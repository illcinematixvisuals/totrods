/**
 * validate.ts — turn raw text from a WebSocket into a typed ClientMessage.
 *
 * NEVER trust data from the network: a browser can send anything. We check
 * every field's type here, so the rest of the server can rely on the types.
 * Anything that doesn't fit returns null and is ignored.
 */
import {
  CHECKPOINTS_PER_LAP,
  PICKUP_COUNT,
  isCharacterId,
  type ClientMessage,
  type ControllerInputState,
  type ResultRow,
  type TvHudFrame,
  type TvPhase,
  type WalkerState,
} from "../../shared/protocol.js";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown, max = 64): v is string => typeof v === "string" && v.length <= max;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const TV_PHASES: readonly TvPhase[] = ["lobby", "countdown", "racing", "results"];

function parseState(v: unknown): WalkerState | null {
  if (!isObj(v)) return null;
  const { x, z, h, v: speed, s, y, look, fx } = v;
  if (![x, z, h, speed, s, y, look].every(isNum)) return null;
  if (fx !== null && fx !== "boost" && fx !== "nap") return null;
  // Clamp to sane ranges (the house is about 100×100 units).
  return {
    x: clamp(x as number, -200, 200),
    z: clamp(z as number, -200, 200),
    h: (h as number) % (Math.PI * 2),
    v: clamp(speed as number, -50, 50),
    s: clamp(s as number, -50, 50),
    y: clamp(y as number, -20, 20),
    look: clamp(look as number, -3, 3),
    fx,
  };
}

function parseControllerInput(v: unknown): ControllerInputState | null {
  if (!isObj(v)) return null;
  const { steer, throttle, brake, drift, reset } = v;
  if (!isNum(steer) || !isNum(throttle) || !isNum(brake) || typeof drift !== "boolean" || typeof reset !== "boolean") return null;
  return {
    steer: clamp(steer, -1, 1),
    throttle: clamp(throttle, 0, 1),
    brake: clamp(brake, 0, 1),
    drift,
    reset,
  };
}

function parseHudFrame(v: unknown): TvHudFrame | null {
  if (!isObj(v) || !isStr(v.id, 32) || !isNum(v.lap) || !isNum(v.speedMph)) return null;
  if (v.place !== null && v.place !== undefined && !isNum(v.place)) return null;
  if (v.effect !== null && v.effect !== "boost" && v.effect !== "nap") return null;
  if (!isStr(v.effectText, 40)) return null;
  if (v.buzz !== null && v.buzz !== "pickup" && v.buzz !== "bump") return null;
  return {
    id: v.id,
    lap: Math.max(1, Math.floor(v.lap)),
    place: v.place === null || v.place === undefined ? null : Math.max(1, Math.floor(v.place as number)),
    speedMph: clamp(v.speedMph, 0, 99),
    effect: v.effect,
    effectText: v.effectText,
    buzz: v.buzz,
  };
}

function parseResultRow(v: unknown): ResultRow | null {
  if (!isObj(v) || !isStr(v.id, 32) || !isStr(v.name, 32)) return null;
  if (v.character !== null && !isCharacterId(v.character)) return null;
  if (v.place !== null && !(isNum(v.place) && Number.isInteger(v.place))) return null;
  if (v.timeMs !== null && !isNum(v.timeMs)) return null;
  if (v.bestLapMs !== null && !isNum(v.bestLapMs)) return null;
  if (!isNum(v.laps)) return null;
  return {
    id: v.id,
    name: v.name,
    character: v.character,
    place: v.place as number | null,
    timeMs: v.timeMs as number | null,
    bestLapMs: v.bestLapMs as number | null,
    laps: Math.max(0, Math.floor(v.laps as number)),
  };
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(data) || typeof data.type !== "string") return null;
  const d = data;
  switch (d.type) {
    case "create":
      return isStr(d.name) && isNum(d.version) ? { type: "create", name: d.name, version: d.version } : null;
    case "join":
      return isStr(d.code, 16) && isStr(d.name) && isNum(d.version) ? { type: "join", code: d.code, name: d.name, version: d.version } : null;
    case "resume":
      return isStr(d.code, 16) && isStr(d.token) && isNum(d.version) ? { type: "resume", code: d.code, token: d.token, version: d.version } : null;
    case "leave":
      return { type: "leave" };
    case "pick":
      return d.character === null || isCharacterId(d.character) ? { type: "pick", character: d.character } : null;
    case "ready":
      return typeof d.ready === "boolean" ? { type: "ready", ready: d.ready } : null;
    case "start":
      return { type: "start" };
    case "state": {
      const state = parseState(d.state);
      return state ? { type: "state", state } : null;
    }
    case "checkpoint":
      return Number.isInteger(d.number) && (d.number as number) >= 1 && (d.number as number) <= CHECKPOINTS_PER_LAP
        ? { type: "checkpoint", number: d.number as number }
        : null;
    case "lapDone":
      return { type: "lapDone" };
    case "claimPickup":
      return Number.isInteger(d.id) && (d.id as number) >= 0 && (d.id as number) < PICKUP_COUNT ? { type: "claimPickup", id: d.id as number } : null;
    case "ping":
      return isNum(d.t) ? { type: "ping", t: d.t } : null;
    case "tv_create":
      return isNum(d.version) ? { type: "tv_create", version: d.version } : null;
    case "tv_resume":
      return isStr(d.code, 16) && isStr(d.token, 80) && isNum(d.version) ? { type: "tv_resume", code: d.code, token: d.token, version: d.version } : null;
    case "controller_join":
      return isStr(d.code, 16) && isStr(d.name) && isNum(d.version)
        ? { type: "controller_join", code: d.code, name: d.name, version: d.version }
        : null;
    case "controller_resume":
      return isStr(d.code, 16) && isStr(d.token, 80) && isNum(d.version)
        ? { type: "controller_resume", code: d.code, token: d.token, version: d.version }
        : null;
    case "controller_input": {
      const input = parseControllerInput(d.input);
      return input ? { type: "controller_input", input } : null;
    }
    case "tv_start":
      return { type: "tv_start" };
    case "tv_state_to_controller": {
      if (!TV_PHASES.includes(d.phase as TvPhase)) return null;
      if (d.countdown !== null && !isStr(d.countdown, 8)) return null;
      if (!Array.isArray(d.huds)) return null;
      const huds: TvHudFrame[] = [];
      for (const row of d.huds) {
        const parsed = parseHudFrame(row);
        if (!parsed) return null;
        huds.push(parsed);
      }
      let results: ResultRow[] | undefined;
      if (d.results !== undefined) {
        if (!Array.isArray(d.results)) return null;
        results = [];
        for (const row of d.results) {
          const parsed = parseResultRow(row);
          if (!parsed) return null;
          results.push(parsed);
        }
      }
      return { type: "tv_state_to_controller", phase: d.phase as TvPhase, countdown: d.countdown as string | null, huds, results };
    }
    case "tv_back_to_lobby":
      return { type: "tv_back_to_lobby" };
    default:
      return null;
  }
}
