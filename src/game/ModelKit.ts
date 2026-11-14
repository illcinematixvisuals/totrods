/**
 * ModelKit.ts — tools for building "premium" procedural models cheaply.
 *
 * THE PROBLEM: a character built from 60 little spheres and cylinders, each
 * with its own material, costs 60 draw calls (one GPU "draw this" command
 * each). Twelve walkers on screen = 700+ draw calls just for characters, and
 * phones start to stutter around a few hundred.
 *
 * THE TRICK (used by most stylised games):
 *  1. Paint each part's colour into its VERTICES (vertex colours) instead of
 *     giving it its own material.
 *  2. Share a handful of materials by *finish* only: matte, skin, glossy,
 *     glowing. They are white, so the vertex colour becomes the real colour.
 *  3. Merge every part that moves together AND shares a finish into ONE mesh.
 *
 * A whole toddler-in-a-kart then costs ~20 draw calls instead of ~120, and
 * the GPU spends its time on nicer lighting instead.
 *
 * Babylon.js concepts:
 *  - VertexBuffer.ColorKind: an RGBA colour per vertex. StandardMaterial
 *    multiplies its lighting result by it automatically.
 *  - Matrix.Compose + bakeTransformIntoVertices: "freeze" a part's position,
 *    rotation and scale into its vertex data, so it can be merged.
 *  - Mesh.MergeMeshes: combine many meshes into one.
 *  - FresnelParameters: change a colour depending on the viewing angle. We
 *    use it for a soft warm rim on skin (fakes light scattering under skin)
 *    and a bright sheen on glossy kart paint.
 */
import {
  Color3,
  Color4,
  FresnelParameters,
  Matrix,
  Mesh,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";

/** The surface "finish" of a part. Each finish = one shared material. */
export type Finish = "matte" | "skin" | "gloss" | "metal" | "glow" | "cloth";

/** One shared material per finish, per scene. */
const finishCache = new WeakMap<Scene, Map<Finish, StandardMaterial>>();

export function finishMaterial(scene: Scene, finish: Finish): StandardMaterial {
  let byFinish = finishCache.get(scene);
  if (!byFinish) {
    byFinish = new Map();
    finishCache.set(scene, byFinish);
  }
  const cached = byFinish.get(finish);
  if (cached) return cached;

  const m = new StandardMaterial(`finish-${finish}`, scene);
  m.diffuseColor = Color3.White(); // the vertex colour supplies the real colour
  switch (finish) {
    case "matte":
      m.specularColor = new Color3(0.08, 0.08, 0.08);
      m.emissiveColor = new Color3(0.12, 0.12, 0.12); // never pitch-black in shadow
      break;
    case "cloth":
      // Soft fabric: no hard highlight, a gentle light rim so outfits read as cosy.
      m.specularColor = new Color3(0.03, 0.03, 0.03);
      m.emissiveColor = new Color3(0.1, 0.1, 0.1);
      m.emissiveFresnelParameters = rim(new Color3(0.32, 0.32, 0.32), 2.2);
      break;
    case "skin":
      // Soft skin: low, wide highlight plus a warm rim that brightens toward the
      // edges, like light glowing through cheeks and ears (cheap "subsurface").
      m.specularColor = new Color3(0.12, 0.1, 0.09);
      m.specularPower = 18;
      m.emissiveColor = new Color3(0.3, 0.27, 0.25);
      m.emissiveFresnelParameters = rim(new Color3(0.6, 0.45, 0.4), 2.2);
      break;
    case "gloss":
      // Candy-coated kart paint / shiny plastic toys.
      m.specularColor = new Color3(0.75, 0.75, 0.75);
      m.specularPower = 72;
      m.emissiveColor = new Color3(0.1, 0.1, 0.1);
      m.emissiveFresnelParameters = rim(new Color3(0.38, 0.38, 0.4), 3.2);
      break;
    case "metal":
      // Gold crowns, chrome exhausts, hubcaps: very shiny, strong rim.
      m.specularColor = new Color3(1, 0.95, 0.85);
      m.specularPower = 110;
      m.emissiveColor = new Color3(0.22, 0.2, 0.16);
      m.emissiveFresnelParameters = rim(new Color3(0.7, 0.66, 0.5), 2.2);
      break;
    case "glow":
      // Headlights, LEDs, magic sparkles: they shine by themselves. The GlowLayer
      // (Stage 3) picks up emissive colour and blooms it.
      m.specularColor = Color3.Black();
      m.emissiveColor = new Color3(0.95, 0.95, 0.95);
      m.disableLighting = false;
      break;
  }
  byFinish.set(finish, m);
  return m;
}

/** A Fresnel "rim": black facing the camera, `edge` at grazing angles. */
function rim(edge: Color3, power: number): FresnelParameters {
  const f = new FresnelParameters();
  f.leftColor = edge; // edges
  f.rightColor = Color3.Black(); // facing us
  f.power = power;
  f.bias = 0.05;
  return f;
}

/** Fill a mesh's vertex colours with one colour (or a per-vertex function). */
export function paintVertices(mesh: Mesh, color: Color3 | ((p: Vector3) => Color3)): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;
  const count = pos.length / 3;
  const colors = new Float32Array(count * 4);
  const tmp = new Vector3();
  for (let i = 0; i < count; i++) {
    const c = typeof color === "function" ? color(tmp.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])) : color;
    colors[i * 4] = c.r;
    colors[i * 4 + 1] = c.g;
    colors[i * 4 + 2] = c.b;
    colors[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

export const hex = (h: string): Color3 => Color3.FromHexString(h);

interface PendingPart {
  mesh: Mesh;
  finish: Finish;
}

/**
 * PartBatch — collect parts for ONE moving node, then merge them per finish.
 *
 *   const b = new PartBatch(scene, headPivot, "head");
 *   b.add(MeshBuilder.CreateSphere(...), "#C9956A", "skin", { pos: new Vector3(0, 0.4, 0) });
 *   b.build(); // → one mesh per finish, parented to headPivot
 *
 * Positions/rotations passed to add() are in the NODE's local space.
 */
export class PartBatch {
  private readonly parts: PendingPart[] = [];
  readonly meshes: Mesh[] = [];

  constructor(
    private readonly scene: Scene,
    readonly node: TransformNode,
    private readonly name: string,
  ) {}

  add(
    mesh: Mesh,
    color: string | Color3 | ((p: Vector3) => Color3),
    finish: Finish,
    t: { pos?: Vector3; rot?: Vector3; scale?: Vector3 } = {},
  ): Mesh {
    // Bake the local transform into the vertices (the mesh has no parent yet,
    // so this is exactly "node-local space").
    const q = t.rot ? Quaternion.RotationYawPitchRoll(t.rot.y, t.rot.x, t.rot.z) : Quaternion.Identity();
    const m = Matrix.Compose(t.scale ?? Vector3.One(), q, t.pos ?? Vector3.Zero());
    mesh.bakeTransformIntoVertices(m);
    // Colour functions receive node-local vertex positions (handy for gradients and blush).
    paintVertices(mesh, typeof color === "string" ? hex(color) : color);
    this.parts.push({ mesh, finish });
    return mesh;
  }

  /** Merge everything added so far. Returns the merged meshes. */
  build(): Mesh[] {
    const byFinish = new Map<Finish, Mesh[]>();
    for (const p of this.parts) {
      const list = byFinish.get(p.finish) ?? [];
      list.push(p.mesh);
      byFinish.set(p.finish, list);
    }
    for (const [finish, list] of byFinish) {
      const merged = list.length === 1 ? list[0] : Mesh.MergeMeshes(list, true, true);
      if (!merged) continue;
      merged.name = `${this.name}-${finish}`;
      merged.material = finishMaterial(this.scene, finish);
      merged.parent = this.node;
      merged.isPickable = false;
      merged.receiveShadows = true;
      this.meshes.push(merged);
    }
    this.parts.length = 0;
    return this.meshes;
  }
}

/** Colour helper for gradients: mix a → b by t (0..1). */
export function mix(a: Color3, b: Color3, t: number): Color3 {
  const k = Math.max(0, Math.min(1, t));
  return new Color3(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

/** Color4 from hex with alpha (for particles). */
export function hex4(h: string, a = 1): Color4 {
  const c = hex(h);
  return new Color4(c.r, c.g, c.b, a);
}
