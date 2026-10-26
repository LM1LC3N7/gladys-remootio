// -----------------------------------------------------------------------------
// One session against the fake Remootio on a real loopback socket: the
// authentication and its failures (each with the kind the app counts), the
// action ids, the bounds on what the network sends.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyFromHex } from '../src/remootio/crypto.js';
import { RemootioSession, SESSION_LIMITS, SessionError } from '../src/remootio/session.js';
import { until } from './helpers/app.js';
import { AUTH, SECRET, SERIAL, startFakeRemootio } from './helpers/fakeRemootio.js';

async function open(t, fakeOptions = {}, sessionOptions = {}) {
  const fake = await startFakeRemootio(fakeOptions);
  t.after(() => fake.close());
  const events = [];
  const closes = [];
  const session = new RemootioSession({
    host: '127.0.0.1',
    port: fake.port,
    secretKey: keyFromHex(SECRET),
    authKey: keyFromHex(AUTH),
    onEvent: (event, meta) => events.push({ event, meta }),
    onClose: (reason) => closes.push(reason),
    ...sessionOptions,
  });
  t.after(() => session.close());
  return { fake, session, events, closes };
}

test('HELLO, AUTH, the first QUERY: the identity and the state', async (t) => {
  const { fake, session } = await open(t, { state: 'open' });
  const { identity, response } = await session.open({ timeout: 2000 });
  assert.equal(identity.serial, SERIAL);
  assert.equal(identity.apiVersion, 3);
  assert.equal(response.state, 'open');
  assert.ok(session.ready);
  assert.deepEqual(
    fake.received.map((r) => r.type ?? r.action.type),
    ['HELLO', 'AUTH', 'QUERY'],
  );
});

test('the action ids follow the counter of the challenge, in order', async (t) => {
  const { fake, session } = await open(t);
  await session.open({ timeout: 2000 });
  const answers = await Promise.all([
    session.action('QUERY'),
    session.action('QUERY'),
    session.action('OPEN'),
  ]);
  const ids = fake.received.filter((r) => r.action).map((r) => r.action.id);
  for (let i = 1; i < ids.length; i += 1) {
    assert.equal(ids[i], ids[i - 1] + 1);
  }
  assert.deepEqual(
    answers.map((a) => a.type),
    ['QUERY', 'QUERY', 'OPEN'],
  );
  assert.equal(answers[2].relayTriggered, true);
});

test('a wrong API Auth Key: "auth" (the MAC of the challenge), nothing else sent', async (t) => {
  const { fake, session } = await open(t, {}, { authKey: keyFromHex('0'.repeat(64)) });
  await assert.rejects(session.open({ timeout: 2000 }), (err) => err.kind === 'auth');
  assert.ok(session.closed);
  assert.deepEqual(
    fake.received.map((r) => r.type),
    ['HELLO', 'AUTH'],
  );
});

test('a wrong API Secret Key: "auth" (the padding of the challenge)', async (t) => {
  const { session } = await open(t, {}, { secretKey: keyFromHex('1'.repeat(64)) });
  await assert.rejects(session.open({ timeout: 2000 }), (err) => err.kind === 'auth');
});

test('closed right after AUTH: "closed", never "auth" (the keys were not even used)', async (t) => {
  const { session } = await open(t, { closeAfterAuth: true });
  await assert.rejects(session.open({ timeout: 2000 }), (err) => err.kind === 'closed');
});

test('the first QUERY not answered in time: "timeout", never "auth"', async (t) => {
  const { session } = await open(t, { dropFirstQueries: 1 });
  await assert.rejects(session.open({ timeout: 200 }), (err) => err.kind === 'timeout');
});

test('another serial number than expected: AUTH still goes, `otherDevice` is said', async (t) => {
  const { session } = await open(t, {}, { expectSerial: 'aaaaaa111111' });
  await session.open({ timeout: 2000 });
  assert.equal(session.otherDevice, true);
});

test('no answer: "timeout"; no serial number: "identity"; nothing listening: "connect"', async (t) => {
  const silentFake = await startFakeRemootio();
  t.after(() => silentFake.close());
  silentFake.silent = true;
  const quiet = new RemootioSession({
    host: '127.0.0.1',
    port: silentFake.port,
    secretKey: keyFromHex(SECRET),
    authKey: keyFromHex(AUTH),
  });
  await assert.rejects(quiet.open({ timeout: 200 }), (err) => err.kind === 'timeout');
  const nameless = await startFakeRemootio({ serial: '' });
  t.after(() => nameless.close());
  const anonymous = new RemootioSession({
    host: '127.0.0.1',
    port: nameless.port,
    secretKey: keyFromHex(SECRET),
    authKey: keyFromHex(AUTH),
  });
  await assert.rejects(anonymous.open({ timeout: 2000 }), (err) => err.kind === 'identity');
  await nameless.close();
  const nowhere = new RemootioSession({
    host: '127.0.0.1',
    port: nameless.port,
    secretKey: keyFromHex(SECRET),
    authKey: keyFromHex(AUTH),
  });
  await assert.rejects(nowhere.open({ timeout: 2000 }), (err) => err.kind === 'connect');
});

test('events: the replay window is told apart; a refused frame closes the session', async (t) => {
  const { fake, session, events, closes } = await open(t);
  await session.open({ timeout: 2000 });
  fake.event({ type: 'StateChange', state: 'open' });
  await until(() => events.length === 1);
  assert.equal(events[0].meta.replayWindow, false);
  fake.badMac = true;
  fake.event({ type: 'StateChange', state: 'closed' });
  await until(() => session.closed);
  assert.equal(events.length, 1, 'a frame with a wrong MAC is never used');
  assert.deepEqual(closes, ['protocol']);
});

test('a flood of messages closes the session', async (t) => {
  const { fake, session } = await open(t);
  await session.open({ timeout: 2000 });
  for (let i = 0; i <= SESSION_LIMITS.messagesPerWindow; i += 1) {
    fake.current.send({ type: 'PONG' });
  }
  await until(() => session.closed);
});

test('a message above 16 KB closes the connection before it is read', async (t) => {
  const { fake, session } = await open(t);
  await session.open({ timeout: 2000 });
  fake.current.send({ type: 'PONG', pad: 'x'.repeat(SESSION_LIMITS.message) });
  await until(() => session.closed);
});

test('an action not answered: "timeout" with sent; a closed session: "notSent"', async (t) => {
  const { fake, session } = await open(t);
  await session.open({ timeout: 2000 });
  fake.dropActions.add('QUERY');
  await assert.rejects(
    session.action('QUERY', { timeout: 100 }),
    (err) => err instanceof SessionError && err.kind === 'timeout' && err.sent === true,
  );
  session.close();
  await assert.rejects(
    session.action('QUERY'),
    (err) => err.kind === 'notSent' && err.sent === false,
  );
});

test('beforeSend runs before the frame; if it throws, nothing is written', async (t) => {
  const { fake, session } = await open(t);
  await session.open({ timeout: 2000 });
  const before = fake.received.length;
  await assert.rejects(
    session.action('OPEN', {
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    /no/,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.received.length, before);
  // The counter did not move: the next action is still accepted.
  assert.equal((await session.action('QUERY')).type, 'QUERY');
});

test('PING is answered by PONG', async (t) => {
  const { session } = await open(t);
  await session.open({ timeout: 2000 });
  await session.ping(500);
});
