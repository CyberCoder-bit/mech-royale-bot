/**
 * Byte-identity check of two bot bundles on the recorded stream: runs both in-process over the same
 * observations and compares the JSON of every action (debug drawings excluded).
 *   bun tools/same-actions.ts runs/bots/a.js runs/bots/b.js
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join, resolve } from "node:path"

const root = join(import.meta.dir, "..")
const lines = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const obs = lines.filter((m: any) => m.type === "obs")
const out: string[][] = []
for (const path of process.argv.slice(2, 4)) {
  const mod = await import(resolve(path))
  const hello = JSON.parse(JSON.stringify({ ...lines[0], map: { ...lines[0].map, dir: join(root, "kit/arena") } }))
  const bot = mod.makeBot(hello)
  const acts: string[] = []
  for (const o of obs) {
    const a = { ...bot.act(JSON.parse(JSON.stringify(o))) }
    delete (a as any).debug
    mod.draw?.clear?.()
    acts.push(JSON.stringify(a))
  }
  out.push(acts)
}
let diff = 0, first = -1
for (let i = 0; i < obs.length; i++)
  if (out[0][i] !== out[1][i]) {
    diff++
    if (first < 0) first = i
  }
console.log(`${obs.length} observations: ${diff} differing actions${first >= 0 ? ` (first at #${first}: ${out[0][first]} vs ${out[1][first]})` : ""}`)
