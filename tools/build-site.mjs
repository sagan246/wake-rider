import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, cp, rm } from 'node:fs/promises';
import { resolve, join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dist=join(root,'dist');
const assets={};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml'};
async function include(path){
  const absolute=join(root,path);
  const entries=await readdir(absolute,{withFileTypes:true}).catch(()=>null);
  if(entries){for(const entry of entries)if(entry.isDirectory()||entry.isFile())await include(join(path,entry.name));return;}
  if(!mime[extname(path)])return;
  assets['/'+path.replaceAll('\\','/')]={body:await readFile(absolute,'utf8'),type:mime[extname(path)]};
}
for(const entry of ['index.html','game.js','replay.js','styles.css','legal.css','privacy.html','support.html','licenses.html','camera','input','physics','simulation','renderers','maps','multiplayer/client.js','multiplayer/http-client.js','multiplayer/socket-client.js','multiplayer/peer-motion.js','multiplayer/inactivity.js'])await include(entry);
await writeFile(join(root,'server/assets.generated.js'),`export const assets=${JSON.stringify(assets)};\n`);
if(relative(root,dist)!=='dist')throw new Error('Unexpected output directory');
await rm(dist,{recursive:true,force:true});await mkdir(join(dist,'server'),{recursive:true});await mkdir(join(dist,'.openai'),{recursive:true});
await build({entryPoints:[join(root,'server/worker.js')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:join(dist,'server/index.js'),minify:true});
await cp(join(root,'.openai/hosting.json'),join(dist,'.openai/hosting.json'));
await cp(join(root,'drizzle'),join(dist,'.openai/drizzle'),{recursive:true});
console.log(`Built shared-lake Worker and ${Object.keys(assets).length} game assets.`);
