import assert from 'node:assert/strict';
import { createSocketClient } from '../multiplayer/socket-client.js';
import { createLakeClient as createHttpClient } from '../multiplayer/http-client.js';
import { createLakeClient } from '../multiplayer/client.js';
import { OSWEGO_MAP as lake } from '../maps/catalog.js';

let time=1000,nextTimer=0;const tasks=new Map();
const schedule=(fn,delay)=>{tasks.set(++nextTimer,{fn,at:time+delay});return nextTimer;};
const cancel=id=>tasks.delete(id);
function advance(ms){
  const end=time+ms;
  for(;;){const item=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!item||item[1].at>end)break;tasks.delete(item[0]);time=item[1].at;item[1].fn();}
  time=end;
}
class Socket{
  readyState=0;bufferedAmount=0;listeners={};sent=[];
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  emit(type,value={}){for(const fn of this.listeners[type]||[])fn(value);}
  send(value){this.sent.push(JSON.parse(value));}
  open(){this.readyState=1;this.emit('open');}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
  message(data){this.emit('message',{data:JSON.stringify(data)});}
}
const body={...lake.spawn,vx:0,vy:0},sockets=[];
const client=createSocketClient({url:'wss://example.test/lake',clock:()=>time,schedule,cancel,
  socketFactory:()=>{const s=new Socket();sockets.push(s);return s;},read:()=>({boat:body,tube:body}),onSpawn:()=>{}});
let frame=0;
function snapshot(socket,extra={}){socket.message({type:'snapshot',frame:++frame,epoch:'test',serverTime:time,self:{id:socket.sent[0].id,name:'Tester'},players:[],...extra});}
function join(socket,delay){const req=socket.sent.at(-1);advance(delay);snapshot(socket,{type:'reply',action:'join',requestSeq:req.seq,echo:req.sentAt,self:{id:req.id,name:'Tester',spawn:lake.spawn}});return req;}
client.setMap('oswego');let s=sockets.at(-1);s.open();
assert.equal(client.latencyMs,null,'No sample must not appear as zero ping');
const first=join(s,80);assert.equal(client.latencyMs,80,'Only this connection’s own round-trip is displayed');
advance(200);snapshot(s,{echo:first.sentAt});assert.equal(client.latencyMs,80,'Duplicate echoes do not resample the growing age');
snapshot(s,{echo:time+10});assert.equal(client.latencyMs,80,'Future timestamps are ignored');
for(let i=0;i<5;i++){advance(500);snapshot(s,i%2?{}:{echo:first.sentAt});}
assert.equal(client.ready,true);assert.equal(client.latencyMs,null,'Other frames do not keep an old latency sample fresh');
const fresh=s.sent.at(-1);advance(70);snapshot(s,{echo:fresh.sentAt});
assert.equal(client.latencyMs,time-fresh.sentAt,'Fresh samples replace an expired estimate');
s.close();assert.equal(client.latencyMs,null,'Disconnect immediately clears the displayed sample');
advance(250);s=sockets.at(-1);s.open();join(s,1300);assert.equal(client.latencyMs,1300,'Display is not capped by prediction’s 1000 ms limit');
advance(1550);assert.equal(client.latencyMs,null,'Silence hides the reading even before reconnect timeout');
client.setMap('open');assert.equal(client.latencyMs,null);assert.equal(tasks.size,0);

let httpTime=1000,duration=120,fail=false;
const http=createHttpClient({clock:()=>httpTime,read:()=>({boat:body,tube:body}),onSpawn:()=>{},onCorrection:()=>{},fetcher:async(_,options)=>{
  const req=JSON.parse(options.body);if(req.action==='leave')return Response.json({left:true});
  httpTime+=duration;if(fail)throw new Error('Offline');
  return Response.json({serverTime:httpTime,self:{id:req.id,name:'Tester',spawn:lake.spawn},players:[]});
}});
const until=async check=>{const end=Date.now()+2000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check());};
try{
  assert.equal(http.latencyMs,null);http.setMap('oswego');await until(()=>http.ready);
  assert.equal(http.latencyMs,120,'HTTP fallback measures its update round-trip');
  httpTime+=2600;assert.equal(http.latencyMs,null,'HTTP readings expire');
  duration=210;await until(()=>http.latencyMs===210);
  fail=true;await until(()=>/interrupted/.test(http.status));assert.equal(http.latencyMs,null,'HTTP failure clears the value');
  http.setMap('open');assert.equal(http.latencyMs,null);
}finally{http.leave();}
const solo=createLakeClient({read:()=>({boat:body,tube:body}),socketFactory:null});
solo.setMap('open');assert.equal(solo.latencyMs,null,'Solo has no multiplayer latency');
console.log('Connection latency passed: own echoes, missing/duplicate/future timestamps, expiry, reconnect, high latency, HTTP failures and solo mode.');
