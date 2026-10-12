#!/bin/sh
# One contest trial, following docs/agents/dogfood.md verbatim (session-dir
# artifacts, watchdog, stdin closed, explicit provider/model), then the base
# audit - and, for arm A, the selected-file audit - then evidence capture on
# the branch. Usage: prototype/run-trial.sh <A|B> <run-number> "<prompt>"
arm="${1:?arm}"; n="${2:?run number}"; prompt="${3:?prompt}"
cd "$(dirname "$0")/.." || exit 1
tag="dogfood-proto${arm}-${n}"
short=$(git rev-parse --short HEAD)
sd="${TMPDIR:-/tmp}/${tag}-${short}"
mkdir "$sd" || { echo "session dir exists: $sd" >&2; exit 1; }

st=$(git status --porcelain --untracked-files=all) || { echo "git status failed"; exit 1; }
[ -n "$st" ] && { echo "working tree dirty - commit first"; exit 1; }
git rev-parse HEAD > "$sd/pre-head"
printf '%s' "$prompt" > "$sd/prompt.txt"
printf '%s\n' "zai-coding-cn glm-5.3-flash" > "$sd/expected-model"
node -p "require('crypto').createHash('sha256').update(require('fs').readFileSync('package.json')).digest('hex')" > "$sd/manifest-sha256"
pi --version > "$sd/pi-version"
node --version > "$sd/node-version"

node bin/theta.mjs --dev --provider zai-coding-cn --model glm-5.3-flash \
	--session-dir "$sd" --print "$prompt" 2> "$sd/stderr.txt" < /dev/null &
pid=$!
( sleep 300; echo fired > "$sd/watchdog" 2>/dev/null; kill $pid 2>/dev/null; sleep 15; kill -9 $pid 2>/dev/null ) & watchdog=$!
wait $pid
echo $? > "$sd/exit-status"
pkill -P $watchdog 2>/dev/null; kill $watchdog 2>/dev/null

# Audit while the tree is still clean at pre-head (the auditor re-checks both).
node scripts/audit-dogfood.mjs "$sd" > "$sd/attestation.txt" 2>&1
base=$?
sel=skip
if [ "$arm" = "A" ]; then
	node scripts/audit-dogfood.mjs "$sd" skills/theta-lit-probe/SKILL.md > "$sd/attestation-selected.txt" 2>&1
	sel=$?
fi

# Clear skill-script scratch (dogfood.md), then capture evidence on the branch.
find skills -type d \( -name __pycache__ -o -name '.venv*' \) -prune -exec rm -rf {} +
mkdir -p prototype/evidence
cp -R "$sd" "prototype/evidence/$(basename "$sd")"
git add -A
git commit -q -m "chore: contest evidence ${tag} (prototype)"
echo "trial ${tag}: exit=$(cat "$sd/exit-status") base-audit=${base} selected-audit=${sel} evidence=prototype/evidence/$(basename "$sd")"
