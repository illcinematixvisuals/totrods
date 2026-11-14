# TotRods — Graphics Upgrade Notes

A short analysis of the renderer, what the "premium kart racer" upgrade
changed, and what would need real artist-made assets to go further.

## 1. Where we started

**Engine.** Babylon.js 7 (`@babylonjs/core`) on WebGL2, TypeScript, built with
Vite. One `Engine` + one `Scene`; split-screen uses several cameras with
viewports (`scene.activeCameras`). The Node server only relays online rooms and
TV Party; all rendering and physics run in the browser.

**Assets.** Everything was procedural: no glTF models, no image textures except
canvas-painted `DynamicTexture`s (floors, rugs, banner) and the 2D portraits in
`public/portraits/` used by the HTML menus.

- Toddlers: ~60 primitive meshes each (spheres/cylinders), each with its own
  `StandardMaterial` → ~60 draw calls per toddler, ~20 materials each.
- Walkers: round base, six tiny casters, posts, tray (~25 meshes).
- House: four rooms of merged boxes (already merged per material — good).
- Lighting: one hemispheric fill + one directional "sun" with a 2048 (1024 on
  phones) PCF shadow map. Tone mapping (ACES) through image processing.
- Effects: two particle systems (boost sparkles, nap "z"s).
- Camera: smooth chase cam with a countdown swoop.

**Limits found.**
- Draw calls, not polygons, were the main cost: 6 showcase walkers + racers
  could reach 800+ draw calls before any effects — too many for phones in
  split-screen.
- No post-processing, no glow, no drift/turbo/jump feedback, no minimap, and
  the physics is 2D (y is always 0), so "real" jumps would change gameplay.
- Headless tests run on SwiftShader (a CPU software GPU), so absolute FPS
  numbers from CI are far below a real phone/TV/PC GPU.

## 2. Is Babylon.js enough?

**Yes.** Everything in the brief maps onto built-in Babylon features, so no
engine migration is needed (and none of the multiplayer, TV Party or controls
code had to change):

| Need | Babylon feature |
| --- | --- |
| Anime chibi characters, karts | procedural meshes (`MeshBuilder`, lathe, tubes), vertex colours, merged meshes, instancing |
| Soft skin, glossy paint | `StandardMaterial` with Fresnel rims (cheap), `PBRMaterial` where worth it |
| Expressions, blinking | canvas-painted `DynamicTexture` decals swapped at runtime |
| Shadows | `ShadowGenerator` (PCF), adjustable map size/refresh |
| Bloom, FXAA, vignette, chromatic aberration | `DefaultRenderingPipeline` |
| Glowing lights / boost trails | `GlowLayer`, `TrailMesh` |
| Drift smoke, sparks, confetti | `ParticleSystem` |
| Reflective floors | `MirrorTexture` / `ReflectionProbe` |
| Real artist models later | optional `@babylonjs/loaders` glTF loader |

## 3. What changed

### Stage 1 — characters and karts
- **ModelKit.ts**: vertex-colour "finishes" (matte, cloth, skin, gloss, metal,
  glow) shared by everyone, plus `PartBatch` which merges every part that moves
  together into one mesh per finish. A toddler + kart went from ~85 draw calls
  to ~25, which pays for all the new detail.
- **Toddler.ts** (rewritten): anime chibi proportions, soft skin (warm Fresnel
  rim), rosy cheeks painted into vertex colours, button nose, fringe bangs,
  smoother hair/puffs/curls; all accessories kept (DJ's orange headphones +
  hoodie, crowns for Adam/Logan/Snacks, Logan's pink bow and puffs, Huggie's
  bear hood + plush, MrNapTime's purple nightcap + blanket cape).
  It's rigged with plain nodes: leaning upper body, a head that glances and
  bobbles, and arms with simple IK that keep both hands on the steering wheel.
- **FaceTextures.ts**: big glossy anime eyes (two-tone iris, pupil, double
  highlight, bold lash flick) and mouths painted on canvases, projected onto the
  curve of the face. Expressions: smile, laugh (^ ^), ouch (> <), sleepy,
  focus (drifting), wow (jumps) + automatic blinking.
- **Kart.ts**: unique walker-karts: lathe-turned candy-paint tub with a colour
  gradient, bumper and stripe bands, nose with headlights and an emblem badge,
  fenders, spoiler with a name board readable from the chase cam, twin chrome
  exhausts, tail-lights, padded walker tray with toy buttons and a steering
  wheel, chunky wheels (one mesh + 3 instances) that spin and steer. Each kart
  has its own theme (speakers, crown, heart, bear ears, cookie, moon & stars).
  Change colours/emblems in `Roster.ts` / `KART_THEMES`.
- **Walker.ts**: spring-damper suspension (pitch on accel/brake, roll in turns,
  road bumps), a kid-friendly drift with three mini-turbo levels, rocket start,
  cartoon collisions (squash, shake, full spin on big hits, "ouch" face),
  visual-only jumps (Jumps.ts), celebrations (arms up, laughing, bouncing).
