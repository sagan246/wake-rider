import assert from 'node:assert/strict';
import { createCameraState, updateFollowCamera } from '../camera/follow-camera.js';
import { createSimulator } from '../simulation/simulator.js';

const rider = { mass: 130, grip: 75, color: '#78aef0' };
const simulator = createSimulator();

let state = simulator.getState();
assert.equal(state.boat.x, 0, 'Reset boat should begin at the origin');
assert.equal(state.replay.active, false, 'Replay should start inactive');
assert.ok(state.ropeChain.length > 4, 'Shared simulator should own the segmented rope');

let lastMetrics;
for (let frame = 0; frame < 1200; frame++) {
  const result = simulator.step({
    dt: 1 / 120,
    throttle: { forward: .7, reverse: 0 },
    steer: frame > 500 ? .45 : 0,
    maxSpeedMph: 45,
    cruiseEnabled: false,
    cruiseSpeedMph: 20,
    rider
  });
  state = result.state;
  lastMetrics = result.metrics;
}

assert.ok(lastMetrics.boatMph > 8, 'Shared simulator should accelerate the boat');
assert.ok(state.wakes.length > 0, 'Shared simulator should emit persistent wakes');
assert.ok(state.traces.boat.length > 20, 'Shared simulator should record replay frames');
assert.ok(simulator.startReplay(), 'A recorded run should be replayable');

const replayStep = simulator.step({
  dt: 1 / 60,
  throttle: { forward: 0, reverse: 0 },
  steer: 0,
  maxSpeedMph: 45,
  cruiseEnabled: false,
  cruiseSpeedMph: 20,
  rider
});
assert.ok(replayStep.replayGhost, 'Replay stepping should expose a renderer-neutral ghost state');

const camera = createCameraState();
updateFollowCamera(camera, {
  boat: replayStep.replayGhost.boat,
  tube: replayStep.replayGhost.tube,
  dt: 1 / 120,
  snap: true,
  view: 'driver',
  viewportWidth: 390,
  showDigitalGauges: true,
  fovDeg: 100
});
assert.ok(Number.isFinite(camera.x) && Number.isFinite(camera.zoom), 'Shared camera output should remain finite');

simulator.reset();
state = simulator.getState();
assert.equal(state.simTime, 0, 'Reset should clear shared simulation time');
assert.equal(state.wakes.length, 0, 'Reset should clear shared wakes');

// A shared collision affects the tube independently of its towing boat/rider.
state.tube.fallenRider={x:50,y:90,z:0,vx:3,vy:4};
const savedBoat={...state.boat},savedRider={...state.tube.fallenRider},savedTube={...state.tube};
// Simulate a line already in motion when the server correction arrives.
for(const node of state.ropeChain){node.px-=6;node.py+=4;}
simulator.applyNetworkCorrection({dx:0,dy:0,dvx:0,dvy:0,tube:{dx:12,dy:-4,dvx:35,dvy:-8,impact:.5,normalX:1,normalY:0}});
assert.deepEqual(state.boat,savedBoat,'Tube impact must not teleport or accelerate its towing boat');
assert.deepEqual(state.tube.fallenRider,savedRider,'Tube impact must not teleport a fallen rider');
assert.equal(state.tube.x,savedTube.x+12);
assert.equal(state.tube.vx,savedTube.vx+35);
assert.ok(state.tube.collisionSplash>0,'Tube impact is visible as compression/splash');
for(const node of state.ropeChain){
  assert.ok(['x','y','z','px','py','pz'].every(k=>Number.isFinite(node[k])));
  assert.equal(node.px,node.x,'Refitting the rope must not add artificial line velocity');
  assert.equal(node.py,node.y);
}
state.tube.fallenRider=null;
for(let frame=0;frame<240;frame++)simulator.step({dt:1/120,throttle:{forward:.4,reverse:0},steer:0,maxSpeedMph:45,cruiseEnabled:false,cruiseSpeedMph:20,rider});
assert.ok([state.boat,state.tube,...state.ropeChain].every(b=>Number.isFinite(b.x)&&Number.isFinite(b.y)),'Tow simulation stays finite after impact');
assert.ok(Math.hypot(state.tube.x-state.boat.x,state.tube.y-state.boat.y)<450,'Tow rope recovers after impact');

console.log('Simulator separation smoke test passed', {
  boatMph: lastMetrics.boatMph.toFixed(1),
  wakePackets: state.wakes.length,
  cameraZoom: camera.zoom.toFixed(2)
});
