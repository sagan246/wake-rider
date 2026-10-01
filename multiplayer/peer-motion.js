import { OSWEGO_MAP, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { resolveShoreCollision } from '../physics/shore.js';

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const turn=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
const bodyKeys=['x','y','vx','vy','angle','z','pitch','roll','riderOn'];
const sameBody=(a,b)=>bodyKeys.every(k=>a[k]===b[k]);
function blend(a,b,t){
  const result={...b};
  for(const k of ['x','y','vx','vy','z','pitch','roll'])result[k]=lerp(a[k]||0,b[k]||0,t);
  result.angle=a.angle+turn(b.angle,a.angle)*t;
  return result;
}
function predict(body,seconds,yaw){
  // Coast briefly through missing packets, then ease to a stop. A disconnected
  // skipper cannot keep sailing across the lake indefinitely on an old pose.
  const t=clamp(seconds,0,.9),tail=Math.max(0,t-.45);
  const travel=t-tail*tail/.9,angle=yaw*travel;
  let dx=body.vx*travel,dy=body.vy*travel;
  if(Math.abs(yaw)>.001){
    dx=(body.vx*Math.sin(angle)+body.vy*(Math.cos(angle)-1))/yaw;
    dy=(body.vx*(1-Math.cos(angle))+body.vy*Math.sin(angle))/yaw;
  }
  return {...body,x:body.x+dx,y:body.y+dy,angle:body.angle+angle};
}

export function createPeerMotion({map=OSWEGO_MAP,minDelay=120,maxDelay=300,initialDelay=150,smoothingMs=140}={}){
  const peers=new Map();
  let serverAnchor=0,localAnchor=0,initialized=false;
  const serverNow=now=>serverAnchor+Math.max(0,now-localAnchor);
  function raw(p,now){
    const history=p.history,last=history.at(-1);
    // Adapt to distinct source updates, not repeated observer reads. Never
    // rewind the presentation clock when a slower packet increases the buffer.
    p.renderTime=Math.max(p.renderTime??-Infinity,serverNow(now)-p.delay);
    if(p.meta.paused)return {boat:{...last.boat,vx:0,vy:0},tube:{...last.tube,vx:0,vy:0}};
    for(let i=1;i<history.length;i++)if(p.renderTime<=history[i].at){
      const a=history[i-1],b=history[i],t=clamp((p.renderTime-a.at)/Math.max(1,b.at-a.at),0,1);
      return {boat:blend(a.boat,b.boat,t),tube:blend(a.tube,b.tube,t)};
    }
    const previous=history.at(-2),elapsed=previous?(last.at-previous.at)/1000:0;
    const yaw=elapsed>0?clamp(turn(last.boat.angle,previous.boat.angle)/elapsed,-1.2,1.2):0;
    const seconds=Math.max(0,(p.renderTime-last.at)/1000);
    return {boat:predict(last.boat,seconds,yaw),tube:predict(last.tube,seconds,0)};
  }
  function display(p,now){
    const result=raw(p,now),age=Math.max(0,now-p.offsetAt);
    const weight=p.offset&&age<1000?Math.exp(-age/smoothingMs):0;
    for(const key of ['boat','tube']){
      const body=result[key],offset=p.offset?.[key];
      if(offset){for(const k of ['x','y','z','pitch','roll','angle'])body[k]=(body[k]||0)+offset[k]*weight;}
      // Smoothing is visual only. Swept shore checks also cover interpolation
      // and correction offsets so a prediction never cuts through an island.
      resolveShoreCollision(map,body,p.history.at(-1)[key],key==='boat'?Math.hypot(p.meta.length,p.meta.beam)/2:1/M);
    }
    const dx=result.tube.x-result.boat.x,dy=result.tube.y-result.boat.y,d=Math.hypot(dx,dy);
    if(d>40/M){result.tube.x=result.boat.x+dx/d*40/M;result.tube.y=result.boat.y+dy/d*40/M;
      resolveShoreCollision(map,result.tube,p.history.at(-1).tube,1/M);}
    return {...p.meta,...result};
  }
  function receive(players,{selfId,serverTime,now,rtt=0}){
    const oldViews=new Map([...peers].map(([id,p])=>[id,display(p,now)]));
    const estimate=(Number.isFinite(serverTime)?serverTime:now)+clamp(rtt/2,0,250);
    const current=serverNow(now);
    serverAnchor=initialized?current+clamp(estimate-current,-50,50)*.15:estimate;
    localAnchor=now;initialized=true;
    const seen=new Set();
    for(const q of players){
      if(q.id===selfId)continue;seen.add(q.id);
      const p=peers.get(q.id),sourceAt=Number.isFinite(q.poseAt)?q.poseAt:serverAnchor;
      const last=p?.history.at(-1);
      if(p&&((q.spawnAt??0)<(p.meta.spawnAt??0)||sourceAt<last.sourceAt))continue;
      const reset=p&&q.spawnAt!==undefined&&q.spawnAt!==p.meta.spawnAt;
      const gap=last?Math.max(0,sourceAt-last.sourceAt)/1000:0;
      const teleport=last&&Math.hypot(q.boat.x-last.boat.x,q.boat.y-last.boat.y)>Math.max(60/M,52/M*gap+10/M);
      const sample={sourceAt,at:sourceAt,boat:{...q.boat},tube:{...q.tube}};
      if(!p||reset||teleport){peers.set(q.id,{meta:q,history:[sample],delay:initialDelay});continue;}
      const changed=!sameBody(q.boat,last.boat)||!sameBody(q.tube,last.tube)||q.paused!==p.meta.paused;
      if(sourceAt===last.sourceAt&&!changed){p.meta=q;continue;}
      // A bump can change a body without changing poseAt. Give that correction
      // its observed server time rather than treating it as a duplicate.
      if(sourceAt===last.sourceAt)sample.at=Math.max(last.at+1,serverTime||serverAnchor);
      if(q.paused||p.meta.paused){p.meta=q;p.history=[sample];p.offset=null;continue;}
      if(gap>0&&gap<2)p.delay=lerp(p.delay,clamp(gap*650,minDelay,maxDelay),.15);
      p.meta=q;p.history.push(sample);if(p.history.length>12)p.history.shift();
      p.offset=null;
      const next=raw(p,now),previous=oldViews.get(q.id);p.offset={};p.offsetAt=now;
      for(const key of ['boat','tube']){
        p.offset[key]={};
        for(const k of ['x','y','z','pitch','roll'])p.offset[key][k]=(previous[key][k]||0)-(next[key][k]||0);
        p.offset[key].angle=turn(previous[key].angle,next[key].angle);
      }
    }
    for(const id of peers.keys())if(!seen.has(id))peers.delete(id);
  }
  return {receive,get:now=>[...peers.values()].map(p=>display(p,now)),clear:()=>{peers.clear();serverAnchor=0;localAnchor=0;initialized=false;}};
}
