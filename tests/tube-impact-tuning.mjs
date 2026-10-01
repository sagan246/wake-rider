import assert from 'node:assert/strict';
import { tubeContactResponse, tubeTubeContactResponse } from '../multiplayer/tube-contacts.js';
import { resolveBoatTubeCollision } from '../physics/collision.js';
import { startTubeGlide } from '../physics/tube-impact.js';
import { createBoatState, createTubeState } from '../physics/state.js';
import { CONFIG, UNITS_PER_FOOT } from '../physics/config.js';
import { effectiveTubeMass } from '../physics/rider.js';
import { createSimulator } from '../simulation/simulator.js';
import { SHARED_LAKE_RULES as rules } from '../simulation/defaults.js';
import { METERS_PER_UNIT as M } from '../maps/catalog.js';
import { stepBot, BOT_PADS } from '../multiplayer/bots.js';

const pose=(x,y,extra={})=>({x,y,angle:0,vx:0,vy:0,z:0,riderOn:true,...extra});
const bow=rules.length/2+rules.tubeRadius,rider={mass:130,grip:75};
for(const speed of [.1,.3,1,4,9,30,60])for(const loaded of [true,false]){
  const boat=pose(0,0,{vx:speed/M}),tube=pose(bow-.05/M,0,{riderOn:loaded});
  const oldTube={...tube,x:bow+.1/M};
  const hit=tubeContactResponse(tube,oldTube,boat,boat);
  assert.ok(hit);
  const mass=loaded?rules.loadedTubeMass:rules.emptyTubeMass;
  const tv=hit.tube.dvx,bv=boat.vx+hit.boat.dvx;
  assert.ok(Math.abs(mass*tv+rules.boatMass*hit.boat.dvx)<1e-6,'Hull/tube impulse conserves momentum');
  assert.ok(mass*tv*tv+rules.boatMass*bv*bv<=rules.boatMass*boat.vx*boat.vx+1e-5,'Bounciness does not add kinetic energy');
  assert.ok((tv-bv)*M<=8+1e-8,'Hard-hit relative rebound is capped');
  if(speed<=.3)assert.ok(Math.abs(tv-bv)<1e-6,'Tiny contacts settle instead of chattering');
  if(speed===9&&loaded){
    const oldLaunch=1.12*boat.vx/(1+mass/rules.boatMass);
    assert.ok(tv>oldLaunch*1.4,'A typical boat strike sends the lighter tube noticeably faster');
    const localBoat={...createBoatState(),...boat};
    const localTube={...createTubeState(tube,0),riderOn:true};
    resolveBoatTubeCollision({boat:localBoat,tube:localTube,rider,previousBoat:boat,previousTube:oldTube,dt:1/120});
    assert.ok(Math.abs(localTube.vx-tv)<1e-6,'Own and peer tubes share the same centered impact response');
    assert.ok(localTube.collisionGlideTime>0);
  }
}
const stationary=pose(bow-.01/M,0),staticBoat=pose(0,0);
const settled=tubeContactResponse(stationary,stationary,staticBoat,staticBoat);
assert.equal(settled.tube.dvx,0,'Overlap cannot launch a stationary tube');
const quietTube={};startTubeGlide(quietTube,0,0);assert.equal(quietTube.collisionGlideTime,undefined);

// Glancing friction must oppose the spinning rim's velocity at the contact.
const glancingBoat=createBoatState();
const spinningTube={...createTubeState({x:glancingBoat.x,y:glancingBoat.y+CONFIG.boatBeam*UNITS_PER_FOOT/2+CONFIG.tubeRadius-.1},0),
  vx:-1,vy:-1,angularVelocity:.7,riderOn:true};
const energy=()=>{
  const bm=CONFIG.boatWeightLb,tm=effectiveTubeMass(true,rider.mass);
  const bi=bm*((CONFIG.boatLength*UNITS_PER_FOOT)**2+(CONFIG.boatBeam*UNITS_PER_FOOT)**2)/12;
  const ti=tm*CONFIG.tubeRadius**2*.5;
  return .5*(bm*(glancingBoat.vx**2+glancingBoat.vy**2)+bi*glancingBoat.yawRate**2
    +tm*(spinningTube.vx**2+spinningTube.vy**2)+ti*spinningTube.angularVelocity**2);
};
const beforeGlance=energy();
const glance=resolveBoatTubeCollision({boat:glancingBoat,tube:spinningTube,rider,dt:1/120});
assert.ok(glance.impulse>0);
assert.ok(energy()<=beforeGlance,'Glancing friction cannot add energy to an already spinning tube');

// The real tow solver still limits travel: a sideways shove has room to swing,
// while an outward shove loads the rope rather than stretching it indefinitely.
const distances=[];
for(const glide of [false,true]){
  const sim=createSimulator();sim.reset({x:0,y:0,angle:0});const state=sim.getState();
  const start={x:state.tube.x,y:state.tube.y};
  sim.applyNetworkCorrection({dx:0,dy:0,dvx:0,dvy:0,tube:{dx:0,dy:0,dvx:0,dvy:6/M,impact:.2,normalX:0,normalY:1}});
  if(!glide)state.tube.collisionGlideTime=0;
  for(let i=0;i<240;i++)sim.step({dt:1/120,throttle:{forward:0,reverse:0},steer:0,maxSpeedMph:45,cruiseEnabled:false,cruiseSpeedMph:20,rider});
  distances.push(Math.hypot(state.tube.x-start.x,state.tube.y-start.y)*M);
  assert.ok(Math.hypot(state.tube.x-state.boat.x,state.tube.y-state.boat.y)<40/M,'The towing constraint remains active');
  for(let i=0;i<120;i++)sim.step({dt:1/120,throttle:{forward:0,reverse:0},steer:0,maxSpeedMph:45,cruiseEnabled:false,cruiseSpeedMph:20,rider});
  assert.equal(state.tube.collisionGlideTime,0,'Normal tube drag returns');
  sim.reset();assert.equal(sim.getState().tube.collisionGlideTime,0,'Reset clears glide');
}
assert.ok(distances[1]>distances[0]*1.05,'A real tethered tube carries a shove farther with collision glide');

const a=pose(0,0,{vx:3/M}),b=pose(2*rules.tubeRadius-.1/M,0,{vx:-3/M});
const pair=tubeTubeContactResponse(a,a,b,b);
assert.ok((b.vx+pair.b.dvx)-(a.vx+pair.a.dvx)>3/M,'Tube pairs get a playful rebound');

const pad=BOT_PADS[2],reach=rules.ropeLength+rules.length*.55;
const bot={id:'bot',botSlot:1,waypoint:pad.waypoint,length:rules.length,beam:rules.beam,ropeLength:rules.ropeLength,
  boat:pose(pad.x,pad.y,{angle:pad.angle}),tube:pose(pad.x-Math.cos(pad.angle)*reach,pad.y-Math.sin(pad.angle)*reach),
  tubeBounce:{vx:-Math.cos(pad.angle)*5/M,vy:-Math.sin(pad.angle)*5/M}};
stepBot(bot,{bot},.1);
const dx=bot.tube.x-bot.boat.x,dy=bot.tube.y-bot.boat.y,d=Math.hypot(dx,dy);
assert.ok(d<=reach+1e-6);
assert.ok((bot.tubeBounce.vx*dx+bot.tubeBounce.vy*dy)/d<1e-6,'A taut bot rope removes stored outward collision motion');
console.log(`Tube tuning passed: mass/energy, local-peer agreement, bounded rebound, quiet contacts, active rope and bot constraint; tethered 2 s glide ${distances[1].toFixed(2)} m vs ${distances[0].toFixed(2)} m.`);
