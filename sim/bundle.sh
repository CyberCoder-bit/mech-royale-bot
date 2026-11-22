#!/usr/bin/env bash
# Bundle the bot at a git ref into one in-process module for the simulator:
#   sim/bundle.sh <git-ref> [out.js]      e.g. sim/bundle.sh v3 runs/bots/v3.js
# then: bun sim/run.ts --mode ffa --bot "bun src/main.ts" --field "inproc:runs/bots/v3.js*4,house:top*6"
# The bundle exports makeBot and the module's `draw` singleton (the sim clears it after every act).
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${1:?git ref}"
OUT="${2:-runs/bots/$(echo "$REF" | tr -c 'a-zA-Z0-9_.-' '_').js}"
TMP="runs/bots/.src_$(echo "$REF" | tr -c 'a-zA-Z0-9_.-' '_')"
rm -rf "$TMP"
mkdir -p "$TMP" "$(dirname "$OUT")"
git archive "$REF" src | tar -x -C "$TMP"
# data/ (precomputed map data) if the ref has it
git archive "$REF" data 2>/dev/null | tar -x -C "$TMP" 2>/dev/null || true
cat > "$TMP/entry.ts" <<'EOF'
export { makeBot } from "./src/bot.ts"
export { draw } from "./src/mechfight.ts"
EOF
bun build "$TMP/entry.ts" --target=bun --outfile "$OUT" > /dev/null
echo "bundled $REF -> $OUT"
