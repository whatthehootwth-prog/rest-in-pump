export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
/** Frame-rate independent exponential approach of a towards b. */
export const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * t;
};

/**
 * Deterministic random numbers. The world is generated from a fixed seed so every player gets
 * exactly the same graveyard (same stones, same colliders).
 */
export class Rng {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  next(): number { this.seed = (this.seed * 16807) % 2147483647; return (this.seed - 1) / 2147483646; }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
}

/** Cosmetic randomness (animations): not shared between players, so plain Math.random. */
export const rr = (a: number, b: number) => a + (b - a) * Math.random();

const h2 = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h2(xi, yi), h2(xi + 1, yi), u), lerp(h2(xi, yi + 1), h2(xi + 1, yi + 1), u), v);
}
export const fbm2 = (x: number, y: number) => noise2(x, y) * 0.5 + noise2(x * 2.1 + 5, y * 2.1) * 0.3 + noise2(x * 4.3, y * 4.3 + 9) * 0.2;
