import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { applyRoomAction, MAX_PLAYERS } from '../multiplayer/room.js';
import { MAX_WAKE_EVENTS, pruneWakeHistory, recordRoomWakes } from '../multiplayer/wake-history.js';
import { createSharedWakeField } from '../simulation/shared-wakes.js';
import { createSimulator } from '../simulation/simulator.js';
import { SHARED_LAKE_RULES, RIDER_PROFILES } from '../simulation/defaults.js';
import { sampleWater, updateWakes } from '../physics/wake.js';
import { applyBoatProfile, DEFAULT_BOAT_ID } from '../physics/boats.js';

applyBoatProfile(DEFAULT_BOAT_ID);
const room={},session=id=>({id,physicsVersion:SHARED_LAKE_RULES.version});
const a=session('wake-player-a'),b=session('wake-player-b'),start=100000;
const action=(s,input,at)=>applyRoomAction(room,{...s,...input},s.id,at);
action(a,{action:'join'},start);action(b,{action:'join'},start);
const p=room.players[a.id],origin={...p.boat};
const vx=Math.cos(origin.angle)*220,vy=Math.sin(origin.angle)*220;
const snapshots=[];
let now=start;
for(let i=1;i<=40;i++){
 now=start+i*200;
 const boat={...origin,x:origin.x+vx*(i-1)*.2,y:origin.y+vy*(i-1)*.2,vx,vy};
 const tube={...boat,x:boat.x-Math.cos(boat.angle)*300,y:boat.y-Math.sin(boat.angle)*300};
 snapshots.push(action(a,{action:'sync',seq:i,ack:999,boat,tube,paused:false,wakeSince:0},now));
}
const last=snapshots.at(-1);
assert.ok(last.wakeEvents.length>60,'Accepted movement produces persistent shared wake history');
assert.equal(action(b,{action:'join'},now).wakeEvents.length,last.wakeEvents.length,'A later viewer receives existing waves');
const waterA=[],waterB=[],fieldA=createSharedWakeField(waterA),fieldB=createSharedWakeField(waterB);
fieldA.receive(last.wakeEvents,now);fieldB.receive(last.wakeEvents,now);
assert.deepEqual(waterA,waterB,'Both clients reconstruct identical wave packets');
const before=waterA.length;fieldA.receive(last.wakeEvents,now);fieldA.receive(snapshots[10].wakeEvents,now);
assert.equal(waterA.length,before,'Retries and older responses do not duplicate wave force');
for(const q of waterA.slice(-12))assert.deepEqual(sampleWater(waterA,q.x,q.y),sampleWater(waterB,q.x,q.y));
assert.equal(action(b,{action:'sync',seq:1,boat:room.players[b.id].boat,tube:room.players[b.id].tube,paused:true,wakeSince:last.wakeCursor},now).wakeEvents.length,0,'Incremental polls avoid resending acknowledged history');

// Use a wave created by A as the actual water under B's ordinary tow system.
const crest=waterA.reduce((best,q)=>sampleWater(waterA,q.x,q.y).height>sampleWater(waterA,best.x,best.y).height?q:best);
const riderSim=createSimulator({sharedWakes:true}),calmSim=createSimulator({sharedWakes:true});
const initial=riderSim.getState().tube;
const spawn={x:crest.x-initial.x,y:crest.y-initial.y,angle:-Math.PI/2};
riderSim.reset(spawn);calmSim.reset(spawn);
riderSim.receiveSharedWakes(last.wakeEvents,now);
let maxLift=0,maxAir=0;
const options={dt:1/120,throttle:{forward:.6,reverse:0},steer:0,maxSpeedMph:45,cruiseEnabled:false,cruiseSpeedMph:20,rider:RIDER_PROFILES.balanced};
for(let i=0;i<360;i++){
 const riding=riderSim.step(options),calm=calmSim.step(options);
 maxLift=Math.max(maxLift,riding.state.tube.z-calm.state.tube.z);
 maxAir=Math.max(maxAir,riding.metrics.airFt);
}
assert.ok(maxLift>1,'Another player’s wake physically lifts the tube');
assert.ok(riderSim.getState().wakes.filter(q=>!q.predictionSeq).length<=before,'Stepping never duplicates confirmed waves');
riderSim.setSharedWakeMode(false);assert.equal(riderSim.getState().wakes.length,0,'Solo starts without shared waves');
for(let i=0;i<360;i++)riderSim.step({...options,throttle:{forward:.5,reverse:0}});
assert.ok(riderSim.getState().wakes.length>0,'Solo keeps its normal local wake generation');

const count=room.wakeEvents.length;
action(a,{action:'reset',seq:41},now+100);
assert.equal(room.wakeEvents.length,count,'Reset leaves existing waves and emits no teleport trail');
action(a,{action:'sync',seq:42,boat:room.players[a.id].boat,tube:room.players[a.id].tube,paused:true},now+300);
assert.equal(room.wakeEvents.length,count,'Paused boats emit no waves');
action(a,{action:'leave'},now+400);
assert.equal(room.wakeEvents.length,count,'Departing boats leave naturally fading waves');
fieldB.receive([],now+40000);assert.equal(waterB.length,0,'Server time ages the water while a client is paused');
pruneWakeHistory(room,now+40000);assert.equal(room.wakeEvents.length,0);
const gapRoom={wakeSeq:0,wakeEvents:[]};
recordRoomWakes(gapRoom,{...origin,vx,vy},{...origin,x:origin.x+10000,vx,vy},0,2000,false);
assert.equal(gapRoom.wakeEvents.length,0,'Reconnections never backfill long missing paths');

const crowded={wakeSeq:0,wakeEvents:[]};
for(let tick=0;tick<370;tick++)for(let player=0;player<MAX_PLAYERS;player++){
 const from={x:tick*22,y:player*300,angle:0,vx:220,vy:0};
 recordRoomWakes(crowded,from,{...from,x:from.x+22},tick*100,(tick+1)*100,false);
}
assert.equal(crowded.wakeEvents.length,MAX_WAKE_EVENTS);
const all=[],field=createSharedWakeField(all);field.receive(crowded.wakeEvents,37000);
const begun=performance.now();
for(let i=0;i<120;i++){updateWakes(all,1/120);for(let sample=0;sample<12;sample++)sampleWater(all,7600+sample,1500);}
console.log(`Shared waves passed: matching clients, rideable remote wake (${maxLift.toFixed(1)} units lift, ${maxAir.toFixed(1)} ft air), deduplication, late joins, reset/pause/leave, solo isolation; ${all.length} packets / 1 simulated second in ${(performance.now()-begun).toFixed(0)} ms.`);
