/** Match worker: reads MatchSpec JSON lines on stdin, writes MatchResult JSON lines on stdout. */
import { runMatch, type MatchSpec } from "./runner.ts"

const queue: MatchSpec[] = []
let busy = false
let closed = false

async function pump() {
  if (busy) return
  busy = true
  while (queue.length) {
    const spec = queue.shift()!
    try {
      const res = await runMatch(spec)
      process.stdout.write(JSON.stringify({ ok: true, res }) + "\n")
    } catch (e: any) {
      process.stdout.write(JSON.stringify({ ok: false, seed: spec.seed, error: String(e?.stack ?? e) }) + "\n")
    }
  }
  busy = false
  if (closed) process.exit(0)
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (c: string) => {
  buf += c
  let i: number
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) queue.push(JSON.parse(line))
  }
  pump()
})
process.stdin.on("end", () => {
  closed = true
  if (!busy) process.exit(0)
})
