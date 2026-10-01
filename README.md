# Wake Rider Lab

A 2.5D boat and tube physics game with a shared lake, rideable wakes, optional
bots, and a separate solo Open Water mode. This is a separate edition of the
original game at [boat.saganweb.com](https://boat.saganweb.com).

[Play the public game](https://wakerider.saganweb.com) ·
[Read the physics guide](PHYSICS.md)

## Play

Use Node.js 24 (tested with 24.19) and pnpm 11.19.0, the version pinned in
`package.json`. Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build:site
pnpm run dev:multiplayer
```

Open [the local game](http://127.0.0.1:8783/?map=oswego) in two tabs to test
independent players. This server listens on this computer only and stores its
local SQLite room in ignored `.local-data/`. Rebuild and restart the server
after changing code; it serves the built Worker.

The Windows static launcher on port 8782 supports solo Open Water. Shared Lake
requires the server above. GitHub stores the source; the public game continues
to run on its existing Sites host. GitHub Pages alone cannot run the shared lake.

For the faster WebSocket room, see [REALTIME.md](REALTIME.md). Run
`pnpm run dev:realtime` alongside the game server and set its
`LAKE_REALTIME_URL=http://127.0.0.1:8787` environment variable. The original
local D1 mode remains available when that variable is unset.

## Physics and source layout

[PHYSICS.md](PHYSICS.md) explains the units, update order, boat handling, tow
rope, rider, water, collisions, and what the server controls. It also identifies
the gameplay approximations and the tests to run when changing the model.

| Directory | Purpose |
| --- | --- |
| `physics/` | Boat, tube, rope, rider, wake and shoreline calculations |
| `simulation/` | Simulation orchestration, defaults and shared wake reconciliation |
| `multiplayer/` | Sessions, remote motion, bots and cross-player contacts |
| `renderers/` | Canvas artwork, camera projections and map overlays |
| `server/`, `db/`, `drizzle/` | Worker API and shared room storage |
| `realtime/` | Cloudflare WebSocket Worker and single live lake owner |
| `tests/` | Physics, input, map and multiplayer regression checks |
| `android/`, `ios/`, `mobile/` | Retained Capacitor app source |

Boats use the shared flat-colored polygon model in `renderers/boat-model.js`.
The overhead, rear mirror and Helm views project the same seats, split windshield
and hull, with each player's color applied to the side bands and rails. There
is no overhead tower or 3D engine. The model keeps the existing collision outline
from `physics/boat-hull.js`; raised details change the drawing, not the physics.
Run `pnpm run test:renderers` when changing the model or its camera projection.

## Hosted edition

This copy also has a Sites deployment. Its identity is saved in
`.openai/hosting.json`. `node tools/build-site.mjs` prepares the Worker and
allowlisted browser assets in `dist/`, preserving both maps.
The server retains the logical D1 binding `DB` for standalone local/legacy mode.
With `LAKE_REALTIME_URL` configured, all multiplayer traffic uses the separate
Cloudflare room, including HTTP clients. No application accounts are needed.
The existing `build` script is for the native mobile edition and must not be
used to prepare the hosted browser version.

## Map selection

The shared lake automatically joins one public room for up to 12 boats. Each browser
tab receives an independent temporary session, name and color. Players appear
in the game and the lake chart. The transparent minimap defaults on and
follows your boat in a north-up, 1 km-wide view. Colored edge arrows point to
players outside that nearby view. Set a nickname or hide **Show player minimap
while driving** in **PHYSICS → Lake map**; an explicit hidden preference is saved.
The Physics map and **OPEN LAKE MAP** still show the entire lake.
Launch and Reset reserve a shore-safe spot in the center of the main basin, checking the
whole tow corridor against current boats and tubes. Boats exchange springy bumper-boat
impulses, with server-owned acknowledgments to avoid duplicate impacts.
After a bump, boats glide briefly before their normal sideways resistance or
bot cruising response returns, letting the shove carry them farther.
Boat strikes give the much lighter tube a stronger rebound and a short glide;
tube pairs also bounce. Ropes still constrain the swing and transfer tension.

Three minutes without interaction removes a player and their bots from the
shared lake. Driving keys, held touch controls, gamepad input and UI interaction
count as activity; a latched throttle, drifting or connection heartbeats do not.
Press **Reset** to rejoin after inactivity. Solo Open Water has no idle timeout.

This is casual multiplayer: local driving and tow physics are synchronized by
WebSockets at a target 20 updates per second; remote poses are interpolated with
limited prediction. One Durable Object owns the active room in memory, including
reservations and collision decisions. Higher latency can still delay a visible
bump. Tubes remain independent tow systems, while everyone sees and rides the same
server-timed wake field. Colored boats share the original detailed 2D artwork.
Connection loss pauses driving while reconnecting; stale players expire after
15 seconds and rejoin at a safe launch. A shorter reconnect preserves the boat's
current position. Switching to Open Water leaves the room.
Replay is available in solo Open Water only.

The shared lake uses the same default boat, tow, rider, water and handling settings
for every player. Physics tuning (including cruise) is locked and hidden there; camera,
map, minimap and display options remain adjustable. Open Water unlocks
the physics controls and remembers its tuning across map switches within the
current page. Returning to either map leaves cruise off until enabled in solo.
The shared server fixes hull/tow dimensions and requires the current physics
rules version, so older open tabs must refresh. This is a game-settings lock;
the simulation remains client-side. Wake emissions are shared, including
recent waves when a player joins; old wakes spread and fade after a boat leaves.

Open **PHYSICS → Lake map** to select a location:

- **Shared Lake** — The mapped shoreline, coves, lake arms,
  and five islands at real scale. Boats, tubes, and fallen riders collide with
  the shoreline. Boat impacts rebound softly and retain motion along the bank;
  a brief coast with stronger steering lets the driver turn clear. Tubes and
  fallen riders stay contained, and server pose checks do not reapply a bounce.
  The start is near the center of the main lake, heading
  east-northeast into open water. A minimap in Physics tracks your position; **OPEN LAKE MAP** opens a larger chart
  and pauses the simulation while it is open.
- **Open Water (original)** — the original endless water with no land or
  shoreline constraints.

Changing maps resets the boat, tube, wake, replay, and controls. Your selected
map is remembered for this copy. Direct links: `/?map=oswego` and `/?map=open`.
Reset and Restore Defaults keep the selected map.

Every camera uses the original 2D style. Choose **HELM** (shortcut **5**) or
**PHYSICS → Camera POV → Helm — Driver's eyes** for a forward view that uses
the rear-view mirror's artwork, with a small translucent 2D bow. The Driver and Helm
rear-view mirrors show shoreline and trees, using fixed tree positions and
hiding far banks behind islands.
The lake geometry is from OpenStreetMap; see [maps/SOURCE.txt](maps/SOURCE.txt) and
[licenses.html](licenses.html#map-data). All map data is bundled locally.

## Controls

- W / Up: forward; S / Down: reverse
- A / D or Left / Right: steer
- R: reset; 1 / 2 / 3 / 4 / 5: Top / Driver / Tube / Rider / Helm
- Touch: steering wheel and latching throttle
- Xbox: left stick and triggers
- Mouse wheel / pinch: camera FOV

## Verification

Run both suites and the browser build:

```sh
pnpm test
pnpm run test:multiplayer
pnpm run test:realtime
pnpm run build:site
```

The suites cover boat and tow motion, shore containment, rider behavior, shared
wakes, glancing and swept collisions, bots, session acknowledgments, reconnects,
map switching and input focus loss. `pnpm run build` separately prepares the
Capacitor mobile bundle in `www/`.

The copied Capacitor projects are retained as source references. Dependencies
and generated bundles were not duplicated; use `pnpm install --frozen-lockfile`
before mobile build commands. This work does not create or publish a new native
app identity. Browser preview is the runnable deliverable.
