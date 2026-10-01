// Count deliberate interaction, never simulation motion or latched throttle.
export function createActivityTracker({ target = window, clock = () => performance.now() } = {}) {
  let sequence = 0, lastMark = -Infinity;
  const pointers = new Set();
  function mark() {
    const now = clock();
    if (now - lastMark >= 250) { sequence++; lastMark = now; }
  }
  for (const event of ['keydown', 'input', 'wheel']) target.addEventListener(event, mark);
  target.addEventListener('pointerdown', event => { pointers.add(event.pointerId); mark(); });
  for (const event of ['pointerup', 'pointercancel']) target.addEventListener(event, e => { pointers.delete(e.pointerId); mark(); });
  target.addEventListener('pointermove', event => { if (event.buttons || pointers.has(event.pointerId)) mark(); });
  target.addEventListener('blur', () => pointers.clear());
  return {
    sample(heldInput = false, paused = false) {
      if (paused) pointers.clear();
      else if (heldInput || pointers.size) mark();
      return sequence;
    }
  };
}
