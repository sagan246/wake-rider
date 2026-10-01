export const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
export const len = (x, y) => Math.hypot(x, y);
export const normAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
