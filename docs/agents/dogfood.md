# Dogfooding theta

`theta --dev` boots pi with this package preloaded from a local checkout. The skill-list and skill-opened criteria are accepted on **operator-attested structural evidence**: recorded transcript and process artifacts whose internal consistency the auditor checks — never on the model's self-report alone. A model asked "is skill X available?" can answer confidently from files it merely sees on disk. The tracer PR (#9) recorded a met criterion that way; PR #10 found the skills were not loading at all. Clean boot is different: it is **process evidence** — exit status and stderr, captured at run time (see the recipe below), because no transcript can reconstruct them. One trust boundary to state plainly: the session directory is operator-supplied and writable by the running model. The auditor checks the structural consistency of the recorded session against the tree, and the operator vouches for capture. It does not defend against a model or skill script that deliberately tampers with the session artifacts — containing that would require a parent-controlled supervisor, which this recipe intentionally is not.

## Run a one-shot session

From the checkout:

```sh
sd=$(mktemp -d)
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
- Bound the run: the watchdog sends SIGTERM at 5 minutes — the launcher forwards it to `pi` — and 15 seconds later SIGKILLs the launcher if it still hangs, leaving a `watchdog` sentinel the audit rejects. A `pi` stalled through both signals may keep running detached, but the run fails either way. No coreutils needed.
- Record the runtime: `pi --version`, `node --version`, and the expected provider/model land in the session dir; the audit enforces the pi ≥ 0.99 and node ≥ 22 floors and verifies the transcript's `model_change` record against the expected run.
- Run inside an isolated `--session-dir`: the fresh temp dir holds exactly this run's transcript, so the audit below can never pick up another session (a newest-by-mtime lookup races every other pi session on the machine).
- Keep the prompt neutral: a prompt that names a skill adds nothing, and a neutral one keeps the spot-check honest.
- Boot-clean is process evidence: `exit-status` must hold 0 and `stderr.txt` must be 0 bytes. Both persist in the session dir next to the transcript, and the audit below re-verifies them fail-closed.

## Ground-truth the evidence

The pi session transcript is the record. Pi advertises the skill library in the session's system records — assert against those records only. Grepping the whole file proves nothing: the user prompt and tool activity can carry a skill name into a session where nothing was advertised.

The oracle is the checked-in `test/expected-skills.json` inventory, not the `skills/` tree, so a dirty checkout cannot shrink the expectation silently. The check runs both ways: every inventory skill must be advertised, and no **extra** checkout skill may appear — a dirty `package.json` that adds a skill source cannot slip in. The audit reads only the `skills` section of the single skills-bearing system record (`message.sections.skills` — the field pi maintains; tools-only system patches are ignored, but two records carrying a skills section fail loudly) — host skills and project context share the system prompt, so raw text elsewhere in it can vouch for nothing. Locations are XML-decoded (including `&apos;`) and compared exactly. Every transcript line must parse — a corrupt or truncated file fails loudly instead of quietly shrinking the evidence. The same audit re-verifies the boot-clean process files: a non-zero `exit-status`, a non-empty `stderr.txt`, or missing files fails before the transcript is even parsed. It also binds the runtime: the session's `cwd` must equal this checkout, the `model_change` record must match the expected provider and model recorded at launch, and the pi and node versions must clear the repository's 0.99 and 22 floors. The working tree must be fully clean — tracked and untracked (clear scratch venvs and `__pycache__` first, below) — at pre-launch and audit time, so the cited HEAD is what was audited. On success it prints a full attestation: the Git HEAD, SHA-256 digests of the transcript and both process files, the pi and node versions, the verified provider and model, and the audited inventory digest — the evidence names exactly what it attests; keep that output with the run's record. Printed output on failure, or any non-zero exit, fails the criterion. The root comes from `fs.realpathSync`, so a symlinked checkout still matches the advertised paths.

The auditor is a tested repository script, `scripts/audit-dogfood.mjs` (unit tests in `test/dogfood-audit.test.mjs`). Run it against the session dir:

```sh
node scripts/audit-dogfood.mjs "$sd"
```

The spot-check is a second full one-shot in its own session dir, prompted with a real task in the skill's domain — never a prompt that names the skill or its file. What it attests is that the **selected file was opened in a real session**: the model reached the SKILL.md on its own, unprompted by name. It does not claim deeper autonomous routing — a global instruction could still steer a read — and the audit rejects prompts that name the skill or file so the recorded evidence stays meaningful. The prompt is written into the session dir, and the audit verifies the session ran exactly that prompt:

```sh
sd2=$(mktemp -d)
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

On success the attestation carries every `clean` line plus `selected-file-opened` with the resolved skill path and the SKILL.md content digest; keep it with the run's record.

## Clean up after

Dogfood sessions execute skill scripts; they leave scratch venvs and `__pycache__` inside vendored trees. The hash-pin seam fails on them by design, so clear them before committing:

```sh
find skills -type d \( -name __pycache__ -o -name '.venv*' \) -prune -exec rm -rf {} +
```
