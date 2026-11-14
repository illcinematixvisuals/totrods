/**
 * Kart.ts — each toddler's racing walker: half baby-walker (padded tray ring,
 * toy buttons, the toddler standing in the seat) and half cartoon kart (glossy
 * candy-paint tub, chunky wheels, spoiler, twin exhausts, headlights).
 *
 * Every kart is unique to its driver:
 *  - paint + trim + stripe colours from the roster,
 *  - an emblem on the nose (♪ for DJ, crown for Adam, heart for Logan,
 *    paw for Huggie, cookie for Snacks, moon for MrNapTime),
 *  - a name board on the back you can read from the chase camera,
 *  - one themed extra (speakers, crown ornament, heart, bear ears, cookie, stars).
 * To customise a kart, change its colours/emblem in Roster.ts or KART_THEMES below.
 *
 * Hierarchy (built here, animated by Walker.ts):
 *   lift ─┬─ wheel nodes (front ones inside a steer pivot)  → spin on rotation.x
 *         └─ body (suspension)  → shell, tray, dash, steering wheel, emitters
 */
import { Color3, DynamicTexture, Material, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { hex, mix, PartBatch } from "./ModelKit";
import type { RosterEntry } from "./Roster";

export const WHEEL_RADIUS = 0.26;

type Emblem = "note" | "crown" | "heart" | "paw" | "cookie" | "moon";

interface KartTheme {
  emblem: Emblem;
  board: string; // text on the back board
  number: number;
}

/** Per-character kart themes. Change these to customise a kart. */
export const KART_THEMES: Record<string, KartTheme> = {
  "dj-the-dasher": { emblem: "note", board: "DJ", number: 1 },
  "adam-the-great": { emblem: "crown", board: "ADAM", number: 2 },
  "princess-logan": { emblem: "heart", board: "LOGAN", number: 3 },
  huggie: { emblem: "paw", board: "HUGGIE", number: 4 },
  snacks: { emblem: "cookie", board: "SNACKS", number: 5 },
  "mr-nap-time": { emblem: "moon", board: "NAPTIME", number: 6 },
};

export interface WheelRig {
  steer: TransformNode | null; // front wheels turn left/right
  spin: TransformNode; // rotation.x = rolling
}

export interface KartParts {
  lift: TransformNode;
  body: TransformNode;
  wheels: WheelRig[];
  steeringSpin: TransformNode; // the toy steering wheel (rotation.y = turn)
  steeringCenter: Vector3; // body-space centre of the steering wheel
  steeringTilt: number; // radians the wheel leans back toward the toddler
  exhausts: Mesh[]; // invisible emitter points for boost flames
  rearWheels: Mesh[]; // invisible emitter points for drift smoke and sparks
  meshes: Mesh[];
  ownMaterials: StandardMaterial[]; // materials only this kart uses (dispose with it)
}

/** Paint an emblem into a 2D context centred at (cx, cy) with size s. */
function paintEmblem(ctx: CanvasRenderingContext2D, emblem: Emblem, cx: number, cy: number, s: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color;
  ctx.strokeStyle = "#13235b";
  ctx.lineWidth = s * 0.08;
  ctx.lineJoin = "round";
  ctx.beginPath();
  switch (emblem) {
    case "note":
      ctx.ellipse(-s * 0.18, s * 0.25, s * 0.2, s * 0.15, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillRect(-s * 0.03, -s * 0.42, s * 0.08, s * 0.65);
      ctx.beginPath();
      ctx.moveTo(s * 0.04, -s * 0.42);
      ctx.quadraticCurveTo(s * 0.4, -s * 0.3, s * 0.3, s * 0.0);
      ctx.lineWidth = s * 0.08;
      ctx.strokeStyle = color;
      ctx.stroke();
      break;
    case "crown":
      ctx.moveTo(-s * 0.42, s * 0.3);
      ctx.lineTo(-s * 0.42, -s * 0.2);
      ctx.lineTo(-s * 0.2, s * 0.05);
      ctx.lineTo(0, -s * 0.38);
      ctx.lineTo(s * 0.2, s * 0.05);
      ctx.lineTo(s * 0.42, -s * 0.2);
      ctx.lineTo(s * 0.42, s * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    case "heart":
      ctx.moveTo(0, s * 0.38);
      ctx.bezierCurveTo(-s * 0.55, 0, -s * 0.35, -s * 0.45, 0, -s * 0.18);
      ctx.bezierCurveTo(s * 0.35, -s * 0.45, s * 0.55, 0, 0, s * 0.38);
      ctx.fill();
      ctx.stroke();
      break;
    case "paw":
      ctx.ellipse(0, s * 0.15, s * 0.24, s * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      for (const [x, y] of [[-0.28, -0.12], [-0.1, -0.3], [0.1, -0.3], [0.28, -0.12]]) {
        ctx.beginPath();
        ctx.arc(x * s, y * s, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      break;
    case "cookie":
      ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#5a3416";
      for (const [x, y] of [[-0.15, -0.12], [0.14, -0.18], [0.02, 0.1], [-0.2, 0.15], [0.2, 0.14]]) {
        ctx.beginPath();
        ctx.arc(x * s, y * s, s * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case "moon":
      ctx.arc(0, 0, s * 0.38, 0.6, Math.PI * 2 - 0.6, false);
      ctx.arc(s * 0.16, -s * 0.06, s * 0.3, Math.PI * 2 - 0.9, 0.9, true);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
  }
  ctx.restore();
}

/** A textured decal plane (name board, nose badge). Planes face -Z unless rotated. */
function decalPlane(scene: Scene, name: string, w: number, h: number, texW: number, texH: number, paint: (ctx: CanvasRenderingContext2D) => void): Mesh {
  const tex = new DynamicTexture(`${name}Tex`, { width: texW, height: texH }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, texW, texH);
  paint(ctx);
  tex.hasAlpha = true;
  tex.update();
  const m = new StandardMaterial(`${name}Mat`, scene);
  m.diffuseTexture = tex;
  m.useAlphaFromDiffuseTexture = true;
  m.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
  m.emissiveColor = new Color3(0.35, 0.35, 0.35);
  m.specularColor = new Color3(0.4, 0.4, 0.4);
  m.zOffset = -2;
  const p = MeshBuilder.CreatePlane(name, { width: w, height: h }, scene);
  p.material = m;
  p.isPickable = false;
  return p;
}

export function buildKart(scene: Scene, who: RosterEntry, id: string, parent: TransformNode): KartParts {
  const theme = KART_THEMES[who.id] ?? { emblem: "note" as Emblem, board: who.name.toUpperCase(), number: 0 };
  const main = who.walkerColor;
  const trim = who.walkerTrim;
  const stripe = who.walkerStripe ?? mix(hex(main), Color3.White(), 0.65).toHexString();
  const rubber = "#25252c";
  const chrome = "#e8edf5";

  const lift = new TransformNode(`kartLift-${id}`, scene);
  lift.parent = parent;
  const body = new TransformNode(`kartBody-${id}`, scene);
  body.parent = lift;
  const meshes: Mesh[] = [];
  const b = new PartBatch(scene, body, `kart-${id}`);

  // ---- Shell: a lathe-turned "tub" (rotate a 2D profile around the Y axis) --
  const profile = [
    new Vector3(0.0, 0.14, 0),
    new Vector3(0.5, 0.14, 0),
    new Vector3(0.74, 0.18, 0),
    new Vector3(0.86, 0.28, 0),
    new Vector3(0.88, 0.42, 0),
    new Vector3(0.83, 0.56, 0),
    new Vector3(0.7, 0.64, 0),
    new Vector3(0.6, 0.62, 0),
  ];
  // Paint a soft two-tone gradient: deeper colour low down, brighter on top.
  const mainC = hex(main);
  const lowC = mix(mainC, Color3.Black(), 0.25);
  const highC = mix(mainC, Color3.White(), 0.12);
  b.add(MeshBuilder.CreateLathe("tub", { shape: profile, tessellation: 28, sideOrientation: Mesh.DOUBLESIDE }, scene), (p) => mix(lowC, highC, (p.y - 0.14) / 0.5), "gloss", {
    scale: new Vector3(1, 1, 1.1),
  });
  // Bumper ring + racing band.
  b.add(MeshBuilder.CreateTorus("bumper", { diameter: 1.8, thickness: 0.17, tessellation: 26 }, scene), trim, "gloss", { pos: new Vector3(0, 0.34, 0), scale: new Vector3(1, 1, 1.1) });
  b.add(MeshBuilder.CreateTorus("band", { diameter: 1.7, thickness: 0.06, tessellation: 22 }, scene), stripe, "gloss", { pos: new Vector3(0, 0.52, 0), scale: new Vector3(1, 1, 1.1) });
  // Nose with two racing stripes and headlights.
  b.add(MeshBuilder.CreateSphere("nose", { diameterX: 0.95, diameterY: 0.46, diameterZ: 0.72, segments: 14 }, scene), main, "gloss", { pos: new Vector3(0, 0.42, 0.8) });
  for (const sx of [-0.12, 0.12]) {
    b.add(MeshBuilder.CreateBox("noseStripe", { width: 0.1, height: 0.02, depth: 0.5 }, scene), stripe, "gloss", { pos: new Vector3(sx, 0.64, 0.82), rot: new Vector3(0.28, 0, 0) });
  }
  const glow = new PartBatch(scene, body, `kartGlow-${id}`);
  for (const sx of [-0.27, 0.27]) {
    glow.add(MeshBuilder.CreateSphere("headlight", { diameterX: 0.17, diameterY: 0.14, diameterZ: 0.08, segments: 10 }, scene), "#fff7d6", "glow", { pos: new Vector3(sx, 0.47, 1.14) });
    b.add(MeshBuilder.CreateTorus("lightRim", { diameter: 0.18, thickness: 0.035, tessellation: 10 }, scene), chrome, "metal", {
      pos: new Vector3(sx, 0.47, 1.12),
      rot: new Vector3(Math.PI / 2, 0, 0),
    });
  }
  // Rear tail-lights.
  for (const sx of [-0.45, 0.45]) glow.add(MeshBuilder.CreateBox("tail", { width: 0.2, height: 0.08, depth: 0.04 }, scene), "#ff3048", "glow", { pos: new Vector3(sx, 0.5, -0.96) });

  // Fenders over each wheel.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // A low arch over the tyre (top half of a squashed sphere).
      b.add(MeshBuilder.CreateSphere("fender", { diameterX: 0.3, diameterY: 0.2, diameterZ: 0.62, segments: 10, slice: 0.5 }, scene), trim, "gloss", {
        pos: new Vector3(sx * 0.8, 0.54, sz * 0.58),
      });
    }
  }

  // Spoiler: posts, wing, end plates.
  for (const sx of [-0.45, 0.45]) b.add(MeshBuilder.CreateCylinder("spoilerPost", { diameter: 0.07, height: 0.42, tessellation: 8 }, scene), chrome, "metal", { pos: new Vector3(sx, 0.78, -0.86) });
  b.add(MeshBuilder.CreateBox("wing", { width: 1.5, height: 0.07, depth: 0.38 }, scene), trim, "gloss", { pos: new Vector3(0, 1.0, -0.9), rot: new Vector3(-0.12, 0, 0) });
  for (const sx of [-0.76, 0.76]) b.add(MeshBuilder.CreateBox("endPlate", { width: 0.05, height: 0.3, depth: 0.44 }, scene), main, "gloss", { pos: new Vector3(sx, 0.98, -0.9) });

  // Twin chrome exhausts.
  const exhausts: Mesh[] = [];
  for (const sx of [-0.28, 0.28]) {
    b.add(MeshBuilder.CreateCylinder("exhaust", { diameterTop: 0.13, diameterBottom: 0.16, height: 0.32, tessellation: 14 }, scene), chrome, "metal", {
      pos: new Vector3(sx, 0.36, -1.02),
      rot: new Vector3(Math.PI / 2 - 0.25, 0, 0),
    });
    b.add(MeshBuilder.CreateCylinder("exhaustHole", { diameter: 0.1, height: 0.02, tessellation: 12 }, scene), "#1a1a1f", "matte", {
      pos: new Vector3(sx, 0.32, -1.18),
      rot: new Vector3(Math.PI / 2 - 0.25, 0, 0),
    });
    const e = MeshBuilder.CreateBox(`exhaustEmit-${id}`, { size: 0.01 }, scene);
    e.isVisible = false;
    e.isPickable = false;
    e.parent = body;
    e.position.set(sx, 0.32, -1.22);
    exhausts.push(e);
  }

  // ---- Walker parts: posts, padded tray ring, seat --------------------------
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.add(MeshBuilder.CreateCylinder("post", { diameter: 0.08, height: 0.46, tessellation: 8 }, scene), chrome, "metal", { pos: new Vector3(Math.cos(a) * 0.56, 0.84, Math.sin(a) * 0.56) });
  }
  b.add(MeshBuilder.CreateTorus("tray", { diameter: 1.34, thickness: 0.22, tessellation: 24 }, scene), main, "gloss", { pos: new Vector3(0, 1.05, 0) });
  b.add(MeshBuilder.CreateTorus("trayPad", { diameter: 1.34, thickness: 0.1, tessellation: 20 }, scene), "#fff3d6", "matte", { pos: new Vector3(0, 1.15, 0) });

  // Dashboard (front play tray) with toy buttons and the steering wheel.
  b.add(MeshBuilder.CreateBox("dash", { width: 0.98, height: 0.1, depth: 0.42 }, scene), trim, "gloss", { pos: new Vector3(0, 1.1, 0.64) });
  const toyColors = ["#ff3b3b", "#ffd21e", "#2fd65a", "#2f8bff"];
  toyColors.forEach((c, i) => {
    glow.add(MeshBuilder.CreateCylinder("toyButton", { diameter: 0.1, height: 0.06, tessellation: 12 }, scene), c, "glow", {
      pos: new Vector3((i < 2 ? -0.38 : 0.28) + (i % 2) * 0.1, 1.18, 0.72),
    });
  });

  // ---- Themed extras -----------------------------------------------------------
  const accent = who.accentColor;
  switch (theme.emblem) {
    case "note": // DJ: bass speakers on the sides
      for (const sx of [-1, 1]) {
        b.add(MeshBuilder.CreateCylinder("speaker", { diameter: 0.3, height: 0.06, tessellation: 20 }, scene), "#1b1b22", "matte", {
          pos: new Vector3(sx * 0.87, 0.42, 0),
          rot: new Vector3(0, 0, Math.PI / 2),
        });
        glow.add(MeshBuilder.CreateTorus("speakerRing", { diameter: 0.3, thickness: 0.04, tessellation: 12 }, scene), accent, "glow", {
          pos: new Vector3(sx * 0.9, 0.42, 0),
          rot: new Vector3(0, 0, Math.PI / 2),
        });
      }
      break;
    case "crown": // Adam: a gold crown hood ornament
      for (let i = 0; i < 3; i++) {
        b.add(MeshBuilder.CreateCylinder("ornament", { diameterTop: 0, diameterBottom: 0.1, height: i === 1 ? 0.2 : 0.14, tessellation: 6 }, scene), "#FFC93A", "metal", {
          pos: new Vector3(-0.08 + i * 0.08, 0.72 + (i === 1 ? 0.03 : 0), 0.95),
        });
      }
      b.add(MeshBuilder.CreateCylinder("ornamentBase", { diameter: 0.24, height: 0.06, tessellation: 14 }, scene), "#FFC93A", "metal", { pos: new Vector3(0, 0.64, 0.95) });
      break;
    case "heart": // Logan: a sparkly purple heart up front
      for (const sx of [-1, 1]) {
        b.add(MeshBuilder.CreateSphere("heartLobe", { diameter: 0.16, segments: 10 }, scene), "#9b5cff", "gloss", { pos: new Vector3(sx * 0.055, 0.78, 0.95) });
      }
      b.add(MeshBuilder.CreateCylinder("heartTip", { diameterTop: 0.2, diameterBottom: 0, height: 0.16, tessellation: 4 }, scene), "#9b5cff", "gloss", {
        pos: new Vector3(0, 0.69, 0.95),
        rot: new Vector3(0, Math.PI / 4, 0),
        scale: new Vector3(1, 1, 0.5),
      });
      break;
    case "paw": // Huggie: teddy-bear ears on the back of the tray
      for (const sx of [-1, 1]) {
        b.add(MeshBuilder.CreateSphere("kartEar", { diameter: 0.3, segments: 12 }, scene), "#8b5a2b", "matte", { pos: new Vector3(sx * 0.4, 1.28, -0.5) });
        b.add(MeshBuilder.CreateSphere("kartEarIn", { diameter: 0.17, segments: 10 }, scene), "#F3D5B0", "matte", { pos: new Vector3(sx * 0.4, 1.28, -0.4) });
      }
      break;
    case "cookie": // Snacks: a giant cookie on the nose
      b.add(MeshBuilder.CreateCylinder("cookie", { diameter: 0.32, height: 0.06, tessellation: 20 }, scene), "#d9a25a", "matte", {
        pos: new Vector3(0, 0.76, 0.92),
        rot: new Vector3(1.2, 0, 0),
      });
      for (const [x, y] of [[-0.06, 0.04], [0.07, 0.02], [0, -0.06]]) {
        b.add(MeshBuilder.CreateSphere("chip", { diameter: 0.05, segments: 5 }, scene), "#5a3416", "matte", { pos: new Vector3(x, 0.77 + y * 0.35, 0.95 + y * 0.9) });
      }
      break;
    case "moon": // MrNapTime: moon and stars around the base
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.2;
        glow.add(MeshBuilder.CreateSphere("baseStar", { diameter: 0.09, segments: 6 }, scene), accent, "glow", { pos: new Vector3(Math.cos(a) * 0.86, 0.48, Math.sin(a) * 0.95) });
      }
      glow.add(MeshBuilder.CreateSphere("moon", { diameter: 0.22, segments: 10 }, scene), "#fff3a0", "glow", { pos: new Vector3(0, 1.2, -0.6) });
      break;
  }
  meshes.push(...b.build(), ...glow.build());

  // ---- Decals: nose badge + name board ----------------------------------------
  const badge = decalPlane(scene, `badge-${id}`, 0.34, 0.34, 128, 128, (ctx) => {
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#13235b";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(64, 64, 56, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    paintEmblem(ctx, theme.emblem, 64, 66, 80, theme.emblem === "cookie" ? "#d9a25a" : theme.emblem === "moon" ? "#ffd400" : theme.emblem === "crown" ? "#FFC93A" : accent);
  });
  badge.parent = body;
  badge.position.set(0, 0.55, 1.165);
  badge.rotation.set(-0.35, Math.PI, 0); // face forward (+Z) and tilt up with the nose
  const board = decalPlane(scene, `board-${id}`, 1.2, 0.3, 512, 128, (ctx) => {
    ctx.fillStyle = trim;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 116, 40);
    ctx.fill();
    ctx.stroke();
    paintEmblem(ctx, theme.emblem, 70, 64, 80, "#ffffff");
    ctx.font = "700 74px Fredoka, 'Comic Sans MS', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 10;
    ctx.strokeStyle = "#13235b";
    ctx.strokeText(theme.board, 290, 68, 360);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(theme.board, 290, 68, 360);
  });
  board.parent = body;
  board.position.set(0, 1.0, -1.1); // under the wing, facing backwards (-Z)
  board.rotation.x = -0.12;
  meshes.push(badge, board);

  // ---- Steering wheel (tilted back toward the toddler, spins with steering) --
  const steeringCenter = new Vector3(0, 1.26, 0.54);
  const steeringTilt = 0.9; // radians back from upright
  const column = new TransformNode(`steerTilt-${id}`, scene);
  column.parent = body;
  column.position.copyFrom(steeringCenter);
  column.rotation.x = -(Math.PI / 2 - steeringTilt); // wheel's flat face points up-and-back
  const steeringSpin = new TransformNode(`steerSpin-${id}`, scene);
  steeringSpin.parent = column;
  const sw = new PartBatch(scene, steeringSpin, `steeringWheel-${id}`);
  sw.add(MeshBuilder.CreateTorus("rim", { diameter: 0.34, thickness: 0.05, tessellation: 16 }, scene), "#22222a", "matte");
  sw.add(MeshBuilder.CreateCylinder("hub", { diameter: 0.12, height: 0.06, tessellation: 14 }, scene), accent, "gloss");
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    sw.add(MeshBuilder.CreateBox("spoke", { width: 0.15, height: 0.025, depth: 0.03 }, scene), "#22222a", "matte", {
      pos: new Vector3(Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08),
      rot: new Vector3(0, -a, 0),
    });
  }
  meshes.push(...sw.build());
  // Steering column down into the dash.
  const colB = new PartBatch(scene, column, `column-${id}`);
  colB.add(MeshBuilder.CreateCylinder("column", { diameter: 0.05, height: 0.22, tessellation: 8 }, scene), "#9aa5b1", "metal", { pos: new Vector3(0, -0.11, 0) });
  meshes.push(...colB.build());

  // ---- Wheels: one source mesh + 3 instances (instances = 1 draw call) ------
  const wheelSrc = new TransformNode(`wheelSrcNode-${id}`, scene);
  const wb = new PartBatch(scene, wheelSrc, `wheel-${id}`);
  const R = WHEEL_RADIUS;
  // A fat rounded tyre is just a torus (a doughnut) — cheaper than a cylinder plus bevels.
  wb.add(MeshBuilder.CreateTorus("tyre", { diameter: R * 2 - 0.13, thickness: 0.13, tessellation: 18 }, scene), rubber, "matte", { rot: new Vector3(0, 0, Math.PI / 2), scale: new Vector3(1.6, 1, 1) });
  // Rim + spokes on BOTH faces (so one mesh works for left and right wheels).
  wb.add(MeshBuilder.CreateCylinder("rim", { diameter: R * 1.25, height: 0.2, tessellation: 14 }, scene), trim, "matte", { rot: new Vector3(0, 0, Math.PI / 2) });
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI;
      wb.add(MeshBuilder.CreateBox("spoke", { width: 0.02, height: R * 1.1, depth: 0.05 }, scene), main, "matte", {
        pos: new Vector3(sx * 0.105, 0, 0),
        rot: new Vector3(a, 0, 0),
      });
    }
    wb.add(MeshBuilder.CreateSphere("hubcap", { diameter: 0.1, segments: 6 }, scene), chrome, "matte", { pos: new Vector3(sx * 0.11, 0, 0), scale: new Vector3(0.5, 1, 1) });
  }
  const [wheelMesh] = wb.build();
  wheelMesh.parent = null;
  wheelSrc.dispose();
  const wheels: WheelRig[] = [];
  const spots: Array<[number, number, boolean]> = [
    [0.8, 0.58, true],
    [-0.8, 0.58, true],
    [0.8, -0.58, false],
    [-0.8, -0.58, false],
  ];
  spots.forEach(([x, z, front], i) => {
    const holder = new TransformNode(`wheelHolder${i}-${id}`, scene);
    holder.parent = lift;
    holder.position.set(x, R, z);
    let steer: TransformNode | null = null;
    let spinParent: TransformNode = holder;
    if (front) {
      steer = new TransformNode(`wheelSteer${i}-${id}`, scene);
      steer.parent = holder;
      spinParent = steer;
    }
    const spin = new TransformNode(`wheelSpin${i}-${id}`, scene);
    spin.parent = spinParent;
    const visual = i === 0 ? wheelMesh : wheelMesh.createInstance(`wheel${i}-${id}`);
    visual.parent = spin;
    visual.position.setAll(0);
    visual.isPickable = false;
    wheels.push({ steer, spin });
  });
  meshes.push(wheelMesh);

  // Rear-wheel contact points (drift smoke and sparks come from here).
  const rearWheels = [0.8, -0.8].map((x, i) => {
    const e = MeshBuilder.CreateBox(`rearEmit${i}-${id}`, { size: 0.01 }, scene);
    e.isVisible = false;
    e.isPickable = false;
    e.parent = lift;
    e.position.set(x, 0.05, -0.62);
    return e;
  });

  const ownMaterials = [badge.material, board.material] as StandardMaterial[];
  return { lift, body, wheels, steeringSpin, steeringCenter, steeringTilt, exhausts, rearWheels, meshes, ownMaterials };
}
