/**
 * Cold single pass of the host bot (src/bot.ts with the FFA hook) over the recorded stream: CPU ms per
 * act() and the slowest observations (index, t, CPU ms), to find per-tick spikes.
 *   bun tools/ffa-slow.ts [runs]
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const lines = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = { ...lines[0], map: { ...lines[0].map, dir: join(root, "kit/arena") } }
const obs = lines.filter((m: any) => m.type === "obs")
const { makeBot } = await import("../src/bot.ts")
const runs = parseInt(process.argv[2] ?? "1")
for (let r = 0; r < runs; r++) {
  const bot = makeBot(hello)
  const cpu: { i: number; t: number; ms: number }[] = []
  obs.forEach((o: any, i: number) => {
    const c0 = process.cpuUsage()
    bot.act(o)
    const c = process.cpuUsage(c0)
    cpu.push({ i, t: o.t, ms: (c.user + c.system) / 1000 })
  })
  const s = [...cpu].sort((a, b) => b.ms - a.ms)
  console.log(`run ${r}: slowest ` + s.slice(0, 8).map((x) => `#${x.i}(t=${x.t.toFixed(1)}):${x.ms.toFixed(1)}`).join(" "))
}
