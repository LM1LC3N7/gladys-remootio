// -----------------------------------------------------------------------------
// The pure parts: the configuration, /data read back, the Gladys device.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseHost, parseKey } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { buildDevice, doorValue } from '../src/model.js';
import { GUARD_MAX, sanitize } from '../src/store.js';

const KEY = 'ab'.repeat(32);

test('addresses: IPv4, host names, a pasted URL; port 8080 by default; credentials refused', () => {
  assert.deepEqual(parseHost(' 192.168.1.115 '), {
    host: '192.168.1.115',
    port: 8080,
    address: '192.168.1.115',
  });
  assert.equal(parseHost('ws://192.168.1.115:8080/').address, '192.168.1.115');
  assert.equal(parseHost('192.168.1.115:9000').address, '192.168.1.115:9000');
  assert.equal(
    parseHost('remootio_2462abe6bda0nfmcfaxm.local').host,
    'remootio_2462abe6bda0nfmcfaxm.local',
  );
  for (const bad of ['', 'user:pw@1.2.3.4', '1.2.3.999', '1.2.3.4:0', 'a b', '-x.local']) {
    assert.equal(parseHost(bad), undefined, bad);
  }
});

test('keys: 64 hex digits, spaces and case ignored; otherwise only a length', () => {
  assert.equal(parseKey(` ${KEY.slice(0, 32)} ${KEY.slice(32)} `).key.length, 32);
  assert.deepEqual(parseKey('secret'), { problem: 'invalid', length: 6 });
  assert.deepEqual(parseKey(''), { problem: 'missing' });
  assert.deepEqual(parseKey(undefined), { problem: 'missing' });
});

test('the configuration: off by default, travel time bounded, slots', () => {
  const empty = normalizeConfig({});
  assert.equal(empty.allowOpen, false);
  assert.equal(empty.allowClose, false);
  assert.equal(empty.travelTime, 30_000);
  assert.ok(empty.slots.every((s) => !s.configured && !s.usable));
  const c = normalizeConfig({
    host_1: '10.0.0.2',
    secret_key_1: KEY,
    auth_key_1: KEY.toUpperCase(),
    allow_open: 'yes',
    allow_close: 'yes',
    travel_time: '500',
    host_2: '10.0.0.3',
  });
  assert.equal(c.allowOpen, false, 'only true allows');
  assert.equal(c.allowClose, false, 'only true allows');
  assert.equal(c.travelTime, 120_000);
  assert.equal(c.slots[0].usable, true);
  assert.equal(c.slots[1].configured, true);
  assert.equal(c.slots[1].usable, false);
  assert.deepEqual(c.slots[1].keyProblems.secret, { problem: 'missing' });
  assert.equal(normalizeConfig({ allow_open: true }).allowOpen, true);
  assert.equal(normalizeConfig({ allow_open: true }).allowClose, false, 'independent');
  assert.equal(normalizeConfig({ allow_close: true }).allowClose, true);
  assert.equal(normalizeConfig({ allow_close: true }).allowOpen, false, 'independent');
  assert.equal(normalizeConfig({ travel_time: '' }).travelTime, 30_000);
  assert.equal(normalizeConfig({ travel_time: 1 }).travelTime, 10_000);
  // A change of keys changes the generation; the generation is a hash, never a key.
  const other = normalizeConfig({
    host_1: '10.0.0.2',
    secret_key_1: KEY,
    auth_key_1: 'CD'.repeat(32),
  });
  assert.notEqual(other.slots[0].generationKey, c.slots[0].generationKey);
  assert.ok(!c.slots[0].generationKey.includes(KEY.toUpperCase().slice(0, 16)));
});

test('/data read back: checked, bounded, a guard never longer than its maximum', () => {
  const now = 1_800_000_000_000;
  const data = sanitize(
    {
      salt: 'x',
      devices: {
        '2462abe6bda0nfmcfaxm': { serial: '2462abe6bda0nfmcfaxm', slot: 1, address: '10.0.0.2' },
        __proto__: { serial: '__proto__' },
        'bad serial': { serial: 'bad serial' },
      },
      guards: {
        '2462abe6bda0nfmcfaxm': { kind: 'open', at: now + 60_000, until: now + 10 * 3_600_000 },
        other1: { kind: 'switch', at: now, until: now + 1000 },
      },
      pendingCloses: {
        '2462abe6bda0nfmcfaxm': { at: now - 1000, tries: 1 },
        old0000000: { at: now - TIMINGS.pendingCloseFor - 1, tries: 0 },
      },
      refused: { 1: { fingerprint: 'f'.repeat(64), at: now }, 3: { fingerprint: 'f'.repeat(64) } },
      attempts: { 1: now + 1000, 2: 'x' },
    },
    now,
  );
  assert.match(data.salt, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(data.devices), ['2462abe6bda0nfmcfaxm']);
  assert.equal(data.devices['2462abe6bda0nfmcfaxm'].slot, 1);
  const guard = data.guards['2462abe6bda0nfmcfaxm'];
  assert.equal(guard.at, now, 'never in the future');
  assert.equal(guard.until, now + GUARD_MAX);
  assert.equal(data.guards.other1, undefined);
  assert.deepEqual(Object.keys(data.pendingCloses), ['2462abe6bda0nfmcfaxm']);
  assert.deepEqual(Object.keys(data.refused), ['1']);
  assert.deepEqual(data.attempts, { 1: now });
});

test('the Gladys device: by serial number, buttons, the door state', () => {
  const gladys = createFakeGladys({ selector: 'remootio' });
  const device = buildDevice(
    gladys,
    { serial: '2462abe6bda0nfmcfaxm', address: '10.0.0.2', model: 'remootio-2' },
    { language: 'en' },
  );
  assert.equal(device.external_id, 'ext:remootio:remootio:2462abe6bda0nfmcfaxm');
  assert.equal(device.name, 'Remootio mcfaxm');
  assert.deepEqual(
    device.features.map((f) => f.name),
    ['Gate or garage door', 'Open', 'Close'],
  );
  assert.deepEqual(device.params, [
    { name: 'IP_ADDRESS', value: '10.0.0.2' },
    { name: 'SERIAL_NUMBER', value: '2462abe6bda0nfmcfaxm' },
    { name: 'MODEL', value: 'remootio-2' },
  ]);
  assert.equal(doorValue('closed'), 1);
  assert.equal(doorValue('open'), 0);
  assert.equal(doorValue('no sensor'), undefined);
  assert.equal(doorValue(undefined), undefined);
});
