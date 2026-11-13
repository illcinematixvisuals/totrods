/**
 * TvSession.ts — the TV / host side of TV Party mode.
 *
 * Architecture (host-authoritative):
 *  - This page is the one "real" game: it simulates every walker, pickups,
 *    collisions and laps, and draws a split-screen view for each player
 *    (1 full screen, 2 side-by-side, 3 = one wide on top + two below,
 *    4 = 2×2, 5–6 = 3×2). Sound plays only here.
 *  - Each phone is just a controller. The server relays their input to us
 *    (`controller_input`) and we relay lap / place / boost status back
 *    (`tv_state_to_controller`). If a phone drops, its walker coasts to a
 *    stop and the seat is held for ~30 s.
 *
 * Flow: open this page (or ?tv=1) → create a room → lobby with a huge code
 * and QR → phones join → Start → countdown → race → results → Race again
 * (same players, back to lobby) or New game (back to the title screen).
 */
import { PROTOCOL_VERSION, TOTAL_LAPS, FINISH_TIMEOUT_MS, type CharacterId, type ResultRow, type ServerMessage, type TvHudFrame, type TvPhase, type TvPlayerInfo, type TvRoomSnapshot } from "../../shared/protocol";
import type { Game } from "../game/Game";
import { bumpCircles } from "../game/Collisions";
import { byId, escapeHtml, portraitHTML } from "../game/Hud";
import { Keyboard, RemoteInput } from "../game/Input";
import { PICKUP_TUNING } from "../game/Pickups";
import { Player, type PlayerConfig } from "../game/Player";
import { character } from "../game/Roster";
import { START_INDEX, laneOffset, layoutTvViewports } from "../game/StartGrid";
import { resolveServerUrl } from "../net/serverUrl";
import { drawJoinQr, joinUrlFor } from "./qr";
import { TvNet } from "./TvNet";

const TV_SESSION_KEY = "totrods-tv-session";
const COUNTDOWN_SECONDS = 3;
const HUD_SEND_HZ = 10;
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export class TvSession {
  net: TvNet | null = null;
  room: TvRoomSnapshot | null = null;
  you = "";
  private readonly remotes = new Map<string, RemoteInput>();
  private phase: TvPhase = "lobby";
  private countdownLeft = 0;
  private lastCountdownShown = -1;
  private hudAcc = 0;
  private firstFinishAt: number | null = null;
  private raceClock = 0;
  private buzz = new Map<string, "pickup" | "bump" | null>();
  private unsub: (() => void) | null = null;
  private keyUnsub: Array<() => void> = [];
  private lastJoinUrl = "";

  constructor(private readonly game: Game) {
    this.bindDom();
    this.bindKeys();
  }

  /** Title screen / ?tv=1: connect and create (or resume) a TV room. */
  async open(): Promise<void> {
    this.game.sound.init();
    document.body.classList.add("tv-mode");
    this.game.showMenuScene();
    this.game.screens.only(byId("tvLobbyScreen"));
    byId("tvLobbyStatus").textContent = "Connecting…";
    const url = resolveServerUrl();
    this.teardownNet();
    this.net = new TvNet(url, TV_SESSION_KEY, "tv_resume");
    const saved = TvNet.saved(TV_SESSION_KEY);
    if (saved?.role === "tv") this.net.session = saved;
    this.net.onStatus = (s) => {
      if (s === "reconnecting") byId("tvLobbyStatus").textContent = "Reconnecting…";
      if (s === "closed" && this.phase === "lobby") byId("tvLobbyStatus").textContent = "Lost the server connection.";
    };
    this.unsub = this.net.on((msg) => this.onMessage(msg));
    try {
      await this.net.connect();
    } catch (err) {
      byId("tvLobbyStatus").textContent = err instanceof Error ? err.message : "Could not connect.";
      return;
    }
    // A saved seat is resumed automatically by TvNet; otherwise create a room.
    if (!this.net.session) this.net.send({ type: "tv_create", version: PROTOCOL_VERSION });
  }

  /** Page reload: go back into the TV room if we still have a seat. */
  resumeSaved(): boolean {
    const saved = TvNet.saved(TV_SESSION_KEY);
    if (!saved || saved.role !== "tv") return false;
    void this.open();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Frame update (called from Game while state === "tvparty")
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    if (this.phase === "lobby") {
      this.game.showcase.update(dt, "orbit");
      this.game.pickups.update(dt, []);
      return;
    }
    if (this.phase === "results") {
      for (const p of this.game.players) p.updateIdle(dt);
      this.game.pickups.update(dt, []);
      return;
    }
    if (this.phase === "countdown") this.updateCountdown(dt);
    else if (this.phase === "racing") this.updateRace(dt);

    this.game.players.forEach((p, i) => {
      this.game.sound.updateRoll(i, p.speed01, this.phase === "racing");
      p.refreshHud();
    });
    this.hudAcc += dt;
    if (this.hudAcc >= 1 / HUD_SEND_HZ) {
      this.hudAcc = 0;
      this.pushHud();
    }
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "tv_welcome":
        if (msg.role !== "tv") return;
        this.you = msg.you;
        this.applyRoom(msg.room);
        if (msg.room.phase !== "lobby") {
          // We reloaded mid-race: the simulation is gone, so wait in the lobby.
          this.net?.send({ type: "tv_back_to_lobby" });
        }
        break;
      case "tv_room":
        this.applyRoom(msg.room);
        break;
      case "tv_start":
        this.beginRace(msg.grid);
        break;
      case "controller_input": {
        const remote = this.remotes.get(msg.id);
        if (!remote) return;
        const i = msg.input;
        remote.apply(i.steer, i.throttle, i.brake, i.drift, i.reset);
        break;
      }
      case "error":
        if (this.phase === "lobby") {
          const el = byId("tvLobbyStatus");
          el.textContent = msg.message;
          el.classList.add("error");
        }
        break;
      default:
        break;
    }
  }

  private applyRoom(room: TvRoomSnapshot): void {
    this.room = room;
    // Coast walkers whose phones dropped; if they come back, inputs resume.
    for (const p of room.players) {
      const remote = this.remotes.get(p.id);
      if (!remote) continue;
      if (!p.connected) remote.coast();
    }
    if (this.phase === "lobby" || room.phase === "lobby") this.renderLobby(room);
  }

  requestStart(): void {
    this.net?.send({ type: "tv_start" });
  }

  backToLobby(): void {
    this.stopRaceVisuals();
    this.phase = "lobby";
    this.net?.send({ type: "tv_back_to_lobby" });
    this.game.showMenuScene();
    this.game.screens.only(byId("tvLobbyScreen"));
    if (this.room) this.renderLobby(this.room);
    this.pushHud();
  }

  /** New Game: leave the room and return to the title screen. */
  leave(): void {
    this.stopRaceVisuals();
    this.teardownNet();
    document.body.classList.remove("tv-mode");
    this.room = null;
    this.phase = "lobby";
    this.game.resetViewportBudget();
    this.game.backToTitle();
  }

  // ---------------------------------------------------------------------------
  // Lobby UI
  // ---------------------------------------------------------------------------

  private async renderLobby(room: TvRoomSnapshot): Promise<void> {
    byId("tvRoomCode").textContent = room.code;
    const url = joinUrlFor(room.code);
    byId("tvJoinUrl").textContent = url;
    if (url !== this.lastJoinUrl) {
      this.lastJoinUrl = url;
      try {
        await drawJoinQr(byId<HTMLCanvasElement>("tvQr"), url);
      } catch (err) {
        console.warn("QR code failed", err);
      }
    }
    const racers = room.players.filter((p) => !p.queued);
    const queued = room.players.filter((p) => p.queued);
    const seats: string[] = racers.map((p) => this.seatHtml(p));
    // Empty slots so the lobby always shows how many can still join.
    for (let i = racers.length; i < 6; i++) {
      seats.push(`<div class="tv-seat"><div class="lp-empty"></div><div class="tv-seat-name">Open</div><div class="tv-seat-char">scan the QR</div></div>`);
    }
    if (queued.length) {
      seats.push(...queued.map((p) => this.seatHtml(p)));
    }
    byId("tvPlayerList").innerHTML = seats.join("");
    const status = byId("tvLobbyStatus");
    status.classList.remove("error");
    const ready = racers.filter((p) => p.ready && p.character).length;
    if (!room.tvConnected) status.textContent = "TV reconnecting…";
    else if (racers.length === 0) status.textContent = "Waiting for players…";
    else if (racers.some((p) => !p.connected)) status.textContent = "Waiting for a player to reconnect…";
    else if (racers.some((p) => !p.character || !p.ready)) status.textContent = `${ready}/${racers.length} ready — everyone pick a toddler and tap Ready`;
    else status.textContent = `All ${racers.length} ready — press Start!`;
    byId<HTMLButtonElement>("tvStartBtn").disabled = racers.length < 1 || racers.some((p) => !p.ready || !p.character || !p.connected);
  }

  private seatHtml(p: TvPlayerInfo): string {
    const who = p.character ? character(p.character) : null;
    const flag = p.queued ? "NEXT RACE" : p.ready ? "READY" : "…";
    return `<div class="tv-seat ${p.ready ? "ready" : ""} ${p.connected ? "" : "away"} ${p.queued ? "queued" : ""}" style="--walker:${who?.walkerColor ?? "#c9d3e3"}">
      ${who ? portraitHTML(who, 88) : `<div class="lp-empty"></div>`}
      <div class="tv-seat-name">${escapeHtml(p.name)}${p.host ? " 👑" : ""}</div>
      <div class="tv-seat-char">${who ? who.name : "picking…"}</div>
      <div class="tv-seat-flag ${p.ready && !p.queued ? "on" : ""}">${p.connected ? flag : "away"}</div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Race
  // ---------------------------------------------------------------------------

  private beginRace(grid: string[]): void {
    if (!this.room) return;
    const byIdMap = new Map(this.room.players.map((p) => [p.id, p]));
    const racers = grid.map((id) => byIdMap.get(id)).filter((p): p is TvPlayerInfo => !!p && !!p.character && !p.queued);
    if (racers.length === 0) return;

    this.remotes.clear();
    this.buzz.clear();
    const configs: PlayerConfig[] = racers.map((p) => {
      const remote = new RemoteInput();
      this.remotes.set(p.id, remote);
      return {
        id: p.id,
        label: p.name,
        character: character(p.character as CharacterId),
        input: remote,
        showPlace: true,
      };
    });
    this.game.createPlayers(configs);
    this.game.showcase.setVisible(false);
    this.game.screens.hideAll();
    this.game.applyViewportBudget(configs.length);
    const n = this.game.players.length;
    const rects = layoutTvViewports(n);
    this.game.players.forEach((p, i) => {
      p.timer.reset(START_INDEX);
      p.placeOnTrack(START_INDEX, laneOffset(i, n));
      p.rig.intro = 1;
      p.rig.snap();
      p.setViewport(rects[i]);
      p.hud.setVisible(true);
      p.onResetPressed = () => {
        if (this.phase === "racing" && !p.finished) p.resetToTrack();
      };
    });
    this.game.scene.activeCameras = this.game.players.map((p) => p.rig.camera);
    this.phase = "countdown";
    this.countdownLeft = COUNTDOWN_SECONDS;
    this.lastCountdownShown = -1;
    this.firstFinishAt = null;
    this.raceClock = 0;
    this.hudAcc = 0;
    this.pushHud("3");
  }

  private updateCountdown(dt: number): void {
    this.countdownLeft -= dt;
    const shown = Math.ceil(this.countdownLeft);
    if (shown !== this.lastCountdownShown && shown > 0) {
      this.lastCountdownShown = shown;
      this.game.screens.setCountdown(String(shown));
      this.game.sound.beep(440);
      this.pushHud(String(shown));
    }
    const intro = smoothstep(Math.min(1, Math.max(0, (this.countdownLeft - 0.5) / 1.5)));
    for (const p of this.game.players) {
      p.rig.intro = intro;
      p.walker.lookAround(intro > 0.5 ? 0 : 0.6);
      p.updateIdle(dt);
    }
    if (this.countdownLeft <= 0) {
      this.phase = "racing";
      this.game.players.forEach((p) => p.timer.start());
      this.game.screens.setCountdown("GO!");
      this.game.sound.beep(880, 0.4);
      this.pushHud("GO!");
      window.setTimeout(() => this.game.screens.setCountdown(null), 800);
    }
  }

  private updateRace(dt: number): void {
    this.raceClock += dt;
    // Consume RESET taps from phones.
    for (const p of this.game.players) {
      const id = p.config.id;
      if (id && this.remotes.get(id)?.takeReset()) p.onResetPressed?.();
    }
    for (const p of this.game.players) p.updateMovement(dt);
    for (const p of this.game.players) this.game.collisions.resolve(p.walker);
    for (let i = 0; i < this.game.players.length; i++) {
      for (let j = i + 1; j < this.game.players.length; j++) {
        if (bumpCircles(this.game.players[i].walker, this.game.players[j].walker)) {
          const a = this.game.players[i].config.id;
          const b = this.game.players[j].config.id;
          if (a) this.buzz.set(a, "bump");
          if (b) this.buzz.set(b, "bump");
        }
      }
    }
    for (const p of this.game.players) this.game.collisions.resolve(p.walker);

    const collectors = this.game.players.filter((p) => !p.finished);
    for (const hit of this.game.pickups.update(dt, collectors)) {
      const p = this.game.players[hit.collector];
      p.applyPickup(hit.pickup.kind);
      if (p.config.id) this.buzz.set(p.config.id, "pickup");
      if (PICKUP_TUNING[hit.pickup.kind].effect === "boost") this.game.sound.chirp();
      else this.game.sound.napTone();
    }

    for (const p of this.game.players) {
      const ev = p.updateProgress(dt);
      if (ev?.type === "lap" || ev?.type === "finish") this.game.sound.jingle();
      if (ev?.type === "finish" && this.firstFinishAt === null) this.firstFinishAt = this.raceClock;
    }
    this.refreshPlaces();

    const allDone = this.game.players.length > 0 && this.game.players.every((p) => p.finished);
    const timedOut = this.firstFinishAt !== null && this.raceClock - this.firstFinishAt > FINISH_TIMEOUT_MS / 1000;
    if (allDone || timedOut) this.finishRace();
  }

  private refreshPlaces(): void {
    const ranked = this.game.players
      .map((p, i) => ({
        i,
        finished: p.finished,
        total: p.timer.totalTime,
        lapsDone: p.finished ? p.timer.totalLaps : p.timer.lap - 1,
        progress: p.progress,
      }))
      .sort((a, b) => {
        if (a.finished && b.finished) return a.total - b.total;
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.lapsDone !== b.lapsDone) return b.lapsDone - a.lapsDone;
        return b.progress - a.progress;
      });
    ranked.forEach((r, place) => {
      this.game.players[r.i].place = place + 1;
    });
  }

  private finishRace(): void {
    this.phase = "results";
    this.refreshPlaces();
    this.game.players.forEach((p) => p.hud.setVisible(false));
    this.game.screens.setCountdown(null);
    const rows = this.resultRows();
    this.game.screens.showTvResults(rows);
    this.pushHud(null, rows);
  }

  private resultRows(): ResultRow[] {
    return [...this.game.players]
      .sort((a, b) => (a.place ?? 99) - (b.place ?? 99))
      .map((p) => ({
        id: p.config.id ?? `p${p.index}`,
        name: p.config.label.replace(/^\s+/, ""),
        character: p.config.character.id as CharacterId,
        place: p.finished ? p.place : null,
        timeMs: p.finished ? Math.round(p.timer.totalTime * 1000) : null,
        bestLapMs: p.timer.bestLap !== null ? Math.round(p.timer.bestLap * 1000) : null,
        laps: p.timer.lapTimes.length,
      }));
  }

  private pushHud(countdown: string | null = this.phase === "countdown" ? String(Math.max(1, Math.ceil(this.countdownLeft))) : this.phase === "racing" && this.countdownLeft > -0.8 ? "GO!" : null, results?: ResultRow[]): void {
    if (!this.net) return;
    const huds: TvHudFrame[] = this.game.players.map((p) => {
      const id = p.config.id ?? "";
      const buzz = this.buzz.get(id) ?? null;
      this.buzz.set(id, null);
      const effect = p.effect?.tuning.effect ?? null;
      return {
        id,
        lap: Math.min(p.timer.lap, TOTAL_LAPS),
        place: p.place,
        speedMph: p.walker.speedMph,
        effect,
        effectText: effect === "boost" ? "BOOST!" : effect === "nap" ? "NAP TIME!" : "",
        buzz,
      };
    });
    // Queued / lobby-only players still get a phase update (empty hud).
    this.net.send({ type: "tv_state_to_controller", phase: this.phase, countdown, huds, results });
  }

  private stopRaceVisuals(): void {
    this.game.screens.setCountdown(null);
    this.game.resetViewportBudget();
    this.remotes.clear();
  }

  private teardownNet(): void {
    this.unsub?.();
    this.unsub = null;
    this.net?.close();
    this.net = null;
    this.lastJoinUrl = "";
  }

  // ---------------------------------------------------------------------------
  // DOM + keys
  // ---------------------------------------------------------------------------

  private bindDom(): void {
    byId("tvStartBtn").addEventListener("click", () => this.requestStart());
    byId("tvLobbyBackBtn").addEventListener("click", () => this.leave());
    byId("tvAgainBtn").addEventListener("click", () => this.backToLobby());
    byId("tvNewBtn").addEventListener("click", () => this.leave());
  }

  private bindKeys(): void {
    const kb = Keyboard.get();
    this.keyUnsub.push(
      kb.onPress(["Enter", "Space"], () => {
        if (this.gameIsActive() && this.phase === "lobby") this.requestStart();
        else if (this.gameIsActive() && this.phase === "results") this.backToLobby();
      }),
      kb.onPress("Escape", () => {
        if (!this.gameIsActive()) return;
        if (this.phase === "results" || this.phase === "lobby") this.leave();
        else this.backToLobby();
      }),
    );
  }

  private gameIsActive(): boolean {
    return document.body.classList.contains("tv-mode") && this.net !== null;
  }

  // ---------------------------------------------------------------------------
  // Debug (tests and the browser console)
  // ---------------------------------------------------------------------------

  debugInfo(): object {
    return {
      phase: this.phase,
      code: this.room?.code ?? null,
      joinUrl: this.room ? joinUrlFor(this.room.code) : null,
      origin: window.location.origin,
      tvConnected: this.room?.tvConnected ?? false,
      players: this.game.players.map((p) => ({
        id: p.config.id,
        name: p.config.label,
        character: p.config.character.name,
        x: Math.round(p.walker.position.x * 10) / 10,
        z: Math.round(p.walker.position.z * 10) / 10,
        speedMph: Math.round(p.walker.speedMph * 10) / 10,
        lap: p.timer.lap,
        place: p.place,
        effect: p.effect?.kind ?? null,
        progress: p.progress,
        finished: p.finished,
        suggestedSteer: this.suggestedSteer(p),
      })),
      lobby: this.room?.players ?? [],
    };
  }

  /** Steering hint for the e2e autopilot: aim a little ahead along the racing line. */
  suggestedSteer(p: Player): number {
    const n = this.game.track.sampleCount;
    // Aim well ahead along the racing line so the bot can take corners.
    const t = this.game.track.samples[(p.progress + 22) % n];
    const w = p.walker;
    let diff = Math.atan2(t.x - w.position.x, t.z - w.position.z) - w.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    return Math.max(-1, Math.min(1, diff / 0.35));
  }
}
