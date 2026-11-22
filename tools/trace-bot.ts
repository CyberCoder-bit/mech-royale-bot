/**
 * Tracing wrapper for in-process sim runs: logs our label, HP, position, visible mechs and damage
 * events to stderr every TRACE_EVERY seconds (default 0.5).
 *   bun <sim>/run.ts --mode squad --seeds 1 --seed-start 4 --jobs 1 --bot inproc:$PWD/tools/trace-bot.ts
 */
import { makeBot as real } from "../src/bot.ts"
import { draw, type Hello, type Observation } from "../src/mechfight.ts"
import { loadWorld } from "../src/world/index.ts"

export function makeBot(hello: Hello, profile?: string) {
  const b = real(hello, profile as any)
  const world = loadWorld(hello.map.dir, hello.map.files)
  const every = Number(process.env.TRACE_EVERY ?? 0.5)
  let next = 0
  return {
    name: b.name,
    act(o: Observation) {
      const a = b.act(o)
      const d = draw.take()
      if (o.t >= next) {
        next = o.t + every - 1e-9
        const me = o.self
        const near = o.mechs
          .filter((q) => q.kind === "mech")
          .map((q) => `${q.id}@${Math.hypot(q.pos[0] - me.pos[0], q.pos[1] - me.pos[1]).toFixed(0)}m/${Math.round(q.hp ?? 0)}${q.charging ? "C" : ""}`)
          .join(" ")
        // LOS diagnostics for attackers that hit us this tick
        for (const e of o.events ?? []) {
          if (e.type !== "damaged" || e.by === null || e.by === undefined) continue
          const m = o.mechs.find((q) => q.id === e.by)
          if (!m) {
            console.error(`   hit by unlisted ${e.by} (${e.weapon}) bearing ${e.bearing?.toFixed(2)}`)
            continue
          }
          const mz = m.pos[2] + 7, me2 = o.self.pos
          const a = world.shotClear([m.pos[0], m.pos[1], mz], [me2[0], me2[1], me2[2] + 4.5])
          const a2 = world.shotClear([m.pos[0], m.pos[1], mz], [me2[0], me2[1], me2[2] + 8.3])
          const bk = world.shotClear([me2[0], me2[1], me2[2] + 7], [m.pos[0], m.pos[1], m.pos[2] + 4.5])
          console.error(`   hit by ${e.by} (${e.weapon}) LOS its muzzle->our center ${a} ->top ${a2}; ours->its center ${bk}; its z ${m.pos[2].toFixed(1)} ours ${me2[2].toFixed(1)}`)
        }
        const ev = (o.events ?? [])
          .filter((e) => e.type === "damaged" || e.type === "kill" || e.type === "hit")
          .map((e: any) => (e.type === "kill" ? "KILL" : e.type === "hit" ? `+${Math.round(e.amount)}` : `-${Math.round(e.amount)}${e.weapon[0]}${e.rear ? "R" : ""}`))
          .join(",")
        console.error(
          `t=${o.t.toFixed(1)} hp=${Math.round(me.hp)} e=${Math.round(me.energy)} pos=(${me.pos.map((v) => v.toFixed(0)).join(",")}) ${me.weapons.map((w) => w?.kind ?? "-").join("/")} | ${d?.label ?? ""} | ${near} ${ev}`,
        )
      }
      return a
    },
  }
}
export default makeBot
