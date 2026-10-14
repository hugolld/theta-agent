import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

// SemVer comparison: true when a >= b. Prereleases follow SemVer precedence
// (a release outranks its own prerelease; numeric identifiers compare
// numerically and rank below alphanumeric ones). Malformed versions —
// leading zeros, empty or malformed prerelease identifiers — fail closed.
export function ge(a, b) {
	const parse = (v) => {
		const m =
			/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
				v,
			);
		if (!m) return null;
		// A wholly numeric prerelease identifier must not carry a leading zero.
		if (
			m[4] !== undefined &&
			m[4].split(".").some((id) => /^0\d+$/.test(id))
		) {
			return null;
		}
		return {
			core: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])],
			pre: m[4] === undefined ? null : m[4].split("."),
		};
	};
	// Floors may be written short ("0.99", "22"); pad them to full SemVer.
	const norm = (v) =>
		/^\d+$/.test(v) ? `${v}.0.0` : /^\d+\.\d+$/.test(v) ? `${v}.0` : v;
	const pa = parse(norm(a));
	const pb = parse(norm(b));
	if (!pa || !pb) return false;
	for (let i = 0; i < 3; i++) {
		if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i];
	}
	if (pa.pre === null && pb.pre === null) return true;
	if (pa.pre === null) return true;
	if (pb.pre === null) return false;
	const cmpId = (x, y) => {
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			const d = BigInt(x) - BigInt(y);
			return d === 0n ? 0 : d > 0n ? 1 : -1;
		}
		if (nx) return -1;
		if (ny) return 1;
		return x < y ? -1 : x > y ? 1 : 0;
	};
	for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
		if (pb.pre[i] === undefined) return true;
		if (pa.pre[i] === undefined) return false;
		const c = cmpId(pa.pre[i], pb.pre[i]);
		if (c !== 0) return c > 0;
	}
	return true;
}

// pi XML-escapes skill fields before serializing them into the transcript.
export function decodeXmlEntities(s) {
	return s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) =>
		({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" })[e],
	);
}

// The advertised skill records live in exactly one <available_skills> block
// inside the skills section pi maintains (message.sections.skills). A second
// block could hide advertisement drift, so any other count throws — and the
// tag counts must balance, so an unclosed block or stray <skill> records
// outside the parsed block fail closed too. Each record must carry both a
// name and a location — advertisement identity is the pair, not the path.
export function extractLocations(skillsText) {
	const opens = (skillsText.match(/<available_skills>/g) ?? []).length;
	const closes = (skillsText.match(/<\/available_skills>/g) ?? []).length;
	const blocks = skillsText.match(/<available_skills>[\s\S]*?<\/available_skills>/g);
	if (!blocks || blocks.length !== 1 || opens !== 1 || closes !== 1) {
		throw new Error(
			`expected exactly 1 well-formed available_skills block, found ${blocks ? blocks.length : 0} (open tags ${opens}, close tags ${closes})`,
		);
	}
	const skillTags = (skillsText.match(/<skill>/g) ?? []).length;
	const skillCloses = (skillsText.match(/<\/skill>/g) ?? []).length;
	const out = [];
	for (const record of blocks[0].match(/<skill>[\s\S]*?<\/skill>/g) ?? []) {
		// Each child tag must appear exactly once per record: stray or
		// duplicated name/location tags are corruption, not content.
		const nameMatches = record.match(/<name>[\s\S]*?<\/name>/g) ?? [];
		const locationMatches = record.match(/<location>[\s\S]*?<\/location>/g) ?? [];
		if (nameMatches.length !== 1 || locationMatches.length !== 1) {
			throw new Error(
				`malformed skill record: ${nameMatches.length} name tags, ${locationMatches.length} location tags`,
			);
		}
		const name = decodeXmlEntities(
			nameMatches[0].match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "",
		);
		const location = decodeXmlEntities(
			locationMatches[0].match(/<location>([\s\S]*?)<\/location>/)?.[1] ?? "",
		);
		if (!name || !location) {
			throw new Error("malformed skill advertisement record (missing name or location)");
		}
		out.push({ name, location });
	}
	if (out.length !== skillTags || skillCloses !== skillTags) {
		throw new Error(
			`stray or unclosed <skill> records: ${skillTags} openings, ${skillCloses} closings, ${out.length} parsed`,
		);
	}
	return out;
}

// Resolves the spot-check's skill argument to an absolute checkout path and
// requires it to be one of the advertised SKILL.md files — traversal and
// non-skill paths are rejected. Comparison happens on canonical paths, with
// a lexical fallback for arguments that do not resolve on disk.
export function resolveAdvertisedSkill(root, skill, expected) {
	const lexical = path.resolve(root, skill);
	let target = lexical;
	try {
		target = fs.realpathSync(lexical);
	} catch {
		// unresolvable paths compare lexically and fail membership below
	}
	if (!expected.has(target)) {
		throw new Error(
			`skill argument must be an advertised checkout SKILL.md, got: ${skill}`,
		);
	}
	return target;
}

// Resolves the script argument to an absolute path and requires an existing
// regular file inside the checkout — traversal and outside paths (including
// symlinks that escape the checkout) are rejected. Unlike the skill
// argument there is no advertisement set to check membership against, so
// containment is the criterion.
export function resolveCheckoutScript(rootArg, script) {
	const root = fs.realpathSync(rootArg);
	const lexical = path.resolve(root, script);
	let target = lexical;
	try {
		target = fs.realpathSync(lexical);
	} catch {
		throw new Error(`script argument does not resolve on disk: ${script}`);
	}
	if (!fs.statSync(target).isFile() || !target.startsWith(root + path.sep)) {
		throw new Error(`script argument must be a file inside the checkout, got: ${script}`);
	}
	return target;
}

// ---------------------------------------------------------------------------
// Shell command inspection
//
// The script attestation judges a bash command STRING, not structured
// arguments. These helpers implement a conservative POSIX-ish read: enough
// shell to know which word is the program being executed, refusing
// everything they cannot model. Unmodelled forms (expansions, arithmetic,
// process substitution, nested `bash -c` strings) leave words unresolvable
// and fail closed.

// Lexes a command into an ordered mix of words and operators. Words carry
// their quote-stripped value; operators are runs of `;&|<>()` (a leading
// file-descriptor digit is absorbed: `2>&1` lexes as the operator `2>&`
// followed by the word `1`) and unquoted newlines. Quoting groups,
// backslash escapes (a backslash-newline is a line continuation and
// contributes nothing), and `#` at word start comments to end of line. An
// unterminated quote consumes the rest of the string — a command the shell
// itself would reject. Heredoc bodies are consumed here, at the raw-line
// level: the lines after the command line belong to each pending `<<`
// delimiter in order, and the terminator is the delimiter ALONE on its
// line — quote-stripped or whitespace-padded lookalikes are body text.
function shellLex(command) {
	const toks = [];
	const heredocs = [];
	let expectDelim = false;
	const isOp = (c) => /[\s;&|<>()]/.test(c);
	const isOpNoSpace = (c) => /[;&|<>()]/.test(c);
	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (ch === "\n" || ch === "\r") {
			if (heredocs.length > 0) {
				i = ch === "\r" && command[i + 1] === "\n" ? i + 2 : i + 1;
				for (const h of heredocs) {
					let terminator = false;
					while (i <= command.length) {
						const nl = command.indexOf("\n", i);
						const end = nl === -1 ? command.length : nl;
						const line = command.slice(i, end);
						if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.delim) {
							i = nl === -1 ? command.length : nl + 1;
							terminator = true;
							break;
						}
						if (nl === -1) {
							i = command.length;
							break;
						}
						i = nl + 1;
					}
					if (!terminator) i = command.length;
				}
				heredocs.length = 0;
			} else {
				i++;
			}
			toks.push({ t: "o", v: "\n" });
			continue;
		}
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === "#") {
			while (i < command.length && command[i] !== "\n") i++;
			continue;
		}
		// fd-prefixed redirection: the digits join the following <>& run
		let j = i;
		while (j < command.length && /[0-9]/.test(command[j])) j++;
		if (j > i && j < command.length && /[<>]/.test(command[j])) {
			while (j < command.length && /[<>&]/.test(command[j])) j++;
			const op = command.slice(i, j);
			toks.push({ t: "o", v: op });
			expectDelim = op.includes("<<") && !op.includes("<<<");
			i = j;
			continue;
		}
		if (isOpNoSpace(ch)) {
			while (j < command.length && isOpNoSpace(command[j])) j++;
			const run = command.slice(i, j);
			i = j;
			// emit canonical operators, splitting runs: `);` is two
			// operators, while &&, ||, <<, >>, <<<, &>, &>> stay whole
			for (let k = 0; k < run.length; ) {
				const three = run.slice(k, k + 3);
				const two = run.slice(k, k + 2);
				let op = run[k];
				if (three === "<<<" || three === "&>>") op = three;
				else if (
					two === "&&" ||
					two === "||" ||
					two === "<<" ||
					two === ">>" ||
					two === "&>"
				) {
					op = two;
				}
				toks.push({ t: "o", v: op });
				// a heredoc expects its delimiter next; a herestring does not
				if (op.includes("<<")) expectDelim = !op.includes("<<<");
				k += op.length;
			}
			continue;
		}
		// a word: quoting groups, backslash escapes the next character
		let w = "";
		let quoted = false;
		while (i < command.length && !isOp(command[i])) {
			const c = command[i];
			if (c === "'") {
				quoted = true;
				let k = i + 1;
				while (k < command.length && command[k] !== "'") k++;
				w += command.slice(i + 1, k);
				i = Math.min(k + 1, command.length);
			} else if (c === '"') {
				quoted = true;
				let k = i + 1;
				while (k < command.length && command[k] !== '"') k++;
				for (let q = i + 1; q < k; q++) {
					if (command[q] === "\\" && /[$`"\\\n]/.test(command[q + 1] ?? "")) q++;
					w += command[q] ?? "";
				}
				i = Math.min(k + 1, command.length);
			} else if (c === "`") {
				// command substitution: consume the span raw as one
				// unresolvable word — the module refuses what it cannot
				// model, and a hidden cd inside must not silently divert
				// the anchor
				quoted = true;
				let k = i + 1;
				while (k < command.length) {
					if (command[k] === "\\") k += 2;
					else if (command[k] === "`") break;
					else k++;
				}
				w += command.slice(i, Math.min(k + 1, command.length));
				i = Math.min(k + 1, command.length);
			} else if (c === "\\") {
				// backslash-newline (and backslash-\r\n) is a continuation
				if (command[i + 1] === "\n") i += 2;
				else if (command[i + 1] === "\r" && command[i + 2] === "\n") i += 3;
				else {
					w += command[i + 1] ?? "";
					i += 2;
				}
			} else {
				w += c;
				i++;
			}
		}
		if (expectDelim) {
			heredocs.push({
				delim: w.startsWith("-") ? w.slice(1) : w,
				tabs: w.startsWith("-"),
			});
			expectDelim = false;
		}
		// an empty word matters only as a quoted heredoc delimiter
		if (w !== "" || quoted) toks.push({ t: "w", v: w });
	}
	return toks;
}

// The command's words, quote-stripped, in order (operators dropped).
export function shellTokens(command) {
	return shellLex(command)
		.filter((tok) => tok.t === "w")
		.map((tok) => tok.v);
}

// Interpreters execute their first program word; wrappers pass through to a
// program after their own flags, numeric arguments, and assignments.
const INTERPRETERS = new Set(["python3", "python", "bash", "sh", "zsh", "env", "uv"]);
const WRAPPERS = new Set([
	"timeout", "nohup", "nice", "stdbuf", "watch", "sudo", "time", "exec",
]);
const isInterpreter = (w) => INTERPRETERS.has(w) || /^python\d+(\.\d+)?$/.test(w);

// Control-flow keywords: whether the body ran is exactly what an
// attestation would have to prove, and the audit does not model it — a
// command headed by one of these words fails closed.
const COMPOUND = new Set([
	"if", "then", "elif", "else", "fi", "while", "until", "do", "done",
	"for", "in", "case", "esac", "select", "function", "{", "}", "!",
]);

// True when the simple command at cdIdx (whose last consumed word ends
// just before `after`) is backgrounded with `&` or sits in a pipeline —
// both run it in a subshell, so a cd there never moves the parent cwd.
// Redirections between the command and the `&` are stepped over.
function subshellConfined(toks, cdIdx, after) {
	const isRedirect = (v) => v.includes("<") || v.includes(">");
	let k = after;
	while (k < toks.length && toks[k].t === "o") {
		const v = toks[k].v;
		if (isRedirect(v)) {
			k++;
			while (k < toks.length && toks[k].t === "o") k++;
			k++; // the redirection's target word
			continue;
		}
		if (v === "|" || v === "&") return true;
		break; // any other operator ends the simple command
	}
	// Backward to the start of the pipeline segment: words of the same
	// segment (an assignment or a redirect's target may precede the cd)
	// belong to it, and a `|` before the boundary means the cd runs in a
	// subshell.
	for (let b = cdIdx - 1; b >= 0; b--) {
		const t = toks[b];
		if (t.t === "w") continue;
		const v = t.v;
		if (v === "|") return true;
		if (isRedirect(v)) continue;
		return false; // a boundary or stray operator ends the look
	}
	return false;
}

// True when the command EXECUTES the target script: a word in program
// position — the command word itself, or the program word after an
// interpreter or wrapper chain — resolves canonically to exactly the
// target. Relative words resolve against the session cwd (or a `cd`
// earlier in the command). Words that merely mention the path —
// arguments, comments, heredoc bodies, redirection targets — never
// attest, and neither does a copy of the script elsewhere on disk.
// Short-circuit operators are modelled conservatively: a segment after
// `&&` attests only when its chain runs to the command's end unbroken (a
// non-error overall result then proves every `&&`-chained segment ran;
// newlines directly after the operator continue the list); a segment
// after `||` never attests, because success and skip are
// indistinguishable in the overall exit status. Control flow (if, while,
// case, for, brace groups) is refused outright — whether the body ran is
// exactly what an attestation would have to prove.
export function commandResolvesToScript(command, target, root) {
	// cwd anchors relative words; null means the shell went somewhere the
	// audit cannot know (cd through an expansion), so relative words can
	// no longer attest.
	let cwd = root;
	const resolvesTo = (w) => {
		if (w === "") return false;
		if (!path.isAbsolute(w) && cwd === null) return false;
		const p = path.isAbsolute(w) ? w : path.resolve(cwd, w);
		try {
			return fs.realpathSync(p) === target;
		} catch {
			return false;
		}
	};
	const toks = shellLex(command);
	// A trailing newline ends the last line, not a statement — the
	// &&-tail proof must not count it as a break.
	while (
		toks.length > 0 &&
		toks[toks.length - 1].t === "o" &&
		toks[toks.length - 1].v === "\n"
	) {
		toks.pop();
	}
	// A CDPATH assignment makes later bare-relative cds land somewhere the
	// audit cannot know — bash searches CDPATH before the working
	// directory. (`./x` and `../x` bypass it; so do absolute paths.)
	const cdpathAt = toks.findIndex(
		(t) => t.t === "w" && t.v.startsWith("CDPATH="),
	);
	// Operators that decouple the overall exit status from the `&&` chain
	// in progress: once one follows, the chain's later segments can no
	// longer be proven to have run. `|` is deliberately absent — pipeline
	// members run unconditionally.
	const breaksChain = (op) =>
		op === ";" || op === "\n" || op === "&" || op === "||" || op === ")";
	// Index of the next chain-breaking operator at or after each token.
	const nextBreak = new Array(toks.length).fill(-1);
	for (let k = toks.length - 1; k >= 0; k--) {
		nextBreak[k] =
			toks[k].t === "o" && breaksChain(toks[k].v) ? k : (nextBreak[k + 1] ?? -1);
	}
	// Program-position state, per simple command (restarted at every
	// operator): "prefix" = still consuming wrappers, flags, and
	// assignments; "program" = the next word is the executed program;
	// "args" = the program word is behind us and nothing later executes.
	// Reachability of the current segment: "open" runs unconditionally,
	// "and"/"or" follow a short-circuit operator. `awaiting` marks an
	// &&/|| operand still expected — a newline (or comment line) directly
	// after the operator continues the list instead of ending it.
	let phase = "prefix";
	let guard = "open";
	let awaiting = false;
	let envChain = false; // the program word waits after env
	let lastWrapper = null; // the wrapper whose args are being consumed
	let headWord = null; // the word that opened the program phase
	const anchors = []; // the cwd at each open subshell
	let i = 0;
	while (i < toks.length) {
		const tok = toks[i];
		if (tok.t === "o") {
			const op = tok.v;
			if (op.includes("<") || op.includes(">")) {
				// a redirection's target is the next word — operator runs
				// may split (`<>` lexes as `<` then `>`), so skip any
				// stray operators before it
				i++;
				while (i < toks.length && toks[i].t === "o") i++;
				i++;
				continue;
			}
			envChain = false; // a new simple command begins
			lastWrapper = null;
			headWord = null;
			if (op === "&&") {
				guard = "and";
				awaiting = true;
			} else if (op === "||") {
				guard = "or";
				awaiting = true;
			} else if (op === "(") {
				anchors.push(cwd); // a subshell starts at the parent cwd…
			} else if (op === ")") {
				cwd = anchors.pop() ?? cwd; // …and its cd dies with it
				guard = "open";
				awaiting = false;
				// `) (` adjacency (newlines aside) is a function
				// definition's body: the body defines, it does not run
				let k = i + 1;
				while (k < toks.length && toks[k].t === "o" && toks[k].v === "\n") k++;
				if (toks[k]?.t === "o" && toks[k].v === "(") return false;
			} else if (op === "\n" && awaiting) {
				// the AND-OR list continues past the newline
			} else {
				guard = "open";
				awaiting = false;
			}
			phase = "prefix"; // every operator ends the simple command
			i++;
			continue;
		}
		const wordIdx = i;
		const w = tok.v;
		i++;
		awaiting = false;
		// A guarded segment's program word attests only when its execution
		// is provable: open segments always run; an `&&`-guarded one only
		// inside a chain that reaches the command's end unbroken.
		const provable = guard === "open" || (guard === "and" && nextBreak[wordIdx] === -1);
		const skippable = /^-/.test(w) || /^\d+$/.test(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
		if (phase === "args") continue;
		if (phase === "program") {
			// An interpreter flag may take the next word as its value — or
			// be the read-stdin operand `-`; a numeric or assignment word
			// would itself be the script operand (env is the exception: it
			// consumes NAME=VALUE pairs). The program search ends, and no
			// later word in this segment can attest.
			const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
			if (envChain && assignment) continue; // env K=V pairs keep waiting
			if (/^-/.test(w) || /^\d+$/.test(w) || assignment) {
				phase = "args";
				continue;
			}
			if (isInterpreter(w) || WRAPPERS.has(w)) {
				// A wrapper (or env) execs its program word, which may
				// itself be an interpreter — the chain continues. After a
				// plain interpreter the word is the script operand
				// (python3 env x.py runs a file named env): the search
				// ends at the fall-through below.
				if (headWord === "env" || WRAPPERS.has(headWord)) {
					envChain = w === "env"; // only env itself consumes pairs
					continue;
				}
			}
			phase = "args";
			if (provable && resolvesTo(w)) return true;
			continue;
		}
		// prefix phase: this word is the command word
		if (skippable) {
			// Command-prefix material: assignments may precede the command
			// word itself (before any wrapper is consumed), flags follow
			// the wrapper they belong to, and only timeout always takes a
			// numeric duration operand. A skippable-shaped word with no
			// such home is itself the program — the shell would fail to
			// find it — and the search ends.
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && lastWrapper === null) continue;
			if (/^-/.test(w) && lastWrapper !== null) continue;
			if (/^\d+$/.test(w) && lastWrapper === "timeout") continue;
			phase = "args";
			continue;
		}
		if (COMPOUND.has(w)) return false; // control flow is refused outright
		if (WRAPPERS.has(w)) {
			lastWrapper = w;
			continue;
		}
		if (w === "cd" || w === "pushd") {
			// Consume the directory argument, past cd's own flags (-L,
			// -P, …) and `--`. The anchor moves only when the cd provably
			// ran and succeeded in the parent shell: open and foreground,
			// or `&&`-guarded in a chain that reaches the command's end
			// (the caller's non-error result gate then proves every
			// chained segment exited 0). A cd backgrounded with `&` or
			// anywhere in a pipeline runs in a subshell — the parent
			// anchor stays exactly. Any other cd — `||`-guarded, decoupled
			// by a later separator, CDPATH-shadowed, expansion-sourced,
			// bare, or resolving to nothing on disk now — leaves the
			// shell somewhere the audit cannot know, and later relative
			// words can no longer attest.
			let d = i;
			while (toks[d]?.t === "w" && /^-/.test(toks[d].v) && toks[d].v !== "--") d++;
			if (toks[d]?.t === "w" && toks[d].v === "--") d++;
			const dir = toks[d]?.t === "w" ? toks[d].v : null;
			if (dir === null) {
				cwd = null; // bare cd goes HOME; bare pushd swaps
				i = d;
			} else {
				i = d + 1;
				const subshellCd = subshellConfined(toks, wordIdx, i);
				const cdpathShadowed =
					cdpathAt !== -1 &&
					cdpathAt < wordIdx &&
					!path.isAbsolute(dir) &&
					!dir.startsWith("./") &&
					!dir.startsWith("../");
				const p =
					cwd === null
						? (path.isAbsolute(dir) ? dir : null)
						: (path.isAbsolute(dir) ? dir : path.resolve(cwd, dir));
				let real = null;
				if (p !== null) {
					try {
						const r = fs.realpathSync(p);
						if (fs.statSync(r).isDirectory()) real = r;
					} catch {
						// unresolvable now: it may have existed at run time
					}
				}
				if (!subshellCd) {
					cwd = real !== null && provable && !cdpathShadowed ? real : null;
				}
			}
			phase = "args";
			continue;
		}
		if (w === "popd") {
			cwd = null; // restores an older directory the audit never knew
			phase = "args";
			continue;
		}
		phase = isInterpreter(w) ? "program" : "args";
		envChain = w === "env";
		headWord = w;
		if (provable && resolvesTo(w)) return true;
	}
	return false;
}

// Collects the tool-call/result graph the spot-check attestations search.
// tool calls are assistant requests: one embedded in a system, user, or
// toolResult record is transcript corruption. The graph must be temporally
// consistent: every call needs exactly one later matching result, every
// result an earlier call — a spliced transcript pairing a result with a
// later call fails.
function collectToolGraph(recs) {
	const calls = [];
	const callOrder = new Map();
	const results = new Map();
	let recordIndex = 0;
	for (const r of recs) {
		const m = r.message;
		recordIndex += 1;
		if (!m) continue;
		// tool calls are assistant requests: one embedded in a system,
		// user, or toolResult record is transcript corruption.
		if (m.role !== "assistant" && Array.isArray(m.content)) {
			for (const t of m.content) {
				if (t?.type === "toolCall") {
					throw new Error(
						`toolCall in ${m.role} record — transcript corruption`,
					);
				}
			}
		}
		if (Array.isArray(m.content))
			for (const t of m.content) {
				if (t?.type !== "toolCall") continue;
				if (typeof t.id !== "string" || t.id === "") {
					throw new Error(`toolCall without a usable id: ${JSON.stringify(t.id)}`);
				}
				if (callOrder.has(t.id)) {
					throw new Error(`duplicate toolCall id: ${t.id}`);
				}
				callOrder.set(t.id, recordIndex);
				calls.push(t);
			}
		if (r.type === "message" && m.role === "toolResult") {
			if (typeof m.toolCallId !== "string" || m.toolCallId === "") {
				throw new Error(
					`toolResult without a usable toolCallId: ${JSON.stringify(m.toolCallId)}`,
				);
			}
			if (results.has(m.toolCallId)) {
				throw new Error(`duplicate toolResult for ${m.toolCallId}`);
			}
			results.set(m.toolCallId, { recordIndex, message: m });
		}
	}
	const orphans = [...results.keys()].filter((id) => !callOrder.has(id));
	const unanswered = calls.filter((t) => !results.has(t.id));
	if (orphans.length > 0) {
		throw new Error(`orphan toolResults without calls:\n${orphans.join("\n")}`);
	}
	if (unanswered.length > 0) {
		throw new Error(
			`tool calls without results:\n${unanswered.map((t) => t.id).join("\n")}`,
		);
	}
	for (const t of calls) {
		const r = results.get(t.id);
		if (r && r.recordIndex < callOrder.get(t.id)) {
			throw new Error(`toolResult for ${t.id} precedes its toolCall`);
		}
	}
	return { calls, callOrder, results };
}

// The id-paired calls of one tool, recorded after the prompt — the shared
// shape of both spot-check attestations. isError is left to the caller:
// the read attestation accepts only non-error results, while the script
// attestation also reports a resolved-but-errored run distinctly.
function pairedCalls(tool, graph, userIndex) {
	const out = [];
	for (const t of graph.calls) {
		const r = graph.results.get(t.id)?.message;
		if (t.name !== tool || !r || r.toolName !== tool) continue;
		if (graph.callOrder.get(t.id) <= userIndex) continue;
		out.push({ call: t, result: r });
	}
	return out;
}

// Audits one dogfood session directory against the checkout at the current
// HEAD and returns the attestation. Throws on any failure; `skill` (a
// checkout-relative SKILL.md path) additionally requires a successful read
// tool call on that exact file; `script` (a checkout-relative script path)
// additionally requires a bash tool call that executed that exact file,
// paired with a non-error tool result.
export function auditSession(dir, rootArg, skill, script) {
	const root = fs.realpathSync(rootArg);
	// Mount aliases (e.g. /var vs /private/var on macOS) give the same tree
	// two spellings; lexical containment accepts either spelling of root.
	const rootAliases = [...new Set([rootArg, root])];
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	if (files.length !== 1) {
		throw new Error(`expected exactly 1 session file, found ${files.length}`);
	}
	if (fs.existsSync(`${dir}/watchdog`)) {
		throw new Error("watchdog fired: run exceeded 300s");
	}
	let bootExit;
	let bootErr;
	let bootExitRaw;
	let bootErrBuf;
	let piVersion;
	let nodeVersion;
	let promptWanted;
	// Read each evidence file exactly once: the same bytes are validated here
	// and hashed into the attestation, so a later mutation cannot produce a
	// successful attestation whose hashes identify invalid evidence.
	try {
		bootExitRaw = fs.readFileSync(`${dir}/exit-status`, "utf8");
		bootErrBuf = fs.readFileSync(`${dir}/stderr.txt`);
		bootExit = bootExitRaw.trim();
		bootErr = bootErrBuf.length;
		piVersion = fs.readFileSync(`${dir}/pi-version`, "utf8").trim().replace(/^v/, "");
		nodeVersion = fs
			.readFileSync(`${dir}/node-version`, "utf8")
			.trim()
			.replace(/^v/, "");
		promptWanted = fs.readFileSync(`${dir}/prompt.txt`, "utf8");
	} catch {
		throw new Error(
			"missing process-evidence files (exit-status, stderr.txt, pi-version, node-version, prompt.txt)",
		);
	}
	if (!ge(piVersion, "0.99")) {
		throw new Error(`pi ${piVersion} is below the supported 0.99 floor`);
	}
	if (!ge(nodeVersion, "22")) {
		throw new Error(`node ${nodeVersion} is below the supported 22 floor`);
	}
	if (bootExit !== "0" || bootErr !== 0) {
		throw new Error(`boot not clean: exit ${bootExit}, stderr ${bootErr} bytes`);
	}
	// assume-unchanged (lowercase h) and skip-worktree (uppercase S) index
	// entries hide tracked-file modifications from git status; either fails
	// the audit.
	const flagged = execSync("git ls-files -v", { cwd: root })
		.toString()
		.split("\n")
		.filter((l) => /^[hsS]/.test(l));
	if (flagged.length > 0) {
		throw new Error(
			`index entries marked assume-unchanged or skip-worktree:\n${flagged.join("\n")}`,
		);
	}
	// The transcript is hashed as raw file bytes and decoded strictly: lossy
	// UTF-8 replacement or normalization would let byte-corrupt evidence pass.
	const transcriptBuf = fs.readFileSync(`${dir}/${files[0]}`);
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(transcriptBuf);
	} catch (e) {
		throw new Error(`corrupt transcript: ${e.message}`);
	}
	// Strip only the trailing newline terminator: blank interior lines are
	// malformed JSONL and fail closed in the parse below.
	const lines = text.replace(/\n$/, "").split("\n");
	const recs = lines.map((l) => {
		try {
			return JSON.parse(l);
		} catch (e) {
			throw new Error(`corrupt transcript: ${e.message}`);
		}
	});
	const sessionRecs = recs.filter((r) => r.type === "session");
	if (sessionRecs.length !== 1) {
		throw new Error(
			`expected exactly 1 session record, found ${sessionRecs.length}`,
		);
	}
	// A one-shot transcript is ONE linear chain rooted at the session record:
	// ids are unique, record 0 is the session, and every later record's
	// parentId is the previous record's id (the schema's single null-parent
	// root exception is the first record after the session). Disconnected
	// roots, self-parents, DAG ancestry, and spliced records all fail.
	const seenIds = new Set();
	let prevId = null;
	let rootExceptions = 0;
	for (let i = 0; i < recs.length; i++) {
		const id = recs[i].id;
		const pid = recs[i].parentId;
		if (id === undefined || id === null || id === "") {
			throw new Error(`record ${i} has no usable id`);
		}
		if (seenIds.has(id)) {
			throw new Error(`duplicate record id: ${id}`);
		}
		seenIds.add(id);
		if (i === 0) {
			if (recs[i].type !== "session") {
				throw new Error("record 0 must be the session record");
			}
		} else if (pid === undefined || pid === null) {
			rootExceptions += 1;
			if (rootExceptions > 1) {
				throw new Error(`record ${i} is an extra disconnected root`);
			}
		} else if (pid !== prevId) {
			throw new Error(
				`record ${i} breaks the linear chain (parent ${pid}, expected ${prevId})`,
			);
		}
		prevId = id;
	}
	const sysRecs = recs.filter(
		(r) => r.type === "message" && r.message?.role === "system",
	);
	// Count records that carry a skills section at all — a later null patch
	// removes the advertisement and must fail loudly, not pass silently.
	const skillsRecs = sysRecs.filter(
		(r) => r.message?.sections !== undefined && "skills" in r.message.sections,
	);
	if (skillsRecs.length !== 1) {
		throw new Error(
			`expected exactly 1 skills-bearing system record, found ${skillsRecs.length}`,
		);
	}
	const sess = recs.find((r) => r.type === "session");
	if (!sess || sess.cwd !== root) {
		throw new Error(`session cwd mismatch: expected ${root}`);
	}
	const userRecs = recs.filter(
		(r) => r.type === "message" && r.message?.role === "user",
	);
	if (userRecs.length !== 1) {
		throw new Error(`expected exactly 1 user record, found ${userRecs.length}`);
	}
	const userIndex = recs.indexOf(userRecs[0]);
	// Record order is part of the evidence: the session identity, the model
	// selection, and the skill advertisement must all be recorded before the
	// prompt they answer — a spliced transcript advertising skills after
	// seeing the task fails here.
	const orderOf = (pred) => {
		const idx = recs.findIndex(pred);
		return idx === -1 ? Number.POSITIVE_INFINITY : idx;
	};
	const sessionOrder = orderOf((r) => r.type === "session");
	const modelOrder = orderOf((r) => r.type === "model_change");
	const skillsOrder = orderOf(
		(r) =>
			r.type === "message" &&
			r.message?.role === "system" &&
			r.message?.sections !== undefined &&
			"skills" in r.message.sections,
	);
	if (
		sessionOrder > userIndex ||
		modelOrder > userIndex ||
		skillsOrder > userIndex
	) {
		throw new Error(
			"transcript order violation: session, model_change, and skills records must precede the user prompt",
		);
	}
	// A completed one-shot ends with the assistant's response: a transcript
	// truncated at a record boundary cannot attest a full session. A final
	// assistant record that still carries a tool request, a length-truncated
	// stop reason, an error, or no text at all is not a completed response.
	const last = recs[recs.length - 1];
	const lastContent = last?.message?.content;
	const endsWithToolCall =
		Array.isArray(lastContent) &&
		lastContent.some((c) => c?.type === "toolCall");
	const lastText = Array.isArray(lastContent)
		? lastContent.filter((c) => c?.type === "text").map((c) => c.text).join("")
		: (typeof lastContent === "string" ? lastContent : "");
	if (
		last?.type !== "message" ||
		last?.message?.role !== "assistant" ||
		endsWithToolCall ||
		lastText === ""
	) {
		throw new Error(
			"transcript does not end with a non-empty assistant response — truncated session",
		);
	}
	if (last.message.stopReason !== "stop" || last.message.errorMessage) {
		throw new Error(
			`incomplete final assistant response: stopReason ${last.message.stopReason}${last.message.errorMessage ? ", error " + last.message.errorMessage : ""}`,
		);
	}
	const userRec = userRecs[0];
	const userText = Array.isArray(userRec?.message?.content)
		? userRec.message.content
				.filter((c) => c?.type === "text")
				.map((c) => c.text)
				.join("")
		: (typeof userRec?.message?.content === "string" ? userRec.message.content : null);
	if (userText !== promptWanted) {
		throw new Error("prompt mismatch: the session did not run the recorded prompt");
	}
	const wantModel = fs.readFileSync(`${dir}/expected-model`, "utf8").trim().split(/\s+/);
	const changes = recs.filter((r) => r.type === "model_change");
	if (changes.length !== 1) {
		throw new Error(`expected exactly 1 model_change record, found ${changes.length}`);
	}
	if (changes[0].provider !== wantModel[0] || changes[0].modelId !== wantModel[1]) {
		throw new Error(
			`model mismatch: ran ${changes[0].provider}/${changes[0].modelId}, expected ${wantModel[0]}/${wantModel[1]}`,
		);
	}
	// Every assistant record carries its own provider/model: a record that
	// contradicts the model_change metadata means provider fallback or
	// recombined evidence.
	const assistantModels = recs
		.filter((r) => r.type === "message" && r.message?.role === "assistant")
		.map((r) => `${r.message.provider}/${r.message.model}`);
	const wrongModelRecords = assistantModels.filter(
		(pm) => pm !== `${wantModel[0]}/${wantModel[1]}`,
	);
	if (wrongModelRecords.length > 0) {
		throw new Error(
			`assistant records contradict the expected model: ${wrongModelRecords.join(", ")}`,
		);
	}
	const skillsText =
		typeof skillsRecs[0].message.sections.skills === "string"
			? skillsRecs[0].message.sections.skills
			: "";
	const advertisements = extractLocations(skillsText);
	const inventoryText = fs.readFileSync(
		`${root}/test/expected-skills.json`,
		"utf8",
	);
	const inv = JSON.parse(inventoryText);
	const skillRoot = manifestSkillRoot(root);
	const names = inv.vendored.map((e) => e.name).concat(inv["self-authored"]);
	// Advertisement identity is the name/location pair: an inventory skill
	// must be advertised at an allowed spelling of its own checkout location
	// — the manifest path resolved against either spelling of the checkout
	// root (mount aliases). Canonicalization is an additional containment
	// check, not a substitute: an arbitrary external alias cannot impersonate
	// a checkout skill, and locations that do not resolve on disk are
	// rejected.
	const inventoryNames = new Set(names);
	const manifestEntry = manifestSkillEntry(root);
	const canonical = new Map();
	for (const rec of advertisements) {
		if (canonical.has(rec.name)) {
			throw new Error(`duplicate advertised skill name: ${rec.name}`);
		}
		try {
			canonical.set(rec.name, fs.realpathSync(rec.location));
		} catch {
			throw new Error(
				`advertised location does not resolve on disk: ${rec.location}`,
			);
		}
		if (inventoryNames.has(rec.name)) {
			const allowed = rootAliases.map(
				(r) => `${path.resolve(r, manifestEntry)}/${rec.name}/SKILL.md`,
			);
			if (!allowed.includes(rec.location)) {
				throw new Error(
					`inventory skill ${rec.name} advertised from outside the checkout: ${rec.location}`,
				);
			}
		}
		if (
			!inventoryNames.has(rec.name) &&
			canonical.get(rec.name).startsWith(root + path.sep)
		) {
			throw new Error(
				`host skill ${rec.name} resolves inside the checkout: ${rec.location}`,
			);
		}
	}
	const missing = [];
	for (const n of names) {
		const p = `${skillRoot}/${n}/SKILL.md`;
		if (canonical.get(n) !== p) missing.push(n);
	}
	if (missing.length > 0) {
		throw new Error(`NOT advertised: ${missing.join(", ")}`);
	}
	const expected = new Set(names.map((n) => `${skillRoot}/${n}/SKILL.md`));
	// An advertised record is an extra when its lexical location or its
	// canonical target lies at or inside the checkout without being
	// inventory — canonicalizing alone would hide a checkout symlink
	// pointing outside, and host-level skills outside the checkout are the
	// environment. Every advertised location must also resolve to a real
	// SKILL.md file: a record pointing at the checkout root itself is
	// checkout-affiliated, not a host skill.
	const extras = [...canonical.entries()]
		.filter(([n, p]) => {
			if (expected.has(p)) return false;
			const lexical =
				advertisements.find((r) => r.name === n)?.location ?? "";
			return (
				rootAliases.some((r) => lexical.startsWith(r + path.sep)) ||
				p === root ||
				p.startsWith(root + path.sep)
			);
		})
		.map(([n]) => n);
	for (const [n, p] of canonical) {
		if (path.basename(p) !== "SKILL.md" || !fs.statSync(p).isFile()) {
			throw new Error(
				`advertised location for ${n} is not a SKILL.md file: ${p}`,
			);
		}
	}
	if (extras.length > 0) {
		throw new Error(`UNEXPECTED advertised skills:\n${extras.join("\n")}`);
	}
	// A duplicate alias (one inventory skill also reachable through a second
	// in-checkout symlink) collapses in the canonical set, so the count of
	// checkout-affiliated records must match the inventory exactly.
	const checkoutRecords = advertisements.filter((rec) =>
		canonical.get(rec.name)?.startsWith(root + path.sep),
	);
	if (checkoutRecords.length !== names.length) {
		throw new Error(
			`expected ${names.length} checkout skill advertisements, found ${checkoutRecords.length}`,
		);
	}
	const dirty = execSync("git status --porcelain --untracked-files=all", {
		cwd: root,
	}).toString().trim();
	if (dirty) {
		throw new Error(`working tree dirty:\n${dirty}`);
	}
	const head = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
	const preHead = fs.readFileSync(`${dir}/pre-head`, "utf8").trim();
	if (head !== preHead) {
		throw new Error(`HEAD moved since the run: ${preHead} -> ${head}`);
	}
	const manifestSha = fs.readFileSync(`${dir}/manifest-sha256`, "utf8").trim();
	const curManifest = createHash("sha256")
		.update(fs.readFileSync(`${root}/package.json`))
		.digest("hex");
	if (curManifest !== manifestSha) {
		throw new Error("package.json changed since the run");
	}
	const shaText = (s) => createHash("sha256").update(s).digest("hex");
	let out =
		`clean ${head}\n` +
		`transcript ${createHash("sha256").update(transcriptBuf).digest("hex")}\n` +
		`exit-status ${shaText(bootExitRaw)}\n` +
		`stderr ${shaText(bootErrBuf)}\n` +
		`pi ${piVersion}\n` +
		`node ${nodeVersion}\n` +
		`provider ${wantModel[0]}\n` +
		`model ${wantModel[1]}\n` +
		`inventory ${shaText(inventoryText)}\n` +
		`prompt ${shaText(promptWanted)}`;
	// The spot-check attestations — skill read, script execution — share one
	// tool-call/result graph and one prompt-neutrality gate.
	if (skill !== undefined || script !== undefined) {
		// Cross-script lookalikes (Cyrillic і for Latin i) survive NFKC, so
		// the recorded prompt must be pure ASCII: the operator's task is
		// English text, and anything else fails closed.
		if (/[^\x00-\x7F]/.test(promptWanted)) {
			throw new Error(
				"spot-check prompt contains non-ASCII characters — cross-script lookalikes are not auditable",
			);
		}
		// The name comparison strips case, separators, and punctuation from
		// both sides — so LiteratureReview, literature_review, "literature
		// review", and SKILL.md all match their canonical forms.
		const normalize = (s) =>
			s.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]/g, "");
		const promptNorm = normalize(promptWanted);
		const promptNamesAny = (variants) =>
			variants.some((v) => v && promptNorm.includes(v));
		const graph = collectToolGraph(recs);
		if (skill !== undefined) {
			const target = resolveAdvertisedSkill(root, skill, expected);
			// The skill bytes are read exactly once: the paired read result must
			// equal these validated bytes, and the attested digest hashes the same
			// buffer — no second read can separate validated from attested bytes.
			const skillBuf = fs.readFileSync(target);
			const skillText = skillBuf.toString("utf8");
			// A routed prompt must not name the selected skill or its file:
			// steering the model there is instruction, not routing. The name is
			// derived from the target's parent directory, not from the argument
			// string.
			const skillName = path.basename(path.dirname(target));
			if (
				promptNamesAny([
					normalize(skillName),
					normalize(path.basename(target)),
					normalize(target),
				])
			) {
				throw new Error(
					"spot-check prompt names the selected skill or its file — a routed task must reach it on its own",
				);
			}
			// pi may advertise and read lexical paths through symlinked resources;
			// canonicalize the read path first, so a lexical path through a
			// symlinked checkout still matches, then compare canonically — an
			// unresolvable or external path cannot vouch for the target. Read
			// arguments (offset/limit) are not judged: the recorded result text
			// must equal the current file contents, so only a read of the whole
			// file can satisfy the check no matter what arguments were passed.
			// The read must also occur after the recorded prompt: a read spliced
			// before the user record was not caused by it.
			const hit = pairedCalls("read", graph, userIndex).some(({ call: t, result: r }) => {
				if (!(r.isError === false && t.arguments?.path)) {
					return false;
				}
				try {
					if (fs.realpathSync(t.arguments.path) !== target) return false;
				} catch {
					return false;
				}
				const resultText = Array.isArray(r.content)
					? r.content
							.filter((c) => c?.type === "text")
							.map((c) => c.text)
							.join("")
					: (typeof r.content === "string" ? r.content : "");
				return resultText === skillText;
			});
			if (!hit) {
				throw new Error("selected file never opened");
			}
			out += `\nselected-file-opened ${target}\nskill-content ${createHash("sha256").update(skillBuf).digest("hex")}`;
		}
		if (script !== undefined) {
			// The script argument resolves like the skill argument, but scripts
			// are not advertised: an existing regular file inside the checkout
			// is the criterion. The bytes are read exactly once — the attested
			// digest hashes the validated buffer.
			const target = resolveCheckoutScript(root, script);
			const scriptBuf = fs.readFileSync(target);
			// A routed prompt must not name the selected script or its path:
			// the script is part of the skill's capability, and naming it is
			// instruction, not routing.
			if (promptNamesAny([normalize(path.basename(target)), normalize(target)])) {
				throw new Error(
					"spot-check prompt names the selected script or its path — a routed task must reach it on its own",
				);
			}
			// Execution, not mention: a bash call qualifies when its command
			// names the checkout's copy in program position, the call follows
			// the recorded prompt, and the paired result reports no error. A
			// copy of the script elsewhere on disk — or the path as an
			// argument, comment, heredoc body, or redirection target — does
			// not attest.
			let hit = false;
			let sawErroredRun = false;
			for (const { call: t, result: r } of pairedCalls("bash", graph, userIndex)) {
				if (typeof t.arguments?.command !== "string") continue;
				if (!commandResolvesToScript(t.arguments.command, target, root)) {
					continue;
				}
				if (r.isError === false) {
					hit = true;
					break;
				}
				sawErroredRun = true;
			}
			if (!hit) {
				throw new Error(
					sawErroredRun
						? "checkout script execution failed: the bash tool result is an error"
						: `checkout script never executed: ${target}`,
				);
			}
			out += `\nscript-executed ${target}\nscript-content ${createHash("sha256").update(scriptBuf).digest("hex")}`;
		}
	}
	// Final state recheck: the audited bytes and the cited HEAD must still
	// describe the tree at attestation time.
	const dirtyFinal = execSync("git status --porcelain --untracked-files=all", {
		cwd: root,
	}).toString().trim();
	if (dirtyFinal) {
		throw new Error(`working tree dirty at attestation time:\n${dirtyFinal}`);
	}
	const headFinal = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
	if (headFinal !== head) {
		throw new Error(`HEAD moved during audit: ${head} -> ${headFinal}`);
	}
	return out;
}

function manifestSkillEntry(root) {
	const manifest = JSON.parse(fs.readFileSync(`${root}/package.json`, "utf8"));
	const raw = manifest.pi?.skills ?? ["./skills"];
	if (
		!Array.isArray(raw) ||
		raw.length !== 1 ||
		typeof raw[0] !== "string" ||
		/[*?[\]{}]/.test(raw[0])
	) {
		throw new Error("audit supports a single plain-directory pi.skills entry");
	}
	const resolved = path.resolve(root, raw[0]);
	const realRoot = fs.realpathSync(root);
	const realResolved = fs.realpathSync(resolved);
	if (!fs.statSync(realResolved).isDirectory()) {
		throw new Error(`pi.skills entry must be a directory, got: ${raw[0]}`);
	}
	if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
		throw new Error(`pi.skills entry must resolve inside the checkout, got: ${raw[0]}`);
	}
	return raw[0];
}

function manifestSkillRoot(root) {
	return path.resolve(root, manifestSkillEntry(root));
}

function main(argv) {
	const [dir, skill, script] = argv;
	const root = fs.realpathSync(".");
	try {
		console.log(auditSession(dir, root, skill, script));
	} catch (e) {
		console.error(e.message);
		return 1;
	}
	return 0;
}

if (
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	// process.exit truncates piped stdout on macOS; exitCode lets Node flush.
	process.exitCode = main(process.argv.slice(2));
}
