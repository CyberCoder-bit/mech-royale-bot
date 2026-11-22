/**
 * FFA brain cost check: constructor time (world, nav, exposure, warmup) and per-tick time on the
 * recorded stream with the FFA flag forced on.
 *   bun tools/ffa-bench.ts
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join } from "node:path"
import { FfaBrain } from "../src/brain/ffa.ts"

const root = join(import.meta.dir, "..")
const lines = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString().split("\n").filter(Boolean)
const hello = JSON.parse(lines[0])
hello.map.dir = join(root, "kit/arena")
for (let i = 0; i < 3; i++) {
  const t0 = performance.now()
  const b = new FfaBrain(hello)
  console.log(`ctor ${i}: ${(performance.now() - t0).toFixed(1)} ms (warm ${b.warmMs.toFixed(1)} ms, nav build ${b.nav?.buildMs?.toFixed(0)} ms)`)
}
const b = new FfaBrain(hello)
// per-method profile
const prof: Record<string, { n: number; ms: number; max: number }> = {}
for (const name of ["chooseSpot", "findCover", "lootGoal", "seesPoint", "shotReaches", "watchYaw"]) {
  const orig = (b as any)[name].bind(b)
  prof[name] = { n: 0, ms: 0, max: 0 }
  ;(b as any)[name] = (...args: unknown[]) => {
    const t0 = performance.now()
    const r = orig(...args)
    const d = performance.now() - t0
    const p = prof[name]
    p.n++
    p.ms += d
    if (d > p.max) p.max = d
    return r
  }
}
{
  const f = b.follow!
  const orig = f.update.bind(f)
  prof.follow = { n: 0, ms: 0, max: 0 }
  f.update = (inp) => {
    const t0 = performance.now()
    const r = orig(inp)
    const d = performance.now() - t0
    prof.follow.n++
    prof.follow.ms += d
    if (d > prof.follow.max) prof.follow.max = d
    return r
  }
}
const ms: number[] = []
for (const l of lines.slice(1)) {
  const m = JSON.parse(l)
  if (m.type !== "obs") continue
  const t0 = performance.now()
  b.tick(m, true)
  ms.push(performance.now() - t0)
}
ms.sort((a, b) => a - b)
const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(2)
console.log(`tick ms over ${ms.length} obs: p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${ms[ms.length - 1].toFixed(2)}  modes ${JSON.stringify(b.modeTime)}`)
for (const [k, v] of Object.entries(prof)) console.log(`  ${k.padEnd(12)} n ${String(v.n).padStart(5)} total ${v.ms.toFixed(1).padStart(8)} ms  max ${v.max.toFixed(2)} ms`)
// repeat passes with fresh brains and take the per-obs minimum (filters out descheduling on a loaded machine)
{
  const obsList = lines.slice(1).map((l) => JSON.parse(l)).filter((m) => m.type === "obs")
  const K = 5
  const mins = new Array(obsList.length).fill(Infinity)
  for (let k = 0; k < K; k++) {
    const bb = new FfaBrain(hello)
    obsList.forEach((o, i) => {
      const t0 = performance.now()
      bb.tick(o, true)
      const d = performance.now() - t0
      if (d < mins[i]) mins[i] = d
    })
  }
  const s = [...mins].sort((a, b) => a - b)
  const qq = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)
  const worst = mins.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([v, i]) => `#${i}:${v.toFixed(1)}`)
  console.log(`min-of-${K} tick ms: p50 ${qq(0.5)} p90 ${qq(0.9)} p99 ${qq(0.99)} max ${s[s.length - 1].toFixed(2)}  worst ${worst.join(" ")}`)
}
