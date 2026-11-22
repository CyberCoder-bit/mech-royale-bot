/** Perf numbers for src/world: load time, LOS calls/ms, nav build and A* timings. `bun tools/world-bench.ts` */
import { World } from "../src/world/world.ts"

const t0 = performance.now()
const w = World.load("kit/arena", ["v2/world.json", "v2/terrain.i16"])
console.log("world load ms", (performance.now() - t0).toFixed(1), "| canopyLimit m", w.canopyLimit.toFixed(2))
console.log("groundZ at stream spawn", w.groundZ(320.21, -280.29).toFixed(2), "(obs pos.z -2.03)")

let s = 12345
const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const N = 20000
const pts: number[][] = []
for (let i = 0; i < N; i++) {
  const x = -400 + r() * 800, y = -250 + r() * 550
  const a = Math.PI * 2 * r(), d = 20 + r() * 180
  const bx = x + Math.cos(a) * d, by = y + Math.sin(a) * d
  pts.push([x, y, w.surfaceZ(x, y) + 8, bx, by, w.surfaceZ(bx, by) + 4.5])
}
for (const name of ["shotClear", "sightClear"] as const) {
  let clear = 0
  const t1 = performance.now()
  for (const p of pts) if (w[name]([p[0], p[1], p[2]], [p[3], p[4], p[5]])) clear++
  const dt = performance.now() - t1
  console.log(name, (N / dt).toFixed(0), "calls/ms | clear fraction", (clear / N).toFixed(3))
}

const nav = await import("../src/world/nav.ts").catch(() => null)
if (nav) {
  const t2 = performance.now()
  const g = nav.NavGrid.build(w)
  console.log("nav build ms", (performance.now() - t2).toFixed(1), g.summary())
  const pf = new nav.Pathfinder(g)
  const trips: [number, number, number, number][] = [
    [320, -280, -80, -60],
    [-276, 40, 100, 150],
    [-400, -200, 0, 200],
    [200, 300, -200, -250],
    [-150, 100, 250, -100],
  ]
  for (const [x0, y0, x1, y1] of trips) {
    const t3 = performance.now()
    const res = pf.findPath(x0, y0, w.surfaceZ(x0, y0), x1, y1, w.surfaceZ(x1, y1), { maxMs: 200 })
    const dt = performance.now() - t3
    console.log(`A* (${x0},${y0})->(${x1},${y1}) straight ${Math.hypot(x1 - x0, y1 - y0).toFixed(0)} m: ${dt.toFixed(2)} ms, status ${res.status}, expanded ${res.expanded}, cost ${res.cost.toFixed(0)}, nodes ${res.nodes.length}`)
  }
}
