import { startCanvas2DApp } from './renderers/canvas2d-app.js?v=28';

document.documentElement.classList.add('js-ready');

// iOS Safari can still perform page-level pinch zoom despite touch-action and
// viewport settings. Cancel only browser gestures; pointer events continue to
// drive the simulator's steering, throttle, and two-finger camera FOV.
const preventPageGesture = event => event.preventDefault();
for (const eventName of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(eventName, preventPageGesture, { passive: false });
}
document.addEventListener('touchmove', event => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });

try {
  startCanvas2DApp();
} catch (error) {
  globalThis.__wakeRiderStartupError = error?.stack || String(error);
  document.documentElement.dataset.startupError = error?.stack || String(error);
  console.error('Wake Rider Lab could not start.', error);
}
