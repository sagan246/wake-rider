import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';

const platform = Capacitor.getPlatform();
document.documentElement.classList.add('native-app');
document.documentElement.dataset.nativePlatform = platform;

async function prepareFullscreenGame() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (platform === 'android') {
      await StatusBar.setOverlaysWebView({ overlay: true });
    }
    await StatusBar.hide();
  } catch (error) {
    console.warn('Could not hide the native status bar.', error);
  }
}

function announceAppState(isActive) {
  window.dispatchEvent(new CustomEvent('wake-rider:native-state', {
    detail: { isActive }
  }));
}

function closeTopDialog() {
  const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return false;

  const cancelEvent = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancelEvent);
  if (!cancelEvent.defaultPrevented && dialog.open) dialog.close();
  return true;
}

const listenerHandles = [];
listenerHandles.push(await App.addListener('appStateChange', ({ isActive }) => {
  announceAppState(isActive);
}));

if (platform === 'android') {
  listenerHandles.push(await App.addListener('backButton', async ({ canGoBack }) => {
    if (closeTopDialog()) return;
    if (canGoBack) {
      history.back();
      return;
    }
    await App.minimizeApp();
  }));
}

globalThis.__wakeRiderNativeListeners = listenerHandles;
void prepareFullscreenGame();
