# Wake Rider physics guide

This guide describes the model implemented in this repository and where to
change it. Wake Rider uses a custom, simplified boat and tow simulation with
flat Canvas artwork. Bodies have height, vertical velocity, pitch and roll, but
the presentation stays 2.5D. Handling, loads and impacts are tuned for gameplay;
this is not a calibrated naval architecture or human injury model.

## Units and coordinates

The source of truth is [physics/config.js](physics/config.js). Positions use
game distance units, time uses seconds, and angles use radians. In the map
plane, positive x points east and positive y points south. Heading zero points
east; positive rotation turns clockwise. Height z is positive upward.

| Conversion | Value |
| --- | --- |
| 1 game distance unit | 0.227333 feet, approximately 0.0692912 meters |
| 1 foot | Approximately 4.39883 game units |
| 1 game unit per second | 0.155 mph |
| Standard gravity | 32.174 feet per second squared, approximately 141.528 game units per second squared |

Lengths in `CONFIG` are deliberately mixed: `boatLength` and `boatBeam` are
feet, while `ropeLength` and `tubeRadius` are already game units. Convert at the
module boundary, rather than multiplying every length by `UNITS_PER_FOOT`.

Weights are stored in pounds and used as relative masses. Tow forces use a
200-pound reference mass and normalized force-like values. The tension gauge,
`ropeWorkingLoad`, `ropeMaximumLoad` and rider grip are game scales, not direct
measurements in pounds-force, newtons or human strength.

## Default setup

The single fictional boat profile lives in [physics/boats.js](physics/boats.js).
Shared settings come from [simulation/defaults.js](simulation/defaults.js).

| Setting | Default |
| --- | --- |
| Boat | V-drive inboard, 21.75 feet long, 8 feet wide |
| Boat weight and reference power | 3,200 pounds, 350 hp |
| Reference top speed | 45 mph |
| Maximum rudder angle | 35 degrees |
| Tow rope | 60 feet, with 0.3 feet of compliance |
| Ski tow attachment | 3.5 feet high, 45% of hull length behind the center |
| Tube | 2.5-foot radius, 30-pound dry weight |
| Rider | 130 pounds, grip setting 75 |
| Effective loaded tube mass | 160 pounds |
| Effective empty tube mass | 105 pounds, including 75 pounds of added water mass |
| Wake strength and lifetime | 1.1 and 36 seconds |

Shared Lake locks boat, tow, rider and water tuning to these defaults. Solo Open
Water allows tuning. Camera settings only affect the view.

## Simulation clock and update order

The frame loop in [renderers/canvas2d-app.js](renderers/canvas2d-app.js) accumulates
time and calls the simulator at **120 steps per second**. It caps elapsed time
from a single rendered frame at 0.05 seconds. A slow frame therefore does not
cause an unbounded catch-up burst; sustained low frame rates can slow simulated
time. The simulator itself accepts an explicit `dt`, which tests can vary.

Each normal step in [simulation/simulator.js](simulation/simulator.js) performs:

1. Apply throttle or solo cruise control, then update boat planar motion.
2. Resolve the boat's first shoreline contact.
3. Emit wakes at 10 Hz and advance the water field.
4. Update boat height, pitch and roll from water samples.
5. Update tow tension, tube drag, attitude, height, rider state and visible rope.
6. Resolve the tube against its own towing boat and refit the rope if needed.
7. Apply final shore containment after tow/contact position corrections.
8. Record replay samples and update displayed speed, air and load metrics.

Replay stores sampled motion for solo playback; it is not a deterministic
network replay or a fresh physics resimulation.

## Boat handling

[physics/boat.js](physics/boat.js) splits velocity into forward and sideways
components relative to the hull. Forward thrust is balanced against quadratic
drag, turn drag and sideslip drag. The selected maximum speed sets propulsion
strength; reducing it does not instantly brake a moving boat.

Steering creates sideways acceleration and yaw torque. Rudder flow combines
forward speed with prop wash, so some steering remains at low speed under
throttle. The steering lever arm and approximate hull inertia turn this force
into a yaw response. Lateral and yaw damping reduce uncontrolled sliding and
spinning. Hard steering increases the tuned hull-bite response and scrubs speed.

After a boat-to-boat impulse, a short bumper glide reduces lateral damping to
as little as 20% and smoothly restores it over at most 2.4 seconds. The duration
scales with the received velocity change; stationary separation and tube hits
do not enable it. Bots use the same easing on their return to cruising velocity.
This is a gameplay tuning of resistance, not a detailed model of water flow:
it adds no momentum and leaves forward drag, thrust, steering and shore checks
active. Reverse propulsion limits no longer instantly clip faster backward
motion received from a collision. [boat-bump.js](physics/boat-bump.js)

The tow acts at a stern or tower attachment, including attachment velocity from
yaw and pitch. Pulling the tube therefore reacts back on the boat and can change
its speed and heading. Boat water response samples a moving surface and uses
spring/damping-style support and attitude targets rather than a full hull
pressure calculation.

## Tow rope and tube motion

The force model is in [physics/tow.js](physics/tow.js). Tension uses the full
height-aware distance between the boat attachment and the tube's front tow eye.
A slack rope does not push. When stretched, its simplified law is:

```text
stiffness = ropeWorkingLoad / ropeCompliance
damping = 2 * ropeDampingRatio * sqrt(stiffness * reducedMass)
tension = clamp(stiffness * stretch + damping * separationSpeed,
                0, ropeMaximumLoad)
```

The implementation bounds the denominators and returns zero for nonpositive
stretch. A separate hard length constraint limits excess separation to the
rope's length plus its small compliance allowance. Position and velocity
corrections account for relative boat and tube masses.

Tube drag uses velocity relative to the moving water, including wake orbital
motion. Rope torque, water slope, drag and a modest fabric/tow-eye alignment term
turn the tube. Four water samples around its rim drive pitch and roll. A rolled
rim can catch water, increasing drag and impact load.

The visible line in [physics/rope.js](physics/rope.js) is a **25-node Verlet and
position-constraint chain with 10 solver passes**. Its endpoints follow the same
tow eyes; node and segment constraints keep it outside the tube. This chain
draws the line's shape. Boat/tube forces come from `tow.js`, not from summing
forces in the drawn segments. It does not implement general rope-to-rope,
rope-to-boat or rope-to-shore collisions.

## Wakes and jumping

[physics/wake.js](physics/wake.js) emits two wave packets behind a moving boat,
one on each side, above approximately 6.51 mph. Their wavelength scales with
hull length. The model borrows the deep-water gravity-wave relationships:

```text
k = 2 * pi / wavelength
omega = sqrt(gravity * k)
groupSpeed = 0.5 * sqrt(gravity / k)
```

Each packet is a cosine wave under a widening Gaussian envelope. Packets move,
spread and fade; old or weak packets are removed. `sampleWater` sums nearby
packet contributions to height, slope, vertical velocity and horizontal orbital
velocity, then clamps extreme values for stability. It is an analytical wave
field, not a fluid grid. Shore reflection, breaking waves and shallow-water
bathymetry are not modeled.

The tube follows the water while supported. Sufficient speed up a sufficiently
energetic slope launches it. Airborne motion integrates gravity plus vertical
tow acceleration. Landing compares tube height/velocity with the water and
applies impact and drag, with pitch and roll worsening the landing. Players can
ride their own wakes and other players' wakes because both enter this same
physical water sampler.

## Rider and gauges

[physics/rider.js](physics/rider.js) checks steady tension, sudden tension
increase and hard impact against the rider's grip setting. Losing grip creates
a separate falling body with inherited motion, water drag, tumble and possible
water skips. The rider normally returns after about three seconds; these are
gameplay rules. An empty tube keeps moving with its added-water mass model.

The G gauge uses proper acceleration:

```text
gForce = sqrt(ax*ax + ay*ay + (az + gravity)*(az + gravity)) / gravity
```

Supported rest is about 1 g and ideal free fall about 0 g. The displayed value
is smoothed and capped at 6 g. Tension and grip displays are normalized game
readouts; they should not be treated as measured real-world loading.

## Collisions

Different interactions use deliberately different approximations:

| Interaction | Detection and response | Source |
| --- | --- | --- |
| Boat against boat | The original rotated 11-point hull outline; swept separating-axis checks with bounded conservative advancement and approximately 1 cm clearance. Equal normal impulses give a rubber-bumper rebound: restitution smoothly rises from 0 at 0.3 m/s closing speed to 0.70 at 1.5 m/s, with relative rebound capped at 6 m/s. Tangential motion is retained; stationary overlap adds no launch energy. Both owners must acknowledge each correction before another contact, with no extra boat-pair cooldown. | [boat-contacts.js](multiplayer/boat-contacts.js), [boat-hull.js](physics/boat-hull.js) |
| Tube against another boat | Tube circle against a capsule around the hull, with swept entry and height checks. The light tube takes most of the impulse; restitution rises smoothly from zero at 0.3 m/s approach to 0.65 at 2 m/s. Relative rebound is capped at 8 m/s. Glancing corrections retain tangential travel. | [tube-contacts.js](multiplayer/tube-contacts.js), [tube-impact.js](physics/tube-impact.js) |
| Tube against another tube | Swept circles with height checks and mass-weighted opposite impulses; restitution ramps up to 0.55 with the same quiet-contact threshold and rebound cap. | [tube-contacts.js](multiplayer/tube-contacts.js) |
| Tube against its own boat | Local capsule contact with mass/inertia, friction, yaw response and tube compression/splash. Friction uses the spinning rim's contact velocity, so a glancing hit opposes slip without adding energy. | [collision.js](physics/collision.js) |
| Boat against shore | Swept enclosing circle against shoreline/island segments. Normal impacts use restitution 0.45 and tangent retention 0.98, with brief steering assistance to get clear. | [shore.js](physics/shore.js), [simulator.js](simulation/simulator.js) |

Restitution controls how much normal approach speed is returned as separation
speed; it is not a percentage of total energy. Shore and spawn checks retain a
conservative boat circle even though boat-to-boat contact follows the sprite
hull. Tubes can pass over other tubes or boats when their relative heights clear
the configured limits. Boat-to-boat contacts remain planar and do not apply a
full off-center angular collision impulse.

Own-tube and peer-tube impacts share the same rebound curve. Local own-tube
contacts additionally include angular contact velocity, yaw inertia and contact
friction. Actual impulses start up to 2.2 seconds of reduced tube water drag
(down to 35%, easing back to normal). Rope tension, airborne clearance and
shore checks remain active. Bots retain their tube impulse with slower damping
and remove its outward component when the rope becomes taut, keeping the
sideways swing. Shared contacts wait for acknowledgments instead of a fixed
400 ms cooldown, so another real encounter can respond promptly.

These coefficients deliberately exaggerate inflatable bounce for play; they
are not measured boat or tube material properties. Equal/opposite impulses use
inverse mass, and restitution stays below one, so the impact itself cannot
create kinetic energy. At a centered 20 mph strike into a stationary loaded
tube, the ideal isolated impulse gives the tube roughly 31 mph; water drag and
its tow rope then reduce and redirect that motion.

Research references: [Box2D's simulation guide](https://box2d.org/documentation/md_simulation.html)
describes mass, restitution, contact friction and suppressing slow bounce to
avoid jitter. [Erin Catto's impulse solver notes](https://box2d.org/files/ErinCatto_SequentialImpulses_GDC2006.pdf)
cover normal/tangent impulses and rotational effective mass.
[NASA's drag equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/modern-drag-equation/)
supports velocity-squared fluid drag; it does not provide inflatable-on-water
coefficients. The game's drag and glide durations remain explicit play tuning.

Additional containment passes after tow or network corrections avoid land and
do not apply the boat's shoreline bounce a second time. Contact tolerances,
velocity caps and position projection prioritize stable gameplay over exact
conservation across the entire simulation.

## Multiplayer ownership and timing

Shared Lake uses a hybrid client/server model:

- Each human player's browser simulates its own boat, tube and rider at the
  local physics rate. Locked defaults align settings but are not comprehensive
  server-side anti-cheat enforcement.
- [multiplayer/socket-client.js](multiplayer/socket-client.js) sends poses at a
  target 20 Hz over a persistent WebSocket. The room broadcasts at 20 Hz and
  immediately pushes human-update collision corrections to both owners.
- [multiplayer/room.js](multiplayer/room.js) owns up to 16 reservations, shared
  collision decisions, wake history and optional bots. [realtime/worker.js](realtime/worker.js)
  gives the lake one live Durable Object owner, with atomic in-memory actions.
  Motion does not require database reads/writes. HTTP compatibility clients
  use the same owner at their older 5 Hz rate. Without a realtime endpoint,
  standalone mode uses [server/lake.js](server/lake.js) and revision-checked D1.
- Collision corrections carry sequence numbers and must be acknowledged. Old
  poses cannot overwrite an unacknowledged impact. A boat correction moves its
  tow system together; a tube correction moves the affected tube separately and
  refits its rope without adding artificial node velocity.
- [multiplayer/peer-motion.js](multiplayer/peer-motion.js) interpolates remote
  poses with a small adaptive delay, predicts briefly through missing updates,
  and eases corrections. This affects appearance, not the authoritative contact
  calculation. Latency can still delay a visible bump.
  WebSockets begin with a 60 ms presentation buffer, adapting within 45–160 ms;
  legacy HTTP keeps its 150 ms initial buffer and 120–300 ms range.
- [simulation/shared-wakes.js](simulation/shared-wakes.js) predicts the local
  boat's wake immediately. Server-timed emission events replace matching
  predictions by IDs so confirmation does not apply the same wave twice.
  A separate clock anchored to server receipts gates uploads. Predictions a
  fraction of a frame ahead remain visible and queued until that clock catches
  up, preserving their timestamps and spacing instead of losing them to the
  server's future-sample rejection. This works independently of display refresh rate.
  Joining players receive recent wake history.
- [multiplayer/bots.js](multiplayer/bots.js) uses simplified server navigation
  and towing in 100 ms steps, driven by the room's independent timer. Bots share wakes
  and collision rules but do not run the complete human tow simulation.
  Up to 15 bots use distributed starts, with three bay patrols in a full fleet.
  [multiplayer/bot-routes.js](multiplayer/bot-routes.js) defines 35 surveyed nodes
  and 41 water corridors with at least 30 m shore clearance. A disconnected
  northeastern patrol avoids a neck too tight for reliable two-way towing.
  [multiplayer/bot-navigation.js](multiplayer/bot-navigation.js) routes between
  destinations, prioritizes unvisited regions, spreads incoming boats between
  destinations, and scales lookahead, speed and weaving to corridor clearance.
  A modest starboard lane separates opposing tows in narrow arms.
  Knocked-off boats reconnect only along a
  checked water segment; if none is visible they ease away from shore and retry.
  Five seeded personalities vary cruising pace (roughly 16–24 mph before traffic
  and turn reductions), weave amplitude/period, destination choice and spin timing.
  Spins use the normal smoothed steering at 0.4 rad/s and 5.5 m/s, complete one
  circle and return to the journey. They require over 90 m shore and 100 m tow
  corridor clearance to start, and abort for nearby traffic, shore or a shove.
  [multiplayer/bot-traffic.js](multiplayer/bot-traffic.js) predicts closest approach
  up to four seconds ahead against moving boat/rope/tube corridors. Drivers use
  a consistent passing side, briefly hold their decision, yield to crossing
  traffic and do not brake in front of a faster boat approaching from behind.
  These are steering aids, not collision immunity; existing physical contacts,
  received momentum and tow constraints remain active. Bots still do not run
  the human rider's complete jump model.
  Optional room-wide automatic filling keeps the total at 16 boats, with humans
  replacing filler bots. Manual bots remain owned by their requesting session;
  automatic fillers remain while any human is present and filling is enabled.

The actor keeps active play in memory. A server restart starts a new room epoch;
clients clear wake/collision counters and relaunch safely. A reconnect within the
15-second reservation window resumes without resetting the boat. See
[REALTIME.md](REALTIME.md) for deployment and the live connection checks.

Open Water does not join a multiplayer room. Remote players receive rider
aboard/absent state and matching rider artwork; a fallen rider's full trajectory
is currently local. There is no server running every human's full physics at
120 Hz, no rollback simulation, and no guarantee of identical instantaneous
poses on every device.

## Changing and checking the model

Change parameters in `physics/config.js`, the boat profile, or shared defaults
instead of adding unexplained constants in drawing code. Preserve unit
conversions and the force-model/renderer separation. For incompatible shared
settings or protocol changes, update `SHARED_LAKE_RULES.version` so mismatched
clients refresh; ordinary compatible server fixes need not change that version.

Run the checks from the repository root:

```sh
pnpm test
pnpm run test:multiplayer
pnpm run test:realtime
pnpm run build:site
```

The physics suite covers handling, tow constraints, wake/rider behavior and
timestep sensitivity. Map tests exercise swept shoreline contact and
containment. Multiplayer tests cover shared wakes, prediction reconciliation,
bots, collision geometry, glancing and fast contacts, acknowledgments and
session lifecycle. These catch regressions; they do not establish real-world
physical accuracy. See [README.md](README.md) for running the game locally.
