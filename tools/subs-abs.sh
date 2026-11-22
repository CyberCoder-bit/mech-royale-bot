#!/usr/bin/env bash
# Like subs.sh but reads the newest Playwright snapshot from the main repo by absolute path (usable from any cwd).
P=/home/jason/builders/mech_royale/.playwright-mcp
f=$(ls -t $P/page-*.yml 2>/dev/null | head -1)
[ -z "$f" ] && { echo "no snapshot"; exit 1; }
date +%H:%M:%S
grep -m1 -o '[0-9] of [0-9] left this hour' "$f"
awk '/Your team.s submissions/{on=1} on{print} /At the cutoff your best score/{if(on) exit}' "$f" | sed -E 's/\[ref=[^]]*\]//g' | grep -E 'BB-|Queued|Scoring|Scored|"[0-9#]|in line|waiting|@ |Entered' | head -${1:-14}
grep -n -E 'textbox "(Public|Commit)|button "Submit"' "$f" | sed -E 's/.*(textbox "[A-Za-z]+|button "Submit").*\[ref=([^]]+)\].*/\1 \2/' | head -3
