# Dogfooding theta

`theta --dev` boots pi with this package preloaded from a local checkout. Acceptance criteria that name it (clean boot, the full skill list, a skill opened in a real session) are accepted on **transcript evidence** — never on the model's self-report. A model asked "is skill X available?" can answer confidently from files it merely sees on disk. The tracer PR (#9) recorded a met criterion that way; PR #10 found the skills were not loading at all.

## Run a one-shot session

From the checkout:

```sh
node bin/theta.mjs --dev --provider zai-coding-cn --model glm-5.3-flash \
  --print "<prompt>" < /dev/null
```

- Pass provider and model explicitly: pi's default model can 401 with an invalid bearer token.
- Close stdin (`< /dev/null`): `pi --print` waits for stdin EOF even with a prompt argument, and a shell that leaves the pipe open hangs the session silently (found in the issue #8 close-out dogfood — 50 minutes, zero output, zero CPU).
- Boot-clean evidence is exit 0 with empty stderr.

## Ground-truth the evidence

The pi session transcript is the record. Pi advertises the skill library in the session's system record — grep inside that record only. Grepping the whole file proves nothing: the user prompt and tool activity can carry a skill name into a session where nothing was advertised.

```sh
f=$(ls -t ~/.pi/agent/sessions/*/*.jsonl | head -1)  # capture the moment the run returns
grep -m1 '"role":"system"' "$f" | grep -c "skills/paper-lookup"   # 1 iff pi advertised it
```

- Capture the session file the moment the run returns: `ls -t` picks the newest across **all** pi sessions on the machine, and any later session would win.
- Match the skill's path (`skills/<name>`), not the bare name, and assert every library name, each ≥1 — the issue #8 close-out run confirmed all 20 paths appear in the system record.
- Keep the prompt neutral for the advertisement check: a prompt that names a skill adds nothing, and a neutral one keeps the spot-check honest too.

For a spot-check, prompt a real task that routes into the named skill, then confirm in the transcript that the skill's files or scripts were actually used — grep for the skill's path or a script name. A reply that merely describes the skill is not evidence.

## Clean up after

Dogfood sessions execute skill scripts; they leave scratch venvs and `__pycache__` inside vendored trees. The hash-pin seam fails on them by design, so clear them before committing:

```sh
find skills -type d \( -name __pycache__ -o -name '.venv*' \) -prune -exec rm -rf {} +
```
