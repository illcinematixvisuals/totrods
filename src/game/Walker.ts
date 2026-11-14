/**
 * Walker.ts — a toddler in a racing walker-kart: the model plus zippy,
 * slightly wobbly arcade physics (no physics engine needed), a kid-friendly
 * DRIFT with mini-turbo, cartoon collisions, visual jumps and lots of
 * character animation.
 *
 * Node hierarchy (children move with their parents):
 *   root (logic position + heading; always on the floor, y = 0)
 *    └─ lift (jumps: the whole kart hops up here)
 *        ├─ wheels (spin; front ones steer)
 *        └─ body (suspension: bobs, pitches, rolls; cartoon squash and spin)
 *            ├─ shell, tray, dash, steering wheel
 *            └─ toddler (leans, bounces, steers, cheers, pulls faces)
 *
 * Physics idea: keep a velocity vector and split it every frame into a
 * FORWARD part (along the walker's facing) and a SIDEWAYS part. Grip kills
 * the sideways part quickly; drifting lowers grip so you slide.
 *
 * DRIFT (forgiving on purpose): hold the skid button while steering at speed.
 * You keep turning toward the drift side (steer harder = tighter). Sparks
 * change colour as the drift charges: blue → orange → pink. Let go for a
 * mini-turbo — the longer the drift, the longer the turbo.
 */
import { Color3, Mesh, MeshBuilder, Scalar, Scene, ShadowGenerator, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import type { Expression } from "./FaceTextures";
import type { InputState } from "./Input";
import { padAt } from "./Jumps";
import { KartFx } from "./KartFx";
import { registerGlow } from "./Quality";
import { buildKart, WHEEL_RADIUS, type KartParts } from "./Kart";
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
  radius: 0.85, // collision circle
  // Drift + mini-turbo
  driftMinSpeed: 6, // must be going at least this fast to start a drift
  driftGrip: 2.6, // sideways grip while drifting (lower = more slide)
  driftCharge: [0.55, 1.3, 2.2], // seconds of drifting for turbo level 1 / 2 / 3
  turboTime: [0, 0.55, 0.9, 1.3], // seconds of turbo per level
  turboSpeed: 1.28, // top-speed multiplier while turbo is on
  turboAccel: 2.2,
} as const;

/** Multipliers from pickups (1 = normal). */
export interface SpeedMods {
  speed: number;
  accel: number;
}

const UNITS_TO_MPH = 2.23694;
const GRAVITY = 24; // visual jumps

/** Pickup effect currently shown on this walker (drives expressions and particles). */
export type WalkerFx = "boost" | "nap" | null;

export class Walker {
  readonly root: TransformNode;
  readonly radius = WALKER_TUNING.radius;
  private readonly kart: KartParts;
  private readonly toddler: ToddlerParts;
  /** Invisible marker at head height, used as a particle emitter. */
  readonly emitter: Mesh;

  heading = 0;
  readonly velocity = Vector3.Zero();
  forwardSpeed = 0;
  slideSpeed = 0;

  // ---- Drift / turbo (read by effects, camera and HUD) ----
  drifting = false;
  driftDir = 0; // -1 left, +1 right
  driftCharge = 0; // seconds
  turboLeft = 0;
  /** Called when a drift is released with a turbo (level 1..3). */
  onDriftBoost: ((level: number) => void) | null = null;
  /** Called on a bump (strength ≈ change in speed, units/s). */
  onImpact: ((strength: number) => void) | null = null;
  /** Called when landing from a jump (airtime in seconds). */
  onLand: ((airtime: number) => void) | null = null;

  // ---- Visual state set by Player / RemotePlayer / Showcase ----
  fx: WalkerFx = null;
  /** Arms up, laughing, bouncing (finish line, results, select screen). */
  celebrate = false;

  private wheelSpin = 0;
  private wobble = 0;
  private glance = 0;
  private glanceTarget = 0;
  private lastYawRate = 0;
  private steerVis = 0;
  private time = Math.random() * 10;
  // suspension springs (pitch, roll, height)
  private pitch = 0;
  private pitchVel = 0;
  private roll = 0;
  private rollVel = 0;
  private bob = 0;
  private bobVel = 0;
  private prevForward = 0;
  // jumps
  private airY = 0;
  private airVy = 0;
  private airTime = 0;
  private padCooldown = 0;
  // cartoon collisions
  private readonly lastVel = Vector3.Zero();
  private squash = 0;
  private spinOut = 0; // remaining visual spin (radians)
  private shake = 0;
  private impactCooldown = 0;
  private cheer = 0; // 0..1 blend toward the celebration pose

  constructor(scene: Scene, shadows: ShadowGenerator, readonly who: RosterEntry, id: string) {
    this.root = new TransformNode(`walker-${id}`, scene);
    this.kart = buildKart(scene, who, id, this.root);
    this.toddler = buildToddler(scene, who, this.kart.body);
    this.emitter = MeshBuilder.CreateBox(`emitter-${id}`, { size: 0.01 }, scene);
    this.emitter.isVisible = false;
    this.emitter.parent = this.kart.lift;
    this.emitter.position.y = 1.9;
    // Every solid part casts a shadow. Painted decals (eyes, badges) don't:
    // their transparent corners would cast square shadows.
    this.root.getChildMeshes().forEach((m) => {
      if (m === this.emitter || !m.isVisible) return;
      const mat = m.material as StandardMaterial | null;
      if (mat && "diffuseTexture" in mat && mat.diffuseTexture) return;
      shadows.addShadowCaster(m, false);
    });
    // Headlights + tail-lights glow (GlowLayer, see Game.ts); smoke/sparks/trails live in KartFx.
    this.root.getChildMeshes().forEach((m) => m.name.startsWith("kartGlow") && registerGlow(m));
    Walker.all.add(this);
    this.kfx = new KartFx(scene, this.root, 0.8, -0.62, new Vector3(0, 0.34, -1.24), Color3.FromHexString(who.walkerColor));
  }
  /** Every live walker (for the mini-map). Showcase walkers are disabled, so they are skipped. */
  static readonly all = new Set<Walker>();
  /** Particle effects + boost trails for this kart. */
  private readonly kfx: KartFx;

  get position(): Vector3 {
    return this.root.position;
  }
  get speedMph(): number {
    return Math.abs(this.forwardSpeed) * UNITS_TO_MPH;
  }
  get forward(): Vector3 {
    return new Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }
  /** Height of the jump right now (0 = on the floor). */
  get air(): number {
    return this.airY;
  }
  /** Current turbo level from the drift charge (0 = none yet). */
  get driftLevel(): number {
    const c = WALKER_TUNING.driftCharge;
    return !this.drifting ? 0 : this.driftCharge >= c[2] ? 3 : this.driftCharge >= c[1] ? 2 : this.driftCharge >= c[0] ? 1 : 0;
  }
  /** Rear-wheel and exhaust emitter points for particle effects. */
  get rearWheels(): Mesh[] {
    return this.kart.rearWheels;
  }
  get exhausts(): Mesh[] {
    return this.kart.exhausts;
  }
  /** Current expression on the toddler's face (handy for tests). */
  get expression(): Expression {
    return this.toddler.face.current;
  }

  /** Make the toddler turn their head (radians, + = to their right). */
  lookAround(angle: number): void {
    this.glanceTarget = angle;
  }

  /** Pull a face for a moment (e.g. "laugh" on a pickup). */
  react(e: Expression, seconds = 1): void {
    this.toddler.face.flash(e, seconds);
  }

  /** Start a short turbo (rocket start, drift release). */
  startTurbo(seconds: number): void {
    this.turboLeft = Math.max(this.turboLeft, seconds);
  }

  placeAt(position: Vector3, heading: number): void {
    this.root.position.set(position.x, 0, position.z);
    this.heading = heading;
    this.velocity.setAll(0);
    this.lastVel.setAll(0);
    this.forwardSpeed = 0;
    this.prevForward = 0;
    this.slideSpeed = 0;
    this.drifting = false;
    this.driftCharge = 0;
    this.turboLeft = 0;
    this.airY = 0;
    this.airVy = 0;
    this.spinOut = 0;
    this.root.rotation.y = heading;
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on);
  }

  dispose(): void {
    Walker.all.delete(this);
    this.kfx.dispose();
    // Don't pass `true` here: most materials (skin, paint, faces) are SHARED by
    // every walker (see ModelKit.ts / FaceTextures.ts) and must stay alive.
    this.root.dispose(false, false);
    this.kart.ownMaterials.forEach((m) => m.dispose(true, true)); // this kart's name board + badge
  }

  /**
   * Advance the simulation by `dt` seconds. Every change is multiplied by dt
   * ("delta time"), so the walker behaves the same at 30, 60 or 144 fps.
   */
  update(dt: number, input: InputState, mods: SpeedMods = { speed: 1, accel: 1 }): void {
    const T = WALKER_TUNING;
    // 0) Did the collision step last frame change our velocity a lot? That was a bump!
    this.detectImpact(Math.hypot(this.velocity.x - this.lastVel.x, this.velocity.z - this.lastVel.z));

    const fwd = this.forward;
    const right = new Vector3(fwd.z, 0, -fwd.x);

    // 1) Split velocity into forward and sideways parts (dot product = projection).
    let vf = Vector3.Dot(this.velocity, fwd);
    let vs = Vector3.Dot(this.velocity, right);

    // Turbo (drift release or rocket start) stacks on top of pickups.
    let speedMul = mods.speed;
    let accelMul = mods.accel;
    if (this.turboLeft > 0) {
      this.turboLeft -= dt;
      speedMul *= T.turboSpeed;
      accelMul *= T.turboAccel;
    }
    const maxSpeed = T.maxSpeed * speedMul;

    // 2) Drift state machine.
    const wantsDrift = input.handbrake && Math.abs(input.steer) > 0.25 && vf > T.driftMinSpeed;
    if (!this.drifting && wantsDrift) {
      this.drifting = true;
      this.driftDir = Math.sign(input.steer);
      this.driftCharge = 0;
      this.bobVel += 1.2; // a little hop as the drift starts (classic kart feel)
    } else if (this.drifting && (!input.handbrake || vf < T.driftMinSpeed * 0.6)) {
      const level = this.driftLevel;
      this.drifting = false;
      this.driftCharge = 0;
      if (level > 0 && input.handbrake === false) {
        this.startTurbo(T.turboTime[level]);
        vf += 2 + level; // instant kick so it feels punchy
        this.onDriftBoost?.(level);
        this.kfx.turbo(level);
      }
    }
    if (this.drifting) this.driftCharge += dt * (0.8 + 0.5 * Math.max(0, input.steer * this.driftDir));

    // 3) Push, brake, reverse.
    if (input.throttle > 0) {
      if (vf < -0.3) vf += T.brakeDecel * dt;
      else {
        const ratio = Math.max(0, vf) / maxSpeed;
        vf += T.accel * accelMul * input.throttle * Math.max(0, 1 - ratio * ratio) * dt;
      }
    }
    if (input.brake > 0) {
      if (vf > 0.3) vf = Math.max(0, vf - T.brakeDecel * dt);
      else vf = Math.max(-T.maxReverse, vf - T.accel * 0.5 * dt);
    }

    // 4) Drag pulls speed toward zero (extra drag if over the limit, e.g. after a nap pickup).
    let drag = T.rollingDrag + T.airDrag * vf * vf;
    if (Math.abs(vf) > maxSpeed) drag += 20;
    if (input.handbrake) drag += this.drifting ? 1.2 : 5; // drifting barely slows you: forgiving for little kids
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), drag * dt);
    if (input.throttle === 0 && input.brake === 0 && Math.abs(vf) < 0.15) vf = 0;

    // 5) Grip: exponentially shrink sideways sliding (frame-rate independent).
    const grip = this.drifting ? T.driftGrip : input.handbrake ? T.gripHandbrake : T.grip;
    vs *= Math.exp(-grip * dt);

    // 6) Turning. Casters let walkers turn even when slow; a bit less at top speed.
    const speed01 = Math.min(1, Math.abs(vf) / T.maxSpeed);
    let yawRate: number;
    if (this.drifting) {
      // Always turning toward the drift side; steering adjusts how tight.
      const k = 0.75 + 0.45 * Scalar.Clamp(input.steer * this.driftDir, -1, 1);
      yawRate = this.driftDir * T.turnRateFast * 1.15 * k;
    } else {
      yawRate = input.steer * Scalar.Lerp(T.turnRateSlow, T.turnRateFast, speed01);
      if (vf < -0.3) yawRate = -yawRate; // reversing flips steering, like a car
      if (input.handbrake) yawRate *= T.handbrakeYawBoost;
    }
    this.lastYawRate = Scalar.Lerp(this.lastYawRate, yawRate, 1 - Math.exp(-12 * dt));

    // 7) Rebuild velocity in the OLD frame, then rotate. Part of it becomes
    //    sideways next frame, and grip decides how much "skid" survives.
    this.velocity.copyFrom(fwd.scale(vf).addInPlace(right.scale(vs)));
    this.heading += this.lastYawRate * dt;
    this.root.position.addInPlace(this.velocity.scale(dt));
    this.forwardSpeed = vf;
    this.slideSpeed = vs;
    this.lastVel.copyFrom(this.velocity);

    const steerGoal = this.drifting ? this.driftDir * 0.6 + input.steer * 0.4 : input.steer;
    this.steerVis = Scalar.Lerp(this.steerVis, steerGoal, 1 - Math.exp(-10 * dt));
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
    // A sudden big drop in speed = they bumped into something.
    if (this.forwardSpeed - forwardSpeed > 5) this.detectImpact(this.forwardSpeed - forwardSpeed);
    this.forwardSpeed = forwardSpeed;
    this.slideSpeed = slide;
    this.lastYawRate = yawRate;
    // Remote karts: show a drift whenever they're sliding hard at speed.
    this.drifting = Math.abs(slide) > 2.5 && forwardSpeed > WALKER_TUNING.driftMinSpeed;
    this.driftDir = Math.sign(yawRate) || 1;
    this.steerVis = Scalar.Lerp(this.steerVis, Scalar.Clamp(yawRate / 2.4, -1, 1), 1 - Math.exp(-10 * dt));
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

  private detectImpact(strength: number): void {
    if (strength < 3.5 || this.impactCooldown > 0) return;
    this.impactCooldown = 0.35;
    this.squash = Math.min(1, strength / 10);
    this.shake = Math.min(1, strength / 8);
    if (strength > 9) this.spinOut = Math.PI * 2; // big hit: a full cartoon spin (visual only!)
    this.toddler.face.flash("ouch", 0.7);
    this.kfx.impact(strength);
    this.onImpact?.(strength);
  }

  /** Purely visual: wheels, suspension, jumps, toddler animation and face. */
  animate(dt: number, speed01: number, slide = 0): void {
    this.time += dt;
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    this.root.rotation.y = this.heading;
    const kart = this.kart;
    const toddler = this.toddler;

    // --- Wheels: roll + steer ---
    this.wheelSpin += (this.forwardSpeed / WHEEL_RADIUS) * dt;
    for (const w of kart.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      if (w.steer) w.steer.rotation.y = this.steerVis * 0.45;
    }
    kart.steeringSpin.rotation.y = this.steerVis * 1.9;

    // --- Jumps (visual hop over pillow ramps) ---
    this.padCooldown = Math.max(0, this.padCooldown - dt);
    if (this.airY <= 0 && this.padCooldown <= 0 && Math.abs(this.forwardSpeed) > 4) {
      const pad = padAt(this.root.position.x, this.root.position.z);
      if (pad) {
        this.airVy = (2.6 + Math.abs(this.forwardSpeed) * 0.22) * pad.power;
        this.airY = 0.001;
        this.airTime = 0;
        this.padCooldown = 0.6;
        toddler.face.flash("wow", 0.9);
      }
    }
    if (this.airY > 0) {
      this.airTime += dt;
      this.airVy -= GRAVITY * dt;
      this.airY += this.airVy * dt;
      if (this.airY <= 0) {
        this.airY = 0;
        this.bobVel -= 2.5 + this.airTime * 4; // land: compress the suspension
        this.squash = Math.max(this.squash, Math.min(0.8, this.airTime));
        this.toddler.face.flash("laugh", 0.8);
        this.kfx.land(this.airTime);
        this.onLand?.(this.airTime);
      }
    }
    kart.lift.position.y = this.airY;
    // Nose up on take-off, nose down when falling.
    const airPitch = this.airY > 0 ? Scalar.Clamp(-this.airVy * 0.035, -0.3, 0.3) : 0;

    // --- Suspension: damped springs for pitch, roll and height ---
    const accel = dt > 0 ? (this.forwardSpeed - this.prevForward) / dt : 0;
    this.prevForward = this.forwardSpeed;
    const pitchTarget = Scalar.Clamp(-accel * 0.0055, -0.09, 0.09) + airPitch;
    const rollTarget = Scalar.Clamp(this.lastYawRate * this.forwardSpeed * 0.0045 + slide * 0.006, -0.12, 0.12);
    const spring = (x: number, v: number, target: number, k: number, c: number): [number, number] => {
      const a = k * (target - x) - c * v;
      v += a * dt;
      return [x + v * dt, v];
    };
    [this.pitch, this.pitchVel] = spring(this.pitch, this.pitchVel, pitchTarget, 140, 11);
    [this.roll, this.rollVel] = spring(this.roll, this.rollVel, rollTarget, 140, 11);
    // Little road bumps at speed keep the suspension alive.
    if (this.airY <= 0 && speed01 > 0.2 && Math.random() < dt * 6 * speed01) this.bobVel += (Math.random() - 0.3) * 0.5 * speed01;
    [this.bob, this.bobVel] = spring(this.bob, this.bobVel, 0, 160, 9);

    // Toddler energy: a sine wobble whose speed and size grow with speed.
    this.wobble += dt * (5 + speed01 * 9);
    const wob = Math.sin(this.wobble) * 0.025 * (0.3 + speed01);

    // Cartoon collision: squash, shake and (big hits) a full spin.
    this.squash = Math.max(0, this.squash - dt * 2.6);
    this.shake = Math.max(0, this.shake - dt * 3);
    let spinVis = 0;
    if (this.spinOut > 0) {
      this.spinOut = Math.max(0, this.spinOut - dt * 11);
      spinVis = this.spinOut;
    }
    const body = kart.body;
    body.position.y = 0.02 + this.bob * 0.08 + Math.abs(Math.sin(this.wobble)) * 0.03 * speed01;
    body.rotation.set(this.pitch, spinVis, this.roll + wob + Math.sin(this.time * 60) * 0.05 * this.shake);
    const sq = Math.sin(Math.min(1, this.squash) * Math.PI) * 0.22;
    body.scaling.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);

    // --- Toddler: lean into turns, bounce, steer or cheer ---
    const k = 1 - Math.exp(-6 * dt);
    this.cheer = Scalar.Lerp(this.cheer, this.celebrate ? 1 : 0, 1 - Math.exp(-5 * dt));
    const ub = toddler.upperBody;
    const leanIn = Scalar.Clamp(-this.lastYawRate * speed01 * 0.09, -0.2, 0.2);
    ub.rotation.z = Scalar.Lerp(ub.rotation.z, leanIn, k);
    ub.rotation.x = Scalar.Lerp(ub.rotation.x, 0.06 * speed01 - this.cheer * 0.12 + (this.turboLeft > 0 || this.fx === "boost" ? -0.08 : 0), k);
    const bounce = this.cheer * Math.abs(Math.sin(this.time * 9)) * 0.12;
    ub.position.y = 0.86 + bounce + this.bob * 0.03;

    // Hands follow the steering wheel rim (IK), or wave in the air when cheering.
    const C = kart.steeringCenter;
    const tilt = kart.steeringTilt;
    const ang = this.steerVis * 1.9;
    const r = 0.17;
    const U = new Vector3(0, Math.cos(tilt), Math.sin(tilt)); // "up" across the wheel face
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1; // toddler's left (+X) then right (−X)
      const onWheel = new Vector3(side * r * Math.cos(ang), 0, 0).addInPlace(U.scale(-side * r * Math.sin(ang))).addInPlace(C);
      onWheel.y -= 0.86; // into upperBody space
      const wave = Math.sin(this.time * 10 + i * 1.7) * 0.12;
      const cheerHand = new Vector3(side * (0.45 + wave * 0.5), 0.95 + wave, 0.12);
      toddler.arms[i].reach(Vector3.Lerp(onWheel, cheerHand, this.cheer));
    }

    // Head: glance, bobble, look up when cheering.
    this.glance = Scalar.Lerp(this.glance, this.glanceTarget * (1 - this.cheer), k);
    const head = toddler.headPivot;
    head.rotation.y = this.glance;
    head.rotation.z = Math.sin(this.wobble * 0.5) * 0.08 * (0.2 + speed01) + this.cheer * Math.sin(this.time * 5) * 0.15;
    head.rotation.x = -this.cheer * 0.15 + (this.airY > 0 ? -0.1 : 0);
    if (toddler.capePivot) {
      // Positive X rotation swings the bottom of the cape backwards (-Z): it flies out behind at speed.
      const flap = 0.12 + speed01 * 1.0 + Math.sin(this.wobble * 1.7) * 0.04 * (0.3 + speed01);
      toddler.capePivot.rotation.x = Scalar.Lerp(toddler.capePivot.rotation.x, flap, k);
    }

    // --- Face: the base expression follows what's happening ---
    let mood: Expression = "smile";
    if (this.celebrate || this.turboLeft > 0 || this.fx === "boost") mood = "laugh";
    else if (this.fx === "nap") mood = "sleepy";
    else if (this.drifting) mood = "focus";
    toddler.face.setBase(mood);
    toddler.face.update(dt);

    // --- Particles and trails ---
    this.kfx.update(dt, {
      drifting: this.drifting,
      driftLevel: this.driftLevel,
      boosting: this.turboLeft > 0 || this.fx === "boost",
      speed: Math.abs(this.forwardSpeed),
      airborne: this.airY > 0,
    });
  }
}
