/** Debug: run one in-process match and print house-bot diagnostics every N seconds.
 *   bun sim/debug_match.ts [seed] [mode] [botspec]
 */
import { defaultConfig, MAP_DIR } from "./config.ts"
import { loadWorld } from "./world.ts"
import { Match } from "./match.ts"
import { HouseAgent, SquadController } from "./house.ts"
import { InprocAgent } from "./agents.ts"
import { hashSeed } from "./rng.ts"

const seed = parseInt(process.argv[2] ?? "1")
const mode = process.argv[3] ?? "squad"
const cfg = defaultConfig()
const w = loadWorld(MAP_DIR)
const t0 = performance.now()
const names = ["inproc:src/bot.ts", ...Array(4).fill("house:easy"), ...Array(4).fill("house:medium"), ...Array(4).fill("house:hard"), ...Array(3).fill("house:expert")]
const teams = names.map((_, i) => (mode === "squad" && i > 0 ? 0 : -1))
const m = new Match({ seed, config: cfg, world: w, names, teams, sharedVision: mode === "squad" })
const squad = new SquadController(0, {})
squad.attach(m)
const agents: any[] = names.map((n, i) => (i === 0 ? new InprocAgent("src/bot.ts") : new HouseAgent(n.slice(6), mode === "squad" ? squad : null, teams[i])))
for (let i = 0; i < names.length; i++) {
  await agents[i].init({ type: "hello", protocol: "mechfight/1", slot: i, seed: hashSeed(seed, i), map: { dir: MAP_DIR, files: [] }, config: cfg })
  if (agents[i] instanceof HouseAgent) agents[i].attach(m, m.mechs[i])
}
console.log(`setup ${(performance.now() - t0).toFixed(0)} ms`)
let nextPrint = 0
let tAct = 0,
  tObs = 0,
  tSim = 0
while (!m.over) {
  const a0 = performance.now()
  m.updateVision()
  m.distributePerception()
  squad.update()
  const alive = m.mechs.filter((x) => x.alive)
  const obs = alive.map((x) => m.observe(x))
  m.clearEvents()
  const a1 = performance.now()
  const acts = alive.map((x, k) => agents[x.id].act(obs[k]))
  const a2 = performance.now()
  alive.forEach((x, k) => m.applyAction(x, acts[k], true))
  m.advance()
  const a3 = performance.now()
  tObs += a1 - a0
  tAct += a2 - a1
  tSim += a3 - a2
  if (m.t >= nextPrint) {
    nextPrint += 20
    const z = m.zoneNow()
    console.log(`t=${m.t.toFixed(1)} alive=${m.aliveCount} zone c=(${z.cx.toFixed(0)},${z.cy.toFixed(0)}) r=${z.r.toFixed(0)} dps=${z.dps}`)
    for (const x of m.mechs) {
      if (!x.alive) continue
      const ag = agents[x.id]
      const dz = Math.hypot(x.x - z.cx, x.y - z.cy)
      console.log(`  ${String(x.id).padStart(2)} ${x.name.padEnd(18)} pos=(${x.x.toFixed(0)},${x.y.toFixed(0)},${x.z.toFixed(1)}) hp=${x.hp.toFixed(0)} dz=${dz.toFixed(0)} mode=${ag.mode ?? "-"} path=${ag.path ? ag.path.length / 2 : "-"} stuck=${x.stats.stuckSeconds.toFixed(0)} w=${x.slots.map((s) => s?.kind ?? "-").join("/")}`)
    }
  }
}
console.log(`end t=${m.t.toFixed(1)} wall ${(performance.now() - t0).toFixed(0)} ms  (obs ${tObs.toFixed(0)} act ${tAct.toFixed(0)} sim ${tSim.toFixed(0)})`)
for (const x of m.mechs) console.log(`  ${x.id} ${x.name} place ${x.place} death ${x.deathT?.toFixed(1)} by ${x.killedBy} with ${x.killedWith} zoneS ${x.stats.zoneSeconds.toFixed(1)} stuck ${x.stats.stuckSeconds.toFixed(1)}`)
