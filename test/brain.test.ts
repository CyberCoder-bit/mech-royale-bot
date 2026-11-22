import { describe, expect, test } from "bun:test"
import { leadPointAir, leadPoint, aimAt, ballisticPitch } from "../src/brain/aim.ts"
import { findCover, hiddenFrom } from "../src/brain/cover.ts"
import { walkableDir } from "../src/brain/steer.ts"
import { loadWorld, navFor } from "../src/world/index.ts"

describe("aim", () => {
  test("lead: stationary target is aimed directly", () => {
    const r = leadPointAir([0, 0, 7], [100, 0, 4.5], [0, 0, 0], 252, 22, 0)
    expect(r.at[0]).toBeCloseTo(100, 6)
    expect(r.at[2]).toBeCloseTo(4.5, 6)
  })
  test("lead: crossing target matches the straight-line solver on the ground", () => {
    const a = leadPointAir([0, 0, 7], [100, 0, 4.5], [0, 11.7, 0], 252, 22, 0)
    const b = leadPoint([0, 0, 7], [100, 0, 4.5], [0, 11.7, 0], 252)
    expect(a.at[1]).toBeCloseTo(b.at[1], 2)
    // bullet and target meet: |at - muzzle| = s * t
    expect(Math.hypot(a.at[0], a.at[1], a.at[2] - 7)).toBeCloseTo(252 * a.t, 3)
  })
  test("lead: a falling target is led downward but never below its floor", () => {
    const r = leadPointAir([0, 0, 7], [150, 0, 20], [0, 0, -8], 252, 22, 4.5)
    expect(r.at[2]).toBeLessThan(20 - 8 * 0.5)
    const r2 = leadPointAir([0, 0, 7], [150, 0, 6], [0, 0, -20], 252, 22, 4.5)
    expect(r2.at[2]).toBeCloseTo(4.5, 6)
  })
  test("lead: a jetting target rises linearly", () => {
    const r = leadPointAir([0, 0, 7], [100, 0, 10], [0, 0, 8.9], 252, 22, 0)
    expect(r.at[2]).toBeCloseTo(10 + 8.9 * r.t, 4)
  })
  test("aimAt and ballisticPitch", () => {
    const [yaw, pitch] = aimAt([0, 0, 0], [0, 10, 10])
    expect(yaw).toBeCloseTo(Math.PI / 2, 6)
    expect(pitch).toBeCloseTo(Math.PI / 4, 6)
    const sol = ballisticPitch(200, 0, 72, 22, false)!
    // range check: v^2 sin(2p) / g
    expect((72 * 72 * Math.sin(2 * sol.pitch)) / 22).toBeCloseTo(200, 3)
    expect(ballisticPitch(400, 0, 72, 22, false)).toBeNull()
  })
})

describe("cover", () => {
  const world = loadWorld("kit/arena", ["v2/world.json", "v2/terrain.i16"])
  const nav = navFor(world)
  test("a point inside a building's shadow is hidden; open ground is not", () => {
    // building 112 (4 vertices, base -5, top 10.83): stand east of it, threat far west
    const zg = world.groundZ(-95, 63)
    const eye: [number, number, number] = [-170, 63, world.groundZ(-170, 63) + 8]
    const behind = hiddenFrom(world, -97, 63, zg, [eye])
    const shot = world.shotClear(eye, [-97, 63, zg + 4.5])
    expect(behind).toBe(!shot && !world.shotClear(eye, [-97, 63, zg + 8.3]))
  })
  test("findCover returns a hidden, reachable point or null", () => {
    const tests: [number, number][] = [[-60, 40], [100, 150], [-200, -100], [250, -150]]
    for (const [x, y] of tests) {
      const n = nav.nearestFree(x, y, world.groundZ(x, y), 20)
      if (n < 0) continue
      const pos: [number, number, number] = [nav.nodeX(n), nav.nodeY(n), nav.hz[n]]
      const eye: [number, number, number] = [pos[0] + 90, pos[1] + 30, world.groundZ(pos[0] + 90, pos[1] + 30) + 8]
      const c = findCover(world, nav, { pos, eyes: [eye], threatPos: [[eye[0], eye[1], eye[2] - 8]], maxDist: 40, budgetMs: 50 })
      if (!c) continue
      expect(hiddenFrom(world, c.x, c.y, c.z, [eye])).toBe(true)
      expect(Math.hypot(c.x - pos[0], c.y - pos[1])).toBeLessThanOrEqual(42.5)
      const cn = nav.nodeAt(c.x, c.y, c.z)
      expect(cn >= 0 && nav.st[cn] === 1).toBe(true)
    }
  })
  test("walkableDir bends away from a wall", () => {
    // pick a free node next to a band cell, then ask to walk into the band direction
    let checked = 0
    for (let c = 0; c < nav.nCells && checked < 20; c += 97) {
      const n = 2 * c
      if (nav.st[n] !== 1 || !nav.terr[n]) continue
      const x = nav.nodeX(n), y = nav.nodeY(n), z = nav.hz[n]
      const right = nav.cellOf(x + 2, y)
      if (right < 0 || nav.st[2 * right] !== 2) continue
      const d = walkableDir(nav, x, y, z, [1, 0], 5)
      if (d[0] === 1 && d[1] === 0) continue // nothing walkable around (enclosed)
      checked++
      expect(nav.lineWalkable(x, y, z, x + d[0] * 5, y + d[1] * 5, 6)).toBe(true)
    }
    expect(checked).toBeGreaterThan(0)
  })
})
