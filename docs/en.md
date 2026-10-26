# Remootio for Gladys Assistant

Unofficial integration, not affiliated with Remootio. **Never tested with a real device**: it follows the
official documentation of the Remootio Websocket API and was checked against a fake Remootio that reproduces
its frames and their cryptography. Feedback with a real Remootio is welcome.

## What the integration does

For each Remootio (up to two), through its local Websocket API (without the Remootio cloud):

- the **state** of the gate or garage door (closed or not closed), when a status sensor is installed;
- two **buttons**: **Open** and **Close** (never a switch: a "turn everything off" or a scene on switches
  never reaches the gate).

The state comes as soon as it changes (events pushed by the Remootio) and is read again every 5 minutes.

## Setup

1. In the Remootio app, with the master key: **Device software**, then **Remootio Websocket API**. Enable the
   API, preferably **with logging** ("Enable API with logging"): Gladys then also sees the pulses of the other
   keys (remote, app, automations) and waits for the end of the travel before sending one.
2. The app shows the **API Secret Key**, the **API Auth Key** (64 hexadecimal digits each) and the IP
   address. Give the Remootio a fixed IP address in your router.
3. In Gladys, configuration of the integration: type the address and both keys. The key fields are kept by
   Gladys in its database, never shown again, and only used with this Remootio, on your local network. The
   keys are in no log line, no status and no file of `/data`.
4. Add the device from the **Discovery** tab.

Remootio software: 2.21 or later (API v2 or v3). An older one does not give its serial number: the status
says so, update the Remootio.

The API takes **one connection at a time**: when another home automation system (Home Assistant…) is connected
to the same Remootio, the two keep closing each other.

## Opening and closing

The output of the Remootio drives the opener with a **pulse that is a toggle**: the same pulse opens a closed
door, closes an open one, and stops or reverses a moving one. Therefore:

- Gladys only sends the **OPEN** and **CLOSE** actions of the API, never the plain pulse (TRIGGER): the
  Remootio only drives its output when **its own sensor** reads the door closed (Open) or open (Close), when
  the action arrives. Without a status sensor it refuses both.
- For the sensor, "open" also means "moving": closing can therefore stop or reverse a moving door. **Open AND
  Close are off by default**; tick "Allow opening and closing" to use them (decision of 2026-10-25, the same as
  for OpenGarage and ismartgate).
- After a pulse (from Gladys, or from another key when the API runs with logging), the next one waits for the
  configured **travel time** (30 s by default) plus 5 s. After a close, only until the door is read closed.
  This guard is written to `/data` before the pulse is sent: a restart keeps it.

### When a command is refused

Open or Close is refused, with nothing sent, in these cases:

- "Allow opening and closing" is not ticked;
- the address or a key of this Remootio is missing or invalid, or this Remootio is no longer in the
  configuration (or another Remootio answers with its keys);
- the keys were refused by the Remootio (see below);
- a pulse left less than the travel time plus 5 s ago, or another key operated the door just now;
- another command of the same door is in progress (a close cancels an opening not sent yet);
- the Remootio could not be reached within 3.5 s (a close is then **kept** and sent at the next connection,
  within 2 minutes, 3 tries at most, unless another command left or another key operated the door meanwhile);
- the guard of the pulse could not be written to `/data`;
- the configuration changed during the command.

The Remootio itself may then refuse the action: no status sensor (ERR_NO_SENSOR), output busy (ERR_RELAY_BUSY:
a close is then sent again a few seconds later), or already in the state asked (nothing moves, the command
succeeds).

When the action may have left but its answer did not come, Gladys answers "Command sent, without
confirmation" and keeps the guard. The state is read 5 s and 15 s after a pulse, then at the end of the
travel; a door not read where it was sent (an obstacle, the remote, a travel longer than configured) is said
in the status.

## Connection and refused keys

- The connection is opened at the start and kept; a lost one is opened again after 5 s, 15 s, 30 s, 1 min,
  2 min, then every 5 minutes. A PING leaves when nothing was received for a minute.
- A command does not wait for the reconnection: it uses the open connection (checked by a PING when it was
  silent for 10 s), else opens a new one at once, after closing the old one.
- **Keys refused** twice in a row (the Remootio does not recognize the keys, or closes the connection during
  the authentication): no more automatic tries, the status says so. Save other keys, or use the **Check the
  Remootio devices** button (one try, at most every 30 s; the refusal is only lifted by a success).

## Known limits

- Without a status sensor, nothing is read and both buttons are refused by the Remootio.
- Without logging in the API, the pulses of the other keys are not seen: only the guard of Gladys's own
  pulses applies.
- During the very first fraction of a second of an opening started by the remote, the sensor still reads
  "closed": an opening sent at that moment would stop the door.
- The secondary output ("free relay output" of the Remootio 2) is not used.
