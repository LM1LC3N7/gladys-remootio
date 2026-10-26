// -----------------------------------------------------------------------------
// The ENCRYPTED frames against the worked example of the official Remootio
// API documentation (v3 specification, chapters 7 and 11: a real device's
// keys, challenge, QUERY and answer), and the frames refused.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameError,
  MAX_PAYLOAD_BASE64,
  decryptFrame,
  encryptFrame,
  keyFromHex,
  sessionKeyFrom,
} from '../src/remootio/crypto.js';
import {
  ACTION_ID_MODULO,
  nextActionId,
  parseChallenge,
  parseEvent,
  parseFrame,
  parseResponse,
} from '../src/remootio/protocol.js';

const SECRET = keyFromHex('EFD0E4BF75D49BDD4F5CD5492D55C92FE96040E9CD74BED9F19ACA2658EA0FA9');
const AUTH = keyFromHex('7B456E7AE95E55F714E2270983C33360514DAD96C93AE1990AFE35FD5BF00A72');
const SESSION = sessionKeyFrom('yzEI7RWCjYDEwFrgc5YrmWo82kXEjFNStbtN+wFM2Qk=');

const CHALLENGE = {
  type: 'ENCRYPTED',
  data: {
    iv: '4kbmkg6iU29Zlpi3NCDM4g==',
    payload:
      'ZTQwhEWXMV2ZxkzDJiJWyCD52FF88pha8lJbpD2KYk5B6TGQvBaTJlA7apd+lO38mu44NA7heNVZOc6B6jVwqvdqMSrEdV33KgaHMZY7yNXBq4aP3+Z2ai4TJ8Smgnj6Z77J4qeT6MqBbr0FTLYkEg==',
  },
  mac: 'qko4r2/Eucwh8FqJIXucKn/w/ftR9+vs05E8A1/y++Q=',
};
const ANSWER = {
  type: 'ENCRYPTED',
  data: {
    iv: 'S7Mt0PR3MCADhHOPqhJPLA==',
    payload:
      'pSw+jH9iR3/nOO2+78EpQct3w+vJGKku+8ynSaYra6WsU4dHQJfMg1KNJkooVb1/WYhT28NyGznEHEKt97SYTMG15KjWcQUuqRSlpGD3JzWi/5LG+JPvIg3ptivsFrRZR3wzHAtZI6CekFujm8dhjeK/o6w+daK4FdvVh78pVigX6tBuNHEjoRQfUL9TRS9W',
  },
  mac: 'cD4IpRARmeWoUjkL4Kh40uhOMbs7P9prP497qZUapwQ=',
};

test('the documentation example: the challenge, with the API Secret Key', () => {
  const payload = decryptFrame(CHALLENGE, { key: SECRET, authKey: AUTH });
  assert.deepEqual(parseChallenge(payload), {
    sessionKey: 'yzEI7RWCjYDEwFrgc5YrmWo82kXEjFNStbtN+wFM2Qk=',
    initialActionId: 808411243,
  });
});

test('the documentation example: the QUERY, byte for byte, with its IV', () => {
  const text = encryptFrame(
    { action: { type: 'QUERY', id: 808411244 } },
    { key: SESSION, authKey: AUTH, iv: Buffer.from('vz3r424R6v9XFchkkgWQTw==', 'base64') },
  );
  assert.equal(
    text,
    '{"type":"ENCRYPTED","data":{"iv":"vz3r424R6v9XFchkkgWQTw==","payload":"L6eTyvyY/q4I7oDAfdeDyz17x0vMUqmqvnCYl73zG2UxnYpIKVIQ0DooAWxcm3WT"},"mac":"legB+2ZnikMtX54VpkPVc8P7o17s61y1JqGDvFrxbts="}',
  );
  assert.equal(nextActionId(808411243), 808411244);
});

test('the documentation example: the answer, with the session key', () => {
  const response = parseResponse(decryptFrame(ANSWER, { key: SESSION, authKey: AUTH }));
  assert.deepEqual(response, {
    type: 'QUERY',
    id: 808411244,
    success: true,
    state: 'no sensor',
    t100ms: 8985,
    relayTriggered: false,
    errorCode: '',
  });
});

test('refused: a wrong MAC, the wrong key (padding), a bad shape, an oversized payload', () => {
  const check = (frame, keys, expected) =>
    assert.throws(
      () => decryptFrame(frame, keys),
      (err) => err instanceof FrameError && err.check === expected,
    );
  const keys = { key: SECRET, authKey: AUTH };
  check({ ...CHALLENGE, mac: Buffer.alloc(32).toString('base64') }, keys, 'mac');
  check(CHALLENGE, { key: SECRET, authKey: keyFromHex('0'.repeat(64)) }, 'mac');
  // The auth key right, the secret key wrong: the MAC passes, the padding does not.
  assert.throws(
    () => decryptFrame(CHALLENGE, { key: keyFromHex('1'.repeat(64)), authKey: AUTH }),
    (err) => err instanceof FrameError && ['padding', 'json'].includes(err.check),
  );
  check({ type: 'ENCRYPTED', data: { iv: 'x', payload: 'y' }, mac: 'z' }, keys, 'shape');
  check({ ...CHALLENGE, data: { ...CHALLENGE.data, extra: 1 } }, keys, 'shape');
  check({ ...CHALLENGE, data: [] }, keys, 'shape');
  check(
    { ...CHALLENGE, data: { ...CHALLENGE.data, payload: 'A'.repeat(MAX_PAYLOAD_BASE64 + 4) } },
    keys,
    'shape',
  );
});

test('keys: 64 hexadecimal digits only; a session key is 32 bytes', () => {
  assert.equal(keyFromHex('ab'.repeat(32)), undefined, 'upper case only (normalized before)');
  assert.equal(keyFromHex('AB'.repeat(31)), undefined);
  assert.equal(keyFromHex('G'.repeat(64)), undefined);
  assert.equal(keyFromHex('AB'.repeat(32)).length, 32);
  assert.equal(sessionKeyFrom(Buffer.alloc(16).toString('base64')), undefined);
  assert.equal(sessionKeyFrom('not base64 at all, but forty-four chars!!!!'), undefined);
});

test('frames: own properties only, strict types, unknown is unknown', () => {
  assert.equal(parseFrame('not json'), null);
  assert.equal(parseFrame('[1]'), null);
  assert.equal(parseFrame('{"type":"OTHER"}'), null);
  assert.deepEqual(
    parseFrame(
      '{"type":"SERVER_HELLO","apiVersion":3,"serialNumber":"2462ABE6bda0nfmcfaxm","remootioVersion":"remootio-2"}',
    ),
    { kind: 'hello', apiVersion: 3, serial: '2462abe6bda0nfmcfaxm', model: 'remootio-2' },
  );
  assert.equal(parseFrame('{"type":"SERVER_HELLO","serialNumber":"a/b"}').serial, undefined);
  assert.deepEqual(parseFrame('{"type":"ERROR","errorMessage":"authentication error\\n"}'), {
    kind: 'error',
    message: 'authentication error',
  });
  const polluted = JSON.parse('{"response":{"__proto__":{"id":1}}}');
  assert.equal(parseResponse(polluted), null);
  assert.equal(
    parseResponse({
      response: { type: 'QUERY', id: 1, success: 'true', t100ms: 1, relayTriggered: false },
    }),
    null,
    'a text is not a boolean',
  );
  assert.equal(
    parseResponse({
      response: {
        type: 'QUERY',
        id: ACTION_ID_MODULO + 1,
        success: true,
        t100ms: 1,
        relayTriggered: false,
      },
    }),
    null,
  );
  const odd = parseResponse({
    response: {
      type: 'QUERY',
      id: 1,
      success: true,
      state: 'ajar',
      t100ms: 1,
      relayTriggered: false,
    },
  });
  assert.equal(odd.state, undefined, 'an unknown state is never open nor closed');
  assert.deepEqual(
    parseEvent({
      event: {
        cnt: 1,
        type: 'RelayTrigger',
        state: 'closed',
        t100ms: 5,
        data: { keyNr: 2, keyType: 'guest key', via: 'wifi' },
      },
    }),
    {
      type: 'RelayTrigger',
      cnt: 1,
      t100ms: 5,
      state: 'closed',
      keyType: 'guest key',
      keyNr: 2,
      via: 'wifi',
    },
  );
  assert.equal(parseEvent({ event: { type: 'StateChange', t100ms: -1 } }), null);
  assert.equal(nextActionId(ACTION_ID_MODULO - 1), 0, 'truncated to 31 bits');
});
