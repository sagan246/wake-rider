import { UNITS_PER_FOOT } from '../physics/config.js';
import { DEFAULT_BOAT_ID, getBoatProfile } from '../physics/boats.js';

export const RIDER_PROFILES = Object.freeze({
  light: Object.freeze({ mass: 90, grip: 55, color: '#7ee0cc' }),
  balanced: Object.freeze({ mass: 130, grip: 75, color: '#78aef0' }),
  heavy: Object.freeze({ mass: 215, grip: 90, color: '#d997e8' })
});

export function createLabDefaults(boatProfile) {
  return Object.freeze({
    view: 'driver',
    cameraFovDeg: 100,
    showDigitalGauges: false,
    rider: 'balanced',
    riderWeight: RIDER_PROFILES.balanced.mass,
    riderGrip: RIDER_PROFILES.balanced.grip,
    tubeWaterFriction: .8,
    boatProfileId: DEFAULT_BOAT_ID,
    boatLength: boatProfile.lengthFt,
    ropeLengthFt: 60,
    towAttachment: 'ski',
    towPointHeightFt: boatProfile.skiTowPointHeightFt,
    gravityScale: 1,
    wakeStrength: 1.1,
    wakeLife: 36,
    maxBoatSpeedMph: boatProfile.topSpeedMph,
    cruiseEnabled: false,
    cruiseSpeedMph: 20,
    hairpinStrength: 1,
    debug: false
  });
}

const sharedBoat = getBoatProfile(DEFAULT_BOAT_ID);
const sharedDefaults = createLabDefaults(sharedBoat);
export const SHARED_LAKE_RULES = Object.freeze({
  version: 'shared-wakes-v9',
  wakeLife: sharedDefaults.wakeLife,
  length: sharedDefaults.boatLength * UNITS_PER_FOOT,
  beam: sharedBoat.beamFt * UNITS_PER_FOOT,
  ropeLength: sharedDefaults.ropeLengthFt * UNITS_PER_FOOT,
  tubeRadius: 2.5 * UNITS_PER_FOOT,
  tubeClearance: 2.2 * UNITS_PER_FOOT,
  tubeTubeClearance: 1.5 * UNITS_PER_FOOT,
  boatMass: sharedBoat.weightLb,
  loadedTubeMass: 30 + sharedDefaults.riderWeight,
  emptyTubeMass: 105
});
