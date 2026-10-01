import { SHARED_LAKE_RULES } from '../simulation/defaults.js';
import { MAX_WAKE_SAMPLES, MAX_WAKE_SAMPLE_AGE_MS, wakePose } from '../simulation/wake-protocol.js';
import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { hasWaterClearance } from '../physics/shore.js';
import { MAX_PLAYERS } from './room-limits.js';

export const WAKE_HISTORY_MS=SHARED_LAKE_RULES.wakeLife*1000;
export const MAX_WAKE_EVENTS=MAX_PLAYERS*SHARED_LAKE_RULES.wakeLife*10;
const round=(n,scale)=>Math.round(n*scale)/scale;

export function recordWakeSamples(room,p,samples,now){
  // An authenticated boat may submit a bounded trail, never amplitudes or
  // arbitrary wave payloads. Acknowledgments include rejected samples so that
  // old predictions cannot linger or be retried forever.
  p.wakeBudget=Math.min(MAX_WAKE_SAMPLES,(p.wakeBudget??3)+Math.max(0,now-(p.wakeBudgetAt??now))/100);
  p.wakeBudgetAt=now;
  let previousAt=p.lastWakeSampleAt??-Infinity,previous=p.lastWakeSamplePose||null;
  for(const raw of samples.slice(0,MAX_WAKE_SAMPLES)){
    if(!Array.isArray(raw)||!Number.isSafeInteger(raw[0])||raw[0]<1||raw[0]<=(p.wakeAck||0))continue;
    p.wakeAck=raw[0];
    if(raw.length!==6||!raw.every(Number.isFinite))continue;
    const [id,at,x,y,angle,speed]=raw,age=now-at;
    if(age<0||age>MAX_WAKE_SAMPLE_AGE_MS||at<(p.wakeEpochAt||0)||at-previousAt<75)continue;
    if(speed<42||speed>52/M||Math.abs(angle)>Math.PI+.001)continue;
    const pose=wakePose({x,y,angle,speed});
    // The accepted final pose bounds the whole trail. Check individual samples
    // and travel too; resets never interpolate a line from the old launch.
    if(Math.hypot(x-p.boat.x,y-p.boat.y)>52/M*age/1000+6/M)continue;
    if(previous&&Math.hypot(x-previous.x,y-previous.y)>52/M*(at-previousAt)/1000+6/M)continue;
    if(!hasWaterClearance(lake,x,y,Math.hypot(p.length,p.beam)/2))continue;
    if(p.wakeBudget<1)continue;
    p.wakeBudget--;previousAt=at;previous=pose;
    p.lastWakeSampleAt=at;p.lastWakeSamplePose=pose;
    room.wakeEvents.push([++room.wakeSeq,at,pose.x,pose.y,pose.angle,pose.speed,p.wakeSource,id]);
  }
  if(room.wakeEvents.length>MAX_WAKE_EVENTS)room.wakeEvents.splice(0,room.wakeEvents.length-MAX_WAKE_EVENTS);
}

export function pruneWakeHistory(room,now){
  room.wakeSeq ||= 0;
  // Different boats' time intervals can overlap; sequence order is not age order.
  room.wakeEvents=(room.wakeEvents||[]).filter(e=>now-e[1]<WAKE_HISTORY_MS).slice(-MAX_WAKE_EVENTS);
}

export function recordRoomWakes(room,previous,next,from,to,paused){
  const elapsed=to-from;
  // Pauses, resets and long missing updates never draw a bridge across the lake.
  if(paused||elapsed<=0||elapsed>1000)return;
  const turn=Math.atan2(Math.sin(next.angle-previous.angle),Math.cos(next.angle-previous.angle));
  for(let at=(Math.floor(from/100)+1)*100;at<=to;at+=100){
    const t=(at-from)/elapsed,angle=previous.angle+turn*t;
    const vx=previous.vx+(next.vx-previous.vx)*t,vy=previous.vy+(next.vy-previous.vy)*t;
    const speed=Math.max(0,vx*Math.cos(angle)+vy*Math.sin(angle));
    if(speed<42)continue;
    // Compact canonical emission: sequence, server time, position, heading, speed.
    // No client-supplied amplitude, gravity, lifetime or wave payload is trusted.
    room.wakeEvents.push([++room.wakeSeq,at,round(previous.x+(next.x-previous.x)*t,10),round(previous.y+(next.y-previous.y)*t,10),round(angle,100000),round(speed,10)]);
  }
  if(room.wakeEvents.length>MAX_WAKE_EVENTS)room.wakeEvents.splice(0,room.wakeEvents.length-MAX_WAKE_EVENTS);
}

export function wakeSnapshot(room,since){
  const cursor=Number.isSafeInteger(since)&&since>=0&&since<=room.wakeSeq?since:0;
  return {wakeCursor:room.wakeSeq,wakeEvents:room.wakeEvents.filter(e=>e[0]>cursor)};
}
