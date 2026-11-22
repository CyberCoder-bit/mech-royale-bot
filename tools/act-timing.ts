/** Time makeBot() and every act() call in-process on the kit's recorded stream (CPU cost, independent of pipe scheduling).
 *   bun tools/act-timing.ts <path/to/src/bot.ts> [stream.jsonl.gz] [mapDir] */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
const botPath = process.argv[2] ?? "../src/bot.ts"
const streamPath = process.argv[3] ?? "kit/check/stream.jsonl.gz"
const mapDir = process.argv[4] ?? "kit/arena"
const { makeBot } = await import(botPath)
const { draw } = await import(botPath.replace(/bot\.ts$/, "mechfight.ts"))
const lines = gunzipSync(readFileSync(streamPath)).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = mapDir
let t0 = performance.now()
const ci = process.cpuUsage()
const bot = makeBot(hello)
const initMs = performance.now() - t0
const ic = process.cpuUsage(ci)
console.log(`init CPU ms ${((ic.user + ic.system) / 1000).toFixed(0)}`)
const times: number[] = []
const cpu: number[] = []
for (const o of lines.filter((m: any) => m.type === "obs")) {
  t0 = performance.now()
  const c0 = process.cpuUsage()
  bot.act(o)
  draw.take?.()
  const c1 = process.cpuUsage(c0)
  times.push(performance.now() - t0)
  cpu.push((c1.user + c1.system) / 1000)
}
cpu.sort((a, b) => a - b)
const qc = (p: number) => cpu[Math.min(cpu.length - 1, Math.floor(p * cpu.length))].toFixed(2)
console.log(`act CPU ms p50 ${qc(0.5)} p90 ${qc(0.9)} p99 ${qc(0.99)} max ${qc(1)}`)
times.sort((a, b) => a - b)
const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(2)
console.log(`init ${initMs.toFixed(0)} ms | act ms p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)} | n ${times.length}`)
