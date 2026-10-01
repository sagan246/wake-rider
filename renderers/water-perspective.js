// The existing canvas water/mirror projection, shared by scenery and boats.
export function createWaterProjector({tow,fx,fy,rx,ry,centerX,horizon,bottom,near,focal,verticalFocal,fullScreen,range,physicalHeight=false}){
  const depth=(x,y)=>-((x-tow.x)*fx+(y-tow.y)*fy);
  const project=(x,y,z=0)=>{
    const back=depth(x,y),lateral=(x-tow.x)*rx+(y-tow.y)*ry;
    if(back<(fullScreen?0:-8)||back>range)return null;
    const d=Math.max(0,back),perspective=near/(d+near),groundY=horizon+(bottom-horizon)*perspective;
    const heightScale=fullScreen||physicalHeight?verticalFocal/(d+near):perspective*.66;
    return {x:centerX-lateral*focal/(d+near),y:groundY-z*heightScale,groundY,
      scale:fullScreen?focal/(d+near):perspective,horizontalScale:focal/(d+near),heightScale,back:d};
  };
  project.depth=depth;project.nearDepth=fullScreen?0:-8;project.farDepth=range;
  project.heading=angle=>({co:-Math.cos(angle)*rx-Math.sin(angle)*ry,si:Math.cos(angle)*fx+Math.sin(angle)*fy});
  return project;
}

// Clip in world coordinates before division. A nearby hull can straddle the
// camera plane without vanishing or stretching across the whole screen.
export function projectWaterPolygon(project,points){
  let clipped=points;
  for(const [limit,sign] of [[project.nearDepth,1],[project.farDepth,-1]]){
    const next=[];
    for(let i=0;i<clipped.length;i++){
      const a=clipped[i],b=clipped[(i+1)%clipped.length];
      const da=(project.depth(a.x,a.y)-limit)*sign,db=(project.depth(b.x,b.y)-limit)*sign;
      if(da>=0)next.push(a);
      if((da>=0)!==(db>=0)){
        const t=da/(da-db),epsilon=1e-7;
        // Nudge toward the visible endpoint to avoid floating point rejection.
        const u=Math.max(0,Math.min(1,t+(da>=0?-epsilon:epsilon)));
        next.push({x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u,z:(a.z||0)+((b.z||0)-(a.z||0))*u});
      }
    }
    clipped=next;
  }
  return clipped.map(p=>project(p.x,p.y,p.z)).filter(Boolean);
}
