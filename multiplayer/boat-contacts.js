import { UNITS_PER_FOOT } from '../physics/config.js';
import { BOAT_OUTLINE, BOAT_SPRITE_LENGTH, BOAT_SPRITE_BEAM } from '../physics/boat-hull.js';

const SKIN = .01 / .3048 * UNITS_PER_FOOT;
const TOLERANCE = SKIN * .02;
const MAX_ADVANCES = 96;
const UNITS_PER_METER = UNITS_PER_FOOT / .3048;
const RESTITUTION = .7;
const QUIET_CONTACT_SPEED = .3 * UNITS_PER_METER;
const FULL_BOUNCE_SPEED = 1.5 * UNITS_PER_METER;
const MAX_REBOUND_SPEED = 6 * UNITS_PER_METER;
const cache = new Map();
const turn = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function localHull(length, beam) {
  const key = `${length}:${beam}`;
  if (cache.has(key)) return cache.get(key);
  const points = BOAT_OUTLINE.map(([x, y]) => ({
    x: x * length / BOAT_SPRITE_LENGTH,
    y: y * beam / BOAT_SPRITE_BEAM
  }));
  const normals = points.map((p, i) => {
    const q = points[(i + 1) % points.length], dx = q.x - p.x, dy = q.y - p.y;
    const size = Math.hypot(dx, dy);
    return { x: -dy / size, y: dx / size };
  });
  const hull = { points, normals, radius: Math.hypot(length, beam) / 2 };
  if (cache.size >= 32) cache.clear();
  cache.set(key, hull);
  return hull;
}

function motion(body, previous, hull) {
  return {
    body, previous, hull,
    dx: body.x - previous.x, dy: body.y - previous.y,
    angle: previous.angle ?? body.angle,
    turn: turn(body.angle, previous.angle ?? body.angle)
  };
}

function at(m, t) {
  const angle = m.angle + m.turn * t, c = Math.cos(angle), s = Math.sin(angle);
  const x = m.previous.x + m.dx * t, y = m.previous.y + m.dy * t;
  return {
    points: m.hull.points.map(p => ({ x: x + p.x * c - p.y * s, y: y + p.x * s + p.y * c })),
    normals: m.hull.normals.map(n => ({ x: n.x * c - n.y * s, y: n.x * s + n.y * c }))
  };
}

function interval(points, nx, ny) {
  let min = Infinity, max = -Infinity;
  for (const p of points) {
    const value = p.x * nx + p.y * ny;
    min = Math.min(min, value); max = Math.max(max, value);
  }
  return { min, max };
}

// The signed gap is positive for separated shapes and negative for overlap.
// The normal points from B to A, including containment and coincident centers.
function sat(a, b, relativeX = 0, relativeY = 0, angularBound = 0) {
  let gap = -Infinity, nx = 1, ny = 0, advance = 0;
  for (const axis of [...a.normals, ...b.normals]) {
    const pa = interval(a.points, axis.x, axis.y), pb = interval(b.points, axis.x, axis.y);
    const positive = pa.min - pb.max, negative = pb.min - pa.max;
    const sign = positive >= negative ? 1 : -1;
    const separated = Math.max(positive, negative);
    if (separated > gap) { gap = separated; nx = axis.x * sign; ny = axis.y * sign; }
    if (separated > SKIN) {
      // While this axis remains separated there cannot be a collision. The
      // angular term bounds every vertex's travel even as hull axes rotate.
      const speed = Math.abs(relativeX * axis.x + relativeY * axis.y) + angularBound;
      advance = Math.max(advance, speed > 1e-12 ? (separated - SKIN) / speed : Infinity);
    }
  }
  return { gap, nx, ny, advance };
}

function broadPhase(a, b) {
  const x = a.previous.x - b.previous.x, y = a.previous.y - b.previous.y;
  const dx = a.dx - b.dx, dy = a.dy - b.dy, squared = dx * dx + dy * dy;
  const t = squared ? Math.max(0, Math.min(1, -(x * dx + y * dy) / squared)) : 0;
  return Math.hypot(x + dx * t, y + dy * t) <= a.hull.radius + b.hull.radius + SKIN;
}

function firstContact(a, b) {
  const relativeX = a.dx - b.dx, relativeY = a.dy - b.dy;
  const angularBound = Math.abs(a.turn) * a.hull.radius + Math.abs(b.turn) * b.hull.radius;
  let t = 0;
  for (let iteration = 0; iteration < MAX_ADVANCES; iteration++) {
    const result = sat(at(a, t), at(b, t), relativeX, relativeY, angularBound);
    if (result.gap <= SKIN + TOLERANCE) return { ...result, t };
    if (!Number.isFinite(result.advance) || t + result.advance > 1 + 1e-10) return null;
    t = Math.min(1, t + Math.max(result.advance, 1e-10));
  }
  // Pathological grazing/rotation cases stay bounded. Still resolve a real
  // final overlap, but never invent a hit from the broad-phase circle alone.
  const end = sat(at(a, 1), at(b, 1));
  return end.gap <= SKIN + TOLERANCE ? { ...end, t: 1 } : null;
}

export function boatContactResponse(a, previousA, b, previousB, lengthA, beamA, lengthB = lengthA, beamB = beamA) {
  if (![lengthA, beamA, lengthB, beamB].every(value => Number.isFinite(value) && value > 0)) return null;
  const ma = motion(a, previousA, localHull(lengthA, beamA));
  const mb = motion(b, previousB, localHull(lengthB, beamB));
  if (!broadPhase(ma, mb)) return null;
  const hit = firstContact(ma, mb);
  if (!hit) return null;
  const { nx, ny } = hit;
  const closing = ((a.vx || 0) - (b.vx || 0)) * nx + ((a.vy || 0) - (b.vy || 0)) * ny;
  const finalA = at(ma, 1), finalB = at(mb, 1);
  const finalGap = sat(finalA, finalB).gap;
  // Let a contact that is already departing clear normally. A turning hull
  // can cross another midway through the interval despite zero center speed.
  const rotatingEntry = hit.t > 1e-8 && Math.abs(ma.turn) + Math.abs(mb.turn) > 1e-5;
  if (closing >= 0 && finalGap >= 0 && !rotatingEntry) return null;
  const pa = interval(finalA.points, nx, ny), pb = interval(finalB.points, nx, ny);
  // Preserve the final tangent positions while restoring the entry-side hull
  // separation. Fast boats cannot cross through each other between packets.
  const push = Math.max(0, SKIN - (pa.min - pb.max)) / 2;
  const approach = Math.max(0, -closing);
  // Rubber-bumper response: slow nudges settle, ordinary hits rebound, and
  // high-speed crashes cannot fling the pair apart at full approach speed.
  // Only incoming normal motion powers the bounce; overlap adds no energy.
  const blend = Math.max(0, Math.min(1,
    (approach - QUIET_CONTACT_SPEED) / (FULL_BOUNCE_SPEED - QUIET_CONTACT_SPEED)));
  const rebound = Math.min(MAX_REBOUND_SPEED,
    approach * RESTITUTION * blend * blend * (3 - 2 * blend));
  const impulse = (approach + rebound) / 2;
  if (push < TOLERANCE && impulse < 1e-9) return null;
  const change = sign => ({ dx: nx * push * sign, dy: ny * push * sign,
    dvx: nx * impulse * sign, dvy: ny * impulse * sign });
  return { a: change(1), b: change(-1), nx, ny, t: hit.t };
}
