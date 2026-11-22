/** Time the bot on the recorded stream in-process: per-tick ms with labels (slowest first). `bun tools/stream-time.ts` */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { makeBot } from "../src/bot.ts"
import { draw } from "../src/mechfight.ts"

const lines = gunzipSync(readFileSync(process.argv[2] ?? "kit/check/stream.jsonl.gz")).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = "kit/arena"
const t0 = performance.now()
const bot = makeBot(hello)
console.log(`factory ${(performance.now() - t0).toFixed(0)} ms`)
const rows: { ms: number; cpu: number; t: number; label: string }[] = []
for (const o of lines.filter((m: any) => m.type === "obs")) {
  const c0 = process.cpuUsage()
  const a = performance.now()
  bot.act(o)
  const ms = performance.now() - a
  const c1 = process.cpuUsage(c0)
  rows.push({ ms, cpu: (c1.user + c1.system) / 1000, t: o.t, label: draw.take()?.label ?? "" })
}
const sc = rows.map((r) => r.cpu).sort((a, b) => a - b)
const qc = (f: number) => sc[Math.min(sc.length - 1, Math.floor(f * sc.length))].toFixed(2)
console.log(`CPU ms (excludes preemption): p50 ${qc(0.5)} p90 ${qc(0.9)} p99 ${qc(0.99)} max ${qc(1)}`)
const s = [...rows].sort((a, b) => a.ms - b.ms)
const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))].ms.toFixed(2)
console.log(`p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)}`)
console.log("wall-time slowest:")
for (const r of s.slice(-8).reverse()) console.log(`${r.ms.toFixed(1)} ms (cpu ${r.cpu.toFixed(1)}) t=${r.t} ${r.label}`)
