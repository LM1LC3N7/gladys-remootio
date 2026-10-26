# TODO — Remootio v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 22 and 24,
  Docker build, store validator), `npm audit --omit=dev`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local Websocket API** (2026-10-26): up to two
      Remootio devices, identity by serial number at every session, AUTH with
      the two API keys, door state (events and a QUERY every 5 min), Open and
      Close (OPEN / CLOSE actions only, off by default, guard of the travel
      time), kept close, refused keys persisted, manifest, docs en/fr. Tested
      against a fake Remootio on loopback only (real frames and cryptography,
      the documentation's worked example as test vectors).
- [ ] **Milestone 2 — real hardware** (testers with a Remootio): to check
      first:
  - the order of the keys in `data` of the frames sent by the device (the MAC
    is computed over `data` as received, "iv" first in the documentation);
  - the history replayed after AUTH: before or after the answer to the first
    QUERY, and its `t100ms` (filtered on the `t100ms` of that answer);
  - whether a `RelayTrigger` of our own action comes with `keyType` "api key";
  - the PING/PONG behaviour on a session idle for a minute; how fast a
    Remootio accepts a new connection right after the old one was destroyed;
  - OPEN/CLOSE answers on a Remootio without sensor (ERR_NO_SENSOR) and while
    the output is held (ERR_RELAY_BUSY).
- [ ] **Milestone 3 — more**: the `LeftOpen` event as a scene trigger, the
      last key that operated the door (number and type, without any name),
      the secondary free relay output of the Remootio 2 (a button, off by
      default), mDNS discovery (`_remootio._tcp`), more than two devices.
- [ ] **Milestone 4 — first release**: Release workflow, topic, then the
      store validator with the image check.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: aioremootio (Apache-2.0, 1.0.0a21, the library of the HACS
  integration) is Python and alpha, so the protocol is ported from the
  official documentation (v1 to v3) with aioremootio as a second reading:
  frames, cryptography, action counter, the replay filter on `t100ms`. No
  runtime dependency besides the SDK: the WebSocket client is the bounded
  one of gladys-bang-olufsen (`node:net`), the cryptography is `node:crypto`.
  Credited in `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`).
  The documentation repository has no license file: only its description of
  the protocol and its worked example (as test vectors) are used.
- SDK: `@gladysassistant/integration-sdk ^0.15.0`: 0.16.0 is not published on
  npm on 2026-10-26 (`npm view` gives 0.15.0); to migrate when it is (types
  ai/tts/music only, nothing breaking).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1 (the template's 1.0.0 was
  someone else's). The first release (patch) gives 0.1.1; every later
  version comes from the Release workflow.
- Manifest: `gladys_version >=5.1.0`, category `security`, no `keywords` nor
  `countries` (they need `>=5.3.0`). Planned for later: keywords "remootio",
  "gate", "portail", "garage door", "porte de garage", "websocket";
  countries HU (maker), and the EU.
- External ids: `gladys.externalIds('remootio', serial)`, `serial` the
  `serialNumber` of `SERVER_HELLO`, lower case, 6 to 40 letters and digits.
  Feature keys frozen: `door`, `open`, `close`. API v1 (Remootio software
  older than 2.21) gives no serial number: refused with a status that says to
  update the Remootio.
- Configuration: two fixed slots (`host_n`, `secret_key_n`, `auth_key_n`),
  the keys normalized (spaces removed, upper case) and checked as 64 hex
  digits; an invalid key is only said invalid with its length. A slot is
  bound to the serial that authenticated with its keys (a positive proof):
  another serial answering with the slot's keys takes the slot, the previous
  device stays in Gladys, unreachable, and its buttons are refused.
- Door: an `opening-sensor`/`binary` (closed 1, open 0, nothing without a
  sensor or for an unknown state), two `button`/`push` features; never a
  switch nor a commandable binary.
- Commands (lessons of lots 11 to 16):
  - only the OPEN and CLOSE actions: the Remootio pulses only when its own
    sensor reads closed (OPEN) / open (CLOSE) when the action arrives, the
    freshest read possible; no QUERY of ours before (it would read the same
    sensor earlier). TRIGGER (a blind toggle) and RESTART are never sent;
  - BOTH behind `allow_open` (decision of Louis, 2026-10-25, as
    gladys-opengarage and ismartgate): "open" for the sensor also means
    "moving", where CLOSE pulses and stops or reverses the door. This is the
    one exception to "closing is never blocked", and the docs list it;
  - the guard: set and saved (awaited) in `beforeSend`, the deadline and
    every check made again after the save; removed only when the Remootio
    answers that nothing moved (relayTriggered false, ERR_*) or when the
    frame surely did not leave. Length: travel time (option, 10-120 s,
    default 30) + 5 s, on the monotonic clock, capped at each use and when
    read back from /data. An open guard is never lifted early (the sensor
    reads open from the start of the travel); a close guard is lifted by a
    "closed" read after the pulse (`t100ms` greater than the answer's);
  - another key's `RelayTrigger` (API with logging) sets the same guard, and
    drops a kept close (someone chose to operate the door);
  - one command per door: a close cancels an opening not written (its waits
    end at once), waits for one written (its answer) then meets its guard;
    an opening is refused while another command runs;
  - the session of a command: the open one if it answered in the last 10 s,
    else a PING (1 s at most), else (or stuck: an answer awaited with no
    byte for 1 s) the socket is destroyed and a new session opened at once.
    A close tries again every 250 ms within its budget;
  - deadlines: written within 3.5 s of the click or refused unsent;
    answered by 4.3 s; a frame that may have left is "sent, without
    confirmation" (guard kept, never resent);
  - a close not written in time (or answered ERR_RELAY_BUSY) is kept in /data
    and sent at the next session or 3 s later (busy), within 2 minutes, 3
    tries at most, only with `allow_open`, never during a guard; dropped by an
    open that leaves or another key's pulse. A close that the Remootio
    confirmed (relayTriggered) is never sent again: a door still open at the
    end of its travel was stopped by its own safety (obstacle) or by someone,
    and a second pulse would fight it; it is said in the status instead;
  - success: relayTriggered (the door moves) or "already there"; reads at
    5 s, 15 s and the end of the travel time.
- Sessions: reconnection after 5 s, 15 s, 30 s, 1, 2, then 5 min; a PING when
  nothing came for 59 s (the Remootio closes at 120 s), a QUERY every 5 min;
  one timer per session. Events older than (or as old as) the answer to the
  first QUERY are history: never a state, never a guard. After a restart soon
  after an attempt (kept in /data at most once a minute) the first connection
  waits 5 s; a command never waits for that.
- Keys refused: two authentication failures in a row ("auth": MAC or padding
  of the challenge refused, an "authentication error" frame; "authClosed":
  closed or silent after AUTH) stop the tries; a salted HMAC of the pair is
  kept in /data (256-bit keys: no brute force), removed at the first success.
  Other keys saved: tried at once. "Check the Remootio devices": one try,
  at most every 30 s, the refusal lifted only by a success (one more failure
  is a refusal again at once). A click never replays refused keys.
- Bounds: a message 16 KB at most (cut before it is read whole), 200
  messages per 10 s, 8 actions awaiting an answer, a payload of 8 KB of
  base64; every field checked (own properties, types, ranges), an unknown
  state is unknown; a frame with a wrong MAC or padding closes the session.
- getConfig() failing at a (re)connection to Gladys: asked again after 5 s,
  15 s, 30 s, then every minute, with a status.
- Units: none (binary and buttons).
