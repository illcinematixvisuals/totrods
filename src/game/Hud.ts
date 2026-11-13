/**
 * Hud.ts — the HTML overlay.
 *
 *  - PlayerHud: one per player (portrait, name, speed, lap, times, effect tint).
 *    Cloned from <template id="hudTemplate"> and positioned over that player's
 *    viewport, so split-screen gets one HUD per half.
 *  - Screens: the shared title, character select, countdown and finish screens
 *    (the online lobby screens live in src/net/OnlineSession.ts).
 *  - portraitHTML(): a little CSS-drawn face for any roster entry.
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

/** A CSS portrait: face circle in the skin tone, hair, eyes, smile, accessory. */
export function portraitHTML(who: RosterEntry, size = 64): string {
  const sleepy = who.accessory === "nightcap" ? " sleepy" : "";
  return `<div class="portrait hair-${who.hairStyle} acc-${who.accessory}${sleepy}" style="--skin:${who.skinTone};--hair:${who.hairColor};--accent:${who.accentColor};--size:${size}px">
    <div class="p-puff l"></div><div class="p-puff r"></div>
    <div class="p-head"><div class="p-hair"></div><i class="p-eye l"></i><i class="p-eye r"></i><i class="p-cheek l"></i><i class="p-cheek r"></i><i class="p-smile"></i></div>
    <div class="p-acc"></div>
  </div>`;
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
    const bar = this.el("effectBar");
    bar.style.transform = `scaleX(${f.effect ? f.effectLeft01 : 0})`;
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

  setCountdown(text: string | null): void {
    if (text === null) {
      this.countdown.classList.add("hidden");
      return;
    }
    this.countdown.classList.remove("hidden", "pop");
    this.countdown.classList.toggle("go", text === "GO!");
    this.countdown.textContent = text;
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
