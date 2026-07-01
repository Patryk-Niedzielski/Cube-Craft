// ── CUBE CRAFT — dependency-free multiplayer server ───────────────────────
// Run on the host PC with:   node server.js  [port]
// Other players add  <your-ip>:<port>  in the in-game server list to join.
//
// Uses only Node built-ins (http + crypto) — no `npm install` required.
// Implements the minimal RFC 6455 WebSocket handshake + text framing and
// relays player state / block edits between everyone connected, while
// holding the authoritative world seed and the set of block edits so
// late-joiners load into the same world.

const http   = require('http');
const crypto = require('crypto');
const os     = require('os');

const PORT = parseInt(process.argv[2], 10) || 25565;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Shared world state
const WORLD_SEED = Math.floor(Math.random() * 1e9);
const edits = new Map();          // "x,y,z" -> blockId  (0 = air/removed)
const clients = new Map();        // id -> socket

let nextId = 1;

// ── WebSocket frame helpers ───────────────────────────────────────────────
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

// Parse as many complete frames as are buffered; returns {messages, rest, close}
function decodeFrames(buf) {
  const messages = [];
  let offset = 0;
  let close = false;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset], b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break; // wait for more data
    let data = buf.slice(p, p + len);
    if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3]; data = out; }
    offset = p + len;
    if (opcode === 0x8) { close = true; break; }         // close
    if (opcode === 0x1 || opcode === 0x2) messages.push(data.toString('utf8'));
    // opcodes 0x9/0xA (ping/pong) ignored
  }
  return { messages, rest: buf.slice(offset), close };
}

function send(sock, obj) {
  if (sock.destroyed) return;
  try { sock.write(encodeFrame(JSON.stringify(obj))); } catch (e) {}
}
function broadcast(obj, exceptId) {
  for (const [id, sock] of clients) { if (id !== exceptId) send(sock, obj); }
}

// ── HTTP + upgrade handling ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Cube Craft server running. Connect from the game server list.\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const id = 'p' + (nextId++);
  clients.set(id, socket);
  let buf = Buffer.alloc(0);

  // Send world seed + all current edits so this player loads the same world
  send(socket, { t: 'welcome', id, seed: WORLD_SEED, edits: Object.fromEntries(edits) });
  console.log(`+ ${id} joined (${clients.size} online)`);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest, close } = decodeFrames(buf);
    buf = rest;
    for (const raw of messages) {
      let m; try { m = JSON.parse(raw); } catch (e) { continue; }
      m.id = id; // stamp sender id (authoritative)
      if (m.t === 'block') {
        if (m.b === 0) edits.delete(`${m.x},${m.y},${m.z}`);
        else edits.set(`${m.x},${m.y},${m.z}`, m.b);
        broadcast(m, id);
      } else if (m.t === 'state' || m.t === 'chat') {
        broadcast(m, id);
      }
    }
    if (close) socket.end();
  });

  const drop = () => {
    if (!clients.has(id)) return;
    clients.delete(id);
    broadcast({ t: 'leave', id });
    console.log(`- ${id} left (${clients.size} online)`);
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

server.listen(PORT, () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list) if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
  }
  console.log(`Cube Craft server listening on port ${PORT} (world seed ${WORLD_SEED})`);
  console.log('Players on your network can join using one of these addresses:');
  for (const ip of ips) console.log(`   ${ip}:${PORT}`);
  console.log(`   (same PC: localhost:${PORT})`);
});
