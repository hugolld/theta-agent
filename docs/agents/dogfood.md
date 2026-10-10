# Dogfooding theta

`theta --dev` boots pi with this package preloaded from a local checkout. The skill-list and skill-opened criteria are accepted on **transcript evidence** — never on the model's self-report. A model asked "is skill X available?" can answer confidently from files it merely sees on disk. The tracer PR (#9) recorded a met criterion that way; PR #10 found the skills were not loading at all. Clean boot is different: it is **process evidence** — exit status and stderr, captured at run time (see the recipe below), because no transcript can reconstruct them.

## Run a one-shot session

From the checkout:

```sh
sd=$(mktemp -d)
st=$(git status --porcelain) || { echo "git status failed"; exit 1; }
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
( sleep 300 && echo fired > "$sd/watchdog" && kill $pid 2>/dev/null && sleep 15 && kill -9 $pid 2>/dev/null ) & watchdog=$!
wait $pid
echo $? > "$sd/exit-status"
kill $watchdog 2>/dev/null
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

The oracle is the checked-in `test/expected-skills.json` inventory, not the `skills/` tree, so a dirty checkout cannot shrink the expectation silently. The check runs both ways: every inventory skill must be advertised, and no **extra** checkout skill may appear — a dirty `package.json` that adds a skill source cannot slip in. The audit reads only the `skills` section of the single system record (`message.sections.skills` — the field pi maintains; a one-shot session has exactly one system record, and any other count fails loudly) — host skills and project context share the system prompt, so raw text elsewhere in it can vouch for nothing. Locations are XML-decoded (including `&apos;`) and compared exactly. Every transcript line must parse — a corrupt or truncated file fails loudly instead of quietly shrinking the evidence. The same audit re-verifies the boot-clean process files: a non-zero `exit-status`, a non-empty `stderr.txt`, or missing files fails before the transcript is even parsed. It also binds the runtime: the session's `cwd` must equal this checkout, the `model_change` record must match the expected provider and model recorded at launch, and the pi and node versions must clear the repository's 0.99 and 22 floors. The tracked working tree must be clean at pre-launch and audit time (clear scratch venvs and `__pycache__` first, below), so the cited HEAD is what was audited. On success it prints a full attestation: the Git HEAD, SHA-256 digests of the transcript and both process files, the pi and node versions, the verified provider and model, and the audited inventory digest — the evidence names exactly what it attests; keep that output with the run's record. Printed output on failure, or any non-zero exit, fails the criterion. The root comes from `fs.realpathSync`, so a symlinked checkout still matches the advertised paths.

```sh
node -e '
  const fs = require("fs");
  const [dir, skill] = process.argv.slice(1);
  const root = fs.realpathSync(".");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  if (files.length !== 1) {
    console.error("expected exactly 1 session file, found " + files.length);
    process.exit(1);
  }
  const text = fs.readFileSync(dir + "/" + files[0], "utf8");
  const lines = text.trim().split("\n").filter(Boolean);
  const recs = lines.map(l => {
    try { return JSON.parse(l); } catch (e) {
      console.error("corrupt transcript: " + e.message);
      process.exit(1);
    }
  });
  if (fs.existsSync(dir + "/watchdog")) {
    console.error("watchdog fired: run exceeded 300s");
    process.exit(1);
  }
  const sysRecs = recs.filter(r => r.message?.role === "system");
  if (sysRecs.length !== 1) {
    console.error("expected exactly 1 system record, found " + sysRecs.length);
    process.exit(1);
  }
  const sess = recs.find(r => r.type === "session");
  if (!sess || sess.cwd !== root) {
    console.error("session cwd mismatch: expected " + root);
    process.exit(1);
  }
  const promptWanted = fs.readFileSync(dir + "/prompt.txt", "utf8");
  const userRec = recs.find(r => r.message?.role === "user");
  const userText = Array.isArray(userRec?.message?.content)
    ? userRec.message.content.filter(c => c?.type === "text").map(c => c.text).join("")
    : userRec?.message?.content;
  if (userText !== promptWanted) {
    console.error("prompt mismatch: the session did not run the recorded prompt");
    process.exit(1);
  }
  let bootExit;
  let bootErr;
  let piVersion;
  let nodeVersion;
  try {
    bootExit = fs.readFileSync(dir + "/exit-status", "utf8").trim();
    bootErr = fs.readFileSync(dir + "/stderr.txt").length;
    piVersion = fs.readFileSync(dir + "/pi-version", "utf8").trim().replace(/^v/, "");
    nodeVersion = fs.readFileSync(dir + "/node-version", "utf8").trim().replace(/^v/, "");
  } catch {
    console.error("missing process-evidence files (exit-status, stderr.txt, pi-version, node-version, prompt.txt)");
    process.exit(1);
  }
  const ge = (a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return true;
  };
  if (!ge(piVersion, "0.99")) {
    console.error("pi " + piVersion + " is below the supported 0.99 floor");
    process.exit(1);
  }
  if (!ge(nodeVersion, "22")) {
    console.error("node " + nodeVersion + " is below the supported 22 floor");
    process.exit(1);
  }
  if (bootExit !== "0" || bootErr !== 0) {
    console.error("boot not clean: exit " + bootExit + ", stderr " + bootErr + " bytes");
    process.exit(1);
  }
  const wantModel = fs.readFileSync(dir + "/expected-model", "utf8").trim().split(/\s+/);
  const changes = recs.filter(r => r.type === "model_change");
  if (changes.length !== 1) {
    console.error("expected exactly 1 model_change record, found " + changes.length);
    process.exit(1);
  }
  if (changes[0].provider !== wantModel[0] || changes[0].modelId !== wantModel[1]) {
    console.error("model mismatch: ran " + changes[0].provider + "/" + changes[0].modelId +
      ", expected " + wantModel[0] + "/" + wantModel[1]);
    process.exit(1);
  }
  const skillsText = sysRecs[0].message?.sections?.skills ?? "";
  const section = skillsText.match(/<available_skills>([\s\S]*?)<\/available_skills>/);
  if (!section) {
    console.error("no available_skills section in system records");
    process.exit(1);
  }
  const decode = s => s.replace(/&(amp|lt|gt|quot|apos|#39);/g,
    (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "\x27", "#39": "\x27" })[e]);
  const locations = new Set(
    [...section[1].matchAll(/<location>([\s\S]*?)<\/location>/g)].map(m => decode(m[1])));
  const inv = JSON.parse(fs.readFileSync("test/expected-skills.json", "utf8"));
  const names = inv.vendored.map(e => e.name).concat(inv["self-authored"]);
  let fail = false;
  for (const n of names) {
    const p = root + "/skills/" + n + "/SKILL.md";
    if (!locations.has(p)) {
      console.error("NOT advertised: " + n);
      fail = true;
    }
  }
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const raw = manifest.pi?.skills ?? ["./skills"];
  if (!Array.isArray(raw) || raw.length !== 1 ||
      typeof raw[0] !== "string" || /[*?[\]{}]/.test(raw[0])) {
    console.error("audit supports a single plain-directory pi.skills entry");
    process.exit(1);
  }
  const path = require("path");
  const skillRoots = [path.resolve(root, raw[0])];
  const expected = new Set(names.map(n => root + "/skills/" + n + "/SKILL.md"));
  const extras = [...locations].filter(l =>
    skillRoots.some(r => l.startsWith(r + "/")) && !expected.has(l));
  if (extras.length > 0) {
    console.error("UNEXPECTED advertised skills:\n" + extras.join("\n"));
    process.exit(1);
  }
  if (fail) process.exit(1);
  const { execSync } = require("child_process");
  const crypto = require("crypto");
  const dirty = execSync("git status --porcelain").toString().trim();
  if (dirty) {
    console.error("working tree dirty:\n" + dirty);
    process.exit(1);
  }
  const head = execSync("git rev-parse HEAD").toString().trim();
  const preHead = fs.readFileSync(dir + "/pre-head", "utf8").trim();
  if (head !== preHead) {
    console.error("HEAD moved since the run: " + preHead + " -> " + head);
    process.exit(1);
  }
  const manifestSha = fs.readFileSync(dir + "/manifest-sha256", "utf8").trim();
  const curManifest = crypto.createHash("sha256")
    .update(fs.readFileSync("package.json")).digest("hex");
  if (curManifest !== manifestSha) {
    console.error("package.json changed since the run");
    process.exit(1);
  }
  const sha = p =>
    crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  let out = "clean " + head +
    "\ntranscript " + crypto.createHash("sha256").update(text).digest("hex") +
    "\nexit-status " + sha(dir + "/exit-status") +
    "\nstderr " + sha(dir + "/stderr.txt") +
    "\npi " + piVersion +
    "\nnode " + nodeVersion +
    "\nprovider " + wantModel[0] +
    "\nmodel " + wantModel[1] +
    "\ninventory " + sha("test/expected-skills.json");
  if (skill !== undefined) {
    const target = root + "/" + skill;
    const calls = [];
    const results = new Map();
    for (const r of recs) {
      const m = r.message;
      if (!m) continue;
      if (Array.isArray(m.content))
        for (const t of m.content) if (t?.type === "toolCall") calls.push(t);
      if (m.role === "toolResult") results.set(m.toolCallId, m);
    }
    const hit = calls.some(t => {
      const r = results.get(t.id);
      return t.name === "read" && t.arguments?.path === target && r && r.isError !== true;
    });
    if (!hit) {
      console.error("NOT used");
      process.exit(1);
    }
    out += "\nused " + target + "\nskill-content " + sha(target);
  }
  console.log(out);
  process.exit(0);
' "$sd"
```

The spot-check is a second full one-shot in its own session dir, prompted with a real task that routes into the named skill — never a prompt that merely asks about it. The prompt is written into the session dir, and the audit verifies the session ran exactly that prompt, so the routing judgment is made on recorded evidence:

```sh
sd2=$(mktemp -d)
st=$(git status --porcelain) || { echo "git status failed"; exit 1; }
[ -n "$st" ] && { echo "working tree dirty — commit first"; exit 1; }
git rev-parse HEAD > "$sd2/pre-head"
printf '%s' "<real task routing into the skill>" > "$sd2/prompt.txt"
printf '%s\n' "zai-coding-cn glm-5.3-flash" > "$sd2/expected-model"
node -p "require('crypto').createHash('sha256').update(require('fs').readFileSync('package.json')).digest('hex')" > "$sd2/manifest-sha256"
pi --version > "$sd2/pi-version"
node --version > "$sd2/node-version"
node bin/theta.mjs --dev --provider zai-coding-cn --model glm-5.3-flash \
  --session-dir "$sd2" --print "<real task routing into the skill>" 2> "$sd2/stderr.txt" < /dev/null &
pid=$!
( sleep 300 && echo fired > "$sd2/watchdog" && kill $pid 2>/dev/null && sleep 15 && kill -9 $pid 2>/dev/null ) & watchdog=$!
wait $pid
echo $? > "$sd2/exit-status"
kill $watchdog 2>/dev/null
```

Audit `$sd2` with the same one command, passing the skill path as a second argument — one invocation runs every check above on that session and then, only if all of them passed, requires a read of the skill's `SKILL.md` from this checkout against the same in-memory transcript: a `read` tool call whose path argument equals the checkout's copy exactly, paired by `toolCallId` with a `toolResult` that reports no error. Path mentions in `bash` commands, writes, prose, or thinking are not use. Nothing can slip between the checks — one auditor, one attestation.

```sh
node -e '<the auditor above>' "$sd2" "skills/literature-review/SKILL.md"
```

On success the attestation carries every `clean` line plus `used` with the resolved skill path and the SKILL.md content digest; keep it with the run's record.

## Clean up after

Dogfood sessions execute skill scripts; they leave scratch venvs and `__pycache__` inside vendored trees. The hash-pin seam fails on them by design, so clear them before committing:

```sh
find skills -type d \( -name __pycache__ -o -name '.venv*' \) -prune -exec rm -rf {} +
```
