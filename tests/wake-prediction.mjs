import assert from 'node:assert/strict';
import { applyRoomAction } from '../multiplayer/room.js';
import { createSharedWakeField } from '../simulation/shared-wakes.js';
import { createSimulator } from '../simulation/simulator.js';
import { MAX_WAKE_SAMPLES } from '../simulation/wake-protocol.js';
import { SHARED_LAKE_RULES, RIDER_PROFILES } from '../simulation/defaults.js';
import { applyBoatProfile, DEFAULT_BOAT_ID } from '../physics/boats.js';
import { sampleWater } from '../physics/wake.js';
import { METERS_PER_UNIT as M } from '../maps/catalog.js';
import { createLakeClient } from '../multiplayer/client.js';

applyBoatProfile(DEFAULT_BOAT_ID);
let clock=0;
const options={dt:1/120,throttle:{forward:.65,reverse:0},steer:0,maxSpeedMph:45,cruiseEnabled:false,cruiseSpeedMph:20,rider:RIDER_PROFILES.balanced};
const sim=createSimulator({sharedWakes:true,wakeClock:()=>clock});
for(let i=0;i<360;i++){clock+=1000/120;sim.step(options);}
assert.ok(sim.getState().wakes.length>0,'Own wake appears before any HTTP response');
assert.ok(sim.getState().wakes.some(q=>sampleWater(sim.getState().wakes,q.x,q.y).energy>0),'Immediate wake is physical');
const lastId=sim.getState().wakes.at(-1).predictionSeq;
sim.reset();assert.deepEqual(sim.getWakeSamples(),[],'Reset clears the unsent trail');
sim.receiveSharedWakes([],100000+clock);
for(let i=0;i<360;i++){clock+=1000/120;sim.step(options);}
assert.ok(sim.getWakeSamples()[0][0]>lastId,'Reset never reuses local wake IDs');
assert.ok(sim.getWakeSamples().length<=MAX_WAKE_SAMPLES);

const room={},base=100000,session={id:'prediction-player',physicsVersion:SHARED_LAKE_RULES.version};
const act=(input,at)=>applyRoomAction(room,{...session,...input},'hash',base+at);
const joined=act({action:'join'},0),source=joined.self.wakeSource,p=room.players[session.id];
const origin={...p.boat},tubeOrigin={...p.tube};
clock=0;
const water=[],field=createSharedWakeField(water,{clock:()=>clock});
field.receive([],base,{source,ack:0});
const speed=130,vx=Math.cos(origin.angle)*speed,vy=Math.sin(origin.angle)*speed;
const boatAt=at=>({...origin,x:origin.x+vx*at/1000,y:origin.y+vy*at/1000,vx,vy,speed});
const tubeAt=at=>({...tubeOrigin,x:tubeOrigin.x+vx*at/1000,y:tubeOrigin.y+vy*at/1000,vx,vy});
for(let i=1;i<=15;i++){clock=i*100;field.advance(.1);field.predict(boatAt(clock),i);}
const captured=field.samples();
const accepted=act({action:'sync',seq:1,boat:boatAt(1500),tube:tubeAt(1500),wakeSamples:captured,paused:false},2000);
assert.equal(accepted.wakeEvents.length,15,'A 1.5-second update keeps every captured wake');
assert.equal(accepted.self.wakeAck,15);
assert.ok(accepted.wakeEvents.every(e=>e[6]===source),'Server assigns the authenticated emitter');
// Response is delayed while the boat continues to generate immediate waves.
for(let i=16;i<=26;i++){clock=i*100;field.advance(.1);field.predict(boatAt(clock),i);}
const points=water.map(q=>({x:q.x,y:q.y})),before=points.map(q=>sampleWater(water,q.x,q.y));
const count=water.length;
field.receive(accepted.wakeEvents,accepted.serverTime,{source,ack:15});
assert.equal(water.length,count,'Delayed confirmation replaces instead of doubling packets');
for(let i=0;i<points.length;i++){
  const after=sampleWater(water,points[i].x,points[i].y);
  for(const key of ['height','sx','sy','energy'])assert.ok(Math.abs(before[i][key]-after[key])<1e-7,`Confirmation preserves ${key}`);
}
assert.equal(field.samples().length,11,'Waves emitted after the request survive its acknowledgment');
assert.ok(water.filter(q=>q.predictionSeq).every(q=>q.predictionSeq>15));
field.receive(accepted.wakeEvents,accepted.serverTime,{source,ack:15});assert.equal(water.length,count,'Retry is idempotent');
const retry=act({action:'sync',seq:2,boat:boatAt(1500),tube:tubeAt(1500),wakeSamples:captured},2100);
assert.equal(retry.wakeEvents.length,15,'Resending sample IDs never creates extra server wakes');
const remote=[];const remoteField=createSharedWakeField(remote);
remoteField.receive(accepted.wakeEvents,base+2600);
assert.equal(remote.length,30,'Other players receive the same confirmed wake');
for(const q of remote)assert.ok(Number.isFinite(sampleWater(remote,q.x,q.y).height));

// Preserve the real samples of a turn, and flush them even if the player
// opens the map after moving. No straight interpolated bridge is manufactured.
const last=boatAt(1500),trail=[];
for(let i=1;i<=28;i++)trail.push([26+i,base+4400-(28-i)*100,last.x+i*9,last.y+Math.sin(i/5)*35,.1,130]);
const final=trail.at(-1),next={...last,x:final[2],y:final[3],angle:final[4]};
const curved=act({action:'sync',seq:3,boat:next,tube:{...tubeAt(1500),x:next.x-22/M,y:next.y},wakeSamples:trail,paused:true},4400);
assert.equal(curved.wakeEvents.length,43,'A 2.8-second paused update keeps all preceding wake samples');
assert.deepEqual(curved.wakeEvents.slice(-28).map(e=>e[2]),trail.map(s=>Math.round(s[2]*10)/10));
const countBeforeReset=room.wakeEvents.length;
act({action:'reset',seq:4},4500);
const resetP=room.players[session.id];
act({action:'sync',seq:5,boat:resetP.boat,tube:resetP.tube,wakeSamples:[[55,base+3600,next.x,next.y,0,130],[56,base+4600,1e9,1e9,0,130],[57,base+4600,resetP.boat.x,resetP.boat.y,0,1e9]]},4600);
assert.equal(room.wakeEvents.length,countBeforeReset,'Old-reset, teleport and excessive-speed samples are rejected');
assert.equal(resetP.wakeAck,57,'Rejected predictions are acknowledged and retired');
const invalid=[];const rejectField=createSharedWakeField(invalid,{clock:()=>clock});
rejectField.predict(boatAt(0),57);rejectField.receive([],base+clock,{source,ack:57});assert.equal(invalid.length,0);
const payload={...session,token:'t'.repeat(72),action:'sync',seq:999,ack:3,wakeSince:123456789,name:'n'.repeat(20),boat:sim.getState().boat,tube:sim.getState().tube,wakeSamples:trail};
// Wire poses carry only the same compact fields as multiplayer/client.js.
for(const key of ['boat','tube'])payload[key]=Object.fromEntries(['x','y','vx','vy','angle','z','pitch','roll','riderOn'].map(k=>[k,payload[key][k]]));
assert.ok(JSON.stringify(payload).length<6000,'A full trail fits the existing request bound');

// Real asynchronous requests: a 300 ms response must not add another 200 ms
// idle gap. Keep a single request in flight and forward the exact wake receipt.
const starts=[];let inFlight=0,maxInFlight=0,receipts=0,client;
await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{client?.leave();reject(new Error('Delayed polling did not complete'));},4000);
  client=createLakeClient({read:()=>({...sim.getState(),wakeSamples:sim.getWakeSamples()}),onSpawn:()=>{},onCorrection:()=>{},onWakes:(events,time,receipt)=>{assert.equal(receipt.source,99);receipts++;},fetcher:async(url,options)=>{
    const input=JSON.parse(options.body);if(input.action==='leave')return new Response('{}');
    starts.push(performance.now());inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
    assert.ok(Array.isArray(input.wakeSamples));
    await new Promise(r=>setTimeout(r,300));inFlight--;
    if(starts.length===3){setTimeout(()=>{client.leave();clearTimeout(timeout);resolve();},10);}
    return new Response(JSON.stringify({serverTime:base,self:{id:input.id,spawn:origin,wakeSource:99,wakeAck:0},players:[],capacity:12,wakeEvents:[]}));
  }});client.setMap('oswego');
});
assert.equal(maxInFlight,1);assert.equal(receipts,3);
assert.ok(starts[1]-starts[0]<450,'Slow responses do not incur another 200 ms wait');
console.log('Wake prediction passed: immediate physical waves, delayed echo without doubled forces, newer predictions, retries, slow curved trails, pause/reset validation, bounded payloads and responsive polling.');
