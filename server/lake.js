import { applyRoomAction, roomError } from '../multiplayer/room.js';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function tokenHash(token){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');}

export async function handleLake(request,db) {
  try{
    if(request.method!=='POST')return json({error:'Use POST.'},405);
    const origin=request.headers.get('Origin');
    const publicOrigin='https://wake-rider-lake-oswego.sagan1122.chatgpt.site';
    if(origin && origin!==new URL(request.url).origin && origin!==publicOrigin)return json({error:'Use the game on this site.'},403);
    if(!db)throw roomError(503,'The shared lake is unavailable. Open Water is still available for solo play.');
    if(Number(request.headers.get('Content-Length'))>6000)throw roomError(413,'Update too large.');
    const text=await request.text();if(text.length>6000)throw roomError(413,'Update too large.');
    let input;try{input=JSON.parse(text);}catch{throw roomError(400,'Invalid update.');}
    if(!input||!/^[-a-zA-Z0-9]{16,80}$/.test(input.id)||typeof input.token!=='string'||!/^[-a-zA-Z0-9]{32,100}$/.test(input.token))throw roomError(400,'Invalid session.');
    const hash=await tokenHash(input.token);
    // Every join, reservation and bump commits against a single room revision.
    // A losing request recomputes from the winning state, never overwriting it.
    for(let attempt=0;attempt<8;attempt++){
      const row=await db.prepare('SELECT revision, state_json FROM lake_rooms WHERE id = ?').bind('oswego').first();
      if(!row){await db.prepare('INSERT OR IGNORE INTO lake_rooms (id, revision, state_json, updated_at) VALUES (?, 0, ?, ?)').bind('oswego','{"players":{},"contacts":{}}',Date.now()).run();continue;}
      const now=Date.now(),room=JSON.parse(row.state_json);
      const result=applyRoomAction(room,input,hash,now);
      const committed=await db.prepare('UPDATE lake_rooms SET state_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? RETURNING revision').bind(JSON.stringify(room),now,'oswego',row.revision).first();
      if(committed)return json({...result,revision:committed.revision},result.status||200);
    }
    return json({error:'The lake is busy. Reconnecting…'},503);
  }catch(error){
    if(!error.status)console.error('Lake synchronization failed:',error.message);
    return json({error:error.status?error.message:'The shared lake is temporarily unavailable. Reconnecting…'},error.status||503);
  }
}
