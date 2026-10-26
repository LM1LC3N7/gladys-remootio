// -----------------------------------------------------------------------------
// The frames of the Remootio Websocket API (v3 specification; v1 and v2 use
// the same frames for what this integration needs), checked strictly (pure).
// Ported from the official documentation and aioremootio (Apache-2.0).
//
// Every value read from the network is checked: own properties only, the
// types and ranges the specification gives, texts bounded; anything else is
// "not understood" (null), never a guess.
// -----------------------------------------------------------------------------

/** Door states of the API. */
export const STATE = Object.freeze({ OPEN: 'open', CLOSED: 'closed', NO_SENSOR: 'no sensor' });
const STATES = new Set(Object.values(STATE));

/** The action ids are 31-bit counters. */
export const ACTION_ID_MODULO = 0x7fffffff;
export const nextActionId = (last) => (last + 1) % ACTION_ID_MODULO;

/** The actions this integration sends. Never TRIGGER (a blind toggle) nor RESTART. */
export const ACTION = Object.freeze({ QUERY: 'QUERY', OPEN: 'OPEN', CLOSE: 'CLOSE' });
const ACTIONS = new Set(Object.values(ACTION));

/** The event types this integration uses; the others are only logged at debug. */
export const EVENT = Object.freeze({
  STATE_CHANGE: 'StateChange',
  RELAY_TRIGGER: 'RelayTrigger',
  LEFT_OPEN: 'LeftOpen',
  RESTART: 'Restart',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const isCount = (v, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= 0 && v <= max;

/** A text of the device: printable ASCII only, cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .slice(0, max * 2)
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, max);
}

/** A serial number of a Remootio: the external id of its device (frozen). */
export const SERIAL = /^[0-9a-z]{6,40}$/;

/**
 * A frame received (text) -> `{ kind, ... }`, or null when it is not one
 * of the API.
 *   - { kind: 'hello', apiVersion, serial, model }
 *   - { kind: 'error', message }
 *   - { kind: 'pong' }
 *   - { kind: 'encrypted', frame }
 */
export function parseFrame(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(frame)) {
    return null;
  }
  switch (own(frame, 'type')) {
    case 'SERVER_HELLO': {
      const apiVersion = own(frame, 'apiVersion');
      const serial = cleanText(own(frame, 'serialNumber'), 40).toLowerCase();
      const model = own(frame, 'remootioVersion');
      return {
        kind: 'hello',
        apiVersion: isCount(apiVersion, 1000) ? apiVersion : undefined,
        serial: SERIAL.test(serial) ? serial : undefined,
        model: model === 'remootio-1' || model === 'remootio-2' ? model : undefined,
      };
    }
    case 'ERROR':
      return { kind: 'error', message: cleanText(own(frame, 'errorMessage'), 40) };
    case 'PONG':
      return { kind: 'pong' };
    case 'ENCRYPTED':
      return { kind: 'encrypted', frame };
    default:
      return null;
  }
}

/** The authentication challenge (decrypted with the API Secret Key), or null. */
export function parseChallenge(payload) {
  const challenge = own(payload, 'challenge');
  if (!isObject(challenge)) {
    return null;
  }
  const sessionKey = own(challenge, 'sessionKey');
  const initialActionId = own(challenge, 'initialActionId');
  if (typeof sessionKey !== 'string' || !isCount(initialActionId, ACTION_ID_MODULO)) {
    return null;
  }
  return { sessionKey, initialActionId };
}

/** The response to an action, or null. */
export function parseResponse(payload) {
  const response = own(payload, 'response');
  if (!isObject(response)) {
    return null;
  }
  const type = own(response, 'type');
  const id = own(response, 'id');
  const success = own(response, 'success');
  const state = own(response, 'state');
  const t100ms = own(response, 't100ms');
  const relayTriggered = own(response, 'relayTriggered');
  if (
    typeof type !== 'string' ||
    !isCount(id, ACTION_ID_MODULO) ||
    typeof success !== 'boolean' ||
    !isCount(t100ms) ||
    typeof relayTriggered !== 'boolean'
  ) {
    return null;
  }
  return {
    type: ACTIONS.has(type) ? type : cleanText(type, 32),
    id,
    success,
    // An unknown state is unknown, never "open" nor "closed".
    state: STATES.has(state) ? state : undefined,
    t100ms,
    relayTriggered,
    errorCode: cleanText(own(response, 'errorCode'), 40),
  };
}

/** An event, or null. */
export function parseEvent(payload) {
  const event = own(payload, 'event');
  if (!isObject(event)) {
    return null;
  }
  const type = own(event, 'type');
  const cnt = own(event, 'cnt');
  const t100ms = own(event, 't100ms');
  const state = own(event, 'state');
  if (typeof type !== 'string' || !isCount(t100ms)) {
    return null;
  }
  const data = own(event, 'data');
  const out = {
    type: cleanText(type, 40),
    cnt: isCount(cnt) ? cnt : undefined,
    t100ms,
    state: STATES.has(state) ? state : undefined,
  };
  if (isObject(data)) {
    const keyType = cleanText(own(data, 'keyType'), 20);
    const keyNr = own(data, 'keyNr');
    const via = cleanText(own(data, 'via'), 20);
    if (keyType) out.keyType = keyType;
    if (isCount(keyNr, 100_000)) out.keyNr = keyNr;
    if (via) out.via = via;
  }
  return out;
}

/** The UNENCRYPTED_PAYLOAD of an action. */
export const actionPayload = (type, id) => ({ action: { type, id } });
