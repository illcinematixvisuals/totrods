/**
 * Jumps.ts — where the little ramps (pillow ramps, toy-car ramps) are.
 *
 * Jumps are PURELY VISUAL: the racing physics stays flat (2D), so a jump can
 * never change who wins, desync online play, or get a small kid stuck. When a
 * walker rolls over a pad fast enough, Walker.ts launches its model into the
 * air, the camera follows the hop, and it lands with a squash and a puff of dust.
 *
 * Every walker (yours, split-screen, online, TV) checks this same list, so
 * everybody sees everybody jump.
 */
export interface JumpPad {
  x: number;
  z: number;
  radius: number; // how close to the centre counts as "on the ramp"
  power: number; // 1 = normal hop
}

export const JUMP_PADS: JumpPad[] = [];

/** The pad under (x, z), if any. */
export function padAt(x: number, z: number): JumpPad | null {
  for (const p of JUMP_PADS) {
    if ((p.x - x) ** 2 + (p.z - z) ** 2 < p.radius * p.radius) return p;
  }
  return null;
}
