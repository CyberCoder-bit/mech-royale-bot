/**
 * Does the host bot hand control to the FFA brain on the recorded stream? Prints, per label kind, the
 * first time it appears (the brain labels "FFA <mode> hp..", the host its own label).
 *   bun tools/ffa-probe.ts
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join } from "node:path"
import { makeBot } from "../src/bot.ts"
import { draw } from "../src/mechfight.ts"

const root = join(import.meta.dir, "..")
const lines = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = { ...lines[0], map: { ...lines[0].map, dir: join(root, "kit/arena") } }
const t0 = performance.now()
const bot = makeBot(hello)
console.log(`makeBot ${(performance.now() - t0).toFixed(0)} ms`)
const first = new Map<string, number>()
for (const o of lines.filter((m: any) => m.type === "obs")) {
  bot.act(o)
  const d = (draw as any).take?.() ?? {}
  const label = String(d.label ?? "")
  const kind = /^FFA (hide|move|heal|loot|strike|fight|flee|end) /.test(label) ? "brain:" + label.split(" ")[1] : "host:" + label.split(" ")[0]
  if (!first.has(kind)) first.set(kind, o.t)
}
for (const [k, t] of first) console.log(`${k.padEnd(14)} first at t=${t.toFixed(1)}`)
