/** Feed the kit's recorded stream to makeBot in-process and print what the bot decides (sanity check, not a sim). */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { makeBot } from "../src/bot.ts"
import { draw } from "../src/mechfight.ts"

const lines = gunzipSync(readFileSync(process.argv[2] ?? "kit/check/stream.jsonl.gz")).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = "kit/arena"
const bot = makeBot(hello)
let errors = 0, fires = 0, takes = 0, picks = 0
for (const o of lines.filter((m: any) => m.type === "obs")) {
  try {
    const a = bot.act(o)
    const d = draw.take()
    if (a.fire?.some(Boolean)) fires++
    if (a.take !== undefined) takes++
    if (a.pick !== undefined) picks++
    if (o.tick % 40 === 0) console.log(`t=${o.t.toFixed(1)} hp=${o.self.hp.toFixed(0)} mechs=${o.mechs.length} move=${a.move?.map((v) => v.toFixed(2))} aim=${a.aim?.map((v) => v.toFixed(2))} fire=${a.fire} boost=${a.boost} jump=${a.jump} | ${d?.label ?? ""}`)
  } catch (e) {
    errors++
    if (errors < 4) console.error(e)
  }
}
console.log({ errors, fires, takes, picks })
