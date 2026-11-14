/**
 * FaceTextures.ts — anime-style eyes and mouths, painted with the canvas 2D
 * API and used as textures on the toddlers' faces.
 *
 * Why paint faces instead of modelling them? Big anime eyes are mostly about
 * clean shapes: a large glossy iris, two sparkly highlights and a bold lash
 * line. Painting gives crisp, expressive results for almost no polygons, and
 * changing an expression is just swapping a material (super cheap).
 *
 * Every texture is created once per scene and shared by all toddlers
 * (brows are tinted to match hair, so there's one set per brow colour).
 *
 * Babylon.js concepts:
 *  - DynamicTexture: a texture backed by an HTML canvas we can draw on.
 *  - hasAlpha + useAlphaFromDiffuseTexture: transparent pixels let the
 *    skin show through, so the decal looks painted on.
 */
import { Color3, DynamicTexture, Material, Scene, StandardMaterial } from "@babylonjs/core";

export type EyeStyle = "open" | "blink" | "happy" | "ouch" | "sleepy" | "focus" | "wow";
export type MouthStyle = "smile" | "grin" | "laugh" | "ouch" | "sleepy" | "focus" | "wow";

/** Every expression the face rig understands = one eye style + one mouth style. */
export type Expression = "smile" | "laugh" | "ouch" | "sleepy" | "focus" | "wow";
export const EXPRESSIONS: Record<Expression, { eyes: EyeStyle; mouth: MouthStyle }> = {
  smile: { eyes: "open", mouth: "smile" },
  laugh: { eyes: "happy", mouth: "laugh" },
  ouch: { eyes: "ouch", mouth: "ouch" },
  sleepy: { eyes: "sleepy", mouth: "sleepy" },
  focus: { eyes: "focus", mouth: "grin" },
  wow: { eyes: "wow", mouth: "wow" },
};

const EYE_W = 256;
const EYE_H = 128;
const MOUTH_W = 128;
const MOUTH_H = 64;

const cache = new WeakMap<Scene, Map<string, StandardMaterial>>();

function decalMaterial(scene: Scene, key: string, w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): StandardMaterial {
  let map = cache.get(scene);
  if (!map) {
    map = new Map();
    cache.set(scene, map);
  }
  const found = map.get(key);
  if (found) return found;
  const tex = new DynamicTexture(`face-${key}`, { width: w, height: h }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, w, h);
  paint(ctx);
  tex.hasAlpha = true;
  tex.update();
  const m = new StandardMaterial(`faceMat-${key}`, scene);
  m.diffuseTexture = tex;
  m.useAlphaFromDiffuseTexture = true;
  // Alpha test + blend: crisp edges, and no sorting problems with the head.
  m.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
  m.alphaCutOff = 0.2;
  m.specularColor = new Color3(0.25, 0.25, 0.25); // a little wet shine on the eyes
  m.emissiveColor = new Color3(0.42, 0.42, 0.42); // eyes stay bright even in shadow
  m.backFaceCulling = false;
  m.zOffset = -2; // draw on top of the head surface it sits on
  map.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------
// Eyes (a PAIR in one texture: viewer's left eye in the left half)
// ---------------------------------------------------------------------------

export function eyeMaterial(scene: Scene, style: EyeStyle, browHex: string): StandardMaterial {
  return decalMaterial(scene, `eyes-${style}-${browHex}`, EYE_W, EYE_H, (ctx) => {
    for (const side of [0, 1]) {
      ctx.save();
      // Paint the left eye, then mirror the canvas for the right eye.
      if (side === 1) {
        ctx.translate(EYE_W, 0);
        ctx.scale(-1, 1);
      }
      paintEye(ctx, style, browHex);
      ctx.restore();
    }
  });
}

/** One eye in the left half (cx ≈ 64). Outer corner = left edge. */
function paintEye(ctx: CanvasRenderingContext2D, style: EyeStyle, browHex: string): void {
  const cx = 66;
  const cy = 74;
  const rx = 36;
  const ry = 42;
  const ink = "#1b0d06";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Eyebrows: soft rounded strokes. Angry-ish (focus) slopes down toward the nose.
  const brow = (lift: number, tilt: number) => {
    ctx.strokeStyle = browHex;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - 30, 22 - lift + tilt * -6);
    ctx.quadraticCurveTo(cx, 12 - lift, cx + 30, 20 - lift + tilt * 8);
    ctx.stroke();
  };

  if (style === "blink" || style === "happy") {
    // Closed eyes: a thick curved lash line. Blink = ‿, happy = ⌒ (anime laugh).
    brow(style === "happy" ? 6 : 0, 0);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 9;
    ctx.beginPath();
    if (style === "blink") {
      ctx.moveTo(cx - 34, cy + 4);
      ctx.quadraticCurveTo(cx, cy + 22, cx + 34, cy + 4);
    } else {
      ctx.moveTo(cx - 32, cy + 12);
      ctx.quadraticCurveTo(cx, cy - 26, cx + 32, cy + 12);
    }
    ctx.stroke();
    // A tiny lash flick at the outer corner.
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx - 32, cy + (style === "blink" ? 4 : 12));
    ctx.lineTo(cx - 42, cy + (style === "blink" ? -2 : 6));
    ctx.stroke();
    return;
  }

  if (style === "ouch") {
    // > <  squeezed shut. (Mirrored for the other eye, so they point inward.)
    brow(-2, 1.2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(cx - 26, cy - 22);
    ctx.lineTo(cx + 22, cy);
    ctx.lineTo(cx - 26, cy + 22);
    ctx.stroke();
    return;
  }

  const wow = style === "wow";
  brow(style === "focus" ? -4 : wow ? 10 : 2, style === "focus" ? 1.4 : 0);

  // Clip everything to the eye shape (and, when sleepy, to its lower half).
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  if (style === "sleepy") {
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.rect(0, cy - 4, EYE_W / 2, EYE_H);
  } else if (style === "focus") {
    // Determined: the top of the eye is cut by a flatter, lower lid.
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(0, cy - ry * 0.55);
    ctx.lineTo(EYE_W / 2, cy - ry * 0.75);
    ctx.lineTo(EYE_W / 2, EYE_H);
    ctx.lineTo(0, EYE_H);
    ctx.closePath();
  }
  ctx.clip();

  // Sclera with a soft shadow under the upper lid.
  const sclera = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
  sclera.addColorStop(0, "#c9cfe6");
  sclera.addColorStop(0.35, "#fbfbff");
  sclera.addColorStop(1, "#ffffff");
  ctx.fillStyle = sclera;
  ctx.fillRect(0, 0, EYE_W / 2, EYE_H);

  // Big iris: dark chocolate at the top fading to warm amber at the bottom.
  const irx = wow ? 24 : 28;
  const iry = wow ? 30 : 36;
  const icx = cx + 3;
  const icy = cy + 4;
  const iris = ctx.createLinearGradient(0, icy - iry, 0, icy + iry);
  iris.addColorStop(0, "#22100a");
  iris.addColorStop(0.5, "#6b3415");
  iris.addColorStop(1, "#c77a33");
  ctx.fillStyle = iris;
  ctx.beginPath();
  ctx.ellipse(icx, icy, irx, iry, 0, 0, Math.PI * 2);
  ctx.fill();
  // Darker iris rim.
  ctx.strokeStyle = "rgba(20,8,4,0.85)";
  ctx.lineWidth = 3;
  ctx.stroke();
  // A glowing crescent at the bottom of the iris (classic anime sparkle).
  ctx.strokeStyle = "rgba(255,190,120,0.75)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(icx, icy + 4, irx - 8, iry - 10, 0, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
  // Pupil.
  ctx.fillStyle = "#0d0604";
  ctx.beginPath();
  ctx.ellipse(icx, icy - 2, wow ? 8 : 12, wow ? 11 : 16, 0, 0, Math.PI * 2);
  ctx.fill();
  // Highlights: one big soft oval + one small dot.
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(icx - 11, icy - 16, 10, 12, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(icx + 12, icy + 14, 5, 0, Math.PI * 2);
  ctx.fill();
  if (style === "sleepy" || style === "focus") ctx.restore();
  ctx.restore();

  // Upper lash line: thick and bold, with a flick at the outer corner.
  ctx.strokeStyle = ink;
  ctx.lineWidth = 9;
  ctx.beginPath();
  if (style === "sleepy") {
    ctx.moveTo(cx - rx, cy - 2);
    ctx.lineTo(cx + rx, cy - 2);
  } else if (style === "focus") {
    ctx.moveTo(cx - rx + 2, cy - ry * 0.55);
    ctx.lineTo(cx + rx - 2, cy - ry * 0.75);
  } else {
    ctx.ellipse(cx, cy, rx, ry, 0, Math.PI * 1.05, Math.PI * 1.95);
  }
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath();
  const flickY = style === "sleepy" ? cy - 2 : style === "focus" ? cy - ry * 0.55 : cy - 12;
  ctx.moveTo(cx - rx + 2, flickY);
  ctx.lineTo(cx - rx - 10, flickY - 9);
  ctx.stroke();
  // Thin lower lash line.
  ctx.strokeStyle = "rgba(40,18,10,0.55)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx - 2, ry - 2, 0, Math.PI * 0.25, Math.PI * 0.75);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Mouths
// ---------------------------------------------------------------------------

export function mouthMaterial(scene: Scene, style: MouthStyle): StandardMaterial {
  return decalMaterial(scene, `mouth-${style}`, MOUTH_W, MOUTH_H, (ctx) => paintMouth(ctx, style));
}

function paintMouth(ctx: CanvasRenderingContext2D, style: MouthStyle): void {
  const cx = MOUTH_W / 2;
  const line = "#5a1a14";
  const inside = "#7a1f22";
  const tongue = "#ff7a8a";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = line;

  const openShape = (w: number, top: number, bottom: number, teeth: boolean) => {
    // A "D" turned on its side: flat-ish top, round bottom.
    ctx.beginPath();
    ctx.moveTo(cx - w, top);
    ctx.quadraticCurveTo(cx, top - 6, cx + w, top);
    ctx.quadraticCurveTo(cx + w * 0.9, bottom, cx, bottom);
    ctx.quadraticCurveTo(cx - w * 0.9, bottom, cx - w, top);
    ctx.closePath();
    ctx.fillStyle = inside;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = tongue;
    ctx.beginPath();
    ctx.ellipse(cx, bottom + 2, w * 0.6, (bottom - top) * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    if (teeth) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - w, top - 8, w * 2, 10);
    }
    ctx.restore();
    ctx.lineWidth = 4;
    ctx.stroke();
  };

  switch (style) {
    case "smile":
      // A small open smile — reads clearly on every skin tone, even far away.
      openShape(20, 24, 42, false);
      break;
    case "grin":
      openShape(26, 20, 44, true);
      break;
    case "laugh":
      openShape(34, 14, 56, true);
      break;
    case "wow":
      ctx.fillStyle = inside;
      ctx.beginPath();
      ctx.ellipse(cx, 34, 14, 18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.stroke();
      break;
    case "sleepy":
      ctx.fillStyle = inside;
      ctx.beginPath();
      ctx.ellipse(cx, 34, 8, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.stroke();
      break;
    case "ouch": {
      // A wobbly, gritted-teeth grimace.
      ctx.beginPath();
      ctx.moveTo(cx - 30, 30);
      ctx.lineTo(cx + 30, 30);
      ctx.lineTo(cx + 24, 46);
      ctx.lineTo(cx - 24, 46);
      ctx.closePath();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - 28, 38);
      ctx.lineTo(cx + 28, 38);
      for (let x = -14; x <= 14; x += 14) {
        ctx.moveTo(cx + x, 30);
        ctx.lineTo(cx + x, 46);
      }
      ctx.stroke();
      break;
    }
    case "focus":
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(cx - 22, 30);
      ctx.quadraticCurveTo(cx, 40, cx + 24, 26);
      ctx.stroke();
      break;
  }
}
