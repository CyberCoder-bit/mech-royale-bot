#!/usr/bin/env bun
/**
 * Aggregate several mechreplay/1 files (e.g. recorded showdown casts) per mech name (team) or archetype.
 *
 *   bun tools/cast-teams.ts <file-or-dir> [more files/dirs...] [--json]
 *
 * Runs tools/replay-summary.ts --json on each file and pools the per-mech results by name.
 * Directories are scanned for *.jsonl and *.jsonl.gz (files without a result line or with < 100 frames are skipped).
 */
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const inputs = args.filter((a) => !a.startsWith("--"))
const files: string[] = []
for (const p of inputs) {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) { if (/\.jsonl(\.gz)?$/.test(f)) files.push(join(p, f)) }
  else files.push(p)
}
if (!files.length) { console.error("usage: bun tools/cast-teams.ts <file-or-dir>... [--json]"); process.exit(2) }

const tool = join(import.meta.dir, "replay-summary.ts")
const q = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), x = (s.length - 1) * p, i = Math.floor(x); return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (x - i) : s[i] }
const r1 = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d)
const sumObj = (into: Record<string, number>, o: Record<string, number> | undefined) => { for (const [k, v] of Object.entries(o ?? {})) into[k] = (into[k] ?? 0) + v }

interface Team { name: string; matches: number; places: number[]; survival: number[]; kills: number; dmgDealt: number; dmgTaken: number; gunHits: number; gunShotsAtMechs: number;
  laserHit: number; laserShots: number; zapsHitMech: number; zaps: number; mortarHit: number; mortarShells: number; hitDistGun: number[]; hitDistLaser: number[];
  engStart: number[]; still: number[]; boost: number[]; air: number[]; speed: number[]; elevated: number[]; zoneOut: number; zoneDmg: number; cubesMax: number[]; drops: number;
  rearDealt: number; hitsDealt: number; rearTaken: number; hitsTaken: number; loadouts: Record<string, number>; firstWeapon: (number | null)[]; upgrades: Record<string, number>;
  killedWith: Record<string, number>; dmgByW: Record<string, number>; marginMin: number[]; laserHold: number[] }
const teams = new Map<string, Team>()
const used: { file: string; seed: any; duration: number; winner: string | null }[] = []
for (const f of files) {
  const p = Bun.spawnSync(["bun", tool, f, "--json"], { stdout: "pipe", stderr: "pipe" })
  if (p.exitCode !== 0) { console.error(`skip ${f}: ${p.stderr.toString().slice(0, 200)}`); continue }
  let S: any
  try { S = JSON.parse(p.stdout.toString()) } catch { console.error(`skip ${f}: bad json`); continue }
  if (S.meta.frames < 100) { console.error(`skip ${f}: only ${S.meta.frames} frames`); continue }
  const dur = S.meta.duration_s
  used.push({ file: f, seed: S.meta.seed, duration: dur, winner: S.mechs.find((m: any) => m.place === 1)?.name ?? null })
  for (const m of S.mechs) {
    const key = m.archetype ?? m.name
    let t = teams.get(key)
    if (!t) {
      t = { name: key, matches: 0, places: [], survival: [], kills: 0, dmgDealt: 0, dmgTaken: 0, gunHits: 0, gunShotsAtMechs: 0, laserHit: 0, laserShots: 0, zapsHitMech: 0, zaps: 0,
        mortarHit: 0, mortarShells: 0, hitDistGun: [], hitDistLaser: [], engStart: [], still: [], boost: [], air: [], speed: [], elevated: [], zoneOut: 0, zoneDmg: 0, cubesMax: [], drops: 0,
        rearDealt: 0, hitsDealt: 0, rearTaken: 0, hitsTaken: 0, loadouts: {}, firstWeapon: [], upgrades: {}, killedWith: {}, dmgByW: {}, marginMin: [], laserHold: [] }
      teams.set(key, t)
    }
    t.matches++
    if (m.place != null) t.places.push(m.place)
    t.survival.push(m.death_t ?? dur)
    t.kills += m.kills
    const dd = Object.values(m.damage_dealt.mech as Record<string, number>).reduce((a, b) => a + b, 0)
    t.dmgDealt += dd; sumObj(t.dmgByW, m.damage_dealt.mech)
    t.dmgTaken += Object.values(m.damage_taken as Record<string, number>).reduce((a, b) => a + b, 0)
    const g = m.accuracy.gun; if (g) { t.gunHits += g.hits_mech; t.gunShotsAtMechs += g.shots_at_mechs ?? 0 }
    const l = m.accuracy.laser; if (l) { t.laserHit += l.hit_mech; t.laserShots += l.shots }
    const z = m.accuracy.lightning; if (z) { t.zapsHitMech += z.hit_mech; t.zaps += z.zaps }
    const mo = m.accuracy.mortar; if (mo) { t.mortarHit += mo.shells_hit_mech; t.mortarShells += mo.shells }
    if (m.hit_dist_m.gun?.median != null) t.hitDistGun.push(m.hit_dist_m.gun.median)
    if (m.hit_dist_m.laser?.median != null) t.hitDistLaser.push(m.hit_dist_m.laser.median)
    for (const e of S.engagements ?? []) if (e.shooter === m.id && e.dist != null) t.engStart.push(e.dist)
    const mv = m.movement
    t.still.push(mv.still_pct ?? 0); t.boost.push(mv.boost_pct ?? 0); t.air.push(mv.airborne_pct ?? 0); if (mv.speed.median != null) t.speed.push(mv.speed.median)
    if (mv.elevated_grounded_s != null) t.elevated.push(mv.elevated_grounded_s)
    t.zoneOut += m.zone.out_s ?? 0; t.zoneDmg += m.zone.dmg ?? 0; if (m.zone.margin_m_min != null) t.marginMin.push(m.zone.margin_m_min)
    t.cubesMax.push(m.cubes_max); t.drops += m.drops_taken
    t.rearDealt += m.rear.dealt; t.hitsDealt += m.rear.dealt_of; t.rearTaken += m.rear.taken; t.hitsTaken += m.rear.taken_of
    const lo = m.loadout_timeline[m.loadout_timeline.length - 1]?.[1]?.filter(Boolean).join("+") ?? "?"
    t.loadouts[lo] = (t.loadouts[lo] ?? 0) + 1
    t.firstWeapon.push(m.first_weapon_t)
    for (const [, u] of m.upgrades) t.upgrades[u] = (t.upgrades[u] ?? 0) + 1
    const kw = m.death_t == null ? "survived" : m.killed_with ?? "?"
    t.killedWith[kw] = (t.killedWith[kw] ?? 0) + 1
    if (m.laser_hold_s?.median != null) t.laserHold.push(m.laser_hold_s.median)
  }
}
const pct = (a: number, b: number) => (b > 0 ? r1((100 * a) / b) : null)
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const rows = [...teams.values()].map((t) => ({
  team: t.name, matches: t.matches, mean_place: r1(mean(t.places), 2), points: t.places.reduce((a, p) => a + 16 - p, 0), wins: t.places.filter((p) => p === 1).length,
  survival_s: r1(mean(t.survival)), kills_per_match: r1(t.kills / t.matches, 2), dmg_dealt_per_match: Math.round(t.dmgDealt / t.matches), dmg_taken_per_match: Math.round(t.dmgTaken / t.matches),
  dmg_by_weapon: Object.fromEntries(Object.entries(t.dmgByW).map(([k, v]) => [k, Math.round(v)])),
  gun_acc_vs_mech_pct: pct(t.gunHits, t.gunShotsAtMechs), gun_shots_at_mechs: t.gunShotsAtMechs, laser_acc_pct: pct(t.laserHit, t.laserShots), laser_shots: t.laserShots,
  lightning_zaps: t.zaps, lightning_hit_mech_pct: pct(t.zapsHitMech, t.zaps), mortar_shells: t.mortarShells, mortar_hit_pct: pct(t.mortarHit, t.mortarShells),
  gun_hit_dist_median: r1(q(t.hitDistGun, 0.5), 0), laser_hit_dist_median: r1(q(t.hitDistLaser, 0.5), 0),
  engage_start_median: r1(q(t.engStart, 0.5), 0), engage_start_p90: r1(q(t.engStart, 0.9), 0), engagements: t.engStart.length,
  still_pct: r1(mean(t.still)), boost_pct: r1(mean(t.boost)), airborne_pct: r1(mean(t.air)), speed_median: r1(mean(t.speed)), elevated_s: r1(mean(t.elevated)),
  zone_out_s: r1(t.zoneOut / t.matches), zone_dmg_per_match: Math.round(t.zoneDmg / t.matches), zone_margin_min: r1(Math.min(...t.marginMin), 0),
  cubes_max_mean: r1(mean(t.cubesMax)), drops: t.drops, rear_dealt_pct: pct(t.rearDealt, t.hitsDealt), rear_taken_pct: pct(t.rearTaken, t.hitsTaken),
  loadouts: t.loadouts, first_weapon_t: t.firstWeapon, upgrades: t.upgrades, death_by: t.killedWith, laser_hold_median: r1(q(t.laserHold, 0.5), 2),
})).sort((a, b) => (a.mean_place ?? 99) - (b.mean_place ?? 99))

if (asJson) console.log(JSON.stringify({ files: used, teams: rows }, null, 1))
else {
  console.log(`files: ${used.length}`)
  for (const u of used) console.log(`  ${u.file}  seed=${u.seed} ${u.duration}s winner=${u.winner}`)
  console.log("\nteam | n | place | pts | wins | surv s | kills | dmg out | dmg in | gun acc% (shots) | laser acc% (n) | zaps | gun hit d | eng start med/p90 | still% | boost% | air% | elev s | zone out s | cubes | drops | rear out/in % | loadout")
  for (const r of rows) {
    console.log([r.team, r.matches, r.mean_place, r.points, r.wins, r.survival_s, r.kills_per_match, r.dmg_dealt_per_match, r.dmg_taken_per_match,
      `${r.gun_acc_vs_mech_pct} (${r.gun_shots_at_mechs})`, `${r.laser_acc_pct} (${r.laser_shots})`, r.lightning_zaps, r.gun_hit_dist_median,
      `${r.engage_start_median}/${r.engage_start_p90}`, r.still_pct, r.boost_pct, r.airborne_pct, r.elevated_s, r.zone_out_s, r.cubes_max_mean, r.drops,
      `${r.rear_dealt_pct}/${r.rear_taken_pct}`, Object.entries(r.loadouts).map(([k, v]) => `${k}x${v}`).join(",")].join(" | "))
  }
  console.log("\nupgrades / first weapon t / death by:")
  for (const r of rows) console.log(`  ${r.team}: ${JSON.stringify(r.upgrades)} | ${JSON.stringify(r.first_weapon_t)} | ${JSON.stringify(r.death_by)} | dmg ${JSON.stringify(r.dmg_by_weapon)} | laser hold ${r.laser_hold_median}`)
}
