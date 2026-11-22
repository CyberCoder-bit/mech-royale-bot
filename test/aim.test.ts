import { describe, expect, test } from "bun:test"
import { aimAt, leadPoint, leadPointBallistic } from "../src/brain/aim.ts"
import type { V3 } from "../src/util/math.ts"

/** Fly a bullet along the solution and return the miss distance to the true target center. */
function miss(m: V3, aim: [number, number], s: number, center: (t: number) => V3, tMax = 2): number {
  const [yaw, pitch] = aim
  const d: V3 = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
  let best = Infinity
  for (let t = 0; t < tMax; t += 0.0005) {
    const b: V3 = [m[0] + d[0] * s * t, m[1] + d[1] * s * t, m[2] + d[2] * s * t]
    const c = center(t)
    best = Math.min(best, Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]))
  }
  return best
}

describe("lead", () => {
  test("straight-line lead hits a constant-velocity target", () => {
    const m: V3 = [0, 0, 7], p: V3 = [80, 30, 4.5], v: V3 = [-5, 11, 0]
    const sol = leadPoint(m, p, v, 252)
    expect(miss(m, aimAt(m, sol.at), 252, (t) => [p[0] + v[0] * t, p[1] + v[1] * t, p[2]])).toBeLessThan(0.05)
  })
  test("ballistic lead hits a falling target that plain lead misses", () => {
    const m: V3 = [0, 0, 7], feet = 12, p: V3 = [140, -20, feet + 4.5], v: V3 = [6, 9, 2]
    const g = 22
    const truth = (t: number): V3 => [p[0] + v[0] * t, p[1] + v[1] * t, p[2] + v[2] * t - 0.5 * g * t * t]
    const bal = leadPointBallistic(m, p, v, 252, g, feet, -100, false)
    const lin = leadPoint(m, p, v, 252)
    expect(miss(m, aimAt(m, bal.at), 252, truth)).toBeLessThan(0.1)
    expect(miss(m, aimAt(m, lin.at), 252, truth)).toBeGreaterThan(1)
  })
  test("jetting target rises at constant speed; floor stops a falling target", () => {
    const m: V3 = [0, 0, 7], p: V3 = [100, 0, 4.5], v: V3 = [0, 10, 8.9]
    const jet = leadPointBallistic(m, p, v, 252, 22, 0, -100, true)
    expect(miss(m, aimAt(m, jet.at), 252, (t) => [p[0], p[1] + v[1] * t, p[2] + v[2] * t])).toBeLessThan(0.1)
    const fall = leadPointBallistic(m, [100, 0, 5.5], [0, 0, -20], 252, 22, 1, 0, false)
    expect(fall.at[2]).toBeCloseTo(4.5, 5)
  })
})
