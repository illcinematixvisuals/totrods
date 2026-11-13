/**
 * Room.ts — one online room: its players, lobby and race.
 *
 * The server is AUTHORITATIVE: clients only *ask* ("I'd like Adam",
 * "I touched pickup 5", "I crossed the line"). The Room checks the rules
 * and then tells everybody what really happened. Two players grabbing the
 * same bottle at once? Whichever message arrives first wins.
 *
 * What the server does NOT do: simulate physics. Each client moves its own
 * walker and reports where it is. That is simple and feels instant, but it
 * means a modified client could lie about its position (see README, "Known
 * limitations"). For a friendly game between friends that's a fair trade.
 */
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  CHECKPOINTS_PER_LAP,
  COUNTDOWN_MS,
  FINISH_TIMEOUT_MS,
  MAX_PLAYERS,
  MIN_LAP_MS,
  MIN_PLAYERS_TO_START,
  PICKUP_COUNT,
  PICKUP_RESPAWN_MS,
  RECONNECT_GRACE_MS,
  TOTAL_LAPS,
  type CharacterId,
  type ClientMessage,
  type ErrorCode,
  type RaceInfo,
  type ResultRow,
  type RoomPhase,
  type RoomSnapshot,
  type ServerMessage,
  type WalkerState,
} from "../../shared/protocol.js";

const MAX_RACE_MS = 10 * 60 * 1000; // safety net: no race lasts longer than 10 minutes

/** Server-side race bookkeeping for one player. */
interface PlayerRace {
  lap: number; // lap they're on (1-based)
  nextCheckpoint: number;
  lapStartedAt: number;
  lapsDone: number;
  bestLapMs: number | null;
  finishedMs: number | null;
  place: number | null;
}

export interface ServerPlayer {
  readonly id: string;
  readonly token: string; // secret used to reconnect into this seat
  readonly joinOrder: number;
  name: string;
  character: CharacterId | null;
  ready: boolean;
  socket: WebSocket | null; // null while disconnected
  disconnectedAt: number | null;
  lastState: WalkerState | null;
  race: PlayerRace | null;
}

interface RaceState {
  raceId: number;
  startAt: number;
  grid: string[];
  pickupRespawnAt: Array<number | null>;
  finishCount: number;
  firstFinishAt: number | null;
}

let nextRaceId = 1;
let joinCounter = 0;

export class Room {
  readonly players = new Map<string, ServerPlayer>();
  phase: RoomPhase = "lobby";
  hostId = "";
  private race: RaceState | null = null;

  constructor(readonly code: string) {}

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  // ---------------------------------------------------------------------------
  // Joining, leaving, reconnecting
  // ---------------------------------------------------------------------------

  /** Returns an error code if this room can't take a new player right now. */
  canJoin(): ErrorCode | null {
    if (this.phase !== "lobby") return "race-running";
    if (this.players.size >= MAX_PLAYERS) return "room-full";
    return null;
  }

  addPlayer(socket: WebSocket, name: string): ServerPlayer {
    const p: ServerPlayer = {
      id: `p${randomBytes(3).toString("hex")}`,
      token: randomBytes(16).toString("hex"),
      joinOrder: joinCounter++,
      name: this.uniqueName(name),
      character: null, // picked in the lobby
      ready: false,
      socket,
      disconnectedAt: null,
      lastState: null,
      race: null,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.send(p, { type: "welcome", you: p.id, token: p.token, room: this.snapshot() });
    this.broadcastRoom();
    return p;
  }

  /** Reattach a socket to an existing seat (same token = same player). */
  resume(token: string, socket: WebSocket): ServerPlayer | null {
    const p = [...this.players.values()].find((x) => x.token === token);
    if (!p) return null;
    if (p.socket && p.socket !== socket) p.socket.close(4000, "replaced by a newer connection");
    p.socket = socket;
    p.disconnectedAt = null;
    this.send(p, { type: "welcome", you: p.id, token: p.token, room: this.snapshot() });
    this.broadcastRoom();
    return p;
  }

  /** The socket closed unexpectedly: keep the seat for RECONNECT_GRACE_MS. */
  disconnected(p: ServerPlayer, now: number): void {
    p.socket = null;
    p.disconnectedAt = now;
    this.broadcastRoom();
  }

  /** Gone for good (left on purpose, or the grace period ran out). */
  remove(p: ServerPlayer): void {
    this.players.delete(p.id);
    if (this.hostId === p.id) {
      // Host migration: the longest-waiting remaining player becomes host.
      const next = [...this.players.values()].sort((a, b) => a.joinOrder - b.joinOrder)[0];
      this.hostId = next ? next.id : "";
    }
    if (this.race) this.race.grid = this.race.grid.filter((id) => id !== p.id);
    this.broadcastRoom();
    this.checkRaceEnd(Date.now());
  }

  // ---------------------------------------------------------------------------
  // Messages from one player
  // ---------------------------------------------------------------------------

  handle(p: ServerPlayer, msg: ClientMessage, now: number): void {
    switch (msg.type) {
      case "pick":
        return this.onPick(p, msg.character);
      case "ready":
        if (this.phase !== "lobby") return;
        p.ready = msg.ready && p.character !== null;
        return this.broadcastRoom();
      case "start":
        return this.onStart(p, now);
      case "state":
        return this.onState(p, msg.state, now);
      case "checkpoint":
        return this.onCheckpoint(p, msg.number, now);
      case "lapDone":
        return this.onLapDone(p, now);
      case "claimPickup":
        return this.onClaim(p, msg.id, now);
      default:
        return; // create / join / resume / leave / ping are handled in index.ts
    }
  }

  private onPick(p: ServerPlayer, character: CharacterId | null): void {
    if (this.phase !== "lobby") return;
    const takenBy = [...this.players.values()].find((o) => o !== p && o.character === character && character !== null);
    if (takenBy) return this.error(p, "taken", `${takenBy.name} already picked that toddler.`);
    p.character = character;
    if (character === null) p.ready = false;
    this.broadcastRoom();
  }

  private onStart(p: ServerPlayer, now: number): void {
    if (p.id !== this.hostId) return this.error(p, "not-host", "Only the host can start the race.");
    const why = this.whyCantStart();
    if (why) return this.error(p, "cannot-start", why);
    const players = [...this.players.values()].sort((a, b) => a.joinOrder - b.joinOrder);
    const startAt = now + COUNTDOWN_MS;
    this.race = {
      raceId: nextRaceId++,
      startAt,
      grid: players.map((x) => x.id),
      pickupRespawnAt: Array.from({ length: PICKUP_COUNT }, () => null),
      finishCount: 0,
      firstFinishAt: null,
    };
    for (const x of players) {
      x.lastState = null;
      x.race = { lap: 1, nextCheckpoint: 0, lapStartedAt: startAt, lapsDone: 0, bestLapMs: null, finishedMs: null, place: null };
    }
    this.phase = "racing";
    this.broadcast({ type: "raceStart", race: this.raceInfo()! });
    this.broadcastRoom();
    console.log(`[${this.code}] race ${this.race.raceId} starting with ${players.length} players`);
  }

  whyCantStart(): string | null {
    if (this.phase !== "lobby") return "A race is already running.";
    const list = [...this.players.values()];
    if (list.length < MIN_PLAYERS_TO_START) return `Need at least ${MIN_PLAYERS_TO_START} players.`;
    if (list.some((x) => !x.socket)) return "Waiting for a player to reconnect.";
    if (list.some((x) => !x.character)) return "Everyone needs to pick a toddler.";
    if (list.some((x) => !x.ready)) return "Everyone needs to be ready.";
    return null;
  }

  /** Positions are relayed straight to everyone else, stamped with the server's clock. */
  private onState(p: ServerPlayer, state: WalkerState, now: number): void {
    if (this.phase !== "racing") return;
    p.lastState = state;
    this.broadcast({ type: "state", id: p.id, t: now, state }, p);
  }

  private racing(p: ServerPlayer, now: number): PlayerRace | null {
    if (!this.race || now < this.race.startAt || !p.race || p.race.finishedMs !== null) return null;
    return p.race;
  }

  private onCheckpoint(p: ServerPlayer, n: number, now: number): void {
    const r = this.racing(p, now);
    // Checkpoints must come in order: 1, 2, 3. Anything else is ignored.
    if (r && n === r.nextCheckpoint + 1) r.nextCheckpoint = n;
  }

  private onLapDone(p: ServerPlayer, now: number): void {
    const r = this.racing(p, now);
    if (!r || !this.race) return;
    const lapMs = now - r.lapStartedAt;
    if (r.nextCheckpoint < CHECKPOINTS_PER_LAP || lapMs < MIN_LAP_MS) return; // skipped checkpoints or impossibly fast
    r.lapsDone++;
    r.nextCheckpoint = 0;
    r.lapStartedAt = now;
    r.bestLapMs = r.bestLapMs === null ? lapMs : Math.min(r.bestLapMs, lapMs);
    if (r.lapsDone >= TOTAL_LAPS) {
      r.finishedMs = now - this.race.startAt;
      r.place = ++this.race.finishCount;
      this.race.firstFinishAt ??= now;
      this.broadcast({ type: "finished", id: p.id, place: r.place, timeMs: r.finishedMs });
      console.log(`[${this.code}] ${p.name} finished #${r.place} in ${(r.finishedMs / 1000).toFixed(2)}s`);
      this.checkRaceEnd(now);
    } else {
      r.lap = r.lapsDone + 1;
      this.broadcast({ type: "lap", id: p.id, lap: r.lap, lapMs });
    }
  }

  /** First claim wins: later claims for the same pickup find it already gone. */
  private onClaim(p: ServerPlayer, id: number, now: number): void {
    if (!this.racing(p, now) || !this.race) return;
    if (this.race.pickupRespawnAt[id] !== null) return;
    const respawnAt = now + PICKUP_RESPAWN_MS;
    this.race.pickupRespawnAt[id] = respawnAt;
    this.broadcast({ type: "pickupTaken", id, by: p.id, respawnAt });
  }

  // ---------------------------------------------------------------------------
  // Timers (called ~10×/s by index.ts)
  // ---------------------------------------------------------------------------

  tick(now: number): void {
    for (const p of [...this.players.values()]) {
      if (p.disconnectedAt !== null && now - p.disconnectedAt > RECONNECT_GRACE_MS) {
        console.log(`[${this.code}] ${p.name} did not reconnect in time`);
        this.remove(p);
      }
    }
    if (this.race) {
      this.race.pickupRespawnAt.forEach((at, id) => {
        if (at !== null && at <= now) {
          this.race!.pickupRespawnAt[id] = null;
          this.broadcast({ type: "pickupRespawn", id });
        }
      });
      this.checkRaceEnd(now);
    }
  }

  private checkRaceEnd(now: number): void {
    const race = this.race;
    if (!race || this.phase !== "racing") return;
    const racers = [...this.players.values()].filter((p) => p.race);
    const allDone = racers.length > 0 && racers.every((p) => p.race!.finishedMs !== null);
    const timedOut = race.firstFinishAt !== null && now - race.firstFinishAt > FINISH_TIMEOUT_MS;
    if (allDone || timedOut || racers.length === 0 || now - race.startAt > MAX_RACE_MS) this.endRace();
  }

  private endRace(): void {
    const race = this.race;
    if (!race) return;
    const rows: ResultRow[] = [...this.players.values()]
      .filter((p) => p.race)
      .map((p) => ({
        id: p.id,
        name: p.name,
        character: p.character,
        place: p.race!.place,
        timeMs: p.race!.finishedMs,
        bestLapMs: p.race!.bestLapMs,
        laps: p.race!.lapsDone,
      }))
      // Finishers by place, then everyone else by laps completed.
      .sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || b.laps - a.laps);
    this.broadcast({ type: "results", raceId: race.raceId, rows });
    console.log(`[${this.code}] race ${race.raceId} over: ${rows.map((r) => `${r.place ?? "DNF"}.${r.name}`).join(" ")}`);
    // Back to the lobby for a rematch. Everyone must press Ready again.
    this.race = null;
    this.phase = "lobby";
    for (const p of this.players.values()) {
      p.ready = false;
      p.race = null;
    }
    this.broadcastRoom();
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      players: [...this.players.values()]
        .sort((a, b) => a.joinOrder - b.joinOrder)
        .map((p) => ({ id: p.id, name: p.name, character: p.character, ready: p.ready, connected: p.socket !== null })),
      race: this.raceInfo(),
    };
  }

  private raceInfo(): RaceInfo | null {
    const race = this.race;
    if (!race) return null;
    const racers = [...this.players.values()].filter((p) => p.race);
    const lastStates: Record<string, WalkerState> = {};
    for (const p of racers) if (p.lastState) lastStates[p.id] = p.lastState;
    return {
      raceId: race.raceId,
      startAt: race.startAt,
      grid: race.grid,
      pickupRespawnAt: [...race.pickupRespawnAt],
      progress: racers.map((p) => ({ id: p.id, lap: p.race!.lap, nextCheckpoint: p.race!.nextCheckpoint, finishedMs: p.race!.finishedMs, place: p.race!.place })),
      lastStates,
    };
  }

  send(p: ServerPlayer, msg: ServerMessage): void {
    if (p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(JSON.stringify(msg));
  }

  /** Send to everyone in the room (optionally skipping one player). */
  broadcast(msg: ServerMessage, except?: ServerPlayer): void {
    const text = JSON.stringify(msg); // stringify once, send many times
    for (const p of this.players.values()) {
      if (p !== except && p.socket && p.socket.readyState === p.socket.OPEN) p.socket.send(text);
    }
  }

  private broadcastRoom(): void {
    this.broadcast({ type: "room", room: this.snapshot() });
  }

  error(p: ServerPlayer, code: ErrorCode, message: string): void {
    this.send(p, { type: "error", code, message });
  }

  private uniqueName(name: string): string {
    const names = new Set([...this.players.values()].map((p) => p.name));
    if (!names.has(name)) return name;
    for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
  }
}
