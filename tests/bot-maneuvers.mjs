import assert from 'node:assert/strict';
import { stepBot } from '../multiplayer/bots.js';
import { botTraffic } from '../multiplayer/bot-traffic.js';
import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { hasWaterClearance, nearestShore } from '../physics/shore.js';
import { SHARED_LAKE_RULES as rules } from '../simulation/defaults.js';

function boat(id,x=0,y=0,angle=0,speed=8){
  const b={x:(-1500+x)/M,y:(330+y)/M,angle,vx:Math.cos(angle)*speed/M,vy:Math.sin(angle)*speed/M};
  const reach=rules.ropeLength+rules.length*.55;
  return {id,isBot:true,length:rules.length,beam:rules.beam,ropeLength:rules.ropeLength,boat:b,
    tube:{...b,x:b.x-Math.cos(angle)*reach,y:b.y-Math.sin(angle)*reach},nextSpinAt:Infinity,
    navigation:{path:[angle===0?12:9],from:10,goal:null,trip:0,visits:{},bestDistance:Infinity,stuckTime:0}};
}
function safe(p){
  assert.ok(hasWaterClearance(lake,p.boat.x,p.boat.y,Math.hypot(p.length,p.beam)/2));
  assert.ok(hasWaterClearance(lake,p.tube.x,p.tube.y,1/M));
  assert.ok(Math.hypot(p.boat.x-p.tube.x,p.boat.y-p.tube.y)*M<25,'Tow remains attached through maneuvers');
}
const scenarios=[
  ['head-on',boat('other',75,0,Math.PI,8)],
  ['crossing',boat('other',35,-40,Math.PI/2,8)],
  ['overtaking',boat('other',55,0,0,3)],
  ['stationary',boat('other',50,0,0,0)],
  ['tube corridor',boat('other',50,20,Math.PI/2,0)]
];
const results=[];
for(const [name,other] of scenarios){
  const p=boat(`encounter-${name}`),players={[p.id]:p,[other.id]:other};
  let minimum=Infinity,tubeMinimum=Infinity,yielded=false;
  for(let i=0;i<180;i++){
    stepBot(p,players,.1);safe(p);yielded ||= p.botMode==='yield';
    minimum=Math.min(minimum,Math.hypot(p.boat.x-other.boat.x,p.boat.y-other.boat.y)*M);
    tubeMinimum=Math.min(tubeMinimum,Math.hypot(p.boat.x-other.tube.x,p.boat.y-other.tube.y)*M);
    for(const body of [other.boat,other.tube]){body.x+=body.vx*.1;body.y+=body.vy*.1;}
  }
  assert.ok(yielded,`${name}: driver anticipates the encounter`);
  assert.ok(minimum>7,`${name}: hulls avoid contact (${minimum.toFixed(2)} m)`);
  assert.ok(tubeMinimum>4,`${name}: boat avoids the other tube (${tubeMinimum.toFixed(2)} m)`);
  results.push(`${name} ${minimum.toFixed(1)} m`);
}
{
  const p=boat('followed'),other=boat('faster-behind',-45,0,0,15);
  const traffic=botTraffic(p,{p,other},.1);
  assert.equal(traffic.pace,1,'Do not brake in front of a faster boat approaching from behind');
}
{
  const p=boat('reciprocal-a'),q=boat('reciprocal-b',80,0,Math.PI);
  const trafficA=botTraffic(p,{p,q},.1),trafficB=botTraffic(q,{p,q},.1);
  assert.ok(trafficA.steer>0&&trafficB.steer>0,'Head-on drivers choose their own starboard sides');
  let minimum=Infinity;
  for(let i=0;i<150;i++){stepBot(p,{p,q},.1);stepBot(q,{p,q},.1);minimum=Math.min(minimum,Math.hypot(p.boat.x-q.boat.x,p.boat.y-q.boat.y)*M);safe(p);safe(q);}
  assert.ok(minimum>7,`Reciprocal drivers pass without bumping (${minimum.toFixed(2)} m)`);
}
{
  const p=boat('spin-check');p.nextSpinAt=0;
  let rotation=0,previous=p.boat.angle;
  for(let i=0;i<180;i++){
    stepBot(p,{p},.1);safe(p);
    const delta=Math.atan2(Math.sin(p.boat.angle-previous),Math.cos(p.boat.angle-previous));previous=p.boat.angle;
    assert.ok(Math.abs(delta)<=.042+1e-8,'A spin never snaps the boat heading');rotation+=Math.abs(delta);
  }
  assert.equal(p.spinCount,1,'A clear-water spin completes one full circle');assert.ok(rotation>=Math.PI*2);
  assert.equal(p.botSpin,null,'Completed spin returns to navigation');
  const before={...p.boat};for(let i=0;i<100;i++)stepBot(p,{p},.1);
  assert.ok(Math.hypot(p.boat.x-before.x,p.boat.y-before.y)*M>25,'Driver resumes its journey after a spin');
}
{
  const p=boat('abort-spin');p.nextSpinAt=0;stepBot(p,{p},.1);assert.ok(p.botSpin);
  const other=boat('incoming');other.boat={...p.boat,x:p.boat.x+40/M};other.tube={...other.boat,x:other.boat.x+22/M};
  stepBot(p,{p,other},.1);assert.equal(p.botSpin,null,'Approaching traffic interrupts the spin');
  assert.ok(p.nextSpinAt>p.rideTime,'Aborted tricks wait before trying again');
}
{
  const p=boat('near-shore',-1340,480);p.nextSpinAt=0;
  stepBot(p,{p},.1);assert.equal(p.botSpin,undefined,'No spin without clearance for the whole boat and tow circle');
}
{
  const p=boat('shore-recovery'),shore=nearestShore(lake,p.boat.x,p.boat.y);
  p.boat={...p.boat,x:shore.x+shore.nx*5/M,y:shore.y+shore.ny*5/M,angle:Math.atan2(shore.ny,shore.nx),vx:0,vy:0};
  p.tube={...p.boat,x:p.boat.x+shore.nx*20/M,y:p.boat.y+shore.ny*20/M};delete p.navigation;
  stepBot(p,{p},.1);assert.equal(p.navigation.path.length,0,'A shore-side shove never selects an occluded fallback route');
  for(let i=0;i<160;i++){stepBot(p,{p},.1);safe(p);}
  assert.ok(p.navigation.path.length>0,'Driver moves into water and safely rejoins a visible corridor');
}
console.log(`Bot maneuvers passed: ${results.join(', ')}; reciprocal passing, rear traffic, complete/abort/rejoin spins and shore clearance.`);
