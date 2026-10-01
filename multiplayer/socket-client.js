import { SHARED_LAKE_RULES } from '../simulation/defaults.js?v=28';
import { createPeerMotion } from './peer-motion.js';
import { IDLE_CLOSE_CODE, IDLE_MESSAGE } from './inactivity.js';

const pose = body => ({ x: body.x, y: body.y, vx: body.vx, vy: body.vy, angle: body.angle,
  z: body.z, pitch: body.pitch, roll: body.roll, riderOn: body.riderOn });

export function createSocketClient({ url, read, onSpawn, onCorrection, onStatus, onWakes, onIdle, checkIdle = () => false,
  socketFactory, clock = () => performance.now(), schedule = setTimeout, cancel = clearTimeout }) {
  const peers = createPeerMotion({ minDelay: 45, maxDelay: 160, initialDelay: 60, smoothingMs: 75 });
  let session = null, socket = null, generation = 0, timer = null, reconnect = null;
  let joined = false, ready = false, self = null, status = 'Solo · Open Water';
  let seq = 0, ack = 0, frameAck = 0, wakeCursor = 0, epoch = null, lastSuccess = 0, lastEcho = -1, rtt = 0;
  let resetRevision = 0, resetWanted = false, pending = null, count = 0, botCount = 0, retry = 0;
  function report(message) { status = message; onStatus?.({ message, ready, count, botCount, self }); }
  function send(action) {
    if (action !== 'leave' && checkIdle()) return false;
    if (!socket || socket.readyState !== 1 || (socket.bufferedAmount || 0) > 64000) return false;
    const state = read(), sentAt = clock(), requestSeq = ++seq;
    const message = { ...session, action, seq: requestSeq, ack, frameAck, wakeSince: wakeCursor,
      physicsVersion: SHARED_LAKE_RULES.version, resetRevision, sentAt,
      name: state.name, botCount: state.botCount || 0, paused: state.paused, activitySeq: state.activitySeq,
      boat: pose(state.boat), tube: pose(state.tube), wakeSamples: state.wakeSamples || [] };
    if (action === 'join' || action === 'reset') pending = { action, seq: requestSeq, resetRevision, sentAt };
    try { socket.send(JSON.stringify(message)); return true; } catch { socket.close(); return false; }
  }
  function receive(data) {
    if (checkIdle()) return;
    if (data.type === 'error') {
      if (data.code === 'idle') { leave(); report(IDLE_MESSAGE); onIdle?.(); return; }
      ready = false; report(data.error || 'Reconnecting to the lake…');
      if (data.status === 409 && joined) { resetWanted = true; pending = null; return; }
      if (data.status === 410) { joined = false; ack = 0; wakeCursor = 0; peers.clear(); }
      if (data.status === 426) { generation++; cancel(timer); socket?.close(); return; }
      socket?.close(); return;
    }
    if (!data.self || !Array.isArray(data.players) || data.self.id !== session.id) return;
    frameAck = data.frame; lastSuccess = clock(); retry = 0;
    if (data.type === 'reply') {
      if (!pending || data.requestSeq !== pending.seq || data.action !== pending.action) return;
      const action = pending.action, requestedReset = pending.resetRevision;
      pending = null;
      // A new room resets its counters. Respawn also clears the old wave field.
      if (action === 'join' && (epoch !== data.epoch || !data.resumed)) { ack = 0; wakeCursor = 0; peers.clear(); }
      if (action === 'reset' || !data.resumed || epoch !== data.epoch) onSpawn(data.self.spawn);
      epoch = data.epoch; joined = true;
      if (action === 'reset' || !data.resumed) resetWanted = requestedReset !== resetRevision;
    } else if (!joined || pending || resetWanted) return;
    if (data.epoch !== epoch) { ready = false; socket?.close(); return; }
    if (Number.isFinite(data.echo) && data.echo !== lastEcho) {
      lastEcho = data.echo; rtt = Math.max(0, Math.min(1000, clock() - data.echo));
    }
    peers.receive(data.players, { selfId: session.id, serverTime: data.serverTime, now: clock(), rtt });
    self = data.self; count = data.players.length; botCount = data.players.filter(player => player.isBot).length;
    onWakes?.(data.wakeEvents || [], data.serverTime, { source: self.wakeSource, ack: self.wakeAck || 0 });
    if (Number.isSafeInteger(data.wakeCursor)) wakeCursor = data.wakeCursor;
    if (self.correction && self.correction.seq > ack) { onCorrection(self.correction); ack = self.correction.seq; }
    ready = !resetWanted;
    const humans = count - botCount;
    report(`${humans} player${humans === 1 ? '' : 's'}${botCount ? ` + ${botCount} bot${botCount === 1 ? '' : 's'}` : ''} · ${self.name}`);
  }
  function connect(run) {
    if (run !== generation || !session || checkIdle()) return;
    let current;
    try { current = socketFactory(url); } catch { reconnect = schedule(() => connect(run), 1000); return; }
    socket = current;
    lastSuccess = 0;
    let openedAt = clock();
    const valid = () => run === generation && socket === current;
    const loop = () => {
      if (!valid() || checkIdle()) return;
      if (clock() - (lastSuccess || openedAt) > 4000 || (pending && clock() - pending.sentAt > 4000)) { current.close(); return; }
      if (current.readyState === 1 && !pending) send(!joined ? 'join' : resetWanted ? 'reset' : 'sync');
      timer = schedule(loop, 50);
    };
    current.addEventListener('open', () => {
      if (!valid()) { current.close(); return; }
      openedAt = clock(); lastSuccess = openedAt; pending = null;
      // Reauthenticate every replacement socket. A resumed boat keeps its pose.
      send('join');
    });
    current.addEventListener('message', event => {
      if (!valid()) return;
      try { receive(JSON.parse(event.data)); } catch { ready = false; current.close(); }
    });
    current.addEventListener('close', event => {
      if (!valid()) return;
      if (event.code === IDLE_CLOSE_CODE) { leave(); report(IDLE_MESSAGE); onIdle?.(); return; }
      cancel(timer); pending = null; ready = false; socket = null;
      report('Connection interrupted · reconnecting…');
      reconnect = schedule(() => connect(run), Math.min(3000, 250 * 2 ** Math.min(retry++, 4)));
    });
    current.addEventListener('error', () => { if (valid()) current.close(); });
    timer = schedule(loop, 50);
  }
  function leave() {
    if (session && socket?.readyState === 1) send('leave');
    generation++; cancel(timer); cancel(reconnect);
    socket?.close(); socket = null; session = null; pending = null; joined = false; ready = false;
    peers.clear(); self = null; count = 0; botCount = 0;
  }
  function setMap(id) {
    leave();
    if (id !== 'oswego') { report('Solo · Open Water'); return; }
    session = { id: crypto.randomUUID(), token: crypto.randomUUID() + crypto.randomUUID() };
    seq = 0; ack = 0; frameAck = 0; wakeCursor = 0; epoch = null; lastSuccess = 0; lastEcho = -1; rtt = 0;
    resetRevision = 0; resetWanted = false; retry = 0;
    report('Joining the shared lake…'); connect(generation);
  }
  return { setMap, leave,
    reset() { if (session) { resetRevision++; resetWanted = true; ready = false; report('Finding a clear starting spot…'); } },
    getPeers: () => peers.get(clock()),
    get self() { return self; }, get status() { return status; }, get color() { return self?.color || '#62dcff'; },
    get ready() { return ready && clock() - lastSuccess < 1500; }
  };
}
