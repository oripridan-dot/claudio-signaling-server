import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const ORIGIN = process.env.ALLOW_ORIGIN || undefined; // undefined = same-origin
const app = express();

app.use(cors({ origin: ORIGIN || true }));
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// Serve static UI
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Create HTTP server + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGIN || true, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

/** In-memory room state (swap to Redis when you scale horizontally) */
const rooms = new Map(); // roomId -> Map<socketId, {username, instrument, audioEnabled}>

function usersIn(roomId) {
  const m = rooms.get(roomId);
  return m ? [...m.entries()].map(([id, u]) => ({ id, ...u })) : [];
}

io.on("connection", (socket) => {
  socket.data.username = null;
  socket.data.roomId = null;
  socket.data.instrument = "other";

  socket.on("join-room", ({ roomId, username, instrument }) => {
    if (!roomId || !username) return;
    roomId = String(roomId).toUpperCase();

    socket.join(roomId);
    socket.data.username = String(username).slice(0, 20);
    socket.data.instrument = instrument || "other";
    socket.data.roomId = roomId;

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    rooms.get(roomId).set(socket.id, {
      username: socket.data.username,
      instrument: socket.data.instrument,
      audioEnabled: true
    });

    socket.emit("joined-room", { roomId, users: usersIn(roomId) });
    socket.to(roomId).emit("user-joined", {
      user: { id: socket.id, username: socket.data.username, instrument: socket.data.instrument },
      users: usersIn(roomId)
    });
  });

  socket.on("toggle-audio", (enabled) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const m = rooms.get(roomId);
    const u = m.get(socket.id);
    if (!u) return;
    u.audioEnabled = !!enabled;
    io.to(roomId).emit("users-updated", { users: usersIn(roomId) });
  });

  socket.on("chat-message", ({ roomId, message }) => {
    roomId = roomId || socket.data.roomId;
    if (!roomId || !message) return;
    io.to(roomId).emit("chat-message", {
      userId: socket.id,
      username: socket.data.username || "user",
      message: String(message).slice(0, 200)
    });
  });

  // latency probe (client sends epoch ms)
  socket.on("ping", (ts) => socket.emit("pong", ts));

  // WebRTC signaling passthrough (Phase 2)
  socket.on("signal", ({ roomId, to, data }) => {
    roomId = roomId || socket.data.roomId;
    if (!roomId || !data) return;
    if (to) io.to(to).emit("signal", { from: socket.id, data });
    else socket.to(roomId).emit("signal", { from: socket.id, data });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const m = rooms.get(roomId);
    const user = m.get(socket.id);
    m.delete(socket.id);
    if (m.size === 0) rooms.delete(roomId);
    socket.to(roomId).emit("user-left", { id: socket.id, username: user?.username });
    io.to(roomId).emit("users-updated", { users: usersIn(roomId) });
  });
});

// Fallback to index.html for root
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

server.listen(PORT, () => console.log(`claudio signaling listening on :${PORT}`));

