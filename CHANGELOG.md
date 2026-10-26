# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Remootio gate and garage door controllers over their local Websocket API,
  without the cloud: up to two, each with its address and its two API keys,
  identified by their serial number at every connection.
- The state of the gate or door (with the Remootio status sensor), pushed by
  the Remootio and read again every 5 minutes.
- Open and Close buttons (never a switch), both off by default: only the OPEN
  and CLOSE actions of the API (the Remootio checks its own sensor), a guard
  of the travel time after each pulse (also after a pulse of another key),
  saved before the pulse leaves; a close not sent in time is kept for the
  next connection (2 minutes, 3 tries at most).
- Keys refused twice in a row stop the connection attempts until other keys
  are saved or "Check the Remootio devices" succeeds.
