// scratch: compare our shotClear/sightClear with the simulator's LOS on random segments. bun tools/cmp-sim-los.ts <simDir>
import { resolve } from "node:path"
import { loadWorld } from "../src/world/index.ts"
const simDir = resolve(process.argv[2] ?? "sim")
const { loadWorld: simLoad } = await import(simDir + "/world.ts")
const { MAP_DIR } = await import(simDir + "/config.ts")
const ours = loadWorld("kit/arena", ["v2/world.json", "v2/terrain.i16"])
const sim = simLoad(MAP_DIR)
let s = 99
const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
let agreeShot = 0, agreeSight = 0, n = 0
const diffs: string[] = []
for (let i = 0; i < 20000; i++) {
  const x = -400 + r() * 800, y = -250 + r() * 550, a = 6.283 * r(), d = 10 + r() * 150
  const bx = x + Math.cos(a) * d, by = y + Math.sin(a) * d
  const az = ours.surfaceZ(x, y) + 8, bz = ours.surfaceZ(bx, by) + 4.5
  const o1 = ours.shotClear([x, y, az], [bx, by, bz])
  const s1 = sim.rayPrisms(x, y, az, bx, by, bz, 1) > 1 && sim.rayTerrain(x, y, az, bx, by, bz, 1) > 1
  const o2 = ours.sightClear([x, y, az], [bx, by, bz], true)
  const s2 = sim.los(x, y, az, bx, by, bz, true)
  n++
  if (o1 === s1) agreeShot++
  else if (diffs.length < 6) diffs.push(`shot ours=${o1} sim=${s1} (${x.toFixed(1)},${y.toFixed(1)},${az.toFixed(1)})->(${bx.toFixed(1)},${by.toFixed(1)},${bz.toFixed(1)})`)
  if (o2 === s2) agreeSight++
}
console.log(`shot agreement ${agreeShot}/${n}, sight agreement ${agreeSight}/${n}`)
for (const d of diffs) console.log(d)
