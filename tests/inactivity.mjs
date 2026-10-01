import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { RoomService } from '../realtime/room-service.js';
import { SHARED_LAKE_RULES as rules } from '../simulation/defaults.js';
import { IDLE_MS, IDLE_CLOSE_CODE } from '../multiplayer/inactivity.js';
import { createActivityTracker } from '../input/activity.js';
import { createInputController } from '../input/controls.js';
import { createLakeClient } from '../multiplayer/client.js';
import { handleLake } from '../server/lake.js';
import { createLocalD1 } from '../tools/local-d1.mjs';

const base=100000,session={id:'idle-player-00001',token:'idle-secret-0000000000000000000001',physicsVersion:rules.version};
const room=new RoomService('idle-test');
room.action({...session,action:'join',botCount:1,activitySeq:1},'owner',base);
for(let sec=1;sec<180;sec++){
  const p=room.room.players[session.id];
  room.action({...session,action:'sync',seq:sec,activitySeq:1,boat:p.boat,tube:p.tube,paused:true,botCount:1},'owner',base+sec*1000);
}
assert.ok(room.room.players[session.id],'Heartbeats keep the connection alive until the idle deadline');
const p=room.room.players[session.id];
const expired=room.action({...session,action:'sync',seq:180,activitySeq:1,boat:p.boat,tube:p.tube},'owner',base+IDLE_MS);
assert.equal(expired.code,'idle');
assert.equal(Object.keys(room.room.players).length,0,'Idle expiry commits removal of the owner and bots');
assert.equal(room.action({...session,action:'join',activitySeq:1},'owner',base+IDLE_MS+1).code,'idle','Old sessions cannot auto-rejoin');
assert.throws(()=>room.view(session.id,'owner',0,base+IDLE_MS),e=>e.code==='idle');

const active=new RoomService();
active.action({...session,action:'join',activitySeq:4},'owner',base);
for(let sec=1;sec<=200;sec++){
  const p=active.room.players[session.id];
  active.action({...session,action:'sync',seq:sec,activitySeq:sec>=170?5:4,boat:p.boat,tube:p.tube,paused:true},'owner',base+sec*1000);
}
assert.equal(active.room.players[session.id].lastActivityAt,base+170000,'Only a newer activity revision refreshes the server deadline');
active.room.players[session.id].updatedAt=base+350000;
active.tick(base+350000);
assert.equal(active.room.players[session.id],undefined,'The server clock also expires idle sessions between packets');

// Real input vs latched controls / recentering / passive pointer motion.
let inputTime=0;
const target=new EventTarget(),input=createInputController({target});
const tracker=createActivityTracker({target,clock:()=>inputTime});
const event=(type,values={})=>{const e=new Event(type);for(const [k,v] of Object.entries(values))Object.defineProperty(e,k,{value:v});target.dispatchEvent(e);};
input.setTouchThrottle(1);input.setTouchSteer(.4);
assert.equal(input.hasHeldInput(),false);
inputTime=1000;input.setTouchSteer(.3);event('pointermove',{buttons:0});
assert.equal(tracker.sample(input.hasHeldInput()),0,'Cruise, latched controls and hover do not reset inactivity');
event('keydown',{code:'KeyW'});const keySeq=tracker.sample(input.hasHeldInput());
inputTime+=1000;assert.ok(tracker.sample(input.hasHeldInput())>keySeq,'A held driving key counts as active');
event('blur');assert.equal(input.hasHeldInput(),false);
event('pointerdown',{pointerId:1});inputTime+=1000;
const held=tracker.sample();inputTime+=1000;assert.ok(tracker.sample()>held,'A held touch counts as active');
tracker.sample(false,true);const hidden=tracker.sample(false,true);inputTime+=1000;
assert.equal(tracker.sample(false,true),hidden,'Suspending releases held touch activity');

// Fake-clock sockets exercise the actual facade and terminal transport paths.
let time=0, next=0, frame=0, seq=0;
const tasks=new Map(),sockets=[];
const schedule=(fn,ms)=>{tasks.set(++next,{fn,at:time+ms});return next;};
const cancel=id=>tasks.delete(id);
function advance(ms){const end=time+ms;for(;;){const task=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!task||task[1].at>end)break;tasks.delete(task[0]);time=task[1].at;task[1].fn();}time=end;}
class Socket{
  readyState=0;listeners={};sent=[];
  addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);}
  emit(k,event={}){for(const fn of this.listeners[k]||[])fn(event);}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
  send(text){const q=JSON.parse(text);this.sent.push(q);if(q.action==='leave')return;
    this.emit('message',{data:JSON.stringify({type:q.action==='sync'?'snapshot':'reply',action:q.action,requestSeq:q.seq,
      frame:++frame,epoch:'test',resumed:false,serverTime:time,self:{id:q.id,name:'Test',spawn:body},players:[],wakeEvents:[],wakeCursor:0})});}
}
const body={x:0,y:0,vx:10,vy:0,angle:0};
const client=createLakeClient({clock:()=>time,schedule,cancel,realtimeUrl:'wss://test/lake',
  socketFactory:()=>{const s=new Socket();sockets.push(s);schedule(()=>{s.readyState=1;s.emit('open');},0);return s;},
  read:()=>({boat:body,tube:body,activitySeq:seq}),onSpawn:()=>{},onCorrection:()=>{}});
client.setMap('open');advance(IDLE_MS);assert.equal(sockets.length,0,'Solo starts no connection or idle task');
client.setMap('oswego');advance(IDLE_MS-1);assert.equal(client.ready,true);
advance(1);assert.match(client.status,/Inactive for 3 minutes/);assert.equal(client.ready,false);
const count=sockets.length;advance(IDLE_MS);assert.equal(sockets.length,count,'Idle clients never retry automatically');
client.reset();advance(1);assert.equal(sockets.length,count+1);assert.equal(client.ready,true,'Reset deliberately rejoins');
advance(170000);seq++;advance(1000);advance(20000);assert.equal(client.ready,true,'New control activity extends the deadline');
const current=sockets.at(-1);current.emit('message',{data:JSON.stringify({type:'error',status:408,code:'idle'})});
assert.match(client.status,/Inactive/);const stopped=sockets.length;advance(10000);assert.equal(sockets.length,stopped);
client.reset();advance(1);sockets.at(-1).emit('close',{code:IDLE_CLOSE_CODE});assert.match(client.status,/Inactive/,'Terminal close code is a backup to the error message');
client.reset();advance(1);client.leave();time+=IDLE_MS;seq++;client.resume();assert.match(client.status,/Inactive/,'Waking a suspended page does not bypass its expired deadline');
client.setMap('open');assert.equal(tasks.size,0);

// Mobile browsers can deliver queued network/input events before overdue timers.
const delayed=[];
const sleeping=createLakeClient({clock:()=>time,schedule,cancel,realtimeUrl:'wss://test/lake',
  socketFactory:()=>{const s=new Socket();delayed.push(s);return s;},
  read:()=>({boat:body,tube:body,activitySeq:seq}),onSpawn:()=>{},onCorrection:()=>{}});
sleeping.setMap('oswego');time+=IDLE_MS+1000;seq++;
delayed[0].readyState=1;delayed[0].emit('open');
assert.match(sleeping.status,/Inactive/,'A delayed handshake checks expiry before reading fresh input');
assert.equal(delayed[0].sent.some(q=>q.action==='join'),false,'An expired handshake cannot rejoin');
assert.equal(tasks.size,0);
sleeping.reset();delayed.at(-1).readyState=1;delayed.at(-1).emit('open');
assert.equal(sleeping.ready,true);
time+=IDLE_MS+1000;seq++;
const beforeReset=delayed.length;sleeping.reset();
assert.equal(delayed.length,beforeReset+1,'A deliberate Reset after sleep rejoins in one tap');
delayed.at(-1).readyState=1;delayed.at(-1).emit('open');assert.equal(sleeping.ready,true);
sleeping.setMap('open');assert.equal(tasks.size,0);

// The HTTP fallback must commit deletion even when the expiring owner is the
// only caller, then stop polling instead of treating idle as a network failure.
const DB=createLocalD1();
for(const f of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort())DB.raw.exec(await readFile(`drizzle/${f}`,'utf8'));
const realNow=Date.now;let wall=base;
Date.now=()=>wall;
const post=input=>handleLake(new Request('https://test/api/lake',{method:'POST',body:JSON.stringify(input)}),DB);
try{
  await post({...session,action:'join',activitySeq:0});wall+=IDLE_MS;
  const response=await post({...session,action:'join',activitySeq:0});
  assert.equal(response.status,408);assert.equal((await response.json()).code,'idle');
  const saved=await DB.prepare('SELECT state_json FROM lake_rooms WHERE id = ?').bind('oswego').first();
  assert.equal(Object.keys(JSON.parse(saved.state_json).players).length,0);
}finally{Date.now=realNow;DB.raw.close();}
let calls=0;
const http=createLakeClient({socketFactory:null,read:()=>({boat:body,tube:body}),onSpawn:()=>{},onCorrection:()=>{},
  fetcher:async()=>{calls++;return Response.json({code:'idle',error:'Inactive',status:408},{status:408});}});
http.setMap('oswego');await new Promise(resolve=>setTimeout(resolve,20));
assert.match(http.status,/Inactive/);const idleCalls=calls;await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(calls,idleCalls,'HTTP idle stops retry timers');http.leave();
console.log('Inactivity passed: 3-minute boundary, activity vs heartbeat, owned bots, atomic expiry, held inputs, WS/HTTP terminal state, explicit rejoin and suspended tabs.');
