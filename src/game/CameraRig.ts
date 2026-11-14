/**
 * CameraRig.ts — a smooth chase camera for one walker.
 *
 * It sits high and slightly to the side so you see the toddler (not just the
 * back of a head). During the countdown it starts IN FRONT of the toddler,
 * looking at their face, then swoops around behind for the race start.
 *
 * Babylon.js concepts:
 *  - FreeCamera: a camera we position by hand every frame.
 *  - camera.viewport: which part of the screen this camera draws into
 *    (split-screen = two cameras with two viewports).
 *  - Vector3.Lerp with t = 1 - exp(-k·dt): smooth, frame-rate-independent follow.
 *
 * Cinematic touches (Stage 3):
 *  - BOOST: the camera drops back and widens its field of view (a "whoosh").
 *  - DRIFT: it swings out to the outside of the turn so you see the slide.
 *  - JUMP: it rises with the kart and looks up a little.
 *  - BUMPS: a short decaying shake on collisions and hard landings.
 *  - WIN: once you finish, it slowly orbits your celebrating toddler.
 */
import { Camera, FreeCamera, Scalar, Scene, Vector3 } from "@babylonjs/core";
import type { Walker } from "./Walker";

const BACK = 6.2; // distance behind
const HEIGHT = 3.9; // above the floor (walls are 3.4, so we see over them)
const SIDE = 1.0; // offset to the right so the face is partly visible
const BASE_FOV = 0.95;
const PORTRAIT_FOV = 1.25; // horizontal, used when the screen is taller than wide

export class CameraRig {
  readonly camera: FreeCamera;
  /** 1 = in front looking at the face, 0 = normal chase view. */
  intro = 0;
  /** Extra field of view from pickups (+ = boost "whoosh", − = sleepy). */
  fovKick = 0;
  /** Camera shake strength (0..1), decays by itself. */
  private shake = 0;
  private boost = 0; // 0..1 smoothed "am I boosting?"
  private driftSwing = 0; // smoothed sideways swing while drifting
  private orbit = 0; // win orbit blend 0..1
  private orbitAngle = 0;
  private smoothedHeading = 0;
  private readonly lookTarget = Vector3.Zero();

  constructor(scene: Scene, private readonly walker: Walker, id: string) {
    this.camera = new FreeCamera(`chaseCam-${id}`, new Vector3(0, 5, -10), scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 600;
    this.camera.fov = BASE_FOV;
    // Listen to the walker's events without replacing anyone else's listener.
    const prevImpact = walker.onImpact;
    walker.onImpact = (s) => {
      prevImpact?.(s);
      this.addShake(Math.min(1, s / 10));
    };
    const prevLand = walker.onLand;
    walker.onLand = (t) => {
      prevLand?.(t);
      this.addShake(Math.min(0.6, t * 0.8));
    };
    const prevBoost = walker.onDriftBoost;
    walker.onDriftBoost = (l) => {
      prevBoost?.(l);
      this.addShake(0.12 * l);
    };
  }

  addShake(amount: number): void {
    this.shake = Math.max(this.shake, amount);
  }

  /** Jump straight to the desired spot (no smoothing). */
  snap(): void {
    this.smoothedHeading = this.walker.heading;
    this.camera.position.copyFrom(this.desiredPosition());
    this.lookTarget.copyFrom(this.desiredLook());
    this.camera.setTarget(this.lookTarget);
  }

  update(dt: number): void {
    let diff = this.walker.heading - this.smoothedHeading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to [-π, π]
    this.smoothedHeading += diff * (1 - Math.exp(-4.5 * dt));

    const w = this.walker;
    const boosting = w.turboLeft > 0 || w.fx === "boost";
    this.boost = Scalar.Lerp(this.boost, boosting ? 1 : 0, 1 - Math.exp(-(boosting ? 5 : 2) * dt));
    this.driftSwing = Scalar.Lerp(this.driftSwing, w.drifting ? -w.driftDir : 0, 1 - Math.exp(-3 * dt));
    this.orbit = Scalar.Lerp(this.orbit, w.celebrate && this.intro <= 0 ? 1 : 0, 1 - Math.exp(-1.5 * dt));
    if (this.orbit > 0.01) this.orbitAngle += dt * 0.45;
    else this.orbitAngle = this.smoothedHeading + Math.PI; // start the orbit from behind

    this.camera.position = Vector3.Lerp(this.camera.position, this.desiredPosition(), 1 - Math.exp(-6 * dt));
    this.lookTarget.copyFrom(Vector3.Lerp(this.lookTarget, this.desiredLook(), 1 - Math.exp(-10 * dt)));
    // Shake: a small random jolt added AFTER smoothing, fading out quickly.
    this.shake = Math.max(0, this.shake - dt * 2.5);
    if (this.shake > 0) {
      const j = this.shake * this.shake * 0.35;
      this.camera.position.addInPlaceFromFloats((Math.random() - 0.5) * j, (Math.random() - 0.5) * j, (Math.random() - 0.5) * j);
    }
    this.camera.setTarget(this.lookTarget);

    // A phone held upright is tall and narrow: fix the HORIZONTAL field of view
    // instead, so you still see the road beside you (just with more sky).
    const portrait = this.camera.getEngine().getAspectRatio(this.camera) < 1;
    this.camera.fovMode = portrait ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;
    const base = portrait ? PORTRAIT_FOV : BASE_FOV;
    const target = base + Math.min(this.walker.speedMph / 50, 1) * 0.15 + this.fovKick + this.boost * 0.12 - this.orbit * 0.15;
    this.camera.fov = Scalar.Lerp(this.camera.fov, target, 1 - Math.exp(-4 * dt));
  }

  private desiredPosition(): Vector3 {
    const h = this.smoothedHeading;
    const fwd = new Vector3(Math.sin(h), 0, Math.cos(h));
    const right = new Vector3(fwd.z, 0, -fwd.x);
    const air = this.walker.air;
    const back = BACK + this.boost * 1.4;
    const side = SIDE + this.driftSwing * 1.6;
    let chase = this.walker.position.add(fwd.scale(-back)).addInPlace(right.scale(side)).addInPlaceFromFloats(0, HEIGHT - this.boost * 0.4 + air * 0.7, 0);
    if (this.orbit > 0.01) {
      // Victory: circle the toddler at a low, heroic angle.
      const a = this.orbitAngle;
      const around = this.walker.position.add(new Vector3(Math.sin(a) * 6.5, 2.4, Math.cos(a) * 6.5));
      chase = Vector3.Lerp(chase, around, this.orbit);
    }
    if (this.intro <= 0) return chase;
    // Front view: ahead of the toddler, a bit to the side, at face height.
    const front = this.walker.position.add(fwd.scale(4.6)).addInPlace(right.scale(1.4)).addInPlaceFromFloats(0, 2.7, 0);
    return Vector3.Lerp(chase, front, this.intro);
  }

  private desiredLook(): Vector3 {
    let chaseLook = this.walker.position.add(this.walker.forward.scale(2.5)).addInPlaceFromFloats(0, 1.4 + this.walker.air * 0.8, 0);
    if (this.orbit > 0.01) {
      // Aim a little to the side of the toddler so they stand LEFT of centre,
      // clear of the results card in the middle of the screen.
      const a = this.orbitAngle;
      const camRight = new Vector3(-Math.cos(a), 0, Math.sin(a));
      const hero = this.walker.position.add(new Vector3(0, 1.5, 0)).addInPlace(camRight.scale(3.2));
      chaseLook = Vector3.Lerp(chaseLook, hero, this.orbit);
    }
    const faceLook = this.walker.position.add(new Vector3(0, 1.75, 0));
    return Vector3.Lerp(chaseLook, faceLook, this.intro);
  }
}
