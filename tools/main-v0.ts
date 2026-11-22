/** Subprocess entry for the v0 bot (timing comparisons in the sim's subprocess mode). */
import { run } from "../src/mechfight.ts"
import { makeBotV0 } from "../src/bot_v0.ts"

run((hello) => makeBotV0(hello))
