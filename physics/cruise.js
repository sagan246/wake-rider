import { clamp } from './math.js';

export function createCruiseState() {
  return { integral: 0, output: 0 };
}

export function updateCruiseThrottle(state, {
  enabled,
  targetSpeedMph,
  currentSpeedMph,
  driverThrottle,
  maxSpeedMph,
  dt
}) {
  const leverLimit = clamp(driverThrottle, 0, 1);
  if (!enabled || leverLimit < .02) {
    state.integral = 0;
    state.output = leverLimit;
    return leverLimit;
  }

  const target = clamp(targetSpeedMph, 0, maxSpeedMph);
  const error = target - Math.max(0, currentSpeedMph);
  state.integral = clamp(state.integral + error * dt, -8, 8);

  // Quadratic hull drag needs approximately the square of the target/max-speed
  // ratio as steady throttle. The feedback terms correct for towing and turns.
  const feedForward = (target / Math.max(maxSpeedMph, 1)) ** 2;
  const requested = Math.min(
    leverLimit,
    clamp(feedForward + error * .055 + state.integral * .015, 0, 1)
  );

  // Move the virtual throttle servo progressively instead of locking speed or
  // applying an instantaneous nonphysical acceleration.
  state.output += clamp(requested - state.output, -2.8 * dt, 1.8 * dt);
  state.output = clamp(state.output, 0, leverLimit);
  return state.output;
}
