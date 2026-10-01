export const MPH_PER_UNIT = .155;
export const FEET_PER_UNIT = MPH_PER_UNIT * 5280 / 3600;
export const UNITS_PER_FOOT = 1 / FEET_PER_UNIT;
export const STANDARD_GRAVITY_FT_PER_SECOND_SQUARED = 32.174;
export const STANDARD_GRAVITY = STANDARD_GRAVITY_FT_PER_SECOND_SQUARED * UNITS_PER_FOOT;

export const CONFIG = {
  gravity: STANDARD_GRAVITY,
  ropeLength: 60 * UNITS_PER_FOOT,
  // A low-stretch tow rope can elongate slightly under a shock without
  // behaving like a bungee. This is also the hard constraint's safety band.
  ropeCompliance: .3 * UNITS_PER_FOOT,
  ropeWorkingLoad: 45,
  ropeDampingRatio: .72,
  ropeMaximumLoad: 400,
  ropeNodes: 25,
  ropeIterations: 10,
  tubeRadius: 2.5 * UNITS_PER_FOOT,
  tubeHalfLength: 2.5 * UNITS_PER_FOOT,
  tubeHalfWidth: 2.5 * UNITS_PER_FOOT,
  tubeTowOffset: 2.5 * UNITS_PER_FOOT,
  tubeTowEyeHeightFt: .45,
  tubeWeightLb: 30,
  tubeWaterFriction: .8,
  tubeRopeContactAngle: Math.PI * .305,
  wakeStrength: 1.1,
  wakeLife: 36,
  boatModel: 'Wake Boat 22',
  boatLength: 21.75,
  boatBeam: 8,
  boatWeightLb: 3200,
  boatDeadriseDeg: 16,
  boatDraftFt: 26 / 12,
  boatEngineHp: 350,
  boatTopSpeedMph: 45,
  boatDriveType: 'v-drive',
  boatTowAttachment: 'ski',
  boatTowPointRatio: .45,
  boatTowPointHeightFt: 3.5,
  boatLongitudinalResponse: 1,
  boatWakeFactor: 1,
  boatWakeAmplitude: 1,
  boatWakeSpread: 1,
  boatHairpinFactor: 1,
  boatTurnDragFactor: 1,
  maxRudderAngleDeg: 35,
  hairpinStrength: 1,
  rudderLiftFactor: .13,
  rudderPropWashSpeed: 55,
  vectorThrustSteering: 0,
  steeringFlowForward: 1,
  steeringLeverRatio: .36,
  steeringYawCoupling: 1.17,
  swayLinearDamping: 2.2,
  swayQuadraticDamping: .016,
  yawLinearDamping: .55,
  yawSpeedDamping: .55,
  yawQuadraticDamping: .25
};

export const MIN_LAB_MAX_MPH = 5;
export const STANDARD_MAX_MPH = 30;
export const LAB_MAX_MPH = 100;
