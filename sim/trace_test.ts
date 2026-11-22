/** Trace who damages the test bot in squad mode (hunter or not), and what the test bot hits.
 *   bun sim/trace_test.ts <seed> [botpath[@profile]] [squad k=v,..] [house k=v,..]
 */
import { defaultConfig, MAP_DIR } from "./config.ts"
import { loadWorld } from "./world.ts"
import { Match } from "./match.ts"
import { HouseAgent, SquadController } from "./house.ts"
import { InprocAgent } from "./agents.ts"
import { hashSeed } from "./rng.ts"

const seed = parseInt(process.argv[2] ?? "1")
const bp = process.argv[3] ?? "src/bot.ts"
const kv = (s?: string) => Object.fromEntries((s ?? "").split(",").filter((x) => x.includes("=")).map((x) => [x.split("=")[0], parseFloat(x.split("=")[1])]))
const sq = kv(process.argv[4])
const ho = kv(process.argv[5])
const [path, profile] = bp.split("@")
const cfg = defaultConfig()
const w = loadWorld(MAP_DIR)
const names = ["test", ...Array(4).fill("house:easy"), ...Array(4).fill("house:medium"), ...Array(4).fill("house:hard"), ...Array(3).fill("house:expert")]
const teams = names.map((_, i) => (i > 0 ? 0 : -1))
const m = new Match({ seed, config: cfg, world: w, names, teams, sharedVision: true })
const squad = new SquadController(0, sq)
squad.attach(m)
const agents: any[] = names.map((n, i) => (i === 0 ? new InprocAgent(path, profile) : new HouseAgent(n.slice(6), squad, teams[i], ho)))
for (let i = 0; i < names.length; i++) {
  await agents[i].init({ type: "hello", protocol: "mechfight/1", slot: i, seed: hashSeed(seed, i), map: { dir: MAP_DIR, files: [] }, config: cfg })
  if (agents[i] instanceof HouseAgent) agents[i].attach(m, m.mechs[i])
}
const dmgBy = new Map<number, number>()
let dealt = 0
const t0 = m.mechs[0]
while (!m.over && t0.alive) {
  m.updateVision()
  m.distributePerception()
  squad.update()
  const alive = m.mechs.filter((x) => x.alive)
  const obs = alive.map((x) => m.observe(x))
  for (const e of t0.events as any[]) {
    if (e.type === "damaged" && e.by !== null) dmgBy.set(e.by, (dmgBy.get(e.by) ?? 0) + e.amount)
    if (e.type === "hit" && e.target < 16) dealt += e.amount
    if (e.type === "kill") console.log(`t=${m.t.toFixed(1)} test killed ${e.target} (${names[e.target]})`)
  }
  m.clearEvents()
  const acts = alive.map((x, k) => agents[x.id].act(obs[k]))
  alive.forEach((x, k) => m.applyAction(x, acts[k], true))
  m.advance()
  if (Math.round(m.t * 10) % 50 === 0) {
    const hs = [...squad.hunters].map((h) => `${h}:${names[h].slice(6)}`).join(" ")
    const d = [...dmgBy.entries()].map(([k, v]) => `${k}:${names[k]?.slice(6)}=${v.toFixed(0)}${squad.hunters.has(k) ? "*" : ""}`).join(" ")
    console.log(`t=${m.t.toFixed(0)} hp=${t0.hp.toFixed(0)} dealt=${dealt.toFixed(0)} hunters=[${hs}] dmgBy={${d}}`)
  }
}
console.log(`test died t=${t0.deathT?.toFixed(1)} place ${t0.place} by ${t0.killedBy} (${names[t0.killedBy ?? 0]}) with ${t0.killedWith}`)
