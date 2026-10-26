// -----------------------------------------------------------------------------
// The integration: the Remootio devices of the configuration (up to two), one
// WebSocket session each (the API allows one at a time), the Gladys devices
// built from them, and the Open and Close commands. index.js only wires the
// SDK handlers to it (src/handlers.js).
//
// Sessions:
//   - HELLO first: the serial number says which Remootio answers, at every
//     session (a new DHCP lease moves a Remootio, never its device); then
//     AUTH with the two API keys and a first QUERY (the door state);
//   - the state then comes pushed (StateChange, LeftOpen events) and from a
//     QUERY every 5 min; a PING when nothing came for a minute; the history
//     the Remootio replays at each connection (events older than the first
//     QUERY of the session) never changes a state nor a guard;
//   - a lost session is opened again after 5 s, 15 s, 30 s, 1, 2, then every
//     5 min; keys refused twice in a row (MAC or padding refused, an
//     "authentication error", a connection closed or silent after AUTH): no
//     more tries, a salted fingerprint of the pair in /data, until other keys
//     are saved or "Check the Remootio devices" succeeds (one try per 30 s);
//   - a session of an older configuration publishes nothing, sets no status.
//
// Commands (Open, Close: buttons, never a switch). The output of a Remootio
// drives the gate or door opener with a TOGGLE pulse: the same pulse opens a
// closed door, closes an open one, and stops or reverses a moving one. So:
//   - only the OPEN and CLOSE actions of the API are sent, never TRIGGER: the
//     Remootio itself pulses only when ITS sensor reads the door closed (OPEN)
//     or open (CLOSE), when the action arrives; without a status sensor it
//     refuses both (ERR_NO_SENSOR);
//   - BOTH need "Allow opening and closing" (allow_open, off by default):
//     "open" for the sensor also means "moving", where a close pulse stops or
//     reverses the door (decision of 2026-10-25, as gladys-opengarage).
//     Checked on arrival, before the session is used and right before the
//     frame is written;
//   - after a pulse (ours, or any key's RelayTrigger event when the API runs
//     with logging), a guard refuses any other pulse for the travel time + 5 s
//     (a door reads "open" as soon as it leaves the closed position); a close
//     guard is lifted early by a fresh "closed". The guard is saved to /data
//     BEFORE the frame is written (a restart keeps it), removed only when the
//     Remootio answers that nothing moved;
//   - one command per door: a close cancels an opening not written yet, waits
//     for one written (its answer) and is then refused by its guard; an
//     opening is refused while another command runs;
//   - a close does not wait for a background reconnection: it uses the
//     session (probed by a PING when silent for 10 s, closed when stuck for
//     1 s), else opens a new one at once, and tries again every 250 ms within
//     its budget; not written in time: kept and sent at the next session
//     (2 min, 3 tries at most), unless a newer command or another key
//     operated the door meanwhile;
//   - written within 3.5 s of the click or refused unsent; answered by 4.3 s; a
//     frame that may have reached the Remootio is never "not sent": "sent,
//     without confirmation", the guard stays;
//   - success: the Remootio answers relayTriggered (moving), or that the door
//     is already there; reads follow at 5 s, 15 s and the end of the travel
//     time, and a door not read where it was sent is said in the status;
//   - the ack never waits for a publication to Gladys; the keys are never in a
//     log line, a status, an error or /data.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, numberOf } from './config.js';
import { BUTTON_PUSH, EXTERNAL_ID_TYPE, LIMITS, TIMINGS } from './constants.js';
import { ERRORS, T, join, word } from './i18n.js';
import { buildDevice, doorValue, featuresOf } from './model.js';
import { StatePublisher } from './publisher.js';
import { FileStore, GUARD_MAX, emptyData } from './store.js';
import { ACTION, EVENT, STATE } from './remootio/protocol.js';
import { RemootioSession } from './remootio/session.js';

/** A command value, strictly: a finite number or its exact text ('' and null are not 0). */
const strictNumber = (value) => (typeof value === 'boolean' ? undefined : numberOf(value));

const reasonOf = (err) => T.reasons[err?.kind] ?? T.reasons.timeout;

export class RemootioApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'remootio' }),
    store = new FileStore(),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    sessionFactory = (options) => new RemootioSession(options),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.sessionFactory = sessionFactory;
    this.config = undefined;
    this.data = undefined;
    this.publisher = new StatePublisher({
      gladys,
      logger,
      now,
      timers,
      interval: TIMINGS.measureInterval,
    });
    /** slot -> link (one configured Remootio and its session) */
    this.links = new Map();
    /** serial -> { kind, at, until, t100?, owner? } on the monotonic clock */
    this.guards = new Map();
    /** serial -> the command running (one per door) */
    this.commands = new Map();
    /** serial -> handles of the reads after its last pulse */
    this.followUps = new Map();
    /** Timers of the kept closes tried again after a busy output. */
    this.retries = new Set();
    /** serial -> the state a command aimed at, not read at the end of the travel */
    this.notReached = new Map();
    /** serial -> reachable */
    this.reachable = new Map();
    /** deviceId -> transport badge last published */
    this.transports = new Map();
    /** featureId -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** featureId -> { serial, key } of the published devices */
    this.features = new Map();
    this.persistTimer = undefined;
    this.saving = Promise.resolve();
    this.lastStatus = undefined;
    this.warned = new Set();
    this.stopped = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stopped = false;
    const first = !this.data;
    if (first) {
      this.data = await this.store.load().catch(() => emptyData());
      this.restoreGuards();
    }
    this.config = normalizeConfig(raw);
    for (const conf of this.config.slots) {
      const link = this.links.get(conf.slot);
      if (link && link.conf.generationKey === conf.generationKey) {
        link.conf = conf;
        continue;
      }
      if (link) {
        this.dropLink(link);
      }
      this.links.set(conf.slot, this.newLink(conf, link, first));
    }
    // Gladys keeps the status and the Discovery tab in memory: sent again at every start.
    this.lastStatus = undefined;
    this.transports.clear();
    this.refreshCreated();
    this.publisher.start();
    await this.publishDevices();
    await this.publishAllTransports();
    this.updateStatus();
  }

  newLink(conf, previous, first) {
    const link = {
      slot: conf.slot,
      conf,
      generation: (previous?.generation ?? 0) + 1,
      session: undefined,
      opening: undefined,
      timer: undefined,
      state: 'idle',
      failures: 0,
      authFailures: 0,
      refused: false,
      lastError: undefined,
      nextAt: undefined,
      baseT100: undefined,
      lastRefreshAt: undefined,
      lastCheckAt: undefined,
      replaced: undefined,
    };
    const kept = this.data.refused[conf.slot];
    if (kept) {
      if (conf.usable && kept.fingerprint === this.fingerprint(conf)) {
        link.refused = true;
        link.authFailures = TIMINGS.authFailures;
      } else {
        // Other keys (or none): the refusal was for the previous ones.
        delete this.data.refused[conf.slot];
        this.persist();
      }
    }
    if (conf.usable && !link.refused) {
      // After a restart soon after an attempt, the first one waits the shortest backoff.
      const last = this.data.attempts[conf.slot];
      const recent = first && last !== undefined && this.now() - last < TIMINGS.attemptSave + 5000;
      this.later(link, recent ? TIMINGS.reconnect[0] : 0);
    }
    return link;
  }

  /** A link whose configuration changed: its session ends, its timers stop. */
  dropLink(link) {
    link.generation += 1;
    this.timers.clearTimeout(link.timer);
    link.timer = undefined;
    const session = link.session;
    link.session = undefined;
    link.opening = undefined;
    session?.close('configuration changed', undefined, { abort: true });
  }

  stop() {
    this.stopped = true;
    this.publisher.stop();
    for (const link of this.links.values()) {
      this.dropLink(link);
    }
    for (const handles of this.followUps.values()) {
      for (const handle of handles) {
        this.timers.clearTimeout(handle);
      }
    }
    this.followUps.clear();
    for (const handle of this.retries) {
      this.timers.clearTimeout(handle);
    }
    this.retries.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.save();
    }
    return this.saving;
  }

  /** Saves /data now, one write at a time; never throws. */
  save() {
    this.saving = this.saving
      .then(() => this.store.save(this.data))
      .catch(() => this.logger.warn('Could not save /data'));
    return this.saving;
  }

  /** Saves /data now; throws when the write failed (the guard of a pulse). */
  saveStrict() {
    const attempt = this.saving.then(() => this.store.save(this.data));
    this.saving = attempt.catch(() => this.logger.warn('Could not save /data'));
    return attempt;
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.save();
    }, TIMINGS.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  get records() {
    return Object.values(this.data?.devices ?? {});
  }

  /** A salted fingerprint of a pair of keys, only ever kept for keys a Remootio refused. */
  fingerprint(conf) {
    return createHmac('sha256', this.data.salt)
      .update(conf.secretKey)
      .update(':')
      .update(conf.authKey)
      .digest('hex');
  }

  // --- Sessions --------------------------------------------------------------

  /** The next connection of a link in `delay` ms (its one timer). */
  later(link, delay) {
    this.timers.clearTimeout(link.timer);
    link.nextAt = this.monotonic() + delay;
    const generation = link.generation;
    link.timer = this.timers.setTimeout(() => {
      link.timer = undefined;
      if (link.generation === generation && !this.stopped) {
        this.connect(link).catch(() => {});
      }
    }, delay);
  }

  scheduleReconnect(link) {
    if (link.refused || !link.conf.usable || this.stopped) {
      return;
    }
    const delay = TIMINGS.reconnect[Math.min(link.failures, TIMINGS.reconnect.length - 1)];
    link.failures += 1;
    this.later(link, delay);
  }

  /** The time of the attempt, in /data at most once a minute. */
  noteAttempt(link) {
    const at = this.now();
    const previous = this.data.attempts[link.slot];
    if (previous === undefined || at - previous >= TIMINGS.attemptSave || at < previous) {
      this.data.attempts[link.slot] = at;
      this.persist();
    }
  }

  /** Opens the session of a link; one opening at a time, shared. */
  connect(link, timeout = TIMINGS.connectTimeout) {
    if (link.opening) {
      return link.opening;
    }
    const { conf } = link;
    const generation = link.generation;
    this.timers.clearTimeout(link.timer);
    link.timer = undefined;
    link.state = 'connecting';
    this.noteAttempt(link);
    const session = this.sessionFactory({
      host: conf.host,
      port: conf.port,
      secretKey: conf.secretKey,
      authKey: conf.authKey,
      timers: this.timers,
      monotonic: this.monotonic,
      logger: this.logger,
      onEvent: (event, meta) => this.onEvent(link, session, event, meta),
      onClose: (reason) => this.onSessionClosed(link, session, reason),
    });
    link.session = session;
    this.updateStatus();
    const opening = session.open({ timeout }).then(
      (result) => {
        if (link.generation !== generation || link.session !== session) {
          session.close('stale', undefined, { abort: true });
          throw Object.assign(new Error('stale'), { kind: 'closed' });
        }
        this.onSessionReady(link, session, result);
        return session;
      },
      (err) => {
        if (link.generation === generation && link.session === session) {
          this.onConnectFailed(link, err);
        }
        throw err;
      },
    );
    link.opening = opening.finally(() => {
      if (link.opening === tracked) {
        link.opening = undefined;
      }
    });
    const tracked = link.opening;
    return tracked;
  }

  onSessionReady(link, session, { identity, response }) {
    link.state = 'ready';
    link.failures = 0;
    link.authFailures = 0;
    link.lastError = undefined;
    link.nextAt = undefined;
    link.baseT100 = response.t100ms;
    link.lastRefreshAt = this.monotonic();
    if (this.data.refused[link.slot]) {
      delete this.data.refused[link.slot];
      this.persist();
    }
    const serial = identity.serial;
    this.logger.info(`Remootio ${link.slot}: connected to ${serial} (API v${identity.apiVersion})`);
    const changed = this.bind(link, identity);
    this.fresh(serial, response.state, response.t100ms);
    this.setReachable(serial, true);
    this.tickLater(link, session);
    if (changed) {
      this.publishDevices().catch(() => {});
    }
    this.updateStatus();
    this.resumePendingClose(link);
  }

  /** The Remootio of a link: its record, bound to the slot (a positive proof: the keys work). */
  bind(link, identity) {
    const { serial } = identity;
    let changed = false;
    for (const record of this.records) {
      if (record.serial !== serial && record.slot === link.slot) {
        this.logger.warn(`Remootio ${link.slot}: ${serial} answers where ${record.serial} was`);
        link.replaced = { previous: record.serial, next: serial };
        record.slot = undefined;
        this.setReachable(record.serial, false);
        changed = true;
      }
    }
    const devices = this.data.devices;
    const existing = devices[serial];
    if (!existing && Object.keys(devices).length >= LIMITS.records) {
      // The oldest unbound record leaves (its Gladys device stays, unreachable).
      const unbound = this.records.find((r) => r.slot === undefined);
      if (unbound) {
        delete devices[unbound.serial];
      }
    }
    const record = {
      serial,
      slot: link.slot,
      address: link.conf.address,
      model: identity.model ?? existing?.model ?? '',
      apiVersion: identity.apiVersion ?? existing?.apiVersion,
    };
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      if (existing) {
        Object.assign(existing, record);
      } else {
        devices[serial] = record;
      }
      changed = true;
      this.persist();
    }
    return changed;
  }

  onConnectFailed(link, err) {
    link.state = 'down';
    link.session = undefined;
    link.lastError = err.kind ?? 'connect';
    this.logger.debug(`Remootio ${link.slot}: connection failed (${err.message})`);
    if (err.kind === 'auth' || err.kind === 'authClosed') {
      link.authFailures += 1;
      if (link.authFailures >= TIMINGS.authFailures) {
        this.refuseKeys(link);
        return;
      }
    }
    this.scheduleReconnect(link);
    this.updateStatus();
  }

  /** Keys refused: no more tries until other keys or a successful check. */
  refuseKeys(link) {
    link.refused = true;
    this.timers.clearTimeout(link.timer);
    link.timer = undefined;
    this.data.refused[link.slot] = { fingerprint: this.fingerprint(link.conf), at: this.now() };
    this.save();
    this.warnOnce(
      `refused:${link.slot}:${link.generation}`,
      `Remootio ${link.slot}: API keys refused`,
    );
    this.updateStatus();
  }

  onSessionClosed(link, session, reason) {
    if (link.session !== session || !session.wasReady) {
      return;
    }
    link.session = undefined;
    link.state = 'down';
    link.lastError = reason === 'auth' ? 'auth' : 'closed';
    this.timers.clearTimeout(link.timer);
    link.timer = undefined;
    const serial = session.identity?.serial;
    if (serial) {
      this.setReachable(serial, false);
    }
    this.logger.info(`Remootio ${link.slot}: session closed (${reason})`);
    this.scheduleReconnect(link);
    this.updateStatus();
  }

  /** The one timer of a ready session: liveness (PING) and the QUERY of every 5 min. */
  tickLater(link, session) {
    this.timers.clearTimeout(link.timer);
    link.timer = this.timers.setTimeout(() => {
      link.timer = undefined;
      this.tick(link, session);
    }, TIMINGS.pingInterval);
  }

  tick(link, session) {
    if (link.session !== session || !session.ready || this.stopped) {
      return;
    }
    const mono = this.monotonic();
    let check;
    if (mono - link.lastRefreshAt >= TIMINGS.refreshInterval) {
      link.lastRefreshAt = mono;
      check = this.query(link, session, TIMINGS.pingTimeout).then(() =>
        this.resumePendingClose(link),
      );
    } else if (mono - (session.lastByteAt ?? -Infinity) >= TIMINGS.pingInterval - 1000) {
      check = session.ping(TIMINGS.pingTimeout);
    } else {
      check = Promise.resolve();
    }
    check.then(
      () => {
        if (link.session === session && session.ready) {
          this.tickLater(link, session);
        }
      },
      () => session.close('no answer', undefined, { abort: true }),
    );
  }

  /** A QUERY on a session; the state answered is fresh. */
  async query(link, session, timeout) {
    const response = await session.action(ACTION.QUERY, { timeout });
    if (link.session === session && session.identity) {
      this.fresh(session.identity.serial, response.state, response.t100ms);
    }
    return response;
  }

  onEvent(link, session, event, { replayWindow }) {
    if (link.session !== session || !session.identity) {
      return;
    }
    // The history the Remootio replays at each connection: never a fresh state.
    if (replayWindow || (link.baseT100 !== undefined && event.t100ms <= link.baseT100)) {
      this.logger.debug(`Remootio ${link.slot}: past event ${event.type} ignored`);
      return;
    }
    const serial = session.identity.serial;
    switch (event.type) {
      case EVENT.STATE_CHANGE:
      case EVENT.LEFT_OPEN:
        this.fresh(serial, event.state, event.t100ms);
        return;
      case EVENT.RELAY_TRIGGER:
        if (event.keyType !== 'api key') {
          this.externalPulse(serial, event);
        }
        return;
      case EVENT.RESTART:
        this.logger.info(`Remootio ${link.slot}: the device restarted`);
        return;
      default:
        this.logger.debug(`Remootio ${link.slot}: event ${event.type}`);
    }
  }

  /** A state read now (a QUERY answer, a fresh event): published, and it may lift a close guard. */
  fresh(serial, state, t100) {
    const guard = this.guards.get(serial);
    if (
      guard?.kind === 'close' &&
      state === STATE.CLOSED &&
      guard.t100 !== undefined &&
      t100 > guard.t100
    ) {
      this.removeGuard(serial, guard);
    }
    const expected = this.notReached.get(serial);
    if (expected && state === expected) {
      this.notReached.delete(serial);
      this.updateStatus();
    }
    const value = doorValue(state);
    if (value === undefined) {
      return;
    }
    const featureId = this.gladys.externalIds(EXTERNAL_ID_TYPE, serial).feature('door');
    const entry = { state: value };
    this.lastValues.set(featureId, entry);
    if (this.created.has(featureId)) {
      this.publisher.push(featureId, entry);
    }
  }

  /** Another key (remote, app, automation) pulsed the output: the door moves. */
  externalPulse(serial, event) {
    const kind = event.state === STATE.CLOSED ? 'open' : 'close';
    this.logger.info(`Remootio ${serial}: operated by a ${event.keyType || 'key'}`);
    this.setGuard(serial, kind, { t100: event.t100ms });
    this.save();
    this.dropPendingClose(serial, 'another key operated the door');
  }

  // --- Guards ----------------------------------------------------------------

  guardLength() {
    return Math.min(this.config.travelTime + TIMINGS.guardMargin, GUARD_MAX);
  }

  /** /data -> memory: the rest of each guard brought onto the monotonic clock. */
  restoreGuards() {
    const at = this.now();
    const mono = this.monotonic();
    for (const [serial, guard] of Object.entries(this.data.guards)) {
      const left = Math.min(guard.until - at, GUARD_MAX);
      if (left > 0) {
        this.guards.set(serial, {
          kind: guard.kind,
          at: mono - (at - guard.at),
          until: mono + left,
        });
      } else {
        delete this.data.guards[serial];
      }
    }
  }

  setGuard(serial, kind, { t100, owner } = {}) {
    const mono = this.monotonic();
    const at = this.now();
    const length = this.guardLength();
    const guard = { kind, at: mono, until: mono + length, t100, owner };
    this.guards.set(serial, guard);
    this.data.guards[serial] = { kind, at, until: at + length };
    return guard;
  }

  removeGuard(serial, guard) {
    if (this.guards.get(serial) === guard) {
      this.guards.delete(serial);
      delete this.data.guards[serial];
      this.persist();
    }
  }

  /** The guard holding at `mono` (its rest capped at every use), other than `except`. */
  activeGuard(serial, mono, except) {
    const guard = this.guards.get(serial);
    if (!guard || guard === except) {
      return undefined;
    }
    // A monotonic clock never goes back; a rest longer than the bound is capped.
    guard.until = Math.min(guard.until, mono + GUARD_MAX);
    if (mono >= guard.until) {
      this.guards.delete(serial);
      delete this.data.guards[serial];
      this.persist();
      return undefined;
    }
    return guard;
  }

  // --- Pending close ---------------------------------------------------------

  keepPendingClose(serial) {
    const previous = this.data.pendingCloses[serial];
    this.data.pendingCloses[serial] = {
      at: previous?.at ?? this.now(),
      tries: previous?.tries ?? 0,
    };
    this.save();
  }

  dropPendingClose(serial, why) {
    if (this.data.pendingCloses[serial]) {
      delete this.data.pendingCloses[serial];
      this.logger.info(`Remootio ${serial}: kept close dropped (${why})`);
      this.save();
    }
  }

  /** At a new session or a refresh: the close not written yet is sent now. */
  resumePendingClose(link) {
    const serial = link.session?.identity?.serial;
    const pending = serial && this.data.pendingCloses[serial];
    if (!pending) {
      return;
    }
    const at = this.now();
    if (
      at - pending.at >= TIMINGS.pendingCloseFor ||
      at < pending.at ||
      pending.tries >= TIMINGS.pendingCloseTries
    ) {
      this.dropPendingClose(serial, 'expired');
      return;
    }
    if (!this.config.allowOpen) {
      this.dropPendingClose(serial, 'commands disabled');
      return;
    }
    if (this.commands.has(serial) || this.activeGuard(serial, this.monotonic())) {
      return;
    }
    pending.tries += 1;
    this.save();
    this.logger.info(`Remootio ${serial}: sending the kept close (try ${pending.tries})`);
    this.command(serial, 'close', this.monotonic()).catch((err) =>
      this.logger.info(`Remootio ${serial}: kept close not done (${err.message})`),
    );
  }

  // --- Gladys devices ----------------------------------------------------------

  /**
   * The Discovery tab. A created device never loses a feature: the features
   * it has that are not published any more are kept as they are.
   */
  async publishDevices() {
    const devices = [];
    this.features.clear();
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    for (const record of this.records) {
      const device = buildDevice(this.gladys, record, { language: this.config.language });
      const ids = this.gladys.externalIds(EXTERNAL_ID_TYPE, record.serial);
      for (const { key } of featuresOf()) {
        this.features.set(ids.feature(key), { serial: record.serial, key });
      }
      const published = new Set(device.features.map((f) => f.external_id));
      for (const feature of created.get(device.external_id)?.features ?? []) {
        if (!published.has(feature.external_id)) {
          const kept = {};
          for (const field of [
            'name',
            'external_id',
            'category',
            'type',
            'min',
            'max',
            'unit',
            'read_only',
            'has_feedback',
            'keep_history',
          ]) {
            if (feature[field] !== undefined && feature[field] !== null) {
              kept[field] = feature[field];
            }
          }
          device.features.push(kept);
        }
      }
      devices.push(device);
    }
    this.publisher.configure({ throttled: new Set(), events: new Set() });
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the discovered devices failed: ${err.message}`));
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    for (const feature of device?.features ?? []) {
      const value = this.lastValues.get(feature.external_id);
      if (value) {
        this.publisher.push(feature.external_id, value);
      }
    }
    if (device?.external_id) {
      await this.publishTransport(device.external_id).catch(() => {});
    }
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  setReachable(serial, reachable) {
    const previous = this.reachable.get(serial);
    this.reachable.set(serial, reachable);
    if (previous !== reachable) {
      this.publishTransport(this.gladys.externalIds(EXTERNAL_ID_TYPE, serial).device).catch((err) =>
        this.logger.warn(`Transport badge failed: ${err.message}`),
      );
    }
  }

  recordOfDevice(deviceId) {
    return this.records.find(
      (record) => this.gladys.externalIds(EXTERNAL_ID_TYPE, record.serial).device === deviceId,
    );
  }

  transportOf(serial) {
    return this.reachable.get(serial) ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
  }

  async publishTransport(deviceId) {
    const record = this.recordOfDevice(deviceId);
    if (!record || !this.reachable.has(record.serial) || !this.createdDevices().has(deviceId)) {
      return;
    }
    const transport = this.transportOf(record.serial);
    if (this.transports.get(deviceId) === transport) {
      return;
    }
    this.transports.set(deviceId, transport);
    await this.gladys.publishTransports([{ external_id: deviceId, transport }]);
  }

  async publishAllTransports() {
    const created = this.createdDevices();
    const entries = [];
    for (const record of this.records) {
      const deviceId = this.gladys.externalIds(EXTERNAL_ID_TYPE, record.serial).device;
      if (!this.reachable.has(record.serial) || !created.has(deviceId)) {
        continue;
      }
      const transport = this.transportOf(record.serial);
      if (this.transports.get(deviceId) !== transport) {
        this.transports.set(deviceId, transport);
        entries.push({ external_id: deviceId, transport });
      }
    }
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries)
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  /** The status line of one configured Remootio. */
  linkStatus(link, mono) {
    const { conf } = link;
    const parts = [];
    if (conf.hostProblem === 'missing') parts.push(T.hostMissing(conf.slot));
    if (conf.hostProblem === 'invalid') parts.push(T.hostInvalid(conf.slot));
    for (const which of ['secret', 'auth']) {
      const problem = conf.keyProblems[which];
      if (problem?.problem === 'missing') parts.push(T.keyMissing(conf.slot, which));
      if (problem?.problem === 'invalid') {
        parts.push(T.keyInvalid(conf.slot, which, problem.length));
      }
    }
    if (!conf.usable) {
      return parts;
    }
    if (link.refused) {
      parts.push(T.refused(conf.slot, conf.address));
    } else if (link.state === 'ready' && link.session?.identity) {
      parts.push(T.connected(conf.slot, conf.address, link.session.identity.serial));
    } else if (link.state === 'down' && link.nextAt !== undefined) {
      parts.push(
        T.down(
          conf.slot,
          conf.address,
          T.reasons[link.lastError] ?? T.reasons.connect,
          link.nextAt - mono,
        ),
      );
    } else {
      parts.push(T.connecting(conf.slot, conf.address));
    }
    if (link.replaced) {
      parts.push(T.replaced(conf.slot, link.replaced.previous, link.replaced.next));
    }
    return parts;
  }

  updateStatus() {
    if (!this.config) {
      return;
    }
    const mono = this.monotonic();
    const links = [...this.links.values()].filter((link) => link.conf.configured);
    const parts = [];
    if (links.length === 0) {
      parts.push(T.none);
    }
    for (const link of links) {
      parts.push(...this.linkStatus(link, mono));
    }
    if (links.length > 0 && !this.config.allowOpen) {
      parts.push(T.commandsOff);
    }
    for (const [serial, expected] of this.notReached) {
      parts.push(T.notReached(`Remootio ${serial.slice(-6)}`, expected));
    }
    const connected = links.some((link) => link.state === 'ready');
    const message = join(parts);
    // The countdown of a retry is not a change: compared without the numbers.
    const key = JSON.stringify([connected, message.en.replace(/\d+ s\b/g, '')]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The Discovery tab scan: the known devices (nothing is read sooner for it). */
  async scan() {
    await this.publishDevices();
    this.updateStatus();
  }

  /**
   * "Check the Remootio devices": the state of each one. Refused keys are
   * tried once more (at most every 30 s); the refusal is lifted only by a
   * success. A lost session is never opened sooner than its next try.
   */
  async checkDevices() {
    const links = [...this.links.values()].filter((link) => link.conf.configured);
    if (links.length === 0) {
      return T.none;
    }
    const lines = [];
    for (const link of links) {
      const mono = this.monotonic();
      if (link.refused && link.conf.usable) {
        if (link.lastCheckAt !== undefined && mono - link.lastCheckAt < TIMINGS.checkSpacing) {
          lines.push(T.check.tooSoon(link.lastCheckAt + TIMINGS.checkSpacing - mono));
        } else {
          link.lastCheckAt = mono;
          link.refused = false;
          // One more failure is a refusal again at once.
          link.authFailures = TIMINGS.authFailures - 1;
          await this.connect(link).catch(() => {});
        }
      }
      lines.push(...this.linkStatus(link, this.monotonic()));
    }
    this.updateStatus();
    return T.check.result(lines);
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config?.language ?? 'fr'));
    error.refusal = true;
    return error;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const target = this.data && this.config && this.features.get(feature?.external_id);
    if (!target || !this.data.devices[target.serial]) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (target.key !== 'open' && target.key !== 'close') {
      throw this.refusal(ERRORS.readOnly);
    }
    if (strictNumber(value) !== BUTTON_PUSH.PRESSED) {
      throw this.refusal(ERRORS.badValue);
    }
    return this.command(target.serial, target.key, received);
  }

  /** The link that commands a known Remootio, or a refusal. */
  linkOf(serial) {
    const slot = this.data.devices[serial]?.slot;
    const link = slot === undefined ? undefined : this.links.get(slot);
    if (!link || !link.conf.configured) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (!link.conf.usable) {
      throw this.refusal(ERRORS.noKeys);
    }
    if (link.refused) {
      throw this.refusal(ERRORS.keysRefused);
    }
    return link;
  }

  checkOption(key) {
    if (!this.config.allowOpen) {
      // Closing is the same pulse as opening on a moving door: both need the permission.
      throw this.refusal(key === 'open' ? ERRORS.openDisabled : ERRORS.closeDisabled);
    }
  }

  /**
   * Waits for `promise` at most until the monotonic `until`, or until the
   * ticket is cancelled (its `wake`); true when the promise settled.
   */
  async within(promise, until, ticket) {
    let timer;
    const left = Math.max(0, until - this.monotonic());
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(false), left);
      if (ticket) {
        ticket.wake = () => resolve(false);
      }
    });
    try {
      return await Promise.race([
        promise.then(
          () => true,
          () => true,
        ),
        timeout,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      if (ticket) {
        ticket.wake = undefined;
      }
    }
  }

  async command(serial, key, received) {
    const isClose = key === 'close';
    this.checkOption(key);
    // Refused at once when this Remootio cannot be commanded at all.
    this.linkOf(serial);
    const sendBy = received + TIMINGS.commandSendBy;
    const current = this.commands.get(serial);
    if (current) {
      if (isClose && current.key === 'open' && !current.sent) {
        // An opening not written yet is cancelled by a close; its waits end now.
        current.cancelled = true;
        current.wake?.();
      } else if (isClose && current.sent) {
        // A pulse written: its answer says whether the door moves (its guard).
        await this.within(current.done, sendBy - 200);
        if (this.commands.get(serial) === current) {
          throw this.refusal(ERRORS.justCommanded(this.guardLength()));
        }
      } else {
        throw this.refusal(ERRORS.busy);
      }
    }
    const mono = this.monotonic();
    const guard = this.activeGuard(serial, mono);
    if (guard) {
      throw this.refusal(ERRORS.justCommanded(guard.until - mono));
    }
    // Read again after the wait: the configuration may have changed.
    const link = this.linkOf(serial);
    let settle;
    const ticket = {
      key,
      serial,
      link,
      generation: link.generation,
      cancelled: false,
      sent: false,
      done: new Promise((resolve) => {
        settle = resolve;
      }),
    };
    this.commands.set(serial, ticket);
    try {
      return await this.runCommand(ticket, received);
    } finally {
      settle();
      if (this.commands.get(serial) === ticket) {
        this.commands.delete(serial);
      }
    }
  }

  async runCommand(ticket, received) {
    const { serial, link, key } = ticket;
    const isClose = key === 'close';
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    let lastReason = T.reasons.timeout;
    const check = (mono, own) => {
      if (ticket.cancelled) throw this.refusal(ERRORS.cancelled);
      if (ticket.generation !== link.generation || this.links.get(link.slot) !== link) {
        throw this.refusal(ERRORS.configChanged);
      }
      this.checkOption(key);
      if (link.refused) throw this.refusal(ERRORS.keysRefused);
      if (this.data.devices[serial]?.slot !== link.slot) throw this.refusal(ERRORS.unknownDevice);
      const guard = this.activeGuard(serial, mono, own);
      if (guard) throw this.refusal(ERRORS.justCommanded(guard.until - mono));
      if (mono > sendBy) {
        if (isClose) {
          this.keepPendingClose(serial);
          throw this.refusal(ERRORS.closeKept(lastReason));
        }
        throw this.refusal(ERRORS.tooSlow(lastReason));
      }
    };
    check(this.monotonic());
    // The session: the one open (probed when silent), else a new one at once;
    // a close tries again every 250 ms within its budget.
    let session;
    for (;;) {
      try {
        session = await this.sessionFor(link, sendBy - 200, ticket);
        break;
      } catch (err) {
        if (err.refusal) throw err;
        lastReason = reasonOf(err);
        check(this.monotonic());
        const mono = this.monotonic();
        if (!isClose || mono + TIMINGS.closeRetry > sendBy - 200) {
          break;
        }
        await this.pause(TIMINGS.closeRetry, ticket);
      }
    }
    if (!session) {
      check(this.monotonic());
      if (isClose) {
        this.keepPendingClose(serial);
        throw this.refusal(ERRORS.closeKept(lastReason));
      }
      throw this.refusal(ERRORS.tooSlow(lastReason));
    }
    // The Remootio of this session is the one commanded (checked in this session).
    if (session.identity?.serial !== serial) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    check(this.monotonic());
    const kind = isClose ? 'close' : 'open';
    let guard;
    let response;
    try {
      response = await session.action(isClose ? ACTION.CLOSE : ACTION.OPEN, {
        timeout: Math.max(100, answerBy - this.monotonic()),
        // The very last checks, right before the frame is written; the guard
        // is saved to /data before the first byte.
        beforeSend: async () => {
          check(this.monotonic());
          guard = this.setGuard(serial, kind, { owner: ticket });
          try {
            await this.saveStrict();
          } catch {
            this.removeGuard(serial, guard);
            throw this.refusal(ERRORS.saveFailed);
          }
          try {
            check(this.monotonic(), guard);
          } catch (err) {
            this.removeGuard(serial, guard);
            this.save();
            throw err;
          }
          ticket.sent = true;
          this.logger.info(`Remootio ${serial}: ${key} sent`);
        },
      });
    } catch (err) {
      if (err.refusal) throw err;
      lastReason = reasonOf(err);
      if (!err.sent) {
        this.removeGuard(serial, guard);
        this.save();
        if (isClose) {
          this.keepPendingClose(serial);
          throw this.refusal(ERRORS.closeKept(lastReason));
        }
        throw this.refusal(ERRORS.tooSlow(lastReason));
      }
      // The frame may have reached the Remootio: the guard stays.
      this.logger.warn(`Remootio ${serial}: ${key} sent, NOT confirmed (${err.message})`);
      if (isClose) this.dropPendingClose(serial, 'sent');
      this.followUp(link, serial, isClose ? STATE.CLOSED : STATE.OPEN);
      throw this.refusal(ERRORS.sentUnconfirmed(lastReason));
    }
    if (guard) {
      guard.t100 = response.t100ms;
    }
    this.fresh(serial, response.state, response.t100ms);
    if (response.success && response.relayTriggered) {
      // Moving: a newer command that left cancels a kept close; a close that left ends it.
      this.dropPendingClose(serial, isClose ? 'sent' : 'a newer command was sent');
      this.followUp(link, serial, isClose ? STATE.CLOSED : STATE.OPEN);
      return;
    }
    // Nothing moved: the guard of this pulse goes.
    this.removeGuard(serial, guard);
    this.save();
    if (response.success) {
      // Already where it was sent (read by the Remootio itself).
      if (isClose) this.dropPendingClose(serial, 'already closed');
      return;
    }
    this.logger.warn(`Remootio ${serial}: ${key} refused (${response.errorCode || 'no code'})`);
    if (response.errorCode === 'ERR_NO_SENSOR') {
      throw this.refusal(ERRORS.noSensor);
    }
    if (response.errorCode === 'ERR_RELAY_BUSY') {
      if (isClose) {
        this.keepPendingClose(serial);
        // The output is busy for a moment: tried again soon on this session.
        const handle = this.timers.setTimeout(() => {
          this.retries.delete(handle);
          this.resumePendingClose(link);
        }, TIMINGS.busyRetry);
        this.retries.add(handle);
        throw this.refusal(ERRORS.relayBusyKept);
      }
      throw this.refusal(ERRORS.relayBusy);
    }
    throw this.refusal(ERRORS.refused(response.errorCode || '?'));
  }

  /** Waits `ms` (or until the ticket is cancelled). */
  pause(ms, ticket) {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(resolve, ms);
      ticket.wake = () => {
        this.timers.clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * The session a command uses: the one open if it answers (a PING first when
   * it was silent for 10 s; closed when stuck: an answer awaited with no byte
   * for 1 s), else a new one opened at once, never beside the old one.
   */
  async sessionFor(link, until, ticket) {
    if (ticket.cancelled) throw this.refusal(ERRORS.cancelled);
    let session = link.session;
    if (session?.ready) {
      const mono = this.monotonic();
      const idle = mono - (session.lastByteAt ?? -Infinity);
      const stuck = session.pending.size > 0 && idle >= TIMINGS.probeTimeout;
      if (!stuck && idle < TIMINGS.probeAfterIdle) {
        return session;
      }
      if (!stuck) {
        let ok = false;
        const answered = await this.within(
          session.ping(Math.max(50, Math.min(TIMINGS.probeTimeout, until - mono))).then(() => {
            ok = true;
          }),
          until,
          ticket,
        );
        ok = ok && answered;
        if (ticket.cancelled) throw this.refusal(ERRORS.cancelled);
        if (ok && session.ready && link.session === session) {
          return session;
        }
      }
      // Stuck or silent: closed (the socket destroyed) before a new one opens.
      session.close('stuck', undefined, { abort: true });
    }
    if (!link.opening) {
      const left = until - this.monotonic();
      if (left <= 0) {
        throw Object.assign(new Error('no time left'), { kind: 'timeout' });
      }
      this.connect(link, left).catch(() => {});
    }
    const opening = link.opening;
    if (!opening) {
      throw Object.assign(new Error('no session'), { kind: link.lastError ?? 'connect' });
    }
    let failure;
    const settled = await this.within(
      opening.catch((err) => {
        failure = err;
      }),
      until,
      ticket,
    );
    if (ticket.cancelled) throw this.refusal(ERRORS.cancelled);
    if (!settled) {
      throw Object.assign(new Error('not connected in time'), { kind: 'timeout' });
    }
    if (failure || !link.session?.ready) {
      throw failure ?? Object.assign(new Error('no session'), { kind: 'connect' });
    }
    return link.session;
  }

  /**
   * Reads after a pulse: at 5 s, 15 s and the end of the travel time. A door
   * not read where it was sent at the end is said in the status.
   */
  followUp(link, serial, expected) {
    for (const handle of this.followUps.get(serial) ?? []) {
      this.timers.clearTimeout(handle);
    }
    this.notReached.delete(serial);
    const last = this.guardLength() + 1000;
    const delays = [...TIMINGS.followUps.filter((d) => d < last), last];
    const handles = delays.map((delay) =>
      this.timers.setTimeout(() => {
        const session = link.session;
        if (!session?.ready || session.identity?.serial !== serial || this.stopped) {
          return;
        }
        this.query(link, session, TIMINGS.pingTimeout).then(
          (response) => {
            if (delay === last && response.state !== expected) {
              this.notReached.set(serial, expected);
              this.logger.warn(`Remootio ${serial}: not read ${expected} after the command`);
              this.updateStatus();
            }
          },
          () => this.logger.debug(`Remootio ${serial}: read after a command failed`),
        );
      }, delay),
    );
    this.followUps.set(serial, handles);
  }
}
