/**
 * Quality.ts — one place that decides how much eye-candy this device gets.
 *
 * Three tiers:
 *  - "high":   desktops / laptops / consoles-on-a-TV with a real GPU.
 *  - "medium": most phones and tablets.
 *  - "low":    old or tiny devices (or a struggling frame rate, see Game.ts).
 *
 * You can force a tier with ?quality=low|medium|high in the URL, which is
 * handy for testing on a desktop what a phone will see.
 */
export type QualityTier = "low" | "medium" | "high";

function detect(): QualityTier {
  const forced = new URLSearchParams(location.search).get("quality");
  if (forced === "low" || forced === "medium" || forced === "high") return forced;
  const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  // deviceMemory (GB) is Chrome-only; hardwareConcurrency = CPU threads.
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (mem <= 2 || cores <= 2) return "low";
  return touch ? "medium" : "high";
}

/** The current tier. Game.ts may lower it at runtime if the frame rate drops. */
export const quality = { tier: detect() };

export const isHigh = (): boolean => quality.tier === "high";
export const isLow = (): boolean => quality.tier === "low";

/**
 * Meshes that should glow (lamp shades, kart lights, boost trails). Game.ts
 * owns the GlowLayer and sets `glowSink`; anything created earlier is queued.
 */
type GlowMesh = import("@babylonjs/core").AbstractMesh;
const pendingGlow: GlowMesh[] = [];
let glowSink: ((m: GlowMesh) => void) | null = null;
export function registerGlow(mesh: GlowMesh): void {
  if (glowSink) glowSink(mesh);
  else pendingGlow.push(mesh);
}
export function setGlowSink(sink: ((m: GlowMesh) => void) | null): void {
  glowSink = sink;
  if (sink) pendingGlow.splice(0).forEach(sink);
}
