import { clamp } from '../physics/math.js';

const KEY_BINDINGS = Object.freeze({
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'throttle',
  KeyW: 'throttle',
  ArrowDown: 'reverse',
  KeyS: 'reverse'
});

export function createInputController({
  target = window,
  onReset = () => {},
  onView = () => {}
} = {}) {
  const digital = { left: 0, right: 0, throttle: 0, reverse: 0 };
  const gamepad = { steer: 0, throttle: 0, reverse: 0, connected: false };
  const touch = { steer: 0, throttle: 0, reverse: 0 };

  target.addEventListener('keydown', event => {
    // Arrow keys and typing belong to focused form fields, including the map selector.
    if (event.target?.closest?.('input, select, textarea, dialog')) return;
    const control = KEY_BINDINGS[event.code];
    if (control) {
      digital[control] = 1;
      event.preventDefault();
    }
    if (event.code === 'KeyR') onReset();
    if (event.code === 'Digit1') onView('top');
    if (event.code === 'Digit2') onView('driver');
    if (event.code === 'Digit3') onView('tube');
    if (event.code === 'Digit4') onView('person');
    if (event.code === 'Digit5') onView('helm');
  });

  target.addEventListener('keyup', event => {
    const control = KEY_BINDINGS[event.code];
    if (control) digital[control] = 0;
  });

  // Keyup can happen in another window. Release held keys on blur while
  // preserving the intentional latched marine throttle and wheel position.
  target.addEventListener('blur', resetDigital);

  function resetDigital() {
    for (const control of Object.keys(digital)) digital[control] = 0;
  }

  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const active = Array.from(pads).find(Boolean);
    gamepad.connected = !!active;
    if (!active) {
      gamepad.steer = 0;
      gamepad.throttle = 0;
      gamepad.reverse = 0;
      return;
    }
    const rawSteer = active.axes[0] || 0;
    gamepad.steer = Math.abs(rawSteer) > .12 ? rawSteer : 0;
    gamepad.throttle = active.buttons[7]?.value || 0;
    gamepad.reverse = active.buttons[6]?.value || 0;
  }

  function sample() {
    return {
      forward: Math.max(digital.throttle, gamepad.throttle, touch.throttle),
      reverse: Math.max(digital.reverse, gamepad.reverse, touch.reverse),
      steer: clamp(digital.right - digital.left + gamepad.steer + touch.steer, -1, 1),
      gamepadConnected: gamepad.connected
    };
  }

  function setDigital(name, value) {
    if (name in digital) digital[name] = clamp(value, 0, 1);
  }

  function setTouchSteer(value) {
    touch.steer = clamp(value, -1, 1);
  }

  function setTouchThrottle(value) {
    const next = Math.abs(value) < .035 ? 0 : clamp(value, -1, 1);
    touch.throttle = Math.max(0, next);
    touch.reverse = Math.max(0, -next);
    return next;
  }

  function resetTouch() {
    touch.steer = 0;
    touch.throttle = 0;
    touch.reverse = 0;
  }

  function resetAll() {
    resetDigital();
    gamepad.steer = 0;
    gamepad.throttle = 0;
    gamepad.reverse = 0;
    gamepad.connected = false;
    resetTouch();
  }

  return {
    hasHeldInput: () => Object.values(digital).some(value => value > 0)
      || Math.abs(gamepad.steer) > .12 || gamepad.throttle > .05 || gamepad.reverse > .05,
    pollGamepad,
    resetAll,
    resetTouch,
    sample,
    setDigital,
    setTouchSteer,
    setTouchThrottle
  };
}
