/**
 * StartGrid.ts — where walkers line up at the start (shared by local and online races).
 */

/** Track sample index of the starting grid: a couple of steps past the line. */
export const START_INDEX = 4;

/** Sideways offset of starting slot `slot` out of `count` walkers (0 = centre of the track). */
export function laneOffset(slot: number, count: number): number {
  if (count === 1) return 0;
  const gap = count <= 3 ? 2.6 : count <= 4 ? 2.0 : 1.7;
  return (slot - (count - 1) / 2) * gap;
}

/** A screen-space rectangle in 0..1 units (same convention as Babylon's Viewport: y = 0 is the bottom). */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Split-screen layout for the TV (16:9). Local 2-player still uses the
 * top/bottom split in Game.layoutViewports; this one is tuned for a couch.
 *   1 = full screen
 *   2 = side-by-side
 *   3 = one wide on top + two below
 *   4 = 2×2
 *   5–6 = 3×2 (a short bottom row is centred)
 */
export function layoutTvViewports(count: number): ViewportRect[] {
  if (count <= 1) return [{ x: 0, y: 0, width: 1, height: 1 }];
  if (count === 2) {
    return [
      { x: 0, y: 0, width: 0.5, height: 1 },
      { x: 0.5, y: 0, width: 0.5, height: 1 },
    ];
  }
  if (count === 3) {
    return [
      { x: 0, y: 0.5, width: 1, height: 0.5 },
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    ];
  }
  if (count === 4) {
    return [
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    ];
  }
  const w = 1 / 3;
  const h = 0.5;
  const cells: ViewportRect[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    const rowCount = row === 0 ? Math.min(3, count) : count - 3;
    const xOff = rowCount < 3 ? (1 - rowCount * w) / 2 : 0;
    cells.push({ x: xOff + col * w, y: row === 0 ? 0.5 : 0, width: w, height: h });
  }
  return cells;
}
