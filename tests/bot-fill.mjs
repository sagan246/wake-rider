import assert from 'node:assert/strict';
import { RoomService } from '../realtime/room-service.js';
import { MAX_PLAYERS, STALE_MS } from '../multiplayer/room.js';
import { SHARED_LAKE_RULES } from '../simulation/defaults.js';
import { IDLE_MS } from '../multiplayer/inactivity.js';

const start=100000;
function fixture(){
  const service=new RoomService(),seqs=new Map();
  const action=(id,action,extra={},at=start)=>service.action({id,action,physicsVersion:SHARED_LAKE_RULES.version,...extra},id,at);
  const sync=(id,extra={},at=start)=>{
    const p=service.room.players[id],seq=(seqs.get(id)||0)+1;seqs.set(id,seq);
    return action(id,'sync',{seq,activitySeq:seq,ack:p.correction?.seq||0,boat:p.boat,tube:p.tube,paused:true,botCount:p.botCount,...extra},at);
  };
  const request=enabled=>({...service.room.botFill,enabled});
  const bots=()=>Object.values(service.room.players).filter(p=>p.isBot);
  return {service,action,sync,request,bots};
}
const f=fixture();f.action('human-a','join');
assert.equal(f.service.room.botFill.enabled,false,'Filling starts off');
const enable=f.request(true);
f.sync('human-a',{fillBotsRequest:enable});
assert.equal(f.bots().length,15);assert.ok(f.bots().every(p=>p.fillBot));
const revision=f.service.room.botFill.revision;
const stable=structuredClone(f.service.room.players);
f.sync('human-a',{fillBotsRequest:enable});
assert.equal(f.service.room.botFill.revision,revision,'Lost-reply retries do not reapply a command');
for(const bot of f.bots())assert.deepEqual(bot,stable[bot.id],'No-op sync preserves each filler and its pose');
const b=f.action('human-b','join');
assert.equal(f.bots().length,14);assert.equal(b.self.botFill.enabled,true,'Everyone sees the shared setting');
f.sync('human-b');assert.equal(f.service.room.botFill.enabled,true,'Older clients without setting commands cannot disable fill');
f.action('human-a','leave');
assert.equal(f.bots().length,15);assert.equal(f.service.room.botFill.enabled,true,'Filling survives the enabler leaving');
f.sync('human-b',{botCount:2});
assert.equal(f.bots().filter(p=>!p.fillBot).length,2,'Manual requests can replace fillers in a full room');
assert.equal(f.bots().length,15);
f.action('human-c','join');
assert.equal(f.bots().filter(p=>!p.fillBot).length,2,'Joining humans replace fillers before manual bots');
assert.equal(f.bots().length,14);
const disable=f.request(false);
f.sync('human-b',{fillBotsRequest:disable});assert.equal(f.bots().length,2,'Turning fill off keeps manual bots');
const afterDisable=f.service.room.botFill.revision;
f.sync('human-c',{fillBotsRequest:enable});
assert.equal(f.service.room.botFill.enabled,false,'A stale click cannot undo another player’s choice');
assert.equal(f.service.room.botFill.revision,afterDisable);
f.sync('human-c',{fillBotsRequest:f.request(false)});
assert.equal(f.service.room.botFill.revision,afterDisable+1,'An accepted same-value command is acknowledged too');
const current=f.request(true);
f.sync('human-c',{fillBotsRequest:{...current,epoch:'an-old-room'}});
assert.equal(f.service.room.botFill.enabled,false,'A command from another room epoch is ignored');
const before=structuredClone(f.service.room);
assert.throws(()=>f.service.action({id:'human-c',action:'sync',seq:999,physicsVersion:SHARED_LAKE_RULES.version,fillBotsRequest:current},'wrong-token',start),e=>e.status===403);
assert.deepEqual(f.service.room,before);
const bot=f.bots()[0];assert.throws(()=>f.action(bot.id,'sync',{seq:1,fillBotsRequest:current}),e=>e.status===403);
f.sync('human-c',{fillBotsRequest:current});
const staleSeq=1;
f.action('human-c','sync',{seq:staleSeq,fillBotsRequest:f.request(false)});
assert.equal(f.service.room.botFill.enabled,true,'Replayed older action sequences cannot change fill');

// All-human capacity and returning filler after a departure.
for(let i=0;i<14;i++)f.action(`guest-${i}`,'join');
assert.equal(Object.keys(f.service.room.players).length,MAX_PLAYERS);assert.equal(f.bots().length,0);
assert.throws(()=>f.action('guest-extra','join'),e=>e.code==='room_full');
f.action('guest-0','leave');assert.equal(f.bots().length,1);
for(const p of Object.values(f.service.room.players).filter(p=>!p.isBot))f.action(p.id,'leave');
assert.equal(Object.keys(f.service.room.players).length,0);assert.equal(f.service.room.botFill.enabled,false);

for(const reason of ['stale','idle']){
  const x=fixture();x.action('last-human','join');x.sync('last-human',{fillBotsRequest:x.request(true)});
  const oldRevision=x.service.room.botFill.revision;
  if(reason==='stale')x.service.tick(start+STALE_MS+1);
  else{
    const p=x.service.room.players['last-human'];p.updatedAt=start+IDLE_MS;
    const result=x.action('last-human','sync',{seq:1000},start+IDLE_MS);
    assert.equal(result.code,'idle','The early idle response still commits empty-room cleanup');
  }
  assert.equal(Object.keys(x.service.room.players).length,0);
  assert.equal(x.service.room.botFill.enabled,false);
  assert.equal(x.service.room.botFill.revision,oldRevision+1);
}
const fresh=fixture();fresh.action('human','join',{fillBotsRequest:enable});
assert.equal(fresh.service.room.botFill.enabled,false,'Joining never applies an old pending setting');
fresh.sync('human',{fillBotsRequest:enable});assert.equal(fresh.service.room.botFill.enabled,false,'A restarted room rejects old epochs');
console.log('Bot fill passed: shared toggle, 16 seats, human priority, manual coexistence, retry/concurrency guards, ownership, enabler departure and final-player cleanup.');
