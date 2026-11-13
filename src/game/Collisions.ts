/**
 * Collisions.ts — very simple 2D collision for a top-down world.
 *
 *  - Walls and big furniture are axis-aligned boxes (AABBs) on the floor plane.
 *  - Walkers are circles.
 *
 * Circle vs box: find the closest point on the box to the circle centre. If
 * it's closer than the radius, push the circle out along that direction and
 * remove the part of the velocity going INTO the wall, so you slide along it.
 */
import { Vector3 } from "@babylonjs/core";

/** An axis-aligned rectangle on the floor (x/z plane). */
export interface Box2 {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Anything round that moves: walkers implement this shape. */
export interface CircleBody {
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly radius: number;
}

export class CollisionWorld {
  readonly boxes: Box2[] = [];

  /** Add a box by centre + size (handy for furniture). */
  addBox(cx: number, cz: number, width: number, depth: number): void {
    this.boxes.push({ minX: cx - width / 2, maxX: cx + width / 2, minZ: cz - depth / 2, maxZ: cz + depth / 2 });
  }

  /** Push `body` out of every box it overlaps. Returns true if it hit something. */
  resolve(body: CircleBody, bounce = 0.15): boolean {
    let hit = false;
    const p = body.position;
    const r = body.radius;
    for (const b of this.boxes) {
      // Quick reject: is the circle's bounding square touching the box at all?
      if (p.x + r < b.minX || p.x - r > b.maxX || p.z + r < b.minZ || p.z - r > b.maxZ) continue;
      const cx = Math.max(b.minX, Math.min(p.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
      let nx = p.x - cx;
      let nz = p.z - cz;
      let dist = Math.hypot(nx, nz);
      let push: number;
      if (dist > 1e-6) {
        if (dist >= r) continue;
        nx /= dist;
        nz /= dist;
        push = r - dist;
      } else {
        // Centre is inside the box: leave by the nearest side.
        const exits = [
          { d: p.x - b.minX, x: -1, z: 0 },
          { d: b.maxX - p.x, x: 1, z: 0 },
          { d: p.z - b.minZ, x: 0, z: -1 },
          { d: b.maxZ - p.z, x: 0, z: 1 },
        ].sort((a, c) => a.d - c.d)[0];
        nx = exits.x;
        nz = exits.z;
        dist = 0;
        push = exits.d + r;
      }
      p.x += nx * push;
      p.z += nz * push;
      // Remove velocity going into the surface (plus a tiny bounce).
      const vn = body.velocity.x * nx + body.velocity.z * nz;
      if (vn < 0) {
        body.velocity.x -= (1 + bounce) * vn * nx;
        body.velocity.z -= (1 + bounce) * vn * nz;
      }
      hit = true;
    }
    return hit;
  }

  /** Is a circle at (x, z) with radius r touching any box? */
  overlaps(x: number, z: number, r: number): boolean {
    return this.boxes.some((b) => {
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      return Math.hypot(x - cx, z - cz) < r;
    });
  }
}

/** Push two circles apart and trade some momentum (walker bumper cars!). */
export function bumpCircles(a: CircleBody, b: CircleBody, bounciness = 0.6): boolean {
  const dx = b.position.x - a.position.x;
  const dz = b.position.z - a.position.z;
  const minDist = a.radius + b.radius;
  const d = Math.hypot(dx, dz);
  if (d >= minDist || d < 1e-6) return false;
  const nx = dx / d;
  const nz = dz / d;
  const overlap = (minDist - d) / 2;
  a.position.x -= nx * overlap;
  a.position.z -= nz * overlap;
  b.position.x += nx * overlap;
  b.position.z += nz * overlap;
  // Relative velocity along the normal; only react if they're moving together.
  const rv = (b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz;
  if (rv < 0) {
    const j = (-(1 + bounciness) * rv) / 2;
    a.velocity.x -= j * nx;
    a.velocity.z -= j * nz;
    b.velocity.x += j * nx;
    b.velocity.z += j * nz;
  }
  return true;
}

/**
 * Like bumpCircles, but only `a` moves. Used online: you can bump into another
 * player's walker, but only THEIR computer is allowed to move them.
 */
export function bumpAgainst(a: CircleBody, fixed: CircleBody, bounciness = 0.6): boolean {
  const dx = fixed.position.x - a.position.x;
  const dz = fixed.position.z - a.position.z;
  const minDist = a.radius + fixed.radius;
  const d = Math.hypot(dx, dz);
  if (d >= minDist || d < 1e-6) return false;
  const nx = dx / d;
  const nz = dz / d;
  const overlap = minDist - d;
  a.position.x -= nx * overlap;
  a.position.z -= nz * overlap;
  const rv = (fixed.velocity.x - a.velocity.x) * nx + (fixed.velocity.z - a.velocity.z) * nz;
  if (rv < 0) {
    const j = -(1 + bounciness) * rv * 0.5;
    a.velocity.x -= j * nx;
    a.velocity.z -= j * nz;
  }
  return true;
}
