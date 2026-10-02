import { CONFIG } from '../physics/config.js';
import { emitWake, updateWakes } from '../physics/wake.js';
import { MAX_WAKE_SAMPLES, MAX_WAKE_SAMPLE_AGE_MS, wakePose } from './wake-protocol.js';

// Predictions and confirmed packets share the same physical water. Reconcile
// by exact emitter/sequence IDs, never by approximate position or arrival time.
export function createSharedWakeField(wakes,{clock=()=>performance.now()}={}){
  let cursor=0,serverClock=null,serverOffset=null;
  const pending=new Map();
  function predict(boat,seq){
    const pose=wakePose(boat);
    if(pose.speed<42)return;
    const packets=[];emitWake(packets,pose);
    for(const packet of packets){packet.predictionSeq=seq;wakes.push(packet);}
    pending.set(seq,{...pose,at:clock(),serverAt:serverClock===null?null:Math.round(serverClock*1000)});
    while(pending.size>MAX_WAKE_SAMPLES)pending.delete(pending.keys().next().value);
  }
  function samples(){
    const now=clock(),result=[];
    const uploadTime=serverOffset===null?null:Math.floor(now+serverOffset);
    for(const [seq,p] of pending){
      const age=Math.max(0,Math.round(now-p.at));
      // Timestamp the emission on the shared clock, not when its upload
      // arrives. Otherwise a slow upload would make confirmed waves younger.
      // A snapshot between animation frames can put the wave simulation a few
      // milliseconds ahead. Keep that prediction and its original timestamp
      // until wall time catches up; sending it early gets it rejected, while
      // restamping it can violate the server's minimum emission spacing.
      if(age<=MAX_WAKE_SAMPLE_AGE_MS&&p.serverAt!==null&&uploadTime!==null&&p.serverAt<=uploadTime)result.push([seq,p.serverAt,p.x,p.y,p.angle,p.speed]);
    }
    return result;
  }
  function advance(dt){
    if(serverClock!==null)serverClock+=dt;
    updateWakes(wakes,dt);
  }
  function receive(events,serverTime,{source,ack=0}={}){
    if(!Number.isFinite(serverTime))return;
    // Advance upload eligibility with monotonic wall time, never physics dt.
    // A delayed receipt gives a conservative estimate; older receipts cannot
    // rewind it. Do not guess one-way latency or relax server validation.
    serverOffset=Math.max(serverOffset??-Infinity,serverTime-clock());
    const now=serverTime/1000;
    if(serverClock===null)serverClock=now;
    else if(now>serverClock)advance(now-serverClock);
    // Remove acknowledged predictions before adding their canonical packets.
    // Anything emitted after the captured request remains immediate and intact.
    if(Number.isSafeInteger(ack)&&ack>=0){
      let keep=0;
      for(const packet of wakes)if(!(packet.predictionSeq<=ack))wakes[keep++]=packet;
      wakes.length=keep;
      for(const seq of pending.keys())if(seq<=ack)pending.delete(seq);
    }
    for(const event of events||[]){
      if(!Array.isArray(event)||![6,8].includes(event.length)||!event.every(Number.isFinite))continue;
      const [seq,at,x,y,angle,speed,emitter,localSeq]=event;
      if(seq<=cursor)continue;
      cursor=seq;
      if(emitter===source&&localSeq>0){
        let keep=0;
        for(const packet of wakes)if(packet.predictionSeq!==localSeq)wakes[keep++]=packet;
        wakes.length=keep;pending.delete(localSeq);
      }
      const age=Math.max(0,serverClock-at/1000);
      if(age>CONFIG.wakeLife)continue;
      const packets=[];
      emitWake(packets,{x,y,angle,speed});
      updateWakes(packets,age);
      for(const packet of packets){packet.eventSeq=seq;wakes.push(packet);}
    }
  }
  return {advance,receive,predict,samples};
}
