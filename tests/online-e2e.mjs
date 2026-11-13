// End-to-end online test: two browser contexts create/join a room, race 3 laps with an autopilot,
// test pickups, a dropped connection, a page reload and leaving. Writes screenshots/online-*.png.
// Needs a running server (npm run build && npm start) plus playwright-core and Chrome:
//   npm i -D playwright-core && BASE=http://localhost:2567/ node tests/online-e2e.mjs
import { chromium } from "playwright-core";
const OUT = new URL("../screenshots", import.meta.url).pathname;
const BASE = process.env.BASE ?? "http://localhost:2567/";
const FULL = process.env.FULL !== "0";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const errors = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function newClient(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${tag} pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`[${tag} ${m.type()}] ${m.text()}`); });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  return page;
}
const oinfo = (p) => p.evaluate(() => window.__totrods.online.info());
const waitPhase = (p, phase, timeout = 30000) => p.waitForFunction((ph) => window.__totrods.online.info().phase === ph, phase, { timeout, polling: 200 });
const startBot = (page) => page.evaluate(() => {
  const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code }));
  clearInterval(window.__bot);
  window.__bot = setInterval(() => {
    const g = window.__totrods.game, p = g.online.local;
    if (!p) return;
    const n = g.track.sampleCount, t = g.track.samples[(p.progress + 14) % n], w = p.walker;
    let diff = Math.atan2(t.x - w.position.x, t.z - w.position.z) - w.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    key("KeyW", true); key("KeyD", diff > 0.06); key("KeyA", diff < -0.06);
  }, 40);
});

// ---- Host creates a room ----
const A = await newClient("A");
await A.keyboard.press("Digit3");
await A.keyboard.press("Enter");
await A.waitForSelector("#onlineScreen:not(.hidden)");
await A.fill("#onlineName", "Alex");
await A.click("#createRoomBtn");
await waitPhase(A, "lobby");
const code = (await oinfo(A)).code;
log("room created:", code);

// ---- Friend joins by typing the code ----
const B = await newClient("B");
await B.click("#mode3");
await B.waitForSelector("#onlineScreen:not(.hidden)");
await B.fill("#onlineName", "Sam");
await B.fill("#joinCode", code.toLowerCase());
await B.click("#joinRoomBtn");
await waitPhase(B, "lobby");
log("B joined:", JSON.stringify((await oinfo(B)).players.map((p) => p.name)));

// ---- Picks: A takes DJ, B tries DJ (refused) then Adam ----
await A.click("#lobbyCards .lobby-pick:nth-child(1)");
await A.waitForTimeout(400);
await B.click("#lobbyCards .lobby-pick:nth-child(1)");
await B.waitForTimeout(400);
log("B tried DJ →", JSON.stringify(await B.textContent("#lobbyStatus")), "| B pick:", (await oinfo(B)).players.find((p) => p.name === "Sam").character);
await B.click("#lobbyCards .lobby-pick:nth-child(2)");
await A.click("#readyBtn");
await B.click("#readyBtn");
await A.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 5000 });
log("start button: A visible+enabled:", await A.isEnabled("#startBtn"), "| B hidden:", await B.isHidden("#startBtn"));
await A.waitForTimeout(600);
await A.screenshot({ path: `${OUT}/online-lobby.png` });
await B.screenshot({ path: `/tmp/pw/online-lobby-b.png` });

// ---- Race ----
await A.click("#startBtn");
await waitPhase(A, "countdown", 5000); await waitPhase(B, "countdown", 5000);
log("both in countdown");
await A.waitForTimeout(1500);
await A.screenshot({ path: "/tmp/pw/online-countdown.png" });
await Promise.all([waitPhase(A, "racing", 10000), waitPhase(B, "racing", 10000)]);
const tGo = Date.now();
log("GO");
await startBot(A); await startBot(B);
await A.waitForTimeout(1200);
const a1 = await oinfo(A), b1 = await oinfo(B);
await A.waitForTimeout(1500);
const a2 = await oinfo(A), b2 = await oinfo(B);
const moved = (r1, r2) => Math.hypot(r2.x - r1.x, r2.z - r1.z);
log("A sees remote Sam moved", moved(a1.remotes[0], a2.remotes[0]).toFixed(2), "units; snapshots", a2.remotes[0].snapshots);
log("B sees remote Alex moved", moved(b1.remotes[0], b2.remotes[0]).toFixed(2), "units; snapshots", b2.remotes[0].snapshots);
log("lag check: A real", JSON.stringify([a2.local.x, a2.local.z]), "B's view of A", JSON.stringify([b2.remotes[0].x, b2.remotes[0].z]), "gap", Math.hypot(a2.local.x - b2.remotes[0].x, a2.local.z - b2.remotes[0].z).toFixed(2));
await A.waitForTimeout(2500);
await A.screenshot({ path: `${OUT}/online-race-p1.png` });
await B.screenshot({ path: `${OUT}/online-race-p2.png` });
log("fps A/B", await A.evaluate(() => Math.round(window.__totrods.game.scene.getEngine().getFps())), await B.evaluate(() => Math.round(window.__totrods.game.scene.getEngine().getFps())));

// ---- Pickup: teleport A onto pickup #1 (middle lane, 1st group, before checkpoint 1) ----
const PID = 1;
await A.evaluate((id) => {
  const s = window.__totrods.game.online, it = window.__totrods.game.pickups.items[id];
  const g = window.__totrods.game, q = g.track.query(it.position);
  s.local.walker.placeAt(it.position.clone(), g.track.poseAt(q.index).heading);
  s.local.progress = q.index;
}, PID);
await A.waitForTimeout(1500);
const ap = await oinfo(A), bp = await oinfo(B);
log(`pickup #${PID}: A sees active=${ap.pickupsActive[PID]} effect=${ap.local.effect} | B sees active=${bp.pickupsActive[PID]}`);
if (!FULL) { log("ERRORS:", errors.length ? errors : "none"); await browser.close(); process.exit(0); }

// ---- Disconnect + automatic reconnect (B's Wi-Fi blinks) ----
await B.evaluate(() => window.__totrods.online.drop());
await A.waitForTimeout(300);
const aSeesB = (await oinfo(A)).players.find((p) => p.name === "Sam");
log("after B drop: A sees Sam connected =", aSeesB.connected);
await B.waitForFunction(() => window.__totrods.online.info().status === "open", null, { timeout: 15000, polling: 200 });
await A.waitForFunction(() => window.__totrods.online.info().players.every((p) => p.connected), null, { timeout: 10000 });
const r1 = (await oinfo(A)).remotes[0]; await A.waitForTimeout(1500); const r2 = (await oinfo(A)).remotes[0];
log("B reconnected; still racing:", (await oinfo(B)).phase, "| A sees Sam moving again:", moved(r1, r2).toFixed(2));

// ---- Race to the finish ----
log("racing 3 laps with autopilot…");
await Promise.all([waitPhase(A, "results", 900000), waitPhase(B, "results", 900000)]);
const resA = (await oinfo(A)).results, resB = (await oinfo(B)).results;
log("results (A):", resA.map((r) => `${r.place ?? "DNF"}. ${r.name} ${r.timeMs ? (r.timeMs / 1000).toFixed(2) + "s" : r.laps + " laps"}`).join(" | "), "| same on B:", JSON.stringify(resA) === JSON.stringify(resB), "| real s:", ((Date.now() - tGo) / 1000).toFixed(0));
await A.evaluate(() => clearInterval(window.__bot)); await B.evaluate(() => clearInterval(window.__bot));
await A.waitForTimeout(800);
await A.screenshot({ path: `${OUT}/online-results.png` });

// ---- Back to lobby, rematch-ready; B reloads the page and gets its seat back ----
await A.click("#restartBtn"); await B.click("#restartBtn");
await waitPhase(A, "lobby"); await waitPhase(B, "lobby");
const bId = (await oinfo(B)).you;
log("back in lobby; ready flags reset:", (await oinfo(A)).players.every((p) => !p.ready));
await B.reload({ waitUntil: "networkidle" });
await waitPhase(B, "lobby", 15000);
const bAfter = await oinfo(B);
log("B reloaded → same seat:", bAfter.you === bId, "| code", bAfter.code, "| players", bAfter.players.length, "| pick kept:", bAfter.players.find((p) => p.id === bId).character);

// ---- B leaves; A sees it ----
await B.click("#leaveBtn");
await A.waitForTimeout(600);
log("after B leaves: A sees", (await oinfo(A)).players.length, "player(s); B phase", await B.evaluate(() => window.__totrods.info().state));
log("ERRORS:", errors.length ? errors : "none");
await browser.close();
