import assert from 'node:assert/strict';
import { createSharedWakeField } from '../simulation/shared-wakes.js';
import { recordWakeSamples } from '../multiplayer/wake-history.js';
import { applyRoomAction } from '../multiplayer/room.js';
import { SHARED_LAKE_RULES } from '../simulation/defaults.js';

function run({fps, snapshotPhase=16, uploadPhase=1, latency=0, jitter=false}) {
  const base=100000, duration=10000, room={};
  const joined=applyRoomAction(room,{id:'frame-test',action:'join',physicsVersion:SHARED_LAKE_RULES.version},'hash',base);
  const player=room.players['frame-test'], source=joined.self.wakeSource;
  const boat={...player.boat,speed:130};
  let now=0, last=0, accumulator=0, simTime=0, seq=0, future=0, submitted=0;
  const seen=new Set(), water=[], field=createSharedWakeField(water,{clock:()=>now});
  field.receive([],base,{source});
  const events=[];
  for(let frame=1,at=0;at<duration;frame++) {
    at+=1000/fps*(jitter?[.7,1.3,1.1,.9][frame%4]:1);
    if(at>duration)break;
    events.push({at,fn:()=>{
      accumulator+=Math.min((now-last)/1000,.05);last=now;
      while(accumulator>=1/120) {
        const dt=1/120;simTime+=dt;
        if(Math.floor(simTime*10)!==Math.floor((simTime-dt)*10))field.predict(boat,++seq);
        field.advance(dt);accumulator-=dt;
      }
    }});
  }
  for(let at=uploadPhase;at<=duration+latency*2+200;at+=50)events.push({at,fn:()=>{
    const samples=field.samples();
    events.push({at:now+latency,fn:()=>{
      for(const sample of samples)if(!seen.has(sample[0])){
        seen.add(sample[0]);submitted++;if(sample[1]>base+now)future++;
      }
      recordWakeSamples(room,player,samples,base+now);
    }});
  }});
  for(let at=snapshotPhase;at<=duration+latency*3+400;at+=50)events.push({at,fn:()=>{
    const serverTime=base+now, wakeEvents=room.wakeEvents.map(e=>[...e]), ack=player.wakeAck||0;
    events.push({at:now+latency,fn:()=>field.receive(wakeEvents,serverTime,{source,ack})});
  }});
  while(events.length){events.sort((a,b)=>a.at-b.at);const event=events.shift();now=event.at;event.fn();}
  const result={fps,snapshotPhase,uploadPhase,latency,jitter,emitted:seq,submitted,accepted:room.wakeEvents.length,future};
  assert.equal(future,0,`No frame timing can stamp future wakes: ${JSON.stringify(result)}`);
  assert.equal(submitted,seq,`Every predicted wake is uploaded: ${JSON.stringify(result)}`);
  assert.equal(room.wakeEvents.length,seq,`Every valid wake survives confirmation: ${JSON.stringify(result)}`);
  assert.equal(water.length,seq*2,'Both sides of every wake remain after acknowledgments');
  return result;
}

const results=[];
for(const fps of [30,60,90,120,144])for(const snapshotPhase of [0,8,16,33]) {
  results.push(run({fps,snapshotPhase}));
}
for(const fps of [30,60,120])for(const latency of [25,150])results.push(run({fps,latency,jitter:true}));
console.log(`Wake frame timing passed: ${results.length} frame-rate, snapshot-phase, jitter and latency cases; no lost valid waves.`);
