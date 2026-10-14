// Strike-completeness gate: before a strike's PR goes ready, every child
// of the spec issue must be landed on this branch (a commit referencing
// its number) or already closed. A closeout ticket — the merge/publish
// steps that run after the merge — is the expected open exception.
//
// Usage: node scripts/check-strike.mjs <spec-issue-number>
// Exit 0 = complete (or only expected exceptions remain); 1 = a child is
// open with no branch commit; 2 = usage or tracker error.
import { execSync } from "node:child_process";

const repo = "hugolld/theta-agent";
const spec = process.argv[2];
if (!spec || !/^\d+$/.test(spec)) {
	console.error("usage: node scripts/check-strike.mjs <spec-issue-number>");
	process.exit(2);
}
const run = (cmd) => {
	try {
		return execSync(cmd, { encoding: "utf8" });
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
	process.exit(2);
}
const parent = new RegExp(`#${spec}\\b`);
const children = JSON.parse(issues).filter((i) => parent.test(i.body ?? ""));
if (children.length === 0) {
	console.error(`no issues name #${spec} as parent`);
	process.exit(2);
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
	process.exit(1);
}
console.log("\nstrike complete: every child is landed or closed.");
