# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Remootio gate and garage door
controllers (local Websocket API, no cloud): a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template
and the structure of LM1LC3N7/gladys-opengarage, and ports the Remootio API
from its official documentation and aioremootio (Apache-2.0). See `TODO.md`
for the status and the decisions.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "guard"   # tests whose name matches
npm run cover                             # regenerate cover.png (800×534)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: src/handlers.js registered before connect()
src/handlers.js                   the SDK handlers -> RemootioApp; getConfig retried, never dead
src/app.js                        RemootioApp: links (one per configured Remootio), commands, guards
src/remootio/session.js           one connection: HELLO, AUTH, actions (ids), events, PING
src/remootio/crypto.js            the protected frames: AES-256-CBC, PKCS#7, HMAC-SHA256
src/remootio/protocol.js          frames checked strictly (pure)
src/remootio/websocket.js         minimal RFC 6455 client over node:net, bounded
src/model.js                      Remootio -> Gladys device and door value (pure)
src/publisher.js                  states within the rate limit (250/min)
src/store.js                      /data/remootio.json (devices, guards, kept closes, refused keys)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js, src/i18n.js     frozen keys, limits, timings; texts in English and French
scripts/cover.mjs                 cover.png generator (plain Node)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the SDK's fake Gladys and a fake Remootio on loopback
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `gladys.externalIds('remootio', serial)`
  (the serial number of `SERVER_HELLO`, lower case), never an address. Feature
  keys (`door`, `open`, `close`), manifest keys and action keys are frozen. A
  created device never loses a feature.
- **Safety.** The door is never a `switch` nor a commandable `binary`. Only
  the `OPEN` and `CLOSE` actions are sent (the Remootio checks its own sensor),
  never `TRIGGER` nor `RESTART`. The output is a toggle: BOTH commands need
  `allow_open` (off by default; decision of 2026-10-25, a separate close
  option awaits Louis), checked on arrival, before the session is used and in
  `beforeSend`. A guard (travel time + 5 s, saved to /data before the first
  byte) follows every pulse: ours, another key's `RelayTrigger`, the manual
  button, an `ERR_RELAY_BUSY` answer (never sent again); a close guard is
  lifted early by a fresh "closed" only. The history replayed at a new
  session never changes a state or a guard, but drops a kept close when it
  shows the door moved. Keep the tests that say so.
- **The API keys** are never logged, never in a status, an error or `/data`
  (only a salted fingerprint of a REFUSED pair). A `secret` field is kept by
  Gladys in its database, never shown again: never write that it is
  encrypted. An invalid key is never shown back (its length only).
- **Sessions**: one per Remootio, its identity read at every session; a
  session of an older configuration publishes nothing. Keys refused twice in
  a row (only a challenge the keys cannot open: never a slow or closed link,
  never another Remootio at the address): no more tries until other keys,
  another address or a successful "Check". A command's tries never lengthen
  the backoff; a kept close makes it 5 s.
- **Clocks**: guards, pauses and liveness on the monotonic clock, read once
  per decision; the wall clock only for /data.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json`, `package-lock.json` or the manifest, nor the
  `docker_image` tag, by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects. The catalog
  `description` holds 10 to 100 characters per language.
- **Units.** Only the ones the core lists for the category
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY` in `server/utils/constants.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
- **Encoding.** Every file is UTF-8 without BOM; `test/encoding.test.js`
  refuses mojibake and control characters.
- **Tests.** The app tests use a virtual clock (the monotonic clock moves at
  each read) and real loopback sockets; `test/realclock.test.js` checks the
  real periods on the real clock, sped up.
