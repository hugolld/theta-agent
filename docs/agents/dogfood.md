# Dogfooding theta

`theta --dev` boots pi with this package preloaded from a local checkout. Acceptance criteria that name it (clean boot, the full skill list, a skill opened in a real session) are accepted on **transcript evidence** — never on the model's self-report. A model asked "is skill X available?" can answer confidently from files it merely sees on disk. The tracer PR (#9) recorded a met criterion that way; PR #10 found the skills were not loading at all.

## Run a one-shot session

From the checkout:

```sh
node bin/theta.mjs --dev --provider zai-coding-cn --model glm-5.3-flash \
  --print "<prompt>"
```

- Pass provider and model explicitly: pi's default model can 401 with an invalid bearer token.
- Boot-clean evidence is exit 0 with empty stderr.

## Ground-truth the evidence

The pi session transcript is the record. Grep the newest session file for the skill names the criterion names:

```sh
f=$(ls -t ~/.pi/agent/sessions/*/*.jsonl | head -1)
grep -c "paper-lookup" "$f"    # a skill name appears iff pi advertised it
```

For a spot-check, prompt a real task that routes into the named skill, then confirm in the transcript that the skill's files or scripts were actually used — grep for the skill's path or a script name. A reply that merely describes the skill is not evidence.

## Clean up after

Dogfood sessions execute skill scripts; they leave scratch venvs and `__pycache__` inside vendored trees. The hash-pin seam fails on them by design, so clear them before committing:

```sh
find skills -type d \( -name __pycache__ -o -name '.venv*' \) -prune -exec rm -rf {} +
```
