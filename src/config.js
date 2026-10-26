// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The API keys are
// kept here only: never logged, never in /data (only a salted fingerprint of a
// pair of keys a Remootio REFUSED, removed at the first success), never in a
// status or an error; an invalid key is never shown back (it is only said
// invalid, with its length).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { API_PORT, SLOTS, TRAVEL_TIME } from './constants.js';
import { keyFromHex } from './remootio/crypto.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  allow_open: false,
  travel_time: TRAVEL_TIME.default,
  language: 'fr',
};

/** The fields without a default in the manifest (the keys are secrets). */
const OPTIONAL = Object.fromEntries(
  SLOTS.flatMap((n) => [
    [`host_${n}`, ''],
    [`secret_key_${n}`, ''],
    [`auth_key_${n}`, ''],
  ]),
);

const LABEL = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * An address typed by the user: an IPv4 address or a host name (the mDNS
 * `remootio_<serial>.local` included), with an optional port (8080 when
 * absent). A pasted URL ("ws://192.168.1.115:8080") is reduced to its host;
 * credentials in it are refused.
 * @returns {{ host: string, port: number, address: string } | undefined}
 */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  text = text.replace(/^(?:wss?|https?):\/\//i, '').replace(/[/?#].*$/, '');
  if (text.includes('@')) {
    return undefined;
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return undefined;
  }
  const [, host, portText] = match;
  const port = portText === undefined ? API_PORT : Number(portText);
  if (port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  const valid =
    IPV4.test(host) || (!/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l)));
  if (!valid) {
    return undefined;
  }
  return { host, port, address: port === API_PORT ? host : `${host}:${port}` };
}

/** A key as the Remootio app shows it: 64 hexadecimal digits (spaces and case ignored). */
export function parseKey(raw) {
  if (typeof raw !== 'string') {
    return { problem: 'missing' };
  }
  const text = raw.replace(/\s+/g, '').toUpperCase();
  if (text === '') {
    return { problem: 'missing' };
  }
  const key = keyFromHex(text);
  // Only the length is ever shown: the text may be a key pasted in the wrong field.
  return key ? { key } : { problem: 'invalid', length: Math.min(text.length, 999) };
}

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The configuration of one Remootio:
 *   { slot, configured, host?, port?, address?, hostProblem?, secretKey?,
 *     authKey?, keyProblems: { secret?, auth? }, generationKey }
 */
function slotOf(c, n) {
  const hostText = String(c[`host_${n}`] ?? '').trim();
  const secret = parseKey(c[`secret_key_${n}`]);
  const auth = parseKey(c[`auth_key_${n}`]);
  const configured = hostText !== '' || !secret.problem || !auth.problem;
  const host = parseHost(hostText);
  const slot = {
    slot: n,
    configured,
    hostProblem: !configured
      ? undefined
      : hostText === ''
        ? 'missing'
        : host
          ? undefined
          : 'invalid',
    keyProblems: {},
  };
  if (host) {
    Object.assign(slot, host);
  }
  if (secret.key) {
    slot.secretKey = secret.key;
  } else if (configured) {
    slot.keyProblems.secret = secret;
  }
  if (auth.key) {
    slot.authKey = auth.key;
  } else if (configured) {
    slot.keyProblems.auth = auth;
  }
  slot.usable = Boolean(host && secret.key && auth.key);
  // What starts a new session when it changes: compared in memory only
  // (a hash, never stored, never shown).
  slot.generationKey = createHash('sha256')
    .update(
      JSON.stringify([
        slot.address ?? '',
        secret.key?.toString('hex') ?? '',
        auth.key?.toString('hex') ?? '',
      ]),
    )
    .digest('hex');
  return slot;
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...OPTIONAL };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const travel = numberOf(c.travel_time);
  return {
    slots: SLOTS.map((n) => slotOf(c, n)),
    allowOpen: strictTrue(c.allow_open),
    /** ms */
    travelTime:
      1000 *
      (travel === undefined
        ? TRAVEL_TIME.default
        : Math.min(TRAVEL_TIME.max, Math.max(TRAVEL_TIME.min, Math.round(travel)))),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
