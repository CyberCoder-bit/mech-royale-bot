/**
 * World library entry point.
 *
 *   const world = loadWorld(hello.map.dir, hello.map.files)  // cached, immutable, ~30 ms
 *   const nav = navFor(world)                                // cached, immutable; data/nav.bin.gz or ~150 ms build
 *   world.groundZ(x, y)            terrain height (bilinear)
 *   world.surfaceZ(x, y, zRef)     highest walkable surface not above zRef + step_up
 *   world.prismAt(x, y, z)         prism index containing the point, or -1
 *   world.shotClear(a, b)          prisms + terrain block; trees never do
 *   world.sightClear(a, b, canopy) shotClear + trunks + canopy (crown length vs canopyLimit)
 *   new PathFollower(nav)          per bot: setGoal(x, y, z), update(obs-ish) -> move/jump/boost
 *   new Pathfinder(nav)            per bot: findPath(sx, sy, sz, tx, ty, tz, opts)
 */
import { existsSync, readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { World, loadWorld, type WorldOpts } from "./world.ts"
import { NavGrid, Pathfinder, type NavOpts } from "./nav.ts"
import { PathFollower } from "./follow.ts"

export { World, loadWorld, type WorldOpts }
export { NavGrid, Pathfinder, EDGE_WALK, EDGE_CLIMB, EDGE_DROP, NAV_VERSION, type NavOpts, type PathResult, type SearchOpts } from "./nav.ts"
export { PathFollower, type FollowIn, type FollowOut } from "./follow.ts"

const navCache = new WeakMap<World, Map<string, NavGrid>>()

/** Precomputed nav grid file (tools/precompute-nav.ts): next to the bundle, in the repo's data/, or $CWD/data. */
export function findNavData(): string | null {
  const here = import.meta.dir
  for (const d of [`${here}/data`, `${here}/../data`, `${here}/../../data`, `${process.cwd()}/data`]) {
    const f = `${d}/nav.bin.gz`
    if (existsSync(f)) return f
  }
  return null
}

/**
 * Build (or reuse, or load the precomputed) immutable nav grid for a world. The first grid of a
 * process also gets a short deterministic JIT warm-up of the hot query paths (warmWorld).
 */
export function navFor(world: World, opts: NavOpts = {}, warm = true): NavGrid {
  let m = navCache.get(world)
  if (!m) navCache.set(world, (m = new Map()))
  const key = JSON.stringify(opts)
  let g = m.get(key)
  if (!g) {
    try {
      const f = findNavData()
      if (f) g = NavGrid.deserialize(world, new Uint8Array(gunzipSync(readFileSync(f))), opts) ?? undefined
    } catch {
      g = undefined
    }
    if (!g) g = NavGrid.build(world, opts)
    m.set(key, g)
    if (warm && !warmed) {
      warmed = true
      try {
        warmWorld(world, g)
      } catch {
        // warm-up is best effort
      }
    }
  }
  return g
}

let warmed = false

/**
 * JIT warm-up of the hot world paths with a fixed amount of work (deterministic CPU, ~30-60 ms on
 * an idle core): LOS (shot/sight/canopy), terrain and surface samples, nav lookups and straight-walk
 * tests, a few budgeted A* searches and path-follower updates. Cold first calls otherwise cost
 * tens of ms inside a match. Results are discarded; the world and grid are not modified.
 */
export function warmWorld(world: World, nav: NavGrid): number {
  let s = 12345
  const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  let acc = 0
  const x0 = world.minX + 60, y0 = world.minY + 60, sx = world.maxX - world.minX - 120, sy = world.maxY - world.minY - 120
  const a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 400; i++) {
    const x = x0 + r() * sx, y = y0 + r() * sy, ang = 6.283 * r(), d = 10 + r() * 180
    a[0] = x
    a[1] = y
    a[2] = world.surfaceZ(x, y) + 8
    b[0] = x + Math.cos(ang) * d
    b[1] = y + Math.sin(ang) * d
    b[2] = world.groundZ(b[0], b[1]) + 4.5
    if (world.shotClear(a, b)) acc++
    if (i % 2 === 0 && world.sightClear(a, b, i % 4 === 0)) acc++
    const n = nav.nodeAt(x, y, a[2] - 8)
    if (n >= 0 && nav.lineWalkable(x, y, nav.hz[n], x + Math.cos(ang) * 20, y + Math.sin(ang) * 20, 30)) acc++
    if (world.prismAt(x, y, a[2] - 4) >= 0) acc++
  }
  const pf = new Pathfinder(nav)
  const f = new PathFollower(nav)
  for (let i = 0; i < 4; i++) {
    const x = x0 + r() * sx, y = y0 + r() * sy
    const z = world.groundZ(x, y)
    const tx = x + 80 + r() * 100, ty = y - 60 + r() * 120
    acc += pf.findPath(x, y, z, tx, ty, world.groundZ(tx, ty), { maxMs: 20, maxExpand: 3000 }).expanded
    f.setGoal(tx, ty, world.groundZ(tx, ty), 3)
    for (let k = 0; k < 3; k++) acc += f.update({ t: k * 0.1, pos: [x, y, z], vel: [0, 0, 0], grounded: true, energy: 100 }).remaining
  }
  return acc
}
