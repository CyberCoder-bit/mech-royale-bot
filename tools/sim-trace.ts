/**
 * Trace one simulated squad match of OUR bot (slot 0) using the simulator agent's sim/ code
 * (pass its directory). Prints our label, HP, position and nearby mechs every `every` seconds.
 *   bun tools/sim-trace.ts <simDir> [seed=1] [botPath=src/bot.ts] [every=1]
 */
import { resolve } from "node:path"

const simDir = resolve(process.argv[2] ?? "sim")
const seed = parseInt(process.argv[3] ?? "1")
const botPath = resolve(process.argv[4] ?? "src/bot.ts")
const every = parseFloat(process.argv[5] ?? "1")
const { defaultConfig, MAP_DIR } = await import(simDir + "/config.ts")
const { loadWorld } = await import(simDir + "/world.ts")
const { Match } = await import(simDir + "/match.ts")
const { HouseAgent, SquadController } = await import(simDir + "/house.ts")
const { hashSeed } = await import(simDir + "/rng.ts")
const { draw } = await import("../src/mechfight.ts")
const mod = await import(botPath)
const makeBot = mod.makeBot ?? mod.default

const cfg = defaultConfig()
const w = loadWorld(MAP_DIR)
const names = ["inproc:bot", ...Array(4).fill("house:easy"), ...Array(4).fill("house:medium"), ...Array(4).fill("house:hard"), ...Array(3).fill("house:expert")]
const teams = names.map((_, i) => (i > 0 ? 0 : -1))
const m = new Match({ seed, config: cfg, world: w, names, teams, sharedVision: true })
const squad = new SquadController(0, {})
squad.attach(m)
const agents: any[] = []
for (let i = 0; i < names.length; i++) {
  const hello = { type: "hello", protocol: "mechfight/1", slot: i, seed: hashSeed(seed, i), map: { dir: MAP_DIR, files: ["v2/world.json", "v2/terrain.i16"] }, config: cfg }
  if (i === 0) agents.push(makeBot(hello))
  else {
    const h = new HouseAgent(names[i].slice(6), squad, teams[i])
    await h.init(hello)
    h.attach(m, m.mechs[i])
    agents.push(h)
  }
}
let next = 0
let maxMs = 0
const times: { ms: number; t: number; label: string }[] = []
while (!m.over) {
  m.updateVision()
  m.distributePerception()
  squad.update()
  const alive = m.mechs.filter((x: any) => x.alive)
  const obs = alive.map((x: any) => m.observe(x))
  m.clearEvents()
  const acts = alive.map((x: any, k: number) => {
    if (x.id !== 0) return agents[x.id].act(obs[k])
    const t0 = performance.now()
    const a = { ...agents[0].act(obs[k]) }
    const ms = performance.now() - t0
    maxMs = Math.max(maxMs, ms)
    const d = draw.take()
    const o = obs[k]
    times.push({ ms, t: o.t, label: d?.label ?? "" })
    if (o.t >= next) {
      next += every
      const me = o.self
      const near = o.mechs.filter((q: any) => q.kind === "mech").map((q: any) => `${q.id}@${Math.hypot(q.pos[0] - me.pos[0], q.pos[1] - me.pos[1]).toFixed(0)}m hp${Math.round(q.hp)}`).join(" ")
      const ev = (o.events ?? []).filter((e: any) => e.type === "damaged" || e.type === "kill").map((e: any) => e.type === "kill" ? "KILL" : `-${Math.round(e.amount)}${e.weapon[0]}${e.rear ? "R" : ""}`).join(",")
      console.log(`t=${o.t.toFixed(1)} hp=${Math.round(me.hp)} e=${Math.round(me.energy)} pos=(${me.pos.map((v: number) => v.toFixed(0)).join(",")}) w=${me.weapons.map((q: any) => q?.kind ?? "-").join("/")} | ${d?.label ?? ""} | ${near} ${ev}`)
    }
    a.tick = o.tick
    return a
  })
  alive.forEach((x: any, k: number) => m.applyAction(x, acts[k], true))
  m.advance()
}
const me = m.mechs[0]
const sorted = [...times].sort((a, b) => a.ms - b.ms)
const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]?.ms.toFixed(2)
console.log(`act ms p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)} (n ${times.length})`)
for (const x of sorted.slice(-6).reverse()) console.log(`  slow ${x.ms.toFixed(1)} ms at t=${x.t.toFixed(1)} ${x.label}`)
console.log(`end t=${m.t.toFixed(1)} place ${me.place} death ${me.deathT?.toFixed(1)} by ${me.killedBy} with ${me.killedWith}; max act ${maxMs.toFixed(1)} ms`)
