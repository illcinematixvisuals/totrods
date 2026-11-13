/**
 * House.ts — the indoor course: four rooms in a 2×2 grid joined by doorways,
 * a cut-away (no ceiling) so the camera sees in, and toddler-scale furniture.
 *
 *     z
 *     ↑   Living room (NW)  |  Kitchen (NE)
 *     |   ------door--------+-------door------
 *     |   Hallway (SW)      |  Nursery (SE)
 *     +------------------------------------→ x
 *
 * Walls and big furniture also register an axis-aligned box in the
 * CollisionWorld so walkers bump into them.
 *
 * Performance trick: furniture is built from many small boxes, then all meshes
 * sharing a material are merged into ONE mesh (Mesh.MergeMeshes). Fewer meshes
 * = fewer draw calls = smoother frame rate.
 */
import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import type { CollisionWorld } from "./Collisions";
import { makeMat } from "./Materials";

type Side = "N" | "S" | "E" | "W";

interface Door {
  side: Side;
  at: number; // world x (N/S walls) or z (E/W walls) of the door centre
  width: number;
}

interface Room {
  name: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  wallColor: string;
  floor: (ctx: CanvasRenderingContext2D, size: number) => void; // paints one floor tile
  floorRepeat: number; // how many times the tile repeats across the room
  doors: Door[];
}

export const WALL_HEIGHT = 3.4;
const WALL_T = 0.5; // wall thickness (each room builds its own inner wall face)
const DOOR_W = 12;

// --- Floor painters (canvas 2D) ---------------------------------------------
function woodFloor(base: string, line: string) {
  return (ctx: CanvasRenderingContext2D, s: number): void => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    const plank = s / 4;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.03 + (i % 2) * 0.04})`;
      ctx.fillRect(i * plank, 0, plank, s);
      ctx.fillStyle = line;
      ctx.fillRect(i * plank, 0, 2, s);
      ctx.fillRect(i * plank, ((i * 37) % 4) * (s / 4), plank, 2);
    }
    for (let k = 0; k < 60; k++) {
      ctx.fillStyle = "rgba(90,50,20,0.08)";
      ctx.fillRect(Math.random() * s, Math.random() * s, 1, 10 + Math.random() * 20);
    }
  };
}
function tileFloor(a: string, b: string) {
  return (ctx: CanvasRenderingContext2D, s: number): void => {
    const t = s / 2;
    for (let x = 0; x < 2; x++)
      for (let y = 0; y < 2; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? a : b;
        ctx.fillRect(x * t, y * t, t, t);
      }
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, s, s);
    ctx.beginPath();
    ctx.moveTo(t, 0);
    ctx.lineTo(t, s);
    ctx.moveTo(0, t);
    ctx.lineTo(s, t);
    ctx.stroke();
  };
}
function carpetFloor(base: string, dots: string) {
  return (ctx: CanvasRenderingContext2D, s: number): void => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    for (let k = 0; k < 900; k++) {
      ctx.fillStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.05)";
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    ctx.fillStyle = dots;
    for (const [x, y] of [[0.25, 0.25], [0.75, 0.75]]) {
      ctx.beginPath();
      ctx.arc(x * s, y * s, s * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
  };
}

const ROOMS: readonly Room[] = [
  {
    name: "living", x0: -44, x1: 0, z0: 0, z1: 44, wallColor: "#7fb8ff",
    floor: woodFloor("#d9a066", "#a8703f"), floorRepeat: 8,
    doors: [{ side: "E", at: 20, width: DOOR_W }, { side: "S", at: -22, width: DOOR_W }],
  },
  {
    name: "kitchen", x0: 0, x1: 44, z0: 0, z1: 44, wallColor: "#b6e86a",
    floor: tileFloor("#fdfaf2", "#9fd8e8"), floorRepeat: 11,
    doors: [{ side: "W", at: 20, width: DOOR_W }, { side: "S", at: 22, width: DOOR_W }],
  },
  {
    name: "nursery", x0: 0, x1: 44, z0: -44, z1: 0, wallColor: "#ffb347",
    floor: carpetFloor("#5f93e8", "#ffd400"), floorRepeat: 9,
    doors: [{ side: "N", at: 22, width: DOOR_W }, { side: "W", at: -20, width: DOOR_W }],
  },
  {
    name: "hallway", x0: -44, x1: 0, z0: -44, z1: 0, wallColor: "#c3cad6",
    floor: woodFloor("#b07a4a", "#7d5230"), floorRepeat: 8,
    doors: [{ side: "E", at: -20, width: DOOR_W }, { side: "N", at: -22, width: DOOR_W }],
  },
];

export class House {
  /** Static meshes waiting to be merged by material at the end. */
  private readonly pending = new Map<StandardMaterial, Mesh[]>();
  private readonly mats = new Map<string, StandardMaterial>();

  constructor(
    private readonly scene: Scene,
    private readonly shadows: ShadowGenerator,
    private readonly collisions: CollisionWorld,
  ) {
    this.buildOutside();
    for (const room of ROOMS) {
      this.buildFloor(room);
      this.buildWalls(room);
    }
    this.buildLivingRoom();
    this.buildKitchen();
    this.buildNursery();
    this.buildHallway();
    this.mergeStatic();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Shared material per colour (so merging can combine them). */
  private mat(hex: string, specular = 0.12, emissive = 0.06): StandardMaterial {
    const key = `${hex}-${specular}-${emissive}`;
    let m = this.mats.get(key);
    if (!m) {
      m = makeMat(this.scene, `house-${key}`, hex, { specular, emissive });
      this.mats.set(key, m);
    }
    return m;
  }

  private queue(mesh: Mesh, mat: StandardMaterial): Mesh {
    mesh.material = mat;
    const list = this.pending.get(mat) ?? [];
    list.push(mesh);
    this.pending.set(mat, list);
    return mesh;
  }

  /** A box sitting ON the floor (y = bottom). Optionally solid for collisions. */
  private box(w: number, h: number, d: number, x: number, y: number, z: number, hex: string, solid = false, glow = 0.06): Mesh {
    const m = MeshBuilder.CreateBox("piece", { width: w, height: h, depth: d }, this.scene);
    m.position.set(x, y + h / 2, z);
    if (solid) this.collisions.addBox(x, z, w, d);
    return this.queue(m, this.mat(hex, 0.12, glow));
  }

  private cyl(diameter: number, h: number, x: number, y: number, z: number, hex: string, tess = 16): Mesh {
    const m = MeshBuilder.CreateCylinder("piece", { diameter, height: h, tessellation: tess }, this.scene);
    m.position.set(x, y + h / 2, z);
    return this.queue(m, this.mat(hex));
  }

  private sphere(d: number, x: number, y: number, z: number, hex: string, scaleY = 1): Mesh {
    const m = MeshBuilder.CreateSphere("piece", { diameter: d, segments: 10 }, this.scene);
    m.position.set(x, y, z);
    m.scaling.y = scaleY;
    return this.queue(m, this.mat(hex));
  }

  /** A flat rug (no collision) — slightly above the floor so it doesn't flicker. */
  private rug(w: number, d: number, x: number, z: number, paint: (ctx: CanvasRenderingContext2D, s: number) => void, round = false): void {
    const tex = new DynamicTexture("rugTex", { width: 256, height: 256 }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    paint(ctx, 256);
    tex.update();
    const m = new StandardMaterial("rugMat", this.scene);
    m.diffuseTexture = tex;
    m.specularColor = Color3.Black();
    m.emissiveColor = new Color3(0.06, 0.06, 0.06);
    const mesh = round
      ? MeshBuilder.CreateDisc("rug", { radius: 0.5, tessellation: 40 }, this.scene)
      : MeshBuilder.CreateGround("rug", { width: 1, height: 1 }, this.scene);
    if (round) mesh.rotation.x = Math.PI / 2; // discs face -Z by default; lay it flat
    mesh.scaling.set(w, round ? d : 1, round ? 1 : d);
    mesh.position.set(x, 0.015, z);
    mesh.material = m;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
  }

  /** Merge queued meshes per material: hundreds of boxes → a handful of meshes. */
  private mergeStatic(): void {
    for (const [mat, meshes] of this.pending) {
      const merged = Mesh.MergeMeshes(meshes, true, true);
      if (!merged) continue;
      merged.material = mat;
      merged.receiveShadows = true;
      merged.isPickable = false;
      merged.freezeWorldMatrix();
      mat.freeze();
      this.shadows.addShadowCaster(merged);
    }
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------
  // Structure
  // ---------------------------------------------------------------------------

  /** A big pastel "yard" under the dollhouse so the cut-away floats on something. */
  private buildOutside(): void {
    const g = MeshBuilder.CreateGround("outside", { width: 400, height: 400 }, this.scene);
    g.position.y = -0.05;
    g.material = makeMat(this.scene, "outsideMat", "#8fd0a0", { specular: 0 });
    g.receiveShadows = true;
    g.freezeWorldMatrix();
  }

  private buildFloor(room: Room): void {
    const w = room.x1 - room.x0;
    const d = room.z1 - room.z0;
    const floor = MeshBuilder.CreateGround(`floor-${room.name}`, { width: w, height: d }, this.scene);
    floor.position.set((room.x0 + room.x1) / 2, 0, (room.z0 + room.z1) / 2);
    const tex = new DynamicTexture(`floorTex-${room.name}`, { width: 256, height: 256 }, this.scene, true);
    room.floor(tex.getContext() as CanvasRenderingContext2D, 256);
    tex.update();
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.uScale = room.floorRepeat;
    tex.vScale = room.floorRepeat;
    tex.anisotropicFilteringLevel = 8;
    const m = new StandardMaterial(`floorMat-${room.name}`, this.scene);
    m.diffuseTexture = tex;
    m.specularColor = new Color3(0.12, 0.1, 0.08);
    floor.material = m;
    floor.receiveShadows = true;
    floor.freezeWorldMatrix();
    m.freeze();
  }

  /** Four inner wall faces per room, leaving gaps for doors. */
  private buildWalls(room: Room): void {
    const wall = room.wallColor;
    const trim = "#ffffff";
    // Each side is a line from a→b along one axis; cut out door gaps.
    const sides: Array<{ side: Side; from: number; to: number; fixed: number; alongX: boolean }> = [
      { side: "N", from: room.x0, to: room.x1, fixed: room.z1 - WALL_T / 2, alongX: true },
      { side: "S", from: room.x0, to: room.x1, fixed: room.z0 + WALL_T / 2, alongX: true },
      { side: "E", from: room.z0, to: room.z1, fixed: room.x1 - WALL_T / 2, alongX: false },
      { side: "W", from: room.z0, to: room.z1, fixed: room.x0 + WALL_T / 2, alongX: false },
    ];
    for (const s of sides) {
      const gaps = room.doors.filter((d) => d.side === s.side).map((d) => [d.at - d.width / 2, d.at + d.width / 2] as const);
      let cursor = s.from;
      const segments: Array<[number, number]> = [];
      for (const [g0, g1] of [...gaps].sort((a, b) => a[0] - b[0])) {
        if (g0 > cursor) segments.push([cursor, g0]);
        cursor = g1;
      }
      if (cursor < s.to) segments.push([cursor, s.to]);
      for (const [a, b] of segments) {
        const len = b - a;
        const mid = (a + b) / 2;
        const [x, z, w, d] = s.alongX ? [mid, s.fixed, len, WALL_T] : [s.fixed, mid, WALL_T, len];
        // Walls get extra self-glow so the paint colours stay bright and cheerful.
        this.box(w, WALL_HEIGHT, d, x, 0, z, wall, true, 0.32);
        // White cap on top and a baseboard make the cut-away read nicely.
        this.box(w + 0.02, 0.12, d + 0.02, x, WALL_HEIGHT, z, trim);
      }
      // Door frames: two white posts per door.
      for (const [g0, g1] of gaps) {
        for (const e of [g0, g1]) {
          const [x, z] = s.alongX ? [e, s.fixed] : [s.fixed, e];
          this.box(s.alongX ? 0.35 : WALL_T + 0.1, WALL_HEIGHT + 0.12, s.alongX ? WALL_T + 0.1 : 0.35, x, 0, z, trim);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Rooms
  // ---------------------------------------------------------------------------

  private buildLivingRoom(): void {
    // Striped round rug under part of the course.
    this.rug(16, 13, -25, 26, (ctx, s) => {
      const colors = ["#1f4fff", "#2ecc40", "#ff8a00", "#e3191f"];
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = colors[i % 4];
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, (s / 2) * (1 - i / 8), 0, Math.PI * 2);
        ctx.fill();
      }
    }, true);
    // Couch against the west wall.
    const cz = 22;
    this.box(4, 1.1, 16, -41.5, 0, cz, "#3aa6a0", true);
    this.box(1.2, 2.4, 16, -43.1, 0, cz, "#2f8f8a");
    for (const end of [-1, 1]) this.box(4.2, 1.7, 1.1, -41.5, 0, cz + end * 8, "#2f8f8a");
    for (const k of [-1, 0, 1]) this.box(2.6, 0.4, 4.6, -41.2, 1.1, cz + k * 5, "#4cc2bb");
    this.box(1.2, 1, 1.4, -40.4, 1.5, cz - 3, "#ffd166"); // throw pillow
    // Coffee table with a toy on it.
    this.box(5, 0.25, 3, -13, 1.0, 10, "#8a5a3b", true);
    for (const [dx, dz] of [[-2.2, -1.2], [2.2, -1.2], [-2.2, 1.2], [2.2, 1.2]]) this.box(0.3, 1.0, 0.3, -13 + dx, 0, 10 + dz, "#6e452c");
    this.sphere(0.9, -12.2, 1.7, 10, "#ff5f5f");
    // TV on a stand against the north wall.
    this.box(14, 1.4, 2, -13, 0, 42.4, "#5b4636", true);
    this.box(10, 2.0, 0.3, -13, 1.6, 42.8, "#111114");
    this.tvScreen(-13, 2.6, 42.62);
    // Plant in the corner + a beach ball.
    this.cyl(2.2, 1.5, -40.5, 0, 40.5, "#d9774b");
    for (const [dx, dy, dz] of [[0, 2.4, 0], [0.6, 2.0, 0.4], [-0.6, 2.1, -0.3]]) this.sphere(1.6, -40.5 + dx, dy, 40.5 + dz, "#3fae5a");
    this.collisions.addBox(-40.5, 40.5, 2.6, 2.6);
    this.sphere(1.6, -4, 0.8, 40, "#ffffff");
    this.sphere(1.62, -4, 0.8, 40, "#ff4f4f", 0.35);
    this.collisions.addBox(-4, 40, 1.6, 1.6);
  }

  private tvScreen(x: number, y: number, z: number): void {
    const tex = new DynamicTexture("tvTex", { width: 256, height: 128 }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, "#6fd3ff");
    g.addColorStop(1, "#b8f0a0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = "#ffe14d";
    ctx.beginPath();
    ctx.arc(200, 32, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff8a00"; // a cartoon blob character
    ctx.beginPath();
    ctx.arc(110, 84, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillRect(98, 72, 8, 10);
    ctx.fillRect(116, 72, 8, 10);
    tex.update();
    const m = new StandardMaterial("tvMat", this.scene);
    m.emissiveTexture = tex;
    m.diffuseColor = Color3.Black();
    m.disableLighting = true;
    const screen = MeshBuilder.CreatePlane("tvScreen", { width: 9.4, height: 1.7 }, this.scene);
    screen.material = m;
    screen.position.set(x, y, z);
    // Planes face -Z by default, which is toward the room here. Good.
    screen.freezeWorldMatrix();
  }

  private buildKitchen(): void {
    // Counters along the north wall + countertop, with a sink.
    this.box(32, 2.0, 3, 18, 0, 42, "#ffffff", true);
    this.box(32.2, 0.2, 3.2, 18, 2.0, 41.9, "#7a8899");
    this.box(4, 0.1, 2, 12, 2.15, 41.9, "#c9d4de");
    for (let x = 4; x < 34; x += 4) this.box(0.6, 0.12, 0.08, x, 1.6, 40.45, "#9aa5b1"); // handles
    // Fridge in the corner.
    this.box(6, 3.4, 5, 40.5, 0, 41, "#e9eef3", true);
    this.box(0.15, 1.2, 0.15, 38.2, 1.6, 38.45, "#9aa5b1");
    this.box(0.15, 0.6, 0.15, 38.2, 2.6, 38.45, "#9aa5b1");
    // East counter with a stove.
    this.box(3, 2.0, 30, 42, 0, 20, "#ffffff", true);
    this.box(3.2, 0.2, 30.2, 41.9, 2.0, 20, "#7a8899");
    this.box(2.6, 0.08, 4, 41.9, 2.2, 22, "#1c1c22");
    for (const [dx, dz] of [[-0.6, -1], [-0.6, 1], [0.6, -1], [0.6, 1]]) this.cyl(0.8, 0.05, 41.9 + dx, 2.28, 22 + dz, "#ff6a3d");
    // Table + four chairs, each solid.
    const tx = 22;
    const tz = 22;
    this.box(7, 0.3, 5, tx, 1.7, tz, "#f2c48d", true);
    for (const [dx, dz] of [[-3, -2], [3, -2], [-3, 2], [3, 2]]) this.box(0.35, 1.7, 0.35, tx + dx, 0, tz + dz, "#d39b5f");
    const chairs: Array<[number, number, number]> = [[-5.2, 0, 0], [5.2, 0, 0], [0, -3.9, 1], [0, 3.9, 1]];
    for (const [dx, dz, vertical] of chairs) {
      const cx = tx + dx;
      const czz = tz + dz;
      this.box(1.8, 0.25, 1.8, cx, 1.0, czz, "#ff8a00", true);
      for (const [lx, lz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) this.box(0.2, 1.0, 0.2, cx + lx, 0, czz + lz, "#d97a45");
      // Chair back on the side away from the table.
      const bx = vertical ? 0 : Math.sign(dx) * 0.8;
      const bz = vertical ? Math.sign(dz) * 0.8 : 0;
      this.box(vertical ? 1.8 : 0.2, 1.4, vertical ? 0.2 : 1.8, cx + bx, 1.25, czz + bz, "#ff8a00");
    }
    // Fruit bowl.
    this.cyl(1.6, 0.4, tx, 2.0, tz, "#ffffff");
    for (const [dx, dz, c] of [[-0.3, 0, "#ff4040"], [0.3, 0.1, "#ffd23f"], [0, -0.3, "#7bd34a"]] as const) this.sphere(0.5, tx + dx, 2.55, tz + dz, c);
  }

  private buildNursery(): void {
    this.rug(15, 15, 22, -24, (ctx, s) => {
      ctx.fillStyle = "#39b6ff";
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(s / 2 + Math.cos(a) * s * 0.33, s / 2 + Math.sin(a) * s * 0.33, s * 0.04, 0, Math.PI * 2);
        ctx.fill();
      }
    }, true);
    // Kid bed in the north-east corner.
    this.box(6, 1.2, 11, 40.7, 0, -7, "#e3191f", true); // race-car bed
    this.box(5.6, 0.5, 10.6, 40.7, 1.2, -7, "#1f4fff"); // blue blanket
    this.box(1.2, 0.04, 10.6, 40.7, 1.71, -7, "#ffffff"); // racing stripe
    this.box(3.2, 0.5, 2, 40.7, 1.7, -2.6, "#ffffff");
    this.box(6, 2.6, 0.4, 40.7, 0, -1.6, "#e3191f");
    // Toy box in the middle with blocks around it.
    this.box(4, 1.6, 3, 21, 0, -23, "#ffcf3f", true);
    this.box(4.2, 0.25, 3.2, 21, 1.6, -23, "#1f4fff");
    const blocks: Array<[number, number, string[]]> = [
      [26, -27, ["#e3191f", "#1f4fff", "#ffd400"]],
      [16, -19, ["#7bd34a", "#ff8a1e"]],
      [25, -18, ["#2ecc40"]],
    ];
    for (const [x, z, stack] of blocks) {
      stack.forEach((c, i) => this.box(1.2, 1.2, 1.2, x, i * 1.2, z, c));
      this.collisions.addBox(x, z, 1.3, 1.3);
    }
    // Giant teddy bear in the corner.
    const bx = 4.5;
    const bz = -40;
    this.sphere(3.0, bx, 1.5, bz, "#b07a4a");
    this.sphere(2.0, bx, 3.6, bz, "#b07a4a");
    for (const s of [-1, 1]) this.sphere(0.8, bx + s * 0.8, 4.5, bz, "#8a5a33");
    this.sphere(0.8, bx, 3.4, bz + 0.9, "#e8c39e");
    this.collisions.addBox(bx, bz, 3.4, 3.4);
    // Bookshelf on the south wall.
    this.box(10, 3.0, 1.8, 35, 0, -42.6, "#ffffff", true);
    for (let i = 0; i < 12; i++) this.box(0.6, 0.9, 1.2, 30.8 + i * 0.75, 0.3 + (i % 2) * 1.4, -42.4, ["#e3191f", "#1f4fff", "#ffd400", "#2ecc40"][i % 4]);
  }

  private buildHallway(): void {
    this.rug(22, 5, -21, -38, (ctx, s) => {
      ctx.fillStyle = "#1d2f73";
      ctx.fillRect(0, 0, s, s);
      // Chequered border, like a finish-line flag.
      for (let i = 0; i < 16; i++)
        for (const [x, y] of [[i * 16, 0], [i * 16, s - 16], [0, i * 16], [s - 16, i * 16]]) {
          ctx.fillStyle = (i + (x === 0 || y === 0 ? 0 : 1)) % 2 === 0 ? "#ffffff" : "#111111";
          ctx.fillRect(x, y, 16, 16);
        }
      ctx.fillStyle = "#ff8a00";
      ctx.fillRect(s / 2 - 22, 16, 14, s - 32);
      ctx.fillRect(s / 2 + 8, 16, 14, s - 32);
    });
    // Dog bed with a sleeping puppy in the middle of the loop.
    const dx = -22;
    const dz = -18;
    this.cyl(4.4, 0.6, dx, 0, dz, "#1d2f73");
    this.cyl(3.4, 0.62, dx, 0.02, dz, "#4f8de8");
    this.sphere(1.6, dx, 1.0, dz, "#f3e1c5", 0.6);
    this.sphere(1.0, dx + 0.9, 1.1, dz + 0.4, "#f3e1c5");
    this.sphere(0.45, dx + 1.1, 1.5, dz + 0.9, "#8a6b4f");
    this.collisions.addBox(dx, dz, 4.4, 4.4);
    // Shoe bench, laundry basket, console table with a vase.
    this.box(14, 1.4, 2, -23, 0, -42.4, "#8a5a3b", true);
    for (let i = 0; i < 5; i++) this.box(1.2, 0.5, 1.8, -28.5 + i * 2.6, 1.4, -42.4, ["#e3191f", "#1f4fff", "#ffffff", "#ffd400", "#2ecc40"][i]);
    this.cyl(3, 2, -40.5, 0, -40.5, "#e8d5a8", 12);
    this.collisions.addBox(-40.5, -40.5, 3, 3);
    this.box(2, 2, 10, -42.4, 0, -9, "#a0704a", true);
    this.cyl(1, 1.2, -42.4, 2, -9, "#4fb3ff");
    // Picture frames on the walls (decoration).
    for (const [x, c] of [[-38, "#ffd166"], [-8, "#06d6a0"]] as const) this.box(3.4, 1.4, 0.15, x, 1.7, -43.4, c);
  }
}
