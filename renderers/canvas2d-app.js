import { CONFIG, LAB_MAX_MPH, MIN_LAB_MAX_MPH, STANDARD_GRAVITY, STANDARD_GRAVITY_FT_PER_SECOND_SQUARED, UNITS_PER_FOOT } from '../physics/config.js';
import { clamp, len, normAngle } from '../physics/math.js';
import { wakeHeightAtPacket, sampleWater } from '../physics/wake.js';
import { boatHeadingDegrees, towPoint } from '../physics/boat.js';
import { tubeTowPoint } from '../physics/tow.js';
import { applyBoatProfile, applyBoatTowAttachment, DEFAULT_BOAT_ID } from '../physics/boats.js';
import { createSimulator } from '../simulation/simulator.js?v=28';
import { createLabDefaults, RIDER_PROFILES } from '../simulation/defaults.js?v=28';
import { createInputController } from '../input/controls.js?v=28';
import { createActivityTracker } from '../input/activity.js';
import { createCameraState, updateFollowCamera } from '../camera/follow-camera.js';
import { getMap, METERS_PER_UNIT } from '../maps/catalog.js?v=28';
import { createMapOverlay } from './map-overlay.js?v=28';
import { createLakeClient } from '../multiplayer/client.js?v=28';
import { drawPlayers2D } from './players2d.js?v=28';
import { drawPlayersPerspective } from './players-perspective.js?v=28';
import { createWaterProjector } from './water-perspective.js?v=28';
import { boatColorStyle } from './boat-sprite.js?v=28';
import { drawBoatTop } from './boat-model.js';
import { drawTubeRiderTop, drawTubeRiderFace } from './tube-rider.js?v=28';
import { BOAT_SPRITE_LENGTH, BOAT_SPRITE_BEAM } from '../physics/boat-hull.js';

export function startCanvas2DApp() {
  const app = document.querySelector('#app');
  const canvas = document.querySelector('#lake');
  const ctx = canvas.getContext('2d');
  const throttleGate=document.querySelector('#throttle-gate');
  const ui = { speed: document.querySelector('#speed'), peakSpeed:document.querySelector('#peak-speed'), boatBar:document.querySelector('#boat-bar'), tubeSpeed:document.querySelector('#tube-speed'), peakTubeSpeed:document.querySelector('#peak-tube-speed'), tubeBar:document.querySelector('#tube-bar'), tension: document.querySelector('#tension'), peakTension:document.querySelector('#peak-tension'), ropeBar:document.querySelector('#rope-bar'), air: document.querySelector('#air'), peakAir:document.querySelector('#peak-air'), airBar:document.querySelector('#air-bar'), g:document.querySelector('#g-force'), peakG:document.querySelector('#peak-g'), gBar:document.querySelector('#g-bar'), needle:document.querySelector('#speed-needle'), speedometer:document.querySelector('.speedometer'), cruiseIndicator:document.querySelector('#cruise-indicator'), speedMaxLabel:document.querySelector('#speed-max-label'), speedQuarter:document.querySelector('#speed-quarter'), speedHalf:document.querySelector('#speed-half'), speedThreeQuarter:document.querySelector('#speed-three-quarter'), compass:document.querySelector('#compass'), compassCard:document.querySelector('#compass-card'), handle:document.querySelector('#throttle-handle'), throttleValue:document.querySelector('#throttle-value'), wheel:document.querySelector('#steering-wheel'), controller:document.querySelector('#controller-status') };
  let rider={...RIDER_PROFILES.balanced};
  const TAU = Math.PI * 2;
  const THROTTLE_FORWARD_SHARE = .7;
  const THROTTLE_NEUTRAL_HALF_SHARE = .055;
  const MIRROR_HORIZONTAL_FOV_DEG=78;
  const MIRROR_MAX_RANGE=200*UNITS_PER_FOOT;
  const TOW_HEIGHT_RENDER_SCALE=.3;
  let activeBoatProfile=applyBoatProfile(DEFAULT_BOAT_ID);
  const LAB_DEFAULTS=createLabDefaults(activeBoatProfile);
  let boatStyle=activeBoatProfile.style;
  let dpr=1,w=0,h=0,last=performance.now(), accumulator=0;
  let boat,tube,wakes,ropeChain,traces,replay,camera,simTime,peaks,view='driver',debug=false,showDigitalGauges=LAB_DEFAULTS.showDigitalGauges,cameraFovDeg=LAB_DEFAULTS.cameraFovDeg,maxBoatSpeedMph=LAB_DEFAULTS.maxBoatSpeedMph,cruiseEnabled=LAB_DEFAULTS.cruiseEnabled,cruiseSpeedMph=LAB_DEFAULTS.cruiseSpeedMph,touchWheelAngle=0,lastWheelPointerAngle=0,wheelHeld=false,appSuspended=document.hidden;
  let savedMap = 'oswego';
  try { savedMap = localStorage.getItem('wake-rider-oswego-map') || savedMap; } catch { /* Storage may be unavailable. */ }
  let activeMap=getMap(new URLSearchParams(location.search).get('map') || savedMap);
  let mapOverlay=createMapOverlay(activeMap),lastChartTime=-1;
  const simulator=createSimulator({map:activeMap,sharedWakes:activeMap.id==='oswego'});
  const controls=createInputController({onReset:reset,onView:setView});
  const activity=createActivityTracker();
  let multiplayer=null,remotePlayers=[],soloPhysics=null;
  let lakeSpawnAssigned=false;

  function syncSimulationState(state=simulator.getState()){
    ({boat,tube,wakes,ropeChain,traces,replay,simTime,peaks}=state);
  }

  function reset(spawn){
    const assignedSpawn=spawn&&[spawn.x,spawn.y,spawn.angle].every(Number.isFinite);
    if(activeMap.id==='oswego' && multiplayer && !assignedSpawn){multiplayer.reset();controls.resetAll();return;}
    syncSimulationState(simulator.reset(assignedSpawn?spawn:undefined));
    camera=createCameraState();
    updateCameraForBodies(boat,tube,1/120,true);
    touchWheelAngle=0;
    controls.resetTouch();
    wheelHeld=false;
    throttleGate.setAttribute('aria-valuenow','0');
  }
  function resize(){
    const bounds=canvas.getBoundingClientRect();
    dpr=Math.min(devicePixelRatio||1,2);w=bounds.width;h=bounds.height;
    canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  addEventListener('resize',resize); resize(); reset();

  document.querySelectorAll('[data-control]').forEach(b=>{
    const k=b.dataset.control;
    const analog=b.dataset.analog==='true',output=b.querySelector('output');
    const set=v=>{const level=analog?clamp(v,0,1):(v?1:0);controls.setDigital(k,level);b.classList.toggle('active',level>0);if(analog){b.style.setProperty('--level',`${level*100}%`);output.value=`${Math.round(level*100)}%`;}};
    const fromPointer=e=>{const r=b.getBoundingClientRect();return clamp(1-(e.clientY-r.top)/r.height,0,1);};
    b.addEventListener('pointerdown',e=>{b.setPointerCapture(e.pointerId);set(analog?fromPointer(e):1)});
    b.addEventListener('pointermove',e=>{if(b.hasPointerCapture(e.pointerId))set(analog?fromPointer(e):1)});
    b.addEventListener('pointerup',()=>set(0)); b.addEventListener('pointercancel',()=>set(0));
  });
  function pointerAngleOnWheel(e){const r=ui.wheel.getBoundingClientRect();return Math.atan2(e.clientY-(r.top+r.height/2),e.clientX-(r.left+r.width/2));}
  function applyTouchWheel(){
    const touchSteer=clamp(touchWheelAngle/135,-1,1);controls.setTouchSteer(touchSteer);ui.wheel.setAttribute('aria-valuenow',String(Math.round(touchSteer*100)));
  }
  ui.wheel.addEventListener('pointerdown',e=>{
    const r=ui.wheel.getBoundingClientRect(),distance=Math.hypot(e.clientX-(r.left+r.width/2),e.clientY-(r.top+r.height/2));
    if(distance<22){touchWheelAngle=0;applyTouchWheel();return;}
    touchWheelAngle=boat.wheel*135;
    wheelHeld=true;ui.wheel.setPointerCapture(e.pointerId);lastWheelPointerAngle=pointerAngleOnWheel(e);
  });
  ui.wheel.addEventListener('pointermove',e=>{
    if(!ui.wheel.hasPointerCapture(e.pointerId))return;
    const next=pointerAngleOnWheel(e),delta=normAngle(next-lastWheelPointerAngle);lastWheelPointerAngle=next;
    touchWheelAngle=clamp(touchWheelAngle+delta*180/Math.PI,-135,135);applyTouchWheel();
  });
  ui.wheel.addEventListener('pointerup',()=>{wheelHeld=false;});ui.wheel.addEventListener('pointercancel',()=>{wheelHeld=false;});
  function setTouchThrottle(value){
    const v=controls.setTouchThrottle(value);
    throttleGate.setAttribute('aria-valuenow',String(Math.round(v*100)));
  }
  function throttleFromPointer(e){
    const r=throttleGate.getBoundingClientRect();
    const y=clamp((e.clientY-r.top)/r.height,0,1);
    const neutralStart=THROTTLE_FORWARD_SHARE-THROTTLE_NEUTRAL_HALF_SHARE;
    const neutralEnd=THROTTLE_FORWARD_SHARE+THROTTLE_NEUTRAL_HALF_SHARE;
    if(y>=neutralStart&&y<=neutralEnd)return 0;
    return y<neutralStart
      ? (neutralStart-y)/neutralStart
      : -(y-neutralEnd)/(1-neutralEnd);
  }
  throttleGate.addEventListener('pointerdown',e=>{throttleGate.setPointerCapture(e.pointerId);setTouchThrottle(throttleFromPointer(e));});
  throttleGate.addEventListener('pointermove',e=>{if(throttleGate.hasPointerCapture(e.pointerId))setTouchThrottle(throttleFromPointer(e));});
  // A real marine throttle stays where the driver leaves it. Touch input
  // therefore latches until the lever is moved back to neutral.
  document.querySelector('#reset').onclick=reset;
  const mapSelect=document.querySelector('#map-select'),mapDialog=document.querySelector('#map-dialog');
  const miniMap=document.querySelector('#mini-map'),lakeChart=document.querySelector('#lake-chart');
  const hudMap=document.querySelector('#player-minimap'),hudMapWrap=document.querySelector('#player-minimap-wrap'),mapToggle=document.querySelector('#show-player-minimap');
  const playerName=document.querySelector('#player-name'),onlineStatus=document.querySelector('#online-status'),onlineNotice=document.querySelector('#online-notice');
  const connectionPing=document.querySelector('#connection-ping');
  let nextPingUiAt=0;
  function updatePingUi(){
    const ping=multiplayer?.latencyMs??null;
    const quality=ping===null?'unknown':ping<=100?'good':ping<=200?'fair':'poor';
    connectionPing.dataset.quality=quality;
    connectionPing.textContent=ping===null
      ?`Ping: ${multiplayer?.ready?'measuring…':'unavailable'}`
      :`Ping: ${ping} ms · ${quality[0].toUpperCase()+quality.slice(1)}`;
  }
  const testBots=document.querySelector('#test-bots'),testBotsStatus=document.querySelector('#test-bots-status');
  const fillEmptySeats=document.querySelector('#fill-empty-seats'),fillBotsStatus=document.querySelector('#fill-bots-status');
  const botFillHelp='Shared setting · keeps 16 boats on the lake while people are playing. Real players replace bots as they join.';
  let botFillState=null,pendingBotFill=null;
  fillEmptySeats.addEventListener('change',()=>{
    if(!botFillState||pendingBotFill||!multiplayer.ready)return;
    pendingBotFill={...botFillState,enabled:fillEmptySeats.checked};
    fillEmptySeats.disabled=true;fillBotsStatus.textContent='Updating the shared lake…';
  });
  testBots.value='0'; // Deliberately opt in again on each visit.
  testBots.addEventListener('change',()=>{testBotsStatus.textContent='Updating your bots…';});
  mapToggle.checked=true;
  try{mapToggle.checked=localStorage.getItem('wake-rider-player-minimap')!=='false';playerName.value=localStorage.getItem('wake-rider-player-name')||'';}catch{}
  const updateMinimapVisibility=()=>{
    const waitingForLaunch=activeMap.id==='oswego'&&!lakeSpawnAssigned;
    hudMapWrap.hidden=activeMap.id!=='oswego'||waitingForLaunch||!mapToggle.checked;
    miniMap.hidden=activeMap.id==='open'||waitingForLaunch;
    document.querySelector('#show-map').disabled=waitingForLaunch;
  };
  mapToggle.addEventListener('change',()=>{updateMinimapVisibility();try{localStorage.setItem('wake-rider-player-minimap',String(mapToggle.checked));}catch{}});
  playerName.addEventListener('change',()=>{try{localStorage.setItem('wake-rider-player-name',playerName.value);}catch{}});
  multiplayer=createLakeClient({
    read:()=>({boat,tube,wakeSamples:simulator.getWakeSamples(),name:playerName.value,botCount:Number(testBots.value),fillBotsRequest:pendingBotFill,paused:appSuspended||mapDialog.open||replay.active,
      activitySeq:activity.sample(controls.hasHeldInput(),appSuspended||mapDialog.open||replay.active)}),
    onSpawn:spawn=>{
      reset(spawn);
      // Install the assigned boat and camera before revealing the lake. The
      // local map default is provisional and may differ from a free server pad.
      lakeSpawnAssigned=true;
      updateMinimapVisibility();
    },
    onCorrection:event=>{simulator.applyNetworkCorrection(event);syncSimulationState();},
    onWakes:(events,time,receipt)=>simulator.receiveSharedWakes(events,time,receipt),
    onStatus:({message,ready,count,self})=>{
      onlineStatus.textContent=message;onlineNotice.textContent=message;
      onlineNotice.hidden=activeMap.id!=='oswego'||ready;
      if(!ready){controls.resetAll();setCruiseEnabled(false);updatePingUi();nextPingUiAt=0;}
      if(self?.botFill){
        botFillState=self.botFill;
        if(pendingBotFill&&(botFillState.epoch!==pendingBotFill.epoch||botFillState.revision!==pendingBotFill.revision))pendingBotFill=null;
        fillEmptySeats.checked=pendingBotFill?pendingBotFill.enabled:botFillState.enabled;
        fillBotsStatus.textContent=pendingBotFill?'Updating the shared lake…':botFillState.enabled
          ?`Automatic fill is on · ${count}/16 boats. People replace bots as they join.`
          :botFillHelp;
      }else if(!self){
        // A new/ended session must not replay an unconfirmed menu change.
        // Ordinary transport reconnects retain self and can safely retry it.
        botFillState=null;pendingBotFill=null;fillEmptySeats.checked=false;
        fillBotsStatus.textContent=botFillHelp;
      }
      fillEmptySeats.disabled=!ready||!botFillState||!!pendingBotFill;
      document.querySelector('#manual-bots-control').hidden=fillEmptySeats.checked;
      if(self&&self.botCount===Number(testBots.value)){
        testBotsStatus.textContent=self.botCount?`${self.activeBots} of ${self.botCount} bots cruising${self.activeBots<self.botCount?' · waiting for space':''}.`:'Your bots are off.';
      }
      document.querySelector('#player-minimap-caption').textContent=`${count} on the lake${self?` · ${self.name}`:''}`;
      lastChartTime=-1;
    }
  });
  function syncMapUi(){
    mapSelect.value=activeMap.id;
    document.querySelector('#map-description').textContent=activeMap.description;
    app.dataset.map=activeMap.id;
    document.querySelector('#show-map').hidden=activeMap.id==='open';
    miniMap.hidden=activeMap.id==='open';
    document.querySelector('.map-panel .map-credit').hidden=activeMap.id==='open';
    lastChartTime=-1;
    document.querySelector('#shared-lake-settings').hidden=activeMap.id!=='oswego';
    document.querySelector('#replay-trace').disabled=activeMap.id==='oswego';
    document.querySelector('#replay-trace').hidden=activeMap.id==='oswego';
    document.querySelector('#replay-trace').title=activeMap.id==='oswego'?'Replay is available in solo Open Water.':'';
    updateMinimapVisibility();
    syncPhysicsMode();
  }
  mapSelect.addEventListener('change',()=>{
    testBots.value='0';testBotsStatus.textContent='Your bots are off.';
    botFillState=null;pendingBotFill=null;fillEmptySeats.checked=false;fillEmptySeats.disabled=true;
    if(activeMap.id==='open')soloPhysics={config:{...CONFIG},rider:{...rider},riderProfile:riderProfileControl.value,maxBoatSpeedMph,cruiseSpeedMph};
    activeMap=getMap(mapSelect.value);mapOverlay=createMapOverlay(activeMap);
    lakeSpawnAssigned=false;
    multiplayer.leave();controls.resetAll();setCruiseEnabled(false);
    if(activeMap.id==='oswego')restorePhysicsDefaults();
    else if(soloPhysics){
      Object.assign(CONFIG,soloPhysics.config);rider={...soloPhysics.rider};
      riderProfileControl.value=soloPhysics.riderProfile;
      maxBoatSpeedMph=soloPhysics.maxBoatSpeedMph;cruiseSpeedMph=soloPhysics.cruiseSpeedMph;
      syncPhysicsControls();
    }
    simulator.setMap(activeMap);
    simulator.setSharedWakeMode(activeMap.id==='oswego');
    reset(activeMap.spawn);syncMapUi();multiplayer.setMap(activeMap.id);
    try { localStorage.setItem('wake-rider-oswego-map',activeMap.id); } catch { /* Optional preference. */ }
    const url=new URL(location.href);url.searchParams.set('map',activeMap.id);history.replaceState(null,'',url);
    document.querySelector('#map-status').textContent=`${activeMap.name} loaded. New run ready.`;
  });
  document.querySelector('#show-map').onclick=()=>{controls.resetAll();setCruiseEnabled(false);mapOverlay.drawChart(lakeChart,replay.ghost?.boat||boat,replay.ghost?.tube||tube,true,multiplayer.getPeers(),multiplayer.color);mapDialog.showModal();};
  document.querySelector('#close-map').onclick=()=>mapDialog.close();
  syncMapUi();
  const riderProfileControl=document.querySelector('#rider-profile');
  function syncRiderControls(){
    document.querySelector('#rider-weight').value=String(rider.mass);document.querySelector('#rider-weight-value').value=`${rider.mass} lb`;
    document.querySelector('#rider-grip').value=String(rider.grip);document.querySelector('#rider-grip-value').value=`${rider.grip}%`;
  }
  riderProfileControl.addEventListener('change',e=>{if(e.target.value==='custom')return;rider={...RIDER_PROFILES[e.target.value]};syncRiderControls();reset();});
  const cruiseToggle=document.querySelector('#cruise-enabled'),cruiseSpeedControl=document.querySelector('#cruise-speed'),cruiseSpeedOutput=document.querySelector('#cruise-speed-value');
  function syncCruiseUi(){
    cruiseSpeedControl.max=String(maxBoatSpeedMph);cruiseSpeedControl.value=String(cruiseSpeedMph);
    const speedLabel=Number.isInteger(cruiseSpeedMph)?cruiseSpeedMph.toFixed(0):cruiseSpeedMph.toFixed(1);
    cruiseSpeedOutput.value=`${speedLabel} mph`;cruiseToggle.checked=cruiseEnabled;
    ui.cruiseIndicator.textContent=`CRUISE ${speedLabel}`;ui.speedometer.classList.toggle('cruise-active',cruiseEnabled);
  }
  function setCruiseEnabled(enabled){
    cruiseEnabled=!!enabled;simulator.resetCruiseController();syncCruiseUi();updateSpeedometerScale();
  }
  function setCruiseSpeed(value){
    cruiseSpeedMph=clamp(Math.round(Number(value)*2)/2,Number(cruiseSpeedControl.min),maxBoatSpeedMph);
    simulator.resetCruiseController();syncCruiseUi();updateSpeedometerScale();
  }
  cruiseToggle.addEventListener('change',e=>setCruiseEnabled(e.target.checked));
  cruiseSpeedControl.addEventListener('input',e=>setCruiseSpeed(e.target.value));
  const boatProfileControl=document.querySelector('#boat-profile'),boatProfileDetails=document.querySelector('#boat-profile-details'),towAttachmentControl=document.querySelector('#tow-attachment');
  function describeBoatProfile(profile){
    const displayLength=profile.overallLengthFt||profile.lengthFt,lengthLabel=displayLength.toFixed(2).replace(/\.00$|0$/,'');
    const beamLabel=profile.beamFt.toFixed(2).replace(/\.00$|0$/,'');
    return `${profile.driveLabel} · ${profile.engineHp} hp · ${profile.weightLb.toLocaleString()} lb · ${lengthLabel} × ${beamLabel} ft · ${profile.topSpeedMph} mph reference top`;
  }
  function setBoatProfile(id,restartRun=true){
    activeBoatProfile=applyBoatProfile(id);boatStyle=activeBoatProfile.style;
    boatProfileControl.value=activeBoatProfile.id;boatProfileDetails.textContent=describeBoatProfile(activeBoatProfile);
    document.querySelector('#boat-length').value=String(activeBoatProfile.lengthFt);
    document.querySelector('#boat-length-value').value=`${activeBoatProfile.lengthFt} ft`;
    towAttachmentControl.value=CONFIG.boatTowAttachment;
    document.querySelector('#tow-point-height').value=String(CONFIG.boatTowPointHeightFt);
    document.querySelector('#tow-point-height-value').value=`${CONFIG.boatTowPointHeightFt} ft`;
    maxBoatSpeedMph=activeBoatProfile.topSpeedMph;
    document.querySelector('#max-boat-speed').value=String(maxBoatSpeedMph);
    document.querySelector('#max-boat-speed-value').value=`${maxBoatSpeedMph} mph`;
    setCruiseSpeed(Math.min(cruiseSpeedMph,maxBoatSpeedMph));
    if(restartRun)reset();
  }
  function setTowAttachment(type,restartRun=true){
    const attachment=applyBoatTowAttachment(activeBoatProfile,type);
    towAttachmentControl.value=attachment.type;
    document.querySelector('#tow-point-height').value=String(attachment.heightFt);
    document.querySelector('#tow-point-height-value').value=`${attachment.heightFt} ft`;
    if(restartRun)reset();
  }
  towAttachmentControl.addEventListener('change',e=>setTowAttachment(e.target.value));
  boatProfileDetails.textContent=describeBoatProfile(activeBoatProfile);
  const cameraViewControl=document.querySelector('#camera-view');
  function setView(next){
    view=next;
    for(const name of ['top','driver','tube','person','helm'])app.classList.toggle(`view-${name}`,name===view);
    document.querySelectorAll('[data-view]').forEach(b=>{
      b.classList.toggle('selected',b.dataset.view===view);
      b.setAttribute('aria-pressed',String(b.dataset.view===view));
    });
    cameraViewControl.value=next;
  }
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
  cameraViewControl.addEventListener('change',e=>setView(e.target.value));
  document.querySelector('#show-digital-gauges').addEventListener('change',e=>{showDigitalGauges=e.target.checked;app.classList.toggle('hide-digital-gauges',!showDigitalGauges);});
  const dialog=document.querySelector('#instructions');
  document.querySelector('#help').onclick=()=>dialog.showModal();
  document.querySelector('#close-help').onclick=()=>dialog.close();
  const physicsPanel=document.querySelector('#physics-panel'),physicsButton=document.querySelector('#physics-tools');
  for(const eventName of ['input','change'])physicsPanel.addEventListener(eventName,event=>{
    if(activeMap.id==='oswego' && event.target.closest('[data-physics-tuning]')){
      event.preventDefault();event.stopImmediatePropagation();syncPhysicsControls();
    }
  },true);
  function syncPhysicsMode(){
    const locked=activeMap.id==='oswego';
    document.querySelector('#physics-tools').textContent=locked?'MENU':'PHYSICS';
    document.querySelector('#physics-panel-title').textContent=locked?'Menu':'Physics lab';
    document.querySelector('#close-physics').setAttribute('aria-label',locked?'Close menu':'Close physics panel');
    for(const section of document.querySelectorAll('[data-physics-tuning]'))section.hidden=locked;
    for(const control of document.querySelectorAll('[data-physics-tuning] input, [data-physics-tuning] select'))control.disabled=locked;
    document.querySelector('.physics-note').hidden=locked;
    document.querySelector('#physics-mode-note').textContent=locked
      ? 'Shared lake · Physics are fixed at the defaults for every player. Switch to Open Water to tune them.'
      : 'Solo Open Water · Physics tuning is unlocked. Your settings are kept when you visit the shared lake.';
    document.querySelector('.physics-kicker').textContent=locked?'SHARED LAKE':'LIVE TUNING';
    document.querySelector('#physics-panel-description').textContent=locked
      ? 'Choose a map, manage your minimap, or adjust your camera.'
      : 'Adjust the boat, tow setup, rider, water, and camera while the simulation runs.';
    document.querySelector('#reset-physics-defaults').textContent=locked?'RESET VIEW':'RESTORE DEFAULTS';
  }
  const desktopPhysicsPanel=matchMedia('(min-width: 901px)');
  function closePhysicsPanel(){
    if(physicsPanel.open)physicsPanel.close();
    app.classList.remove('physics-open');requestAnimationFrame(resize);
  }
  function openPhysicsPanel(){
    if(desktopPhysicsPanel.matches)physicsPanel.show();else physicsPanel.showModal();
    lastChartTime=-1;
    app.classList.add('physics-open');requestAnimationFrame(resize);
  }
  function syncPhysicsPanelMode(){if(physicsPanel.open){closePhysicsPanel();openPhysicsPanel();}}
  physicsButton.onclick=()=>physicsPanel.open?closePhysicsPanel():openPhysicsPanel();
  document.querySelector('#close-physics').onclick=closePhysicsPanel;
  physicsPanel.addEventListener('close',()=>{
    // Switching between modal and docked layouts queues a close event even
    // though the panel has already reopened in its new layout.
    if(!physicsPanel.open){app.classList.remove('physics-open');requestAnimationFrame(resize);}
  });
  physicsPanel.addEventListener('cancel',event=>{event.preventDefault();closePhysicsPanel();});
  desktopPhysicsPanel.addEventListener('change',syncPhysicsPanelMode);
  addEventListener('keydown',event=>{if(event.code==='Escape'&&physicsPanel.open&&!mapDialog.open&&desktopPhysicsPanel.matches)closePhysicsPanel();});
  const bindTune=(id,outId,apply,format)=>{const control=document.querySelector(`#${id}`),out=document.querySelector(`#${outId}`);control.addEventListener('input',()=>{const value=Number(control.value);apply(value);out.value=format(value);});};
  const cameraFovControl=document.querySelector('#camera-fov'),cameraFovOutput=document.querySelector('#camera-fov-value');
  function setCameraFov(value){
    cameraFovDeg=clamp(Math.round(value),Number(cameraFovControl.min),Number(cameraFovControl.max));
    cameraFovControl.value=String(cameraFovDeg);cameraFovOutput.value=`${cameraFovDeg}°`;
    canvas.setAttribute('aria-label',`Boat and tube simulator, camera field of view ${cameraFovDeg} degrees`);
  }
  bindTune('camera-fov','camera-fov-value',setCameraFov,v=>`${v}°`);
  let fovWheelDelta=0;
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    const pixelDelta=event.deltaMode===1?event.deltaY*16:event.deltaMode===2?event.deltaY*innerHeight:event.deltaY;
    fovWheelDelta+=pixelDelta;
    const steps=Math.trunc(fovWheelDelta/100);
    if(!steps)return;
    const appliedSteps=clamp(steps,-4,4);fovWheelDelta-=appliedSteps*100;
    setCameraFov(cameraFovDeg+appliedSteps*2);
  },{passive:false});
  const openWaterTouches=new Map();
  let pinchStart=null;
  const pinchDistance=()=>{
    const points=Array.from(openWaterTouches.values());
    return points.length===2?len(points[0].x-points[1].x,points[0].y-points[1].y):0;
  };
  const beginPinch=()=>{const distance=pinchDistance();pinchStart=distance>8?{distance,fov:cameraFovDeg}:null;};
  canvas.addEventListener('pointerdown',event=>{
    if(event.pointerType!=='touch')return;
    openWaterTouches.set(event.pointerId,{x:event.clientX,y:event.clientY});canvas.setPointerCapture(event.pointerId);
    if(openWaterTouches.size===2)beginPinch();else if(openWaterTouches.size>2)pinchStart=null;
  });
  canvas.addEventListener('pointermove',event=>{
    if(event.pointerType!=='touch'||!openWaterTouches.has(event.pointerId))return;
    openWaterTouches.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(openWaterTouches.size!==2||!pinchStart)return;
    const ratio=pinchDistance()/pinchStart.distance;
    if(!Number.isFinite(ratio)||ratio<=0)return;
    const startRadians=pinchStart.fov*Math.PI/180;
    setCameraFov(2*Math.atan(Math.tan(startRadians/2)/ratio)*180/Math.PI);
  });
  const endOpenWaterTouch=event=>{
    if(event.pointerType!=='touch')return;
    openWaterTouches.delete(event.pointerId);
    if(openWaterTouches.size===2)beginPinch();else pinchStart=null;
  };
  canvas.addEventListener('pointerup',endOpenWaterTouch);canvas.addEventListener('pointercancel',endOpenWaterTouch);canvas.addEventListener('lostpointercapture',endOpenWaterTouch);
  bindTune('rider-weight','rider-weight-value',v=>{rider.mass=v;riderProfileControl.value='custom';},v=>`${v} lb`);
  bindTune('rider-grip','rider-grip-value',v=>{rider.grip=v;riderProfileControl.value='custom';},v=>`${v}%`);
  bindTune('tube-friction','tube-friction-value',v=>CONFIG.tubeWaterFriction=v/100,v=>`${v}%`);
  bindTune('boat-length','boat-length-value',v=>{CONFIG.boatLength=v;if(activeMap.id==='oswego')reset();},v=>`${v} ft`);
  bindTune('rope-length','rope-length-value',v=>{CONFIG.ropeLength=v*UNITS_PER_FOOT;reset();},v=>`${v} ft`);
  bindTune('tow-point-height','tow-point-height-value',v=>{CONFIG.boatTowPointHeightFt=v;reset();},v=>`${v} ft`);
  bindTune('hairpin-steering','hairpin-steering-value',v=>CONFIG.hairpinStrength=v/100,v=>`${v}%`);
  const formatGravity=value=>`${(value/100).toFixed(2)} g · ${(STANDARD_GRAVITY_FT_PER_SECOND_SQUARED*value/100).toFixed(1)} ft/s²`;
  bindTune('gravity','gravity-value',v=>CONFIG.gravity=STANDARD_GRAVITY*v/100,formatGravity);
  document.querySelector('#gravity').addEventListener('change',reset);
  bindTune('wake-strength','wake-strength-value',v=>CONFIG.wakeStrength=v/100,v=>`${v}%`);
  bindTune('wake-life','wake-life-value',v=>CONFIG.wakeLife=v,v=>`${v} sec`);
  function updateSpeedometerScale(){
    ui.speedQuarter.textContent=Math.round(maxBoatSpeedMph*.25);
    ui.speedHalf.textContent=Math.round(maxBoatSpeedMph*.5);
    ui.speedThreeQuarter.textContent=Math.round(maxBoatSpeedMph*.75);
    ui.speedMaxLabel.textContent=maxBoatSpeedMph;
    const cruiseLabel=cruiseEnabled?`, cruise set to ${cruiseSpeedMph} mph`:'';
    ui.speedometer.setAttribute('aria-label',`Analog boat speedometer, ${maxBoatSpeedMph} mph scale${cruiseLabel}`);
  }
  const maxSpeedControl=document.querySelector('#max-boat-speed');
  maxSpeedControl.min=MIN_LAB_MAX_MPH;maxSpeedControl.max=LAB_MAX_MPH;maxSpeedControl.value=maxBoatSpeedMph;
  bindTune('max-boat-speed','max-boat-speed-value',v=>{maxBoatSpeedMph=clamp(v,MIN_LAB_MAX_MPH,LAB_MAX_MPH);setCruiseSpeed(Math.min(cruiseSpeedMph,maxBoatSpeedMph));},v=>`${v} mph`);
  syncCruiseUi();
  updateSpeedometerScale();
  document.querySelector('#debug-mode').addEventListener('change',e=>{debug=e.target.checked;physicsButton.classList.toggle('selected',debug);});
  function syncPhysicsControls(){
    if(activeMap.id==='oswego')riderProfileControl.value=LAB_DEFAULTS.rider;
    const restore=(id,value,outId,formatted)=>{document.querySelector(`#${id}`).value=String(value);if(outId)document.querySelector(`#${outId}`).value=formatted;};
    restore('boat-length',CONFIG.boatLength,'boat-length-value',`${CONFIG.boatLength} ft`);
    const ropeFeet=Math.round(CONFIG.ropeLength/UNITS_PER_FOOT);
    restore('rope-length',ropeFeet,'rope-length-value',`${ropeFeet} ft`);
    restore('tow-attachment',CONFIG.boatTowAttachment);
    restore('tow-point-height',CONFIG.boatTowPointHeightFt,'tow-point-height-value',`${CONFIG.boatTowPointHeightFt} ft`);
    const gravityPercent=Math.round(CONFIG.gravity/STANDARD_GRAVITY*100);
    restore('gravity',gravityPercent,'gravity-value',formatGravity(gravityPercent));
    const wakePercent=Math.round(CONFIG.wakeStrength*100);
    restore('wake-strength',wakePercent,'wake-strength-value',`${wakePercent}%`);
    restore('wake-life',CONFIG.wakeLife,'wake-life-value',`${CONFIG.wakeLife} sec`);
    restore('max-boat-speed',maxBoatSpeedMph,'max-boat-speed-value',`${maxBoatSpeedMph} mph`);
    const steeringPercent=Math.round(CONFIG.hairpinStrength*100),frictionPercent=Math.round(CONFIG.tubeWaterFriction*100);
    restore('hairpin-steering',steeringPercent,'hairpin-steering-value',`${steeringPercent}%`);
    restore('tube-friction',frictionPercent,'tube-friction-value',`${frictionPercent}%`);
    syncRiderControls();syncCruiseUi();updateSpeedometerScale();
  }
  function restorePhysicsDefaults(){
    setBoatProfile(LAB_DEFAULTS.boatProfileId,false);
    setTowAttachment(LAB_DEFAULTS.towAttachment,false);
    rider={...RIDER_PROFILES[LAB_DEFAULTS.rider]};
    riderProfileControl.value=LAB_DEFAULTS.rider;
    maxBoatSpeedMph=LAB_DEFAULTS.maxBoatSpeedMph;
    cruiseSpeedMph=LAB_DEFAULTS.cruiseSpeedMph;
    Object.assign(CONFIG,{
      tubeWaterFriction:LAB_DEFAULTS.tubeWaterFriction,
      boatLength:LAB_DEFAULTS.boatLength,
      ropeLength:LAB_DEFAULTS.ropeLengthFt*UNITS_PER_FOOT,
      boatTowPointHeightFt:LAB_DEFAULTS.towPointHeightFt,
      gravity:STANDARD_GRAVITY*LAB_DEFAULTS.gravityScale,
      wakeStrength:LAB_DEFAULTS.wakeStrength,
      wakeLife:LAB_DEFAULTS.wakeLife,
      hairpinStrength:LAB_DEFAULTS.hairpinStrength
    });
    setCruiseEnabled(LAB_DEFAULTS.cruiseEnabled);
    syncPhysicsControls();
  }
  document.querySelector('#reset-physics-defaults').onclick=()=>{
    if(activeMap.id==='open')restorePhysicsDefaults();
    setCameraFov(LAB_DEFAULTS.cameraFovDeg);
    showDigitalGauges=LAB_DEFAULTS.showDigitalGauges;
    debug=LAB_DEFAULTS.debug;
    document.querySelector('#show-digital-gauges').checked=showDigitalGauges;
    document.querySelector('#debug-mode').checked=debug;
    app.classList.toggle('hide-digital-gauges',!showDigitalGauges);
    physicsButton.classList.remove('selected');
    setView(LAB_DEFAULTS.view);
    if(activeMap.id==='open')reset();
  };
  document.querySelector('#replay-trace').onclick=()=>{
    if(!simulator.startReplay())return;
    syncSimulationState();closePhysicsPanel();
    updateCameraForBodies(replay.ghost.boat,replay.ghost.tube,1/120,true);
  };

  function update(dt){
    if(activeMap.id==='oswego'&&!multiplayer.ready){controls.resetAll();return;}
    controls.pollGamepad();
    if(replay.active){
      const result=simulator.step({dt,throttle:{forward:0,reverse:0},steer:0,maxSpeedMph:maxBoatSpeedMph,cruiseEnabled:false,cruiseSpeedMph,rider});
      syncSimulationState(result.state);
      if(result.replayGhost)updateCameraForBodies(result.replayGhost.boat,result.replayGhost.tube,dt);
      return;
    }
    const controlState=controls.sample();
    const forwardThrottle=controlState.forward;
    const reverseThrottle=controlState.reverse;
    if(cruiseEnabled&&reverseThrottle>.035)setCruiseEnabled(false);
    // Water loading on the rudder tends to return an unattended helm toward
    // center. The effect is weak near idle and increases with boat speed.
    if(!wheelHeld && Math.abs(boat.speed)>9 && Math.abs(touchWheelAngle)>.05){
      touchWheelAngle*=Math.exp(-dt*(.22+Math.abs(boat.speed)/145));
      if(Math.abs(touchWheelAngle)<.15)touchWheelAngle=0;applyTouchWheel();
    }
    const steer=controlState.steer;
    const result=simulator.step({
      dt,
      throttle:{forward:forwardThrottle,reverse:reverseThrottle},
      steer,
      maxSpeedMph:maxBoatSpeedMph,
      cruiseEnabled,
      cruiseSpeedMph,
      rider
    });
    syncSimulationState(result.state);
    updateCameraForBodies(boat,tube,dt);
    const {boatMph,tubeMph,ropePct,airFt}=result.metrics;
    ui.speed.textContent=boatMph.toFixed(1);
    ui.tubeSpeed.textContent=tubeMph.toFixed(1);
    ui.g.textContent=tube.feltG.toFixed(1);ui.peakG.textContent=`peak ${tube.peakG.toFixed(1)}`;ui.gBar.style.width=`${clamp(tube.feltG/4,0,1)*100}%`;
    ui.tension.textContent=ropePct;ui.air.textContent=airFt.toFixed(1);
    const speedometerMax=maxBoatSpeedMph;
    ui.boatBar.style.width=`${clamp(boatMph/speedometerMax,0,1)*100}%`;ui.tubeBar.style.width=`${clamp(tubeMph/50,0,1)*100}%`;ui.ropeBar.style.width=`${ropePct}%`;ui.airBar.style.width=`${clamp(airFt/10,0,1)*100}%`;
    ui.peakSpeed.textContent=`pk ${peaks.boat.toFixed(1)}`;ui.peakTubeSpeed.textContent=`pk ${peaks.tube.toFixed(1)}`;ui.peakTension.textContent=`pk ${Math.round(peaks.rope)}`;ui.peakAir.textContent=`pk ${peaks.air.toFixed(1)}`;
    const gauge=clamp(boatMph/speedometerMax,0,1);
    ui.needle.style.transform=`rotate(${-180+gauge*180}deg)`;
    const heading=Math.round(boatHeadingDegrees(boat.angle))%360;
    ui.compassCard.style.transform=`rotate(${-heading}deg)`;
    ui.compass.setAttribute('aria-label',`Marine compass, boat heading ${heading} degrees`);
    const lever=forwardThrottle-reverseThrottle;
    const gateHeight=throttleGate.clientHeight,handleHalf=9,neutralY=gateHeight*THROTTLE_FORWARD_SHARE;
    const handleCenterY=lever>=0
      ? neutralY+(handleHalf-neutralY)*lever
      : neutralY+(gateHeight-handleHalf-neutralY)*-lever;
    ui.handle.style.top=`${handleCenterY-handleHalf}px`;ui.handle.style.bottom='auto';
    ui.throttleValue.value=lever===0?'NEUTRAL':`${lever>0?'FWD':'REV'} ${Math.round(Math.abs(lever)*100)}%`;
    ui.wheel.style.transform=`rotate(${boat.wheel*135}deg)`;
    ui.controller.textContent=controlState.gamepadConnected?'XBOX CONNECTED':'';ui.controller.classList.toggle('connected',controlState.gamepadConnected);
  }

  function updateCameraForBodies(cameraBoat,cameraTube,dt,snap=false){
    updateFollowCamera(camera,{
      boat:cameraBoat,
      tube:cameraTube,
      dt,
      snap,
      view,
      viewportWidth:w,
      showDigitalGauges,
      fovDeg:cameraFovDeg
    });
  }

  function screen(x,y){ const scale=clamp(Math.min(w,h)/650,.72,1.2)*camera.zoom,dx=x-camera.x,dy=y-camera.y,c=Math.cos(camera.angle),s=Math.sin(camera.angle); return {x:w/2+(dx*c-dy*s)*scale,y:h/2+(dx*s+dy*c)*scale,scale}; }
  function drawLake(){
    const g=ctx.createLinearGradient(0,0,w,h);g.addColorStop(0,'#17627a');g.addColorStop(1,'#0b435c');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
    ctx.globalAlpha=.12;ctx.strokeStyle='#b7f0ef';ctx.lineWidth=1;
    // These calm-water ripples live in lake/world coordinates. Projecting each
    // point through the camera makes the surface rotate beneath Driver and Tube
    // views, which supplies an immediate visual cue that the boat is turning.
    const lakeScale=screen(camera.x,camera.y).scale;
    const cameraCos=Math.cos(camera.angle),cameraSin=Math.sin(camera.angle);
    // Keep the calm-water bands on a fixed ten-foot world spacing. Besides
    // rotating with the heading, they now provide an honest scale reference:
    // the 21.75-foot wake boat visibly spans a little more than two bands.
    const gap=10*UNITS_PER_FOOT,step=2*UNITS_PER_FOOT;
    const radius=Math.hypot(w,h)*.5/lakeScale+gap*2;
    const firstY=Math.floor((camera.y-radius)/gap)*gap;
    for(let worldY=firstY;worldY<=camera.y+radius;worldY+=gap){
      ctx.beginPath();let started=false;
      for(let worldX=camera.x-radius;worldX<=camera.x+radius;worldX+=step){
        const rippleY=worldY+Math.sin(worldX*.03+simTime*.35)*3;
        const dx=worldX-camera.x,dy=rippleY-camera.y;
        const screenX=w/2+(dx*cameraCos-dy*cameraSin)*lakeScale;
        const screenY=h/2+(dx*cameraSin+dy*cameraCos)*lakeScale;
        if(!started){ctx.moveTo(screenX,screenY);started=true;}else ctx.lineTo(screenX,screenY);
      }
      ctx.stroke();
    }
    ctx.globalAlpha=1;
  }
  function drawWakes(limit=wakes.length){
    ctx.lineCap='round';
    for(let i=Math.max(0,wakes.length-limit);i<wakes.length;i++){
      const q=wakes[i];
      const fadeWindow=Math.min(12,CONFIG.wakeLife*.34),p=screen(q.x,q.y),fade=clamp(q.strength,0,1)*clamp((CONFIG.wakeLife-q.age)/fadeWindow,0,1);
      if(p.x<-60||p.x>w+60||p.y<-60||p.y>h+60)continue;
      const mag=len(q.dx,q.dy)||1,tx=-q.dy/mag,ty=q.dx/mag,c=Math.cos(camera.angle),s=Math.sin(camera.angle),stx=tx*c-ty*s,sty=tx*s+ty*c,half=Math.min(q.width*1.45,36)*p.scale;
      ctx.strokeStyle=`rgba(234,246,224,${fade*.52})`;ctx.lineWidth=clamp(q.width*.16,1,4);
      ctx.beginPath();ctx.moveTo(p.x-stx*half,p.y-sty*half);ctx.lineTo(p.x+stx*half,p.y+sty*half);ctx.stroke();
    }
  }
  function polygon(points,fill,stroke,lineWidth=2){ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);for(let i=1;i<points.length;i++)ctx.lineTo(points[i][0],points[i][1]);ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lineWidth;ctx.stroke();}}
  function drawBoat(){
    const p=screen(boat.x,boat.y),a=boat.angle+camera.angle,s=p.scale;
    const lengthScale=CONFIG.boatLength*UNITS_PER_FOOT/BOAT_SPRITE_LENGTH,beamScale=CONFIG.boatBeam*UNITS_PER_FOOT/BOAT_SPRITE_BEAM;
    if(boat.splash){ctx.strokeStyle=`rgba(220,250,255,${boat.splash*.8})`;ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(p.x,p.y,42*s*lengthScale*(1.3-boat.splash*.25),18*s*beamScale*(1.3-boat.splash*.25),a,0,TAU);ctx.stroke();}
    ctx.save();ctx.translate(p.x,p.y);ctx.rotate(a);ctx.scale(lengthScale,beamScale);
    ctx.fillStyle='#06273544';ctx.beginPath();ctx.ellipse(-7*s,7*s,38*s,17*s,0,0,TAU);ctx.fill();
    ctx.restore();
    ctx.save();
    drawBoatTop(ctx,screen,boat,CONFIG.boatLength*UNITS_PER_FOOT,CONFIG.boatBeam*UNITS_PER_FOOT,boatStyle);
    ctx.restore();
  }
  function drawTow(){
    const tow=towPoint(boat),tubeEye=tubeTowPoint(tube),visualTowZ=tow.baseZ+(tow.z-tow.baseZ)*TOW_HEIGHT_RENDER_SCALE,heightCompression=tow.z-visualTowZ,b=screen(tow.x,tow.y),towBase=screen(tow.x,tow.y);b.y-=visualTowZ*b.scale;towBase.y-=tow.baseZ*towBase.scale;ctx.strokeStyle= tube.tension>8 ? '#ffe7a6' : '#c7b98d';ctx.lineWidth=1.5+clamp(tube.tension/180,0,1);ctx.setLineDash(tube.tension>8?[]:[7,5]);ctx.beginPath();
    for(let i=0;i<ropeChain.length;i++){const n=ropeChain[i],p=screen(n.x,n.y),t=i/(ropeChain.length-1),physicalZ=Number.isFinite(n.z)?n.z:tow.z+(tubeEye.z-tow.z)*t,z=physicalZ-heightCompression*(1-t);p.y-=z*p.scale;if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}
    ctx.stroke();ctx.setLineDash([]);
    ctx.strokeStyle='#a9bbc0';ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(towBase.x,towBase.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    // The main view is almost overhead, so the mast height is visually
    // compressed to keep a central tower from reading as a bow attachment.
    // The mirror and physics retain the full configured height.
    ctx.fillStyle='#f4d66f';ctx.strokeStyle='#493c2c';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(b.x,b.y,3.5*b.scale,0,TAU);ctx.fill();ctx.stroke();
  }
  function drawTube(){
    const p=screen(tube.x,tube.y),z=tube.z*p.scale,a=tube.angle+camera.angle,s=p.scale;
    const radius=CONFIG.tubeRadius*s;
    if(tube.splash){ctx.strokeStyle=`rgba(220,250,255,${tube.splash})`;ctx.lineWidth=4;ctx.beginPath();ctx.ellipse(p.x,p.y,radius*1.65*(1.4-tube.splash/2),radius*.8*(1.4-tube.splash/2),0,0,TAU);ctx.stroke();}
    if(tube.collisionSplash){
      const edge=screen(tube.x+(tube.collisionNormalX||0)*CONFIG.tubeRadius,tube.y+(tube.collisionNormalY||0)*CONFIG.tubeRadius);
      const splashAngle=Math.atan2(edge.y-p.y,edge.x-p.x),spread=radius*(1.05+(1-tube.collisionSplash)*.8);
      ctx.strokeStyle=`rgba(230,252,255,${tube.collisionSplash*.9})`;ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(edge.x,edge.y,spread,spread*.34,splashAngle,0,TAU);ctx.stroke();
    }
    ctx.fillStyle='#041f2b55';ctx.beginPath();ctx.ellipse(p.x,p.y,radius*1.08,radius*.5,0,0,TAU);ctx.fill();
    ctx.save();ctx.translate(p.x,p.y-z);ctx.rotate(a);
    if(tube.collisionCompression){const deformationAngle=Math.atan2(tube.collisionNormalY||0,tube.collisionNormalX||1)-tube.angle;ctx.rotate(deformationAngle);ctx.scale(1-tube.collisionCompression*.3,1+tube.collisionCompression*.12);ctx.rotate(-deformationAngle);}
    ctx.fillStyle='#ffca44';ctx.strokeStyle='#74451f';ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,radius,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#17475c';ctx.beginPath();ctx.arc(0,0,radius*.38,0,TAU);ctx.fill();ctx.fillStyle='#f07c3d';ctx.fillRect(-radius*.19,-radius*.86,radius*.38,radius*1.72);ctx.fillStyle='#f4d66f';ctx.strokeStyle='#493c2c';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(CONFIG.tubeTowOffset*s,0,Math.max(2.2,radius*.15),0,TAU);ctx.fill();ctx.stroke();
    if(tube.riderOn)drawTubeRiderTop(ctx,CONFIG.tubeRadius*s,rider.color);
    ctx.restore();
    if(tube.fallSplash&&!tube.fallenRider){ctx.strokeStyle=`rgba(230,250,255,${tube.fallSplash})`;ctx.lineWidth=3;ctx.beginPath();ctx.arc(p.x+26*s,p.y,22*s*(2-tube.fallSplash),0,TAU);ctx.stroke();}
  }
  function drawFallenRider(){
    const body=tube.fallenRider;if(!body||replay.active)return;
    ctx.save();
    for(const impact of body.impacts){
      const p=screen(impact.x,impact.y),fade=clamp(1-impact.age/1.35,0,1),radius=(8+impact.age*32)*p.scale;
      ctx.strokeStyle=`rgba(226,249,255,${fade*impact.strength})`;ctx.lineWidth=2.5;ctx.beginPath();ctx.ellipse(p.x,p.y,radius,radius*.42,0,0,TAU);ctx.stroke();
    }
    const p=screen(body.x,body.y),s=p.scale,z=body.z*s;
    if(!body.floating){ctx.fillStyle='rgba(1,22,31,.3)';ctx.beginPath();ctx.ellipse(p.x,p.y,9*s,3.5*s,0,0,TAU);ctx.fill();}
    ctx.translate(p.x,p.y-z);ctx.rotate(body.angle+camera.angle+body.tumble);
    ctx.strokeStyle='#f0bd91';ctx.lineWidth=2.4*s;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(-4*s,0);ctx.lineTo(-11*s,-5*s);ctx.moveTo(-4*s,0);ctx.lineTo(-11*s,5*s);ctx.moveTo(4*s,0);ctx.lineTo(10*s,-5*s);ctx.moveTo(4*s,0);ctx.lineTo(10*s,5*s);ctx.stroke();
    ctx.fillStyle=body.color||rider.color;ctx.strokeStyle='#173747';ctx.lineWidth=1.4*s;ctx.beginPath();ctx.ellipse(0,0,8*s,4.6*s,0,0,TAU);ctx.fill();ctx.stroke();
    ctx.fillStyle='#f0bd91';ctx.beginPath();ctx.arc(10*s,0,3.7*s,0,TAU);ctx.fill();ctx.stroke();ctx.restore();
  }
  function drawTrace(){
    const path=(points,color)=>{if(points.length<2)return;ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();for(let i=0;i<points.length;i++){const p=screen(points[i].x,points[i].y);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.stroke();};
    path(traces.boat,'rgba(116,220,229,.45)');path(traces.tube,'rgba(255,198,72,.55)');
  }
  function drawDebug(){
    if(!debug)return;
    ctx.save();
    const boatTow=towPoint(boat),tubeEye=tubeTowPoint(tube),visualTowZ=boatTow.baseZ+(boatTow.z-boatTow.baseZ)*TOW_HEIGHT_RENDER_SCALE,heightCompression=boatTow.z-visualTowZ;
    for(let i=0;i<ropeChain.length;i++){
      const node=ropeChain[i],p=screen(node.x,node.y),t=i/(ropeChain.length-1),physicalZ=Number.isFinite(node.z)?node.z:boatTow.z+(tubeEye.z-boatTow.z)*t,z=physicalZ-heightCompression*(1-t);
      ctx.fillStyle=i===0||i===ropeChain.length-1?'#fff1a3':'#d8f0ea';ctx.beginPath();ctx.arc(p.x,p.y-z*p.scale,2.5,0,TAU);ctx.fill();
    }
    const drawWaterContact=(contact,color,shape)=>{
      const p=screen(contact.x,contact.y),y=p.y-contact.height*p.scale;
      ctx.fillStyle=color;ctx.strokeStyle='#092d3b';ctx.lineWidth=1.7;ctx.beginPath();
      if(shape==='diamond'){ctx.moveTo(p.x,y-4.5);ctx.lineTo(p.x+4.5,y);ctx.lineTo(p.x,y+4.5);ctx.lineTo(p.x-4.5,y);ctx.closePath();}
      else ctx.arc(p.x,y,4.5,0,TAU);
      ctx.fill();ctx.stroke();
    };
    if(boat.waterContacts){
      const colors={bow:'#ef6c50',stern:'#72d2be',left:'#80aef0',right:'#df8ee0',center:'#fff1a3'};
      for(const contact of Object.values(boat.waterContacts))drawWaterContact(contact,colors[contact.name],'diamond');
    }
    drawSteeringHardwareDebug();
    if(tube.contacts){
      const colors={front:'#ef6c50',back:'#72d2be',left:'#80aef0',right:'#df8ee0'};
      for(const contact of tube.contacts.points)drawWaterContact(contact,colors[contact.name],'circle');
    }
    if(tube.collisionAge<.8&&Number.isFinite(tube.collisionContactX)){
      const contact=screen(tube.collisionContactX,tube.collisionContactY),normalEnd=screen(tube.collisionContactX+(tube.collisionNormalX||0)*4*UNITS_PER_FOOT,tube.collisionContactY+(tube.collisionNormalY||0)*4*UNITS_PER_FOOT);
      ctx.strokeStyle='#ff9b65';ctx.fillStyle='#ff9b65';ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(contact.x,contact.y,6,0,TAU);ctx.stroke();ctx.beginPath();ctx.moveTo(contact.x,contact.y);ctx.lineTo(normalEnd.x,normalEnd.y);ctx.stroke();
    }
    const tubeEyeMarker=screen(tubeEye.x,tubeEye.y);ctx.strokeStyle='#63e2ef';ctx.lineWidth=2;ctx.beginPath();ctx.arc(tubeEyeMarker.x,tubeEyeMarker.y-tubeEye.z*tubeEyeMarker.scale,7,0,TAU);ctx.stroke();
    const p=screen(tube.x,tube.y),startX=p.x,startY=p.y-tube.z*p.scale;
    const acceleration=Math.hypot(tube.debugAx,tube.debugAy,tube.debugAz||0),forceScale=.18*Math.min(1,180/(acceleration||1));
    const forceEnd=screen(tube.x+tube.debugAx*forceScale,tube.y+tube.debugAy*forceScale),endX=forceEnd.x,endY=forceEnd.y-(tube.z+(tube.debugAz||0)*forceScale)*forceEnd.scale;
    const arrowAngle=Math.atan2(endY-startY,endX-startX),arrowSize=6;
    ctx.strokeStyle='#ff7a59';ctx.fillStyle='#ff7a59';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(startX,startY);ctx.lineTo(endX,endY);ctx.stroke();ctx.beginPath();ctx.moveTo(endX,endY);ctx.lineTo(endX-Math.cos(arrowAngle-.55)*arrowSize,endY-Math.sin(arrowAngle-.55)*arrowSize);ctx.lineTo(endX-Math.cos(arrowAngle+.55)*arrowSize,endY-Math.sin(arrowAngle+.55)*arrowSize);ctx.closePath();ctx.fill();
    ctx.font='10px ui-monospace,monospace';ctx.fillText(`PITCH ${(tube.pitch*57.3).toFixed(1)}°  ROLL ${(tube.roll*57.3).toFixed(1)}°`,p.x+12,startY-28);
    ctx.restore();
  }
  function drawSteeringHardwareDebug(){
    const length=CONFIG.boatLength*UNITS_PER_FOOT,beam=CONFIG.boatBeam*UNITS_PER_FOOT;
    const fx=Math.cos(boat.angle),fy=Math.sin(boat.angle),sx=-fy,sy=fx;
    const steerAngle=(boat.wheel||0)*CONFIG.maxRudderAngleDeg*Math.PI/180;
    const local=(forward,side=0)=>({x:boat.x+fx*forward+sx*side,y:boat.y+fy*forward+sy*side});
    const line=(from,to,width=3)=>{const a=screen(from.x,from.y),b=screen(to.x,to.y);ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();};
    const axis=(pivot,angle,forwardLength,aftLength=forwardLength)=>{
      const dx=Math.cos(angle),dy=Math.sin(angle);
      line({x:pivot.x-dx*aftLength,y:pivot.y-dy*aftLength},{x:pivot.x+dx*forwardLength,y:pivot.y+dy*forwardLength});
    };
    const pivotDot=pivot=>{const p=screen(pivot.x,pivot.y);ctx.fillStyle='#63e2ef';ctx.beginPath();ctx.arc(p.x,p.y,2.6,0,TAU);ctx.fill();};
    ctx.strokeStyle='#63e2ef';ctx.fillStyle='#63e2ef';
    if(activeBoatProfile.driveType==='v-drive'){
      const pivot=local(-length*(CONFIG.steeringLeverRatio??.36));
      axis(pivot,boat.angle+steerAngle,1.25*UNITS_PER_FOOT);pivotDot(pivot);
    }else if(activeBoatProfile.driveType==='sterndrive'){
      // The whole lower unit pivots at the transom; the propeller thrust axis
      // therefore turns with it rather than acting through a separate rudder.
      const pivot=local(-length*.47),angle=boat.angle+steerAngle;
      const drive={x:pivot.x-Math.cos(angle)*length*.08,y:pivot.y-Math.sin(angle)*length*.08};
      line(pivot,drive,5);axis(drive,angle,1.4*UNITS_PER_FOOT,.45*UNITS_PER_FOOT);pivotDot(pivot);
    }else if(activeBoatProfile.driveType==='outboard'){
      // Show the larger motor body and its steered lower-unit/thrust axis.
      const mount=local(-length*.49),angle=boat.angle+steerAngle;
      const motor={x:mount.x-Math.cos(angle)*length*.1,y:mount.y-Math.sin(angle)*length*.1};
      line(mount,motor,7);axis(motor,angle,1.75*UNITS_PER_FOOT,.65*UNITS_PER_FOOT);pivotDot(mount);
    }else if(activeBoatProfile.driveType==='jet'){
      // Jet-drive profiles use twin steering nozzles when added in development.
      for(const side of [-beam*.22,beam*.22]){
        const nozzle=local(-length*.47,side),angle=boat.angle+steerAngle;
        const aft={x:nozzle.x-Math.cos(angle)*1.25*UNITS_PER_FOOT,y:nozzle.y-Math.sin(angle)*1.25*UNITS_PER_FOOT};
        line(nozzle,aft,3);pivotDot(nozzle);
      }
    }
    const labelWorld=local(-length*.58),label=screen(labelWorld.x,labelWorld.y);
    ctx.font='700 9px ui-monospace,monospace';ctx.fillStyle='#9af2f7';ctx.fillText(activeBoatProfile.driveType==='v-drive'?'RUDDER':activeBoatProfile.driveType==='jet'?'TWIN JETS':activeBoatProfile.driveType==='outboard'?'MOTOR':'DRIVE',label.x+7,label.y-6);
  }
  function drawReplay(){
    if(!replay.ghost)return;
    const b=screen(replay.ghost.boat.x,replay.ghost.boat.y),t=screen(replay.ghost.tube.x,replay.ghost.tube.y),last=Math.min(Math.floor(replay.index),replay.boatFrames.length-1);
    ctx.save();ctx.globalAlpha=.72;
    const replayPath=(frames,color)=>{ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();for(let i=0;i<=last;i+=2){const p=screen(frames[i].x,frames[i].y);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.stroke();};
    replayPath(replay.boatFrames,'#83e4ef');replayPath(replay.tubeFrames,'#ffd05d');
    const boatY=b.y-replay.ghost.boat.z*b.scale,tubeY=t.y-replay.ghost.tube.z*t.scale;
    ctx.strokeStyle='#fff1b0';ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(b.x,boatY);ctx.lineTo(t.x,tubeY);ctx.stroke();ctx.setLineDash([]);
    ctx.save();drawBoatTop(ctx,screen,replay.ghost.boat,CONFIG.boatLength*UNITS_PER_FOOT,CONFIG.boatBeam*UNITS_PER_FOOT,boatColorStyle('#55c9dd'));ctx.restore();
    ctx.fillStyle='#ffc94b';ctx.strokeStyle='#fff3c6';ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(t.x,tubeY,10,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#17475c';ctx.beginPath();ctx.arc(t.x,tubeY,3.8,0,TAU);ctx.fill();
    if(replay.ghost.rider){const r=screen(replay.ghost.rider.x,replay.ghost.rider.y),riderY=r.y-replay.ghost.rider.z*r.scale;ctx.save();ctx.translate(r.x,riderY);ctx.rotate((replay.ghost.rider.angle||0)+camera.angle+(replay.ghost.rider.tumble||0));ctx.fillStyle=replay.ghost.rider.color||rider.color;ctx.strokeStyle='#fff3c6';ctx.lineWidth=1.5;ctx.beginPath();ctx.ellipse(0,0,9,4,0,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#f0bd91';ctx.beginPath();ctx.arc(10,0,3.2,0,TAU);ctx.fill();ctx.restore();}
    ctx.fillStyle='#fff3c6';ctx.font='700 11px ui-monospace,monospace';ctx.fillText('REPLAY',w/2-22,190);ctx.restore();
  }
  function roundedRectPath(x,y,width,height,radius){
    const r=Math.min(radius,width/2,height/2);
    ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+width-r,y);ctx.quadraticCurveTo(x+width,y,x+width,y+r);ctx.lineTo(x+width,y+height-r);ctx.quadraticCurveTo(x+width,y+height,x+width-r,y+height);ctx.lineTo(x+r,y+height);ctx.quadraticCurveTo(x,y+height,x,y+height-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
  }
  const helmBowCanvas=document.createElement('canvas'),helmBowContext=helmBowCanvas.getContext('2d');
  function drawHelmBow(body){
    // Crop the same boat's bow at the bottom of the driver's view. Composite
    // opacity stays subtle so it never hides a boat or wake ahead.
    const width=Math.min(w*.46,430),depth=Math.min(h*.17,width*.38),scale=width/BOAT_SPRITE_BEAM;
    const rise=clamp((body.pitch||0)*depth*.65,-5,5);
    const cw=Math.ceil(width+8),ch=Math.ceil(depth+16);
    if(helmBowCanvas.width!==cw||helmBowCanvas.height!==ch){helmBowCanvas.width=cw;helmBowCanvas.height=ch;}
    helmBowContext.clearRect(0,0,cw,ch);
    const project=(x,y)=>({x:cw/2+x*scale,y:8+rise+(y+BOAT_SPRITE_LENGTH/2)*scale,scale});
    drawBoatTop(helmBowContext,project,{x:0,y:0,z:0,angle:-Math.PI/2,roll:body.roll||0,pitch:0},BOAT_SPRITE_LENGTH,BOAT_SPRITE_BEAM,boatStyle);
    // Fade the completed bow once, rather than making hidden hull faces show
    // through each other when every individual polygon is translucent.
    ctx.save();ctx.globalAlpha=.3;ctx.drawImage(helmBowCanvas,(w-cw)/2,h-depth-8);ctx.restore();
  }
  // Both views use the original mirror's canvas artwork and perspective.
  // Helm adds only a subtle translucent bow to the forward view.
  function drawPerspectiveView(fullScreen=false){
    if(!fullScreen&&view!=='driver'&&view!=='helm')return;
    const mirrorWidth=fullScreen?w:Math.min(w-28,clamp(w*.87,280,500)),mirrorHeight=fullScreen?h:clamp(mirrorWidth*.28,78,125),mirrorX=(w-mirrorWidth)/2,mirrorY=fullScreen?0:w<=700?(showDigitalGauges?126:76):74;
    ctx.save();
    if(fullScreen){ctx.beginPath();ctx.rect(0,0,w,h);}else roundedRectPath(mirrorX,mirrorY,mirrorWidth,mirrorHeight,14);
    ctx.clip();
    const viewBoat=fullScreen?(replay.ghost?.boat||boat):boat;
    const horizon=mirrorY+mirrorHeight*(fullScreen ? .4 : .31),bottom=mirrorY+mirrorHeight*.94,centerX=mirrorX+mirrorWidth/2;
    const sky=ctx.createLinearGradient(0,mirrorY,0,horizon);sky.addColorStop(0,'#8ec7d0');sky.addColorStop(1,'#4d91a5');ctx.fillStyle=sky;ctx.fillRect(mirrorX,mirrorY,mirrorWidth,horizon-mirrorY);
    const water=ctx.createLinearGradient(0,horizon,0,mirrorY+mirrorHeight);water.addColorStop(0,'#2d7188');water.addColorStop(1,'#0a4058');ctx.fillStyle=water;ctx.fillRect(mirrorX,horizon,mirrorWidth,mirrorHeight-(horizon-mirrorY));
    ctx.strokeStyle='rgba(225,247,241,.42)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(mirrorX,horizon);ctx.lineTo(mirrorX+mirrorWidth,horizon);ctx.stroke();
    const facing=fullScreen?-1:1,tow=fullScreen?viewBoat:towPoint(viewBoat),fx=Math.cos(viewBoat.angle)*facing,fy=Math.sin(viewBoat.angle)*facing,rx=-fy,ry=fx;
    const focal=mirrorWidth/(2*Math.tan((fullScreen?cameraFovDeg:MIRROR_HORIZONTAL_FOV_DEG)*Math.PI/360));
    const verticalFocal=focal*.65;
    const near=fullScreen?Math.max(2,((viewBoat.z||0)+4.8*UNITS_PER_FOOT)*verticalFocal/(bottom-horizon)):42;
    const range=fullScreen?1800/METERS_PER_UNIT:MIRROR_MAX_RANGE;
    const projection={tow,fx,fy,rx,ry,centerX,horizon,bottom,near,focal,verticalFocal,fullScreen,range};
    const projectRear=createWaterProjector(projection);
    const projectBoats=fullScreen?projectRear:createWaterProjector({...projection,physicalHeight:true});
    // Perspective water bands converge on the horizon and make this read as an
    // eye-level view rather than another overhead map.
    ctx.strokeStyle='rgba(193,234,235,.16)';ctx.lineWidth=1;
    for(const depth of [18,38,70,120,210,380,700,1100]){const left=projectRear(tow.x-fx*depth-rx*420,tow.y-fy*depth-ry*420),right=projectRear(tow.x-fx*depth+rx*420,tow.y-fy*depth+ry*420);if(left&&right){ctx.beginPath();ctx.moveTo(left.x,left.y);ctx.lineTo(right.x,right.y);ctx.stroke();}}
    mapOverlay.drawRearScenery(ctx,{x:mirrorX,width:mirrorWidth,horizon,bottom,tow,fx,fy,rx,ry,near,focal,columns:fullScreen?clamp(Math.ceil(w/5),96,320):96});
    // Render the same oscillating wake surface used by sampleWater(). The shaded
    // face is only a perspective treatment: its height, phase and decay all
    // come from the simulated packet, so the mirror cannot invent a ramp.
    ctx.lineCap='round';
    for(let i=0;i<wakes.length;i++){
      const q=wakes[i],mag=len(q.dx,q.dy)||1,tx=-q.dy/mag,ty=q.dx/mag,half=Math.min(q.width*1.25,42);
      const wakeDepth=(tow.x-q.x)*fx+(tow.y-q.y)*fy;
      if(wakeDepth<-half-8||wakeDepth>range+half)continue;
      const fadeWindow=Math.min(12,CONFIG.wakeLife*.34),fade=clamp(q.strength,0,1)*clamp((CONFIG.wakeLife-q.age)/fadeWindow,0,1);
      const surface=[],base=[];
      for(let sample=0;sample<=6;sample++){
        const tangent=half*(sample/3-1);
        const surfaceHeight=wakeHeightAtPacket(q,0,tangent);
        const x=q.x+tx*tangent,y=q.y+ty*tangent,groundPoint=projectRear(x,y),surfacePoint=projectRear(x,y,surfaceHeight);
        if(groundPoint&&surfacePoint){base.push(groundPoint);surface.push(surfacePoint);}
      }
      if(surface.length<2||surface.every(p=>p.x<mirrorX-80||p.x>mirrorX+mirrorWidth+80))continue;
      const raised=Math.cos(q.phase)>=0;
      ctx.fillStyle=raised?`rgba(5,43,57,${fade*.24})`:`rgba(1,29,44,${fade*.28})`;
      ctx.beginPath();ctx.moveTo(surface[0].x,surface[0].y);for(let j=1;j<surface.length;j++)ctx.lineTo(surface[j].x,surface[j].y);for(let j=base.length-1;j>=0;j--)ctx.lineTo(base[j].x,base[j].y);ctx.closePath();ctx.fill();
      ctx.strokeStyle=raised?`rgba(238,247,222,${fade*.68})`:`rgba(126,190,199,${fade*.25})`;
      ctx.lineWidth=clamp((surface[0].scale+surface[surface.length-1].scale)*2.2,.6,3);ctx.beginPath();ctx.moveTo(surface[0].x,surface[0].y);for(let j=1;j<surface.length;j++)ctx.lineTo(surface[j].x,surface[j].y);ctx.stroke();
    }
    drawPlayersPerspective(ctx,projectBoats,remotePlayers);
    if(fullScreen){drawHelmBow(viewBoat);ctx.restore();return;}
    const tubeAttachment=tubeTowPoint(tube),tubeGround=projectRear(tube.x,tube.y,0),tubeView=projectRear(tube.x,tube.y,tube.z),rawTubeEyeView=projectRear(tubeAttachment.x,tubeAttachment.y,tubeAttachment.z);
    const tubeSize=tubeView?clamp(34*tubeView.scale,5.5,17):0;
    let tubeEyeView=rawTubeEyeView;
    if(tubeView&&rawTubeEyeView&&tubeSize){
      // The mirror deliberately exaggerates the distant tube so it stays
      // readable. Put the physics tow-eye direction on that same drawn rim,
      // then bend only the final visual rope pixels to the matching point.
      const eyeDx=rawTubeEyeView.x-tubeView.x,eyeDy=rawTubeEyeView.y-tubeView.y;
      const ellipseDistance=Math.sqrt((eyeDx/tubeSize)**2+(eyeDy/(tubeSize*.48))**2)||1;
      tubeEyeView={...rawTubeEyeView,x:tubeView.x+eyeDx/ellipseDistance,y:tubeView.y+eyeDy/ellipseDistance};
    }
    // The rope starts at the stern at the bottom of the mirror and recedes to
    // the tube. Its final point uses the same rim location as the tube art.
    ctx.strokeStyle=tube.tension>8?'#ffe7a6':'#c7b98d';ctx.lineWidth=1.6;ctx.setLineDash(tube.tension>8?[]:[5,4]);ctx.beginPath();let ropeStarted=false;
    const boatTowEye=towPoint(boat);
    for(let i=0;i<ropeChain.length;i++){const node=ropeChain[i],t=i/(ropeChain.length-1),z=Number.isFinite(node.z)?node.z:boatTowEye.z+(tubeAttachment.z-boatTowEye.z)*t,p=projectRear(node.x,node.y,z);if(!p)continue;if(rawTubeEyeView&&tubeEyeView){const eyeBlend=t*t*t*t;p.x+=(tubeEyeView.x-rawTubeEyeView.x)*eyeBlend;p.y+=(tubeEyeView.y-rawTubeEyeView.y)*eyeBlend;}if(!ropeStarted){ctx.moveTo(p.x,p.y);ropeStarted=true;}else ctx.lineTo(p.x,p.y);}ctx.stroke();ctx.setLineDash([]);
    if(tubeGround&&tubeView){
      ctx.fillStyle='rgba(0,18,26,.38)';ctx.beginPath();ctx.ellipse(tubeGround.x,tubeGround.y,tubeSize*1.05,tubeSize*.28,0,0,TAU);ctx.fill();
      ctx.fillStyle='#ffca44';ctx.strokeStyle='#74451f';ctx.lineWidth=1.5;ctx.beginPath();ctx.ellipse(tubeView.x,tubeView.y,tubeSize,tubeSize*.48,0,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#17475c';ctx.beginPath();ctx.ellipse(tubeView.x,tubeView.y,tubeSize*.34,tubeSize*.18,0,0,TAU);ctx.fill();
      if(tubeEyeView){ctx.fillStyle='#f4d66f';ctx.strokeStyle='#493c2c';ctx.lineWidth=1;ctx.beginPath();ctx.arc(tubeEyeView.x,tubeEyeView.y,Math.max(1.4,tubeSize*.12),0,TAU);ctx.fill();ctx.stroke();}
      if(tube.riderOn){ctx.save();ctx.translate(tubeView.x,tubeView.y);drawTubeRiderFace(ctx,tubeSize,rider.color);ctx.restore();}
    }
    if(tube.fallenRider){
      const fallen=tube.fallenRider,fallenView=projectRear(fallen.x,fallen.y,fallen.z);
      if(fallenView){const bodySize=clamp(18*fallenView.scale,3,9);ctx.save();ctx.translate(fallenView.x,fallenView.y);ctx.rotate(fallen.tumble*.45);ctx.fillStyle=fallen.color||rider.color;ctx.strokeStyle='#173747';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(0,0,bodySize,bodySize*.38,0,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#f0bd91';ctx.beginPath();ctx.arc(bodySize*.95,0,Math.max(1.2,bodySize*.28),0,TAU);ctx.fill();ctx.restore();}
    }
    // A small stern/deck edge at the bottom establishes the driver's location.
    if(view!=='helm'){
      const deckWidth=mirrorWidth*.26;ctx.fillStyle=boatStyle.blue;ctx.strokeStyle=boatStyle.hull;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(centerX-deckWidth/2,mirrorY+mirrorHeight);ctx.lineTo(centerX-deckWidth*.38,bottom-3);ctx.lineTo(centerX+deckWidth*.38,bottom-3);ctx.lineTo(centerX+deckWidth/2,mirrorY+mirrorHeight);ctx.closePath();ctx.fill();ctx.stroke();ctx.fillStyle='#f4d66f';ctx.beginPath();ctx.arc(centerX,bottom-4,2.4,0,TAU);ctx.fill();
    }
    const sheen=ctx.createLinearGradient(mirrorX,mirrorY,mirrorX+mirrorWidth,mirrorY+mirrorHeight);sheen.addColorStop(0,'rgba(235,252,255,.16)');sheen.addColorStop(.34,'rgba(235,252,255,.015)');sheen.addColorStop(1,'rgba(0,20,30,.15)');ctx.fillStyle=sheen;ctx.fillRect(mirrorX,mirrorY,mirrorWidth,mirrorHeight);ctx.restore();
    ctx.save();roundedRectPath(mirrorX,mirrorY,mirrorWidth,mirrorHeight,14);ctx.strokeStyle='#cabd96';ctx.lineWidth=5;ctx.stroke();roundedRectPath(mirrorX+4,mirrorY+4,mirrorWidth-8,mirrorHeight-8,10);ctx.strokeStyle='#102d38';ctx.lineWidth=2;ctx.stroke();ctx.restore();
  }
  function draw2d(){
    if(view==='helm'){drawPerspectiveView(true);drawPerspectiveView();return;}
    drawLake();drawWakes();if(debug)drawTrace();mapOverlay.drawTerrain(ctx,screen,w,h);drawPlayers2D(ctx,screen,remotePlayers,w,h);drawBoat();drawTow();drawTube();drawFallenRider();drawDebug();drawReplay();drawPerspectiveView();
  }
  function draw(){
    if(activeMap.id==='oswego'&&!lakeSpawnAssigned){
      // Keep the existing connection notice and controls, without briefly
      // drawing the old launch, boat, mirror, or minimap beneath them.
      ctx.fillStyle='#123f56';ctx.fillRect(0,0,w,h);return;
    }
    boatStyle=activeMap.id==='oswego'?boatColorStyle(multiplayer.color):activeBoatProfile.style;
    remotePlayers=activeMap.id==='oswego'?multiplayer.getPeers():[];
    draw2d();
    const chartTime=performance.now();
    if(activeMap.rings.length && (physicsPanel.open||mapDialog.open||!hudMapWrap.hidden) && (lastChartTime<0 || chartTime-lastChartTime>100)){
      const chartBoat=replay.ghost?.boat||boat,chartTube=replay.ghost?.tube||tube;
      if(physicsPanel.open)mapOverlay.drawChart(miniMap,chartBoat,chartTube,false,remotePlayers,multiplayer.color);
      if(!hudMapWrap.hidden)mapOverlay.drawChart(hudMap,chartBoat,chartTube,false,remotePlayers,multiplayer.color,{transparent:true,followBoat:true});
      if(mapDialog.open)mapOverlay.drawChart(lakeChart,chartBoat,chartTube,true,remotePlayers,multiplayer.color);
      lastChartTime=chartTime;
    }
  }
  function frame(now){
    if(appSuspended){last=now;accumulator=0;requestAnimationFrame(frame);return;}
    if(physicsPanel.open&&activeMap.id==='oswego'&&now>=nextPingUiAt){updatePingUi();nextPingUiAt=now+1000;}
    let elapsed=Math.min((now-last)/1000,.05);last=now;accumulator+=elapsed;
    if(mapDialog.open)accumulator=0;
    while(accumulator>=1/120){update(1/120);accumulator-=1/120;}
    draw();requestAnimationFrame(frame);
  }
  function suspendSimulation(){
    if(appSuspended)return;
    appSuspended=true;accumulator=0;controls.resetAll();touchWheelAngle=0;wheelHeld=false;applyTouchWheel();setTouchThrottle(0);
    ui.handle.style.removeProperty('top');ui.handle.style.removeProperty('bottom');ui.throttleValue.value='NEUTRAL';ui.controller.textContent='';ui.controller.classList.remove('connected');
  }
  function resumeSimulation(){last=performance.now();accumulator=0;appSuspended=false;}
  document.addEventListener('visibilitychange',()=>document.hidden?suspendSimulation():resumeSimulation());
  addEventListener('wake-rider:native-state',event=>event.detail?.isActive?resumeSimulation():suspendSimulation());
  addEventListener('pagehide',()=>multiplayer.leave());
  addEventListener('pageshow',event=>{if(event.persisted)multiplayer.resume();});
  if(activeMap.id==='oswego')restorePhysicsDefaults();
  multiplayer.setMap(activeMap.id);
  requestAnimationFrame(frame);
}
