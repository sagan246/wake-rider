import assert from 'node:assert/strict';
import { createInputController } from '../input/controls.js';

const target=new EventTarget();
const controls=createInputController({target});
const key=(type,code)=>{const event=new Event(type,{cancelable:true});Object.defineProperty(event,'code',{value:code});target.dispatchEvent(event);};

key('keydown','KeyW');key('keydown','KeyA');
assert.equal(controls.sample().forward,1);
assert.equal(controls.sample().steer,-1);
// The release goes to another window, so our page never receives keyup.
target.dispatchEvent(new Event('blur'));
assert.equal(controls.sample().forward,0,'Losing focus releases keyboard throttle');
assert.equal(controls.sample().steer,0,'Losing focus releases keyboard steering');
key('keydown','KeyS');assert.equal(controls.sample().reverse,1);
key('keyup','KeyS');assert.equal(controls.sample().reverse,0,'Keys work normally after focus returns');

controls.setTouchThrottle(.65);controls.setTouchSteer(.3);key('keydown','KeyW');
target.dispatchEvent(new Event('blur'));
assert.equal(controls.sample().forward,.65,'The marine lever stays where the player left it');
assert.equal(controls.sample().steer,.3,'The wheel position remains independent of released keys');
controls.resetAll();
assert.deepEqual(controls.sample(),{forward:0,reverse:0,steer:0,gamepadConnected:false});
console.log('Input checks passed: held keys release on focus loss, controls resume, and latched marine controls stay independent.');
