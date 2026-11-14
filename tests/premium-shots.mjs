/**
 * premium-shots.mjs — screenshots of the graphics upgrade at desktop, phone and TV sizes.
 * Usage:  BASE=http://localhost:2568 OUT=/workspace/totrods-premium-shots node tests/premium-shots.mjs [what...]
 * Needs: a running server and playwright-core (see /tmp/e2e-pw), Google Chrome.
 */
import { createRequire } from "module";
import { mkdirSync } from "fs";
const require = createRequire("/tmp/e2e-pw/package.json");
const { chromium } = require("playwright-core");

const BASE = (process.env.BASE ?? "http://localhost:2567").replace(/\/$/, "");
const OUT = process.env.OUT ?? "/workspace/totrods-premium-shots";
mkdirSync(OUT, { recursive: true });
const want = new Set(process.argv.slice(2));
const on = (k) => want.size === 0 || want.has(k);
const errors = [];

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});

async function open(w, h, query = "", mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${w}x${h} pageerror] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`[${w}x${h} console] ${m.text()}`));
  // Q=high pins the quality tier (otherwise slow software rendering would make
  // the adaptive-quality watcher switch effects off mid-shot).
  if (process.env.Q) query += (query.includes("?") ? "&" : "?") + `quality=${process.env.Q}`;
  await page.goto(`${BASE}/${query}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__totrods?.game, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return page;
}
const info = (page) => page.evaluate(() => window.__totrods.info());
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("saved", `${OUT}/${name}.png`);
};

/** Start a 1P race with roster index `pick` and wait for the countdown. */
async function startSolo(page, pick = 0, players = 1) {
  if (players === 2) await page.keyboard.press("Digit2");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  if (players === 1) await page.locator(".char-card").nth(pick).click();
  else {
    await page.locator(".char-card").nth(pick).click();
    await page.locator(".char-card").nth((pick + 2) % 6).click();
  }
  await page.waitForFunction(() => window.__totrods.info().state === "countdown", null, { timeout: 15000 });
}

if (on("select")) {
  for (const [w, h, tag, mobile] of [[1280, 720, "desktop", false], [390, 664, "phone-portrait", true], [844, 390, "phone-landscape", true], [1920, 1080, "tv", false]]) {
    const page = await open(w, h, "", mobile);
    if (mobile) await page.locator("#mode1").tap();
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);
    await shot(page, `select-${tag}`);
    await page.context().close();
  }
}

if (on("faces")) {
  // Close-ups of every toddler during the countdown (the camera starts on their face).
  const page = await open(1280, 720);
  for (let i = 0; i < 6; i++) {
    await startSolo(page, i);
    await page.waitForTimeout(250);
    await page.evaluate(() => (window.__totrods.paused = true));
    await page.waitForTimeout(400);
    await shot(page, `face-${i}`);
    await page.evaluate(() => (window.__totrods.paused = false));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
  await page.context().close();
}

if (on("tour")) {
  // Stage 2 environments: drop the racer at points along the lap (facing along the
  // racing line) and let the chase camera settle. Fractions are of one lap.
  const page = await open(1280, 720);
  await startSolo(page, 0);
  await page.waitForFunction(() => window.__totrods.info().state === "racing", null, { timeout: 30000 });
  for (const [f, tag] of [[0.03, "living"], [0.1, "yard-in"], [0.17, "yard-swings"], [0.24, "yard-back"], [0.4, "kitchen"], [0.6, "nursery"], [0.82, "hallway"]]) {
    await page.evaluate((frac) => {
      const g = window.__totrods.game, t = g.track;
      const pose = t.poseAt(Math.round(t.sampleCount * frac));
      g.debugPlace(0, pose.position.x, pose.position.z, pose.heading);
    }, f);
    await page.waitForTimeout(1800);
    await shot(page, `env-${tag}`);
  }
  await page.context().close();
}

if (on("devices")) {
  // In-race HUD (touch pads, mini-map, speedo) on phones and a TV.
  for (const [w, h, tag, mobile] of [[390, 664, "phone-portrait", true], [844, 390, "phone-landscape", true], [1920, 1080, "tv", false]]) {
    const page = await open(w, h, "", mobile);
    if (mobile) await page.locator("#mode1").tap();
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    if (mobile) await page.locator(".char-card").nth(1).tap();
    else await page.locator(".char-card").nth(1).click();
    await page.waitForFunction(() => window.__totrods.info().state === "racing", null, { timeout: 60000 });
    await page.evaluate(() => (window.__totrods.game.players[0].autopilot = "drive"));
    await page.waitForTimeout(3000);
    await shot(page, `race-${tag}`);
    await page.context().close();
  }
}

if (on("countdown")) {
  const page = await open(1280, 720);
  await startSolo(page, 2);
  await page.waitForTimeout(1300);
  await shot(page, "race-start-countdown");
  await page.context().close();
}

if (on("race")) {
  const page = await open(1280, 720);
  await startSolo(page, 0);
  await page.waitForFunction(() => window.__totrods.info().state === "racing", null, { timeout: 60000 });
  await page.evaluate(() => (window.__totrods.game.players[0].autopilot = "drift"));
  await page.waitForFunction(() => window.__totrods.game.players[0].walker.driftLevel >= 1, null, { timeout: 120000 });
  await page.waitForTimeout(400);
  await shot(page, "mid-race-drift");
  await page.waitForFunction(() => window.__totrods.game.players[0].walker.turboLeft > 0.2, null, { timeout: 120000 });
  await page.waitForTimeout(150);
  await shot(page, "mid-race-boost");
  console.log(JSON.stringify(await page.evaluate(() => ({ fps: window.__totrods.info().fps, drawCalls: window.__totrods.drawCalls?.() }))));
  await page.context().close();
}

if (on("split")) {
  const page = await open(1280, 720);
  await startSolo(page, 0, 2);
  await page.waitForFunction(() => window.__totrods.info().state === "racing", null, { timeout: 60000 });
  await page.evaluate(() => window.__totrods.game.players.forEach((p, i) => (p.autopilot = i ? "drive" : "drift")));
  await page.waitForTimeout(6000);
  await shot(page, "split-screen");
  await page.context().close();
}

if (on("results")) {
  const page = await open(1280, 720);
  await startSolo(page, 4);
  await page.waitForFunction(() => window.__totrods.info().state === "racing", null, { timeout: 60000 });
  // Jump to the last lap, all checkpoints done, just before the line, then let autopilot cross it.
  await page.evaluate(() => {
    const g = window.__totrods.game;
    const p = g.players[0];
    p.timer.lap = p.timer.totalLaps;
    p.timer.lapTimes.push(31.2, 29.8);
    p.timer.bestLap = 29.8;
    p.timer.nextCheckpoint = 3;
    const n = g.track.sampleCount;
    const pose = g.track.poseAt(n - 12);
    g.debugPlace(0, pose.position.x, pose.position.z, pose.heading);
    p.timer.lastIndex = n - 12;
    p.autopilot = "drive";
  });
  await page.waitForFunction(() => window.__totrods.info().state === "finished", null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot(page, "results");
  await page.context().close();
}

await browser.close();
if (errors.length) {
  console.log("ERRORS:\n" + errors.join("\n"));
  process.exitCode = 1;
}
