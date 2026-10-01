import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { isWater, nearestShore } from '../physics/shore.js';
import { botRandom } from './bot-personality.js';
import { BOT_NODES, BOT_LINKS } from './bot-routes.js';

const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const neighbors=BOT_NODES.map(()=>[]);
for(const [a,b,clearance] of BOT_LINKS){
  const length=distance(BOT_NODES[a],BOT_NODES[b]);
  neighbors[a].push({id:b,length,clearance});neighbors[b].push({id:a,length,clearance});
}
const paths=new Map();
function routesFrom(start){
  if(paths.has(start))return paths.get(start);
  const costs=BOT_NODES.map(()=>Infinity),previous=BOT_NODES.map(()=>null),done=new Set();costs[start]=0;
  while(done.size<BOT_NODES.length){
    let next=-1;for(let i=0;i<costs.length;i++)if(!done.has(i)&&(next<0||costs[i]<costs[next]))next=i;
    if(next<0||!Number.isFinite(costs[next]))break;
    done.add(next);
    for(const edge of neighbors[next])if(costs[next]+edge.length<costs[edge.id]){
      costs[edge.id]=costs[next]+edge.length;previous[edge.id]=next;
    }
  }
  const result={costs,previous};paths.set(start,result);return result;
}
// Used only on launch or after a large knock off the route, never per neighbor
// per tick. Sample spacing includes a margin for the interval between samples.
function connectorClearance(a,b){
  const steps=Math.max(1,Math.ceil(distance(a,b)*M/8));
  const margin=distance(a,b)*M/(steps*2);let clearance=Infinity;
  for(let i=0;i<=steps;i++){
    const x=a.x+(b.x-a.x)*i/steps,y=a.y+(b.y-a.y)*i/steps;
    if(!isWater(lake,x,y))return null;
    clearance=Math.min(clearance,nearestShore(lake,x,y).distance*M-margin);
    if(clearance<8)return null;
  }
  return clearance;
}
function nearestVisible(b){
  const candidates=BOT_NODES.map((node,id)=>({id,d:distance(b,node)})).sort((a,c)=>a.d-c.d);
  for(const candidate of candidates){const clearance=connectorClearance(b,BOT_NODES[candidate.id]);if(clearance!==null)return {id:candidate.id,clearance};}
  return null;
}
function newJourney(p,start,players){
  const nav=p.navigation,{costs,previous}=routesFrom(start);nav.trip++;
  const goals=BOT_NODES.map((node,id)=>({node,id})).filter(({node,id})=>node.goal&&id!==start&&Number.isFinite(costs[id]));
  let best=null,score=-Infinity;
  for(const option of goals){
    const incoming=Object.values(players).filter(other=>other.id!==p.id&&other.navigation?.goal!=null
      &&BOT_NODES[other.navigation.goal]?.region===option.node.region).length;
    const rank=-(nav.visits[option.node.region]||0)*10+botRandom(p.id,`trip-${nav.trip}-${option.id}`)*3
      +Math.min(1,costs[option.id]*M/2500)*(p.driver.name==='Explorer'?2:1)-incoming*1.5;
    if(rank>score){score=rank;best=option;}
  }
  if(!best)return;
  const path=[];for(let id=best.id;id!==start;id=previous[id])path.unshift(id);
  nav.path=path;nav.from=start;nav.goal=best.id;nav.bestDistance=Infinity;nav.stuckTime=0;
}
export function botRoute(p,players,dt,shore,play){
  const b=p.boat;
  if(!p.navigation){
    p.navigation={path:[],from:{x:b.x,y:b.y},goal:null,trip:0,visits:{},bestDistance:Infinity,stuckTime:0};
  }
  const nav=p.navigation;
  const escape={angle:shore?Math.atan2(shore.ny,shore.nx):b.angle,speedLimit:2.5,clearance:shore?.distance*M||0};
  if(!nav.path.length){
    // A shove may put the hull closer to shore than the route's margin. Move
    // gently into water and retry; never substitute an occluded straight leg.
    if(p.rideTime>=(nav.retryAt||0)){
      const next=nearestVisible(b);nav.retryAt=p.rideTime+2;
      if(next!==null){nav.path=[next.id];nav.connectorClearance=next.clearance;nav.from={x:b.x,y:b.y};nav.goal=null;nav.bestDistance=Infinity;nav.stuckTime=0;}
    }
    if(!nav.path.length)return escape;
  }
  let target=BOT_NODES[nav.path[0]],a=typeof nav.from==='number'?BOT_NODES[nav.from]:nav.from;
  let edge=typeof nav.from==='number'?neighbors[nav.from].find(e=>e.id===nav.path[0]):null;
  let clearance=Math.min(target.clearance,edge?.clearance??nav.connectorClearance);
  const gap=distance(b,target),arrival=clamp(clearance*.3,5,18)/M;
  const leg=distance(a,target),cross=leg?Math.abs((b.x-a.x)*(target.y-a.y)-(b.y-a.y)*(target.x-a.x))/leg:0;
  const passed=(b.x-target.x)*(target.x-a.x)+(b.y-target.y)*(target.y-a.y)>0;
  if(!p.botSpin&&(gap<arrival||(passed&&gap<30/M&&cross<arrival))){
    const reached=nav.path.shift();nav.from=reached;nav.bestDistance=Infinity;nav.stuckTime=0;
    if(!nav.path.length){
      if(nav.goal!==null){const region=BOT_NODES[nav.goal].region;nav.visits[region]=(nav.visits[region]||0)+1;}
      newJourney(p,reached,players);
    }
    target=BOT_NODES[nav.path[0]];a=BOT_NODES[nav.from];
    edge=neighbors[nav.from].find(e=>e.id===nav.path[0]);clearance=Math.min(target.clearance,edge?.clearance??target.clearance);
  }
  // A traffic hold is temporary; after a prolonged lack of route progress,
  // recover onto a visible corridor instead of circling the same obstruction.
  if(!p.botSpin){
    const remaining=distance(b,target);
    if(remaining<nav.bestDistance-3/M){nav.bestDistance=remaining;nav.stuckTime=0;}else nav.stuckTime+=dt;
    if(nav.stuckTime>24){
      nav.path=[];nav.retryAt=0;
      nav.recoveries=(nav.recoveries||0)+1;
      return escape;
    }
  }
  const lx=target.x-a.x,ly=target.y-a.y,length=Math.max(1,distance(a,target)),fx=lx/length,fy=ly/length;
  const along=clamp((b.x-a.x)*fx+(b.y-a.y)*fy,0,length);
  const tight=Math.min(clearance,shore?shore.distance*M:clearance);
  const look=clamp(tight*.6,10,45)/M;
  const ahead=Math.min(length,along+look);
  const corner=clamp((length-along)*M/50,0,1);
  const weave=Math.sin(p.rideTime*Math.PI*2/p.driver.period+p.driver.phase)*p.driver.weave/M
    *play*corner*clamp((tight-35)/45,0,1);
  // Keep a modest starboard lane even when weaving is off. Opposing tows can
  // pass in an arm instead of forming two queues on the same centerline.
  const lane=clamp((tight-18)*.7,0,8)/M;
  const x=a.x+fx*ahead-fy*(lane+weave),y=a.y+fy*ahead+fx*(lane+weave);
  return {angle:Math.atan2(y-b.y,x-b.x),speedLimit:clamp((tight-8)*.16,2.5,11),clearance:tight};
}
