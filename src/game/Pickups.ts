/**
 * Pickups.ts — floating, bobbing items along the course.
 *
 * The pickup STATE is shared by all players: there is one Pickups object in
 * Game, and if P1 grabs a bottle, it's gone for P2 too until it respawns.
 * Online, the SERVER owns this state instead: set `autoRespawn = false`, and
 * the online session calls take()/restore() when the server says so.
 *
 * TypeScript features:
 *  - `PickupKind` is a union type: only these three strings are allowed.
 *  - `PICKUP_TUNING` is a Record<PickupKind, ...>, so forgetting a kind is a
 *    compile error.
 *
 * Babylon.js: each kind has one hidden "template" node; `instantiateHierarchy()`
 * makes cheap instanced copies of all its child meshes.
 */
import { Mesh, MeshBuilder, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { makeMat } from "./Materials";
import type { Track } from "./Track";

export type PickupKind = "milk" | "snack" | "crib";
export type EffectKind = "boost" | "nap";

export interface PickupTuning {
  effect: EffectKind;
  duration: number; // seconds the effect lasts
  speedMul: number; // top speed multiplier
  accelMul: number; // acceleration multiplier
  message: string; // HUD toast
  respawn: number; // seconds until it comes back
}

export const PICKUP_TUNING: Record<PickupKind, PickupTuning> = {
  milk: { effect: "boost", duration: 2.5, speedMul: 1.45, accelMul: 1.7, message: "MILK BOOST!", respawn: 4 },
  snack: { effect: "boost", duration: 2.5, speedMul: 1.35, accelMul: 1.5, message: "SNACK BOOST!", respawn: 4 },
  crib: { effect: "nap", duration: 2.5, speedMul: 0.45, accelMul: 0.5, message: "NAP TIME... zzz", respawn: 4 },
};

/** Where pickups go: a fraction of the lap, and their kinds across the lane (left → right). */
const LAYOUT: ReadonlyArray<{ at: number; kinds: readonly PickupKind[] }> = [
  { at: 0.1, kinds: ["crib", "milk", "snack"] },
  { at: 0.33, kinds: ["milk", "snack", "crib"] },
  { at: 0.58, kinds: ["snack", "milk", "crib"] },
  { at: 0.84, kinds: ["milk", "crib", "snack"] },
];
const LANE_SPACING = 2.3;
const PICKUP_RADIUS = 0.75;
const PICKUP_SCALE = 1.4; // models are built small; scale them up so they read from the chase camera
const FLOAT_HEIGHT = 1.3;

/** Shared state for one pickup. */
export interface PickupState {
  readonly id: number;
  readonly kind: PickupKind;
  readonly position: Vector3; // base position on the floor
  active: boolean;
  respawnIn: number;
  readonly node: TransformNode;
}

/** Anything that can collect pickups (a Player provides this). */
export interface Collector {
  readonly index: number; // player number
  readonly position: Vector3;
  readonly radius: number;
}

export interface PickupHit {
  collector: number;
  pickup: PickupState;
}

export class Pickups {
  readonly items: PickupState[] = [];
  /** Local play: pickups come back by themselves. Online: only when the server says so. */
  autoRespawn = true;
  private time = 0;

  constructor(private readonly scene: Scene, track: Track) {
    const templates: Record<PickupKind, TransformNode> = {
      milk: this.makeBottle(),
      snack: this.makeSnackCup(),
      crib: this.makeCrib(),
    };
    let id = 0;
    for (const group of LAYOUT) {
      const index = Math.round(group.at * track.sampleCount);
      const { position } = track.poseAt(index);
      const right = track.rightAt(index);
      group.kinds.forEach((kind, lane) => {
        const offset = (lane - (group.kinds.length - 1) / 2) * LANE_SPACING;
        const pos = position.add(right.scale(offset));
        const node = templates[kind].instantiateHierarchy(null, undefined, (src, clone) => {
          clone.name = `${src.name}-${id}`;
        }) as TransformNode;
        node.setEnabled(true);
        node.position.copyFrom(pos);
        node.scaling.setAll(PICKUP_SCALE);
        this.items.push({ id, kind, position: pos, active: true, respawnIn: 0, node });
        id++;
      });
    }
  }

  /**
   * Animate, respawn, and check collisions against every collector.
   * Returns the pickups collected this frame (Game applies their effects).
   */
  update(dt: number, collectors: readonly Collector[]): PickupHit[] {
    this.time += dt;
    const hits: PickupHit[] = [];
    for (const p of this.items) {
      if (!p.active) {
        if (!this.autoRespawn) continue;
        p.respawnIn -= dt;
        if (p.respawnIn <= 0) this.restore(p.id);
        continue;
      }
      // Bob up and down and spin; each pickup is offset in time so they don't move in sync.
      p.node.position.y = FLOAT_HEIGHT + Math.sin(this.time * 2.5 + p.id) * 0.18;
      p.node.rotation.y = this.time * 1.8 + p.id;
      for (const c of collectors) {
        const d = Math.hypot(c.position.x - p.position.x, c.position.z - p.position.z);
        if (d < c.radius + PICKUP_RADIUS) {
          p.active = false;
          p.respawnIn = PICKUP_TUNING[p.kind].respawn;
          p.node.setEnabled(false);
          hits.push({ collector: c.index, pickup: p });
          break;
        }
      }
    }
    return hits;
  }

  /** The first active pickup this collector is touching, without collecting it (online mode). */
  findTouch(c: Collector): PickupState | null {
    for (const p of this.items) {
      if (p.active && Math.hypot(c.position.x - p.position.x, c.position.z - p.position.z) < c.radius + PICKUP_RADIUS) return p;
    }
    return null;
  }

  /** Hide a pickup (it was collected). */
  take(id: number): void {
    const p = this.items[id];
    if (!p) return;
    p.active = false;
    p.respawnIn = PICKUP_TUNING[p.kind].respawn;
    p.node.setEnabled(false);
  }

  /** Show a pickup again. */
  restore(id: number): void {
    const p = this.items[id];
    if (!p) return;
    p.active = true;
    p.node.setEnabled(true);
  }

  /** Everything back, local respawning on (used when leaving online play). */
  resetAll(): void {
    this.autoRespawn = true;
    this.items.forEach((p) => this.restore(p.id));
  }

  // ---------------------------------------------------------------------------
  // Models (each is a hidden template node with child meshes)
  // ---------------------------------------------------------------------------

  private template(name: string): TransformNode {
    const t = new TransformNode(`tpl-${name}`, this.scene);
    t.setEnabled(false);
    // A soft glowing ring underneath makes every pickup easy to spot.
    const ring = MeshBuilder.CreateTorus(`${name}Ring`, { diameter: 1.1, thickness: 0.06, tessellation: 24 }, this.scene);
    ring.material = makeMat(this.scene, `${name}RingMat`, "#fff6a8", { emissive: 0.9 });
    ring.position.y = -0.55;
    ring.parent = t;
    return t;
  }

  private part(t: TransformNode, mesh: Mesh, hex: string, pos: Vector3, emissive = 0.25): Mesh {
    mesh.material = makeMat(this.scene, `${mesh.name}Mat`, hex, { specular: 0.5, emissive });
    mesh.position.copyFrom(pos);
    mesh.parent = t;
    return mesh;
  }

  /** Milk bottle: white body, blue band, collar and a nipple on top. */
  private makeBottle(): TransformNode {
    const t = this.template("milk");
    this.part(t, MeshBuilder.CreateCylinder("bottleBody", { diameter: 0.42, height: 0.7, tessellation: 14 }, this.scene), "#ffffff", new Vector3(0, 0, 0), 0.35);
    this.part(t, MeshBuilder.CreateCylinder("bottleBand", { diameter: 0.44, height: 0.08, tessellation: 14 }, this.scene), "#5ab8ff", new Vector3(0, 0.1, 0));
    this.part(t, MeshBuilder.CreateCylinder("bottleCollar", { diameter: 0.4, height: 0.12, tessellation: 14 }, this.scene), "#5ab8ff", new Vector3(0, 0.41, 0));
    this.part(t, MeshBuilder.CreateSphere("bottleNipple", { diameterX: 0.2, diameterY: 0.3, diameterZ: 0.2, segments: 8 }, this.scene), "#ffd9a8", new Vector3(0, 0.55, 0));
    return t;
  }

  /** Snack cup with puffs piled on top. */
  private makeSnackCup(): TransformNode {
    const t = this.template("snack");
    this.part(t, MeshBuilder.CreateCylinder("cup", { diameterTop: 0.55, diameterBottom: 0.4, height: 0.45, tessellation: 14 }, this.scene), "#ff9f1c", new Vector3(0, 0, 0));
    this.part(t, MeshBuilder.CreateTorus("cupLid", { diameter: 0.52, thickness: 0.06, tessellation: 16 }, this.scene), "#2ec4b6", new Vector3(0, 0.23, 0));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = i === 0 ? 0 : 0.14;
      this.part(t, MeshBuilder.CreateSphere("puff", { diameter: 0.13, segments: 5 }, this.scene), "#ffe08a", new Vector3(Math.cos(a) * r, 0.3 + (i === 0 ? 0.06 : 0), Math.sin(a) * r), 0.3);
    }
    return t;
  }

  /** Tiny floating crib (slows you down — nap time!). */
  private makeCrib(): TransformNode {
    const t = this.template("crib");
    this.part(t, MeshBuilder.CreateBox("cribBase", { width: 0.9, height: 0.12, depth: 0.55 }, this.scene), "#ffffff", new Vector3(0, -0.2, 0));
    this.part(t, MeshBuilder.CreateBox("cribMattress", { width: 0.82, height: 0.08, depth: 0.48 }, this.scene), "#9ad0ff", new Vector3(0, -0.12, 0));
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) this.part(t, MeshBuilder.CreateCylinder("cribPost", { diameter: 0.06, height: 0.55, tessellation: 6 }, this.scene), "#ffffff", new Vector3(sx * 0.43, 0.03, sz * 0.26));
    for (let i = -3; i <= 3; i++)
      for (const sz of [-1, 1]) this.part(t, MeshBuilder.CreateCylinder("cribBar", { diameter: 0.03, height: 0.4, tessellation: 4 }, this.scene), "#ffffff", new Vector3(i * 0.12, 0.0, sz * 0.26));
    for (const sz of [-1, 1]) this.part(t, MeshBuilder.CreateBox("cribRail", { width: 0.9, height: 0.05, depth: 0.05 }, this.scene), "#39b6ff", new Vector3(0, 0.22, sz * 0.26));
    this.part(t, MeshBuilder.CreateSphere("cribMoon", { diameter: 0.18, segments: 6 }, this.scene), "#fff27a", new Vector3(0, 0.5, 0), 0.6);
    return t;
  }
}
