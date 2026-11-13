/**
 * Walker.ts — a toddler in a baby walker: the model plus zippy, slightly
 * wobbly arcade physics (no physics engine needed).
 *
 * Node hierarchy (children move with their parents):
 *   root (moves + turns)
 *    ├─ casters (spin as you roll)
 *    └─ body (wobbles and bounces)  →  frame, tray, toys, toddler
 *
 * Physics idea: keep a velocity vector and split it every frame into a
 * FORWARD part (along the walker's facing) and a SIDEWAYS part. Grip kills
 * the sideways part quickly; the handbrake lowers grip so you skid (drift).
 */
import { Mesh, MeshBuilder, Scalar, Scene, ShadowGenerator, TransformNode, Vector3 } from "@babylonjs/core";
import type { InputState } from "./Input";
import { makeMat } from "./Materials";
import type { RosterEntry } from "./Roster";
import { buildToddler, type ToddlerParts } from "./Toddler";

/** One tuning table for everyone, so every toddler is equally fast. */
export const WALKER_TUNING = {
  maxSpeed: 17, // units/s (~38 "mph" on the HUD)
  maxReverse: 6,
  accel: 24,
  brakeDecel: 36,
  rollingDrag: 2,
  airDrag: 0.004, // × speed²
  turnRateSlow: 3.4, // rad/s when slow (casters spin easily)
  turnRateFast: 2.1, // rad/s at top speed
  grip: 7.5, // how fast sideways sliding is cancelled (per second)
  gripHandbrake: 1.2,
  handbrakeYawBoost: 1.4,
  casterRadius: 0.1,
  radius: 0.85, // collision circle
} as const;

/** Multipliers from pickups (1 = normal). */
export interface SpeedMods {
  speed: number;
  accel: number;
}

const UNITS_TO_MPH = 2.23694;

export class Walker {
  readonly root: TransformNode;
  readonly radius = WALKER_TUNING.radius;
  private readonly body: TransformNode;
  private readonly casters: Mesh[] = [];
  private readonly toddler: ToddlerParts;
  /** Invisible marker at head height, used as a particle emitter. */
  readonly emitter: Mesh;

  heading = 0;
  readonly velocity = Vector3.Zero();
  forwardSpeed = 0;
  slideSpeed = 0;

  private casterSpin = 0;
  private wobble = 0;
  private glance = 0;
  private glanceTarget = 0;
  private lastYawRate = 0;

  constructor(scene: Scene, shadows: ShadowGenerator, readonly who: RosterEntry, id: string) {
    this.root = new TransformNode(`walker-${id}`, scene);
    this.body = new TransformNode(`walkerBody-${id}`, scene);
    this.body.parent = this.root;
    this.buildFrame(scene, id);
    this.toddler = buildToddler(scene, who, this.body);
    this.emitter = MeshBuilder.CreateBox(`emitter-${id}`, { size: 0.01 }, scene);
    this.emitter.isVisible = false;
    this.emitter.parent = this.root;
    this.emitter.position.y = 1.9;
    this.root.getChildMeshes().forEach((m) => {
      if (m !== this.emitter) shadows.addShadowCaster(m);
    });
  }

  get position(): Vector3 {
    return this.root.position;
  }
  get speedMph(): number {
    return Math.abs(this.forwardSpeed) * UNITS_TO_MPH;
  }
  get forward(): Vector3 {
    return new Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** Make the toddler turn their head (radians, + = to their right). */
  lookAround(angle: number): void {
    this.glanceTarget = angle;
  }

  placeAt(position: Vector3, heading: number): void {
    this.root.position.set(position.x, 0, position.z);
    this.heading = heading;
    this.velocity.setAll(0);
    this.forwardSpeed = 0;
    this.slideSpeed = 0;
    this.root.rotation.y = heading;
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on);
  }

  dispose(): void {
    this.root.dispose(false, true); // also dispose this walker's materials
  }

  /**
   * Advance the simulation by `dt` seconds. Every change is multiplied by dt
   * ("delta time"), so the walker behaves the same at 30, 60 or 144 fps.
   */
  update(dt: number, input: InputState, mods: SpeedMods = { speed: 1, accel: 1 }): void {
    const T = WALKER_TUNING;
    const fwd = this.forward;
    const right = new Vector3(fwd.z, 0, -fwd.x);

    // 1) Split velocity into forward and sideways parts (dot product = projection).
    let vf = Vector3.Dot(this.velocity, fwd);
    let vs = Vector3.Dot(this.velocity, right);
    const maxSpeed = T.maxSpeed * mods.speed;

    // 2) Push, brake, reverse.
    if (input.throttle > 0) {
      if (vf < -0.3) vf += T.brakeDecel * dt;
      else {
        const ratio = Math.max(0, vf) / maxSpeed;
        vf += T.accel * mods.accel * input.throttle * Math.max(0, 1 - ratio * ratio) * dt;
      }
    }
    if (input.brake > 0) {
      if (vf > 0.3) vf = Math.max(0, vf - T.brakeDecel * dt);
      else vf = Math.max(-T.maxReverse, vf - T.accel * 0.5 * dt);
    }

    // 3) Drag pulls speed toward zero (extra drag if over the limit, e.g. after a nap pickup).
    let drag = T.rollingDrag + T.airDrag * vf * vf;
    if (Math.abs(vf) > maxSpeed) drag += 20;
    if (input.handbrake) drag += 5;
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), drag * dt);
    if (input.throttle === 0 && input.brake === 0 && Math.abs(vf) < 0.15) vf = 0;

    // 4) Grip: exponentially shrink sideways sliding (frame-rate independent).
    vs *= Math.exp(-(input.handbrake ? T.gripHandbrake : T.grip) * dt);

    // 5) Turning. Casters let walkers turn even when slow; a bit less at top speed.
    const speed01 = Math.min(1, Math.abs(vf) / T.maxSpeed);
    let yawRate = input.steer * Scalar.Lerp(T.turnRateSlow, T.turnRateFast, speed01);
    if (vf < -0.3) yawRate = -yawRate; // reversing flips steering, like a car
    if (input.handbrake) yawRate *= T.handbrakeYawBoost;
    this.lastYawRate = Scalar.Lerp(this.lastYawRate, yawRate, 1 - Math.exp(-12 * dt));

    // 6) Rebuild velocity in the OLD frame, then rotate. Part of it becomes
    //    sideways next frame, and grip decides how much "skid" survives.
    this.velocity.copyFrom(fwd.scale(vf).addInPlace(right.scale(vs)));
    this.heading += this.lastYawRate * dt;
    this.root.position.addInPlace(this.velocity.scale(dt));
    this.forwardSpeed = vf;
    this.slideSpeed = vs;
    this.animate(dt, speed01, vs);
  }

  /**
   * Online: show a walker exactly where its owner says it is (no physics here;
   * the owner's computer already ran the physics). Then animate it.
   */
  applyNetworkPose(dt: number, x: number, z: number, heading: number, forwardSpeed: number, slide: number, yawRate: number): void {
    const vx = dt > 0 ? (x - this.root.position.x) / dt : 0;
    const vz = dt > 0 ? (z - this.root.position.z) / dt : 0;
    this.velocity.set(vx, 0, vz); // so bumping into a remote walker feels right
    this.root.position.set(x, 0, z);
    this.heading = heading;
    this.forwardSpeed = forwardSpeed;
    this.slideSpeed = slide;
    this.lastYawRate = yawRate;
    this.animate(dt, Math.min(1, Math.abs(forwardSpeed) / WALKER_TUNING.maxSpeed), slide);
  }

  /** Current yaw rate (sent online so other players see the lean into turns). */
  get yawRate(): number {
    return this.lastYawRate;
  }

  /** Current head glance angle. */
  get lookAngle(): number {
    return this.glanceTarget;
  }

  /** Purely visual: casters, wobble, bounce, head glance, cape flap. */
  animate(dt: number, speed01: number, slide = 0): void {
    this.root.rotation.y = this.heading;
    this.casterSpin += (this.forwardSpeed / WALKER_TUNING.casterRadius) * dt;
    for (const c of this.casters) c.rotation.x = this.casterSpin;

    // Wobble: a sine wave whose speed and size grow with speed — toddler energy.
    this.wobble += dt * (5 + speed01 * 9);
    const lean = Scalar.Clamp(-this.lastYawRate * speed01 * 0.06 + slide * 0.01, -0.14, 0.14);
    this.body.rotation.z = lean + Math.sin(this.wobble) * 0.035 * (0.3 + speed01);
    this.body.rotation.x = Math.sin(this.wobble * 0.5 + 1) * 0.025 * speed01;
    this.body.position.y = Math.abs(Math.sin(this.wobble)) * 0.06 * speed01;

    const k = 1 - Math.exp(-6 * dt);
    this.glance = Scalar.Lerp(this.glance, this.glanceTarget, k);
    const head = this.toddler.headPivot;
    head.rotation.y = this.glance;
    head.rotation.z = Math.sin(this.wobble * 0.5) * 0.08 * (0.2 + speed01); // head bobble
    if (this.toddler.capePivot) {
      // Positive X rotation swings the bottom of the cape backwards (-Z): it flies out behind at speed.
      const flap = 0.12 + speed01 * 1.0 + Math.sin(this.wobble * 1.7) * 0.04 * (0.3 + speed01);
      this.toddler.capePivot.rotation.x = Scalar.Lerp(this.toddler.capePivot.rotation.x, flap, k);
    }
  }

  // ---------------------------------------------------------------------------

  private buildFrame(scene: Scene, id: string): void {
    const main = makeMat(scene, `walkerMain-${id}`, this.who.walkerColor, { specular: 0.4, emissive: 0.08 });
    const trim = makeMat(scene, `walkerTrim-${id}`, this.who.walkerTrim, { specular: 0.4, emissive: 0.08 });
    const rubber = makeMat(scene, `rubber-${id}`, "#2b2b30", { specular: 0.1 });
    const seat = makeMat(scene, `seat-${id}`, "#fff3d6", { specular: 0.05 });
    const toyColors = ["#ff3b3b", "#ffd21e", "#2fd65a", "#2f8bff"];
    const toys = toyColors.map((c, i) => makeMat(scene, `toy${i}-${id}`, c, { specular: 0.6, emissive: 0.2 }));

    const add = (m: Mesh, mat = main, parent: TransformNode = this.body): Mesh => {
      m.material = mat;
      m.parent = parent;
      return m;
    };

    // Round base + bumper ring.
    const base = add(MeshBuilder.CreateCylinder("base", { diameterTop: 1.4, diameterBottom: 1.62, height: 0.2, tessellation: 24 }, scene));
    base.position.y = 0.24;
    const bumper = add(MeshBuilder.CreateTorus("bumper", { diameter: 1.56, thickness: 0.14, tessellation: 24 }, scene), trim);
    bumper.position.y = 0.33;

    // Ring of caster wheels (on root, so they don't wobble with the body).
    const casterProto = MeshBuilder.CreateCylinder("caster", { diameter: WALKER_TUNING.casterRadius * 2, height: 0.08, tessellation: 10 }, scene);
    casterProto.rotation.z = Math.PI / 2;
    casterProto.bakeCurrentTransformIntoVertices(); // axle now along X → rotation.x = spin
    casterProto.material = rubber;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const c = i === 0 ? casterProto : (casterProto.clone(`caster${i}`) as Mesh);
      c.parent = this.root;
      c.position.set(Math.cos(a) * 0.62, WALKER_TUNING.casterRadius, Math.sin(a) * 0.62);
      this.casters.push(c);
    }

    // Four posts up to the tray.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const post = add(MeshBuilder.CreateCylinder("post", { diameter: 0.08, height: 0.72, tessellation: 6 }, scene), trim);
      post.position.set(Math.cos(a) * 0.56, 0.68, Math.sin(a) * 0.56);
    }

    // Tray ring, seat and the front play tray with toy buttons.
    const tray = add(MeshBuilder.CreateTorus("tray", { diameter: 1.32, thickness: 0.2, tessellation: 28 }, scene));
    tray.position.y = 1.04;
    const seatDisc = add(MeshBuilder.CreateCylinder("seat", { diameter: 1.1, height: 0.04, tessellation: 20 }, scene), seat);
    seatDisc.position.y = 0.98;
    const play = add(MeshBuilder.CreateBox("playTray", { width: 0.95, height: 0.08, depth: 0.42 }, scene), trim);
    play.position.set(0, 1.1, 0.62);
    toys.forEach((mat, i) => {
      const b = add(MeshBuilder.CreateCylinder("toyButton", { diameter: 0.12, height: 0.07, tessellation: 10 }, scene), mat);
      b.position.set(-0.33 + i * 0.22, 1.17, 0.73);
    });
    // Optional racing stripes: two thin strips over the base and the play tray.
    if (this.who.walkerStripe) {
      const stripe = makeMat(scene, `stripe-${id}`, this.who.walkerStripe, { specular: 0.4, emissive: 0.15 });
      for (const sx of [-0.13, 0.13]) {
        for (const sz of [-1, 1]) {
          const s = add(MeshBuilder.CreateBox("stripe", { width: 0.09, height: 0.02, depth: 0.42 }, scene), stripe);
          s.position.set(sx, 0.345, sz * 0.5);
        }
        const t = add(MeshBuilder.CreateBox("trayStripe", { width: 0.09, height: 0.02, depth: 0.43 }, scene), stripe);
        t.position.set(sx + (sx > 0 ? 0.24 : -0.24), 1.15, 0.62);
      }
      const band = add(MeshBuilder.CreateTorus("stripeBand", { diameter: 1.52, thickness: 0.05, tessellation: 24 }, scene), stripe);
      band.position.y = 0.2;
    }
    const wheel = add(MeshBuilder.CreateTorus("toyWheel", { diameter: 0.24, thickness: 0.05, tessellation: 14 }, scene), toys[0]);
    wheel.position.set(0, 1.22, 0.6);
    wheel.rotation.x = -1.1;

    // MrNapTime: little moons and stars around the walker base.
    if (this.who.accessory === "nightcap") {
      const sky = makeMat(scene, `skyDeco-${id}`, this.who.accentColor, { specular: 0.5, emissive: 0.35 });
      const navy = makeMat(scene, `navyDeco-${id}`, this.who.walkerTrim, { specular: 0.3, emissive: 0.1 });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.2;
        const star = add(MeshBuilder.CreateSphere("baseStar", { diameter: 0.09, segments: 5 }, scene), sky);
        star.position.set(Math.cos(a) * 0.7, 0.36, Math.sin(a) * 0.7);
      }
      const moon = add(MeshBuilder.CreateSphere("baseMoon", { diameter: 0.16, segments: 8 }, scene), navy);
      moon.position.set(0.55, 0.42, 0.15);
      const moonCut = add(MeshBuilder.CreateSphere("moonCut", { diameter: 0.13, segments: 8 }, scene), main);
      moonCut.position.set(0.6, 0.45, 0.2);
    }
  }
}
