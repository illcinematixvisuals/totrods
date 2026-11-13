/**
 * TvRoom.ts — one TV Party room.
 *
 * Authority is the opposite of online rooms (see Room.ts):
 *  - The TV browser runs the race (physics, pickups, laps, finish order).
 *  - Each phone only sends controller input (steer / gas / brake / drift / reset).
 *  - This server is a RELAY plus a lobby referee: it owns the room code, the
 *    player list, unique toddler picks, the Start button, and reconnect seats.
 *    It does not simulate the walkers.
 *
 * Phones that drop keep their seat for TV_CONTROLLER_GRACE_MS (~30 s). If the
 * TV drops, phones see "TV disconnected, waiting…" and the room is held for
 * TV_HOST_GRACE_MS so the TV can come back with the same code.
 */
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  MAX_PLAYERS,
  TV_CONTROLLER_GRACE_MS,
  TV_HOST_GRACE_MS,
  type CharacterId,
  type ClientMessage,
  type ControllerInputState,
  type ErrorCode,
  type ResultRow,
  type ServerMessage,
  type TvPhase,
  type TvPlayerInfo,
  type TvRoomSnapshot,
} from "../../shared/protocol.js";

export interface TvController {
  readonly id: string;
  readonly token: string;
  readonly joinOrder: number;
  name: string;
  character: CharacterId | null;
  ready: boolean;
  queued: boolean;
  socket: WebSocket | null;
  disconnectedAt: number | null;
}

export interface TvHost {
  readonly id: string;
  readonly token: string;
  socket: WebSocket | null;
  disconnectedAt: number | null;
}

let joinCounter = 0;

export class TvRoom {
  tv: TvHost;
  readonly controllers = new Map<string, TvController>();
  phase: TvPhase = "lobby";
  hostControllerId = "";
  private pendingRemove = new Set<string>(); // drop after the race if grace ran out mid-race

  constructor(readonly code: string, tvSocket: WebSocket) {
    this.tv = {
      id: `tv${randomBytes(3).toString("hex")}`,
      token: randomBytes(16).toString("hex"),
      socket: tvSocket,
      disconnectedAt: null,
    };
    this.welcomeTv();
  }

  get isEmpty(): boolean {
    return this.tv.socket === null && this.tv.disconnectedAt === null && this.controllers.size === 0;
  }

  /** A brand-new phone may enter (queued if a race is already on). */
  canJoin(): ErrorCode | null {
    if (this.controllers.size >= MAX_PLAYERS) return "room-full";
    return null;
  }

  addController(socket: WebSocket, name: string): TvController {
    const queued = this.phase !== "lobby";
    const p: TvController = {
      id: `c${randomBytes(3).toString("hex")}`,
      token: randomBytes(16).toString("hex"),
      joinOrder: joinCounter++,
      name: this.uniqueName(name),
      character: null,
      ready: false,
      queued,
      socket,
      disconnectedAt: null,
    };
    this.controllers.set(p.id, p);
    if (!this.hostControllerId) this.hostControllerId = p.id;
    this.send(p, { type: "tv_welcome", role: "controller", you: p.id, token: p.token, room: this.snapshot() });
    this.broadcastRoom();
    return p;
  }

  resumeTv(token: string, socket: WebSocket): boolean {
    if (token !== this.tv.token) return false;
    if (this.tv.socket && this.tv.socket !== socket) this.tv.socket.close(4000, "replaced by a newer connection");
    this.tv.socket = socket;
    this.tv.disconnectedAt = null;
    // A mid-race TV reload lost the simulation, so everyone goes back to the lobby.
    if (this.phase !== "lobby") this.backToLobby();
    this.welcomeTv();
    this.broadcastRoom();
    return true;
  }

  resumeController(token: string, socket: WebSocket): TvController | null {
    const p = [...this.controllers.values()].find((x) => x.token === token);
    if (!p) return null;
    if (p.socket && p.socket !== socket) p.socket.close(4000, "replaced by a newer connection");
    p.socket = socket;
    p.disconnectedAt = null;
    this.pendingRemove.delete(p.id);
    this.send(p, { type: "tv_welcome", role: "controller", you: p.id, token: p.token, room: this.snapshot() });
    this.broadcastRoom();
    return p;
  }

  tvDisconnected(now: number): void {
    this.tv.socket = null;
    this.tv.disconnectedAt = now;
    this.broadcastToControllers({ type: "tv_waiting", message: "TV disconnected, waiting…" });
    this.broadcastRoom();
  }

  controllerDisconnected(p: TvController, now: number): void {
    p.socket = null;
    p.disconnectedAt = now;
    this.broadcastRoom();
  }

  removeController(p: TvController): void {
    this.controllers.delete(p.id);
    this.pendingRemove.delete(p.id);
    if (this.hostControllerId === p.id) {
      const next = this.racers().sort((a, b) => a.joinOrder - b.joinOrder)[0];
      this.hostControllerId = next ? next.id : "";
    }
    this.broadcastRoom();
  }

  /** The TV left on purpose (New Game) or its grace period ran out. */
  close(reason: string): void {
    this.broadcastToControllers({ type: "error", code: "tv-gone", message: reason });
    for (const p of this.controllers.values()) p.socket?.close(4001, reason);
    this.controllers.clear();
    this.tv.socket = null;
    this.tv.disconnectedAt = null;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  handleTv(msg: ClientMessage, now: number): void {
    void now;
    switch (msg.type) {
      case "tv_start":
        return this.tryStart("tv");
      case "tv_state_to_controller":
        return this.relayHud(msg.phase, msg.countdown, msg.huds, msg.results);
      case "tv_back_to_lobby":
        return this.backToLobby();
      default:
        return;
    }
  }

  handleController(p: TvController, msg: ClientMessage): void {
    switch (msg.type) {
      case "pick":
        return this.onPick(p, msg.character);
      case "ready":
        if (this.phase !== "lobby" || p.queued) return;
        p.ready = msg.ready && p.character !== null;
        return this.broadcastRoom();
      case "start":
      case "tv_start":
        return this.tryStart(p.id);
      case "controller_input":
        return this.relayInput(p, msg.input);
      default:
        return;
    }
  }

  private onPick(p: TvController, character: CharacterId | null): void {
    if (this.phase !== "lobby" || p.queued) return;
    const takenBy = [...this.controllers.values()].find((o) => o !== p && o.character === character && character !== null);
    if (takenBy) return this.error(p, "taken", `${takenBy.name} already picked that toddler.`);
    p.character = character;
    if (character === null) p.ready = false;
    this.broadcastRoom();
  }

  private tryStart(who: string): void {
    const isTv = who === "tv";
    const isHost = who === this.hostControllerId;
    if (!isTv && !isHost) {
      const p = this.controllers.get(who);
      if (p) this.error(p, "not-host", "Only the TV or the first phone can start the race.");
      return;
    }
    const why = this.whyCantStart();
    if (why) {
      if (isTv) this.sendTv({ type: "error", code: "cannot-start", message: why });
      else {
        const p = this.controllers.get(who);
        if (p) this.error(p, "cannot-start", why);
      }
      return;
    }
    const grid = this.racers()
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((x) => x.id);
    this.phase = "countdown";
    this.sendTv({ type: "tv_start", grid });
    this.broadcastRoom();
    console.log(`[${this.code}] TV Party starting with ${grid.length} players`);
  }

  whyCantStart(): string | null {
    if (this.phase !== "lobby") return "A race is already running.";
    if (!this.tv.socket) return "The TV is disconnected.";
    const list = this.racers();
    if (list.length < 1) return "Need at least one player.";
    if (list.some((x) => !x.socket)) return "Waiting for a player to reconnect.";
    if (list.some((x) => !x.character)) return "Everyone needs to pick a toddler.";
    if (list.some((x) => !x.ready)) return "Everyone needs to be ready.";
    return null;
  }

  private relayInput(p: TvController, input: ControllerInputState): void {
    if (p.queued || this.phase === "lobby" || this.phase === "results") return;
    this.sendTv({ type: "controller_input", id: p.id, input });
  }

  private relayHud(phase: TvPhase, countdown: string | null, huds: Array<{ id: string; lap: number; place: number | null; speedMph: number; effect: "boost" | "nap" | null; effectText: string; buzz: "pickup" | "bump" | null }>, results?: ResultRow[]): void {
    if (phase !== this.phase && (phase === "racing" || phase === "results" || phase === "countdown" || phase === "lobby")) {
      this.phase = phase;
    }
    const byId = new Map(huds.map((h) => [h.id, h]));
    for (const p of this.controllers.values()) {
      const frame = byId.get(p.id);
      const hud = {
        phase: this.phase,
        countdown,
        lap: frame?.lap ?? 1,
        place: frame?.place ?? null,
        speedMph: frame?.speedMph ?? 0,
        effect: frame?.effect ?? null,
        effectText: frame?.effectText ?? "",
        buzz: frame?.buzz ?? null,
        tvConnected: this.tv.socket !== null,
      };
      this.send(p, { type: "tv_state_to_controller", hud, results });
    }
  }

  backToLobby(): void {
    this.phase = "lobby";
    for (const id of this.pendingRemove) {
      const p = this.controllers.get(id);
      if (p) this.controllers.delete(id);
    }
    this.pendingRemove.clear();
    if (!this.controllers.has(this.hostControllerId)) {
      const next = [...this.controllers.values()].sort((a, b) => a.joinOrder - b.joinOrder)[0];
      this.hostControllerId = next ? next.id : "";
    }
    for (const p of this.controllers.values()) {
      p.ready = false;
      p.queued = false;
    }
    this.broadcastRoom();
  }

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  tick(now: number): "close" | "ok" {
    if (this.tv.disconnectedAt !== null && now - this.tv.disconnectedAt > TV_HOST_GRACE_MS) {
      console.log(`[${this.code}] TV did not reconnect in time`);
      this.close("The TV left the party.");
      return "close";
    }
    for (const p of [...this.controllers.values()]) {
      if (p.disconnectedAt !== null && now - p.disconnectedAt > TV_CONTROLLER_GRACE_MS) {
        console.log(`[${this.code}] ${p.name} did not reconnect in time`);
        if (this.phase === "lobby" || this.phase === "results") this.removeController(p);
        else this.pendingRemove.add(p.id); // keep the seat until the race ends, walker will coast on the TV
      }
    }
    return "ok";
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  snapshot(): TvRoomSnapshot {
    return {
      kind: "tv",
      code: this.code,
      phase: this.phase,
      tvConnected: this.tv.socket !== null,
      hostControllerId: this.hostControllerId,
      players: [...this.controllers.values()]
        .sort((a, b) => a.joinOrder - b.joinOrder)
        .map((p): TvPlayerInfo => ({
          id: p.id,
          name: p.name,
          character: p.character,
          ready: p.ready,
          connected: p.socket !== null,
          queued: p.queued,
          host: p.id === this.hostControllerId,
        })),
    };
  }

  private welcomeTv(): void {
    this.sendTv({ type: "tv_welcome", role: "tv", you: this.tv.id, token: this.tv.token, room: this.snapshot() });
  }

  sendTv(msg: ServerMessage): void {
    const s = this.tv.socket;
    if (s && s.readyState === s.OPEN) s.send(JSON.stringify(msg));
  }

  send(p: TvController, msg: ServerMessage): void {
    if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(JSON.stringify(msg));
  }

  broadcastRoom(): void {
    const msg: ServerMessage = { type: "tv_room", room: this.snapshot() };
    this.sendTv(msg);
    this.broadcastToControllers(msg);
  }

  private broadcastToControllers(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const p of this.controllers.values()) {
      if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(text);
    }
  }

  error(p: TvController, code: ErrorCode, message: string): void {
    this.send(p, { type: "error", code, message });
  }

  /** Players who will (or do) race — not late-joiners waiting for the next one. */
  private racers(): TvController[] {
    return [...this.controllers.values()].filter((p) => !p.queued);
  }

  private uniqueName(name: string): string {
    const names = new Set([...this.controllers.values()].map((p) => p.name));
    if (!names.has(name)) return name;
    for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
  }
}
