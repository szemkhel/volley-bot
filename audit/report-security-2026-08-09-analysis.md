# Analysis of `report-security-2026-08-09.md`

Verified against the actual repo (checked which files are tracked/public, grepped for the exact
lines cited). This report is the strongest of the four — most findings hold up, and two of them
(F3, F6/F7) are **live, actionable right now on a public GitHub repo**, not theoretical.

---

## DO — confirmed real, actionable today (highest priority of the whole audit)

### 1. F3 + F6 + F7 — secrets/infra reconnaissance data is live on the public repo, right now
**Verified: real, and the single most important finding across all four reports.** Confirmed
`CLAUDE.md`, `README.md`, `.env.example`, `config.example.json` are all `git ls-files`-tracked (i.e.
public — `szemkhel/volley-bot` is a public repo). Confirmed by direct read:
- `CLAUDE.md` documents the exact PAT-recovery command
  (`git -C /opt/whatsapp-agent remote get-url origin | grep -oE 'ghp_[A-Za-z0-9]+'`) and states the
  token is "flagged for rotation" but not yet rotated.
- `CLAUDE.md` documents real internal IPs (`192.168.31.203` bot container, `192.168.31.103`
  Postgres, `192.168.31.108` Grafana) and the production Grafana public-dashboard access token.
- `.env.example` contains the *real* Postgres hostname and the *real* read-write role name
  (`volley_rw`) — only the password is a placeholder.

None of this is a live secret by itself, but together it's a ready-made target list: exact host to
attack, exact privileged role name to brute-force/guess, and documented instructions for extracting
a real credential from a container the reader now knows the IP of.

**Action (in order):**
1. **Rotate the classic PAT to a fine-grained token** (repo-scope only, no admin/workflow) —
   this was already flagged as pending in project memory; treat it as no-longer-optional given the
   extraction method is public.
2. **Move the PAT-recovery recipe out of the public `CLAUDE.md`** into the private memory file
   (`project_whatsapp_agent.md`, which already has an equivalent note) — the public repo doesn't
   need to explain how to pull a token out of the container.
3. **Replace real infra values in `.env.example`/`config.example.json`** with generic placeholders
   (`localhost`, `volley_bot` instead of `volley_rw`, drop specific IP octets). Note: this session
   discovered a local tool guard (`guard-secrets` hook) blocks editing files matching
   `.env`/`.env.example` patterns even for placeholder-only edits — whoever picks up this job will
   need to either get the user to make this specific edit themselves, or have the guard's pattern
   narrowed to exclude genuinely-placeholder files.
4. **Scrub real IPs from the public `CLAUDE.md`** — keep a sanitized public version (generic
   "production container", "Postgres mirror") and move the real IPs into the private memory doc,
   which already substantially duplicates this information for session use.
**Effort:** ~1-2 hours total (mostly careful find-and-replace across 4 files + the actual token
rotation, which requires the repo owner's GitHub session).

---

## DO — real, worth fixing, lower urgency

### 2. F5 — PII and full identity objects in `console.log`
**Verified: real, and slightly worse than described.** Confirmed lines: `index.js:227`
(`console.log("Vote recorded:", phone, ...)`), `:257` (`"MVP vote:", phone, ...`), `:1556`
(`console.log("[DBG sock.user]", JSON.stringify(sock.user))` — this dumps the bot's *entire*
WhatsApp identity object, not just a phone number), plus `:1051`/`:1262`/`:1413` logging full raw
command text via `JSON.stringify(text)`.
**Action:** Low-effort, no design risk — this is systemd/journald-local logging on a container only
the owner and this assistant access, so urgency is low, but it's a one-line-per-call fix:
- Remove or gate the `[DBG sock.user]` dump behind an explicit debug flag — it serves no purpose in
  steady-state operation and was clearly left in from debugging (matches the general report's note
  about debug-log cleanup being an open TODO already).
- For phone-number logging, a `maskPhone(p)` helper (last 4 digits only) is enough; full masking
  isn't necessary given the low actual exposure (single-operator container), but it's cheap and
  removes the habit of full PII in logs before it matters more.
**Effort:** ~20 min.

### 3. F12 — deploy.sh runs `git reset --hard` every 3 minutes
**Verified: exact interval confirmed** (`*/3 * * * * /opt/whatsapp-agent/deploy.sh`).
**Action:** The report's suggestion to widen the interval trades deploy latency for a marginal
safety gain that doesn't really apply here — `deploy.sh` already validates (`node --check` + `npm
test`) before restarting and auto-rolls-back on failure, so a bad `main` doesn't crash-loop
regardless of interval. **Skip the interval change** — it would just slow down every future PR
deploy in this session's normal workflow for no real benefit. The genuinely useful part of this
finding is verifying the crontab/systemd service run as a non-root user with minimal permissions —
worth a one-time check, not a recurring concern.
**Action (narrowed):** `ssh` in and confirm `crontab -l` and `systemctl show whatsapp-agent
-p User` are not root. If they are root, consider a dedicated service account — but this is
infrastructure hardening, not a code fix, and is medium priority at most for a single-container
personal project.
**Effort:** ~10 min to check, more if a user migration is actually needed.

---

## DOWNGRADE — real code pattern, but risk is much lower than stated

### 4. F2 — prompt injection via group messages
**Verdict: real pattern (user text is interpolated unsanitized into prompts), but the report
misses the actual mitigation already in place.** Confirmed `reminder.js` interpolates raw group
text/history into several prompts. However: `interpretCommand()`'s output (`{action, day}`) is only
ever used to trigger a state-changing action *after* a separate `isAdmin()` gate on the **message
sender's identity** (`index.js`: `if ((cmd.action === "schedule" || ... "cancel") &&
await denyIfNotAdmin()) return;`). This means prompt injection cannot escalate a non-admin's message
into an admin action — the AI's classification never grants permission, it only routes an
already-authorized sender's intent. The realistic worst case is a weird/off-tone generated message
(a reminder or motivation string that doesn't sound right) — a quality nuisance, not a security
breach.
**Action:** Worth doing as cheap hygiene, not urgent: add a one-line preamble to the creative-prompt
functions (`generateReminder`, `generateMotivation`, `proposeFeatures`) instructing the model to
treat `${content}` as untrusted data, not instructions. Skip elaborate sanitization/pattern-stripping
— not proportionate to the actual risk here.
**Effort:** ~20 min.

### 5. F9 — admin list stored in a plain config file with no rotation mechanism
**Verdict: real, but the threat model undermines its own urgency.** The report's own stated
attacker capability is "compromised container filesystem" — but an attacker who already has
filesystem write access to `config.json` also has access to `.env` (same directory, same
permissions) and to the tracked `.js` files themselves. Adding a phone number to an admin array is
not meaningfully more dangerous than an attacker who can already read every secret and rewrite any
code path directly. This finding doesn't describe a new attack surface, it describes what "the
container is compromised" already means for this bot.
**Action:** Skip as written. If pursued at all, the actually load-bearing mitigation is disk
encryption + container access hardening (which is F1's remediation, already the right answer) — not
a separate admin-list redesign.
**Effort:** 0.

### 6. F4 — `execSync` string concatenation for calendar git push
**Verdict: real code smell, essentially zero live risk.** Confirmed at `index.js:1768-1772`. The
`repo` variable is a fixed internal constant (`path.join(DIR, "calendar-repo")`), never influenced
by user input — the report says as much itself ("no user input currently reaches this code path").
**Action:** Fine to fix opportunistically (swap to `execFileSync`/`spawnSync` with array args) next
time this function is touched for another reason — not worth a dedicated task on its own.
**Effort:** ~15 min, batch with unrelated calendar work if any comes up.

---

## SKIP — low value as written

- **F1** (WhatsApp session creds as plaintext on disk): correctly identified as inherent to Baileys'
  architecture with no real code-level fix available. The suggested remediation (disk encryption,
  file permissions) is real infra hardening but is a one-time ops task for the container owner, not
  a code change — track it as an infra checklist item, not an "agent job."
- **F8** (no rate limiting on `/health`): the endpoint serves a tiny static JSON blob and reads a
  small file synchronously; DoS-ing a personal container's status endpoint has essentially no
  payoff for an attacker and the described "100+ RPS blocks WhatsApp processing" scenario requires
  sustained attack traffic against an obscure internal-only service. Binding to `127.0.0.1` only
  makes sense IF the external monitoring described in project memory doesn't need to reach it from
  outside the container — worth a 5-minute check of whether that's true, otherwise skip.
- **F10** (BLIK number visible in group messages): the report itself says this is intentional,
  accepted functionality, not a vulnerability. No action.
- **F11** (dependency risk / Baileys RC version): already tracked as a known, accepted risk in
  project memory (no stable release exists yet to move to). `npm audit` as a periodic habit is
  reasonable but doesn't need a dedicated job — fold it into the next dependency bump.

---

## Priority order for job creation

1. **F3/F6/F7 — sanitize public repo docs + rotate the PAT.** This is the only finding across all
   four reports with a live, external, actionable exposure. Should be the first job created from
   this entire audit.
2. F5 — strip the `[DBG sock.user]` dump and mask phone numbers in logs. Cheap.
3. F2 — add an untrusted-input preamble to creative AI prompts. Cheap, good hygiene.
4. F12 (narrowed) — verify deploy/service run as non-root. One-time check.
5. Everything else — skip or fold into unrelated work when convenient.
