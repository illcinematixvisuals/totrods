/**
 * Showcase.ts — the toddlers lined up on the living-room rug for the
 * title and character-select screens, plus the menu camera that films them.
 * Six toddlers stand in two rows of three so they all stay in frame.
 */
import { Camera, FreeCamera, Scene, ShadowGenerator, Vector3 } from "@babylonjs/core";
import { ROSTER } from "./Roster";
import { Walker } from "./Walker";

const CENTER = new Vector3(-25, 0, 25);
const SPACING = 2.35;
const ROW = 2.25;

export class Showcase {
  readonly camera: FreeCamera;
  readonly walkers: Walker[];
  private time = 0;
  /** Roster indexes that should bounce excitedly (hovered on the select screen). */
  highlighted: readonly number[] = [];

  constructor(scene: Scene, shadows: ShadowGenerator) {
    this.walkers = ROSTER.map((who, i) => {
      const w = new Walker(scene, shadows, who, `show${i}`);
      // Face the camera (south = heading π). Two rows of three, same order as the cards.
      const col = i % 3;
      const row = Math.floor(i / 3); // 0 = front (closer to the camera), 1 = back
      w.placeAt(CENTER.add(new Vector3((col - 1) * SPACING, 0, row * ROW)), Math.PI);
      return w;
    });
    this.camera = new FreeCamera("menuCam", new Vector3(-25, 3, 15), scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 600;
    this.camera.fov = 0.8;
  }

  setVisible(on: boolean): void {
    this.walkers.forEach((w) => w.setEnabled(on));
  }

  /** mode "orbit" for the title screen, "front" for character select. */
  update(dt: number, mode: "orbit" | "front"): void {
    this.time += dt;
    this.walkers.forEach((w, i) => {
      const excited = this.highlighted.includes(i);
      w.root.position.y = excited ? Math.abs(Math.sin(this.time * 7 + i)) * 0.3 : 0;
      w.lookAround(excited ? Math.sin(this.time * 3) * 0.5 : Math.sin(this.time * 0.8 + i * 2) * 0.25);
      w.animate(dt, excited ? 0.5 : 0.1);
    });
    // Phone held upright: keep the horizontal view fixed so all three toddlers still fit.
    const portrait = this.camera.getEngine().getAspectRatio(this.camera) < 1;
    this.camera.fovMode = portrait ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;
    this.camera.fov = portrait ? 1.15 : 0.85;
    if (mode === "orbit") {
      const a = Math.PI + Math.sin(this.time * 0.25) * (portrait ? 0.35 : 0.9); // sway in front of them
      const r = portrait ? 11 : 13.5;
      const look = CENTER.add(new Vector3(0, 0, ROW * 0.45));
      this.camera.position.set(look.x + Math.sin(a) * r, 3.2, look.z + Math.cos(a) * r);
      // Wide screens: toddlers sit right of the title card.
      // Upright phones: the card sits at the bottom, so aim low and the toddlers appear above it.
      this.camera.setTarget(look.add(portrait ? new Vector3(0, -1.4, 0) : new Vector3(-3.6, 1.1, 0)));
    } else {
      const look = CENTER.add(new Vector3(0, 0, ROW * 0.45));
      this.camera.position.set(look.x, 3.1, look.z - 11.5);
      this.camera.setTarget(look.add(new Vector3(0, 0.15, 0))); // aim low so toddlers sit above the cards
    }
  }
}
