import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { applyRoomAction, tickRoom, MAX_PLAYERS } from '../multiplayer/room.js';
import { MAX_BOTS, BOT_STEP_MS } from '../multiplayer/bots.js';
import { BOT_NODES, BOT_LINKS } from '../multiplayer/bot-routes.js';
import { BOT_STYLES } from '../multiplayer/bot-personality.js';
import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { hasWaterClearance } from '../physics/shore.js';
import { SHARED_LAKE_RULES } from '../simulation/defaults.js';

// A point-safe route is not sufficient: every leg must also miss islands and
// peninsulas. 1 m sampling plus a .5 m margin bounds the unsampled interval.
for(const [from,to] of BOT_LINKS){
  const a=BOT_NODES[from],b=BOT_NODES[to],steps=Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)*M);
  for(let i=0;i<=steps;i++)assert.ok(hasWaterClearance(lake,a.x+(b.x-a.x)*i/steps,a.y+(b.y-a.y)*i/steps,30.5/M),`${a.id}–${b.id} corridor clearance`);
}
const room={},owner={id:'ride-owner',physicsVersion:SHARED_LAKE_RULES.version},start=100000;
const automatic=process.argv.includes('--fill'),botCount=automatic?0:MAX_BOTS;
applyRoomAction(room,{...owner,action:'join',botCount},'owner',start);
if(automatic){const p=room.players[owner.id];applyRoomAction(room,{...owner,action:'sync',seq:0,botCount,boat:p.boat,tube:p.tube,paused:true,fillBotsRequest:{...room.botFill,enabled:true}},'owner',start);}
const fleet=Object.values(room.players).filter(p=>p.isBot);
assert.equal(fleet.length,15);assert.equal(Object.keys(room.players).length,MAX_PLAYERS);
assert.equal(new Set(Object.values(room.players).map(p=>p.color)).size,MAX_PLAYERS);
assert.equal(new Set(fleet.map(p=>p.driver.name)).size,BOT_STYLES.length,'A full fleet includes all five styles');
assert.equal(new Set(fleet.map(p=>p.driver.phase)).size,MAX_BOTS,'Drivers do not share a synchronized weave');
for(const p of fleet){
  assert.ok(Math.hypot(p.boat.x-lake.spawn.x,p.boat.y-lake.spawn.y)*M>70,'Bot launch leaves human starting space');
  for(let t=0;t<=1;t+=.1)assert.ok(hasWaterClearance(lake,p.boat.x+(p.tube.x-p.boat.x)*t,p.boat.y+(p.tube.y-p.boat.y)*t,30/M),'Entire initial tow clears shore');
}
const stats=new Map(fleet.map(p=>[p.id,{regions:new Set(),left:0,right:0,swing:0,distance:0,last:{...p.boat},minX:p.boat.x*M,maxX:p.boat.x*M,stalled:0,maxStalled:0}]));
const regions=new Set(),frameTimes=[];let minSpeed=Infinity,maxSpeed=0,spins=0;
const begun=performance.now();
for(let tick=1;tick<=12000;tick++){
  const now=start+tick*BOT_STEP_MS,t0=performance.now();
  if(tick%10===0){const p=room.players[owner.id];applyRoomAction(room,{...owner,action:'sync',seq:tick,activitySeq:tick,botCount,ack:p.correction?.seq||0,boat:p.boat,tube:p.tube,paused:true},'owner',now);}
  else tickRoom(room,now);
  frameTimes.push(performance.now()-t0);
  assert.equal(Object.values(room.players).filter(p=>p.isBot).length,MAX_BOTS);
  for(const p of Object.values(room.players).filter(p=>p.isBot)){
    const s=stats.get(p.id),b=p.boat,t=p.tube,speed=Math.hypot(b.vx,b.vy)*M;
    s.left=Math.max(s.left,p.botTurnRate);s.right=Math.min(s.right,p.botTurnRate);
    s.swing=Math.max(s.swing,Math.abs((b.x-t.x)*Math.sin(b.angle)-(b.y-t.y)*Math.cos(b.angle))*M);
    s.distance+=Math.hypot(b.x-s.last.x,b.y-s.last.y)*M;s.last={...b};
    s.minX=Math.min(s.minX,b.x*M);s.maxX=Math.max(s.maxX,b.x*M);
    s.stalled=speed<.5?s.stalled+BOT_STEP_MS/1000:0;s.maxStalled=Math.max(s.maxStalled,s.stalled);
    if(tick>100){minSpeed=Math.min(minSpeed,speed);maxSpeed=Math.max(maxSpeed,speed);}
    assert.ok([b.x,b.y,b.vx,b.vy,b.angle,t.x,t.y,t.vx,t.vy].every(Number.isFinite));
    assert.ok(Math.hypot(t.x-b.x,t.y-b.y)<40/M,'Tube remains tethered');
    assert.ok(Math.abs(p.botTurnRate)<=.42+1e-8,'Steering stays bounded, including spins');
    if(tick%10===0){
      assert.ok(hasWaterClearance(lake,b.x,b.y,Math.hypot(p.length,p.beam)/2),'Bot hull stays in water');
      assert.ok(hasWaterClearance(lake,t.x,t.y,1/M),'Tube stays in water');
      for(const node of BOT_NODES)if(Math.hypot(b.x-node.x,b.y-node.y)*M<45){s.regions.add(node.region);regions.add(node.region);}
    }
  }
}
for(const p of fleet){
  const s=stats.get(p.id),bay=p.spawn.x*M>600;
  assert.ok(s.distance>3500,'Every driver keeps making progress');
  assert.ok(s.maxX-s.minX>(bay?300:1000),'Actual positions explore beyond the old launch loop');
  assert.ok(s.regions.size>=(bay?1:3),'Individual drivers reach varied areas of their connected water');
  assert.ok(s.maxStalled<30,`${p.name} has no persistent traffic standstill (${s.maxStalled.toFixed(1)} s)`);
  assert.ok(s.left>.08&&s.right<-.08,'Each driver turns in both directions');
  assert.ok(s.swing>3,'Turns create visible lateral tube swing');
  spins+=p.spinCount||0;
}
assert.equal(regions.size,new Set(BOT_NODES.map(n=>n.region)).size,'The fleet explores every navigable region');
assert.ok(spins>=10,'Drivers complete playful full circles when clear');assert.ok(maxSpeed<12,'Cruise speeds remain bounded');
frameTimes.sort((a,b)=>a-b);
console.log(`Bot driving passed: 15 distinct drivers, seven lake regions, 20 minutes, ${spins} spins, safe tows and no stalls; ${(performance.now()-begun).toFixed(0)} ms CPU, p95 tick ${frameTimes[Math.floor(frameTimes.length*.95)].toFixed(2)} ms, speeds ${minSpeed.toFixed(1)}–${maxSpeed.toFixed(1)} m/s.`);
