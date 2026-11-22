import { describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { makeBot } from "../src/bot.ts"
import { draw, type Observation } from "../src/mechfight.ts"
import { loadWorld, navFor } from "../src/world/index.ts"

const lines = gunzipSync(readFileSync("kit/check/stream.jsonl.gz")).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = "kit/arena"
const first: Observation = lines[1]
const world = loadWorld("kit/arena", hello.map.files)
const nav = navFor(world)

/** a free open-ground spot (feet) near (x, y) */
function spot(x: number, y: number): [number, number, number] {
  const n = nav.nearestFree(x, y, world.groundZ(x, y), 30)
  return [nav.nodeX(n), nav.nodeY(n), nav.hz[n]]
}

function obsAt(t: number, pos: [number, number, number], extra: Partial<Observation> = {}): Observation {
  const o = JSON.parse(JSON.stringify(first)) as Observation
  o.t = t
  o.tick = Math.round(t * 20)
  o.self.pos = pos
  o.self.vel = [0, 0, 0]
  o.mechs = []
  o.events = []
  o.sounds = []
  o.projectiles = []
  o.pickups = []
  o.crates = []
  o.cubes = []
  return Object.assign(o, extra)
}

describe("bot behaviour", () => {
  test("never throws on the recorded stream and answers every observation", () => {
    const bot = makeBot(hello, "fighter", { warm: false })
    for (const o of lines.filter((m: any) => m.type === "obs")) {
      const a = bot.act(o)
      draw.take()
      expect(Array.isArray(a.move)).toBe(true)
      expect(Number.isFinite(a.aim![0]) && Number.isFinite(a.aim![1])).toBe(true)
    }
  })

  test("steps away from an incoming mortar shell's impact point", () => {
    const bot = makeBot(hello, "fighter", { warm: false })
    const me = spot(30, -60)
    // a shell 1.2 s from landing right next to us (falls from 30 m up, moving east)
    const g = 22, tImp = 1.2
    const target = [me[0] + 2, me[1], me[2]]
    const vel: [number, number, number] = [10, 0, 0]
    const p0: [number, number, number] = [target[0] - vel[0] * tImp, target[1], target[2] + 0.5 * g * tImp * tImp]
    let a = bot.act(obsAt(5, me))
    draw.take()
    a = bot.act(obsAt(5.1, me, { projectiles: [{ id: 1, kind: "mortar", pos: p0, vel }] }))
    const label = draw.take()?.label ?? ""
    expect(label).toContain("dodge")
    // moving away from the impact point (which is east of us)
    expect(a.move![0]).toBeLessThan(0)
  })

  test("zone travel does not dither at the boundary", () => {
    const bot = makeBot(hello, "fighter", { warm: false })
    const me = spot(30, -60)
    // next circle centered 200 m east; we stand just outside its margin boundary
    const nc: [number, number] = [me[0] + 200, me[1]]
    const nr = 160 // margin = 40 (capped) -> zoneIn = 120, we are at 200
    const modes: string[] = []
    let pos = me
    for (let i = 0; i < 60; i++) {
      const o = obsAt(10 + i * 0.1, pos, { zone: { center: [nc[0], nc[1]], radius: 400, next_center: nc, next_radius: nr, shrink_start: 60, shrink_end: 110, dps: 20 } })
      bot.act(o)
      modes.push((draw.take()?.label ?? "").split(" ")[1] ?? "")
      // pretend we walked 1.2 m east per decision
      pos = [pos[0] + 1.2, pos[1], world.groundZ(pos[0] + 1.2, pos[1])]
    }
    let flips = 0
    for (let i = 1; i < modes.length; i++) if (modes[i].split(":")[0] !== modes[i - 1].split(":")[0]) flips++
    expect(flips).toBeLessThanOrEqual(2)
  })
})
