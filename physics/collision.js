import { CONFIG, MPH_PER_UNIT, UNITS_PER_FOOT } from './config.js';
import { clamp } from './math.js';
import { effectiveTubeMass } from './rider.js';
import { tubeReboundSpeed, startTubeGlide } from './tube-impact.js';

const CONTACT_FRICTION = .3;
const COMPRESSION_STIFFNESS = 78;
const COMPRESSION_DAMPING = 15;
const MAX_COMPRESSION = .38;
const COLLISION_VERTICAL_CLEARANCE_FT = 2.2;
const IMPACT_REFERENCE_MPH = 28;

function hullGeometry() {
  const length = CONFIG.boatLength * UNITS_PER_FOOT;
  const radius = CONFIG.boatBeam * UNITS_PER_FOOT * .5;
  return { length, radius, axisHalfLength: Math.max(0, length * .5 - radius) };
}

function localPoint(x, y, boat, angle = boat.angle) {
  const dx = x - boat.x, dy = y - boat.y;
  const fx = Math.cos(angle), fy = Math.sin(angle);
  return { x: dx * fx + dy * fy, y: dx * -fy + dy * fx };
}

function worldPoint(x, y, boat) {
  const fx = Math.cos(boat.angle), fy = Math.sin(boat.angle);
  return { x: boat.x + x * fx - y * fy, y: boat.y + x * fy + y * fx };
}

function capsuleSample(point, axisHalfLength) {
  const axisX = clamp(point.x, -axisHalfLength, axisHalfLength);
  const dx = point.x - axisX, dy = point.y;
  return { axisX, dx, dy, distance: Math.hypot(dx, dy) };
}

function closestSweepSample(start, end, axisHalfLength) {
  const at = t => capsuleSample({
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t
  }, axisHalfLength);
  let low = 0, high = 1;
  // Distance to the capsule axis is convex along a linear relative path.
  for (let iteration = 0; iteration < 16; iteration++) {
    const a = low + (high - low) / 3;
    const b = high - (high - low) / 3;
    if (at(a).distance < at(b).distance) high = b;
    else low = a;
  }
  const t = (low + high) * .5;
  return {
    t,
    point: { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t },
    ...at(t)
  };
}

function updateCompression(tube, dt) {
  tube.collisionCompression ||= 0;
  tube.collisionCompressionVelocity ||= 0;
  const acceleration = -COMPRESSION_STIFFNESS * tube.collisionCompression
    - COMPRESSION_DAMPING * tube.collisionCompressionVelocity;
  tube.collisionCompressionVelocity += acceleration * dt;
  tube.collisionCompression = clamp(
    tube.collisionCompression + tube.collisionCompressionVelocity * dt,
    0,
    MAX_COMPRESSION
  );
  if (tube.collisionCompression === 0 && tube.collisionCompressionVelocity < 0) tube.collisionCompressionVelocity = 0;
  tube.collisionSplash = Math.max(0, (tube.collisionSplash || 0) - dt * 1.8);
  tube.collisionAge = (tube.collisionAge ?? 10) + dt;
  tube.collisionImpactTime = Math.max(0, (tube.collisionImpactTime || 0) - dt);
}

export function boatTubeSeparation(boat, tube) {
  const hull = hullGeometry();
  const local = localPoint(tube.x, tube.y, boat);
  const sample = capsuleSample(local, hull.axisHalfLength);
  return sample.distance - hull.radius - CONFIG.tubeRadius;
}

export function resolveBoatTubeCollision({ boat, tube, rider, previousBoat, previousTube, dt }) {
  updateCompression(tube, dt);
  const hull = hullGeometry();
  const contactRadius = hull.radius + CONFIG.tubeRadius;
  const currentLocal = localPoint(tube.x, tube.y, boat);
  const previousReference = previousBoat || boat;
  const previousLocal = localPoint(
    previousTube?.x ?? tube.x,
    previousTube?.y ?? tube.y,
    previousReference,
    boat.angle
  );
  const currentSample = capsuleSample(currentLocal, hull.axisHalfLength);
  const swept = closestSweepSample(previousLocal, currentLocal, hull.axisHalfLength);
  const verticalGap = Math.abs((tube.z || 0) - (boat.z || 0));
  if (Math.min(currentSample.distance, swept.distance) >= contactRadius
      || verticalGap > COLLISION_VERTICAL_CLEARANCE_FT * UNITS_PER_FOOT) {
    return { hit: false, relativeSpeedMph: 0, impulse: 0 };
  }

  const collisionLocal = currentSample.distance < contactRadius ? currentLocal : swept.point;
  const collisionSample = capsuleSample(collisionLocal, hull.axisHalfLength);
  let localNx = collisionSample.dx, localNy = collisionSample.dy;
  let normalLength = Math.hypot(localNx, localNy);
  if (normalLength < 1e-6) {
    localNx = previousLocal.x >= 0 ? 1 : -1;
    localNy = 0;
    collisionSample.axisX = localNx * hull.axisHalfLength;
    normalLength = 1;
  }
  localNx /= normalLength; localNy /= normalLength;
  const cos = Math.cos(boat.angle), sin = Math.sin(boat.angle);
  const nx = localNx * cos - localNy * sin;
  const ny = localNx * sin + localNy * cos;
  const hullContact = worldPoint(
    collisionSample.axisX + localNx * hull.radius,
    localNy * hull.radius,
    boat
  );

  const boatMass = Math.max(CONFIG.boatWeightLb, 1);
  const tubeMass = Math.max(effectiveTubeMass(tube.riderOn, rider.mass), 1);
  const boatInverseMass = 1 / boatMass;
  const tubeInverseMass = 1 / tubeMass;
  const inverseMassSum = boatInverseMass + tubeInverseMass;
  const sweptOnly = currentSample.distance >= contactRadius;
  if (sweptOnly) {
    const safeCenter = worldPoint(
      collisionSample.axisX + localNx * contactRadius,
      localNy * contactRadius,
      boat
    );
    tube.x = safeCenter.x;
    tube.y = safeCenter.y;
  } else {
    const penetration = contactRadius - currentSample.distance;
    const correction = Math.max(0, penetration - .015 * UNITS_PER_FOOT) * .92;
    boat.x -= nx * correction * boatInverseMass / inverseMassSum;
    boat.y -= ny * correction * boatInverseMass / inverseMassSum;
    tube.x += nx * correction * tubeInverseMass / inverseMassSum;
    tube.y += ny * correction * tubeInverseMass / inverseMassSum;
  }

  const rx = hullContact.x - boat.x, ry = hullContact.y - boat.y;
  const boatContactVx = boat.vx - (boat.yawRate || 0) * ry;
  const boatContactVy = boat.vy + (boat.yawRate || 0) * rx;
  const relativeVx = tube.vx - boatContactVx;
  const relativeVy = tube.vy - boatContactVy;
  const normalSpeed = relativeVx * nx + relativeVy * ny;
  const yawInertia = boatMass * (hull.length * hull.length + (hull.radius * 2) ** 2) / 12;
  const tubeInertia = tubeMass * CONFIG.tubeRadius * CONFIG.tubeRadius * .5;
  let normalImpulse = 0;

  if (normalSpeed < 0) {
    const boatNormalLever = rx * ny - ry * nx;
    const normalDenominator = inverseMassSum + boatNormalLever * boatNormalLever / yawInertia;
    normalImpulse = (-normalSpeed + tubeReboundSpeed(-normalSpeed)) / normalDenominator;
    const normalImpulseX = nx * normalImpulse, normalImpulseY = ny * normalImpulse;
    tube.vx += normalImpulseX * tubeInverseMass;
    tube.vy += normalImpulseY * tubeInverseMass;
    startTubeGlide(tube, normalImpulseX * tubeInverseMass, normalImpulseY * tubeInverseMass);
    boat.vx -= normalImpulseX * boatInverseMass;
    boat.vy -= normalImpulseY * boatInverseMass;
    boat.yawRate -= (rx * normalImpulseY - ry * normalImpulseX) / yawInertia;

    const tx = -ny, ty = nx;
    const nextBoatContactVx = boat.vx - boat.yawRate * ry;
    const nextBoatContactVy = boat.vy + boat.yawRate * rx;
    const tubeLever = -CONFIG.tubeRadius;
    const tangentSpeed = (tube.vx - nextBoatContactVx) * tx + (tube.vy - nextBoatContactVy) * ty
      + tubeLever * (tube.angularVelocity || 0);
    const boatTangentLever = rx * ty - ry * tx;
    const tangentDenominator = inverseMassSum
      + boatTangentLever * boatTangentLever / yawInertia
      + tubeLever * tubeLever / tubeInertia;
    const tangentImpulse = clamp(
      -tangentSpeed / tangentDenominator,
      -normalImpulse * CONTACT_FRICTION,
      normalImpulse * CONTACT_FRICTION
    );
    const tangentImpulseX = tx * tangentImpulse, tangentImpulseY = ty * tangentImpulse;
    tube.vx += tangentImpulseX * tubeInverseMass;
    tube.vy += tangentImpulseY * tubeInverseMass;
    boat.vx -= tangentImpulseX * boatInverseMass;
    boat.vy -= tangentImpulseY * boatInverseMass;
    boat.yawRate -= (rx * tangentImpulseY - ry * tangentImpulseX) / yawInertia;
    tube.angularVelocity = clamp(
      (tube.angularVelocity || 0) + tubeLever * tangentImpulse / tubeInertia,
      -1.25,
      1.25
    );
  }

  const relativeSpeedMph = Math.max(0, -normalSpeed) * MPH_PER_UNIT;
  const severity = clamp(relativeSpeedMph / IMPACT_REFERENCE_MPH, 0, 1);
  if (relativeSpeedMph > .25) {
    tube.collisionCompression = Math.max(tube.collisionCompression, .05 + severity * .29);
    tube.collisionCompressionVelocity = Math.max(tube.collisionCompressionVelocity, severity * .65);
    tube.collisionNormalX = nx;
    tube.collisionNormalY = ny;
    tube.collisionSplash = Math.max(tube.collisionSplash, .25 + severity * .75);
    tube.collisionContactX = hullContact.x;
    tube.collisionContactY = hullContact.y;
    tube.collisionImpulse = normalImpulse;
    tube.collisionAge = 0;
    tube.collisionImpactTime = .3;
    tube.impact = Math.max(tube.impact || 0, severity);
    tube.splash = Math.max(tube.splash || 0, severity * .7);
  }
  return { hit: true, relativeSpeedMph, impulse: normalImpulse, severity };
}
