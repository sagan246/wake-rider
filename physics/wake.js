import { CONFIG, UNITS_PER_FOOT } from './config.js';
import { clamp, len } from './math.js';

export function emitWake(wakes, boat) {
  if (boat.speed < 42) return;

  const backX = -Math.cos(boat.angle);
  const backY = -Math.sin(boat.angle);
  const sideX = -Math.sin(boat.angle);
  const sideY = Math.cos(boat.angle);
  const length = CONFIG.boatLength * UNITS_PER_FOOT;
  const beam = CONFIG.boatBeam * UNITS_PER_FOOT;
  const planing = clamp((boat.speed - 34) / 92, 0, 1);
  const strength = clamp(
    (.18 + planing * .9) * CONFIG.wakeStrength * (CONFIG.boatWakeFactor ?? 1),
    0,
    1.5
  );
  const wavelength = length * .36;
  const wavenumber = Math.PI * 2 / wavelength;
  const omega = Math.sqrt(CONFIG.gravity * wavenumber);
  const groupSpeed = .5 * Math.sqrt(CONFIG.gravity / wavenumber);

  for (const side of [-1, 1]) {
    const spread = CONFIG.boatWakeSpread ?? 1;
    const rawDx = backX * .72 + sideX * side * .82 * spread;
    const rawDy = backY * .72 + sideY * side * .82 * spread;
    const magnitude = len(rawDx, rawDy) || 1;
    wakes.push({
      x: boat.x + backX * length * .42 + sideX * side * beam * .5,
      y: boat.y + backY * length * .42 + sideY * side * beam * .5,
      dx: rawDx / magnitude,
      dy: rawDy / magnitude,
      side,
      age: 0,
      strength,
      amplitude: 8 * (CONFIG.boatWakeAmplitude ?? 1),
      width: beam * .28,
      phase: 0,
      wavenumber,
      omega,
      groupSpeed
    });
  }

  if (wakes.length > 2400) wakes.splice(0, wakes.length - 2400);
}

export function updateWakes(wakes, dt) {
  // Long gravity waves retain useful height after the bright crest has faded.
  // Keep the same lifetime, but let older wake packets lose amplitude more
  // gradually so returning through a previous turn still has a real effect.
  const decay = 2.95 / CONFIG.wakeLife;

  for (const wake of wakes) {
    wake.age += dt;
    // The envelope travels at deep-water group velocity while crests pass
    // through it at phase velocity. In envelope coordinates that leaves half
    // the angular frequency for the phase advance.
    wake.phase += (wake.omega - wake.wavenumber * wake.groupSpeed) * dt;
    wake.x += wake.dx * wake.groupSpeed * dt;
    wake.y += wake.dy * wake.groupSpeed * dt;
    wake.width += dt * 4.1;
    wake.strength *= Math.exp(-dt * decay);
  }

  let keep=0;
  for(const wake of wakes)if(wake.age<=CONFIG.wakeLife&&wake.strength>=.035)wakes[keep++]=wake;
  wakes.length=keep;
}

function packetEnvelope(wake, normal, tangent) {
  return Math.exp(
    -(normal * normal) / (wake.width * wake.width * .85)
    - (tangent * tangent) / (wake.width * wake.width * 2.6)
  );
}

export function wakeHeightAtPacket(wake, normal = 0, tangent = 0) {
  const phase = normal * wake.wavenumber - wake.phase;
  return Math.cos(phase) * wake.strength * wake.amplitude * packetEnvelope(wake, normal, tangent);
}

export function sampleWater(wakes, x, y) {
  let height = 0;
  let slopeX = 0;
  let slopeY = 0;
  let verticalSpeed = 0;
  let horizontalSpeedX = 0;
  let horizontalSpeedY = 0;
  let energy = 0;

  // Every wake that is still visible remains physical. At the default emission
  // rate and lifetime this is only about 720 packets, so truncating old wakes
  // creates a much larger realism error than it saves work.
  for (let index = wakes.length - 1; index >= 0; index--) {
    const wake = wakes[index];
    const dx = x - wake.x;
    const dy = y - wake.y;
    // Cheap spatial rejection before projection/oscillation for crowded lakes.
    if(Math.abs(dx)>wake.width*3.7||Math.abs(dy)>wake.width*3.7)continue;
    const nx = wake.dx;
    const ny = wake.dy;
    const tx = -ny;
    const ty = nx;
    const normal = dx * nx + dy * ny;
    const tangent = dx * tx + dy * ty;
    if (Math.abs(normal) > wake.width * 2.4 || Math.abs(tangent) > wake.width * 2.8) continue;

    const envelope = packetEnvelope(wake, normal, tangent);
    const phase = normal * wake.wavenumber - wake.phase;
    const amplitude = wake.strength * wake.amplitude;
    const packetHeight = Math.cos(phase) * amplitude * envelope;
    height += packetHeight;
    energy += Math.abs(amplitude * envelope) / wake.amplitude;
    verticalSpeed += Math.sin(phase) * amplitude * wake.omega * envelope;
    // Surface particles in a progressive deep-water gravity wave have both
    // vertical and horizontal orbital velocity. Tube and rider drag must use
    // their velocity relative to this moving water, not relative to the map.
    const orbitalSpeed = Math.cos(phase) * amplitude * wake.omega * envelope;
    horizontalSpeedX += orbitalSpeed * nx;
    horizontalSpeedY += orbitalSpeed * ny;

    const normalDerivative = -Math.sin(phase) * wake.wavenumber * amplitude * envelope
      - packetHeight * normal / (wake.width * wake.width * .425);
    const tangentDerivative = -packetHeight * tangent / (wake.width * wake.width * 1.3);
    slopeX += normalDerivative * nx + tangentDerivative * tx;
    slopeY += normalDerivative * ny + tangentDerivative * ty;
  }

  return {
    height: clamp(height, -18, 24),
    sx: clamp(slopeX, -.65, .65),
    sy: clamp(slopeY, -.65, .65),
    vz: clamp(verticalSpeed, -55, 55),
    ux: clamp(horizontalSpeedX, -45, 45),
    uy: clamp(horizontalSpeedY, -45, 45),
    energy
  };
}
