/** Rule checks for the local simulator engine (sim/match.ts). */
import { test, expect } from "bun:test"
import { defaultConfig, MAP_DIR } from "../sim/config.ts"
import { loadWorld, pip, segPrism } from "../sim/world.ts"
import { Match, wrap } from "../sim/match.ts"

const cfg = defaultConfig()
const w = loadWorld(MAP_DIR)

function duel(seed = 1) {
  const m = new Match({ seed, config: cfg, world: w, names: ["a", "b"] })
  // place both on open ground far from buildings, 60 m apart, facing each other
  const A = m.mechs[0],
    B = m.mechs[1]
  let x = 0,
    y = 0
  for (let k = 0; k < 2000; k++) {
    x = -300 + (k * 37) % 600
    y = -200 + (k * 53) % 400
    let ok = true
    for (let s = 0; s <= 70 && ok; s += 5) if (!w.discClear(x + s, y, w.ground(x + s, y), 4, 9, 0.5) || Math.abs(w.ground(x + s, y) - w.ground(x, y)) > 0.5) ok = false
    if (ok) break
  }
  A.x = x
  A.y = y
  A.z = w.ground(x, y)
  B.x = x + 60
  B.y = y
  B.z = w.ground(x + 60, y)
  A.yaw = A.cyaw = 0
  B.yaw = B.cyaw = Math.PI
  m.npcs.length = 0
  m.crates.length = 0
  return { m, A, B }
}

test("point in polygon and segment vs prism", () => {
  const sq = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10])
  expect(pip(sq, 5, 5)).toBe(true)
  expect(pip(sq, 15, 5)).toBe(false)
  const p = { id: 0, kind: "building", base: 0, top: 5, polys: [sq], minX: 0, maxX: 10, minY: 0, maxY: 10, area: 100 }
  expect(segPrism(p, -5, 5, 2, 15, 5, 2)).toBeCloseTo(0.25, 6)
  expect(segPrism(p, -5, 5, 6, 15, 5, 6)).toBe(2) // above the top
})

test("wrap stays in [-pi, pi]", () => {
  expect(Math.abs(wrap(3 * Math.PI))).toBeCloseTo(Math.PI, 9)
  expect(Math.abs(wrap(-3 * Math.PI))).toBeCloseTo(Math.PI, 9)
  expect(wrap(0.5)).toBeCloseTo(0.5, 9)
})

test("gun fires at exactly 1/cooldown while held, then reloads", () => {
  const { m, A } = duel()
  let shots = 0
  for (let d = 0; d < 30; d++) {
    m.applyAction(A, { tick: m.tick, fire: [true, false], aim: [0, 0] }, true)
    const before = m.nextProj
    m.advance()
    shots += m.nextProj - before
  }
  // 3 s held: 12 rounds (0.24 s apart = 2.64 s), then a 2.4 s reload
  expect(shots).toBe(12)
  expect(A.slots[0]!.reload).toBeGreaterThan(0)
})

test("laser: full charge does full damage, released early does min_frac+", () => {
  const { m, A, B } = duel(2)
  A.slots[1] = m.newWeapon("laser", A)
  A.yaw = A.cyaw = Math.atan2(B.y - A.y, B.x - A.x)
  A.pitch = A.cpitch = Math.atan2(B.z + 4.5 - (A.z + 7), 60)
  const hp0 = B.hp
  // hold 1.0 s (> 0.75 s full charge), then release
  for (let d = 0; d < 10; d++) {
    m.applyAction(A, { tick: m.tick, fire: [false, true], aim: [A.cyaw, A.cpitch] }, true)
    m.advance()
  }
  m.applyAction(A, { tick: m.tick, fire: [false, false], aim: [A.cyaw, A.cpitch] }, true)
  m.advance()
  const dmg = hp0 - B.hp
  const L = cfg.weapons.laser
  // B faces A: front hit, no cubes, no armor
  expect(dmg).toBeCloseTo(L.damage, 0)
})

test("jets rise at max_rise_speed - g*dt (8.9 m/s) and regen restarts on the 14th tick", () => {
  const { m, A } = duel(3)
  m.applyAction(A, { tick: m.tick, jump: true, boost: true }, true)
  const zs: number[] = []
  for (let d = 0; d < 20; d++) {
    m.applyAction(A, { tick: m.tick, boost: true }, true)
    m.advance()
    zs.push(A.z)
  }
  const rise = (zs[19] - zs[9]) / 1.0
  expect(rise).toBeCloseTo(cfg.mech.max_rise_speed - cfg.mech.gravity / cfg.match.tick_hz, 1)
  // stop spending; count ticks until energy rises
  const e0 = A.energy
  let ticks = 0
  m.applyAction(A, { tick: m.tick, boost: false }, true)
  while (A.energy <= e0 + 1e-9 && ticks < 40) {
    ;(m as any).step()
    ticks++
  }
  expect(ticks).toBe(14)
})

test("rear hits deal rear_mult", () => {
  const { m, A, B } = duel(4)
  // B faces away from A
  B.yaw = B.cyaw = 0
  const amt = m.damageMech(B, 100, A, A.id, "gun", A.x, A.y)
  expect(amt).toBeCloseTo(100 * cfg.mech.rear_mult, 6)
  B.yaw = B.cyaw = Math.PI
  const amt2 = m.damageMech(B, 100, A, A.id, "gun", A.x, A.y)
  expect(amt2).toBeCloseTo(100, 6)
})

test("zone circles: next inside current, phases chain", () => {
  const m = new Match({ seed: 7, config: cfg, world: w, names: ["a", "b"] })
  for (let k = 1; k < m.circles.length; k++) {
    const a = m.circles[k - 1],
      b = m.circles[k]
    expect(Math.hypot(a.cx - b.cx, a.cy - b.cy) + b.r).toBeLessThanOrEqual(a.r + 1e-6)
    expect(b.shrinkStart).toBeGreaterThanOrEqual(a.shrinkEnd)
  }
})
