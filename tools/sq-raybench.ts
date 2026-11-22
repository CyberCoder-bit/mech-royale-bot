/** Micro-benchmark of world.shotClear and findPath: bun tools/sq-raybench.ts */
import { loadWorld, navFor, Pathfinder } from "../src/world/index.ts"
const w = loadWorld("kit/arena", ["v2/world.json", "v2/terrain.i16"])
const nav = navFor(w)
let seed = 1
const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const rays: number[][] = []
for (let i = 0; i < 4000; i++) {
  const x = -300 + r() * 600, y = -250 + r() * 500
  const a = r() * Math.PI * 2, d = 20 + r() * 180
  const z0 = w.groundZ(x, y) + 7
  const x1 = x + Math.cos(a) * d, y1 = y + Math.sin(a) * d
  rays.push([x, y, z0, x1, y1, w.groundZ(x1, y1) + 4.5])
}
for (let pass = 0; pass < 3; pass++) {
  const t0 = performance.now()
  let clear = 0, mx = 0
  for (const q of rays) {
    const a = performance.now()
    if (w.shotClear([q[0], q[1], q[2]], [q[3], q[4], q[5]])) clear++
    const d = performance.now() - a
    if (d > mx) mx = d
  }
  console.log(`pass ${pass}: ${rays.length} rays ${(performance.now() - t0).toFixed(1)} ms, clear ${clear}, max ${mx.toFixed(2)} ms`)
}
const pf = new Pathfinder(nav)
for (let i = 0; i < 12; i++) {
  const x = -200 + r() * 400, y = -200 + r() * 400, x1 = -200 + r() * 400, y1 = -200 + r() * 400
  const a = performance.now()
  const res = pf.findPath(x, y, w.groundZ(x, y), x1, y1, w.groundZ(x1, y1), { maxMs: 4, weight: 1.8 })
  console.log(`path ${i}: ${(performance.now() - a).toFixed(1)} ms ${res.status} exp ${res.expanded}`)
}
