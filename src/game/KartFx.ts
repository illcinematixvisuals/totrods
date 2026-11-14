/**
 * KartFx.ts — the "juice" around every kart: drift smoke, drift sparks that
 * change colour with the mini-turbo level, exhaust flames + glowing light
 * trails while boosting, cartoon impact stars, landing dust and a confetti pop
 * when a mini-turbo fires.
 *
 * Babylon.js concepts:
 *  - ParticleSystem: thousands of tiny camera-facing quads, simulated on the CPU.
 *    `emitter` can be a Mesh: particles then spawn inside a box in that mesh's
 *    LOCAL space and their directions turn with it, so effects follow the kart.
 *  - manualEmitCount: spawn a one-off burst (impacts, landings) from a running
 *    system whose emitRate is 0.
 *  - TrailMesh: a ribbon that follows a node and fades out behind it.
 *
 * Everything is sized by Quality.ts (fewer particles on phones, no trails on "low").
 * Each Walker owns one KartFx, so local, split-screen, online and TV karts all
 * get the same effects.
 */
import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  ParticleSystem,
  Scene,
  StandardMaterial,
  TrailMesh,
  TransformNode,
  Vector3,
  Engine,
} from "@babylonjs/core";
import { quality, registerGlow } from "./Quality";

/** Colours for drift level 0 (charging), 1 blue, 2 orange, 3 pink/purple. */
const LEVEL_COLORS: Array<[Color4, Color4]> = [
  [new Color4(1, 1, 1, 0.9), new Color4(0.85, 0.9, 1, 0.8)],
  [new Color4(0.3, 0.75, 1, 1), new Color4(0.6, 0.95, 1, 1)],
  [new Color4(1, 0.55, 0.1, 1), new Color4(1, 0.85, 0.2, 1)],
  [new Color4(1, 0.3, 0.85, 1), new Color4(0.7, 0.4, 1, 1)],
];

// --- Shared particle textures (painted once per scene) -----------------------
const texCache = new WeakMap<Scene, Record<string, DynamicTexture>>();
function textures(scene: Scene): Record<string, DynamicTexture> {
  let t = texCache.get(scene);
  if (t) return t;
  const paint = (name: string, draw: (c: CanvasRenderingContext2D) => void): DynamicTexture => {
    const tex = new DynamicTexture(name, { width: 64, height: 64 }, scene, false);
    const c = tex.getContext() as CanvasRenderingContext2D;
    c.clearRect(0, 0, 64, 64);
    draw(c);
    tex.hasAlpha = true;
    tex.update();
    return tex;
  };
  const soft = (c: CanvasRenderingContext2D): void => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.5, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  };
  t = {
    puff: paint("fxPuff", soft),
    spark: paint("fxSpark", (c) => {
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 14);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    }),
    star: paint("fxStar", (c) => {
      c.fillStyle = "#ffffff";
      c.strokeStyle = "rgba(0,0,0,0.35)";
      c.lineWidth = 3;
      c.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 29 : 12;
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        c.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
      }
      c.closePath();
      c.fill();
      c.stroke();
    }),
    confetti: paint("fxConfetti", (c) => {
      c.fillStyle = "#ffffff";
      c.fillRect(20, 8, 24, 48);
    }),
  };
  texCache.set(scene, t);
  return t;
}

/** What KartFx needs to know about its walker each frame. */
export interface KartFxState {
  drifting: boolean;
  driftLevel: number; // 0..3
  boosting: boolean; // turbo or milk boost
  speed: number; // |forward speed| (units/s)
  airborne: boolean;
}

export class KartFx {
  private readonly systems: ParticleSystem[] = [];
  private readonly smoke: ParticleSystem;
  private readonly sparks: ParticleSystem;
  private readonly flames: ParticleSystem;
  private readonly stars: ParticleSystem;
  private readonly dust: ParticleSystem;
  private readonly confetti: ParticleSystem;
  private readonly trails: TrailMesh[] = [];
  private readonly trailMat: StandardMaterial | null = null;
  private trailAlpha = 0;
  private readonly rear: Mesh;
  private readonly exhaust: Mesh;
  private readonly head: Mesh;
  private readonly scale: number;

  /**
   * @param root      the walker's root node (moves + turns with the kart)
   * @param rearHalf  half the distance between the rear wheels
   * @param rearZ     how far back the rear wheels are (negative = behind)
   * @param exhaustLocal  the exhausts' midpoint in root space
   */
  constructor(scene: Scene, root: TransformNode, rearHalf: number, rearZ: number, exhaustLocal: Vector3, accent: Color3) {
    const tex = textures(scene);
    this.scale = quality.tier === "high" ? 1 : quality.tier === "medium" ? 0.6 : 0.35;
    const n = (k: number): number => Math.max(8, Math.round(k * this.scale));

    // Invisible anchor meshes (no geometry) in the kart's local space.
    const anchor = (name: string, pos: Vector3): Mesh => {
      const m = new Mesh(name, scene);
      m.parent = root;
      m.position.copyFrom(pos);
      m.isPickable = false;
      return m;
    };
    this.rear = anchor("fxRear", new Vector3(0, 0.08, rearZ));
    this.exhaust = anchor("fxExhaust", exhaustLocal);
    this.head = anchor("fxHead", new Vector3(0, 2.2, 0));

    const make = (name: string, capacity: number, texture: DynamicTexture, emitter: Mesh): ParticleSystem => {
      const ps = new ParticleSystem(name, capacity, scene);
      ps.particleTexture = texture;
      ps.emitter = emitter;
      ps.emitRate = 0;
      ps.start(); // always "running"; we just turn emitRate up and down
      this.systems.push(ps);
      return ps;
    };

    // Drift smoke: soft grey-white puffs from the rear tyres that grow and fade.
    this.smoke = make("driftSmoke", n(90), tex.puff, this.rear);
    this.smoke.minEmitBox = new Vector3(-rearHalf, 0, -0.1);
    this.smoke.maxEmitBox = new Vector3(rearHalf, 0.1, 0.1);
    this.smoke.direction1 = new Vector3(-0.6, 0.4, -1);
    this.smoke.direction2 = new Vector3(0.6, 1.0, -0.4);
    this.smoke.minEmitPower = 0.6;
    this.smoke.maxEmitPower = 1.6;
    this.smoke.minSize = 0.35;
    this.smoke.maxSize = 0.7;
    this.smoke.addSizeGradient(0, 0.5);
    this.smoke.addSizeGradient(1, 1.8);
    this.smoke.minLifeTime = 0.35;
    this.smoke.maxLifeTime = 0.7;
    this.smoke.color1 = new Color4(1, 1, 1, 0.55);
    this.smoke.color2 = new Color4(0.85, 0.85, 0.9, 0.45);
    this.smoke.colorDead = new Color4(0.9, 0.9, 0.95, 0);
    this.smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    this.smoke.gravity = new Vector3(0, 0.6, 0);

    // Drift sparks: tiny bright additive dots flicking out from the tyres.
    this.sparks = make("driftSparks", n(120), tex.spark, this.rear);
    this.sparks.minEmitBox = new Vector3(-rearHalf, 0, 0);
    this.sparks.maxEmitBox = new Vector3(rearHalf, 0.05, 0);
    this.sparks.direction1 = new Vector3(-1.5, 1.5, -2.5);
    this.sparks.direction2 = new Vector3(1.5, 3, -1);
    this.sparks.minEmitPower = 1.2;
    this.sparks.maxEmitPower = 2.6;
    this.sparks.minSize = 0.08;
    this.sparks.maxSize = 0.2;
    this.sparks.minLifeTime = 0.15;
    this.sparks.maxLifeTime = 0.35;
    this.sparks.gravity = new Vector3(0, -9, 0);
    this.sparks.blendMode = ParticleSystem.BLENDMODE_ADD;

    // Exhaust flames: short-lived additive puffs blasting backwards.
    this.flames = make("boostFlames", n(100), tex.puff, this.exhaust);
    this.flames.minEmitBox = new Vector3(-0.22, -0.03, 0);
    this.flames.maxEmitBox = new Vector3(0.22, 0.03, 0);
    this.flames.direction1 = new Vector3(-0.15, 0.1, -1);
    this.flames.direction2 = new Vector3(0.15, 0.3, -1);
    this.flames.minEmitPower = 3;
    this.flames.maxEmitPower = 5;
    this.flames.minSize = 0.25;
    this.flames.maxSize = 0.45;
    this.flames.addSizeGradient(0, 1);
    this.flames.addSizeGradient(1, 0.2);
    this.flames.minLifeTime = 0.08;
    this.flames.maxLifeTime = 0.2;
    this.flames.color1 = new Color4(1, 0.75, 0.2, 1);
    this.flames.color2 = new Color4(0.4, 0.8, 1, 1);
    this.flames.colorDead = new Color4(1, 0.2, 0.1, 0);
    this.flames.blendMode = ParticleSystem.BLENDMODE_ADD;

    // Cartoon impact stars that spin out around the toddler's head.
    this.stars = make("impactStars", n(24), tex.star, this.head);
    this.stars.minEmitBox = new Vector3(-0.2, 0, -0.2);
    this.stars.maxEmitBox = new Vector3(0.2, 0.2, 0.2);
    this.stars.direction1 = new Vector3(-2, 1.5, -2);
    this.stars.direction2 = new Vector3(2, 3, 2);
    this.stars.minEmitPower = 0.8;
    this.stars.maxEmitPower = 1.4;
    this.stars.minSize = 0.25;
    this.stars.maxSize = 0.45;
    this.stars.minLifeTime = 0.5;
    this.stars.maxLifeTime = 0.8;
    this.stars.minAngularSpeed = -6;
    this.stars.maxAngularSpeed = 6;
    this.stars.color1 = new Color4(1, 0.92, 0.2, 1);
    this.stars.color2 = new Color4(1, 1, 1, 1);
    this.stars.colorDead = new Color4(1, 0.8, 0.2, 0);
    this.stars.gravity = new Vector3(0, -3, 0);
    this.stars.blendMode = ParticleSystem.BLENDMODE_STANDARD;

    // Landing dust ring.
    this.dust = make("landDust", n(40), tex.puff, this.rear);
    this.dust.minEmitBox = new Vector3(-0.7, 0, -0.2);
    this.dust.maxEmitBox = new Vector3(0.7, 0.05, 1.2);
    this.dust.direction1 = new Vector3(-2, 0.3, -2);
    this.dust.direction2 = new Vector3(2, 0.8, 2);
    this.dust.minEmitPower = 1;
    this.dust.maxEmitPower = 2;
    this.dust.minSize = 0.5;
    this.dust.maxSize = 0.9;
    this.dust.minLifeTime = 0.4;
    this.dust.maxLifeTime = 0.7;
    this.dust.color1 = new Color4(0.95, 0.9, 0.8, 0.7);
    this.dust.color2 = new Color4(1, 1, 1, 0.6);
    this.dust.colorDead = new Color4(1, 1, 1, 0);
    this.dust.blendMode = ParticleSystem.BLENDMODE_STANDARD;

    // Confetti pop when a mini-turbo fires.
    this.confetti = make("turboConfetti", n(60), tex.confetti, this.exhaust);
    this.confetti.minEmitBox = new Vector3(-0.3, 0, 0);
    this.confetti.maxEmitBox = new Vector3(0.3, 0.3, 0);
    this.confetti.direction1 = new Vector3(-2, 2, -3);
    this.confetti.direction2 = new Vector3(2, 4, -1);
    this.confetti.minEmitPower = 1.2;
    this.confetti.maxEmitPower = 2.2;
    this.confetti.minSize = 0.12;
    this.confetti.maxSize = 0.22;
    this.confetti.minLifeTime = 0.5;
    this.confetti.maxLifeTime = 0.9;
    this.confetti.minAngularSpeed = -10;
    this.confetti.maxAngularSpeed = 10;
    this.confetti.gravity = new Vector3(0, -6, 0);
    this.confetti.blendMode = ParticleSystem.BLENDMODE_STANDARD;

    // Glowing boost trails from both rear wheels (not on "low").
    if (quality.tier !== "low") {
      const mat = new StandardMaterial("trailMat", scene);
      mat.emissiveColor = accent;
      mat.diffuseColor = Color3.Black();
      mat.specularColor = Color3.Black();
      mat.disableLighting = true;
      mat.alpha = 0;
      mat.alphaMode = Engine.ALPHA_ADD;
      mat.backFaceCulling = false;
      this.trailMat = mat;
      for (const s of [-1, 1]) {
        const node = anchor("fxTrailNode", new Vector3(s * rearHalf, 0.25, rearZ));
        const trail = new TrailMesh("boostTrail", node, scene, 0.16, quality.tier === "high" ? 34 : 20, true);
        trail.material = mat;
        trail.isPickable = false;
        this.trails.push(trail);
        registerGlow(trail);
      }
    }
  }

  update(dt: number, s: KartFxState): void {
    const lvl = Math.max(0, Math.min(3, s.driftLevel));
    const onGround = !s.airborne;
    this.smoke.emitRate = s.drifting && onGround ? 70 * this.scale : 0;
    this.sparks.emitRate = s.drifting && onGround && lvl > 0 ? (60 + lvl * 40) * this.scale : 0;
    const [c1, c2] = LEVEL_COLORS[lvl];
    this.sparks.color1 = c1;
    this.sparks.color2 = c2;
    this.sparks.colorDead = new Color4(c1.r, c1.g, c1.b, 0);
    this.flames.emitRate = s.boosting ? 160 * this.scale : 0;
    // Trails fade in while boosting and out afterwards.
    if (this.trailMat) {
      const target = s.boosting && s.speed > 3 ? 0.85 : 0;
      this.trailAlpha += (target - this.trailAlpha) * (1 - Math.exp(-8 * dt));
      this.trailMat.alpha = this.trailAlpha;
      const on = this.trailAlpha > 0.02;
      for (const t of this.trails) if (t.isEnabled() !== on) t.setEnabled(on);
    }
  }

  /** Bonk! Stars around the head; bigger hits make more stars. */
  impact(strength: number): void {
    this.stars.manualEmitCount = Math.round(Math.min(10, 3 + strength * 0.6) * Math.max(0.5, this.scale));
  }

  land(airtime: number): void {
    this.dust.manualEmitCount = Math.round(Math.min(24, 8 + airtime * 20) * Math.max(0.5, this.scale));
  }

  /** A mini-turbo fired: confetti in the level's colour. */
  turbo(level: number): void {
    const [c1, c2] = LEVEL_COLORS[Math.max(1, Math.min(3, level))];
    this.confetti.color1 = c1;
    this.confetti.color2 = new Color4(1, 0.9, 0.2, 1);
    this.confetti.colorDead = new Color4(c2.r, c2.g, c2.b, 0);
    this.confetti.manualEmitCount = Math.round((10 + level * 8) * Math.max(0.5, this.scale));
  }

  dispose(): void {
    for (const ps of this.systems) ps.dispose(false); // textures are shared: keep them
    for (const t of this.trails) t.dispose();
    this.trailMat?.dispose();
  }
}
