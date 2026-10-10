# Dogfooding theta

`theta --dev` boots pi with this package preloaded from a local checkout. The skill-list and skill-opened criteria are accepted on **transcript evidence** — never on the model's self-report. A model asked "is skill X available?" can answer confidently from files it merely sees on disk. The tracer PR (#9) recorded a met criterion that way; PR #10 found the skills were not loading at all. Clean boot is different: it is **process evidence** — exit status and stderr, captured at run time (see the recipe below), because no transcript can reconstruct them.

## Run a one-shot session

From the checkout:

```sh
sd=$(mktemp -d)
node bin/theta.mjs --dev --provider zai-coding-cn --model glm-5.3-flash \
  --session-dir "$sd" --print "<prompt>" 2> "$sd/stderr.txt" < /dev/null
echo $?                  # boot-clean: 0
wc -c < "$sd/stderr.txt" # boot-clean: 0
```

- Pass provider and model explicitly: pi's default model can 401 with an invalid bearer token.
- Close stdin (`< /dev/null`): `pi --print` waits for stdin EOF even with a prompt argument, and a shell that leaves the pipe open hangs the session silently (found in the issue #8 close-out dogfood — 50 minutes, zero output, zero CPU).
- Run inside an isolated `--session-dir`: the fresh temp dir holds exactly this run's transcript, so the audit below can never pick up another session (a newest-by-mtime lookup races every other pi session on the machine).
- Keep the prompt neutral: a prompt that names a skill adds nothing, and a neutral one keeps the spot-check honest.
- Boot-clean is process evidence: exit status 0 and a 0-byte `stderr.txt`, captured in the run and kept next to the transcript it gates.

## Ground-truth the evidence

The pi session transcript is the record. Pi advertises the skill library in the session's system records — assert against those records only. Grepping the whole file proves nothing: the user prompt and tool activity can carry a skill name into a session where nothing was advertised.

The oracle is the checked-in `test/expected-skills.json` inventory, not the `skills/` tree, so a dirty checkout cannot shrink the expectation silently. Exit 0 means every inventory skill was advertised; printed output or any non-zero exit fails the criterion. The root comes from `fs.realpathSync`, so a symlinked checkout still matches the paths pi advertised. Every transcript line must parse — a corrupt or truncated file fails loudly instead of quietly shrinking the evidence — and advertised locations are XML-decoded before comparison, so escaped entities in a checkout path cannot hide a skill.

```sh
node -e '
  const fs = require("fs");
  const [dir] = process.argv.slice(1);
  const root = fs.realpathSync(".");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  if (files.length !== 1) {
    console.error("expected exactly 1 session file, found " + files.length);
    process.exit(1);
  }
  const lines = fs.readFileSync(dir + "/" + files[0], "utf8")
    .trim().split("\n").filter(Boolean);
  const recs = lines.map(l => {
    try { return JSON.parse(l); } catch (e) {
      console.error("corrupt transcript: " + e.message);
      process.exit(1);
    }
  });
  const sys = recs
    .filter(r => r.message?.role === "system")
    .map(r => JSON.stringify(r.message))
    .join("")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) =>
      ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "\x27" })[e]);
  const inv = JSON.parse(fs.readFileSync("test/expected-skills.json", "utf8"));
  const names = inv.vendored.map(e => e.name).concat(inv["self-authored"]);
  let fail = false;
  for (const n of names) {
    if (!sys.includes(root + "/skills/" + n + "/SKILL.md")) {
      console.error("NOT advertised: " + n);
      fail = true;
    }
  }
  process.exit(fail ? 1 : 0);
' "$sd"
```

For a spot-check, prompt a real task that routes into the named skill, then require a read of the skill's `SKILL.md` from this checkout: a `read` tool call whose path argument equals the checkout's copy exactly, paired by `toolCallId` with a `toolResult` that reports no error. Path mentions in `bash` commands, writes, prose, or thinking are not use.

```sh
f=$(ls "$sd"/*.jsonl | head -1)   # the audit above enforces exactly one file
node -e '
  const fs = require("fs");
  const [file, skill] = process.argv.slice(1);
  const root = fs.realpathSync(".");
  const lines = fs.readFileSync(file, "utf8")
    .trim().split("\n").filter(Boolean);
  const recs = lines.map(l => {
    try { return JSON.parse(l); } catch (e) {
      console.error("corrupt transcript: " + e.message);
      process.exit(1);
    }
  });
  const calls = [];
  const results = new Map();
  for (const r of recs) {
    const m = r.message;
    if (!m) continue;
    if (Array.isArray(m.content))
      for (const t of m.content) if (t?.type === "toolCall") calls.push(t);
    if (m.role === "toolResult") results.set(m.toolCallId, m);
  }
  const target = root + "/" + skill;
  const hit = calls.some(t => {
    const r = results.get(t.id);
    return t.name === "read" && t.arguments?.path === target && r && r.isError !== true;
  });
  console.log(hit ? "used" : "NOT used");
  process.exit(hit ? 0 : 1);
' "$f" "skills/literature-review/SKILL.md"
```

## Clean up after

Dogfood sessions execute skill scripts; they leave scratch venvs and `__pycache__` inside vendored trees. The hash-pin seam fails on them by design, so clear them before committing:

```sh
find skills -type d \( -name __pycache__ -o -name '.venv*' \) -prune -exec rm -rf {} +
```
