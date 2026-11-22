/** Dump observations from one in-process match (for schema checks):
 *   bun sim/dump_obs.ts <out.jsonl> [seed] [mode] [every]
 *   python3 sim/schema_check.py <out.jsonl>
 */
import { writeFileSync } from "node:fs"
import { defaultConfig, MAP_DIR } from "./config.ts"
import { loadWorld } from "./world.ts"
import { Match } from "./match.ts"
import { HouseAgent, SquadController } from "./house.ts"
import { hashSeed } from "./rng.ts"

const out = process.argv[2] ?? "runs/obs_dump.jsonl"
const seed = parseInt(process.argv[3] ?? "3")
const mode = process.argv[4] ?? "ffa"
const every = parseInt(process.argv[5] ?? "7")
const cfg = defaultConfig()
const w = loadWorld(MAP_DIR)
const archs = ["expert", "brawler", "sniper", "thirdparty", "farmer", "hard", "medium", "easy"]
const names = Array.from({ length: 16 }, (_, i) => "house:" + archs[i % archs.length])
const teams = names.map((_, i) => (mode === "squad" && i > 0 ? 0 : -1))
const m = new Match({ seed, config: cfg, world: w, names, teams, sharedVision: mode === "squad" })
const squad = mode === "squad" ? new SquadController(0, {}) : null
squad?.attach(m)
const agents = names.map((n, i) => new HouseAgent(n.slice(6), squad, teams[i]))
for (let i = 0; i < 16; i++) {
  await agents[i].init({ type: "hello", protocol: "mechfight/1", slot: i, seed: hashSeed(seed, i), map: { dir: MAP_DIR, files: [] }, config: cfg })
  agents[i].attach(m, m.mechs[i])
}
const lines: string[] = []
let k = 0
const evTypes = new Set<string>()
while (!m.over) {
  m.updateVision()
  m.distributePerception()
  squad?.update()
  const alive = m.mechs.filter((x) => x.alive)
  const obs = alive.map((x) => m.observe(x))
  for (const o of obs) {
    for (const e of o.events) evTypes.add(e.type)
    if (k++ % every === 0 || o.events.length > 0 || o.offer) lines.push(JSON.stringify(o))
  }
  m.clearEvents()
  alive.forEach((x, i) => m.applyAction(x, agents[x.id].act(obs[i]), true))
  m.advance()
}
writeFileSync(out, lines.join("\n") + "\n")
console.log(`wrote ${lines.length} observations to ${out}; match ended t=${m.t.toFixed(1)}; event types: ${[...evTypes].join(",")}`)
console.log(JSON.stringify(m.result().mechs.map((r) => [r.name, r.place, r.kills, r.killed_with])))
