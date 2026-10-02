# Multiplayer server

Shared sessions expire after three minutes without deliberate interaction.
Clients send a monotonic activity counter; the room timestamps advances using
its own clock, separately from connection heartbeats. The room removes an idle
owner and their manual bots atomically. Automatic fillers replace their seats
while another human remains; the final human's removal clears all bots and filling.
Both transports treat the idle reason as
terminal, and WebSockets also use close code 4008. A client deadline survives
reconnects and tab suspension. Reset creates a fresh session after inactivity;
drifting or a latched throttle cannot silently keep the old one alive.

The public game is hosted by Sites at `https://wakerider.saganweb.com`;
the original `chatgpt.site` address still works. A separate Cloudflare Worker named
`wake-rider-realtime` accepts WebSockets and routes every player to one
SQLite-backed Durable Object named `shared-lake`. SQLite-backed objects are
available on Workers Free; this implementation keeps active motion in memory
and does not store every frame. No player account or purchased domain is needed.

Current endpoint: `https://wake-rider-realtime.wake-rider-lab-oswego.workers.dev`
(`wss://wake-rider-realtime.wake-rider-lab-oswego.workers.dev/lake` for clients).

## Local development

Install the pinned dependencies, then run in separate terminals:

```sh
pnpm run dev:realtime
```

```powershell
pnpm run build:site
$env:LAKE_REALTIME_URL='http://127.0.0.1:8787'
pnpm run dev:multiplayer
```

Open `http://127.0.0.1:8783/?map=oswego`. On macOS/Linux, set the environment
variable with `LAKE_REALTIME_URL=http://127.0.0.1:8787 pnpm run dev:multiplayer`.
Without it, the local game uses its original D1-compatible SQLite HTTP room.

## Deployment

1. Authenticate the official Wrangler CLI with `pnpm exec wrangler login`.
   Use the account intended to own the game. Account/user read plus
   `workers_scripts:write` are sufficient for this Worker and its Durable Object.
2. Run `pnpm run deploy:realtime`. The configuration is in
   [realtime/wrangler.jsonc](realtime/wrangler.jsonc). It provisions a new SQLite
   Durable Object namespace; no paid-plan upgrade is required for this design.
3. Verify the printed Worker URL's `/health` route and run
   `node tests/realtime-live.mjs https://<printed-worker-url>`.
4. Set the Sites environment variable `LAKE_REALTIME_URL` to that HTTPS origin,
   then publish the game with `pnpm run build:site` through Sites hosting.
   `/api/lake-config` exposes only the public WebSocket URL, never credentials.

The Worker allows browser connections from the game's public origin. Add any
explicitly supported new game origin to `ALLOWED_ORIGINS` before changing its URL.
Local development overrides this with the loopback game origin.

Do not commit Cloudflare credentials, `.dev.vars`, `.env`, or `.wrangler` files.
These paths are ignored. The public Worker address is configuration, not a secret.

## Protocol and behavior

- Human browsers send poses at 20 Hz and simulate their own boat/tube locally.
  The actor broadcasts snapshots at 20 Hz and pushes collision corrections.
- Anonymous random session IDs plus ownership tokens reserve up to 16 boats.
  Tokens travel in message bodies over TLS, never in URLs or peer snapshots.
- Up to 15 bots share that capacity and yield their slots to joining humans.
  The shared **Fill empty seats with bots** toggle adds room-owned fillers after
  manual requests. Human joins evict fillers first. Settings use explicit sync
  commands with a room-specific epoch and expected revision; stale/repeated
  commands never overwrite a newer setting. The revision is advanced even for
  an accepted same-value click. Fill mode survives its enabler leaving, but is
  disabled and all bots removed when the last human leaves or expires.
  A full human room returns `room_full`; clients keep the full notice visible
  while automatically retrying. There is no ordered waiting queue. A network
  failure replaces the notice, and the three-minute inactivity deadline still applies.
- Each socket receives its own collision acknowledgment and wake cursor. An
  initial join/reset history must be acknowledged before regular broadcasts
  resume, preventing slow connections from repeatedly queueing that history.
- Wake uploads use a server-time estimate anchored to monotonic wall time,
  separate from wave simulation steps. A prediction slightly ahead of this
  estimate stays visible and waits for a later upload, keeping its timestamp
  and emission spacing intact. Strict future-sample validation stays enabled;
  frame timing must never cause a valid wake to be rejected and disappear.
- The actor validates and atomically commits room actions. Invalid input never
  leaves a partially updated player behind. Messages and update rates are bounded.
- Bots advance from an independent timer using their existing 100 ms step.
  Their server-owned personalities, exploration routes, traffic yielding and
  occasional spins are shared by every client. Route geometry is prevalidated;
  path lookup is cached, and traffic prediction is bounded to the 16-boat fleet.
- Unexpected disconnects retain reservations for 15 seconds. Reconnects resume
  the existing boat; expiry or an actor restart creates a fresh safe launch.
  Explicitly leaving removes the player and its manually requested bots.
- All HTTP compatibility traffic is forwarded to this same room, so old tabs
  and browsers without WebSockets do not end up in a separate lake.
- The shared-lake Menu displays each client's own smoothed update round-trip time.
  WebSockets reuse validated, advancing timestamp echoes; HTTP uses request
  duration. This includes processing and snapshot scheduling, not just network
  travel. No additional ping requests are sent. The display refreshes once per
  second, expires after 2.5 seconds without a fresh sample (or a stale connection),
  clears on failure/reconnect, and is separate from capped prediction timing.
- Open Water remains entirely solo. Rendering remains the existing 2.5D Canvas
  artwork. This is not full server simulation, rollback, or lag-free physics.

The active room is intentionally transient: deployments/restarts can relaunch
connected players. Idle rooms stop their timer. Free-tier limits can interrupt
service until the daily reset; paid Workers usage is optional and billed under
[Cloudflare's current pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Checks

```sh
pnpm run test:realtime
node tests/realtime-live.mjs
node tests/realtime-capacity.mjs
```

The first command tests transactional rejection, ownership, timed bots,
personalized wakes/corrections, reconnects, epoch changes, reset races and solo
isolation. The live check requires Wrangler dev to be running; it connects two
real WebSocket clients and an HTTP client, checks stream frequency, bots,
reconnection and reset. Continue running the physics and multiplayer suites
when changing the shared model.

The capacity check fills the local Wrangler room with 16 human clients, verifies
that they displace bots, and confirms the next client waits with a clear full
notice before automatically joining a freed slot. It never targets production.
