/**
 * Track.ts — the racing line through the house: a smooth closed spline,
 * a tape line + arrows on the floor, the start/finish baby gate, and the
 * "where is this walker along the lap?" lookup.
 *
 * Babylon.js concepts:
 *  - Vector3: an (x, y, z) point or direction. Y is UP; +X right, +Z forward.
 *  - Curve3.CreateCatmullRomSpline: turns a few control points into a smooth curve.
 *  - Mesh + VertexData: we fill in raw vertex positions/UVs/triangles ourselves
 *    to make the tape ribbon.
 *  - DynamicTexture: a texture painted with the normal HTML canvas 2D API.
 */
import {
  Color3,
  Curve3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import type { CollisionWorld } from "./Collisions";
import { makeMat } from "./Materials";

export interface TrackQuery {
  index: number; // nearest centre-line sample (0 .. sampleCount-1)
  distance: number; // sideways distance from the racing line
  point: Vector3;
}

export interface TrackPose {
  position: Vector3;
  heading: number; // radians, 0 = facing +Z
}

/**
 * The racing line, as (x, z) points through the house (see House.ts for the
 * room layout). Doorways get three points in a row so the line goes straight
 * through them. `as const` makes this a read-only tuple array.
 */
const CONTROL_POINTS = [
  // Living room (start gate first)
  [-22, 9], [-24, 18], [-32, 28], [-24, 36], [-12, 34], [-7, 20],
  // → door → Kitchen, around the table
  [0, 20], [7, 20], [14, 32], [26, 36], [36, 28], [34, 14], [22, 7],
  // → door → Nursery, around the toy box
  [22, 0], [22, -7], [30, -14], [36, -26], [28, -36], [16, -34], [7, -20],
  // → door → Hallway, around the dog bed
  [0, -20], [-7, -20], [-18, -26], [-32, -30], [-36, -18], [-28, -10], [-22, -7],
  // → door → back to the living room
  [-22, 0],
] as const;

/** How far either side of the last known position the lookup searches. */
const SEARCH_WINDOW = 40;

export class Track {
  readonly halfWidth = 4; // "on the racing line" for checkpoint purposes
  readonly samples: Vector3[] = [];
  readonly tangents: Vector3[] = [];
  readonly length: number;

  constructor(private readonly scene: Scene, shadows: ShadowGenerator, collisions: CollisionWorld) {
    this.length = this.buildCenterLine(700);
    this.buildTape();
    this.buildArrows();
    this.buildStartGate(shadows, collisions);
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /**
   * Nearest racing-line sample to `pos`. With a `hint` (the walker's last
   * index) we only search a window around it — this is faster AND it can't
   * jump to a different part of the course that happens to be close by
   * through a wall. Without a hint (or if we're lost) we scan everything.
   */
  query(pos: Vector3, hint?: number): TrackQuery {
    const n = this.samples.length;
    if (hint !== undefined) {
      const local = this.scan(pos, hint - SEARCH_WINDOW, hint + SEARCH_WINDOW);
      if (local.distance < 14) return local;
    }
    return this.scan(pos, 0, n - 1);
  }

  private scan(pos: Vector3, from: number, to: number): TrackQuery {
    const n = this.samples.length;
    let best = 0;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (let k = from; k <= to; k++) {
      const i = ((k % n) + n) % n;
      const s = this.samples[i];
      const d2 = (s.x - pos.x) ** 2 + (s.z - pos.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return { index: best, distance: Math.sqrt(bestD2), point: this.samples[best] };
  }

  poseAt(index: number): TrackPose {
    const i = this.wrap(index);
    const t = this.tangents[i];
    return { position: this.samples[i].clone(), heading: Math.atan2(t.x, t.z) };
  }

  /** Unit vector pointing to the right of the direction of travel. */
  rightAt(index: number): Vector3 {
    const t = this.tangents[this.wrap(index)];
    return new Vector3(t.z, 0, -t.x);
  }

  wrap(index: number): number {
    const n = this.samples.length;
    return ((Math.round(index) % n) + n) % n;
  }

  // ---------------------------------------------------------------------------

  private buildCenterLine(count: number): number {
    const ctrl = CONTROL_POINTS.map(([x, z]) => new Vector3(x, 0, z));
    const dense = Curve3.CreateCatmullRomSpline(ctrl, 30, true).getPoints();
    if (Vector3.Distance(dense[0], dense[dense.length - 1]) < 0.01) dense.pop();
    const cum: number[] = [0];
    for (let i = 1; i <= dense.length; i++) cum.push(cum[i - 1] + Vector3.Distance(dense[i - 1], dense[i % dense.length]));
    const total = cum[cum.length - 1];
    let j = 0;
    for (let k = 0; k < count; k++) {
      const target = (k / count) * total;
      while (cum[j + 1] < target) j++;
      const f = (target - cum[j]) / (cum[j + 1] - cum[j]);
      this.samples.push(Vector3.Lerp(dense[j], dense[(j + 1) % dense.length], f));
    }
    for (let k = 0; k < count; k++) {
      const next = this.samples[(k + 1) % count];
      const prev = this.samples[(k - 1 + count) % count];
      this.tangents.push(next.subtract(prev).normalize());
    }
    return total;
  }

  /** A flat strip following the line: two vertices per sample, two triangles per step. */
  private ribbon(name: string, inner: number, outer: number, y: number, vScale: number): Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const n = this.samples.length;
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      const p = this.samples[k];
      const r = this.rightAt(k);
      const v = ((i / n) * this.length) / vScale;
      positions.push(p.x + r.x * inner, y, p.z + r.z * inner, p.x + r.x * outer, y, p.z + r.z * outer);
      uvs.push(0, v, 1, v);
      if (i < n) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.uvs = uvs;
    data.normals = normals;
    const mesh = new Mesh(name, this.scene);
    data.applyToMesh(mesh);
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    return mesh;
  }

  /** Dashed "painter's tape" racing line down the middle. */
  private buildTape(): void {
    const tex = new DynamicTexture("tapeTex", { width: 16, height: 64 }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 16, 64);
    ctx.fillStyle = "#ffd400"; // bright yellow racing tape
    ctx.fillRect(0, 0, 16, 40);
    tex.hasAlpha = true;
    tex.update();
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    const mat = new StandardMaterial("tapeMat", this.scene);
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.emissiveColor = new Color3(0.25, 0.25, 0.25);
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    this.ribbon("tape", -0.16, 0.16, 0.03, 2.2).material = mat;
  }

  /** Chevron arrows on the floor pointing the way. */
  private buildArrows(): void {
    const tex = new DynamicTexture("arrowTex", { width: 128, height: 128 }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 128, 128);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 18;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const y of [30, 72]) {
      ctx.beginPath();
      ctx.moveTo(24, y + 30);
      ctx.lineTo(64, y);
      ctx.lineTo(104, y + 30);
      ctx.stroke();
    }
    tex.hasAlpha = true;
    tex.update();
    const mat = new StandardMaterial("arrowMat", this.scene);
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.emissiveColor = new Color3(0.35, 0.35, 0.35);
    mat.specularColor = Color3.Black();
    const proto = MeshBuilder.CreateGround("arrow", { width: 1.6, height: 1.6 }, this.scene);
    proto.material = mat;
    proto.isVisible = false;
    proto.isPickable = false;
    for (let i = 20; i < this.samples.length - 10; i += 28) {
      const { position, heading } = this.poseAt(i);
      const a = proto.createInstance(`arrow${i}`);
      a.position.set(position.x, 0.035, position.z);
      a.rotation.y = heading;
      a.freezeWorldMatrix();
    }
  }

  /** Chequered line + a baby-gate arch with a TotRods banner on both sides. */
  private buildStartGate(shadows: ShadowGenerator, collisions: CollisionWorld): void {
    const { position, heading } = this.poseAt(0);
    const right = this.rightAt(0);

    const lineTex = new DynamicTexture("checker", { width: 256, height: 32 }, this.scene, false);
    const ctx = lineTex.getContext() as CanvasRenderingContext2D;
    for (let x = 0; x < 16; x++)
      for (let y = 0; y < 2; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#222" : "#fafafa";
        ctx.fillRect(x * 16, y * 16, 16, 16);
      }
    lineTex.update();
    const lineMat = new StandardMaterial("lineMat", this.scene);
    lineMat.diffuseTexture = lineTex;
    lineMat.specularColor = Color3.Black();
    const line = MeshBuilder.CreateGround("startLine", { width: 9, height: 1.2 }, this.scene);
    line.position = position.add(new Vector3(0, 0.04, 0));
    line.rotation.y = heading;
    line.material = lineMat;
    line.receiveShadows = true;

    // Banner text, painted once and shown on two single-sided planes.
    const banTex = new DynamicTexture("banner", { width: 1024, height: 192 }, this.scene, true);
    const b = banTex.getContext() as CanvasRenderingContext2D;
    // Royal-blue banner with red/white racing stripes and chequered-flag ends.
    b.save();
    b.beginPath();
    b.roundRect(0, 0, 1024, 192, 40);
    b.clip();
    b.fillStyle = "#1f4fff";
    b.fillRect(0, 0, 1024, 192);
    b.fillStyle = "#e3191f";
    b.fillRect(0, 150, 1024, 18);
    b.fillStyle = "#ffffff";
    b.fillRect(0, 140, 1024, 8);
    b.fillRect(0, 170, 1024, 8);
    for (const x0 of [0, 1024 - 144]) {
      for (let cx = 0; cx < 6; cx++)
        for (let cy = 0; cy < 8; cy++) {
          b.fillStyle = (cx + cy) % 2 === 0 ? "#111111" : "#ffffff";
          b.fillRect(x0 + cx * 24, cy * 24, 24, 24);
        }
    }
    b.restore();
    b.fillStyle = "#fff";
    b.font = "700 116px Fredoka, 'Baloo 2', 'Comic Sans MS', sans-serif";
    b.textAlign = "center";
    b.textBaseline = "middle";
    b.lineWidth = 14;
    b.strokeStyle = "#0d1b4d";
    b.strokeText("TotRods", 512, 92);
    b.fillStyle = "#ffffff";
    b.fillText("TotRods", 512, 92);
    banTex.hasAlpha = true;
    banTex.update();
    const banMat = new StandardMaterial("banMat", this.scene);
    banMat.diffuseTexture = banTex;
    banMat.useAlphaFromDiffuseTexture = true;
    banMat.emissiveColor = new Color3(0.45, 0.45, 0.45);
    banMat.specularColor = Color3.Black();
    // A Babylon plane is visible from its front (-Z side). Rotating it by
    // `heading` makes the front face walkers approaching the line; the second
    // plane is turned 180° so the text also reads correctly from behind.
    for (const [name, yaw, offset] of [["bannerFront", heading, -0.06], ["bannerBack", heading + Math.PI, 0.06]] as const) {
      const plane = MeshBuilder.CreatePlane(name, { width: 9, height: 1.7 }, this.scene);
      plane.material = banMat;
      plane.rotation.y = yaw;
      plane.position = position.add(this.tangents[0].scale(offset)).addInPlaceFromFloats(0, 4.7, 0); // high enough for the chase camera to pass under
    }

    // Baby-gate posts and folded-open gate panels (white bars).
    const white = makeMat(this.scene, "gateWhite", "#fdfdfd", { specular: 0.3, emissive: 0.1 });
    const half = 4.9;
    for (const side of [-1, 1]) {
      const base = position.add(right.scale(side * half));
      const post = MeshBuilder.CreateBox("gatePost", { width: 0.35, height: 5.6, depth: 0.35 }, this.scene);
      post.position = base.add(new Vector3(0, 2.8, 0));
      post.rotation.y = heading;
      post.material = white;
      shadows.addShadowCaster(post);
      collisions.addBox(base.x, base.z, 0.6, 0.6);
      // Panel swung open along the direction of travel.
      for (let k = 0; k < 6; k++) {
        const bar = MeshBuilder.CreateCylinder("gateBar", { diameter: 0.08, height: 1.6, tessellation: 6 }, this.scene);
        bar.position = base.add(this.tangents[0].scale(-0.3 - k * 0.32)).add(right.scale(side * 0.25)).addInPlaceFromFloats(0, 0.9, 0);
        bar.material = white;
        shadows.addShadowCaster(bar);
      }
      for (const y of [0.15, 1.65]) {
        const rail = MeshBuilder.CreateBox("gateRail", { width: 0.1, height: 0.1, depth: 1.8 }, this.scene);
        rail.position = base.add(this.tangents[0].scale(-1.1)).add(right.scale(side * 0.25)).addInPlaceFromFloats(0, y, 0);
        rail.rotation.y = heading;
        rail.material = white;
      }
    }
    const top = MeshBuilder.CreateBox("gateTop", { width: half * 2 + 0.35, height: 0.3, depth: 0.3 }, this.scene);
    top.position = position.add(new Vector3(0, 5.7, 0));
    top.rotation.y = heading;
    top.material = white;
    shadows.addShadowCaster(top);
  }
}
