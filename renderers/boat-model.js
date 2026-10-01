import { BOAT_OUTLINE, BOAT_SPRITE_LENGTH, BOAT_SPRITE_BEAM } from '../physics/boat-hull.js';
import { projectWaterPolygon } from './water-perspective.js';

// One small, flat-colored mesh for every camera. Bow +X, starboard +Y, up +Z.
// The hull keeps the collision outline; the swim step is inset at the stern.
const vertices=[],faces=[],indices=new Map();
function face(points,material,edge=true){
  const ids=points.map(p=>{
    const key=p.join(',');
    if(!indices.has(key)){indices.set(key,vertices.length);vertices.push(p);}
    return indices.get(key);
  });
  faces.push({ids,material,edge});
}
function join(a,b,material,edge=false){
  for(let i=0;i<a.length;i++){
    const j=(i+1)%a.length;
    face([a[i],a[j],b[j],b[i]],typeof material==='function'?material(i):material,edge);
  }
}
const ring=(sx,sy,z)=>BOAT_OUTLINE.map(([x,y])=>[x*sx,y*sy,z+(x>15?(x-15)/20*.9:0)]);
const water=ring(.94,.88,0),stripeLow=ring(.965,.94,2),stripeHigh=ring(.985,.98,3.7);
const sheer=ring(1,1,6),inner=ring(.91,.77,6),floor=ring(.87,.73,3.7);
join(water,stripeLow,'side');
join(stripeLow,stripeHigh,'blue');
join(stripeHigh,sheer,'hull');
join(sheer,inner,i=>[1,2,3,7,8,9].includes(i)?'blue':'hull',true);
join(inner,floor,'side');
face([...floor].reverse(),'floor',false);
function slab(points,z0,z1,top='seat',side='seatSide'){
  const a=points.map(([x,y])=>[x,y,z0]),b=points.map(([x,y])=>[x,y,z1]);
  join(a,b,side);face(b,top);
}
const box=(x0,x1,y0,y1,z0,z1,color='seat')=>slab([[x0,y0],[x1,y0],[x1,y1],[x0,y1]],z0,z1,color);
// Aft bench, side lounges, helm seats, then the open bow seating.
box(-30,-20,-9,9,3.8,6.6);box(-30,-27,-10,10,6.6,9.2);
box(-21,-7,-11.6,-7,3.8,6.4);box(-21,-7,7,11.6,3.8,6.4);
box(-21,-7,-12,-10.3,6.4,8.4);box(-21,-7,10.3,12,6.4,8.4);
box(-4,3,-9,-3.6,3.8,6.9);box(-4,-2,-9.4,-3.2,6.9,10);
box(-4,3,3.6,9,3.8,6.9);box(-4,-2,3.2,9.4,6.9,10);
slab([[7,-10.2],[18,-8.2],[26,-3.3],[20,-2.7],[13,-5.4],[7,-5.5]],3.8,6.8);
slab([[7,10.2],[18,8.2],[26,3.3],[20,2.7],[13,5.4],[7,5.5]],3.8,6.8);
slab([[26,-3.3],[31,0],[26,3.3],[22,2],[22,-2]],3.8,6.8);
box(-33,-30,-8.7,8.7,6,6.7);
slab([[-31,-8.5],[-35,-7.5],[-35,7.5],[-31,8.5]],.8,1.6,'side','trim');
const panels=[
  [[11,-2,6.6],[10,-10,6.6],[6,-8.8,12],[7,-2,12]],
  [[10,-10,6.6],[2,-10.6,6.6],[1,-9.5,10.8],[6,-8.8,12]],
  [[11,2,6.6],[10,10,6.6],[6,8.8,12],[7,2,12]],
  [[10,10,6.6],[2,10.6,6.6],[1,9.5,10.8],[6,8.8,12]]
];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function bar(a,b,width){
  const d=b.map((v,i)=>v-a[i]),n=Math.hypot(...d),u=d.map(v=>v/n);
  let v=cross(u,Math.abs(u[2])>.9?[0,1,0]:[0,0,1]);
  const vn=Math.hypot(...v);v=v.map(x=>x/vn);const w=cross(u,v);
  const ends=[a,b].map(p=>[[1,1],[-1,1],[-1,-1],[1,-1]].map(([s,t])=>p.map((x,i)=>x+(s*v[i]+t*w[i])*width/2)));
  join(ends[0],ends[1],'trim');face(ends[1],'trim',false);
}
for(const p of panels){face(p,'glass');bar(p[2],p[3],.48);bar(p[0],p[3],.42);}

export const BOAT_MODEL=Object.freeze({
  vertices:Object.freeze(vertices.map(v=>Object.freeze(v))),
  faces:Object.freeze(faces.map(f=>Object.freeze({...f,ids:Object.freeze(f.ids)})))
});
const palettes=new WeakMap();
function palette(style){
  if(!palettes.has(style))palettes.set(style,{
    ...style,side:'#dce6e4',floor:'#abbdbc',seatSide:'#d5dace',glass:'#9bd0d8'
  });
  return palettes.get(style);
}

export function boatModelVertices(boat,length,beam){
  const ls=length/BOAT_SPRITE_LENGTH,bs=beam/BOAT_SPRITE_BEAM;
  const cr=Math.cos(boat.roll||0),sr=Math.sin(boat.roll||0),cp=Math.cos(boat.pitch||0),sp=Math.sin(boat.pitch||0);
  const ca=Math.cos(boat.angle),sa=Math.sin(boat.angle);
  return vertices.map(([x,y,z])=>{
    x*=ls;y*=bs;z*=ls;
    const yr=y*cr-z*sr,zr=y*sr+z*cr,xp=x*cp-zr*sp,zp=x*sp+zr*cp;
    return {x:boat.x+xp*ca-yr*sa,y:boat.y+xp*sa+yr*ca,z:(boat.z||0)+zp};
  });
}

// Static geometry is indexed once, so shared vertices project once per boat.
export function drawBoatModel(ctx,world,project,depth,style,perspective=false){
  const colors=palette(style),points=world.map(p=>project(p.x,p.y,p.z));
  const depths=world.map(p=>depth(p.x,p.y,p.z));
  const ordered=faces.map((f,index)=>({f,index,d:f.ids.reduce((s,i)=>s+depths[i],0)/f.ids.length}));
  // The cockpit floor spans the whole open cavity. Painting it by centroid
  // depth would incorrectly cover far-side seats, despite sitting below them.
  ordered.sort((a,b)=>(a.f.material==='floor'?-1:b.f.material==='floor'?1:0)||b.d-a.d||a.index-b.index);
  ctx.lineJoin='round';
  for(const {f} of ordered){
    let polygon=f.ids.map(i=>points[i]);
    if(polygon.some(p=>!p)){
      if(!perspective)continue;
      polygon=projectWaterPolygon(project,f.ids.map(i=>world[i]));
    }
    if(polygon.length<3)continue;
    ctx.beginPath();ctx.moveTo(polygon[0].x,polygon[0].y);
    for(let i=1;i<polygon.length;i++)ctx.lineTo(polygon[i].x,polygon[i].y);
    ctx.closePath();ctx.fillStyle=colors[f.material];ctx.fill();
    // A same-color seam seals antialias cracks between the hull's flat bands.
    ctx.strokeStyle=f.edge?colors.trim:colors[f.material];
    const scale=polygon[0].horizontalScale??polygon[0].scale??1;
    ctx.lineWidth=f.edge?Math.max(.35,Math.min(1.2,scale*.7)):.5;
    ctx.stroke();
  }
}

export function drawBoatTop(ctx,screen,boat,length,beam,style){
  const origin=screen(boat.x,boat.y),height=.22;
  const project=(x,y,z)=>{const p=screen(x,y);return {...p,y:p.y-((boat.z||0)+(z-(boat.z||0))*height)*p.scale};};
  // Almost overhead: raised features have a slight offset, preserving the 2D
  // silhouette. Sort along this same camera axis so the deck stays open.
  const depth=(x,y,z)=>-((screen(x,y).y-origin.y)/origin.scale*height+z);
  drawBoatModel(ctx,boatModelVertices(boat,length,beam),project,depth,style);
}
