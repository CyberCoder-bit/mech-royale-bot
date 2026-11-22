/** Per-act timing of makeBot on the kit's recorded stream (in-process): bun tools/sq-timing.ts [botpath] */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const mod = await import(resolve(process.argv[2] ?? "src/bot.ts"))
const W = await import(resolve("src/world/index.ts"))
const prof: Record<string, { n: number; ms: number; max: number }> = {}
const wrap = (proto: any, name: string, label: string) => {
  const f = proto[name]
  proto[name] = function (...a: any[]) {
    const t = performance.now()
    const r = f.apply(this, a)
    const d = performance.now() - t
    const p = (prof[label] ??= { n: 0, ms: 0, max: 0 })
    p.n++
    p.ms += d
    if (d > p.max) p.max = d
    return r
  }
}
wrap(W.PathFollower.prototype, "update", "follow.update")
wrap(W.Pathfinder.prototype, "findPath", "findPath")
wrap(W.World.prototype, "shotClear", "shotClear")
wrap(W.NavGrid.prototype, "lineWalkable", "lineWalkable")
process.on("exit", () => console.log(JSON.stringify(prof)))
const lines = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = "kit/arena"
const t0 = performance.now()
const bot = mod.makeBot(hello)
const tInit = performance.now() - t0
const ts: number[] = []
const cpu: number[] = []
for (const o of lines.filter((m: any) => m.type === "obs")) {
  const a = performance.now()
  const c0 = process.cpuUsage()
  bot.act(o)
  const c1 = process.cpuUsage(c0)
  ts.push(performance.now() - a)
  cpu.push((c1.user + c1.system) / 1000)
}
{
  const s = [...cpu].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)
  console.log(`cpu ms: p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)}`)
}
const s = [...ts].sort((a, b) => a - b)
const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)
const top = ts.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 6).map(([v, i]) => `#${i}:${v.toFixed(1)}`).join(" ")
console.log(`init ${tInit.toFixed(0)} ms  act p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)}  slowest ${top}`)
