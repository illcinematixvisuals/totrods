/**
 * main.ts — the entry point. Vite loads this from index.html.
 *
 * Babylon.js basics:
 *  - Engine: wraps WebGL and owns the <canvas>. One per page.
 *  - Scene: holds everything you can see (created inside Game).
 *  - Render loop: engine.runRenderLoop(fn) calls fn ~60 times per second.
 *    Each call we update the game, then draw one frame with scene.render().
 */
import { Engine } from "@babylonjs/core";
// The Fredoka font is bundled from npm (@fontsource), so it works offline.
import "@fontsource/fredoka/latin-500.css";
import "@fontsource/fredoka/latin-700.css";
import "./style.css";
import { Game } from "./game/Game";
import { bootPhoneController } from "./tv/PhoneController";

function isPhoneController(): boolean {
  const params = new URLSearchParams(location.search);
  const path = location.pathname.replace(/\/$/, "") || "/";
  return params.has("join") || path.endsWith("/play");
}

async function boot(): Promise<void> {
  // Phone join links skip the 3D engine entirely — this tab is just a controller.
  if (isPhoneController()) {
    setUpPhoneFriendlyPage(() => undefined);
    bootPhoneController();
    return;
  }

  // Wait for the font so text painted onto 3D textures (the gate banner) uses it.
  // `await` pauses this async function until the Promise finishes.
  try {
    await Promise.race([document.fonts.load("700 64px Fredoka"), new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    /* fall back to the next font in the list */
  }

  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
  // adaptToDeviceRatio=false renders one pixel per CSS pixel, NOT per physical pixel.
  // A phone with a 3× "retina" screen would otherwise draw 9× as many pixels → slow and hot.
  const engine = new Engine(canvas, true, { stencil: true, powerPreference: "high-performance" }, false);
  // ?players=2 pre-selects 2 players on the title screen.
  const players = new URLSearchParams(location.search).get("players") === "2" ? 2 : 1;
  const game = new Game(engine, players);

  setUpPhoneFriendlyPage(() => game.sound.unlock());

  // Deep links: ?tv=1 opens TV Party; ?room=ABCD is an online-rooms invite.
  // A page reload rejoins a TV Party first, then an online room, if a seat was saved.
  const params = new URLSearchParams(location.search);
  if (params.has("tv")) game.enterTvParty();
  else if (params.get("room")) game.enterOnline(params.get("room") ?? "");
  else if (!game.resumeTvParty()) game.resumeOnline();

  // Debug hook: type `__totrods.info()` in the browser console.
  (window as unknown as { __totrods: object }).__totrods = {
    info: () => game.debugInfo(),
    online: {
      info: () => game.online.debugInfo(),
      drop: () => game.online.net?.simulateDrop(),
    },
    tv: {
      info: () => game.tv.debugInfo(),
      start: () => game.tv.requestStart(),
      drop: () => game.tv.net?.simulateDrop(),
    },
    place: (player: number, x: number, z: number, heading?: number) => game.debugPlace(player, x, z, heading),
    scene: game.scene,
    game,
    /** Draw calls in the last frame (performance check). */
    drawCalls: () => (engine as unknown as { _drawCalls: { current: number } })._drawCalls?.current ?? null,
    /** Freeze the simulation (rendering continues) — used to frame screenshots. */
    paused: false,
  };

  engine.runRenderLoop(() => {
    // getDeltaTime() = ms since last frame. Convert to seconds and cap it, so a
    // slow frame (or a background tab) can't teleport anyone through a wall.
    const dt = Math.min(engine.getDeltaTime() / 1000, 1 / 20);
    if (!(window as unknown as { __totrods: { paused: boolean } }).__totrods.paused) game.update(dt);
    game.scene.render();
  });
  window.addEventListener("resize", () => engine.resize());
}

/**
 * Phones: stop the browser from treating game taps as page gestures
 * (pinch/double-tap zoom, pull-to-refresh, long-press menus), and unlock audio
 * on the first tap (iOS only allows sound that starts inside a tap).
 */
function setUpPhoneFriendlyPage(unlockAudio: () => void): void {
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) {
    window.addEventListener(type, unlockAudio, { capture: true, passive: true });
  }
  const typing = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  // Block browser page-gestures ONLY on the 3D canvas and the on-screen driving
  // pads. Menus must still scroll when they are taller than the phone, or the
  // buttons / links under the fold can't be reached (especially on iPhone Safari).
  document.addEventListener(
    "touchmove",
    (e) => {
      if (typing(e.target)) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("#renderCanvas, #touch, .phone-pad")) e.preventDefault();
    },
    { passive: false },
  );
  // iOS pinch-zoom ignores user-scalable=no, but these non-standard events can be cancelled.
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());
  // Long-press "copy / save image" menus.
  document.addEventListener("contextmenu", (e) => !typing(e.target) && e.preventDefault());
  document.getElementById("rotateHintClose")?.addEventListener("click", () => document.getElementById("rotateHint")?.classList.add("dismissed"));
}

void boot();
