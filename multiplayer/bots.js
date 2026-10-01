import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { nearestShore, resolveShoreCollision, BOAT_SHORE_RESPONSE } from '../physics/shore.js';
import { stepBoatBump } from '../physics/boat-bump.js';
import { MAX_PLAYERS } from './room-limits.js';
import { botPersonality, botRandom } from './bot-personality.js';
import { botRoute } from './bot-navigation.js';
import { botTraffic } from './bot-traffic.js';

export const MAX_BOTS = MAX_PLAYERS - 1;
export const BOT_STEP_MS = 100;
// Safe main-basin launch positions. Once moving, drivers choose journeys on
// the wider lake graph instead of all following this launch loop.
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
  const driver=botPersonality(p);
  p.rideTime=(p.rideTime||0)+dt;
  const shore=nearestShore(lake,b.x,b.y);
  const traffic=botTraffic(p,players,dt);
  const play=clamp((traffic.nearest-30)/45,0,1)*(1-traffic.threat);
  const route=botRoute(p,players,dt,shore,play);
  let dx=Math.cos(route.angle)-Math.sin(b.angle)*traffic.steer*1.8;
  let dy=Math.sin(route.angle)+Math.cos(b.angle)*traffic.steer*1.8;
  let speed=Math.min(route.speedLimit,driver.speed+Math.sin(p.rideTime*.17+driver.phase)*.6)/M;
  if(shore&&shore.distance<32/M){
    const weight=(32-shore.distance*M)/12;
    dx+=shore.nx*weight;dy+=shore.ny*weight;speed*=.65;
  }
  speed*=traffic.pace;
  const headingError=angleDiff(Math.atan2(dy,dx),b.angle);
  speed*=1-Math.min(.65,Math.abs(headingError)*.25);
  const towAngle=Math.abs(angleDiff(Math.atan2(b.y-p.tube.y,b.x-p.tube.x),b.angle));
  speed*=1-clamp((towAngle-.65)*.3,0,.3);
  let wantedTurn=clamp(headingError*.9,-.42,.42);
  p.nextSpinAt??=25+botRandom(p.id,'first-spin')*driver.spinDelay;
  const spinSafe=shore&&shore.distance*M>90&&traffic.nearest>100&&!b.bumpGlideTime;
  if(!p.botSpin&&p.rideTime>=p.nextSpinAt&&spinSafe&&Math.abs(headingError)<.35){
    p.botSpin={remaining:Math.PI*2,direction:botRandom(p.id,`spin-${p.spinCount||0}`)>.5?1:-1};
  }
  if(p.botSpin&&(traffic.nearest<65||traffic.threat>.12||shore.distance*M<45||b.bumpGlideTime)){
    p.botSpin=null;p.nextSpinAt=p.rideTime+driver.spinDelay*.5;
  }
  p.botMode=p.botSpin?'spin':traffic.threat>.15?'yield':'explore';
  if(p.botSpin){wantedTurn=p.botSpin.direction*.4;speed=5.5/M;}
  p.botTurnRate=(p.botTurnRate||0)+(wantedTurn-(p.botTurnRate||0))*(1-Math.exp(-dt*2.5));
  const turn=p.botTurnRate*dt;
  if(p.botSpin){
    p.botSpin.remaining-=Math.max(0,turn*p.botSpin.direction);
    if(p.botSpin.remaining<=0){p.botSpin=null;p.spinCount=(p.spinCount||0)+1;p.nextSpinAt=p.rideTime+driver.spinDelay;}
  }
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
