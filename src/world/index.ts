/**
 * World library entry point.
 *
 *   const world = loadWorld(hello.map.dir, hello.map.files)  // cached, immutable, ~30 ms
 *   const nav = navFor(world)                                // cached, immutable, ~150 ms
 *   world.groundZ(x, y)            terrain height (bilinear)
 *   world.surfaceZ(x, y, zRef)     highest walkable surface not above zRef + step_up
 *   world.prismAt(x, y, z)         prism index containing the point, or -1
 *   world.shotClear(a, b)          prisms + terrain block; trees never do
 *   world.sightClear(a, b, canopy) shotClear + trunks + canopy (crown length vs canopyLimit)
 *   new PathFollower(nav)          per bot: setGoal(x, y, z), update(obs-ish) -> move/jump/boost
 *   new Pathfinder(nav)            per bot: findPath(sx, sy, sz, tx, ty, tz, opts)
 */
import { World, loadWorld, type WorldOpts } from "./world.ts"
import { NavGrid, type NavOpts } from "./nav.ts"

export { World, loadWorld, type WorldOpts }
export { NavGrid, Pathfinder, EDGE_WALK, EDGE_CLIMB, EDGE_DROP, type NavOpts, type PathResult, type SearchOpts } from "./nav.ts"
export { PathFollower, type FollowIn, type FollowOut } from "./follow.ts"

const navCache = new WeakMap<World, Map<string, NavGrid>>()

/** Build (or reuse) the immutable nav grid for a world. */
export function navFor(world: World, opts: NavOpts = {}): NavGrid {
  let m = navCache.get(world)
  if (!m) navCache.set(world, (m = new Map()))
  const key = JSON.stringify(opts)
  let g = m.get(key)
  if (!g) m.set(key, (g = NavGrid.build(world, opts)))
  return g
}
