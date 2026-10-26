// -----------------------------------------------------------------------------
// WebSocket frames as a server writes them and as a client masks them (from
// gladys-bang-olufsen, same author).
// -----------------------------------------------------------------------------

/** A server frame: never masked. */
export function serverFrame(opcode, payload, { fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }
  return Buffer.concat([header, data]);
}

/** Decodes the masked client frames of `buffer` (complete frames only). */
export function clientFrames(buffer) {
  const frames = [];
  let at = 0;
  while (buffer.length - at >= 6) {
    const opcode = buffer[at] & 0x0f;
    let length = buffer[at + 1] & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = buffer.readUInt32BE(offset + 4);
      offset += 8;
    }
    if (buffer.length < offset + 4 + length) {
      break;
    }
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, masked: (buffer[at + 1] & 0x80) !== 0, payload });
    at = offset + 4 + length;
  }
  return frames;
}
