/**
 * Sim-only wrapper around a bot bundle (MR_WRAP_BOT=path) that logs stuck intervals to stderr:
 * commanded to move (|move| >= 0.5) but < 1 m of progress over 1 s. Each line has the position, our
 * size (cubes -> height), the zone state and the distance to the nearest low-ceiling nav node.
 *   MR_WRAP_BOT=runs/bots/x.js bun sim/run.ts --bot inproc:tools/stuck-wrap.ts ...
 */
import { resolve, join } from "node:path"
import { loadWorld, navFor } from "../src/world/index.ts"

const mod = await import(resolve(process.env.MR_WRAP_BOT ?? "runs/bots/v3es.js"))
export const draw = mod.draw

let low: { x: number; y: number; ceil: number }[] | null = null
function lowNodes(dir: string, files: string[]) {
  if (low) return low
  low = []
  try {
    const w = loadWorld(dir, files)
    const nav = navFor(w)
    for (let v = 0; v < nav.N; v++) if (nav.st[v] === 1 && nav.ceil[v] < 20) low.push({ x: nav.nodeX(v), y: nav.nodeY(v), ceil: nav.ceil[v] })
  } catch {}
  return low
}

export function makeBot(hello: any, profile?: string) {
  const bot = profile !== undefined ? mod.makeBot(hello, profile) : mod.makeBot(hello)
  const L = lowNodes(hello.map.dir, hello.map.files)
  const spc = Number(hello.config.cubes?.size_per_cube ?? 0.05)
  let refT = -1, refX = 0, refY = 0
  const tag = Number(hello.seed) % 100000
  return {
    name: bot.name,
    act(obs: any) {
      const a = bot.act(obs)
      const P = obs.self.pos, t = obs.t
      const mv = a.move ? Math.hypot(a.move[0], a.move[1]) : 0
      if (mv >= 0.5) {
        if (refT < 0) (refT = t), (refX = P[0]), (refY = P[1])
        else if (t - refT >= 1) {
          if (Math.hypot(P[0] - refX, P[1] - refY) < 1) {
            let bd = Infinity, bc = 0
            for (const n of L) {
              const d = Math.hypot(n.x - P[0], n.y - P[1])
              if (d < bd) (bd = d), (bc = n.ceil)
            }
            const H = 9 * (1 + spc * obs.self.cubes)
            console.error(`[stuck ${tag}] t=${t.toFixed(1)} x=${P[0].toFixed(0)} y=${P[1].toFixed(0)} z=${P[2].toFixed(1)} cubes=${obs.self.cubes} H=${H.toFixed(1)} inzone=${obs.self.in_zone ? 1 : 0} hp=${obs.self.hp | 0} lowd=${bd.toFixed(1)} lowceil=${bc.toFixed(1)}`)
          }
          ;(refT = t), (refX = P[0]), (refY = P[1])
        }
      } else refT = -1
      return a
    },
  }
}
