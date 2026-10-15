// Strike-completeness gate: before a strike's PR goes ready, every child
// of the spec issue must be landed on this branch (a commit referencing
// its number) or already closed. A closeout ticket — the merge/publish
// steps that run after the merge — is the expected open exception.
//
// Evidence freshness (#27, M2 retro): when the PR body carries a dogfood
// attestation (`clean <sha>` from audit-dogfood.mjs), that SHA must equal
// HEAD. Evidence goes stale on the next commit (dogfood.md's batch rule),
// and M2 marked stale evidence ready twice — the ready gate is where that
// bites. No attestation in the body (chore strikes) passes with a note.
//
// Usage: node scripts/check-strike.mjs <spec-issue-number>
// Exit 0 = complete (or only expected exceptions remain); 1 = a child is
// open with no branch commit, or attested evidence is stale; 2 = usage or
// tracker error.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = "hugolld/theta-agent";

// The pure half of the evidence-freshness gate: every `clean <sha>`
// attestation in the PR body must name the branch HEAD. Prose "clean"
// never matches — only the 40-hex token does — and no attestation at all
// is a pass (chore strikes carry no dogfood pair), not a failure.
export function evidenceFreshness(prBody, head) {
	const attested = [
		...`${prBody ?? ""}`.matchAll(/\bclean\s+([0-9a-f]{40})\b/g),
	].map((match) => match[1]);
	if (attested.length === 0) return { verdict: "none", attested };
	const unique = [...new Set(attested)];
	return unique.length === 1 && unique[0] === head
		? { verdict: "fresh", attested: unique }
		: { verdict: "stale", attested: unique };
}

function main(argv) {
	const spec = argv[0];
	if (!spec || !/^\d+$/.test(spec)) {
		console.error("usage: node scripts/check-strike.mjs <spec-issue-number>");
		return 2;
	}
	const run = (cmd) => {
		try {
			// stderr is piped, not inherited: a failed gh call (no PR yet, no
			// network) must read as an empty string, not dump usage help.
			return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			return "";
		}
	};

	// Children declare their parent ("## Parent" naming the spec number) —
	// matching the spec's body would false-positive on PR references.
	const issues = run(
		`gh issue list --repo ${repo} --state all --limit 200 --json number,title,state,body`,
	);
	if (!issues) {
		console.error(`cannot list issues on ${repo} — is gh authenticated?`);
		return 2;
	}
	const parent = new RegExp(`#${spec}\\b`);
	const children = JSON.parse(issues).filter((i) => parent.test(i.body ?? ""));
	if (children.length === 0) {
		console.error(`no issues name #${spec} as parent`);
		return 2;
	}

	// A child is landed when some commit on this branch references its number.
	const branchLog = run("git log --oneline origin/main..HEAD");
	let missing = 0;
	for (const i of children) {
		const landed = new RegExp(`#${i.number}\\b`).test(branchLog);
		if (i.state.toUpperCase() === "CLOSED" || landed) {
			console.log(`ok   #${i.number} ${i.title} (${i.state})`);
			continue;
		}
		if (/closeout/i.test(i.title)) {
			console.log(`skip #${i.number} ${i.title} (closeout runs post-merge)`);
			continue;
		}
		console.log(`MISSING #${i.number} ${i.title} — open, no branch commit`);
		missing += 1;
	}
	if (missing > 0) {
		console.error(`\n${missing} child issue(s) not landed; see above.`);
		return 1;
	}

	// Evidence freshness: the PR body's dogfood attestation must name this
	// HEAD. A body with no attestation, or no PR yet, passes with a note —
	// the gate protects evidence that exists, it does not demand evidence.
	// gh pr view needs the branch spelled out when --repo is passed (it
	// cannot infer "current branch" across an explicit repository).
	const branch = run("git branch --show-current").trim();
	const prBody = run(`gh pr view --repo ${repo} ${branch} --json body --jq .body`);
	const head = run("git rev-parse HEAD").trim();
	const freshness = evidenceFreshness(prBody, head);
	if (freshness.verdict === "stale") {
		console.error(
			`\nstale evidence: PR body attests ${freshness.attested.join(", ")} ` +
				`but HEAD is ${head} — recapture the dogfood pair at the final ` +
				"HEAD (dogfood.md batch rule).",
		);
		return 1;
	}
	if (freshness.verdict === "fresh") {
		console.log(`\nevidence fresh: PR body attests ${head}.`);
	} else if (prBody) {
		console.log("\nno evidence attestation in the PR body — freshness check skipped.");
	} else {
		console.log("\nno PR body found (no PR yet?) — freshness check skipped.");
	}
	console.log("\nstrike complete: every child is landed or closed.");
	return 0;
}

if (
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	// process.exit truncates piped stdout on macOS; exitCode lets Node flush.
	process.exitCode = main(process.argv.slice(2));
}
