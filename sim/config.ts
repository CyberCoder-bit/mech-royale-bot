/** Default rule set: the real `hello.config` recorded in kit/check/stream.jsonl.gz. */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join, dirname } from "node:path"
import type { Config } from "../src/mechfight.ts"

export const ROOT = join(dirname(new URL(import.meta.url).pathname), "..")
export const KIT = join(ROOT, "kit")
export const MAP_DIR = join(KIT, "arena")

let cfg: Config | null = null
export function defaultConfig(): Config {
  if (!cfg) {
    const raw = gunzipSync(readFileSync(join(KIT, "check/stream.jsonl.gz"))).toString("utf8")
    const first = raw.slice(0, raw.indexOf("\n"))
    cfg = JSON.parse(first).config as Config
  }
  return JSON.parse(JSON.stringify(cfg))
}

export const WEAPON_KINDS = ["gun", "mortar", "laser", "lightning"] as const
