/**
 * Materials.ts — a tiny helper for making coloured StandardMaterials.
 *
 * Babylon.js concept: a Material describes how a surface reacts to light.
 *  - diffuseColor: the base colour under light
 *  - specularColor: the colour/strength of shiny highlights
 *  - emissiveColor: light the surface gives off itself (never goes fully dark)
 */
import { Color3, Scene, StandardMaterial } from "@babylonjs/core";

export interface MatOptions {
  specular?: number; // 0 = matte, 1 = very shiny
  emissive?: number; // 0..1, fraction of the colour that glows
  alpha?: number; // 1 = opaque
}

export function makeMat(scene: Scene, name: string, hex: string, opts: MatOptions = {}): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  const c = Color3.FromHexString(hex);
  m.diffuseColor = c;
  const s = opts.specular ?? 0.15;
  m.specularColor = new Color3(s, s, s);
  if (opts.emissive) m.emissiveColor = c.scale(opts.emissive);
  if (opts.alpha !== undefined) m.alpha = opts.alpha;
  return m;
}
