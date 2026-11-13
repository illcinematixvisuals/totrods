/**
 * Toddler.ts — builds a chunky, big-headed (chibi) toddler from simple shapes
 * (spheres, cylinders, tubes) using a RosterEntry for colours and accessories.
 *
 * The goal is to read as the same kid as the 2D portraits: big brown eyes,
 * rosy cheeks, a smile, the right hair and outfit, then sit them in a walker.
 * We keep the polygon count modest (low `segments` / `tessellation`) so six
 * of them still run smoothly in split-screen on a phone or a TV.
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
  capePivot: TransformNode | null; // MrNapTime's little blanket, flaps with speed
  meshes: Mesh[]; // every mesh, so the caller can register shadows
}

const HEAD_R = 0.46; // head radius — chibi toddlers are mostly head!

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
  skin.diffuseColor = skinColor.scale(0.86);
  skin.specularColor = new Color3(0.09, 0.07, 0.05);
  skin.emissiveColor = skinColor.scale(0.2);

  const hair = makeMat(scene, `hair-${tag}`, who.hairColor, { specular: 0.1 });
  const shirt = makeMat(scene, `shirt-${tag}`, who.shirtColor, { specular: 0.06 });
  const diaper = makeMat(scene, `diaper-${tag}`, "#ffffff", { specular: 0.05, emissive: 0.1 });
  // Eyes: big brown irises like the portraits (not just black dots).
  const sclera = makeMat(scene, `sclera-${tag}`, "#FFF6EE", { specular: 0.35, emissive: 0.18 });
  const iris = makeMat(scene, `iris-${tag}`, "#6B3A14", { specular: 0.25, emissive: 0.12 });
  const pupil = makeMat(scene, `pupil-${tag}`, "#140C08", { specular: 0.4 });
  const shine = makeMat(scene, `shine-${tag}`, "#ffffff", { emissive: 1 });
  const mouth = makeMat(scene, `mouth-${tag}`, "#8A1F2A", { emissive: 0.2 });
  const cheek = makeMat(scene, `cheek-${tag}`, "#E07A5A", { emissive: 0.22, alpha: 0.55 });
  const accent = makeMat(scene, `accent-${tag}`, who.accentColor, { specular: 0.35, emissive: 0.12 });
  const gold = makeMat(scene, `gold-${tag}`, "#FFD24A", { specular: 0.85, emissive: 0.28 });
  const yellow = makeMat(scene, `yellow-${tag}`, "#FFE566", { specular: 0.2, emissive: 0.12 });

  // Small helper: create, parent, colour, position, remember.
  const add = (m: Mesh, mat: StandardMaterial, pos: Vector3, p: TransformNode = root): Mesh => {
    m.parent = p;
    m.material = mat;
    m.position.copyFrom(pos);
    meshes.push(m);
    return m;
  };

  // --- Body -----------------------------------------------------------------
  // Slightly shorter legs so the oversized head reads as chibi, not a grown-up.
  for (const side of [-1, 1]) {
    add(MeshBuilder.CreateCylinder("leg", { diameter: 0.2, height: 0.5, tessellation: 8 }, scene), skin, new Vector3(side * 0.13, 0.42, 0));
    add(MeshBuilder.CreateSphere("foot", { diameterX: 0.2, diameterY: 0.12, diameterZ: 0.28, segments: 6 }, scene), skin, new Vector3(side * 0.13, 0.16, 0.05));
  }
  const onesie = who.accessory === "teddy";
  add(MeshBuilder.CreateSphere("diaper", { diameterX: 0.58, diameterY: 0.42, diameterZ: 0.5, segments: 10 }, scene), onesie ? shirt : diaper, new Vector3(0, 0.78, 0));
  add(MeshBuilder.CreateSphere("torso", { diameterX: 0.56, diameterY: 0.66, diameterZ: 0.48, segments: 10 }, scene), shirt, new Vector3(0, 1.1, 0));

  // Princess Logan: a little flared pink skirt over the diaper.
  if (who.accessory === "tiara") {
    const skirt = add(MeshBuilder.CreateCylinder("skirt", { diameterTop: 0.42, diameterBottom: 0.72, height: 0.32, tessellation: 12 }, scene), shirt, new Vector3(0, 0.86, 0));
    skirt.rotation.x = 0.05;
  }
  // DJ: orange zipper down the black hoodie. The hood itself sits behind the
  // head (built with the headphones) so we don't put a ring around the neck.
  if (who.accessory === "headphones") {
    const zip = add(MeshBuilder.CreateBox("zipper", { width: 0.04, height: 0.42, depth: 0.04 }, scene), accent, new Vector3(0, 1.14, 0.25));
    zip.rotation.x = 0.15;
  }
  // Snacks: a yellow band across the white top (not a ring around the neck).
  if (who.id === "snacks") {
    const band = add(MeshBuilder.CreateBox("yellowBand", { width: 0.42, height: 0.1, depth: 0.36 }, scene), yellow, new Vector3(0, 1.28, 0.06));
    band.rotation.x = 0.1;
  }

  // Arms run from the shoulder down to the tray. rotation.x tilts the cylinder's
  // axis (Y) toward +Z: angle = atan2(dz, dy).
  const shoulderY = 1.28;
  const hand = new Vector3(0.3, 1.14, 0.46);
  for (const side of [-1, 1]) {
    const dy = hand.y - shoulderY;
    const dz = hand.z;
    const len = Math.hypot(dy, dz);
    // Hoodie / onesie sleeves use the shirt colour; others show skin arms.
    const sleeve = who.accessory === "headphones" || who.accessory === "teddy" || who.id === "adam-the-great" || who.accessory === "nightcap";
    const arm = add(
      MeshBuilder.CreateCylinder("arm", { diameter: 0.16, height: len, tessellation: 8 }, scene),
      sleeve ? shirt : skin,
      new Vector3(side * 0.3, (shoulderY + hand.y) / 2, dz / 2),
    );
    arm.rotation.x = Math.atan2(dz, dy);
    add(MeshBuilder.CreateSphere("hand", { diameter: 0.17, segments: 6 }, scene), skin, new Vector3(side * hand.x, hand.y, hand.z));
  }

  // --- Head -----------------------------------------------------------------
  const headPivot = new TransformNode(`neck-${tag}`, scene);
  headPivot.parent = root;
  headPivot.position.set(0, 1.42, 0);
  const headY = HEAD_R - 0.02; // head centre above the neck
  add(MeshBuilder.CreateSphere("head", { diameter: HEAD_R * 2, segments: 16 }, scene), skin, new Vector3(0, headY, 0), headPivot);
  // Ears sit a little lower and behind the headphones / hood.
  if (who.accessory !== "headphones" && who.accessory !== "teddy") {
    for (const side of [-1, 1]) {
      add(MeshBuilder.CreateSphere("ear", { diameter: 0.16, segments: 6 }, scene), skin, new Vector3(side * HEAD_R * 0.95, headY - 0.02, -0.02), headPivot);
    }
  }

  // Put a feature on the front of the head: given x/y, find z on the sphere surface.
  const onFace = (x: number, y: number, lift = 0.005): Vector3 => {
    const dy = y - headY;
    const z = Math.sqrt(Math.max(0, HEAD_R * HEAD_R - x * x - dy * dy)) + lift;
    return new Vector3(x, y, z);
  };

  // Big brown eyes (white, iris, pupil, highlight) — the portraits all have these,
  // including MrNapTime (wide awake, not sleepy).
  for (const side of [-1, 1]) {
    const eye = onFace(side * 0.155, headY + 0.04, 0);
    add(MeshBuilder.CreateSphere("eyeWhite", { diameterX: 0.18, diameterY: 0.2, diameterZ: 0.1, segments: 8 }, scene), sclera, eye, headPivot);
    add(MeshBuilder.CreateSphere("iris", { diameterX: 0.12, diameterY: 0.13, diameterZ: 0.07, segments: 8 }, scene), iris, eye.add(new Vector3(0, -0.005, 0.03)), headPivot);
    add(MeshBuilder.CreateSphere("pupil", { diameterX: 0.055, diameterY: 0.06, diameterZ: 0.04, segments: 6 }, scene), pupil, eye.add(new Vector3(0, -0.005, 0.055)), headPivot);
    add(MeshBuilder.CreateSphere("eyeShine", { diameter: 0.04, segments: 5 }, scene), shine, eye.add(new Vector3(side * -0.025, 0.04, 0.07)), headPivot);
    add(MeshBuilder.CreateSphere("cheek", { diameterX: 0.14, diameterY: 0.08, diameterZ: 0.05, segments: 6 }, scene), cheek, onFace(side * 0.24, headY - 0.1, 0), headPivot);
  }
  // Smile: a tube following the bottom half of a small arc.
  const smilePath: Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * (1.15 + 0.7 * (i / 10)); // 207°..333° = lower arc
    smilePath.push(onFace(Math.cos(a) * 0.13, headY - 0.08 + Math.sin(a) * 0.08, 0.006));
  }
  add(MeshBuilder.CreateTube("smile", { path: smilePath, radius: 0.02, tessellation: 6, cap: Mesh.CAP_ALL }, scene), mouth, Vector3.Zero(), headPivot);

  // --- Hair -----------------------------------------------------------------
  // `slice` keeps only the top part of a sphere: a perfect hair cap.
  // The teddy hood covers the hair, so we skip the cap there (a few bangs later).
  if (who.accessory !== "teddy") {
    const cap = add(
      MeshBuilder.CreateSphere("hairCap", { diameter: HEAD_R * 2 + 0.06, segments: 12, slice: 0.52 }, scene),
      hair,
      new Vector3(0, headY + 0.02, -0.03),
      headPivot,
    );
    cap.rotation.x = -0.28; // tilt back so the forehead and face stay visible
  }
  if (who.hairStyle === "curly") {
    // Tight curls around the crown. ~12 spheres stays cheap in split-screen.
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 0.26 + (i % 3) * 0.02;
      add(
        MeshBuilder.CreateSphere("curl", { diameter: 0.15 + (i % 2) * 0.02, segments: 5 }, scene),
        hair,
        new Vector3(Math.cos(a) * r, headY + 0.3 + (i % 3) * 0.03, Math.sin(a) * r * 0.85 - 0.04),
        headPivot,
      );
    }
  } else if (who.hairStyle === "puffs") {
    // Two high afro puffs (Princess Logan) made of a big sphere plus a few tighter curls.
    for (const side of [-1, 1]) {
      add(MeshBuilder.CreateSphere("puff", { diameter: 0.36, segments: 8 }, scene), hair, new Vector3(side * 0.38, headY + 0.32, -0.08), headPivot);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        add(MeshBuilder.CreateSphere("puffCurl", { diameter: 0.14, segments: 5 }, scene), hair, new Vector3(side * 0.38 + Math.cos(a) * 0.14, headY + 0.32 + Math.sin(a) * 0.1, -0.08 + Math.sin(a * 1.5) * 0.08), headPivot);
      }
    }
  }

  // --- Accessories ----------------------------------------------------------
  let capePivot: TransformNode | null = null;

  if (who.accessory === "headphones") {
    // Orange over-ear headphones with a music-note badge on the left cup.
    const band: Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = Math.PI * (i / 16);
      band.push(new Vector3(Math.cos(a) * (HEAD_R + 0.04), headY + Math.sin(a) * (HEAD_R + 0.08), -0.02));
    }
    add(MeshBuilder.CreateTube("headband", { path: band, radius: 0.035, tessellation: 8 }, scene), accent, Vector3.Zero(), headPivot);
    const pad = makeMat(scene, `pad-${tag}`, "#2A2A2A", { specular: 0.1 });
    for (const side of [-1, 1]) {
      const cup = add(MeshBuilder.CreateCylinder("earCup", { diameter: 0.3, height: 0.13, tessellation: 12 }, scene), accent, new Vector3(side * (HEAD_R + 0.03), headY, -0.02), headPivot);
      cup.rotation.z = Math.PI / 2;
      const inner = add(MeshBuilder.CreateCylinder("earPad", { diameter: 0.22, height: 0.05, tessellation: 12 }, scene), pad, new Vector3(side * (HEAD_R - 0.01), headY, -0.02), headPivot);
      inner.rotation.z = Math.PI / 2;
    }
    // Black hoodie hood behind the head, with a hint of orange lining.
    const hoodMat = makeMat(scene, `djHood-${tag}`, who.shirtColor, { specular: 0.06, emissive: 0.05 });
    const hood = add(MeshBuilder.CreateSphere("djHood", { diameter: HEAD_R * 2 + 0.16, segments: 12, slice: 0.5 }, scene), hoodMat, new Vector3(0, headY + 0.04, -0.1), headPivot);
    hood.rotation.x = -0.85;
    const lining = add(MeshBuilder.CreateTorus("hoodLining", { diameter: 0.5, thickness: 0.04, tessellation: 12 }, scene), accent, new Vector3(0, headY + 0.02, -0.12), headPivot);
    lining.rotation.x = 0.9;
    // Music note on the left cup (a stem, a flag, and a round note-head).
    const noteRoot = new TransformNode(`note-${tag}`, scene);
    noteRoot.parent = headPivot;
    noteRoot.position.set(-(HEAD_R + 0.11), headY - 0.02, 0.04);
    noteRoot.rotation.y = -Math.PI / 2;
    add(MeshBuilder.CreateSphere("noteHead", { diameter: 0.07, segments: 6 }, scene), accent, new Vector3(0, -0.04, 0), noteRoot);
    const stem = add(MeshBuilder.CreateCylinder("noteStem", { diameter: 0.016, height: 0.12, tessellation: 6 }, scene), accent, new Vector3(0.02, 0.03, 0), noteRoot);
    stem.rotation.z = -0.15;
    const flag = add(MeshBuilder.CreateBox("noteFlag", { width: 0.07, height: 0.03, depth: 0.02 }, scene), accent, new Vector3(0.05, 0.08, 0), noteRoot);
    flag.rotation.z = 0.4;
  } else if (who.accessory === "crown") {
    // Pointy gold crown (Adam The Great and Snacks). No cape — the portraits don't have one.
    const ring = add(MeshBuilder.CreateCylinder("crown", { diameter: 0.42, height: 0.14, tessellation: 12 }, scene), gold, new Vector3(0, headY + 0.4, -0.03), headPivot);
    ring.rotation.x = -0.12;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2; // one point faces forward
      const spike = add(
        MeshBuilder.CreateCylinder("spike", { diameterTop: 0, diameterBottom: 0.11, height: i === 0 ? 0.2 : 0.14, tessellation: 5 }, scene),
        gold,
        new Vector3(Math.cos(a) * 0.17, headY + (i === 0 ? 0.56 : 0.52), Math.sin(a) * 0.17 - 0.03),
        headPivot,
      );
      spike.rotation.x = -0.1;
    }
  } else if (who.accessory === "teddy") {
    // Tan teddy-bear hood with round ears, framing the face like the portrait.
    const hood = makeMat(scene, `hood-${tag}`, who.shirtColor, { specular: 0.08, emissive: 0.1 });
    const fur = makeMat(scene, `fur-${tag}`, who.accentColor, { specular: 0.08, emissive: 0.08 });
    const innerEar = makeMat(scene, `earIn-${tag}`, "#F3D5B0", { specular: 0.08, emissive: 0.12 });
    const hoodCap = add(MeshBuilder.CreateSphere("hood", { diameter: HEAD_R * 2 + 0.18, segments: 12, slice: 0.62 }, scene), hood, new Vector3(0, headY + 0.06, -0.06), headPivot);
    hoodCap.rotation.x = -0.4;
    // Bangs / little curls peeking out at the forehead.
    for (const side of [-1, 0, 1]) {
      add(MeshBuilder.CreateSphere("bangs", { diameter: 0.12, segments: 5 }, scene), hair, new Vector3(side * 0.14, headY + 0.22, 0.28), headPivot);
    }
    for (const side of [-1, 1]) {
      add(MeshBuilder.CreateSphere("bearEar", { diameter: 0.24, segments: 8 }, scene), fur, new Vector3(side * 0.3, headY + 0.46, -0.08), headPivot);
      add(MeshBuilder.CreateSphere("earIn", { diameter: 0.13, segments: 6 }, scene), innerEar, new Vector3(side * 0.3, headY + 0.46, 0.02), headPivot);
    }
    // Tiny plush bear sitting on the left side of the play tray (held close).
    const plush = new TransformNode(`plush-${tag}`, scene);
    plush.parent = root;
    plush.position.set(-0.28, 1.22, 0.62);
    plush.rotation.y = 0.4;
    add(MeshBuilder.CreateSphere("plushBody", { diameter: 0.16, segments: 6 }, scene), fur, new Vector3(0, 0, 0), plush);
    add(MeshBuilder.CreateSphere("plushHead", { diameter: 0.12, segments: 6 }, scene), fur, new Vector3(0, 0.1, 0.02), plush);
    for (const side of [-1, 1]) add(MeshBuilder.CreateSphere("plushEar", { diameter: 0.06, segments: 5 }, scene), fur, new Vector3(side * 0.06, 0.16, 0), plush);
    const snout = makeMat(scene, `snout-${tag}`, "#f0d2a8", { specular: 0.1, emissive: 0.1 });
    add(MeshBuilder.CreateSphere("plushSnout", { diameter: 0.05, segments: 5 }, scene), snout, new Vector3(0, 0.08, 0.06), plush);
  } else if (who.accessory === "nightcap") {
    // Floppy purple nightcap with a gold tassel hanging off the tip.
    const capMat = makeMat(scene, `napcap-${tag}`, who.shirtColor, { specular: 0.08, emissive: 0.12 });
    // A bent path: up from the crown, then droops down to the right so the
    // cap and tassel are visible from the front (as in the portrait).
    const capPath: Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      capPath.push(new Vector3(0.04 + t * 0.42, headY + 0.46 + t * 0.06 - t * t * 0.5, -0.02 - t * 0.1));
    }
    add(MeshBuilder.CreateTube("nightcap", { path: capPath, radius: 0.16, radiusFunction: (i) => 0.2 * (1 - i / 12) + 0.03, tessellation: 10, cap: Mesh.CAP_ALL }, scene), capMat, Vector3.Zero(), headPivot);
    // Brim around the hairline.
    add(MeshBuilder.CreateTorus("capBrim", { diameter: 0.5, thickness: 0.07, tessellation: 12 }, scene), capMat, new Vector3(0.02, headY + 0.36, -0.04), headPivot);
    // Gold tassel: a short string, then a tuft of little spheres.
    const tip = capPath[capPath.length - 1];
    const tasselPath = [tip, tip.add(new Vector3(0.04, -0.12, -0.04)), tip.add(new Vector3(0.05, -0.2, -0.05))];
    add(MeshBuilder.CreateTube("tasselCord", { path: tasselPath, radius: 0.012, tessellation: 5, cap: Mesh.CAP_ALL }, scene), gold, Vector3.Zero(), headPivot);
    const tuft = tasselPath[2];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(MeshBuilder.CreateSphere("tasselTuft", { diameter: 0.05, segments: 5 }, scene), gold, tuft.add(new Vector3(Math.cos(a) * 0.03, -0.02, Math.sin(a) * 0.03)), headPivot);
    }
    // A soft blanket that can flap with speed (Walker.ts reads capePivot).
    capePivot = new TransformNode(`blanketPivot-${tag}`, scene);
    capePivot.parent = root;
    capePivot.position.set(0, 1.36, -0.2);
    const blanket = makeMat(scene, `blanket-${tag}`, "#4A2A90", { specular: 0.08, emissive: 0.08 });
    add(MeshBuilder.CreateBox("blanket", { width: 0.62, height: 0.55, depth: 0.05 }, scene), blanket, new Vector3(0, -0.28, -0.02), capePivot);
  } else {
    // Princess Logan: a small gold crown (not just a thin tiara) with a pink
    // gem in front, plus a pink bow on the right puff — matching the portrait.
    const ring = add(MeshBuilder.CreateCylinder("loganCrown", { diameter: 0.34, height: 0.1, tessellation: 12 }, scene), gold, new Vector3(0, headY + 0.36, -0.02), headPivot);
    ring.rotation.x = -0.15;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      add(
        MeshBuilder.CreateCylinder("loganSpike", { diameterTop: 0, diameterBottom: 0.08, height: i === 0 ? 0.16 : 0.1, tessellation: 5 }, scene),
        gold,
        new Vector3(Math.cos(a) * 0.14, headY + (i === 0 ? 0.5 : 0.46), Math.sin(a) * 0.12 - 0.02),
        headPivot,
      );
    }
    add(MeshBuilder.CreateSphere("tiaraGem", { diameterX: 0.08, diameterY: 0.08, diameterZ: 0.05, segments: 6 }, scene), accent, new Vector3(0, headY + 0.42, 0.18), headPivot);
    // Bow on the right puff.
    for (const side of [-1, 1]) {
      const loop = add(MeshBuilder.CreateSphere("bow", { diameterX: 0.16, diameterY: 0.12, diameterZ: 0.05, segments: 5 }, scene), accent, new Vector3(0.4 + side * 0.09, headY + 0.5, -0.04), headPivot);
      loop.rotation.z = side * 0.45;
    }
    add(MeshBuilder.CreateSphere("bowKnot", { diameter: 0.07, segments: 5 }, scene), accent, new Vector3(0.4, headY + 0.5, 0.0), headPivot);
  }

  return { root, headPivot, capePivot, meshes };
}
