import { UNITS_PER_FOOT as F } from '../physics/config.js';
import { RIDER_PROFILES } from '../simulation/defaults.js';

const SKIN='#f0bd91',TAU=Math.PI*2;
const DEFAULT_COLOR=RIDER_PROFILES.balanced.color;

// Use the original local rider artwork for everyone. Boat and tube colors
// identify players; shared-lake riders all wear the default blue vest.
export function drawTubeRiderTop(ctx,r,color=DEFAULT_COLOR){
  const s=r/(2.5*F);
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(0,-3*s,6*s,0,TAU);ctx.fill();
  ctx.fillStyle=SKIN;ctx.beginPath();ctx.arc(0,-10*s,3.8*s,0,TAU);ctx.fill();
}

// Flat mirror/Helm artwork, shared by the local and remote tubes. Let distant
// riders shrink naturally instead of giving them a different silhouette.
export function drawTubeRiderFace(ctx,r,color=DEFAULT_COLOR){
  const minimum=Math.min(1,r/5.5);
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(0,-r*.38,Math.max(2*minimum,r*.25),0,TAU);ctx.fill();
  ctx.fillStyle=SKIN;ctx.beginPath();ctx.arc(0,-r*.67,Math.max(1.4*minimum,r*.15),0,TAU);ctx.fill();
}

export function drawTubeRiderPerspective(ctx,project,tube){
  const p=project(tube.x,tube.y,tube.z||0);
  if(!p)return;
  ctx.save();ctx.translate(p.x,p.y);
  drawTubeRiderFace(ctx,Math.max(1,2.5*F*p.horizontalScale));
  ctx.restore();
}
