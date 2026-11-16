"use strict";
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_PLAYERS = 8;
const MAX_PER_IP = 8;
const AUTO_START_MS = 20000;
const RACE_TIMEOUT_MS = 6 * 60 * 1000;

const rooms = new Map();
const perIp = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OVERDRIVE online\nsalas: " + rooms.size + "\n");
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

const uid = () => crypto.randomBytes(5).toString("hex");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const num = (x, lo, hi) => { x = +x; return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0; };
const str = (x, n) => String(x == null ? "" : x).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
function cleanLook(l) {
  const o = {};
  if (!l || typeof l !== "object") return o;
  for (const k of ["paint", "wheel", "neon", "smoke"]) if (typeof l[k] === "string") o[k] = str(l[k], 24);
  if (typeof l.pc === "string" && /^#[0-9a-f]{6}$/i.test(l.pc)) o.pc = l.pc;
  return o;
}
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(room, o, except) {
  const m = JSON.stringify(o);
  for (const p of room.players.values()) if (p.ws !== except && p.ws.readyState === 1) p.ws.send(m);
}
function roster(room) {
  return {
    t: "room", code: room.code, mode: room.mode, host: room.host,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, car: p.car, av: p.av, ready: p.ready, look: p.look }))
  };
}
function pushRoom(room) { broadcast(room, roster(room)); }

function clearTimers(room) {
  clearTimeout(room.autoT); clearInterval(room.countT); clearTimeout(room.raceT);
  room.autoT = room.countT = room.raceT = null;
}
function startCountdown(room) {
  if (room.state !== "lobby" || room.countT) return;
  clearTimeout(room.autoT); room.autoT = null;
  let n = 3;
  broadcast(room, { t: "count", n });
  room.countT = setInterval(() => {
    n--;
    if (n > 0) { broadcast(room, { t: "count", n }); return; }
    clearInterval(room.countT); room.countT = null;
    startRace(room);
  }, 1000);
}
function startRace(room) {
  if (room.players.size === 0) return;
  room.state = "racing";
  room.fin = new Set();
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  broadcast(room, { t: "start", seed, fill: Math.max(0, MAX_PLAYERS - room.players.size) });
  room.raceT = setTimeout(() => backToLobby(room), RACE_TIMEOUT_MS);
}
function backToLobby(room) {
  if (!rooms.has(room.code)) return;
  clearTimers(room);
  room.state = "lobby"; room.fin = new Set();
  for (const p of room.players.values()) p.ready = false;
  pushRoom(room);
  scheduleAuto(room);
}
function scheduleAuto(room) {
  clearTimeout(room.autoT); room.autoT = null;
  if (room.priv || room.state !== "lobby" || room.players.size < 2) return;
  room.autoT = setTimeout(() => {
    for (const p of room.players.values()) p.ready = true;
    pushRoom(room); startCountdown(room);
  }, AUTO_START_MS);
}
function checkAllReady(room) {
  if (room.state !== "lobby" || room.players.size === 0) return;
  for (const p of room.players.values()) if (!p.ready) return;
  startCountdown(room);
}
function leaveRoom(p) {
  const room = p.room;
  if (!room) return;
  p.room = null;
  room.players.delete(p.id);
  if (room.players.size === 0) { clearTimers(room); rooms.delete(room.code); return; }
  if (room.host === p.id) room.host = room.players.keys().next().value;
  broadcast(room, { t: "left", id: p.id });
  if (room.state === "lobby") {
    if (room.countT) { clearInterval(room.countT); room.countT = null; }
    pushRoom(room); checkAllReady(room); scheduleAuto(room);
  } else if ([...room.players.keys()].every(id => room.fin.has(id))) backToLobby(room);
}
function joinRoom(p, msg) {
  if (p.room) leaveRoom(p);
  const now = Date.now();
  if (now - p.lastJoin < 800) return send(p.ws, { t: "err", m: "Aguarde um instante." });
  p.lastJoin = now;
  const priv = !!msg.priv, mode = "casual";
  let room = null;
  if (priv && msg.code) {
    room = rooms.get(str(msg.code, 6).toUpperCase());
    if (!room || !room.priv) return send(p.ws, { t: "err", m: "Sala não encontrada." });
    if (room.state !== "lobby") return send(p.ws, { t: "err", m: "A corrida já começou." });
    if (room.players.size >= MAX_PLAYERS) return send(p.ws, { t: "err", m: "Sala cheia." });
  } else if (!priv) {
    for (const r of rooms.values())
      if (!r.priv && r.mode === mode && r.state === "lobby" && r.players.size < MAX_PLAYERS && !r.countT) { room = r; break; }
  }
  if (!room) {
    room = { code: newCode(), mode, priv, host: p.id, state: "lobby", players: new Map(), fin: new Set(), autoT: null, countT: null, raceT: null };
    rooms.set(room.code, room);
  }
  p.name = str(msg.name, 14) || p.name;
  p.car = str(msg.car, 16); p.av = str(msg.av, 4) || "🏎"; p.look = cleanLook(msg.look);
  p.ready = false; p.room = room;
  room.players.set(p.id, p);
  pushRoom(room); scheduleAuto(room);
}

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin || "";
  if (ALLOWED.length && origin && !ALLOWED.includes(origin)) { ws.close(1008, "origin"); return; }
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const n = (perIp.get(ip) || 0) + 1;
  if (n > MAX_PER_IP) { ws.close(1008, "limit"); return; }
  perIp.set(ip, n);

  const p = { ws, id: uid(), name: "Piloto", car: "", av: "🏎", look: {}, ready: false, room: null, hello: false, alive: true, lastSt: 0, lastJoin: 0, bucket: 40, bt: Date.now() };
  const helloT = setTimeout(() => { if (!p.hello) ws.close(1008, "hello"); }, 10000);
  ws.on("pong", () => { ws._dead = false; });

  ws.on("message", raw => {
    const now = Date.now();
    p.bucket = Math.min(40, p.bucket + (now - p.bt) / 1000 * 25); p.bt = now;
    if (--p.bucket < 0) return;
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    if (m.t === "hello") {
      if (p.hello) return;
      p.hello = true; p.name = str(m.name, 14) || "Piloto";
      return send(ws, { t: "welcome", id: p.id });
    }
    if (!p.hello) return;
    switch (m.t) {
      case "ping": send(ws, { t: "pong", ts: num(m.ts, 0, 1e15) }); break;
      case "join": joinRoom(p, m); break;
      case "ready":
        if (p.room && p.room.state === "lobby") { p.ready = true; pushRoom(p.room); checkAllReady(p.room); }
        break;
      case "leave": leaveRoom(p); break;
      case "st":
        if (p.room && p.room.state === "racing" && now - p.lastSt >= 50) {
          p.lastSt = now;
          broadcast(p.room, { t: "st", id: p.id, d: num(m.d, 0, 1e6), l: num(m.l, -40, 40), sp: num(m.sp, 0, 200), n: m.n ? 1 : 0, lv: num(m.lv, -30, 30) }, ws);
        }
        break;
      case "fin":
        if (p.room && p.room.state === "racing" && !p.room.fin.has(p.id)) {
          p.room.fin.add(p.id);
          broadcast(p.room, { t: "fin", id: p.id, time: num(m.time, 0, 3600) });
          if ([...p.room.players.keys()].every(id => p.room.fin.has(id))) setTimeout(() => backToLobby(p.room), 4000);
        }
        break;
    }
  });
  ws.on("close", () => {
    clearTimeout(helloT);
    leaveRoom(p);
    const left = (perIp.get(ip) || 1) - 1;
    if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
  });
  ws.on("error", () => {});
});

const hb = setInterval(() => {
  for (const ws of wss.clients) { if (ws._dead) { ws.terminate(); continue; } ws._dead = true; ws.ping(); }
}, 30000);
hb.unref && hb.unref();

server.listen(PORT, () => console.log("OVERDRIVE online na porta " + PORT));
