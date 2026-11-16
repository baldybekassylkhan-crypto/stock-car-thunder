# Prompt: Open-wheel series, car choice, damage fix, 12 humans / 32-car grids

Copy everything below the line into a new Claude Code session in this repo.

---

You're working on **Stock Car Thunder**, a browser 3D racing game (Vite + TypeScript + three.js, static GitHub Pages deploy, PeerJS WebRTC rooms in a star topology where the host relays). Read `README.md` first, then the files named below. Build this update **one milestone at a time**. After each milestone, run `npm run build`, check it in the browser with the dev helpers in `src/dev/autotest.ts` (the browser pane often runs hidden and throttles rAF, so step the sim by hand), update the README status table, and commit. Then stop and give me a short report before starting the next milestone.

**Naming rule:** everything stays fictional. Don't use "Formula 1", "F1", "NASCAR", or any real team, driver, sponsor, circuit name or livery. Call the new series **"Open-Wheel Grand Prix"** (short label "GP") and the existing series **"Stock Car"**.

## Milestone A: Fix stock-car damage (it wrecks cars far too easily)

Right now in stock-car races, small contacts snowball into fires and explosions. Look at `src/damage/damage.ts`:

- `J0 = 240` N·s is a very low impulse threshold, so every rub and tap does damage.
- Every impact takes `e * 0.02` off `engine` wherever it lands, so many small taps eventually drop `engine` below 0.05 → `ignite()`.
- `recentDV` adds up every impact inside a 0.3 s window, car-to-car contact included. That means a pack of light bumps can pass `DEADLY_DV` (34 m/s on realistic) and blow the car up.
- Puncture chance is `hit * 0.9` for each corner on every hit.
- The integrity formula punishes the single worst panel, and `integrity <= 0.02` also ignites the car.

Change it so stock cars are as tough as real ones: door-to-door rubbing, bump-drafting and light wall scrapes do cosmetic damage only.

1. Raise the damage threshold a lot (start around ~900 N·s for walls and ~1400 N·s for car-to-car), and scale damage non-linearly so it's tiny for small hits and only climbs steeply for big ones.
2. Only hits to the front of the car (bumperF/hood) hurt the engine. Remove the flat per-hit engine loss.
3. Only count wall impacts and car hits above a high closing speed toward `recentDV`. Raise realistic `DEADLY_DV` to roughly a 45+ m/s instant stop, so only a head-on into a wall at top speed is instantly fatal.
4. A car should only catch fire after a single massive hit, or when engine health is near zero *and* it took a big hit. Wear alone never starts a fire. Make "destroyed" a rare event on `realistic`. Keep `brutal` spectacular but well below today's rate.
5. Make punctures need a direct, hard hit to that corner (low probability, with a minimum hit strength).
6. Add a regression check in `autotest.ts` that simulates a 10-lap pack race with bots. On `realistic`, it should average well under 1 destroyed car per race, and no car should be destroyed by contacts below the new thresholds.
7. Tune a separate damage profile per car class (see Milestone C). Open-wheel cars are more fragile (wings and suspension break off easily) but still shouldn't explode from contact.

## Milestone B: Bigger grids: 12 human players, up to 32 cars

1. In `src/net/transport.ts`, replace `MAX_PLAYERS` (currently 10) with two constants: `MAX_HUMANS = 12` and `MAX_GRID = 32`. Update every use: room join rejection in `src/net/room.ts`, the lobby AI-driver dropdown and driver count in `src/ui/screens.ts`, and grid building in `src/core/session.ts`.
2. The AI-driver dropdown should offer `0 … MAX_GRID - humans`. The driver count reads `Drivers (n/32)`. Generate enough unique bot names and car numbers for 32 cars.
3. Grids and track data: every track (old and new) needs 32 grid slots and 32 pit boxes (Milestone E). Use 2-wide rows for stock cars and the staggered 2-by-2 grid for GP.
4. Performance for 32 cars:
   - Distance-based LOD for car models.
   - Fewer debris and smoke particles per car.
   - Cheaper simulation for bots far from any human (a simplified physics step, or a lower tick rate with interpolation).
   - The host simulates bots and sends them in one batched, quantized snapshot packet (extend `src/net/codec.ts`). Send far cars at a lower rate.

   Target: 60 fps on a mid-range laptop with 32 cars, with the host's upload bandwidth reasonable for 11 clients.
5. HUD, leaderboard and results screens must handle 32 rows (scrolling or compact view).

## Milestone C: Car choice in every race type

1. Add a car catalogue (`src/vehicle/catalog.ts`) with 3 or more fictional cars per series. Each car has stats that differ in feel, not just colour: power curve, mass, weight distribution, grip, aero downforce/drag, fuel tank and fuel use, tyre wear rate, damage profile.
   - Stock Car example archetypes: "Torque" (strong exit, heavy), "Aero" (fast on ovals, loose in traffic), "Balanced".
   - GP example archetypes: "High-downforce", "Low-drag", "Balanced".
2. Generalise `src/vehicle/car.ts` and `src/vehicle/carModel.ts`: physics reads parameters from the chosen car spec, and the model builder makes a procedural stock car body or a procedural open-wheel body (exposed wheels, front and rear wings, halo-style cockpit protection, sidepods, floor). Open-wheel cars need their own detachable parts: front wing endplates, rear wing, wheels with tethers, nose cone.
3. Car selection screen in single-player and in multiplayer lobbies, filtered to the room's series, with a stat bar preview and a rotating 3D preview. Store each player's pick in their profile (`src/core/profile.ts`) and sync it in `PeerInfo`. Bots pick a mix of cars.
4. Host room settings gain **Series: Stock Car / Open-Wheel GP**, plus a "Same car for all" option.

## Milestone D: Open-Wheel GP driving model

Make it feel realistic and clearly different from stock cars:

- **Aero:** downforce grows with speed squared, so grip in high-speed corners is much higher than in slow ones. Following within ~1.5 s of a car ahead costs front downforce ("dirty air"), and a slipstream on straights cuts drag.
- **Drag-reduction flap:** on marked straights, if you're within 1.0 s of the car ahead at the detection point, you can open the rear-wing flap for less drag. It closes on braking. The HUD shows when it's available or active.
- **Tyres:** temperature and wear modelled per tyre. Cold tyres have low grip, there's an optimal window, overheating costs grip, and wear lowers grip over a stint. Compounds are Soft / Medium / Hard (fast and short-lived through to slow and long-lived), plus Wet and Intermediate for the existing weather setting. In dry races, every car must use 2 dry compounds.
- **Brakes and power:** carbon brakes with very short stopping distances and lock-ups when cold or under huge pedal pressure. High power-to-weight with traction loss on throttle out of slow corners. Optional energy-boost ("ERS") deployment from a battery that charges under braking.
- **Fuel:** mass drops as fuel burns, so lap times improve slightly. No refuelling in GP. Stock cars do refuel (Milestone E).
- **Assists**, selectable per player: traction control, ABS, racing line, auto-gearbox. These replace any existing assist toggles where they apply.
- **AI** (`src/vehicle/bot.ts`): GP bots use braking points that account for downforce, defend and overtake with the slipstream and flap, manage tyres, and follow pit strategy.
- **Flags and race control** (`src/race/race.ts`): track limits, a yellow sector after an incident, safety car / virtual safety car on big crashes (also for stock cars as a "caution"), a time penalty for causing collisions, and a blue flag for lapped cars.

## Milestone E: Pit stops (both series)

1. Every track gets a pit lane: entry and exit lines, a speed limit (80 km/h for GP, 72 km/h for Stock), and 32 pit boxes. Speeding gives a time penalty. Show the pit limiter on the HUD (auto on entry, or a key you press).
2. Before or during the race, set a pit plan from a small menu: tyre compound, fuel amount (stock), front-wing angle repair (GP), repair damage yes/no.
3. When a car stops in its box, it plays a stop sequence: car jacks up, wheels change, then refuel or repair. Show a timer.
   - GP tyre-only stop: about 2.5–3.5 s.
   - Stock car stop (4 tyres + fuel): about 12–15 s.
   - Repairs add time based on how bad the damage is, and destroyed parts get replaced.

   Show small animated crew figures or simple placeholders, and add a bit of random variation so stops aren't always the same.
4. AI pits based on tyre wear, fuel, damage and caution or safety-car timing.
5. In multiplayer, the host decides pit stop results. Clients send pit requests, and the host confirms the duration and resulting state.

## Milestone F: Three new GP circuits

Build them in the same style as `src/tracks/sunvale.ts`, `cedarridge.ts` and `ironhollow.ts`: procedural spline track, curbs, run-off, barriers, props, atmosphere. Register them in `src/tracks/maps.ts` with a `series` tag. Lobbies show GP circuits for GP and ovals or road courses for Stock, and allow cross-series picks if you set "any track". Every circuit needs a pit lane, 32-car grid, drag-flap zones, sector lines and safety-car line.

1. **Harbor Point Street Circuit:** a tight night street race along a waterfront. Concrete walls close to the track, a tunnel section, a hairpin and a fast chicane. One drag-flap zone. Little run-off, so mistakes get punished.
2. **Velmont Park:** a fast, flowing parkland circuit with elevation changes, a long straight and a fast uphill esses section, plus gravel traps and wide grass run-off. Two drag-flap zones.
3. **Desert Ring Al-Sahra (fictional):** a modern purpose-built circuit with long straights and heavy braking zones, tarmac run-off, dusk lighting and an optional sand-haze atmosphere. Two to three drag-flap zones.

Each track needs a minimap, a lap-record entry in `src/core/progress.ts`, and AI that can lap it cleanly. Check this with an autotest bot lap.

## Final step

Update the README (features, controls for the drag flap, boost and pit limiter, the series list, tracks, limits of 12 humans and 32 cars), confirm `npm run build` passes with no TypeScript errors, and make sure the GitHub Pages deploy workflow still works.
