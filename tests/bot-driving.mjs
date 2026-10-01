import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { applyRoomAction, tickRoom, MAX_PLAYERS } from '../multiplayer/room.js';
import { MAX_BOTS, BOT_ROUTE, BOT_STEP_MS } from '../multiplayer/bots.js';
import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { hasWaterClearance } from '../physics/shore.js';
import { SHARED_LAKE_RULES } from '../simulation/defaults.js';

const room = {}, owner = { id: 'ride-owner', physicsVersion: SHARED_LAKE_RULES.version };
const start = 100000;
applyRoomAction(room, { ...owner, action: 'join', botCount: MAX_BOTS }, 'owner', start);
const fleet = Object.values(room.players).filter(p => p.isBot);
assert.equal(fleet.length, 15, 'One human can immediately launch all fifteen bots');
assert.equal(Object.keys(room.players).length, MAX_PLAYERS);
assert.equal(new Set(Object.values(room.players).map(p => p.color)).size, MAX_PLAYERS);
for (const p of fleet) {
  assert.ok(Math.hypot(p.boat.x-lake.spawn.x,p.boat.y-lake.spawn.y)*M > 70, 'Bot launch keeps clear of central human launch');
  for (let t=0;t<=1;t+=.1) assert.ok(hasWaterClearance(lake,p.boat.x+(p.tube.x-p.boat.x)*t,p.boat.y+(p.tube.y-p.boat.y)*t,40/M), 'Full initial tow has generous shoreline clearance');
}
const stats = new Map(fleet.map(p => [p.id, { visited: new Set(), left: 0, right: 0, swing: 0, distance: 0, last: { ...p.boat } }]));
let minSpeed = Infinity, maxSpeed = 0;
const begun = performance.now();
for (let tick=1;tick<=6000;tick++) {
  const now=start+tick*BOT_STEP_MS;
  if(tick%10===0){
    const p=room.players[owner.id];
    applyRoomAction(room,{...owner,action:'sync',seq:tick,activitySeq:tick,botCount:MAX_BOTS,ack:p.correction?.seq||0,boat:p.boat,tube:p.tube,paused:true},'owner',now);
  }else tickRoom(room,now);
  assert.equal(Object.values(room.players).filter(p=>p.isBot).length,MAX_BOTS);
  for(const p of Object.values(room.players).filter(p=>p.isBot)){
    const s=stats.get(p.id),b=p.boat,t=p.tube;
    s.visited.add(p.waypoint);s.left=Math.max(s.left,p.botTurnRate);s.right=Math.min(s.right,p.botTurnRate);
    s.swing=Math.max(s.swing,Math.abs((b.x-t.x)*Math.sin(b.angle)-(b.y-t.y)*Math.cos(b.angle))*M);
    s.distance+=Math.hypot(b.x-s.last.x,b.y-s.last.y)*M;s.last={...b};
    const speed=Math.hypot(b.vx,b.vy)*M;
    if(tick>100){minSpeed=Math.min(minSpeed,speed);maxSpeed=Math.max(maxSpeed,speed);}
    assert.ok([b.x,b.y,b.vx,b.vy,b.angle,t.x,t.y,t.vx,t.vy].every(Number.isFinite));
    assert.ok(Math.hypot(t.x-b.x,t.y-b.y)<40/M,'Tube remains tethered');
    assert.ok(Math.abs(p.botTurnRate)<=.42+1e-8,'Driver respects the steering rate limit');
    if(tick%10===0){
      assert.ok(hasWaterClearance(lake,b.x,b.y,Math.hypot(p.length,p.beam)/2),'Bot hull stays in water');
      assert.ok(hasWaterClearance(lake,t.x,t.y,1/M),'Bot tube stays in water');
    }
  }
}
for(const s of stats.values()){
  assert.equal(s.visited.size,BOT_ROUTE.length,'Every individual bot completes the whole route');
  assert.ok(s.distance>2000,'No bot gets stuck in traffic');
  assert.ok(s.left>.08&&s.right<-.08,'Each driver makes both left and right turns');
  assert.ok(s.swing>3,'Alternating turns create a visible lateral tube swing');
}
assert.ok(maxSpeed<12,'Higher-numbered bots do not gain excessive cruising speed');
console.log(`Bot driving passed: 15 bots, safe spread launches, ten minutes of individual route progress, alternating turns and tube swing; ${(performance.now()-begun).toFixed(0)} ms CPU, speeds ${minSpeed.toFixed(1)}–${maxSpeed.toFixed(1)} m/s.`);
