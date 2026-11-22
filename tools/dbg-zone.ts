// scratch: why do zone-mode ticks cost ~12 ms CPU? Time follower plans toward a far zone goal.
import { loadWorld, navFor, PathFollower } from "../src/world/index.ts"
const world = loadWorld("kit/arena", ["v2/world.json", "v2/terrain.i16"])
const nav = navFor(world)
const f = new PathFollower(nav)
const start: [number, number, number] = [320.21, -280.29, world.groundZ(320.21, -280.29)]
const nc = [-42.12, 7.11], nr = 380
const d = Math.hypot(start[0] - nc[0], start[1] - nc[1])
const want = nr - 40 * 1.3
const gx = nc[0] + ((start[0] - nc[0]) / d) * want, gy = nc[1] + ((start[1] - nc[1]) / d) * want
console.log("goal", gx.toFixed(1), gy.toFixed(1), "dist", Math.hypot(gx - start[0], gy - start[1]).toFixed(0))
for (const planMs of [4, 4, 4, 8, 30]) {
  f.clear()
  f.planMs = planMs
  f.setGoal(gx, gy, world.groundZ(gx, gy), 6)
  const c0 = process.cpuUsage()
  const t0 = performance.now()
  const o = f.update({ t: 1, pos: start, vel: [0, 0, 0], grounded: true, energy: 100 })
  const c = process.cpuUsage(c0)
  const pr = (f as any).path
  console.log(`planMs ${planMs}: wall ${(performance.now() - t0).toFixed(1)} cpu ${((c.user + c.system) / 1000).toFixed(1)} ms status ${pr?.status} expanded ${pr?.expanded} nodes ${pr?.nodes.length} state ${o.state}`)
}
// raw A*
const t1 = performance.now()
const r = f.pf.findPath(start[0], start[1], start[2], gx, gy, world.groundZ(gx, gy), { maxMs: 4, weight: 1.8 })
console.log(`raw A* W1.8: ${(performance.now() - t1).toFixed(1)} ms ${r.status} exp ${r.expanded}`)
const t2 = performance.now()
const r2 = f.pf.findPath(start[0], start[1], start[2], gx, gy, world.groundZ(gx, gy), { maxMs: 100, weight: 1.25 })
console.log(`raw A* W1.25 unlimited: ${(performance.now() - t2).toFixed(1)} ms ${r2.status} exp ${r2.expanded}`)
