import { UNITS_PER_FOOT } from './config.js';
import { clamp } from './math.js';

const UNITS_PER_METER = UNITS_PER_FOOT / .3048;
const GLIDE_SECONDS = 2.2;

// Tuned inflatable bounce, shared by local and network contacts. Quiet contact
// is inelastic; hard hits have bounded rebound, never a minimum-energy kick.
export function tubeReboundSpeed(approach, tubePair = false) {
  const speed = Math.max(0, approach);
  const blend = clamp((speed / UNITS_PER_METER - .3) / 1.7, 0, 1);
  return Math.min(8 * UNITS_PER_METER,
    speed * (tubePair ? .55 : .65) * blend * blend * (3 - 2 * blend));
}

export function startTubeGlide(tube, dvx, dvy) {
  const speed = Math.hypot(dvx, dvy) / UNITS_PER_METER;
  if (!Number.isFinite(speed) || speed <= .25) return;
  tube.collisionGlideTime = Math.max(tube.collisionGlideTime || 0,
    GLIDE_SECONDS * clamp((speed - .25) / 3.75, 0, 1));
}

export function stepTubeGlide(tube, dt) {
  const remaining = clamp(tube.collisionGlideTime || 0, 0, GLIDE_SECONDS);
  const blend = remaining / GLIDE_SECONDS;
  tube.collisionGlideTime = Math.max(0, remaining - dt);
  return 1 - .65 * blend * blend * (3 - 2 * blend);
}
