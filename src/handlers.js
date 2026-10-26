// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS, TIMINGS } from './constants.js';
import { T } from './i18n.js';

/**
 * At every (re)connection to Gladys: the configuration, then the app. A
 * configuration that cannot be read is asked again (5 s, 15 s, 30 s, then
 * every minute) with a status: the integration never stays dead.
 */
export function startOnConnect(gladys, app, logger, timers = globalThis) {
  let attempt = 0;
  let timer;
  let run = 0;
  const tryStart = async (current) => {
    try {
      const config = await gladys.getConfig();
      if (current !== run) return;
      attempt = 0;
      await app.start(config);
    } catch (err) {
      if (current !== run) return;
      logger?.error('Start failed', err);
      const wait = TIMINGS.configRetry[Math.min(attempt, TIMINGS.configRetry.length - 1)];
      attempt += 1;
      gladys.setConnectionStatus(false, T.configUnreadable(wait)).catch(() => {});
      timers.clearTimeout(timer);
      timer = timers.setTimeout(() => tryStart(current), wait);
    }
  };
  return () => {
    run += 1;
    timers.clearTimeout(timer);
    return tryStart(run);
  };
}

export function registerHandlers(gladys, app, logger, timers = globalThis) {
  // Discovery: the known Remootio devices are published at every start and change.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.CHECK, () => app.checkDevices());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.start(config));

  // Connection lifecycle (also after every reconnection to Gladys): the
  // status and the Discovery tab are published again; a session whose
  // configuration did not change is kept as it is.
  const onConnected = startOnConnect(gladys, app, logger, timers);
  gladys.on('connected', () => onConnected());
}
