import { METERS_PER_UNIT as M } from '../maps/catalog.js';

// Surveyed against the game's exact shoreline and islands. Clearances are
// meters; tests validate every corridor, including the space between samples.
// The northeast bay has its own patrols: the connecting neck is only about
// 8 m wide, too tight for reliable two-way traffic with a full tow.
export const BOT_NODES=[
  ['w0',-2880,810,'west',40,true],['w1',-2740,720,'west',115],
  ['w2',-2510,540,'west',100],['w3',-2290,520,'west',146],
  ['w4',-2340,760,'west',117,true],['w5',-2700,810,'west',41],['w6',-2540,700,'west',93],
  ['c0',-2040,470,'main',127],['c1',-1850,550,'main',121,true],
  ['c2',-1730,350,'main',138],['c3',-1500,330,'main',178],
  ['c4',-1430,450,'main',101,true],['c5',-1250,310,'main',93],['c6',-1650,420,'main',116],
  ['m0',-1060,200,'middle',99],['m1',-1150,280,'middle',74],['m2',-880,60,'middle',165],
  ['m3',-850,-170,'north-cove',59,true],['m4',-670,-70,'middle',88,true],
  ['m5',-470,-150,'middle',107],['m6',-420,-270,'north-cove',45,true],
  ['m7',-250,-200,'middle',145],['m8',-50,-180,'middle',141],
  ['e0',220,-270,'east',78],['e1',340,-310,'east',61,true],['e2',100,-70,'east',147],
  ['s0',280,20,'southeast',76],['s1',450,70,'southeast',56],['s2',660,100,'southeast',56],
  ['s3',820,110,'southeast',38],['s4',980,80,'southeast',30,true],
  ['n0',740,-345,'northeast',68,true],['n1',880,-420,'northeast',56],
  ['n2',1110,-485,'northeast',74,true],['n3',970,-345,'northeast',53,true]
].map(([id,x,y,region,clearance,goal=false])=>({id,x:x/M,y:y/M,region,clearance,goal}));
const ids=new Map(BOT_NODES.map((n,i)=>[n.id,i]));
export const BOT_LINKS=[
  ['w0','w1',31],['w1','w2',93],['w2','w3',100],['w3','c0',127],
  ['w1','w5',41],['w5','w6',37],['w6','w4',60],['w4','w3',117],['w4','c1',74],
  ['c0','c1',121],['c0','c2',121],['c1','c2',121],['c1','c6',111],['c6','c4',68],
  ['c2','c3',138],['c3','c4',101],['c3','c5',93],['c4','c5',93],
  ['c5','m0',87],['c5','m1',72],['m1','m0',74],['m0','m2',98],['m2','m3',59],
  ['m2','m4',88],['m4','m5',77],['m5','m6',45],['m5','m7',107],['m6','m7',45],
  ['m7','m8',141],['m8','e0',49],['e0','e1',61],['m8','e2',141],
  ['e2','s0',62],['s0','s1',54],['s1','s2',56],['s2','s3',31],['s3','s4',30],
  ['n0','n1',56],['n1','n2',39],['n2','n3',53],['n3','n0',53]
].map(([a,b,clearance])=>[ids.get(a),ids.get(b),clearance]);

// Nearby launch pads remain the default. Every fifth bot starts in the bay so
// a full fleet covers both components without ever teleporting between them.
export const BAY_BOT_PADS=[31,32,33,34].flatMap((id,i)=>{
  const a=BOT_NODES[id],b=BOT_NODES[[32,33,34,31][i]],angle=Math.atan2(b.y-a.y,b.x-a.x);
  return [.2,.5,.8].map(t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,angle}));
});
