import {
  CONFIG,
  LAB_MAX_MPH,
  MIN_LAB_MAX_MPH,
  MPH_PER_UNIT,
  STANDARD_GRAVITY,
  STANDARD_MAX_MPH,
  UNITS_PER_FOOT
} from './config.js';
import { clamp } from './math.js';
import { stepBoatBump } from './boat-bump.js';

const REFERENCE_FORCE_MASS_LB = 200;
const REFERENCE_POWER_TO_WEIGHT = 350 / 3200;

export function boatHeadingDegrees(angle) {
  return ((angle + Math.PI / 2) * 180 / Math.PI + 360) % 360;
}

export function boatDimensions() {
  return {
    length: CONFIG.boatLength * UNITS_PER_FOOT,
    beam: CONFIG.boatBeam * UNITS_PER_FOOT
  };
}

export function towPoint(boat) {
  const { length } = boatDimensions();
  const offset = length * (CONFIG.boatTowPointRatio ?? .45);
  const fx = Math.cos(boat.angle);
  const fy = Math.sin(boat.angle);
  const pitch = boat.pitch || 0;
  const pitchRate = boat.pitchRate || 0;
  const planarOffset = offset * Math.cos(pitch);
  const rx = -fx * planarOffset;
  const ry = -fy * planarOffset;
  const height = CONFIG.boatTowPointHeightFt * UNITS_PER_FOOT;
  const sternPitchOffset = -offset * Math.sin(pitch);
  const baseZ = boat.z + sternPitchOffset;

  return {
    x: boat.x + rx,
    y: boat.y + ry,
    z: baseZ + height,
    baseZ,
    vx: boat.vx - boat.yawRate * ry + fx * offset * Math.sin(pitch) * pitchRate,
    vy: boat.vy + boat.yawRate * rx + fy * offset * Math.sin(pitch) * pitchRate,
    vz: (boat.vz || 0) - offset * Math.cos(pitch) * pitchRate,
    offsetX: rx,
    offsetY: ry
  };
}

export function applyTowReaction(boat, forceX, forceY, dt, forceZ = 0) {
  const inverseMass = REFERENCE_FORCE_MASS_LB / CONFIG.boatWeightLb;
  boat.vx -= forceX * inverseMass * dt;
  boat.vy -= forceY * inverseMass * dt;
  boat.vz -= forceZ * inverseMass * dt;
  boat.towVerticalLoad = forceZ;

  const tow = towPoint(boat);
  const { length, beam } = boatDimensions();
  const yawInertia = CONFIG.boatWeightLb * (length * length + beam * beam) / 12;
  const torque = tow.offsetX * (-forceY) - tow.offsetY * (-forceX);
  boat.yawRate += torque * REFERENCE_FORCE_MASS_LB / yawInertia * dt;
}

export function updateBoatPlanar(boat, { throttle, steer, maxSpeedMph = STANDARD_MAX_MPH, dt, shoreRecovery = false }) {
  const bumpResistance = stepBoatBump(boat, dt);
  const fx = Math.cos(boat.angle);
  const fy = Math.sin(boat.angle);
  const sx = -fy;
  const sy = fx;
  const forward = boat.vx * fx + boat.vy * fy;
  const lateral = boat.vx * sx + boat.vy * sy;
  const { length, beam } = boatDimensions();

  const selectedMaxMph = clamp(maxSpeedMph, MIN_LAB_MAX_MPH, LAB_MAX_MPH);
  const selectedMax = selectedMaxMph / MPH_PER_UNIT;
  const hullDragCoefficient = .0048;
  const forwardPropulsion = hullDragCoefficient * selectedMax * selectedMax;
  const reverseAvailable = clamp(1 - Math.max(0, forward) / (8 / MPH_PER_UNIT), 0, 1);
  const reverseBumpCoast = boat.bumpReverseCoast && forward < -32;
  const propulsiveAcceleration = throttle >= 0
    ? throttle * forwardPropulsion * (shoreRecovery ? 0 : 1)
    : throttle * 72 * reverseAvailable * (reverseBumpCoast ? 0 : 1);

  // Rudder boats combine forward flow with prop wash. Sterndrives, outboards,
  // and jets use more throttle-driven steering flow and less passive authority
  // while coasting. In every case steering creates side force rather than
  // directly prescribing a turn rate.
  const vectorDrive = CONFIG.boatDriveType !== 'v-drive';
  const steeringThrottle = vectorDrive ? Math.abs(throttle) : Math.max(0, throttle);
  // Keep the driver's steering direction during the short shore rebound;
  // otherwise backing off the bank reverses the rudder and can pin the bow.
  const flowSign = (forward < -2 && !(shoreRecovery && throttle > 0)) || (vectorDrive && throttle < 0) ? -1 : 1;
  const propWash = CONFIG.rudderPropWashSpeed * Math.sqrt(steeringThrottle);
  const forwardSteeringFlow = forward * (CONFIG.steeringFlowForward ?? 1);
  const rudderFlow = Math.sqrt(forwardSteeringFlow * forwardSteeringFlow + propWash * propWash);
  const rudderAngle = steer * CONFIG.maxRudderAngleDeg * Math.PI / 180;
  const hardOverInput = clamp((Math.abs(steer) - .55) / .45, 0, 1);
  const hardOver = hardOverInput * hardOverInput * (3 - 2 * hardOverInput);
  const speedLoss = clamp(1 - Math.abs(forward) / Math.max(selectedMax, 1), 0, .4) / .4;
  const hairpinStrength = clamp(
    CONFIG.hairpinStrength * (CONFIG.boatHairpinFactor ?? 1),
    .35,
    1.7
  );
  // The wake boat does not stay on the same linear rudder curve at hard-over. As it
  // scrubs speed, more hull and lifting-strake area bites the water and the
  // turn tightens rapidly—the characteristic hairpin/pivot response.
  const hullBite = 1 + hardOver * (vectorDrive
    ? .12 * (CONFIG.boatHairpinFactor ?? .5)
    : (.5 + speedLoss * .35) * hairpinStrength);
  const rudderSideAcceleration = (Math.sin(rudderAngle)
    * CONFIG.rudderLiftFactor
    * rudderFlow * rudderFlow / Math.max(length, 1)
    * flowSign
    + (vectorDrive
      ? Math.sin(rudderAngle)
        * Math.abs(propulsiveAcceleration)
        * (CONFIG.vectorThrustSteering ?? 0)
        * flowSign
      : 0))
    * hullBite;

  // Most steering force acts across the path, so it should bend the velocity
  // vector before it behaves like a brake. Charge only a fraction of the
  // generated side force as rudder/hull induced drag; sideslip damping below
  // then supplies the larger, progressively developing energy loss. The old
  // flow-squared term could hit the deceleration clamp the instant the wheel
  // went hard-over and shed nearly half the boat's speed in two seconds.
  const inducedTurnDrag = Math.abs(rudderSideAcceleration)
    * (.08 + hardOver * .22)
    * (CONFIG.boatTurnDragFactor ?? 1);
  const slipDrag = Math.abs(lateral) * Math.abs(lateral) * .0012;
  let forwardAcceleration = propulsiveAcceleration
    - forward * Math.abs(forward) * hullDragCoefficient
    - Math.sign(forward || 1) * (inducedTurnDrag + slipDrag);
  const powerToWeight = CONFIG.boatEngineHp / Math.max(CONFIG.boatWeightLb, 1);
  const powerResponse = clamp(Math.sqrt(powerToWeight / REFERENCE_POWER_TO_WEIGHT), .55, 1.35);
  forwardAcceleration *= (CONFIG.boatLongitudinalResponse ?? 1) * powerResponse;
  forwardAcceleration = clamp(forwardAcceleration, -75, 46);

  const lateralDamping = CONFIG.swayLinearDamping
    + CONFIG.swayQuadraticDamping * Math.abs(lateral)
    + .0025 * Math.abs(forward);
  const lateralAcceleration = rudderSideAcceleration - lateral * lateralDamping * bumpResistance;

  boat.vx += (fx * forwardAcceleration + sx * lateralAcceleration) * dt;
  boat.vy += (fy * forwardAcceleration + sy * lateralAcceleration) * dt;

  const yawInertiaPerMass = (length * length + beam * beam) / 12;
  // The inboard rudder is tucked forward beneath the hull rather than hung on
  // the transom. Tracking fins and immersed strakes transfer that concentrated
  // prop-wash force into the characteristic pivot, represented by the yaw
  // coupling factor. Vector drives apply steering force farther aft.
  const steeringLever = length * (CONFIG.steeringLeverRatio ?? .42);
  // Briefly strengthen the driver's steering after a bank impact. Rotate
  // gradually instead of snapping the hull and its stern tow attachment.
  const yawAcceleration = rudderSideAcceleration
    * steeringLever
    * (CONFIG.steeringYawCoupling ?? 1)
    / yawInertiaPerMass
    + (shoreRecovery && throttle > 0 ? steer * 1.2 : 0);
  const yawDamping = CONFIG.yawLinearDamping
    + CONFIG.yawSpeedDamping * Math.abs(forward) / Math.max(length, 1)
    + CONFIG.yawQuadraticDamping * Math.abs(boat.yawRate);
  const digInYawDamping = yawDamping * (1 - hardOver * speedLoss * .18 * hairpinStrength);
  boat.yawRate += (yawAcceleration - boat.yawRate * digInYawDamping) * dt;
  boat.turnLoadG = Math.abs(boat.yawRate * forward) / CONFIG.gravity;
  boat.turnRollTarget = -Math.sign(rudderSideAcceleration)
    * clamp(Math.atan(boat.turnLoadG) * .36, 0, .44);
  boat.angle += boat.yawRate * dt;
  boat.wheel += (steer - boat.wheel) * clamp(dt * 7, 0, 1);

  // A lowered lab maximum is a propulsion setting, not a brake. Only prevent a
  // boat that was below the selected maximum from accelerating through it.
  const nextFx = Math.cos(boat.angle);
  const nextFy = Math.sin(boat.angle);
  const nextForward = boat.vx * nextFx + boat.vy * nextFy;
  if (forward <= selectedMax && nextForward > selectedMax) {
    const excess = nextForward - selectedMax;
    boat.vx -= nextFx * excess;
    boat.vy -= nextFy * excess;
  }

  const boundedForward = boat.vx * nextFx + boat.vy * nextFy;
  // A shoreline rebound is an external impulse, not powered reverse. Give it
  // a short coast before forward thrust resumes; keep prop-wash steering above.
  // Preserve backward momentum specifically from a boat bump until it
  // dissipates naturally. Keep the existing bank-recovery behavior separate.
  if (forward >= -32) boat.bumpReverseCoast = false;
  const reverseLimit = boat.bumpReverseCoast ? Math.min(-32, forward) : -32;
  if (boundedForward < reverseLimit && !shoreRecovery) {
    const excess = boundedForward - reverseLimit;
    boat.vx -= nextFx * excess;
    boat.vy -= nextFy * excess;
  }

  boat.speed = Math.max(0, boat.vx * nextFx + boat.vy * nextFy);
  boat.lateralSpeed = boat.vx * -nextFy + boat.vy * nextFx;
  boat.x += boat.vx * dt;
  boat.y += boat.vy * dt;
}

export function updateBoatWaterResponse(boat, waterAt, dt) {
  const sample = typeof waterAt === 'function' ? waterAt : () => waterAt;
  const { length, beam } = boatDimensions();
  const fx = Math.cos(boat.angle);
  const fy = Math.sin(boat.angle);
  const sx = -fy;
  const sy = fx;
  const point = (name, forward, side) => {
    const x = boat.x + fx * forward + sx * side;
    const y = boat.y + fy * forward + sy * side;
    return { name, x, y, ...sample(x, y) };
  };
  const bow = point('bow', length * .36, 0);
  const stern = point('stern', -length * .36, 0);
  const left = point('left', 0, -beam * .38);
  const right = point('right', 0, beam * .38);
  const center = { name: 'center', x: boat.x, y: boat.y, ...sample(boat.x, boat.y) };
  const contacts = [bow, stern, left, right, center];
  const meanHeight = contacts.reduce((sum, water) => sum + water.height, 0) / contacts.length;
  const meanVerticalSpeed = contacts.reduce((sum, water) => sum + water.vz, 0) / contacts.length;

  const forwardSpeed = boat.vx * fx + boat.vy * fy;
  const forwardMph = Math.max(0, forwardSpeed) * MPH_PER_UNIT;
  const longitudinalSlope = (bow.height - stern.height) / Math.max(length * .72, 1);
  // A moving hull encounters the spatial rise of a wake as vertical surface
  // velocity. Sampling only the wave's own vz made a stationary-looking hull
  // follow wakes without ever being launched by them.
  const encounteredVerticalSpeed = meanVerticalSpeed + forwardSpeed * longitudinalSlope;
  boat.encounteredVerticalSpeed = encounteredVerticalSpeed;
  const planing = clamp((forwardMph - 10) / 15, 0, 1);
  const pitch = boat.pitch || 0;
  const roll = boat.roll || 0;
  const hullHeightAt = (forward, side) => boat.z
    + forward * Math.sin(pitch)
    + side * Math.sin(roll);
  const contactClearances = [
    hullHeightAt(length * .36, 0) - bow.height,
    hullHeightAt(-length * .36, 0) - stern.height,
    hullHeightAt(0, -beam * .38) - left.height,
    hullHeightAt(0, beam * .38) - right.height,
    boat.z - center.height
  ];
  const contactBand = .16 * UNITS_PER_FOOT;
  boat.contactFraction = contactClearances.filter(clearance => clearance <= contactBand).length / contacts.length;
  boat.air = Boolean(boat.air);
  boat.impact = Math.max(0, (boat.impact || 0) - dt * 1.8);
  boat.splash = Math.max(0, (boat.splash || 0) - dt * 1.35);

  if (!boat.air) {
    // Buoyant stiffness scales with gravity, while critical damping follows
    // the square root of that stiffness. This keeps reduced/high-gravity lab
    // runs physically consistent without changing the equilibrium waterline.
    const gravityScale = CONFIG.gravity / STANDARD_GRAVITY;
    const heaveAcceleration = (meanHeight - boat.z) * 15 * gravityScale
      + (meanVerticalSpeed - boat.vz) * 5.2 * Math.sqrt(gravityScale);
    boat.vz += heaveAcceleration * dt;
    boat.z += boat.vz * dt;

    // A planing hull may leave a sufficiently steep, rising crest. The
    // clearance check prevents ordinary bobbing and small ripples from being
    // mislabeled as flight.
    const upwardEncounter = Math.max(0, encounteredVerticalSpeed);
    boat.launchImpulse = Math.max(0, (boat.launchImpulse || 0) - dt * .35);
    if (planing > .35 && upwardEncounter > 4 * UNITS_PER_FOOT) {
      boat.launchImpulse = Math.max(
        boat.launchImpulse,
        clamp((upwardEncounter - 4 * UNITS_PER_FOOT) / (8 * UNITS_PER_FOOT), 0, 1) * .28
      );
    }
    const separationSpeed = boat.vz - encounteredVerticalSpeed;
    boat.separationSpeed = separationSpeed;
    const launchCandidate = boat.launchImpulse > 0
      && separationSpeed > 3 * UNITS_PER_FOOT
      && boat.contactFraction <= .6;
    boat.launchReadiness = clamp((boat.launchReadiness || 0) + dt * (launchCandidate ? 1 : -3), 0, .04);
    if (boat.launchReadiness >= .017) {
      boat.air = true;
      boat.contactFraction = 0;
      boat.launchReadiness = 0;
      boat.launchImpulse = 0;
    }
  } else {
    boat.vz -= CONFIG.gravity * dt;
    boat.z += boat.vz * dt;

    // Land on whichever sampled hull point reaches the water first. This also
    // permits bow-first or stern-first landings instead of snapping the boat's
    // center to the mean surface.
    const landingClearances = [
      boat.z + length * .36 * Math.sin(boat.pitch || 0) - bow.height,
      boat.z - length * .36 * Math.sin(boat.pitch || 0) - stern.height,
      boat.z - beam * .38 * Math.sin(boat.roll || 0) - left.height,
      boat.z + beam * .38 * Math.sin(boat.roll || 0) - right.height,
      boat.z - center.height
    ];
    const deepestIndex = landingClearances.indexOf(Math.min(...landingClearances));
    if (landingClearances[deepestIndex] <= 0 && boat.vz <= encounteredVerticalSpeed + 2 * UNITS_PER_FOOT) {
      const impactSpeed = Math.max(0, encounteredVerticalSpeed - boat.vz);
      boat.z -= landingClearances[deepestIndex];
      boat.vz = encounteredVerticalSpeed + impactSpeed * .08;
      boat.impact = clamp(impactSpeed / (12 * UNITS_PER_FOOT), 0, 1);
      boat.splash = clamp(.3 + boat.impact * .75, 0, 1);
      boat.air = false;
      boat.contactFraction = .2;
      boat.launchReadiness = 0;
      boat.launchImpulse = 0;
      const landingForward = [length * .36, -length * .36, 0, 0, 0][deepestIndex];
      boat.pitchRate = (boat.pitchRate || 0)
        - landingForward / Math.max(length * .36, 1) * boat.impact * .32;
      const landingSide = [0, 0, -beam * .38, beam * .38, 0][deepestIndex];
      boat.rollRate = (boat.rollRate || 0)
        - landingSide / Math.max(beam * .38, 1) * boat.impact * .25;
      const landingDrag = 1 - boat.impact * .07;
      boat.vx *= landingDrag;
      boat.vy *= landingDrag;
    }
  }

  const towPitch = clamp((boat.towVerticalLoad || 0) / 260, -.1, .14);
  const targetPitch = clamp(Math.atan2(bow.height - stern.height, length * .72) + towPitch, -.32, .32);
  const targetRoll = clamp(
    Math.atan2(right.height - left.height, beam * .76) + (boat.turnRollTarget || 0),
    -.46,
    .46
  );
  const previousPitch = boat.pitch || 0;
  if (boat.air) {
    // Preserve takeoff attitude briefly, then let aerodynamic/rotational
    // damping bring the bow down without pretending this is a full 6-DOF CFD
    // model.
    boat.pitchRate = (boat.pitchRate || 0) * Math.exp(-dt * 1.4) - .11 * dt;
    boat.pitch = clamp(previousPitch + boat.pitchRate * dt, -.38, .38);
    boat.rollRate = (boat.rollRate || 0) * Math.exp(-dt * 1.8);
    boat.roll = clamp((boat.roll || 0) + boat.rollRate * dt, -.5, .5);
  } else {
    const pitchBlend = clamp(dt * (4.5 - planing * .8), 0, 1);
    boat.pitch = previousPitch + (targetPitch - previousPitch) * pitchBlend;
    boat.pitchRate = (boat.pitch - previousPitch) / dt;
    const previousRoll = boat.roll || 0;
    boat.roll = previousRoll + (targetRoll - previousRoll) * clamp(dt * 5, 0, 1);
    boat.rollRate = (boat.roll - previousRoll) / dt;
  }

  // A heavy planing hull reacts only weakly in the horizontal plane, but old
  // wakes can still nudge its track and heading when crossed obliquely.
  if (!boat.air) {
    const waveAccelerationScale = CONFIG.gravity * .032;
    boat.vx -= center.sx * waveAccelerationScale * dt;
    boat.vy -= center.sy * waveAccelerationScale * dt;
    const sideHeightDifference = right.height - left.height;
    boat.yawRate += clamp(sideHeightDifference / Math.max(beam, 1), -.2, .2) * .055 * dt;
  }
  boat.waterContacts = { bow, stern, left, right, center };
}
