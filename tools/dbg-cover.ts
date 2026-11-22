// scratch: are slow LOS calls deterministic (geometry) or noise (preemption/GC)?
import { loadWorld } from "../src/world/index.ts"
const world = loadWorld("kit/arena", ["v2/world.json", "v2/terrain.i16"])
const me: [number, number, number] = [249.64, -259.22, world.groundZ(249.64, -259.22)]
const eye: [number, number, number] = [340.1, -201.4, 10.9]
for (let rep = 0; rep < 5; rep++) {
  const slow: string[] = []
  let total = 0
  for (const r of [12, 29, 50])
    for (let a = 0; a < 16; a++) {
      const x = me[0] + Math.cos(a * 0.39) * r, y = me[1] + Math.sin(a * 0.39) * r
      const z = world.groundZ(x, y)
      const t0 = performance.now()
      world.shotClear(eye, [x, y, z + 4.5])
      const dt = performance.now() - t0
      total += dt
      if (dt > 1) slow.push(`r${r}a${a}:${dt.toFixed(1)}`)
    }
  console.log(`rep ${rep}: total ${total.toFixed(2)} ms slow: ${slow.join(" ")}`)
}
