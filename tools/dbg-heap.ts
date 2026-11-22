// scratch: heap size after makeBot, and per-tick GC behaviour on the stream
import { heapStats } from "bun:jsc"
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { makeBot } from "../src/bot.ts"
import { draw } from "../src/mechfight.ts"

const lines = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = "kit/arena"
const show = (tag: string) => {
  const h = heapStats()
  console.log(`${tag}: heapSize ${(h.heapSize / 1e6).toFixed(1)} MB, capacity ${(h.heapCapacity / 1e6).toFixed(1)} MB, extra ${(h.extraMemorySize / 1e6).toFixed(1)} MB, objects ${h.objectCount}`)
}
show("start")
const bot = makeBot(hello)
show("after makeBot")
Bun.gc(true)
show("after full gc")
let slow = 0
for (const o of lines.filter((m: any) => m.type === "obs")) {
  const c0 = process.cpuUsage()
  bot.act(o)
  draw.take()
  const c = process.cpuUsage(c0)
  const ms = (c.user + c.system) / 1000
  if (ms > 5) {
    slow++
    if (slow < 8) console.log(`tick ${o.tick}: cpu ${ms.toFixed(1)} ms`)
  }
}
show("end")
console.log("slow ticks", slow)
