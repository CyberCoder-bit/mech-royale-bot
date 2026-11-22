/** Per-act timing of makeBot on the kit's recorded stream (in-process): bun tools/sq-timing.ts [botpath] */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const mod = await import(resolve(process.argv[2] ?? "src/bot.ts"))
const lines = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = "kit/arena"
const t0 = performance.now()
const bot = mod.makeBot(hello)
const tInit = performance.now() - t0
const ts: number[] = []
for (const o of lines.filter((m: any) => m.type === "obs")) {
  const a = performance.now()
  bot.act(o)
  ts.push(performance.now() - a)
}
const s = [...ts].sort((a, b) => a - b)
const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)
const top = ts.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 6).map(([v, i]) => `#${i}:${v.toFixed(1)}`).join(" ")
console.log(`init ${tInit.toFixed(0)} ms  act p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)}  slowest ${top}`)
