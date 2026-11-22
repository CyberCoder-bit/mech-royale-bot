/** Firing solutions. Pure functions, no state. */
import type { V3 } from "../util/math.ts"

/**
 * Intercept for a straight-flying projectile of speed `s` from muzzle `m` at a target point `p`
 * moving with velocity `v`. Returns the aim point and flight time.
 */
export function leadPoint(m: V3, p: V3, v: V3, s: number): { at: V3; t: number } {
  const dx = p[0] - m[0], dy = p[1] - m[1], dz = p[2] - m[2]
  const a = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - s * s
  const b = 2 * (dx * v[0] + dy * v[1] + dz * v[2])
  const c = dx * dx + dy * dy + dz * dz
  let t: number
  if (Math.abs(a) < 1e-9) t = b !== 0 ? -c / b : 0
  else {
    const disc = b * b - 4 * a * c
    if (disc < 0) t = Math.sqrt(c) / s
    else {
      const r = Math.sqrt(disc)
      const t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a)
      t = Math.min(...[t1, t2].filter((x) => x > 0), Infinity)
      if (!Number.isFinite(t)) t = Math.sqrt(c) / s
    }
  }
  if (!(t >= 0) || !Number.isFinite(t)) t = Math.sqrt(c) / s
  return { at: [p[0] + v[0] * t, p[1] + v[1] * t, p[2] + v[2] * t], t }
}

/**
 * Intercept for an airborne target: horizontal motion is linear, vertical follows gravity `g`
 * (a jetting target rises at constant speed, `jetting`), and the target's feet never go below
 * `floorZ` (a landed target stops falling). `p` is the aim point (e.g. center), `feetZ` its feet.
 * Fixed-point iteration on the flight time.
 */
export function leadPointBallistic(m: V3, p: V3, v: V3, s: number, g: number, feetZ: number, floorZ: number, jetting: boolean): { at: V3; t: number } {
  let t = Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]) / s
  let at: V3 = [p[0], p[1], p[2]]
  for (let k = 0; k < 4; k++) {
    let dz = jetting ? v[2] * t : v[2] * t - 0.5 * g * t * t
    if (feetZ + dz < floorZ) dz = floorZ - feetZ
    at = [p[0] + v[0] * t, p[1] + v[1] * t, p[2] + dz]
    t = Math.hypot(at[0] - m[0], at[1] - m[1], at[2] - m[2]) / s
  }
  return { at, t }
}

/** Yaw/pitch from `m` toward `p`. */
export function aimAt(m: V3, p: V3): [number, number] {
  return [Math.atan2(p[1] - m[1], p[0] - m[0]), Math.atan2(p[2] - m[2], Math.hypot(p[0] - m[0], p[1] - m[1]))]
}

/**
 * Ballistic pitch for a shell with speed `v` and gravity `g` to cover horizontal distance `d` and rise `h`.
 * `high` picks the lobbed arc. Returns null when out of range.
 */
export function ballisticPitch(d: number, h: number, v: number, g: number, high = false): { pitch: number; t: number } | null {
  if (d < 0.5) return null
  const a = (g * d * d) / (2 * v * v)
  const disc = d * d - 4 * a * (h + a)
  if (disc < 0) return null
  const r = Math.sqrt(disc)
  const u = high ? (d + r) / (2 * a) : (d - r) / (2 * a)
  const pitch = Math.atan(u)
  const t = d / (v * Math.cos(pitch))
  return { pitch, t }
}
