#!/bin/sh
# Toggle the contest's active arm as a commit. The dogfood launch gate refuses
# a dirty tree, and the auditor binds each run's advertised skills to the
# expected-skills.json inventory at that HEAD, so arm state must be committed,
# not parked as untracked copies. Usage: prototype/set-arm.sh A|B
set -e
cd "$(dirname "$0")/.."
arm="${1:?usage: set-arm.sh A|B}"
case "$arm" in
A)
	rm -rf skills/theta-lit-probe extensions/lit-probe.ts
	cp -R prototype/arms/skill/theta-lit-probe skills/theta-lit-probe
	cp prototype/arms/expected-skills.armA.json test/expected-skills.json
	;;
B)
	rm -rf skills/theta-lit-probe extensions/lit-probe.ts
	cp prototype/arms/tool/lit-probe.ts extensions/lit-probe.ts
	cp prototype/arms/expected-skills.armB.json test/expected-skills.json
	;;
*)
	echo "unknown arm: $arm" >&2
	exit 1
	;;
esac
git add -A
git commit -q -m "chore: contest arm $arm state (prototype)"
git log --oneline -1
