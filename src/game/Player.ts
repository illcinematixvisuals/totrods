/**
 * Player.ts — everything that belongs to ONE racer, bundled together:
 * walker (toddler + physics), controls, chase camera, lap timer, HUD,
 * particle effects and any active pickup effect.
 *
 * Game keeps `players: Player[]`. Single-player is an array of length 1;
 * split-screen adds a second Player with different keys and viewport.
 * For online play, a remote Player would get its InputSource from the network.
 */
import { Scene, ShadowGenerator, Viewport } from "@babylonjs/core";
import { CameraRig } from "./CameraRig";
import { PlayerEffects } from "./Effects";
import { PlayerHud, type ScreenRect } from "./Hud";
import { PlayerInput, type InputSource, type KeyBindings } from "./Input";
import { LapTimer, type LapEvent } from "./LapTimer";
import { PICKUP_TUNING, type Collector, type PickupKind, type PickupTuning } from "./Pickups";
import type { RosterEntry } from "./Roster";
import type { Track } from "./Track";
import { Walker, WALKER_TUNING, type SpeedMods } from "./Walker";

/** Phones and tablets: show the on-screen buttons. */
export function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export interface PlayerConfig {
  label: string; // small tag on the HUD, e.g. "P1"
  character: RosterEntry; // who's driving
  keys?: KeyBindings; // omitted when `input` is provided (TV Party phones)
  touch?: boolean; // bind the on-screen touch buttons to this player
  input?: InputSource; // e.g. a RemoteInput fed by a phone
  showPlace?: boolean; // show 1st / 2nd / 3rd on the HUD (TV Party)
  id?: string; // network id (TV Party / tests)
}

/** A pickup effect currently running on this player. */
interface ActiveEffect {
  kind: PickupKind;
  tuning: PickupTuning;
  left: number; // seconds remaining
}

export class Player implements Collector {
  readonly walker: Walker;
  readonly rig: CameraRig;
  readonly timer: LapTimer;
  readonly hud: PlayerHud;
  readonly input: InputSource;
  private readonly effects: PlayerEffects;
  private readonly cleanup: Array<() => void> = [];

  /** Last known index along the racing line (used for the local track search). */
  progress = 0;
  effect: ActiveEffect | null = null;
  /** Live race position (1 = first). TV Party writes this every frame. */
  place: number | null = null;
  private glanceTimer = 3 + Math.random() * 3;
  private glanceHold = 0;

  /** Game sets this to decide when a reset is allowed (only while racing). */
  onResetPressed: (() => void) | null = null;

  constructor(
    readonly index: number,
    readonly config: PlayerConfig,
    scene: Scene,
    shadows: ShadowGenerator,
    private readonly track: Track,
    totalLaps: number,
  ) {
    const id = `p${index}`;
    this.walker = new Walker(scene, shadows, config.character, id);
    this.rig = new CameraRig(scene, this.walker, id);
    this.timer = new LapTimer(totalLaps, track.sampleCount);
    this.hud = new PlayerHud(config.label, config.character);
    this.effects = new PlayerEffects(scene, this.walker.emitter);

    if (config.input) {
      this.input = config.input;
    } else {
      const input = new PlayerInput(config.keys ?? { label: "", throttle: [], brake: [], left: [], right: [], handbrake: [], reset: [], confirm: [] });
      this.cleanup.push(input.onReset(() => this.onResetPressed?.()));
      if (config.touch) {
        const touchEl = document.getElementById("touch");
        if (touchEl && isTouchDevice()) {
          touchEl.classList.remove("hidden");
          this.cleanup.push(input.bindTouchButtons(touchEl));
        }
      }
      this.input = input;
    }
    if (config.showPlace) this.hud.setPlace(null);
  }

  // Collector interface (used by Pickups)
  get position() {
    return this.walker.position;
  }
  get radius(): number {
    return this.walker.radius;
  }
  get finished(): boolean {
    return this.timer.finished;
  }

  setViewport(r: ScreenRect): void {
    this.rig.camera.viewport = new Viewport(r.x, r.y, r.width, r.height);
    this.hud.setRect(r);
  }

  /** Put the walker on the racing line at `index`, shifted sideways by `lane` units. */
  placeOnTrack(index: number, lane = 0): void {
    const pose = this.track.poseAt(index);
    this.walker.placeAt(pose.position.add(this.track.rightAt(index).scale(lane)), pose.heading);
    this.progress = this.track.wrap(index);
    this.clearEffect();
    this.rig.snap();
  }

  /** R key: back onto the racing line, facing the right way. */
  resetToTrack(): void {
    const q = this.track.query(this.walker.position, this.progress);
    const keepEffect = this.effect;
    this.placeOnTrack(q.index);
    this.effect = keepEffect;
    this.hud.flash("OOPSIE! RESET", 0.9);
  }

  applyPickup(kind: PickupKind): void {
    const tuning = PICKUP_TUNING[kind];
    this.effect = { kind, tuning, left: tuning.duration };
    this.effects.setMode(tuning.effect);
    this.hud.flash(tuning.message, 1.4, tuning.effect === "boost" ? "good" : "bad");
    this.glanceHold = 0.9; // the toddler looks back, delighted (or sleepy)
  }

  private clearEffect(): void {
    this.effect = null;
    this.effects.setMode(null);
  }

  private mods(): SpeedMods {
    return this.effect ? { speed: this.effect.tuning.speedMul, accel: this.effect.tuning.accelMul } : { speed: 1, accel: 1 };
  }

  /** Countdown / menus: no driving, just idle animation and camera. */
  updateIdle(dt: number): void {
    this.walker.animate(dt, 0);
    this.rig.update(dt);
  }

  /** One racing frame (movement only; Game resolves collisions afterwards). */
  updateMovement(dt: number): void {
    if (this.effect) {
      this.effect.left -= dt;
      if (this.effect.left <= 0) this.clearEffect();
    }
    const controls = this.finished ? { throttle: 0, brake: 0.4, steer: 0, handbrake: false } : this.input.read();
    this.walker.update(dt, controls, this.mods());

    // Every few seconds the toddler glances back at the camera (so you see the face).
    this.glanceTimer -= dt;
    if (this.glanceTimer <= 0) {
      this.glanceHold = 0.9;
      this.glanceTimer = 4 + Math.random() * 4;
    }
    this.glanceHold -= dt;
    this.walker.lookAround(this.glanceHold > 0 ? 1.15 : -this.walker.slideSpeed * 0.04);

    this.rig.fovKick = this.effect?.tuning.effect === "boost" ? 0.28 : this.effect ? -0.08 : 0;
  }

  /** After collisions: update lap progress and react to lap events. */
  updateProgress(dt: number): LapEvent | null {
    const q = this.track.query(this.walker.position, this.progress);
    this.progress = q.index;
    this.rig.update(dt);
    if (this.finished) return null;
    const event = this.timer.update(dt, q.index, q.distance < this.track.halfWidth * 2.5);
    const total = this.timer.totalLaps;
    if (event?.type === "lap") {
      this.hud.flash(event.isBest ? `BEST LAP!  LAP ${this.timer.lap}/${total}` : `LAP ${this.timer.lap}/${total}`, 1.6, "good");
      if (this.timer.lap === total) window.setTimeout(() => this.hud.flash("FINAL LAP!", 1.4, "good"), 1700);
    } else if (event?.type === "finish") {
      this.hud.flash("FINISHED!", 3, "good");
    } else if (!this.effect && Math.abs(this.walker.slideSpeed) > 4 && this.walker.speedMph > 15) {
      this.hud.flash("WHEEE!", 0.4);
    }
    return event;
  }

  refreshHud(): void {
    this.hud.update({
      speedMph: this.walker.speedMph,
      lap: this.timer.lap,
      totalLaps: this.timer.totalLaps,
      current: this.timer.currentLapTime,
      last: this.timer.lastLap,
      best: this.timer.bestLap,
      effect: this.effect?.tuning.effect ?? null,
      effectLeft01: this.effect ? this.effect.left / this.effect.tuning.duration : 0,
    });
    if (this.config.showPlace) this.hud.setPlace(this.place);
  }

  /** 0..1+ speed for the rolling sound. */
  get speed01(): number {
    return Math.abs(this.walker.forwardSpeed) / WALKER_TUNING.maxSpeed;
  }

  dispose(): void {
    this.cleanup.forEach((fn) => fn());
    this.effects.dispose();
    this.walker.dispose();
    this.rig.camera.dispose();
    this.hud.dispose();
  }
}
