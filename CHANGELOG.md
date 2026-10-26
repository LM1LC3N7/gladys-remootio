# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-26

### Added

- Remootio gate and garage door controllers over their local Websocket API,
  without the cloud: up to two, each with its address and its two API keys,
  identified by their serial number at every connection.
- The state of the gate or door (with the Remootio status sensor), pushed by
  the Remootio and read again every 5 minutes.
- Open and Close buttons (never a switch), both off by default: only the OPEN
  and CLOSE actions of the API (the Remootio checks its own sensor), a guard
  of the travel time after each pulse (also after a pulse of another key),
  saved before the pulse leaves (also after an "output busy" answer, never
  sent again); a close not sent in time is kept for the next connection
  (2 minutes, 3 tries at most, dropped when the door moved meanwhile, even if the history comes after the
  first answer: it leaves after a PING/PONG and 1 s of ready session).
- Keys refused twice in a row (a challenge the keys cannot open) stop the
  connection attempts until other keys or another address are saved, or
  "Check the Remootio devices" succeeds; another Remootio at the address is
  said as such.

[Unreleased]: https://github.com/LM1LC3N7/gladys-remootio/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-remootio/releases/tag/v0.1.1
