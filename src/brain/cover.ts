/**
 * Cover search: nearby standing spots where no known threat has a clear shot line to our body
 * (hard cover: buildings and terrain; trees never stop shots).
 */
import type { World } from "../world/world.ts"
import type { NavGrid } from "../world/nav.ts"
import type { V2, V3 } from "../util/math.ts"

export type CoverQuery = {
  /** our feet */
  pos: V3
  /** threat eye points (world) */
  eyes: V3[]
  /** threat feet positions, to avoid running toward them */
  threatPos?: V3[]
  maxDist: number
  minDist?: number
  /** keep inside this circle (radius <= 0: ignore) */
  zoneC?: V2
  zoneR?: number
  /** our body height (9 x size) */
  bodyH?: number
  /** stop after this many ms */
  budgetMs?: number
  /** max height change from our level (avoid roofs unless allowed) */
  maxDz?: number
  /** also require hidden from eyes shifted sideways by this (m), for robustness to threat movement */
  wiggle?: number
}

export type CoverPoint = { x: number; y: number; z: number; d: number; cost: number; straight: boolean }

const RADII = [4, 6.5, 9, 12, 15.5, 19.5, 24, 29, 35, 42, 50]
const ANG = 16

/** Is a body standing at (x, y, z) hidden from every eye (no clear shot to its center or upper body)? */
export function hiddenFrom(world: World, x: number, y: number, z: number, eyes: V3[], bodyH = 9, wiggle = 0): boolean {
  const c: V3 = [x, y, z + bodyH * 0.5]
  const top: V3 = [x, y, z + bodyH * 0.92]
  for (const e of eyes) {
    if (world.shotClear(e, c) || world.shotClear(e, top)) return false
    if (wiggle > 0) {
      const dx = x - e[0], dy = y - e[1]
      const l = Math.hypot(dx, dy) || 1
      const px = (-dy / l) * wiggle, py = (dx / l) * wiggle
      for (const s of [-1, 1]) {
        const e2: V3 = [e[0] + px * s, e[1] + py * s, e[2]]
        if (world.shotClear(e2, c) || world.shotClear(e2, top)) return false
      }
    }
  }
  return true
}

/** How many eyes have a clear shot line to a body at (x, y, z). */
export function exposure(world: World, x: number, y: number, z: number, eyes: V3[], bodyH = 9): number {
  const c: V3 = [x, y, z + bodyH * 0.5]
  const top: V3 = [x, y, z + bodyH * 0.92]
  let n = 0
  for (const e of eyes) if (world.shotClear(e, c) || world.shotClear(e, top)) n++
  return n
}

/**
 * Nearest standing spot within maxDist from which a muzzle at height muzzleH has a clear shot at
 * `target` (to re-acquire a target that broke line of sight). Prefers spots close to us.
 */
export function findPeek(
  world: World,
  nav: NavGrid,
  pos: V3,
  target: V3,
  muzzleH: number,
  maxDist: number,
  budgetMs = 1.5,
  zoneC?: V2,
  zoneR = 0,
): CoverPoint | null {
  const t0 = performance.now()
  const [px, py, pz] = pos
  const radii = [2.5, 4.5, 7, 10, 13.5, 17.5, 22]
  for (let ri = 0; ri < radii.length; ri++) {
    const r = radii[ri]
    if (r > maxDist) break
    // directions toward the target's side first
    const base = Math.atan2(target[1] - py, target[0] - px)
    for (let a = 0; a < ANG; a++) {
      if (performance.now() - t0 > budgetMs) return null
      const k = a % 2 === 0 ? a / 2 : -(a + 1) / 2
      const ang = base + (k * 2 * Math.PI) / ANG
      const x = px + Math.cos(ang) * r, y = py + Math.sin(ang) * r
      const n = nav.nodeAt(x, y, pz)
      if (n < 0 || nav.st[n] !== 1) continue
      const z = nav.hz[n]
      if (Math.abs(z - pz) > 3) continue
      if (zoneC && zoneR > 0 && Math.hypot(x - zoneC[0], y - zoneC[1]) > zoneR) continue
      if (!world.shotClear([x, y, z + muzzleH], target)) continue
      if (!nav.lineWalkable(px, py, pz, x, y, 40)) continue
      return { x, y, z, d: r, cost: r, straight: true }
    }
  }
  return null
}

export function findCover(world: World, nav: NavGrid, q: CoverQuery): CoverPoint | null {
  const t0 = performance.now()
  const budget = q.budgetMs ?? 3
  const [px, py, pz] = q.pos
  const bodyH = q.bodyH ?? 9
  const maxDz = q.maxDz ?? 3
  const zr = q.zoneR ?? 0
  const zc = q.zoneC
  type Cand = { x: number; y: number; z: number; d: number; prior: number }
  const cands: Cand[] = []
  const tp = q.threatPos ?? []
  const myThreatD = tp.map((p) => Math.hypot(p[0] - px, p[1] - py))
  for (let ri = 0; ri < RADII.length; ri++) {
    const r = RADII[ri]
    if (r > q.maxDist) break
    if (q.minDist && r < q.minDist) continue
    const off = (ri % 2) * (Math.PI / ANG)
    for (let a = 0; a < ANG; a++) {
      const ang = off + (a * 2 * Math.PI) / ANG
      const x = px + Math.cos(ang) * r, y = py + Math.sin(ang) * r
      const n = nav.nodeAt(x, y, pz)
      if (n < 0 || nav.st[n] !== 1) continue
      const z = nav.hz[n]
      if (Math.abs(z - pz) > maxDz) continue
      if (zc && zr > 0 && Math.hypot(x - zc[0], y - zc[1]) > zr) continue
      let prior = r
      for (let k = 0; k < tp.length; k++) {
        const dt = Math.hypot(tp[k][0] - x, tp[k][1] - y)
        if (dt < myThreatD[k]) prior += (myThreatD[k] - dt) * 2.5
        if (dt < 20) prior += (20 - dt) * 3
      }
      prior += nav.pen[n] * 4
      cands.push({ x, y, z, d: r, prior })
    }
  }
  cands.sort((a, b) => a.prior - b.prior)
  let best: CoverPoint | null = null
  let found = 0
  for (const c of cands) {
    if (best && c.prior >= best.cost) break
    if (performance.now() - t0 > budget) break
    if (!hiddenFrom(world, c.x, c.y, c.z, q.eyes, bodyH, q.wiggle ?? 0)) continue
    const straight = nav.lineWalkable(px, py, pz, c.x, c.y, 60)
    const cost = c.prior + (straight ? 0 : 8 + c.d * 0.5)
    if (!best || cost < best.cost) best = { x: c.x, y: c.y, z: c.z, d: c.d, cost, straight }
    if (++found >= 4) break
  }
  return best
}
