#!/usr/bin/env bash
# Print the "Your team's submissions" section and the hourly quota from the newest Playwright snapshot.
f=$(ls -t .playwright-mcp/page-*.yml 2>/dev/null | head -1)
[ -z "$f" ] && { echo "no snapshot"; exit 1; }
grep -m1 -o '[0-9] of [0-9] left this hour' "$f"
awk '/Your team.s submissions/{on=1} on{print} /At the cutoff your best score/{if(on) exit}' "$f" | sed -E 's/\[ref=[^]]*\]//g; s/^ +- //; s/generic : //' | grep -v -E '^(list|listitem|generic)( |:|$)' | head -${1:-60}
