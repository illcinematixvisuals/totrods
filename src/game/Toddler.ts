/**
 * Toddler.ts — builds an anime-inspired chibi toddler from smooth procedural
 * shapes, using a RosterEntry for colours, hair and accessories.
 *
 * What makes it read as "anime chibi" rather than "pile of spheres":
 *  - A huge head (about 45% of the height), tiny body, short limbs.
 *  - Big painted eyes with glossy irises and sparkly highlights
 *    (FaceTextures.ts), projected onto the curve of the face.
 *  - Soft skin: one shared "skin" material with a warm Fresnel rim, and rosy
 *    cheeks painted into the head's VERTEX colours (no extra texture).
 *
 * It is RIGGED with plain TransformNodes (no skeleton needed):
 *
 *   root
 *    ├─ hips (legs, diaper)              — sits in the walker seat
 *    └─ upperBody (pivot at the waist)   — leans into turns, bounces
 *        ├─ torso
 *        ├─ shoulderL / shoulderR        — ArmRig: aims at a target (simple IK)
 *        └─ headPivot (neck)             — glances, bobbles
 *            ├─ head, hair, accessories
 *            └─ FaceRig: eye + mouth decals (swap material = new expression)
 *
 * Everything is built with ModelKit.PartBatch, so a toddler is ~15 draw calls.
 * The toddler faces +Z.
 */
import { Mesh, MeshBuilder, Scalar, Scene, TransformNode, Vector3, VertexData } from "@babylonjs/core";
import { eyeMaterial, EXPRESSIONS, mouthMaterial, type Expression } from "./FaceTextures";
import { hex, mix, PartBatch } from "./ModelKit";
import type { RosterEntry } from "./Roster";

const HEAD_R = 0.46; // head radius — chibi toddlers are mostly head!
const HEAD_Y = HEAD_R - 0.02; // head centre above the neck pivot
const WAIST_Y = 0.86; // upperBody pivot height (in the walker seat)
const SHOULDER = new Vector3(0.28, 0.42, 0.0); // relative to upperBody (x is mirrored)

// ---------------------------------------------------------------------------
// Face rig: expressions + blinking
// ---------------------------------------------------------------------------

export class FaceRig {
  private expression: Expression = "smile";
  private hold = 0; // seconds the current (temporary) expression stays
  private base: Expression = "smile"; // what we return to afterwards
  private blinkIn = 2 + Math.random() * 2;
  private blinkLeft = 0;

  constructor(
    private readonly scene: Scene,
    private readonly eyes: Mesh,
    private readonly mouth: Mesh,
    private readonly brow: string,
  ) {
    this.apply();
  }

  get current(): Expression {
    return this.expression;
  }

  /** The face to wear when nothing special is happening. */
  setBase(e: Expression): void {
    if (e === this.base) return;
    this.base = e;
    if (this.hold <= 0) this.show(e);
  }

  /** Pull a face for `seconds` (e.g. "ouch" after a bump), then go back to the base. */
  flash(e: Expression, seconds: number): void {
    this.hold = seconds;
    this.show(e);
  }

  update(dt: number): void {
    if (this.hold > 0) {
      this.hold -= dt;
      if (this.hold <= 0) this.show(this.base);
    }
    // Blink every 2–5 s, for ~0.12 s, but only when the eyes are open.
    const eyesOpen = EXPRESSIONS[this.expression].eyes === "open" || EXPRESSIONS[this.expression].eyes === "focus";
    if (this.blinkLeft > 0) {
      this.blinkLeft -= dt;
      if (this.blinkLeft <= 0) this.apply();
    } else if (eyesOpen) {
      this.blinkIn -= dt;
      if (this.blinkIn <= 0) {
        this.blinkIn = 2 + Math.random() * 3;
        this.blinkLeft = 0.12;
        this.eyes.material = eyeMaterial(this.scene, "blink", this.brow);
      }
    }
  }

  private show(e: Expression): void {
    if (e === this.expression) return;
    this.expression = e;
    this.apply();
  }

  private apply(): void {
    const look = EXPRESSIONS[this.expression];
    this.eyes.material = eyeMaterial(this.scene, look.eyes, this.brow);
    this.mouth.material = mouthMaterial(this.scene, look.mouth);
  }
}

// ---------------------------------------------------------------------------
// Arm rig: point an arm at a target (two-bone IK simplified to one bone that stretches a little)
// ---------------------------------------------------------------------------

export class ArmRig {
  private readonly restLength: number;
  constructor(
    readonly pivot: TransformNode, // at the shoulder
    private readonly arm: TransformNode, // stretchy sleeve (scaled along -Y)
    private readonly hand: TransformNode,
    restLength: number,
  ) {
    this.restLength = restLength;
  }

  /**
   * Aim at `target` (upperBody space). The arm hangs along -Y; we roll it
   * sideways (Z) then pitch it forward (X). Babylon applies roll → pitch → yaw,
   * so for a direction d with length L:   sin(roll) = d.x / L,
   *                                       pitch = atan2(-d.z, -d.y).
   */
  reach(target: Vector3): void {
    const d = target.subtract(this.pivot.position);
    const len = Math.max(0.2, d.length());
    const roll = Math.asin(Scalar.Clamp(d.x / len, -1, 1));
    const pitch = Math.atan2(-d.z, -d.y);
    this.pivot.rotation.set(pitch, 0, roll);
    // Allow a little stretch so hands stay on the wheel (squash & stretch is very cartoon anyway).
    const reach = Math.min(len, this.restLength * 1.25);
    this.arm.scaling.y = reach / this.restLength;
    this.hand.position.set(0, -reach, 0);
  }
}

/** The parts other code animates. */
export interface ToddlerParts {
  root: TransformNode;
  upperBody: TransformNode;
  headPivot: TransformNode; // turn this to make the toddler glance around
  capePivot: TransformNode | null; // MrNapTime's little blanket, flaps with speed
  face: FaceRig;
  arms: [ArmRig, ArmRig]; // [toddler's left (+X), toddler's right (−X)]
  shoulder: Vector3; // right-shoulder position (x mirrored for the left)
  meshes: Mesh[]; // every mesh, so the caller can register shadows
}

/**
 * A decal that hugs the head sphere: a small grid whose vertices are pushed
 * onto a sphere of radius HEAD_R + lift. u runs from the viewer's left
 * (toddler's +X) to the viewer's right, so textures read correctly from the front.
 */
function faceDecal(scene: Scene, name: string, cx: number, cy: number, w: number, h: number, lift: number): Mesh {
  const seg = 8;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const r = HEAD_R + lift;
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const v = j / seg;
      const x = cx + (0.5 - u) * w; // u = 0 at +X (viewer's left)
      const y = cy + (v - 0.5) * h; // v = 0 at the bottom
      const dy = y - HEAD_Y;
      const z = Math.sqrt(Math.max(0.0001, r * r - x * x - dy * dy));
      positions.push(x, y, z);
      uvs.push(u, v);
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + seg + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  data.normals = normals;
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh);
  mesh.isPickable = false;
  return mesh;
}

export function buildToddler(scene: Scene, who: RosterEntry, parent: TransformNode): ToddlerParts {
  const tag = `${who.id}-${Math.random().toString(36).slice(2, 6)}`;
  const root = new TransformNode(`toddler-${tag}`, scene);
  root.parent = parent;

  const skinC = hex(who.skinTone);
  const blushC = mix(skinC, hex("#ff6f7d"), 0.55);
  const hairC = who.hairColor;
  const shirtC = who.shirtColor;
  const accent = who.accentColor;
  const gold = "#FFC93A";

  // ---- Hips: legs + diaper (mostly hidden inside the walker) -------------
  const hips = new TransformNode(`hips-${tag}`, scene);
  hips.parent = root;
  const hipsB = new PartBatch(scene, hips, `hips-${tag}`);
  for (const side of [-1, 1]) {
    hipsB.add(MeshBuilder.CreateCapsule("leg", { radius: 0.1, height: 0.52, tessellation: 8, capSubdivisions: 2 }, scene), skinC, "skin", { pos: new Vector3(side * 0.13, 0.42, 0) });
    hipsB.add(MeshBuilder.CreateSphere("foot", { diameterX: 0.2, diameterY: 0.13, diameterZ: 0.3, segments: 8 }, scene), "#ffffff", "cloth", { pos: new Vector3(side * 0.13, 0.16, 0.05) });
  }
  const onesie = who.accessory === "teddy";
  hipsB.add(MeshBuilder.CreateSphere("diaper", { diameterX: 0.6, diameterY: 0.44, diameterZ: 0.52, segments: 10 }, scene), onesie ? shirtC : "#ffffff", "cloth", { pos: new Vector3(0, 0.78, 0) });
  if (who.accessory === "tiara") {
    // Princess Logan: a flared pink tutu with a purple hem.
    hipsB.add(MeshBuilder.CreateCylinder("skirt", { diameterTop: 0.42, diameterBottom: 0.8, height: 0.3, tessellation: 20 }, scene), shirtC, "cloth", { pos: new Vector3(0, 0.86, 0) });
    hipsB.add(MeshBuilder.CreateTorus("hem", { diameter: 0.78, thickness: 0.05, tessellation: 14 }, scene), "#9b5cff", "cloth", { pos: new Vector3(0, 0.72, 0) });
  }
  const meshes = [...hipsB.build()];

  // ---- Upper body ---------------------------------------------------------
  const upperBody = new TransformNode(`upper-${tag}`, scene);
  upperBody.parent = root;
  upperBody.position.y = WAIST_Y;
  const upB = new PartBatch(scene, upperBody, `upper-${tag}`);
  // A rounded, slightly pear-shaped torso (capsules look softer than spheres).
  upB.add(MeshBuilder.CreateCapsule("torso", { radius: 0.27, height: 0.66, tessellation: 12, capSubdivisions: 4 }, scene), shirtC, "cloth", {
    pos: new Vector3(0, 0.24, 0),
    scale: new Vector3(1.05, 1, 0.88),
  });
  // Little neck so the big head doesn't float.
  upB.add(MeshBuilder.CreateCylinder("neck", { diameter: 0.18, height: 0.16, tessellation: 10 }, scene), skinC, "skin", { pos: new Vector3(0, 0.55, 0) });
  if (who.accessory === "headphones") {
    // DJ: orange zipper + drawstrings on the black hoodie.
    upB.add(MeshBuilder.CreateBox("zipper", { width: 0.04, height: 0.42, depth: 0.04 }, scene), accent, "gloss", { pos: new Vector3(0, 0.28, 0.24), rot: new Vector3(0.15, 0, 0) });
    for (const s of [-1, 1]) upB.add(MeshBuilder.CreateCylinder("string", { diameter: 0.025, height: 0.2, tessellation: 5 }, scene), "#ffffff", "cloth", { pos: new Vector3(s * 0.07, 0.38, 0.25) });
  }
  if (who.id === "snacks") {
    upB.add(MeshBuilder.CreateTorus("collar", { diameter: 0.34, thickness: 0.07, tessellation: 12 }, scene), "#FFE566", "cloth", { pos: new Vector3(0, 0.5, 0.02) });
  }
  if (who.id === "adam-the-great") {
    // A tiny gold "A" medal on the chest — he's The Great, after all.
    upB.add(MeshBuilder.CreateCylinder("medal", { diameter: 0.12, height: 0.03, tessellation: 14 }, scene), gold, "metal", { pos: new Vector3(0, 0.34, 0.25), rot: new Vector3(Math.PI / 2, 0, 0) });
  }
  if (who.accessory === "nightcap") {
    // Pajama buttons.
    for (let i = 0; i < 3; i++) upB.add(MeshBuilder.CreateSphere("button", { diameter: 0.05, segments: 6 }, scene), "#FFD24A", "gloss", { pos: new Vector3(0, 0.12 + i * 0.12, 0.25) });
  }

  // ---- Arms (rigged) ------------------------------------------------------
  const sleeve = who.accessory === "headphones" || who.accessory === "teddy" || who.id === "adam-the-great" || who.accessory === "nightcap";
  const ARM_LEN = 0.5;
  const arms: ArmRig[] = [];
  for (const side of [1, -1]) {
    const pivot = new TransformNode(`shoulder${side}-${tag}`, scene);
    pivot.parent = upperBody;
    pivot.position.set(side * SHOULDER.x, SHOULDER.y, SHOULDER.z);
    const armNode = new TransformNode(`arm${side}-${tag}`, scene);
    armNode.parent = pivot;
    const handNode = new TransformNode(`hand${side}-${tag}`, scene);
    handNode.parent = pivot;
    const armB = new PartBatch(scene, armNode, `arm${side}-${tag}`);
    armB.add(MeshBuilder.CreateCapsule("arm", { radius: 0.075, height: ARM_LEN, tessellation: 8, capSubdivisions: 2 }, scene), sleeve ? shirtC : skinC, sleeve ? "cloth" : "skin", {
      pos: new Vector3(0, -ARM_LEN / 2 + 0.03, 0),
    });
    meshes.push(...armB.build());
    const handB = new PartBatch(scene, handNode, `hand${side}-${tag}`);
    handB.add(MeshBuilder.CreateSphere("hand", { diameter: 0.17, segments: 7 }, scene), skinC, "skin");
    // Little thumb so it reads as a mitten-hand gripping the wheel.
    handB.add(MeshBuilder.CreateSphere("thumb", { diameter: 0.07, segments: 6 }, scene), skinC, "skin", { pos: new Vector3(-side * 0.06, 0.03, 0.04) });
    meshes.push(...handB.build());
    const rig = new ArmRig(pivot, armNode, handNode, ARM_LEN);
    rig.reach(pivot.position.add(new Vector3(0, -0.3, 0.4)));
    arms.push(rig);
  }

  // ---- Head ---------------------------------------------------------------
  const headPivot = new TransformNode(`neck-${tag}`, scene);
  headPivot.parent = upperBody;
  headPivot.position.set(0, 0.56, 0);
  const headB = new PartBatch(scene, headPivot, `head-${tag}`);
  // Head sphere with rosy cheeks painted into the vertex colours: each vertex
  // gets more pink the closer it is to a cheek centre (a Gaussian falloff).
  const cheeks = [new Vector3(0.25, HEAD_Y - 0.12, 0.35), new Vector3(-0.25, HEAD_Y - 0.12, 0.35)];
  headB.add(MeshBuilder.CreateSphere("head", { diameter: HEAD_R * 2, segments: 20 }, scene), (p) => {
    let w = 0;
    for (const c of cheeks) w = Math.max(w, Math.exp(-Vector3.DistanceSquared(p, c) / 0.0065));
    return mix(skinC, blushC, w * 0.75);
  }, "skin", { pos: new Vector3(0, HEAD_Y, 0) });
  // Tiny button nose.
  headB.add(MeshBuilder.CreateSphere("nose", { diameterX: 0.06, diameterY: 0.045, diameterZ: 0.04, segments: 8 }, scene), mix(skinC, blushC, 0.25), "skin", {
    pos: new Vector3(0, HEAD_Y - 0.07, HEAD_R - 0.005),
  });
  if (who.accessory !== "headphones" && who.accessory !== "teddy") {
    for (const side of [-1, 1]) {
      headB.add(MeshBuilder.CreateSphere("ear", { diameterX: 0.1, diameterY: 0.16, diameterZ: 0.12, segments: 10 }, scene), mix(skinC, blushC, 0.2), "skin", {
        pos: new Vector3(side * HEAD_R * 0.95, HEAD_Y - 0.04, -0.02),
      });
    }
  }

  // Face decals: eyes (a pair in one texture) and mouth.
  const eyes = faceDecal(scene, `eyes-${tag}`, 0, HEAD_Y + 0.005, 0.68, 0.36, 0.006);
  eyes.parent = headPivot;
  const mouth = faceDecal(scene, `mouth-${tag}`, 0, HEAD_Y - 0.185, 0.28, 0.14, 0.006);
  mouth.parent = headPivot;
  const brow = who.hairStyle === "curly" && who.id === "snacks" ? "#a07a45" : "#2a160c";
  const face = new FaceRig(scene, eyes, mouth, brow);

  // ---- Hair -----------------------------------------------------------------
  if (who.accessory !== "teddy") {
    // A cap of hair: the top part of a slightly bigger sphere, tilted back so
    // the forehead and big eyes stay visible.
    headB.add(MeshBuilder.CreateSphere("hairCap", { diameter: HEAD_R * 2 + 0.06, segments: 14, slice: 0.5 }, scene), hairC, "cloth", {
      pos: new Vector3(0, HEAD_Y + 0.02, -0.03),
      rot: new Vector3(-0.3, 0, 0),
    });
    // Soft bangs: three flattened lobes along the hairline (anime fringe).
    if (who.accessory !== "headphones") {
      for (const [x, s] of [[-0.17, 0.9], [0, 1], [0.17, 0.9]] as const) {
        headB.add(MeshBuilder.CreateSphere("bang", { diameterX: 0.2 * s, diameterY: 0.13, diameterZ: 0.12, segments: 8 }, scene), hairC, "cloth", {
          pos: new Vector3(x, HEAD_Y + 0.3, 0.3),
          rot: new Vector3(-0.5, 0, x * -1.2),
        });
      }
    }
  }
  if (who.hairStyle === "curly") {
    // Tight curls around the crown.
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 0.27 + (i % 3) * 0.02;
      headB.add(MeshBuilder.CreateSphere("curl", { diameter: 0.15 + (i % 2) * 0.03, segments: 5 }, scene), hairC, "cloth", {
        pos: new Vector3(Math.cos(a) * r, HEAD_Y + 0.3 + (i % 3) * 0.03, Math.sin(a) * r * 0.85 - 0.04),
      });
    }
  } else if (who.hairStyle === "puffs") {
    // Two high afro puffs (Princess Logan).
    for (const side of [-1, 1]) {
      headB.add(MeshBuilder.CreateSphere("puff", { diameter: 0.38, segments: 9 }, scene), hairC, "cloth", { pos: new Vector3(side * 0.38, HEAD_Y + 0.32, -0.08) });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        headB.add(MeshBuilder.CreateSphere("puffCurl", { diameter: 0.15, segments: 5 }, scene), hairC, "cloth", {
          pos: new Vector3(side * 0.38 + Math.cos(a) * 0.15, HEAD_Y + 0.32 + Math.sin(a) * 0.11, -0.08 + Math.sin(a * 1.5) * 0.09),
        });
      }
    }
  }

  // ---- Accessories (they match the portraits) -----------------------------
  let capePivot: TransformNode | null = null;
  if (who.accessory === "headphones") {
    // Orange over-ear headphones (a tube band + two cups with dark pads).
    const band: Vector3[] = [];
    for (let i = 0; i <= 18; i++) {
      const a = Math.PI * (i / 18);
      band.push(new Vector3(Math.cos(a) * (HEAD_R + 0.045), HEAD_Y + Math.sin(a) * (HEAD_R + 0.09), -0.02));
    }
    headB.add(MeshBuilder.CreateTube("headband", { path: band, radius: 0.04, tessellation: 10, cap: Mesh.CAP_ALL }, scene), accent, "gloss");
    for (const side of [-1, 1]) {
      headB.add(MeshBuilder.CreateCylinder("earCup", { diameter: 0.32, height: 0.14, tessellation: 14 }, scene), accent, "gloss", {
        pos: new Vector3(side * (HEAD_R + 0.03), HEAD_Y, -0.02),
        rot: new Vector3(0, 0, Math.PI / 2),
      });
      headB.add(MeshBuilder.CreateCylinder("earPad", { diameter: 0.24, height: 0.06, tessellation: 12 }, scene), "#2A2A2A", "cloth", {
        pos: new Vector3(side * (HEAD_R - 0.01), HEAD_Y, -0.02),
        rot: new Vector3(0, 0, Math.PI / 2),
      });
      // Glowing ring on each cup — a little "DJ booth" flair.
      headB.add(MeshBuilder.CreateTorus("cupRing", { diameter: 0.22, thickness: 0.025, tessellation: 10 }, scene), "#ffd27a", "glow", {
        pos: new Vector3(side * (HEAD_R + 0.105), HEAD_Y, -0.02),
        rot: new Vector3(0, 0, Math.PI / 2),
      });
    }
    // Black hoodie hood behind the head with orange lining.
    headB.add(MeshBuilder.CreateSphere("djHood", { diameter: HEAD_R * 2 + 0.16, segments: 12, slice: 0.5 }, scene), shirtC, "cloth", {
      pos: new Vector3(0, HEAD_Y + 0.04, -0.1),
      rot: new Vector3(-0.85, 0, 0),
    });
    headB.add(MeshBuilder.CreateTorus("hoodLining", { diameter: 0.52, thickness: 0.045, tessellation: 12 }, scene), accent, "cloth", {
      pos: new Vector3(0, HEAD_Y + 0.02, -0.12),
      rot: new Vector3(0.9, 0, 0),
    });
  } else if (who.accessory === "crown") {
    addCrown(headB, scene, gold, HEAD_Y + 0.45, 0.21, 0.14, who.id === "adam-the-great" ? "#e3191f" : "#2f8bff");
  } else if (who.accessory === "teddy") {
    // Tan teddy-bear hood with round ears, framing the face like the portrait.
    headB.add(MeshBuilder.CreateSphere("hood", { diameter: HEAD_R * 2 + 0.18, segments: 14, slice: 0.62 }, scene), shirtC, "cloth", {
      pos: new Vector3(0, HEAD_Y + 0.06, -0.06),
      rot: new Vector3(-0.4, 0, 0),
    });
    for (const side of [-1, 0, 1]) {
      headB.add(MeshBuilder.CreateSphere("bangs", { diameter: 0.13, segments: 7 }, scene), hairC, "cloth", { pos: new Vector3(side * 0.14, HEAD_Y + 0.24, 0.3) });
    }
    for (const side of [-1, 1]) {
      headB.add(MeshBuilder.CreateSphere("bearEar", { diameter: 0.25, segments: 8 }, scene), accent, "cloth", { pos: new Vector3(side * 0.3, HEAD_Y + 0.46, -0.08) });
      headB.add(MeshBuilder.CreateSphere("earIn", { diameter: 0.14, segments: 8 }, scene), "#F3D5B0", "cloth", { pos: new Vector3(side * 0.3, HEAD_Y + 0.46, 0.0) });
    }
  } else if (who.accessory === "nightcap") {
    // Floppy purple nightcap with a gold tassel hanging off the tip.
    const capPath: Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      capPath.push(new Vector3(0.04 + t * 0.42, HEAD_Y + 0.46 + t * 0.06 - t * t * 0.5, -0.02 - t * 0.1));
    }
    headB.add(
      MeshBuilder.CreateTube("nightcap", { path: capPath, radius: 0.16, radiusFunction: (i) => 0.2 * (1 - i / 14) + 0.03, tessellation: 10, cap: Mesh.CAP_ALL }, scene),
      shirtC,
      "cloth",
    );
    headB.add(MeshBuilder.CreateTorus("capBrim", { diameter: 0.52, thickness: 0.08, tessellation: 12 }, scene), "#ffffff", "cloth", { pos: new Vector3(0.02, HEAD_Y + 0.36, -0.04) });
    const tip = capPath[capPath.length - 1];
    headB.add(MeshBuilder.CreateTube("tasselCord", { path: [tip, tip.add(new Vector3(0.04, -0.12, -0.04))], radius: 0.014, tessellation: 5 }, scene), gold, "metal");
    headB.add(MeshBuilder.CreateSphere("tassel", { diameter: 0.12, segments: 8 }, scene), gold, "metal", { pos: tip.add(new Vector3(0.05, -0.18, -0.05)) });
    // A soft blanket that flaps with speed (Walker.ts animates capePivot).
    capePivot = new TransformNode(`blanketPivot-${tag}`, scene);
    capePivot.parent = upperBody;
    capePivot.position.set(0, 0.5, -0.2);
    const capeB = new PartBatch(scene, capePivot, `blanket-${tag}`);
    capeB.add(MeshBuilder.CreateBox("blanket", { width: 0.62, height: 0.55, depth: 0.05 }, scene), "#4A2A90", "cloth", { pos: new Vector3(0, -0.28, -0.02) });
    for (let i = 0; i < 4; i++) {
      capeB.add(MeshBuilder.CreateSphere("blanketStar", { diameter: 0.07, segments: 5 }, scene), "#FFD24A", "glow", { pos: new Vector3(-0.2 + i * 0.13, -0.2 - (i % 2) * 0.18, -0.05) });
    }
    meshes.push(...capeB.build());
  } else {
    // Princess Logan: a small gold crown with a pink gem, and a pink bow on a puff.
    addCrown(headB, scene, gold, HEAD_Y + 0.47, 0.16, 0.1, accent);
    for (const side of [-1, 1]) {
      headB.add(MeshBuilder.CreateSphere("bow", { diameterX: 0.17, diameterY: 0.13, diameterZ: 0.06, segments: 8 }, scene), accent, "gloss", {
        pos: new Vector3(0.4 + side * 0.095, HEAD_Y + 0.52, -0.02),
        rot: new Vector3(0, 0, side * 0.45),
      });
    }
    headB.add(MeshBuilder.CreateSphere("bowKnot", { diameter: 0.075, segments: 7 }, scene), accent, "gloss", { pos: new Vector3(0.4, HEAD_Y + 0.52, 0.02) });
  }

  meshes.push(...upB.build(), ...headB.build(), eyes, mouth);

  // Huggie hugs a tiny plush bear on the walker tray (lives on the toddler root).
  if (who.accessory === "teddy") {
    const plush = new TransformNode(`plush-${tag}`, scene);
    plush.parent = root;
    plush.position.set(-0.36, 1.2, 0.6);
    plush.rotation.y = 0.4;
    const pb = new PartBatch(scene, plush, `plush-${tag}`);
    pb.add(MeshBuilder.CreateSphere("plushBody", { diameter: 0.16, segments: 8 }, scene), accent, "cloth");
    pb.add(MeshBuilder.CreateSphere("plushHead", { diameter: 0.12, segments: 8 }, scene), accent, "cloth", { pos: new Vector3(0, 0.1, 0.02) });
    for (const side of [-1, 1]) pb.add(MeshBuilder.CreateSphere("plushEar", { diameter: 0.06, segments: 6 }, scene), accent, "cloth", { pos: new Vector3(side * 0.06, 0.16, 0) });
    pb.add(MeshBuilder.CreateSphere("plushSnout", { diameter: 0.05, segments: 6 }, scene), "#f0d2a8", "cloth", { pos: new Vector3(0, 0.08, 0.06) });
    meshes.push(...pb.build());
  }

  return { root, upperBody, headPivot, capePivot, face, arms: arms as [ArmRig, ArmRig], shoulder: SHOULDER, meshes };
}

/** A pointy gold crown: band + five spikes + jewel balls on the tips + a front gem. */
function addCrown(b: PartBatch, scene: Scene, gold: string, y: number, radius: number, bandH: number, gem: string): void {
  b.add(MeshBuilder.CreateCylinder("crownBand", { diameter: radius * 2, height: bandH, tessellation: 20 }, scene), gold, "metal", {
    pos: new Vector3(0, y, -0.03),
    rot: new Vector3(-0.12, 0, 0),
  });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2; // one point faces forward (+Z)
    const h = i === 0 ? bandH * 1.45 : bandH;
    const p = new Vector3(Math.cos(a) * radius * 0.82, y + bandH / 2 + h / 2 - 0.01, -Math.sin(a) * radius * 0.82 - 0.03);
    b.add(MeshBuilder.CreateCylinder("spike", { diameterTop: 0, diameterBottom: radius * 0.6, height: h, tessellation: 8 }, scene), gold, "metal", { pos: p, rot: new Vector3(-0.1, 0, 0) });
    b.add(MeshBuilder.CreateSphere("tip", { diameter: radius * 0.22, segments: 6 }, scene), "#fff3b0", "metal", { pos: p.add(new Vector3(0, h / 2, 0)) });
  }
  b.add(MeshBuilder.CreateSphere("gem", { diameterX: radius * 0.42, diameterY: radius * 0.42, diameterZ: radius * 0.24, segments: 8 }, scene), gem, "gloss", {
    pos: new Vector3(0, y, radius * 0.98 - 0.03),
  });
}

