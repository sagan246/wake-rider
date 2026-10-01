import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { nearestShore, resolveShoreCollision, BOAT_SHORE_RESPONSE } from '../physics/shore.js';
import { stepBoatBump } from '../physics/boat-bump.js';

export const MAX_BOTS = 3;
export const BOT_STEP_MS = 100;
// A loop around the main-basin launch, with at least 76 m of shoreline
// clearance along its legs. Nearby routes make finding and following wakes easy.
export const BOT_ROUTE = [
  [-1830,420],[-1740,350],[-1600,250],[-1450,220],[-1300,230],
  [-1210,280],[-1300,370],[-1430,440],[-1570,425],[-1710,470],[-1830,500]
].map(([x,y])=>({x:x/M,y:y/M}));
export const BOT_PADS = Array.from({length:9},(_,i)=>{
  const leg=i<4?0:1,t=i<4?i/4:(i-4)/5,a=BOT_ROUTE[leg],b=BOT_ROUTE[leg+1];
  return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,angle:Math.atan2(b.y-a.y,b.x-a.x),waypoint:leg+1};
});
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const angleDiff=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));

// Server-owned, deliberately small steering/tow state. No browser needs to
// volunteer as the bot host; every visitor sees the same boat and wake poses.
export function stepBot(p,players,dt){
  const b=p.boat,old={...b},towOld={...p.tube};
  let target=BOT_ROUTE[p.waypoint||0];
  if(Math.hypot(target.x-b.x,target.y-b.y)<38/M){
    p.waypoint=((p.waypoint||0)+1)%BOT_ROUTE.length;target=BOT_ROUTE[p.waypoint];
  }
  const direction=Math.atan2(target.y-b.y,target.x-b.x);
  let dx=Math.cos(direction),dy=Math.sin(direction),speed=(8.5+p.botSlot*.65)/M;
  const shore=nearestShore(lake,b.x,b.y);
  if(shore&&shore.distance<40/M){
    const weight=(40/M-shore.distance)/(15/M),d=Math.max(1,shore.distance);
    dx+=(b.x-shore.x)/d*weight;dy+=(b.y-shore.y)/d*weight;speed*=.65;
  }
  for(const other of Object.values(players)){
    if(other.id===p.id)continue;
    const ox=b.x-other.boat.x,oy=b.y-other.boat.y,d=Math.hypot(ox,oy);
    if(d<30/M&&d>1){
      const ahead=-(ox*Math.cos(b.angle)+oy*Math.sin(b.angle))/d;
      const weight=(1-d/(30/M))*(ahead>0?1.6:.4);
      dx+=ox/d*weight;dy+=oy/d*weight;
      if(ahead>.5)speed*=Math.max(.25,d/(30/M));
    }
  }
  const headingError=angleDiff(Math.atan2(dy,dx),b.angle);
  speed*=1-Math.min(.65,Math.abs(headingError)*.25);
  const turn=clamp(headingError,-.42*dt,.42*dt);
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
