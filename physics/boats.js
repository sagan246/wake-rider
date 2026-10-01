import { CONFIG } from './config.js';

export const DEFAULT_BOAT_ID = 'wake-boat-22';

// A fictional all-around wake boat tuned from representative V-drive
// dimensions. It is the single baseline hull used by the game.
export const BOAT_PROFILES = Object.freeze({
  'wake-boat-22': Object.freeze({
    id: 'wake-boat-22',
    label: 'Wake Boat 22',
    driveType: 'v-drive',
    driveLabel: 'V-drive inboard',
    lengthFt: 21.75,
    beamFt: 8,
    weightLb: 3200,
    engineHp: 350,
    topSpeedMph: 45,
    deadriseDeg: 16,
    draftFt: 26 / 12,
    maxSteerAngleDeg: 35,
    steeringLiftFactor: .13,
    steeringThrustFlow: 55,
    vectorThrustSteering: 0,
    steeringLeverRatio: .36,
    steeringYawCoupling: 1.17,
    steeringForwardFlow: 1,
    hairpinFactor: 1,
    turnDragFactor: 1,
    longitudinalResponse: 1,
    wakeFactor: 1,
    wakeAmplitude: 1,
    wakeSpread: 1,
    swayLinearDamping: 2.2,
    swayQuadraticDamping: .016,
    yawLinearDamping: .55,
    yawSpeedDamping: .55,
    yawQuadraticDamping: .25,
    skiTowPointRatio: .45,
    skiTowPointHeightFt: 3.5,
    towerTowPointRatio: .08,
    towerTowPointHeightFt: 6.4,
    tower: true,
    style: Object.freeze({
      hull: '#f4f7f4',
      blue: '#1d5b92',
      blueDark: '#123b62',
      interior: '#dce4e3',
      seat: '#f0eee5',
      trim: '#263d4b',
      metal: '#a9bbc0'
    })
  })
});

export function getBoatProfile(id) {
  return BOAT_PROFILES[id] || BOAT_PROFILES[DEFAULT_BOAT_ID];
}

export function applyBoatTowAttachment(profileOrId, attachment = 'ski') {
  const profile = typeof profileOrId === 'string' ? getBoatProfile(profileOrId) : profileOrId;
  const type = attachment === 'tower' ? 'tower' : 'ski';
  CONFIG.boatTowAttachment = type;
  CONFIG.boatTowPointRatio = type === 'tower' ? profile.towerTowPointRatio : profile.skiTowPointRatio;
  CONFIG.boatTowPointHeightFt = type === 'tower' ? profile.towerTowPointHeightFt : profile.skiTowPointHeightFt;
  return {
    type,
    ratio: CONFIG.boatTowPointRatio,
    heightFt: CONFIG.boatTowPointHeightFt
  };
}

export function applyBoatProfile(id) {
  const profile = getBoatProfile(id);
  Object.assign(CONFIG, {
    boatModel: profile.label,
    boatDriveType: profile.driveType,
    boatLength: profile.lengthFt,
    boatBeam: profile.beamFt,
    boatWeightLb: profile.weightLb,
    boatDeadriseDeg: profile.deadriseDeg,
    boatDraftFt: profile.draftFt,
    boatEngineHp: profile.engineHp,
    boatTopSpeedMph: profile.topSpeedMph,
    maxRudderAngleDeg: profile.maxSteerAngleDeg,
    rudderLiftFactor: profile.steeringLiftFactor,
    rudderPropWashSpeed: profile.steeringThrustFlow,
    vectorThrustSteering: profile.vectorThrustSteering,
    steeringFlowForward: profile.steeringForwardFlow,
    steeringLeverRatio: profile.steeringLeverRatio,
    steeringYawCoupling: profile.steeringYawCoupling,
    boatHairpinFactor: profile.hairpinFactor,
    boatTurnDragFactor: profile.turnDragFactor,
    boatLongitudinalResponse: profile.longitudinalResponse,
    boatWakeFactor: profile.wakeFactor,
    boatWakeAmplitude: profile.wakeAmplitude,
    boatWakeSpread: profile.wakeSpread,
    swayLinearDamping: profile.swayLinearDamping,
    swayQuadraticDamping: profile.swayQuadraticDamping,
    yawLinearDamping: profile.yawLinearDamping,
    yawSpeedDamping: profile.yawSpeedDamping,
    yawQuadraticDamping: profile.yawQuadraticDamping
  });
  applyBoatTowAttachment(profile, CONFIG.boatTowAttachment);
  return profile;
}
