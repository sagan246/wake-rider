import { CONFIG, MPH_PER_UNIT, UNITS_PER_FOOT } from './config.js';
import { clamp, len } from './math.js';
import { sampleWater } from './wake.js';

const EMPTY_TUBE_ADDED_MASS_LB = 75;
const RIDER_RETURN_SECONDS = 3;
const MAX_WATER_SKIPS = 5;
const SPLASH_LIFETIME_SECONDS = 1.35;

export function effectiveTubeMass(riderOn, riderMass) {
  return CONFIG.tubeWeightLb + (riderOn ? riderMass : EMPTY_TUBE_ADDED_MASS_LB);
}

export function updateRiderGripState(tube, rider, dt) {
  const previousBaseline = Number.isFinite(tube.loadBaseline) ? tube.loadBaseline : 0;
  tube.loadShock = Math.max(0, tube.tension - previousBaseline);
  tube.loadBaseline = previousBaseline
    + (tube.tension - previousBaseline) * clamp(dt * 2.2, 0, 1);

  const steadyOverload = tube.tension > rider.grip * 4.2;
  const shockOverload = tube.loadShock > rider.grip * 2.1;
  const hardImpact = tube.impact > rider.grip / 100;

  let fell = false;
  let returned = false;
  if (tube.riderOn && (steadyOverload || shockOverload || hardImpact)) {
    tube.riderOn = false;
    tube.riderReturn = RIDER_RETURN_SECONDS;
    tube.fallSplash = 1;
    fell = true;
  }
  if (!tube.riderOn) {
    tube.riderReturn = Math.max(0, tube.riderReturn - dt);
    if (tube.riderReturn === 0) {
      tube.riderOn = true;
      tube.splash = Math.max(tube.splash, .55);
      tube.loadBaseline = tube.tension;
      tube.loadShock = 0;
      returned = true;
    }
  }

  return { steadyOverload, shockOverload, hardImpact, fell, returned };
}

export function createFallenRider(tube, rider, cause, tubeAx = 0, tubeAy = 0) {
  const acceleration = len(tubeAx, tubeAy);
  const accelerationX = acceleration > 1 ? tubeAx / acceleration : Math.cos(tube.angle);
  const accelerationY = acceleration > 1 ? tubeAy / acceleration : Math.sin(tube.angle);
  const travelSpeed = len(tube.prevVx, tube.prevVy);
  const travelX = travelSpeed > 1 ? tube.prevVx / travelSpeed : Math.cos(tube.angle);
  const travelY = travelSpeed > 1 ? tube.prevVy / travelSpeed : Math.sin(tube.angle);
  const sideX = -Math.sin(tube.angle) * (Math.sign(tube.roll) || 1);
  const sideY = Math.cos(tube.angle) * (Math.sign(tube.roll) || 1);

  let offsetX = -accelerationX * CONFIG.tubeRadius * .28;
  let offsetY = -accelerationY * CONFIG.tubeRadius * .28;
  let verticalSpeed = Math.max(tube.vz, 10);
  let spinRate = 2.2;
  if (cause === 'hard-landing') {
    offsetX = travelX * CONFIG.tubeRadius * .18;
    offsetY = travelY * CONFIG.tubeRadius * .18;
    verticalSpeed = Math.max(tube.vz, 18 + tube.impact * 38);
    spinRate = 4.4;
  } else if (cause === 'edge-catch') {
    offsetX = sideX * CONFIG.tubeRadius * .35;
    offsetY = sideY * CONFIG.tubeRadius * .35;
    verticalSpeed = Math.max(tube.vz, 15 + tube.impact * 24);
    spinRate = 5.2 * (Math.sign(tube.roll) || 1);
  } else if (cause === 'collision') {
    verticalSpeed = Math.max(tube.vz, 13 + tube.impact * 28);
    spinRate = 4.8 * (Math.sign(tube.angularVelocity) || 1);
  }

  // The rider retains the tube's pre-impulse velocity. The tube then continues
  // responding to the rope, so a rope shock naturally leaves the rider behind.
  return {
    x: tube.x + offsetX,
    y: tube.y + offsetY,
    z: tube.z + 1.7 * UNITS_PER_FOOT,
    vx: tube.prevVx,
    vy: tube.prevVy,
    vz: verticalSpeed,
    angle: Math.atan2(travelY, travelX),
    tumble: 0,
    spinRate,
    age: 0,
    floating: false,
    skipCount: 0,
    impacts: [],
    cause,
    color: rider.color
  };
}

function reattachFallenRider(tube, rider, body) {
  const emptyTubeMass = effectiveTubeMass(false, rider.mass);
  const combinedMass = emptyTubeMass + rider.mass;
  tube.vx = (tube.vx * emptyTubeMass + body.vx * rider.mass) / combinedMass;
  tube.vy = (tube.vy * emptyTubeMass + body.vy * rider.mass) / combinedMass;
  tube.vz = (tube.vz * emptyTubeMass + body.vz * rider.mass) / combinedMass;
  tube.riderOn = true;
  tube.riderReturn = 0;
  tube.impact = Math.max(tube.impact, .18);
  tube.splash = Math.max(tube.splash, .5);
  tube.loadBaseline = tube.tension;
  tube.loadShock = 0;
}

export function updateFallenRider(tube, rider, wakes, dt) {
  const body = tube.fallenRider;
  if (!body) return { reattached: false, skipped: false };

  body.age += dt;
  body.impacts = body.impacts
    .map(impact => ({ ...impact, age: impact.age + dt }))
    .filter(impact => impact.age < SPLASH_LIFETIME_SECONDS);
  let skipped = false;

  if (!body.floating) {
    body.vz -= CONFIG.gravity * dt;
    const airDamping = Math.exp(-dt * .018);
    body.vx *= airDamping;
    body.vy *= airDamping;
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.z += body.vz * dt;
    body.tumble += body.spinRate * dt;

    const dx = body.x - tube.x;
    const dy = body.y - tube.y;
    const relativeSpeed = len(body.vx - tube.vx, body.vy - tube.vy);
    const tubeTop = tube.z + 1.15 * UNITS_PER_FOOT;
    const canLandOnTube = body.age > .18
      && body.vz <= tube.vz + 4
      && body.z >= tube.z - .15 * UNITS_PER_FOOT
      && body.z <= tubeTop + 1.1 * UNITS_PER_FOOT
      && len(dx, dy) < CONFIG.tubeRadius * .78
      && relativeSpeed < 38 + rider.grip * .32;
    if (canLandOnTube) {
      reattachFallenRider(tube, rider, body);
      return { reattached: true, skipped: false };
    }

    const water = sampleWater(wakes, body.x, body.y);
    const contactHeight = water.height + .42 * UNITS_PER_FOOT;
    if (body.z <= contactHeight && body.vz < water.vz) {
      const relativeVx = body.vx - water.ux;
      const relativeVy = body.vy - water.uy;
      const horizontalSpeed = len(relativeVx, relativeVy);
      const normalSpeed = water.vz - body.vz;
      const impactAngle = Math.atan2(normalSpeed, Math.max(horizontalSpeed, 1));
      const impactStrength = clamp((normalSpeed + horizontalSpeed * .12) / 70, .25, 1);
      body.impacts.push({ x: body.x, y: body.y, age: 0, strength: impactStrength });

      const orientationFactor = .72 + Math.abs(Math.cos(body.tumble)) * .28;
      const canSkip = horizontalSpeed * MPH_PER_UNIT > 12
        && impactAngle < .42
        && body.skipCount < MAX_WATER_SKIPS;
      if (canSkip) {
        const rebound = horizontalSpeed * .22 * orientationFactor
          * clamp(1 - impactAngle / .58, .35, 1);
        body.z = contactHeight;
        body.vz = water.vz + clamp(rebound, 12, 52);
        const retention = clamp(.82 - impactAngle * .42 - body.skipCount * .055, .52, .82);
        body.vx = water.ux + relativeVx * retention;
        body.vy = water.uy + relativeVy * retention;
        body.spinRate *= .84;
        body.skipCount += 1;
        skipped = true;
      } else {
        body.z = contactHeight;
        body.vz = water.vz;
        body.floating = true;
        body.spinRate = 0;
      }
    }
  } else {
    const water = sampleWater(wakes, body.x, body.y);
    const relativeVx = body.vx - water.ux;
    const relativeVy = body.vy - water.uy;
    const speed = len(relativeVx, relativeVy);
    const waterDamping = Math.exp(-dt * (1.3 + speed * .012));
    body.vx = water.ux + relativeVx * waterDamping;
    body.vy = water.uy + relativeVy * waterDamping;
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.z += (water.height + .55 * UNITS_PER_FOOT - body.z) * clamp(dt * 8, 0, 1);
    body.vz = water.vz;
    if (speed > 2) body.angle = Math.atan2(body.vy, body.vx);
  }

  return { reattached: false, skipped };
}
