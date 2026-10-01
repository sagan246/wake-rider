import { boatColorStyle } from './boat-sprite.js?v=28';
import { projectWaterPolygon } from './water-perspective.js';
import { UNITS_PER_FOOT as F } from '../physics/config.js';
import { drawTubeRiderPerspective } from './tube-rider.js?v=28';
import { boatModelVertices, drawBoatModel } from './boat-model.js';
import { towPoint } from '../physics/boat.js';
import { BOAT_OUTLINE, BOAT_SPRITE_LENGTH, BOAT_SPRITE_BEAM } from '../physics/boat-hull.js';

const TAU=Math.PI*2;
function line(ctx,points,color,width=1){
  if(points.length<2)return;
  ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);
  for(const p of points.slice(1))ctx.lineTo(p.x,p.y);
  ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
}
function drawHull(ctx,project,p){
  const co=Math.cos(p.boat.angle),si=Math.sin(p.boat.angle);
  const shadow=projectWaterPolygon(project,BOAT_OUTLINE.map(([x,y])=>{
    x*=p.length/BOAT_SPRITE_LENGTH;y*=p.beam/BOAT_SPRITE_BEAM;
    return {x:p.boat.x+x*co-y*si,y:p.boat.y+x*si+y*co,z:0};
  }));
  if(shadow.length>=3){
    ctx.fillStyle='#062c404d';ctx.beginPath();ctx.moveTo(shadow[0].x,shadow[0].y);
    for(let i=1;i<shadow.length;i++)ctx.lineTo(shadow[i].x,shadow[i].y);
    ctx.closePath();ctx.fill();
  }
  drawBoatModel(ctx,boatModelVertices(p.boat,p.length,p.beam),project,project.depth,boatColorStyle(p.color),true);
}
function drawTow(ctx,project,p){
  // Shared Lake locks everyone to the same default stern ski attachment.
  line(ctx,projectWaterPolygon(project,[towPoint(p.boat),p.tube]),'#e0d49e99',1);
}
function drawTube(ctx,project,p){
  const t=project(p.tube.x,p.tube.y,p.tube.z||0),ground=project(p.tube.x,p.tube.y,0);
  if(!t)return;
  const r=Math.max(1,2.5*F*t.horizontalScale),height=Math.max(.65,r*.32);
  if(ground){ctx.fillStyle='#082b3a66';ctx.beginPath();ctx.ellipse(ground.x,ground.y,r*1.05,height*.5,0,0,TAU);ctx.fill();}
  ctx.fillStyle=p.color;ctx.strokeStyle='#153d4a';ctx.lineWidth=Math.max(.5,Math.min(1.3,r*.1));
  ctx.beginPath();ctx.ellipse(t.x,t.y-height*.3,r,height,0,0,TAU);ctx.fill();ctx.stroke();
  ctx.fillStyle='#17475c';ctx.beginPath();ctx.ellipse(t.x,t.y-height*.5,r*.38,height*.32,0,0,TAU);ctx.fill();
  if(p.tube.riderOn!==false)drawTubeRiderPerspective(ctx,project,p.tube);
}

// Flat-colored polygons, distance scaling and painter ordering give the Helm
// view and mirror the same 2.5D style as the overhead game.
export function drawPlayersPerspective(ctx,project,players){
  const bodies=[];
  for(const p of players){
    drawTow(ctx,project,p);
    bodies.push({p,body:p.boat,draw:drawHull},{p,body:p.tube,draw:drawTube});
  }
  bodies.sort((a,b)=>project.depth(b.body.x,b.body.y)-project.depth(a.body.x,a.body.y));
  for(const item of bodies){
    const depth=project.depth(item.body.x,item.body.y),margin=item.draw===drawHull?item.p.length:5*F;
    if(depth+margin<project.nearDepth||depth-margin>project.farDepth)continue;
    ctx.save();item.draw(ctx,project,item.p);ctx.restore();
  }
}
