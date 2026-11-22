import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { loadWorld, navFor, Pathfinder, PathFollower, EDGE_CLIMB } from "../src/world/index.ts"

const world = loadWorld("kit/arena", ["v2/world.json", "v2/terrain.i16"])
const raw = JSON.parse(readFileSync("kit/arena/v2/world.json", "utf8"))

describe("terrain", () => {
  test("bilinear sample equals raw vertices and interpolates", () => {
    const buf = readFileSync("kit/arena/v2/terrain.i16")
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const { nx, minX, minY } = raw.terrain
    for (const [i, j] of [[10, 10], [500, 300], [1000, 700], [237, 411]]) {
      const v = dv.getInt16(2 * (j * nx + i), true) / 100
      expect(world.groundZ(minX + i, minY + j)).toBeCloseTo(v, 4)
    }
    const a = dv.getInt16(2 * (300 * nx + 500), true) / 100, b = dv.getInt16(2 * (300 * nx + 501), true) / 100
    expect(world.groundZ(minX + 500.5, minY + 300)).toBeCloseTo((a + b) / 2, 4)
  })
  test("recorded spawn stands on the terrain", () => {
    expect(world.groundZ(320.21, -280.29)).toBeCloseTo(-2.03, 1)
  })
})

describe("prisms", () => {
  const k = 112 // simple 4-vertex building, base -5, top 10.83
  test("inside / outside footprint", () => {
    expect(world.inside2D(k, -107.7, 63)).toBe(true)
    expect(world.inside2D(k, -100, 63)).toBe(false)
    expect(world.inside2D(k, -107.7, 80)).toBe(false)
    expect(world.prismAt(-107.7, 63, 5)).toBe(k)
    expect(world.prismAt(-107.7, 63, 12)).toBe(-1)
  })
  test("surfaceZ: roof when zRef is high, ground when below the roof", () => {
    expect(world.surfaceZ(-107.7, 63, 20)).toBeCloseTo(10.83, 2)
    const g = world.groundZ(-100, 63)
    expect(world.surfaceZ(-100, 63, g)).toBeCloseTo(g, 4)
  })
  test("holes are outside", () => {
    const h = raw.prisms.findIndex((p: any) => p.holes?.length && p.holes[0].length >= 6)
    expect(h).toBeGreaterThanOrEqual(0)
    const hole = raw.prisms[h].holes[0] as number[]
    // centroid of the hole polygon (shoelace)
    let A = 0, cx = 0, cy = 0
    for (let i = 0; i < hole.length / 2; i++) {
      const j = (i + 1) % (hole.length / 2)
      const x0 = hole[2 * i], y0 = hole[2 * i + 1], x1 = hole[2 * j], y1 = hole[2 * j + 1]
      const c = x0 * y1 - x1 * y0
      A += c
      cx += (x0 + x1) * c
      cy += (y0 + y1) * c
    }
    cx /= 3 * A
    cy /= 3 * A
    expect(world.inside2D(h, cx, cy)).toBe(false)
  })
})

describe("line of sight", () => {
  test("building blocks shots below its top, not above", () => {
    const zg = world.groundZ(-95, 63)
    expect(world.shotClear([-120, 63, zg + 5], [-95, 63, zg + 5])).toBe(false)
    expect(world.shotClear([-120, 63, 14], [-95, 63, 14])).toBe(true)
  })
  test("terrain blocks a line through the ground", () => {
    const z = world.groundZ(0, 0)
    expect(world.shotClear([-20, 0, z - 3], [20, 0, z - 3])).toBe(false)
  })
  test("tree trunk blocks sight but not shots", () => {
    let tested = 0
    for (let k = 0; k < world.nTrees && tested < 5; k++) {
      if (world.trCB[k] - world.trZ[k] < 6) continue
      const x = world.trX[k], y = world.trY[k], z = world.trZ[k] + 3
      const a = [x - 10, y, z], b = [x + 10, y, z]
      if (!world.shotClear(a, b)) continue // something else in the way
      tested++
      expect(world.sightClear(a, b)).toBe(false)
      expect(world.sightClear([x - 10, y + 3, z], [x + 10, y + 3, z], false)).toBe(world.canopyAlong(x - 10, y + 3, z, x + 10, y + 3, z) >= 0)
    }
    expect(tested).toBeGreaterThan(0)
  })
  test("canopy limit follows rules (transmittance exp(-d*L) < blockT)", () => {
    expect(world.canopyLimit).toBeCloseTo(Math.log(1 / 0.25) / 0.35, 3)
  })
})

describe("nav", () => {
  const nav = navFor(world)
  test("grid basics", () => {
    const s = nav.summary()
    expect(s.free).toBeGreaterThan(100000)
    expect(s.band).toBeGreaterThan(1000)
    expect(s.hops).toBeGreaterThan(1000)
  })
  test("path goes around a building when climbing is not allowed", () => {
    const pf = new Pathfinder(nav)
    let tested = 0
    for (let k = 0; k < world.nPrisms && tested < 3; k++) {
      if (world.pKind[k] !== 0) continue
      const wdt = world.pMaxX[k] - world.pMinX[k], hgt = world.pMaxY[k] - world.pMinY[k]
      if (wdt < 25 || wdt > 70 || hgt < 15 || world.pTop[k] - world.pBase[k] < 10) continue
      const cy = (world.pMinY[k] + world.pMaxY[k]) / 2
      const x0 = world.pMinX[k] - 9, x1 = world.pMaxX[k] + 9
      const z0 = world.surfaceZ(x0, cy, world.groundZ(x0, cy) + 0.5), z1 = world.surfaceZ(x1, cy, world.groundZ(x1, cy) + 0.5)
      const s = nav.nodeAt(x0, cy, z0), t = nav.nodeAt(x1, cy, z1)
      if (s < 0 || t < 0 || !nav.terr[s] || !nav.terr[t]) continue
      if (world.shotClear([x0, cy, z0 + 3], [x1, cy, z1 + 3])) continue
      const res = pf.search(s, t, { maxClimb: 0, maxMs: 200 })
      if (res.status !== "ok") continue
      tested++
      expect(res.kinds.includes(EDGE_CLIMB)).toBe(false)
      let len = 0
      for (let i = 1; i < res.nodes.length; i++) {
        const a = res.nodes[i - 1], b = res.nodes[i]
        len += Math.hypot(nav.nodeX(b) - nav.nodeX(a), nav.nodeY(b) - nav.nodeY(a))
        expect(world.inside2D(k, nav.nodeX(b), nav.nodeY(b))).toBe(false)
        expect(nav.st[b]).toBe(1)
      }
      expect(len).toBeGreaterThan(x1 - x0 + 5)
    }
    expect(tested).toBeGreaterThan(0)
  })
  test("roof reachable with a climb edge when allowed", () => {
    const pf = new Pathfinder(nav)
    let tested = 0
    for (let k = 0; k < world.nPrisms && tested < 3; k++) {
      if (world.pKind[k] !== 0) continue
      const cx = (world.pMinX[k] + world.pMaxX[k]) / 2, cy = (world.pMinY[k] + world.pMaxY[k]) / 2
      if (!world.inside2D(k, cx, cy)) continue
      const roof = nav.nodeAt(cx, cy, world.pTop[k])
      if (roof < 0 || Math.abs(nav.hz[roof] - world.pTop[k]) > 0.01) continue
      const x0 = world.pMaxX[k] + 8
      const s = nav.nodeAt(x0, cy, world.groundZ(x0, cy))
      if (s < 0 || !nav.terr[s]) continue
      const dh = world.pTop[k] - nav.hz[s]
      if (dh < 8 || dh > 25) continue
      const res = pf.search(s, roof, { maxClimb: 30, maxMs: 100 })
      if (res.status !== "ok") continue
      tested++
      expect(res.kinds.includes(EDGE_CLIMB)).toBe(true)
      expect(nav.hz[res.nodes[res.nodes.length - 1]]).toBeCloseTo(world.pTop[k], 1)
      // and never without enough climb allowance
      const low = pf.search(s, roof, { maxClimb: 2, maxMs: 100 })
      expect(low.status === "ok" && low.kinds.includes(EDGE_CLIMB)).toBe(false)
    }
    expect(tested).toBeGreaterThan(0)
  })
  test("follower produces a move toward the path", () => {
    const f = new PathFollower(nav)
    const zg = world.groundZ(300, -280)
    f.setGoal(250, -250, world.groundZ(250, -250))
    const o = f.update({ t: 0, pos: [300, -280, zg], vel: [0, 0, 0], grounded: true, energy: 100 })
    expect(Math.hypot(o.move[0], o.move[1])).toBeGreaterThan(0.5)
    expect(o.move[0]).toBeLessThan(0)
  })
})

describe("perf", () => {
  test("load, LOS and A* budgets", () => {
    const t0 = performance.now()
    const w2 = new (world.constructor as any)(raw, world.th)
    const load = performance.now() - t0
    expect(load).toBeLessThan(500)
    let s = 7
    const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const N = 5000
    const segs: number[][] = []
    for (let i = 0; i < N; i++) {
      const x = -400 + r() * 800, y = -250 + r() * 550, a = 6.283 * r(), d = 20 + r() * 180
      segs.push([x, y, world.groundZ(x, y) + 8, x + Math.cos(a) * d, y + Math.sin(a) * d, world.groundZ(x + Math.cos(a) * d, y + Math.sin(a) * d) + 4.5])
    }
    const t1 = performance.now()
    for (const q of segs) w2.sightClear([q[0], q[1], q[2]], [q[3], q[4], q[5]])
    const perMs = N / (performance.now() - t1)
    expect(perMs).toBeGreaterThan(30) // ~400/ms on an idle machine; generous for a loaded box
    const pf = new Pathfinder(navFor(world))
    pf.findPath(-150, 100, world.groundZ(-150, 100), 250, -100, world.groundZ(250, -100), { maxMs: 200 })
    const t2 = performance.now()
    const res = pf.findPath(-150, 100, world.groundZ(-150, 100), 250, -100, world.groundZ(250, -100), { maxMs: 200 })
    const astar = performance.now() - t2
    expect(res.status).toBe("ok")
    expect(astar).toBeLessThan(40)
    console.log(`perf: world ctor ${load.toFixed(1)} ms, sightClear ${perMs.toFixed(0)}/ms, A* 447 m ${astar.toFixed(2)} ms (${res.expanded} expanded)`)
  })
})
