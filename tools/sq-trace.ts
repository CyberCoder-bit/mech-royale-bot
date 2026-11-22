/** One squad match with a per-second timeline of the test bot (label, hp, hunters, damage by source).
 *   bun tools/sq-trace.ts <seed> [botpath] [squad k=v,..]
 */
import { defaultConfig, MAP_DIR } from "../sim/config.ts"
import { loadWorld } from "../sim/world.ts"
import { Match } from "../sim/match.ts"
import { HouseAgent, SquadController } from "../sim/house.ts"
import { InprocAgent } from "../sim/agents.ts"
import { hashSeed } from "../sim/rng.ts"
import { resolve } from "node:path"

const seed = parseInt(process.argv[2] ?? "1")
const bp = resolve(process.argv[3] ?? "src/bot.ts")
const kv = (s?: string) => Object.fromEntries((s ?? "").split(",").filter((x) => x.includes("=")).map((x) => [x.split("=")[0], parseFloat(x.split("=")[1])]))
const sq = kv(process.argv[4])
const cfg = defaultConfig()
const w = loadWorld(MAP_DIR)
const names = ["test", ...Array(4).fill("house:easy"), ...Array(4).fill("house:medium"), ...Array(4).fill("house:hard"), ...Array(3).fill("house:expert")]
const teams = names.map((_, i) => (i > 0 ? 0 : -1))
const m = new Match({ seed, config: cfg, world: w, names, teams, sharedVision: true })
const squad = new SquadController(0, sq)
squad.attach(m)
const agents: any[] = names.map((n, i) => (i === 0 ? new InprocAgent(bp) : new HouseAgent(n.slice(6), squad, teams[i], {})))
for (let i = 0; i < names.length; i++) {
  await agents[i].init({ type: "hello", protocol: "mechfight/1", slot: i, seed: hashSeed(seed, i), map: { dir: MAP_DIR, files: [] }, config: cfg })
  if (agents[i] instanceof HouseAgent) agents[i].attach(m, m.mechs[i])
}
const t0 = m.mechs[0]
let dmgWin = new Map<string, number>()
let dealtWin = 0
let lastLabel = ""
let nextPrint = 1
const quiet = process.env.QUIET === "1"
const stat = { unseenDmg: 0, seenDmg: 0, multiDmg: 0, soloDmg: 0, hits: 0 }
const byW: Record<string, number> = {}
const recentAtk = new Map<number, number>()
let lastListed = new Set<number>()
while (!m.over && t0.alive) {
  m.updateVision()
  m.distributePerception()
  squad.update()
  const alive = m.mechs.filter((x) => x.alive)
  const obs = alive.map((x) => m.observe(x))
  for (const e of t0.events as any[]) {
    if (e.type === "damaged" && e.by !== null) {
      recentAtk.set(e.by, m.t)
      byW[e.weapon] = (byW[e.weapon] ?? 0) + e.amount
      if (lastListed.has(e.by)) stat.seenDmg += e.amount
      else stat.unseenDmg += e.amount
      let n = 0
      for (const [, tt] of recentAtk) if (m.t - tt < 4) n++
      if (n >= 2) stat.multiDmg += e.amount
      else stat.soloDmg += e.amount
    }
    if (e.type === "damaged") {
      const k = e.by === null ? "zone" : `${e.by}${names[e.by]?.slice(6, 7) ?? "?"}${squad.hunters.has(e.by) ? "*" : ""}${e.rear ? "R" : ""}:${e.weapon[0]}`
      dmgWin.set(k, (dmgWin.get(k) ?? 0) + e.amount)
    }
    if (e.type === "hit" && e.target < 16) dealtWin += e.amount
    if (e.type === "kill" && !quiet) console.log(`   t=${m.t.toFixed(1)} KILL ${e.target} (${names[e.target]})`)
  }
  m.clearEvents()
  lastListed = new Set((obs[alive.findIndex((x) => x.id === 0)]?.mechs ?? []).map((mm: any) => mm.id))
  const acts = alive.map((x, k) => {
    const a = agents[x.id].act(obs[k])
    if (x.id === 0) {
      const g = agents[0].bot?.dbg
      if (g) lastLabel = `${g.mode} ${g.weapons} t${g.target}${g.los ? "+" : "-"} L:${g.listed}`
      const win = (process.env.WIN ?? "").split(",").map(Number)
      if (g && win.length === 2 && m.t >= win[0] && m.t <= win[1]) console.log(`  ${m.t.toFixed(2)} ${lastLabel} | ${g.info} aim=${obs[k].self.aim.map((v: number) => v.toFixed(3))} cmd=${a.aim?.map((v: number) => v.toFixed(3))} fire=${a.fire}`)
    }
    return a
  })
  alive.forEach((x, k) => m.applyAction(x, acts[k], true))
  m.advance()
  if (m.t >= nextPrint) {
    nextPrint += 2
    const hs = [...squad.hunters].map((h) => `${h}${names[h].slice(6, 7)}:${Math.round(Math.hypot(m.mechs[h].x - t0.x, m.mechs[h].y - t0.y))}`).join(" ")
    const d = [...dmgWin.entries()].map(([k, v]) => `${k}=${v.toFixed(0)}`).join(" ")
    if (!quiet) console.log(`t=${m.t.toFixed(0).padStart(3)} hp=${t0.hp.toFixed(0).padStart(4)} [${lastLabel}] dealt=${dealtWin.toFixed(0)} hunters=[${hs}] took={${d}}`)
    dmgWin = new Map()
    dealtWin = 0
  }
}
console.log(`STAT seed ${seed} unseen ${stat.unseenDmg.toFixed(0)} seen ${stat.seenDmg.toFixed(0)} multi ${stat.multiDmg.toFixed(0)} solo ${stat.soloDmg.toFixed(0)} kills ${t0.stats.kills} byW ${JSON.stringify(byW)}`)
console.log(`test died t=${t0.deathT?.toFixed(1)} place ${t0.place} by ${t0.killedBy} (${names[t0.killedBy ?? 0]}) with ${t0.killedWith}`)
