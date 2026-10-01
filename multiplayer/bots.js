import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { nearestShore, resolveShoreCollision, BOAT_SHORE_RESPONSE } from '../physics/shore.js';
import { stepBoatBump } from '../physics/boat-bump.js';
import { MAX_PLAYERS } from './room-limits.js';

export const MAX_BOTS = MAX_PLAYERS - 1;
export const BOT_STEP_MS = 100;
// A loop around the main-basin launch, with at least 76 m of shoreline
// clearance along its legs. Nearby routes make finding and following wakes easy.
export const BOT_ROUTE = [
  [-1830,420],[-1740,350],[-1600,250],[-1450,220],[-1300,230],
  [-1210,280],[-1300,370],[-1430,440],[-1570,425],[-1710,470],[-1830,500]
].map(([x,y])=>({x:x/M,y:y/M}));
const routeLengths=BOT_ROUTE.map((a,i)=>{
  const b=BOT_ROUTE[(i+1)%BOT_ROUTE.length];return Math.hypot(b.x-a.x,b.y-a.y);
});
const routeLength=routeLengths.reduce((a,b)=>a+b,0);
// First spread the fleet around the whole loop, then try interleaved fallback
// pads if a boat/tow already occupies a preferred location.
export const BOT_PADS = Array.from({length:MAX_BOTS*3},(_,i)=>{
  let distance=(i%MAX_BOTS+Math.floor(i/MAX_BOTS)/3)*routeLength/MAX_BOTS,leg=0;
  while(distance>routeLengths[leg]&&leg<routeLengths.length-1)distance-=routeLengths[leg++];
  const a=BOT_ROUTE[leg],b=BOT_ROUTE[(leg+1)%BOT_ROUTE.length],t=distance/routeLengths[leg];
  return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,angle:Math.atan2(b.y-a.y,b.x-a.x),waypoint:(leg+1)%BOT_ROUTE.length};
});
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const angleDiff=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));

// Server-owned, deliberately small steering/tow state. No browser needs to
// volunteer as the bot host; every visitor sees the same boat and wake poses.
export function stepBot(p,players,dt){
  const b=p.boat,old={...b},towOld={...p.tube};
  if(p.rideSeed===undefined){
    let seed=0;for(const char of p.id)seed=(Math.imul(seed,31)+char.charCodeAt(0))>>>0;
    // Mix the suffix thoroughly: slots 1–9 from one owner should not all
    // weave and accelerate at almost exactly the same time.
    seed=Math.imul(seed^(seed>>>16),0x7feb352d);
    seed=Math.imul(seed^(seed>>>15),0x846ca68b);
    p.rideSeed=((seed^(seed>>>16))>>>0)/4294967296;
  }
  p.rideTime=(p.rideTime||0)+dt;
  let target=BOT_ROUTE[p.waypoint||0];
  const previous=BOT_ROUTE[((p.waypoint||0)+BOT_ROUTE.length-1)%BOT_ROUTE.length];
  const passed=(b.x-target.x)*(target.x-previous.x)+(b.y-target.y)*(target.y-previous.y)>0;
  if(Math.hypot(target.x-b.x,target.y-b.y)<30/M||passed){
    p.waypoint=((p.waypoint||0)+1)%BOT_ROUTE.length;target=BOT_ROUTE[p.waypoint];
  }
  const a=BOT_ROUTE[((p.waypoint||0)+BOT_ROUTE.length-1)%BOT_ROUTE.length];
  const lx=target.x-a.x,ly=target.y-a.y,length=Math.hypot(lx,ly),fx=lx/length,fy=ly/length;
  const along=clamp((b.x-a.x)*fx+(b.y-a.y)*fy,0,length);
  const lookahead=Math.min(length,along+45/M);
  const shore=nearestShore(lake,b.x,b.y);
  let roomToPlay=shore?clamp((shore.distance*M-45)/35,0,1):1;
  let trafficPace=1;
  for(const other of Object.values(players)){
    if(other.id===p.id)continue;
    roomToPlay=Math.min(roomToPlay,clamp((Math.hypot(b.x-other.boat.x,b.y-other.boat.y)*M-25)/30,0,1));
  }
  // Aim a short distance ahead, sweeping left/right so the tow swings across
  // the wake. Ease the weave at corners, near shore and around other drivers.
  const phase=p.rideTime*2*Math.PI/(15+p.rideSeed*5)+p.rideSeed*2*Math.PI;
  const cornerEase=clamp((length-along)*M/45,0,1);
  const offset=Math.sin(phase)*(18+p.rideSeed*6)/M*roomToPlay*cornerEase;
  const direction=Math.atan2(a.y+fy*lookahead+fx*offset-b.y,a.x+fx*lookahead-fy*offset-b.x);
  let dx=Math.cos(direction),dy=Math.sin(direction);
  // Slot number never increases speed: a large fleet gets the same relaxed
  // tubing pace, with gentle independent changes instead of synchronized laps.
  let speed=(8.4+p.rideSeed+Math.sin(p.rideTime*.19+p.rideSeed*6)*.7)/M;
  if(shore&&shore.distance<40/M){
    const weight=(40/M-shore.distance)/(15/M),d=Math.max(1,shore.distance);
    dx+=(b.x-shore.x)/d*weight;dy+=(b.y-shore.y)/d*weight;speed*=.65;
  }
  for(const other of Object.values(players)){
    if(other.id===p.id)continue;
    // Yield to the whole tow corridor, not just the hull in front of it.
    const tx=other.tube.x-other.boat.x,ty=other.tube.y-other.boat.y,td=tx*tx+ty*ty;
    const t=td?clamp(((b.x-other.boat.x)*tx+(b.y-other.boat.y)*ty)/td,0,1):0;
    const ox=b.x-other.boat.x-tx*t,oy=b.y-other.boat.y-ty*t,d=Math.hypot(ox,oy);
    if(d<35/M&&d>1){
      const ahead=-(ox*Math.cos(b.angle)+oy*Math.sin(b.angle))/d;
      const weight=(1-d/(35/M))*(ahead>0?1.6:.4);
      dx+=ox/d*weight;dy+=oy/d*weight;
      if(ahead>.5)trafficPace=Math.min(trafficPace,Math.max(.3,d/(35/M)));
    }
  }
  speed*=trafficPace;
  const headingError=angleDiff(Math.atan2(dy,dx),b.angle);
  speed*=1-Math.min(.65,Math.abs(headingError)*.25);
  const towAngle=Math.abs(angleDiff(Math.atan2(b.y-p.tube.y,b.x-p.tube.x),b.angle));
  speed*=1-clamp((towAngle-.65)*.3,0,.3);
  const wantedTurn=clamp(headingError*.9,-.42,.42);
  p.botTurnRate=(p.botTurnRate||0)+(wantedTurn-(p.botTurnRate||0))*(1-Math.exp(-dt*2.5));
  const turn=p.botTurnRate*dt;
  b.angle=angleDiff(b.angle+turn,0);
  // Let received momentum carry the bot before its autopilot gradually
  // regains normal control. Steering and shore containment remain active.
  const response=1-Math.exp(-dt*1.2*stepBoatBump(b,dt));
  b.vx+=(Math.cos(b.angle)*speed-b.vx)*response;
  b.vy+=(Math.sin(b.angle)*speed-b.vy)*response;
  b.x+=b.vx*dt;b.y+=b.vy*dt;b.pitch=.025;b.roll=-turn/dt*.12;
  resolveShoreCollision(lake,b,old,Math.hypot(p.length,p.beam)/2,BOAT_SHORE_RESPONSE);
  const tow=p.tube;
  if(p.tubeBounce){
    tow.x+=p.tubeBounce.vx*dt;tow.y+=p.tubeBounce.vy*dt;
    const drag=Math.exp(-dt*(.75+.015*Math.hypot(p.tubeBounce.vx,p.tubeBounce.vy)*M));
    p.tubeBounce.vx*=drag;p.tubeBounce.vy*=drag;
    if(Math.hypot(p.tubeBounce.vx,p.tubeBounce.vy)<.05/M)p.tubeBounce=null;
  }
  const tx=b.x-tow.x,ty=b.y-tow.y,d=Math.hypot(tx,ty);
  const reach=p.ropeLength+p.length*.55;
  if(d>reach){
    tow.x=b.x-tx/d*reach;tow.y=b.y-ty/d*reach;
    // A taut rope removes outward motion, while retaining sideways swing.
    // Do not store an impossible shove and reapply it on the next bot step.
    if(p.tubeBounce){
      const outward=-(p.tubeBounce.vx*tx+p.tubeBounce.vy*ty)/d;
      if(outward>0){p.tubeBounce.vx+=tx/d*outward;p.tubeBounce.vy+=ty/d*outward;}
    }
  }
  tow.vx=(tow.x-towOld.x)/dt;tow.vy=(tow.y-towOld.y)/dt;
  tow.angle=Math.atan2(ty,tx);
  resolveShoreCollision(lake,tow,towOld,1/M);
  p.paused=false;
}
