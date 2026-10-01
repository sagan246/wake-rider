import assert from 'node:assert/strict';
import { boatContactResponse } from '../multiplayer/boat-contacts.js';
import { BOAT_OUTLINE, BOAT_SPRITE_LENGTH, BOAT_SPRITE_BEAM } from '../physics/boat-hull.js';
import { SHARED_LAKE_RULES as rules } from '../simulation/defaults.js';
import { METERS_PER_UNIT as M } from '../maps/catalog.js';

const L = rules.length, B = rules.beam;
const pose = (x = 0, y = 0, extra = {}) => ({ x, y, angle: 0, vx: 0, vy: 0, ...extra });
const contact = (a, previousA, b, previousB = b) =>
  boatContactResponse(a, previousA, b, previousB, L, B);
const close = (a, b, message, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
function verify(hit) {
  assert.ok(hit);
  assert.ok(hit.t >= 0 && hit.t <= 1, 'Contact time belongs to the swept interval');
  close(Math.hypot(hit.nx, hit.ny), 1, 'The response normal has unit length');
  for (const key of ['dx', 'dy', 'dvx', 'dvy']) {
    assert.ok(Number.isFinite(hit.a[key]) && Number.isFinite(hit.b[key]), 'Corrections stay finite');
    close(hit.a[key] + hit.b[key], 0, 'Equal boats receive opposite position/velocity changes');
  }
}

assert.equal(Math.max(...BOAT_OUTLINE.map(p => p[0])) - Math.min(...BOAT_OUTLINE.map(p => p[0])), BOAT_SPRITE_LENGTH);
assert.equal(Math.max(...BOAT_OUTLINE.map(p => p[1])) - Math.min(...BOAT_OUTLINE.map(p => p[1])), BOAT_SPRITE_BEAM);

// The reported bug: circumscribed circles touched with several meters of
// clear water still visible between parallel sides. Their actual hulls don't.
{
  const a = pose(0, 0, { vx: 10 / M }), b = pose(0, 3 / M, { vx: 10 / M });
  assert.equal(contact(a, a, b), null, 'Parallel boats with a 3 m center gap do not bump prematurely');
  const closePass = pose(0, B + .03 / M, { vx: 10 / M });
  assert.equal(contact(a, pose(-4 / M, 0), closePass, pose(-4 / M, closePass.y)), null,
    'A close parallel pass retains a visible 3 cm side gap');
}

// The tapered bow must not occupy the empty corners of a hull rectangle.
{
  const a = pose(), b = pose(L * .9, B * .7);
  assert.ok(b.x < L && b.y < B, 'The enclosing rectangles overlap in this fixture');
  assert.equal(contact(a, a, b), null, 'Tapered bow/stern corners can pass without an invisible box impact');
}

{
  const a = pose(0, 0, { vy: 5 / M }), b = pose(0, B - .12 / M, { vy: -5 / M });
  const hit = contact(a, pose(0, -.3 / M, { vy: a.vy }), b, pose(0, B + .3 / M, { vy: b.vy }));
  verify(hit);
  assert.ok(hit.a.dy < 0 && hit.b.dy > 0, 'Real broadside contact separates the hulls');
  assert.ok(a.vy + hit.a.dvy < 0 && b.vy + hit.b.dvy > 0, 'A direct approach rebounds');
  assert.ok((b.y + hit.b.dy) - (a.y + hit.a.dy) >= B,
    'Corrected broadside hulls no longer overlap');
  assert.ok((b.y + hit.b.dy) - (a.y + hit.a.dy) < B + .03 / M,
    'Contact clearance is centimeters, not an oversized safety circle');
}

{
  const a = pose(-L / 2 + .04 / M, 0, { vx: 3 / M });
  const b = pose(L / 2 - .04 / M, 0, { vx: -3 / M, angle: Math.PI });
  const hit = contact(a, { ...a, x: a.x - 2 / M }, b, { ...b, x: b.x + 2 / M });
  verify(hit);
  assert.ok(hit.a.dvx < 0 && hit.b.dvx > 0, 'Head-on bows push each other back');
  close(hit.a.dvy, 0, 'Symmetric bow contact does not invent a sideways impulse');
  assert.ok((b.x + hit.b.dx) - (a.x + hit.a.dx) >= L);
  close((a.vx + hit.a.dvx) - (b.vx + hit.b.dvx), -(a.vx - b.vx) * .7,
    'Bumper boats return a clear controlled rebound');
}

// Bump strength follows incoming motion, with no minimum kick or energy gain.
for (const speed of [.1, .3, .6, 1.5, 4, 10, 40]) {
  const a = pose(-L + .04 / M, 0, { vx: speed / M }), b = pose();
  const hit = contact(a, { ...a, x: a.x - .1 / M }, b);
  verify(hit);
  const av = a.vx + hit.a.dvx, bv = b.vx + hit.b.dvx;
  close(av + bv, a.vx, 'The struck boat receives the same momentum the first loses');
  assert.ok(av * av + bv * bv <= a.vx * a.vx + 1e-8, 'Bumpers never generate kinetic energy');
  assert.ok((bv - av) * M <= 6 + 1e-8, 'Hard crashes cap relative rebound at 6 m/s');
  if (speed <= .3) close(av, bv, 'Very slow nudges settle without a bounce');
  if (speed === 4) assert.ok(bv > .8 * a.vx, 'A normal bump gives the other boat an obvious shove');
  if (speed === 40) close((bv - av) * M, 6, 'The high-speed rebound cap takes effect');
  const moved = (body, change) => ({ ...body, x: body.x + change.dx, y: body.y + change.dy,
    vx: body.vx + change.dvx, vy: body.vy + change.dvy });
  const nextA = moved(a, hit.a), nextB = moved(b, hit.b);
  assert.equal(contact(nextA, nextA, nextB), null, 'A resolved departing contact gets no repeat kick');
}

{
  const a = pose(0, 0, { vx: 12 / M, vy: 4 / M });
  const b = pose(0, B - .1 / M, { vx: 8 / M, vy: -4 / M });
  const hit = contact(a, { ...a, x: -2 / M, y: -.4 / M }, b,
    { ...b, x: -2 / M, y: B + .4 / M });
  verify(hit);
  close(-hit.ny * hit.a.dvx + hit.nx * hit.a.dvy, 0,
    'Glancing hull contact retains the first boat\'s speed along the contact tangent');
  close(-hit.ny * hit.b.dvx + hit.nx * hit.b.dvy, 0,
    'Glancing hull contact retains the second boat\'s speed along the contact tangent');
}

{
  const a = pose(2 * L, B * .06, { vx: 30 / M });
  const oldA = pose(-2 * L, B * .02, { vx: a.vx }), b = pose();
  const hit = contact(a, oldA, b);
  verify(hit);
  assert.ok(a.x + hit.a.dx < b.x + hit.b.dx, 'A fast full crossing preserves encounter order');
  assert.ok((b.x + hit.b.dx) - (a.x + hit.a.dx) >= L - .01 / M);
  close(hit.a.dy, 0, 'CCD does not rewind unrelated tangential travel');
  close(hit.b.dy, 0, 'The struck boat is not dragged along the approaching path');
}

// Neither endpoint overlaps, but the rotating bow sweeps through the other
// hull in the middle. A start/end-only SAT test would miss this encounter.
{
  const oldA = pose(), a = pose(0, 0, { angle: Math.PI });
  const b = pose(0, 5 / M, { angle: Math.PI / 2 });
  assert.equal(contact(oldA, oldA, b), null);
  assert.equal(contact(a, a, b), null);
  const hit = contact(a, oldA, b);
  verify(hit);
  assert.ok(hit.t > 0 && hit.t < .5, 'Rotation is checked continuously before its midpoint');
  assert.ok(Math.hypot(hit.a.dx, hit.a.dy) > 0, 'A rotating-edge sweep produces a real separation correction');
}

{
  const a = pose(0, 0, { angle: -Math.PI + .03 }), oldA = pose(0, 0, { angle: Math.PI - .03 });
  const b = pose(0, 3 / M, { angle: Math.PI });
  assert.equal(contact(a, oldA, b), null, 'Angle wrapping follows the short turn instead of a phantom full rotation');
  const departingA = pose(0, -.5 / M, { vy: -2 / M });
  const departingB = pose(0, B + .5 / M, { vy: 2 / M });
  assert.equal(contact(departingA, pose(), departingB, pose(0, B - .1 / M)), null,
    'Already-separating hulls are allowed to leave an old contact');
}

{
  const a = pose(), b = pose(0, B - .1 / M);
  const hit = contact(a, a, b);
  verify(hit);
  close(hit.a.dvx, 0, 'Stationary overlap is separated without a launch impulse');
  close(hit.a.dvy, 0, 'Stationary overlap is separated without a launch impulse');
  verify(contact(a, a, a, a));
  assert.equal(boatContactResponse(a, a, b, b, NaN, B), null, 'Invalid dimensions cannot create non-finite corrections');
}

// The common distant/clear case has a cheap bound; the difficult turn remains
// capped even when called repeatedly by a shared room with many observers.
const started = performance.now();
for (let i = 0; i < 300; i++) {
  const a = pose(0, 0, { angle: Math.PI }), oldA = pose();
  contact(a, oldA, pose(0, 5 / M, { angle: Math.PI / 2 }));
  assert.equal(contact(a, oldA, pose(1000 / M, 1000 / M)), null);
}
console.log(`Boat hull contacts passed: close side/bow gaps, bumper rebound, quiet nudges, bounded energy and sliding, fast and rotating sweeps, separating poses and finite corrections; 300 hard sweeps + broad-phase rejects in ${(performance.now() - started).toFixed(0)} ms.`);
