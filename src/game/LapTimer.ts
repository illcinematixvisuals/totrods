/**
 * LapTimer.ts — lap counting with anti-cheat checkpoints.
 *
 * The track is a loop of N samples (index 0 = start/finish line). We place
 * invisible checkpoints at 25%, 50% and 75% of the way round. A lap only
 * counts if you pass all of them IN ORDER and then cross the line, so
 * cutting across the infield or reversing over the line doesn't work.
 *
 * This class knows nothing about Babylon — it's plain TypeScript logic,
 * which makes it easy to read and to test.
 */

/** What happened this frame. A "discriminated union": check `type` to know which. */
export type LapEvent =
  | { type: "checkpoint"; number: number }
  | { type: "lap"; lapTime: number; isBest: boolean }
  | { type: "finish"; lapTime: number; isBest: boolean; totalTime: number };

export class LapTimer {
  lap = 1; // the lap you're currently on (1-based)
  currentLapTime = 0; // seconds
  totalTime = 0;
  bestLap: number | null = null; // `null` until you finish a lap
  readonly lapTimes: number[] = [];
  finished = false;

  private readonly checkpoints: number[];
  private nextCheckpoint = 0;
  private lastIndex = 0;
  private running = false;

  constructor(
    readonly totalLaps: number,
    private readonly sampleCount: number,
    checkpointCount = 3,
  ) {
    // e.g. for 3 checkpoints: 25%, 50%, 75% of the loop.
    this.checkpoints = Array.from({ length: checkpointCount }, (_, i) =>
      Math.floor(((i + 1) / (checkpointCount + 1)) * sampleCount),
    );
  }

  get lastLap(): number | null {
    return this.lapTimes.length > 0 ? this.lapTimes[this.lapTimes.length - 1] : null;
  }

  reset(startIndex: number): void {
    this.lap = 1;
    this.currentLapTime = 0;
    this.totalTime = 0;
    this.bestLap = null;
    this.lapTimes.length = 0;
    this.finished = false;
    this.nextCheckpoint = 0;
    this.lastIndex = startIndex;
    this.running = false;
  }

  start(): void {
    this.running = true;
  }

  /** Rejoining an online race: continue from what the server remembers. */
  restore(lap: number, nextCheckpoint: number, elapsed: number, index: number): void {
    this.lap = Math.min(lap, this.totalLaps);
    this.nextCheckpoint = nextCheckpoint;
    this.totalTime = elapsed;
    this.currentLapTime = 0; // unknown after a reload; the server keeps the official times
    this.lastIndex = index;
    this.finished = lap > this.totalLaps;
    this.running = true;
  }

  /** Call every frame with the car's nearest track index. */
  update(dt: number, index: number, onTrack: boolean): LapEvent | null {
    if (!this.running || this.finished) return null;
    this.currentLapTime += dt;
    this.totalTime += dt;

    const n = this.sampleCount;
    const prev = this.lastIndex;
    this.lastIndex = index;
    let event: LapEvent | null = null;

    // Checkpoint: within a short window just past the checkpoint index.
    if (this.nextCheckpoint < this.checkpoints.length && onTrack) {
      const cp = this.checkpoints[this.nextCheckpoint];
      if (index >= cp && index < cp + n * 0.05) {
        this.nextCheckpoint++;
        event = { type: "checkpoint", number: this.nextCheckpoint };
      }
    }

    // Crossing the line forwards = index wraps from the end back to the start.
    const crossedLine = prev > n * 0.8 && index < n * 0.2;
    if (crossedLine && this.nextCheckpoint === this.checkpoints.length) {
      const lapTime = this.currentLapTime;
      const isBest = this.bestLap === null || lapTime < this.bestLap;
      if (isBest) this.bestLap = lapTime;
      this.lapTimes.push(lapTime);
      this.currentLapTime = 0;
      this.nextCheckpoint = 0;
      if (this.lap >= this.totalLaps) {
        this.finished = true;
        return { type: "finish", lapTime, isBest, totalTime: this.totalTime };
      }
      this.lap++;
      return { type: "lap", lapTime, isBest };
    }
    return event;
  }
}

/** Format seconds as m:ss.mmm (e.g. 1:05.042). */
export function formatTime(seconds: number | null): string {
  if (seconds === null) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
