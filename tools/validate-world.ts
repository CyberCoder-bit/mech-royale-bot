/**
 * Validate src/world against the recorded stream (kit/check/stream.jsonl.gz):
 *  - grounded self.pos.z vs surfaceZ under the feet
 *  - for every listed mech/NPC: does our vision model (range, FOV wedge, LOS, canopy) say we see it?
 *    Listings that fail every LOS variant are memory-tracked (seen within memory_s, now hidden).
 * `bun tools/validate-world.ts [stream.jsonl.gz]`
 */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { World } from "../src/world/world.ts"

const lines = gunzipSync(readFileSync(process.argv[2] ?? "kit/check/stream.jsonl.gz")).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = lines[0]
const obs = lines.filter((m: any) => m.type === "obs")
const w = World.load("kit/arena", hello.map.files)
const vis = hello.config.vision
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

// 1. surface heights
let n = 0, sum = 0, max = 0
const worst: string[] = []
for (const o of obs) {
  const s = o.self
  if (!s.grounded) continue
  const [x, y, z] = s.pos
  const sz = w.surfaceZ(x, y, z + 0.5)
  const g = w.groundZ(x, y)
  const e = Math.abs(sz - z)
  n++
  sum += e
  if (e > max) max = e
  if (e > 0.2 && worst.length < 8) worst.push(`t=${o.t} pos=${s.pos.map((v: number) => v.toFixed(2))} surfaceZ=${sz.toFixed(2)} groundZ=${g.toFixed(2)}`)
}
console.log(`grounded samples ${n}: mean |pos.z - surfaceZ| = ${(sum / Math.max(1, n)).toFixed(3)} m, max ${max.toFixed(3)} m`)
for (const s of worst) console.log("  off:", s)

// 2. listed actors vs our vision model
type Row = { t: number; id: number; kind: string; d: number; inFov: boolean; shot: boolean; sightC: boolean; sightT: boolean; sightNoCanopy: boolean; crown: number; first: boolean }
const rows: Row[] = []
const lastSeenT = new Map<number, number>()
let prevIds = new Set<number>()
for (const o of obs) {
  const s = o.self
  const eye = [s.pos[0], s.pos[1], s.pos[2] + (s.stats?.eye_height ?? 8)]
  const ids = new Set<number>()
  for (const m of o.mechs) {
    ids.add(m.id)
    const size = 1 + 0.05 * (m.cubes ?? 0)
    const hgt = m.kind === "npc" ? hello.config.npc.height : 9 * size
    const c = [m.pos[0], m.pos[1], m.pos[2] + hgt / 2]
    const top = [m.pos[0], m.pos[1], m.pos[2] + hgt]
    const d = Math.hypot(c[0] - eye[0], c[1] - eye[1])
    const yaw = Math.atan2(c[1] - eye[1], c[0] - eye[0])
    const inFov = Math.abs(wrap(yaw - s.aim[0])) <= ((vis.fov_deg / 2) * Math.PI) / 180 && d <= vis.range
    const crown = Math.max(w.canopyAlong(eye[0], eye[1], eye[2], c[0], c[1], c[2]), 0)
    rows.push({
      t: o.t,
      id: m.id,
      kind: m.kind,
      d,
      inFov,
      shot: w.shotClear(eye, c),
      sightC: w.sightClear(eye, c, d > vis.near_range),
      sightT: w.sightClear(eye, top, d > vis.near_range),
      sightNoCanopy: w.sightClear(eye, c, false) || w.sightClear(eye, top, false),
      crown,
      first: !prevIds.has(m.id),
    })
    lastSeenT.set(m.id, o.t)
  }
  prevIds = ids
}
const near = rows.filter((r) => r.d <= vis.near_range)
const far = rows.filter((r) => r.d > vis.near_range)
const pct = (a: number, b: number) => `${a}/${b} (${((100 * a) / Math.max(1, b)).toFixed(0)}%)`
console.log(`listed actor-frames: ${rows.length} (near ${near.length}, far ${far.length})`)
const visibleModel = (r: Row) => (r.d <= vis.near_range ? r.sightC || r.sightT : r.inFov && (r.sightC || r.sightT))
console.log("  our model says visible:", pct(rows.filter(visibleModel).length, rows.length))
console.log("  far & outside FOV wedge:", pct(far.filter((r) => !r.inFov).length, far.length))
console.log("  far & in FOV & no LOS (buildings/terrain):", pct(far.filter((r) => r.inFov && !r.shot).length, far.length))
console.log("  far & in FOV & hard LOS ok but canopy/trunk blocks:", pct(far.filter((r) => r.inFov && r.shot && !(r.sightC || r.sightT)).length, far.length))
const firsts = rows.filter((r) => r.first)
console.log(`first appearances: ${firsts.length}`)
for (const r of firsts) console.log(`  t=${r.t} id=${r.id} ${r.kind} d=${r.d.toFixed(0)} inFov=${r.inFov} shotLOS=${r.shot} sight(c/t)=${r.sightC}/${r.sightT} crown=${r.crown.toFixed(2)} m`)
// runs of invisible listings (memory tracking)
let runStart = -1, runs: string[] = []
for (let i = 0; i < rows.length; i++) {
  const v = visibleModel(rows[i])
  if (!v && runStart < 0) runStart = i
  if ((v || i === rows.length - 1) && runStart >= 0) {
    const a = rows[runStart], b = rows[v ? i - 1 : i]
    runs.push(`t=${a.t}..${b.t} id=${a.id} (${(b.t - a.t).toFixed(1)} s) reason=${!a.inFov && a.d > vis.near_range ? "outside FOV" : !a.shot ? "blocked" : "canopy"}`)
    runStart = -1
  }
}
console.log(`listed-but-not-visible stretches (model): ${runs.length}`)
for (const r of runs.slice(0, 20)) console.log("  " + r)
// canopy crown lengths for in-FOV far listings with hard LOS
const crowns = far.filter((r) => r.inFov && r.shot).map((r) => r.crown).sort((a, b) => a - b)
if (crowns.length) console.log(`crown length on far in-FOV hard-LOS listings: min ${crowns[0].toFixed(2)} median ${crowns[crowns.length >> 1].toFixed(2)} max ${crowns[crowns.length - 1].toFixed(2)} (limit ${w.canopyLimit.toFixed(2)})`)
