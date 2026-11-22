/** Roof-mode trace: our height over ground, mode and HP over time, plus what the hunters do near us
 * (distance, height over ground: do they climb?) and who damages us.
 *   MR_PARAMS='{"roofMode":true}' bun sim/roof_trace.ts <seed> [squad k=v,..] [house k=v,..] [every_s]
 */
import { defaultConfig, MAP_DIR } from "./config.ts"
import { loadWorld } from "./world.ts"
import { Match } from "./match.ts"
import { HouseAgent, SquadController } from "./house.ts"
import { InprocAgent } from "./agents.ts"
import { hashSeed } from "./rng.ts"

const seed = parseInt(process.argv[2] ?? "1")
const kv = (s?: string) => Object.fromEntries((s ?? "").split(",").filter((x) => x.includes("=")).map((x) => [x.split("=")[0], parseFloat(x.split("=")[1])]))
const sq = kv(process.argv[3])
const ho = kv(process.argv[4])
const every = parseFloat(process.argv[5] ?? "2")
const quiet = every <= 0
const cfg = defaultConfig()
const w = loadWorld(MAP_DIR)
const names = ["test", ...Array(4).fill("house:easy"), ...Array(4).fill("house:medium"), ...Array(4).fill("house:hard"), ...Array(3).fill("house:expert")]
const teams = names.map((_, i) => (i > 0 ? 0 : -1))
const m = new Match({ seed, config: cfg, world: w, names, teams, sharedVision: true })
const squad = new SquadController(0, sq)
squad.attach(m)
const agents: any[] = names.map((n, i) => (i === 0 ? new InprocAgent("src/bot.ts") : new HouseAgent(n.slice(6), squad, teams[i], ho)))
for (let i = 0; i < names.length; i++) {
  await agents[i].init({ type: "hello", protocol: "mechfight/1", slot: i, seed: hashSeed(seed, i), map: { dir: MAP_DIR, files: [] }, config: cfg })
  if (agents[i] instanceof HouseAgent) agents[i].attach(m, m.mechs[i])
}
const me = m.mechs[0]
let next = 0
let dmgWin: string[] = []
let maxClimbNear = 0
let dmgOn = 0, dmgOff = 0, climbersOnRoof = 0
const onRoofIds = new Set<number>()
while (!m.over && me.alive) {
  m.updateVision()
  m.distributePerception()
  squad.update()
  const alive = m.mechs.filter((x) => x.alive)
  const obs = alive.map((x) => m.observe(x))
  for (const e of me.events as any[]) {
    if (e.type === "damaged") {
      dmgWin.push(`${e.by ?? "z"}:${e.weapon}${e.rear ? "R" : ""}${Math.round(e.amount)}`)
      const st = ((agents[0] as InprocAgent).bot as any)?.dbg?.roof
      if (st?.on) dmgOn += e.amount
      else dmgOff += e.amount
    }
    if (e.type === "kill" && !quiet) console.log(`  t=${m.t.toFixed(1)} KILL ${e.target} (${names[e.target]})`)
  }
  m.clearEvents()
  const acts = alive.map((x, k) => agents[x.id].act(obs[k]))
  alive.forEach((x, k) => m.applyAction(x, acts[k], true))
  m.advance()
  for (const x of m.mechs) {
    if (!x.alive || x.id === 0) continue
    if (Math.hypot(x.x - me.x, x.y - me.y) < 40 && x.grounded) {
      maxClimbNear = Math.max(maxClimbNear, x.z - w.ground(x.x, x.y))
      if (me.grounded && me.z - w.ground(me.x, me.y) > 8 && Math.abs(x.z - me.z) < 2 && !onRoofIds.has(x.id)) (onRoofIds.add(x.id), climbersOnRoof++)
    }
  }
  if (!quiet && m.t >= next) {
    next += every
    const bot = (agents[0] as InprocAgent).bot as any
    const dbg = bot?.dbg ?? {}
    const hz = me.z - w.ground(me.x, me.y)
    const hs = [...squad.hunters].map((h) => {
      const x = m.mechs[h]
      return `${h}${names[h].slice(6, 7)}@${Math.hypot(x.x - me.x, x.y - me.y).toFixed(0)}m/h${(x.z - w.ground(x.x, x.y)).toFixed(0)}${(agents[h] as any).mode?.slice(0, 3) ?? ""}`
    }).join(" ")
    console.log(`t=${m.t.toFixed(0)} hp=${me.hp.toFixed(0)} pos=(${me.x.toFixed(0)},${me.y.toFixed(0)}) h=${hz.toFixed(1)}${me.grounded ? "" : "^"} e=${me.energy.toFixed(0)} ${dbg.mode} w=${dbg.weapons} tgt=${dbg.target} hunters=[${hs}] dmg=[${dmgWin.join(" ")}]`)
    dmgWin = []
  }
}
const bot = (agents[0] as InprocAgent).bot as any
const st = bot?.dbg?.roof ?? {}
const kl = me.killedBy !== null && me.killedBy !== undefined ? m.mechs[me.killedBy] : null
const klH = kl ? (kl.z - w.ground(kl.x, kl.y)).toFixed(0) : "-"
const myH = (me.z - w.ground(me.x, me.y)).toFixed(0)
console.log(`seed ${seed} died ${me.deathT?.toFixed(1) ?? "alive"} pts ${16 - (me.place ?? 16)} by ${names[me.killedBy ?? 0]}/${me.killedWith} myH ${myH} killerH ${klH} | roof first ${st.firstOnRoof?.toFixed?.(0)} onS ${st.onRoofS?.toFixed?.(0)} chosen ${st.roofsChosen} | dmg on ${dmgOn.toFixed(0)} off ${dmgOff.toFixed(0)} | house max h within 40 m ${maxClimbNear.toFixed(1)}, climbers on our roof ${climbersOnRoof} | refuges ${st.refuges ?? 0} healed ${st.healed ?? 0} idleS ${(st.idleS ?? 0).toFixed(0)} deathMode ${bot?.dbg?.mode}`)
