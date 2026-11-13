/**
 * server/src/index.ts — the TotRods game server.
 *
 * ONE Node process, ONE port, two jobs:
 *  1. Plain HTTP: serves the built game (the dist/ folder) so a single deploy
 *     hosts everything. Open http://localhost:2567 and play.
 *  2. WebSockets: on the same port, browsers "upgrade" their connection to a
 *     WebSocket and exchange JSON messages (see shared/protocol.ts).
 *
 * Environment variables:
 *   PORT        port to listen on (default 2567; hosts like Render set this for you)
 *   STATIC_DIR  folder with the built client (default ./dist)
 *
 * Run in development:  npm run server      (restarts when you edit files)
 * Run in production:   npm run build && npm start
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { randomInt } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_SERVER_PORT,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  cleanName,
  normalizeRoomCode,
  type ServerMessage,
} from "../../shared/protocol.js";
import { Room, type ServerPlayer } from "./Room.js";
import { TvRoom, type TvController } from "./TvRoom.js";
import { parseClientMessage } from "./validate.js";

const PORT = Number(process.env.PORT) || DEFAULT_SERVER_PORT;
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? "dist");

// -----------------------------------------------------------------------------
// 1) Static files (the built game)
// -----------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/**
 * index.html gets a tiny marker so the client knows "the game server is the
 * same host and port that served this page" (see src/net/serverUrl.ts).
 */
function indexHtml(): string | null {
  const file = join(STATIC_DIR, "index.html");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").replace("</head>", `<meta name="totrods-server" content="same-origin" /></head>`);
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end(`ok ${rooms.size + tvRooms.size} rooms`);
    return;
  }
  // /play?room=CODE is the phone-controller join URL; serve the same app.
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/play" || url.pathname === "/play/") {
    const html = indexHtml();
    if (!html) {
      res.writeHead(200, { "content-type": "text/plain" }).end("TotRods server is running. Build the client (npm run build) to serve the game here.");
      return;
    }
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" }).end(html);
    return;
  }
  // normalize + prefix check stops "../../etc/passwd" style requests escaping STATIC_DIR.
  let file: string;
  try {
    file = normalize(join(STATIC_DIR, decodeURIComponent(url.pathname)));
  } catch {
    file = ""; // malformed %-escapes
  }
  if (!file.startsWith(STATIC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const cache = url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": cache });
  createReadStream(file).pipe(res);
}

const http = createServer(serveStatic);

// -----------------------------------------------------------------------------
// 2) WebSockets and rooms
// -----------------------------------------------------------------------------

const rooms = new Map<string, Room>();
const tvRooms = new Map<string, TvRoom>();

function makeRoomCode(): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!rooms.has(code) && !tvRooms.has(code)) return code;
  }
}

/** Which room/seat a socket belongs to (set once it creates or joins). */
type Seat =
  | { kind: "online"; room: Room; player: ServerPlayer }
  | { kind: "tv-host"; room: TvRoom }
  | { kind: "tv-pad"; room: TvRoom; player: TvController };

function sendRaw(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// maxPayload: refuse giant messages (ours are tiny, ~150 bytes).
const wss = new WebSocketServer({ server: http, maxPayload: 4 * 1024 });

wss.on("connection", (ws: WebSocket & { alive?: boolean }) => {
  let seat: Seat | null = null;
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (data) => {
    const msg = parseClientMessage(data.toString());
    if (!msg) return sendRaw(ws, { type: "error", code: "bad-message", message: "Could not understand that message." });
    const now = Date.now();

    switch (msg.type) {
      case "ping":
        // Clock sync: the client compares its own clock with ours (see NetClient.ts).
        return sendRaw(ws, { type: "pong", t: msg.t, server: now });

      case "create":
      case "join":
      case "resume": {
        if (msg.version !== PROTOCOL_VERSION) return sendRaw(ws, { type: "error", code: "version", message: "Your game is out of date. Please refresh the page." });
        if (seat) return; // already in a room
        if (msg.type === "create") {
          const room = new Room(makeRoomCode());
          rooms.set(room.code, room);
          seat = { kind: "online", room, player: room.addPlayer(ws, cleanName(msg.name)) };
          console.log(`[${room.code}] created by ${seat.player.name} (${rooms.size} rooms)`);
          return;
        }
        const room = rooms.get(normalizeRoomCode(msg.code));
        if (!room) return sendRaw(ws, { type: "error", code: msg.type === "resume" ? "expired" : "no-room", message: "No room with that code." });
        if (msg.type === "resume") {
          const player = room.resume(msg.token, ws);
          if (!player) return sendRaw(ws, { type: "error", code: "expired", message: "Your seat in that room has expired." });
          seat = { kind: "online", room, player };
          console.log(`[${room.code}] ${player.name} reconnected`);
          return;
        }
        const why = room.canJoin();
        if (why) return sendRaw(ws, { type: "error", code: why, message: why === "room-full" ? "That room is full." : "That room is racing. Try again after the race." });
        seat = { kind: "online", room, player: room.addPlayer(ws, cleanName(msg.name)) };
        console.log(`[${room.code}] ${seat.player.name} joined (${room.players.size} players)`);
        return;
      }

      case "tv_create":
      case "tv_resume":
      case "controller_join":
      case "controller_resume": {
        if (msg.version !== PROTOCOL_VERSION) return sendRaw(ws, { type: "error", code: "version", message: "Your game is out of date. Please refresh the page." });
        if (seat) return;
        if (msg.type === "tv_create") {
          const room = new TvRoom(makeRoomCode(), ws);
          tvRooms.set(room.code, room);
          seat = { kind: "tv-host", room };
          console.log(`[${room.code}] TV Party created (${tvRooms.size} TV rooms)`);
          return;
        }
        const room = tvRooms.get(normalizeRoomCode(msg.code));
        if (!room) return sendRaw(ws, { type: "error", code: msg.type.endsWith("resume") ? "expired" : "no-room", message: "No TV Party with that code." });
        if (msg.type === "tv_resume") {
          if (!room.resumeTv(msg.token, ws)) return sendRaw(ws, { type: "error", code: "expired", message: "This TV Party has expired." });
          seat = { kind: "tv-host", room };
          console.log(`[${room.code}] TV reconnected`);
          return;
        }
        if (msg.type === "controller_resume") {
          const player = room.resumeController(msg.token, ws);
          if (!player) return sendRaw(ws, { type: "error", code: "expired", message: "Your seat in that party has expired." });
          seat = { kind: "tv-pad", room, player };
          console.log(`[${room.code}] ${player.name} (controller) reconnected`);
          return;
        }
        const why = room.canJoin();
        if (why) return sendRaw(ws, { type: "error", code: why, message: "Room full" });
        const fallback = `Player ${room.snapshot().players.length + 1}`;
        seat = { kind: "tv-pad", room, player: room.addController(ws, cleanName(msg.name, fallback)) };
        console.log(`[${room.code}] ${seat.player.name} joined the TV Party (${room.snapshot().players.length} phones)`);
        return;
      }

      case "leave":
        if (seat) {
          leaveSeat(seat);
          seat = null;
        }
        return;

      default:
        if (!seat) return;
        if (seat.kind === "online") seat.room.handle(seat.player, msg, now);
        else if (seat.kind === "tv-host") seat.room.handleTv(msg, now);
        else seat.room.handleController(seat.player, msg);
    }
  });

  ws.on("close", () => {
    // Only mark disconnected if this socket still owns the seat (a reconnect may have replaced it).
    if (!seat) return;
    if (seat.kind === "online" && seat.player.socket === ws) {
      console.log(`[${seat.room.code}] ${seat.player.name} disconnected (grace period started)`);
      seat.room.disconnected(seat.player, Date.now());
    } else if (seat.kind === "tv-host" && seat.room.tv.socket === ws) {
      console.log(`[${seat.room.code}] TV disconnected (grace period started)`);
      seat.room.tvDisconnected(Date.now());
    } else if (seat.kind === "tv-pad" && seat.player.socket === ws) {
      console.log(`[${seat.room.code}] ${seat.player.name} (controller) disconnected (grace period started)`);
      seat.room.controllerDisconnected(seat.player, Date.now());
    }
  });
});

function leaveSeat(seat: Seat): void {
  if (seat.kind === "online") {
    console.log(`[${seat.room.code}] ${seat.player.name} left`);
    seat.player.socket = null;
    seat.room.remove(seat.player);
    cleanupRoom(seat.room);
  } else if (seat.kind === "tv-host") {
    console.log(`[${seat.room.code}] TV left (party over)`);
    seat.room.close("The TV started a new game.");
    cleanupTvRoom(seat.room);
  } else {
    console.log(`[${seat.room.code}] ${seat.player.name} left the TV Party`);
    seat.player.socket = null;
    seat.room.removeController(seat.player);
    cleanupTvRoom(seat.room);
  }
}

function cleanupRoom(room: Room): void {
  if (room.isEmpty && rooms.get(room.code) === room) {
    rooms.delete(room.code);
    console.log(`[${room.code}] closed (${rooms.size} rooms)`);
  }
}

function cleanupTvRoom(room: TvRoom): void {
  if (room.isEmpty && tvRooms.get(room.code) === room) {
    tvRooms.delete(room.code);
    console.log(`[${room.code}] TV Party closed (${tvRooms.size} TV rooms)`);
  }
}

// Room timers: pickup respawns, reconnect grace, race timeouts.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    room.tick(now);
    cleanupRoom(room);
  }
  for (const room of tvRooms.values()) {
    if (room.tick(now) === "close") cleanupTvRoom(room);
    else cleanupTvRoom(room);
  }
}, 100);

// Heartbeat: browsers that vanish without closing (Wi-Fi dropped) are detected
// by WebSocket ping frames. No pong within 10 s → terminate → normal close handling.
setInterval(() => {
  for (const client of wss.clients as Set<WebSocket & { alive?: boolean }>) {
    if (client.alive === false) client.terminate();
    else {
      client.alive = false;
      client.ping();
    }
  }
}, 10000);

// Hosts (Render, Railway, Fly.io) send SIGTERM before replacing the server: close politely.
// Rooms live in memory, so they end here; clients show "Lost the connection to the room".
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal}: closing ${wss.clients.size} connections`);
    for (const client of wss.clients) client.close(1001, "server restarting");
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

http.listen(PORT, "0.0.0.0", () => {
  console.log(`TotRods server listening on 0.0.0.0:${PORT}  (WebSocket on the same port)`);
  console.log(existsSync(join(STATIC_DIR, "index.html")) ? `Serving the game from ${STATIC_DIR}` : `No built client in ${STATIC_DIR} yet (run npm run build)`);
});
