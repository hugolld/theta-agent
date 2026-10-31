# Dogfooding theta

`theta --dev` boots pi with this package preloaded from a local checkout. The skill-list and skill-opened criteria are accepted on **operator-attested structural evidence**: recorded transcript and process artifacts whose internal consistency the auditor checks — never on the model's self-report alone. A model asked "is skill X available?" can answer confidently from files it merely sees on disk. The tracer PR (#9) recorded a met criterion that way; PR #10 found the skills were not loading at all. Clean boot is different: it is **process evidence** — exit status and stderr, captured at run time (see the recipe below), because no transcript can reconstruct them. One trust boundary to state plainly: the session directory is operator-supplied and writable by the running model. The auditor checks the structural consistency of the recorded session against the tree, and the operator vouches for both capture and prompt quality — the neutrality of a routed task is a human judgment the gate cannot mechanically prove. The gate does not defend against a model or skill script that deliberately tampers with the session artifacts — containing that would require a parent-controlled supervisor, which this recipe intentionally is not.

## Run a one-shot session

From the checkout:

```sh
sd=$(mktemp -d "${TMPDIR:-/tmp}/dogfood-$(git rev-parse --short HEAD)-XXXXXX")
st=$(git status --porcelain --untracked-files=all) || { echo "git status failed"; exit 1; }
[ -n "$st" ] && { echo "working tree dirty — commit first"; exit 1; }
git rev-parse HEAD > "$sd/pre-head"
printf '%s' "<prompt>" > "$sd/prompt.txt"
printf '%s\n' "zai-coding-cn glm-5.3-flash" > "$sd/expected-model"
node -p "require('crypto').createHash('sha256').update(require('fs').readFileSync('package.json')).digest('hex')" > "$sd/manifest-sha256"
pi --version > "$sd/pi-version"
node --version > "$sd/node-version"
node bin/theta.mjs --dev --provider zai-coding-cn --model glm-5.3-flash \
  --session-dir "$sd" --print "<prompt>" 2> "$sd/stderr.txt" < /dev/null &
pid=$!
( sleep 300; echo fired > "$sd/watchdog" 2>/dev/null; kill $pid 2>/dev/null; sleep 15; kill -9 $pid 2>/dev/null ) & watchdog=$!
wait $pid
echo $? > "$sd/exit-status"
kill $watchdog 2>/dev/null; pkill -P $watchdog 2>/dev/null
```

- Pass provider and model explicitly: pi's default model can 401 with an invalid bearer token.
- Close stdin (`< /dev/null`): `pi --print` waits for stdin EOF even with a prompt argument, and a shell that leaves the pipe open hangs the session silently (found in the issue #8 close-out dogfood — 50 minutes, zero output, zero CPU).
- Gate before launch: a dirty tree refuses the run, and the pre-run HEAD and `package.json` digest are captured into the session dir — the audit fails if either moved afterwards, so evidence cannot be rebound to a different tree.
- Batch fixes before regenerating evidence: the pre-head binding makes evidence stale on the next commit, so harden first, commit, then run the evidence pair once at the final HEAD.
- Bound the run: the watchdog sends SIGTERM at 5 minutes — the launcher forwards it to `pi` — and 15 seconds later SIGKILLs the launcher if it still hangs, leaving a `watchdog` sentinel the audit rejects. A `pi` stalled through both signals may keep running detached, but the run fails either way. No coreutils needed.
- Tear down in order: kill the watchdog subshell **before** reaping its children. Killing the `sleep` child first lets the subshell advance to the sentinel write, so a clean run could record a false `fired` (observed live 2026-10-12; VERDICT.md residual 5, `prototype/m2-shape-contest`). After the kill, re-parenting can hide the orphaned `sleep` from the `pkill` — it writes nothing, so it is harmless.
- Record the runtime: `pi --version`, `node --version`, and the expected provider/model land in the session dir; the audit enforces the pi ≥ 1.4.0 and node ≥ 22.19.0 floors and verifies the transcript's `model_change` record against the expected run. These are operator-attested runtime observations — the launcher resolves `pi` from `PATH` independently, so the audit names what was recorded, not a cryptographically bound executable.
- Keep the spot-check prompt pure ASCII: the audit rejects non-ASCII prompts (cross-script lookalikes are not auditable), and legitimate English scientific text with em dashes or symbols must be transcribed in ASCII before the run.
- Run inside an isolated `--session-dir`: the fresh temp dir holds exactly this run's transcript, so the audit below can never pick up another session (a newest-by-mtime lookup races every other pi session on the machine). The dir name carries the short HEAD, so evidence dirs self-identify.
- Keep the prompt neutral: a prompt that names a skill adds nothing, and a neutral one keeps the spot-check honest.
- Boot-clean is process evidence: `exit-status` must hold 0 and `stderr.txt` must be 0 bytes. Both persist in the session dir next to the transcript, and the audit below re-verifies them fail-closed.

## Run the one-shot in the clean-room rig

The recipe above runs with the operator's full user rights. The clean-room rig (ADR 0005, GLOSSARY) moves the run into a disposable Linux container where a session can damage at most its own scratch space, and exercises the Linux leg for real — case-sensitive paths, GNU coreutils, a non-zsh shell, an empty first-run `~/.pi`. From a clean checkout:

```sh
node test/rig/run.mjs build
node test/rig/run.mjs run "<prompt>"
```

Spot-check leg arguments ride `--leg`, repeatable, one per auditor leg slot in its order (skill, script, notebook) — `-` skips a slot, so a script-plus-notebook capture runs the skill leg as `-`:

```sh
node test/rig/run.mjs run "<real task routing into the skill>" \
  --leg - --leg skills/theta-notebook/scripts/notebook.py --leg .theta
```

The routed prompt stages any session scratch — a file the task assembles before recording it, say — outside the checkout (`/tmp`), never "in the working directory": the auditor's final clean-tree recheck refuses the untracked file after every leg has passed, and the roll is lost (the S5 job-record capture's first roll died exactly this way). The durable copy belongs in the notebook's content-addressed store; the scratch file earns no place in the tree.

The runner gates on a clean tree host-side, records the pre-run HEAD and `package.json` digest, and prepares the one credential the rig receives: the target provider's key, extracted from the host pi config into a 0600 temp dir and mounted read-only. Inside, the checkout is a fresh clone of the pinned HEAD, staged through a host-side scratch clone (a worktree's `.git` pointer names a host path and does not survive the mount) — clean by construction, writable where the notebook leg needs `.theta/` — the session dir mounts at `/session` so the transcript and process files land on the host as they are written, and the auditor runs from the clone, where every path it binds is self-consistent; the attestation is printed and saved beside the evidence. Evidence lands under the operator's evidence root unless `--session-dir` says otherwise.

Two mechanical differences from the host recipe, both recorded in the evidence: GNU `timeout` stands in for the hand-rolled watchdog (SIGTERM at the bound, SIGKILL 15 s later; exit 124 writes the `watchdog` sentinel the audit rejects), and the runner refuses a non-ASCII prompt before the run instead of after it. Resource Saver may pause the Docker VM between runs; the runner waits out the wake instead of reporting a false failure.

The boundary is deliberate: no SSH keys and no cluster token enter the rig, so gateway live legs stay on the host path (ADR 0004). Adversarial sessions get the same walls with a keyboard: `node test/rig/run.mjs shell`.

## Gateway-bearing sessions

The gateway's tools register at launch only: pi connects its MCP servers when the session starts, never later. Run the preflight before every launch — the port-forward answers (`/mcp` returns 401 without a token), and the forward runs with keepalive flags (`ServerAliveInterval=15 ServerAliveCountMax=4 ExitOnForwardFailure=yes`) so a dead tunnel fails loudly instead of hanging mid-session. A session that starts without the tools improvises: the S6 closeout's r2 roll wrote its own gateway client and drove it with the token from the user's MCP registration, past the submit gate (ADR 0004 records the residual).

pi's default MCP server exposure is codemode, and pi auto-activates the codemode tool when such a server connects — a gateway session already runs it. The tool has the model write a JavaScript script that calls the session's tools as functions; every nested call still crosses the tool-call pipeline (`parentToolCallId` links the layers), so the submit gate sees codemode-driven submits exactly like direct ones (the M4 S1 live evidence drove the gateway through codemode scripts). Since M5 S2 the gate is the stacked gate framework: the nested call's `parentToolCallId` rides the confirm prompt (the user answering sees which parent call is spending the time), the refusal reason, and the gate log — `gate.jsonl` beside the session transcript, one JSONL line per gated decision (`approved`, `refused`, or an annotation-drift `drift`), best-effort so a log failure never changes the decision.

A destructive call can only cross the submit gate where a user can answer: print mode installs a no-op UI whose confirm returns false, so every submit there is client-denied — that refusal is the record, and a cheap probe captures it. To let a submit through headlessly, run the session in **RPC mode** and answer the gate from a small JSONL-over-stdio driver: when the `confirm` request arrives on stdout, reply `{"type":"extension_ui_response","id":…,"confirmed":true}` on stdin (pi's rpc-extension-ui docs own the protocol). Two gotchas the M5 S0 live leg paid for: scrub the ambient `ANTHROPIC_*` env from the pi child or provider auth breaks, and pin the provider and model on the command line (`--provider zai-coding-cn --model glm-5.3-flash`) — the user config stores no default. That leg's working driver and captured evidence sit in the owner's m5-s0-live evidence dir (the pointer lives in the owner's private notes). The routed prompt runs the whole task in one turn (a mid-session prose answer is a second user record and the auditor refuses the roll), calls only the tools the session has registered, and keeps credentials out of scripts.

## Ground-truth the evidence

The pi session transcript is the record. Pi advertises the skill library in the session's system records — assert against those records only. Grepping the whole file proves nothing: the user prompt and tool activity can carry a skill name into a session where nothing was advertised.

The oracle is the checked-in `test/expected-skills.json` inventory, not the `skills/` tree, so a dirty checkout cannot shrink the expectation silently. The check runs both ways: every inventory skill must be advertised, and no **extra** checkout skill may appear — a dirty `package.json` that adds a skill source cannot slip in. The audit reads only the `skills` section of the single skills-bearing system record (`message.sections.skills` — the field pi maintains; tools-only system patches are ignored, but two records carrying a skills section fail loudly) — host skills and project context share the system prompt, so raw text elsewhere in it can vouch for nothing. Locations are XML-decoded (including `&apos;`) and compared exactly. Every transcript line must parse — a corrupt or truncated file fails loudly instead of quietly shrinking the evidence. Nested calls never add records — a codemode script's calls ride the calling tool's result as the `nestedCalls` bounded record, and the audit reads that record instead of assuming a flat call sequence: every nested id must derive from the carrying result's `toolCallId` (pi assigns `<parent id>/<n>`), all nested ids are unique, and none may claim a top-level call's id — a fabricated nestedCalls record fails closed. The same audit re-verifies the boot-clean process files: a non-zero `exit-status`, a non-empty `stderr.txt`, or missing files fails before the transcript is even parsed. It also binds the runtime: the session's `cwd` must equal this checkout, the `model_change` record must match the expected provider and model recorded at launch, and the pi and node versions must clear the repository's 1.4.0 and 22.19.0 floors. The working tree must be clean of tracked and untracked changes (clear scratch venvs and `__pycache__` first, below) at pre-launch and audit time, so the cited HEAD is what was audited. This is a git-status proof: files excluded by `.gitignore` are outside it by design, which is why the launch gate refuses a dirty tree instead of trusting ignored local state. On success it prints a full attestation: the Git HEAD as its first line — `clean 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c`, the token `scripts/check-strike.mjs` matches in PR bodies with the pattern the auditor owns — then SHA-256 digests of the transcript and both process files, the pi and node versions, the verified provider and model, the audited inventory digest, and the prompt's digest with the nested-call count — the evidence names exactly what it attests; keep that output with the run's record. Printed output on failure, or any non-zero exit, fails the criterion. The root comes from `fs.realpathSync`, so a symlinked checkout still matches the advertised paths.

The auditor is a tested repository script, `scripts/audit-dogfood.mjs` (unit tests in `test/dogfood-audit.test.mjs`). Run it against the session dir:

```sh
node scripts/audit-dogfood.mjs "$sd"
```

The spot-check is a second full one-shot in its own session dir, prompted with a real task in the skill's domain — never a prompt that names the skill or its file. What it attests is that the **selected file was opened in a real session**: the model reached the SKILL.md on its own, unprompted by name. It does not claim deeper autonomous routing — a global instruction could still steer a read — and the audit rejects prompts that name the skill or file so the recorded evidence stays meaningful. The prompt is written into the session dir, and the audit verifies the session ran exactly that prompt. Record shapes live in [pi-transcript-schema.md](pi-transcript-schema.md):

```sh
sd2=$(mktemp -d "${TMPDIR:-/tmp}/dogfood-spot-$(git rev-parse --short HEAD)-XXXXXX")
st=$(git status --porcelain --untracked-files=all) || { echo "git status failed"; exit 1; }
[ -n "$st" ] && { echo "working tree dirty — commit first"; exit 1; }
git rev-parse HEAD > "$sd2/pre-head"
printf '%s' "<real task routing into the skill — name the research domain, not the skill or its files>" > "$sd2/prompt.txt"
printf '%s\n' "zai-coding-cn glm-5.3-flash" > "$sd2/expected-model"
node -p "require('crypto').createHash('sha256').update(require('fs').readFileSync('package.json')).digest('hex')" > "$sd2/manifest-sha256"
pi --version > "$sd2/pi-version"
node --version > "$sd2/node-version"
node bin/theta.mjs --dev --provider zai-coding-cn --model glm-5.3-flash \
  --session-dir "$sd2" --print "<real task routing into the skill — name the research domain, not the skill or its files>" 2> "$sd2/stderr.txt" < /dev/null &
pid=$!
( sleep 300; echo fired > "$sd2/watchdog" 2>/dev/null; kill $pid 2>/dev/null; sleep 15; kill -9 $pid 2>/dev/null ) & watchdog=$!
wait $pid
echo $? > "$sd2/exit-status"
kill $watchdog 2>/dev/null; pkill -P $watchdog 2>/dev/null
```

Audit `$sd2` with the same one command, passing the skill path as a second argument — one invocation runs every check above on that session and then, only if all of them passed, requires a read of the skill's `SKILL.md` from this checkout against the same in-memory transcript: a `read` tool call whose path canonicalizes to the checkout's copy exactly, paired by `toolCallId` with a `toolResult` that reports no error and whose text equals the current file contents — `offset` and `limit` are not judged, because a fragment cannot reproduce the full file's bytes. The attested fact is **selected file opened in a real session**, not autonomous routing. The skill argument must resolve to an advertised checkout SKILL.md — traversal or any non-skill path is rejected. Path mentions in `bash` commands, writes, prose, or thinking are not use. Nothing can slip between the checks — one auditor, one attestation.

```sh
node scripts/audit-dogfood.mjs "$sd2" "skills/literature-review/SKILL.md"
```

On success the attestation carries every `clean` line plus `selected-file-opened` with the resolved skill path and the SKILL.md content digest — and the recorded prompt's digest, so the routed task itself is part of the durable record; keep it with the run's record. A session that reads SKILL.md in offset/limit fragments attests nothing — a refused run, redone, never excused (observed in the M2 closeout re-capture). The fragment class has a mechanical floor: pi's reader appends a `[N more lines in file. Use offset=… to continue.]` trailer whenever any segment remains, and a trailing newline is a segment — so a `wc -l`-exact limit still fails byte-equality, and a passing read is one call whose limit clears the file's segment count. The task prompt may secure that without naming anything: have the session check each document's length, then read each one whole in a single call with some headroom past the end (the M3 recapture passed the first roll so prompted, after seven fragment refusals — fourteen refusals across both recaptures were all this class).

The script-executed attestation is a third optional argument on the same command — the checkout-relative path of a helper script. It turns "the skill was advertised and opened" into "the capability was used": a `bash` tool call recorded after the prompt whose command names the script **in program position** — the command word itself (direct execution needs a slash in the word and the execute bit), or the program argument of an interpreter (`python3 …`, `env …`), with wrappers (`timeout`, …) and an earlier `cd` in the command resolved (`pushd` behaves like cd — `-n` is a dry run — and `popd` loses the anchor) — canonicalized to the checkout's copy, paired by `toolCallId` with a `toolResult` that reports no error. Short-circuits are judged conservatively: a segment after `&&` attests only when its chain runs to the command's end (a non-error overall result then proves the chain ran), a segment after `||` never attests (the overall exit status cannot prove it ran), control-flow commands (`if`, `while`, `case`, `for`, brace groups, function definitions) are refused outright — as are `trap`, `eval`, `builtin`, `source`, and noexec, noclobber, or restricted `set`, and `exit`/`exec` at top level end the shell so nothing after them attests (subshell-confined forms die with their subshell) — and a `cd` whose successful run the audit cannot prove — `||`-guarded, decoupled by a later separator, CDPATH-shadowed, expansion-sourced, or unresolvable now — makes later relative paths unattestable, while a backgrounded or pipelined cd moves only its subshell and the parent anchor holds. Bash opens a command's redirections before running it, so a redirection that provably fails — a missing parent directory, a directory as the target, a dangling symlink, an unreadable or unwritable path, a bad file descriptor — taints the whole invocation, judged against the anchor current at that point. Mentions do not attest: the path as a `grep`/`cat` argument, in a comment, a heredoc body, or a redirection target is not execution (stdin-fed interpreters are refused with the other stdin forms); neither is a copy of the script run from outside the checkout, nor a nested `bash -c` string — the attested bytes are the checkout's at the audited HEAD. The tool environment's ambient `CDPATH` and `PATH` are outside the audit — any in-command `CDPATH` mention (a `read` can assign it without the `=` spelling) shadows relative cds, and a `PATH=` reassignment in the same segment as the invocation ends its program search.

The routed prompt must not name the script or its path, for the same reason it must not name the skill. Some genuine executions are refused rather than guessed — interpreter flag prefixes (`python3 -u …`), conditional chains inside subshells, adjacent subshell sequences, `~` paths, control flow: a refused spot-check means redoing the run with a plain invocation, never weakening the gate.

```sh
node scripts/audit-dogfood.mjs "$sd2" "skills/theta-lit-search/SKILL.md" "skills/theta-lit-search/scripts/pubmed.py"
```

On success the attestation additionally carries `script-executed` with the resolved script path and `script-content`, the executed file's digest.

The notebook-written attestation is a fourth optional argument on the same command — the checkout-relative path of the `.theta` project notebook directory. It extends the script-executed leg rather than standing alone: the same invocation must also pass the recorder itself as the script argument (`skills/theta-notebook/scripts/notebook.py` — anything else is refused, and a notebook argument without the script argument fails outright), so the attested fact is "the session executed the recorder, and the notebook the checkout holds parses into well-formed, dated provenance entries" — captured files, never the model's self-report. Notebook files alone, however clean, attest nothing: the not-run golden fixture is exactly that case and goes red. Passing `-` as any leg argument skips that leg's slot when only the later legs are wanted — the notebook leg still requires the script argument, so a `-` there fails with that leg's own error.

The files are judged the way the recorder writes them (ADR 0003). Every line of `notebook.jsonl` must parse into a typed provenance entry: one of the five types (hypothesis, method, observation, decision, confidence), an id sequenced per type (`hyp-0001`, `mth-0001`, … in file order), a calendar-valid `date`, and non-empty text. Hypothesis and observation entries require a non-empty evidence list; method and decision entries carry one when a motivating source was recorded; a confidence entry carries none — judgment is not a source claim — and instead names the hypothesis it judges. Only an observation carries an entry-level grade: a grade rates a source, judgment is the confidence entry type, and the two never merge, so a grade on any other type is refused. An evidence item is one of two shapes, and the item's own fields say which. A connector item carries a non-empty source, a non-empty endpoints list, a query that is a string or null, a calendar-valid `retrieved`, one of the three evidence grades, and an `evidence/<sha256>.json` address. A job-record item (ADR 0004) carries the same grade, retrieval date, and address, plus the compute job's identity: the gateway as source, a digits-only `job_id`, the template (a name, or null for a raw submit), a 64-hex `arguments_digest`, the final state, and the artifact manifest when the artifacts were fetched — paths and sizes, never file contents. Either shape on an observation may carry a `supports` link. Every reference — a confidence's subject, an item's `supports` — must resolve to an earlier hypothesis entry. Every cited snapshot must resolve inside `.theta`, hash to its own address, parse as the shape its item declares — a connector `--json` output (source, `provenance.calls` with endpoint and url, an `accessed` date) or an assembled gateway job record (gateway, digits job ID, run name, template, argument digest, final state, an `observed` date the item's `retrieved` carries, and a manifest free of `content_b64`) — and agree with the evidence item it backs. The re-executed grade still stands on the fetched manifest, as in the recorder. Extra snapshot files are tolerated: the recorder's write order orphans snapshots, never entries. The routed prompt must not name `notebook.jsonl`, for the same reason it must not name the skill or the script.

```sh
node scripts/audit-dogfood.mjs "$sd2" "skills/theta-notebook/SKILL.md" "skills/theta-notebook/scripts/notebook.py" ".theta"
```

On success the attestation additionally carries `notebook-written` with the resolved directory, `notebook-entries` and `notebook-evidence` (entries and distinct snapshots cited — orphan snapshots are not counted), and `notebook-digest`, the SHA-256 of `notebook.jsonl`. Golden fixture session dirs — the pass case, an all-types notebook (one entry of each type with a resolving evidence-to-hypothesis link), the job-record method entry (M4), recorder not run, a malformed entry, an undated entry — live under `test/fixtures/notebook-audit/`; the offline suite runs the auditor CLI on each and requires green on pass, red on every failure. One residual of its own, beyond the script-executed ones it inherits: the project notebook accumulates across sessions by design, so entries may predate the audited run — the attestation is structural (the recorder executed in this session, and the checkout's notebook is recorder-shaped), not a proof that this session wrote these exact lines; the operator's capture voucher covers the gap, as elsewhere.

### Residuals

The script-executed attestation's residual trust boundaries, accumulated across the #21 adversarial review loop and co-located here. The loop stopped by judgment once its findings reached the crafted-command class, per its own termination rule.

1. Interpreter rebinding in an *earlier* segment of the same call — a standalone `PATH=` assignment, `hash -p`, `alias` after `shopt -s expand_aliases` — is not tracked across segments.
2. A wrapper flag whose value word is a terminator (`sudo -p; exit 0`) eats it before the terminator refusal fires.
3. A script truncated by a redirect and then restored inside the session passes the clean-tree gate.
4. The shell model is conservative but not complete — the same trust boundary as deliberate tampering. A command adversarially crafted around an unmodelled corner of the grammar — fd duplication chains, wrapper flag values, environment-assigning builtins — can in principle pair a non-execution with a non-error result. The auditor's job is honest dogfood evidence under the operator's prompt-quality voucher, not defense against a hostile command craftsman.
5. When the invocation is followed by `;`, `&`, or `||` commands in the same bash call — or runs inside `$( )` or a pipeline tail — the call's recorded exit status is the last command's: the execution attestation stands unless the trailing context could have skipped or stopped it, but the non-error result no longer speaks for the script's own exit.
6. A redirection onto the script's own path would truncate it before the interpreter opens it — deliberate in-session tampering territory, but it means the attested bytes are the tree's bytes at audit time, not a copy of what executed.

## Clean up after

Dogfood sessions execute skill scripts; they leave scratch venvs and `__pycache__` inside vendored trees. The hash-pin seam fails on them by design, so clear them before committing:

```sh
find skills -type d \( -name __pycache__ -o -name '.venv*' \) -prune -exec rm -rf {} +
```

Refused spot-check reruns leave their recorded entries behind as well: clear the checkout's gitignored `.theta/` between reruns, so the audited notebook reflects the one session that passed (the M3 recapture let it accumulate to eleven entries, and its PR body had to say so).
