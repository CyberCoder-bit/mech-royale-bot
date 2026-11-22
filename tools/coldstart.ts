/** Cold-start phase costs (wall and CPU ms): world load, nav build, exposure load, full makeBot. `bun tools/coldstart.ts` */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"

const hello = JSON.parse(gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().split("\n")[0])
hello.map.dir = "kit/arena"
const phase = async (name: string, fn: () => unknown | Promise<unknown>) => {
  const c0 = process.cpuUsage()
  const t0 = performance.now()
  await fn()
  const c = process.cpuUsage(c0)
  console.log(`${name.padEnd(14)} wall ${(performance.now() - t0).toFixed(0).padStart(5)} ms  cpu ${((c.user + c.system) / 1000).toFixed(0).padStart(5)} ms`)
}
const W = await import("../src/world/index.ts")
let world: any
await phase("world load", () => (world = W.loadWorld(hello.map.dir, hello.map.files)))
await phase("nav build", () => W.navFor(world))
const E = await import("../src/expo/exposure.ts")
await phase("exposure", () => E.loadExposure())
const B = await import("../src/bot.ts")
await phase("makeBot(warm)", () => B.makeBot(hello))
