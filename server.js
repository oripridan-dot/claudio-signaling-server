// server.js
import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));
app.use(express.static("public"));

const rooms = new Map(); // roomId -> Set(socketId)
const log = (...a) => console.log(new Date().toISOString(), ...a);

function preferOpus(sdp) {
  try {
    const m = sdp.match(/^m=audio .+$/m);
    const r = sdp.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2$/m);
    if (!m || !r) return sdp;
    const pt = r[1];
    const fixed = m[0].split(" ");
    const reordered = [fixed[0], fixed[1], fixed[2], pt, ...fixed.slice(3).filter(x => x !== pt)].join(" ");
    sdp = sdp.replace(m[0], reordered);
    if (!sdp.includes(`a=fmtp:${pt}`)) {
      sdp += `\na=fmtp:${pt} minptime=10;useinbandfec=1;cbr=1;stereo=0;ptime=10\n`;
    } else {
      sdp = sdp.replace(
        new RegExp(`^a=fmtp:${pt}.*$`, "m"),
        (line) => line.includes("ptime=") ? line : `${line};ptime=10`
      );
    }
  } catch {}
  return sdp;
}

io.on("connection", (socket) => {
  log("conn", socket.id);

  socket.on("join-room", ({ roomId, username, instrument }) => {
    roomId = String(roomId || "").toUpperCase().slice(0, 12);
    if (!roomId) return;

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId).add(socket.id);
    socket.data.user = {
      id: socket.id,
      username: username || "user",
      instrument: instrument || "guitar",
      audioEnabled: false
    };
    socket.join(roomId);

    const users = [...rooms.get(roomId)]
      .map((id) => io.sockets.sockets.get(id)?.data.user)
      .filter(Boolean);

    socket.emit("joined-room", { roomId, users });
    socket.to(roomId).emit("user-joined", { user: socket.data.user, users });
  });

  socket.on("toggle-audio", (flag) => {
    if (socket.data.user) socket.data.user.audioEnabled = !!flag;
    const roomId = [...socket.rooms].find((r) => r !== socket.id);
    if (roomId && rooms.has(roomId)) {
      const users = [...rooms.get(roomId)]
        .map((id) => io.sockets.sockets.get(id)?.data.user)
        .filter(Boolean);
      io.to(roomId).emit("users-updated", { users });
    }
  });

  // latency
  socket.on("ping", (ts) => socket.emit("pong", ts));

  // signaling + SDP munge
  socket.on("signal", ({ to, roomId, data }) => {
    if (data?.sdp?.sdp) data.sdp.sdp = preferOpus(data.sdp.sdp);
    io.to(to).emit("signal", { from: socket.id, data });
  });

  // simple room broadcast for coordination (self-test, etc.)
  socket.on("roomcast", ({ roomId, type, payload }) => {
    io.to(roomId).emit(type, { from: socket.id, payload });
  });

  socket.on("disconnect", () => {
    for (const [roomId, set] of rooms) {
      if (set.delete(socket.id)) {
        const users = [...set]
          .map((id) => io.sockets.sockets.get(id)?.data.user)
          .filter(Boolean);
        socket.to(roomId).emit("user-left", { id: socket.id });
        io.to(roomId).emit("users-updated", { users });
        if (set.size === 0) rooms.delete(roomId);
      }
    }
  });
});

// very small health endpoint
app.get("/diag/health", (_req, res) => {
  res.json({ ok: true, rooms: [...rooms.entries()].map(([k, v]) => [k, v.size]) });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log("listening", PORT));
