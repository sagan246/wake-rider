import { getBoatProfile, DEFAULT_BOAT_ID } from '../physics/boats.js';


const base=getBoatProfile(DEFAULT_BOAT_ID).style;
const variants=new Map();
export { BOAT_OUTLINE } from '../physics/boat-hull.js';
export function boatColorStyle(color){
  if(!/^#[0-9a-f]{6}$/i.test(color||''))return base;
  if(!variants.has(color)){
    const dark='#'+color.slice(1).match(/../g).map(v=>Math.round(parseInt(v,16)*.42).toString(16).padStart(2,'0')).join('');
    variants.set(color,Object.freeze({...base,blue:color,blueDark:dark}));
  }
  return variants.get(color);
}
