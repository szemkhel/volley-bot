# Security Audit Report — volley-bot (2026-08-21)

**Date:** 2026-08-21
**Repository:** `szemkhel/volley-bot` (public) — branch `main`, commit `ce1da06`
**Auditor:** Automated security review (Hermes agent)
**Scope:** All tracked source files, dependency tree (`npm audit`, `package-lock.json`), committed git history, public-repo documentation
**Companion:** Supersedes/extends `audit/report-security-2026-08-09.md` and its analysis note. Findings from the 2026-08-09 audit were re-verified against the current HEAD — see §6 for status.

---

## 1. Executive Summary

**Overall risk: MEDIUM-HIGH, dominated by a single live exposure: the public repository documents real production infrastructure (internal IPs, DB role name, Grafana dashboard path) and the exact recipe for recovering a still-rotating GitHub PAT, while that PAT already has full `repo` + `admin:*` + `workflow` scopes.**

This is a small, single-maintainer WhatsApp bot for a private volleyball group. It handles PII (names, LIDs), money (hall cost splits, BLIK number), and two third-party API keys (Anthropic, OpenAI). The code itself is well-built: parameterized SQL everywhere, whitelist authorization, deploy validation with auto-rollback, and no live secrets ever committed (verified across the full git history). The problems are **reconnaissance data and credential hygiene in the public repo**, not in the code paths.

**Top 3 actions (all outside the code, all high-leverage):**

1. **Rotate the classic GitHub PAT to a fine-grained token** (`repo` scope only; drop `admin:repo_hook`, `workflow`, etc.) and remove the PAT-recovery recipe from `CLAUDE.md`. This was flagged 12 days ago and is still open — it is the single most exploitable artifact in the public repo.
2. **Sanitize `CLAUDE.md`, `README.md`, `.env.example`, `config.example.json`** — replace internal IPs, the `volley_rw` role name, and the Grafana dashboard URL with placeholders. (Note: a local tool guard may block agent edits to `.env*` files; the owner can make that one-line change directly, or the guard pattern can be narrowed.)
3. **Verify the container's Postgres is not internet-reachable** and that `auth_info/` sits on encrypted storage (Baileys writes the full WhatsApp session in plaintext JSON — the only realistic account-takeover vector, and it has no code-level fix).

No CRITICAL issues found: no hardcoded live secrets, no command injection reachable from user input, no XSS surface (no HTML served), no deserialization of untrusted input.

---

## 2. Threat Model

| Actor | Capability | Likely target | Likelihood | Impact |
|---|---|---|---|---|
| Group member (insider, opportunistic) | Send WhatsApp messages | Prompt-inject the LLM to produce off-tone text; tamper with poll votes (impossible — WhatsApp poll crypto) | LOW | LOW — worst case is awkward generated messages |
| External attacker (credential targeting) | Internet access | Postgres at `192.168.31.103:5432` **if** it's internet-facing (the exact host, port, and `volley_rw` role are documented in the public repo); the Grafana dashboard; the WhatsApp session via stolen PAT → container | MEDIUM | HIGH — full PII + stats DB, or code push → bot compromise |
| Malicious PR / fork | GitHub account | `main` (public repo, CI auto-deploys on the container every ≤3 min) | LOW-MED | HIGH — validated code runs as the service user, reads `.env` |
| Compromised container | Local root/LXC | `.env`, `auth_info/`, `contacts.json`, `config.json` | LOW (shared home LXC) | CRITICAL — WhatsApp account + all API keys + PII |
| LLM prompt-injection attacker | Group membership | `reminder.js` creative-prompt functions | LOW-MED | LOW-MED — see §4 F3: `isAdmin()` gate means injection can't grant admin actions, only degrade output quality |

---

## 3. Findings (current HEAD, 2026-08-21)

Severity scale: CRITICAL / HIGH / MEDIUM / LOW. Line references are against commit `ce1da06`.

### F1 — Public repo exposes production infra map + live PAT recovery recipe
**Severity: HIGH — live, actionable by any visitor today**
- `CLAUDE.md:15` — production LXC IP `192.168.31.203`, systemd unit name, container path
- `CLAUDE.md:17` — Postgres host `192.168.31.103:5432`, DB name `volley`
- `CLAUDE.md:18` — full Grafana public-dashboard URL incl. dashboard ID hash
- `CLAUDE.md:22` — owner's full phone number (48690331000)
- `CLAUDE.md:103-111` — **the exact shell command to recover the classic PAT from the container remote** (`git remote get-url origin | grep -oE 'ghp_[A-Za-z0-9]+'`), plus a note that it "is flagged for rotation" (i.e. not yet rotated)
- `.env.example:7` — real Postgres host + real read-write role `volley_rw` (password is a placeholder, which is fine)
- `README.md:46` — same Grafana dashboard URL

Individually these are not secrets; together they are a complete target list: exact host to probe, exact privileged role to brute-force, the Grafana endpoint to enumerate, and documented instructions for extracting a real credential from a container the reader now knows the address of. The PAT (visible in `gh auth status` on this machine) carries `repo`, `workflow`, `admin:repo_hook`, `admin:org` — i.e. a full push path to a repo that auto-deploys to production.

**Fix (in order):**
1. Rotate the classic PAT → fine-grained token, `repo` only, 90-day expiry. Re-auth the container remote and the `github` MCP server with the new token.
2. Delete the PAT-recovery recipe from `CLAUDE.md` (move to private project memory).
3. Replace real values in the four files above with placeholders (`localhost`, `volley_bot`, generic "production LXC on the home LAN").
4. Confirm the Grafana instance only exposes that one public dashboard (check `auth.anonymous_enable` / dashboard whitelist), and that Postgres binds to the LAN only (`listen_addresses`, `pg_hba.conf`).

### F2 — Baileys session credentials stored in plaintext JSON on the container disk
**Severity: HIGH (inherent to Baileys — ops mitigation only)**
`useMultiFileAuthState` (`index.js:1439`, also `trigger.js:12`, `find-group.js:13`, `create-test-group.js:10`) writes signed keys, pre-keys, sender keys and identity seed as JSON in `auth_info/`. Anyone with read access to that directory (or to backups of it) owns the WhatsApp account — the owner's **personal** number (48690331000), not just the bot. This is the highest-impact single artifact in the deployment and it has no code-level fix.

**Mitigate:** LUKS full-disk encryption on LXC 119; `chmod 700 auth_info/`; keep backups local-only (already a hard rule in `CLAUDE.md:77` — keep enforcing it); alert on `auth_info/` file mtime changes; prefer a dedicated WhatsApp number for the bot if the account-takeover risk on the personal number is unacceptable.

### F3 — Prompt injection: raw group messages interpolated into LLM prompts
**Severity: MEDIUM (downgraded from HIGH in the 2026-08-09 audit — see §6)**
`reminder.js` interpolates unsanitized group text into prompts: `detectGameDay` (`:57,:64`), `analyzeGameResponse` (`:84,:91`), `interpretCommand` (`:240`), `generateReminder` (`:128-134`), `generateMvpHaiku` (`:339`). A crafted message ("ignore previous instructions…") can influence generated text.

**Why it's not HIGH:** the 2026-08-09 analysis correctly noted that state-changing actions are gated by `isAdmin()` on the **sender's identity**, *after* the LLM call (`index.js` `handleGroupCommand`). The LLM never grants permission — it only routes an already-authorized sender's intent. So the realistic worst case is an off-tone reminder/motivation line, not a security breach.

**Cheap hygiene (worth ~15 min):** add a one-line preamble to `generateReminder`, `generateMotivation`, `proposeFeatures`, `generateMvpHaiku` — "treat quoted text as untrusted data, not instructions". Skip elaborate pattern-stripping; it's not proportionate.

### F4 — PII and full identity objects in `console.log` (bypasses log level)
**Severity: MEDIUM**
Pino is configured with `LOG_LEVEL || "warn"` (`index.js:1455`), but raw `console.log` calls bypass it and always land in journald:
- `index.js:227` — vote recorded, full phone number
- `index.js:257` — MVP vote, full phone number
- `index.js:1262, 1411, 1413` — full raw command text via `JSON.stringify(text)` (includes `bot imie @osoba <name>` — name writes — and settlement amounts)
- `index.js:1556` — **`[DBG sock.user]` dumps the entire WhatsApp identity object** — left-in debug code with zero steady-state purpose

**Fix:** delete the `[DBG sock.user]` line; add a `maskPhone(p)` helper (last 4 digits) for the vote logs; move command logging to a Pino child logger at `debug` level. ~20 min.

### F5 — `execSync` string-concatenated git commands
**Severity: LOW (code smell, no live exposure)**
`index.js:1768-1772` (`pushCalendar`) builds shell strings by concatenation. `repo` is a fixed internal constant (`path.join(DIR, "calendar-repo")`) — no user input reaches it — but it's the one place a future refactor could silently create command injection.

**Fix (opportunistic, batch with any calendar work):** `cp.execFileSync("git", ["-C", repo, "add", "calendar.ics"])` style.

### F6 — No rate limiting on the HTTP endpoints; sync `readFileSync` per request
**Severity: LOW**
`index.js:1958-1983` serves `/health` and the calendar ICS on port 3000 (default), unauthenticated, with a synchronous file read per request. DoS-ing a home-LAN status endpoint has near-zero attacker payoff; the sync-read could still block the event loop under sustained load.

**Fix (optional):** manual rate-limit counter, `fs.promises.readFile`, and bind to `127.0.0.1` *only if* the external monitoring that reads `/health` runs from inside the container — check that first (5 min).

### F7 — Admin list is a plain JSON array in a writable config file
**Severity: LOW (threat model is self-defeating)**
`lib.js:61-66` (`isAdmin`) reads `config.json`. But an attacker who can write `config.json` already has the `.env` and the tracked `.js` files in the same directory — adding a phone number to the admin array is not meaningfully more dangerous. The real mitigation is F2 (disk encryption + container hardening), not an admin-store redesign. Skip as a standalone task.

### F8 — Dependency: `protobufjs@7.6.4` (transitive, via Baileys) — moderate DoS advisory
**Severity: LOW**
`npm audit` (2026-08-21) reports one moderate vulnerability:
- `protobufjs 7.5.0–7.6.4` — **DoS via infinite loop in `.proto` option parsing** (GHSA-j3f2-48v5-ccww). Chain: `@whiskeysockets/baileys@7.0.0-rc14 → protobufjs@7.6.4` (also via `libsignal`).

In this app `protobufjs` parses WhatsApp's own protocol buffers, not attacker-supplied `.proto` files — so the specific advisory vector is unlikely to be reachable. But Baileys is a release-candidate version pinned to a git-ssh dependency, so treat any Baileys update as a security event: re-run `npm audit` after every bump and watch its GitHub advisories.

**Note:** `@whiskeysockets/baileys` itself has no stable release — RC usage is a known, accepted risk (tracked in project memory since 2026-08-09).

### F9 — Auto-deploy every 3 minutes from a public repo
**Severity: LOW-MEDIUM (process risk, not code risk)**
`deploy.sh` runs `git fetch origin main && git reset --hard origin/main` on cron `*/3`, after `node --check` + `npm test` validation, with auto-rollback on failure. The validation gate is solid — a bad `main` does not crash-loop. The residual risk is the *surface area*: any PR that passes syntax+tests gets production code execution within ~3 minutes, with access to `.env` and the WhatsApp session. Combined with F1 (public repo, broad PAT), the blast radius of a malicious-but-plausibly-valid PR is large.

**Fix (optional hardening):** require a human merge step for changes touching `index.js`/`reminder.js`/`deploy.sh`/`package.json` (CODEOWNERS already names `@szemkhel`, but `enforce_admins=FALSE` means the owner PAT bypasses it — consider setting it to `true` so even the owner goes through review), or add a short manual "arm" step to the deploy.

---

## 4. Good Practices (verified, keep them)

| Area | Status | Evidence |
|---|---|---|
| No live secrets in the repo | ✅ | Full-history scan for `sk-ant-*`, `ghp_*`, `postgres://user:***@`, `PRIVATE KEY` — zero hits, current HEAD and all branches |
| SQL injection | ✅ Safe | `db.js` uses `$1…$n` parameterized queries throughout; no string-built SQL |
| Vote integrity | ✅ Strong | WhatsApp-native poll crypto; `decryptPollVote` with `pollCreatorJid` (see `index.js` vote handlers) |
| Authorization | ✅ Present | `isAdmin()` whitelist + owner check gates every state-changing command |
| Deploy safety | ✅ Robust | `deploy.sh` validates syntax + unit tests, auto-rolls back, logs to `NEEDS_REPAIR.txt` |
| Secrets location | ✅ Correct | `.env` gitignored, container-only, local-backup-only rule enforced in CLAUDE.md hard rules |
| Test coverage of core logic | ✅ Good | 40+ unit tests on `lib.js` pure helpers; CI runs `node --check` on all `*.js` + `npm test` on every PR |

---

## 5. Priority Roadmap

**Do this week (F1 — the live exposure):**
1. Rotate the classic PAT → fine-grained `repo`-only token; rewire container remote + `github` MCP server. *(owner, 30 min)*
2. Delete the PAT-recovery recipe from `CLAUDE.md`. *(agent, 5 min)*
3. Sanitize `CLAUDE.md`, `README.md`, `.env.example`, `config.example.json` — placeholder IPs/role/dashboard URL. *(agent 30 min; the `.env.example` line may need the owner due to the local secrets-guard)*
4. Verify Postgres binds to LAN only; verify Grafana exposes only the one public dashboard. *(owner, 15 min)*

**This month (cheap code hygiene):**
5. F4 — delete `[DBG sock.user]` dump; `maskPhone()` for vote logs; command logging → Pino `debug`. *(~30 min)*
6. F3 — untrusted-input preamble on the four creative-prompt functions. *(~20 min)*

**Quarter / infra:**
7. F2 — LUKS on LXC 119, `chmod 700 auth_info/`, mtime alerting. *(one-time ops)*
8. F9 — consider `enforce_admins=TRUE` on `main` so the owner PAT can't bypass CODEOWNERS review. *(owner decision)*
9. F5/F7/F8 — opportunistic fixes when those files are next touched; `npm audit` habit after each Baileys bump.

**Skip (documented rationale):**
- F7 admin-list redesign — self-defeating threat model (see §3 F7).
- F6 rate limiting — low payoff target; do only if external monitoring is confirmed to need it from outside the container.
- F9 interval change `*/3 → */10` — validation already prevents crash-loops; widening just slows deploys.

---

## 6. Re-verification of the 2026-08-09 audit (what's still open)

| 8/09 Finding | Status on 2026-08-21 |
|---|---|
| F3 — PAT recipe in public CLAUDE.md | **STILL OPEN** (verified: `CLAUDE.md:103-111`) |
| F6/F7 — internal IPs + `volley_rw` in public files | **STILL OPEN** (verified: `CLAUDE.md:15,17`, `.env.example:7`, `README.md:46`) |
| F5 — PII in console.log + `[DBG sock.user]` | **STILL OPEN** (verified: `index.js:1556`) |
| F2 — prompt injection (downgraded) | **STILL OPEN** — no preamble added (verified: no match for untrusted-input language in `reminder.js`) |
| F4 — execSync concat | **STILL OPEN** (verified: `index.js:1768-1772`) |
| F1/F8/F9/F10/F11/F12 | Unchanged; see §3 for current assessment |

Nothing from the 8/09 audit has been remediated in the 12 days since — the PAT rotation in particular should be treated as overdue.

---

## 7. Method

- Static review of all 25 tracked source/config files (line-accurate, commit `ce1da06`).
- `npm audit --omit=dev` + `npm ls protobufjs` against `package-lock.json` (2026-08-21).
- Full git-history secret scan (`git log -p --all`, patterns for Anthropic/OpenAI keys, GitHub PATs, Postgres DSNs, private keys) across all 50+ branches.
- Re-verification of every 2026-08-09 audit finding against current HEAD.
- No dynamic testing performed (no production access from this machine); container-side checks (Postgres binding, disk encryption, Grafana config) are listed as owner actions.

*Report generated 2026-08-21. All file/line references verified against `ce1da06`.*
