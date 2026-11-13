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
  private smoothedHeading = 0;
  private readonly lookTarget = Vector3.Zero();

  constructor(scene: Scene, private readonly walker: Walker, id: string) {
    this.camera = new FreeCamera(`chaseCam-${id}`, new Vector3(0, 5, -10), scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 600;
    this.camera.fov = BASE_FOV;
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

    this.camera.position = Vector3.Lerp(this.camera.position, this.desiredPosition(), 1 - Math.exp(-6 * dt));
    this.lookTarget.copyFrom(Vector3.Lerp(this.lookTarget, this.desiredLook(), 1 - Math.exp(-10 * dt)));
    this.camera.setTarget(this.lookTarget);

    // A phone held upright is tall and narrow: fix the HORIZONTAL field of view
    // instead, so you still see the road beside you (just with more sky).
    const portrait = this.camera.getEngine().getAspectRatio(this.camera) < 1;
    this.camera.fovMode = portrait ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;
    const base = portrait ? PORTRAIT_FOV : BASE_FOV;
    const target = base + Math.min(this.walker.speedMph / 50, 1) * 0.15 + this.fovKick;
    this.camera.fov = Scalar.Lerp(this.camera.fov, target, 1 - Math.exp(-4 * dt));
  }

  private desiredPosition(): Vector3 {
    const h = this.smoothedHeading;
    const fwd = new Vector3(Math.sin(h), 0, Math.cos(h));
    const right = new Vector3(fwd.z, 0, -fwd.x);
    const chase = this.walker.position.add(fwd.scale(-BACK)).addInPlace(right.scale(SIDE)).addInPlaceFromFloats(0, HEIGHT, 0);
    if (this.intro <= 0) return chase;
    // Front view: ahead of the toddler, a bit to the side, at face height.
    const front = this.walker.position.add(fwd.scale(4.6)).addInPlace(right.scale(1.4)).addInPlaceFromFloats(0, 2.7, 0);
    return Vector3.Lerp(chase, front, this.intro);
  }

  private desiredLook(): Vector3 {
    const chaseLook = this.walker.position.add(this.walker.forward.scale(2.5)).addInPlaceFromFloats(0, 1.4, 0);
    const faceLook = this.walker.position.add(new Vector3(0, 1.75, 0));
    return Vector3.Lerp(chaseLook, faceLook, this.intro);
  }
}
