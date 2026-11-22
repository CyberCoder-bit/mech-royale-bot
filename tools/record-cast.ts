/**
 * Record the public Buildathon cast (top teams' bots, head to head) to mechreplay/1 files.
 * The cast's stage socket streams newline-separated replay lines; a new match starts with a "header" line.
 *
 *   bun tools/record-cast.ts [outDir=runs/cast] [url=wss://watch.joinbuilders.org/live]
 *
 * Also logs what the show says is airing (ws /state) so recordings can be matched to team names.
 */
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs"

const outDir = process.argv[2] ?? "runs/cast"
const liveUrl = process.argv[3] ?? "wss://watch.joinbuilders.org/live"
const stateUrl = liveUrl.replace(/\/live$/, "/state")
mkdirSync(outDir, { recursive: true })

let file: string | null = null
let lines = 0
let lastSeed = ""
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-")

function startFile(header: { seed?: unknown }) {
  file = `${outDir}/cast-${stamp()}-seed${header.seed ?? "x"}.jsonl`
  lines = 0
  console.error(`[cast] new match -> ${file}`)
}

function onLine(raw: string) {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (msg.type === "header") {
    const key = `${msg.seed}|${JSON.stringify(msg.bots ?? "")}`
    if (key !== lastSeed || !file) startFile(msg)
    else return // same match header re-sent on reconnect: keep appending to the same file
    lastSeed = key
  }
  if (!file) return
  appendFileSync(file, raw + "\n")
  lines++
  if (msg.type === "result") console.error(`[cast] result written (${lines} lines)`)
}

function connectLive(attempt = 0) {
  const ws = new WebSocket(liveUrl)
  ws.onopen = () => console.error(`[cast] live connected`)
  ws.onmessage = (m) => {
    for (const l of String(m.data).split("\n")) if (l.trim()) onLine(l)
  }
  ws.onclose = () => {
    console.error(`[cast] live closed; reconnecting`)
    setTimeout(() => connectLive(attempt + 1), Math.min(10000, 1000 * (attempt + 1)))
  }
  ws.onerror = () => {}
}

function connectState(attempt = 0) {
  const ws = new WebSocket(stateUrl)
  ws.onmessage = (m) => {
    try {
      const d = JSON.parse(String(m.data))
      if (d.type === "state") writeFileSync(`${outDir}/state-latest.json`, JSON.stringify(d, null, 1))
      appendFileSync(`${outDir}/state.log`, `${new Date().toISOString()} ${String(m.data).slice(0, 4000)}\n`)
    } catch {}
  }
  ws.onclose = () => setTimeout(() => connectState(attempt + 1), Math.min(30000, 2000 * (attempt + 1)))
  ws.onerror = () => {}
}

connectLive()
connectState()
