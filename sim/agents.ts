/**
 * Bot drivers: subprocess bots speaking mechfight/1 over stdin/stdout (exactly like kit/check/check.py
 * and the real server), and in-process bots exposing makeBot(hello) -> { act(obs) }.
 */
import type { BotAction, Hello, Observation, Bot } from "../src/mechfight.ts"
import { ROOT } from "./config.ts"
import { resolve, dirname, join } from "node:path"
import { existsSync } from "node:fs"

export interface Agent {
  name: string
  kind: "proc" | "inproc" | "house"
  /** start the bot; resolves when ready (or failed) */
  init(hello: Hello): Promise<boolean>
  /** subprocess: send obs now (non-blocking) */
  send?(obs: Observation): void
  /** subprocess: wait for the answer to `tick` until `deadline` (performance.now ms) */
  recv?(tick: number, deadline: number): Promise<{ action: BotAction | null; ms: number; late: boolean }>
  /** in-process: compute the action */
  act?(obs: Observation): BotAction
  end(place: number, kills: number): void
  crashed?: boolean
  readyMs?: number
  badLines?: number
}

// ------------------------------------------------------------------ subprocess
export function splitCmd(cmd: string): string[] {
  const out: string[] = []
  let cur = ""
  let q: string | null = null
  for (const ch of cmd) {
    if (q) {
      if (ch === q) q = null
      else cur += ch
    } else if (ch === '"' || ch === "'") q = ch
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ""
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

export class ProcAgent implements Agent {
  kind = "proc" as const
  name: string
  cmd: string[]
  proc: any = null
  lines: { at: number; line: string }[] = []
  waiter: (() => void) | null = null
  exited = false
  crashed = false
  readyMs = 0
  badLines = 0
  stderrPath: string | null
  maxLine = 65536
  constructor(cmd: string, name?: string, stderrPath: string | null = null) {
    this.cmd = splitCmd(cmd)
    this.name = name ?? cmd
    this.stderrPath = stderrPath
  }

  private wake() {
    const w = this.waiter
    this.waiter = null
    if (w) w()
  }

  async init(hello: Hello): Promise<boolean> {
    const t0 = performance.now()
    try {
      this.proc = Bun.spawn(this.cmd, {
        cwd: ROOT,
        stdin: "pipe",
        stdout: "pipe",
        stderr: this.stderrPath ? Bun.file(this.stderrPath) : "ignore",
      })
    } catch (e) {
      this.crashed = true
      this.exited = true
      return false
    }
    this.readLoop()
    this.write(JSON.stringify(hello) + "\n")
    const budget = hello.config.bot.hello_budget_ms ?? 20000
    const deadline = t0 + budget
    while (true) {
      const l = await this.nextLine(deadline)
      if (!l) {
        this.crashed = true
        return false
      }
      try {
        const m = JSON.parse(l.line)
        if (m && m.type === "ready") {
          if (typeof m.name === "string" && m.name) this.name = m.name.slice(0, 32)
          this.readyMs = performance.now() - t0
          return true
        }
      } catch {
        this.badLines++
      }
    }
  }

  private async readLoop() {
    const reader = this.proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ""
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (line.trim()) this.lines.push({ at: performance.now(), line })
        }
        if (this.lines.length) this.wake()
      }
    } catch {}
    this.exited = true
    this.wake()
  }

  private write(s: string) {
    if (this.exited || !this.proc) return
    try {
      this.proc.stdin.write(s)
      this.proc.stdin.flush()
    } catch {
      this.exited = true
    }
  }

  private nextLine(deadline: number): Promise<{ at: number; line: string } | null> {
    return new Promise((res) => {
      const check = () => {
        if (this.lines.length) return res(this.lines.shift()!)
        if (this.exited) return res(null)
        const left = deadline - performance.now()
        if (left <= 0) return res(null)
        const timer = setTimeout(() => {
          this.waiter = null
          check()
        }, Math.max(1, left))
        this.waiter = () => {
          clearTimeout(timer)
          check()
        }
      }
      check()
    })
  }

  sentAt = 0
  send(obs: Observation) {
    this.sentAt = performance.now()
    this.write(JSON.stringify(obs) + "\n")
  }

  async recv(tick: number, deadline: number): Promise<{ action: BotAction | null; ms: number; late: boolean }> {
    while (true) {
      const l = await this.nextLine(deadline)
      if (!l) return { action: null, ms: performance.now() - this.sentAt, late: true }
      if (l.line.length > this.maxLine) {
        this.badLines++
        continue
      }
      let m: any
      try {
        m = JSON.parse(l.line)
      } catch {
        this.badLines++
        continue
      }
      if (!m || typeof m !== "object") {
        this.badLines++
        continue
      }
      if (m.tick !== tick) continue // stale answer to an older observation: dropped
      return { action: m as BotAction, ms: l.at - this.sentAt, late: false }
    }
  }

  end(place: number, kills: number) {
    this.write(JSON.stringify({ type: "end", place, kills }) + "\n")
    try {
      this.proc?.stdin.end()
    } catch {}
    const p = this.proc
    setTimeout(() => {
      try {
        p?.kill()
      } catch {}
    }, 2000).unref?.()
  }
  kill() {
    try {
      this.proc?.kill()
    } catch {}
  }
}

// ------------------------------------------------------------------ in-process
type Factory = (hello: Hello, profile?: string) => Bot
type DrawLike = { clear?: () => void; caps?: unknown }
const factoryCache = new Map<string, { f: Factory; draw: DrawLike | null }>()

/** load makeBot from a module; also find its mechfight `draw` singleton so in-process drawings can be discarded */
export async function loadFactory(path: string): Promise<{ f: Factory; draw: DrawLike | null }> {
  const abs = resolve(ROOT, path)
  let e = factoryCache.get(abs)
  if (!e) {
    const mod = await import(abs)
    const f = (mod.makeBot ?? mod.default?.makeBot ?? mod.default) as Factory
    if (typeof f !== "function") throw new Error(`${path} does not export makeBot`)
    let draw: DrawLike | null = mod.draw ?? null
    const mf = join(dirname(abs), "mechfight.ts")
    if (!draw && existsSync(mf)) {
      try {
        draw = (await import(mf)).draw ?? null
      } catch {}
    }
    e = { f, draw }
    factoryCache.set(abs, e)
  }
  return e
}

export class InprocAgent implements Agent {
  kind = "inproc" as const
  name: string
  path: string
  profile?: string
  bot: Bot | null = null
  last: BotAction = {}
  errors = 0
  crashed = false
  constructor(path: string, profile?: string, name?: string) {
    this.path = path
    this.profile = profile
    this.name = name ?? `inproc:${path}${profile ? "@" + profile : ""}`
  }
  draw: DrawLike | null = null
  async init(hello: Hello): Promise<boolean> {
    try {
      const { f, draw } = await loadFactory(this.path)
      this.draw = draw
      if (draw) draw.caps = hello.config.debug
      this.bot = this.profile !== undefined ? f(hello, this.profile) : f(hello)
      return true
    } catch (e) {
      console.error(`[sim] in-process bot ${this.path} failed to start:`, e)
      this.crashed = true
      return false
    }
  }
  act(obs: Observation): BotAction {
    if (!this.bot) return {}
    try {
      this.draw?.clear?.()
      const a = { ...this.bot.act(obs) }
      this.draw?.clear?.()
      this.last = { move: a.move, aim: a.aim, boost: a.boost }
      a.tick = obs.tick
      return a
    } catch (e) {
      this.errors++
      if (this.errors <= 3) console.error(`[sim] ${this.name} act() threw at tick ${obs.tick}:`, e)
      return { ...this.last, tick: obs.tick }
    }
  }
  end() {}
}
