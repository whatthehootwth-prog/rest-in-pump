import { describe, expect, it } from 'vitest';
import { RoomManager } from '../src/rooms.ts';
import { MAX_SPEED, WORLD_RADIUS } from '../../shared/protocol.ts';

const make = (capacity = 2, maxRooms = 3, graceMs = 1000) => new RoomManager({ capacity, maxRooms, graceMs });
const state = (x: number, z: number) => ({ x, y: 0, z, yaw: 0, speed: 1, air: false, walk: 0, emote: 0 });

describe('RoomManager', () => {
  it('fills the first room, then opens the next one', () => {
    const rm = make(2, 3);
    const a = rm.join('A', null, 0), b = rm.join('B', null, 0), c = rm.join('C', null, 0);
    expect(a.ok && a.player.roomId).toBe('graveyard-1');
    expect(b.ok && b.player.roomId).toBe('graveyard-1');
    expect(c.ok && c.player.roomId).toBe('graveyard-2');
  });

  it('refuses when every room is full', () => {
    const rm = make(1, 2);
    expect(rm.join('A', null, 0).ok).toBe(true);
    expect(rm.join('B', null, 0).ok).toBe(true);
    expect(rm.join('C', null, 0)).toEqual({ ok: false, code: 'server_full' });
  });

  it('honours a preferred room and reports a full one', () => {
    const rm = make(1, 3);
    const a = rm.join('A', 'graveyard-3', 0);
    expect(a.ok && a.player.roomId).toBe('graveyard-3');
    expect(rm.join('B', 'graveyard-3', 0)).toEqual({ ok: false, code: 'room_full' });
    expect(rm.join('B', 'graveyard-9', 0)).toEqual({ ok: false, code: 'unknown_room' });
  });

  it('keeps a dropped player for the grace period so they can resume', () => {
    const rm = make(2, 1, 1000);
    const a = rm.join('A', null, 0);
    if (!a.ok) throw new Error();
    rm.markDisconnected(a.player.id, 100);
    expect(rm.connectedCount()).toBe(0);
    // the slot is still reserved
    expect(rm.summary('graveyard-1').players).toBe(1);
    const back = rm.resume(a.player.session, 900);
    expect(back?.id).toBe(a.player.id);
    expect(rm.connectedCount()).toBe(1);
    // a connected session cannot be resumed a second time (duplicated tab)
    expect(rm.resume(a.player.session, 950)).toBeNull();
  });

  it('removes a dropped player after the grace period', () => {
    const rm = make(2, 2, 1000);
    const a = rm.join('A', 'graveyard-2', 0);
    if (!a.ok) throw new Error();
    rm.markDisconnected(a.player.id, 0);
    expect(rm.sweep(500)).toHaveLength(0);
    expect(rm.sweep(1500).map((p) => p.id)).toEqual([a.player.id]);
    expect(rm.resume(a.player.session, 1600)).toBeNull();
    expect(rm.roomIds()).toEqual(['graveyard-1']);  // empty extra rooms close
  });

  it('moves players between rooms', () => {
    const rm = make(1, 3);
    const a = rm.join('A', null, 0), b = rm.join('B', null, 0);
    if (!a.ok || !b.ok) throw new Error();
    expect(rm.move(a.player.id, 'graveyard-2', 0)).toEqual({ ok: false, code: 'room_full' });
    expect(rm.move(a.player.id, 'graveyard-3', 0)).toEqual({ ok: true, from: 'graveyard-1', to: 'graveyard-3' });
    expect(rm.playersIn('graveyard-3').map((p) => p.name)).toEqual(['A']);
  });

  it('gives each player a fixed walk style the client cannot change', () => {
    const rm = new RoomManager({ capacity: 5, maxRooms: 1, graceMs: 1000 }, () => 0.99);
    const a = rm.join('A', null, 0);
    if (!a.ok) throw new Error();
    expect(a.player.state.walk).toBe(8);
    const s = rm.applyState(a.player.id, { ...a.player.state, walk: 2, emote: 3 }, 100)!;
    expect(s.walk).toBe(8);
    expect(s.emote).toBe(3);
  });

  it('rate-limits chat', () => {
    const rm = make();
    const a = rm.join('A', null, 0);
    if (!a.ok) throw new Error();
    expect([0, 0, 0, 0].map(() => rm.allowChat(a.player.id, 0))).toEqual([true, true, true, false]);
    expect(rm.allowChat(a.player.id, 1600)).toBe(true);
  });

  it('clamps teleports, speed, height and the world edge', () => {
    const rm = make();
    const a = rm.join('A', null, 0);
    if (!a.ok) throw new Error();
    const start = { ...a.player.state };
    // 100 ms later, try to jump 50 m
    const s = rm.applyState(a.player.id, { ...state(start.x + 50, start.z), y: 99, speed: 99, walk: 3 }, 100)!;
    const moved = Math.hypot(s.x - start.x, s.z - start.z);
    expect(moved).toBeLessThanOrEqual(MAX_SPEED * 0.1 * 1.6 + 0.35 + 1e-9);
    expect(s.y).toBeLessThanOrEqual(2);
    expect(s.speed).toBeLessThanOrEqual(MAX_SPEED * 1.1);
    // walk slowly out to the edge: stays inside the world
    let t = 100;
    for (let i = 0; i < 400; i++) { t += 1000; rm.applyState(a.player.id, state(100, 0), t); }
    const end = rm.get(a.player.id)!.state;
    expect(Math.hypot(end.x, end.z)).toBeLessThanOrEqual(WORLD_RADIUS + 1e-9);
  });
});
