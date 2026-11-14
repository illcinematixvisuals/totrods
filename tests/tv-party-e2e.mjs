/**
 * TV Party end-to-end test: one 1920×1080 "TV" + up to four emulated iPhones.
 * Usage:  node tests/tv-party-e2e.mjs
 * Needs: a running server (npm start) and playwright-core (see /tmp/e2e-pw).
 */
import { createRequire } from "module";
// Software-rendered headless Chrome (SwiftShader) can be 10x slower than a real GPU;
// E2E_SLOW=3 stretches every phase wait so slow CI boxes do not fail on timing alone.
const SLOW = Number(process.env.E2E_SLOW ?? 1);
const require = createRequire("/tmp/e2e-pw/package.json");
const { chromium, devices } = require("playwright-core");

const OUT = process.env.OUT ?? "/workspace/driver-game/screenshots";
const BASE = (process.env.BASE ?? "http://localhost:2567").replace(/\/$/, "");
const errors = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
});

function attachErrors(page, tag) {
  page.on("pageerror", (e) => errors.push(`[${tag} pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag} console] ${m.text()}`);
  });
}

async function tvPage() {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  attachErrors(page, "TV");
  await page.goto(`${BASE}/?tv=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__totrods?.tv?.info()?.code, null, { timeout: 30000 });
  return page;
}

async function phonePage(code, name, portrait = true) {
  const device = portrait ? devices["iPhone 14"] : devices["iPhone 14 landscape"];
  const ctx = await browser.newContext({ ...device });
  const page = await ctx.newPage();
  attachErrors(page, name);
  await page.goto(`${BASE}/?join=${code}&name=${encodeURIComponent(name)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__totrods?.controller, null, { timeout: 30000 });
  await page.fill("#phoneName", name);
  return page;
}

async function pickReady(page, index) {
  await page.waitForSelector("#phoneCards .phone-pick");
  await page.locator("#phoneCards .phone-pick").nth(index).click();
  await page.waitForTimeout(200);
  await page.click("#phoneReadyBtn");
  await page.waitForTimeout(200);
}

const tvInfo = (page) => page.evaluate(() => window.__totrods.tv.info());
const waitPhase = (page, phase, timeout = 30000) =>
  page.waitForFunction((ph) => window.__totrods.tv.info().phase === ph, phase, { timeout: timeout * SLOW });

async function driveFor(tv, phones, ms) {
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < ms) {
    const info = await tv.evaluate(() => {
      const g = window.__totrods.game;
      const tip = window.__totrods.tv.info();
      // Un-stick anyone who left the racing line.
      for (const p of g.players) {
        const q = g.track.query(p.walker.position, p.progress);
        if (!p.finished && q.distance > g.track.halfWidth * 2) p.resetToTrack();
      }
      return tip;
    });
    if (info.phase === "results") return info;
    if (Date.now() - lastLog > 8000) {
      lastLog = Date.now();
      log("autopilot", info.players.map((p) => `${p.name} L${p.lap} p${p.progress} ${p.speedMph}mph`).join(" | "));
    }
    for (let i = 0; i < info.players.length; i++) {
      const p = info.players[i];
      const pad = phones[i];
      if (!pad) continue;
      try {
        await pad.evaluate((s) => window.__totrods.controller.hold({ steer: s, throttle: 1, brake: 0, drift: false, reset: false }), p.suggestedSteer);
      } catch {
        /* phone may be mid-reload */
      }
    }
    await tv.waitForTimeout(50);
  }
  return tvInfo(tv);
}

// -----------------------------------------------------------------------------
// 1) Character select with all 6 toddlers
// -----------------------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  attachErrors(page, "chars");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__totrods?.game, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.click("#mode1");
  await page.waitForTimeout(200);
  // Call enterSelect directly: pressing Enter on the title used to also lock in
  // the first toddler (a handler added mid-keydown). The Keyboard now snapshots
  // its list, but we still avoid Enter here so the select screen stays up.
  await page.evaluate(() => window.__totrods.game.enterSelect());
  await page.waitForSelector("#selectScreen:not(.hidden)");
  await page.waitForTimeout(1800);
  const onSelect = await page.evaluate(() => !document.getElementById("selectScreen").classList.contains("hidden"));
  if (!onSelect) throw new Error("character select disappeared before the screenshot");
  const nCards = await page.locator("#selectCards .char-card").count();
  if (nCards !== 6) throw new Error(`expected 6 character cards, got ${nCards}`);
  await page.screenshot({ path: `${OUT}/characters.png` });
  log("characters.png —", nCards, "cards");
  await ctx.close();
}

// -----------------------------------------------------------------------------
// 2) TV lobby + phones
// -----------------------------------------------------------------------------
const tv = await tvPage();
await tv.waitForTimeout(800);
const lobby0 = await tvInfo(tv);
log("TV room", lobby0.code, "joinUrl", lobby0.joinUrl);
if (!lobby0.joinUrl.includes(`?join=${lobby0.code}`)) throw new Error("join URL should be origin + ?join=CODE");
const code = lobby0.code;

const names = ["Alex", "Sam", "Riley", "Quinn"];
const phones = [];
phones[0] = await phonePage(code, names[0], true);
phones[1] = await phonePage(code, names[1], true);
await pickReady(phones[0], 0);
await pickReady(phones[1], 1);
await tv.waitForTimeout(500);
await tv.screenshot({ path: `${OUT}/tv-lobby.png` });
log("tv-lobby.png — code", (await tv.locator("#tvRoomCode").textContent()).trim());
await phones[0].screenshot({ path: `${OUT}/phone-join.png` });
log("phone-join.png");

// 2P race screenshot
await tv.click("#tvStartBtn");
await waitPhase(tv, "racing", 20000);
await tv.waitForTimeout(800);
await tv.screenshot({ path: `${OUT}/tv-race-2p.png` });
log("tv-race-2p.png");
await tv.keyboard.press("Escape"); // back to lobby (race aborted)
await waitPhase(tv, "lobby", 10000);

// 3rd phone, 3P race
phones[2] = await phonePage(code, names[2], true);
await pickReady(phones[2], 2);
// first two need to ready again after lobby reset
for (const p of [phones[0], phones[1]]) {
  const ready = await p.locator("#phoneReadyBtn").textContent();
  if (!ready.includes("✓")) await p.click("#phoneReadyBtn");
}
await tv.waitForTimeout(400);
await tv.click("#tvStartBtn");
await waitPhase(tv, "racing", 20000);
await tv.waitForTimeout(800);
await tv.screenshot({ path: `${OUT}/tv-race-3p.png` });
log("tv-race-3p.png");
await tv.keyboard.press("Escape");
await waitPhase(tv, "lobby", 10000);

// 4th phone, 4P race, movement, pickup, reload, finish
phones[3] = await phonePage(code, names[3], true);
await pickReady(phones[3], 3);
for (const p of phones.slice(0, 3)) {
  const ready = await p.locator("#phoneReadyBtn").textContent();
  if (!ready.includes("✓")) await p.click("#phoneReadyBtn");
}
await tv.waitForTimeout(400);
await tv.click("#tvStartBtn");
await waitPhase(tv, "racing", 20000);

// Landscape controller screenshot
await phones[0].setViewportSize({ width: 844, height: 390 });
await phones[0].waitForTimeout(300);
await phones[0].screenshot({ path: `${OUT}/phone-controller.png` });
log("phone-controller.png");

await tv.waitForTimeout(600);
await tv.screenshot({ path: `${OUT}/tv-race-4p.png` });
log("tv-race-4p.png");

// Phones send gas; every walker on the TV should move.
const before = await tvInfo(tv);
for (const p of phones) {
  await p.evaluate(() => window.__totrods.controller.hold({ steer: 0, throttle: 1, brake: 0, drift: false, reset: false }));
}
await tv.waitForTimeout(1200 * SLOW);
const after = await tvInfo(tv);
const moved = after.players.filter((p, i) => {
  const b = before.players[i];
  return Math.hypot(p.x - b.x, p.z - b.z) > 0.4;
}).length;
log("walkers that moved after phone throttle:", moved, "/", after.players.length);
if (moved < after.players.length) throw new Error(`only ${moved} walkers moved`);

// Pickup: teleport player 0 onto an active pickup and check the effect lands on them.
const hit = await tv.evaluate(() => {
  const g = window.__totrods.game;
  const item = g.pickups.items.find((i) => i.active && i.kind !== "crib") ?? g.pickups.items.find((i) => i.active);
  if (!item) return null;
  g.debugPlace(0, item.position.x, item.position.z);
  return { kind: item.kind, x: item.position.x, z: item.position.z };
});
await tv.waitForTimeout(300);
const fx = (await tvInfo(tv)).players[0].effect;
log("pickup", hit, "→ player 0 effect", fx);
if (!fx) throw new Error("expected player 0 to receive a pickup effect");
await tv.evaluate(() => window.__totrods.game.players[0].resetToTrack());

// Phone reload mid-race: same seat.
const youBefore = await phones[1].evaluate(() => window.__totrods.controller.info().you);
await phones[1].reload({ waitUntil: "domcontentloaded" });
await phones[1].waitForFunction(() => window.__totrods?.controller?.info()?.you, null, { timeout: 20000 });
const youAfter = await phones[1].evaluate(() => window.__totrods.controller.info().you);
log("phone reload seat", youBefore, "→", youAfter);
if (youBefore !== youAfter) throw new Error("phone did not rejoin its seat");

// Autopilot the rest of the race.
log("autopilot…");
const finished = await driveFor(tv, phones, 360000);
if (finished.phase !== "results") throw new Error(`race did not finish, phase=${finished.phase}`);
await tv.waitForSelector("#tvResultsScreen:not(.hidden)", { timeout: 10000 });
await tv.waitForTimeout(400);
await tv.screenshot({ path: `${OUT}/tv-results.png` });
log("tv-results.png —", await tv.locator("#tvResultsTitle").textContent());

// Back to lobby, TV reload keeps the room and players.
await tv.click("#tvAgainBtn");
await waitPhase(tv, "lobby", 10000);
const beforeReload = await tvInfo(tv);
await tv.reload({ waitUntil: "domcontentloaded" });
await tv.waitForFunction(() => window.__totrods?.tv?.info()?.code, null, { timeout: 30000 });
const afterReload = await tvInfo(tv);
log("TV reload", beforeReload.code, "→", afterReload.code, "players", afterReload.lobby?.length);
if (afterReload.code !== beforeReload.code) throw new Error("TV reload lost the room code");
if ((afterReload.lobby?.length ?? 0) < 4) throw new Error("TV reload lost players");

// -----------------------------------------------------------------------------
// Public URL: join link uses the ngrok https origin when the TV is opened there.
// -----------------------------------------------------------------------------
const PUBLIC = process.env.PUBLIC_URL ?? "";
if (PUBLIC) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  attachErrors(page, "ngrok");
  await page.goto(`${PUBLIC.replace(/\/$/, "")}/?tv=1`, { waitUntil: "networkidle", timeout: 60000 });
  const visit = page.getByRole("button", { name: "Visit Site" });
  if ((await visit.count()) > 0) {
    log("ngrok interstitial shown, clicking Visit Site");
    await visit.click();
  }
  await page.waitForFunction(() => window.__totrods?.tv?.info()?.joinUrl, null, { timeout: 45000 });
  const url = (await page.evaluate(() => window.__totrods.tv.info())).joinUrl;
  log("ngrok join URL", url);
  if (!url.startsWith(PUBLIC.replace(/\/$/, ""))) throw new Error(`join URL did not use the public origin: ${url}`);
  await ctx.close();
}

await browser.close();

const real = errors.filter((e) => !/failed to load|favicon|net::ERR_/.test(e));
if (real.length) {
  console.log("CONSOLE ERRORS:");
  real.forEach((e) => console.log(" ", e));
  process.exit(1);
}
console.log("ALL TV PARTY E2E CHECKS PASSED");
process.exit(0);
