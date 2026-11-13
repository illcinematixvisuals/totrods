/**
 * Sound.ts — tiny synthesized sounds with the Web Audio API (no audio files).
 *
 *  - One soft "rolling" hum per player, pitched by speed (split-screen mixes both).
 *  - A happy chirp for boosts, a slow descending tone for nap time,
 *    countdown beeps and a little lap jingle.
 *
 * Browsers only allow audio after a user click/keypress, so call init() then.
 * iPhones are stricter: the AudioContext must be resumed AND make a sound
 * inside a tap. unlock() does that, and main.ts calls it on every tap.
 */
interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly voices: Voice[] = [];
  muted = false;

  init(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null; // no audio available — the game still works silently
    }
  }

  /** Call from a tap/click handler: starts (or wakes up) audio on iOS and Android. */
  unlock(): void {
    this.init();
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running") return;
    void ctx.resume().catch(() => {});
    // Playing a 1-sample silent buffer inside the gesture is what really unlocks iOS Safari.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  }

  get state(): string {
    return this.ctx?.state ?? "none";
  }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  private voice(i: number): Voice | null {
    if (!this.ctx || !this.master) return null;
    while (this.voices.length <= i) {
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 700;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(this.master);
      osc.start();
      this.voices.push({ osc, gain });
    }
    return this.voices[i];
  }

  /** Per-player rolling hum. `speed01` 0..1+, `active` false = silent. */
  updateRoll(player: number, speed01: number, active: boolean): void {
    const v = this.voice(player);
    if (!v || !this.ctx) return;
    const t = this.ctx.currentTime;
    v.osc.frequency.setTargetAtTime(90 + speed01 * 160, t, 0.06);
    v.gain.gain.setTargetAtTime(active ? 0.02 + Math.min(speed01, 1.5) * 0.05 : 0, t, 0.1);
  }

  /** Silence voices for players that no longer exist. */
  trimVoices(count: number): void {
    if (!this.ctx) return;
    this.voices.slice(count).forEach((v) => v.gain.gain.setTargetAtTime(0, this.ctx!.currentTime, 0.05));
  }

  private tone(type: OscillatorType, from: number, to: number, start: number, duration: number, volume: number): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + start;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + duration);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  beep(freq: number, duration = 0.18): void {
    this.tone("square", freq, freq, 0, duration, 0.08);
  }

  /** Two quick rising notes: "boo-ip!" */
  chirp(): void {
    this.tone("sine", 660, 990, 0, 0.12, 0.18);
    this.tone("sine", 880, 1480, 0.1, 0.16, 0.18);
  }

  /** Slow sleepy slide down. */
  napTone(): void {
    this.tone("sine", 520, 160, 0, 1.3, 0.16);
  }

  /** Little arpeggio for finishing a lap. */
  jingle(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone("triangle", f, f, i * 0.09, 0.16, 0.12));
  }
}
