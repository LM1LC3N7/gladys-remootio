// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and
// the fake Remootio on a real loopback socket: the liveness PINGs really
// leave once a minute and the QUERY of every 5 minutes really leaves (time
// sped up 20 times: a minute is 3 s, but it is the real clock, moving
// between any two reads of it); a close goes end to end on the real clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RemootioApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { TIMINGS } from '../src/constants.js';
import { MemoryStore } from '../src/store.js';
import { AUTH, SECRET, startFakeRemootio } from './helpers/fakeRemootio.js';

const SPEED = 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The app on the real clock, `speed` times faster. */
function realApp(t, fake, speed) {
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / speed);
    },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, Math.max(1, ms) / speed),
    clearInterval: (id) => clearInterval(id),
  };
  const config = {
    host_1: fake.host,
    secret_key_1: SECRET,
    auth_key_1: AUTH,
    allow_open: true,
    allow_close: true,
  };
  const gladys = createFakeGladys({ selector: 'remootio', config });
  const quiet = () => {};
  const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet };
  const app = new RemootioApp({
    gladys,
    logger,
    store: new MemoryStore(),
    timers,
    now: () => Date.now() * speed,
    monotonic: () => performance.now() * speed,
  });
  registerHandlers(gladys, app, logger, timers);
  t.after(() => app.stop());
  return { gladys, app, timersSet: () => timersSet };
}

test('real clock: a PING every minute, a QUERY every 5 minutes', async (t) => {
  const fake = await startFakeRemootio({ state: 'open' });
  t.after(() => fake.close());
  const start = performance.now();
  const { gladys, timersSet } = realApp(t, fake, SPEED);
  await gladys.connect();
  // 5.5 minutes of sped-up time.
  const end = start + (5.5 * 60_000) / SPEED;
  while (performance.now() < end) {
    await sleep(5);
  }
  const at = (type) =>
    fake.received
      .filter((r) => (r.type ?? r.action?.type) === type)
      .map((r) => Math.round((r.at - start) * SPEED));
  const pings = at('PING');
  const queries = at('QUERY');
  assert.ok(pings.length >= 3 && pings.length <= 5, `pings at ${pings}`);
  for (let i = 1; i < pings.length; i += 1) {
    const gap = pings[i] - pings[i - 1];
    assert.ok(gap >= 0.9 * TIMINGS.pingInterval, `never sooner than a minute: ${pings}`);
    assert.ok(gap < 1.5 * TIMINGS.pingInterval, `on time: ${pings}`);
  }
  assert.equal(queries.length, 2, `the first QUERY, then one at 5 min: ${queries}`);
  const gap = queries[1] - queries[0];
  assert.ok(
    gap >= 0.95 * TIMINGS.refreshInterval && gap < 1.3 * TIMINGS.refreshInterval,
    `refresh at ${queries}`,
  );
  assert.ok(timersSet() < 200, `timers bounded: ${timersSet()}`);
});

test('real clock (not sped up): a close end to end, then its guard', async (t) => {
  const fake = await startFakeRemootio({ state: 'open' });
  t.after(() => fake.close());
  const { gladys, app } = realApp(t, fake, 1);
  await gladys.connect();
  while (app.links.get(1)?.state !== 'ready') {
    await sleep(2);
  }
  const device = gladys.fake.discoveredDevices[0];
  await gladys.fake.deviceCreated(device);
  const close = device.features.find((f) => f.external_id.endsWith(':close'));
  assert.deepEqual(await gladys.fake.setValue(device, close, 1), { success: true });
  assert.equal(fake.pulses.length, 1);
  assert.match((await gladys.fake.setValue(device, close, 1)).error, /vient d’être actionné/);
});
