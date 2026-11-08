import { describe, expect, it } from 'vitest';
import { parseClientMessage, sanitizeChat, sanitizeName, isRoomId, MAX_CLIENT_MESSAGE_BYTES } from '../../shared/protocol.ts';

describe('sanitizeName', () => {
  it('accepts and normalises ordinary names', () => {
    expect(sanitizeName('  Grave   Digger ')).toBe('Grave Digger');
    expect(sanitizeName('owl_99')).toBe('owl_99');
    expect(sanitizeName('Señor.Búho')).toBe('Señor.Búho');
  });
  it('rejects bad names', () => {
    for (const bad of ['', 'a', 'x'.repeat(17), '<script>', 'zero​width', '  ', '-dash', 42, null]) {
      expect(sanitizeName(bad)).toBeNull();
    }
  });
});

describe('parseClientMessage', () => {
  it('parses a valid hello', () => {
    expect(parseClientMessage('{"t":"hello","v":1,"name":"Owl","resume":null,"room":"graveyard-2"}'))
      .toEqual({ t: 'hello', v: 1, name: 'Owl', resume: null, room: 'graveyard-2' });
    expect(parseClientMessage('{"t":"hello","v":1}')).toEqual({ t: 'hello', v: 1, name: null, resume: null, room: null });
  });
  it('parses a valid state', () => {
    const s = { x: 1, y: 0, z: 2, yaw: 0.5, speed: 1.8, air: false, walk: 3, emote: 2 };
    expect(parseClientMessage(JSON.stringify({ t: 'state', s }))).toEqual({ t: 'state', s });
  });
  it('rejects malformed or hostile input', () => {
    const bad = [
      'not json', '[]', '{}', '{"t":"nope"}', '{"t":"hello","v":"1"}',
      JSON.stringify({ t: 'state', s: { x: 'NaN', y: 0, z: 0, yaw: 0, speed: 0, air: false, walk: 0, emote: 0 } }),
      JSON.stringify({ t: 'state', s: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, air: false, walk: 99, emote: 0 } }),
      JSON.stringify({ t: 'state', s: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, air: false, walk: 0, emote: 6 } }),
      JSON.stringify({ t: 'state', s: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, air: false, walk: 0 } }),
      JSON.stringify({ t: 'state', s: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, air: 'yes', walk: 0, emote: 0 } }),
      '{"t":"state","s":{"x":1e999,"y":0,"z":0,"yaw":0,"speed":0,"air":false,"walk":0,"emote":0}}',
      JSON.stringify({ t: 'rename', name: 'x'.repeat(100) }),
      JSON.stringify({ t: 'hello', v: 1, name: 'a', pad: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES) }),
    ];
    for (const raw of bad) expect(parseClientMessage(raw), raw.slice(0, 60)).toBeNull();
  });
  it('validates room ids', () => {
    expect(isRoomId('graveyard-1')).toBe(true);
    expect(isRoomId('graveyard-x')).toBe(false);
    expect(isRoomId('../etc')).toBe(false);
  });
});

describe('sanitizeChat', () => {
  it('cleans and limits chat text', () => {
    expect(sanitizeChat('  hello   world ')).toBe('hello world');
    expect(sanitizeChat('bye​!')).toBe('bye!');
    expect(sanitizeChat('héllo wörld 😂')).toBe('héllo wörld 😂');
    expect(sanitizeChat('   ')).toBeNull();
    expect(sanitizeChat('x'.repeat(141))).toBeNull();
    expect(sanitizeChat('x'.repeat(140))).toHaveLength(140);
  });
});
