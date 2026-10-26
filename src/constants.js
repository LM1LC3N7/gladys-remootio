// -----------------------------------------------------------------------------
// Fixed values: manifest keys (frozen: users store them in their scenes and
// configuration), the Gladys core value enums the SDK does not export, limits
// and timings.
// -----------------------------------------------------------------------------

/** The external id type: `gladys.externalIds('remootio', <serial number>)`. Frozen. */
export const EXTERNAL_ID_TYPE = 'remootio';

/** Manifest `actions` keys. */
export const ACTIONS = {
  CHECK: 'check_devices',
};

// Gladys core enums (server/utils/constants.js), not exported by the SDK.
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const BUTTON_PUSH = { PRESSED: 1 };

/** Remootio devices of the configuration: fields `host_1`, `secret_key_1`, `auth_key_1`... */
export const SLOTS = [1, 2];

/** The port of the Remootio Websocket API. */
export const API_PORT = 8080;

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Devices kept in /data (a replaced Remootio keeps its Gladys device). */
  records: 10,
};

export const TIMINGS = {
  /** Opening a session in the background (WebSocket, HELLO, AUTH, first QUERY). */
  connectTimeout: 5000,
  /**
   * A command is written within this many ms of its arrival, or refused
   * unsent: Gladys gives up waiting for the ack after 5 s.
   */
  commandSendBy: 3500,
  /** The ack is given by then: past it, "sent, without confirmation". */
  commandAnswerBy: 4300,
  /** A close that could not leave tries again this often within its budget. */
  closeRetry: 250,
  /**
   * A session silent for longer (a round trip on a LAN is far shorter) is
   * probed (PING) before a pulse: a frame written can never be sent again,
   * so the channel is checked first. With no PONG within `probeTimeout` it
   * is closed and a new one opened.
   */
  probeAfterIdle: 2000,
  probeTimeout: 1000,
  /** Liveness: a PING when nothing was received for this long (the Remootio closes at 120 s). */
  pingInterval: 60_000,
  pingTimeout: 10_000,
  /** A QUERY this often keeps the door state fresh. */
  refreshInterval: 5 * 60_000,
  /** Reconnections after a failure or a lost session. */
  reconnect: [5000, 15_000, 30_000, 60_000, 120_000, 300_000],
  /** Authentication failures in a row (MAC, padding, closed after AUTH) that stop the retries. */
  authFailures: 2,
  /** "Check the Remootio devices" tries refused keys again at most this often. */
  checkSpacing: 30_000,
  /** A close not sent is sent again at the next session within this time, 3 times at most. */
  pendingCloseFor: 120_000,
  pendingCloseTries: 3,
  /** Reads after a pulse (plus one at the end of the travel time). */
  followUps: [5000, 15_000],
  /** Added to the travel time for the guard of a pulse. */
  guardMargin: 5000,
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** Measurements of a same feature are spaced by this much (none here). */
  measureInterval: 60_000,
  /** An unchanged value is re-sent this often (on a fresh read only). */
  stateHeartbeat: 30 * 60_000,
  /** Saving /data waits this long for more changes. */
  persistDelay: 1000,
  /** The time of the last connection attempt is written to /data at most this often. */
  attemptSave: 60_000,
  /** getConfig() failed: tried again after these, then every minute. */
  configRetry: [5000, 15_000, 30_000, 60_000],
};

/** Configuration bounds (mirrored by the manifest): the longest travel of the door, in seconds. */
export const TRAVEL_TIME = { default: 30, min: 10, max: 120 };
