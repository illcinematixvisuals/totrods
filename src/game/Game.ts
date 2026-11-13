/**
 * Game.ts — builds the shared world and runs the state machine:
 *
 *   title → select → countdown → racing → finished → (again) countdown
 *                                                   → (menu)  title
 *   title → online  (OnlineSession takes over until you leave the room)
 *   title → tvparty (TvSession: this screen is the TV, phones are controllers)
 *
 * The world (house, track, pickups, lights) is SHARED; everything per-racer
 * lives in Player. `players` is an array, so 1P and split-screen share code.
 *
 * Babylon.js concepts:
 *  - Scene: the container for meshes, lights and cameras.
 *  - HemisphericLight = soft fill from "the sky"; DirectionalLight = sunlight
 *    through the windows, which also casts shadows via a ShadowGenerator.
 *  - scene.activeCameras: render several cameras (each with its own viewport)
 *    in one frame. That is how split-screen works.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  ImageProcessingConfiguration,
  Scene,
  ShadowGenerator,
  Vector3,
  Viewport,
} from "@babylonjs/core";
import { bumpCircles, CollisionWorld } from "./Collisions";
import { House } from "./House";
import { OnlineSession } from "../net/OnlineSession";
import { TvSession } from "../tv/TvSession";
import { Screens, type ScreenRect, type SelectView, type TitleChoice } from "./Hud";
import { Keyboard, P1_KEYS, P2_KEYS, SOLO_KEYS, type KeyBindings } from "./Input";
import { Pickups, PICKUP_TUNING } from "./Pickups";
import { Player, isTouchDevice, type PlayerConfig } from "./Player";
import { ROSTER } from "./Roster";
import { Showcase } from "./Showcase";
import { START_INDEX, laneOffset } from "./StartGrid";
import { Sound } from "./Sound";
import { Track } from "./Track";

type GameState = "title" | "select" | "countdown" | "racing" | "finished" | "online" | "tvparty";

const TOTAL_LAPS = 3;
const COUNTDOWN_SECONDS = 3;

/** Screen slices for N players: 1 = full screen, 2 = top/bottom, 3-4 = 2×2 grid. */
export function layoutViewports(count: number): ScreenRect[] {
  if (count <= 1) return [{ x: 0, y: 0, width: 1, height: 1 }];
  if (count === 2) return [{ x: 0, y: 0.5, width: 1, height: 0.5 }, { x: 0, y: 0, width: 1, height: 0.5 }];
  const quads: ScreenRect[] = [
    { x: 0, y: 0.5, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    { x: 0, y: 0, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5 },
  ];
  return quads.slice(0, count);
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export class Game {
  readonly scene: Scene;
  players: Player[] = [];
  readonly collisions = new CollisionWorld();
  readonly track: Track;
  readonly pickups: Pickups;
  // Shared with OnlineSession (it builds its own players in the same world).
  readonly shadows: ShadowGenerator;
  readonly showcase: Showcase;
  readonly screens: Screens;
  readonly sound = new Sound();
  readonly online: OnlineSession;
  readonly tv: TvSession;
  private readonly keyboard = Keyboard.get();

  private state: GameState = "title";
  private playerCount: 1 | 2;
  private titleChoice: TitleChoice;
  private countdownLeft = 0;
  private lastCountdownShown = -1;

  // Character select state (one entry per player).
  private cursors: number[] = [];
  private picked: Array<number | null> = [];
  private selectCleanup: Array<() => void> = [];

  constructor(private readonly engine: Engine, initialPlayers: 1 | 2 = 1) {
    this.playerCount = initialPlayers;
    this.titleChoice = initialPlayers;
    this.scene = new Scene(engine);
    const scene = this.scene;
    scene.clearColor = new Color4(0.75, 0.9, 1, 1);
    scene.ambientColor = new Color3(0.3, 0.28, 0.25);
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.imageProcessingConfiguration.exposure = 1.1;
    scene.imageProcessingConfiguration.contrast = 1.1;

    // Warm indoor lighting: a creamy fill light + golden "afternoon sun".
    const fill = new HemisphericLight("fill", new Vector3(0.2, 1, 0.1), scene);
    fill.intensity = 0.8;
    fill.diffuse = new Color3(1, 0.95, 0.86);
    fill.groundColor = new Color3(0.55, 0.45, 0.4);
    const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, 0.4).normalize(), scene);
    sun.intensity = 1.25;
    sun.diffuse = new Color3(1, 0.9, 0.75);
    sun.position = sun.direction.scale(-120);
    // The house is compact, so ONE fixed shadow box covers all of it — every
    // player gets shadows in split-screen, wherever they are.
    sun.autoUpdateExtends = false;
    sun.orthoLeft = -60;
    sun.orthoRight = 60;
    sun.orthoTop = 60;
    sun.orthoBottom = -60;
    sun.shadowMinZ = 1;
    sun.shadowMaxZ = 260;
    // Phones: a 1024 shadow map is 4× cheaper than 2048 and looks fine on a small screen.
    this.shadows = new ShadowGenerator(isTouchDevice() ? 1024 : 2048, sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = 0.0012;
    this.shadows.normalBias = 0.02;
    this.shadows.darkness = 0.35; // soft indoor shadows

    new House(scene, this.shadows, this.collisions);
    this.track = new Track(scene, this.shadows, this.collisions);
    this.pickups = new Pickups(scene, this.track);
    this.showcase = new Showcase(scene, this.shadows);

    this.screens = new Screens(
      (i) => this.onCardClick(i),
      (choice) => {
        this.pickMode(choice);
        if (this.state === "title") this.confirmTitle();
      },
    );
    this.online = new OnlineSession(this);
    this.tv = new TvSession(this);
    this.bindMenuKeys();
    this.enterTitle();
  }

  // ---------------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    if (this.state === "online") {
      this.online.update(dt);
      return;
    }
    if (this.state === "tvparty") {
      this.tv.update(dt);
      return;
    }
    switch (this.state) {
      case "title":
        this.showcase.update(dt, "orbit");
        break;
      case "select":
        this.showcase.highlighted = this.cursors;
        this.showcase.update(dt, "front");
        break;
      case "countdown": {
        this.countdownLeft -= dt;
        const shown = Math.ceil(this.countdownLeft);
        if (shown !== this.lastCountdownShown && shown > 0) {
          this.lastCountdownShown = shown;
          this.screens.setCountdown(String(shown));
          this.sound.beep(440);
        }
        // Camera starts on the toddler's face, then swoops behind by "GO".
        const intro = smoothstep(Math.min(1, Math.max(0, (this.countdownLeft - 0.5) / 1.5)));
        for (const p of this.players) {
          p.rig.intro = intro;
          p.walker.lookAround(intro > 0.5 ? 0 : 0.6);
          p.updateIdle(dt);
        }
        if (this.countdownLeft <= 0) {
          this.state = "racing";
          this.players.forEach((p) => p.timer.start());
          this.screens.setCountdown("GO!");
          this.sound.beep(880, 0.4);
          window.setTimeout(() => this.screens.setCountdown(null), 800);
        }
        break;
      }
      case "racing":
      case "finished":
        this.updateRace(dt);
        break;
      default:
        break;
    }
    // Outside of racing, pickups still bob and respawn (nobody can collect them).
    if (this.state !== "racing" && this.state !== "finished") this.pickups.update(dt, []);
    this.players.forEach((p, i) => {
      this.sound.updateRoll(i, p.speed01, this.state === "racing");
      p.refreshHud();
    });
  }

  private updateRace(dt: number): void {
    // 1) Move everyone.
    for (const p of this.players) p.updateMovement(dt);
    // 2) Walls/furniture, then walker-vs-walker bumps, then walls again.
    for (const p of this.players) this.collisions.resolve(p.walker);
    for (let i = 0; i < this.players.length; i++)
      for (let j = i + 1; j < this.players.length; j++) bumpCircles(this.players[i].walker, this.players[j].walker);
    for (const p of this.players) this.collisions.resolve(p.walker);
    // 3) Shared pickups: whoever touches one first gets it.
    {
      const collectors = this.state === "racing" ? this.players.filter((p) => !p.finished) : [];
      for (const hit of this.pickups.update(dt, collectors)) {
        const p = this.players[hit.collector];
        p.applyPickup(hit.pickup.kind);
        if (PICKUP_TUNING[hit.pickup.kind].effect === "boost") this.sound.chirp();
        else this.sound.napTone();
      }
    }
    // 4) Lap progress.
    for (const p of this.players) {
      const ev = p.updateProgress(dt);
      if (ev?.type === "lap" || ev?.type === "finish") this.sound.jingle();
    }
    if (this.state === "racing" && this.players.every((p) => p.finished)) this.finishRace();
  }

  // ---------------------------------------------------------------------------
  // States
  // ---------------------------------------------------------------------------

  private enterTitle(): void {
    this.state = "title";
    this.showMenuScene();
    this.showcase.highlighted = [];
    this.screens.showTitle(this.titleChoice);
  }

  /** Called by OnlineSession when you leave online play. */
  backToTitle(): void {
    this.enterTitle();
  }

  /** The living-room line-up with the menu camera (title, online menu and lobby). */
  showMenuScene(): void {
    this.disposePlayers();
    this.showcase.setVisible(true);
    this.useMenuCamera();
    this.screens.setCountdown(null);
  }

  /** Title screen → TV Party (this screen becomes the host display). */
  enterTvParty(): void {
    this.sound.init();
    this.state = "tvparty";
    this.titleChoice = "tv";
    void this.tv.open();
  }

  /** Page reload while hosting a TV Party. Returns false if there's nothing to resume. */
  resumeTvParty(): boolean {
    this.state = "tvparty";
    if (this.tv.resumeSaved()) return true;
    this.state = "title";
    return false;
  }

  /** Lower resolution and refresh shadows when many split-screen viewports are on screen. */
  applyViewportBudget(count: number): void {
    const engine = this.engine;
    if (count >= 5) engine.setHardwareScalingLevel(1.7);
    else if (count >= 3) engine.setHardwareScalingLevel(1.35);
    else engine.setHardwareScalingLevel(1);
    const map = this.shadows.getShadowMap();
    if (map) map.refreshRate = count >= 5 ? 3 : count >= 3 ? 2 : 1;
  }

  resetViewportBudget(): void {
    this.engine.setHardwareScalingLevel(1);
    const map = this.shadows.getShadowMap();
    if (map) map.refreshRate = 1;
  }

  /** Title screen → online menu (optionally with a room code from a ?room= link). */
  enterOnline(code = ""): void {
    this.sound.init();
    this.state = "online";
    this.titleChoice = "online";
    this.online.open(code);
  }

  /** Page reload while in a room: go straight back into it. Returns false if there's nothing to resume. */
  resumeOnline(): boolean {
    this.state = "online";
    if (this.online.resumeSaved()) return true;
    this.state = "title";
    return false;
  }

  /** Enter / click on the title screen. */
  private confirmTitle(): void {
    if (this.titleChoice === "online") this.enterOnline();
    else if (this.titleChoice === "tv") this.enterTvParty();
    else this.enterSelect();
  }

  private enterSelect(): void {
    this.sound.init(); // audio must start from a user gesture
    this.state = "select";
    // Start cursors on different toddlers.
    this.cursors = this.playerCount === 2 ? [0, 2] : [0];
    this.picked = this.cursors.map(() => null);
    const bindings: KeyBindings[] = this.playerCount === 2 ? [P1_KEYS, P2_KEYS] : [SOLO_KEYS];
    bindings.forEach((b, p) => {
      this.selectCleanup.push(
        this.keyboard.onPress(b.left, () => this.moveCursor(p, -1)),
        this.keyboard.onPress(b.right, () => this.moveCursor(p, 1)),
        this.keyboard.onPress(b.confirm, () => this.confirmPick(p)),
      );
    });
    this.screens.showSelect(this.selectView());
  }

  private leaveSelect(): void {
    this.selectCleanup.forEach((fn) => fn());
    this.selectCleanup = [];
  }

  private selectView(): SelectView {
    const hints = this.playerCount === 2 ? [P1_KEYS.label, P2_KEYS.label] : [isTouchDevice() ? "Tap a toddler to race!" : SOLO_KEYS.label];
    return { cursors: this.cursors, picked: this.picked, hints };
  }

  private moveCursor(p: number, dir: number): void {
    if (this.state !== "select" || this.picked[p] !== null) return;
    const n = ROSTER.length;
    this.cursors[p] = (this.cursors[p] + dir + n) % n;
    this.screens.renderSelect(this.selectView());
  }

  /** Lock in a pick. Duplicates are NOT allowed: each toddler can only be picked once. */
  private confirmPick(p: number): void {
    if (this.state !== "select" || this.picked[p] !== null) return;
    const choice = this.cursors[p];
    if (this.picked.includes(choice)) {
      this.screens.renderSelect(this.selectView());
      return; // already taken by the other player
    }
    this.picked[p] = choice;
    this.sound.chirp();
    this.screens.renderSelect(this.selectView());
    if (this.picked.every((x) => x !== null)) window.setTimeout(() => this.beginRaceFromSelect(), 450);
  }

  private onCardClick(i: number): void {
    if (this.state !== "select") return;
    // Click/tap assigns the toddler to the first player who hasn't picked yet.
    const p = this.picked.findIndex((x) => x === null);
    if (p < 0 || this.picked.includes(i)) return;
    this.cursors[p] = i;
    this.confirmPick(p);
  }

  private beginRaceFromSelect(): void {
    if (this.state !== "select") return;
    this.leaveSelect();
    const keys = this.playerCount === 2 ? [P1_KEYS, P2_KEYS] : [SOLO_KEYS];
    const configs: PlayerConfig[] = this.picked.map((r, i) => ({
      label: this.playerCount === 2 ? `P${i + 1}` : "PLAYER",
      character: ROSTER[r ?? 0],
      keys: keys[i],
      touch: this.playerCount === 1,
    }));
    this.createPlayers(configs);
    this.startRace();
  }

  /** Build Player objects for a line-up (any number of players). */
  createPlayers(configs: readonly PlayerConfig[]): void {
    this.disposePlayers();
    this.players = configs.map((cfg, i) => {
      const p = new Player(i, cfg, this.scene, this.shadows, this.track, TOTAL_LAPS);
      p.onResetPressed = () => {
        if (this.state === "racing" && !p.finished) p.resetToTrack();
      };
      return p;
    });
  }

  private disposePlayers(): void {
    this.players.forEach((p) => p.dispose());
    this.players = [];
    this.sound.trimVoices(0);
    document.getElementById("touch")?.classList.add("hidden");
  }

  private startRace(): void {
    this.showcase.setVisible(false);
    this.screens.hideAll();
    const n = this.players.length;
    const rects = layoutViewports(n);
    this.players.forEach((p, i) => {
      const lane = laneOffset(i, n);
      p.timer.reset(START_INDEX);
      p.placeOnTrack(START_INDEX, lane);
      p.rig.intro = 1;
      p.rig.snap();
      p.setViewport(rects[i]);
      p.hud.setVisible(true);
    });
    this.scene.activeCameras = this.players.map((p) => p.rig.camera);
    this.state = "countdown";
    this.countdownLeft = COUNTDOWN_SECONDS;
    this.lastCountdownShown = -1;
  }

  private finishRace(): void {
    this.state = "finished";
    this.players.forEach((p) => p.hud.setVisible(false));
    this.screens.showFinish(
      this.players.map((p) => ({ who: p.config.character, lapTimes: p.timer.lapTimes, total: p.timer.totalTime, best: p.timer.bestLap })),
    );
  }

  private useMenuCamera(): void {
    this.showcase.camera.viewport = new Viewport(0, 0, 1, 1);
    this.scene.activeCameras = [this.showcase.camera];
  }

  private bindMenuKeys(): void {
    const kb = this.keyboard;
    const order: TitleChoice[] = [1, 2, "online", "tv"];
    const step = (dir: number) => () => {
      if (this.state !== "title") return;
      this.pickMode(order[(order.indexOf(this.titleChoice) + dir + order.length) % order.length]);
    };
    kb.onPress(["ArrowDown", "KeyS"], step(1));
    kb.onPress(["ArrowUp", "KeyW"], step(-1));
    kb.onPress("Digit1", () => this.state === "title" && this.pickMode(1));
    kb.onPress("Digit2", () => this.state === "title" && this.pickMode(2));
    kb.onPress("Digit3", () => this.state === "title" && this.pickMode("online"));
    kb.onPress("Digit4", () => this.state === "title" && this.pickMode("tv"));
    kb.onPress(["Enter", "Space"], () => {
      if (this.state === "title") this.confirmTitle();
      else if (this.state === "finished") this.startRace();
    });
    kb.onPress("Escape", () => {
      if (this.state === "select") {
        this.leaveSelect();
        this.enterTitle();
      } else if (this.state === "finished" || this.state === "racing" || this.state === "countdown") this.enterTitle();
    });
    kb.onPress("KeyM", () => this.sound.toggleMute());
    document.getElementById("restartBtn")?.addEventListener("click", () => this.state === "finished" && this.startRace());
    document.getElementById("menuBtn")?.addEventListener("click", () => this.state === "finished" && this.enterTitle());
  }

  private pickMode(choice: TitleChoice): void {
    this.titleChoice = choice;
    if (choice !== "online" && choice !== "tv") this.playerCount = choice;
    this.screens.setTitleMode(choice);
  }

  // ---------------------------------------------------------------------------
  // Debug helpers (used by automated tests and handy in the browser console)
  // ---------------------------------------------------------------------------

  debugInfo(): object {
    return {
      state: this.state,
      fps: Math.round(this.engine.getFps()),
      players: this.players.map((p) => ({
        name: p.config.character.name,
        speedMph: Math.round(p.walker.speedMph * 10) / 10,
        lap: p.timer.lap,
        progress: p.progress,
        effect: p.effect?.kind ?? null,
        x: Math.round(p.walker.position.x * 10) / 10,
        z: Math.round(p.walker.position.z * 10) / 10,
      })),
      pickups: this.pickups.items.map((i) => ({ kind: i.kind, active: i.active, x: i.position.x, z: i.position.z })),
    };
  }

  /** Teleport a player (for testing pickups and collisions). */
  debugPlace(player: number, x: number, z: number, heading?: number): void {
    const p = this.players[player];
    if (!p) return;
    p.walker.placeAt(new Vector3(x, 0, z), heading ?? p.walker.heading);
    p.progress = this.track.query(p.walker.position).index;
  }
}
