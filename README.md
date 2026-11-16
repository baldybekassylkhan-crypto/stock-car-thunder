# Stock Car Thunder

A 3D stock-car racing game that runs entirely in the browser as static files, so it can be hosted
for free on GitHub Pages. You pick a nickname and race; there is no account or registration.
Multiplayer (up to 12 players per room, joined with a 6-character room code, plus AI drivers for grids of up to 32 cars) uses peer-to-peer WebRTC.

## Status

| Milestone | What | State |
|---|---|---|
| 1 | Project setup, GitHub Pages deploy, nickname + lobby UI | ✅ done |
| 2 | Driving physics on Sunvale Superspeedway | ✅ done |
| 3 | Online rooms (PeerJS): host/join by code or link, 10-player cap, chat, pings, synced cars | ✅ done |
| 4 | Race logic: AI drivers, grid, rolling start, laps, positions, cautions, flags, results | ✅ done |
| 5 | Damage: crumpling bodywork, parts flying off, mechanical damage, fire, explosions | ✅ done |
| 6 | Iron Hollow (night short track) + Cedar Ridge (road course, optional rain) | ✅ done |
| 7 | Graphics polish, recorded audio, 3D sound for other cars, optimisation | later |

### Update: Open-Wheel GP series (see `PROMPT-open-wheel-update.md`)

| Milestone | What | State |
|---|---|---|
| A | Stock-car damage fix: contact is cosmetic, only big crashes wreck cars; steadier AI on banked turns | ✅ done |
| B | 12 human players, up to 32 cars with AI; LOD, batched snapshots, compact leaderboard | ✅ done |
| C | Car choice in every race type: 6 cars in 2 series, open-wheel body, lobby car picker | ✅ done |
| D | Open-Wheel GP driving model | next |
| E | Pit stops (both series) | |
| F | Three new GP circuits | |

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (branch `main`).
2. In the repository, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Every push to `main` runs `.github/workflows/deploy.yml`, which builds the game and publishes it at
   `https://<user>.github.io/<repo>/`.

## Controls

| Key | Action |
|---|---|
| W / ↑ | Throttle |
| S / ↓ | Brake (hold while stopped to reverse) |
| A D / ← → | Steer |
| Q / E | Shift down / up (manual gearbox; toggle with M) |
| C | Cycle camera (chase, far chase, hood, cockpit, TV) · next car when spectating |
| Mouse drag | Hold a mouse button and drag to look around; release and the camera swings back |
| Hold R (3 s) | Reset car to the track (5 s penalty in a race) · new car in free practice after a wreck |
| Esc / P | Pause |
| F3 | Debug overlay |

Gamepad: left stick steers, RT/LT are throttle/brake, LB/RB shift, Y changes camera, holding X for 3 s resets.

## Playing online

1. One player clicks **Host room**. They get a 6-character code (and a shareable link).
2. Friends click **Join room** and type the code, or just open the link.
3. Everyone presses **Ready**, then the host picks the track, laps, damage level, AI drivers and weather and clicks **Start race**.

Up to 12 people can join a room, and the host can fill the grid with AI drivers up to 32 cars. Connections go directly browser-to-browser over WebRTC.
A few strict corporate or mobile networks block direct WebRTC connections; on those, players may not be able to connect (there is no relay server).

## Car choice

The host picks the **series** for the room, and every driver picks a car from it in the lobby (single
races too). The picker shows a rotating 3D preview, stat bars, top speed, power and weight. The host
can also set **Cars → All drive: …** so everyone races the same car. AI drivers get an even mix of
the series' cars. Picks are saved per series in your profile.

| Series | Car | Character |
|---|---|---|
| Stock Car | Vanguard SR | Balanced: the reference car |
| Stock Car | Ironhide 427 | Torque: strong off the corners, best on short tracks, heavier |
| Stock Car | Stiletto Aero | Aero: low drag, fastest on the superspeedway, loose in traffic |
| Open-Wheel GP | Apex GP-1 | Balanced |
| Open-Wheel GP | Titan HD-7 | High downforce: quickest on twisty circuits, slow on straights |
| Open-Wheel GP | Falcon LD-3 | Low drag: fastest in a straight line, nervous in fast corners |

Open-wheel cars weigh 800 kg with about 1,000 hp, an 8-speed gearbox and four times the downforce of
a stock car. In AI testing they lap Iron Hollow in about 14 s (stock 17 s), Cedar Ridge in about 71 s
(stock 84 s) and Sunvale in about 42 s (stock 45 s). All names are fictional.

Every car is a full spec in `src/vehicle/catalog.ts` (mass, springs, tyres, torque curve, gearbox,
aero, geometry, collision hull, damage profile); `src/vehicle/car.ts` reads all of its physics from
it. The open-wheel body is built in `src/vehicle/openWheelModel.ts` and reuses the stock car's damage
part slots (front wing, nose cone, sidepods, engine cover, rear wing, diffuser, wheels), so damage,
debris and networking work the same for both bodies.

## Damage and crashes

- **Bodywork crumples** where the car is hit (vertex deformation). Bumpers, splitter, hood, spoiler, side skirts and even wheels come off and become physical debris.
- **Mechanical damage:** engine power, radiator/overheating (engines can blow), steering, wheel alignment (car pulls to one side), punctures, and lost aero.
- **Tough like real stock cars:** door-to-door rubbing, bump drafting and light wall scrapes only scuff the paint. Damage starts above a threshold and grows faster than the hit strength, so it's the big crashes that hurt. Only hits to the nose damage the engine. An engine knocked out by smaller hits just dies (smoke, no power) instead of burning.
- **Fire and explosions:** only from a single massive hit, or a big hit on a car that's already wrecked. On *Realistic* a car survives (badly damaged) hits up to about 85 mph straight into the wall. A head-on at around 100 mph or more blows it up instantly: fireball, flying burning debris, a charred shell, and a blast that shoves and damages nearby cars.
- **Damage setting:** *Realistic*, *Brutal* (lower thresholds, ~1.8× damage, a ~70 mph head-on is fatal) or *Off* (visual dents only).
- Damage profiles per car class live in `src/damage/damage.ts` (`DAMAGE_PROFILES`). The open-wheel profile sheds wings and suspension more easily but rarely burns.
- Dev check: in `npm run dev`, start a race with `await __quickRace('sunvale', 'realistic', 9)`, then run `__damageTest(480)`. It fast-forwards an all-AI pack race and reports destroyed cars, an impact histogram and `pass`.
- A wreck brings out the yellow flag. In a race a destroyed car is out (DNF) and you spectate; in free practice hold R for a new car.

## How it works

- **Rendering:** three.js with PBR materials, a physical sky, IBL reflections from the sky, a soft
  shadow map that follows the player, and post-processing (SMAA, optional bloom). Graphics quality
  (Low/Medium/High/Ultra) is in Garage & settings.
- **Physics:** Rapier rigid body at 120 Hz with raycast suspension (springs, dampers, anti-roll bars,
  bump stops), a simplified Pacejka tire model with friction circle, load sensitivity, wheelspin,
  lock-up, ABS/TC, a torque curve and 4-speed gearbox, aerodynamic drag and downforce. A drafting
  hook is ready for multiplayer.
- **Tracks:** each track is a spline with per-sample banking. Road surface, curved banking transition,
  SAFER wall, catch fence, pit road, lines and colliders are all generated from it.
- **AI drivers:** pick speeds from the curvature and banking ahead (with braking distances, tighter for inside lanes and with a margin in a pack), follow lanes or racing lines, draft, pass, keep a gap and avoid wrecks. They countersteer and lift when sliding, trail-brake instead of locking up mid-corner, slow down gradually for cautions and reset themselves if stuck.
- **Networking:** star topology over WebRTC. The host's PeerJS id is derived from the
  room code; PeerJS's free public broker is used only to connect players, and gameplay data then
  flows directly between browsers. No game server is needed. Each player simulates their own car;
  others appear as interpolated kinematic bodies, so contact between cars feels solid. The host runs
  race control and the AI cars. Dents, lost parts and explosions are broadcast as events.
  Car snapshots are 40 bytes. The host keeps the latest snapshot of every car and sends each client
  one batched packet per tick (20 Hz), with only the cars that changed. Cars more than 220 m from that
  client's car go at a third of the rate. For 11 clients and 31 other cars that's about 100 KB/s
  upload for the host.
- **Big grids:** beyond a quality-dependent distance (45–130 m), each car switches to one merged,
  vertex-coloured mesh with no shadow (a full car is ~80 draw calls). With 32 cars that cuts render
  time about 4× (27 → 7 ms in testing). Tyre smoke, dust and spray scale down with distance and grid
  size. Bots far from every human re-plan their AI every other frame. The leaderboard shows the top
  5 plus the cars around you.

### Dev testing

In `npm run dev`, the browser console has `__run(...)` (an autopilot that steps the physics for N
seconds) and `__race(seconds)` (an AI drives your car and the whole race is fast-forwarded). See
`src/dev/autotest.ts`. `await __quickRace(map, damage, bots)` starts a single race through the lobby, and
`__damageTest(seconds)` fast-forwards an all-AI race and reports wrecks. `__quickRace` also takes a series and a car id
(`await __quickRace('cedarridge', 'realistic', 8, 5, 'gp', 'gp-downforce')` puts everyone in that car). All of these are stripped from production builds. To test multiplayer locally, open two
browser tabs, host in one and join with the code in the other.
