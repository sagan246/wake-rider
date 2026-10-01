import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = resolve(projectRoot, 'www');

if (webDir !== join(projectRoot, 'www') || !webDir.startsWith(`${projectRoot}${sep}`)) {
  throw new Error(`Refusing to clean unexpected mobile output path: ${webDir}`);
}

const copyEntries = [
  'game.js',
  'styles.css',
  'replay.js',
  'privacy.html',
  'support.html',
  'licenses.html',
  'legal.css',
  'camera',
  'input',
  'physics',
  'simulation',
  'maps',
  'renderers',
  'multiplayer/client.js','multiplayer/http-client.js','multiplayer/socket-client.js',
  'multiplayer/peer-motion.js','multiplayer/inactivity.js'
];

await rm(webDir, { recursive: true, force: true });
await mkdir(join(webDir, 'renderers'), { recursive: true });

for (const entry of copyEntries) {
  const source = join(projectRoot, entry);
  await stat(source);
  await cp(source, join(webDir, entry), { recursive: true });
}

const sourceHtml = await readFile(join(projectRoot, 'index.html'), 'utf8');
const moduleTagPattern = /(\s*<script type="module" src="game\.js[^\"]*"><\/script>)/;
if (!moduleTagPattern.test(sourceHtml)) {
  throw new Error('Could not find the game module tag in index.html.');
}
const mobileHtml = sourceHtml.replace(
  moduleTagPattern,
  '$1\n  <script type="module" src="native.js"></script>'
);
await writeFile(join(webDir, 'index.html'), mobileHtml, 'utf8');

await build({
  entryPoints: [join(projectRoot, 'mobile', 'native-entry.js')],
  outfile: join(webDir, 'native.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: ['safari15', 'chrome100']
});

const builtFiles = copyEntries.length + 2;
console.log(`Built ${builtFiles} mobile entries in ${relative(projectRoot, webDir)} (2D, offline).`);
