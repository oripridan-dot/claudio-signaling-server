// server.js
import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { Server } from "socket.io";
import crypto from "node:crypto";

// ---- App & HTTP
const app = express();
const server = http.createServer(app);

// ---- Socket.IO
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

// ---- Middleware & static files
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));
app.use(express.static("public"));

// ---- In-memory rooms { roomId -> Set(socketId) }
const rooms = new Map();

// ---- Helpers
const log = (...a) => console.log(new Date().toISOString(), ...a);
const preferOpus = (sdp) => {
  // force opus @48k, ptime=10, stereo=0
  try {
    // move opus payload first in m=audio
    const m = sdp.match(/^m=audio .+$/m);
    if (!m) return sdp;
    const mline = m[0];
    const opusRtp = sdp.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2$/m);
    if (!opusRtp) return sdp;
    const pt = opusRtp[1];
    const parts = mline.split(" ");
    const fixed = [parts[0], parts[1], parts[2], pt, ...parts.slice(3).filter(p => p !== pt)].join(" ");
    sdp = sdp.replace(mline, fixed);
    // add fmtp for low latency
    if (!sdp.includes(`a=fmtp:${pt}`)) {
      sdp += `\na=fmtp:${pt} minptime=10;useinbandfec=1;stereo=0;cbr=1;maxplaybackrate=48000;ptime=10\n`;
    } else {
      sdp = sdp.replace(
        new RegExp(`^a=fmtp:${pt}.*$`, "m"),
        (line) => line.includes("ptime=") ? line : `${line};ptime=10`
      );
    }
  } catch {}
  return sdp;
};

// ---- Socket.IO handlers
io.on("connection", (socket) => {
  log("conn", socket.id);

  socket.on("join-room", ({ roomId, username, instrument }) => {
    roomId = String(roomId || "").toUpperCase().slice(0, 12);
    if (!roomId) return;

    // join structures
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId).add(socket.id);
    socket.data.user = { id: socket.id, username: username || "user", instrument: instrument || "guitar", audioEnabled: false };
    socket.join(roomId);

    // notify self
    const users = [...rooms.get(roomId)].map((id) => io.sockets.sockets.get(id)?.data.user).filter(Boolean);
    socket.emit("joined-room", { roomId, users });

    // notify others
    socket.to(roomId).emit("user-joined", { user: socket.data.user, users });
    log("join", roomId, socket.id, username);
  });

  socket.on("toggle-audio", (flag) => {
    if (socket.data.user) socket.data.user.audioEnabled = !!flag;
    // broadcast updated users list
    const roomId = [...socket.rooms].find((r) => r !== socket.id);
    if (roomId && rooms.has(roomId)) {
      const users = [...rooms.get(roomId)].map((id) => io.sockets.sockets.get(id)?.data.user).filter(Boolean);
      io.to(roomId).emit("users-updated", { users });
    }
  });

  socket.on("ping", (ts) => socket.emit("pong", ts));

  // signaling: forward, with tiny SDP munging for Opus/ptime
  socket.on("signal", ({ to, roomId, data }) => {
    if (data?.sdp?.sdp) data.sdp.sdp = preferOpus(data.sdp.sdp);
    io.to(to).emit("signal", { from: socket.id, data });
    if (data?.sdp) {
      log("signal-sdp", (data.sdp.type || "?"), "len", String(data.sdp.sdp || "").length, "to", to);
    } else if (data?.candidate) {
      // keep it quiet; uncomment to debug ICE:
      // log("ice", to);
    }
  });

  socket.on("disconnect", () => {
    // remove from all rooms
    for (const [roomId, set] of rooms) {
      if (set.delete(socket.id)) {
        const users = [...set].map((id) => io.sockets.sockets.get(id)?.data.user).filter(Boolean);
        socket.to(roomId).emit("user-left", { id: socket.id });
        io.to(roomId).emit("users-updated", { users });
        if (set.size === 0) rooms.delete(roomId);
        log("leave", roomId, socket.id);
      }
    }
  });
});

// ---- Diagnostics API
app.get("/diag/health", (_req, res) => {
  res.json({ ok: true, time: Date.now(), rooms: [...rooms.entries()].map(([k, v]) => [k, v.size]) });
});

// Run a local wrtc self-test: spins up two headless peers through our signaling bus and
// confirms inbound RTP bytes grow. Returns a detailed report.
import { runSelfTest } from "./diagnostics/selftest.js";
app.post("/diag/selftest", async (req, res) => {
  try {
    const timeoutMs = Math.min(15000, Math.max(5000, Number(req.body?.timeoutMs || 9000)));
    const report = await runSelfTest({ serverPort: PORT, timeoutMs });
    res.json(report);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---- Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log("listening", PORT));
