import { METERS_PER_UNIT as M } from '../maps/catalog.js';

const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function corridorDistance(x,y,a,b){
  const dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy;
  const t=d?clamp(((x-a.x)*dx+(y-a.y)*dy)/d,0,1):0;
  return Math.hypot(x-a.x-dx*t,y-a.y-dy*t);
}

// Predict closest approach to the complete moving boat/rope/tube corridor.
// A consistent starboard pass handles reciprocal head-on encounters; a short
// maneuver hold prevents the selected side flipping as the other bow moves.
export function botTraffic(p,players,dt){
  const b=p.boat,hx=Math.cos(b.angle),hy=Math.sin(b.angle);
  const moving=Math.hypot(b.vx,b.vy)*M>.5;
  const vx=moving?b.vx:hx*5/M,vy=moving?b.vy:hy*5/M;
  let threat=0,pace=1,nearest=Infinity,steer=0,blocking=null;
  p.avoidHold=Math.max(0,(p.avoidHold||0)-dt);
  for(const other of Object.values(players)){
    if(other.id===p.id)continue;
    const a=other.boat,c=other.tube||a,dx=a.x-b.x,dy=a.y-b.y;
    const distance=corridorDistance(b.x,b.y,a,c)*M;
    nearest=Math.min(nearest,distance);
    if(Math.hypot(dx,dy)*M>125)continue;
    const forward=(dx*hx+dy*hy)*M,lateral=(-dx*hy+dy*hx)*M;
    let gap=distance,when=0;
    for(const fraction of [0,.5,1]){
      const x=a.x+(c.x-a.x)*fraction,y=a.y+(c.y-a.y)*fraction;
      const ovx=a.vx+((c.vx??a.vx)-a.vx)*fraction,ovy=a.vy+((c.vy??a.vy)-a.vy)*fraction;
      const rx=x-b.x,ry=y-b.y,rvx=ovx-vx,rvy=ovy-vy,v2=rvx*rvx+rvy*rvy;
      const t=v2?clamp(-(rx*rvx+ry*rvy)/v2,0,4):0;
      const predicted=corridorDistance(b.x+vx*t,b.y+vy*t,
        {x:a.x+a.vx*t,y:a.y+a.vy*t},{x:c.x+(c.vx??a.vx)*t,y:c.y+(c.vy??a.vy)*t})*M;
      if(predicted<gap){gap=predicted;when=t;}
    }
    const approaching=forward>-8||when>.1;
    const risk=approaching?clamp((18-gap)/16,0,1)*(1-.1*when):0;
    const close=clamp((20-distance)/17,0,1);
    const weight=Math.max(risk,close*.7);
    if(weight>threat){threat=weight;blocking=other.id;}
    if(weight<.03)continue;
    let side=Math.abs(lateral)>6?(lateral>0?-1:1):1;
    if(p.avoidHold&&p.avoidBoat===other.id)side=p.avoidSide;
    else if(weight>.2){p.avoidBoat=other.id;p.avoidSide=side;p.avoidHold=2.5;}
    steer+=side*weight;
    if(forward>-8){
      // Crossing traffic on our right gets room to pass in front. For a boat
      // already behind us, steer clear without stopping in its path.
      const crossing=Math.abs(Math.cos(a.angle-b.angle))<.65&&lateral>0;
      pace=Math.min(pace,clamp(1-weight*(crossing?1:.78),.08,1));
      if(distance<12&&forward>0)pace=Math.min(pace,.12);
    }
  }
  return {steer:clamp(steer,-1.8,1.8),pace,threat,nearest,blocking};
}
