# gladys-remootio

[Gladys Assistant](https://gladysassistant.com) external integration for
**Remootio** gate and garage door controllers, on the local network: the state
of the gate or door (closed or not, with the Remootio status sensor) and Open
and Close buttons, through the local Websocket API of each Remootio (up to
two), without the Remootio cloud. Unofficial, not affiliated with Remootio.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake Remootio only,
> never with a real device.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (RemootioApp)
                                   ├─ src/remootio/session.js    one connection: HELLO, AUTH, actions, events, PING
                                   ├─ src/remootio/crypto.js     protected frames: AES-256-CBC + HMAC-SHA256
                                   ├─ src/remootio/protocol.js   frames checked strictly (pure)
                                   ├─ src/remootio/websocket.js  minimal RFC 6455 client over node:net, bounded
                                   ├─ src/model.js               Remootio -> Gladys device (pure)
                                   ├─ src/publisher.js           states within 250/min (Gladys: 300)
                                   └─ src/store.js               /data/remootio.json: devices, guards, kept closes
```

- **Sessions.** One WebSocket per Remootio (`ws://<ip>:8080`, the API takes
  one connection at a time). `HELLO` first: the serial number identifies the
  Remootio (external ids `remootio:<serial>`) at every session. Then `AUTH`:
  the challenge is read with the API Secret Key and checked with the API
  Auth Key (HMAC-SHA256), and gives the session key and the action counter;
  a first `QUERY` proves the session. The state then comes from the events
  (`StateChange`, `LeftOpen`), a `QUERY` every 5 min and a `PING` after a
  silent minute. The history replayed at each connection is ignored.
- **Commands.** Only the `OPEN` and `CLOSE` actions, never `TRIGGER`: the
  Remootio pulses only when its own sensor reads the door closed / open. The
  pulse is a toggle and Close can still stop, reverse or open a door (moving
  without the Remootio knowing, or a wrong sensor), so both are off by
  default, each with its own option ("Allow opening", "Allow closing": Close
  does not need "Allow opening"). A guard (travel time + 5 s, saved to
  `/data` before the frame is written) refuses another pulse while the door
  may move; a `RelayTrigger` of another key, the manual button or an
  `ERR_RELAY_BUSY` answer set it too (nothing is sent again). Before a pulse
  the session is checked by a PING when silent for 2 s; an action without an
  answer closes it. A close cancels an opening not sent, tries again every
  250 ms within 3.5 s, and is kept for 2 minutes when it could not leave
  (reconnection every 5 s meanwhile), unless the history replayed at the
  reconnection shows that the door moved.
- **Keys** refused twice in a row (a challenge these keys cannot open; a slow
  or closed link never counts) stop the tries (a salted fingerprint of the
  address and the refused pair in `/data`), until other keys or another
  address are saved or the "Check" button succeeds. Another Remootio at the
  address (serial number of `SERVER_HELLO`) is said as such, never as refused
  keys. The keys are never logged, never in `/data`, a status or an error.
- **No dependency** besides the Gladys SDK: the WebSocket client and the
  cryptography use `node:net` and `node:crypto`.

## Development

```bash
npm install
npm test              # node --test (Node 22 and 24)
npm run lint
npm run format:check
npm run cover         # cover.png, 800×534
```

The tests run against the SDK's fake Gladys and a fake Remootio on a real
loopback socket, with the real frames and cryptography of the API (the
worked example of the official documentation is a test vector), on a
virtual clock; `test/realclock.test.js` runs on the real clock, sped up.

## License

Apache-2.0 (see `LICENSE`). Ported knowledge: see `THIRD_PARTY_NOTICES.md`
(aioremootio, Apache-2.0, and the official Remootio API documentation).
