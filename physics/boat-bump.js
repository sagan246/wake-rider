import { UNITS_PER_FOOT } from './config.js';
import { clamp } from './math.js';

const METERS_PER_UNIT = .3048 / UNITS_PER_FOOT;
const GLIDE_SECONDS = 2.4;

// A gameplay tuning for bumper boats: dissipate the received momentum more
// slowly for a short time. This never adds velocity or alters the impact itself.
export function startBoatBump(boat, dvx, dvy) {
  const speed = Math.hypot(dvx, dvy) * METERS_PER_UNIT;
  if (!Number.isFinite(speed) || speed <= .1) return;
  const duration = GLIDE_SECONDS * clamp((speed - .1) / 1.9, 0, 1);
  boat.bumpGlideTime = Math.max(boat.bumpGlideTime || 0, duration);
  if (boat.vx * Math.cos(boat.angle) + boat.vy * Math.sin(boat.angle) < -32) {
    boat.bumpReverseCoast = true;
  }
}

export function stepBoatBump(boat, dt) {
  const remaining = clamp(boat.bumpGlideTime || 0, 0, GLIDE_SECONDS);
  const blend = remaining / GLIDE_SECONDS;
  boat.bumpGlideTime = Math.max(0, remaining - dt);
  return 1 - .8 * blend * blend * (3 - 2 * blend);
}
