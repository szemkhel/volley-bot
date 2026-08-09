# Analysis of `report-bugs-2026-08-09.md`

Verified against the actual code (not just taken at face value — several claims below are disputed
or downgraded after checking real behavior and, where relevant, this session's own production
history). Ordered as an action list for future job creation: **DO** items are real and worth fixing;
**SKIP/DOWNGRADE** items explain why the original finding is wrong or overstated so no one re-does
this verification work.

---

## DO — confirmed real, worth fixing

### 1. BUG-01 — `loadConfig()` has no try/catch around `JSON.parse`
**Verified: real.** `index.js:64` is a bare `JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))`.
**Action:** Wrap in try/catch. On failure, do NOT crash the process — log via `console.error` and
`notify()` if a socket exists, and refuse to proceed with poll/reminder actions until config is
readable again (don't fabricate defaults for `groupJid`/`anthropicApiKey`, since a wrong guess is
worse than a startup halt). Apply the identical fix to `scheduler.js:23`'s raw
`fs.readFileSync(__dirname + "/config.json")` — that one has the same gap and is a separate call site.
**Severity:** downgrade from CRITICAL to HIGH — `config.json` is gitignored production data, never
touched by deploys, and is basically never hand-edited given this project's discipline. Real risk,
low likelihood.
**Effort:** ~20 min including the scheduler.js twin.

### 2. BUG-04 — reconnect storm can spawn overlapping `connectToWhatsApp()` calls
**Verified: real.** `scheduleReconnect()` (`index.js:137-142`) nulls `reconnectTimer` *before*
`connectToWhatsApp()` finishes, so a close event arriving while a reconnect is already in flight
schedules a second one. This matches the actual 2026-07-29 `405` version-rejection outage pattern
recorded in project memory — a storm-of-closes scenario has happened before on this bot.
**Action:** Add a `reconnecting` boolean guard exactly as the report suggests, set `true` at the
start of the scheduled reconnect callback and reset to `false` in the `connection.update` handler's
`open` case (not just on success — reset it on definitive failure too, or a stuck `true` would wedge
reconnection forever).
**Severity:** MEDIUM (not HIGH) — the existing exponential backoff + single-timer guard already caps
the damage; this closes a secondary gap, it doesn't fix an unguarded loop.
**Effort:** ~15 min.

### 3. BUG-07 — `processedCmds.clear()` wipes ALL dedup protection at 200 entries
**Verified: real.** `index.js:196`, exact code as quoted.
**Action:** Replace bulk-clear with an eviction of the oldest ~half when the cap is hit (report's
suggested diff is fine, or swap the `Set` for a small ring-buffer/Map-with-insertion-order — same
effect). Low risk, cheap, no reason not to do it.
**Effort:** ~10 min.

### 4. Missing global `unhandledRejection`/`uncaughtException` handlers
This is buried in the general report (§4.3) but belongs here too: there is genuinely no
`process.on('unhandledRejection', ...)` anywhere in `index.js`. Given this codebase's otherwise
careful per-call try/catch discipline, one missed `await` or a rejected promise outside a try block
would currently kill the whole process silently (systemd restarts it, but state mutated
mid-operation could be left inconsistent).
**Action:** Add both handlers near the top of `index.js`, logging via `console.error` and — where a
socket exists — `notify()`. Do not attempt to "recover" the process in the handler; let it exit and
rely on systemd's restart, but make sure the failure is visible instead of silent.
**Effort:** ~15 min.

### 5. BUG-11 — vote events have no debounce, rapid re-votes could produce a moment of unstable derived state
**Verified: partially real.** The upsert-path vote handler at `index.js:1622-1623` indeed doesn't
call `seen()` before recording — confirmed by reading the code. However the report's stated
consequence ("counts inflate") is wrong: `recordVote`/`recordMvpVote` **overwrite** the voter's
entry keyed by phone (`poll.voters[phone] = {...}`), they don't append, so a duplicate delivery of
the same vote is idempotent, not additive. The real (much smaller) issue is a legitimate rapid
option change (e.g., "Gram" → "Gram i przyprowadzam +2" within seconds) being processed out of
order if two update events race — a correctness edge case, not an inflation bug.
**Action:** Low priority. If addressed at all, do it as a comment clarifying the idempotent-overwrite
behavior rather than adding artificial debounce (debouncing a real, fast vote change would just
delay a legitimate correction).
**Effort:** documentation-only, ~5 min, or skip.

---

## DOWNGRADE / DISPUTE — re-characterized after verification

### 6. BUG-02 — "MVP vote decryption silently fails for every vote" — **contradicted by this session's own production data**
**Verdict: the report's core claim is FALSE.** It asserts `voterJid` is never normalized before
`decryptPollVote` and that this causes *all* MVP votes to silently fail. This is directly
contradicted by observed reality: during this very session the production MVP poll accumulated real
votes (5 → 6, tracked live in `state.json`) and closed correctly with a genuine winner (Michał, 6
votes) — i.e., vote decryption has been working in production the whole time. The auditor is right
that `voterJid` at `index.js:1621` (`msg.key.participant || ...`) and `index.js:1753`
(`update.key.participant || update.key.remoteJid`) isn't run through `jidNormalizedUser()`, but that
is very likely *correct* — Baileys' `decryptPollVote` expects the raw participant JID exactly as
delivered in the event, not a normalized one; CLAUDE.md's own documented gotcha about
`pollCreatorJid` needing `jidNormalizedUser(sock.user.lid)` is about a narrower, different problem
(the creator's own `sock.user.lid` carrying a stray device suffix), not a general "always normalize"
rule.
**Action:** Do NOT apply the suggested fix — normalizing `voterJid` risks *breaking* the currently-working
decrypt path by changing the JID format Baileys expects. If anyone wants to harden this further,
the correct next step is to add an integration test that decrypts a real captured poll-update payload
(not to blindly wrap it in `jidNormalizedUser`).
**Effort:** 0 — explicitly do not implement the report's fix.

### 7. BUG-09 — "MVP tally race: votes during winner processing are dropped" — pre-existing by design, not a regression
**Verdict: real observation, wrong framing.** It's true that a vote arriving while `closeMvpPoll` is
mid-loop (after PR #52's fix cleared `state.mvpPoll` before processing) is dropped by
`recordMvpVote`'s early-return guard. But this was **already true before that fix**: the OLD code
computed `winners` from a one-time tally snapshot *before* the loop started, so a late vote used to
get written into `state.mvpPoll.votes` and then silently discarded when `state.mvpPoll = null` ran
at the end — it was never reflected in the announced winner either. The behavior (a vote cast after
the close moment doesn't change an already-announced result) is correct semantics for "closing a
poll," not a bug.
**Action:** No fix needed. If desired, add a one-line code comment on the early return in
`recordMvpVote` noting that votes after close are intentionally not counted (for future readers, not
because it's broken).
**Effort:** ~2 min for the comment, or skip entirely.

### 8. BUG-06 — "scheduler.js reads config.json directly, causing test/prod crossover" — overstated
**Verdict: real code smell, overstated consequence.** `scheduler.js:23` does bypass `loadConfig()`
and re-read `config.json` raw — confirmed. But the specific failure mode claimed ("scheduler fires
using production config while state is test-mode") doesn't hold up: `index.js`'s `"test on"`/`"test
off"` handlers call `saveConfig(cfg)` after swapping `cfg.groupJid`, which **persists the swap to
disk** — so a raw read of `config.json` from `scheduler.js` sees the same swapped `groupJid` that
`loadConfig()` would. The only actual gap is that `scheduler.js`'s raw read misses the
`process.env.*` overlay (`ANTHROPIC_API_KEY` etc.) — harmless in practice since `reminder.js`'s AI
calls already do `process.env.ANTHROPIC_API_KEY || config.anthropicApiKey`, and `process.env` is
already populated process-wide by `dotenv` at startup.
**Action:** Still worth fixing for hygiene/consistency (one duplicated JSON-read pattern less to
maintain), but reframe as a low-priority cleanup, not a data-crossover risk.
**Effort:** ~10 min — export `loadConfig` from index.js or move it to `lib.js`/a shared module and
import it in scheduler.js.

### 9. BUG-05 — "settlement auto-confirms without approval" — real behavior, but likely intentional and already has an audit trail
**Verdict: real code path, mischaracterized severity.** Confirmed: `detectSettlement` calls
`settleAndClose(people)` immediately with no confirmation prompt when the AI-extracted headcount
already equals the currently-recorded count (`index.js:708-713`). But: (a) this only writes a number
that's *already agreed with what the bot has on record* — it can't silently corrupt data with a
wrong number, since the "wrong number" case is exactly the branch that DOES ask for confirmation;
(b) the owner is already notified every time this fires (`notify(sock, cfg, "Rozliczenie
wykryte: ...")` at line 711) — there's an audit trail, just not a pre-action gate. The real
(narrower) risk is a false-positive `isSettlement` classification from `extractSettlement` on an
unrelated message that happens to produce a matching number — plausible but rare given the regex
pre-filter (digit + zł/pln/blik) already restricts what reaches the AI classifier.
**Action:** Low priority. If addressed, the cheapest correct fix is NOT "always require confirmation"
(that adds friction to the common, correct case) — it's tightening `extractSettlement`'s prompt to
be more conservative about `isSettlement: true`, or requiring the settlement-looking message to also
mention the hall/game explicitly. Not worth doing unless a real false-positive incident occurs.
**Effort:** skip, or ~20 min prompt-tightening if it becomes a real problem.

---

## SKIP — low value or already effectively covered

- **BUG-03** (atomic state writes / WAL): correct in the abstract, but a full WAL pattern is a large
  architectural change for a bot whose data files are all under 1KB and written synchronously — the
  actual risk window (crash between mutation and `fs.writeFileSync`) is a few milliseconds. Not worth
  the complexity. If pursued at all, the ROI-appropriate version is a single `fs.writeFileSync(tmp) +
  fs.renameSync` atomic-write wrapper in the existing `saveXxx` functions (prevents a torn write on
  power loss), not a WAL. This is a good "if we ever have spare cycles" item, not a priority.
- **BUG-08** (calendar push swallows git stderr): valid, cheap, low priority (calendar staleness is
  cosmetic — the bot already regenerates it hourly). One-line fix: log stderr instead of `stdio:
  "ignore"`.
- **BUG-10** (settlement AI+notify both failing = total silent drop): true but already about as
  mitigated as reasonably possible short of a second alerting channel (which doesn't exist for this
  single-maintainer bot). Not worth building a retry-queue for a scenario requiring two independent
  systems to fail simultaneously.
- **BUG-12, BUG-13**: both explicitly rated LOW by the auditor and are genuinely minor/cosmetic
  (dashboard display edge cases). Skip unless someone notices an actual wrong number on the
  dashboard.
- **A1-A8 (architectural section)**: mostly restatements of the numbered bugs above at higher
  abstraction (WAL, schema versioning, job queues). None of these match the actual scale of this
  codebase (~3,000 LOC, single bot process, sub-1KB JSON files) — they're the kind of advice that
  makes sense for a multi-tenant SaaS product, not a private group's WhatsApp bot. Skip the lot;
  revisit only if the bot's scope genuinely grows (more groups, more concurrent state).

---

## Priority order for job creation

1. BUG-01 (config crash) + scheduler.js twin — cheap, real risk
2. Global `unhandledRejection`/`uncaughtException` handlers — cheap, closes a real blind spot
3. BUG-04 (reconnect guard) — cheap, matches a real past incident
4. BUG-07 (dedup set eviction) — cheap, real
5. Everything else in DO — nice-to-have, do opportunistically
6. Do NOT implement BUG-02's fix (§6) — it would risk breaking working vote decryption
