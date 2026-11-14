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

### Stage 2 — environments and lighting

- **Backyard playground** (House.ts `buildBackyard`): two new doors in the living
  room's north wall lead out to a fenced garden — painted grass with daisies,
  white picket fence, sandbox with bucket/spade/sand castle, a swing set whose
  swings really swing, a slide, a paddling pool with scrolling ripples and a
  bobbing rubber duck, trees, flower beds, the beach ball, a sweeping sprinkler
  (particles) and fluttering butterflies. The lap now goes living room →
  backyard → back inside → kitchen → nursery → hallway (Track.ts `CONTROL_POINTS`).
  The server has no track data, so online/TV play is unaffected.
- **Track surface** (Track.ts `buildRoad`): a soft grey "car-play-rug road" with
  white edge lines under the racing line, red/white kerbs on both sides, the
  yellow tape centre line and chevrons on top. Three ribbons = three draw calls.
- **Pillow ramps** (Track.ts `buildRamps` + Jumps.ts): three striped wedges
  (backyard, hallway, nursery). Rolling over one at speed does a visual hop.
- **More toys and furniture**: alphabet blocks that spell TOT/ROD/TOTRODS (one
  texture atlas + `faceUV`, all merged into one mesh), heaps of giant pillows,
  a stacking-ring toy, a floor lamp with a glowing shade, giant cereal box, milk
  carton and toaster on the kitchen counter.
- **Lighting and reflections**: glossy wood and tile floors use a
  `ReflectionProbe` per room rendered ONCE (refresh rate RENDER_ONCE) with a
  Fresnel falloff, so the floors shine at grazing angles and cost nothing per
  frame. The sun's shadow box was widened and re-centred to cover the yard.
- **Sky**: an inside-out sphere coloured per vertex (deep blue overhead → pale
  horizon) with nine drifting puffy clouds.
- **Animated scenery** (`House.update(dt)`, ticked by Game.ts): a looping cartoon
  on the TV (repainted ~8×/s), spinning baby mobile over the race-car bed,
  swings, duck, pool ripples, sprinkler, butterflies, clouds.
- **Quality.ts**: picks a tier (`high` desktop / `medium` phones / `low` old
  devices, or `?quality=low|medium|high`). Low skips floor reflections and the
  sprinkler, and has fewer butterflies.
