// -----------------------------------------------------------------------------
// RemootioApp end to end: the SDK's fake Gladys and the exact handlers of the
// container, a fake Remootio on a real loopback socket (real frames, real
// cryptography), a memory store and a virtual clock (test/helpers/app.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { startOnConnect } from '../src/handlers.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { AUTH, SECRET, SERIAL, startFakeRemootio } from './helpers/fakeRemootio.js';
import { D, F, NOW, advanceUntil, createAll, press, setup, tick, until } from './helpers/app.js';

const statusFr = (gladys) => gladys.fake.connectionStatus.message.fr;

test('a session: identity, discovery (buttons, never a switch), state, transport', async (t) => {
  const { gladys, app, fake, ready, advance } = await setup(t, { config: { allow_open: false } });
  await ready();
  assert.deepEqual(
    fake.received.slice(0, 2).map((r) => r.type),
    ['HELLO', 'AUTH'],
    'the identity is read before any key is used',
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    statusFr(gladys),
    /Remootio 1 \(127\.0\.0\.1:\d+, 2462abe6bda0nfmcfaxm\) : connecté/,
  );
  assert.match(statusFr(gladys), /Commandes désactivées/);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, D());
  assert.deepEqual(
    device.features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type, f.read_only]),
    [
      ['door', 'opening-sensor', 'binary', true],
      ['open', 'button', 'push', false],
      ['close', 'button', 'push', false],
    ],
  );
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  await createAll(gladys);
  await advance(1000);
  assert.equal(gladys.fake.lastState(F('door')), 1, 'closed, from the first QUERY');
  fake.setState('open');
  await until(() => app.lastValues.get(F('door'))?.state === 0);
  await advance(1000);
  assert.equal(gladys.fake.lastState(F('door')), 0);
  assert.deepEqual(gladys.fake.transports.at(-1), { device_external_id: D(), transport: 'local' });
});

test('commands are off by default: Open AND Close refused, nothing sent', async (t) => {
  const { gladys, fake, ready } = await setup(t, { config: { allow_open: undefined } });
  await ready();
  await createAll(gladys);
  const open = await press(gladys, 'open');
  assert.equal(open.success, false);
  assert.match(open.error, /L’ouverture est désactivée/);
  fake.state = 'open';
  const close = await press(gladys, 'close');
  assert.equal(close.success, false);
  assert.match(close.error, /Fermer déclenche la même sortie qu’ouvrir/);
  assert.deepEqual(fake.actions(), ['QUERY'], 'only the QUERY of the authentication');
  assert.equal(fake.pulses.length, 0);
});

test('open: the guard is in /data before the frame is written; then held for the travel time', async (t) => {
  const { gladys, fake, ready, store, advance } = await setup(t);
  await ready();
  await createAll(gladys);
  let guardWhenSent;
  fake.onAction = (type) => {
    if (type === 'OPEN') guardWhenSent = structuredClone(store.data.guards[SERIAL]);
  };
  const ack = await press(gladys, 'open');
  assert.deepEqual(ack, { success: true });
  assert.equal(guardWhenSent?.kind, 'open', 'saved before the first byte');
  assert.deepEqual(
    fake.pulses.map((p) => p.type),
    ['OPEN'],
  );
  await until(() => fake.state === 'open');
  // The door reads "open" at once but is still moving: no pulse for travel + 5 s.
  const close = await press(gladys, 'close');
  assert.match(close.error, /vient d’être actionné/);
  await advance(34_000);
  assert.match((await press(gladys, 'close')).error, /vient d’être actionné/);
  await advance(1100);
  assert.deepEqual(await press(gladys, 'close'), { success: true });
  assert.deepEqual(
    fake.pulses.map((p) => p.type),
    ['OPEN', 'CLOSE'],
  );
});

test('close: a fresh "closed" after the pulse lifts its guard early', async (t) => {
  const { gladys, app, fake, ready } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.moveAfter = undefined;
  assert.deepEqual(await press(gladys, 'close'), { success: true });
  assert.match((await press(gladys, 'open')).error, /vient d’être actionné/);
  fake.setState('closed');
  await until(() => app.guards.size === 0);
  assert.deepEqual(await press(gladys, 'open'), { success: true });
});

test('already there: the Remootio answers without a pulse, the guard goes', async (t) => {
  const { gladys, fake, ready, store } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  assert.deepEqual(await press(gladys, 'open'), { success: true });
  assert.equal(fake.pulses.length, 0);
  assert.deepEqual(fake.actions(), ['QUERY', 'OPEN']);
  await until(() => store.data.guards[SERIAL] === undefined);
  assert.deepEqual(await press(gladys, 'close'), { success: true }, 'no guard left behind');
});

test('no status sensor: Open and Close refused by the Remootio, nothing moved', async (t) => {
  const { gladys, fake, ready } = await setup(t, {
    fake: await startFakeRemootio({ state: 'no sensor' }),
  });
  await ready();
  await createAll(gladys);
  const ack = await press(gladys, 'open');
  assert.match(ack.error, /pas de capteur d’état/);
  assert.equal(fake.pulses.length, 0);
  assert.equal(gladys.fake.lastState(F('door')), undefined, 'no state published without a sensor');
});

test('a busy output (another key drives it): a guard of the travel, nothing sent again', async (t) => {
  const { gladys, app, fake, ready, advance, store } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.relay = 'busy';
  const ack = await press(gladys, 'close');
  assert.match(ack.error, /en train d’être actionnée.*va bouger, rien n’a été envoyé/);
  assert.equal(app.guards.get(SERIAL)?.kind, 'close', 'the door is about to close');
  await advance(1000);
  assert.equal(store.data.guards[SERIAL]?.kind, 'close');
  assert.equal(store.data.pendingCloses[SERIAL], undefined, 'never kept');
  fake.relay = 'ok';
  for (let i = 0; i < 10; i += 1) {
    await advance(1000);
    await tick();
  }
  assert.equal(fake.pulses.length, 0, 'no pulse into the moving door');
  assert.match((await press(gladys, 'close')).error, /vient d’être actionné/);
});

test('a value other than 1, a read-only feature: refused', async (t) => {
  const { gladys, ready } = await setup(t);
  await ready();
  await createAll(gladys);
  for (const value of [0, '', null, true, '1x']) {
    assert.match((await press(gladys, 'open', { value })).error, /Valeur invalide/);
  }
  assert.match((await press(gladys, 'door')).error, /ne se commande pas/);
});

test('a session silent for 10 s is probed; with no PONG it is replaced before the close leaves', async (t) => {
  const { gladys, fake, ready, advance } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  await advance(11_000);
  fake.silent = true;
  const ack = press(gladys, 'close');
  await until(() => fake.received.at(-1)?.type === 'PING');
  fake.silent = false;
  await advance(1000);
  assert.deepEqual(await ack, { success: true });
  assert.equal(fake.connections, 2, 'a new connection, after the old one was closed');
  assert.deepEqual(
    fake.pulses.map((p) => p.type),
    ['CLOSE'],
  );
});

test('a close that cannot leave in time is kept, then sent at the next session', async (t) => {
  const { gladys, fake, ready, advance, store } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.silent = true;
  fake.kick();
  await until(() => gladys.fake.connectionStatus.connected === false);
  const pending = press(gladys, 'close');
  // The close tries again every 250 ms within its 3.5 s budget.
  for (let i = 0; i < 16; i += 1) {
    await tick();
    await advance(250);
  }
  const ack = await pending;
  assert.match(ack.error, /La fermeture est gardée/);
  assert.ok(store.data.pendingCloses[SERIAL]);
  assert.equal(fake.pulses.length, 0);
  fake.silent = false;
  fake.kick();
  await advanceUntil(advance, () => fake.pulses.length === 1);
  assert.equal(fake.pulses[0].type, 'CLOSE');
  await until(() => store.data.pendingCloses[SERIAL] === undefined);
});

test('a close cancels an opening not written yet', async (t) => {
  const { gladys, fake, ready, advance } = await setup(t);
  await ready();
  await createAll(gladys);
  fake.silent = true;
  fake.kick();
  await until(() => gladys.fake.connectionStatus.connected === false);
  const opening = press(gladys, 'open');
  await until(() => fake.received.filter((r) => r.type === 'HELLO').length >= 2);
  const closing = press(gladys, 'close');
  assert.match((await opening).error, /Annulée par une commande de fermeture/);
  for (let i = 0; i < 16; i += 1) {
    await tick();
    await advance(250);
  }
  assert.match((await closing).error, /La fermeture est gardée/);
  assert.equal(fake.pulses.length, 0);
});

test('a pulse by another key (RelayTrigger) holds the guard and drops a kept close', async (t) => {
  const { gladys, fake, ready, store } = await setup(t, {
    fake: await startFakeRemootio({ state: 'closed' }),
  });
  await ready();
  await createAll(gladys);
  store.data.pendingCloses[SERIAL] = { at: NOW, tries: 0 };
  fake.event({
    type: 'RelayTrigger',
    state: 'closed',
    data: { keyNr: 3, keyType: 'unique key', via: 'bluetooth' },
  });
  await until(() => store.data.guards[SERIAL]?.kind === 'open');
  assert.equal(store.data.pendingCloses[SERIAL], undefined);
  assert.match((await press(gladys, 'open')).error, /vient d’être actionné/);
});

test('the history replayed at a new session never changes the state nor a guard', async (t) => {
  const { gladys, fake, ready, advance, store } = await setup(t);
  await ready();
  await createAll(gladys);
  await advance(1000);
  const count = gladys.fake.states.length;
  fake.event({ type: 'StateChange', state: 'open' }, { t100ms: 5 });
  fake.event(
    { type: 'RelayTrigger', state: 'open', data: { keyType: 'guest key', keyNr: 1 } },
    {
      t100ms: 6,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await advance(1000);
  assert.equal(gladys.fake.states.length, count);
  assert.equal(store.data.guards[SERIAL], undefined);
});

test('keys refused twice in a row: no more tries, kept across a restart; other keys try again', async (t) => {
  const fake = await startFakeRemootio({ auth: 'A'.repeat(64) });
  const store = new MemoryStore();
  // Known from an earlier session (the keys were changed since).
  store.data.devices[SERIAL] = { serial: SERIAL, slot: 1, address: '', model: '' };
  const { gladys, app, advance, logs } = await setup(t, { fake, store });
  await until(() => fake.received.filter((r) => r.type === 'AUTH').length === 1);
  await until(() => app.links.get(1).state === 'down');
  await advance(5000);
  await until(() => app.links.get(1).refused);
  assert.match(statusFr(gladys), /les clés d’API ont été refusées/);
  assert.match(store.data.refused['1'].fingerprint, /^[0-9a-f]{64}$/);
  await advance(3_600_000);
  assert.equal(fake.connections, 2, 'never tried again by itself');
  await createAll(gladys);
  assert.match((await press(gladys, 'open')).error, /refusé les clés d’API/);
  assert.equal(fake.connections, 2, 'a click never replays refused keys');
  // A restart with the same keys: still refused.
  const again = await setup(t, { fake, store });
  await again.advance(10_000);
  assert.equal(fake.connections, 2);
  assert.ok(again.app.links.get(1).refused);
  // Other keys saved: tried at once.
  fake.auth = Buffer.from(AUTH, 'hex');
  await again.gladys.fake.configUpdated({
    host_1: fake.host,
    secret_key_1: SECRET,
    auth_key_1: AUTH.toLowerCase(),
  });
  // Same keys (case aside): still the refused pair, so nothing is tried.
  await again.advance(1000);
  assert.equal(fake.connections, 2);
  const text = JSON.stringify([logs, store.data, gladys.fake.connectionStatuses]);
  for (const key of [SECRET, AUTH, 'A'.repeat(64)]) {
    assert.ok(!text.toUpperCase().includes(key), 'no key anywhere');
  }
});

test('"Check the Remootio devices" tries refused keys once, at most every 30 s', async (t) => {
  const fake = await startFakeRemootio({ auth: 'A'.repeat(64) });
  const { gladys, app, advance } = await setup(t, { fake });
  await until(() => app.links.get(1).state === 'down');
  await advance(5000);
  await until(() => app.links.get(1).refused);
  const connections = fake.connections;
  fake.auth = Buffer.from(AUTH, 'hex');
  const first = await gladys.fake.action('check_devices');
  assert.match(first.data.message.fr, /connecté/);
  assert.equal(fake.connections, connections + 1);
  assert.equal(app.links.get(1).refused, false);
  assert.match(statusFr(gladys), /connecté/);
  assert.equal(app.data.refused['1'], undefined, 'lifted by the success');
});

test('a second refusal after the check is final again at once', async (t) => {
  const fake = await startFakeRemootio({ auth: 'A'.repeat(64) });
  const { gladys, app, advance } = await setup(t, { fake });
  await until(() => app.links.get(1).state === 'down');
  await advance(5000);
  await until(() => app.links.get(1).refused);
  await gladys.fake.action('check_devices');
  assert.ok(app.links.get(1).refused);
  const result = await gladys.fake.action('check_devices');
  assert.match(result.data.message.fr, /attendez/);
});

test('another Remootio answers with the keys: rebound, the old device is not commanded', async (t) => {
  const store = new MemoryStore();
  store.data.devices.oldoldoldserial = {
    serial: 'oldoldoldserial',
    slot: 1,
    address: '',
    model: '',
  };
  const { gladys, app, ready } = await setup(t, { store });
  await ready();
  assert.equal(app.data.devices.oldoldoldserial.slot, undefined);
  assert.equal(app.data.devices[SERIAL].slot, 1);
  assert.match(
    statusFr(gladys),
    /2462abe6bda0nfmcfaxm répond avec ces clés là où était oldoldoldserial/,
  );
  await createAll(gladys);
  const ack = await press(gladys, 'open', { serial: 'oldoldoldserial' });
  assert.match(ack.error, /n’est plus dans la configuration/);
});

test('after a restart the guard is kept, and a close works before any event', async (t) => {
  const store = new MemoryStore(emptyData(), () => NOW);
  store.data.devices[SERIAL] = { serial: SERIAL, slot: 1, address: '', model: 'remootio-2' };
  store.data.guards[SERIAL] = { kind: 'open', at: NOW - 10_000, until: NOW + 25_000 };
  const fake = await startFakeRemootio({ state: 'open' });
  const { gladys, advance } = await setup(t, { fake, store, start: false });
  await gladys.connect();
  await createAll(gladys);
  // Pressed before the session is up: the command opens it itself.
  assert.match((await press(gladys, 'close')).error, /vient d’être actionné/);
  await advance(25_000);
  assert.deepEqual(await press(gladys, 'close'), { success: true });
  assert.equal(fake.pulses[0].type, 'CLOSE');
});

test('a pulse whose answer never comes: "sent, without confirmation", the guard stays', async (t) => {
  const { gladys, fake, ready, advance, store } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.dropActions.add('CLOSE');
  const ack = press(gladys, 'close');
  await until(() => fake.pulses.length === 1);
  await advance(4300);
  assert.match((await ack).error, /Commande envoyée, sans confirmation/);
  assert.equal(store.data.guards[SERIAL].kind, 'close');
  assert.equal(store.data.pendingCloses[SERIAL], undefined, 'never kept: it may have left');
});

test('the guard cannot be saved: nothing sent', async (t) => {
  const { gladys, fake, ready, store } = await setup(t);
  await ready();
  await createAll(gladys);
  store.failing = true;
  assert.match((await press(gladys, 'open')).error, /n’a pas pu être enregistrée/);
  assert.deepEqual(fake.actions(), ['QUERY']);
});

test('a door not read where it was sent at the end of the travel is said in the status', async (t) => {
  const { gladys, fake, ready, advance } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.moveAfter = undefined;
  assert.deepEqual(await press(gladys, 'close'), { success: true });
  for (const step of [5000, 10_000, 21_000]) {
    await advance(step);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await until(() => /pas lu fermé après la dernière commande/.test(statusFr(gladys)));
  fake.setState('closed');
  await until(() => !/pas lu fermé/.test(statusFr(gladys)));
});

test('liveness: a PING every minute; no PONG closes the session and a new one opens', async (t) => {
  const { app, fake, ready, advance } = await setup(t);
  await ready();
  await advance(60_000);
  await until(() => fake.received.at(-1)?.type === 'PING');
  await until(() => app.links.get(1).timer !== undefined);
  fake.silent = true;
  await advance(60_000);
  await until(() => fake.received.filter((r) => r.type === 'PING').length === 2);
  await advance(10_000);
  await until(() => fake.connections === 2, 2000);
  fake.silent = false;
  fake.kick();
  await advanceUntil(advance, () => app.links.get(1).state === 'ready', { step: 1000 });
});

test('the QUERY of every 5 minutes keeps the state fresh', async (t) => {
  const { fake, ready, advance } = await setup(t);
  await ready();
  for (let i = 0; i < 5; i += 1) {
    await advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await until(() => fake.actions().length === 2);
  assert.deepEqual(fake.actions(), ['QUERY', 'QUERY']);
});

test('an invalid key is never shown back, only its length', async (t) => {
  const { gladys } = await setup(t, {
    config: { secret_key_1: 'my-password-pasted-here', auth_key_1: '' },
  });
  const status = JSON.stringify(gladys.fake.connectionStatus);
  assert.ok(!status.includes('my-password'));
  assert.match(statusFr(gladys), /23 caractères saisis/);
  assert.match(statusFr(gladys), /pas d’API Auth Key/);
});

test('a configuration that cannot be read is asked again, with a status', async () => {
  const gladys = createFakeGladys({ selector: 'remootio', config: {} });
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    if (calls === 1) throw new Error('down');
    return {};
  };
  const started = [];
  const app = { start: async (config) => started.push(config) };
  const handles = [];
  const timers = {
    setTimeout: (fn, ms) => handles.push({ fn, ms }),
    clearTimeout: () => {},
  };
  const run = startOnConnect(gladys, app, { error: () => {} }, timers);
  await run();
  assert.equal(started.length, 0);
  assert.equal(handles[0].ms, 5000);
  assert.match(gladys.fake.connectionStatus.message.fr, /nouvel essai dans 5 s/);
  await handles[0].fn();
  assert.equal(started.length, 1);
});

test('B1: closed or silent links during AUTH are never "refused keys"; Close still works', async (t) => {
  const { gladys, app, fake, ready, advance } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  // Another client (Home Assistant) takes the connection during AUTH, three times.
  fake.closeAfterAuth = true;
  fake.kick();
  await advanceUntil(advance, () => fake.received.filter((r) => r.type === 'AUTH').length >= 4, {
    step: 5000,
  });
  // Then a slow link: the first QUERY unanswered, twice.
  fake.closeAfterAuth = false;
  fake.dropFirstQueries = 2;
  await advanceUntil(advance, () => app.links.get(1).state === 'ready', { step: 5000 });
  assert.equal(app.links.get(1).refused, false);
  assert.equal(app.data.refused['1'], undefined);
  assert.deepEqual(await press(gladys, 'close'), { success: true });
});

test('I1: a kept close leaves when the Remootio comes back, its tries never lengthen the wait', async (t) => {
  const { gladys, app, fake, ready, advance } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  // Down for a while before the click: the backoff has grown.
  fake.silent = true;
  fake.kick();
  await advanceUntil(advance, () => app.links.get(1).failures >= 4, { step: 5000 });
  const failures = app.links.get(1).failures;
  const ack = press(gladys, 'close');
  for (let i = 0; i < 16; i += 1) {
    await tick();
    await advance(250);
  }
  assert.match((await ack).error, /La fermeture est gardée/);
  assert.ok(app.links.get(1).failures <= failures, 'the command did not lengthen the backoff');
  fake.silent = false;
  fake.kick();
  const before = Date.now();
  await advanceUntil(advance, () => fake.pulses.length === 1, { ms: 30_000, step: 1000 });
  assert.ok(Date.now() - before < 5000);
  assert.equal(fake.pulses[0].type, 'CLOSE');
});

test('I1: a kept close that cannot leave in 2 minutes is said in the status', async (t) => {
  const { gladys, app, fake, ready, advance } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.silent = true;
  fake.kick();
  await until(() => app.links.get(1).state !== 'ready');
  const ack = press(gladys, 'close');
  for (let i = 0; i < 16; i += 1) {
    await tick();
    await advance(250);
  }
  await ack;
  await advanceUntil(advance, () => app.data.pendingCloses[SERIAL] === undefined, {
    ms: 200_000,
    step: 5000,
  });
  assert.match(
    statusFr(gladys),
    /la fermeture gardée n’est pas partie \(le Remootio n’a pas pu être joint/,
  );
  assert.equal(fake.pulses.length, 0);
});

test('I2: the history replayed after the outage shows the door moved: the kept close is dropped', async (t) => {
  const { gladys, app, fake, ready, advance } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.silent = true;
  fake.kick();
  await until(() => app.links.get(1).state !== 'ready');
  const ack = press(gladys, 'close');
  for (let i = 0; i < 16; i += 1) {
    await tick();
    await advance(250);
  }
  assert.match((await ack).error, /La fermeture est gardée/);
  // Closed then opened again by the remote of the opener while the link was down.
  fake.offlineEvent({ type: 'StateChange', state: 'closed' });
  fake.offlineEvent({ type: 'StateChange', state: 'open' });
  fake.silent = false;
  fake.kick();
  await advanceUntil(advance, () => app.links.get(1).state === 'ready', { step: 1000 });
  await advance(1000);
  assert.equal(fake.pulses.length, 0, 'not sent onto the car that comes in');
  assert.equal(app.data.pendingCloses[SERIAL], undefined);
  assert.match(statusFr(gladys), /la porte a bougé pendant la coupure/);
  await createAll(gladys);
  assert.equal(
    gladys.fake.states.filter((st) => st.state === 1).length,
    0,
    'history never published',
  );
});

test('I3: another Remootio at the address is not "refused keys"; a refusal belongs to an address', async (t) => {
  const store = new MemoryStore();
  store.data.devices.aaaaaa111111 = { serial: 'aaaaaa111111', slot: 1, address: '', model: '' };
  // B answers at A's address; A's keys do not open B's challenge.
  const fake = await startFakeRemootio({ auth: 'C'.repeat(64) });
  const { gladys, app, advance } = await setup(t, { fake, store });
  await advanceUntil(advance, () => fake.connections >= 4, { step: 5000 });
  assert.equal(app.links.get(1).refused, false);
  assert.match(
    statusFr(gladys),
    /un autre Remootio \(…cfaxm\w?\) répond à cette adresse|un autre Remootio \(…\w+\) répond à cette adresse/,
  );
});

test('I3: refused keys at one address; the right address typed again is tried at once', async (t) => {
  const fake = await startFakeRemootio({ auth: 'A'.repeat(64) });
  const right = await startFakeRemootio();
  t.after(() => right.close());
  const { gladys, app, advance } = await setup(t, { fake });
  await until(() => app.links.get(1).state === 'down');
  await advance(5000);
  await until(() => app.links.get(1).refused);
  await gladys.fake.configUpdated({
    host_1: right.host,
    secret_key_1: SECRET,
    auth_key_1: AUTH,
    allow_open: true,
  });
  await advanceUntil(advance, () => app.links.get(1).state === 'ready', { step: 1000 });
  assert.equal(right.connections, 1);
});

test('I4: a session silent for 2 s is probed before the pulse; an action unanswered closes it', async (t) => {
  const { gladys, app, fake, ready, advance } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  await advance(2500);
  fake.dropActions.add('CLOSE');
  const ack = press(gladys, 'close');
  await until(() => fake.pulses.length === 1);
  const kinds = fake.received.map((r) => r.type ?? r.action.type);
  assert.deepEqual(kinds.slice(-2), ['PING', 'CLOSE'], 'the channel checked first');
  await advance(4300);
  assert.match((await ack).error, /Commande envoyée, sans confirmation/);
  await until(() => app.links.get(1).state !== 'ready' || fake.connections === 2);
  assert.ok(fake.connections === 2 || app.links.get(1).state !== 'ready', 'not "connected"');
});

test('I4: the end of the travel not read is said in the status', async (t) => {
  const { gladys, app, fake, ready, advance } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.moveAfter = undefined;
  assert.deepEqual(await press(gladys, 'close'), { success: true });
  fake.silent = true;
  fake.kick();
  await until(() => app.links.get(1).state !== 'ready');
  await advanceUntil(
    advance,
    () => /état non relu après la dernière commande/.test(statusFr(gladys)),
    {
      ms: 60_000,
      step: 1000,
    },
  );
});

test('m1: a PING every minute even while events keep coming', async (t) => {
  const { app, fake, ready, advance } = await setup(t);
  await ready();
  for (let i = 1; i <= 3; i += 1) {
    await advance(55_000);
    fake.event({ type: 'LeftOpen', state: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await advance(5000);
    await until(() => fake.received.filter((r) => r.type === 'PING').length === i);
    await until(() => app.links.get(1).timer !== undefined);
  }
});

test('m2: an event replayed within the session (same counter) is ignored', async (t) => {
  const { gladys, app, fake, ready } = await setup(t, {
    fake: await startFakeRemootio({ state: 'open' }),
  });
  await ready();
  await createAll(gladys);
  fake.event({ type: 'StateChange', state: 'closed', cnt: 50 });
  await until(() => app.lastValues.get(F('door'))?.state === 1);
  fake.event({ type: 'StateChange', state: 'open', cnt: 51 });
  await until(() => app.lastValues.get(F('door'))?.state === 0);
  fake.event({ type: 'StateChange', state: 'closed', cnt: 50 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.lastValues.get(F('door')).state, 0);
});

test('m3, m4: the manual button, and a pulse in the same 100 ms as the first answer, set a guard', async (t) => {
  const { gladys, app, fake, ready } = await setup(t, {
    fake: await startFakeRemootio({ state: 'closed' }),
  });
  await ready();
  await createAll(gladys);
  fake.event({ type: 'ManualButtonPushed', state: 'closed' });
  await until(() => app.guards.get(SERIAL)?.kind === 'open');
  app.guards.clear();
  const base = app.links.get(1).baseT100;
  fake.event(
    { type: 'RelayTrigger', state: 'open', data: { keyType: 'guest key', keyNr: 2 } },
    {
      t100ms: base,
    },
  );
  await until(() => app.guards.get(SERIAL)?.kind === 'close');
  assert.match((await press(gladys, 'open')).error, /vient d’être actionné/);
});

test('m5: a command before the configuration is read says so', async (t) => {
  const { gladys } = await setup(t, { start: false });
  const ack = await press(gladys, 'close');
  assert.match(ack.error, /configuration n’est pas encore chargée/);
});
