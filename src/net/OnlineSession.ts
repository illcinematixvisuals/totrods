/**
 * OnlineSession.ts — everything about online rooms on the client:
 *
 *   online menu (create / join) → lobby → countdown → race → results → lobby …
 *
 * Who decides what (AUTHORITY):
 *   - YOU decide where your own walker is: we simulate it right here every
 *     frame, so steering feels instant, and report it ~20×/s.
 *   - The SERVER decides everything that must be fair and the same for all:
 *     room membership, toddler picks, when the race starts, laps, finish order
 *     and pickups (if two players touch a bottle, the server's first-come
 *     answer is final).
 *   - OTHER players' walkers are RemotePlayers: drawn ~100 ms in the past and
 *     smoothly interpolated between their snapshots.
 *
 * Local 1P / 2P never touches this file: Game hands control over only when
 * you pick "Online" on the title screen.
 */
import { Viewport } from "@babylonjs/core";
import {
  INTERPOLATION_DELAY_MS,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  PROTOCOL_VERSION,
  STATE_SEND_HZ,
  TOTAL_LAPS,
  cleanName,
  normalizeRoomCode,
  type CharacterId,
  type RaceInfo,
  type ResultRow,
  type RoomSnapshot,
  type ServerMessage,
  type WalkerState,
} from "../../shared/protocol";
import { bumpAgainst } from "../game/Collisions";
import type { Game } from "../game/Game";
import { byId, escapeHtml, portraitHTML } from "../game/Hud";
import { Keyboard, SOLO_KEYS } from "../game/Input";
import { PICKUP_TUNING } from "../game/Pickups";
import { Player } from "../game/Player";
import { ROSTER, type RosterEntry } from "../game/Roster";
import { START_INDEX, laneOffset } from "../game/StartGrid";
import { NetClient, type NetStatus } from "./NetClient";
import { RemotePlayer } from "./RemotePlayer";
import { resolveServerUrl } from "./serverUrl";

type Phase = "menu" | "connecting" | "lobby" | "countdown" | "racing" | "results";

const NAME_KEY = "totrods-name";
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

function rosterFor(id: CharacterId | null): RosterEntry {
  return ROSTER.find((r) => r.id === id) ?? ROSTER[0];
}

export class OnlineSession {
  /** True while online mode owns the screen (Game checks this). */
  active = false;
  phase: Phase = "menu";
  net: NetClient | null = null;
  you = "";
  room: RoomSnapshot | null = null;
  local: Player | null = null;
  readonly remotes = new Map<string, RemotePlayer>();
  results: ResultRow[] | null = null;
  lastError = "";

  private raceId = 0;
  private startAt = 0;
  private lastCountdownShown = -1;
  private sendTimer = 0;
  private readonly pendingClaims = new Set<number>();
  private readonly cleanup: Array<() => void> = [];
  private readonly keyboard = Keyboard.get();

  constructor(private readonly game: Game) {
    this.bindDom();
  }

  // ---------------------------------------------------------------------------
  // Entering / leaving online mode
  // ---------------------------------------------------------------------------

  /** Title screen → "Online". */
  open(prefillCode = ""): void {
    this.active = true;
    this.phase = "menu";
    this.game.showMenuScene();
    const name = byId<HTMLInputElement>("onlineName");
    name.value = localStorage.getItem(NAME_KEY) ?? "";
    if (prefillCode) byId<HTMLInputElement>("joinCode").value = normalizeRoomCode(prefillCode);
    byId("serverUrlLabel").textContent = resolveServerUrl();
    this.setStatus("onlineStatus", "");
    this.game.screens.only(byId("onlineScreen"));
    window.setTimeout(() => (name.value ? byId<HTMLInputElement>("joinCode") : name).focus(), 50);
  }

  /** Page reload while in a room: try to get our seat back. */
  resumeSaved(): boolean {
    const saved = NetClient.savedSession();
    if (!saved) return false;
    this.open();
    this.connect((net) => {
      net.session = saved;
    });
    return true;
  }

  /** Leave the room and go back to the title screen. */
  leave(): void {
    this.dropNet();
    this.disposeRace();
    this.room = null;
    this.results = null;
    this.active = false;
    this.phase = "menu";
    byId("netBanner").classList.add("hidden");
    this.game.pickups.resetAll();
    this.game.backToTitle();
  }

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  /** Close the connection on purpose (without triggering "connection lost" handling). */
  private dropNet(): void {
    if (!this.net) return;
    this.net.onStatus = () => {};
    this.net.close();
    this.net = null;
  }

  private playerName(): string {
    const name = cleanName(byId<HTMLInputElement>("onlineName").value);
    localStorage.setItem(NAME_KEY, name);
    return name;
  }

  /** Open a WebSocket, then run `then` (send create / join, or set up a resume). */
  private connect(before: (net: NetClient) => void, after?: (net: NetClient) => void): void {
    if (this.phase === "connecting") return;
    this.dropNet();
    const net = new NetClient(resolveServerUrl());
    this.net = net;
    this.phase = "connecting";
    this.setStatus("onlineStatus", "Connecting…");
    net.onStatus = (s) => this.onNetStatus(s);
    net.on((msg) => this.onMessage(msg));
    before(net);
    net
      .connect()
      .then(() => after?.(net))
      .catch((err: Error) => {
        if (this.net !== net) return;
        this.net = null;
        this.phase = "menu";
        this.setStatus("onlineStatus", `${err.message}. Is the server running (npm run server)?`, true);
      });
  }

  private createRoom(): void {
    const name = this.playerName();
    this.connect(
      () => {},
      (net) => net.send({ type: "create", name, version: PROTOCOL_VERSION }),
    );
  }

  private joinRoom(): void {
    const code = normalizeRoomCode(byId<HTMLInputElement>("joinCode").value);
    if (code.length < 4) {
      this.setStatus("onlineStatus", "Type the 4-letter room code first.", true);
      return;
    }
    const name = this.playerName();
    this.connect(
      () => {},
      (net) => net.send({ type: "join", code, name, version: PROTOCOL_VERSION }),
    );
  }

  private onNetStatus(s: NetStatus): void {
    const banner = byId("netBanner");
    if (s === "reconnecting" && this.room) {
      banner.textContent = "Connection lost, reconnecting…";
      banner.classList.remove("hidden");
    } else if (s === "open") {
      banner.classList.add("hidden");
    } else if (s === "closed" && this.active && this.room) {
      // Gave up reconnecting: back to the online menu.
      banner.classList.add("hidden");
      this.net = null;
      this.disposeRace();
      this.room = null;
      this.open();
      this.setStatus("onlineStatus", "Lost the connection to the room.", true);
    } else if (s === "closed" && this.active && this.phase === "connecting") {
      // Never got in (server not running, wrong address, or it went away while rejoining).
      const url = this.net?.url ?? resolveServerUrl();
      this.net = null;
      this.phase = "menu";
      this.setStatus("onlineStatus", `Can't reach the game server at ${url}. Is it running (npm run server)?`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Messages from the server
  // ---------------------------------------------------------------------------

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome": {
        this.you = msg.you;
        this.room = msg.room;
        const race = msg.room.race;
        if (msg.room.phase === "racing" && race && race.progress.some((p) => p.id === this.you)) {
          if (this.local && this.raceId === race.raceId) this.syncPickups(race); // reconnected mid-race: just carry on
          else this.buildRace(race, true); // page reload mid-race: rebuild from the server's memory
        } else if (this.phase !== "results") {
          this.showLobby();
        }
        return;
      }
      case "room":
        this.room = msg.room;
        for (const [id, remote] of this.remotes) {
          const info = msg.room.players.find((p) => p.id === id);
          if (!info) {
            remote.dispose(); // left for good
            this.remotes.delete(id);
          } else remote.setConnected(info);
        }
        if (this.phase === "lobby") this.renderLobby();
        return;
      case "error":
        this.lastError = msg.message;
        if (msg.code === "expired" || (this.phase === "connecting" && !this.room)) {
          // Couldn't get in: close the socket and show the reason on the online menu.
          this.dropNet();
          this.room = null;
          this.phase = "menu";
          if (msg.code === "expired") this.open();
          this.setStatus("onlineStatus", msg.message, true);
        } else this.setStatus("lobbyStatus", msg.message, true);
        return;
      case "raceStart":
        this.buildRace(msg.race, false);
        return;
      case "state":
        this.remotes.get(msg.id)?.push(msg.t, msg.state);
        return;
      case "pickupTaken": {
        this.game.pickups.take(msg.id);
        this.pendingClaims.delete(msg.id);
        if (msg.by === this.you && this.local) {
          // The server confirmed it: NOW the boost (or nap) happens.
          const kind = this.game.pickups.items[msg.id].kind;
          this.local.applyPickup(kind);
          if (PICKUP_TUNING[kind].effect === "boost") this.game.sound.chirp();
          else this.game.sound.napTone();
        }
        return;
      }
      case "pickupRespawn":
        this.game.pickups.restore(msg.id);
        return;
      case "lap":
        return; // our own HUD already flashed the lap; others' laps aren't shown
      case "finished":
        if (msg.id === this.you) this.local?.hud.flash(`FINISHED! #${msg.place}`, 4, "good");
        else this.local?.hud.flash(`${this.nameOf(msg.id)} finished #${msg.place}!`, 2.5, "info");
        return;
      case "results":
        this.results = msg.rows;
        this.phase = "results";
        this.local?.hud.setVisible(false);
        this.game.screens.setCountdown(null);
        this.game.screens.showOnlineResults(msg.rows, this.you);
        this.game.sound.jingle();
        return;
      default:
        return;
    }
  }

  private nameOf(id: string): string {
    return this.room?.players.find((p) => p.id === id)?.name ?? "Someone";
  }

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------

  private showLobby(): void {
    this.disposeRace();
    this.phase = "lobby";
    this.results = null;
    this.game.showMenuScene();
    this.setStatus("lobbyStatus", "");
    this.game.screens.only(byId("lobbyScreen"));
    this.renderLobby();
  }

  private me() {
    return this.room?.players.find((p) => p.id === this.you) ?? null;
  }

  /** Mirror of the server's start rules, so the host sees why START is greyed out. */
  private whyCantStart(): string | null {
    const players = this.room?.players ?? [];
    if (players.length < MIN_PLAYERS_TO_START) return `Waiting for friends to join (need ${MIN_PLAYERS_TO_START}).`;
    if (players.some((p) => !p.connected)) return "Waiting for a player to reconnect…";
    if (players.some((p) => !p.character)) return "Everyone needs to pick a toddler.";
    if (players.some((p) => !p.ready)) return "Waiting for everyone to press READY.";
    return null;
  }

  private renderLobby(): void {
    const room = this.room;
    if (!room) return;
    const me = this.me();
    const isHost = room.hostId === this.you;
    byId("lobbyCode").textContent = room.code;
    byId("lobbyLink").textContent = `${location.origin}${location.pathname}?room=${room.code}`;

    const rows = room.players.map((p) => {
      const who = p.character ? rosterFor(p.character) : null;
      return `<div class="lobby-player ${p.id === this.you ? "me" : ""} ${p.connected ? "" : "away"}" style="${who ? `--walker:${who.walkerColor}` : ""}">
        ${who ? portraitHTML(who, 44) : `<div class="lp-empty"></div>`}
        <div class="lp-name">${room.hostId === p.id ? "👑 " : ""}${escapeHtml(p.name)}${p.id === this.you ? " (you)" : ""}<br><small>${who ? who.name : "choosing…"}${p.connected ? "" : " · reconnecting"}</small></div>
        <span class="lp-ready ${p.ready ? "on" : ""}">${p.ready ? "READY" : "not ready"}</span>
      </div>`;
    });
    for (let i = room.players.length; i < MAX_PLAYERS; i++) rows.push(`<div class="lobby-player away"><div class="lp-empty"></div><div class="lp-name"><small>Waiting for a friend…</small></div></div>`);
    byId("lobbyPlayers").innerHTML = rows.join("");

    const cards = byId("lobbyCards");
    cards.innerHTML = "";
    ROSTER.forEach((who) => {
      const owner = room.players.find((p) => p.character === who.id);
      const mine = owner?.id === this.you;
      const btn = document.createElement("button");
      btn.className = `lobby-pick ${mine ? "mine" : ""} ${owner && !mine ? "taken" : ""}`;
      btn.style.setProperty("--walker", who.walkerColor);
      btn.innerHTML = `${portraitHTML(who, 64)}<div>${who.name}</div><small>${mine ? "yours!" : owner ? escapeHtml(owner.name) : ""}</small>`;
      btn.addEventListener("click", () => this.pick(mine ? null : (who.id as CharacterId)));
      cards.appendChild(btn);
    });

    const ready = byId<HTMLButtonElement>("readyBtn");
    ready.disabled = !me?.character;
    ready.textContent = me?.ready ? "READY ✓" : "READY";
    ready.classList.toggle("ready-on", !!me?.ready);
    const start = byId<HTMLButtonElement>("startBtn");
    start.classList.toggle("hidden", !isHost);
    const why = this.whyCantStart();
    start.disabled = why !== null;
    if (!byId("lobbyStatus").classList.contains("error")) {
      this.setStatus("lobbyStatus", why ?? (isHost ? "Everyone's ready. Press START RACE!" : "Waiting for the host to start…"));
    }
    // The 3D toddlers behind the lobby bounce if somebody picked them.
    this.game.showcase.highlighted = room.players.map((p) => ROSTER.findIndex((r) => r.id === p.character)).filter((i) => i >= 0);
  }

  private pick(character: CharacterId | null): void {
    this.setStatus("lobbyStatus", "");
    this.net?.send({ type: "pick", character });
  }

  /** ← / → in the lobby: move to the next free toddler. */
  private cyclePick(dir: number): void {
    const room = this.room;
    if (!room || this.phase !== "lobby") return;
    const taken = new Set(room.players.filter((p) => p.id !== this.you).map((p) => p.character));
    const current = ROSTER.findIndex((r) => r.id === this.me()?.character);
    for (let step = 1; step <= ROSTER.length; step++) {
      const i = (((current < 0 ? (dir > 0 ? -1 : 0) : current) + dir * step) % ROSTER.length + ROSTER.length) % ROSTER.length;
      if (!taken.has(ROSTER[i].id as CharacterId)) return this.pick(ROSTER[i].id as CharacterId);
    }
  }

  private toggleReady(): void {
    const me = this.me();
    if (this.phase !== "lobby" || !me?.character) return;
    this.setStatus("lobbyStatus", "");
    this.net?.send({ type: "ready", ready: !me.ready });
  }

  // ---------------------------------------------------------------------------
  // Race
  // ---------------------------------------------------------------------------

  private buildRace(race: RaceInfo, rejoin: boolean): void {
    const room = this.room;
    const net = this.net;
    if (!room || !net) return;
    this.disposeRace();
    (document.activeElement as HTMLElement | null)?.blur?.(); // so Space doesn't "click" a lobby button
    this.raceId = race.raceId;
    this.startAt = race.startAt;
    this.results = null;
    this.lastCountdownShown = -1;
    const game = this.game;
    game.showcase.setVisible(false);
    game.screens.only(null);
    game.pickups.autoRespawn = false;
    this.syncPickups(race);

    const n = race.grid.length;
    race.grid.forEach((id, slot) => {
      const info = room.players.find((p) => p.id === id);
      if (!info) return;
      const who = rosterFor(info.character);
      const lane = laneOffset(slot, n);
      if (id === this.you) {
        const p = new Player(0, { label: info.name.toUpperCase(), character: who, keys: SOLO_KEYS, touch: true }, game.scene, game.shadows, game.track, TOTAL_LAPS);
        p.onResetPressed = () => {
          if (this.phase === "racing" && !p.finished) p.resetToTrack();
        };
        p.timer.reset(START_INDEX);
        p.placeOnTrack(START_INDEX, lane);
        p.rig.camera.viewport = new Viewport(0, 0, 1, 1);
        p.hud.setRect({ x: 0, y: 0, width: 1, height: 1 });
        p.hud.setVisible(true);
        this.local = p;
      } else {
        const r = new RemotePlayer(id, info.name, who, game.scene, game.shadows);
        // Until their first snapshot arrives, show them on their grid spot.
        const pose = game.track.poseAt(START_INDEX);
        const pos = pose.position.add(game.track.rightAt(START_INDEX).scale(lane));
        const start = race.lastStates[id] ?? { x: pos.x, z: pos.z, h: pose.heading, v: 0, s: 0, y: 0, look: 0, fx: null };
        r.push(net.serverNow() - 1000, start);
        r.setConnected(info);
        this.remotes.set(id, r);
      }
    });

    const local = this.local;
    if (!local) return;
    if (rejoin) {
      // Reloaded the page mid-race: put the walker back where the server last saw it.
      const last = race.lastStates[this.you];
      const prog = race.progress.find((p) => p.id === this.you);
      if (last) {
        local.walker.placeAt(local.walker.position.set(last.x, 0, last.z), last.h);
        local.progress = game.track.query(local.walker.position).index;
      }
      if (prog) local.timer.restore(prog.finishedMs !== null ? TOTAL_LAPS + 1 : prog.lap, prog.nextCheckpoint, Math.max(0, (net.serverNow() - race.startAt) / 1000), local.progress);
    }
    local.rig.intro = rejoin ? 0 : 1;
    local.rig.snap();
    game.scene.activeCameras = [local.rig.camera];
    this.phase = net.serverNow() < race.startAt ? "countdown" : "racing";
    if (this.phase === "racing" && !rejoin) local.timer.start();
  }

  /** Make our pickups match the server's list (after a reconnect or race start). */
  private syncPickups(race: RaceInfo): void {
    this.pendingClaims.clear();
    race.pickupRespawnAt.forEach((at, id) => (at === null ? this.game.pickups.restore(id) : this.game.pickups.take(id)));
  }

  private disposeRace(): void {
    this.local?.dispose();
    this.local = null;
    this.remotes.forEach((r) => r.dispose());
    this.remotes.clear();
    this.pendingClaims.clear();
    this.game.sound.trimVoices(0);
    document.getElementById("touch")?.classList.add("hidden");
  }

  // ---------------------------------------------------------------------------
  // Frame update (called by Game while online mode is active)
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    const game = this.game;
    const net = this.net;
    const local = this.local;

    if (!local || !net || this.phase === "menu" || this.phase === "connecting" || this.phase === "lobby") {
      game.showcase.update(dt, "orbit");
      game.pickups.update(dt, []);
      return;
    }

    const now = net.serverNow();
    if (this.phase === "countdown") {
      const left = (this.startAt - now) / 1000;
      const shown = Math.ceil(left);
      if (shown !== this.lastCountdownShown && shown > 0 && shown <= 3) {
        this.lastCountdownShown = shown;
        game.screens.setCountdown(String(shown));
        game.sound.beep(440);
      }
      const intro = smoothstep(Math.min(1, Math.max(0, (left - 0.5) / 1.5)));
      local.rig.intro = intro;
      local.walker.lookAround(intro > 0.5 ? 0 : 0.6);
      local.updateIdle(dt);
      if (left <= 0) {
        // GO! Everyone's clock is synced to the server, so all players start together.
        this.phase = "racing";
        local.timer.start();
        game.screens.setCountdown("GO!");
        game.sound.beep(880, 0.4);
        window.setTimeout(() => game.screens.setCountdown(null), 800);
      }
    } else {
      this.updateRacing(dt, local, net);
    }

    // Remote walkers, drawn 100 ms in the past (see RemotePlayer.ts).
    const renderTime = now - INTERPOLATION_DELAY_MS;
    for (const r of this.remotes.values()) r.update(dt, renderTime);
    game.pickups.update(dt, []); // bob + spin only; the server decides who collects
    game.sound.updateRoll(0, local.speed01, this.phase === "racing");
    local.refreshHud();
  }

  private updateRacing(dt: number, local: Player, net: NetClient): void {
    const game = this.game;
    // 1) Our own walker: full physics, instantly.
    local.updateMovement(dt);
    game.collisions.resolve(local.walker);
    for (const r of this.remotes.values()) bumpAgainst(local.walker, r.walker);
    game.collisions.resolve(local.walker);

    if (this.phase === "racing") {
      // 2) Touching a pickup? ASK the server. Hide it right away so it feels
      //    snappy; the effect only starts when the server says "yes, yours".
      if (!local.finished && net.connected) {
        const hit = game.pickups.findTouch(local);
        if (hit && !this.pendingClaims.has(hit.id)) {
          this.pendingClaims.add(hit.id);
          game.pickups.take(hit.id);
          net.send({ type: "claimPickup", id: hit.id });
        }
      }
      // 3) Laps: our LapTimer notices checkpoints; the server double-checks and keeps the official times.
      const ev = local.updateProgress(dt);
      if (ev?.type === "checkpoint") net.send({ type: "checkpoint", number: ev.number });
      if (ev?.type === "lap" || ev?.type === "finish") {
        net.send({ type: "lapDone" });
        game.sound.jingle();
      }
      if (ev?.type === "finish") local.hud.flash("FINISHED! Waiting for the others…", 3, "good");
    } else {
      local.updateProgress(dt); // results showing: just keep the camera following
    }

    // 4) Tell everyone where we are, STATE_SEND_HZ times per second.
    this.sendTimer -= dt;
    if (this.sendTimer <= 0 && this.phase === "racing") {
      this.sendTimer = 1 / STATE_SEND_HZ;
      const w = local.walker;
      const state: WalkerState = {
        x: w.position.x,
        z: w.position.z,
        h: w.heading,
        v: w.forwardSpeed,
        s: w.slideSpeed,
        y: w.yawRate,
        look: w.lookAngle,
        fx: local.effect?.tuning.effect ?? null,
      };
      net.send({ type: "state", state });
    }
  }

  // ---------------------------------------------------------------------------
  // Buttons and keys
  // ---------------------------------------------------------------------------

  private setStatus(id: "onlineStatus" | "lobbyStatus", text: string, error = false): void {
    const el = byId(id);
    el.textContent = text;
    el.classList.toggle("error", error);
  }

  private bindDom(): void {
    byId("createRoomBtn").addEventListener("click", () => this.createRoom());
    byId("joinRoomBtn").addEventListener("click", () => this.joinRoom());
    byId("onlineBackBtn").addEventListener("click", () => this.leave());
    byId("readyBtn").addEventListener("click", () => this.toggleReady());
    byId("startBtn").addEventListener("click", () => this.net?.send({ type: "start" }));
    byId("leaveBtn").addEventListener("click", () => this.leave());
    const code = byId<HTMLInputElement>("joinCode");
    code.addEventListener("input", () => (code.value = normalizeRoomCode(code.value)));
    code.addEventListener("keydown", (e) => e.key === "Enter" && this.joinRoom());
    byId<HTMLInputElement>("onlineName").addEventListener("keydown", (e) => e.key === "Enter" && this.createRoom());
    // Finish screen buttons are shared with local play; only react while online.
    byId("restartBtn").addEventListener("click", () => this.active && this.phase === "results" && this.showLobby());
    byId("menuBtn").addEventListener("click", () => this.active && this.leave());

    const kb = this.keyboard;
    this.cleanup.push(
      kb.onPress(["ArrowLeft", "KeyA"], () => this.active && this.cyclePick(-1)),
      kb.onPress(["ArrowRight", "KeyD"], () => this.active && this.cyclePick(1)),
      kb.onPress("Enter", () => {
        // A focused button already reacts to Enter by itself; don't do it twice.
        if (!this.active || document.activeElement instanceof HTMLButtonElement) return;
        if (this.phase === "lobby") this.toggleReady();
        else if (this.phase === "results") this.showLobby();
      }),
      kb.onPress("Escape", () => this.active && this.leave()),
    );
  }

  // ---------------------------------------------------------------------------
  // Debug / tests: window.__totrods.online.info()
  // ---------------------------------------------------------------------------

  debugInfo(): object {
    const w = this.local?.walker;
    return {
      phase: this.phase,
      status: this.net?.status ?? "closed",
      you: this.you,
      code: this.room?.code ?? null,
      roomPhase: this.room?.phase ?? null,
      hostId: this.room?.hostId ?? null,
      players: this.room?.players ?? [],
      rtt: this.net?.rtt ?? null,
      local: w
        ? { x: +w.position.x.toFixed(2), z: +w.position.z.toFixed(2), lap: this.local!.timer.lap, finished: this.local!.finished, effect: this.local!.effect?.kind ?? null, progress: this.local!.progress }
        : null,
      remotes: [...this.remotes.values()].map((r) => ({ id: r.id, name: r.name, x: +r.walker.position.x.toFixed(2), z: +r.walker.position.z.toFixed(2), snapshots: r.snapshotCount })),
      pickupsActive: this.game.pickups.items.map((p) => p.active),
      results: this.results,
      lastError: this.lastError,
    };
  }
}
