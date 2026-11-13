// Protocol test: talks to a running server with raw WebSockets (no browser).
// Usage: node tests/protocol-test.mjs [ws://localhost:2567]
import WebSocket from "ws";
const URL = process.argv[2] ?? "ws://localhost:2567";
const V = 1;
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const c = { ws, msgs: [], send: (m) => ws.send(JSON.stringify(m)), last: (type) => [...c.msgs].reverse().find((m) => m.type === type), all: (type) => c.msgs.filter((m) => m.type === type) };
    ws.on("message", (d) => c.msgs.push(JSON.parse(d.toString())));
    ws.on("open", () => resolve(c));
  });
}

const a = await client();
a.send({ type: "create", name: "Alice", version: V });
await sleep(200);
const code = a.last("welcome")?.room.code;
check(/^[A-HJKMNP-Z2-9]{4}$/.test(code ?? ""), `room code looks right (${code})`);

const bad = await client();
bad.send({ type: "join", code: "ZZZZ", name: "x", version: V });
await sleep(150);
check(bad.last("error")?.code === "no-room", "unknown code is refused");
bad.send({ nonsense: true });
await sleep(100);
check(bad.last("error")?.code === "bad-message", "garbage message is refused");
bad.ws.close();

const b = await client();
b.send({ type: "join", code: code.toLowerCase(), name: "Alice", version: V });
await sleep(200);
const bWelcome = b.last("welcome");
check(!!bWelcome, "second player joins (lowercase code accepted)");
check(bWelcome?.room.players.map((p) => p.name).join(",") === "Alice,Alice 2", "duplicate names get a number");

a.send({ type: "pick", character: "dj-the-dasher" });
await sleep(100);
b.send({ type: "pick", character: "dj-the-dasher" });
await sleep(150);
check(b.last("error")?.code === "taken", "duplicate toddler pick refused");
b.send({ type: "pick", character: "adam-the-great" });
b.send({ type: "start" });
await sleep(150);
check(b.last("error")?.code === "not-host", "non-host cannot start");
a.send({ type: "start" });
await sleep(150);
check(a.last("error")?.code === "cannot-start", "host cannot start before everyone is ready");
a.send({ type: "ready", ready: true });
b.send({ type: "ready", ready: true });
await sleep(150);

const c3 = await client();
c3.send({ type: "join", code, name: "Carl", version: V });
await sleep(150);
const extras = [];
for (const name of ["Dee", "Eve", "Fay"]) {
  const c = await client();
  c.send({ type: "join", code, name, version: V });
  extras.push(c);
  await sleep(120);
}
check(a.last("room").room.players.length === 6, "six unique toddlers → six players can join");
const c7 = await client();
c7.send({ type: "join", code, name: "Guy", version: V });
await sleep(150);
check(c7.last("error")?.code === "room-full", "7th player refused (6 toddlers → max 6 players)");
c7.ws.close();
for (const c of extras) c.send({ type: "leave" });
c3.send({ type: "leave" });
await sleep(200);
check(a.last("room").room.players.length === 2, "explicit leave frees the seat immediately");

a.send({ type: "start" });
await sleep(150);
const start = a.last("raceStart")?.race;
check(!!start && !!b.last("raceStart"), "host starts: both get raceStart with a start time");
const wait = start.startAt - Date.now();
check(wait > 2500 && wait < 3600, `countdown start is ~3.5 s ahead (${wait} ms)`);

// Claims before GO are ignored.
a.send({ type: "claimPickup", id: 0 });
await sleep(100);
check(a.all("pickupTaken").length === 0, "pickups can't be claimed before GO");
await sleep(Math.max(0, start.startAt - Date.now() + 50));

// Both claim the same pickup at the same moment: exactly one winner.
a.send({ type: "claimPickup", id: 3 });
b.send({ type: "claimPickup", id: 3 });
await sleep(200);
const takenA = a.all("pickupTaken"), takenB = b.all("pickupTaken");
check(takenA.length === 1 && takenB.length === 1 && takenA[0].by === takenB[0].by, `first claim wins (winner ${takenA[0]?.by === a.last("welcome").you ? "Alice" : "Alice 2"}), both told`);

// State relay with server timestamps.
a.send({ type: "state", state: { x: 1, z: 2, h: 0.5, v: 10, s: 0, y: 0, look: 0, fx: null } });
await sleep(100);
check(b.last("state")?.state.x === 1 && typeof b.last("state")?.t === "number" && !a.last("state"), "positions relayed to others only, server-timestamped");

// Lap rules.
b.send({ type: "lapDone" });
await sleep(100);
check(b.all("lap").length === 0, "lap without checkpoints rejected");
b.send({ type: "checkpoint", number: 2 });
b.send({ type: "checkpoint", number: 1 });
b.send({ type: "checkpoint", number: 2 });
b.send({ type: "checkpoint", number: 3 });
b.send({ type: "lapDone" });
await sleep(100);
check(b.all("lap").length === 0, "lap faster than MIN_LAP_MS rejected");

// Disconnect + resume inside the grace period.
const token = b.last("welcome").token;
const bId = b.last("welcome").you;
b.ws.terminate();
await sleep(300);
check(a.last("room").room.players.find((p) => p.id === bId)?.connected === false, "dropped player shown as disconnected, seat kept");
const b2 = await client();
b2.send({ type: "resume", code, token, version: V });
await sleep(200);
const w2 = b2.last("welcome");
check(w2?.you === bId && w2.room.phase === "racing" && w2.room.race?.pickupRespawnAt[3] !== null, "resume restores the same seat mid-race with pickup state");
const bogus = await client();
bogus.send({ type: "resume", code, token: "deadbeef", version: V });
await sleep(150);
check(bogus.last("error")?.code === "expired", "bad token refused");
bogus.ws.close();

// Pickup respawn after 4 s.
await sleep(4100);
check(a.all("pickupRespawn").some((m) => m.id === 3), "pickup respawns after 4 s");

// Host leaves → host migrates.
a.send({ type: "leave" });
await sleep(200);
check(b2.last("room").room.hostId === bId, "host migrates when the host leaves");
await sleep(200);
check(!b2.last("results"), "remaining racer can still finish (race keeps going)");
b2.send({ type: "leave" });
await sleep(100);
a.ws.close(); b2.ws.close();

// -----------------------------------------------------------------------------
// TV Party: the server is a relay + lobby referee, not the race authority.
// -----------------------------------------------------------------------------
const tv = await client();
tv.send({ type: "tv_create", version: V });
await sleep(200);
const tvWelcome = tv.last("tv_welcome");
const tvCode = tvWelcome?.room.code;
check(tvWelcome?.role === "tv" && /^[A-HJKMNP-Z2-9]{4}$/.test(tvCode ?? ""), `TV Party room created (${tvCode})`);

const p1 = await client();
p1.send({ type: "controller_join", code: tvCode, name: "", version: V });
await sleep(150);
check(/^Player 1$/.test(p1.last("tv_welcome")?.you ? p1.last("tv_welcome").room.players[0].name : ""), "empty name becomes Player 1");
check(p1.last("tv_welcome")?.role === "controller" && p1.last("tv_welcome").room.players[0].host === true, "first phone is the host controller");

const p2 = await client();
p2.send({ type: "controller_join", code: tvCode.toLowerCase(), name: "Sam", version: V });
await sleep(150);
check(p2.last("tv_welcome")?.room.players.length === 2, "second phone joins (lowercase code accepted)");

p1.send({ type: "pick", character: "huggie" });
await sleep(80);
p2.send({ type: "pick", character: "huggie" });
await sleep(120);
check(p2.last("error")?.code === "taken", "TV Party: duplicate toddler pick refused");
p2.send({ type: "pick", character: "snacks" });
p2.send({ type: "tv_start" });
await sleep(120);
check(p2.last("error")?.code === "not-host", "non-host phone cannot start");
tv.send({ type: "tv_start" });
await sleep(120);
check(tv.last("error")?.code === "cannot-start", "TV cannot start before everyone is ready");
p1.send({ type: "ready", ready: true });
p2.send({ type: "ready", ready: true });
await sleep(120);
tv.send({ type: "tv_start" });
await sleep(150);
check(!!tv.last("tv_start")?.grid && tv.last("tv_start").grid.length === 2, "TV start: grid of 2 player ids");
check(p1.last("tv_room")?.room.phase === "countdown" || p1.last("tv_room")?.room.phase === "racing" || p1.last("tv_room")?.room.phase === "countdown", "phones see the race phase");

// Input is relayed only to the TV, not to the other phone.
p1.send({ type: "controller_input", input: { steer: 0.5, throttle: 1, brake: 0, drift: false, reset: false } });
await sleep(120);
check(tv.last("controller_input")?.input.throttle === 1 && tv.last("controller_input").id === p1.last("tv_welcome").you, "phone input is relayed to the TV");
check(!p2.last("controller_input"), "other phones do not receive raw input");

// Mid-race join is queued, not refused.
const p3 = await client();
p3.send({ type: "controller_join", code: tvCode, name: "Late", version: V });
await sleep(150);
check(p3.last("tv_welcome")?.room.players.find((x) => x.name === "Late")?.queued === true, "late joiner is queued for the next race");

// Room cap still applies (fill to 6, 7th refused). Already 3 in the room; add 3 more queued, 7th full.
const more = [];
for (const name of ["P4", "P5", "P6"]) {
  const c = await client();
  c.send({ type: "controller_join", code: tvCode, name, version: V });
  more.push(c);
  await sleep(80);
}
const p7 = await client();
p7.send({ type: "controller_join", code: tvCode, name: "P7", version: V });
await sleep(120);
check(p7.last("error")?.code === "room-full", "7th phone sees Room full");
p7.ws.close();

// Phone reload: resume same seat.
const p1Token = p1.last("tv_welcome").token;
const p1Id = p1.last("tv_welcome").you;
p1.ws.terminate();
await sleep(200);
check(tv.last("tv_room")?.room.players.find((x) => x.id === p1Id)?.connected === false, "dropped phone shown as disconnected, seat kept");
const p1b = await client();
p1b.send({ type: "controller_resume", code: tvCode, token: p1Token, version: V });
await sleep(200);
check(p1b.last("tv_welcome")?.you === p1Id, "phone resume restores the same seat");

// TV HUD is forwarded to the matching phone.
tv.send({ type: "tv_state_to_controller", phase: "racing", countdown: null, huds: [{ id: p1Id, lap: 2, place: 1, speedMph: 12, effect: "boost", effectText: "BOOST!", buzz: "pickup" }] });
await sleep(120);
check(p1b.last("tv_state_to_controller")?.hud.lap === 2 && p1b.last("tv_state_to_controller").hud.effect === "boost", "TV status is forwarded to the phone");

// TV disconnect → phones wait; TV resume returns to lobby (simulation was lost).
tv.ws.terminate();
await sleep(200);
check(p1b.last("tv_waiting")?.message.toLowerCase().includes("tv disconnected"), "phones are told the TV disconnected");
const tv2 = await client();
tv2.send({ type: "tv_resume", code: tvCode, token: tvWelcome.token, version: V });
await sleep(200);
check(tv2.last("tv_welcome")?.role === "tv" && tv2.last("tv_welcome").room.phase === "lobby", "TV resume mid-race returns everyone to the lobby");
check(p1b.last("tv_room")?.room.phase === "lobby" && p1b.last("tv_room").room.players.find((x) => x.name === "Late")?.queued === false, "queued late joiner is promoted once the lobby reopens");

for (const c of more) c.ws.close();
p2.ws.close(); p3.ws.close(); p1b.ws.close(); tv2.ws.close();
await sleep(80);

console.log(failures ? `${failures} FAILED` : "ALL PROTOCOL CHECKS PASSED");
process.exit(failures ? 1 : 0);
