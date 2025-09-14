// Claudio Signaling Server (ESM) — broadcast + directed signaling
import express from 'express';
import http from 'http';
import compression from 'compression';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors());

// serve UI from /public
app.use(express.static('public', {
  setHeaders(res) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
}));

// quick diag
app.get('/diag/health', (req, res) => {
  const rooms = Array.from(io.sockets.adapter.rooms || [])
    .filter(([id]) => !io.sockets.sockets.get(id))
    .map(([id, set]) => ({ id, size: set.size }));
  res.json({ ok: true, rooms });
});

app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/public/index.html');
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// in-memory users per room
const rooms = new Map(); // Map<roomId, Map<socketId, {id, username, instrument}>>

function getUsers(roomId){ const m = rooms.get(roomId); return m ? Array.from(m.values()) : []; }
function broadcastUsers(roomId){ io.to(roomId).emit('users-updated', { users: getUsers(roomId) }); }

io.on('connection', (sock) => {
  sock.data = { username: undefined, instrument: undefined, roomId: undefined };

  sock.on('join-room', ({ roomId, username, instrument }) => {
    try {
      if (!roomId) return;
      roomId = String(roomId).toUpperCase().slice(0, 12);
      username = (username || 'musician').slice(0, 24);
      instrument = (instrument || 'guitar').slice(0, 24);

      // leave previous
      if (sock.data.roomId && sock.data.roomId !== roomId) {
        const prev = rooms.get(sock.data.roomId);
        if (prev) {
          prev.delete(sock.id);
          if (prev.size === 0) rooms.delete(sock.data.roomId);
          io.to(sock.data.roomId).emit('user-left', { id: sock.id, username: sock.data.username, users: getUsers(sock.data.roomId) });
          broadcastUsers(sock.data.roomId);
        }
        sock.leave(sock.data.roomId);
      }

      sock.join(roomId);
      sock.data.roomId = roomId;
      sock.data.username = username;
      sock.data.instrument = instrument;

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      rooms.get(roomId).set(sock.id, { id: sock.id, username, instrument });

      // notify self
      sock.emit('joined-room', { roomId, users: getUsers(roomId), selfId: sock.id });
      // notify others
      sock.to(roomId).emit('user-joined', { user: { id: sock.id, username, instrument }, users: getUsers(roomId) });
      broadcastUsers(roomId);
    } catch (e) {
      sock.emit('error', { message: 'join-room failed', details: String(e?.message || e) });
    }
  });

  // simple room broadcast text
  sock.on('roomcast', ({ roomId, message }) => {
    if (!roomId || !message) return;
    const username = sock.data?.username || 'user';
    io.to(roomId).emit('roomcast', { username, message: String(message).slice(0, 240) });
  });

  // legacy alias
  sock.on('chat-message', ({ roomId, message }) => {
    if (!roomId || !message) return;
    const username = sock.data?.username || 'user';
    io.to(roomId).emit('chat-message', { username, message: String(message).slice(0, 240) });
  });

  // === WebRTC signaling ===
  // data: { sdp? | candidate? }, to: socketId | "*" (broadcast to all others in room)
  sock.on('signal', ({ to, roomId, data }) => {
    if (!roomId || !data) return;
    if (to === '*' ) {
      const set = io.sockets.adapter.rooms.get(roomId);
      if (!set) return;
      for (const sid of set) {
        if (sid === sock.id) continue;
        const target = io.sockets.sockets.get(sid);
        if (target) target.emit('signal', { from: sock.id, data });
      }
    } else {
      const target = io.sockets.sockets.get(to);
      if (target && target.rooms.has(roomId)) {
        target.emit('signal', { from: sock.id, data });
      }
    }
  });

  // latency
  sock.on('ping', (ts) => sock.emit('pong', ts));

  // cleanup
  sock.on('disconnect', () => {
    const roomId = sock.data.roomId;
    if (!roomId) return;
    const m = rooms.get(roomId);
    if (m) {
      m.delete(sock.id);
      if (m.size === 0) rooms.delete(roomId);
      sock.to(roomId).emit('user-left', { id: sock.id, username: sock.data.username, users: getUsers(roomId) });
      broadcastUsers(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`claudio-signaling-server listening on :${PORT}`));
