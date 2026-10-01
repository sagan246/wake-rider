import assert from 'node:assert/strict';
import { applyRoomAction, STALE_MS, MAX_PLAYERS } from '../multiplayer/room.js';
import { BOT_ROUTE, MAX_BOTS } from '../multiplayer/bots.js';
import { SHARED_LAKE_RULES } from '../simulation/defaults.js';
import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { hasWaterClearance } from '../physics/shore.js';
import { createSharedWakeField } from '../simulation/shared-wakes.js';

let now=100000,seq=0;
const room={};
const bots=()=>Object.values(room.players).filter(p=>p.isBot);
const action=(id,action,extra={},at=now)=>applyRoomAction(room,{id,action,physicsVersion:SHARED_LAKE_RULES.version,...extra},`hash-${id}`,at);
const sync=(id,botCount,at=now)=>{
  const p=room.players[id];
  return action(id,'sync',{seq:++seq,activitySeq:seq,ack:p.correction?.seq||0,boat:{...p.boat},tube:{...p.tube},paused:true,botCount},at);
};
action('human-a','join');assert.equal(bots().length,0,'Bots default off');
sync('human-a',3);assert.equal(bots().length,3);
assert.equal(new Set(Object.values(room.players).map(p=>p.color)).size,4);
for(const bot of bots())assert.ok(Math.hypot(bot.boat.x-room.players['human-a'].boat.x,bot.boat.y-room.players['human-a'].boat.y)*M>50,'Bots launch nearby without occupying the human launch');
const second=action('human-b','join');assert.equal(second.players.filter(p=>p.isBot).length,3,'Another player sees the same bots');
assert.equal(second.self.activeBots,0);
sync('human-b',3);assert.equal(bots().length,MAX_BOTS,'Requests from different players cannot exceed the lake limit');
const botId=bots()[0].id;
assert.throws(()=>action(botId,'leave'),e=>e.status===403,'Clients cannot take over server boats');
const initial={...bots()[0].boat};
now+=1000;
let moving=sync('human-a',3);
assert.ok(Math.hypot(bots()[0].boat.x-initial.x,bots()[0].boat.y-initial.y)>1,'Server advances bots');
const frozen=JSON.stringify(bots().map(p=>p.boat)),cursor=room.wakeSeq;
sync('human-b',3);assert.equal(JSON.stringify(bots().map(p=>p.boat)),frozen,'More visitors do not speed up bots');
assert.equal(room.wakeSeq,cursor,'No duplicate wake emission at the same server time');
assert.ok(moving.wakeEvents.length>0,'Bots produce canonical shared wakes');
const water=[];const field=createSharedWakeField(water);field.receive(moving.wakeEvents,moving.serverTime);
assert.ok(water.length>0,'Bot wakes enter the same physical wave field used by riders');

// Follow three boats for multiple laps: their hulls and tows stay inside the
// actual polygon, continue making progress, and do not outrun their rope.
const visited=new Set();let minClear=true;
for(let tick=1;tick<=6000;tick++){
  now+=200;moving=sync('human-a',3);
  if(tick%20===0)sync('human-b',3);
  for(const bot of bots()){
    visited.add(bot.waypoint);
    minClear&&=hasWaterClearance(lake,bot.boat.x,bot.boat.y,Math.hypot(bot.length,bot.beam)/2);
    minClear&&=hasWaterClearance(lake,bot.tube.x,bot.tube.y,1/M);
    assert.ok(Math.hypot(bot.tube.x-bot.boat.x,bot.tube.y-bot.boat.y)<40/M);
  }
}
assert.ok(minClear,'No hull or tube crosses land during 20 minutes of cruising');
assert.equal(visited.size,BOT_ROUTE.length,'Bots complete the entire loop');
const movingBot=bots()[0],human=room.players['human-a'];
const contactOffset=movingBot.length*.75;
human.boat={...movingBot.boat,x:movingBot.boat.x+Math.cos(movingBot.boat.angle)*contactOffset,y:movingBot.boat.y+Math.sin(movingBot.boat.angle)*contactOffset,vx:0,vy:0};human.tube={...human.boat,x:human.boat.x-24/M};human.graceUntil=0;
movingBot.graceUntil=0;
now+=200;sync('human-a',3);
assert.ok(human.correction,'A bot can bump a real player');
assert.ok(movingBot.boat.bumpGlideTime>0,'A hull impact starts the bot\'s momentum carry');
now+=200;sync('human-a',3);
assert.equal(bots()[0].correction,null,'Server consumes bot collision acknowledgments');
sync('human-a',0);assert.equal(room.players[botId],undefined,'Turning off removes only your bots');
assert.equal(bots().length,3,'Another player may use freed bot slots');
action('human-b','leave');assert.equal(bots().length,0,'Leaving removes owned bots');
sync('human-a',3);
for(let i=0;i<MAX_PLAYERS-1;i++)action(`guest-${i}`,'join');
assert.equal(Object.keys(room.players).length,MAX_PLAYERS);
assert.equal(bots().length,0,'Real players take priority over every bot');
action('guest-0','leave');assert.equal(bots().length,1,'A waiting request uses a free space');
now+=STALE_MS+1;action('fresh-human','join');
assert.equal(Object.keys(room.players).length,1,'Abandoned sessions never leave orphan bots');
sync('fresh-human',999);assert.equal(bots().length,3,'Server bounds requested bot counts');
sync('fresh-human',-1);assert.equal(bots().length,0);
console.log('Bot checks passed: shared visibility, default off, safe full laps, physical wakes, bumps, server clock, ownership, human priority and cleanup.');
