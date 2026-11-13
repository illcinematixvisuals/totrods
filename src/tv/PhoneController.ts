/**
 * PhoneController.ts — the phone side of TV Party mode.
 *
 * Opening ?join=CODE (or /play?room=CODE) skips the 3D game entirely: this
 * page is a full-screen landscape controller. You type a name (optional),
 * pick a unique toddler, tap Ready, and then steer the walker that the TV
 * is simulating. Input is sent on every change plus a short heartbeat.
 *
 * The phone also:
 *  - keeps the screen awake (Wake Lock API, when the browser allows it)
 *  - can tilt-to-steer (DeviceOrientation, with iOS's permission prompt)
 *  - vibrates on pickups and bumps when the TV tells us to
 *  - reconnects automatically and reclaims the same seat after a reload
 */
import {
  CONTROLLER_HEARTBEAT_MS,
  PROTOCOL_VERSION,
  normalizeRoomCode,
  type CharacterId,
  type ControllerInputState,
  type ServerMessage,
  type TvControllerHud,
  type TvRoomSnapshot,
} from "../../shared/protocol";
import { byId, escapeHtml, portraitHTML } from "../game/Hud";
import { ROSTER } from "../game/Roster";
import { resolveServerUrl } from "../net/serverUrl";
import { TvNet } from "./TvNet";

const PAD_SESSION_KEY = "totrods-controller-session";
const NAME_KEY = "totrods-controller-name";

type TouchKey = "left" | "right" | "gas" | "brake" | "hand" | "reset";
const TOUCH_KEYS: readonly TouchKey[] = ["left", "right", "gas", "brake", "hand", "reset"];

export class PhoneController {
  private net: TvNet | null = null;
  private room: TvRoomSnapshot | null = null;
  private you = "";
  private hud: TvControllerHud | null = null;
  private readonly held: Record<TouchKey, boolean> = { left: false, right: false, gas: false, brake: false, hand: false, reset: false };
  private resetPulse = false;
  private tiltOn = false;
  private tiltSteer = 0;
  private lastSent = "";
  private heartbeat = 0;
  private wake: WakeLockSentinel | null = null;
  private driving = false;
  /** Test hook: freeze the current input instead of reading the buttons. */
  private forced: ControllerInputState | null = null;

  constructor(private readonly joinCode: string) {
    document.body.classList.add("phone-ui");
    this.bindDom();
    void this.connect(this.joinCode);
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  private async connect(code: string): Promise<void> {
    this.showJoin("Connecting…");
    const url = resolveServerUrl();
    this.net = new TvNet(url, PAD_SESSION_KEY, "controller_resume");
    const saved = TvNet.saved(PAD_SESSION_KEY);
    const want = normalizeRoomCode(code);
    if (saved?.role === "controller" && saved.code === want) this.net.session = saved;
    this.net.onStatus = (s) => {
      if (s === "reconnecting") this.banner("Reconnecting…");
      if (s === "open") this.banner(null);
      if (s === "closed") this.banner("Lost the connection.");
    };
    this.net.on((msg) => this.onMessage(msg));
    try {
      await this.net.connect();
    } catch (err) {
      this.showJoin(err instanceof Error ? err.message : "Could not connect.", true);
      return;
    }
    if (!this.net.session) {
      const name = byId<HTMLInputElement>("phoneName").value;
      this.net.send({ type: "controller_join", code, name, version: PROTOCOL_VERSION });
    }
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "tv_welcome":
        if (msg.role !== "controller") return;
        this.you = msg.you;
        this.applyRoom(msg.room);
        break;
      case "tv_room":
        this.applyRoom(msg.room);
        break;
      case "tv_state_to_controller":
        this.applyHud(msg.hud);
        break;
      case "tv_waiting":
        this.banner(msg.message);
        break;
      case "error":
        if (msg.code === "room-full") this.showJoin("Room full", true);
        else if (msg.code === "tv-gone" || msg.code === "expired" || msg.code === "no-room") {
          this.showJoin(msg.message, true);
          this.stopDriving();
        } else {
          const el = byId("phoneJoinStatus");
          el.textContent = msg.message;
          el.classList.toggle("error", true);
        }
        break;
      default:
        break;
    }
  }

  private applyRoom(room: TvRoomSnapshot): void {
    this.room = room;
    const me = room.players.find((p) => p.id === this.you);
    if (me && !byId<HTMLInputElement>("phoneName").value) {
      byId<HTMLInputElement>("phoneName").value = me.name;
    }
    // Mid-race late joiner: stay on the join screen with a clear message.
    if (me?.queued || (room.phase !== "lobby" && room.phase !== "results" && !this.driving && !me?.character)) {
      this.renderJoin(room);
      byId("phoneJoinStatus").textContent = "Race in progress, you're next";
      return;
    }
    if ((room.phase === "countdown" || room.phase === "racing") && me?.character && !me.queued) {
      this.startDriving(room);
      return;
    }
    this.renderJoin(room);
  }

  private applyHud(hud: TvControllerHud): void {
    this.hud = hud;
    if (!hud.tvConnected) this.banner("TV disconnected, waiting…");
    else if (this.net?.status === "open") this.banner(null);

    if (hud.phase === "lobby" || hud.phase === "results") {
      if (this.driving) this.stopDriving();
      if (this.room) this.renderJoin(this.room);
      return;
    }
    if ((hud.phase === "countdown" || hud.phase === "racing") && !this.driving && this.room) this.startDriving(this.room);

    const cd = byId("padCountdown");
    if (hud.countdown) {
      cd.textContent = hud.countdown;
      cd.classList.remove("hidden");
    } else {
      cd.classList.add("hidden");
    }
    byId("padLap").textContent = String(hud.lap);
    byId("padPlace").textContent = hud.place === null ? "—" : hud.place === 1 ? "1st" : hud.place === 2 ? "2nd" : hud.place === 3 ? "3rd" : `${hud.place}th`;
    const fx = byId("padEffect");
    fx.textContent = hud.effectText;
    fx.className = `pad-effect ${hud.effect ?? ""}`;
    if (hud.buzz) {
      try {
        navigator.vibrate?.(hud.buzz === "pickup" ? [30, 30, 30] : [40]);
      } catch {
        /* some browsers reject vibrate unless a gesture just happened */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Join UI
  // ---------------------------------------------------------------------------

  private showJoin(status: string, error = false): void {
    byId("phoneJoinScreen").classList.remove("hidden");
    byId("phonePadScreen").classList.add("hidden");
    const el = byId("phoneJoinStatus");
    el.textContent = status;
    el.classList.toggle("error", error);
  }

  private renderJoin(room: TvRoomSnapshot): void {
    byId("phoneJoinScreen").classList.remove("hidden");
    byId("phonePadScreen").classList.add("hidden");
    const me = room.players.find((p) => p.id === this.you);
    const holder = byId("phoneCards");
    holder.innerHTML = "";
    ROSTER.forEach((who) => {
      const owner = room.players.find((p) => p.character === who.id);
      const mine = owner?.id === this.you;
      const taken = !!owner && !mine;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `phone-pick ${mine ? "mine" : ""} ${taken ? "taken" : ""}`;
      btn.style.setProperty("--walker", who.walkerColor);
      btn.innerHTML = `${portraitHTML(who, 72)}<span>${escapeHtml(who.name)}</span>`;
      btn.disabled = taken || me?.queued === true;
      btn.addEventListener("click", () => {
        if (taken || me?.queued) return;
        this.net?.send({ type: "pick", character: (mine ? null : who.id) as CharacterId | null });
      });
      holder.appendChild(btn);
    });
    const ready = byId<HTMLButtonElement>("phoneReadyBtn");
    ready.disabled = !me?.character || me.queued;
    ready.classList.toggle("ready-on", !!me?.ready);
    ready.textContent = me?.ready ? "READY ✓" : "READY";
    const start = byId<HTMLButtonElement>("phoneHostStartBtn");
    const canStart = !!me?.host && !!me.ready && room.players.filter((p) => !p.queued).every((p) => p.ready && p.character);
    start.classList.toggle("hidden", !me?.host);
    start.disabled = !canStart;
    if (me?.queued) byId("phoneJoinStatus").textContent = "Race in progress, you're next";
    else if (!room.tvConnected) byId("phoneJoinStatus").textContent = "TV disconnected, waiting…";
    else { const s = byId("phoneJoinStatus"); s.textContent = ""; s.classList.remove("error"); }
  }

  // ---------------------------------------------------------------------------
  // Driving
  // ---------------------------------------------------------------------------

  private startDriving(room: TvRoomSnapshot): void {
    const me = room.players.find((p) => p.id === this.you);
    if (!me?.character) return;
    this.driving = true;
    byId("phoneJoinScreen").classList.add("hidden");
    byId("phonePadScreen").classList.remove("hidden");
    const who = ROSTER.find((r) => r.id === me.character)!;
    byId("padPortrait").innerHTML = portraitHTML(who, 64);
    byId("padName").textContent = me.name;
    byId("padCharacter").textContent = who.name;
    void this.requestWakeLock();
    this.loop();
  }

  private stopDriving(): void {
    this.driving = false;
    byId("phonePadScreen").classList.add("hidden");
    this.releaseWakeLock();
  }

  /** rAF loop: send input on change + a heartbeat, even if buttons aren't moving. */
  private loop = (): void => {
    if (!this.driving) return;
    const input = this.forced ?? this.read();
    const key = JSON.stringify(input);
    const now = performance.now();
    if (key !== this.lastSent || now - this.heartbeat >= CONTROLLER_HEARTBEAT_MS) {
      this.net?.send({ type: "controller_input", input });
      this.lastSent = key;
      this.heartbeat = now;
      // RESET is a one-shot so the next packet is false.
      this.resetPulse = false;
    }
    requestAnimationFrame(this.loop);
  };

  private read(): ControllerInputState {
    const left = this.held.left;
    const right = this.held.right;
    let steer = (right ? 1 : 0) - (left ? 1 : 0);
    if (this.tiltOn && steer === 0) steer = this.tiltSteer;
    return {
      steer,
      throttle: this.held.gas ? 1 : 0,
      brake: this.held.brake ? 1 : 0,
      drift: this.held.hand,
      reset: this.resetPulse,
    };
  }

  private bindDom(): void {
    const savedName = new URLSearchParams(location.search).get("name") || localStorage.getItem(NAME_KEY);
    if (savedName) byId<HTMLInputElement>("phoneName").value = savedName;
    byId<HTMLInputElement>("phoneName").addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value;
      localStorage.setItem(NAME_KEY, v);
    });
    byId("phoneReadyBtn").addEventListener("click", () => {
      const me = this.room?.players.find((p) => p.id === this.you);
      this.net?.send({ type: "ready", ready: !me?.ready });
    });
    byId("phoneHostStartBtn").addEventListener("click", () => this.net?.send({ type: "tv_start" }));

    const pad = byId("phonePadScreen");
    const update = (e: TouchEvent): void => {
      e.preventDefault();
      const pressed = new Set<TouchKey>();
      for (const t of Array.from(e.touches)) {
        const el = document.elementFromPoint(t.clientX, t.clientY)?.closest<HTMLElement>("[data-key]");
        if (el && pad.contains(el)) pressed.add(el.dataset.key as TouchKey);
      }
      if (pressed.has("reset") && !this.held.reset) this.resetPulse = true;
      for (const k of TOUCH_KEYS) this.held[k] = pressed.has(k);
      pad.querySelectorAll<HTMLElement>("[data-key]").forEach((b) => b.classList.toggle("active", pressed.has(b.dataset.key as TouchKey)));
    };
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      pad.addEventListener(type, update, { passive: false });
    }
    // Mouse clicks help the headless test (and a laptop opened as a "phone").
    pad.querySelectorAll<HTMLElement>("[data-key]").forEach((b) => {
      const key = b.dataset.key as TouchKey;
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (key === "reset") this.resetPulse = true;
        this.held[key] = true;
        b.classList.add("active");
      });
    });
    window.addEventListener("mouseup", () => {
      for (const k of TOUCH_KEYS) this.held[k] = false;
      pad.querySelectorAll("[data-key]").forEach((b) => b.classList.remove("active"));
    });

    byId("padTilt").addEventListener("click", () => void this.toggleTilt());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.driving) void this.requestWakeLock();
    });
  }

  private async toggleTilt(): Promise<void> {
    if (this.tiltOn) {
      this.tiltOn = false;
      this.tiltSteer = 0;
      byId("padTilt").textContent = "TILT STEER: OFF";
      byId("padTilt").classList.remove("on");
      return;
    }
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (typeof DOE.requestPermission === "function") {
        const res = await DOE.requestPermission();
        if (res !== "granted") {
          byId("padTilt").textContent = "TILT STEER: DENIED";
          return;
        }
      }
    } catch {
      byId("padTilt").textContent = "TILT STEER: UNAVAILABLE";
      return;
    }
    this.tiltOn = true;
    byId("padTilt").textContent = "TILT STEER: ON";
    byId("padTilt").classList.add("on");
    window.addEventListener("deviceorientation", (e) => {
      if (!this.tiltOn) return;
      // Portrait: gamma is left/right. Landscape: beta takes over, with a sign flip.
      const type = (screen.orientation?.type ?? "").toLowerCase();
      let angle = e.gamma ?? 0;
      if (type.includes("landscape-secondary") || (window.orientation ?? 0) === -90) angle = -(e.beta ?? 0);
      else if (type.includes("landscape") || Math.abs(window.orientation ?? 0) === 90) angle = e.beta ?? 0;
      this.tiltSteer = Math.max(-1, Math.min(1, angle / 25));
    });
  }

  private async requestWakeLock(): Promise<void> {
    try {
      this.wake = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.wake = null;
    }
  }

  private releaseWakeLock(): void {
    void this.wake?.release();
    this.wake = null;
  }

  private banner(text: string | null): void {
    const el = byId("padBanner");
    if (!text) {
      el.classList.add("hidden");
      return;
    }
    el.textContent = text;
    el.classList.remove("hidden");
  }

  // ---------------------------------------------------------------------------
  // Debug (used by the e2e test to drive the walker from the phone)
  // ---------------------------------------------------------------------------

  debugInfo(): object {
    return {
      you: this.you,
      code: this.room?.code ?? null,
      driving: this.driving,
      room: this.room,
      hud: this.hud,
      input: this.read(),
    };
  }

  hold(input: ControllerInputState): void {
    this.forced = input;
  }

  releaseHold(): void {
    this.forced = null;
  }
}

/** Boot the phone-only page (no Babylon engine). */
export function bootPhoneController(): void {
  const params = new URLSearchParams(location.search);
  const raw = params.get("join") ?? params.get("room") ?? "";
  const code = normalizeRoomCode(raw);
  const pad = new PhoneController(code || raw);
  (window as unknown as { __totrods: object }).__totrods = {
    controller: {
      info: () => pad.debugInfo(),
      hold: (input: ControllerInputState) => pad.hold(input),
      release: () => pad.releaseHold(),
    },
  };
}
