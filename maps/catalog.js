import { FEET_PER_UNIT } from '../physics/config.js';
import { OSWEGO_LAKE_METERS as data } from './oswego-lake-data.js';

// Physics units are ~6.93 cm, not meters. Keep the mapped lake at real scale.
export const METERS_PER_UNIT = FEET_PER_UNIT * .3048;
const toUnits = value => value / METERS_PER_UNIT;
const ring = points => points.map(([x, y]) => ({ x: toUnits(x), y: toUnits(y) }));

export const OPEN_MAP = Object.freeze({
  id: 'open', name: 'Open Water', description: 'Original map · endless open water',
  rings: [], bounds: null, spawn: { x: 0, y: 0, angle: -Math.PI / 2 }
});
export const OSWEGO_MAP = Object.freeze({
  id: 'oswego', name: 'Shared Lake', description: 'Shoreline & islands · multiplayer',
  rings: [ring(data.outer), ...data.holes.map(ring)],
  bounds: Object.fromEntries(Object.entries(data.boundsMeters).map(([key, value]) => [key, toUnits(value)])),
  spawn: { x: toUnits(-2900), y: toUnits(810), angle: -20 * Math.PI / 180 },
  source: data.source, attribution: data.attribution
});
export const MAPS = Object.freeze({ oswego: OSWEGO_MAP, open: OPEN_MAP });
export function getMap(id) { return MAPS[id] || OSWEGO_MAP; }
