import { applyRoomAction, snapshot, tickRoom, roomError, STALE_MS } from '../multiplayer/room.js';
import { wakeSnapshot } from '../multiplayer/wake-history.js';
import { IDLE_MESSAGE } from '../multiplayer/inactivity.js';

export const UPDATE_MS = 50;
export const MAX_INPUT_BYTES = 6000;

export function parseInput(text) {
  if (typeof text !== 'string' || text.length > MAX_INPUT_BYTES) throw roomError(413, 'Update too large.');
  let input;
  try { input = JSON.parse(text); } catch { throw roomError(400, 'Invalid update.'); }
  if (!input || !/^[-a-zA-Z0-9]{16,80}$/.test(input.id) || typeof input.token !== 'string' || !/^[-a-zA-Z0-9]{32,100}$/.test(input.token)) throw roomError(400, 'Invalid session.');
  if (!['join', 'sync', 'reset', 'leave'].includes(input.action)) throw roomError(400, 'Unknown lake action.');
  return input;
}

export async function hashToken(token) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}

export class RoomService {
  constructor(epoch = crypto.randomUUID()) {
    this.epoch = epoch;
    this.room = { players: {}, contacts: {}, departed: {}, wakeEvents: [], wakeSeq: 0 };
  }

  action(input, tokenHash, now) {
    const existing = this.room.players[input.id];
    const resumed = input.action === 'join' && !!existing && now - existing.updatedAt <= STALE_MS;
    // Preserve the old transaction guarantee without copying immutable wake
    // samples or touching the database for every position update.
    const next = { ...this.room, players: structuredClone(this.room.players),
      contacts: { ...this.room.contacts }, departed: { ...this.room.departed }, idleDeparted: { ...this.room.idleDeparted },
      wakeEvents: [...this.room.wakeEvents] };
    const result = applyRoomAction(next, input, tokenHash, now);
    this.room = next;
    return { ...result, epoch: this.epoch, resumed };
  }

  tick(now) { tickRoom(this.room, now); }

  view(id, tokenHash, wakeSince, now) {
    if (this.room.idleDeparted?.[id]) throw Object.assign(roomError(408, IDLE_MESSAGE), { code: 'idle' });
    const player = this.room.players[id];
    if (!player) throw roomError(410, 'Rejoining the lake…');
    if (player.tokenHash !== tokenHash) throw roomError(403, 'This boat belongs to another session.');
    return { ...snapshot(this.room, player, now), ...wakeSnapshot(this.room, wakeSince), epoch: this.epoch };
  }

  get active() { return Object.values(this.room.players).some(p => !p.isBot); }
}
