/**
 * Toddler.ts — builds a chunky, big-headed toddler from simple shapes
 * (spheres, cylinders, tubes) using a RosterEntry for colours and accessories.
 *
 * Babylon.js concepts:
 *  - MeshBuilder.CreateSphere / CreateCylinder / CreateTube: primitive shapes.
 *  - Parenting: the head is a child of `headPivot` (at the neck), so rotating
 *    the pivot turns the whole head — eyes, hair, crown and all.
 *  - The toddler faces +Z (Babylon's "forward").
 */
import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { makeMat } from "./Materials";
import type { RosterEntry } from "./Roster";

/** The parts other code wants to animate. */
export interface ToddlerParts {
  root: TransformNode;
  headPivot: TransformNode; // turn this to make the toddler glance around
  capePivot: TransformNode | null; // Adam's cape or MrNapTime's blanket
  meshes: Mesh[]; // every mesh, so the caller can register shadows
}

const HEAD_R = 0.4; // head radius — toddlers are mostly head!

export function buildToddler(scene: Scene, who: RosterEntry, parent: TransformNode): ToddlerParts {
  const root = new TransformNode(`toddler-${who.id}`, scene);
  root.parent = parent;
  const meshes: Mesh[] = [];
  const tag = `${who.id}-${Math.random().toString(36).slice(2, 6)}`; // unique material names

  // Skin: soft highlight + a little self-glow so warm brown tones stay readable
  // indoors and never turn muddy grey in shadow. Diffuse is scaled down a bit
  // because the room lights add up to more than 1.0 on lit faces.
  const skinColor = Color3.FromHexString(who.skinTone);
  const skin = new StandardMaterial(`skin-${tag}`, scene);
  skin.diffuseColor = skinColor.scale(0.82);
  skin.specularColor = new Color3(0.07, 0.05, 0.04);
  skin.emissiveColor = skinColor.scale(0.22);

  const hair = makeMat(scene, `hair-${tag}`, who.hairColor, { specular: 0.12 });
  const shirt = makeMat(scene, `shirt-${tag}`, who.shirtColor, { specular: 0.05 });
  const diaper = makeMat(scene, `diaper-${tag}`, "#ffffff", { specular: 0.05, emissive: 0.1 });
  const eyeMat = makeMat(scene, `eye-${tag}`, "#120c08", { specular: 0.8 });
  const shine = makeMat(scene, `shine-${tag}`, "#ffffff", { emissive: 1 });
  const mouth = makeMat(scene, `mouth-${tag}`, "#8a1f2a", { emissive: 0.2 });
  const cheek = makeMat(scene, `cheek-${tag}`, "#d9714f", { emissive: 0.15, alpha: 0.4 }); // subtle warm blush
  const accent = makeMat(scene, `accent-${tag}`, who.accentColor, { specular: 0.3, emissive: 0.1 });
  const gold = makeMat(scene, `gold-${tag}`, "#ffcc33", { specular: 0.9, emissive: 0.25 });

  // Small helper: create, parent, colour, position, remember.
  const add = (m: Mesh, mat: StandardMaterial, pos: Vector3, p: TransformNode = root): Mesh => {
    m.parent = p;
    m.material = mat;
    m.position.copyFrom(pos);
    meshes.push(m);
    return m;
  };

  // --- Body -----------------------------------------------------------------
  for (const side of [-1, 1]) {
    add(MeshBuilder.CreateCylinder("leg", { diameter: 0.2, height: 0.55, tessellation: 8 }, scene), skin, new Vector3(side * 0.13, 0.45, 0));
    add(MeshBuilder.CreateSphere("foot", { diameterX: 0.2, diameterY: 0.12, diameterZ: 0.28, segments: 6 }, scene), skin, new Vector3(side * 0.13, 0.17, 0.05));
  }
  add(MeshBuilder.CreateSphere("diaper", { diameterX: 0.58, diameterY: 0.42, diameterZ: 0.5, segments: 10 }, scene), who.accessory === "teddy" ? shirt : diaper, new Vector3(0, 0.8, 0));
  add(MeshBuilder.CreateSphere("torso", { diameterX: 0.56, diameterY: 0.66, diameterZ: 0.46, segments: 10 }, scene), shirt, new Vector3(0, 1.12, 0));

  // Arms run from the shoulder down to the tray. rotation.x tilts the cylinder's
  // axis (Y) toward +Z: angle = atan2(dz, dy).
  const shoulderY = 1.3;
  const hand = new Vector3(0.3, 1.16, 0.46);
  for (const side of [-1, 1]) {
    const dy = hand.y - shoulderY;
    const dz = hand.z;
    const len = Math.hypot(dy, dz);
    const arm = add(
      MeshBuilder.CreateCylinder("arm", { diameter: 0.15, height: len, tessellation: 8 }, scene),
      skin,
      new Vector3(side * 0.3, (shoulderY + hand.y) / 2, dz / 2),
    );
    arm.rotation.x = Math.atan2(dz, dy);
    add(MeshBuilder.CreateSphere("hand", { diameter: 0.17, segments: 6 }, scene), skin, new Vector3(side * hand.x, hand.y, hand.z));
  }

  // --- Head -----------------------------------------------------------------
  const headPivot = new TransformNode(`neck-${tag}`, scene);
  headPivot.parent = root;
  headPivot.position.set(0, 1.45, 0);
  const headY = HEAD_R - 0.02; // head centre above the neck
  add(MeshBuilder.CreateSphere("head", { diameter: HEAD_R * 2, segments: 16 }, scene), skin, new Vector3(0, headY, 0), headPivot);
  for (const side of [-1, 1]) {
    add(MeshBuilder.CreateSphere("ear", { diameter: 0.17, segments: 6 }, scene), skin, new Vector3(side * HEAD_R * 0.97, headY, 0), headPivot);
  }

  // Put a feature on the front of the head: given x/y, find z on the sphere surface.
  const onFace = (x: number, y: number, lift = 0.005): Vector3 => {
    const dy = y - headY;
    const z = Math.sqrt(Math.max(0, HEAD_R * HEAD_R - x * x - dy * dy)) + lift;
    return new Vector3(x, y, z);
  };
  const sleepy = who.accessory === "nightcap";
  for (const side of [-1, 1]) {
    const eye = onFace(side * 0.14, headY + 0.05, -0.02);
    if (sleepy) {
      // Half-closed lids: a thin eye slit plus a skin-coloured lid over the top.
      add(MeshBuilder.CreateSphere("eye", { diameterX: 0.11, diameterY: 0.05, diameterZ: 0.06, segments: 8 }, scene), eyeMat, eye, headPivot);
      const lid = add(MeshBuilder.CreateSphere("lid", { diameterX: 0.13, diameterY: 0.08, diameterZ: 0.07, slice: 0.5, segments: 8 }, scene), skin, eye.add(new Vector3(0, 0.03, 0.01)), headPivot);
      lid.rotation.x = Math.PI; // dome covers the top of the eye
    } else {
      add(MeshBuilder.CreateSphere("eye", { diameterX: 0.11, diameterY: 0.14, diameterZ: 0.08, segments: 8 }, scene), eyeMat, eye, headPivot);
      add(MeshBuilder.CreateSphere("eyeShine", { diameter: 0.04, segments: 4 }, scene), shine, eye.add(new Vector3(0.02, 0.03, 0.035)), headPivot);
    }
    add(MeshBuilder.CreateSphere("cheek", { diameterX: 0.12, diameterY: 0.07, diameterZ: 0.04, segments: 6 }, scene), cheek, onFace(side * 0.22, headY - 0.09, -0.01), headPivot);
  }
  // Smile: a tube following the bottom half of a small arc.
  const smilePath: Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * (1.15 + 0.7 * (i / 10)); // 207°..333° = lower arc
    smilePath.push(onFace(Math.cos(a) * 0.12, headY - 0.06 + Math.sin(a) * 0.07, 0.004));
  }
  add(MeshBuilder.CreateTube("smile", { path: smilePath, radius: 0.018, tessellation: 6, cap: Mesh.CAP_ALL }, scene), mouth, Vector3.Zero(), headPivot);

  // --- Hair -----------------------------------------------------------------
  // `slice` keeps only the top part of a sphere: a perfect hair cap.
  const cap = add(
    MeshBuilder.CreateSphere("hairCap", { diameter: HEAD_R * 2 + 0.05, segments: 14, slice: 0.5 }, scene),
    hair,
    new Vector3(0, headY + 0.02, -0.03),
    headPivot,
  );
  cap.rotation.x = -0.3; // tilt back so the forehead and face stay visible
  if (who.hairStyle === "curly") {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      add(MeshBuilder.CreateSphere("curl", { diameter: 0.16, segments: 5 }, scene), hair, new Vector3(Math.cos(a) * 0.22, headY + 0.33, Math.sin(a) * 0.2 - 0.05), headPivot);
    }
  } else if (who.hairStyle === "puffs") {
    for (const side of [-1, 1]) {
      add(MeshBuilder.CreateSphere("puff", { diameter: 0.34, segments: 8 }, scene), hair, new Vector3(side * 0.36, headY + 0.28, -0.08), headPivot);
    }
  }

  // --- Accessories ----------------------------------------------------------
  let capePivot: TransformNode | null = null;
  if (who.accessory === "headphones") {
    const band: Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = Math.PI * (i / 16);
      band.push(new Vector3(Math.cos(a) * (HEAD_R + 0.05), headY + Math.sin(a) * (HEAD_R + 0.07), -0.02));
    }
    add(MeshBuilder.CreateTube("headband", { path: band, radius: 0.035, tessellation: 8 }, scene), accent, Vector3.Zero(), headPivot);
    for (const side of [-1, 1]) {
      const cup = add(MeshBuilder.CreateCylinder("earCup", { diameter: 0.26, height: 0.12, tessellation: 12 }, scene), accent, new Vector3(side * (HEAD_R + 0.04), headY, -0.02), headPivot);
      cup.rotation.z = Math.PI / 2;
    }
  } else if (who.accessory === "crown") {
    const ring = add(MeshBuilder.CreateCylinder("crown", { diameter: 0.4, height: 0.13, tessellation: 14 }, scene), gold, new Vector3(0, headY + 0.4, -0.04), headPivot);
    ring.rotation.x = -0.15;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(MeshBuilder.CreateCylinder("spike", { diameterTop: 0, diameterBottom: 0.09, height: 0.14, tessellation: 5 }, scene), gold, new Vector3(Math.cos(a) * 0.17, headY + 0.52, Math.sin(a) * 0.17 - 0.04), headPivot);
    }
    add(MeshBuilder.CreateSphere("gem", { diameter: 0.07, segments: 5 }, scene), accent, new Vector3(0, headY + 0.4, 0.17), headPivot);
    // The cape hangs from a pivot at the shoulders so it can flap back with speed.
    capePivot = new TransformNode(`capePivot-${tag}`, scene);
    capePivot.parent = root;
    capePivot.position.set(0, 1.38, -0.2);
    add(MeshBuilder.CreateBox("cape", { width: 0.62, height: 0.85, depth: 0.04 }, scene), accent, new Vector3(0, -0.42, -0.02), capePivot);
  } else if (who.accessory === "teddy") {
    // Teddy-bear hood: a soft cap plus round ears, and a tiny plush on the tray.
    const hood = makeMat(scene, `hood-${tag}`, who.shirtColor, { specular: 0.08, emissive: 0.08 });
    const fur = makeMat(scene, `fur-${tag}`, who.accentColor, { specular: 0.08, emissive: 0.08 });
    const snout = makeMat(scene, `snout-${tag}`, "#f0d2a8", { specular: 0.1, emissive: 0.1 });
    const hoodCap = add(MeshBuilder.CreateSphere("hood", { diameter: HEAD_R * 2 + 0.12, segments: 14, slice: 0.58 }, scene), hood, new Vector3(0, headY + 0.04, -0.04), headPivot);
    hoodCap.rotation.x = -0.35;
    for (const side of [-1, 1]) {
      add(MeshBuilder.CreateSphere("bearEar", { diameter: 0.2, segments: 8 }, scene), fur, new Vector3(side * 0.28, headY + 0.42, -0.06), headPivot);
      add(MeshBuilder.CreateSphere("earIn", { diameter: 0.11, segments: 6 }, scene), snout, new Vector3(side * 0.28, headY + 0.42, 0.02), headPivot);
    }
    // Tiny plush bear sitting on the left side of the play tray (held close).
    const plush = new TransformNode(`plush-${tag}`, scene);
    plush.parent = root;
    plush.position.set(-0.28, 1.22, 0.62);
    plush.rotation.y = 0.4;
    add(MeshBuilder.CreateSphere("plushBody", { diameter: 0.16, segments: 6 }, scene), fur, new Vector3(0, 0, 0), plush);
    add(MeshBuilder.CreateSphere("plushHead", { diameter: 0.12, segments: 6 }, scene), fur, new Vector3(0, 0.1, 0.02), plush);
    for (const side of [-1, 1]) add(MeshBuilder.CreateSphere("plushEar", { diameter: 0.06, segments: 5 }, scene), fur, new Vector3(side * 0.06, 0.16, 0), plush);
    add(MeshBuilder.CreateSphere("plushSnout", { diameter: 0.05, segments: 5 }, scene), snout, new Vector3(0, 0.08, 0.06), plush);
  } else if (who.accessory === "chef") {
    // Cereal-puff / cracker crown, a crumb-covered bib, and a snack cup on the tray.
    const cracker = makeMat(scene, `cracker-${tag}`, "#e8b04a", { specular: 0.15, emissive: 0.1 });
    const puff = makeMat(scene, `puff-${tag}`, "#f4e0a8", { specular: 0.1, emissive: 0.12 });
    const bib = makeMat(scene, `bib-${tag}`, "#fff8ee", { specular: 0.05, emissive: 0.08 });
    const crumb = makeMat(scene, `crumb-${tag}`, "#c9893a", { specular: 0.05, emissive: 0.05 });
    const cupMat = makeMat(scene, `cup-${tag}`, who.accentColor, { specular: 0.3, emissive: 0.1 });
    const straw = makeMat(scene, `straw-${tag}`, "#2f8bff", { specular: 0.2, emissive: 0.1 });
    // Crown of alternating crackers and cereal puffs.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = Math.cos(a) * 0.22;
      const z = Math.sin(a) * 0.18 - 0.04;
      if (i % 2 === 0) {
        const c = add(MeshBuilder.CreateBox("cracker", { width: 0.1, height: 0.16, depth: 0.03 }, scene), cracker, new Vector3(x, headY + 0.44, z), headPivot);
        c.rotation.y = a;
        c.rotation.x = -0.2;
      } else {
        add(MeshBuilder.CreateSphere("cereal", { diameter: 0.1, segments: 5 }, scene), puff, new Vector3(x, headY + 0.46, z), headPivot);
      }
    }
    const bibMesh = add(MeshBuilder.CreateBox("bib", { width: 0.32, height: 0.34, depth: 0.04 }, scene), bib, new Vector3(0, 1.18, 0.24));
    bibMesh.rotation.x = 0.25;
    for (let i = 0; i < 6; i++) {
      add(MeshBuilder.CreateSphere("crumb", { diameter: 0.03, segments: 4 }, scene), crumb, new Vector3((i % 3) * 0.07 - 0.07, 1.22 + (i % 2) * 0.06, 0.27));
    }
    // Snack cup on the right of the play tray.
    add(MeshBuilder.CreateCylinder("cup", { diameter: 0.14, height: 0.16, tessellation: 10 }, scene), cupMat, new Vector3(0.28, 1.22, 0.66));
    const strawM = add(MeshBuilder.CreateCylinder("straw", { diameter: 0.025, height: 0.18, tessellation: 6 }, scene), straw, new Vector3(0.28, 1.34, 0.66));
    strawM.rotation.z = 0.25;
  } else if (who.accessory === "nightcap") {
    // Nightcap with a pom-pom, and a tiny blanket cape that flaps with speed.
    const capMat = makeMat(scene, `napcap-${tag}`, who.shirtColor, { specular: 0.08, emissive: 0.1 });
    const pom = makeMat(scene, `pom-${tag}`, who.accentColor, { specular: 0.2, emissive: 0.2 });
    const blanket = makeMat(scene, `blanket-${tag}`, "#2a1f6e", { specular: 0.08, emissive: 0.08 });
    const cone = add(MeshBuilder.CreateCylinder("nightcap", { diameterTop: 0.02, diameterBottom: 0.42, height: 0.5, tessellation: 12 }, scene), capMat, new Vector3(0.08, headY + 0.48, -0.12), headPivot);
    cone.rotation.z = -0.55;
    cone.rotation.x = -0.35;
    add(MeshBuilder.CreateSphere("pom", { diameter: 0.12, segments: 6 }, scene), pom, new Vector3(0.28, headY + 0.7, -0.26), headPivot);
    capePivot = new TransformNode(`blanketPivot-${tag}`, scene);
    capePivot.parent = root;
    capePivot.position.set(0, 1.38, -0.2);
    add(MeshBuilder.CreateBox("blanket", { width: 0.7, height: 0.7, depth: 0.05 }, scene), blanket, new Vector3(0, -0.35, -0.02), capePivot);
    // A couple of star badges on the pajamas.
    const star = makeMat(scene, `pjstar-${tag}`, who.accentColor, { specular: 0.4, emissive: 0.3 });
    add(MeshBuilder.CreateSphere("pjStar", { diameter: 0.08, segments: 5 }, scene), star, new Vector3(-0.14, 1.18, 0.22));
    add(MeshBuilder.CreateSphere("pjMoon", { diameter: 0.07, segments: 5 }, scene), star, new Vector3(0.14, 1.08, 0.22));
  } else {
    // Tiara: a golden arc across the front of the hair, with a pink gem.
    const arc: Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = Math.PI * (0.2 + 0.6 * (i / 12));
      arc.push(new Vector3(Math.cos(a) * 0.3, headY + 0.3 + Math.sin(a) * 0.06, Math.sin(a) * 0.2 + 0.02));
    }
    add(MeshBuilder.CreateTube("tiara", { path: arc, radius: 0.025, tessellation: 6 }, scene), gold, Vector3.Zero(), headPivot);
    add(MeshBuilder.CreateSphere("tiaraGem", { diameterX: 0.08, diameterY: 0.12, diameterZ: 0.05, segments: 5 }, scene), accent, new Vector3(0, headY + 0.42, 0.22), headPivot);
    // Bow on the right puff.
    for (const side of [-1, 1]) {
      const loop = add(MeshBuilder.CreateSphere("bow", { diameterX: 0.16, diameterY: 0.12, diameterZ: 0.05, segments: 5 }, scene), accent, new Vector3(0.36 + side * 0.09, headY + 0.48, -0.08), headPivot);
      loop.rotation.z = side * 0.4;
    }
  }

  return { root, headPivot, capePivot, meshes };
}
