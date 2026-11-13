/**
 * RemotePlayer.ts — another person's walker, as seen on YOUR screen.
 *
 * Their computer runs the physics and sends us snapshots ~20 times a second.
 * If we just jumped the walker to each new snapshot it would stutter (and
 * network packets don't arrive evenly). Instead we use INTERPOLATION:
 *
 *   - Every snapshot is stored with the server time it arrived.
 *   - We draw the walker as it was INTERPOLATION_DELAY_MS (100 ms) ago.
 *   - At that moment in the past we almost always have one snapshot before
 *     and one after, so we blend ("lerp") smoothly between the two.
 *
 * The cost: remote walkers are shown ~100 ms behind where they really are.
 * At toddler speeds that's under 2 units, and nobody notices.
 */
import { Color3, DynamicTexture, Mesh, MeshBuilder, Scalar, Scene, ShadowGenerator, StandardMaterial } from "@babylonjs/core";
import type { PlayerInfo, WalkerState } from "../../shared/protocol";
import { PlayerEffects } from "../game/Effects";
import type { RosterEntry } from "../game/Roster";
import { Walker } from "../game/Walker";

interface Snapshot {
  t: number; // server time (ms)
  s: WalkerState;
}

const MAX_EXTRAPOLATE_MS = 200; // if packets stop, keep gliding this long, then wait
const BUFFER_KEEP_MS = 1500;

/** Blend two angles the short way round (so 350° → 10° goes through 0°, not 180°). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class RemotePlayer {
  readonly walker: Walker;
  private readonly effects: PlayerEffects;
  private readonly tag: Mesh;
  private readonly tagMat: StandardMaterial;
  private readonly buffer: Snapshot[] = [];
  private fx: WalkerState["fx"] = null;

  constructor(
    readonly id: string,
    public name: string,
    readonly who: RosterEntry,
    scene: Scene,
    shadows: ShadowGenerator,
  ) {
    this.walker = new Walker(scene, shadows, who, `net-${id}`);
    this.effects = new PlayerEffects(scene, this.walker.emitter);

    // Name tag: a small plane with text painted on a canvas texture.
    // billboardMode makes it always face the camera; renderingGroupId 1 draws it
    // after the world, so you can spot friends even behind a wall.
    const tex = new DynamicTexture(`tagTex-${id}`, { width: 512, height: 128 }, scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = "700 64px Fredoka, 'Comic Sans MS', sans-serif";
    const w = Math.min(500, ctx.measureText(name).width + 60);
    ctx.fillStyle = who.walkerColor;
    ctx.strokeStyle = "#13235b";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.roundRect(256 - w / 2, 14, w, 100, 50);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 256, 68, 460);
    tex.hasAlpha = true;
    tex.update();
    this.tagMat = new StandardMaterial(`tagMat-${id}`, scene);
    this.tagMat.diffuseTexture = tex;
    this.tagMat.emissiveColor = Color3.White();
    this.tagMat.disableLighting = true;
    this.tagMat.useAlphaFromDiffuseTexture = true;
    this.tagMat.backFaceCulling = false;
    this.tag = MeshBuilder.CreatePlane(`tag-${id}`, { width: 2.4, height: 0.6 }, scene);
    this.tag.material = this.tagMat;
    this.tag.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.tag.renderingGroupId = 1;
    this.tag.isPickable = false;
    this.tag.parent = this.walker.root;
    this.tag.position.y = 2.75;
  }

  /** A new snapshot arrived (t = server time it was received). */
  push(t: number, state: WalkerState): void {
    // Ignore out-of-order packets (WebSockets keep order, but be safe).
    if (this.buffer.length > 0 && t <= this.buffer[this.buffer.length - 1].t) return;
    this.buffer.push({ t, s: state });
  }

  /** Show "lagging" (half see-through tag) while their connection is down. */
  setConnected(info: PlayerInfo): void {
    this.tagMat.alpha = info.connected ? 1 : 0.4;
  }

  get snapshotCount(): number {
    return this.buffer.length;
  }

  /** Draw the walker as it was at `renderTime` (server clock, ms). */
  update(dt: number, renderTime: number): void {
    const buf = this.buffer;
    if (buf.length === 0) {
      this.walker.animate(dt, 0);
      return;
    }
    // Forget snapshots we'll never need again (keep one older than renderTime).
    while (buf.length > 2 && buf[1].t < renderTime - BUFFER_KEEP_MS) buf.shift();

    let s: WalkerState;
    const newest = buf[buf.length - 1];
    if (renderTime >= newest.t) {
      // No newer snapshot yet: extrapolate a little along the heading, then hold.
      const ahead = Math.min(renderTime - newest.t, MAX_EXTRAPOLATE_MS) / 1000;
      const n = newest.s;
      s = { ...n, x: n.x + Math.sin(n.h) * n.v * ahead, z: n.z + Math.cos(n.h) * n.v * ahead };
    } else if (renderTime <= buf[0].t) {
      s = buf[0].s;
    } else {
      // Find the two snapshots either side of renderTime and blend them.
      let i = buf.length - 2;
      while (i > 0 && buf[i].t > renderTime) i--;
      const a = buf[i];
      const b = buf[i + 1];
      const k = (renderTime - a.t) / Math.max(1, b.t - a.t);
      s = {
        x: Scalar.Lerp(a.s.x, b.s.x, k),
        z: Scalar.Lerp(a.s.z, b.s.z, k),
        h: lerpAngle(a.s.h, b.s.h, k),
        v: Scalar.Lerp(a.s.v, b.s.v, k),
        s: Scalar.Lerp(a.s.s, b.s.s, k),
        y: Scalar.Lerp(a.s.y, b.s.y, k),
        look: Scalar.Lerp(a.s.look, b.s.look, k),
        fx: b.s.fx,
      };
    }
    this.walker.lookAround(s.look);
    this.walker.applyNetworkPose(dt, s.x, s.z, s.h, s.v, s.s, s.y);
    if (s.fx !== this.fx) {
      this.fx = s.fx;
      this.effects.setMode(s.fx);
    }
  }

  dispose(): void {
    this.effects.dispose();
    this.tag.dispose(false, true);
    this.walker.dispose();
  }
}
