import { describe, expect, it } from 'vitest';
import { sillyName } from '../src/names.ts';

describe('sillyName', () => {
  it('makes short "Adjective Noun" names', () => {
    for (let i = 0; i < 200; i++) {
      const n = sillyName(new Set());
      expect(n).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(n.length).toBeLessThanOrEqual(16);
    }
  });
  it('never repeats a name that is taken', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const n = sillyName(taken);
      expect(taken.has(n)).toBe(false);
      taken.add(n);
    }
  });
  it('still finds a unique name when the combinations run out', () => {
    const first = sillyName(new Set(), () => 0);
    expect(sillyName(new Set([first]), () => 0)).toMatch(/ 2$/);
  });
});
