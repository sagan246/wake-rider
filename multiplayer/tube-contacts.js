import { SHARED_LAKE_RULES as rules } from '../simulation/defaults.js';
import { MPH_PER_UNIT, UNITS_PER_FOOT } from '../physics/config.js';
import { tubeReboundSpeed } from '../physics/tube-impact.js';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const mix=(a,b,t)=>a+(b-a)*t;
const angleDiff=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));

// First entry into a capsule expanded by the tube radius. Sampling the nearest
// point alone misses fast crossings, or incorrectly pushes out the far side.
function capsuleEntry(a,b,axis,radius){
  const dx=b.x-a.x,dy=b.y-a.y;
  const ax=clamp(a.x,-axis,axis),sx=a.x-ax,sy=a.y;
  if(sx*sx+sy*sy<=radius*radius){
    const d=Math.hypot(sx,sy);
    // On the center axis, longitudinal normals can land inside another part
    // of the hull. A lateral exit is always on the capsule's outer surface.
    const nx=d>1e-8?sx/d:0;
    const ny=d>1e-8?sy/d:(dy>0?-1:1);
    return {t:0,x:ax+nx*radius,y:ny*radius,nx,ny};
  }
  const hits=[];
  if(Math.abs(dy)>1e-8)for(const sign of [-1,1]){
    const t=(sign*radius-a.y)/dy,x=a.x+dx*t;
    if(t>=0&&t<=1&&Math.abs(x)<=axis&&dy*sign<0)hits.push({t,x,y:sign*radius,nx:0,ny:sign});
  }
  const aa=dx*dx+dy*dy;
  if(aa>1e-8)for(const sign of [-1,1]){
    const cx=sign*axis,rx=a.x-cx,bb=2*(rx*dx+a.y*dy),cc=rx*rx+a.y*a.y-radius*radius;
    const disc=bb*bb-4*aa*cc;
    if(disc<0)continue;
    const t=(-bb-Math.sqrt(disc))/(2*aa),x=a.x+dx*t,y=a.y+dy*t;
    if(t>=0&&t<=1&&(x-cx)*sign>=-1e-8)hits.push({t,x,y,nx:(x-cx)/radius,ny:y/radius});
  }
  return hits.sort((a,b)=>a.t-b.t)[0]||null;
}

export function sweptTubeHull(tube,previousTube,boat,previousBoat,length=rules.length,beam=rules.beam){
  const axis=Math.max(0,(length-beam)/2),radius=beam/2+rules.tubeRadius;
  // Only sweep the part of the interval in which the tube is low enough to hit.
  const z0=(previousTube.z||0)-(previousBoat.z||0),z1=(tube.z||0)-(boat.z||0),dz=z1-z0;
  let lo=0,hi=1;
  if(Math.abs(dz)<1e-8){if(Math.abs(z0)>rules.tubeClearance)return null;}
  else{
    const a=(-rules.tubeClearance-z0)/dz,b=(rules.tubeClearance-z0)/dz;
    lo=Math.max(0,Math.min(a,b));hi=Math.min(1,Math.max(a,b));
    if(lo>hi)return null;
  }
  const turn=angleDiff(boat.angle,previousBoat.angle);
  const local=t=>{
    const angle=previousBoat.angle+turn*t,c=Math.cos(angle),s=Math.sin(angle);
    const x=mix(previousTube.x,tube.x,t)-mix(previousBoat.x,boat.x,t);
    const y=mix(previousTube.y,tube.y,t)-mix(previousBoat.y,boat.y,t);
    return {x:x*c+y*s,y:-x*s+y*c};
  };
  const steps=Math.max(1,Math.ceil(Math.abs(turn)*(hi-lo)/.08));
  for(let i=0;i<steps;i++){
    const from=mix(lo,hi,i/steps),to=mix(lo,hi,(i+1)/steps);
    const hit=capsuleEntry(local(from),local(to),axis,radius);
    if(!hit)continue;
    // Carry the entry-side surface with the boat to its current pose. This also
    // handles a moving boat hitting a stationary tube between HTTP updates.
    const c=Math.cos(boat.angle),s=Math.sin(boat.angle),skin=.04*UNITS_PER_FOOT;
    const nx=hit.nx*c-hit.ny*s,ny=hit.nx*s+hit.ny*c;
    return {x:boat.x+hit.x*c-hit.y*s+nx*skin,y:boat.y+hit.x*s+hit.y*c+ny*skin,nx,ny,t:mix(from,to,hit.t)};
  }
  return null;
}

export function tubeContactResponse(tube,previousTube,boat,previousBoat,length=rules.length,beam=rules.beam){
  const hit=sweptTubeHull(tube,previousTube,boat,previousBoat,length,beam);
  if(!hit)return null;
  const relative=(tube.vx-boat.vx)*hit.nx+(tube.vy-boat.vy)*hit.ny;
  // Already separating from a previous impact: allow departure instead of
  // rewinding an outgoing tube to the beginning of the sample interval.
  const c=Math.cos(boat.angle),s=Math.sin(boat.angle),rx=tube.x-boat.x,ry=tube.y-boat.y;
  const x=rx*c+ry*s,y=-rx*s+ry*c,axis=Math.max(0,(length-beam)/2);
  const rotatingEntry=hit.t>1e-8&&Math.abs(angleDiff(boat.angle,previousBoat.angle))>1e-5;
  if(relative>=0&&!rotatingEntry&&Math.hypot(x-clamp(x,-axis,axis),y)>=beam/2+rules.tubeRadius)return null;
  const tubeMass=tube.riderOn===false?rules.emptyTubeMass:rules.loadedTubeMass;
  const approach=Math.max(0,-relative);
  const impulse=(approach+tubeReboundSpeed(approach))/(1/tubeMass+1/rules.boatMass);
  // Keep tangential travel from this interval. Rewinding to the entry point
  // made a tube slide backward along the hull during a glancing impact.
  const push=Math.max(0,(hit.x-tube.x)*hit.nx+(hit.y-tube.y)*hit.ny);
  return {
    tube:{dx:hit.nx*push,dy:hit.ny*push,dvx:hit.nx*impulse/tubeMass,dvy:hit.ny*impulse/tubeMass,
      normalX:hit.nx,normalY:hit.ny,impact:clamp(-relative*MPH_PER_UNIT/28,0,1)},
    boat:{dvx:-hit.nx*impulse/rules.boatMass,dvy:-hit.ny*impulse/rules.boatMass}
  };
}

export function tubeTubeContactResponse(a,previousA,b,previousB){
  const radius=2*rules.tubeRadius;
  const z0=(previousA.z||0)-(previousB.z||0),z1=(a.z||0)-(b.z||0),dz=z1-z0;
  let lo=0,hi=1;
  if(Math.abs(dz)<1e-8){if(Math.abs(z0)>rules.tubeTubeClearance)return null;}
  else{
    const t0=(-rules.tubeTubeClearance-z0)/dz,t1=(rules.tubeTubeClearance-z0)/dz;
    lo=Math.max(0,Math.min(t0,t1));hi=Math.min(1,Math.max(t0,t1));
    if(lo>hi)return null;
  }
  const sx=previousA.x-previousB.x,sy=previousA.y-previousB.y;
  const dx=a.x-b.x-sx,dy=a.y-b.y-sy;
  const x=sx+dx*lo,y=sy+dy*lo,cc=x*x+y*y-radius*radius;
  let at=lo;
  if(cc>0){
    const aa=dx*dx+dy*dy,bb=2*(x*dx+y*dy),disc=bb*bb-4*aa*cc;
    if(aa<1e-8||disc<0)return null;
    const t=(-bb-Math.sqrt(disc))/(2*aa);
    if(t<0||t>hi-lo)return null;
    at=lo+t;
  }
  let nx=sx+dx*at,ny=sy+dy*at,d=Math.hypot(nx,ny);
  if(d<1e-8){nx=b.vx-a.vx;ny=b.vy-a.vy;d=Math.hypot(nx,ny);}
  if(d<1e-8){nx=1;ny=0;d=1;}
  nx/=d;ny/=d;
  const closing=(a.vx-b.vx)*nx+(a.vy-b.vy)*ny;
  if(closing>=0&&Math.hypot(a.x-b.x,a.y-b.y)>=radius)return null;
  const massA=a.riderOn===false?rules.emptyTubeMass:rules.loadedTubeMass;
  const massB=b.riderOn===false?rules.emptyTubeMass:rules.loadedTubeMass;
  const inverseA=1/massA,inverseB=1/massB,total=inverseA+inverseB;
  // Inflatable tubes rebound more softly than a rigid ball. Equal/opposite
  // impulses conserve momentum; a lighter, empty tube gets pushed farther.
  const approach=Math.max(0,-closing);
  const impulse=(approach+tubeReboundSpeed(approach,true))/total;
  const push=Math.max(0,radius+.04*UNITS_PER_FOOT-((a.x-b.x)*nx+(a.y-b.y)*ny));
  const impact=clamp(-closing*MPH_PER_UNIT/28,0,1);
  const change=(sign,inverse)=>({dx:nx*push*inverse/total*sign,dy:ny*push*inverse/total*sign,
    dvx:nx*impulse*inverse*sign,dvy:ny*impulse*inverse*sign,normalX:nx*sign,normalY:ny*sign,impact});
  return {a:change(1,inverseA),b:change(-1,inverseB)};
}
