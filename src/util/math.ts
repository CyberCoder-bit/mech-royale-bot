/** Small math helpers. Angles in radians, yaw 0 = east, CCW positive. */

export type V2 = [number, number]
export type V3 = [number, number, number]

export const TAU = Math.PI * 2

/** Normalize an angle to (-PI, PI]. */
export function wrap(a: number): number {
  a = a % TAU
  if (a <= -Math.PI) a += TAU
  else if (a > Math.PI) a -= TAU
  return a
}

/** Signed smallest difference a - b, in (-PI, PI]. */
export const angDiff = (a: number, b: number) => wrap(a - b)

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export const dist2 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(b[0] - a[0], b[1] - a[1])
export const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
export const yawTo = (from: ArrayLike<number>, to: ArrayLike<number>) => Math.atan2(to[1] - from[1], to[0] - from[0])

export const unit = (yaw: number): V2 => [Math.cos(yaw), Math.sin(yaw)]

/** Deterministic PRNG (mulberry32) seeded from hello.seed. */
export function rng(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
