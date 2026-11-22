/** FFA hook contract on the recorded stream: inert without the flag, acts with it, never throws. */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join } from "node:path"
import { FfaBrain } from "../src/brain/ffa.ts"
import { makeBot } from "../src/bot.ts"

const root = join(import.meta.dir, "..")
const lines = gunzipSync(readFileSync(join(root, "kit/check/stream.jsonl.gz"))).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = { ...lines[0], map: { ...lines[0].map, dir: join(root, "kit/arena") } }
const obs = lines.filter((m: any) => m.type === "obs")

test("tick() returns null while the ffa flag is off", () => {
  const b = new FfaBrain(hello)
  for (const o of obs) expect(b.tick(o, false)).toBeNull()
  expect(b.active).toBe(false)
  expect(b.failed).toBe(0)
})

test("with the flag on, tick() waits for 2 deaths we didn't cause, then drives with valid actions", () => {
  const b = new FfaBrain(hello)
  let n = 0
  for (const o of obs) {
    const a = b.tick(o, true)
    const deaths = 16 - o.alive // we kill nobody in the recorded stream
    if (deaths < 2) {
      expect(a).toBeNull()
      continue
    }
    expect(a).not.toBeNull()
    const m = a!.move!
    expect(Math.hypot(m[0], m[1])).toBeLessThanOrEqual(1.0001)
    expect(a!.aim!.every(Number.isFinite)).toBe(true)
    expect(a!.fire!.length).toBe(2)
    n++
  }
  expect(n).toBeGreaterThan(50)
  expect(b.failed).toBe(0)
})

test("the flag coming on late (after lateCutoff) never activates the brain", () => {
  const b = new FfaBrain(hello)
  const late = obs.map((o: any) => ({ ...o, t: o.t + 1000 }))
  for (const o of late) expect(b.tick(o, true)).toBeNull()
  expect(b.active).toBe(false)
})

test("host bot with the hook runs the whole stream (FFA takes over after the 2nd death at t=22.7 s)", () => {
  const bot = makeBot(hello)
  for (const o of obs) {
    const a = bot.act(o)
    expect(a.move).toBeDefined()
    expect(a.aim!.every(Number.isFinite)).toBe(true)
  }
})
