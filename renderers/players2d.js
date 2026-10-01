import { boatColorStyle } from './boat-sprite.js?v=28';
import { drawTubeRiderTop } from './tube-rider.js?v=28';
import { drawBoatTop } from './boat-model.js';
import { towPoint } from '../physics/boat.js';
import { UNITS_PER_FOOT as F } from '../physics/config.js';

export function drawPlayers2D(ctx,project,players,width,height,labels=true){
  for(const p of players){
    const b=project(p.boat.x,p.boat.y),t=project(p.tube.x,p.tube.y);
    // In overhead views project has no height input; perspective views do.
    const raised=(body,ground)=>{const point=project(body.x,body.y,body.z||0);if(point&&point.groundY===undefined)point.y-=(body.z||0)*point.scale;return point||ground;};
    const boatPoint=b&&raised(p.boat,b),tubePoint=t&&raised(p.tube,t);
    const tow=towPoint(p.boat),towPoint2D=raised({...tow,z:tow.baseZ+(tow.z-tow.baseZ)*.3},b);
    if(towPoint2D&&tubePoint){ctx.strokeStyle='#e0d49e99';ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(towPoint2D.x,towPoint2D.y);ctx.lineTo(tubePoint.x,tubePoint.y);ctx.stroke();}
    if(tubePoint){
      const r=Math.max(2,2.5*F*tubePoint.scale);
      if(tubePoint.x>=-r&&tubePoint.x<=width+r&&tubePoint.y>=-r&&tubePoint.y<=height+r){
        const tip=project(p.tube.x+Math.cos(p.tube.angle)*10,p.tube.y+Math.sin(p.tube.angle)*10);
        const angle=tip?Math.atan2(tip.y-t.y,tip.x-t.x):p.tube.angle;
        ctx.fillStyle='#041f2b55';ctx.beginPath();ctx.ellipse(t.x,t.y,r*1.08,r*.5,0,0,Math.PI*2);ctx.fill();
        ctx.save();ctx.translate(tubePoint.x,tubePoint.y);ctx.rotate(angle);
        ctx.fillStyle=p.color;ctx.strokeStyle='#153d4a';ctx.lineWidth=Math.max(.8,Math.min(2,r*.14));
        ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.fillStyle='#17475c';ctx.beginPath();ctx.arc(0,0,r*.38,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle='#ecf6e7bb';ctx.lineWidth=Math.max(.6,r*.08);ctx.beginPath();ctx.moveTo(r*.72,-r*.48);ctx.lineTo(r*.5,-r*.33);ctx.moveTo(r*.72,r*.48);ctx.lineTo(r*.5,r*.33);ctx.stroke();
        if(p.tube.riderOn!==false)drawTubeRiderTop(ctx,r);
        ctx.restore();
      }
    }
    // A visible tube/rider must not disappear when its boat leaves the frame.
    if(!boatPoint)continue;
    const length=p.length*b.scale;
    if(boatPoint.x < -length || boatPoint.x>width+length || boatPoint.y < -length || boatPoint.y>height+length)continue;
    ctx.save();drawBoatTop(ctx,project,p.boat,p.length,p.beam,boatColorStyle(p.color));ctx.restore();
    if(labels){ctx.save();ctx.font='600 11px system-ui';ctx.textAlign='center';const y=b.y-Math.max(length*.65,20);ctx.fillStyle='#082e3de6';ctx.fillRect(b.x-ctx.measureText(p.name).width/2-7,y-12,ctx.measureText(p.name).width+14,19);ctx.fillStyle=p.color;ctx.fillText(p.name,b.x,y+1);ctx.restore();}
  }
}
