/**
 * Effects.ts — particle effects for pickups.
 *
 * Babylon.js concept: a ParticleSystem spawns many tiny textured quads from an
 * "emitter" and moves them each frame (no physics, just velocity + gravity).
 * We paint the particle images (a star and a "z") with the canvas 2D API.
 */
import { AbstractMesh, Color4, DynamicTexture, ParticleSystem, Scene, Vector3 } from "@babylonjs/core";

export type EffectMode = "boost" | "nap" | null;

function paintTexture(scene: Scene, name: string, draw: (ctx: CanvasRenderingContext2D) => void): DynamicTexture {
  const tex = new DynamicTexture(name, { width: 64, height: 64 }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 64, 64);
  draw(ctx);
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

export class PlayerEffects {
  private readonly sparkle: ParticleSystem;
  private readonly zzz: ParticleSystem;
  private mode: EffectMode = null;

  constructor(scene: Scene, emitter: AbstractMesh) {
    const star = paintTexture(scene, "sparkleTex", (ctx) => {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const r = i % 2 === 0 ? 30 : 9;
        const a = (i / 8) * Math.PI * 2;
        ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
      }
      ctx.fill();
    });
    const zTex = paintTexture(scene, "zzzTex", (ctx) => {
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 54px Fredoka, 'Comic Sans MS', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("z", 32, 34);
    });

    this.sparkle = new ParticleSystem("sparkle", 120, scene);
    this.sparkle.particleTexture = star;
    this.sparkle.emitter = emitter;
    this.sparkle.minEmitBox = new Vector3(-0.6, -1.2, -0.6);
    this.sparkle.maxEmitBox = new Vector3(0.6, 0.2, 0.6);
    this.sparkle.color1 = new Color4(1, 0.95, 0.4, 1);
    this.sparkle.color2 = new Color4(0.5, 0.9, 1, 1);
    this.sparkle.colorDead = new Color4(1, 0.55, 0.1, 0);
    this.sparkle.minSize = 0.12;
    this.sparkle.maxSize = 0.3;
    this.sparkle.minLifeTime = 0.3;
    this.sparkle.maxLifeTime = 0.7;
    this.sparkle.emitRate = 90;
    this.sparkle.direction1 = new Vector3(-1, 1.5, -1);
    this.sparkle.direction2 = new Vector3(1, 3, 1);
    this.sparkle.gravity = new Vector3(0, -4, 0);
    this.sparkle.blendMode = ParticleSystem.BLENDMODE_ADD;

    this.zzz = new ParticleSystem("zzz", 30, scene);
    this.zzz.particleTexture = zTex;
    this.zzz.emitter = emitter;
    this.zzz.minEmitBox = new Vector3(-0.2, 0.2, -0.2);
    this.zzz.maxEmitBox = new Vector3(0.2, 0.4, 0.2);
    this.zzz.color1 = new Color4(0.6, 0.8, 1, 1);
    this.zzz.color2 = new Color4(1, 1, 1, 1);
    this.zzz.colorDead = new Color4(0.6, 0.8, 1, 0);
    this.zzz.minSize = 0.3;
    this.zzz.maxSize = 0.55;
    this.zzz.minLifeTime = 1.0;
    this.zzz.maxLifeTime = 1.6;
    this.zzz.emitRate = 4;
    this.zzz.direction1 = new Vector3(-0.3, 0.8, -0.3);
    this.zzz.direction2 = new Vector3(0.3, 1.2, 0.3);
    this.zzz.minEmitPower = 0.6;
    this.zzz.maxEmitPower = 0.9;
    this.zzz.gravity = Vector3.Zero();
  }

  setMode(mode: EffectMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "boost") this.sparkle.start();
    else this.sparkle.stop();
    if (mode === "nap") this.zzz.start();
    else this.zzz.stop();
  }

  dispose(): void {
    this.sparkle.dispose();
    this.zzz.dispose();
  }
}
