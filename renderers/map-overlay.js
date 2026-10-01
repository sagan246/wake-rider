import { METERS_PER_UNIT } from '../maps/catalog.js';

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function inWater(map, x, y) {
  return inRing(map.rings[0], x, y) && !map.rings.slice(1).some(r => inRing(r, x, y));
}

export function createMapOverlay(map) {
  const scenery = [];
  let seed = 104729;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  if (map.rings.length) {
    // Repeatable decorative shore vegetation; all coordinates remain fixed in the world.
    for (const ring of map.rings) {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i], length = Math.hypot(b.x - a.x, b.y - a.y);
        const count = Math.ceil(length * METERS_PER_UNIT / 18);
        for (let n = 0; n < count; n++) {
          const t = (n + .5) / count, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          let nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
          if (inWater(map, x + nx * 20, y + ny * 20)) { nx *= -1; ny *= -1; }
          for (let row = 0; row < 3; row++) {
            const distance = (8 + row * 19 + random() * 12) / METERS_PER_UNIT;
            const px = x + nx * distance, py = y + ny * distance;
            if (!inWater(map, px, py)) scenery.push({ x: px, y: py, size: (2.5 + random() * 2.4) / METERS_PER_UNIT, house: row === 1 && random() > .72, angle: Math.atan2(ny, nx), tone: random() });
          }
        }
      }
    }
  }

  // Reuse the world's trees in the mirror and forward driver perspective.
  // A shallow ray buffer finds the first bank, including island shorelines.
  const shoreEdges=map.rings.flatMap(ring=>ring.slice(1).map((b,i)=>({
    x:ring[i].x,y:ring[i].y,dx:b.x-ring[i].x,dy:b.y-ring[i].y
  })));
  function drawRearScenery(ctx,{x,width,horizon,bottom,tow,fx,fy,rx,ry,near,focal,columns=96}) {
    if(!shoreEdges.length)return;
    const range=1800/METERS_PER_UNIT,center=x+width/2;
    const step=width/columns,depths=new Float64Array(columns);
    const originX=tow.x+fx*near,originY=tow.y+fy*near;
    const verticalFocal=focal*.65;
    ctx.save();
    for(let column=0;column<columns;column++){
      const screenX=x+(column+.5)*step,lateral=-(screenX-center)/focal;
      const dx=-fx+rx*lateral,dy=-fy+ry*lateral;
      let closest=range+near;
      for(const edge of shoreEdges){
        const denominator=dx*edge.dy-dy*edge.dx;
        if(Math.abs(denominator)<1e-9)continue;
        const qx=edge.x-originX,qy=edge.y-originY;
        const depth=(qx*edge.dy-qy*edge.dx)/denominator;
        const along=(qx*dy-qy*dx)/denominator;
        if(depth>=near && depth<closest && along>=0 && along<=1)closest=depth;
      }
      depths[column]=closest;
      if(closest>=range+near)continue;
      const waterY=horizon+(bottom-horizon)*near/closest;
      const bankY=waterY-1.2/METERS_PER_UNIT*verticalFocal/closest;
      ctx.fillStyle=closest*METERS_PER_UNIT>500?'#587b70':'#48634f';
      ctx.fillRect(x+column*step,horizon-1,step+.5,Math.max(1,bankY-horizon+1));
      ctx.fillStyle='#a7a482';ctx.fillRect(x+column*step,bankY,step+.5,Math.max(.5,waterY-bankY));
      ctx.fillStyle='#c8d4ae88';ctx.fillRect(x+column*step,waterY,step+.5,.65);
    }
    const visible=[];
    for(const item of scenery){
      if(item.house)continue;
      const dx=item.x-tow.x,dy=item.y-tow.y,back=-(dx*fx+dy*fy);
      if(back<0||back>range)continue;
      const depth=back+near,scale=focal/depth;
      const px=center-(dx*rx+dy*ry)*scale,radius=item.size*scale*.8;
      if(px+radius<x||px-radius>x+width)continue;
      const column=Math.max(0,Math.min(columns-1,Math.floor((px-x)/step)));
      // Keep the tree belt on the visible bank; a nearer island hides far banks.
      if(depth>depths[column]+85/METERS_PER_UNIT)continue;
      const base=horizon+(bottom-horizon)*near/depth;
      const height=item.size*3.8*verticalFocal/depth;
      visible.push({item,px,base,height,radius,depth});
    }
    visible.sort((a,b)=>b.depth-a.depth);
    for(const {item,px,base,height,radius,depth} of visible){
      const haze=Math.min(.7,depth*METERS_PER_UNIT/2200);
      ctx.globalAlpha=1-haze;
      ctx.fillStyle='#65543e';ctx.fillRect(px-Math.max(.5,radius*.09),base-height*.32,Math.max(1,radius*.18),height*.32);
      ctx.fillStyle=item.tone>.5?'#244a3b':'#345c42';
      ctx.beginPath();ctx.moveTo(px,base-height);
      ctx.lineTo(px+radius*.7,base-height*.5);ctx.lineTo(px+radius*.4,base-height*.5);
      ctx.lineTo(px+radius,base-height*.18);ctx.lineTo(px-radius,base-height*.18);
      ctx.lineTo(px-radius*.4,base-height*.5);ctx.lineTo(px-radius*.7,base-height*.5);ctx.closePath();ctx.fill();
      ctx.fillStyle='#668761';ctx.beginPath();ctx.moveTo(px,base-height);ctx.lineTo(px,base-height*.22);ctx.lineTo(px-radius*.8,base-height*.22);ctx.lineTo(px-radius*.4,base-height*.5);ctx.lineTo(px-radius*.7,base-height*.5);ctx.closePath();ctx.fill();
    }
    ctx.restore();
  }

  function path(ctx, project) {
    ctx.beginPath();
    for (const ring of map.rings) {
      ring.forEach((v, i) => { const p = project(v.x, v.y); if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.closePath();
    }
  }

  function drawTerrain(ctx, screen, width, height) {
    if (!map.rings.length) return;
    const scale = screen(0, 0).scale;
    ctx.save();
    path(ctx, screen);
    ctx.rect(-1, -1, width + 2, height + 2);
    ctx.fillStyle = '#42654e'; ctx.fill('evenodd');
    // Clip land details so islands and inlet water stay clean.
    ctx.clip('evenodd');
    path(ctx, screen); ctx.strokeStyle = '#8b8e67'; ctx.lineWidth = 9 / METERS_PER_UNIT * scale; ctx.stroke();
    path(ctx, screen); ctx.strokeStyle = '#c0b991'; ctx.lineWidth = 2.8 / METERS_PER_UNIT * scale; ctx.stroke();
    for (const item of scenery) {
      const p = screen(item.x, item.y), radius = item.size * scale;
      if (p.x < -radius || p.y < -radius || p.x > width + radius || p.y > height + radius) continue;
      ctx.save(); ctx.translate(p.x, p.y);
      if (item.house) {
        ctx.rotate(item.angle); ctx.fillStyle = '#18382e66'; ctx.fillRect(-radius + 6, -radius * .65 + 7, radius * 2, radius * 1.3);
        ctx.fillStyle = item.tone > .5 ? '#c4b69a' : '#809597'; ctx.fillRect(-radius, -radius * .65, radius * 2, radius * 1.3);
        ctx.fillStyle = '#405653'; ctx.fillRect(-radius, -radius * .65, radius * 2, radius * .66);
        ctx.strokeStyle = '#e0d3b5'; ctx.lineWidth = Math.max(1, scale); ctx.strokeRect(-radius, -radius * .65, radius * 2, radius * 1.3);
      } else {
        ctx.fillStyle = item.tone > .5 ? '#244e3d' : '#305b43'; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#507452'; ctx.beginPath(); ctx.arc(-radius * .23, -radius * .25, radius * .56, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
    path(ctx, screen); ctx.strokeStyle = '#c4d9b677'; ctx.lineWidth = 1; ctx.stroke();
  }

  function drawChart(canvas, boat, tube, detailed = false, players = [], ownColor = '#fff4cb', { transparent = false, followBoat = false } = {}) {
    if (!map.rings.length) return;
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    const pad = detailed ? 75 : 24, b = map.bounds;
    const nearby = followBoat && !detailed;
    // The HUD canvas is scaled down from 460 pixels to 145 pixels on phones.
    // Size its markers in displayed pixels so they stay readable on every screen.
    const markerScale = nearby ? w / (canvas.clientWidth || w) : 1;
    const scale = nearby ? w / (1000 / METERS_PER_UNIT)
      : Math.min((w - pad * 2) / (b.maxX - b.minX), (h - pad * 2) / (b.maxY - b.minY));
    const midX = nearby ? boat.x : (b.minX + b.maxX) / 2;
    const midY = nearby ? boat.y : (b.minY + b.maxY) / 2;
    const project = (x, y) => ({ x: w / 2 + (x - midX) * scale, y: h / 2 + (y - midY) * scale });
    ctx.clearRect(0, 0, w, h);
    if (!transparent) {
      ctx.fillStyle = '#183d36'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#99b79912'; ctx.lineWidth = 1;
      for (let x = 0; x < w; x += w / 12) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += w / 12) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    }
    path(ctx, project);
    if (!transparent) { ctx.fillStyle = '#367e8a'; ctx.fill('evenodd'); }
    ctx.save();
    if (transparent) { ctx.shadowColor = '#082b37'; ctx.shadowBlur = 4; }
    ctx.strokeStyle = transparent ? '#b3d9d8aa' : '#98cbbf'; ctx.lineWidth = transparent ? 2.2 : detailed ? 2 : 1.4; ctx.stroke();
    ctx.restore();
    const p = project(boat.x, boat.y), home = project(map.spawn.x, map.spawn.y);
    for(const player of players){
      const q=project(player.boat.x,player.boat.y),r=nearby?3*markerScale:detailed?7:4;
      const dx=q.x-w/2,dy=q.y-h/2;
      const edgeX=Math.max(0,w/2-10*markerScale),edgeY=Math.max(0,h/2-13*markerScale);
      const edgeRatio=nearby?Math.min(1,dx?edgeX/Math.abs(dx):1,dy?edgeY/Math.abs(dy):1):1;
      const atEdge=edgeRatio<1;
      ctx.save();ctx.translate(atEdge?w/2+dx*edgeRatio:q.x,atEdge?h/2+dy*edgeRatio:q.y);
      ctx.lineJoin='round';ctx.lineCap='round';
      ctx.rotate(atEdge?Math.atan2(dy,dx):player.boat.angle);
      if(atEdge){
        ctx.beginPath();ctx.moveTo(-r,-r);ctx.lineTo(r*1.3,0);ctx.lineTo(-r,r);
        ctx.strokeStyle='#092f39';ctx.lineWidth=2.5*markerScale;ctx.stroke();
        ctx.strokeStyle=player.color;ctx.lineWidth=1.2*markerScale;ctx.stroke();
      }else{
        ctx.beginPath();ctx.moveTo(r*1.5,0);ctx.lineTo(-r,-r*.7);ctx.lineTo(-r,r*.7);ctx.closePath();
        ctx.fillStyle=player.color;ctx.strokeStyle='#092f39';ctx.lineWidth=nearby?.8*markerScale:1.5;ctx.fill();ctx.stroke();
      }
      ctx.restore();
      if(detailed){ctx.font='15px system-ui';ctx.fillStyle=player.color;ctx.textAlign='center';ctx.fillText(player.name,q.x,q.y-13);ctx.textAlign='left';}
    }
    const r = nearby ? 3*markerScale : detailed ? 10 : 6;
    // Keep both minimaps focused on boats; the full chart retains the tow.
    if(detailed){
      const t=project(tube.x,tube.y);
      ctx.strokeStyle = '#eedda4'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      ctx.fillStyle = '#f0b957'; ctx.beginPath(); ctx.arc(t.x, t.y, r * .55, 0, Math.PI * 2); ctx.fill();
    }
    if(!nearby){ctx.strokeStyle = '#f7f3d2'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(home.x, home.y, r * 1.8, 0, Math.PI * 2); ctx.stroke();}
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(boat.angle);
    ctx.lineJoin='round';
    ctx.beginPath(); ctx.moveTo(r * 1.8, 0); ctx.lineTo(-r, -r); ctx.lineTo(-r * .6, 0); ctx.lineTo(-r, r); ctx.closePath();
    ctx.fillStyle=ownColor;ctx.strokeStyle='#0c383e';ctx.lineWidth=nearby?.8*markerScale:2;ctx.fill();ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#d6e8d7'; ctx.textAlign = 'left'; ctx.font = `${detailed ? 23 : 17}px system-ui`;
    ctx.fillText('N ↑', w - (detailed ? 80 : 51), detailed ? 40 : 25);
    if (detailed) {
      const bar = 500 / METERS_PER_UNIT * scale;
      ctx.strokeStyle = '#d6e8d7'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(36, h - 47); ctx.lineTo(36 + bar, h - 47); ctx.stroke();
      ctx.font = '18px system-ui'; ctx.fillText('500 m', 36, h - 19);
    }
  }
  return { drawTerrain, drawChart, drawRearScenery };
}
