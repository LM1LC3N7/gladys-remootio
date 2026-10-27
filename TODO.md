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
  - whether `ManualButtonPushed` means the output was driven;
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
- **SDK `^0.16.0`** (2026-10-27, migration wave 2): 0.16.0 is on npm since
  2026-10-25 (a stale npm cache said otherwise); it adds the ai, tts and music
  types; no effect here (`should_poll` explicit, `poll_frequency` unused).
  `keywords`, `countries` and `gladys_version >= 5.3.0` wait until Gladys 5.3
  is widespread.
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
  - OPEN behind `allow_open`, CLOSE behind `allow_close` only (decision of
    Louis, 2026-10-26; before, 2026-10-25, CLOSE needed `allow_open`), both
    off by default and independent: CLOSE can open or stop a door closing
    without the Remootio knowing it, or with a wrong sensor. This is the one
    exception to "closing is never blocked", and the docs list it. Updating
    from 0.1.1: `allow_close` is NOT ticked automatically (decision of Louis);
    the CHANGELOG ("Changed") and the docs say it;
  - the guard: set and saved (awaited) in `beforeSend`, the deadline and
    every check made again after the save; removed only when the Remootio
    answers that nothing moved (relayTriggered false, ERR_*) or when the
    frame surely did not leave. Length: travel time (option, 10-120 s,
    default 30) + 5 s, on the monotonic clock, capped at each use and when
    read back from /data. An open guard is never lifted early (the sensor
    reads open from the start of the travel); a close guard is lifted by a
    "closed" read after the pulse (`t100ms` greater than the answer's);
  - another key's `RelayTrigger` (API with logging), a `ManualButtonPushed`
    (taken as a pulse, to check on real hardware) and an ERR_RELAY_BUSY
    answer (the output is being driven: the door is about to move) set the
    same guard and drop a kept close; nothing is ever sent again after
    ERR_RELAY_BUSY (review r1, B2). A pulse event in the same 100 ms as the
    first answer of the session is taken as fresh (one guard too many is
    harmless);
  - one command per door: a close cancels an opening not written (its waits
    end at once), waits for one written (its answer) then meets its guard;
    an opening is refused while another command runs;
  - the session of a command: the open one if a byte came in the last 2 s
    (a frame written can never be sent again, so the channel is checked
    first), else a PING (1 s at most), else (or stuck: an answer awaited with
    no byte for 1 s) the socket is destroyed and a new session opened at
    once. A close tries again every 250 ms within its budget; these tries
    never lengthen the backoff of the reconnection (review r1, I1). Any action
    left without an answer closes its session, and a new one opens at once
    (review r1, I4);
  - deadlines: written within 3.5 s of the click or refused unsent;
    answered by 4.3 s; a frame that may have left is "sent, without
    confirmation" (guard kept, never resent);
  - a close not written in time is kept in /data and sent at the next
    session, the reconnection tried every 5 s meanwhile, within 2 minutes of
    the click, 3 tries at most, only with `allow_close` (read again when it leaves), never during a guard;
    dropped by an open that leaves, another key's pulse, ERR_RELAY_BUSY, or
    the history replayed at the reconnection showing the door moved during
    the outage (StateChange, RelayTrigger, ManualButtonPushed; review r1,
    I2). A drop other than "sent" or "already closed" is said in the status
    and logged (warn). A close that the Remootio
    confirmed (relayTriggered) is never sent again: a door still open at the
    end of its travel was stopped by its own safety (obstacle) or by someone,
    and a second pulse would fight it; it is said in the status instead;
  - success: relayTriggered (the door moves) or "already there"; reads at
    5 s, 15 s and the end of the travel time.
- Sessions: reconnection after 5 s, 15 s, 30 s, 1, 2, then 5 min; a PING
  every minute whatever was received (the Remootio closes a session whose
  client sends nothing for 120 s; review r1, m1), a QUERY every 5 min; one
  timer per session. Events older than the answer to the first QUERY (or as
  old, except a pulse) are history: never a state, never a guard. An event
  whose `cnt` does not grow within the session is a replay, ignored (m2).
  After a restart soon after an attempt (kept in /data at most once a
  minute) the first connection waits 5 s; a command never waits for that.
  The end of the travel not read (no session, no answer) is said in the
  status ("state not read after the last command").
- Keys refused (review r1, B1): only "auth" counts: the challenge's MAC,
  padding or JSON refused with these keys, or an "authentication error"
  answering the first QUERY. The Remootio sends its challenge without
  checking anything, so a link closed, slow or taken by another client
  during AUTH says nothing of the keys: a plain failure with the usual
  backoff. Two "auth" in a row stop the tries; a salted HMAC of the address
  and the pair is kept in /data (256-bit keys: no brute force), removed at
  the first success. Other keys or another address saved: tried at once.
  "Check the Remootio devices": one try, at most every 30 s, the refusal
  lifted only by a success (one more failure is a refusal again at once). A
  click never replays refused keys. To consider: a refusal could be tried
  again every 5 min instead (nothing derived from the keys leaves).
- Identity (review r1, I3): the serial number bound to the slot is given to
  the session; another serial in SERVER_HELLO still gets AUTH (it reveals
  nothing), and if its challenge does not fit the keys the status says
  "another Remootio answers at this address", never "refused keys", with
  the usual reconnection; if the keys open it, the slot is rebound (a
  replaced device).
- Protocol limit: no client nonce in the authentication; someone recording
  the LAN can replay a whole session. Not fixable on our side.
- A command before the configuration is read is refused with "configuration
  not loaded yet" (m5).
- Bounds: a message 16 KB at most (cut before it is read whole), 200
  messages per 10 s, 8 actions awaiting an answer, a payload of 8 KB of
  base64; every field checked (own properties, types, ranges), an unknown
  state is unknown; a frame with a wrong MAC or padding closes the session.
- getConfig() failing at a (re)connection to Gladys: asked again after 5 s,
  15 s, 30 s, then every minute, with a status.
- Units: none (binary and buttons).
