import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { hasWaterClearance, resolveShoreCollision } from '../physics/shore.js';
import { SHARED_LAKE_RULES } from '../simulation/defaults.js';
import { pruneWakeHistory, recordRoomWakes, recordWakeSamples, wakeSnapshot } from './wake-history.js';
import { MAX_BOTS, BOT_STEP_MS, BOT_PADS, stepBot } from './bots.js';
import { tubeContactResponse, tubeTubeContactResponse } from './tube-contacts.js';
import { boatContactResponse } from './boat-contacts.js';
import { startBoatBump } from '../physics/boat-bump.js';
import { IDLE_MS, idleResult } from './inactivity.js';
import { MAX_PLAYERS } from './room-limits.js';

export { MAX_PLAYERS };
export const STALE_MS = 15000;
const COLORS = ['#62dcff','#ff85ba','#a9e76d','#b9a0ff','#ffcb62','#7ce4bd','#ff9770','#88aaff','#e6dc7b','#ed99f1','#a5d1df','#cdb496','#f56b64','#36bd9b','#e8eff5','#e7a14e'];
const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
const finite = (n,fallback,min,max) => Number.isFinite(n) ? clamp(n,min,max) : fallback;
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const radius = player => Math.hypot(player.length,player.beam)/2;
export function roomError(status,message) { return Object.assign(new Error(message), {status}); }
function cleanName(value, fallback) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,20) || fallback : fallback; }
function body(raw) {
  if (!raw || !['x','y','vx','vy','angle'].every(k=>Number.isFinite(raw[k]))) throw roomError(400,'Invalid boat position.');
  const b=lake.bounds;
  return {
    x:clamp(raw.x,b.minX,b.maxX),y:clamp(raw.y,b.minY,b.maxY),
    vx:clamp(raw.vx,-52/M,52/M),vy:clamp(raw.vy,-52/M,52/M),
    angle:Math.atan2(Math.sin(raw.angle),Math.cos(raw.angle)),
    z:finite(raw.z,0,-3/M,20/M),pitch:finite(raw.pitch,0,-1.5,1.5),roll:finite(raw.roll,0,-1.5,1.5),
    riderOn:raw.riderOn !== false
  };
}
function configure(p,input) {
  p.length=SHARED_LAKE_RULES.length;
  p.beam=SHARED_LAKE_RULES.beam;
  p.ropeLength=SHARED_LAKE_RULES.ropeLength;
  p.name=cleanName(input.name,p.name);
}
function pointSegment(p,a,b) {
  const dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy;
  const t=d?clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/d,0,1):0;
  return Math.hypot(p.x-a.x-dx*t,p.y-a.y-dy*t);
}
const pads=[];
for(let row=-6;row<=6;row++)for(let col=-6;col<=6;col++){
  const a=lake.spawn.angle,f=col*40/M,s=row*20/M;
  pads.push({x:lake.spawn.x+Math.cos(a)*f-Math.sin(a)*s,y:lake.spawn.y+Math.sin(a)*f+Math.cos(a)*s,angle:a,rank:f*f+s*s});
}
pads.sort((a,b)=>a.rank-b.rank);
function chooseSpawn(players,p,now,candidates=pads) {
  for(const spawn of candidates){
    const rear={x:spawn.x-Math.cos(spawn.angle)*(p.ropeLength+p.length*.55+2/M),y:spawn.y-Math.sin(spawn.angle)*(p.ropeLength+p.length*.55+2/M)};
    if(!hasWaterClearance(lake,spawn.x,spawn.y,5/M)||!hasWaterClearance(lake,rear.x,rear.y,3/M))continue;
    let safe=true;
    for(let t=0;t<=1;t+=.1){const q={x:spawn.x+(rear.x-spawn.x)*t,y:spawn.y+(rear.y-spawn.y)*t};
      if(!hasWaterClearance(lake,q.x,q.y,2/M)){safe=false;break;}
      for(const other of Object.values(players)){
        if(other.id===p.id)continue;
        // Reserve the complete tow corridor, including stationary/paused boats.
        if(pointSegment(q,other.boat,other.tube)<10/M){safe=false;break;}
        const predicted={x:other.boat.x+other.boat.vx*.6,y:other.boat.y+other.boat.vy*.6};
        if(pointSegment(q,other.boat,predicted)<10/M){safe=false;break;}
      }
      if(!safe)break;
    }
    if(!safe)continue;
    const zero={vx:0,vy:0,z:0,pitch:0,roll:0};
    p.boat={...zero,x:spawn.x,y:spawn.y,angle:spawn.angle};
    p.tube={...zero,...rear,angle:spawn.angle,riderOn:true};
    p.spawn={x:spawn.x,y:spawn.y,angle:spawn.angle};
    if(p.isBot)p.waypoint=spawn.waypoint;
    p.poseAt=now;p.updatedAt=now;p.paused=true;p.graceUntil=now+1500;
    p.wakeEpochAt=now;
    p.lastWakeSampleAt=undefined;p.lastWakeSamplePose=null;
    p.correction=null;
    p.tubeBounce=null;
    return;
  }
  throw roomError(409,'The launch area is busy. Trying another starting spot…');
}
function moveConvoy(p,dx,dy) {
  for(const b of [p.boat,p.tube]){const prev={x:b.x,y:b.y};b.x+=dx;b.y+=dy;resolveShoreCollision(lake,b,prev,b===p.boat?radius(p):1/M);}
}
function correction(p,dx,dy,dvx,dvy,boatBump=false) {
  p.eventSeq++;
  p.correction={seq:p.eventSeq,dx,dy,dvx,dvy,...(boatBump?{boatBump:true}:{})};
  moveConvoy(p,dx,dy);p.boat.vx+=dvx;p.boat.vy+=dvy;
  if(boatBump&&p.isBot)startBoatBump(p.boat,dvx,dvy);
}
export function resolvePlayerContacts(room,p,previous,now) {
  if(p.correction || p.graceUntil>now)return;
  for(const other of Object.values(room.players)){
    if(other.id===p.id||other.correction||other.graceUntil>now)continue;
    const hit=boatContactResponse(p.boat,previous,other.boat,other.boat,p.length,p.beam,other.length,other.beam);
    if(!hit)continue;
    correction(p,hit.a.dx,hit.a.dy,hit.a.dvx,hit.a.dvy,true);
    correction(other,hit.b.dx,hit.b.dy,hit.b.dvx,hit.b.dvy,true);
    // Acknowledgments prevent duplicate impulses. Do not add a timed blind
    // window: both drivers can push the bumpers back together immediately.
    break; // Wait for both acknowledgments before resolving another impact.
  }
}
function correctTube(p,change){
  const previous={...p.tube};
  p.tube.x+=change.dx;p.tube.y+=change.dy;
  p.tube.vx+=change.dvx;p.tube.vy+=change.dvy;
  resolveShoreCollision(lake,p.tube,previous,SHARED_LAKE_RULES.tubeRadius);
  p.eventSeq++;
  p.correction={seq:p.eventSeq,dx:0,dy:0,dvx:0,dvy:0,tube:{...change,
    dx:p.tube.x-previous.x,dy:p.tube.y-previous.y,
    dvx:p.tube.vx-previous.vx,dvy:p.tube.vy-previous.vy}};
  if(p.isBot)p.tubeBounce={vx:(p.tubeBounce?.vx||0)+p.correction.tube.dvx,vy:(p.tubeBounce?.vy||0)+p.correction.tube.dvy};
}
export function resolveTubeContacts(room,p,previousBoat,previousTube,now){
  if(p.correction||p.graceUntil>now)return;
  for(const other of Object.values(room.players)){
    if(other.id===p.id||other.correction||other.graceUntil>now)continue;
    // Either member of the pair may be the one sending the new pose.
    for(const [towOwner,hullOwner,oldTube,oldBoat] of [
      [p,other,previousTube,other.boat],[other,p,other.tube,previousBoat]
    ]){
      const hit=tubeContactResponse(towOwner.tube,oldTube,hullOwner.boat,oldBoat,hullOwner.length,hullOwner.beam);
      if(!hit)continue;
      correctTube(towOwner,hit.tube);
      correction(hullOwner,0,0,hit.boat.dvx,hit.boat.dvy);
      return; // One acknowledged correction per owner, just like boat bumps.
    }
    const hit=tubeTubeContactResponse(p.tube,previousTube,other.tube,other.tube);
    if(!hit)continue;
    correctTube(p,hit.a);correctTube(other,hit.b);
    return;
  }
}
const requestedBots=value=>Number.isSafeInteger(value)?clamp(value,0,MAX_BOTS):0;
function reconcileBots(room,now){
  // Bots belong to the session that requested them, and never take a human's
  // last seat. Bound the whole lake to MAX_BOTS, even if many clients request them.
  for(const [id,bot] of Object.entries(room.players))if(bot.isBot){
    const owner=room.players[bot.ownerId];
    if(!owner||owner.isBot||bot.botSlot>owner.botCount)delete room.players[id];
  }
  let total=Object.values(room.players).filter(q=>q.isBot).length;
  for(const owner of Object.values(room.players).filter(q=>!q.isBot)){
    for(let slot=1;slot<=owner.botCount&&total<MAX_BOTS&&Object.keys(room.players).length<MAX_PLAYERS;slot++){
      const id=`bot-${owner.id}-${slot}`;
      if(room.players[id])continue;
      const used=new Set(Object.values(room.players).map(q=>q.color));
      const color=COLORS.find(c=>!used.has(c))||COLORS[0];
      const bot={id,isBot:true,ownerId:owner.id,botSlot:slot,name:`Bot ${COLORS.indexOf(color)+1}`,color,physicsVersion:SHARED_LAKE_RULES.version,eventSeq:0};
      configure(bot,{});
      try{chooseSpawn(room.players,bot,now,BOT_PADS);}catch(error){if(error.status===409)break;throw error;}
      room.players[id]=bot;total++;
    }
  }
}
function advanceBots(room,now){
  for(const bot of Object.values(room.players).filter(q=>q.isBot)){
    // Fixed steps are persisted with the room. Extra visitors/retries cannot
    // make bots run faster. Never catch up more than one second after a gap.
    if(now-bot.poseAt>1000)bot.poseAt=now-1000;
    while(bot.poseAt+BOT_STEP_MS<=now){
      const previous={...bot.boat},previousTube={...bot.tube},from=bot.poseAt;
      bot.correction=null; // Server already applied this bot's bump.
      stepBot(bot,room.players,BOT_STEP_MS/1000);
      bot.poseAt+=BOT_STEP_MS;
      resolvePlayerContacts(room,bot,previous,bot.poseAt);
      resolveTubeContacts(room,bot,previous,previousTube,bot.poseAt);
      recordRoomWakes(room,previous,bot.boat,from,bot.poseAt,false);
    }
    bot.updatedAt=now;
  }
}
function pruneRoom(room,now) {
  room.players ||= {};room.contacts ||= {};room.departed ||= {};
  room.idleDeparted ||= {};
  pruneWakeHistory(room,now);
  for(const [id,at] of Object.entries(room.idleDeparted))if(now-at>10*60*1000)delete room.idleDeparted[id];
  for(const [id,p] of Object.entries(room.players))if(!p.isBot&&now-(p.lastActivityAt??p.updatedAt)>=IDLE_MS){
    room.idleDeparted[id]=now;delete room.players[id];
  }
  for(const [id,at] of Object.entries(room.departed))if(now-at>60000)delete room.departed[id];
  for(const [id,p] of Object.entries(room.players))if((!p.isBot&&now-p.updatedAt>STALE_MS)||p.physicsVersion!==SHARED_LAKE_RULES.version)delete room.players[id];
  for(const [id,p] of Object.entries(room.players))if(p.isBot&&!room.players[p.ownerId])delete room.players[id];
  for(const [key,at] of Object.entries(room.contacts))if(now-at>3000)delete room.contacts[key];
}
// The live room has its own clock; bots keep moving between incoming packets.
export function tickRoom(room,now) {
  pruneRoom(room,now);reconcileBots(room,now);advanceBots(room,now);
}
export function applyRoomAction(room,input,tokenHash,now) {
  if(input.action!=='leave' && input.physicsVersion!==SHARED_LAKE_RULES.version)throw roomError(426,'Lake physics updated. Refresh the game to join with shared defaults.');
  pruneRoom(room,now);
  // Return a terminal result so the caller commits removal even when the
  // expiring player's own request discovers the timeout (also on HTTP/D1).
  if(input.action!=='leave'&&room.idleDeparted[input.id])return idleResult();
  let p=room.players[input.id];
  if(p && (p.isBot||p.tokenHash!==tokenHash))throw roomError(403,'This boat belongs to another session.');
  if(input.action==='join'){
    if(room.departed[input.id])throw roomError(410,'This lake session has ended.');
    if(!p){
      if(Object.keys(room.players).length>=MAX_PLAYERS){
        const bot=Object.values(room.players).find(q=>q.isBot);
        if(bot)delete room.players[bot.id];
      }
      if(Object.keys(room.players).length>=MAX_PLAYERS)throw Object.assign(
        roomError(409,`Lake full (${MAX_PLAYERS}/${MAX_PLAYERS} players). Waiting for a spot — retrying automatically…`),
        {code:'room_full'});
      const used=new Set(Object.values(room.players).map(p=>p.color));
      const color=COLORS.find(c=>!used.has(c))||COLORS[0];
      room.wakeSourceSeq=(room.wakeSourceSeq||0)+1;
      p={id:input.id,tokenHash,color,name:`Skipper ${COLORS.indexOf(color)+1}`,physicsVersion:SHARED_LAKE_RULES.version,eventSeq:0,lastSeq:-1,lastReset:-1,botCount:requestedBots(input.botCount),wakeSource:room.wakeSourceSeq,wakeAck:0,wakeBudget:3,wakeBudgetAt:now,lastActivityAt:now,activitySeq:Number.isSafeInteger(input.activitySeq)?input.activitySeq:0};
      configure(p,input);chooseSpawn(room.players,p,now);room.players[p.id]=p;
    }
    p.updatedAt=now;
  }else if(input.action==='leave'){
    if(p)delete room.players[p.id];
    room.departed[input.id]=now;
    reconcileBots(room,now);
    return {left:true};
  }else{
    if(!p)throw roomError(410,'Rejoining the lake…');
    if(!Number.isSafeInteger(input.seq)||input.seq<0)throw roomError(400,'Invalid update sequence.');
    if(input.seq>p.lastSeq){
      p.lastSeq=input.seq;p.updatedAt=now;
      p.botCount=requestedBots(input.botCount);
      if(input.action==='reset'){
        configure(p,input);chooseSpawn(room.players,p,now);p.lastReset=input.seq;
      }else if(input.action==='sync'){
        p.name=cleanName(input.name,p.name);
        if(!p.correction || input.ack>=p.correction.seq){
          p.correction=null;
          const previous={...p.boat},previousTube={...p.tube},previousAt=p.poseAt,wasPaused=p.paused,next=body(input.boat),tube=body(input.tube);
          const travel=Math.max(.2,Math.min(4,(now-p.poseAt)/1000))*52/M+6/M;
          if(distance(next,previous)>travel)throw roomError(409,'Position changed too quickly. Reset to rejoin safely.');
          resolveShoreCollision(lake,next,previous,radius(p));
          if(distance(tube,next)>40/M){tube.x=next.x;tube.y=next.y;tube.vx=0;tube.vy=0;}
          resolveShoreCollision(lake,tube,p.tube,1/M);
          p.boat=next;p.tube=tube;p.paused=!!input.paused;p.poseAt=now;
          if(p.paused){p.boat.vx=0;p.boat.vy=0;p.tube.vx=0;p.tube.vy=0;}
          if(Array.isArray(input.wakeSamples))recordWakeSamples(room,p,input.wakeSamples,now);
          else recordRoomWakes(room,previous,p.boat,previousAt,now,wasPaused||p.paused);
          resolvePlayerContacts(room,p,previous,now);
          resolveTubeContacts(room,p,previous,previousTube,now);
        }
      }else throw roomError(400,'Unknown lake action.');
    }
  }
  if(Number.isSafeInteger(input.activitySeq)&&input.activitySeq>p.activitySeq){
    p.activitySeq=input.activitySeq;p.lastActivityAt=now;
  }
  reconcileBots(room,now);
  advanceBots(room,now);
  return {...snapshot(room,p,now),...wakeSnapshot(room,input.action==='join'||input.action==='reset'?0:input.wakeSince)};
}
export function snapshot(room,p,now) {
  return {serverTime:now,capacity:MAX_PLAYERS,self:{id:p.id,name:p.name,color:p.color,spawn:p.spawn,correction:p.correction,lastReset:p.lastReset,wakeSource:p.wakeSource,wakeAck:p.wakeAck||0,botCount:p.botCount||0,activeBots:Object.values(room.players).filter(q=>q.isBot&&q.ownerId===p.id).length},players:Object.values(room.players).map(q=>({id:q.id,name:q.name,color:q.color,isBot:!!q.isBot,boat:q.boat,tube:q.tube,length:q.length,beam:q.beam,paused:q.paused,updatedAt:q.updatedAt,poseAt:q.poseAt,spawnAt:q.wakeEpochAt}))};
}
