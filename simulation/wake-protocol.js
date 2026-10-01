export const MAX_WAKE_SAMPLES = 30;
export const MAX_WAKE_SAMPLE_AGE_MS = 4000;
export const roundWake = (n,scale=10)=>Math.round(n*scale)/scale;

// Keep predicted and confirmed geometry identical, including quantization.
export function wakePose(boat){
  const angle=Math.atan2(Math.sin(boat.angle),Math.cos(boat.angle));
  const speed=Number.isFinite(boat.speed)?boat.speed:Math.max(0,boat.vx*Math.cos(angle)+boat.vy*Math.sin(angle));
  return {x:roundWake(boat.x),y:roundWake(boat.y),angle:roundWake(angle,100000),speed:roundWake(speed)};
}
