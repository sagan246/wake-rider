import assert from 'node:assert/strict';
import { BOAT_MODEL, boatModelVertices } from '../renderers/boat-model.js';
import { BOAT_OUTLINE } from '../physics/boat-hull.js';
import { createWaterProjector, projectWaterPolygon } from '../renderers/water-perspective.js';

// Art must not grow outside the collider: that previously made bumps look early.
for(const [x,y,z] of BOAT_MODEL.vertices){
  assert.ok(Number.isFinite(x+y+z));
  for(let i=0;i<BOAT_OUTLINE.length;i++){
    const a=BOAT_OUTLINE[i],b=BOAT_OUTLINE[(i+1)%BOAT_OUTLINE.length];
    assert.ok((b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0])<=1e-8,'Visible geometry remains inside the hull');
  }
}
const pose={x:120,y:-30,z:7,angle:0,pitch:0,roll:0};
const level=boatModelVertices(pose,70,30);
const turned=boatModelVertices({...pose,angle:Math.PI/2},70,30);
for(let i=0;i<level.length;i++){
  assert.ok(Math.abs(turned[i].x-pose.x+(level[i].y-pose.y))<1e-8);
  assert.ok(Math.abs(turned[i].y-pose.y-(level[i].x-pose.x))<1e-8);
}
const bowIndex=BOAT_MODEL.vertices.findIndex(([x,y])=>x>30&&y===0);
assert.ok(boatModelVertices({...pose,pitch:.15},70,30)[bowIndex].z>level[bowIndex].z,'Positive pitch lifts the bow');

// A partly visible boat keeps its clipped bow even when its center is behind
// the camera. Both mirror and Helm projections must stay finite while turning.
for(const fullScreen of [false,true]){
  const project=createWaterProjector({tow:{x:0,y:0},fx:0,fy:-1,rx:1,ry:0,centerX:300,horizon:100,bottom:230,near:42,focal:300,verticalFocal:195,fullScreen,physicalHeight:true,range:1000});
  for(const y of [-20,0,30,980,1020])for(let i=0;i<16;i++){
    const world=boatModelVertices({x:15,y,z:0,angle:i*Math.PI/8,pitch:.1,roll:-.06},96,35);
    const projected=BOAT_MODEL.faces.map(f=>projectWaterPolygon(project,f.ids.map(j=>world[j])));
    const partiallyVisible=world.some(p=>project.depth(p.x,p.y)>project.nearDepth&&project.depth(p.x,p.y)<project.farDepth);
    if(partiallyVisible)assert.ok(projected.some(f=>f.length>=3),'Partly visible hull remains visible');
    for(const polygon of projected)for(const p of polygon)assert.ok(Number.isFinite(p.x+p.y),'Clipped faces remain finite');
  }
}
console.log('Boat model passed: collider footprint, heading, pitch, and near/far clipping in both cameras.');
