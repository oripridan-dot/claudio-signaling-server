// diagnostics/selftest.js
// Node self-test that proves audio m-line is active and RTP flows (bytes increase).
import { io as ioc } from "socket.io-client";
import wrtc from "wrtc";
import crypto from "node:crypto";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function randomRoom() {
  return "TEST" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

// Create a silent audio track using wrtc nonstandard source
function makeSilentTrack() {
  const { RTCAudioSource } = wrtc.nonstandard;
  const source = new RTCAudioSource();
  const track = source.createTrack();
  // pump silence at 10ms chunks
  const frame = { sampleRate: 48000, channelCount: 1, numberOfFrames: 480, samples: new Int16Array(480) };
  let running = true;
  (async function loop() {
    while (running) { source.onData(frame); await sleep(10); }
  })();
  track.stop = () => { running = false; };
  return track;
}

function preferOpus(sdp) {
  try {
    const m = sdp.match(/^m=audio .+$/m);
    if (!m) return sdp;
    const opusRtp = sdp.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2$/m);
    if (!opusRtp) return sdp;
    const pt = opusRtp[1];
    const line = m[0];
    const parts = line.split(" ");
    const fixed = [parts[0], parts[1], parts[2], pt, ...parts.slice(3).filter(p => p !== pt)].join(" ");
    sdp = sdp.replace(line, fixed);
    if (!sdp.includes(`a=fmtp:${pt}`)) {
      sdp += `\na=fmtp:${pt} minptime=10;useinbandfec=1;cbr=1;ptime=10\n`;
    }
  } catch {}
  return sdp;
}

async function createHeadlessPeer({ name, serverUrl, room }) {
  const sock = ioc(serverUrl, { transports: ["websocket", "polling"] });

  // Join
  await new Promise((resolve, reject) => {
    sock.on("connect", resolve);
    sock.on("connect_error", reject);
  });
  sock.emit("join-room", { roomId: room, username: name, instrument: "bot" });

  // RTCPeer
  const pc = new wrtc.RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  const tx = pc.addTransceiver("audio", { direction: "sendrecv" });
  // attach silent track so m-line is active
  await tx.sender.replaceTrack(makeSilentTrack());

  pc.onicecandidate = (e) => {
    if (e.candidate) sock.emit("signal", { to: partnerId, roomId: room, data: { candidate: e.candidate } });
  };

  let partnerId = null;
  let resolvedOnTrack = null;
  const onTrackPromise = new Promise(r => (resolvedOnTrack = r));

  pc.ontrack = () => { resolvedOnTrack(); };

  // signaling
  sock.on("signal", async ({ from, data }) => {
    partnerId = from;
    if (data?.sdp) {
      await pc.setRemoteDescription(new wrtc.RTCSessionDescription(data.sdp));
      if (data.sdp.type === "offer") {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sock.emit("signal", { to: from, roomId: room, data: { sdp: pc.localDescription } });
      }
    } else if (data?.candidate) {
      await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
    }
  });

  // helpers
  async function offerTo(id) {
    partnerId = id;
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: "offer", sdp: preferOpus(offer.sdp) });
    sock.emit("signal", { to: id, roomId: room, data: { sdp: pc.localDescription } });
  }

  return { pc, sock, offerTo, onTrackPromise, name };
}

export async function runSelfTest({ serverPort = process.env.PORT || 3000, timeoutMs = 9000 } = {}) {
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const room = randomRoom();

  // create two peers (A existing -> will offer, B joins -> answers)
  const A = await createHeadlessPeer({ name: "diagA", serverUrl, room });
  // wait a tick so A is "existing"
  await sleep(200);
  const B = await createHeadlessPeer({ name: "diagB", serverUrl, room });

  // A creates offer to B using room usersUpdated path
  await A.offerTo(B.sock.id);

  // wait for tracks/ICE
  const raceTimeout = new Promise((_r, rej) => setTimeout(() => rej(new Error("timeout waiting for tracks")), timeoutMs));
  await Promise.race([A.onTrackPromise, B.onTrackPromise, raceTimeout]);

  // give time for media to flow
  await sleep(1200);

  // pull WebRTC stats
  const statsA = await A.pc.getStats();
  const statsB = await B.pc.getStats();

  function summarize(stats, dir) {
    const out = { dir, bytes: 0, packets: 0, jitterMs: null, rttMs: null };
    stats.forEach(r => {
      if (r.type === "inbound-rtp" && r.kind === "audio") {
        out.bytes += r.bytesReceived || 0;
        out.packets += r.packetsReceived || 0;
        out.jitterMs = r.jitter != null ? Math.round(r.jitter * 1000) : out.jitterMs;
      }
      if (r.type === "remote-inbound-rtp" && r.kind === "audio") {
        out.rttMs = r.roundTripTime != null ? Math.round(r.roundTripTime * 1000) : out.rttMs;
      }
    });
    return out;
  }

  const sumA = summarize(statsA, "A<-B");
  const sumB = summarize(statsB, "B<-A");

  // close
  A.sock.disconnect(); B.sock.disconnect();
  A.pc.close(); B.pc.close();

  const ok = sumA.bytes > 0 && sumB.bytes > 0;
  return {
    ok,
    room,
    summary: { A: sumA, B: sumB },
    note: ok ? "media flowed (bytesReceived>0). Opus preferred, ptime=10." : "no media counted; inspect signaling/ICE reachability"
  };
}

// CLI mode
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const once = process.argv.includes("--once");
      const report = await runSelfTest({});
      console.log(JSON.stringify(report, null, 2));
      if (!once) process.exit(report.ok ? 0 : 2);
      else process.exit(0);
    } catch (e) {
      console.error("SELFTEST_ERROR", e);
      process.exit(2);
    }
  })();
}
