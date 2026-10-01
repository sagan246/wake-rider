const REPLAY_FRAME_SECONDS = .12;
const REPLAY_MAX_FRAMES = 150;

function interpolateFrame(a, b, amount) {
  const frame = { ...a };
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'tumble']) {
    if (Number.isFinite(a[key]) && Number.isFinite(b[key])) {
      frame[key] = a[key] + (b[key] - a[key]) * amount;
    }
  }
  if (Number.isFinite(a.angle) && Number.isFinite(b.angle)) {
    const delta = Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle));
    frame.angle = a.angle + delta * amount;
  }
  return frame;
}

function interpolateOptionalFrame(a, b, amount) {
  if (!a && !b) return null;
  if (!a || !b) return amount < .5 ? a : b;
  return interpolateFrame(a, b, amount);
}

export function createReplay(traces, maxFrames = REPLAY_MAX_FRAMES) {
  const count = Math.min(traces.boat.length, traces.tube.length, maxFrames);
  if (count < 6) return { active: false, index: 0, ghost: null, boatFrames: [], tubeFrames: [] };

  const boatFrames = traces.boat.slice(-count).map(frame => ({ ...frame }));
  const tubeFrames = traces.tube.slice(-count).map(frame => ({ ...frame }));
  const riderFrames = traces.rider?.length >= count
    ? traces.rider.slice(-count).map(frame => frame ? { ...frame } : null)
    : Array(count).fill(null);
  return {
    active: true,
    index: 0,
    boatFrames,
    tubeFrames,
    riderFrames,
    ghost: { boat: boatFrames[0], tube: tubeFrames[0], rider: riderFrames[0] }
  };
}

export function advanceReplay(replay, dt) {
  if (!replay.active) return null;
  replay.index += dt / REPLAY_FRAME_SECONDS;
  const index = Math.floor(replay.index);
  if (index >= replay.boatFrames.length || index >= replay.tubeFrames.length) {
    replay.active = false;
    replay.ghost = null;
    return null;
  }

  const nextIndex = Math.min(index + 1, replay.boatFrames.length - 1);
  const amount = replay.index - index;
  replay.ghost = {
    boat: interpolateFrame(replay.boatFrames[index], replay.boatFrames[nextIndex], amount),
    tube: interpolateFrame(replay.tubeFrames[index], replay.tubeFrames[nextIndex], amount),
    rider: interpolateOptionalFrame(replay.riderFrames?.[index], replay.riderFrames?.[nextIndex], amount)
  };
  return replay.ghost;
}
