#!/usr/bin/env bun
/**
 * Summarize a `mechreplay/1` replay (public replays and our simulator's replays).
 *
 *   bun tools/replay-summary.ts <file.jsonl.gz | file.jsonl | url> [--mech <id>] [--json] [--map <dir>] [--archetypes]
 *
 * Text mode prints one block per mech, then (with --archetypes, or always in --json) per-archetype aggregates
 * and behavior estimates (aim noise fit, lead fraction, engagement ranges, target selection, retreat curve, TTK).
 * --map points at the kit arena dir (default: <repo>/kit/arena) for height-above-terrain stats; skipped if missing.
 *
 * Conventions (from the replay header): frame `t` is the TICK; one frame every `frame_every` ticks; events in a
 * frame happened in the ticks since the previous frame. Mechs disappear from `m` once dead.
 * Ids: mechs 0-15, NPCs 100+, crates 1000+, cubes 5000+, pickups 8000+, drops 20000+.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

type Row = number[]
type Ev = Record<string, any> & { t: number; e: string }
interface Frame { t: number; m: Row[]; n?: Row[]; p?: Row[]; z?: number[]; d?: Row[]; ev?: Ev[] }

// ---------------------------------------------------------------- helpers
const args = process.argv.slice(2)
const flag = (k: string) => args.includes(k)
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const src = args.find((a, i) => !a.startsWith("--") && !["--mech", "--map"].includes(args[i - 1] ?? ""))
if (!src) {
  console.error("usage: bun tools/replay-summary.ts <file.jsonl.gz|file.jsonl|url> [--mech <id>] [--json] [--map <dir>] [--archetypes]")
  process.exit(2)
}
const wrap = (a: number) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI }
const DEG = 180 / Math.PI
const hyp = (dx: number, dy: number) => Math.hypot(dx, dy)
function q(arr: number[], p: number): number | null {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b), x = (s.length - 1) * p, i = Math.floor(x)
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (x - i) : s[i]
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const r1 = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d)
const dist3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const isMech = (id: any) => typeof id === "number" && id >= 0 && id < 100
const isNpc = (id: any) => typeof id === "number" && id >= 100 && id < 1000
const isCrate = (id: any) => typeof id === "number" && id >= 1000 && id < 5000
const cls = (id: any) => (id == null ? "none" : isMech(id) ? "mech" : isNpc(id) ? "npc" : isCrate(id) ? "crate" : "other")
const inc = (o: Record<string, number>, k: string, v = 1) => { o[k] = (o[k] ?? 0) + v }
const pct = (a: number, b: number) => (b > 0 ? r1((100 * a) / b) : null)
function stat(a: number[], d = 1) { return { n: a.length, p10: r1(q(a, 0.1), d), median: r1(q(a, 0.5), d), p90: r1(q(a, 0.9), d), mean: r1(mean(a), d) } }

// ---------------------------------------------------------------- load
async function loadBytes(s: string): Promise<Uint8Array> {
  if (/^https?:\/\//.test(s)) {
    const r = await fetch(s)
    if (!r.ok) throw new Error(`fetch ${s}: ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  }
  return new Uint8Array(readFileSync(s))
}
const raw = await loadBytes(src)
const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? Bun.gunzipSync(raw) : raw
const text = new TextDecoder().decode(bytes)
let header: any = {}, result: any = null
const frames: Frame[] = []
for (const line of text.split("\n")) {
  if (!line.trim()) continue
  let o: any
  try { o = JSON.parse(line) } catch { continue }
  if (o.type === "header") header = o
  else if (o.type === "result") result = o
  else if (Array.isArray(o.m)) frames.push(o)
}
frames.sort((a, b) => a.t - b.t)
if (!frames.length) { console.error("no frames found"); process.exit(1) }

const HZ: number = header.tick_hz ?? 20
const FM: string[] = header.fields?.m ?? ["id", "x", "y", "z", "aim_yaw", "aim_pitch", "hp", "energy", "flags", "cubes", "max_hp", "slot0", "slot1"]
const FN: string[] = header.fields?.n ?? ["id", "x", "y", "z", "yaw", "hp"]
const mi = (k: string) => FM.indexOf(k)
const I = { id: mi("id"), x: mi("x"), y: mi("y"), z: mi("z"), yaw: mi("aim_yaw"), pitch: mi("aim_pitch"), hp: mi("hp"), en: mi("energy"),
  fl: mi("flags"), cubes: mi("cubes"), maxhp: mi("max_hp"), s0: mi("slot0"), s1: mi("slot1") }
const NI = { id: FN.indexOf("id"), x: FN.indexOf("x"), y: FN.indexOf("y"), z: FN.indexOf("z"), hp: FN.indexOf("hp") }
const KINDS: string[] = header.weapon_kinds ?? ["gun", "mortar", "laser", "lightning"]
const kindName = (k: number | undefined) => (k == null || k < 0 ? null : KINDS[k] ?? `k${k}`)
const MAXHP0 = 1400, MUZZLE = 7, CENTER = 4.5, SIZE_PER_CUBE = 0.05, GUN_SPREAD_DEG = 0.6, MECH_R = 2.5
const size = (cubes: number) => 1 + SIZE_PER_CUBE * (cubes || 0)

// terrain (optional)
const mapDir = opt("--map") ?? join(import.meta.dir, "..", "kit", "arena")
let ground: ((x: number, y: number) => number) | null = null
try {
  const wpath = join(mapDir, "v2", "world.json")
  if (existsSync(wpath)) {
    const T = JSON.parse(readFileSync(wpath, "utf8")).terrain
    const b = readFileSync(join(mapDir, "v2", T.file ?? "terrain.i16"))
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    const nx = T.nx, ny = T.ny, sc = T.scale ?? 0.01
    const H = (i: number, j: number) => dv.getInt16(2 * (Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))), true) * sc
    ground = (x, y) => {
      const fx = (x - T.minX) / T.step, fy = (y - T.minY) / T.step
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j
      return (H(i, j) * (1 - tx) + H(i + 1, j) * tx) * (1 - ty) + (H(i, j + 1) * (1 - tx) + H(i + 1, j + 1) * tx) * ty
    }
  }
} catch { ground = null }

// ---------------------------------------------------------------- indexes
const lastTick = frames[frames.length - 1].t
const tickToFrame = new Int32Array(lastTick + 2).fill(-1)
for (let fi = 0, t = 0; t <= lastTick; t++) { while (frames[fi].t < t) fi++; tickToFrame[t] = fi }
const frameAt = (tick: number) => frames[tickToFrame[Math.max(0, Math.min(lastTick, Math.round(tick)))]]
const mechMaps: Map<number, Row>[] = frames.map((f) => new Map(f.m.map((r) => [r[I.id], r])))
const npcMaps: Map<number, Row>[] = frames.map((f) => new Map((f.n ?? []).map((r) => [r[NI.id], r])))
const fIndex = (tick: number) => tickToFrame[Math.max(0, Math.min(lastTick, Math.round(tick)))]

const mechIds = new Set<number>()
for (const f of frames) for (const r of f.m) mechIds.add(r[I.id])
for (const m of header.mechs ?? []) mechIds.add(m.id)
for (const m of result?.mechs ?? []) mechIds.add(m.id)
const ids = [...mechIds].sort((a, b) => a - b)
const nameOf = (id: number) => header.mechs?.find((m: any) => m.id === id)?.name ?? result?.mechs?.find((m: any) => m.id === id)?.name ?? `mech${id}`
const archOf = (id: number) => {
  // house bots group by archetype ("house:expert" -> "expert"); team entries ("docker:...") group by their mech name
  const b = header.bots?.[id]
  if (typeof b === "string" && b.startsWith("house:")) return b.slice(6)
  return nameOf(id)
}

// crates: static positions; alive until 'crate' event
const crates = new Map<number, { pos: number[]; dead: number }>()
for (const c of header.crates ?? []) crates.set(c.id, { pos: c.pos, dead: Infinity })
const allEv: Ev[] = []
for (const f of frames) for (const e of f.ev ?? []) allEv.push(e)
allEv.sort((a, b) => a.t - b.t)
for (const e of allEv) if (e.e === "crate" && crates.has(e.id)) crates.get(e.id)!.dead = e.t

// state lookups
function mechState(fi: number, id: number) { return mechMaps[fi]?.get(id) }
function lastMechState(fi: number, id: number): Row | undefined {
  for (let k = fi; k >= 0 && k > fi - 40; k--) { const r = mechMaps[k].get(id); if (r) return r }
  return undefined
}
function entityPos(fi: number, id: number): number[] | null {
  if (isMech(id)) { const r = lastMechState(fi, id); return r ? [r[I.x], r[I.y], r[I.z] + CENTER * size(r[I.cubes])] : null }
  if (isNpc(id)) {
    for (let k = fi; k >= 0 && k > fi - 40; k--) { const r = npcMaps[k].get(id); if (r) return [r[NI.x], r[NI.y], r[NI.z] + 1.75] }
    return null
  }
  if (isCrate(id)) { const c = crates.get(id); return c ? [c.pos[0], c.pos[1], c.pos[2] + 1.2] : null }
  return null
}
const muzzle = (r: Row) => [r[I.x], r[I.y], r[I.z] + MUZZLE * size(r[I.cubes])]
function vel(fi: number, id: number): number[] {
  const a = mechMaps[fi]?.get(id), b = fi > 0 ? mechMaps[fi - 1]?.get(id) : undefined
  if (!a || !b) return [0, 0, 0]
  const dt = (frames[fi].t - frames[fi - 1].t) / HZ
  return dt > 0 ? [(a[I.x] - b[I.x]) / dt, (a[I.y] - b[I.y]) / dt, (a[I.z] - b[I.z]) / dt] : [0, 0, 0]
}

/** Most likely intended target of a shot along (yaw, pitch) from shooter row `r` at frame fi. */
function attribute(fi: number, r: Row, yaw: number, pitch: number, mode: "3d" | "yaw", maxDeg = 8, maxRange = 300) {
  const m = muzzle(r), sid = r[I.id]
  const dir = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
  let best: { id: number; dist: number; ang: number } | null = null
  const consider = (id: number, p: number[]) => {
    const v = [p[0] - m[0], p[1] - m[1], p[2] - m[2]], d = Math.hypot(v[0], v[1], v[2]), dh = hyp(v[0], v[1])
    if (d < 1 || dh > maxRange) return
    const ang = mode === "3d" ? Math.acos(Math.max(-1, Math.min(1, (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / d))) * DEG
      : Math.abs(wrap(Math.atan2(v[1], v[0]) - yaw)) * DEG
    if (ang <= maxDeg && (!best || ang < best.ang)) best = { id, dist: mode === "3d" ? d : dh, ang }
  }
  for (const [id, o] of mechMaps[fi]) if (id !== sid) consider(id, [o[I.x], o[I.y], o[I.z] + CENTER * size(o[I.cubes])])
  for (const [id, o] of npcMaps[fi]) consider(id, [o[NI.x], o[NI.y], o[NI.z] + 1.75])
  const tick = frames[fi].t
  for (const [id, c] of crates) if (c.dead > tick) consider(id, [c.pos[0], c.pos[1], c.pos[2] + 1.2])
  return best as { id: number; dist: number; ang: number } | null
}

// projectile speeds inferred from tracks (replays may come from other rulesets: e.g. mechanics-v2 gun = 140 m/s)
const projSpeeds: Record<string, number[]> = {}
{
  const last = new Map<number, { t: number; p: Row }>()
  for (const f of frames) for (const p of f.p ?? []) {
    const l = last.get(p[0])
    if (l && f.t > l.t) {
      const dt = (f.t - l.t) / HZ
      ;(projSpeeds[String(p[1])] ??= []).push(Math.hypot(p[2] - l.p[2], p[3] - l.p[3]) / dt)
    }
    last.set(p[0], { t: f.t, p })
  }
}
const GUN_SPEED = Number(opt("--gun-speed")) || (projSpeeds["0"]?.length ? q(projSpeeds["0"], 0.9)! : 252)

// ---------------------------------------------------------------- per-mech accumulation
interface Shot { t: number; w: string; target: number | null; dist: number | null; hit?: boolean; leadIdeal?: number; leadActual?: number; pitchErr?: number }
function newMech(id: number) {
  return {
    id, name: nameOf(id), archetype: archOf(id), place: null as number | null, death_t: null as number | null,
    killer: null as number | null, killed_with: null as string | null, alive_s: 0, kills: 0,
    dmg_dealt: { mech: {} as Record<string, number>, npc: {} as Record<string, number>, crate: {} as Record<string, number> },
    dmg_taken: {} as Record<string, number>, dmg_taken_by_src: {} as Record<string, number>,
    fires: {} as Record<string, number>, laser_shots: 0, laser_hit_mech: 0, zaps: 0, zap_hit_mech: 0, zap_hit_any: 0,
    hits: { gun: { mech: 0, npc: 0, crate: 0 } }, mortar_shells_hit_mech: 0, mortar_hit_events_mech: 0,
    hit_dist: {} as Record<string, number[]>, rear_dealt: 0, hits_dealt_mech: 0, rear_taken: 0, hits_taken_mech: 0,
    rear_dealt_by_w: {} as Record<string, number>, hits_dealt_by_w: {} as Record<string, number>,
    zone_out_s: 0, zone_dmg: 0, zone_margin: [] as { t: number; m: number }[],
    cube_timeline: [] as [number, number][], cubes_max: 0, upgrades: [] as [number, string][],
    loadout_timeline: [] as [number, (string | null)[]][], boost_s: 0, air_s: 0, still_s: 0, charge_s: 0, frames: 0,
    speeds: [] as number[], speeds_boost: [] as number[], speeds_walk: [] as number[], hag: [] as number[], max_z: -Infinity, max_hag: -Infinity, roof_s: 0,
    crates: 0, npc_kills: 0, takes: [] as [number, string][], drops_taken: 0, charge_durs: [] as number[],
    fx_dealt: {} as Record<string, number>, fx_taken: {} as Record<string, number>, cube_pickups: {} as Record<string, number>,
    hp_timeline: [] as [number, number, number][], min_hp_frac: 1, shots: [] as Shot[],
  }
}
type M = ReturnType<typeof newMech>
const mechs = new Map<number, M>()
for (const id of ids) mechs.set(id, newMech(id))
const S = (id: number) => mechs.get(id)

// frames
const prevRow = new Map<number, Row>()
for (let fi = 0; fi < frames.length; fi++) {
  const f = frames[fi], tsec = f.t / HZ
  const dt = fi > 0 ? (f.t - frames[fi - 1].t) / HZ : header.frame_every ? header.frame_every / HZ : 0.1
  for (const r of f.m) {
    const s = S(r[I.id]); if (!s) continue
    s.frames++; s.alive_s += dt
    const fl = r[I.fl] ?? 1, grounded = (fl & 1) !== 0
    if (fl & 2) s.boost_s += dt
    if (!grounded) s.air_s += dt
    if (fl & 4) s.charge_s += dt
    const cubes = r[I.cubes] ?? 0
    if (cubes > s.cubes_max) s.cubes_max = cubes
    const lastC = s.cube_timeline.length ? s.cube_timeline[s.cube_timeline.length - 1][1] : 0
    if (cubes !== lastC || !s.cube_timeline.length) { if (cubes !== 0 || s.cube_timeline.length) s.cube_timeline.push([r1(tsec, 2)!, cubes]) }
    const lo = [kindName(r[I.s0]), kindName(r[I.s1])]
    const lastLo = s.loadout_timeline[s.loadout_timeline.length - 1]?.[1]
    if (!lastLo || lastLo[0] !== lo[0] || lastLo[1] !== lo[1]) s.loadout_timeline.push([r1(tsec, 2)!, lo])
    const hpf = r[I.hp] / (r[I.maxhp] || MAXHP0)
    if (hpf < s.min_hp_frac) s.min_hp_frac = hpf
    if (fi % 10 === 0) s.hp_timeline.push([r1(tsec, 1)!, Math.round(r[I.hp]), Math.round(r[I.maxhp])])
    if (r[I.z] > s.max_z) s.max_z = r[I.z]
    if (ground) {
      const h = r[I.z] - ground(r[I.x], r[I.y])
      s.hag.push(h)
      if (h > s.max_hag) s.max_hag = h
      if (grounded && h > 3) s.roof_s += dt
    }
    const z = f.z
    if (z) {
      const d = hyp(r[I.x] - z[0], r[I.y] - z[1]), margin = z[2] - d
      if (margin < 0) s.zone_out_s += dt
      if (fi % 10 === 0) s.zone_margin.push({ t: tsec, m: margin })
    }
    const p = prevRow.get(r[I.id])
    if (p && fi > 0 && mechMaps[fi - 1].has(r[I.id]) && dt > 0) {
      const sp = hyp(r[I.x] - p[I.x], r[I.y] - p[I.y]) / dt
      s.speeds.push(sp)
      if (grounded && (fl & 2)) s.speeds_boost.push(sp); else if (grounded) s.speeds_walk.push(sp)
      if (sp < 1) s.still_s += dt
    }
    prevRow.set(r[I.id], r)
  }
}

// cube sources: a cube spawned on the same tick as a crate break / NPC death / mech death comes from that source
const cubeSource = new Map<number, string>()
{
  const byTick = new Map<number, Ev[]>()
  for (const e of allEv) { if (!byTick.has(e.t)) byTick.set(e.t, []); byTick.get(e.t)!.push(e) }
  for (const e of allEv) {
    if (e.e !== "cube") continue
    const same = byTick.get(e.t) ?? []
    let best = "other", bd = Infinity
    for (const o of same) {
      let p: number[] | null = null, k = ""
      if (o.e === "crate") { p = crates.get(o.id)?.pos ?? null; k = "crate" }
      else if (o.e === "death" && isNpc(o.id)) { p = entityPos(fIndex(o.t), o.id); k = "npc" }
      else if (o.e === "death" && isMech(o.id)) { p = entityPos(fIndex(o.t), o.id); k = "kill" }
      if (k && p && e.at) { const d = hyp(p[0] - e.at[0], p[1] - e.at[1]); if (d < bd) { bd = d; best = k } }
      else if (k && best === "other") best = k
    }
    cubeSource.set(e.id, best)
  }
}

// events
const mortarHitGroups = new Map<string, Set<number>>() // `${src}:${t}` -> mech dsts
const laserFx = new Map<number, number>()
for (const e of allEv) {
  const fi = fIndex(e.t), tsec = e.t / HZ
  switch (e.e) {
    case "fire": { const s = S(e.id); if (s) inc(s.fires, e.w); break }
    case "charge": { const s = S(e.id); if (s && typeof e.dur === "number") s.charge_durs.push(e.dur); break }
    case "laser": { const s = S(e.id); if (s) { s.laser_shots++; if ((e.hits ?? []).some(isMech)) s.laser_hit_mech++ } break }
    case "zap": { const s = S(e.id); if (s) { s.zaps++; const h = e.hits ?? []; if (h.some(isMech)) s.zap_hit_mech++; if (h.length) s.zap_hit_any++ } break }
    case "hit": {
      const a = S(e.src), d = S(e.dst), w = e.w ?? "?", c = cls(e.dst)
      if (a && (c === "mech" || c === "npc" || c === "crate")) inc((a.dmg_dealt as any)[c], w, e.amt)
      if (a && w === "gun" && (c === "mech" || c === "npc" || c === "crate")) (a.hits.gun as any)[c]++
      if (d) { inc(d.dmg_taken, w, e.amt); inc(d.dmg_taken_by_src, e.src == null ? "zone" : cls(e.src), e.amt); if (w === "zone") d.zone_dmg += e.amt }
      if (a && c === "mech") {
        a.hits_dealt_mech++; inc(a.hits_dealt_by_w, w)
        if (e.rear) { a.rear_dealt++; inc(a.rear_dealt_by_w, w) }
        const p1 = entityPos(fi, e.src), p2 = entityPos(fi, e.dst)
        if (p1 && p2) (a.hit_dist[w] ??= []).push(hyp(p1[0] - p2[0], p1[1] - p2[1]))
        if (w === "mortar") { const k = `${e.src}:${e.t}`; if (!mortarHitGroups.has(k)) mortarHitGroups.set(k, new Set()); mortarHitGroups.get(k)!.add(e.dst); a.mortar_hit_events_mech++ }
      }
      if (d && isMech(e.src)) { d.hits_taken_mech++; if (e.rear) d.rear_taken++ }
      if (e.fx) { if (a) inc(a.fx_dealt, e.fx); if (d) inc(d.fx_taken, e.fx) }
      break
    }
    case "death": {
      if (isMech(e.id)) {
        const s = S(e.id)
        if (s) { s.death_t = tsec; s.killer = e.by ?? null; if (e.place != null) s.place = e.place }
        const k = S(e.by); if (k) k.kills++
      } else if (isNpc(e.id)) { const k = S(e.by); if (k) k.npc_kills++ }
      break
    }
    case "crate": { const s = S(e.by); if (s) s.crates++; break }
    case "pickup": { const s = S(e.by); if (s) inc(s.cube_pickups, cubeSource.get(e.id) ?? "other"); break }
    case "weapon": { if (e.op === "take") { const s = S(e.by); if (s) s.takes.push([r1(tsec, 2)!, e.kind]) } break }
    case "upgrade": { const s = S(e.id); if (s) s.upgrades.push([r1(tsec, 2)!, e.up]); break }
    case "drop": { if (e.op === "take") { const s = S(e.by); if (s) { s.drops_taken++; inc(s.cube_pickups, "drop", 3) } } break }
    case "end": { (e.places ?? []).forEach((p: number, i: number) => { const s = S(i); if (s && s.place == null) s.place = p }); break }
  }
}
for (const [k, set] of mortarHitGroups) { const s = S(Number(k.split(":")[0])); if (s && set.size) s.mortar_shells_hit_mech++ }
// killing weapon: last damaging hit on the victim at/before death
for (const s of mechs.values()) {
  if (s.death_t == null) continue
  const dt = Math.round(s.death_t * HZ)
  for (let k = allEv.length - 1; k >= 0; k--) {
    const e = allEv[k]
    if (e.t > dt || e.e !== "hit" || e.dst !== s.id) continue
    s.killed_with = e.w ?? null
    if (s.killer == null && e.src != null) s.killer = e.src
    break
  }
}
// places when the replay has neither `death.place` nor an `end` event: death order, survivors ranked by final HP
{
  const n = mechs.size
  const deadTicks = [...mechs.values()].filter((s) => s.death_t != null).map((s) => Math.round(s.death_t! * HZ))
  const lastF = mechMaps[frames.length - 1]
  const survivors = [...mechs.values()].filter((s) => s.death_t == null)
  for (const s of mechs.values()) {
    if (s.place != null) continue
    if (s.death_t != null) { const t = Math.round(s.death_t * HZ); s.place = n - deadTicks.filter((d) => d < t).length }
    else { const hp = lastF.get(s.id)?.[I.hp] ?? 0; s.place = 1 + survivors.filter((o) => (lastF.get(o.id)?.[I.hp] ?? 0) > hp).length }
  }
}
// result line overrides (authoritative when present)
for (const rm of result?.mechs ?? []) {
  const s = S(rm.id); if (!s) continue
  if (rm.place != null) s.place = rm.place
  if (rm.death_t !== undefined) s.death_t = rm.death_t
  if (rm.killed_by !== undefined) s.killer = rm.killed_by
  if (rm.killed_with !== undefined) s.killed_with = rm.killed_with
}

// ---------------------------------------------------------------- shot attribution + behavior analysis
const fireEvents = allEv.filter((e) => e.e === "fire" && S(e.id))
for (const e of fireEvents) {
  const fi = fIndex(e.t), r = mechState(fi, e.id) ?? lastMechState(fi, e.id)
  if (!r) continue
  const w = e.w
  const a = w === "mortar" ? attribute(fi, r, r[I.yaw], 0, "yaw", 10, 260) : attribute(fi, r, r[I.yaw], r[I.pitch], "3d", 8, 300)
  const shot: Shot = { t: e.t / HZ, w, target: a?.id ?? null, dist: a ? a.dist : null }
  if (w === "gun" && a && isMech(a.id)) {
    const tr = mechState(fi, a.id)
    if (tr) {
      const m = muzzle(r), P = [tr[I.x], tr[I.y], tr[I.z] + CENTER * size(tr[I.cubes])], V = vel(fi, a.id)
      // intercept: |P + V t - m| = s t
      const D = [P[0] - m[0], P[1] - m[1], P[2] - m[2]]
      const A = V[0] ** 2 + V[1] ** 2 + V[2] ** 2 - GUN_SPEED ** 2, B = 2 * (D[0] * V[0] + D[1] * V[1] + D[2] * V[2]), C = D[0] ** 2 + D[1] ** 2 + D[2] ** 2
      const disc = B * B - 4 * A * C
      const tau = disc >= 0 ? (-B - Math.sqrt(disc)) / (2 * A) : Math.sqrt(C) / GUN_SPEED
      const Q = [D[0] + V[0] * tau, D[1] + V[1] * tau, D[2] + V[2] * tau]
      const bearing = Math.atan2(D[1], D[0])
      shot.leadIdeal = wrap(Math.atan2(Q[1], Q[0]) - bearing)
      shot.leadActual = wrap(r[I.yaw] - bearing)
      shot.pitchErr = r[I.pitch] - Math.atan2(Q[2], hyp(Q[0], Q[1]))
    }
  }
  S(e.id)!.shots.push(shot)
}
for (const e of allEv) {
  if (e.e === "laser" && S(e.id)) {
    const fi = fIndex(e.t), r = mechState(fi, e.id) ?? lastMechState(fi, e.id)
    const h = (e.hits ?? []).find(isMech)
    let target: number | null = null, d: number | null = null
    if (h != null) { target = h; const p = entityPos(fi, h); if (p && e.from) d = dist3(e.from, p) }
    else if (r && e.from && e.to) {
      const v = [e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]]
      const a = attribute(fi, r, Math.atan2(v[1], v[0]), Math.atan2(v[2], hyp(v[0], v[1])), "3d", 6, 300)
      if (a) { target = a.id; d = a.dist }
    }
    S(e.id)!.shots.push({ t: e.t / HZ, w: "laser", target, dist: d, hit: h != null })
  } else if (e.e === "zap" && S(e.id)) {
    const fi = fIndex(e.t), h = (e.hits ?? [])[0]
    const p = h != null ? entityPos(fi, h) : null, r = lastMechState(fi, e.id)
    S(e.id)!.shots.push({ t: e.t / HZ, w: "lightning", target: h ?? null, dist: p && r ? hyp(p[0] - r[I.x], p[1] - r[I.y]) : null, hit: h != null && isMech(h) })
  }
}
for (const s of mechs.values()) s.shots.sort((a, b) => a.t - b.t)
// link each gun hit on a mech to the shot that most plausibly produced it (fire time + flight time ~ hit time)
for (const e of allEv) {
  if (e.e !== "hit" || e.w !== "gun" || !isMech(e.dst) || !S(e.src)) continue
  const th = e.t / HZ, fi = fIndex(e.t), p1 = entityPos(fi, e.src), p2 = entityPos(fi, e.dst)
  const dh = p1 && p2 ? dist3(p1, p2) : 60
  let best: Shot | null = null, be = Infinity
  for (const sh of S(e.src)!.shots) {
    if (sh.w !== "gun" || sh.hit || sh.t > th + 0.051 || sh.t < th - 2.5) continue
    const err = Math.abs(sh.t + dh / GUN_SPEED - th) + (sh.target === e.dst ? 0 : 0.15)
    if (err < be) { be = err; best = sh }
  }
  if (best) { best.hit = true; if (best.target !== e.dst || best.dist == null) { best.target = e.dst; best.dist = p1 && p2 ? hyp(p1[0] - p2[0], p1[1] - p2[1]) : null } }
}

// damage hits indexed for analyses
const hitEvents = allEv.filter((e) => e.e === "hit" && isMech(e.dst) && e.w !== "zone")

// engagements: first attributed shot at a mech target after >= 5 s without shooting at it
interface Eng { shooter: number; target: number; t: number; dist: number | null; w: string; nCand: number; nearest: boolean; lowestHp: boolean; targetHpFrac: number }
const engagements: Eng[] = []
for (const s of mechs.values()) {
  const lastAt = new Map<number, number>()
  for (const sh of s.shots) {
    if (sh.target == null || !isMech(sh.target)) continue
    const prev = lastAt.get(sh.target)
    lastAt.set(sh.target, sh.t)
    if (prev != null && sh.t - prev < 5) continue
    const fi = fIndex(sh.t * HZ), r = lastMechState(fi, s.id)
    if (!r) continue
    // candidates: alive mechs within 45 m, or within 200 m inside the 120 deg wedge of the shooter's aim (no LOS test)
    const cands: { id: number; d: number; hp: number }[] = []
    for (const [id, o] of mechMaps[fi]) {
      if (id === s.id) continue
      const d = hyp(o[I.x] - r[I.x], o[I.y] - r[I.y]), b = Math.atan2(o[I.y] - r[I.y], o[I.x] - r[I.x])
      if (d <= 45 || (d <= 200 && Math.abs(wrap(b - r[I.yaw])) <= Math.PI / 3)) cands.push({ id, d, hp: o[I.hp] })
    }
    const tgt = cands.find((c) => c.id === sh.target)
    const to = mechMaps[fi].get(sh.target)
    const nearest = !!tgt && cands.every((c) => c.d >= tgt.d)
    const lowestHp = !!tgt && cands.every((c) => c.hp >= tgt.hp)
    engagements.push({ shooter: s.id, target: sh.target, t: sh.t, dist: sh.dist, w: sh.w, nCand: cands.length, nearest, lowestHp,
      targetHpFrac: to ? to[I.hp] / (to[I.maxhp] || MAXHP0) : NaN })
  }
}

// reaction: victim first hit by attacker A (no exchange with A in previous 10 s) -> victim's first shot at A within 10 s
const reactions = new Map<number, number[]>()
{
  const lastHitBy = new Map<string, number>()
  for (const e of hitEvents) {
    if (!isMech(e.src)) continue
    const key = `${e.dst}:${e.src}`, t = e.t / HZ, prev = lastHitBy.get(key)
    lastHitBy.set(key, t)
    if (prev != null && t - prev < 10) continue
    const v = S(e.dst); if (!v) continue
    if (v.shots.some((sh) => sh.target === e.src && sh.t < t && sh.t > t - 10)) continue
    const next = v.shots.find((sh) => sh.target === e.src && sh.t >= t && sh.t <= t + 10)
    if (next) { if (!reactions.has(v.id)) reactions.set(v.id, []); reactions.get(v.id)!.push(next.t - t) }
  }
}

// time to kill: death by mech K -> first hit of K's last streak on the victim (gaps < 8 s)
const ttk: { killer: number; victim: number; ttk: number; hits: number }[] = []
for (const s of mechs.values()) {
  if (s.death_t == null || !isMech(s.killer)) continue
  const hs = hitEvents.filter((e) => e.dst === s.id && e.src === s.killer && e.t / HZ <= s.death_t! + 0.05).map((e) => e.t / HZ)
  if (!hs.length) continue
  let start = hs[hs.length - 1], n = 1
  for (let k = hs.length - 2; k >= 0 && start - hs[k] < 8; k--) { start = hs[k]; n++ }
  ttk.push({ killer: s.killer!, victim: s.id, ttk: s.death_t - start, hits: n })
}

// retreat curve + strafe: per frame, if damaged by a mech within 1.5 s, radial speed away from that attacker by HP bin
const retreat = new Map<number, { bins: number[][] }>() // id -> [bin][away, total]
const combat = new Map<number, { frames: number; strafe: number; speed: number[] }>()
{
  const lastDmg = new Map<number, { t: number; by: number }>()
  let hk = 0
  for (let fi = 1; fi < frames.length; fi++) {
    const tick = frames[fi].t
    while (hk < hitEvents.length && hitEvents[hk].t <= tick) { const e = hitEvents[hk++]; if (isMech(e.src)) lastDmg.set(e.dst, { t: e.t / HZ, by: e.src }) }
    for (const [id, r] of mechMaps[fi]) {
      const ld = lastDmg.get(id)
      if (ld && tick / HZ - ld.t <= 1.5) {
        const a = lastMechState(fi, ld.by)
        if (a && mechMaps[fi].has(ld.by)) {
          const v = vel(fi, id), ux = r[I.x] - a[I.x], uy = r[I.y] - a[I.y], L = hyp(ux, uy) || 1
          const vr = (v[0] * ux + v[1] * uy) / L
          const hpf = r[I.hp] / (r[I.maxhp] || MAXHP0), b = Math.min(4, Math.floor(hpf * 5))
          if (!retreat.has(id)) retreat.set(id, { bins: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]] })
          const bin = retreat.get(id)!.bins[b]; bin[1]++; if (vr > 3) bin[0]++
        }
      }
    }
  }
  for (const s of mechs.values()) {
    const c = { frames: 0, strafe: 0, speed: [] as number[] }
    let k = 0
    for (let fi = 1; fi < frames.length; fi++) {
      const t = frames[fi].t / HZ, r = mechMaps[fi].get(s.id); if (!r) continue
      while (k < s.shots.length && s.shots[k].t < t - 0.5) k++
      const sh = s.shots[k]
      if (!sh || sh.t > t + 0.05 || sh.target == null || !isMech(sh.target)) continue
      const o = mechMaps[fi].get(sh.target); if (!o) continue
      const v = vel(fi, s.id), ux = o[I.x] - r[I.x], uy = o[I.y] - r[I.y], L = hyp(ux, uy) || 1
      const par = (v[0] * ux + v[1] * uy) / L, perp = Math.abs((v[0] * uy - v[1] * ux) / L), sp = hyp(v[0], v[1])
      c.frames++; c.speed.push(sp); if (sp > 4 && perp > Math.abs(par)) c.strafe++
    }
    combat.set(s.id, c)
  }
}

// regen episodes: runs of frames with hp rising 2-8.5 HP per 0.1 s at constant max_hp
const regen = new Map<number, { start: number; end: number; dur: number; full: boolean }[]>()
for (const s of mechs.values()) {
  const eps: { start: number; end: number; dur: number; full: boolean }[] = []
  let cur: { start: number; end: number; t0: number; t1: number; max: number } | null = null
  for (let fi = 1; fi < frames.length; fi++) {
    const r = mechMaps[fi].get(s.id), p = mechMaps[fi - 1].get(s.id)
    if (!r || !p) continue
    const dhp = r[I.hp] - p[I.hp], dt = (frames[fi].t - frames[fi - 1].t) / HZ, rate = dhp / dt
    const ok = r[I.maxhp] === p[I.maxhp] && rate > 20 && rate < 85
    const t = frames[fi].t / HZ
    if (ok) {
      if (cur && t - cur.t1 <= 0.25) { cur.end = r[I.hp]; cur.t1 = t }
      else { if (cur) eps.push({ start: cur.start / cur.max, end: cur.end / cur.max, dur: cur.t1 - cur.t0, full: cur.end >= cur.max - 1 }); cur = { start: p[I.hp], end: r[I.hp], t0: t - dt, t1: t, max: r[I.maxhp] } }
    }
  }
  if (cur) eps.push({ start: cur.start / cur.max, end: cur.end / cur.max, dur: cur.t1 - cur.t0, full: cur.end >= cur.max - 1 })
  regen.set(s.id, eps.filter((e) => e.dur >= 0.5))
}

// ---------------------------------------------------------------- per-mech report objects
function mechReport(s: M) {
  const acc: Record<string, any> = {}
  const gunF = s.fires.gun ?? 0
  if (gunF) acc.gun = { shots: gunF, hits_mech: s.hits.gun.mech, hits_npc: s.hits.gun.npc, hits_crate: s.hits.gun.crate,
    acc_any_pct: pct(s.hits.gun.mech + s.hits.gun.npc + s.hits.gun.crate, gunF) }
  if (s.fires.mortar) acc.mortar = { shells: s.fires.mortar, shells_hit_mech: s.mortar_shells_hit_mech, mech_hit_events: s.mortar_hit_events_mech, acc_pct: pct(s.mortar_shells_hit_mech, s.fires.mortar) }
  if (s.laser_shots) acc.laser = { shots: s.laser_shots, hit_mech: s.laser_hit_mech, acc_pct: pct(s.laser_hit_mech, s.laser_shots) }
  if (s.zaps) acc.lightning = { zaps: s.zaps, hit_mech: s.zap_hit_mech, hit_any: s.zap_hit_any, acc_any_pct: pct(s.zap_hit_any, s.zaps) }
  // gun accuracy vs mechs among shots attributed to a mech target
  const gm = s.shots.filter((x) => x.w === "gun" && x.target != null && isMech(x.target)).length
  if (acc.gun) { acc.gun.shots_at_mechs = gm; acc.gun.acc_vs_mech_pct = pct(s.hits.gun.mech, gm) }
  const hd: Record<string, any> = {}
  for (const [w, a] of Object.entries(s.hit_dist)) hd[w] = stat(a, 0)
  const zm = s.zone_margin
  return {
    id: s.id, name: s.name, archetype: s.archetype, place: s.place, death_t: r1(s.death_t, 2), killer: s.killer, killed_with: s.killed_with,
    alive_s: r1(s.alive_s), kills: s.kills, npc_kills: s.npc_kills, crates: s.crates, drops_taken: s.drops_taken,
    damage_dealt: { mech: round(s.dmg_dealt.mech), npc: round(s.dmg_dealt.npc), crate: round(s.dmg_dealt.crate) },
    damage_taken: round(s.dmg_taken), damage_taken_by_source: round(s.dmg_taken_by_src),
    accuracy: acc, hit_dist_m: hd,
    rear: { dealt: s.rear_dealt, dealt_of: s.hits_dealt_mech, dealt_pct: pct(s.rear_dealt, s.hits_dealt_mech), taken: s.rear_taken, taken_of: s.hits_taken_mech, taken_pct: pct(s.rear_taken, s.hits_taken_mech) },
    effects_dealt: s.fx_dealt, effects_taken: s.fx_taken,
    zone: { out_s: r1(s.zone_out_s), dmg: Math.round(s.zone_dmg), margin_m_min: r1(Math.min(...zm.map((z) => z.m))), margin_m_median: r1(q(zm.map((z) => z.m), 0.5)) },
    movement: { boost_pct: pct(s.boost_s, s.alive_s), airborne_pct: pct(s.air_s, s.alive_s), still_pct: pct(s.still_s, s.alive_s), charging_pct: pct(s.charge_s, s.alive_s),
      speed: stat(s.speeds), speed_walk: stat(s.speeds_walk), speed_boost: stat(s.speeds_boost), max_z: r1(s.max_z),
      max_height_above_ground: ground ? r1(s.max_hag) : null, elevated_grounded_s: ground ? r1(s.roof_s) : null },
    cubes_max: s.cubes_max, cube_timeline: s.cube_timeline, cube_sources: s.cube_pickups, upgrades: s.upgrades,
    loadout_timeline: s.loadout_timeline, takes: s.takes, first_weapon_t: s.takes[0]?.[0] ?? null,
    laser_charge_s: s.charge_durs.length ? stat(s.charge_durs, 2) : null, min_hp_frac: r1(s.min_hp_frac, 2),
  }
}
function round(o: Record<string, number>) { const r: Record<string, number> = {}; for (const [k, v] of Object.entries(o)) r[k] = Math.round(v); return r }

// ---------------------------------------------------------------- archetype aggregation
const SIG_GRID = Array.from({ length: 200 }, (_, i) => 0.05 * (i + 1)) // deg
function phit(d: number, sigDeg: number, sz = 1) {
  const s = (sigDeg / DEG) * d
  if (s <= 1e-9) return 1
  const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y }
  return erf((MECH_R * sz) / (Math.SQRT2 * s)) * erf((CENTER * sz) / (Math.SQRT2 * s))
}
const BINS = [0, 30, 60, 100, 150, 230, 400]
function archetypeReport(group: M[]) {
  const ids = new Set(group.map((s) => s.id))
  const all = <T,>(f: (s: M) => T[]) => group.flatMap(f)
  const sum = (f: (s: M) => number) => group.reduce((a, s) => a + f(s), 0)
  const alive = sum((s) => s.alive_s)
  // gun hit rate by distance bin, from shots attributed to mechs vs gun hits on mechs at that distance
  const gs = all((s) => s.shots.filter((x) => x.w === "gun" && x.target != null && isMech(x.target) && x.dist != null))
  const shotsD = gs.map((x) => x.dist!)
  const bins = BINS.slice(0, -1).map((lo, k) => {
    const hi = BINS[k + 1], inb = gs.filter((x) => x.dist! >= lo && x.dist! < hi), n = inb.length, h = inb.filter((x) => x.hit).length
    const md = q(inb.map((x) => x.dist!), 0.5)
    return { range: `${lo}-${hi}`, shots: n, hits: h, rate_pct: pct(h, n), median_d: r1(md, 0) }
  })
  // MLE of effective angular error (deg) from binned hit rates
  let best = { sig: NaN, ll: -Infinity }
  for (const sg of SIG_GRID) {
    let ll = 0
    for (const b of bins) { if (!b.shots || b.median_d == null) continue; const p = Math.min(0.999, Math.max(0.001, phit(b.median_d, sg))); const h = Math.min(b.hits, b.shots); ll += h * Math.log(p) + (b.shots - h) * Math.log(1 - p) }
    if (ll > best.ll) best = { sig: sg, ll }
  }
  const nShotsFit = bins.reduce((a, b) => a + b.shots, 0)
  // lead fraction: least squares of actual vs ideal lead (yaw), shots with |ideal| > 0.5 deg
  const leads = all((s) => s.shots.filter((x) => x.leadIdeal != null && Math.abs(x.leadIdeal) > 0.5 / DEG && Math.abs(x.leadActual!) < 8 / DEG))
  let sxy = 0, sxx = 0
  for (const x of leads) { sxy += x.leadIdeal! * x.leadActual!; sxx += x.leadIdeal! ** 2 }
  const leadFrac = sxx > 0 ? sxy / sxx : null
  const resid = leads.map((x) => (x.leadActual! - (leadFrac ?? 0) * x.leadIdeal!) * DEG)
  const allLead = all((s) => s.shots.filter((x) => x.leadActual != null && Math.abs(x.leadActual!) < 8 / DEG))
  const yawErrAll = allLead.map((x) => (x.leadActual! - x.leadIdeal!) * DEG)
  const pitchErr = allLead.map((x) => x.pitchErr! * DEG)
  const sd = (a: number[]) => { const m = mean(a) ?? 0; return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : null }
  // per-weapon attributed shot distances (fire ranges)
  const fireRange: Record<string, any> = {}
  for (const w of ["gun", "mortar", "laser", "lightning"]) {
    const d = all((s) => s.shots.filter((x) => x.w === w && x.dist != null && x.target != null && isMech(x.target)).map((x) => x.dist!))
    if (d.length) fireRange[w] = stat(d, 0)
  }
  const eng = engagements.filter((e) => ids.has(e.shooter))
  const eng2 = eng.filter((e) => e.nCand >= 2)
  const rb = [0, 1, 2, 3, 4].map((b) => { let a = 0, t = 0; for (const s of group) { const x = retreat.get(s.id)?.bins[b]; if (x) { a += x[0]; t += x[1] } } return { hp: `${b * 20}-${b * 20 + 20}%`, frames: t, away_pct: pct(a, t) } })
  const regs = all((s) => regen.get(s.id) ?? [])
  const cmb = group.map((s) => combat.get(s.id)!).filter(Boolean)
  const cf = cmb.reduce((a, c) => a + c.frames, 0), cs = cmb.reduce((a, c) => a + c.strafe, 0)
  const tk = ttk.filter((x) => ids.has(x.killer))
  const upCount: Record<string, number> = {}; for (const s of group) for (const [, u] of s.upgrades) inc(upCount, u)
  const takeCount: Record<string, number> = {}; for (const s of group) for (const [, k] of s.takes) inc(takeCount, k)
  const srcCount: Record<string, number> = {}; for (const s of group) for (const [k, v] of Object.entries(s.cube_pickups)) inc(srcCount, k, v)
  const dmgW: Record<string, number> = {}; for (const s of group) for (const [k, v] of Object.entries(s.dmg_dealt.mech)) inc(dmgW, k, v)
  const rearW: Record<string, string> = {}
  for (const w of ["gun", "mortar", "laser", "lightning"]) { const h = sum((s) => s.hits_dealt_by_w[w] ?? 0); if (h) rearW[w] = `${sum((s) => s.rear_dealt_by_w[w] ?? 0)}/${h}` }
  const zoneBins = [[0, 60], [60, 110], [110, 155], [155, 195], [195, 230], [230, 265], [265, 325], [325, 480]].map(([a, b]) => {
    const m = all((s) => s.zone_margin.filter((z) => z.t >= a && z.t < b).map((z) => z.m))
    return { t: `${a}-${b}`, n: m.length, margin_median: r1(q(m, 0.5), 0), margin_p10: r1(q(m, 0.1), 0) }
  }).filter((z) => z.n)
  const places = group.map((s) => s.place).filter((p): p is number => p != null)
  return {
    n: group.length, ids: group.map((s) => s.id), places, mean_place: r1(mean(places)),
    death_t: group.map((s) => r1(s.death_t, 1)), killed_with: group.map((s) => s.killed_with),
    kills: sum((s) => s.kills), npc_kills: sum((s) => s.npc_kills), crates: sum((s) => s.crates),
    movement: { boost_pct: pct(sum((s) => s.boost_s), alive), airborne_pct: pct(sum((s) => s.air_s), alive), still_pct: pct(sum((s) => s.still_s), alive),
      speed: stat(all((s) => s.speeds)), speed_walk: stat(all((s) => s.speeds_walk)), speed_boost: stat(all((s) => s.speeds_boost)),
      max_height_above_ground: ground ? r1(Math.max(...group.map((s) => s.max_hag))) : null,
      elevated_grounded_pct: ground ? pct(sum((s) => s.roof_s), alive) : null,
      hag_p90: ground ? r1(q(all((s) => s.hag), 0.9)) : null },
    accuracy: {
      gun: { shots: sum((s) => s.fires.gun ?? 0), hits_mech: sum((s) => s.hits.gun.mech), hits_npc: sum((s) => s.hits.gun.npc), hits_crate: sum((s) => s.hits.gun.crate),
        shots_at_mechs: shotsD.length, acc_vs_mech_pct: pct(sum((s) => s.hits.gun.mech), shotsD.length) },
      mortar: { shells: sum((s) => s.fires.mortar ?? 0), shells_hit_mech: sum((s) => s.mortar_shells_hit_mech) },
      laser: { shots: sum((s) => s.laser_shots), hit_mech: sum((s) => s.laser_hit_mech) },
      lightning: { zaps: sum((s) => s.zaps), hit_mech: sum((s) => s.zap_hit_mech), hit_any: sum((s) => s.zap_hit_any) },
    },
    gun_hit_rate_by_dist: bins,
    aim_fit: { sigma_eff_deg: r1(best.sig, 2), sigma_aim_deg: Number.isFinite(best.sig) ? r1(Math.sqrt(Math.max(0, best.sig ** 2 - GUN_SPREAD_DEG ** 2)), 2) : null, shots: nShotsFit,
      lead_frac: r1(leadFrac, 2), lead_shots: leads.length, yaw_resid_sd_deg: r1(sd(resid), 2), yaw_err_vs_ideal_sd_deg: r1(sd(yawErrAll), 2),
      yaw_err_vs_ideal_median_abs_deg: r1(q(yawErrAll.map(Math.abs), 0.5), 2), pitch_err_median_deg: r1(q(pitchErr, 0.5), 2), pitch_err_sd_deg: r1(sd(pitchErr), 2) },
    hit_dist_m: Object.fromEntries(["gun", "mortar", "laser", "lightning"].map((w) => [w, all((s) => s.hit_dist[w] ?? [])]).filter(([, a]) => (a as number[]).length).map(([w, a]) => [w, stat(a as number[], 0)])),
    fire_dist_m: fireRange,
    rear_hits_dealt: rearW, rear_dealt_pct: pct(sum((s) => s.rear_dealt), sum((s) => s.hits_dealt_mech)), rear_taken_pct: pct(sum((s) => s.rear_taken), sum((s) => s.hits_taken_mech)),
    laser_charge_s: stat(all((s) => s.charge_durs), 2),
    engagement: { n: eng.length, start_dist: stat(eng.filter((e) => e.dist != null).map((e) => e.dist!), 0), by_weapon: countBy(eng.map((e) => e.w)),
      multi_candidate: eng2.length, nearest_pct: pct(eng2.filter((e) => e.nearest).length, eng2.length), lowest_hp_pct: pct(eng2.filter((e) => e.lowestHp).length, eng2.length),
      random_baseline_pct: eng2.length ? r1(100 * (mean(eng2.map((e) => 1 / e.nCand)) ?? 0)) : null, target_hp_frac_median: r1(q(eng.map((e) => e.targetHpFrac).filter(Number.isFinite), 0.5), 2) },
    reaction_s: stat(all((s) => reactions.get(s.id) ?? []), 2),
    combat_motion: { frames: cf, strafe_pct: pct(cs, cf), speed: stat(cmb.flatMap((c) => c.speed)) },
    retreat_curve: rb,
    regen: { episodes: regs.length, start_hp_frac: stat(regs.map((e) => e.start), 2), end_hp_frac: stat(regs.map((e) => e.end), 2), dur_s: stat(regs.map((e) => e.dur), 1), full_pct: pct(regs.filter((e) => e.full).length, regs.length) },
    ttk_s: stat(tk.map((x) => x.ttk), 1), ttk_hits: stat(tk.map((x) => x.hits), 0),
    economy: { first_weapon_t: group.map((s) => s.takes[0]?.[0] ?? null), first_weapon: group.map((s) => s.takes[0]?.[1] ?? null), takes: takeCount,
      cube_sources: srcCount, cubes_max: group.map((s) => s.cubes_max), upgrades: upCount, drops_taken: sum((s) => s.drops_taken), damage_to_mechs_by_weapon: round(dmgW) },
    zone: { out_s: group.map((s) => r1(s.zone_out_s)), dmg: group.map((s) => Math.round(s.zone_dmg)), margin_by_time: zoneBins },
  }
}
function countBy(a: string[]) { const o: Record<string, number> = {}; for (const x of a) inc(o, x); return o }

// ---------------------------------------------------------------- output
const only = opt("--mech")
const selected = [...mechs.values()].filter((s) => only == null || s.id === Number(only))
const reports = selected.map(mechReport)
const groups = new Map<string, M[]>()
for (const s of mechs.values()) { if (!groups.has(s.archetype)) groups.set(s.archetype, []); groups.get(s.archetype)!.push(s) }
const arch: Record<string, any> = {}
if (flag("--json") || flag("--archetypes")) {
  for (const [k, g] of [...groups.entries()].sort()) arch[k] = archetypeReport(g)
  arch["ALL"] = archetypeReport([...mechs.values()])
}
const meta = { source: src, format: header.format ?? null, seed: header.seed ?? null, ticks: result?.ticks ?? lastTick, duration_s: r1(lastTick / HZ, 2), frames: frames.length,
  terrain: !!ground, inferred: { gun_speed: r1(GUN_SPEED), npc_bullet_speed: r1(q(projSpeeds["2"] ?? [], 0.9)), mortar_horiz_speed_p90: r1(q(projSpeeds["1"] ?? [], 0.9)),
    walk_speed_p90: r1(q([...mechs.values()].flatMap((s) => s.speeds_walk), 0.9)), boost_speed_p95: r1(q([...mechs.values()].flatMap((s) => s.speeds_boost), 0.95)),
    laser_charge_median: r1(q([...mechs.values()].flatMap((s) => s.charge_durs), 0.5), 2) }, winner: [...mechs.values()].find((s) => s.place === 1)?.id ?? null }

if (flag("--json")) {
  console.log(JSON.stringify({ meta, mechs: reports, archetypes: only == null ? arch : undefined, engagements: only == null ? engagements : engagements.filter((e) => e.shooter === Number(only) || e.target === Number(only)), ttk }, null, 1))
} else {
  const L: string[] = []
  L.push(`replay ${meta.source}  format=${meta.format} seed=${meta.seed} duration=${meta.duration_s}s frames=${meta.frames} winner=${meta.winner} terrain=${meta.terrain}`)
  L.push(`inferred rules ${JSON.stringify(meta.inferred)}`)
  for (const r of reports.sort((a, b) => (a.place ?? 99) - (b.place ?? 99))) {
    L.push("")
    L.push(`#${r.id} ${r.name} [${r.archetype}]  place ${r.place}  ${r.death_t == null ? "survived" : `died ${r.death_t}s by ${r.killer ?? "-"} (${r.killed_with})`}  kills ${r.kills}  npc ${r.npc_kills}  crates ${r.crates}  drops ${r.drops_taken}`)
    L.push(`  dealt mech ${JSON.stringify(r.damage_dealt.mech)} npc ${JSON.stringify(r.damage_dealt.npc)} crate ${JSON.stringify(r.damage_dealt.crate)}`)
    L.push(`  taken ${JSON.stringify(r.damage_taken)}  rear dealt ${r.rear.dealt}/${r.rear.dealt_of} taken ${r.rear.taken}/${r.rear.taken_of}  fx dealt ${JSON.stringify(r.effects_dealt)} taken ${JSON.stringify(r.effects_taken)}`)
    for (const [w, a] of Object.entries(r.accuracy)) L.push(`  acc ${w}: ${JSON.stringify(a)}`)
    for (const [w, h] of Object.entries(r.hit_dist_m)) L.push(`  hit dist ${w}: n=${h.n} p10=${h.p10} med=${h.median} p90=${h.p90}`)
    if (r.laser_charge_s) L.push(`  laser charge s: ${JSON.stringify(r.laser_charge_s)}`)
    const mv = r.movement
    L.push(`  move: speed med ${mv.speed.median} p90 ${mv.speed.p90} | walk med ${mv.speed_walk.median} boost med ${mv.speed_boost.median} | boost ${mv.boost_pct}% air ${mv.airborne_pct}% still ${mv.still_pct}% charging ${mv.charging_pct}% | max z ${mv.max_z} above-ground max ${mv.max_height_above_ground} elevated ${mv.elevated_grounded_s}s`)
    L.push(`  zone: out ${r.zone.out_s}s dmg ${r.zone.dmg} margin min ${r.zone.margin_m_min} med ${r.zone.margin_m_median}  min hp ${r.min_hp_frac}`)
    L.push(`  cubes max ${r.cubes_max} sources ${JSON.stringify(r.cube_sources)} timeline ${r.cube_timeline.map(([t, c]) => `${t}:${c}`).join(" ")}`)
    L.push(`  upgrades ${r.upgrades.map(([t, u]) => `${t}:${u}`).join(" ") || "-"}`)
    L.push(`  loadout ${r.loadout_timeline.map(([t, l]) => `${t}:${l.map((x) => x ?? "-").join("/")}`).join(" ")}`)
  }
  if (flag("--archetypes")) {
    L.push("", "==== archetypes")
    for (const [k, a] of Object.entries(arch)) {
      L.push("", `## ${k} n=${a.n} places=${a.places.join(",")} mean place ${a.mean_place} kills ${a.kills} npc ${a.npc_kills} crates ${a.crates}`)
      L.push(`  move ${JSON.stringify(a.movement)}`)
      L.push(`  acc ${JSON.stringify(a.accuracy)}`)
      L.push(`  gun hit rate by dist ${a.gun_hit_rate_by_dist.map((b: any) => `${b.range}:${b.hits}/${b.shots}`).join(" ")}  fit ${JSON.stringify(a.aim_fit)}`)
      L.push(`  hit dist ${JSON.stringify(a.hit_dist_m)}`)
      L.push(`  fire dist ${JSON.stringify(a.fire_dist_m)}`)
      L.push(`  rear dealt ${a.rear_dealt_pct}% ${JSON.stringify(a.rear_hits_dealt)} taken ${a.rear_taken_pct}%  laser charge ${JSON.stringify(a.laser_charge_s)}`)
      L.push(`  engagement ${JSON.stringify(a.engagement)}  reaction ${JSON.stringify(a.reaction_s)}`)
      L.push(`  combat motion ${JSON.stringify(a.combat_motion)}  retreat ${a.retreat_curve.map((b: any) => `${b.hp}:${b.away_pct}%(${b.frames})`).join(" ")}`)
      L.push(`  regen ${JSON.stringify(a.regen)}  ttk ${JSON.stringify(a.ttk_s)} hits ${JSON.stringify(a.ttk_hits)}`)
      L.push(`  economy ${JSON.stringify(a.economy)}`)
      L.push(`  zone ${JSON.stringify(a.zone)}`)
    }
  }
  console.log(L.join("\n"))
}
