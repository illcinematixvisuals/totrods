/**
 * live-smoke.mjs — quick check that a deployed TotRods works end to end:
 * page loads, /healthz ok, two browsers make an online room over websockets,
 * pick, ready, start, and see each other move.
 * Usage:  BASE=https://totrods.onrender.com node tests/live-smoke.mjs
 */
import { createRequire } from "module";
const require = createRequire("/tmp/e2e-pw/package.json");
const { chromium } = require("playwright-core");
const BASE = (process.env.BASE ?? "https://totrods.onrender.com").replace(/\/$/, "");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const health = await (await fetch(`${BASE}/healthz`)).text();
log("healthz:", health);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const errors = [];
async function client(tag) {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  page.on("pageerror", (e) => errors.push(`[${tag}] ${e.message}`));
  const res = await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  log(tag, "HTTP", res.status());
  await page.waitForFunction(() => window.__totrods?.game, null, { timeout: 60000 });
  return page;
}
const info = (p) => p.evaluate(() => window.__totrods.online.info());
const phase = (p, ph, t = 60000) => p.waitForFunction((x) => window.__totrods.online.info().phase === x, ph, { timeout: t, polling: 250 });
const A = await client("A");
await A.click("#mode3");
await A.fill("#onlineName", "Smoke A");
await A.click("#createRoomBtn");
await phase(A, "lobby");
const code = (await info(A)).code;
log("room", code);
const B = await client("B");
await B.click("#mode3");
await B.fill("#onlineName", "Smoke B");
await B.fill("#joinCode", code);
await B.click("#joinRoomBtn");
await phase(B, "lobby");
log("B joined; players:", (await info(A)).players.length);
await A.click("#lobbyCards .lobby-pick:nth-child(1)");
await B.click("#lobbyCards .lobby-pick:nth-child(3)");
await A.click("#readyBtn");
await B.click("#readyBtn");
await A.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 15000 });
await A.click("#startBtn");
await Promise.all([phase(A, "racing"), phase(B, "racing")]);
log("racing");
await A.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" })));
const b0 = (await info(B)).remotes[0];
await A.waitForTimeout(4000);
const b1 = (await info(B)).remotes[0];
const moved = Math.hypot(b1.x - b0.x, b1.z - b0.z);
log("B sees A move", moved.toFixed(2), "units");
await B.click("#leaveBtn").catch(() => {});
log(errors.length ? "ERRORS: " + errors.join(" | ") : "no page errors");
await browser.close();
process.exit(health.startsWith("ok") && moved > 0.5 && !errors.length ? 0 : 1);
