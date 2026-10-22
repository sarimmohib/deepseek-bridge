/*
 * Minimal RFC 6455 WebSocket server.
 *
 * Only what the bridge needs: text messages, ping/pong, close. No extensions,
 * no compression, no subprotocols. Kept dependency-free on purpose.
 */

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export class WsConnection {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.lastSeen = Date.now();
    this.listeners = { message: [], close: [] };
    this.meta = {};

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.#onClose());
    socket.setNoDelay(true);
  }

  on(event, fn) {
    this.listeners[event].push(fn);
    return this;
  }

  #emit(event, ...args) {
    for (const fn of this.listeners[event]) {
      try {
        fn(...args);
      } catch {
        /* listener errors must not kill the socket */
      }
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    this.#emit('close');
  }

  #onData(chunk) {
    this.lastSeen = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > 64n * 1024n * 1024n) {
          this.close(1009, 'message too large');
          return;
        }
        len = Number(big);
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;

      let payload = this.buffer.subarray(offset, offset + len);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buffer = this.buffer.subarray(offset + len);

      if (opcode === OP_PING) {
        this.#raw(OP_PONG, payload);
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_CLOSE) {
        this.close(1000, '');
        return;
      }
      if (opcode === OP_CONT) {
        this.fragments.push(Buffer.from(payload));
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.fragmentOpcode === OP_TEXT) this.#emit('message', whole.toString('utf8'));
        }
        continue;
      }
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (!fin) {
          this.fragmentOpcode = opcode;
          this.fragments = [Buffer.from(payload)];
          continue;
        }
        if (opcode === OP_TEXT) this.#emit('message', payload.toString('utf8'));
      }
    }
  }

  #raw(opcode, payload) {
    if (this.closed) return;
    try {
      this.socket.write(frame(opcode, payload));
    } catch {
      this.close();
    }
  }

  sendJSON(obj) {
    this.#raw(OP_TEXT, Buffer.from(JSON.stringify(obj)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(frame(OP_CLOSE, body));
    } catch {
      /* ignore */
    }
    this.socket.end();
    this.closed = true;
    this.#emit('close');
  }
}

export function attachWebSocket(server, { path = '/agent', onConnection }) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    );
    const conn = new WsConnection(socket, req);
    onConnection(conn, url);
  });
}
