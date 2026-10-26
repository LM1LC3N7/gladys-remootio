// -----------------------------------------------------------------------------
// The ENCRYPTED frames of the Remootio Websocket API (v3 specification,
// chapter 11), ported from the official documentation
// (github.com/remootio/remootio-api-documentation) and aioremootio
// (Apache-2.0, see THIRD_PARTY_NOTICES.md):
//
//   - the payload is a JSON text (Latin-1), PKCS#7-padded, AES-256-CBC with a
//     random 16-byte IV; the key is the API Secret Key (64 hex digits) for the
//     authentication challenge only, then the session key the challenge gives
//     (32 bytes, base64);
//   - the MAC is HMAC-SHA256 with the API Auth Key over the exact text
//     `{"iv":"<base64>","payload":"<base64>"}` ("iv" first), base64;
//   - a frame received is used only when its MAC matches (compared in
//     constant time) AND its padding is valid.
//
// The keys never leave this module in any form: no log, no error text holds
// them (the errors only say which check failed).
// -----------------------------------------------------------------------------

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** A payload received is a few hundred bytes: more is refused before any work. */
export const MAX_PAYLOAD_BASE64 = 8 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64 = /^[0-9A-F]{64}$/;

export class FrameError extends Error {
  constructor(check) {
    super(`encrypted frame refused (${check})`);
    this.name = 'FrameError';
    /** 'shape' | 'mac' | 'padding' | 'json' */
    this.check = check;
  }
}

/** A 64-hex-digit key of the Remootio app -> 32 bytes; undefined when it is not one. */
export function keyFromHex(text) {
  if (typeof text !== 'string' || !HEX64.test(text)) {
    return undefined;
  }
  return Buffer.from(text, 'hex');
}

/** The session key of a challenge (base64 of 32 bytes) -> 32 bytes, or undefined. */
export function sessionKeyFrom(text) {
  if (typeof text !== 'string' || text.length !== 44 || !BASE64.test(text)) {
    return undefined;
  }
  const key = Buffer.from(text, 'base64');
  return key.length === 32 ? key : undefined;
}

const macOf = (authKey, data) => createHmac('sha256', authKey).update(data, 'latin1').digest();

/** The text the MAC covers: "iv" first, as the Remootio computes it. */
const macBase = (iv, payload) => JSON.stringify({ iv, payload });

/**
 * An UNENCRYPTED_PAYLOAD (an object) -> the text of its ENCRYPTED frame.
 * `iv` is only given by the tests (the documentation's example).
 */
export function encryptFrame(payload, { key, authKey, iv = randomBytes(16) }) {
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'latin1')),
    cipher.final(),
  ]);
  const ivText = iv.toString('base64');
  const payloadText = encrypted.toString('base64');
  const mac = macOf(authKey, macBase(ivText, payloadText)).toString('base64');
  return JSON.stringify({ type: 'ENCRYPTED', data: { iv: ivText, payload: payloadText }, mac });
}

/**
 * An ENCRYPTED frame (parsed JSON) -> its UNENCRYPTED_PAYLOAD (an object).
 * @throws {FrameError} shape, MAC, padding or JSON refused
 */
export function decryptFrame(frame, { key, authKey }) {
  const data = frame?.data;
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).length !== 2 ||
    typeof data.iv !== 'string' ||
    typeof data.payload !== 'string' ||
    typeof frame.mac !== 'string' ||
    data.iv.length !== 24 ||
    !BASE64.test(data.iv) ||
    data.payload.length > MAX_PAYLOAD_BASE64 ||
    data.payload.length % 4 !== 0 ||
    !BASE64.test(data.payload) ||
    frame.mac.length !== 44 ||
    !BASE64.test(frame.mac)
  ) {
    throw new FrameError('shape');
  }
  const received = Buffer.from(frame.mac, 'base64');
  // Over the "data" object as received (its key order kept), as the
  // documentation's client and aioremootio compute it.
  const expected = macOf(authKey, JSON.stringify(data));
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new FrameError('mac');
  }
  const iv = Buffer.from(data.iv, 'base64');
  const ciphertext = Buffer.from(data.payload, 'base64');
  if (iv.length !== 16 || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new FrameError('shape');
  }
  let plain;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new FrameError('padding');
  }
  let payload;
  try {
    payload = JSON.parse(plain.toString('latin1'));
  } catch {
    throw new FrameError('json');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new FrameError('json');
  }
  return payload;
}
