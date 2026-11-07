import { WORLD_RADIUS } from '../../../shared/protocol.ts';
import { clamp } from '../util/math.ts';

export interface Colliders {
  circles: { x: number; z: number; r: number }[];
  /** Wall segments [x0, z0, x1, z1]. */
  segs: [number, number, number, number][];
}

/** Pushes a circle of radius `r` at p out of every obstacle and keeps it inside the world. */
export function resolveCollisions(p: { x: number; z: number }, r: number, c: Colliders): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const o of c.circles) {
      const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz), m = r + o.r;
      if (d < m && d > 1e-6) { p.x = o.x + (dx / d) * m; p.z = o.z + (dz / d) * m; }
    }
    for (const [x0, z0, x1, z1] of c.segs) {
      const ex = x1 - x0, ez = z1 - z0, t = clamp(((p.x - x0) * ex + (p.z - z0) * ez) / (ex * ex + ez * ez), 0, 1);
      const qx = x0 + ex * t, qz = z0 + ez * t, dx = p.x - qx, dz = p.z - qz, d = Math.hypot(dx, dz);
      if (d < r && d > 1e-6) { p.x = qx + (dx / d) * r; p.z = qz + (dz / d) * r; }
    }
    const rad = Math.hypot(p.x, p.z);
    if (rad > WORLD_RADIUS) { p.x *= WORLD_RADIUS / rad; p.z *= WORLD_RADIUS / rad; }
  }
}
