/** Squad-mode fight trace for the test bot (sq2): damage taken by weapon / attacker tier / our mode, crossfire share,
 * and a per-second timeline of the hunters near us.
 *   MR_PARAMS='{...}' bun tools/sq2-trace.ts <seed> [botpath] [quiet]
 */
import { defaultConfig, MAP_DIR } from "../sim/config.ts"
import { loadWorld } from "../sim/world.ts"
import { Match } from "../sim/match.ts"
import { HouseAgent, SquadController } from "../sim/house.ts"
import { InprocAgent } from "../sim/agents.ts"
import { hashSeed } from "../sim/rng.ts"

const seed = parseInt(process.argv[2] ?? "1")
const bp = process.argv[3] ?? "src/bot.ts"
const quiet = process.argv[4] === "quiet"
const cfg = defaultConfig()
const w = loadWorld(MAP_DIR)
const names = ["test", ...Array(4).fill("house:easy"), ...Array(4).fill("house:medium"), ...Array(4).fill("house:hard"), ...Array(3).fill("house:expert")]
const teams = names.map((_, i) => (i > 0 ? 0 : -1))
const m = new Match({ seed, config: cfg, world: w, names, teams, sharedVision: true })
const squad = new SquadController(0, {})
squad.attach(m)
const agents: any[] = names.map((n, i) => (i === 0 ? new InprocAgent(bp) : new HouseAgent(n.slice(6), squad, teams[i], {})))
for (let i = 0; i < names.length; i++) {
  await agents[i].init({ type: "hello", protocol: "mechfight/1", slot: i, seed: hashSeed(seed, i), map: { dir: MAP_DIR, files: [] }, config: cfg })
  if (agents[i] instanceof HouseAgent) agents[i].attach(m, m.mechs[i])
}
const T = m.mechs[0]
const tier = (id: number) => (id < 16 ? names[id].slice(6) : "npc")
const byW: Record<string, number> = {}, byTier: Record<string, number> = {}, byMode: Record<string, number> = {}
const timeMode: Record<string, number> = {}
let xfireDmg = 0, soloDmg = 0, total = 0, hitsOut = 0, rearOut = 0, hitsOutP = 0, rearOutP = 0
const recent: { t: number; by: number }[] = []
let next = 0
let losT = 0, tgtT = 0, shots = 0, lastAmmo = -1, lasers = 0, wasCharging = false, losShots = 0
const dbg = () => (agents[0].bot as any)?.dbg ?? { mode: "?", target: -1 }
while (!m.over && T.alive) {
  m.updateVision()
  m.distributePerception()
  squad.update()
  const alive = m.mechs.filter((x) => x.alive)
  const obs = alive.map((x) => m.observe(x))
  const mode = dbg().mode
  for (const e of T.events as any[]) {
    if (e.type === "damaged" && e.weapon !== "zone") {
      const by = e.by ?? -1
      byW[e.weapon] = (byW[e.weapon] ?? 0) + e.amount
      byTier[tier(by)] = (byTier[tier(by)] ?? 0) + e.amount
      byMode[mode] = (byMode[mode] ?? 0) + e.amount
      total += e.amount
      recent.push({ t: m.t, by })
      while (recent.length && recent[0].t < m.t - 3) recent.shift()
      const ids = new Set(recent.filter((r) => r.by < 16).map((r) => r.by))
      if (ids.size >= 2) xfireDmg += e.amount
      else soloDmg += e.amount
      if (!quiet) console.log(`  t=${m.t.toFixed(2)} dmg ${e.amount.toFixed(0)} ${e.weapon}${e.rear ? " REAR" : ""} by ${by}:${tier(by)} mode=${mode} hp=${T.hp.toFixed(0)}`)
    }
    if (e.type === "hit" && e.target < 16) {
      hitsOut++
      if (e.rear) rearOut++
      if (!squad.hunters.has(e.target)) (hitsOutP++, e.rear && rearOutP++)
    }
    if (e.type === "kill" && !quiet) console.log(`t=${m.t.toFixed(1)} KILL ${e.target}:${tier(e.target)}`)
  }
  m.clearEvents()
  timeMode[mode] = (timeMode[mode] ?? 0) + 0.1
  {
    const d0 = dbg()
    const g = T.slots.find((w: any) => w && w.kind === "gun") as any
    const L = T.slots.find((w: any) => w && w.kind === "laser") as any
    if (d0.target >= 0) tgtT += 0.1
    if (d0.target >= 0 && d0.los) losT += 0.1
    if (L) {
      if (wasCharging && !L.charging) lasers++
      wasCharging = L.charging
    }
    void g
  }
  const acts = alive.map((x, k) => agents[x.id].act(obs[k]))
  alive.forEach((x, k) => m.applyAction(x, acts[k], true))
  {
    const g0 = T.slots.find((w: any) => w && w.kind === "gun") as any
    const before = g0 ? g0.ammo : 0
    m.advance()
    const g1 = T.slots.find((w: any) => w && w.kind === "gun") as any
    if (g1 && g0 === g1) {
      const fired = before - g1.ammo > 0 ? before - g1.ammo : (g1.ammo === g1.ammo && before === 1 && g1.reload > 0 ? 1 : 0)
      shots += fired
      if (dbg().los) losShots += fired
    }
  }
  if (m.t >= next && !quiet) {
    next += 1
    const near = m.mechs
      .filter((x) => x.alive && x.id !== 0 && Math.hypot(x.x - T.x, x.y - T.y) < 220)
      .map((x) => {
        const d = Math.hypot(x.x - T.x, x.y - T.y)
        const los = w.los(x.x, x.y, x.z + 7, T.x, T.y, T.z + 4.5, false)
        return `${x.id}:${tier(x.id)}${squad.hunters.has(x.id) ? "*" : ""} d${d.toFixed(0)}${los ? "+" : "-"} hp${x.hp.toFixed(0)} ${x.slots.map((s) => s?.kind[0] ?? "-").join("")}${x.slots.some((s) => s && s.kind === "laser" && s.charging) ? "C" : ""}`
      })
    const d = dbg()
    console.log(`t=${m.t.toFixed(0)} hp=${T.hp.toFixed(0)}/${m.maxHp(T).toFixed(0)} e=${T.energy.toFixed(0)} ${d.mode} tgt=${d.target} w=${T.slots.map((s) => s?.kind ?? "-").join("/")} | ${near.join(" | ")}`)
  }
}
const f = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(" ")
console.log(`seed ${seed} died t=${T.deathT?.toFixed(1)} place ${T.place} kills ${T.stats.kills} by ${T.killedBy}:${tier(T.killedBy ?? 0)} with ${T.killedWith}`)
console.log(`  dmg ${total.toFixed(0)} | by weapon ${f(byW)} | by tier ${f(byTier)} | crossfire ${((100 * xfireDmg) / Math.max(1, total)).toFixed(0)}%`)
console.log(`  target time ${tgtT.toFixed(0)} s, with LOS ${losT.toFixed(0)} s | gun shots ${shots} (${(shots / Math.max(1, losT)).toFixed(2)}/s of LOS time, max ~2.27) | laser shots ${lasers} (${(lasers / Math.max(1, losT)).toFixed(2)}/s, max 0.42)`)
console.log(`  our hits on mechs ${hitsOut} rear ${rearOut} | on non-hunters ${hitsOutP} rear ${rearOutP}`)
console.log(`  by our mode ${f(byMode)} | time in mode ${f(timeMode)}`)
