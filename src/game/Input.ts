/**
 * Input.ts — turns keyboard and touch events into a simple "what does the
 * driver want?" snapshot that a Car can read every frame.
 *
 * Multiplayer-ready: each player gets their own PlayerInput with its own
 * KeyBindings, so P1 can use WASD while P2 uses the arrow keys on the same
 * keyboard. All of them read from one shared Keyboard listener.
 *
 * TypeScript tip: an `interface` describes the *shape* of an object. Anything
 * with these fields counts as an InputState, no class needed.
 */
export interface InputState {
  throttle: number; // 0..1  (gas pedal)
  brake: number; // 0..1  (brake / reverse)
  steer: number; // -1 (left) .. +1 (right)
  handbrake: boolean;
}

/** Which key codes (KeyboardEvent.code) drive which action. */
export interface KeyBindings {
  label: string; // shown on the character select screen
  throttle: readonly string[];
  brake: readonly string[];
  left: readonly string[];
  right: readonly string[];
  handbrake: readonly string[];
  reset: readonly string[];
  confirm: readonly string[]; // pick a character
  /** Which game controller (Gamepad API index) also drives this player, if any. */
  pad?: number;
}

/** Single player: both WASD and arrows work. */
export const SOLO_KEYS: KeyBindings = {
  pad: 0,
  label: "← → to choose · Enter to confirm",
  throttle: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  handbrake: ["Space"],
  reset: ["KeyR"],
  confirm: ["Enter", "Space"],
};

/** Split-screen player 1: WASD + Space, R to reset. */
export const P1_KEYS: KeyBindings = {
  pad: 0,
  label: "P1: A / D to choose · Space to confirm",
  throttle: ["KeyW"],
  brake: ["KeyS"],
  left: ["KeyA"],
  right: ["KeyD"],
  handbrake: ["Space"],
  reset: ["KeyR"],
  confirm: ["Space"],
};

/** Split-screen player 2: arrows + Right Shift, Right Ctrl to reset. */
export const P2_KEYS: KeyBindings = {
  pad: 1,
  label: "P2: ← → to choose · Right Shift / Enter to confirm",
  throttle: ["ArrowUp"],
  brake: ["ArrowDown"],
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
  handbrake: ["ShiftRight"],
  reset: ["ControlRight"],
  confirm: ["ShiftRight", "Enter"],
};

/**
 * One window-wide keyboard listener shared by every player.
 * `static` members belong to the class itself, not to each instance.
 */
export class Keyboard {
  private static instance: Keyboard | null = null;
  readonly held = new Set<string>();
  private readonly pressHandlers = new Map<string, Array<() => void>>();

  static get(): Keyboard {
    Keyboard.instance ??= new Keyboard();
    return Keyboard.instance;
  }

  private constructor() {
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      // Typing your name or a room code must not steer, mute or start anything.
      if (e.target instanceof HTMLInputElement && e.code !== "Escape") return;
      // Stop arrows / space from scrolling the page.
      if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
      if (!e.repeat) [...(this.pressHandlers.get(e.code) ?? [])].forEach((fn) => fn());
      this.held.add(e.code);
    });
    window.addEventListener("keyup", (e: KeyboardEvent) => this.held.delete(e.code));
    // If the window loses focus, release everything so cars don't keep driving.
    window.addEventListener("blur", () => this.held.clear());
  }

  /**
   * Run `fn` once whenever any of `codes` is first pressed.
   * Returns a function that removes the handler again (call it on cleanup).
   */
  onPress(codes: string | readonly string[], fn: () => void): () => void {
    const list = typeof codes === "string" ? [codes] : codes;
    for (const code of list) {
      const handlers = this.pressHandlers.get(code) ?? [];
      handlers.push(fn);
      this.pressHandlers.set(code, handlers);
    }
    return () => {
      for (const code of list) {
        const handlers = this.pressHandlers.get(code);
        if (handlers) this.pressHandlers.set(code, handlers.filter((h) => h !== fn));
      }
    };
  }

  any(codes: readonly string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }
}

/** The on-screen touch buttons we support. A "union type" of string literals. */
type TouchKey = "left" | "right" | "gas" | "brake" | "hand" | "reset";
const TOUCH_KEYS: readonly TouchKey[] = ["left", "right", "gas", "brake", "hand", "reset"];

/**
 * The controls for ONE player. In online play, a remote player could use a
 * different source that also produces InputState (e.g. from the network).
 */
export interface InputSource {
  read(): InputState;
}

export class PlayerInput implements InputSource {
  private readonly keyboard = Keyboard.get();
  // Record<K, V> = an object whose keys are K and values are V.
  private readonly touch: Record<TouchKey, boolean> = {
    left: false,
    right: false,
    gas: false,
    brake: false,
    hand: false,
    reset: false,
  };
  private readonly resetHandlers = new Set<() => void>();

  constructor(readonly bindings: KeyBindings) {}

  /** Register this player's reset key (and the ↺ touch button). Returns an unsubscribe function. */
  onReset(fn: () => void): () => void {
    this.resetHandlers.add(fn);
    const off = this.keyboard.onPress(this.bindings.reset, fn);
    return () => {
      off();
      this.resetHandlers.delete(fn);
    };
  }

  /**
   * Wire up the on-screen buttons (elements with a data-key attribute).
   *
   * Instead of listening on each button, we look at EVERY finger on the screen
   * on each touch event and ask "which button is under it?". That way you can
   * hold ▲ with one thumb and slide the other thumb from ◀ to ▶ without lifting.
   * Returns a function that removes the listeners again.
   */
  bindTouchButtons(container: HTMLElement): () => void {
    const buttons = Array.from(container.querySelectorAll<HTMLElement>("[data-key]"));
    const update = (e: TouchEvent): void => {
      e.preventDefault(); // no scrolling, zooming or fake mouse clicks
      const pressed = new Set<TouchKey>();
      for (const t of Array.from(e.touches)) {
        const el = document.elementFromPoint(t.clientX, t.clientY)?.closest<HTMLElement>("[data-key]");
        if (el && container.contains(el)) pressed.add(el.dataset.key as TouchKey);
      }
      if (pressed.has("reset") && !this.touch.reset) this.resetHandlers.forEach((fn) => fn());
      for (const k of TOUCH_KEYS) this.touch[k] = pressed.has(k);
      for (const b of buttons) b.classList.toggle("active", pressed.has(b.dataset.key as TouchKey));
    };
    const types = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
    for (const type of types) container.addEventListener(type, update, { passive: false });
    return () => {
      for (const type of types) container.removeEventListener(type, update);
      buttons.forEach((b) => b.classList.remove("active"));
    };
  }

  /** Snapshot of the current controls. Called once per frame. */
  read(): InputState {
    const k = this.keyboard;
    const b = this.bindings;
    const left = k.any(b.left) || this.touch.left;
    const right = k.any(b.right) || this.touch.right;
    const state: InputState = {
      throttle: k.any(b.throttle) || this.touch.gas ? 1 : 0,
      brake: k.any(b.brake) || this.touch.brake ? 1 : 0,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      handbrake: k.any(b.handbrake) || this.touch.hand,
    };
    this.mergeGamepad(state);
    return state;
  }

  private padResetHeld = false;

  /**
   * Game controllers (Xbox / PlayStation / Switch Pro / TV remotes that act as
   * pads) via the browser Gamepad API, in the "standard" button layout:
   *   left stick / d-pad = steer (the stick is analogue),
   *   RT or A = go, LT or B = brake, RB / LB / X = drift, Y = reset.
   * Whichever is stronger — keys, touch or pad — wins, so they can be mixed.
   */
  private mergeGamepad(state: InputState): void {
    if (this.bindings.pad === undefined || !navigator.getGamepads) return;
    const pad = navigator.getGamepads()[this.bindings.pad];
    if (!pad || !pad.connected) return;
    const btn = (i: number): number => pad.buttons[i]?.value ?? 0;
    const pressed = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
    const stick = Math.abs(pad.axes[0] ?? 0) > 0.2 ? pad.axes[0] : 0; // dead-zone so a worn stick doesn't drift
    const dpad = (pressed(15) ? 1 : 0) - (pressed(14) ? 1 : 0);
    const steer = dpad !== 0 ? dpad : stick;
    if (Math.abs(steer) > Math.abs(state.steer)) state.steer = Math.max(-1, Math.min(1, steer));
    state.throttle = Math.max(state.throttle, btn(7), pressed(0) ? 1 : 0);
    state.brake = Math.max(state.brake, btn(6), pressed(1) ? 1 : 0);
    state.handbrake = state.handbrake || pressed(4) || pressed(5) || pressed(2);
    const reset = pressed(3);
    if (reset && !this.padResetHeld) this.resetHandlers.forEach((fn) => fn());
    this.padResetHeld = reset;
  }
}

/**
 * Input coming from a phone over the network (TV Party mode).
 * The TV feeds each walker one of these instead of a keyboard.
 * If the phone disconnects, call coast() so the walker rolls to a stop.
 */
export class RemoteInput implements InputSource {
  private current: InputState = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private resetQueued = false;

  apply(steer: number, throttle: number, brake: number, drift: boolean, reset: boolean): void {
    this.current = { steer, throttle, brake, handbrake: drift };
    if (reset) this.resetQueued = true;
  }

  /** Release the pedals so a disconnected walker coasts to a stop. */
  coast(): void {
    this.current = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  }

  /** True once after the phone tapped RESET (consumed so it does not repeat). */
  takeReset(): boolean {
    const v = this.resetQueued;
    this.resetQueued = false;
    return v;
  }

  read(): InputState {
    return this.current;
  }
}
