/** Entry point for the container: speak mechfight/1 on stdin/stdout. */
import { run } from "./mechfight.ts"
import { makeBot } from "./bot.ts"

run(makeBot)
