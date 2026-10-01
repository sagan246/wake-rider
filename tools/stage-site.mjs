// Stage the existing buildless browser game for Sites, using the original 2D style.
// Keep native bundles, tooling, local launchers and logs outside public output.
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'dist');
if (destination !== join(root, 'dist') || !destination.startsWith(root + sep)) {
  throw new Error('Refusing to clean an unexpected static output path.');
}
const entries = [
  'index.html', 'game.js', 'replay.js', 'styles.css', 'legal.css',
  'privacy.html', 'support.html', 'licenses.html',
  'camera', 'input', 'physics', 'simulation', 'renderers', 'maps', 'multiplayer/client.js'
];
for (const entry of entries) await stat(join(root, entry));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const entry of entries) await cp(join(root, entry), join(destination, entry), { recursive: true });
console.log('Staged the complete browser game in dist, including both maps.');
