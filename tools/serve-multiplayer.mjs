import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createLocalD1 } from './local-d1.mjs';
import worker from '../dist/server/index.js';
await mkdir('.local-data',{recursive:true});
const DB=createLocalD1('.local-data/lake.sqlite');
DB.raw.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
for(const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort()){
  if(DB.raw.prepare('SELECT name FROM local_migrations WHERE name=?').get(file))continue;
  DB.raw.exec(await readFile(`drizzle/${file}`,'utf8'));DB.raw.prepare('INSERT INTO local_migrations(name) VALUES (?)').run(file);
}
const server=createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const chunk of req){chunks.push(chunk);if(chunks.reduce((n,c)=>n+c.length,0)>8192){res.writeHead(413);res.end();return;}}
    const body=Buffer.concat(chunks),request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(body.length?{body}: {})});
    const response=await worker.fetch(request,{DB,LAKE_REALTIME_URL:process.env.LAKE_REALTIME_URL});
    const headers=new Headers(response.headers);
    // Node fetch decodes forwarded realtime responses; do not label those
    // decoded bytes as gzip or keep the compressed Content-Length.
    headers.delete('Content-Encoding');headers.delete('Content-Length');
    res.writeHead(response.status,Object.fromEntries(headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error(error);res.writeHead(500);res.end('Local server error');}
});
server.listen(8783,'127.0.0.1',()=>console.log('Shared-lake preview: http://127.0.0.1:8783/?map=oswego'));
