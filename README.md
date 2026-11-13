# TotRods

A tiny 3D arcade racer: **toddlers in baby walkers** zooming around a house.
Built with **TypeScript + Babylon.js + Vite**. 1 player, 2-player split-screen,
**online rooms**, or **TV Party** (everyone in the same room plays on one TV,
each person steering from their phone — like Jackbox). Up to 6 players (one
unique toddler each), 3 laps, pickups, bumper-walker collisions.

## Run it

```bash
npm install        # first time only
npm run dev        # game only, hot reload → http://localhost:5173   (1P / 2P)
npm run server     # game server only (WebSockets) on port 2567, restarts on edits
npm run dev:all    # both at once: open http://localhost:5173 and choose ONLINE
npm run build      # type-check + bundle the game into dist/, compile the server into server/dist/
npm start          # production: ONE server on $PORT (default 2567) serving the game AND WebSockets
npm run preview    # serve the built dist/ only → http://localhost:8080
npm run typecheck  # TypeScript checker for client and server
node tests/protocol-test.mjs   # quick server rules test (needs a running server)
# tests/online-e2e.mjs: two-browser end-to-end test (see the comment at its top)
```

`dist/` is a static site with relative paths, so you can upload it anywhere (itch.io, Netlify, GitHub Pages).
The Fredoka font is bundled from npm (`@fontsource/fredoka`), so the game also works offline.

## How to play

Title screen → pick **1 Player / 2 Players / Online / TV Party** (↑/↓, 1/2/3/4 or click) → **Enter** → choose your toddler → race!
`?players=2` in the URL pre-selects 2 players. `?tv=1` jumps straight into TV Party.

| | 1 Player | 2P: Player 1 | 2P: Player 2 |
|---|---|---|---|
| Go / brake / steer | W A S D or arrows | W A S D | arrows |
| Skid (drift) | Space | Space | Right Shift |
| Reset onto track | R | R | Right Ctrl |
| Character select | ← → / A D, Enter or Space | A / D, Space | ← →, Right Shift or Enter |

M = mute, Esc = back to menu. Touch screens get on-screen buttons (1 player and online):
◀ ▶ steer, ▲ go, ▼ brake, SKID drift, ↺ reset. You can slide a thumb between ◀ and ▶ without lifting.
Phones work held either way; sideways (landscape) gives the best view, and a small hint suggests it.
In 2-player mode each toddler can only be picked once (no duplicates).

**Pickups** (shared by everyone, respawn after 4 s):
milk bottle → MILK BOOST · snack cup → SNACK BOOST · floating crib → NAP TIME (slow).

## Online rooms

1. One player picks **ONLINE → CREATE ROOM**. They get a 4-letter code like `GE8Q`
   (no look-alike letters such as O/0 or I/1/L).
2. Friends pick **ONLINE**, type the code and **JOIN**, or just open the link shown in the lobby
   (`…/?room=GE8Q`).
3. In the lobby everyone picks a different toddler (click a card, or ← →) and presses **READY** (Enter).
4. The host (👑) presses **START RACE**. Everyone sees the same countdown, then you race.
   Other players' walkers have name tags (visible through walls so you can find each other).
5. The finish screen ranks everybody. **BACK TO LOBBY** for a rematch, **LEAVE ROOM** to quit.

Rooms hold **2–6 players**: there are 6 toddlers and picks must be unique, so the server caps a
room at 6. (Add another toddler to `ROSTER` *and* `CHARACTER_IDS` in `shared/protocol.ts`, plus a
3D model in `Toddler.ts` and a CSS portrait, and rooms, local select and TV Party all grow by
themselves.) If your connection drops, the game reconnects automatically and you keep
your seat for 20 seconds, even through a page reload. Esc leaves the room.

### How it works (WebSockets, messages, authority, interpolation)

- **WebSocket**: a connection that stays open, so the browser and the server can each send small
  messages whenever they like. (Normal HTTP is one question, one answer.) We use the plain
  [`ws`](https://github.com/websockets/ws) package on the server and the browser's built-in `WebSocket`.
- **Messages**: every message is a small JSON object with a `type`, for example
  `{ "type": "pick", "character": "adam-the-great" }`. All message types live in
  **`shared/protocol.ts`**, which both the game and the server import. Rename a field there and
  TypeScript shows every place on *both* sides that needs fixing.
- **Authority (who decides?)**: the **server** is the referee for everything that must be fair:
  rooms and codes, who's in the lobby, toddler picks (no duplicates), the start, the countdown
  time, checkpoints and laps (in order, not impossibly fast), the finish order, and pickups (if two
  players touch the same bottle, the first message to arrive wins, and everyone is told who got it).
  Each **client** decides only where its *own* walker is: it runs the physics locally, so steering
  feels instant, and sends its position, heading, speed, lean and boost/nap state 20 times a second.
- **Interpolation**: other players' walkers are drawn **100 ms in the past**. That way there is
  almost always one snapshot just before and one just after the moment we draw, and we blend
  smoothly between them (`src/net/RemotePlayer.ts`). Without this, remote walkers would jitter
  every time a packet arrived early or late.
- **Clock sync**: the server stamps snapshots and the race start with *its* clock. Clients ping the
  server every 2 s and estimate the difference between the clocks (`NetClient.serverNow()`), so
  everybody's countdown hits GO at the same moment.
- **Delta time**: the walker physics multiplies every change by the frame time (and grip uses
  `exp(-k·dt)`), so it behaves the same at 30 or 144 fps. The frame time is capped at 1/20 s.

### Configuring the server address

The game finds the server like this (first match wins):

1. `?server=wss://example.com` in the page URL
2. `VITE_SERVER_URL` at build time: `VITE_SERVER_URL=wss://my-server.example.com npm run build`
3. If the page came from the game server itself (`npm start`), the same host and port
4. Otherwise the same hostname on port **2567** (`ws://<host>:2567`), which suits `npm run dev:all`

The server reads `PORT` (default 2567) and `STATIC_DIR` (default `./dist`). `GET /healthz` returns `ok`.

### Free hosting (one service hosts both game and server)

Because the Node server also serves the built game, you deploy **one** web service. The simplest
free option is **[Render](https://render.com)**:

1. Push this folder to a GitHub repository.
2. On Render: **New → Web Service**, connect the repo, runtime **Node**.
3. Build command: `npm ci --include=dev && npm run build`
4. Start command: `npm start` (Render sets `PORT` for you). Health check path: `/healthz`.
5. Open `https://<your-service>.onrender.com`, pick ONLINE and share the room link.

Free Render services go to sleep after 15 minutes with no traffic and take about a minute to
wake up on the next visit. While anyone is connected, the game's pings keep the service awake.
**Railway** and **Fly.io** work the same way (one Node service, build `npm run build`, start
`npm start`, they also set `PORT`), but check their current pricing because their free
allowances change. If you host the game somewhere else (itch.io, GitHub Pages), build it with
`VITE_SERVER_URL=wss://<your-server>` so it knows where to connect.

### Known limitations

- **Cheating**: clients report their own positions, so a modified client could teleport. The server
  only checks that checkpoints come in order and that laps aren't impossibly fast (8 s minimum).
  That's fine for a game between friends; a competitive game would run the physics on the server.
- Rooms live in the server's memory: restarting or redeploying the server ends all rooms.
- One server process. Several instances behind a load balancer would need shared room storage.
- Bumping works one way: you bounce off other players' walkers, but only *their* computer moves them.
- Remote walkers are shown ~100 ms in the past, so very close finishes can look different on
  different screens. The server's finish order is the official one.
- No rate limiting or accounts: anyone with a room code can join while the room is in its lobby.

## TV Party mode

Couch co-op: one TV (or a laptop cast to a TV) shows the race in split-screen,
and each person in the room steers from their own phone.

1. On the TV's browser (or a laptop HDMI'd / Chromecast to the TV), open the
   site and pick **TV PARTY** (or add `?tv=1` to the URL).
2. A lobby appears with a **huge room code**, a **QR code**, and a short link.
   The QR and link use `window.location.origin`, so they work through the same
   public URL you opened (ngrok, Render, or `http://localhost:2567`).
3. Everyone else scans the QR (or opens `https://your-host/?join=CODE` or
   `/play?room=CODE`) on their phone. They land on a controller page — no need
   to pick 1P/2P/Online. Type a name (or keep "Player N"), pick a toddler
   (taken ones are greyed out; no duplicates), and tap **Ready**.
4. Press **START RACE** on the TV (Enter / click) or on the first phone. The
   TV counts down 3-2-1-GO (phones show it too), then you race 3 laps.
5. After the podium, **RACE AGAIN** returns everyone to the lobby (same
   players, Ready is cleared) or **NEW GAME** ends the party and goes back to
   the title screen. M mutes the TV. Sound plays from the TV only.

### How it works (host-authoritative TV, server is a relay)

This is the opposite of Online rooms. The **TV runs the whole simulation**
locally for every toddler (the same physics, pickups and walker-vs-walker
bumps as local split-screen). Each **phone only sends input** — steer, gas,
brake, drift, reset — on every change plus a short heartbeat, about 30–60
times a second. The server's job is the lobby: the room code, unique picks,
the Start button, relaying inputs to the TV and status (lap, place, boost /
nap) back to the phones, and holding seats if someone drops.

If a phone disconnects mid-race, its walker **coasts to a stop** and the seat
is held for **30 seconds** (a reload reclaims it). If the **TV** disconnects,
phones show "TV disconnected, waiting…" and the room is held for 2 minutes so
the TV can come back with the same code. A mid-race TV reload can't restore
the simulation, so everyone is sent back to the lobby.

Late joiners mid-race see **"Race in progress, you're next"** and are queued
for the following race. A 7th phone sees **"Room full"**.

### Split-screen and performance

The TV lays out 1–6 viewports: 1 = full screen, 2 = side-by-side (best on a
16:9 couch), 3 = one wide on top + two below, 4 = 2×2, 5–6 = a 3×2 grid.
Each viewport has its own chase camera and a TV-sized HUD (name, portrait,
lap, 1st/2nd/3rd, speed, boost bar) with that player's colour as a border.
With 3 or more viewports the TV lowers the shadow-map refresh rate and the
hardware resolution so a typical laptop or smart-TV browser stays smooth; at
5–6 viewports it lowers them further. All 6 are supported; if a very modest
device chugs with 5–6, play with 4 and leave extras queued for the next race.

### Phone controller

The phone is a full-screen landscape pad: big ◀ ▶, GAS, BRAKE, DRIFT and
RESET, plus the player's name, portrait, lap, place and boost/nap text from
the TV. Optional **tilt-to-steer** (on iOS this asks for motion permission).
The screen stays awake when the Wake Lock API is available, zoom/scroll are
blocked, and the phone vibrates on pickups and bumps when the browser allows
it.

To raise the player cap, add a toddler to `ROSTER` and `CHARACTER_IDS` (see
above) — TV Party uses the same cap.

## Project tour

```
index.html             Canvas + HUD template + title/select/finish/online/lobby + TV Party + phone pad
shared/protocol.ts     The typed message protocol + rules (laps, room size, TV Party) shared by both sides
server/src/index.ts    Node server: serves dist/ over HTTP + WebSockets on the same port, room codes
server/src/Room.ts     Online room: lobby, picks, start, laps, finish order, pickups, reconnect grace
server/src/TvRoom.ts   TV Party room: lobby referee + input/status relay (the TV simulates the race)
server/src/validate.ts Checks every incoming message (never trust the network)
src/tv/TvSession.ts    TV host: lobby (QR + code), split-screen race, results, status back to phones
src/tv/PhoneController.ts Phone-only controller page (no 3D engine): pick, ready, touch + tilt
src/tv/TvNet.ts        WebSocket helper for TV / phones (separate session from online rooms)
src/tv/qr.ts           Client-side QR code for the phone join URL
src/net/NetClient.ts   Browser WebSocket wrapper: typed send/receive, clock sync, auto-reconnect
src/net/OnlineSession.ts Online menu, lobby, online race and results (client side)
src/net/RemotePlayer.ts  Another player's walker: snapshot buffer + interpolation + name tag
src/net/serverUrl.ts   Picks the server address (?server=, VITE_SERVER_URL, same origin, :2567)
tests/protocol-test.mjs  Raw-WebSocket test of the server rules
src/main.ts            Entry: loads the font, creates the Engine, runs the render loop
src/style.css          Playful HUD/menu styling + CSS-drawn toddler portraits
src/game/Game.ts       Shared world (lights, shadows, house, track, pickups) + state machine:
                       title → select → countdown → racing → finished
src/game/Player.ts     Everything for ONE racer: walker, input, camera, lap timer, HUD, effects
src/game/Roster.ts     The six toddlers (skin tone, hair, accessory, walker colours)
src/game/StartGrid.ts  Starting lanes + the TV split-screen viewport layouts (1–6 players)
src/game/Toddler.ts    Builds a toddler (big head, face, hair, headphones/crown+cape/tiara)
src/game/Walker.ts     Baby-walker model + zippy, wobbly arcade physics (WALKER_TUNING)
src/game/House.ts      Rooms, walls with doorways, furniture, colliders (meshes merged for speed)
src/game/Track.ts      Racing-line spline, tape + arrows, TotRods baby gate, local track search
src/game/Collisions.ts Circle-vs-box (walls/furniture) and circle-vs-circle (walker bumps)
src/game/Pickups.ts    Pickup kinds (typed union), tuning table, shared state, models
src/game/Effects.ts    Sparkle and "zzz" particle systems
src/game/CameraRig.ts  Chase camera (face-first intro during the countdown, FOV kick on boost)
src/game/Showcase.ts   Toddler line-up + menu camera for the title/select screens
src/game/Input.ts      Shared Keyboard + per-player key bindings (SOLO / P1 / P2) + RemoteInput (phones)
src/game/LapTimer.ts   Laps + 3 in-order checkpoints + best lap (plain TypeScript)
src/game/Hud.ts        Per-player HUD + shared screens
src/game/Sound.ts      Synth sounds: rolling hum per player, chirps, nap tone, beeps
```

**How a frame works:** `main.ts` → `engine.runRenderLoop` → `game.update(dt)`
(move walkers → resolve collisions → collect pickups → update laps/HUD) → `scene.render()`.

**Multiplayer structure:** there is no global player. `Game.players` is an array; each
`Player` has its own key bindings, camera viewport, lap timer and HUD. Pickups live in one
shared `Pickups` object. Online, `OnlineSession` takes over from `Game`: it builds one local
`Player` (full screen) plus a `RemotePlayer` per friend, and switches `Pickups` to
server-controlled mode (`autoRespawn = false`, `take()` / `restore()` when the server says so).

**Debugging:** in the browser console, `__totrods.info()` shows the state, players and pickups;
`__totrods.online.info()` shows the room, remote walkers and pickups as this client sees them, and
`__totrods.online.drop()` cuts the connection to test reconnecting;
`__totrods.place(0, x, z)` teleports player 1; `__totrods.scene` is the Babylon scene.

## Learning exercises

1. **Tune the feel.** Change `WALKER_TUNING` in `Walker.ts` (e.g. `turnRateSlow`, `grip`, `maxSpeed`)
   or `PICKUP_TUNING` in `Pickups.ts` and feel the difference.
2. **Add a pickup.** Add `"bubbles"` to the `PickupKind` union. TypeScript will now point at every
   place you need to handle it (tuning table, model, layout). Make it spin the walker around!
3. **Add a toddler.** Add a seventh entry to `ROSTER` with a new accessory (e.g. `"cap"`), then teach
   `Toddler.ts` and the CSS portrait how to draw it. Add its id to `CHARACTER_IDS` in
   `shared/protocol.ts` too, and online rooms, local select and TV Party all grow to 7 players.
4. **Save best laps.** Store each toddler's best lap in `localStorage` and show it on the select cards.
5. **New room.** Add a bathroom to `House.ts` (tile floor, bathtub collider) and move some
   `CONTROL_POINTS` in `Track.ts` so the course runs through it.
6. **Online chat bubbles.** Add `{ type: "emote"; emoji: string }` to `ClientMessage` and
   `ServerMessage` in `shared/protocol.ts`, relay it in `Room.ts`, and show the emoji above the
   sender's name tag for two seconds. TypeScript will guide you through both sides.
