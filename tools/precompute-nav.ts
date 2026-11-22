/**
 * Precompute the nav grid into data/nav.bin.gz (loaded by navFor at hello instead of a ~1 s build).
 * Re-run after any change to NavGrid.build (and bump NAV_VERSION): a stale file is rejected by signature.
 *   bun tools/precompute-nav.ts
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { World } from "../src/world/world.ts"
import { NavGrid } from "../src/world/nav.ts"

const world = World.load("kit/arena", ["v2/world.json", "v2/terrain.i16"])
const t0 = performance.now()
const g = NavGrid.build(world)
const sig = NavGrid.signature(world)
const raw = g.serialize(sig)
const gz = gzipSync(raw, { level: 9 })
mkdirSync("data", { recursive: true })
writeFileSync("data/nav.bin.gz", gz)
console.log(`built in ${(performance.now() - t0).toFixed(0)} ms; raw ${(raw.length / 1e6).toFixed(2)} MB, gz ${(gz.length / 1e6).toFixed(2)} MB`)
// round trip check
const back = NavGrid.deserialize(world, raw)
if (!back) throw new Error("signature mismatch on round trip")
for (const k of ["hz", "st", "terr", "ceil", "pen", "xStart", "xTo", "xCost", "xDh", "xKind"] as const) {
  const a = g[k] as ArrayLike<number>, b = back[k] as ArrayLike<number>
  if (a.length !== b.length) throw new Error(`${k} length`)
  for (let i = 0; i < a.length; i++) if (!(a[i] === b[i] || (Number.isNaN(a[i]) && Number.isNaN(b[i])))) throw new Error(`${k}[${i}]`)
}
console.log("round trip ok:", g.summary())
