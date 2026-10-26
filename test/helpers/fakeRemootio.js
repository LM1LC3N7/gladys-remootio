// -----------------------------------------------------------------------------
// A fake Remootio on 127.0.0.1 (real TCP, real WebSocket frames, the real
// cryptography of the API): HELLO, AUTH with a challenge, the action ids
// checked as the device does ("authentication error" on a wrong one), QUERY,
// OPEN and CLOSE gated on its door state (the relay only when the door is
// closed / open), events pushed by the test, and misbehaviours (silence,
// slowness, a wrong MAC, closing after AUTH). One connection at a time, like
// the device: a second one closes the first.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { decryptFrame, encryptFrame, keyFromHex } from '../../src/remootio/crypto.js';

export const SECRET = 'EFD0E4BF75D49BDD4F5CD5492D55C92FE96040E9CD74BED9F19ACA2658EA0FA9';
export const AUTH = '7B456E7AE95E55F714E2270983C33360514DAD96C93AE1990AFE35FD5BF00A72';
export const SERIAL = '2462abe6bda0nfmcfaxm';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function serverFrame(opcode, payload) {
  const data = Buffer.from(payload ?? '', 'latin1');
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  }
  return Buffer.concat([header, data]);
}

/** Masked client frames -> [{ opcode, payload }], and the bytes left. */
function readClientFrames(buffer) {
  const frames = [];
  let at = 0;
  while (buffer.length - at >= 6) {
    const opcode = buffer[at] & 0x0f;
    let length = buffer[at + 1] & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    }
    if (buffer.length < offset + 4 + length) break;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    at = offset + 4 + length;
  }
  return { frames, rest: buffer.subarray(at) };
}

export async function startFakeRemootio(options = {}) {
  const fake = {
    serial: options.serial ?? SERIAL,
    secret: keyFromHex(options.secret ?? SECRET),
    auth: keyFromHex(options.auth ?? AUTH),
    state: options.state ?? 'closed',
    t100ms: 1000,
    cnt: 10,
    /** What the clients sent, decoded: { type } or { action: { type, id } }. */
    received: [],
    /** The relay pulses: [{ type, at }] */
    pulses: [],
    connections: 0,
    open: 0,
    /** Behaviour switches the tests change. */
    silent: false,
    answerDelay: 0,
    closeAfterAuth: false,
    badMac: false,
    /** OPEN/CLOSE: 'busy' answers ERR_RELAY_BUSY. */
    relay: 'ok',
    /** Events kept while no client is connected, replayed after the next AUTH. */
    history: [],
    /** Real ms after the first answer for each history event (undefined: before it). */
    historyLate: undefined,
    /** The first QUERY of the next N connections is never answered (a slow link). */
    dropFirstQueries: 0,
    /** Actions answered by nothing (the device still acts on them). */
    dropActions: new Set(),
    /** Called with the action type when an action arrives (before any answer). */
    onAction: undefined,
    /** Applied by the device after a pulse (ms), or never (undefined). */
    moveAfter: 50,
    current: undefined,
  };
  for (const key of [
    'silent',
    'answerDelay',
    'closeAfterAuth',
    'badMac',
    'relay',
    'moveAfter',
    'dropFirstQueries',
  ]) {
    if (Object.hasOwn(options, key)) fake[key] = options[key];
  }
  let nextCnt = 11;
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    fake.connections += 1;
    // One connection at a time: the newest wins.
    if (fake.current) fake.current.socket.destroy();
    const conn = { socket, sessionKey: undefined, lastId: undefined, upgraded: false };
    fake.current = conn;
    let buffer = Buffer.alloc(0);
    const send = (object) => {
      if (!socket.destroyed) socket.write(serverFrame(1, JSON.stringify(object)));
    };
    const sendEncrypted = (payload, key = conn.sessionKey) => {
      const frame = JSON.parse(encryptFrame(payload, { key, authKey: fake.auth }));
      if (fake.badMac) frame.mac = Buffer.alloc(32, 1).toString('base64');
      send(frame);
    };
    conn.send = send;
    conn.sendEncrypted = sendEncrypted;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!conn.upgraded) {
        const text = buffer.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (end === -1) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(text)[1];
        const accept = createHash('sha1')
          .update(key + GUID)
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        conn.upgraded = true;
        fake.open += 1;
        buffer = buffer.subarray(end + 4);
      }
      const { frames, rest } = readClientFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 1) continue;
        handle(conn, JSON.parse(frame.payload.toString('latin1')));
      }
    });
  });

  function reply(conn, fn) {
    if (fake.silent) return;
    if (fake.answerDelay > 0) setTimeout(fn, fake.answerDelay);
    else fn();
  }

  function handle(conn, message) {
    if (message.type === 'HELLO') {
      fake.received.push({ type: 'HELLO', at: performance.now() });
      reply(conn, () =>
        conn.send({
          type: 'SERVER_HELLO',
          apiVersion: 3,
          message: 'This is the Remootio Websocket API',
          serialNumber: fake.serial,
          remootioVersion: 'remootio-2',
        }),
      );
      return;
    }
    if (message.type === 'AUTH') {
      fake.received.push({ type: 'AUTH', at: performance.now() });
      if (fake.closeAfterAuth) {
        conn.socket.destroy();
        return;
      }
      conn.sessionKey = randomBytes(32);
      conn.lastId = 1000 + Math.floor(Math.random() * 1000);
      reply(conn, () =>
        conn.sendEncrypted(
          {
            challenge: {
              sessionKey: conn.sessionKey.toString('base64'),
              initialActionId: conn.lastId,
            },
          },
          fake.secret,
        ),
      );
      return;
    }
    if (message.type === 'PING') {
      fake.received.push({ type: 'PING', at: performance.now() });
      reply(conn, () => conn.send({ type: 'PONG' }));
      return;
    }
    if (message.type === 'ENCRYPTED') {
      let payload;
      try {
        payload = decryptFrame(message, { key: conn.sessionKey, authKey: fake.auth });
      } catch {
        conn.send({ type: 'ERROR', errorMessage: 'authentication error' });
        conn.socket.end();
        return;
      }
      const { type, id } = payload.action;
      fake.received.push({ action: { type, id }, at: performance.now() });
      if (id !== (conn.lastId + 1) % 0x7fffffff) {
        conn.send({ type: 'ERROR', errorMessage: 'authentication error' });
        conn.socket.end();
        return;
      }
      conn.lastId = id;
      fake.onAction?.(type);
      conn.queries = (conn.queries ?? 0) + 1;
      let late = [];
      if (conn.queries === 1) {
        // The history first, as the Remootio replays it after a reconnection
        // (or, with historyLate, `historyLate[i]` ms after the answer).
        const history = fake.history.splice(0);
        if (fake.historyLate) late = history;
        else for (const event of history) conn.sendEncrypted({ event });
        if (fake.dropFirstQueries > 0) {
          fake.dropFirstQueries -= 1;
          return;
        }
      }
      let relayTriggered = false;
      let success = true;
      let errorCode = '';
      const gate = { OPEN: 'closed', CLOSE: 'open' }[type];
      if (gate) {
        if (fake.state === 'no sensor') {
          success = false;
          errorCode = 'ERR_NO_SENSOR';
        } else if (fake.relay === 'busy') {
          success = false;
          errorCode = 'ERR_RELAY_BUSY';
        } else if (fake.state === gate) {
          relayTriggered = true;
          fake.pulses.push({ type, at: Date.now() });
        }
      }
      const state = fake.state;
      fake.t100ms += 1;
      const t100ms = fake.t100ms;
      if (!fake.dropActions.has(type))
        reply(conn, () =>
          conn.sendEncrypted({
            response: { type, id, success, state, t100ms, relayTriggered, errorCode },
          }),
        );
      late.forEach((event, i) =>
        setTimeout(
          () => {
            if (!conn.socket.destroyed) conn.sendEncrypted({ event });
          },
          fake.historyLate[i] ?? fake.historyLate.at(-1),
        ),
      );
      if (relayTriggered && fake.moveAfter !== undefined) {
        const target = type === 'OPEN' ? 'open' : 'closed';
        setTimeout(() => fake.setState(target), fake.moveAfter);
      }
    }
  }

  /** The door changes: a StateChange event to the client. */
  fake.setState = (state) => {
    fake.state = state;
    fake.event({ type: 'StateChange', state });
  };

  /** Pushes an event (encrypted) to the connected client. */
  fake.event = (event, { t100ms } = {}) => {
    fake.t100ms += 1;
    const conn = fake.current;
    if (!conn?.sessionKey || conn.socket.destroyed) return;
    conn.sendEncrypted({
      event: { cnt: nextCnt++, state: fake.state, t100ms: t100ms ?? fake.t100ms, ...event },
    });
  };

  fake.kick = () => fake.current?.socket.destroy();
  /** Something happened while no client was connected (replayed later). */
  fake.offlineEvent = (event) => {
    fake.t100ms += 1;
    if (event.state) fake.state = event.state;
    fake.history.push({ cnt: nextCnt++, state: fake.state, t100ms: fake.t100ms, ...event });
  };
  fake.actions = () => fake.received.filter((r) => r.action).map((r) => r.action.type);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.host = `127.0.0.1:${fake.port}`;
  fake.close = () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  return fake;
}
