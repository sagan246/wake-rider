// Shared outline of the original 2D boat artwork. Collision and rendering use
// the same full extents, so the bow taper and hull sides meet where they look.
export const BOAT_SPRITE_LENGTH = 70;
export const BOAT_SPRITE_BEAM = 30;
export const BOAT_OUTLINE = Object.freeze([
  [35, 0], [22, -11], [8, -14], [-24, -15], [-32, -12], [-35, -10],
  [-35, 10], [-32, 12], [-24, 15], [8, 14], [22, 11]
].map(point => Object.freeze(point)));
