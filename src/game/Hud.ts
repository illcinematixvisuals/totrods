/**
 * Hud.ts — the HTML overlay.
 *
 *  - PlayerHud: one per player (portrait, name, speed, lap, times, effect tint).
 *    Cloned from <template id="hudTemplate"> and positioned over that player's
 *    viewport, so split-screen gets one HUD per half.
 *  - Screens: the shared title, character select, countdown and finish screens
 *    (the online lobby screens live in src/net/OnlineSession.ts).
 *  - portraitHTML(): the illustrated portrait image for any roster entry.
 *
 * We use normal DOM elements instead of 3D text: simpler, crisp, styled with CSS.
 */
import { TOTAL_LAPS, type ResultRow } from "../../shared/protocol";
import { formatTime } from "./LapTimer";
import type { EffectKind } from "./Pickups";
import { ROSTER, type RosterEntry } from "./Roster";

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

/**
 * Illustrated portrait for any roster entry.
 *
 * Every menu and HUD that shows a toddler (select cards, lobby lists, the
 * in-race HUD, results, and the phone controller) calls this one helper, so
 * swapping the art here updates the whole game.
 *
 * The PNGs live in `public/portraits/` and are named after each roster `id`
 * (for example `dj-the-dasher.png`). Vite copies that folder to the site
 * root as-is. We use a "./" URL because vite.config.ts sets `base: "./"`
 * (relative paths, so the build works from any folder).
 */
export function portraitHTML(who: RosterEntry, size = 64): string {
  const src = `./portraits/${who.id}.png`;
  return `<div class="portrait" style="--size:${size}px"><img class="portrait-art" src="${src}" width="${size}" height="${size}" alt="${escapeHtml(who.name)}" draggable="false"></div>`;
}

export interface HudFrame {
  speedMph: number;
  lap: number;
  totalLaps: number;
  current: number;
  last: number | null;
  best: number | null;
  effect: EffectKind | null;
  effectLeft01: number; // 1 = just picked up, 0 = worn off
  turbo?: boolean; // drift mini-turbo / rocket start / milk boost → speed lines
}

/** One racer on the mini-map. */
export interface MapRacer {
  x: number;
  z: number;
  color: string;
  self: boolean;
}

/** A screen-space rectangle in 0..1 units (same convention as Babylon's Viewport). */
export interface ScreenRect {
  x: number;
  y: number; // 0 = bottom (Babylon convention)
  width: number;
  height: number;
}

const GAUGE_LENGTH = 252;
const GAUGE_MAX_MPH = 60;

export class PlayerHud {
  readonly root: HTMLElement;
  private toastTimer = 0;
  // Mini-map: the lap outline is drawn ONCE into an offscreen canvas, then each
  // update just copies it and adds the racer dots (cheap, ~10 times a second).
  private mapBg: HTMLCanvasElement | null = null;
  private mapXf: ((x: number, z: number) => [number, number]) | null = null;
  private mapLast = 0;

  constructor(label: string, who: RosterEntry) {
    const tpl = byId<HTMLTemplateElement>("hudTemplate");
    this.root = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    byId("huds").appendChild(this.root);
    this.el("name").textContent = who.name;
    this.el("tag").textContent = label;
    this.el("portrait").innerHTML = portraitHTML(who, 58);
    this.root.style.setProperty("--player", who.walkerColor);
  }

  private el(name: string): HTMLElement {
    const found = this.root.querySelector<HTMLElement>(`[data-hud="${name}"]`);
    if (!found) throw new Error(`HUD template is missing data-hud="${name}"`);
    return found;
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle("hidden", !visible);
  }

  setPlace(n: number | null): void {
    const el = this.el("place");
    el.classList.toggle("hidden", n === null);
    if (n !== null) el.textContent = n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
  }

  /** Place this HUD over a viewport (flip Y: CSS top=0, Babylon bottom=0). */
  setRect(r: ScreenRect): void {
    // Small split-screen views get a smaller mini-map and panels.
    this.root.classList.toggle("compact", r.width < 0.5 || r.height < 0.5);
    const s = this.root.style;
    s.left = `${r.x * 100}%`;
    s.width = `${r.width * 100}%`;
    s.top = `${(1 - r.y - r.height) * 100}%`;
    s.height = `${r.height * 100}%`;
    s.right = "auto";
    s.bottom = "auto";
  }

  flash(message: string, seconds = 1.6, kind: "good" | "bad" | "info" = "info"): void {
    const toast = this.el("toast");
    toast.textContent = message;
    toast.className = `toast show ${kind}`;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove("show"), seconds * 1000);
  }

  update(f: HudFrame): void {
    this.el("speed").textContent = String(Math.round(f.speedMph));
    const frac = Math.min(f.speedMph / GAUGE_MAX_MPH, 1);
    this.el("gaugeFill").style.strokeDashoffset = String(GAUGE_LENGTH * (1 - frac));
    this.el("lapNum").textContent = String(Math.min(f.lap, f.totalLaps));
    this.el("lapTotal").textContent = String(f.totalLaps);
    this.el("curTime").textContent = formatTime(f.current);
    this.el("lastTime").textContent = formatTime(f.last);
    this.el("bestTime").textContent = formatTime(f.best);
    this.root.classList.toggle("fx-boost", f.effect === "boost");
    this.root.classList.toggle("fx-nap", f.effect === "nap");
    this.root.classList.toggle("turbo", !!f.turbo);
    const bar = this.el("effectBar");
    bar.style.transform = `scaleX(${f.effect ? f.effectLeft01 : 0})`;
  }

  /**
   * Draw the mini-map: the lap (from the track's centre-line samples) with a
   * chequered start mark, and a dot per racer (yours is bigger, with a ring).
   */
  drawMinimap(path: ReadonlyArray<{ x: number; z: number }>, racers: readonly MapRacer[]): void {
    const now = performance.now();
    if (now - this.mapLast < 100 && this.mapBg) return; // ~10 redraws a second is plenty
    this.mapLast = now;
    const canvas = this.el("minimap") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.offsetParent === null) return; // hidden
    const W = canvas.width;
    if (!this.mapBg || !this.mapXf) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of path) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
      }
      const pad = 16;
      const scale = (W - pad * 2) / Math.max(x1 - x0, z1 - z0);
      const ox = (W - (x1 - x0) * scale) / 2;
      const oz = (W - (z1 - z0) * scale) / 2;
      // North (+Z) is up on the map, +X is right.
      const xf = (x: number, z: number): [number, number] => [ox + (x - x0) * scale, W - (oz + (z - z0) * scale)];
      this.mapXf = xf;
      const bg = document.createElement("canvas");
      bg.width = bg.height = W;
      const b = bg.getContext("2d")!;
      b.lineJoin = b.lineCap = "round";
      const stroke = (width: number, color: string): void => {
        b.beginPath();
        path.forEach((p, i) => (i === 0 ? b.moveTo(...xf(p.x, p.z)) : b.lineTo(...xf(p.x, p.z))));
        b.closePath();
        b.lineWidth = width;
        b.strokeStyle = color;
        b.stroke();
      };
      stroke(15, "rgba(19,35,91,0.85)");
      stroke(10, "#ffffff");
      stroke(3, "#ffd400");
      const [sx, sy] = xf(path[0].x, path[0].z);
      b.fillStyle = "#111";
      b.fillRect(sx - 7, sy - 3, 14, 6);
      b.fillStyle = "#fff";
      for (let i = 0; i < 4; i++) b.fillRect(sx - 7 + i * 3.5 + (i % 2) * 0, sy - 3 + (i % 2) * 3, 3.5, 3);
      this.mapBg = bg;
    }
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(this.mapBg, 0, 0);
    // Others first, you on top.
    for (const r of [...racers].sort((a, b) => Number(a.self) - Number(b.self))) {
      const [x, y] = this.mapXf(r.x, r.z);
      ctx.beginPath();
      ctx.arc(x, y, r.self ? 9 : 6.5, 0, Math.PI * 2);
      ctx.fillStyle = r.color;
      ctx.fill();
      ctx.lineWidth = r.self ? 3.5 : 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer);
    this.root.remove();
  }
}

/** One row on the finish screen. */
export interface PlayerResult {
  who: RosterEntry;
  lapTimes: readonly number[];
  total: number;
  best: number | null;
}

/** Which title-screen button is selected. */
export type TitleChoice = 1 | 2 | "online" | "tv";

/** Escape text before putting it into innerHTML (player names come from other people!). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** What the select screen needs to draw. */
export interface SelectView {
  cursors: readonly number[]; // roster index each player is pointing at
  picked: ReadonlyArray<number | null>; // roster index each player locked in
  hints: readonly string[];
}

export class Screens {
  private readonly countdown = byId("countdown");
  private readonly title = byId("titleScreen");
  private readonly select = byId("selectScreen");
  private readonly finish = byId("finishScreen");
  /** Every full-screen overlay (title, select, finish, online, lobby). */
  private readonly allScreens = Array.from(document.querySelectorAll<HTMLElement>(".screen"));
  private readonly cards: HTMLButtonElement[] = [];

  constructor(onCardClick: (rosterIndex: number) => void, onModeClick: (choice: TitleChoice) => void) {
    const holder = byId("selectCards");
    ROSTER.forEach((who, i) => {
      const card = document.createElement("button");
      card.className = "char-card";
      card.style.setProperty("--walker", who.walkerColor);
      card.style.setProperty("--trim", who.walkerTrim);
      card.innerHTML = `<div class="badges"></div>${portraitHTML(who, 110)}<div class="char-name">${who.name}</div><div class="char-tag">${who.tagline}</div><div class="swatch"><span></span><span></span></div>`;
      card.addEventListener("click", () => onCardClick(i));
      holder.appendChild(card);
      this.cards.push(card);
    });
    byId("mode1").addEventListener("click", () => onModeClick(1));
    byId("mode2").addEventListener("click", () => onModeClick(2));
    byId("mode3").addEventListener("click", () => onModeClick("online"));
    byId("mode4")?.addEventListener("click", () => onModeClick("tv"));
  }

  /** Show exactly one screen (or none). */
  only(el: HTMLElement | null): void {
    const current = this.allScreens.find((s) => !s.classList.contains("hidden")) ?? null;
    if (current !== el) Screens.transition();
    for (const s of this.allScreens) s.classList.toggle("hidden", s !== el);
  }

  showTitle(choice: TitleChoice): void {
    this.only(this.title);
    this.setTitleMode(choice);
  }

  setTitleMode(choice: TitleChoice): void {
    byId("mode1").classList.toggle("selected", choice === 1);
    byId("mode2").classList.toggle("selected", choice === 2);
    byId("mode3").classList.toggle("selected", choice === "online");
    byId("mode4")?.classList.toggle("selected", choice === "tv");
  }

  showSelect(view: SelectView): void {
    this.only(this.select);
    this.renderSelect(view);
  }

  renderSelect(view: SelectView): void {
    this.cards.forEach((card, i) => {
      const badges: string[] = [];
      view.cursors.forEach((c, p) => {
        if (c === i) badges.push(`<span class="badge p${p + 1} ${view.picked[p] === i ? "locked" : ""}">P${p + 1}${view.picked[p] === i ? " ✓" : ""}</span>`);
      });
      card.querySelector(".badges")!.innerHTML = view.cursors.length > 1 ? badges.join("") : "";
      card.classList.toggle("hover", view.cursors.includes(i));
      card.classList.toggle("taken", view.picked.includes(i));
    });
    byId("selectHint").innerHTML = view.hints.map((h) => `<div>${h}</div>`).join("");
  }

  hideAll(): void {
    this.only(null);
  }

  /** Play the candy-stripe wipe across the whole screen (menus ↔ race ↔ results). */
  static transition(): void {
    const wipe = document.getElementById("wipe");
    if (!wipe) return;
    wipe.classList.remove("run");
    void wipe.offsetWidth; // restart the CSS animation
    wipe.classList.add("run");
  }

  setCountdown(text: string | null): void {
    if (text === null) {
      this.countdown.classList.add("hidden");
      return;
    }
    this.countdown.classList.remove("hidden", "pop");
    this.countdown.classList.toggle("go", text === "GO!");
    // Toy traffic lights: 3 → one red, 2 → two red, 1 → three red, GO! → all green.
    const n = text === "GO!" ? 3 : Math.max(0, 4 - Number(text));
    const lamp = (i: number): string => `<span class="cd-lamp ${text === "GO!" ? "green" : i < n ? "red" : ""}"></span>`;
    this.countdown.innerHTML = `<div class="cd-lights">${lamp(0)}${lamp(1)}${lamp(2)}</div><div class="cd-num">${escapeHtml(text)}</div>`;
    void this.countdown.offsetWidth; // restart the CSS animation
    this.countdown.classList.add("pop");
  }

  private setFinishButtons(online: boolean): void {
    byId("restartBtn").textContent = online ? "BACK TO LOBBY" : "RACE AGAIN";
    byId("menuBtn").textContent = online ? "LEAVE ROOM" : "MENU";
    byId("finishHint").textContent = online ? "Enter = back to lobby · Esc = leave room" : "Enter = race again · Esc = menu";
  }

  /** Online finish screen: everyone in the room, ranked by the server. */
  showOnlineResults(rows: readonly ResultRow[], you: string): void {
    this.only(this.finish);
    this.setFinishButtons(true);
    const who = (r: ResultRow): RosterEntry => ROSTER.find((x) => x.id === r.character) ?? ROSTER[0];
    const winner = rows[0];
    const youRow = rows.find((r) => r.id === you);
    byId("finishTitle").textContent = !winner || winner.place === null ? "Race over!" : winner.id === you ? "You win!" : `${winner.name} wins!`;
    byId("finishPortrait").innerHTML = winner ? portraitHTML(who(winner), 96) : "";
    const ms = (v: number | null): string => formatTime(v === null ? null : v / 1000);
    byId("resultList").innerHTML =
      rows
        .map(
          (r, i) =>
            `<div class="res-row ${i === 0 && r.place !== null ? "best" : ""} ${r.id === you ? "you" : ""}"><span>${r.place ?? "DNF"}. ${escapeHtml(r.name)} <small>(${who(r).name})</small></span><span>${r.place !== null ? ms(r.timeMs) : `${r.laps}/${TOTAL_LAPS} laps`} · best ${ms(r.bestLapMs)}</span></div>`,
        )
        .join("") + (youRow && youRow.place === null ? `<div class="res-note">Out of time! Others had 45 s after the winner.</div>` : "");
  }

  showTvResults(rows: readonly ResultRow[]): void {
    this.only(byId("tvResultsScreen"));
    const who = (r: ResultRow): RosterEntry => ROSTER.find((x) => x.id === r.character) ?? ROSTER[0];
    const winner = rows.find((r) => r.place === 1) ?? rows[0];
    byId("tvResultsTitle").textContent = !winner || winner.place === null ? "Race over!" : `${winner.name} wins!`;
    byId("tvResultsPortrait").innerHTML = winner ? portraitHTML(who(winner), 140) : "";
    const ms = (v: number | null): string => formatTime(v === null ? null : v / 1000);
    byId("tvResultsList").innerHTML = rows
      .map((r, i) => {
        const place = r.place ?? "DNF";
        const time = r.place !== null ? ms(r.timeMs) : `${r.laps}/${TOTAL_LAPS} laps`;
        return `<div class="tv-podium-row ${i === 0 && r.place !== null ? "winner" : ""}"><span class="tv-place">${place}</span>${portraitHTML(who(r), 72)}<span class="tv-who">${escapeHtml(r.name)}<small>${who(r).name}</small></span><span class="tv-time">${time}</span></div>`;
      })
      .join("");
  }

  showFinish(results: readonly PlayerResult[]): void {
    this.only(this.finish);
    this.setFinishButtons(false);
    const sorted = [...results].sort((a, b) => a.total - b.total);
    const winner = sorted[0];
    byId("finishTitle").textContent = results.length > 1 ? `${winner.who.name} wins!` : "Great driving!";
    byId("finishPortrait").innerHTML = portraitHTML(winner.who, 96);
    const list = byId("resultList");
    list.innerHTML = "";
    if (results.length === 1) {
      const r = winner;
      list.innerHTML =
        `<div class="res-total">${r.who.name} — ${formatTime(r.total)}</div>` +
        r.lapTimes.map((t, i) => `<div class="res-row ${t === r.best ? "best" : ""}">Lap ${i + 1} <span>${formatTime(t)}</span></div>`).join("");
    } else {
      list.innerHTML = sorted
        .map((r, i) => `<div class="res-row ${i === 0 ? "best" : ""}">${i + 1}. ${r.who.name} <span>${formatTime(r.total)} · best ${formatTime(r.best)}</span></div>`)
        .join("");
    }
  }
}
