# Volley-Bot General Code Quality Report

**Date:** 2026-08-09  
**Branch:** analysis/2026-08-09  
**Files audited:** index.js (1983), lib.js (345), reminder.js (463), scheduler.js (84), db.js (169), textPool.js (25), mvpCaricature.js (90), avatars.js (83), notify.js (13), deploy.sh, package.json  
**Reviewer:** Senior JavaScript Architect

---

# Executive Summary — Health Score Card

| Category | Score | Notes |
|----------|-------|-------|
| **Architecture** | 6/10 | `index.js` is a massive god file (1983 lines); extraction candidates exist |
| **Naming & Readability** | 7/10 | Mostly clear; Polish-English mixing needs consistency |
| **Duplication** | 6/10 | Several repeated patterns: state read/write, JSON parse, vote tallying |
| **Error Handling** | 8/10 | Good AI fallback patterns; some silent catches need improvement |
| **Testing Coverage** | 3/10 | Only `test/lib.test.js` covers pure helpers — no integration tests for bot logic |
| **Config Management** | 5/10 | `.env.example + config.json` but no runtime validation or schema enforcement |
| **API / Design Consistency** | 7/10 | Command handlers follow a pattern; MVP flow is particularly well-structured |
| **Dependencies** | 7/10 | Minimal, focused deps; Baileys RC version is a concern |
| **Documentation** | 6/10 | CLAUDE.md is excellent; README outdated on some features; inline comments vary |

**Overall Assessment:** Volley-bot demonstrates strong domain-specific engineering. The MVP flow (`closeMvpPoll`) and settlement pipeline are notably well-crafted with good failure-mode awareness. However, the monolithic `index.js` architecture limits maintainability, and test coverage is dangerously low for a bot that directly handles money settlements and polls affecting dozens of real people.

---

## 1. Architectural Analysis — The Monolith Problem

### 1.1 `index.js` Is a God File (1983 lines)

**Location:** `index.js`  
**Severity:** High maintainability risk

Index.js contains at minimum **eight distinct responsibility domains**:
- WhatsApp socket lifecycle & reconnect management (lines ~120-142, 1536+)
- Command dispatch and parsing (inline handler, lines ~1420-1580)
- Poll creation/tallying/closing logic (~145-179, 567-601, 355-393)
- MVP voting workflow including caricature generation (~260-393)
- Settlement/rzoliczenie flow (689-890)
- State file management (load/save for state/config/contacts/history/mvp/suggestions/weeklog)
- Stats/dashboard sync to Postgres (~464-496, 535-565, 892-932)
- UI message formatting (frekwencjaText, rankingText, zmianyText, statusText)

**Recommendation:** Extract these into separate modules:
```
modules/
  poll-manager.js     # createPoll, tallyOf, attendanceOf, archivePoll, finalizePolls
  mvp-workflow.js     # createMvpPoll, closeMvpPoll, offerMvpPoll, sendMvpCaricature
  settlement.js       # detectSettlement, doSettlement, handleRozliczenieAnswer
  state-manager.js    # loadState, saveState, dataFile wrapper + migrations
  dashboard-sync.js   # syncStatsDb, frekwencjaEntries/Chart, rankings/mvp list generation
  command-dispatch.js # Command interpreter, handler routing
```

This alone would reduce `index.js` to ~800 lines focused on socket lifecycle and message dispatch.

---

## 2. Naming Conventions & Readability

### 2.1 Mixed Polish-English Terminology

**Affected files:** Multiple  
**Severity:** Low — cosmetic but hurts long-term comprehension for non-Polish contributors

Scanning the codebase reveals inconsistent naming:
- Function names are all English (`attendanceFromTally`, `parseAnkieta`, `settlementPeople`)
- State keys mix languages: `askedAboutGame` (English) vs `lastCancel` (English) vs `realPlayers` (English in Polish context)
- Variable/property strings in UI messages use Polish ("Gram", "Nie gram") which is correct for user output
- `pendingRozliczenie`, `pendingMvpOffer`, `pendingPlayerUpdate` — these camelCase Polish words are confusing

**Recommendation:** Standardize internal state keys to English only. Replace `state.pendingRozliczenie` with `state.pendingSettlement`. Keep Polish exclusively in user-facing strings.

### 2.2 Variable Name Clarity

**Lines index.js:196-198**
```javascript
function seen(id) {
    if (!id) return false;
    if (processedCmds.has(id)) return true;
    processedCmds.add(id);
    if (processedCmds.size > 200) processedCmds.clear();
    return false;
}
```

`seen()` is ambiguous — does it mean "has been seen" or "mark as seen"? The function returns `true` when already seen and `false` when newly added. This is an unusual convention. Consider renaming to `wasAlreadyProcessed(id)` or `addSeenCommand(id)`.

---

## 3. Code Duplication Analysis

### 3.1 JSON File Read/Write Everywhere

Every data file follows the same pattern:
```javascript
function loadXxx() { try { return JSON.parse(fs.readFileSync(...)); } catch { return {}; } }
function saveXxx(x) { fs.writeFileSync(path, JSON.stringify(x, null, 2)); }
```

This appears in `loadState`/`saveState`, `loadConfig`/`saveConfig`, `loadContacts`/`saveContacts`, `loadHistory`/`saveHistory` (3x — including `mvp.json`), and `loadMvp`/`saveMvp`. That's ~10 similar functions.

**Recommendation:** Create a `state-manager.js` module with a generic:
```javascript
function persistedData(key, defaults) {
  const file = dataFile(`${key}.json`);
  return {
    load: () => { try { return JSON.parse(fs.readFileSync(file)); } catch { return typeof defaults === 'function' ? defaults() : default; },
    save: (data) => fs.writeFileSync(file, JSON.stringify(data, null, 2)),
  };
}
```

### 3.2 Vote Decryption Logic — Duplicate Code Path

**Files:** `index.js` lines 209-228 (`recordVote`) and lines 241-258 (`recordMvpVote`)

Both functions contain nearly identical vote decryption logic:
```javascript
if (poll.encKeyB64 && pollUpdate.vote) {
    const meta = decryptPollVote(pollUpdate.vote, {
        pollCreatorJid: ...,
        pollMsgId: ...,
        pollEncKey: Buffer.from(poll.encKeyB64, "base64"),
        voterJid,
    });
```

**Recommendation:** Extract into a shared helper `decryptVotersVote(poll, vote)` in `lib.js`.

### 3.3 Attendance Weight Calculation Repeated Unnecessarily

`attendanceFromTally(tally)` is called in multiple places to convert poll data into numeric values:
- `attendanceOf()` at line 158
- `weightOfOptions()` at lines 283, 405  
- `tallyOf()` at line 157

These are mathematically related but not unified. The `weightsForOptions()` function at line 29 already does some of this work for a single voter's vote — consider consolidating all poll-to-count conversions into one module.

### 3.4 Poll Option Handling Patterns

`POLL_OPTIONS` appears as a constant at line 450, but option hashes are computed manually with `optionHashes = {}` + hash loop at lines 578-579 and again in `createMvpPoll` at lines 315-316. Extract to `buildOptionHashes(options)`.

---

## 4. Error Handling Quality Assessment

### 4.1 Excellent — AI Call Graceful Degradation

The codebase does this well:
```javascript
try { ... Claude/OpenAI call ... } catch(err) {
    console.error("...", err.message);
    return fallback(...); // or cached pool text, or hardcoded default
}
```

This pattern in `reminder.js`, `mvpCaricature.js`, and `textPool.js` is genuinely good — the bot never crashes due to API failures. This deserves praise.

### 4.2 Problematic — Silent Catch Blocks with No Escalation

**File:** `db.js` lines 50-56, 78-84, 102-108
```javascript
} catch (e) {
    console.error("[db] sync failed:", e.message);
}
```

Postgres sync failures are logged but silently discarded. No retry queue, no alert to the operator if Postgres has been down for hours/days — the dashboard shows stale data with no indication. **Recommendation:** Add a `lastSyncFailure` timestamp + hourly health check that notifies via owner self-chat.

**File:** `avatars.js` line 72-75
```javascript
} catch (e) {
    fresh = { ... }; skipped++; // silently skipped, no logging
}
```

Individual avatar fetch errors are counted but not logged. If all avatars fail due to account restrictions, nobody knows until the MVP feature stops working.

### 4.3 Missing Error Types — Where Errors Should Be Propagated

In `deploy.sh`, any syntax check failure triggers rollback — good. But in Node.js code, there's no global `uncaughtException` handler or `process.on('unhandledRejection')`. A single unhandled promise rejection anywhere could leave state corrupted without any record.

---

## 5. Testing Adequacy

### 5.1 Current Test Coverage — Only Pure Helpers

**File:** `test/lib.test.js`  
Only the pure, deterministic helper functions in `lib.js` have tests. These are:
- `attendanceFromTally()`
- `weightOfOptions()`
- `parseAnkieta()`
- `nextDateForDay()`
- `looksLikeFullSurname()` / `suggestedInitialName()`
- `parseSettlementShorthand()`
- `pollBeatsHistory()`
- Looks like maybe 40% of lib.js functions tested

### 5.2 What's Missing — Critical Business Logic With No Tests

| Feature | Test Coverage | Risk Level |
|---------|--------------|------------|
| Vote tally accuracy (multi-vote, +1/+2 weighting) | None | High |
| MVP candidate selection by attendance ranking (`pickTopByAttendance`) | None | Medium |
| Poll date logic (`gameDate`, day-of-week matching) | None | Medium |
| Settlement math (cost/person splitting) | None | **Critical** — real money involved |
| Date-based cron scheduling correctness | None | Medium |
`mvpCaricature.js` — prompt construction & image generation logic | None | Low (hard to test without API key) |
| `avatars.js` — meta merging (`nextAvatarMeta`) | None | Medium |

### 5.3 Testing Recommendations (Priority Order)

1. **Settlement math** — Write unit tests for `parseSettlementShorthand()` edge cases and `buildSettlement()` output formatting with known inputs → expected JSON
2. **Vote counting** — Test that `weightOfOptions` correctly computes attendance for all 5 vote options including +1/+2 variants
3. **MVP candidate selection** — Verify `pickTopByAttendance()` produces deterministic ordering by season attendance

---

## 6. Configuration Management Assessment

### 6.1 `.env.example + config.json` Split Is Reasonable

The separation is sensible here:
- **`.env` (machine secrets)**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PHONE`, `DATABASE_URL`, `LOG_LEVEL`
- **`config.json` (deploy config)**: `groupJid`, `gameDay`, `hallCost`, `admins`

However, there are gaps:
1. **No startup validation** — the bot connects to WhatsApp *before* validating that required keys exist. If `ANTHROPIC_API_KEY` is missing, it will work fine until the first AI call fails in 3 hours.
2. **No env var validation at load time** — `loadConfig()` reads from disk but never checks that `process.env.DATABASE_URL` exists before attempting Postgres operations (even though `getPool()` handles this gracefully).

### 6.2 Missing: Config Schema / Type Checking

```javascript
function loadConfig() {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE)); // no schema validation!
    if (process.env.ANTHROPIC_API_KEY) c.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    return c;
}
```

If someone adds `hallCost: "200"` instead of `hallCost: 200` (string vs number), `parseFloat("200")` would silently work, but arithmetic like `cost / realPeople` could produce NaN downstream. Consider a simple runtime schema check at startup:
```javascript
const requiredFields = ['groupJid', 'hallCost'];
for (const field of requiredFields) {
    if (!(field in config)) throw new Error(`Required config missing: ${field}`);
}
```

### 6.3 Test Mode Gating Mechanism Is Fragile

```javascript
function isTestMode() {
    try { const c = JSON.parse(fs.readFileSync(CONFIG_FILE)); return !!(c.groupJid && c.testGroupJid && c.groupJid === c.testGroupJid); }
    catch { return false; }
}
```

If a production deploy accidentally sets `testGroupJid` to the same value as `groupJid`, ALL stats flow into test-mode files instead of production — silently zeroing out dashboard data for days. Recommend an env var flag (`TEST_MODE=1`) as the source-of-truth instead.

---

## 7. API Design & Command Consistency

### 7.1 Command Pattern Is Reasonably Clean

Commands follow a consistent routing pattern:
```javascript
function interpretCommand(text, state, config) { /* classifies intent */ }
// Then in onMessages handler:
switch(action) { case "status": ...; break; case "schedule": ...; break; }
```

The classified action is always one of `["status","schedule","remind","cancel","help","none"]` — a clean enum. Good design.

### 7.2 MVP Flow Is Exceptionally Well-Structured

The MVP poll workflow (`createMvpPoll` → `closeMvpPoll` → `sendMvpCaricature`) is the best-crafted feature in this codebase:
- Uses `saveState-before-critical-section` pattern to prevent duplicates on crash
- Captures winner list atomically
- Processes winners sequentially with per-winner failure boundaries
- Caricature generation is fire-and-forget (non-blocking) — correct design choice

This should serve as a template for other feature modules extracted from index.js.

### 7.3 Settlement Flow Has Inconsistent Confirmation Gates

Settlement has **three** distinct code paths with different confirmation semantics:
1. `detectSettlement()` auto-confirms if detected count matches poll count (line 708) — no user consent
2. Manual `bot rozlicz` requires explicit person/cost entry through multi-step interactive flow
3. User mentions people in reply to settlement question — bypasses both

This should be standardized: all settlements (auto or manual) should require confirmation from at least one admin before being written to history.

---

## 8. Dependencies Assessment

### 8.1 package.json Review

```json
{
    "@anthropic-ai/sdk": "^0.104.2",
    "@napi-rs/canvas": "^1.0.0",
    "@whiskeysockets/baileys": "^7.0.0-rc14",     // ← CONCERN
    "dotenv": "^17.4.2",
    "node-cron": "^4.2.1",
    "pg": "^8.22.0",
    "pino": "^10.3.1",
    "qrcode-terminal": "^0.12.0"
}
```

| Dependency | Concern |
|-----------|---------|
| `@whiskeysockets/baileys` rc14 | Pre-release version — breaking changes could arrive unexpectedly; WhatsApp protocol updates may lag |
| `dotenv` v17 | Latest major, but `.env` files aren't in git (correct) — no action needed |
| All others | Mature stable versions, appropriate for this codebase size |

### 8.2 Missing Dependency: No Lock File Integrity Check

CI runs `npm test` on PR merge, which will install from package-lock.json — good. But there's no `npm ci` vs `npm install` discipline (in CI it uses npm run check + npm test without explicit install, relying on pre-installed images). Recommend adding an `install:ci` script that runs `npm ci --ignore-scripts`.

---

## 9. Documentation Quality Assessment

### 9.1 CLAUDE.md — Excellent 🌟

The `CLAUDE.md` file is genuinely a first-class piece of project documentation:
- Clear layout explaining every file's purpose
- Exact production environment IPs, container IDs, SSH access instructions
- Critical path warnings ("Never edit tracked files directly on the container")
- Domain-specific gotchas (LID vs phone, poll vote decryption LID normalization)
- Release loop description is precise enough to follow

This deserves a GitHub badge or pinned PR as a reference for any contributor.

### 9.2 README.md — Needs Updating

The `README.md` (7917 bytes) is described as "user-facing changelog" and "command list." Based on the codebase, I know it needs to be validated against:
- Commands added since last edit (e.g., "bot imie", hidden "karykatura" command referenced in `feat/karykatura-resend-trigger` branch)
- MVP caricature feature is noted but the **how** is missing — should explain for new admins that the MVP surprise works automatically
- The `testMode` (test group isolation) feature needs documentation

### 9.3 Inline Comments — Generally Good, Some Outdoors

The most valuable inline comment in the entire codebase:
```javascript
// HARD WhatsApp limit: a poll accepts at most 12 options (100 chars each). This is NOT our
// choice — Baileys does not validate it, so sending more just gets the poll rejected server-side
// and no vote appears at all. Do not raise this without a different voting mechanism.
```

This explains *why* rather than *what* — exactly what future developers need. However, some comments are outdated:
- CLAUDE.md references `deploy.sh` running from cron every 3 minutes, but there's also the `feat/reduce-ai-credit-usage` branch which may change deploy timing
- The comment about "2026-08-07" zero-credit issues is already in the past — consider whether this incident still applies

---

## 10. Performance Analysis

### 10.1 `fs.readFileSync()` on Hot Paths

All JSON reads are synchronous: `loadState()`, `loadConfig()`, `loadHistory()`, etc. For a long-running daemon that loads these every cron tick and every message, this is acceptable because:
- File sizes are tiny (<1KB each)
- Node.js event loop can handle microsecond fs ops between AI calls (which take seconds)

**However:** In `handleImieConfirmAnswer()` and `handleRozliczenieAnswer()` — which run on **every inbound message** — calling `loadContacts()` + `loadHistory()` synchronously means the event loop is blocked during that I/O. For this bot's message volume (likely 50-100 messages/hour during active weeks), this is negligible in practice.

### 10.2 Avatar Fetching Delay Pattern

**File:** `avatars.js` line 77
```javascript
await new Promise(r => setTimeout(r, 400)); // ← intentional delay to avoid hammering WhatsApp
```

This 400ms per-member sleep is correct and necessary (WhatsApp rate limits). For a group of ~30 members this adds ~12s to the monthly avatar refresh. Not a performance issue, but worth noting for scaling considerations if the group grows beyond 50 people.

### 10.3 Memory Usage — Reasonable but Watch Out

- `processedCmds` Set caps at 200 (with clear-on-overflow) — fine
- `recentMessages` array (implicitly capped at message event count) — unbounded, could grow for active groups
- `state.polls[]` array grows per game session and only shrinks when polls are archived/cancelled — this is the biggest memory concern. Over time (~20 weeks of volleyball season), this could reach 100+ poll objects with vote dicts

---

## Code Quality Metrics Summary

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Total LOC | ~3,056 | <3,500 for this domain | ✅ Pass |
| Main file (index.js) | 1,983 lines | <1,200 per module | ⚠️ Exceeds target |
| Pure helper coverage | lib.test.js | >80% of pure functions | ⚠️ ~40-50% covered |
| Integration tests | 0 | >1 critical workflow test | ❌ Missing entirely |
| Config validation | None | Required fields at startup | ❌ Missing |
| Error logging completeness | Good for AI calls, weak for infra/DB | Comprehensive alerts | ⚠️ Partially met |
| CLAUDE.md quality | Excellent (reference doc) | Best practice | ✅ Exceeds target |

---

## Prioritized Refactoring Roadmap

| Priority | Action | Expected Impact | Effort |
|----------|--------|-----------------|--------|
| **P0** | Add config validation at startup (`validateConfig()`) | Prevent silent failures on deploy | Low (2 hours) |
| **P0** | Extract `state-manager.js` from index.js 1/4+ of index.js into one module | Massive readability improvement | Medium (8-12 hours) |
| **P1** | Add integration test for MVP poll lifecycle | Catch critical vote-loss bugs before deployment | High (16-20 hours) |
| **P1** | Deduplicate vote decryption helper (`decryptVotersVote`) in lib.js | Single source of truth, easier audit | Low (2 hours) |
| **P2** | Add Postgres health check with operator notification | Early warning on DB failures | Low-Medium (4-6 hours) |
| **P2** | Upgrade `@whiskeysockets/baileys` RC to stable version when available | Prevent unexpected WhatsApp API breaks | Depends on upstream release |
| **P3** | Standardize internal state key naming (`pendingRozliczenie` → `pendingSettlement`) | Long-term maintainability | Low (1 hour) |

---

*End of report.*
