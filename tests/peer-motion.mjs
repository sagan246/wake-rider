import assert from 'node:assert/strict';
import { createPeerMotion } from '../multiplayer/peer-motion.js';
import { OSWEGO_MAP as lake, METERS_PER_UNIT as M } from '../maps/catalog.js';
import { hasWaterClearance } from '../physics/shore.js';

const base=100000,empty={rings:[]};
const body=(x,angle=0)=>({x,y:0,vx:100,vy:0,z:0,pitch:0,roll:0,angle,riderOn:true});
const player=(at,x=at*.1,extra={})=>({id:'remote',name:'Other boat',length:90,beam:35,paused:false,poseAt:base+at,spawnAt:base,boat:body(x),tube:body(x-300),...extra});
const receive=(motion,p,at,rtt=0)=>motion.receive([p],{selfId:'self',serverTime:base+at,now:at,rtt});
const x=(motion,at)=>motion.get(at)[0].boat.x;

const a=createPeerMotion({map:empty}),b=createPeerMotion({map:empty});
for(const motion of [a,b]){receive(motion,player(0),0);receive(motion,player(200),200);}
receive(a,player(200),300);receive(a,player(200),400);
assert.ok(Math.abs(x(a,500)-x(b,500))<1e-7,'Repeated snapshots do not restart interpolation or halt travel');
assert.ok(x(a,650)>x(a,500),'Prediction continues beyond the old 150 ms cutoff');
const stopped=x(a,1600);assert.equal(x(a,2500),stopped,'Missing updates eventually stop bounded prediction');

// A steady boat arriving in irregular 200–900 ms batches keeps moving smoothly
// between arrivals and never snaps backward when the interpolation delay grows.
const jitter=createPeerMotion({map:empty});receive(jitter,player(0),0);
let lastX=x(jitter,0),nextPacket=200,maxStep=0,backward=0,flat=0,arrivals=0;
const gaps=[200,600,900,250,700];
for(let at=20;at<=8000;at+=20){
  if(at>=nextPacket){receive(jitter,player(at),at);nextPacket=at+gaps[arrivals++%gaps.length];}
  const current=x(jitter,at),delta=current-lastX;
  if(at>400){maxStep=Math.max(maxStep,delta);if(delta<-.001)backward++;if(Math.abs(delta)<.00001)flat++;}
  lastX=current;
}
assert.equal(backward,0,'Jitter smoothing never rewinds a steady boat');
assert.ok(maxStep<6,`No packet-sized jump (largest 20 ms step: ${maxStep})`);
assert.equal(flat,0,'No visible freeze during 200–900 ms update gaps');

const independent=createPeerMotion({map:empty});receive(independent,player(0),0);
const deliveries=[[240,80],[680,440],[880,80],[1640,760],[1840,120],[2440,600],[2640,80]];
let delivery=0,lastIndependent=x(independent,0);
for(let at=20;at<=2800;at+=20){
  if(delivery<deliveries.length&&at===deliveries[delivery][0]){
    const rtt=deliveries[delivery++][1],serverAt=at-rtt/2,sourceAt=Math.floor(serverAt/400)*400;
    independent.receive([player(sourceAt)],{selfId:'self',serverTime:base+serverAt,now:at,rtt});
  }
  const current=x(independent,at);
  assert.ok(current>=lastIndependent-.001,'Repeated source poses plus variable RTT never rewind steady motion');
  assert.ok(current-lastIndependent<7,'Changing latency does not create a packet-sized jump');
  lastIndependent=current;
}

const bumps=createPeerMotion({map:empty});receive(bumps,player(0),0);receive(bumps,player(200),200);
const before=x(bumps,300);receive(bumps,player(200,70),300);
assert.ok(Math.abs(x(bumps,300)-before)<1e-6,'Same-timestamp collision correction starts smoothly');
assert.ok(x(bumps,700)>80,'Changed body at the same timestamp is not ignored as a duplicate');
receive(bumps,player(100,-500),720);assert.ok(x(bumps,740)>80,'Older peer poses cannot rewind the boat');

const pause=player(800,95,{paused:true});receive(bumps,pause,800);
assert.equal(x(bumps,800),95);assert.equal(x(bumps,3000),95,'Paused boats do not drift');
receive(bumps,player(3100,10,{spawnAt:base+3100,paused:true}),3100);
assert.equal(x(bumps,3100),10,'A nearby reset clears old motion history immediately');
receive(bumps,player(3200,20,{spawnAt:base+3100}),3200);
assert.ok(x(bumps,3500)>20,'Motion resumes from the new launch');
bumps.receive([],{selfId:'self',serverTime:base+3600,now:3600});assert.deepEqual(bumps.get(3600),[],'Departed players disappear');
bumps.clear();assert.deepEqual(bumps.get(4000),[]);

const angles=createPeerMotion({map:empty});
receive(angles,player(0,0,{boat:body(0,3.1)}),0);
receive(angles,player(200,20,{boat:body(20,-3.1)}),200);
assert.ok(Math.abs(angles.get(250)[0].boat.angle)>3,'Heading crosses ±π by the short turn');

// Small water rectangle: even smoothing and forward prediction must stay wet.
const box={rings:[[{x:-600,y:-200},{x:300,y:-200},{x:300,y:200},{x:-600,y:200}]],spawn:{x:0,y:0,angle:0}};
const shore=createPeerMotion({map:box});
receive(shore,player(0,220),0);receive(shore,player(200,240),200);
for(let at=200;at<=2000;at+=20){const p=shore.get(at)[0];assert.ok(hasWaterClearance(box,p.boat.x,p.boat.y,Math.hypot(p.length,p.beam)/2));assert.ok(hasWaterClearance(box,p.tube.x,p.tube.y,1/M));}

// Both boats use the real shoreline and default dimensions in a render workload.
const live=createPeerMotion();
const sample={...player(0),boat:{...body(lake.spawn.x),y:lake.spawn.y},tube:{...body(lake.spawn.x-25/M),y:lake.spawn.y}};
receive(live,sample,0);
const start=performance.now();for(let i=0;i<600;i++)live.get(i*1000/60);
console.log(`Peer motion passed: duplicate snapshots, irregular updates without stops/jumps, collision corrections, pause/reset/leave, angle wrap and swept shores; 600 frames in ${(performance.now()-start).toFixed(0)} ms.`);
