# Analysis of `report-general-2026-08-09.md`

Verified against the actual `lib.js`/`test/lib.test.js` and `.github/workflows/ci.yml`. The
architecture and documentation observations hold up reasonably well; the **testing-coverage
assessment is substantially wrong** — the report scored this 3/10 and listed several "critical,
untested" items that are, in fact, already tested.

---

## REJECT / CORRECT — testing coverage claim is factually wrong

### 1. §5 "Only ~40-50% of lib.js functions tested," settlement math / vote counting / MVP selection listed as "Test Coverage: None"
**Verified: wrong.** Counted directly: `lib.js` currently exports **27 functions**; cross-referencing
every `test("<funcName>: ...")` block in `test/lib.test.js` against that list shows **every single
one has at least one matching test** — 70 test cases total. Specifically, the report's own "critical
gaps" table is contradicted point by point:
- *"Settlement math ... Critical"* → `parseSettlementShorthand` (2 tests) and `settlementPeople`
  (4 tests) are both tested with edge cases (explicit people count, total/perPerson back-calc,
  hallCost back-calc, no-match → null).
- *"Vote tally accuracy (multi-vote, +1/+2 weighting) ... High"* → `attendanceFromTally` (4 tests,
  including the exact +1/+2 weighting case) and `weightOfOptions` are tested.
- *"MVP candidate selection by attendance ranking ... Medium"* → `pickTopByAttendance` has 3 tests
  including a determinism/tie-order test.
- *"avatars.js meta merging (nextAvatarMeta) ... Medium"* → 6 dedicated tests, added specifically
  because of a bug found in a prior review round (this is genuinely one of the better-tested
  functions in the codebase).
**Likely cause:** the auditor appears to have either read an outdated snapshot of the test file or
inferred coverage from function names/architecture without actually opening
`test/lib.test.js` and counting.
**Action:** No fix needed — this correction itself is the deliverable. Re-score this category ~7/10,
not 3/10: `lib.js` (the explicitly-designated "testable logic goes here" module per `CLAUDE.md`) has
excellent, near-complete coverage. The one part of the original finding that *is* accurate — see
next item.
**Effort:** 0, this is a correction not a task.

### 2. What IS actually true about test coverage: no tests for `index.js`/`reminder.js` bot-logic itself
**Verdict: real, but by design, and the report's proposed fix (16-20h integration test suite) is
disproportionate.** Functions living directly in `index.js` (`closeMvpPoll`, `detectSettlement`,
`recordVote`, etc.) have no direct tests — true. But this isn't an oversight: `CLAUDE.md` explicitly
states the project convention is *"`lib.js` — pure helpers, this is what the tests cover. Put
testable logic here"* — i.e., the intended path for new logic is extraction into `lib.js`, not
mocking Baileys sockets for true integration tests. This session's own work followed that pattern
repeatedly (`nextAvatarMeta`, `topTiedEntries`, `mvpWinCount`, `looksLikeOwnerCommand`,
`looksLikeGameResponse` — all pure functions pulled out of `index.js` specifically to make them
testable).
**Action:** Keep following the existing pattern — when adding new bot-logic, ask "can the decision
logic be a pure function in `lib.js`?" first, mock Baileys only if genuinely unavoidable. Do NOT
schedule a dedicated 16-20 hour "integration test suite" task — that estimate assumes building
socket/state mocking infrastructure from scratch for a single-maintainer bot where the existing
pattern already gets most of the value at a fraction of the cost.
**Effort:** ongoing discipline, not a one-off task.

---

## DO — real findings worth acting on

### 3. CI has no dependency-install step — works today, but only because the tested surface has zero external deps (nuance the report missed)
**Verified: real, and worse than the report implies.** `.github/workflows/ci.yml` runs `node --check`
and `npm test` with **no `npm install`/`npm ci` step anywhere**. The report frames this as "no npm ci
vs npm install discipline... relying on pre-installed images" — that explanation is wrong (GitHub
Actions runners are not pre-seeded with this repo's dependencies). The real reason CI currently
passes: `test/lib.test.js` only imports `node:test`, `node:assert`, and `lib.js` — and `lib.js`
itself has **zero external package dependencies** (pure functions only). Both CI steps (syntax check,
unit tests) genuinely never touch `node_modules`. This is a real latent gap: the moment anyone adds a
test that imports anything from `package.json` (e.g., testing `db.js` or `mvpCaricature.js` logic
directly), CI will fail on every PR with a confusing "module not found" error until someone notices
the missing install step.
**Action:** Add `- run: npm ci` as a step before the syntax-check/test steps in
`.github/workflows/ci.yml`. Cheap, prevents a confusing future failure, and costs nothing today since
`npm ci` is fast and cache-friendly on GitHub Actions.
**Effort:** ~5 min.

### 4. `index.js` is a 1983-line god file mixing 8 responsibility domains
**Verified: real** (line count confirmed, matches `wc -l` exactly). The domain list in the report
(socket lifecycle, command dispatch, poll logic, MVP workflow, settlement, state I/O, dashboard sync,
message formatting) is an accurate read of the file's actual contents.
**Action:** Agreed this is worth doing eventually, but scope it down from the report's proposed
6-module split — start with the two lowest-risk, highest-value extractions:
- `dashboard-sync.js` (syncStatsDb + the various `*Text()`/`*Chart()` formatters) — purely
  read/format functions, no state mutation, safest to extract first.
- `state-manager.js` (the `loadXxx`/`saveXxx` pairs + `dataFile()` wrapper) — mechanical extraction,
  low regression risk.
Leave poll/MVP/settlement logic in `index.js` for now — those are the most actively-changed, most
state-coupled parts of the file (this session alone touched `closeMvpPoll` five times across
PRs #49/#52/#53), and extracting them mid-active-development multiplies merge-conflict risk for
little near-term benefit. Revisit once that logic stabilizes.
**Effort:** ~4-6 hours for the two safe modules; skip the rest for now.

### 5. `state.pendingRozliczenie` / Polish-named state keys — real, but a rename is riskier than the report suggests
**Verdict: real naming inconsistency, but the report doesn't account for migration cost.** These
keys live in **persisted `state.json` on the production container**, not just in-memory code — a
plain search-and-replace rename would silently orphan any in-flight pending confirmation on the
container at deploy time (a `state.pendingRozliczenie` object written before the deploy would sit
unrecognized under the old key after, since the code would look for `state.pendingSettlement`
instead). Exactly the kind of shape-change the existing `migrateState()` function was built to
handle for other state model changes.
**Action:** Only worth doing bundled with a `migrateState()` entry that renames the field on load
(read old key if new key absent, one-time). Not worth doing as a bare rename. Given it's purely
cosmetic (internal-only, never user-facing), this is low priority — bundle it opportunistically the
next time `pendingRozliczenie`'s logic is touched for an unrelated reason, don't schedule it alone.
**Effort:** ~30 min including the migration entry, but only worth doing piggy-backed on other work.

### 6. Vote-decryption duplication between `recordVote`/`recordMvpVote`
**Verified: real**, confirmed both functions contain near-identical `decryptPollVote(...)` call
blocks. Extracting a shared `decryptVotersVote(poll, pollUpdate, voterJid)` helper into `lib.js` is
reasonable — **but note it can't be a pure function** (it calls Baileys' `decryptPollVote`, an
external library call with side-effect-like behavior on crypto state), so it belongs in `index.js` or
a new non-pure module, not `lib.js` alongside the tested pure helpers. Don't test it the same way as
`lib.js` functions — a real decrypt call needs a captured real poll-update payload to test against
meaningfully, not a trivial unit test.
**Action:** Extract as suggested, but place it correctly (not `lib.js`) and don't over-promise test
coverage for it.
**Effort:** ~30 min.

### 7. Missing config startup validation
**Verified: real** (matches BUG-01 from the bugs report — same underlying gap, viewed from a
different angle: the bugs report frames it as "crashes on bad config," this report frames it as
"no schema check"). Don't treat these as two separate tasks — they're the same fix.
**Action:** See `report-bugs-2026-08-09-analysis.md` item 1. Cross-reference, don't duplicate work.
**Effort:** already scoped in the bugs analysis.

---

## SKIP — low value or already covered elsewhere

- **§6.3 "test mode gating via config comparison is fragile, use env var instead"**: real observation,
  but the described failure mode (accidentally setting `testGroupJid === groupJid` in production)
  would require a manual config edit that no established workflow in this project performs — config
  changes go through documented owner-only commands (`test on`/`test off`), not raw file edits. Low
  practical risk given actual usage patterns. Skip unless it happens for real.
- **§4.3 no global `unhandledRejection` handler**: real, but already captured and scoped in the bugs
  analysis (item 4) — don't duplicate.
- **§4.2 `db.js`/`avatars.js` silent catches**: real and worth a small fix (log avatar fetch failures
  instead of silently counting them), but low priority — these are best-effort-by-design paths
  (explicitly documented as such in code comments) and a total Postgres outage is already visible via
  other means (dashboard goes stale, which is itself an observable signal).
- **§7.3 "settlement flow has 3 confirmation paths, should be standardized"**: overlaps with the
  bugs report's BUG-05 discussion — see that analysis (already downgraded there with the same
  reasoning: the auto-confirm path only fires when the numbers already agree, and is already
  notified to the owner).
- **§8.2 dependency lock file integrity**: covered more precisely by item 3 above (the actual gap is
  "no install step at all," not "install vs ci discipline").
- **§10.3 `state.polls[]` unbounded growth over a season**: worth a mental note, not a task — polls
  get archived via `finalizePolls()` within `finalizeGraceDays` (default 3 days) per existing design;
  a season's worth of *concurrently open* polls would require ~20 simultaneous unarchived games,
  which doesn't match this group's actual 1-3-games-per-week cadence. Revisit only if `state.json`
  actually grows noticeably.
- **§9.2 README needs updating for hidden commands**: by definition, hidden commands (`avatary`,
  `karykatura`) are deliberately excluded from `README.md`/`pomoc` per explicit project convention —
  the report flagging their absence as a documentation gap misunderstands the intent. No action.

---

## Priority order for job creation

1. Add `npm ci` to CI workflow (item 3) — 5-minute fix preventing a real future failure mode.
2. Correct the testing-coverage self-assessment (item 1/2) — no code change, but make sure whoever
   consumes this audit doesn't schedule redundant "write settlement math tests" work that's already
   done.
3. `dashboard-sync.js` + `state-manager.js` extraction (item 4, narrowed scope) — do when there's a
   slow week, not urgent.
4. Items 5-6 (state key rename, decrypt dedup) — bundle opportunistically with unrelated touches to
   those areas, don't schedule standalone.
5. Everything in SKIP — no action.
