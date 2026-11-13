/**
 * shared/protocol.ts — the "language" the game client and the server speak.
 *
 * This ONE file is imported by both sides (the browser game in src/ and the
 * Node server in server/), so if you rename a field here, TypeScript points
 * at every place on both sides that needs updating. That is the whole point
 * of a shared, typed protocol.
 *
 * How the two multiplayer modes share this file:
 *  - A WebSocket stays open, so the browser and the server can send small
 *    messages at any time (unlike normal HTTP). Every message is a JSON
 *    object with a `type` field. TypeScript "discriminated unions" let us
 *    switch on `type` and know exactly which other fields exist.
 *
 *  ONLINE ROOMS (server-authoritative): the server is the referee for rooms,
 *    picks, the race start, laps, finish order and pickups. Each client
 *    drives its own walker (so steering feels instant) and reports its
 *    position ~20 times per second. Other walkers are drawn slightly in the
 *    past and interpolated.
 *
 *  TV PARTY (host-authoritative TV, server is only a relay): one TV/laptop
 *    runs the *whole* simulation for every toddler, just like local
 *    split-screen. Each phone is a controller: it sends input (steer, gas,
 *    brake, drift, reset) through the server to the TV, and the TV sends
 *    lap/place/boost status back. The server still owns the room, unique
 *    toddler picks, the player list, and reconnect seats — it does not
 *    simulate physics or decide the race.
 *
 * Keep this file free of imports so it works unchanged in Node and Vite.
 */

/** Bump this when the messages change in an incompatible way. */
export const PROTOCOL_VERSION = 1;

/** Default port of the game server in development. */
export const DEFAULT_SERVER_PORT = 2567;

/**
 * The playable toddlers, by id (must match src/game/Roster.ts).
 * One unique toddler per player → a room holds at most this many players.
 * Add another toddler here and in the roster (and a 3D model + portrait)
 * and rooms, local select and TV Party all grow automatically.
 */
export const CHARACTER_IDS = ["dj-the-dasher", "adam-the-great", "princess-logan", "huggie", "snacks", "mr-nap-time"] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

export const MAX_PLAYERS = CHARACTER_IDS.length;
export const MIN_PLAYERS_TO_START = 2;
export const TOTAL_LAPS = 3;
export const CHECKPOINTS_PER_LAP = 3; // matches LapTimer's default
export const PICKUP_COUNT = 12; // 4 groups × 3 lanes (see src/game/Pickups.ts LAYOUT)
export const PICKUP_RESPAWN_MS = 4000;
export const COUNTDOWN_MS = 3500; // from "race starts" message to GO
export const RECONNECT_GRACE_MS = 20000; // a dropped player keeps their seat this long (online rooms)
export const TV_CONTROLLER_GRACE_MS = 30000; // a dropped phone keeps its TV-Party seat this long
export const TV_HOST_GRACE_MS = 120000; // the TV can vanish this long and still reclaim the room
export const CONTROLLER_HEARTBEAT_MS = 400; // phones resend input at least this often, even if nothing changed
export const MIN_LAP_MS = 8000; // laps faster than this are rejected (simple sanity check)
export const FINISH_TIMEOUT_MS = 45000; // after the first finisher, others get this long
export const MAX_NAME_LENGTH = 14;

/** Room codes avoid look-alike characters (no I/1/L, O/0). */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 4;

/** Clients send their walker state this many times per second. */
export const STATE_SEND_HZ = 20;
/** Remote walkers are drawn this far in the past, so there are always two snapshots to blend between. */
export const INTERPOLATION_DELAY_MS = 100;

// -----------------------------------------------------------------------------
// Data shapes
// -----------------------------------------------------------------------------

/** One walker's state, sent by its owner ~20×/s. Short field names keep messages small. */
export interface WalkerState {
  x: number; // position on the floor
  z: number;
  h: number; // heading (radians)
  v: number; // forward speed (units/s) — spins the casters
  s: number; // sideways slide speed — leans the body
  y: number; // yaw rate (radians/s) — leans into turns
  look: number; // head glance angle
  fx: "boost" | "nap" | null; // active pickup effect
}

export type RoomPhase = "lobby" | "racing";

export interface PlayerInfo {
  id: string;
  name: string;
  character: CharacterId | null;
  ready: boolean;
  connected: boolean; // false while inside the reconnect grace period
}

/** Per-player race progress as the server sees it. */
export interface RaceProgress {
  id: string;
  lap: number; // 1-based lap the player is on
  nextCheckpoint: number; // 0..CHECKPOINTS_PER_LAP
  finishedMs: number | null; // race time when they finished
  place: number | null;
}

export interface RaceInfo {
  raceId: number;
  startAt: number; // server clock (ms since epoch) when the lights go green
  grid: string[]; // player ids in starting-lane order
  pickupRespawnAt: Array<number | null>; // per pickup: null = available, else server time it returns
  progress: RaceProgress[];
  lastStates: Record<string, WalkerState>; // newest known state per player (used when rejoining)
}

/** Everything a client needs to draw the lobby (and rejoin a race). */
export interface RoomSnapshot {
  code: string;
  phase: RoomPhase;
  hostId: string;
  players: PlayerInfo[];
  race: RaceInfo | null;
}

export interface ResultRow {
  id: string;
  name: string;
  character: CharacterId | null;
  place: number | null; // null = did not finish
  timeMs: number | null;
  bestLapMs: number | null;
  laps: number; // laps completed
}

// -----------------------------------------------------------------------------
// TV Party mode (host-authoritative TV, phones are controllers)
// -----------------------------------------------------------------------------

/** Input one phone sends to the TV (via the server) many times a second. */
export interface ControllerInputState {
  steer: number; // -1 (left) .. +1 (right)
  throttle: number; // 0..1
  brake: number; // 0..1
  drift: boolean;
  reset: boolean; // true for one message when the player taps RESET
}

export type TvPhase = "lobby" | "countdown" | "racing" | "results";

export interface TvPlayerInfo {
  id: string;
  name: string;
  character: CharacterId | null;
  ready: boolean;
  connected: boolean;
  queued: boolean; // joined mid-race: waits for the next lobby
  host: boolean; // first phone: can also press Start
}

export interface TvRoomSnapshot {
  kind: "tv";
  code: string;
  phase: TvPhase;
  tvConnected: boolean;
  hostControllerId: string;
  players: TvPlayerInfo[];
}

/** Status the TV paints on one phone's controller screen. */
export interface TvControllerHud {
  phase: TvPhase;
  countdown: string | null;
  lap: number;
  place: number | null;
  speedMph: number;
  effect: "boost" | "nap" | null;
  effectText: string;
  buzz: "pickup" | "bump" | null; // phone vibrates once when this is set
  tvConnected: boolean;
}

export interface TvHudFrame {
  id: string;
  lap: number;
  place: number | null;
  speedMph: number;
  effect: "boost" | "nap" | null;
  effectText: string;
  buzz: "pickup" | "bump" | null;
}

// -----------------------------------------------------------------------------
// Messages: client → server
// -----------------------------------------------------------------------------

export type ClientMessage =
  | { type: "create"; name: string; version: number }
  | { type: "join"; code: string; name: string; version: number }
  | { type: "resume"; code: string; token: string; version: number }
  | { type: "leave" }
  | { type: "pick"; character: CharacterId | null }
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "state"; state: WalkerState }
  | { type: "checkpoint"; number: number } // passed checkpoint 1..CHECKPOINTS_PER_LAP
  | { type: "lapDone" } // crossed the finish line after all checkpoints
  | { type: "claimPickup"; id: number }
  | { type: "ping"; t: number }
  // TV Party
  | { type: "tv_create"; version: number }
  | { type: "tv_resume"; code: string; token: string; version: number }
  | { type: "controller_join"; code: string; name: string; version: number }
  | { type: "controller_resume"; code: string; token: string; version: number }
  | { type: "controller_input"; input: ControllerInputState }
  | { type: "tv_start" } // TV or the first phone asks to start
  | { type: "tv_state_to_controller"; phase: TvPhase; countdown: string | null; huds: TvHudFrame[]; results?: ResultRow[] }
  | { type: "tv_back_to_lobby" };

// -----------------------------------------------------------------------------
// Messages: server → client
// -----------------------------------------------------------------------------

export type ErrorCode =
  | "bad-message"
  | "no-room"
  | "room-full"
  | "race-running"
  | "not-host"
  | "cannot-start"
  | "taken"
  | "version"
  | "expired"
  | "tv-gone";

export type ServerMessage =
  | { type: "welcome"; you: string; token: string; room: RoomSnapshot } // you joined (or rejoined)
  | { type: "room"; room: RoomSnapshot } // lobby changed: someone joined, picked, readied, left...
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "raceStart"; race: RaceInfo }
  | { type: "state"; id: string; t: number; state: WalkerState } // t = server receive time
  | { type: "pickupTaken"; id: number; by: string; respawnAt: number }
  | { type: "pickupRespawn"; id: number }
  | { type: "lap"; id: string; lap: number; lapMs: number } // `id` completed a lap; now on `lap`
  | { type: "finished"; id: string; place: number; timeMs: number }
  | { type: "results"; raceId: number; rows: ResultRow[] }
  | { type: "pong"; t: number; server: number }
  // TV Party
  | { type: "tv_welcome"; role: "tv" | "controller"; you: string; token: string; room: TvRoomSnapshot }
  | { type: "tv_room"; room: TvRoomSnapshot }
  | { type: "controller_input"; id: string; input: ControllerInputState } // server → TV
  | { type: "tv_start"; grid: string[] } // server → TV: begin the countdown
  | { type: "tv_state_to_controller"; hud: TvControllerHud; results?: ResultRow[] } // server → one phone
  | { type: "tv_waiting"; message: string }; // TV vanished; phones wait for it to return

// -----------------------------------------------------------------------------
// Small helpers used on both sides
// -----------------------------------------------------------------------------

export function isCharacterId(v: unknown): v is CharacterId {
  return typeof v === "string" && (CHARACTER_IDS as readonly string[]).includes(v);
}

/** Uppercase, strip anything that isn't in the code alphabet. */
export function normalizeRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .split("")
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .join("")
    .slice(0, ROOM_CODE_LENGTH);
}

export function cleanName(raw: unknown, fallback = "Toddler"): string {
  const s = typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim() : "";
  return s.slice(0, MAX_NAME_LENGTH) || fallback;
}
