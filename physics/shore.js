// Lake rings use game coordinates: the first encloses water and later rings
// enclose islands. Winding order is intentionally not part of the map API.
const geometryCache = new WeakMap();
const SKIN = .025;
// Boat impacts lose energy but retain enough motion to bounce/slide clear.
// Position sanitization (including network poses) keeps the default no-bounce
// response so it cannot reflect an already-resolved client impact a second time.
export const BOAT_SHORE_RESPONSE = Object.freeze({ restitution: .45, tangentRetention: .98 });

function geometry(map) {
  if (!map?.rings?.length) return [];
  if (geometryCache.has(map)) return geometryCache.get(map);
  const edges = [];
  map.rings.forEach((ring, ringIndex) => {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      area += a.x * b.y - b.x * a.y;
    }
    const side = (area >= 0 ? 1 : -1) * (ringIndex === 0 ? 1 : -1);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-8) continue;
      edges.push({ a, b, dx, dy, length, nx: -dy / length * side, ny: dx / length * side,
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
    }
  });
  geometryCache.set(map, edges);
  return edges;
}

function insideRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function isWater(map, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (!map?.rings?.length) return true;
  return insideRing(map.rings[0], x, y)
    && !map.rings.slice(1).some(ring => insideRing(ring, x, y));
}

export function nearestShore(map, x, y) {
  let nearest = null;
  let distanceSquared = Infinity;
  for (const edge of geometry(map)) {
    const t = Math.max(0, Math.min(1,
      ((x - edge.a.x) * edge.dx + (y - edge.a.y) * edge.dy) / (edge.length ** 2)));
    const px = edge.a.x + edge.dx * t, py = edge.a.y + edge.dy * t;
    const squared = (x - px) ** 2 + (y - py) ** 2;
    if (squared < distanceSquared) {
      distanceSquared = squared;
      nearest = { x: px, y: py, nx: edge.nx, ny: edge.ny, distance: Math.sqrt(squared) };
    }
  }
  return nearest;
}

export function hasWaterClearance(map, x, y, radius = 0) {
  if (!isWater(map, x, y)) return false;
  const shore = nearestShore(map, x, y);
  return !shore || shore.distance >= Math.max(0, radius) - 1e-6;
}

// Earliest intersection of a moving circle with all shore segments. Checking
// the whole movement, rather than just its endpoint, prevents jumping through
// a narrow peninsula or island at high speeds or with a long tow correction.
function sweep(map, start, dx, dy, radius) {
  const speedSquared = dx * dx + dy * dy;
  if (speedSquared < 1e-16) return null;
  let result = null;
  const minX = Math.min(start.x, start.x + dx) - radius;
  const maxX = Math.max(start.x, start.x + dx) + radius;
  const minY = Math.min(start.y, start.y + dy) - radius;
  const maxY = Math.max(start.y, start.y + dy) + radius;
  const accept = (t, nx, ny) => {
    if (t < -1e-8 || t > 1 || dx * nx + dy * ny >= -1e-9) return;
    if (!result || t < result.t) result = { t: Math.max(0, t), nx, ny };
  };
  for (const edge of geometry(map)) {
    if (edge.maxX < minX || edge.minX > maxX || edge.maxY < minY || edge.minY > maxY) continue;
    const tx = edge.dx / edge.length, ty = edge.dy / edge.length;
    const nx = -ty, ny = tx;
    const distance = (start.x - edge.a.x) * nx + (start.y - edge.a.y) * ny;
    const normalMotion = dx * nx + dy * ny;
    const startAlong = (start.x - edge.a.x) * tx + (start.y - edge.a.y) * ty;
    if (Math.abs(distance) < radius && startAlong >= 0 && startAlong <= edge.length) {
      const side = distance >= 0 ? 1 : -1;
      accept(0, nx * side, ny * side);
    }
    if (Math.abs(normalMotion) > 1e-10) {
      for (const side of [-1, 1]) {
        const t = (side * radius - distance) / normalMotion;
        const along = (start.x + dx * t - edge.a.x) * tx + (start.y + dy * t - edge.a.y) * ty;
        if (along >= 0 && along <= edge.length) accept(t, nx * side, ny * side);
      }
    }
    for (const point of [edge.a, edge.b]) {
      const px = start.x - point.x, py = start.y - point.y;
      const b = px * dx + py * dy;
      const c = px * px + py * py - radius * radius;
      if (c < 0 && px * px + py * py > 1e-16) {
        const magnitude = Math.hypot(px, py);
        accept(0, px / magnitude, py / magnitude);
      }
      const discriminant = b * b - speedSquared * c;
      if (discriminant < 0) continue;
      const t = (-b - Math.sqrt(discriminant)) / speedSquared;
      if (t < -1e-8 || t > 1) continue;
      const normalX = px + dx * t, normalY = py + dy * t;
      const normalLength = Math.hypot(normalX, normalY);
      if (normalLength > 1e-8) accept(t, normalX / normalLength, normalY / normalLength);
    }
  }
  return result;
}

function recoverWaterPosition(map, position, radius, fallback) {
  const next = { x: position.x, y: position.y };
  // This is only needed after a settings change enlarges a hull, or a supplied
  // spawn is too close to land. Normal movement always uses the swept path.
  for (let pass = 0; pass < 12; pass++) {
    if (hasWaterClearance(map, next.x, next.y, radius)) return next;
    const shore = nearestShore(map, next.x, next.y);
    if (!shore) break;
    next.x = shore.x + shore.nx * (radius + SKIN * 2);
    next.y = shore.y + shore.ny * (radius + SKIN * 2);
  }
  if (fallback && hasWaterClearance(map, fallback.x, fallback.y, radius)) return { ...fallback };
  const spawn = map.spawn;
  if (spawn && hasWaterClearance(map, spawn.x, spawn.y, radius)) return { x: spawn.x, y: spawn.y };
  // A malformed map should fail explicitly instead of silently putting a body
  // on land. All supplied lake maps have a tested, full-hull spawn clearance.
  throw new Error('This map has no safe water position for the selected boat size.');
}

export function resolveShoreCollision(map, body, previous = body, radius = 0, response = {}) {
  if (!map?.rings?.length) return { hit: false };
  const restitution = Math.max(0, Math.min(1, response.restitution ?? 0));
  const tangentRetention = Math.max(0, Math.min(1, response.tangentRetention ?? .94));
  radius = Math.max(.01, radius);
  const start = recoverWaterPosition(map, previous, radius, map.spawn);
  let x = start.x, y = start.y;
  let dx = body.x - x, dy = body.y - y;
  let hit = start.x !== previous.x || start.y !== previous.y;
  let impactSpeed = 0;
  for (let pass = 0; pass < 4; pass++) {
    const contact = sweep(map, { x, y }, dx, dy, radius + SKIN);
    if (!contact) { x += dx; y += dy; break; }
    hit = true;
    const t = Math.max(0, contact.t - 1e-7);
    x += dx * t;
    y += dy * t;
    const remaining = 1 - t;
    dx *= remaining;
    dy *= remaining;
    const intoShore = Math.min(0, dx * contact.nx + dy * contact.ny);
    dx = (dx - intoShore * contact.nx) * tangentRetention - intoShore * restitution * contact.nx;
    dy = (dy - intoShore * contact.ny) * tangentRetention - intoShore * restitution * contact.ny;
    const normalSpeed = Math.min(0, (body.vx || 0) * contact.nx + (body.vy || 0) * contact.ny);
    impactSpeed = Math.max(impactSpeed, -normalSpeed);
    if (normalSpeed < 0) {
      body.vx = ((body.vx || 0) - normalSpeed * contact.nx) * tangentRetention - normalSpeed * restitution * contact.nx;
      body.vy = ((body.vy || 0) - normalSpeed * contact.ny) * tangentRetention - normalSpeed * restitution * contact.ny;
    }
    if (dx * dx + dy * dy < 1e-12) break;
  }
  if (!hasWaterClearance(map, x, y, radius)) {
    // Numerical edge cases at acute corners keep the previous safe position.
    x = start.x;
    y = start.y;
    body.vx = 0;
    body.vy = 0;
    hit = true;
  }
  body.x = x;
  body.y = y;
  if (hit && impactSpeed > 1) {
    const severity = Math.min(1, impactSpeed / 160);
    body.impact = Math.max(body.impact || 0, severity);
    body.splash = Math.max(body.splash || 0, severity * .7);
  }
  return { hit, impactSpeed };
}
