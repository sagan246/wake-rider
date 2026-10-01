import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { handleLake } from '../server/lake.js';
import { createLocalD1 } from '../tools/local-d1.mjs';
import { applyRoomAction, MAX_PLAYERS, STALE_MS } from '../multiplayer/room.js';
import { createLakeClient } from '../multiplayer/client.js';
import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { hasWaterClearance } from '../physics/shore.js';
import { createSimulator } from '../simulation/simulator.js';
import { SHARED_LAKE_RULES } from '../simulation/defaults.js';

const DB=createLocalD1();
for(const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort())DB.raw.exec(await readFile(`drizzle/${file}`,'utf8'));
const sessions=Array.from({length:MAX_PLAYERS+1},(_,i)=>({id:`test-player-${String(i).padStart(8,'0')}`,token:`test-secret-${String(i).padStart(32,'0')}`,physicsVersion:SHARED_LAKE_RULES.version}));
async function post(input,origin='https://game.test'){
  const response=await handleLake(new Request('https://game.test/api/lake',{method:'POST',headers:{'Content-Type':'application/json','Origin':origin},body:JSON.stringify(input)}),DB);
  return {status:response.status,data:await response.json()};
}
async function join(session){
  for(let i=0;i<8;i++){const r=await post({...session,action:'join'});if(r.status!==503)return r;}
  throw new Error('Concurrent join did not settle');
}
assert.equal((await post({...sessions[0],physicsVersion:undefined,action:'join'})).status,426,'Older games must refresh before joining with tunable physics');
const joined=await Promise.all(sessions.slice(0,MAX_PLAYERS).map(join));
assert.ok(joined.every(r=>r.status===200),'Concurrent joins succeed without lost room updates');
const latest=await join(sessions[0]);assert.equal(latest.data.players.length,MAX_PLAYERS);
assert.equal(new Set(latest.data.players.map(p=>`${p.boat.x},${p.boat.y}`)).size,MAX_PLAYERS);
assert.equal(new Set(latest.data.players.map(p=>p.color)).size,MAX_PLAYERS,'Every boat has its own color at full capacity');
assert.equal(new Set(latest.data.players.map(p=>p.name)).size,MAX_PLAYERS,'Default skipper names remain unique');
for(const p of latest.data.players){assert.ok(hasWaterClearance(lake,p.boat.x,p.boat.y,5/M));assert.ok(hasWaterClearance(lake,p.tube.x,p.tube.y,3/M));}
for(const p of latest.data.players){
  assert.ok(Math.hypot(p.boat.x-lake.spawn.x,p.boat.y-lake.spawn.y)<85/M,'All players start together in the main basin');
  for(let t=0;t<=1;t+=.05){
    assert.ok(hasWaterClearance(lake,p.boat.x+(p.tube.x-p.boat.x)*t,p.boat.y+(p.tube.y-p.boat.y)*t,100/M),
      'The new launch keeps each full tow corridor well away from the banks');
  }
}
for(const a of latest.data.players)for(const b of latest.data.players)if(a.id!==b.id)assert.ok(Math.hypot(a.boat.x-b.boat.x,a.boat.y-b.boat.y)>10/M);
const full=await join(sessions[MAX_PLAYERS]);
assert.equal(full.status,409,'Room capacity is enforced');
assert.equal(full.data.code,'room_full','HTTP fallback preserves the distinct full-room reason');
assert.match(full.data.error,new RegExp(`${MAX_PLAYERS}/${MAX_PLAYERS}`));
assert.equal((await post({...sessions[0],token:sessions[1].token,action:'sync',seq:1})).status,403);
assert.equal((await post({...sessions[0],action:'join'},'https://elsewhere.test')).status,403);
const before=latest.data.self.spawn;
assert.deepEqual((await join(sessions[0])).data.self.spawn,before,'Retrying join keeps its reservation');
await post({...sessions[1],action:'leave'});
assert.equal((await join(sessions[1])).status,410,'A delayed join cannot resurrect a session after leaving');
assert.equal((await join(sessions[MAX_PLAYERS])).status,200);
const reset=await post({...sessions[0],action:'reset',seq:3,length:1,beam:99999,ropeLength:99999});
assert.equal(reset.status,200);
const fixedBoat=reset.data.players.find(p=>p.id===sessions[0].id);
// Already-open browsers still know the old map default. The server-assigned
// spawn must override it without requiring a new frontend or physics version.
const oldMapClient=createSimulator({map:{...lake,spawn:{x:-2900/M,y:810/M,angle:lake.spawn.angle}}});
oldMapClient.reset(reset.data.self.spawn);
assert.equal(oldMapClient.getState().boat.x,fixedBoat.boat.x);
assert.equal(oldMapClient.getState().boat.y,fixedBoat.boat.y);
assert.equal(fixedBoat.length,SHARED_LAKE_RULES.length,'Shared hull length ignores solo/client tuning');
assert.equal(fixedBoat.beam,SHARED_LAKE_RULES.beam,'Shared beam stays at the default');
const resetAgain=await post({...sessions[0],action:'reset',seq:3});assert.deepEqual(resetAgain.data.self.spawn,reset.data.self.spawn,'Reset retry is idempotent');

const room={players:{},contacts:{}};const now=100000;
room.players.legacy={updatedAt:now};
applyRoomAction(room,{...sessions[0],action:'join',length:99999,beam:1,ropeLength:1},'hash-a',now);
assert.equal(room.players.legacy,undefined,'Old physics sessions do not remain on the shared lake');
assert.equal(room.players[sessions[0].id].ropeLength,SHARED_LAKE_RULES.ropeLength,'Shared tow corridor always uses the default rope');
applyRoomAction(room,{...sessions[1],action:'join'},'hash-b',now);
const a=room.players[sessions[0].id],b=room.players[sessions[1].id];
for(const [p,x,v] of [[a,-2805,5],[b,-2795,-5]]){
  p.boat={x:x/M,y:740/M,vx:v/M,vy:0,z:0,angle:0,pitch:0,roll:0};
  p.tube={...p.boat,x:(x-20)/M};p.graceUntil=0;p.poseAt=now;
}
const nearMiss=applyRoomAction(room,{...sessions[0],action:'sync',seq:1,ack:0,boat:{...a.boat,x:-2802/M},tube:a.tube},'hash-a',now+200);
assert.equal(nearMiss.self.correction,null,'The old enclosing-circle boundary no longer bumps clear hulls');
assert.equal(b.correction,null);
const impact=applyRoomAction(room,{...sessions[0],action:'sync',seq:2,ack:0,boat:{...a.boat,x:-2801.2/M},tube:a.tube},'hash-a',now+300);
assert.ok(impact.self.correction,'The approaching boat receives a bump');
assert.ok(b.correction,'The other boat receives the same impact');
assert.equal(a.correction.boatBump,true,'The driver receives the boat-glide trigger');
assert.equal(b.correction.boatBump,true,'The struck driver receives the same glide trigger');
assert.ok(a.correction.dvx<0&&b.correction.dvx>0);
assert.ok(Math.abs(a.correction.dvx+b.correction.dvx)<1e-7,'Equal/opposite impulse');
const correctedX=a.boat.x,serial=a.correction.seq;
applyRoomAction(room,{...sessions[0],action:'sync',seq:3,ack:0,boat:{...a.boat,x:0},tube:a.tube},'hash-a',now+400);
assert.equal(a.boat.x,correctedX,'Unacknowledged old packets cannot overwrite collision correction');
assert.equal(a.correction.seq,serial);
applyRoomAction(room,{...sessions[0],action:'sync',seq:4,ack:serial,boat:a.boat,tube:a.tube},'hash-a',now+500);
assert.equal(a.correction,null);
applyRoomAction(room,{...sessions[1],action:'sync',seq:1,ack:b.correction.seq,boat:b.boat,tube:b.tube},'hash-b',now+510);
assert.equal(b.correction,null,'Both owners acknowledge the original bump');
const secondImpact=applyRoomAction(room,{...sessions[0],action:'sync',seq:5,ack:serial,
  boat:{...a.boat,x:a.boat.x+.05/M,vx:6/M},tube:a.tube},'hash-a',now+550);
assert.ok(secondImpact.self.correction&&b.correction,
  'Renewed contact responds immediately after acknowledgment, within the old 400 ms blind window');
assert.ok(secondImpact.self.correction.seq>serial,'A new bump has its own correction sequence');
const secondCorrection={...a.correction},secondPosition=a.boat.x;
applyRoomAction(room,{...sessions[0],action:'sync',seq:6,ack:serial,
  boat:{...a.boat,x:a.boat.x+1/M,vx:6/M},tube:a.tube},'hash-a',now+600);
assert.deepEqual(a.correction,secondCorrection,'The new impulse is not multiplied before acknowledgment');
assert.equal(a.boat.x,secondPosition,'A stale pose cannot undo the new bumper response');
applyRoomAction(room,{...sessions[2],action:'join'},'hash-c',now+STALE_MS+1000);
assert.equal(Object.keys(room.players).length,1,'Stale players stop occupying the lake');

const sim=createSimulator({map:lake});sim.applyNetworkCorrection({dx:2/M,dy:1/M,dvx:3/M,dvy:0});
assert.ok(hasWaterClearance(lake,sim.getState().boat.x,sim.getState().boat.y,3.5/M));
assert.ok(sim.getState().ropeChain.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.px)));

// A slow join response arriving after switching to solo cannot add a remote boat.
let resolveJoin,spawns=0,calls=0;
const client=createLakeClient({read:()=>({...sim.getState(),name:'Tester'}),onSpawn:()=>spawns++,onCorrection:()=>{},fetcher:async(url,options)=>{
  calls++;const input=JSON.parse(options.body);
  if(input.action==='leave')return new Response('{}');
  return new Promise(resolve=>{resolveJoin=()=>resolve(new Response(JSON.stringify({self:{id:input.id,spawn:lake.spawn},players:[],capacity:12})));});
}});
client.setMap('open');assert.equal(calls,0,'Open Water makes no multiplayer request');
client.setMap('oswego');client.setMap('open');resolveJoin();await new Promise(r=>setTimeout(r,10));
assert.equal(spawns,0);assert.equal(client.getPeers().length,0);assert.equal(client.ready,false);client.leave();

// Recreated server sessions restart their bump counter; never retain an old ack.
let requestNo=0,bumps=0,rejoinAck=-1;
const reconnectClient=createLakeClient({read:()=>({...sim.getState(),name:'Tester'}),onSpawn:()=>{},onCorrection:()=>bumps++,fetcher:async(url,options)=>{
  const input=JSON.parse(options.body);if(input.action==='leave')return new Response('{}');
  requestNo++;
  if(requestNo===3)return new Response(JSON.stringify({error:'Expired'}),{status:410});
  if(requestNo===4)rejoinAck=input.ack;
  return new Response(JSON.stringify({self:{id:input.id,spawn:lake.spawn,correction:[2,5].includes(requestNo)?{seq:1,dx:1,dy:0,dvx:0,dvy:0}:null},players:[],capacity:12}));
}});
reconnectClient.setMap('oswego');
const deadline=Date.now()+5000;while(bumps<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
reconnectClient.leave();assert.equal(bumps,2);assert.equal(rejoinAck,0);

let finishReset,resetRequests=0;
const resetClient=createLakeClient({read:()=>({...sim.getState(),name:'Tester'}),onSpawn:()=>{},onCorrection:()=>{},fetcher:async(url,options)=>{
  const input=JSON.parse(options.body);if(input.action==='leave')return new Response('{}');
  const response=()=>new Response(JSON.stringify({self:{id:input.id,spawn:lake.spawn,correction:null},players:[],capacity:12}));
  if(input.action==='reset'&&++resetRequests===1)return new Promise(resolve=>{finishReset=()=>resolve(response());});
  return response();
}});
resetClient.setMap('oswego');await new Promise(r=>setTimeout(r,20));resetClient.reset();
while(!finishReset)await new Promise(r=>setTimeout(r,20));
resetClient.reset();finishReset();await new Promise(r=>setTimeout(r,20));assert.equal(resetClient.ready,false,'Older response cannot release a newer reset');
await new Promise(r=>setTimeout(r,250));resetClient.leave();assert.ok(resetRequests>=2);
DB.raw.close();
console.log(`Multiplayer checks passed: ${MAX_PLAYERS} concurrent joins, distinct colors, full-room reason, safe/reset reservations, auth, collision acknowledgments, expiry, and solo isolation.`);
