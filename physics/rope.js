import { CONFIG, UNITS_PER_FOOT } from './config.js';
import { clamp, normAngle } from './math.js';

export function createRope(start, end) {
  return Array.from({ length: CONFIG.ropeNodes }, (_, index) => {
    const t = index / (CONFIG.ropeNodes - 1);
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    const z = (start.z || 0) + ((end.z || 0) - (start.z || 0)) * t;
    return { x, y, z, px: x, py: y, pz: z };
  });
}

// Resolve the rope against a conservative spherical envelope around the tube.
// Applying this during every PBD pass lets the line curve naturally around the
// fabric instead of replacing a long group of tube-end nodes with a rigid ray.
export function constrainRopeOutsideTube(nodes, tube) {
  const center = { x: tube.x, y: tube.y, z: tube.z };
  const radius = CONFIG.tubeRadius + .025 * UNITS_PER_FOOT;
  const fallbackX = Math.cos(tube.angle);
  const fallbackY = Math.sin(tube.angle);
  const moveNode = (node, dx, dy, dz) => {
    node.x += dx;
    node.y += dy;
    node.z += dz;
    node.px += dx;
    node.py += dy;
    node.pz += dz;
  };

  for (let index = 1; index < nodes.length - 1; index++) {
    const node = nodes[index];
    let dx = node.x - center.x;
    let dy = node.y - center.y;
    let dz = node.z - center.z;
    let distance = Math.hypot(dx, dy, dz);
    if (distance >= radius) continue;
    if (distance < 1e-6) {
      dx = fallbackX;
      dy = fallbackY;
      dz = 0;
      distance = 1;
    }
    const correction = radius - distance;
    moveNode(node, dx / distance * correction, dy / distance * correction, dz / distance * correction);
  }

  // Node-only projection can still leave a chord passing through the tube.
  for (let index = 0; index < nodes.length - 1; index++) {
    const a = nodes[index];
    const b = nodes[index + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const lengthSquared = abx * abx + aby * aby + abz * abz || 1;
    const t = clamp(
      ((center.x - a.x) * abx + (center.y - a.y) * aby + (center.z - a.z) * abz) / lengthSquared,
      0,
      1
    );
    const closestX = a.x + abx * t;
    const closestY = a.y + aby * t;
    const closestZ = a.z + abz * t;
    let nx = closestX - center.x;
    let ny = closestY - center.y;
    let nz = closestZ - center.z;
    let distance = Math.hypot(nx, ny, nz);
    if (distance >= radius) continue;
    if (distance < 1e-6) {
      nx = fallbackX;
      ny = fallbackY;
      nz = 0;
      distance = 1;
    }
    nx /= distance;
    ny /= distance;
    nz /= distance;
    const aWeight = index === 0 ? 0 : 1 - t;
    const bWeight = index + 1 === nodes.length - 1 ? 0 : t;
    const denominator = aWeight * aWeight + bWeight * bWeight;
    if (denominator < 1e-8) continue;
    const penetration = radius - distance;
    const aCorrection = penetration * aWeight / denominator;
    const bCorrection = penetration * bWeight / denominator;
    if (aWeight) moveNode(a, nx * aCorrection, ny * aCorrection, nz * aCorrection);
    if (bWeight) moveNode(b, nx * bCorrection, ny * bCorrection, nz * bCorrection);
  }

  // The tow patch limits only the first free segment. Repeated length passes
  // spread the direction change smoothly through the following nodes.
  if (nodes.length <= 2) return;
  const eye = nodes[nodes.length - 1];
  const adjacent = nodes[nodes.length - 2];
  const dx = adjacent.x - eye.x;
  const dy = adjacent.y - eye.y;
  const planarLength = Math.hypot(dx, dy);
  if (planarLength <= 1e-6) return;
  const exitAngle = Math.atan2(dy, dx);
  const error = normAngle(exitAngle - tube.angle);
  const limitedError = clamp(error, -CONFIG.tubeRopeContactAngle, CONFIG.tubeRopeContactAngle);
  if (limitedError === error) return;
  const angle = tube.angle + limitedError;
  const targetX = eye.x + Math.cos(angle) * planarLength;
  const targetY = eye.y + Math.sin(angle) * planarLength;
  moveNode(adjacent, targetX - adjacent.x, targetY - adjacent.y, 0);
}

export function solveRope(nodes, start, end, dt, constrain = null) {
  const damping = Math.exp(-dt * 2.4);
  const segment = CONFIG.ropeLength / (nodes.length - 1);

  for (let index = 1; index < nodes.length - 1; index++) {
    const node = nodes[index];
    const vx = (node.x - node.px) * damping;
    const vy = (node.y - node.py) * damping;
    const vz = (node.z - node.pz) * damping;
    node.px = node.x;
    node.py = node.y;
    node.pz = node.z;
    node.x += vx;
    node.y += vy;
    node.z += vz;
  }

  for (let pass = 0; pass < CONFIG.ropeIterations; pass++) {
    nodes[0].x = start.x;
    nodes[0].y = start.y;
    nodes[0].z = start.z || 0;
    nodes[nodes.length - 1].x = end.x;
    nodes[nodes.length - 1].y = end.y;
    nodes[nodes.length - 1].z = end.z || 0;

    for (let index = 0; index < nodes.length - 1; index++) {
      const a = nodes[index];
      const b = nodes[index + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const distance = Math.hypot(dx, dy, dz) || 1;
      const error = (distance - segment) / distance;

      if (index === 0) {
        b.x -= dx * error;
        b.y -= dy * error;
        b.z -= dz * error;
      } else if (index === nodes.length - 2) {
        a.x += dx * error;
        a.y += dy * error;
        a.z += dz * error;
      } else {
        a.x += dx * error * .5;
        a.y += dy * error * .5;
        a.z += dz * error * .5;
        b.x -= dx * error * .5;
        b.y -= dy * error * .5;
        b.z -= dz * error * .5;
      }
    }

    if (constrain) constrain(nodes);
  }

  nodes[0].x = start.x;
  nodes[0].y = start.y;
  nodes[0].z = start.z || 0;
  nodes[nodes.length - 1].x = end.x;
  nodes[nodes.length - 1].y = end.y;
  nodes[nodes.length - 1].z = end.z || 0;
}

export function solveTubeRope(nodes, start, end, tube, dt) {
  solveRope(nodes, start, end, dt, ropeNodes => constrainRopeOutsideTube(ropeNodes, tube));
}
