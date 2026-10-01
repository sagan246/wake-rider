import { createLakeClient as createHttpClient } from './http-client.js';
import { createSocketClient } from './socket-client.js';
import { IDLE_MS, IDLE_MESSAGE } from './inactivity.js';

// Both transports address the same room once the host has a realtime URL.
// Solo never opens a connection or looks up the multiplayer configuration.
export function createLakeClient(options) {
  const fetcher = options.fetcher || fetch;
  const socketFactory = options.socketFactory === undefined
    ? (typeof window !== 'undefined' && typeof WebSocket !== 'undefined' ? url => new WebSocket(url) : null)
    : options.socketFactory;
  let active = null, generation = 0, pendingReset = false;
  const clock = options.clock || Date.now, schedule = options.schedule || setTimeout, cancel = options.cancel || clearTimeout;
  let map = 'open', idle = false, activitySeq = null, lastActivityAt = 0, idleTimer = null;
  let status = 'Solo · Open Water';
  const report = message => { status = message; options.onStatus?.({ message, ready: false, count: 0, botCount: 0, self: null }); };
  function leave() { generation++; cancel(idleTimer); idleTimer = null; active?.leave(); active = null; pendingReset = false; }
  function read() {
    const state = options.read();
    if (Number.isSafeInteger(state.activitySeq) && state.activitySeq !== activitySeq) {
      activitySeq = state.activitySeq; lastActivityAt = clock();
    }
    return state;
  }
  function expireIdle() {
    if (idle) return;
    idle = true; leave(); report(IDLE_MESSAGE);
  }
  function checkIdle() {
    if (map !== 'oswego') return false;
    if (idle) return true;
    // Check the deadline before reading new input after a suspended tab wakes.
    if (clock() - lastActivityAt >= IDLE_MS) { expireIdle(); return true; }
    read(); return false;
  }
  function watchIdle() {
    if (checkIdle() || map !== 'oswego') return;
    idleTimer = schedule(watchIdle, 1000);
  }
  function activate(url, run) {
    if (run !== generation) return;
    if (checkIdle()) return;
    const shared = { ...options, read, checkIdle, onIdle: expireIdle };
    active = url && socketFactory ? createSocketClient({ ...shared, url, socketFactory }) : createHttpClient(shared);
    active.setMap('oswego');
    if (pendingReset) { pendingReset = false; active.reset(); }
  }
  function setMap(id) {
    leave();
    map = id; idle = false; activitySeq = null; lastActivityAt = clock();
    if (id !== 'oswego') { report('Solo · Open Water'); return; }
    read(); watchIdle();
    report('Joining the shared lake…');
    const run = generation;
    if (!socketFactory) { activate(null, run); return; }
    if (options.realtimeUrl !== undefined) { activate(options.realtimeUrl, run); return; }
    fetcher('/api/lake-config', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
      .then(response => response.ok ? response.json() : {})
      .then(config => activate(config.websocketUrl, run))
      .catch(() => activate(null, run));
  }
  return {
    setMap, leave,
    reset() { if (map === 'oswego' && checkIdle()) setMap(map); else if (active) active.reset(); else pendingReset = true; },
    resume() { if (map === 'oswego' && !checkIdle()) { const at = lastActivityAt; setMap(map); lastActivityAt = at; } },
    getPeers: () => active?.getPeers() || [],
    get self() { return active?.self || null; },
    get ready() { return active?.ready || false; },
    get status() { return active?.status || status; },
    get color() { return active?.color || '#62dcff'; }
  };
}
