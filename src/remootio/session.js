// -----------------------------------------------------------------------------
// One connection to a Remootio (its Websocket API allows one at a time):
//
//   open():  WebSocket, HELLO -> SERVER_HELLO (serial number, API version:
//            the identity, compared with the one expected: `otherDevice`
//            tells the caller another Remootio answers), AUTH -> challenge (decrypted with the API Secret
//            Key, MAC with the API Auth Key) -> session key and initial action
//            id, then a QUERY whose answer proves the session (and gives the
//            door state and the device uptime);
//   action(): an encrypted action with the next action id ((last + 1) mod
//            2^31 - 1, the anti-replay counter of the API), answered by the
//            response with the same id; `beforeSend` runs right before the
//            frame is written (the guard of a pulse, saved to /data first);
//   ping():  a PING frame answered by PONG (the liveness of the connection);
//   events:  the encrypted events, handed to `onEvent` (the caller filters
//            the history the Remootio replays at each connection).
//
// Everything is bounded: the size of a message (the WebSocket client), the
// number of messages per 10 s, the actions waiting for an answer, the time of
// each step. The keys are never in a log line or an error text.
// -----------------------------------------------------------------------------

import { openWebSocket } from './websocket.js';
import { FrameError, decryptFrame, encryptFrame, sessionKeyFrom } from './crypto.js';
import {
  ACTION,
  actionPayload,
  nextActionId,
  parseChallenge,
  parseEvent,
  parseFrame,
  parseResponse,
} from './protocol.js';

export const SESSION_LIMITS = {
  /** A frame of the API is a few hundred bytes. */
  message: 16 * 1024,
  /** Messages per window: more is a flood, the connection is closed. */
  messagesPerWindow: 200,
  window: 10_000,
  /** Actions written and not answered yet. */
  pending: 8,
};

/**
 * kind: 'connect' (no WebSocket), 'timeout' (a step not answered in time),
 * 'identity' (no serial number), 'auth' (the keys: the challenge's MAC,
 * padding or JSON refused, or "authentication error" answering the first
 * QUERY; the only kind that says anything of the keys), 'protocol' (a frame
 * not understood), 'closed' (the connection ended, during the
 * authentication too: a closed or slow link says nothing of the keys),
 * 'device' (an ERROR frame), 'notSent'.
 * `sent`: the frame of an action may have reached the Remootio.
 */
export class SessionError extends Error {
  constructor(kind, detail = '', { sent = false } = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'SessionError';
    this.kind = kind;
    this.sent = sent;
  }
}

export class RemootioSession {
  constructor({
    host,
    port = 8080,
    secretKey,
    authKey,
    expectSerial,
    timers = globalThis,
    monotonic = () => performance.now(),
    logger,
    connectSocket,
    onEvent = () => {},
    onClose = () => {},
  }) {
    this.host = host;
    this.port = port;
    this.secretKey = secretKey;
    this.authKey = authKey;
    this.expectSerial = expectSerial;
    this.timers = timers;
    this.monotonic = monotonic;
    this.logger = logger;
    this.connectSocket = connectSocket;
    this.onEvent = onEvent;
    this.onClose = onClose;
    /** 'new' | 'connecting' | 'hello' | 'auth' | 'ready' | 'closed' */
    this.phase = 'new';
    this.identity = undefined;
    this.sessionKey = undefined;
    this.lastActionId = undefined;
    /** id -> { type, resolve, reject, timer } */
    this.pending = new Map();
    this.pings = [];
    /** Monotonic time of the last byte received. */
    this.lastByteAt = undefined;
    this.window = { start: 0, count: 0 };
    /** The step of open() waiting for a frame: (parsed) => void */
    this.waiter = undefined;
    this.closeReason = undefined;
    this.ws = undefined;
  }

  get ready() {
    return this.phase === 'ready';
  }

  get closed() {
    return this.phase === 'closed';
  }

  /** Opens and authenticates the session within `timeout` ms; resolves the first QUERY response. */
  open({ timeout = 5000 } = {}) {
    if (this.phase !== 'new') {
      return Promise.reject(new SessionError('protocol', 'opened twice'));
    }
    this.phase = 'connecting';
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        this.waiter = undefined;
        if (err) {
          this.close(err.kind);
          reject(err);
        } else {
          resolve(value);
        }
      };
      const timer = this.timers.setTimeout(
        () => finish(new SessionError('timeout', this.phase)),
        timeout,
      );
      this.failOpen = (err) => finish(err);
      this.ws = openWebSocket({
        host: this.host,
        port: this.port,
        connectTimeout: timeout,
        maxMessage: SESSION_LIMITS.message,
        timers: this.timers,
        ...(this.connectSocket ? { connectSocket: this.connectSocket } : {}),
        onActivity: () => {
          this.lastByteAt = this.monotonic();
        },
        onOpen: () => {
          this.phase = 'hello';
          this.waiter = (frame) => {
            if (frame.kind !== 'hello') {
              throw new SessionError('protocol', 'no SERVER_HELLO');
            }
            if (!frame.serial) {
              throw new SessionError('identity', 'no serial number');
            }
            // Another Remootio than the one of this slot: AUTH still goes (it
            // reveals nothing of the keys; their success is the proof of a
            // replaced device), but a refused challenge then says "another
            // device", never "refused keys".
            this.otherDevice = Boolean(this.expectSerial && frame.serial !== this.expectSerial);
            this.identity = frame;
            this.phase = 'auth';
            this.waiter = (challengeFrame) => this.onChallenge(challengeFrame, finish);
            this.write({ type: 'AUTH' });
          };
          this.write({ type: 'HELLO' });
        },
        onMessage: (text) => this.onMessage(text),
        onClose: (reason) => this.onSocketClosed(reason),
      });
    });
  }

  write(object) {
    const written = this.ws?.sendText(JSON.stringify(object)) ?? false;
    if (written) {
      this.lastSentAt = this.monotonic();
    }
    return written;
  }

  /** The challenge (step 2), then the QUERY that ends the authentication (step 3). */
  onChallenge(frame, finish) {
    if (frame.kind === 'error') {
      // Before the challenge nothing of the keys was used: not a refusal.
      throw new SessionError('device', frame.message);
    }
    if (frame.kind !== 'encrypted') {
      throw new SessionError('protocol', 'no challenge');
    }
    let payload;
    try {
      payload = decryptFrame(frame.frame, { key: this.secretKey, authKey: this.authKey });
    } catch (err) {
      // A MAC or a padding refused: the keys typed do not match this Remootio.
      throw new SessionError(err instanceof FrameError ? 'auth' : 'protocol', err.check ?? '');
    }
    const challenge = parseChallenge(payload);
    const sessionKey = challenge && sessionKeyFrom(challenge.sessionKey);
    if (!sessionKey) {
      throw new SessionError('protocol', 'challenge not understood');
    }
    this.sessionKey = sessionKey;
    this.lastActionId = challenge.initialActionId;
    const id = nextActionId(this.lastActionId);
    this.lastActionId = id;
    this.waiter = (answer) => {
      if (answer.kind === 'error') {
        throw new SessionError(
          answer.message === 'authentication error' ? 'auth' : 'device',
          answer.message,
        );
      }
      if (answer.kind !== 'encrypted') {
        throw new SessionError('protocol', 'no answer to the first QUERY');
      }
      const payload = this.decrypt(answer.frame);
      const event = parseEvent(payload);
      if (event) {
        // History replayed by the Remootio before the answer: handed on, the wait goes on.
        this.onEvent(event, { replayWindow: true });
        return;
      }
      const response = parseResponse(payload);
      if (!response || response.id !== id || response.type !== ACTION.QUERY) {
        throw new SessionError('protocol', 'unexpected answer to the first QUERY');
      }
      this.phase = 'ready';
      finish(undefined, { identity: this.identity, response });
    };
    this.writeEncrypted(actionPayload(ACTION.QUERY, id));
  }

  writeEncrypted(payload) {
    return this.write(
      JSON.parse(encryptFrame(payload, { key: this.sessionKey, authKey: this.authKey })),
    );
  }

  /** A frame with the session key; refused (MAC, padding): the connection is not trusted. */
  decrypt(frame) {
    try {
      return decryptFrame(frame, { key: this.sessionKey, authKey: this.authKey });
    } catch (err) {
      throw new SessionError('protocol', `encrypted frame refused (${err.check ?? 'error'})`);
    }
  }

  onMessage(text) {
    if (this.phase === 'closed') {
      return;
    }
    const now = this.monotonic();
    if (now - this.window.start >= SESSION_LIMITS.window) {
      this.window = { start: now, count: 0 };
    }
    this.window.count += 1;
    if (this.window.count > SESSION_LIMITS.messagesPerWindow) {
      this.fail(new SessionError('protocol', 'too many messages'));
      return;
    }
    const frame = parseFrame(text);
    try {
      if (!frame) {
        throw new SessionError('protocol', 'frame not understood');
      }
      if (this.waiter) {
        this.waiter(frame);
        return;
      }
      this.onReadyFrame(frame);
    } catch (err) {
      this.fail(err instanceof SessionError ? err : new SessionError('protocol', err.message));
    }
  }

  onReadyFrame(frame) {
    switch (frame.kind) {
      case 'pong': {
        const pings = this.pings;
        this.pings = [];
        for (const ping of pings) ping.resolve();
        return;
      }
      case 'error':
        if (frame.message === 'authentication error') {
          throw new SessionError('auth', 'after the authentication');
        }
        // "input error", "internal error"...: the pending actions may not
        // have run; "connection timeout": the Remootio closes.
        this.logger?.warn?.(`Remootio ${this.host}: error frame "${frame.message}"`);
        this.rejectPending(new SessionError('device', frame.message, { sent: true }));
        return;
      case 'encrypted': {
        const payload = this.decrypt(frame.frame);
        const response = parseResponse(payload);
        if (response) {
          const waiting = this.pending.get(response.id);
          if (waiting && waiting.type === response.type) {
            this.pending.delete(response.id);
            this.timers.clearTimeout(waiting.timer);
            waiting.resolve(response);
          }
          return;
        }
        const event = parseEvent(payload);
        if (event) {
          this.onEvent(event, { replayWindow: false });
        }
        return;
      }
      default:
        // A second SERVER_HELLO: not asked, ignored.
        return;
    }
  }

  /**
   * Sends an action; resolves its response. `beforeSend` (may be async) runs
   * right before the frame is written; if it throws, nothing is written.
   * @throws {SessionError} with `sent` true once the frame may have left
   */
  async action(type, { timeout = 3000, beforeSend } = {}) {
    if (!this.ready) {
      throw new SessionError('notSent', 'session not ready');
    }
    if (this.pending.size >= SESSION_LIMITS.pending) {
      throw new SessionError('notSent', 'too many actions waiting');
    }
    if (beforeSend) {
      await beforeSend();
    }
    if (!this.ready) {
      throw new SessionError('notSent', 'session closed');
    }
    // The id is taken right before the write: the ids leave in order.
    const id = nextActionId(this.lastActionId);
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        reject(new SessionError('timeout', `${type} not answered`, { sent: true }));
        // An action without an answer: the connection is not trusted any more.
        this.close('no answer', undefined, { abort: true });
      }, timeout);
      this.pending.set(id, { type, resolve, reject, timer });
      this.lastActionId = id;
      let written;
      try {
        written = this.writeEncrypted(actionPayload(type, id));
      } catch {
        written = false;
      }
      if (!written) {
        this.pending.delete(id);
        this.timers.clearTimeout(timer);
        reject(new SessionError('notSent', 'connection closed'));
      }
    });
  }

  /** A PING answered by a PONG within `timeout` ms. */
  ping(timeout = 1000) {
    if (!this.ready) {
      return Promise.reject(new SessionError('notSent', 'session not ready'));
    }
    return new Promise((resolve, reject) => {
      const entry = {};
      const timer = this.timers.setTimeout(() => {
        this.pings = this.pings.filter((p) => p !== entry);
        reject(new SessionError('timeout', 'no PONG'));
      }, timeout);
      entry.resolve = () => {
        this.timers.clearTimeout(timer);
        resolve();
      };
      entry.reject = (err) => {
        this.timers.clearTimeout(timer);
        reject(err);
      };
      this.pings.push(entry);
      if (!this.write({ type: 'PING' })) {
        this.pings = this.pings.filter((p) => p !== entry);
        this.timers.clearTimeout(timer);
        reject(new SessionError('notSent', 'connection closed'));
      }
    });
  }

  rejectPending(err) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      this.timers.clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  fail(err) {
    if (this.failOpen && this.phase !== 'ready') {
      this.failOpen(err);
      return;
    }
    this.close(err.kind, err);
  }

  onSocketClosed(reason) {
    if (this.phase !== 'ready' && this.phase !== 'closed' && this.failOpen) {
      // After AUTH, a connection closed without an answer may be a refusal.
      this.failOpen(new SessionError(this.phase === 'connecting' ? 'connect' : 'closed', reason));
      return;
    }
    this.close('closed');
  }

  /** Ends the session (idempotent); every waiter is rejected. */
  close(reason = 'closed', err, { abort = false } = {}) {
    if (this.phase === 'closed') {
      return;
    }
    this.wasReady = this.phase === 'ready';
    this.phase = 'closed';
    this.closeReason = err?.kind ?? reason;
    this.sessionKey = undefined;
    this.ws?.close({ abort });
    this.rejectPending(new SessionError('closed', String(reason), { sent: true }));
    const pings = this.pings;
    this.pings = [];
    for (const ping of pings) ping.reject(new SessionError('closed', String(reason)));
    this.onClose(this.closeReason, err);
  }
}
