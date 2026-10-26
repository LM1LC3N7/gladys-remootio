// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume), in /data/remootio.json:
//   - the known Remootio devices (by serial number) and the slot of the
//     configuration they answered on, so a door can be closed after a restart
//     before any event, and a created device never loses a feature;
//   - the guard of the last pulse of each door (when it left, when it ends):
//     a restart never lets a second pulse stop or reverse a moving door;
//   - a close that could not leave yet (sent again at the next session,
//     within 2 minutes, 3 times at most);
//   - the API keys a Remootio REFUSED: a salted fingerprint of the pair only
//     (never a key, never a fingerprint of keys that work), removed at the
//     first success, so refused keys are never replayed in a loop;
//   - the time of the last connection attempt of each slot (written at most
//     once a minute).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHost } from './config.js';
import { LIMITS, SLOTS, TIMINGS, TRAVEL_TIME } from './constants.js';
import { SERIAL } from './remootio/protocol.js';

export const newSalt = () => randomBytes(16).toString('hex');

export const emptyData = () => ({
  salt: newSalt(),
  devices: {},
  guards: {},
  pendingCloses: {},
  refused: {},
  attempts: {},
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SLOT_KEYS = new Set(SLOTS.map(String));
/** The longest guard: the longest travel time and its margin. */
export const GUARD_MAX = TRAVEL_TIME.max * 1000 + TIMINGS.guardMargin;

/**
 * What a file holds, checked: unknown keys dropped, ids and addresses checked,
 * every end never later than its longest bound from now (a clock that jumped,
 * a file edited by hand), every start never in the future.
 */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)) {
    base.salt = data.salt;
  }
  if (isObject(data.devices)) {
    for (const [serial, record] of Object.entries(data.devices).slice(0, LIMITS.records)) {
      if (!SERIAL.test(serial) || !isObject(record) || record.serial !== serial) {
        continue;
      }
      const address = typeof record.address === 'string' ? record.address : '';
      base.devices[serial] = {
        serial,
        slot: SLOT_KEYS.has(String(record.slot)) ? Number(record.slot) : undefined,
        address: parseHost(address)?.address === address ? address : '',
        model: record.model === 'remootio-1' || record.model === 'remootio-2' ? record.model : '',
        apiVersion: Number.isInteger(record.apiVersion) ? record.apiVersion : undefined,
      };
    }
  }
  if (isObject(data.guards)) {
    for (const [serial, guard] of Object.entries(data.guards).slice(0, LIMITS.records)) {
      if (
        !SERIAL.test(serial) ||
        !isObject(guard) ||
        (guard.kind !== 'open' && guard.kind !== 'close') ||
        !Number.isFinite(guard.until)
      ) {
        continue;
      }
      const at = Number.isFinite(guard.at) ? Math.min(guard.at, now) : now;
      base.guards[serial] = {
        kind: guard.kind,
        at,
        until: Math.min(guard.until, now + GUARD_MAX),
      };
    }
  }
  if (isObject(data.pendingCloses)) {
    for (const [serial, pending] of Object.entries(data.pendingCloses).slice(0, LIMITS.records)) {
      if (!SERIAL.test(serial) || !isObject(pending) || !Number.isFinite(pending.at)) {
        continue;
      }
      const at = Math.min(pending.at, now);
      const tries = Number.isInteger(pending.tries) ? Math.max(0, pending.tries) : 0;
      if (now - at < TIMINGS.pendingCloseFor && tries < TIMINGS.pendingCloseTries) {
        base.pendingCloses[serial] = { at, tries };
      }
    }
  }
  if (isObject(data.refused)) {
    for (const [slot, refusal] of Object.entries(data.refused)) {
      if (
        SLOT_KEYS.has(slot) &&
        isObject(refusal) &&
        typeof refusal.fingerprint === 'string' &&
        /^[0-9a-f]{64}$/.test(refusal.fingerprint)
      ) {
        base.refused[slot] = {
          fingerprint: refusal.fingerprint,
          at: Number.isFinite(refusal.at) ? Math.min(refusal.at, now) : now,
        };
      }
    }
  }
  if (isObject(data.attempts)) {
    for (const [slot, at] of Object.entries(data.attempts)) {
      if (SLOT_KEYS.has(slot) && Number.isFinite(at)) {
        base.attempts[slot] = Math.min(at, now);
      }
    }
  }
  return base;
}

export class FileStore {
  constructor({
    dir = process.env.DATA_DIR || '/data',
    name = 'remootio.json',
    now = Date.now,
  } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.now = now;
  }

  async load() {
    try {
      return sanitize(JSON.parse(await readFile(this.path, 'utf8')), this.now());
    } catch {
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData(), now = Date.now) {
    this.data = structuredClone(data);
    this.saves = 0;
    this.now = now;
    /** A test may make the next saves fail. */
    this.failing = false;
  }

  async load() {
    return sanitize(structuredClone(this.data), this.now());
  }

  async save(data) {
    if (this.failing) {
      throw new Error('disk full');
    }
    this.data = structuredClone(data);
    this.saves += 1;
  }
}
