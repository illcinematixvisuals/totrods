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
 * Two doors in the living room's north wall lead out to a fenced BACKYARD
 * playground (swings, slide, sandbox, paddling pool, trees, a sprinkler).
 *
 * Stage 2 of the graphics upgrade added: the backyard, a sky dome with drifting
 * clouds, glossy floors (a ReflectionProbe rendered ONCE per room, so it costs
 * nothing per frame), alphabet blocks, giant pillows, lamps, and animated
 * scenery (TV cartoon, swings, a spinning baby mobile, butterflies, a bobbing
 * rubber duck, the sprinkler). Everything animated is ticked by update(dt).
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
  Color4,
  DynamicTexture,
  FresnelParameters,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  ReflectionProbe,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  Vector4,
} from "@babylonjs/core";
import { isLow, quality, registerGlow } from "./Quality";
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
  gloss?: number; // 0..1 how mirror-like the floor is (0 = no reflection probe)
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
    floor: woodFloor("#d9a066", "#a8703f"), floorRepeat: 8, gloss: 0.5,
    // Two north doors: out to the backyard and back in again.
    doors: [
      { side: "E", at: 20, width: DOOR_W }, { side: "S", at: -22, width: DOOR_W },
      { side: "N", at: -36, width: DOOR_W }, { side: "N", at: -8, width: DOOR_W },
    ],
  },
  {
    name: "kitchen", x0: 0, x1: 44, z0: 0, z1: 44, wallColor: "#b6e86a",
    floor: tileFloor("#fdfaf2", "#9fd8e8"), floorRepeat: 11, gloss: 0.7,
    doors: [{ side: "W", at: 20, width: DOOR_W }, { side: "S", at: 22, width: DOOR_W }],
  },
  {
    name: "nursery", x0: 0, x1: 44, z0: -44, z1: 0, wallColor: "#ffb347",
    floor: carpetFloor("#5f93e8", "#ffd400"), floorRepeat: 9,
    doors: [{ side: "N", at: 22, width: DOOR_W }, { side: "W", at: -20, width: DOOR_W }],
  },
  {
    name: "hallway", x0: -44, x1: 0, z0: -44, z1: 0, wallColor: "#c3cad6",
    floor: woodFloor("#b07a4a", "#7d5230"), floorRepeat: 8, gloss: 0.45,
    doors: [{ side: "E", at: -20, width: DOOR_W }, { side: "N", at: -22, width: DOOR_W }],
  },
];

export class House {
  /** Static meshes waiting to be merged by material at the end. */
  private readonly pending = new Map<StandardMaterial, Mesh[]>();
  private readonly mats = new Map<string, StandardMaterial>();
  /** Per-frame animation callbacks (t = seconds since start, dt = frame time). */
  private readonly animators: Array<(t: number, dt: number) => void> = [];
  private time = 0;
  /** Glossy-floor cube cameras; filled with the merged furniture at the end. */
  private readonly probes: ReflectionProbe[] = [];
  /** Everything static, so the probes can see it. */
  private readonly staticMeshes: Mesh[] = [];

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
    this.buildBackyard();
    this.buildSky();
    this.mergeStatic();
    for (const probe of this.probes) probe.renderList!.push(...this.staticMeshes);
  }

  /** Tick the animated scenery. Called every frame by Game.ts (menus too). */
  update(dt: number): void {
    this.time += dt;
    for (const a of this.animators) a(this.time, dt);
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

  private sphere(d: number, x: number, y: number, z: number, hex: string, scaleY = 1, segments = 10): Mesh {
    const m = MeshBuilder.CreateSphere("piece", { diameter: d, segments }, this.scene);
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
      this.staticMeshes.push(merged);
    }
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------
  // Structure
  // ---------------------------------------------------------------------------

  /** A big pastel "yard" under the dollhouse so the cut-away floats on something. */
  private buildOutside(): void {
    const g = MeshBuilder.CreateGround("outside", { width: 800, height: 800 }, this.scene);
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
    if (room.gloss && !isLow()) {
      // Glossy floor: a ReflectionProbe is 6 cameras looking out from the room
      // centre into a cube texture. RENDER_ONCE = it is drawn on the first frame
      // only, so the shine is free afterwards (moving karts are not reflected —
      // that would need a per-frame mirror, far too slow for phones).
      const probe = new ReflectionProbe(`probe-${room.name}`, quality.tier === "high" ? 256 : 128, this.scene);
      probe.position.set((room.x0 + room.x1) / 2, 1.2, (room.z0 + room.z1) / 2);
      probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      this.probes.push(probe);
      m.reflectionTexture = probe.cubeTexture;
      m.reflectionTexture.level = room.gloss;
      // Fresnel: strong reflections at grazing angles, almost none looking straight down.
      m.reflectionFresnelParameters = new FresnelParameters();
      m.reflectionFresnelParameters.leftColor = Color3.White();
      m.reflectionFresnelParameters.rightColor = new Color3(0.05, 0.05, 0.05);
      m.reflectionFresnelParameters.power = 2.5;
      m.specularColor = new Color3(0.35, 0.32, 0.3);
      m.specularPower = 48;
    }
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
    // TV on a stand against the north wall, between the two backyard doors.
    this.box(10, 1.4, 2, -21, 0, 42.4, "#5b4636", true);
    this.box(7.6, 2.0, 0.3, -21, 1.6, 42.8, "#111114");
    this.tvScreen(-21, 2.6, 42.62, 7.0);
    // Plant in the south-west corner.
    this.cyl(2.2, 1.5, -40.5, 0, 3.5, "#d9774b");
    for (const [dx, dy, dz] of [[0, 2.4, 0], [0.6, 2.0, 0.4], [-0.6, 2.1, -0.3]]) this.sphere(1.6, -40.5 + dx, dy, 3.5 + dz, "#3fae5a");
    this.collisions.addBox(-40.5, 3.5, 2.6, 2.6);
    // Floor lamp by the couch: the glowing shade is picked up by the GlowLayer.
    this.lamp(-41.5, 11);
    // Giant alphabet-block tower and a pile of floor pillows inside the loop.
    this.letterBlocks([
      [-18, 0, 32, "T", "#e3191f"], [-18, 1.6, 32, "O", "#1f4fff"], [-18, 3.2, 32, "T", "#ffd400"],
      [-16.2, 0, 33.4, "R", "#2ecc40"], [-20, 0, 34, "O", "#ff8a00"], [-16.6, 1.6, 33.2, "D", "#7b3fe4"],
    ], 1.6);
    this.collisions.addBox(-18, 33, 5, 4.2);
    this.pillows(-25, 37, ["#ff6fb5", "#39b6ff", "#ffd400"]);
  }

  /** A standard lamp: pole + glowing shade. Solid so you bump it. */
  private lamp(x: number, z: number): void {
    this.cyl(1.4, 0.15, x, 0, z, "#2b2f3a");
    this.cyl(0.18, 4.2, x, 0.15, z, "#2b2f3a", 8);
    const shade = MeshBuilder.CreateCylinder("lampShade", { diameterTop: 1.1, diameterBottom: 1.8, height: 1.2, tessellation: 20 }, this.scene);
    shade.position.set(x, 4.6, z);
    const m = makeMat(this.scene, "lampShadeMat", "#ffe9a8", { emissive: 0.95, specular: 0 });
    m.backFaceCulling = false;
    shade.material = m;
    shade.freezeWorldMatrix();
    registerGlow(shade);
    this.collisions.addBox(x, z, 1.4, 1.4);
  }

  /**
   * Alphabet blocks: one shared texture ATLAS of letter tiles, and faceUV
   * picks which tile each cube face shows. All blocks merge into one mesh.
   */
  private letterBlocks(list: Array<[number, number, number, string, string]>, size: number): void {
    const letters = "TOTRDSABC";
    if (!this.blockMat) {
      const tex = new DynamicTexture("blockAtlas", { width: 64 * letters.length, height: 64 }, this.scene, true);
      const c = tex.getContext() as CanvasRenderingContext2D;
      const colors = ["#e3191f", "#1f4fff", "#ffd400", "#2ecc40", "#ff8a00", "#7b3fe4"];
      for (let i = 0; i < letters.length; i++) {
        c.fillStyle = "#fff8e8";
        c.fillRect(i * 64, 0, 64, 64);
        c.strokeStyle = colors[i % colors.length];
        c.lineWidth = 8;
        c.strokeRect(i * 64 + 5, 5, 54, 54);
        c.fillStyle = colors[(i + 2) % colors.length];
        c.font = "700 44px Fredoka, 'Baloo 2', 'Comic Sans MS', sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(letters[i], i * 64 + 32, 35);
      }
      tex.update();
      this.blockMat = new StandardMaterial("blockMat", this.scene);
      this.blockMat.diffuseTexture = tex;
      this.blockMat.specularColor = new Color3(0.15, 0.15, 0.15);
      this.blockMat.emissiveColor = new Color3(0.12, 0.12, 0.12);
    }
    const n = letters.length;
    const tile = (ch: string): Vector4 => {
      const i = Math.max(0, letters.indexOf(ch));
      return new Vector4(i / n, 0, (i + 1) / n, 1);
    };
    list.forEach(([x, y, z, ch], k) => {
      const other = letters[(letters.indexOf(ch) + 3 + k) % n];
      const faceUV = [tile(ch), tile(ch), tile(other), tile(other), tile(letters[(k + 5) % n]), tile(letters[(k + 5) % n])];
      const b = MeshBuilder.CreateBox("block", { size, faceUV, wrap: true }, this.scene);
      b.position.set(x, y + size / 2, z);
      b.rotation.y = (k * 0.37) % 0.6;
      this.queue(b, this.blockMat!);
    });
  }
  private blockMat?: StandardMaterial;

  /** A heap of big squashy pillows (solid). */
  private pillows(x: number, z: number, colors: string[]): void {
    colors.forEach((c, i) => {
      const a = (i / colors.length) * Math.PI * 2;
      const p = MeshBuilder.CreateSphere("pillow", { diameter: 2.6, segments: 10 }, this.scene);
      p.scaling.set(1.2, 0.42, 0.9);
      p.position.set(x + Math.cos(a) * 1.1, 0.5 + (i === colors.length - 1 ? 0.7 : 0), z + Math.sin(a) * 0.9);
      p.rotation.y = a;
      this.queue(p, this.mat(c, 0.05, 0.12));
    });
    this.collisions.addBox(x, z, 4.2, 3.6);
  }

  /**
   * The TV plays a little looping cartoon: the canvas is repainted ~8 times a
   * second (cheap: a 256×128 texture) by an animator, so the living room feels alive.
   */
  private tvScreen(x: number, y: number, z: number, width = 9.4): void {
    const tex = new DynamicTexture("tvTex", { width: 256, height: 128 }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const paint = (t: number): void => {
      const g = ctx.createLinearGradient(0, 0, 0, 128);
      g.addColorStop(0, "#6fd3ff");
      g.addColorStop(1, "#b8f0a0");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 128);
      ctx.fillStyle = "#ffe14d"; // sun drifting across
      ctx.beginPath();
      ctx.arc(40 + ((t * 18) % 200), 30, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4caf50"; // rolling hills
      ctx.beginPath();
      ctx.moveTo(0, 128);
      for (let px = 0; px <= 256; px += 16) ctx.lineTo(px, 104 + Math.sin(px * 0.04 + t) * 6);
      ctx.lineTo(256, 128);
      ctx.fill();
      // A bouncing cartoon blob character.
      const bx = 128 + Math.sin(t * 1.3) * 70;
      const by = 80 - Math.abs(Math.sin(t * 4)) * 34;
      ctx.fillStyle = "#ff8a00";
      ctx.beginPath();
      ctx.ellipse(bx, by, 26, 26 - Math.abs(Math.cos(t * 4)) * 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(bx - 12, by - 12, 8, 10);
      ctx.fillRect(bx + 4, by - 12, 8, 10);
      ctx.fillStyle = "#222";
      ctx.fillRect(bx - 9, by - 8, 4, 5);
      ctx.fillRect(bx + 7, by - 8, 4, 5);
      tex.update();
    };
    paint(0);
    let acc = 0;
    this.animators.push((t, dt) => {
      acc += dt;
      if (acc < (isLow() ? 0.25 : 0.12)) return;
      acc = 0;
      paint(t);
    });
    const m = new StandardMaterial("tvMat", this.scene);
    m.emissiveTexture = tex;
    m.diffuseColor = Color3.Black();
    m.disableLighting = true;
    const screen = MeshBuilder.CreatePlane("tvScreen", { width, height: 1.7 }, this.scene);
    screen.material = m;
    screen.position.set(x, y, z);
    // Planes face -Z by default, which is toward the room here. Good.
    screen.freezeWorldMatrix();
    registerGlow(screen);
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
    // Giant cereal box, milk carton and a toaster on the counter (toddler's-eye scale).
    this.box(2.4, 3.2, 0.9, 27, 2.2, 42, "#ff8a00");
    this.box(2.0, 1.2, 0.05, 27, 3.4, 41.52, "#ffd400");
    this.box(1.2, 2.2, 1.2, 31, 2.2, 42, "#ffffff");
    this.box(1.22, 0.7, 1.22, 31, 3.5, 42, "#39b6ff");
    this.box(1.8, 1.0, 1.0, 6, 2.2, 42, "#c9d4de");
    this.box(1.2, 0.08, 0.6, 6, 3.2, 42, "#1c1c22");
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
    const letters = "TOTRODS";
    let li = 0;
    for (const [x, z, stack] of blocks) {
      this.letterBlocks(stack.map((c, i) => [x, i * 1.3, z, letters[li++ % letters.length], c] as [number, number, number, string, string]), 1.3);
      this.collisions.addBox(x, z, 1.4, 1.4);
    }
    this.ringToy(19, -27.5);
    this.babyMobile(40.7, -7);
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
    // Pillow fort pile.
    this.pillows(-14, -13, ["#1f4fff", "#e3191f", "#2ecc40", "#ffd400"]);
    // Picture frames on the walls (decoration).
    for (const [x, c] of [[-38, "#ffd166"], [-8, "#06d6a0"]] as const) this.box(3.4, 1.4, 0.15, x, 1.7, -43.4, c);
  }

  // ---------------------------------------------------------------------------
  // Nursery toys
  // ---------------------------------------------------------------------------

  /** A stacking-ring toy: a pole with rainbow doughnuts. */
  private ringToy(x: number, z: number): void {
    this.cyl(2.4, 0.3, x, 0, z, "#1f4fff");
    this.cyl(0.35, 3.2, x, 0.3, z, "#ffd400", 10);
    const colors = ["#e3191f", "#ff8a00", "#ffd400", "#2ecc40", "#39b6ff"];
    colors.forEach((c, i) => {
      const d = 2.2 - i * 0.3;
      const ring = MeshBuilder.CreateTorus("ring", { diameter: d, thickness: 0.5, tessellation: 18 }, this.scene);
      ring.position.set(x, 0.55 + i * 0.5, z);
      this.queue(ring, this.mat(c, 0.35, 0.1));
    });
    this.sphere(0.7, x, 3.6, z, "#ffd400");
    this.collisions.addBox(x, z, 2.4, 2.4);
  }

  /** A baby mobile on a stand above the bed, slowly turning (animated). */
  private babyMobile(x: number, z: number): void {
    // The stand is static (merged); the hanging part is a TransformNode we spin.
    this.box(0.25, 5.4, 0.25, x + 2.4, 0, z, "#ffffff");
    this.box(2.6, 0.2, 0.2, x + 1.2, 5.3, z, "#ffffff");
    const hub = new TransformNode("mobileHub", this.scene);
    hub.position.set(x, 5.2, z);
    const shapes: Array<[string, string]> = [["#ffd400", "star"], ["#ff6fb5", "moon"], ["#39b6ff", "ball"], ["#2ecc40", "ball"]];
    shapes.forEach(([c, kind], i) => {
      const a = (i / shapes.length) * Math.PI * 2;
      const arm = MeshBuilder.CreateBox("mobileArm", { width: 1.6, height: 0.04, depth: 0.04 }, this.scene);
      arm.rotation.y = a;
      arm.position.set(Math.cos(a) * 0.8, 0, -Math.sin(a) * 0.8);
      arm.parent = hub;
      arm.material = this.mat("#ffffff");
      const str = MeshBuilder.CreateBox("mobileString", { width: 0.02, height: 0.9, depth: 0.02 }, this.scene);
      str.position.set(Math.cos(a) * 1.5, -0.45, -Math.sin(a) * 1.5);
      str.parent = hub;
      str.material = this.mat("#ffffff");
      const toy =
        kind === "star"
          ? MeshBuilder.CreatePolyhedron("mobileStar", { type: 1, size: 0.3 }, this.scene)
          : kind === "moon"
            ? MeshBuilder.CreateTorus("mobileMoon", { diameter: 0.6, thickness: 0.18, tessellation: 12 }, this.scene)
            : MeshBuilder.CreateSphere("mobileBall", { diameter: 0.5, segments: 8 }, this.scene);
      toy.position.set(Math.cos(a) * 1.5, -1.0, -Math.sin(a) * 1.5);
      toy.parent = hub;
      toy.material = this.mat(c, 0.4, 0.35);
      this.shadows.addShadowCaster(toy);
    });
    this.animators.push((t) => {
      hub.rotation.y = t * 0.6;
      hub.rotation.z = Math.sin(t * 0.9) * 0.05;
    });
  }

  // ---------------------------------------------------------------------------
  // Backyard playground (outside the two north doors of the living room)
  // ---------------------------------------------------------------------------

  private buildBackyard(): void {
    const X0 = -56;
    const X1 = 6;
    const Z0 = 44;
    const Z1 = 86;
    // Grass: a painted tile with blades + clover, repeated.
    const grass = MeshBuilder.CreateGround("yardGrass", { width: X1 - X0, height: Z1 - Z0 }, this.scene);
    grass.position.set((X0 + X1) / 2, 0.005, (Z0 + Z1) / 2);
    const gt = new DynamicTexture("grassTex", { width: 256, height: 256 }, this.scene, true);
    const g = gt.getContext() as CanvasRenderingContext2D;
    g.fillStyle = "#5cc04a";
    g.fillRect(0, 0, 256, 256);
    for (let k = 0; k < 2200; k++) {
      g.fillStyle = ["#4aa83a", "#72d35c", "#3f9a33", "#86e06b"][k % 4];
      g.fillRect(Math.random() * 256, Math.random() * 256, 2, 5 + Math.random() * 5);
    }
    for (let k = 0; k < 14; k++) {
      g.fillStyle = k % 2 ? "#ffffff" : "#ffe14d"; // little daisies
      g.beginPath();
      g.arc(Math.random() * 256, Math.random() * 256, 3, 0, Math.PI * 2);
      g.fill();
    }
    gt.update();
    gt.wrapU = gt.wrapV = Texture.WRAP_ADDRESSMODE;
    gt.uScale = 10;
    gt.vScale = 7;
    gt.anisotropicFilteringLevel = 8;
    const gm = new StandardMaterial("grassMat", this.scene);
    gm.diffuseTexture = gt;
    gm.specularColor = Color3.Black();
    gm.emissiveColor = new Color3(0.08, 0.1, 0.06);
    grass.material = gm;
    grass.receiveShadows = true;
    grass.freezeWorldMatrix();

    // White picket fence on the three open sides (+ the short bit west of the house).
    const fence = (ax: number, az: number, bx: number, bz: number): void => {
      const len = Math.hypot(bx - ax, bz - az);
      const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
      const cx = (ax + bx) / 2;
      const cz = (az + bz) / 2;
      for (const y of [0.7, 1.6]) this.box(alongX ? len : 0.15, 0.22, alongX ? 0.15 : len, cx, y, cz, "#ffffff");
      for (let d = 0; d <= len; d += 1.1) {
        const px = alongX ? Math.min(ax, bx) + d : ax;
        const pz = alongX ? az : Math.min(az, bz) + d;
        this.box(0.45, 2.3, 0.12, px, 0, pz, "#ffffff").rotation.y = alongX ? 0 : Math.PI / 2;
      }
      this.collisions.addBox(cx, cz, alongX ? len : 0.6, alongX ? 0.6 : len);
    };
    fence(X0, Z1, X1, Z1);
    fence(X0, Z0, X0, Z1);
    fence(X1, Z0, X1, Z1);
    fence(X0, Z0, -44, Z0);

    // Sandbox with a bucket and spade.
    const sx = -27;
    const sz = 57;
    for (const [w, d, dx, dz] of [[6, 0.5, 0, -2.75], [6, 0.5, 0, 2.75], [0.5, 6, -2.75, 0], [0.5, 6, 2.75, 0]] as const) this.box(w, 0.7, d, sx + dx, 0, sz + dz, "#e3191f");
    this.box(5, 0.5, 5, sx, 0, sz, "#f6dc8f");
    this.cyl(1.0, 1.0, sx + 1, 0.5, sz - 1, "#1f4fff", 12);
    this.box(0.25, 1.4, 0.25, sx - 1.2, 0.5, sz + 1, "#ffd400").rotation.z = 0.5;
    this.sphere(0.9, sx - 0.5, 0.75, sz - 1.4, "#f6dc8f", 0.6, 8); // sand castle
    this.collisions.addBox(sx, sz, 6, 6);

    // Swing set with two swings that really swing.
    this.swingSet(-20, 68);
    // Slide (ladder + platform + sloped chute).
    this.slide(-12, 58);
    // Paddling pool with a bobbing rubber duck.
    this.pool(-11, 70.5);
    // Trees outside the loop.
    for (const [tx, tz, s] of [[-50, 52, 1.1], [-49, 80, 1.3], [1, 82, 1.0], [-30, 84, 0.9]] as const) this.tree(tx, tz, s);
    // Flower beds along the back fence.
    for (let fx = -52; fx < 4; fx += 2.3) {
      const c = ["#ff6fb5", "#ffd400", "#e3191f", "#7b3fe4", "#ffffff"][Math.abs(Math.round(fx)) % 5];
      this.cyl(0.08, 0.7, fx, 0, Z1 - 1.2, "#3f9a33", 5);
      this.sphere(0.55, fx, 0.85, Z1 - 1.2, c, 1, 6);
    }
    // Beach ball (moved out here from the living room).
    this.sphere(1.6, -46, 0.8, 66, "#ffffff");
    this.sphere(1.62, -46, 0.8, 66, "#ff4f4f", 0.35);
    this.collisions.addBox(-46, 66, 1.6, 1.6);

    this.sprinkler(-50, 72);
    this.butterflies();
  }

  private swingSet(x: number, z: number): void {
    const W = 9;
    const H = 4.6;
    this.box(W + 0.6, 0.3, 0.3, x, H, z, "#e3191f");
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const leg = this.box(0.3, H + 0.2, 0.3, x + sx * (W / 2), -0.1, z + sz * 0.9, "#1f4fff");
        leg.rotation.x = -sz * 0.2; // A-frame: legs splay out
      }
    this.collisions.addBox(x - W / 2, z, 0.8, 2.6);
    this.collisions.addBox(x + W / 2, z, 0.8, 2.6);
    const seatMat = this.mat("#ffd400", 0.3, 0.15);
    const ropeMat = this.mat("#8a6b4f");
    for (const [dx, phase] of [[-2, 0], [2, 1.7]] as const) {
      // The pivot sits on the top bar; children hang down. Rotating the pivot = swinging.
      const pivot = new TransformNode("swingPivot", this.scene);
      pivot.position.set(x + dx, H, z);
      for (const rx of [-0.6, 0.6]) {
        const rope = MeshBuilder.CreateBox("rope", { width: 0.06, height: H - 1.0, depth: 0.06 }, this.scene);
        rope.position.set(rx, -(H - 1.0) / 2, 0);
        rope.material = ropeMat;
        rope.parent = pivot;
      }
      const seat = MeshBuilder.CreateBox("seat", { width: 1.5, height: 0.15, depth: 0.7 }, this.scene);
      seat.position.set(0, -(H - 1.0), 0);
      seat.material = seatMat;
      seat.parent = pivot;
      this.shadows.addShadowCaster(seat);
      this.animators.push((t) => {
        pivot.rotation.x = Math.sin(t * 1.6 + phase) * 0.45;
      });
    }
  }

  private slide(x: number, z: number): void {
    // Platform + ladder at the south end, chute sloping north.
    this.box(2.4, 0.25, 2.4, x, 2.8, z - 3, "#1f4fff");
    for (const [dx, dz] of [[-1.1, -4.1], [1.1, -4.1], [-1.1, -1.9], [1.1, -1.9]]) this.box(0.25, 2.8, 0.25, x + dx, 0, z + dz, "#ffd400");
    for (let i = 0; i < 4; i++) this.box(2.2, 0.12, 0.12, x, 0.5 + i * 0.6, z - 4.1, "#ffffff");
    for (const dx of [-1.1, 1.1]) this.box(0.15, 0.9, 2.4, x + dx, 3.05, z - 3, "#e3191f");
    const chute = this.box(2.0, 0.2, 6.2, x, 0, z + 0.9, "#e3191f");
    chute.position.y = 1.5;
    chute.rotation.x = 0.46; // slopes down toward +Z
    for (const dx of [-1.05, 1.05]) {
      const rail = this.box(0.15, 0.45, 6.2, x + dx, 0, z + 0.9, "#ff8a00");
      rail.position.y = 1.75;
      rail.rotation.x = 0.46;
    }
    this.collisions.addBox(x, z - 3, 2.6, 2.6);
    this.collisions.addBox(x, z + 1.2, 2.2, 4.4);
  }

  private pool(x: number, z: number): void {
    const ring = MeshBuilder.CreateTorus("poolRing", { diameter: 5.2, thickness: 0.9, tessellation: 28 }, this.scene);
    ring.position.set(x, 0.42, z);
    ring.scaling.y = 0.9;
    this.queue(ring, this.mat("#39b6ff", 0.5, 0.12));
    // Water: a disc whose ripple texture slides along (animated UVs = very cheap).
    const wt = new DynamicTexture("waterTex", { width: 128, height: 128 }, this.scene, true);
    const w = wt.getContext() as CanvasRenderingContext2D;
    w.fillStyle = "#4fc3ff";
    w.fillRect(0, 0, 128, 128);
    w.strokeStyle = "rgba(255,255,255,0.55)";
    w.lineWidth = 3;
    for (let i = 0; i < 10; i++) {
      w.beginPath();
      const yy = i * 13 + 4;
      w.moveTo(0, yy);
      for (let px = 0; px <= 128; px += 16) w.lineTo(px, yy + Math.sin(px * 0.1 + i) * 3);
      w.stroke();
    }
    wt.update();
    wt.wrapU = wt.wrapV = Texture.WRAP_ADDRESSMODE;
    const wm = new StandardMaterial("waterMat", this.scene);
    wm.diffuseTexture = wt;
    wm.specularColor = new Color3(0.8, 0.8, 0.8);
    wm.specularPower = 64;
    wm.emissiveColor = new Color3(0.15, 0.2, 0.25);
    const water = MeshBuilder.CreateDisc("water", { radius: 2.3, tessellation: 28 }, this.scene);
    water.rotation.x = Math.PI / 2;
    water.position.set(x, 0.62, z);
    water.material = wm;
    water.receiveShadows = true;
    // Rubber duck.
    const duck = new TransformNode("duck", this.scene);
    duck.position.set(x, 0.7, z);
    const yellow = this.mat("#ffd400", 0.4, 0.25);
    const body = MeshBuilder.CreateSphere("duckBody", { diameter: 1.0, segments: 10 }, this.scene);
    body.scaling.set(1, 0.75, 1.25);
    body.parent = duck;
    body.material = yellow;
    const head = MeshBuilder.CreateSphere("duckHead", { diameter: 0.6, segments: 10 }, this.scene);
    head.position.set(0, 0.5, 0.35);
    head.parent = duck;
    head.material = yellow;
    const beak = MeshBuilder.CreateCylinder("duckBeak", { diameterTop: 0, diameterBottom: 0.25, height: 0.35, tessellation: 8 }, this.scene);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.47, 0.72);
    beak.parent = duck;
    beak.material = this.mat("#ff8a00", 0.3, 0.2);
    for (const s of [-1, 1]) {
      const eye = MeshBuilder.CreateSphere("duckEye", { diameter: 0.1, segments: 6 }, this.scene);
      eye.position.set(s * 0.17, 0.6, 0.6);
      eye.parent = duck;
      eye.material = this.mat("#111111");
    }
    this.shadows.addShadowCaster(body);
    this.animators.push((t) => {
      wt.uOffset = t * 0.05;
      wt.vOffset = t * 0.03;
      duck.position.y = 0.72 + Math.sin(t * 2.2) * 0.06;
      duck.position.x = x + Math.cos(t * 0.4) * 1.0;
      duck.position.z = z + Math.sin(t * 0.4) * 1.0;
      duck.rotation.y = -t * 0.4;
      duck.rotation.z = Math.sin(t * 2.2) * 0.08;
    });
    this.collisions.addBox(x, z, 5.4, 5.4);
  }

  private tree(x: number, z: number, s: number): void {
    this.cyl(1.2 * s, 5 * s, x, 0, z, "#8a5a33", 10);
    for (const [dx, dy, dz, d] of [[0, 6.2, 0, 5], [1.6, 5.2, 0.8, 3.6], [-1.5, 5.4, -0.6, 3.8], [0.3, 7.6, -0.4, 3.4]] as const)
      this.sphere(d * s, x + dx * s, dy * s, z + dz * s, ["#3fae5a", "#4cc26a", "#36a050", "#5ccf6f"][Math.round(d) % 4], 1, 10);
    this.collisions.addBox(x, z, 1.6 * s, 1.6 * s);
  }

  /** Lawn sprinkler: a GPU-cheap particle fountain that sweeps side to side. */
  private sprinkler(x: number, z: number): void {
    this.cyl(0.6, 0.35, x, 0, z, "#2ecc40", 10);
    if (isLow()) return; // skip the particles on weak devices
    const dot = new DynamicTexture("dropTex", { width: 32, height: 32 }, this.scene, false);
    const c = dot.getContext() as CanvasRenderingContext2D;
    const grad = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = grad;
    c.fillRect(0, 0, 32, 32);
    dot.hasAlpha = true;
    dot.update();
    const ps = new ParticleSystem("sprinkler", quality.tier === "high" ? 400 : 160, this.scene);
    ps.particleTexture = dot;
    ps.emitter = new Vector3(x, 0.4, z);
    ps.minSize = 0.12;
    ps.maxSize = 0.3;
    ps.minLifeTime = 0.9;
    ps.maxLifeTime = 1.3;
    ps.emitRate = quality.tier === "high" ? 260 : 100;
    ps.color1 = new Color4(0.75, 0.92, 1, 0.9);
    ps.color2 = new Color4(0.55, 0.85, 1, 0.8);
    ps.colorDead = new Color4(0.6, 0.85, 1, 0);
    ps.gravity = new Vector3(0, -9, 0);
    ps.minEmitPower = 7;
    ps.maxEmitPower = 8;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.start();
    this.animators.push((t) => {
      const a = Math.sin(t * 0.8) * 0.9; // sweep
      ps.direction1 = new Vector3(Math.sin(a) - 0.1, 1.4, Math.cos(a) - 0.1);
      ps.direction2 = new Vector3(Math.sin(a) + 0.1, 1.6, Math.cos(a) + 0.1);
    });
  }

  /** Butterflies flutter around on looping paths (two flapping wing planes each). */
  private butterflies(): void {
    const count = isLow() ? 3 : 7;
    const colors = ["#ff6fb5", "#ffd400", "#39b6ff", "#ff8a00", "#7b3fe4", "#ffffff", "#2ecc40"];
    for (let i = 0; i < count; i++) {
      const node = new TransformNode("butterfly", this.scene);
      const m = makeMat(this.scene, `wing${i}`, colors[i % colors.length], { emissive: 0.5, specular: 0 });
      m.backFaceCulling = false;
      const wings: Mesh[] = [];
      for (const s of [-1, 1]) {
        const pivot = new TransformNode("wingPivot", this.scene);
        pivot.parent = node;
        const wing = MeshBuilder.CreateDisc("wing", { radius: 0.32, tessellation: 8 }, this.scene);
        wing.rotation.x = Math.PI / 2;
        wing.position.x = s * 0.3;
        wing.parent = pivot;
        wing.material = m;
        wings.push(pivot as unknown as Mesh);
      }
      // Half of them in the backyard, the rest drifting through the rooms.
      const cx = i % 2 === 0 ? -25 + (i % 3) * 8 : -30 + i * 9;
      const cz = i % 2 === 0 ? 66 + (i % 3) * 5 : -20 + i * 5;
      const r = 4 + (i % 3) * 2;
      const sp = 0.35 + (i % 4) * 0.08;
      this.animators.push((t) => {
        const a = t * sp + i;
        node.position.set(cx + Math.cos(a) * r, 3.5 + Math.sin(a * 2.3) * 1.2, cz + Math.sin(a * 1.3) * r);
        node.rotation.y = -a;
        const flap = Math.sin(t * 18 + i) * 0.9;
        wings[0].rotation.z = flap;
        wings[1].rotation.z = -flap;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Sky
  // ---------------------------------------------------------------------------

  /** A gradient sky dome (inside of a huge sphere) with slowly drifting puffy clouds. */
  private buildSky(): void {
    // Colour each vertex of a big inside-out sphere by its height: deep blue
    // overhead, pale at the horizon. (Vertex colours need no texture at all.)
    const dome = MeshBuilder.CreateSphere("sky", { diameter: 900, segments: 16, sideOrientation: Mesh.BACKSIDE }, this.scene);
    const pos = dome.getVerticesData("position")!;
    const colors: number[] = [];
    const top = Color3.FromHexString("#0b5cff");
    const mid = Color3.FromHexString("#3fa2ff");
    const horizon = Color3.FromHexString("#b4e4ff");
    for (let i = 0; i < pos.length; i += 3) {
      const h = Math.max(0, pos[i + 1] / 450); // 0 at the horizon, 1 straight up
      const c = h < 0.3 ? Color3.Lerp(horizon, mid, h / 0.3) : Color3.Lerp(mid, top, (h - 0.3) / 0.7);
      colors.push(c.r, c.g, c.b, 1);
    }
    dome.setVerticesData("color", colors);
    const m = new StandardMaterial("skyMat", this.scene);
    // Unlit: emissive white × vertex colour (see ModelKit.ts for that trick).
    m.emissiveColor = Color3.White();
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.disableLighting = true;
    m.backFaceCulling = false;
    m.fogEnabled = false;
    dome.material = m;
    dome.isPickable = false;
    dome.infiniteDistance = true; // always centred on the camera
    dome.freezeWorldMatrix();

    const cloudMat = makeMat(this.scene, "cloudMat", "#ffffff", { emissive: 0.75, specular: 0 });
    const clouds: Mesh[] = [];
    for (let i = 0; i < 9; i++) {
      const puffs: Mesh[] = [];
      for (let k = 0; k < 4; k++) {
        const p = MeshBuilder.CreateSphere("puff", { diameter: 14 + (k % 2) * 6, segments: 8 }, this.scene);
        p.position.set((k - 1.5) * 8, (k % 2) * 3, (k % 3) * 3);
        p.scaling.y = 0.6;
        puffs.push(p);
      }
      const cloud = Mesh.MergeMeshes(puffs, true)!;
      cloud.material = cloudMat;
      cloud.isPickable = false;
      const a = (i / 9) * Math.PI * 2;
      cloud.position.set(Math.cos(a) * (150 + (i % 3) * 40), 55 + (i % 4) * 9, Math.sin(a) * (150 + (i % 3) * 40));
      clouds.push(cloud);
    }
    this.animators.push((_t, dt) => {
      for (const cl of clouds) {
        cl.position.x += dt * 2.5;
        if (cl.position.x > 260) cl.position.x = -260;
      }
    });
  }
}
