/**
 * Validate sim geometry against the recorded real stream (kit/check/stream.jsonl.gz):
 * grounded self.pos.z vs terrain/roof height, max speeds, visible mechs vs our LOS.
 *   bun sim/validate_stream.ts
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join } from "node:path"
import { KIT, MAP_DIR } from "./config.ts"
import { World } from "./world.ts"

const t0 = performance.now()
const w = new World(MAP_DIR)
console.log(`world loaded in ${(performance.now() - t0).toFixed(0)} ms: ${w.prisms.length} prisms, ${w.nTrees} trees`)
const lines = gunzipSync(readFileSync(join(KIT, "check/stream.jsonl.gz")))
  .toString("utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
const obs = lines.filter((l) => l.type === "obs")
let n = 0,
  bad = 0,
  maxErr = 0
for (const o of obs) {
  const s = o.self
  if (!s.grounded) continue
  const [x, y, z] = s.pos
  const sup = w.support(x, y, z + 1.2)
  const err = Math.abs(sup - z)
  n++
  if (err > 0.1) {
    bad++
    if (bad < 6) console.log(`grounded mismatch t=${o.t} pos=${s.pos} support=${sup.toFixed(2)} ground=${w.ground(x, y).toFixed(2)}`)
  }
  maxErr = Math.max(maxErr, err)
}
console.log(`grounded samples ${n}, mismatches(>0.1m) ${bad}, max err ${maxErr.toFixed(3)}`)
// visible mechs LOS
let vis = 0,
  losOk = 0,
  near = 0
for (const o of obs) {
  const s = o.self
  const eye = s.pos[2] + (s.stats.eye_height ?? 8)
  for (const m of o.mechs) {
    vis++
    const hc = m.kind === "npc" ? 1.75 : 4.5
    const ht = m.kind === "npc" ? 3.5 : 9
    const d = Math.hypot(m.pos[0] - s.pos[0], m.pos[1] - s.pos[1])
    if (d < 45) near++
    const a = w.los(s.pos[0], s.pos[1], eye, m.pos[0], m.pos[1], m.pos[2] + hc, d >= 45)
    const b = w.los(s.pos[0], s.pos[1], eye, m.pos[0], m.pos[1], m.pos[2] + ht, d >= 45)
    if (a || b) losOk++
    else if (vis - losOk < 8) console.log(`visible but our LOS blocked: t=${o.t} self=${s.pos} other=${m.id} ${m.pos} d=${d.toFixed(1)}`)
  }
}
console.log(`visible mech samples ${vis} (near ${near}), our LOS agrees on ${losOk}`)
// speeds
let maxV = 0
for (let i = 1; i < obs.length; i++) {
  const a = obs[i - 1].self.pos,
    b = obs[i].self.pos
  const dt = obs[i].t - obs[i - 1].t
  if (dt > 0) maxV = Math.max(maxV, Math.hypot(b[0] - a[0], b[1] - a[1]) / dt)
}
console.log(`max observed self horizontal speed ${maxV.toFixed(2)} m/s`)
// raycast perf
const t1 = performance.now()
let blocked = 0
for (let i = 0; i < 20000; i++) {
  const x = -400 + ((i * 37) % 800),
    y = -250 + ((i * 53) % 500)
  const z = w.ground(x, y) + 8
  const x2 = x + 150 * Math.cos(i),
    y2 = y + 150 * Math.sin(i)
  if (!w.los(x, y, z, x2, y2, w.ground(x2, y2) + 4.5, true)) blocked++
}
console.log(`20000 LOS rays of 150 m: ${(performance.now() - t1).toFixed(0)} ms, blocked ${blocked}`)
