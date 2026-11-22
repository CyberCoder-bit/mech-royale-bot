/** Local steering: bend a desired move direction around walls, ledges and the map edge using the nav grid. */
import type { NavGrid } from "../world/nav.ts"
import type { V2 } from "../util/math.ts"

const OFFS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9]
const STEP = 0.3 // rad (~17 deg)

/**
 * The walkable direction closest to `desired` (scaled like it), looking `look` meters ahead.
 * Returns `desired` unchanged when nothing nearby is walkable (e.g. airborne, no nav).
 */
export function walkableDir(nav: NavGrid | null, x: number, y: number, z: number, desired: V2, look = 6): V2 {
  const len = Math.hypot(desired[0], desired[1])
  if (!nav || len < 1e-6) return desired
  const yaw0 = Math.atan2(desired[1], desired[0])
  for (const k of OFFS) {
    const yaw = yaw0 + k * STEP
    const c = Math.cos(yaw), s = Math.sin(yaw)
    if (nav.lineWalkable(x, y, z, x + c * look, y + s * look, look + 1)) return [c * len, s * len]
  }
  return desired
}

/** Is a straight walk of `look` meters along yaw walkable? */
export function canWalk(nav: NavGrid | null, x: number, y: number, z: number, yaw: number, look = 6): boolean {
  if (!nav) return true
  return nav.lineWalkable(x, y, z, x + Math.cos(yaw) * look, y + Math.sin(yaw) * look, look + 1)
}
