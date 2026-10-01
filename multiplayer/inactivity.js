export const IDLE_MS = 3 * 60 * 1000;
export const IDLE_MESSAGE = 'Inactive for 3 minutes · press Reset to rejoin';
export const IDLE_CLOSE_CODE = 4008;
export const idleResult = () => ({ status: 408, code: 'idle', error: IDLE_MESSAGE });
