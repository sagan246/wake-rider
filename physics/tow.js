import { CONFIG, STANDARD_GRAVITY, UNITS_PER_FOOT } from './config.js';
import { stepTubeGlide } from './tube-impact.js';
import { clamp, len, normAngle } from './math.js';
import { applyTowReaction, towPoint } from './boat.js';
import { createFallenRider, effectiveTubeMass, updateFallenRider, updateRiderGripState } from './rider.js';
import { solveTubeRope } from './rope.js';
import { sampleWater } from './wake.js';

const REFERENCE_FORCE_MASS_LB = 200;

export function properAccelerationG(ax, ay, az, gravity = CONFIG.gravity) {
  // An accelerometer measures forces other than gravity. Subtracting the
  // free-fall acceleration makes a ballistic tube read near 0 g, a supported
  // tube read 1 g, and a landing spike according to its actual deceleration.
  return Math.hypot(ax, ay, az + gravity) / Math.max(gravity, 1e-9);
}

export function ropeTensionForState(stretch, separationSpeed, effectiveInverseMass) {
  if (stretch <= 0) return 0;
  const elasticRange = Math.max(CONFIG.ropeCompliance, .01 * UNITS_PER_FOOT);
  const stiffness = CONFIG.ropeWorkingLoad / elasticRange;
  const reducedMass = 1 / Math.max(effectiveInverseMass, 1e-9);
  const damping = 2 * CONFIG.ropeDampingRatio * Math.sqrt(stiffness * reducedMass);
  return clamp(
    stiffness * stretch + damping * separationSpeed,
    0,
    CONFIG.ropeMaximumLoad
  );
}

function sampleTubeContacts(tube, waterAt) {
  const fx = Math.cos(tube.angle);
  const fy = Math.sin(tube.angle);
  const sx = -fy;
  const sy = fx;
  const point = (name, forward, side) => {
    const x = tube.x + fx * forward + sx * side;
    const y = tube.y + fy * forward + sy * side;
    return { name, x, y, ...waterAt(x, y) };
  };

  const front = point('front', CONFIG.tubeRadius, 0);
  const back = point('back', -CONFIG.tubeRadius, 0);
  const left = point('left', 0, -CONFIG.tubeRadius);
  const right = point('right', 0, CONFIG.tubeRadius);
  const points = [front, back, left, right];

  return {
    points,
    height: points.reduce((sum, contact) => sum + contact.height, 0) / points.length,
    vz: points.reduce((sum, contact) => sum + contact.vz, 0) / points.length,
    energy: points.reduce((sum, contact) => sum + contact.energy, 0) / points.length,
    pitch: (front.height - back.height) / (CONFIG.tubeRadius * 2),
    roll: (right.height - left.height) / (CONFIG.tubeRadius * 2)
  };
}

export function tubeTowPoint(tube) {
  const pitch = tube.pitch || 0;
  const pitchRate = tube.pitchRate || 0;
  const eyeHeight = CONFIG.tubeTowEyeHeightFt * UNITS_PER_FOOT;
  // Rotate both the front-rim offset and the eye's height with the tube. Adding
  // eye height in world Z after rotation let a nose-down tube pull its own tow
  // eye inside the body, shortening the line and producing visible kinks.
  const planarOffset = CONFIG.tubeTowOffset * Math.cos(pitch)
    - eyeHeight * Math.sin(pitch);
  const offsetX = Math.cos(tube.angle) * planarOffset;
  const offsetY = Math.sin(tube.angle) * planarOffset;
  const angularVelocity = tube.angularVelocity || 0;
  const height = CONFIG.tubeTowOffset * Math.sin(pitch)
    + eyeHeight * Math.cos(pitch);
  const planarSpeedFromPitch = (-CONFIG.tubeTowOffset * Math.sin(pitch)
    - eyeHeight * Math.cos(pitch)) * pitchRate;

  return {
    x: tube.x + offsetX,
    y: tube.y + offsetY,
    z: tube.z + height,
    vx: tube.vx - angularVelocity * offsetY + Math.cos(tube.angle) * planarSpeedFromPitch,
    vy: tube.vy + angularVelocity * offsetX + Math.sin(tube.angle) * planarSpeedFromPitch,
    vz: (tube.vz || 0) + planarOffset * pitchRate,
    offsetX,
    offsetY
  };
}

export function tubeCenterBehindBoat(boat, tubeAngle = boat.angle) {
  const tow = towPoint(boat);
  const tubeEyeZ = CONFIG.tubeTowEyeHeightFt * UNITS_PER_FOOT;
  const verticalDifference = tow.z - tubeEyeZ;
  const horizontalRopeSpan = Math.sqrt(Math.max(
    CONFIG.ropeLength * CONFIG.ropeLength - verticalDifference * verticalDifference,
    0
  ));
  return {
    x: tow.x - Math.cos(boat.angle) * horizontalRopeSpan
      - Math.cos(tubeAngle) * CONFIG.tubeTowOffset,
    y: tow.y - Math.sin(boat.angle) * horizontalRopeSpan
      - Math.sin(tubeAngle) * CONFIG.tubeTowOffset
  };
}

function refreshBoatBodySpeeds(boat) {
  const fx = Math.cos(boat.angle);
  const fy = Math.sin(boat.angle);
  boat.speed = Math.max(0, boat.vx * fx + boat.vy * fy);
  boat.lateralSpeed = boat.vx * -fy + boat.vy * fx;
}

function enforceTowLength(boat, tube, tubeInverseMass) {
  const boatInverseMass = REFERENCE_FORCE_MASS_LB / CONFIG.boatWeightLb;
  let tow = towPoint(boat);
  let attachment = tubeTowPoint(tube);
  let dx = tow.x - attachment.x;
  let dy = tow.y - attachment.y;
  let dz = tow.z - attachment.z;
  let distance = len(dx, dy) || 1;
  // Leave a small solver buffer for vertical motion that occurs later in the
  // fixed step, keeping the final 3D line inside its compliance band.
  const maximumDistance = CONFIG.ropeLength
    + Math.max(0, CONFIG.ropeCompliance - .02 * UNITS_PER_FOOT);
  const maximumHorizontalDistance = Math.sqrt(Math.max(
    maximumDistance * maximumDistance - dz * dz,
    0
  ));
  if (distance <= maximumHorizontalDistance) return;

  const nx = dx / distance;
  const ny = dy / distance;
  const inverseMassSum = tubeInverseMass + boatInverseMass;
  const excess = distance - maximumHorizontalDistance;
  const tubeShare = tubeInverseMass / inverseMassSum;
  const boatShare = boatInverseMass / inverseMassSum;
  tube.x += nx * excess * tubeShare;
  tube.y += ny * excess * tubeShare;
  boat.x -= nx * excess * boatShare;
  boat.y -= ny * excess * boatShare;

  tow = towPoint(boat);
  attachment = tubeTowPoint(tube);
  dx = tow.x - attachment.x;
  dy = tow.y - attachment.y;
  dz = tow.z - attachment.z;
  distance = Math.hypot(dx, dy, dz) || 1;
  const constraintX = dx / distance;
  const constraintY = dy / distance;
  const constraintZ = dz / distance;
  const separationSpeed = (tow.vx - attachment.vx) * constraintX
    + (tow.vy - attachment.vy) * constraintY
    + (tow.vz - attachment.vz) * constraintZ;
  if (separationSpeed > 0) {
    const impulse = separationSpeed / inverseMassSum * .94;
    tube.vx += constraintX * impulse * tubeInverseMass;
    tube.vy += constraintY * impulse * tubeInverseMass;
    tube.vz += constraintZ * impulse * tubeInverseMass;
    boat.vx -= constraintX * impulse * boatInverseMass;
    boat.vy -= constraintY * impulse * boatInverseMass;
    boat.vz -= constraintZ * impulse * boatInverseMass;
  }
  refreshBoatBodySpeeds(boat);
}

export function updateTowSystem({ boat, tube, ropeChain, rider, wakes, dt }) {
  const collisionDrag = stepTubeGlide(tube, dt);
  const waterFriction = clamp(CONFIG.tubeWaterFriction ?? 1, .4, 1.8);
  const waterAt = (x, y) => sampleWater(wakes, x, y);
  const tow = towPoint(boat);
  const attachment = tubeTowPoint(tube);
  const dx = tow.x - attachment.x;
  const dy = tow.y - attachment.y;
  const dz = tow.z - attachment.z;
  const distance = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / distance;
  const ny = dy / distance;
  const nz = dz / distance;

  // An empty tube still carries added water mass, but it accelerates and slides
  // more readily than the same tube with a rider aboard.
  const totalTubeMass = effectiveTubeMass(tube.riderOn, rider.mass);
  const tubeMassRatio = totalTubeMass / REFERENCE_FORCE_MASS_LB;
  const tubeInverseMass = 1 / tubeMassRatio;
  const boatInverseMass = REFERENCE_FORCE_MASS_LB / CONFIG.boatWeightLb;
  const stretch = Math.max(0, distance - CONFIG.ropeLength);
  const separationSpeed = (tow.vx - attachment.vx) * nx
    + (tow.vy - attachment.vy) * ny
    + (tow.vz - attachment.vz) * nz;
  const tension = ropeTensionForState(
    stretch,
    separationSpeed,
    tubeInverseMass + boatInverseMass
  );
  tube.tension += (tension - tube.tension) * clamp(dt * 14, 0, 1);

  let ax = 0;
  let ay = 0;
  let verticalTowAcceleration = 0;
  let angularAcceleration = 0;
  boat.towVerticalLoad = 0;
  if (tension > 0) {
    const forceX = nx * tension;
    const forceY = ny * tension;
    const forceZ = nz * tension;
    ax += forceX * tubeInverseMass;
    ay += forceY * tubeInverseMass;
    verticalTowAcceleration += forceZ * tubeInverseMass;
    applyTowReaction(boat, forceX, forceY, dt, forceZ);

    const torque = attachment.offsetX * forceY - attachment.offsetY * forceX;
    const yawInertia = tubeMassRatio * CONFIG.tubeRadius * CONFIG.tubeRadius * .5;
    angularAcceleration += torque / yawInertia * .055;
  }

  const initialSpeed = len(tube.vx, tube.vy);
  const surfaceFlow = waterAt(tube.x, tube.y);
  const relativeVx = tube.vx - surfaceFlow.ux;
  const relativeVy = tube.vy - surfaceFlow.uy;
  const relativeSpeed = len(relativeVx, relativeVy);
  if (tube.air) {
    ax -= tube.vx * .035 * tubeInverseMass;
    ay -= tube.vy * .035 * tubeInverseMass;
  } else {
    // High-Reynolds-number drag is quadratic in velocity relative to the fluid.
    // Roll and pitch expose more tube area, while a rolled rim adds a separate
    // lateral edge force instead of merely multiplying world-space damping.
    const normalLoadFactor = clamp(1 - verticalTowAcceleration / CONFIG.gravity, .55, 1.18);
    const exposedArea = 1 + Math.abs(tube.roll || 0) * .55 + Math.abs(tube.pitch || 0) * .28;
    const dragCoefficient = (.135 + relativeSpeed * .0027)
      * waterFriction * normalLoadFactor * exposedArea * collisionDrag;
    ax -= relativeVx * dragCoefficient * tubeInverseMass;
    ay -= relativeVy * dragCoefficient * tubeInverseMass;

    const sideX = -Math.sin(tube.angle);
    const sideY = Math.cos(tube.angle);
    const lateralFlow = relativeVx * sideX + relativeVy * sideY;
    const rimImmersion = clamp((Math.abs(tube.roll || 0) - .12) / .5, 0, 1);
    const rimDrag = lateralFlow * Math.abs(lateralFlow) * .0012
      * waterFriction * rimImmersion * tubeInverseMass * collisionDrag;
    ax -= sideX * rimDrag;
    ay -= sideY * rimDrag;
    ax -= surfaceFlow.sx * CONFIG.gravity * .55 * tubeInverseMass;
    ay -= surfaceFlow.sy * CONFIG.gravity * .55 * tubeInverseMass;
  }

  tube.vx += ax * dt;
  tube.vy += ay * dt;
  tube.x += tube.vx * dt;
  tube.y += tube.vy * dt;

  const ropeAngle = Math.atan2(ny, nx);
  const ropeError = normAngle(ropeAngle - tube.angle);
  const ropeLoad = clamp(tube.tension / 110, 0, 1);
  // Fabric deformation and the tow-eye patch add a small restoring moment.
  // Most rotation still comes from the actual off-centre rope force above.
  angularAcceleration += ropeError * (.18 + ropeLoad * .62);
  if (!tube.air && relativeSpeed > 3 && ropeLoad < .45) {
    angularAcceleration += normAngle(Math.atan2(relativeVy, relativeVx) - tube.angle)
      * .08 * (1 - ropeLoad);
  }
  const angularDamping = tube.air ? 1.7 : (3.8 + relativeSpeed * .008) * Math.sqrt(waterFriction);
  tube.angularVelocity += angularAcceleration * dt;
  tube.angularVelocity *= Math.exp(-dt * angularDamping);
  tube.angularVelocity = clamp(tube.angularVelocity, -.7, .7);
  tube.angle = normAngle(tube.angle + tube.angularVelocity * dt);

  // The rope cannot pass through the round tube. At the contact angle, the rim
  // carries the line and turns the tow eye back toward it.
  const contactError = normAngle(ropeAngle - tube.angle);
  tube.ropeContact = Math.abs(contactError) > CONFIG.tubeRopeContactAngle;
  if (tube.ropeContact) {
    const contactSide = Math.sign(contactError) || 1;
    tube.angle = normAngle(ropeAngle - contactSide * CONFIG.tubeRopeContactAngle);
    if (contactSide * tube.angularVelocity < 0) tube.angularVelocity *= .12;
  }

  enforceTowLength(boat, tube, tubeInverseMass);
  refreshBoatBodySpeeds(boat);

  const finalTow = towPoint(boat);
  const finalAttachment = tubeTowPoint(tube);
  const finalDx = finalTow.x - finalAttachment.x;
  const finalDy = finalTow.y - finalAttachment.y;
  const finalDz = finalTow.z - finalAttachment.z;
  const finalDistance = Math.hypot(finalDx, finalDy, finalDz) || 1;
  const finalNx = finalDx / finalDistance;
  const finalNy = finalDy / finalDistance;
  const finalNz = finalDz / finalDistance;
  const ropeSide = finalNx * -Math.sin(tube.angle) + finalNy * Math.cos(tube.angle);
  const contacts = sampleTubeContacts(tube, waterAt);
  tube.contacts = contacts;
  const ropeRoll = clamp(ropeSide * tube.tension / 260, -.34, .34);
  const ropePitch = clamp(finalNz * tube.tension / 180, -.28, .28);
  const previousPitch = tube.pitch || 0;
  tube.pitch = previousPitch + (clamp(contacts.pitch + ropePitch, -.55, .55) - previousPitch) * clamp(dt * 7, 0, 1);
  tube.pitchRate = (tube.pitch - previousPitch) / dt;
  tube.roll += (clamp(contacts.roll * 1.4 + ropeRoll, -.72, .72) - tube.roll) * clamp(dt * 7, 0, 1);

  const edgeCatch = !tube.air
    ? clamp((Math.abs(tube.roll) - .22) * 2.1 * waterFriction, 0, 1) * clamp(relativeSpeed / 90, 0, 1)
    : 0;
  if (edgeCatch > 0) {
    const edgeSlow = Math.exp(-dt * edgeCatch * 1.45);
    tube.vx *= edgeSlow;
    tube.vy *= edgeSlow;
    tube.impact = Math.max(tube.impact, edgeCatch * .32);
  }

  const centerWater = waterAt(tube.x, tube.y);
  const water = {
    ...centerWater,
    height: contacts.height,
    vz: contacts.vz,
    energy: Math.max(centerWater.energy, contacts.energy)
  };
  const planarSpeed = len(tube.vx, tube.vy);
  const waterRelativeVx = tube.vx - water.ux;
  const waterRelativeVy = tube.vy - water.uy;
  const waterRelativeSpeed = len(waterRelativeVx, waterRelativeVy);
  const alongSlope = water.sx * (waterRelativeVx / (waterRelativeSpeed || 1))
    + water.sy * (waterRelativeVy / (waterRelativeSpeed || 1));

  if (!tube.air) {
    const waterResponseScale = Math.sqrt(CONFIG.gravity / STANDARD_GRAVITY);
    const towLiftHeight = clamp(verticalTowAcceleration / CONFIG.gravity, -.22, .42)
      * .45 * UNITS_PER_FOOT;
    tube.z += (water.height + towLiftHeight - tube.z) * clamp(dt * 10 * waterResponseScale, 0, 1);
    tube.vz += (water.vz + verticalTowAcceleration * .12 - tube.vz) * clamp(dt * 7 * waterResponseScale, 0, 1);
    if (alongSlope > .065 && waterRelativeSpeed > 58 && water.energy > .1) {
      tube.vz = clamp(
        water.vz + alongSlope * waterRelativeSpeed * .72 + verticalTowAcceleration * .18,
        20,
        105
      );
      tube.air = true;
    }
  } else {
    tube.vz += verticalTowAcceleration * dt;
    tube.vz -= CONFIG.gravity * dt;
    tube.z += tube.vz * dt;
    if (tube.z <= water.height && tube.vz < water.vz) {
      const attitudePenalty = 1 + Math.abs(tube.pitch) * .7 + Math.abs(tube.roll) * .8;
      tube.impact = clamp((water.vz - tube.vz) / 90 * attitudePenalty, 0, 1);
      tube.z = water.height;
      tube.vz = water.vz * .35;
      tube.air = false;
      tube.splash = 1;
      const landingDrag = 1 - tube.impact * .16;
      tube.vx *= landingDrag;
      tube.vy *= landingDrag;
    }
  }

  const tubeAx = (tube.vx - tube.prevVx) / dt;
  const tubeAy = (tube.vy - tube.prevVy) / dt;
  const tubeAz = (tube.vz - (tube.prevVz || 0)) / dt;
  const gripEvent = updateRiderGripState(tube, rider, dt);
  if (gripEvent.fell) {
    const shockSeverity = tube.loadShock / Math.max(rider.grip * 2.1, 1);
    const impactSeverity = tube.impact / Math.max(rider.grip / 100, .01);
    const fallCause = tube.collisionImpactTime > 0 && gripEvent.hardImpact
      ? 'collision'
      : edgeCatch > .18 && impactSeverity >= shockSeverity
        ? 'edge-catch'
        : gripEvent.hardImpact && impactSeverity > shockSeverity
          ? 'hard-landing'
          : gripEvent.shockOverload
            ? 'rope-shock'
            : 'overload';
    tube.fallenRider = createFallenRider(tube, rider, fallCause, tubeAx, tubeAy);
  }
  if (gripEvent.returned) {
    tube.fallenRider = null;
  } else if (!tube.riderOn && tube.fallenRider) {
    const riderMotion = updateFallenRider(tube, rider, wakes, dt);
    if (riderMotion.reattached) tube.fallenRider = null;
  }

  const rawG = properAccelerationG(tubeAx, tubeAy, tubeAz);
  tube.feltG += (clamp(rawG, 0, 6) - tube.feltG) * clamp(dt * 10, 0, 1);
  tube.peakG = Math.max(tube.peakG, tube.feltG);
  tube.prevVx = tube.vx;
  tube.prevVy = tube.vy;
  tube.prevVz = tube.vz;
  tube.debugAx = tubeAx;
  tube.debugAy = tubeAy;
  tube.debugAz = tubeAz;
  tube.impact *= Math.exp(-dt * 4);
  tube.fallSplash = Math.max(0, tube.fallSplash - dt * .7);
  tube.splash = Math.max(0, tube.splash - dt * 2.2);

  // Solve the visible line only after the tube's height and pitch have been
  // integrated. The nodes use the same full 3D length as the tow constraint,
  // so a taut elevated line no longer has artificial sideways slack.
  const ropeTow = towPoint(boat);
  const ropeAttachment = tubeTowPoint(tube);
  solveTubeRope(ropeChain, ropeTow, ropeAttachment, tube, dt);

  return { water, planarSpeed };
}
