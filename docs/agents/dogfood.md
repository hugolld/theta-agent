# Dogfooding theta

`theta --dev` boots pi with this package preloaded from a local checkout. Acceptance criteria that name it (clean boot, the full skill list, a skill opened in a real session) are accepted on **transcript evidence** — never on the model's self-report. A model asked "is skill X available?" can answer confidently from files it merely sees on disk. The tracer PR (#9) recorded a met criterion that way; PR #10 found the skills were not loading at all.

## Run a one-shot session

From the checkout:

```sh
sd=$(mktemp -d)
node bin/theta.mjs --dev --provider zai-coding-cn --model glm-5.3-flash \
  --session-dir "$sd" --print "<prompt>" < /dev/null
```

- Pass provider and model explicitly: pi's default model can 401 with an invalid bearer token.
- Close stdin (`< /dev/null`): `pi --print` waits for stdin EOF even with a prompt argument, and a shell that leaves the pipe open hangs the session silently (found in the issue #8 close-out dogfood — 50 minutes, zero output, zero CPU).
- Run inside an isolated `--session-dir`: the fresh temp dir holds exactly this run's transcript, so the audit below can never pick up another session (a newest-by-mtime lookup races every other pi session on the machine).
- Keep the prompt neutral: a prompt that names a skill adds nothing, and a neutral one keeps the spot-check honest.
- Boot-clean evidence is exit 0 with empty stderr.

## Ground-truth the evidence

The pi session transcript is the record. Pi advertises the skill library in the session's system record — grep inside that record only. Grepping the whole file proves nothing: the user prompt and tool activity can carry a skill name into a session where nothing was advertised.

```sh
f=$(ls "$sd"/*.jsonl | head -1)
for d in skills/*/; do
  grep -m1 '"role":"system"' "$f" | grep -Fq "$PWD/${d}SKILL.md" || echo "NOT advertised: $d"
done
```

Each line anchors the skill's absolute path in this `--dev` checkout (`$PWD/skills/<name>/SKILL.md`), so the evidence ties to this checkout and not to an installed copy. The expected set comes from `skills/*/` at run time, so it cannot go stale. Silence means every skill was advertised.

For a spot-check, prompt a real task that routes into the named skill, then require a tool to have run on the skill's files: a `toolCall` whose arguments carry the skill's checkout path, paired by `toolCallId` with a `toolResult` that reports no error. The system record alone cannot prove use — it advertises every path — and a reply that merely describes the skill is not evidence.

```sh
node -e '
  const fs = require("fs");
  const [file, root, skill] = process.argv.slice(1);
  const recs = fs.readFileSync(file, "utf8").trim().split("\n")
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const calls = [], results = new Map();
  for (const r of recs) {
    const m = r.message; if (!m) continue;
    if (Array.isArray(m.content))
      for (const t of m.content) if (t?.type === "toolCall") calls.push(t);
    if (m.role === "toolResult") results.set(m.toolCallId, m);
  }
  const hit = calls.some(t => {
    const r = results.get(t.id);
    return r && r.isError !== true &&
      JSON.stringify(t.arguments ?? {}).includes(root + "/" + skill);
  });
  console.log(hit ? "used" : "NOT used");
' "$f" "$PWD" "skills/literature-review/SKILL.md"
```

## Clean up after

Dogfood sessions execute skill scripts; they leave scratch venvs and `__pycache__` inside vendored trees. The hash-pin seam fails on them by design, so clear them before committing:

```sh
find skills -type d \( -name __pycache__ -o -name '.venv*' \) -prune -exec rm -rf {} +
```
