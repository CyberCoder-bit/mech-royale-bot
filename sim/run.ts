/**
 * Batch runner.
 *   bun sim/run.ts --mode squad --seeds 48 --bot "bun src/main.ts" [--seed-start 1] [--jobs 12] [--replay runs/replays] [--out runs/x.json]
 *   bun sim/run.ts --mode ffa --seeds 48 --bot "bun src/main.ts" --field "inproc:src/bot.ts*4,house:expert*6,house:sniper*3,house:brawler*3"
 *   bun sim/run.ts --mode squad --seeds 48 --bot inproc:src/bot.ts
 *   bun sim/run.ts --compare runs/a.json runs/b.json
 * Extra: --squad "t_all=330,hunters_know_position=1,base_hunters=1,nonhunter_engage_m=60" --house "aim_mul=1,react_mul=1,lead_mul=1"
 *        --budget-ms 50 --stderr runs/logs --name label --quiet
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { ROOT } from "./config.ts"
import type { AgentSpec, MatchResult, MatchSpec } from "./runner.ts"

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith("--")) o[k] = true
      else {
        o[k] = v
        i++
      }
    } else pos.push(a)
  }
  return { o, pos }
}

export function parseAgent(s: string): AgentSpec {
  s = s.trim()
  if (s.startsWith("inproc:")) {
    const rest = s.slice(7)
    const at = rest.lastIndexOf("@")
    if (at > 0) return { type: "inproc", path: rest.slice(0, at), profile: rest.slice(at + 1) }
    return { type: "inproc", path: rest }
  }
  if (s.startsWith("house:")) return { type: "house", arch: s.slice(6) }
  return { type: "proc", cmd: s }
}

function parseField(s: string): AgentSpec[] {
  const out: AgentSpec[] = []
  for (const part of s.split(",")) {
    if (!part.trim()) continue
    const m = part.match(/^(.*)\*(\d+)$/)
    const spec = parseAgent(m ? m[1] : part)
    const n = m ? parseInt(m[2]) : 1
    for (let i = 0; i < n; i++) out.push(spec)
  }
  return out
}

function parseSquad(s: string | undefined): Record<string, number | boolean> {
  const o: Record<string, number | boolean> = {}
  if (!s) return o
  for (const kv of s.split(",")) {
    const [k, v] = kv.split("=")
    if (!k) continue
    if (v === "true" || v === "false") o[k] = v === "true"
    else if (k === "hunters_know_position") o[k] = v !== "0"
    else o[k] = parseFloat(v)
  }
  return o
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
const se = (a: number[]) => {
  if (a.length < 2) return 0
  const m = mean(a)
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length)
}
const f2 = (x: number) => x.toFixed(2)

export function summarize(results: MatchResult[]) {
  const pts = results.map((r) => r.test.points)
  const surv = results.map((r) => r.test.deathT ?? r.t)
  const kills = results.map((r) => r.test.kills)
  const causes: Record<string, number> = {}
  for (const r of results) {
    const c = r.test.cause === null ? "survived" : r.test.cause + (r.test.killedBy ? "" : "")
    causes[c] = (causes[c] ?? 0) + 1
  }
  const field: Record<string, { n: number; pts: number[]; deaths: Record<string, number> }> = {}
  for (const r of results)
    for (const f of r.field) {
      const e = (field[f.spec] ??= { n: 0, pts: [], deaths: {} })
      e.n++
      e.pts.push(f.points)
      const c = f.cause === null ? "survived" : f.killedBy === null ? f.cause : f.killedBy.startsWith("house:") ? `${f.cause}(house)` : `${f.cause}(test/other)`
      e.deaths[c] = (e.deaths[c] ?? 0) + 1
    }
  return {
    n: results.length,
    mean_points: mean(pts),
    se_points: se(pts),
    mean_survival_s: mean(surv),
    mean_kills: mean(kills),
    win_rate: results.filter((r) => r.test.place === 1).length / Math.max(1, results.length),
    death_causes: causes,
    late_answers: results.reduce((s, r) => s + r.test.late, 0),
    missed_answers: results.reduce((s, r) => s + r.test.missed, 0),
    crashes: results.filter((r) => r.test.crashed).length,
    mean_stuck_s: mean(results.map((r) => r.test.stuckSeconds)),
    mean_zone_s: mean(results.map((r) => r.test.zoneSeconds)),
    mean_idle_s: mean(results.map((r) => r.test.idleSeconds)),
    mean_rear_hits: mean(results.map((r) => r.test.rearHits)),
    mean_cubes_max: mean(results.map((r) => r.test.cubesMax)),
    ans_p99_max_ms: Math.max(0, ...results.map((r) => r.test.ansP99)),
    ans_max_ms: Math.max(0, ...results.map((r) => r.test.ansMax)),
    mean_wall_s: mean(results.map((r) => r.wallMs / 1000)),
    field: Object.fromEntries(Object.entries(field).map(([k, v]) => [k, { n: v.n, mean_points: mean(v.pts), deaths: v.deaths }])),
  }
}

function printSummary(label: string, s: ReturnType<typeof summarize>) {
  const L = (k: string, v: string) => console.log(`  ${k.padEnd(22)} ${v}`)
  console.log(`\n=== ${label} ===`)
  L("matches", String(s.n))
  L("points (16-place)", `${f2(s.mean_points)} ± ${f2(s.se_points)}`)
  L("win rate", `${(s.win_rate * 100).toFixed(1)}%`)
  L("survival s", f2(s.mean_survival_s))
  L("kills", f2(s.mean_kills))
  L("max cubes", f2(s.mean_cubes_max))
  L("death causes", Object.entries(s.death_causes).map(([k, v]) => `${k}:${v}`).join("  "))
  L("rear hits taken", f2(s.mean_rear_hits))
  L("zone s / stuck s", `${f2(s.mean_zone_s)} / ${f2(s.mean_stuck_s)}`)
  L("late/missed answers", `${s.late_answers} / ${s.missed_answers}  (idle s ${f2(s.mean_idle_s)}, crashes ${s.crashes})`)
  L("answer ms p99/max", `${f2(s.ans_p99_max_ms)} / ${f2(s.ans_max_ms)}`)
  L("wall s per match", f2(s.mean_wall_s))
  console.log("  field (mean points, deaths):")
  for (const [k, v] of Object.entries(s.field)) console.log(`    ${k.padEnd(28)} n=${String(v.n).padEnd(4)} pts ${f2(v.mean_points).padStart(6)}  ${Object.entries(v.deaths).map(([a, b]) => `${a}:${b}`).join(" ")}`)
}

function compare(a: string, b: string) {
  const A = JSON.parse(readFileSync(a, "utf8"))
  const B = JSON.parse(readFileSync(b, "utf8"))
  const mb = new Map<number, MatchResult>(B.results.map((r: MatchResult) => [r.seed, r]))
  const diffs: number[] = []
  const pa: number[] = [],
    pb: number[] = []
  for (const r of A.results as MatchResult[]) {
    const o = mb.get(r.seed)
    if (!o) continue
    diffs.push(r.test.points - o.test.points)
    pa.push(r.test.points)
    pb.push(o.test.points)
  }
  console.log(`paired seeds: ${diffs.length}`)
  console.log(`A ${a}: ${f2(mean(pa))} ± ${f2(se(pa))}`)
  console.log(`B ${b}: ${f2(mean(pb))} ± ${f2(se(pb))}`)
  console.log(`A - B: ${f2(mean(diffs))} ± ${f2(se(diffs))} (n=${diffs.length}); A better on ${diffs.filter((d) => d > 0).length}, worse on ${diffs.filter((d) => d < 0).length}`)
}

async function main() {
  const { o, pos } = parseArgs(process.argv.slice(2))
  if (o.compare) {
    compare(String(o.compare), pos[0])
    return
  }
  const mode = (o.mode as string) === "ffa" ? "ffa" : "squad"
  const nSeeds = parseInt((o.seeds as string) ?? "8")
  const seedStart = parseInt((o["seed-start"] as string) ?? "1")
  const jobs = Math.max(1, Math.min(parseInt((o.jobs as string) ?? "12"), nSeeds))
  const botStr = (o.bot as string) ?? "inproc:src/bot.ts"
  const test = parseAgent(botStr)
  let field: AgentSpec[]
  if (o.field) field = parseField(o.field as string)
  else if (mode === "squad") field = parseField("house:easy*4,house:medium*4,house:hard*4,house:expert*3")
  else field = parseField("house:expert*6,house:sniper*3,house:brawler*3,house:thirdparty*2,house:farmer*1")
  const squad = parseSquad(o.squad as string | undefined)
  const house = parseSquad(o.house as string | undefined) as Record<string, number>
  const replayDir = o.replay ? String(o.replay) : null
  const label = (o.name as string) ?? `${mode}_${botStr.replace(/[^a-zA-Z0-9]+/g, "_")}`
  const outPath = (o.out as string) ?? join(ROOT, "runs", `${label}_${Date.now()}.json`)
  const stderrDir = o.stderr ? String(o.stderr) : null
  if (stderrDir) mkdirSync(stderrDir, { recursive: true })
  const specs: MatchSpec[] = []
  for (let i = 0; i < nSeeds; i++) {
    const seed = seedStart + i
    specs.push({ seed, mode, test, field, squad, house, replay: replayDir ? join(replayDir, `${label}_seed${seed}.jsonl.gz`) : null, budgetMs: o["budget-ms"] ? parseFloat(o["budget-ms"] as string) : undefined, stderrDir })
  }
  const t0 = performance.now()
  const results: MatchResult[] = []
  const errors: any[] = []
  // worker pool
  let next = 0
  let done = 0
  await new Promise<void>((resolveAll) => {
    const workers: any[] = []
    const startWorker = () => {
      const p = Bun.spawn(["bun", join(ROOT, "sim/worker.ts")], { cwd: ROOT, stdin: "pipe", stdout: "pipe", stderr: "inherit" })
      const w = { p, busy: false }
      workers.push(w)
      const feed = () => {
        if (next < specs.length) {
          const s = specs[next++]
          p.stdin.write(JSON.stringify(s) + "\n")
          p.stdin.flush()
          w.busy = true
        } else {
          p.stdin.end()
        }
      }
      ;(async () => {
        const reader = p.stdout.getReader()
        const dec = new TextDecoder()
        let buf = ""
        while (true) {
          const { value, done: eof } = await reader.read()
          if (eof) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (!line.trim()) continue
            let msg: any
            try {
              msg = JSON.parse(line)
            } catch {
              continue
            }
            done++
            if (msg.ok) {
              results.push(msg.res)
              const r: MatchResult = msg.res
              if (!o.quiet) process.stderr.write(`[${done}/${specs.length}] seed ${r.seed}: place ${r.test.place} (pts ${r.test.points}) t=${(r.test.deathT ?? r.t).toFixed(1)}s kills ${r.test.kills} cause ${r.test.cause ?? "-"} wall ${(r.wallMs / 1000).toFixed(1)}s\n`)
            } else {
              errors.push(msg)
              process.stderr.write(`[${done}/${specs.length}] seed ${msg.seed}: ERROR ${msg.error}\n`)
            }
            if (done >= specs.length) resolveAll()
            feed()
          }
        }
      })()
      feed()
    }
    for (let i = 0; i < jobs; i++) startWorker()
  })
  const wall = (performance.now() - t0) / 1000
  results.sort((a, b) => a.seed - b.seed)
  const summary = summarize(results)
  const out = { label, mode, bot: botStr, field: field.map((f) => (f.type === "house" ? `house:${f.arch}` : f.type === "inproc" ? `inproc:${f.path}` : f.cmd)), squad, house, seeds: [seedStart, seedStart + nSeeds - 1], wall_s: wall, matches_per_min: (results.length / wall) * 60, summary, errors, results }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(out, null, 1))
  printSummary(label, summary)
  console.log(`  throughput             ${f2(out.matches_per_min)} matches/min (${jobs} jobs, ${f2(wall)} s)`)
  if (errors.length) console.log(`  ERRORS: ${errors.length}`)
  console.log(`  saved ${outPath}`)
  process.exit(0)
}

if (import.meta.main) main()
