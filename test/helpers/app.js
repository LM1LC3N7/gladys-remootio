// -----------------------------------------------------------------------------
// RemootioApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a fake Remootio on a real loopback socket, a memory store
// and a virtual clock: the timers only fire when the test advances the clock,
// and the monotonic clock moves 1 µs at each read (a decision that reads it
// twice is caught).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RemootioApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { MemoryStore } from '../../src/store.js';
import { AUTH, SECRET, SERIAL, startFakeRemootio } from './fakeRemootio.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'remootio';
export const NOW = 1_800_000_000_000;
export const F = (key, serial = SERIAL) => `ext:${SELECTOR}:remootio:${serial}:${key}`;
export const D = (serial = SERIAL) => `ext:${SELECTOR}:remootio:${serial}`;

/** Waits (real time) until `condition()` holds; the I/O is real. */
export async function until(condition, ms = 2000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error(`condition not met in ${ms} ms: ${condition}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Moves the virtual clock by `step` at a time, letting the real I/O run in
 * between, until `condition()` holds (or `ms` of virtual time passed).
 */
export async function advanceUntil(advance, condition, { ms = 600_000, step = 1000 } = {}) {
  for (let spent = 0; spent <= ms; spent += step) {
    if (condition()) return;
    await advance(step);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met in ${ms} virtual ms: ${condition}`);
}

export async function setup(t, { config = {}, fake, store, devices = [], start = true } = {}) {
  const remootio = fake ?? (await startFakeRemootio());
  t.after(() => remootio.close());
  const fullConfig = {
    host_1: remootio.host,
    secret_key_1: SECRET,
    auth_key_1: AUTH,
    allow_open: true,
    allow_close: true,
    ...config,
  };
  const gladys = createFakeGladys({ selector: SELECTOR, config: fullConfig, devices });
  const { clock, timers, advance, pending } = createFakeClock(NOW);
  let drift = 0;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const kept = store ?? new MemoryStore(undefined, () => clock.now);
  const app = new RemootioApp({
    gladys,
    logger,
    store: kept,
    timers,
    now: () => clock.now,
    monotonic: () => clock.now + (drift += 0.001),
  });
  registerHandlers(gladys, app, logger, timers);
  t.after(() => app.stop());
  if (start) {
    await gladys.connect();
    await until(() => app.config);
    await advance(0);
  }
  const ready = (slot = 1) => until(() => app.links.get(slot)?.state === 'ready');
  return { gladys, app, fake: remootio, logs, store: kept, clock, advance, pending, ready };
}

/** Creates every discovered device in the fake Gladys. */
export async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

/** A button press through the fake Gladys (the handler of the container): the ack. */
export function press(gladys, key, { serial = SERIAL, value = 1 } = {}) {
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === D(serial));
  const feature = device?.features.find((f) => f.external_id === F(key, serial)) ?? {
    external_id: F(key, serial),
  };
  return gladys.fake.setValue(device ?? { external_id: D(serial) }, feature, value);
}
