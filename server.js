// Claudio Signaling Server (ESM)
// Serves /public and provides Socket.IO signaling for WebRTC

import express from 'express';
import http from 'http';
import compression from 'compression';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(cors());

// Static site (your UI lives in /public)
app.use(express.static('public', {
  setHeaders(res) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
}));

// Health / small diag
app.get('/diag/health', (req, res) => {
  const rooms = Array.from(io.sockets.adapter.rooms || []).filter(([id, s]) => !io.sockets.sockets.get(id));
  res.json({ ok: true, rooms: rooms.map(([id, set]) => ({ id, size: set.size })) });
});

// Fallback index
app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/public/index.html');
});

const server = http.createServer(app);
const io = new Server(server, {
  // Allow your site origin (Render will set host)
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ---- In-memory room user list ------------------------------------------------
/**
 * rooms: Map<roomId, Map<socketId, {id, username, instrument}>>
 */
const rooms = new Map();

function getUsers(roomId) {
  const m = rooms.get(roomId);
  if (!m) return [];
  return Array.from(m.values());
}
function broadcastUsers(roomId) {
  io.to(roomId).emit('users-updated', { users: getUsers(roomId) });
}

// ---- Socket.IO handlers ------------------------------------------------------
io.on('connection', (sock) => {
  // Useful metadata on the socket
  sock.data = { username: undefined, instrument: undefined, roomId: undefined };

  // Join a room
  sock.on('join-room', ({ roomId, username, instrument }) => {
    try {
      if (!roomId) return;
      roomId = String(roomId).toUpperCase().slice(0, 12);
      username = (username || 'musician').slice(0, 24);
      instrument = (instrument || 'guitar').slice(0, 24);

      // Leave previous room if any
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

      // Notify this client
      sock.emit('joined-room', { roomId, users: getUsers(roomId) });

      // Notify others
      sock.to(roomId).emit('user-joined', { user: { id: sock.id, username, instrument }, users: getUsers(roomId) });
      broadcastUsers(roomId);
    } catch (e) {
      sock.emit('error', { message: 'join-room failed', details: String(e?.message || e) });
    }
  });

  // Simple room chat broadcast (UI listens to both 'roomcast' and legacy 'chat-message')
  sock.on('roomcast', ({ roomId, message }) => {
    if (!roomId || !message) return;
    const username = sock.data?.username || 'user';
    io.to(roomId).emit('roomcast', { username, message: String(message).slice(0, 240) });
  });

  // Legacy chat event compatibility (optional)
  sock.on('chat-message', ({ roomId, message }) => {
    if (!roomId || !message) return;
    const username = sock.data?.username || 'user';
    io.to(roomId).emit('chat-message', { username, message: String(message).slice(0, 240) });
  });

  // WebRTC signaling relay
  sock.on('signal', ({ to, roomId, data }) => {
    if (!to || !roomId || !data) return;
    // Only relay inside the same room
    const target = io.sockets.sockets.get(to);
    if (target && target.rooms.has(roomId)) {
      target.emit('signal', { from: sock.id, data });
    }
  });

  // Latency test
  sock.on('ping', (ts) => {
    sock.emit('pong', ts);
  });

  // Disconnect cleanup
  sock.on('disconnect', () => {
    const roomId = sock.data.roomId;
    if (!roomId) return;
    const m = rooms.get(roomId);
    if (!m) return;
    m.delete(sock.id);
    if (m.size === 0) rooms.delete(roomId);
    sock.to(roomId).emit('user-left', { id: sock.id, username: sock.data.username, users: getUsers(roomId) });
    broadcastUsers(roomId);
  });
});

// ---- Start -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`claudio-signaling-server listening on :${PORT}`);
});
