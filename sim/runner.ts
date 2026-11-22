/** Run one match: agents + engine + (optional) replay. */
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { gzipSync } from "node:zlib"
import type { BotAction, Config, Hello } from "../src/mechfight.ts"
import { defaultConfig, MAP_DIR } from "./config.ts"
import { loadWorld } from "./world.ts"
import { Match, type Mech } from "./match.ts"
import { ProcAgent, InprocAgent, type Agent } from "./agents.ts"
import { Rng, hashSeed } from "./rng.ts"
import { HouseAgent, SquadController, type SquadParams, loadArchetypes } from "./house.ts"

export type AgentSpec = { type: "proc"; cmd: string } | { type: "inproc"; path: string; profile?: string } | { type: "house"; arch: string }

export interface MatchSpec {
  seed: number
  mode: "squad" | "ffa"
  test: AgentSpec
  field: AgentSpec[]
  replay?: string | null
  squad?: Partial<SquadParams>
  budgetMs?: number
  stderrDir?: string | null
  /** fixed slot for the test bot (default: random per seed) */
  testSlot?: number
  config?: Config
}

export interface MechResult {
  slot: number
  name: string
  spec: string
  place: number
  points: number
  deathT: number | null
  kills: number
  cause: string | null
  killedBy: string | null
  damageDealt: number
  damageTaken: number
  zoneSeconds: number
  stuckSeconds: number
  idleSeconds: number
  rearHits: number
  cubesMax: number
  upgrades: string[]
  dropsTaken: number
}
export interface MatchResult {
  seed: number
  mode: string
  ticks: number
  t: number
  wallMs: number
  test: MechResult & { late: number; missed: number; readyMs: number; ansP50: number; ansP99: number; ansMax: number; crashed: boolean; badLines: number }
  field: MechResult[]
  replay?: string
}

export function specName(s: AgentSpec): string {
  if (s.type === "proc") return s.cmd
  if (s.type === "inproc") return `inproc:${s.path}${s.profile ? "@" + s.profile : ""}`
  return `house:${s.arch}`
}

function mkAgent(s: AgentSpec, stderrPath: string | null, squad: SquadController | null, team: number): Agent {
  if (s.type === "proc") return new ProcAgent(s.cmd, undefined, stderrPath)
  if (s.type === "inproc") return new InprocAgent(s.path, s.profile)
  return new HouseAgent(s.arch, squad, team)
}

const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0)

export async function runMatch(spec: MatchSpec): Promise<MatchResult> {
  const wall0 = performance.now()
  const cfg = spec.config ?? defaultConfig()
  const world = loadWorld(MAP_DIR)
  const rng = new Rng(hashSeed(spec.seed, 77))
  const N = cfg.match.mechs ?? 16
  const testSlot = spec.testSlot ?? rng.int(N)
  const others = [...spec.field]
  while (others.length < N - 1) others.push({ type: "house", arch: "expert" })
  others.length = N - 1
  rng.shuffle(others)
  const specs: AgentSpec[] = []
  for (let i = 0, k = 0; i < N; i++) specs.push(i === testSlot ? spec.test : others[k++])
  const teams = specs.map((s, i) => (spec.mode === "squad" && i !== testSlot ? 0 : -1))
  const squad = spec.mode === "squad" ? new SquadController(testSlot, spec.squad ?? {}) : null
  const archetypes = loadArchetypes()
  void archetypes
  const agents = specs.map((s, i) => mkAgent(s, spec.stderrDir && s.type === "proc" ? `${spec.stderrDir}/seed${spec.seed}_slot${i}.log` : null, squad, teams[i]))
  const match = new Match({ seed: spec.seed, config: cfg, world, names: specs.map(specName), teams, sharedVision: spec.mode === "squad", record: !!spec.replay })
  // hellos
  const ok = await Promise.all(
    agents.map((a, i) => {
      const hello: Hello = { type: "hello", protocol: "mechfight/1", slot: i, seed: hashSeed(spec.seed, i, 991), map: { dir: MAP_DIR, files: ["v2/world.json", "v2/terrain.i16"] }, config: cfg }
      return a.init(JSON.parse(JSON.stringify(hello)))
    }),
  )
  for (let i = 0; i < N; i++) {
    match.mechs[i].name = agents[i].name
    if (!ok[i]) match.mechs[i].stats.crashed = true
    if (agents[i] instanceof HouseAgent) (agents[i] as HouseAgent).attach(match, match.mechs[i])
  }
  squad?.attach(match)
  const budget = spec.budgetMs ?? cfg.bot.tick_budget_ms ?? 50
  const ended = new Set<number>()
  match.onDeath = (m: Mech) => {
    if (ended.has(m.id)) return
    ended.add(m.id)
    agents[m.id].end(m.place, m.stats.kills)
  }
  const ansMs: number[] = []
  let late = 0,
    missed = 0
  const procs = agents.filter((a) => a.kind === "proc") as ProcAgent[]
  while (!match.over) {
    match.updateVision()
    match.distributePerception()
    squad?.update()
    const alive = match.mechs.filter((m) => m.alive)
    const obsMap = new Map<number, any>()
    for (const m of alive) obsMap.set(m.id, match.observe(m))
    match.clearEvents()
    // subprocess bots first: send, then compute in-process bots while they think
    for (const m of alive) {
      const a = agents[m.id]
      if (a.kind === "proc" && !(a as ProcAgent).exited && ok[m.id]) (a as ProcAgent).send(obsMap.get(m.id))
    }
    const acts = new Map<number, { a: BotAction | null; valid: boolean }>()
    for (const m of alive) {
      const a = agents[m.id]
      if (a.kind !== "proc") acts.set(m.id, { a: ok[m.id] ? a.act!(obsMap.get(m.id)) : null, valid: ok[m.id] })
    }
    for (const m of alive) {
      const a = agents[m.id]
      if (a.kind !== "proc") continue
      const pa = a as ProcAgent
      if (pa.exited || !ok[m.id]) {
        acts.set(m.id, { a: null, valid: false })
        if (pa.exited) m.stats.crashed = true
        continue
      }
      const r = await pa.recv(obsMap.get(m.id).tick, pa.sentAt + budget)
      if (m.id === testSlot) {
        if (r.action) ansMs.push(r.ms)
        else {
          late++
        }
      }
      acts.set(m.id, { a: r.action, valid: !!r.action })
    }
    for (const m of alive) {
      const x = acts.get(m.id)!
      if (!x.valid) {
        if (m.id === testSlot) missed++
      }
      match.applyAction(m, x.a, x.valid)
    }
    match.advance()
  }
  for (const m of match.mechs) if (!ended.has(m.id)) agents[m.id].end(m.place, m.stats.kills)
  for (const p of procs) setTimeout(() => p.kill(), 2500).unref?.()
  ansMs.sort((a, b) => a - b)
  const res = match.result()
  const mk = (m: Mech): MechResult => ({
    slot: m.id,
    name: m.name,
    spec: specName(specs[m.id]),
    place: m.place,
    points: N - m.place,
    deathT: m.deathT === null ? null : Math.round(m.deathT * 100) / 100,
    kills: m.stats.kills,
    cause: m.alive ? null : m.killedWith,
    killedBy: m.killedBy !== null ? specName(specs[m.killedBy]) : null,
    damageDealt: Math.round(m.stats.damageDealt),
    damageTaken: Math.round(m.stats.damageTaken),
    zoneSeconds: Math.round(m.stats.zoneSeconds * 10) / 10,
    stuckSeconds: Math.round(m.stats.stuckSeconds * 10) / 10,
    idleSeconds: Math.round(m.stats.idleSeconds * 10) / 10,
    rearHits: m.stats.rearHitsTaken,
    cubesMax: m.stats.cubesMax,
    upgrades: m.upList,
    dropsTaken: m.stats.dropsTaken,
  })
  const tm = match.mechs[testSlot]
  const ta = agents[testSlot]
  const out: MatchResult = {
    seed: spec.seed,
    mode: spec.mode,
    ticks: match.tick,
    t: Math.round(match.t * 100) / 100,
    wallMs: Math.round(performance.now() - wall0),
    test: { ...mk(tm), late, missed, readyMs: Math.round(ta.readyMs ?? 0), ansP50: pct(ansMs, 0.5), ansP99: pct(ansMs, 0.99), ansMax: ansMs.length ? ansMs[ansMs.length - 1] : 0, crashed: tm.stats.crashed || !!ta.crashed, badLines: ta.badLines ?? 0 },
    field: match.mechs.filter((m) => m.id !== testSlot).map(mk),
  }
  if (spec.replay) {
    const hdr = match.frames[0]
    hdr.bots = specs.map(specName)
    hdr.mechs.forEach((x: any, i: number) => (x.name = match.mechs[i].name.slice(0, 32)))
    hdr.drops = match.drops.map((d) => ({ id: d.id, pos: [d.x, d.y, d.z].map((v) => Math.round(v * 100) / 100), radius: cfg.drops?.radius ?? 8, call_t: d.callT, land_t: d.landT }))
    const body = match.frames.map((f) => JSON.stringify(f)).join("\n") + "\n" + JSON.stringify(res) + "\n"
    mkdirSync(dirname(spec.replay), { recursive: true })
    writeFileSync(spec.replay, gzipSync(body))
    out.replay = spec.replay
  }
  return out
}
