/**
 * Precompute rooftop candidates into data/roofs.json (roof mode, src/brain/roof.ts).
 *   bun tools/precompute-roofs.ts [--all]
 * A roof = a connected set of free nav nodes on a building or stadium top (not terrain, not a bridge deck),
 * at least 6 m above the ground. Per roof: area, height, climb from the ground (cheapest jet-up edge in the
 * nav graph), depth (cells from the edge), and the best interior spot (lowest exposure to ground viewers).
 */
import { writeFileSync } from "node:fs"
import { World, KIND_BRIDGE } from "../src/world/world.ts"
import { navFor } from "../src/world/index.ts"
import { ExposureMap } from "../src/expo/exposure.ts"

const world = World.load("kit/arena", ["v2/world.json", "v2/terrain.i16"])
const nav = navFor(world, {}, false)
const ex = ExposureMap.load("data")
const { w, h, cs, st, hz, terr } = nav
const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]
const SU = 1.2

const isRoof = new Uint8Array(nav.N)
for (let n = 0; n < nav.N; n++) {
  if (st[n] === 0 || terr[n]) continue
  const x = nav.nodeX(n), y = nav.nodeY(n)
  if (hz[n] - world.groundZ(x, y) < 6) continue
  const k = world.prismAt(x, y, hz[n] - 0.05)
  if (k >= 0 && world.pKind[k] === KIND_BRIDGE) continue
  isRoof[n] = 1
}
const comp = new Int32Array(nav.N).fill(-1)
type Roof = { id: number; nodes: number[] }
const roofs: Roof[] = []
for (let s = 0; s < nav.N; s++) {
  if (!isRoof[s] || comp[s] >= 0) continue
  const id = roofs.length
  const nodes: number[] = [s]
  comp[s] = id
  for (let q = 0; q < nodes.length; q++) {
    const u = nodes[q], c = u >> 1, ci = c % w, cj = (c - ci) / w
    for (let d = 0; d < 8; d++) {
      const ii = ci + DX[d], jj = cj + DY[d]
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue
      for (let l = 0; l < 2; l++) {
        const v = 2 * (jj * w + ii) + l
        if (!isRoof[v] || comp[v] >= 0 || Math.abs(hz[v] - hz[u]) > SU) continue
        comp[v] = id
        nodes.push(v)
      }
    }
  }
  roofs.push({ id, nodes })
}

const out: Record<string, number>[] = []
for (const r of roofs) {
  const free = r.nodes.filter((n) => st[n] === 1)
  if (free.length < 20) continue
  // depth: cells from the component's edge (multi-source BFS over free nodes)
  const depth = new Map<number, number>()
  const q: number[] = []
  for (const u of free) {
    const c = u >> 1, ci = c % w, cj = (c - ci) / w
    let edge = false
    for (let d = 0; d < 8 && !edge; d++) {
      const ii = ci + DX[d], jj = cj + DY[d]
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) { edge = true; break }
      const cc = jj * w + ii
      const same = (comp[2 * cc] === r.id && st[2 * cc] === 1) || (comp[2 * cc + 1] === r.id && st[2 * cc + 1] === 1)
      if (!same) edge = true
    }
    if (edge) (depth.set(u, 0), q.push(u))
  }
  for (let k = 0; k < q.length; k++) {
    const u = q[k], du = depth.get(u)!, c = u >> 1, ci = c % w, cj = (c - ci) / w
    for (let d = 0; d < 8; d++) {
      const ii = ci + DX[d], jj = cj + DY[d]
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue
      for (let l = 0; l < 2; l++) {
        const v = 2 * (jj * w + ii) + l
        if (comp[v] !== r.id || st[v] !== 1 || depth.has(v)) continue
        depth.set(v, du + 1)
        q.push(v)
      }
    }
  }
  // climb from the ground: implicit neighbor climbs and hop edges from terrain nodes
  let climb = Infinity
  for (const v of r.nodes) {
    const c = v >> 1, ci = c % w, cj = (c - ci) / w
    for (let d = 0; d < 8; d++) {
      const ii = ci + DX[d], jj = cj + DY[d]
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue
      for (let l = 0; l < 2; l++) {
        const u = 2 * (jj * w + ii) + l
        if (st[u] !== 1 || !terr[u]) continue
        const dh = hz[v] - hz[u]
        if (dh > SU && dh < climb && nav.ceil[u] >= dh + 9.3) climb = dh
      }
    }
  }
  for (let u = 0; u < nav.N; u++) {
    if (!terr[u] || st[u] !== 1) continue
    for (let e = nav.xStart[u]; e < nav.xStart[u + 1]; e++) {
      if (nav.xKind[e] !== 1 || comp[nav.xTo[e]] !== r.id) continue
      if (nav.xDh[e] < climb) climb = nav.xDh[e]
    }
  }
  let sx = 0, sy = 0, sz = 0, gz = 0
  for (const n of free) (sx += nav.nodeX(n)), (sy += nav.nodeY(n)), (sz += hz[n]), (gz += world.groundZ(nav.nodeX(n), nav.nodeY(n)))
  const N = free.length
  let maxDepth = 0
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d)
  // best spot: depth >= 2 cells (4 m), lowest ground-viewer exposure, then all-viewer exposure, then deeper
  let best = -1, bestS = Infinity
  let mExp = 0, mExpGV = 0
  for (const n of free) {
    const x = nav.nodeX(n), y = nav.nodeY(n), z = hz[n]
    const eGV = ex.exposureAt(x, y, z, true), eAll = ex.exposureAt(x, y, z)
    mExp += eAll
    mExpGV += eGV
    const dp = depth.get(n) ?? 0
    if (dp < Math.min(2, maxDepth)) continue
    const s = eGV + 0.3 * eAll - 0.01 * Math.min(dp, 6)
    if (s < bestS) (bestS = s), (best = n)
  }
  if (best < 0) continue
  const bx = nav.nodeX(best), by = nav.nodeY(best), bz = hz[best]
  const rnd = (v: number, k = 1) => Math.round(v * k) / k
  out.push({
    id: r.id, n: N, area: N * cs * cs, cx: rnd(sx / N), cy: rnd(sy / N), z: rnd(sz / N, 10), ground: rnd(gz / N, 10),
    climb: Number.isFinite(climb) ? rnd(climb, 10) : -1, depth: maxDepth,
    sx: rnd(bx, 10), sy: rnd(by, 10), sz: rnd(bz, 100),
    sExpGV: rnd(ex.exposureAt(bx, by, bz, true), 1000), sExp: rnd(ex.exposureAt(bx, by, bz), 1000),
    mExpGV: rnd(mExpGV / N, 1000), mExp: rnd(mExp / N, 1000),
  })
}
out.sort((a, b) => b.area - a.area)
const keep = process.argv.includes("--all") ? out : out.filter((r) => r.climb > 0 && r.climb <= 50 && r.area >= 160 && r.depth >= 2)
writeFileSync("data/roofs.json", JSON.stringify({ format: "mech-roofs/1", roofs: keep }))
console.log(`${roofs.length} roof components, ${out.length} with >= 20 free nodes, kept ${keep.length}`)
for (const r of keep.slice(0, 60))
  console.log(`#${r.id} area ${r.area} z ${r.z} (ground ${r.ground}) climb ${r.climb} depth ${r.depth} c (${r.cx},${r.cy}) spot (${r.sx},${r.sy}) expGV ${r.sExpGV} exp ${r.sExp} mean ${r.mExpGV}/${r.mExp}`)
