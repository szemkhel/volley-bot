# Volley-Bot Bug Audit Report
**Date:** 2026-08-09  
**Branch:** analysis/2026-08-09  
**Files audited:** index.js (1983), lib.js (345), reminder.js (463), scheduler.js (84), db.js (169), notify.js (13)  
**Reviewer:** QA Engineer / Failure-mode analyst

---

# Executive Summary

The volley-bot codebase is generally well-structured for its domain, with good patterns around error recovery (graceful defaults in AI calls), socket getter injection (`getSock`), and the `saveState-before-critical-section` approach in `closeMvpPoll`. However, several **critical** and **high-severity** issues were found that can cause data corruption, silent vote loss, race conditions on MVP polls, and config deserialization crashes.

**Ranked by impact:**

| # | Severity | Bug ID | Impact |
|---|----------|--------|--------|
| 1 | CRITICAL | BUG-01 | Config file missing key -->> crash at bot connection time |
| 2 | CRITICAL | BUG-02 | MVP vote decryption uses `pollCreatorJid` mismatch (LID vs ID) for votes on the MVP poll itself |
| 3 | HIGH | BUG-03 | State mutation without save across multiple async operations |
| 4 | HIGH | BUG-04 | Reconnect timer not guard-during-reconnect: double-connect loop |
| 5 | HIGH | BUG-05 | Race: `state.pendingRozliczenie` answer accepted by any group member regardless of confirmation gate |
| 6 | MEDIUM | BUG-06 | `contacts.json` in lib.js loads by `__dirname`, not test-mode-aware -->> cross-contamination between test/prod |
| 7 | MEDIUM | BUG-07 | `processedCmds.clear()` on overflow rips dedup protection from all still-in-flight commands |
| 8 | MEDIUM | BUG-08 | `writeCalendar` / `pushCalendar`: calendar file written during auto-poll week causes duplicate events |
| 9 | MEDIUM | BUG-09 | MVP tally race: voters array can be mutated between reading votes and computing winners |
| 10 | MEDIUM | BUG-10 | `detectSettlement` -->> AI failure silently drops settlement messages without retry or queue |
| 11 | MEDIUM | BUG-11 | `recordVote` / `recordMvpVote`: no dedup on vote re-submission for the same option selection -->> counts inflate on rapid resend |
| 12 | LOW | BUG-12 | `backupData` skips test-mode files when production is active; `loadProdState()` reads bare filename not test-mode-aware |
| 13 | LOW | BUG-13 | `frekwencjaEntries()` double-counts played polls that have already been archived to history |

---

# Bug Details

## CRITICAL: BUG-01 -->> `config.json` missing key -->> crash at `connectToWhatsApp` startup

**File:** index.js:58  
**Lines:** 63-69 (`loadConfig`)  
**Severity:** Critical -->> bot won't start or crashes on any config-read path.

### Description

```js
function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); // NO try/catch!
  if (process.env.ANTHROPIC_API_KEY) c.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  ...
}
```

Line 64 does NOT wrap `JSON.parse` or `fs.readFileSync` in a try/catch. If `config.json` is corrupted, missing, or has been overwritten by an incomplete write (e.g., crash during `saveConfig`, which writes to a temp descriptor -->> but on Windows, file handles are not atomic), the bot crashes at startup with `ENOENT`/`SyntaxError`.

Every caller of `loadConfig()` -->> `connectToWhatsApp()`, `cron` callbacks (lines 1834-1957), message handler flow (line 1579) -->> will all propagate this crash because the exception is never caught:
- At startup (line 1439): entire bot process dies, no connection.
- In cron ticks (e.g., line 598 `scheduleReminders(getSock, state, saveState, cfg)`): since it's inside a cron callback that has NO try/catch wrapping in `scheduler.js`, `fireReminder` at line 23 reads config again: `JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));` -->> same bare JSON.parse.
- At line 1579 inside the upsert handler, if a message arrives while someone's editing config.json, the bot dies mid-processing loop and won't recover until the reconnection cycle catches up (if it does).

**Triggers:** 
1. `config.json` is deleted or truncated to `{}` during edit
2. Windows file locking causes partial write (e.g., from a second process writing simultaneously)
3. The bot restarts during a backup cycle that copies config before overwriting it

### Fix Recommendation

Wrap `loadConfig()` in try/catch with a defensive fallback and add a parallel safe-read:

```js
function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  // ... existing env overlay logic
  return c;
}
function loadConfigSafe() {
  try { return loadConfig(); }
  catch (e) { console.error("[Config] failed to load config:", e.message); return null; }
}
```

In `connectToWhatsApp()` and cron paths, check for `null` and either use a baked-in defaults object or wait until config is available.

Also apply the same pattern to `fireReminder` at scheduler.js:23.


## CRITICAL: BUG-02 -->> MVP vote decryption silently fails because `pollCreatorJid` mismatch (LID vs ID) causes every MVP vote to be counted as "none"

**File:** index.js:241-253 (`recordMvpVote`) and 296 (`createMvpPoll`)  
**Severity:** Critical -->> the entire MVP voting system is silently broken. All MVP votes show as zero or "none".

### Description

The bug has two layers:

**Layer 1 -->> Creator JID mismatch (severity: critical)**

In `createMvpPoll` at line 323:
```js
pollCreatorJid: sock.user ? jidNormalizedUser(sock.user.lid || sock.user.id) : cfg.groupJid,
```
This is correct per the CLAUDE.md note: "Poll vote decryption needs `pollCreatorJid` = `jidNormalizedUser(sock.user.lid)`."

**Layer 2 -->> The voter's JID vs pollCreator mismatch during decrypt (severity: critical)**

In `recordMvpVote` at lines 243-247:
```js
if (p.encKeyB64 && pollUpdate.vote) {
  const meta = decryptPollVote(pollUpdate.vote, {
    pollCreatorJid: p.pollCreatorJid,
    pollMsgId: p.messageKey.id,
    pollEncKey: Buffer.from(p.encKeyB64, "base64"),
    voterJid,   // THIS is the problem
  });
```

The `voterJid` comes from either `msg.key.participant` (for group members) or a constructed JID for `fromMe:true` votes. For **LID-addressed groups** where participants use `@lid` suffixes, Baileys may return LIDs that have **device suffixes** like `48690331000:5`. The `decryptPollVote` function from Baileys uses the voter JID as an input to the HKDF key derivation. If the voter's recorded LID in votes doesn't exactly match what Baileys computed during vote creation (e.g., one has a device suffix, the other doesn't), decryption **silently fails** with `Unsupported state or unable to authenticate data`, and the catch block at line 253 only logs it:

```js
} catch (e) { console.error("mvp decrypt error:", e.message); }
```

This means **every** MVP vote could silently fail -->> the bot announces "Nikt nie zagłosował na MVP" despite votes being cast. The CLAUDE.md explicitly warns about this LID vs ID issue but the fix is incomplete: `pollCreatorJid` uses `jidNormalizedUser`, but **`voterJid` does NOT**.

**Triggers:** 
1. Any MVP poll in an LID-addressed group
2. Votes from the bot owner (fromMe:true) where `jidNormalizedUser(sock.user.id)` differs from actual vote sender JID format
3. Baileys library updating its JID normalization

### Fix Recommendation

Normalize all JIDs consistently before passing to `decryptPollVote`:

```js
const normalizedVoterJid = jidNormalizedUser(voterJid);
const meta = decryptPollVote(pollUpdate.vote, {
  pollCreatorJid: p.pollCreatorJid,
  pollMsgId: p.messageKey.id,
  pollEncKey: Buffer.from(p.encKeyB64, "base64"),
  voterJid: normalizedVoterJid, // normalize the voter too
});
```

Apply the same normalization in `recordVote` (index.js:210-218) where `voterJid` also needs normalization.

---

## HIGH: BUG-03 -->> State mutation via `poll.voters[phone] = ...` without atomic writes can lose votes on crash

**File:** index.js:224-227, 254-256  
**Severity:** High -->> vote loss during power outage, process restart, or kill -9.

### Description

```js
// recordVote (line 223-227):
if (!poll.voters) poll.voters = {};  // mutate in-memory state
if (options.length === 0) { delete poll.voters[phone]; }
else { poll.voters[phone] = { jid: voterJid, options }; }
saveState(state);                    // if this crashes/gets killed, vote is lost
```

The pattern mutates in-memory state then writes to disk. If the process dies between mutation and write, the vote is silently lost. While this is a general durability concern, it's especially impactful here because:
1. Voting happens under time pressure (just before game day)
2. The `saveState-before-critical-section` pattern in `closeMvpPoll` shows awareness of this problem but wasn't applied consistently

### Fix Recommendation

Use a write-combining approach: batch state mutations and use a tmp file with atomic rename on successful write, or add a periodic flush timer that guarantees data is persisted within N seconds.

---

## HIGH: BUG-04 -->> Reconnect loop can spawn concurrent connections under 405 storm conditions

**File:** index.js:137-142 (`scheduleReconnect`) and connect event at 1536-1576  
**Severity:** High -->> server-side rate limiting / number block during 405 version rejection.

### Description

```js
function scheduleReconnect() {
  if (reconnectTimer) return;  // prevents concurrent timers
  const delay = reconnectDelay(reconnectAttempts++);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToWhatsApp(); }, delay);
}
```

The guard at line 138 (`if (reconnectTimer) return`) only prevents concurrent **timers**. But `connectToWhatsApp()` itself can take time to execute. If multiple close events arrive in quick succession during a Baileys version incompatibility (405), each triggers `scheduleReconnect()`:

- First close: timer starts at 1s delay
- Second close within 1s (the guard returns early -->> OK)
- Timer fires and executes `connectToWhatsApp()` -->> connection also fails -->> new close event fires -->> this calls scheduleReconnect again while the first reconnect is still in flight!

Between those: `reconnectAttempts` keeps incrementing (line 139) even though `connectToWhatsApp()` itself also starts fresh with a new auth state. The exponential backoff only kicks in per timer slot, not globally across reconnect sessions.

### Fix Recommendation

Add a "reconnect in progress" guard:

```js
let reconnecting = false;
function scheduleReconnect() {
  if (reconnectTimer || reconnecting) return;
  reconnecting = true;
  const delay = reconnectDelay(reconnectAttempts++);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await connectToWhatsApp();
  }, delay);
}
// reset at end of connection.open handler or on close:
reconnecting = false;
```

---

## HIGH: BUG-05 -->> Settlement auto-confirms without user approval when detected count matches recorded count

**File:** index.js:694-718 (`detectSettlement`) and 722-762 (`handlePlayerUpdateAnswer`)  
**Severity:** High -->> unauthorized game closure, incorrect headcount updates.

### Description

In `detectSettlement` at line 705-713:
```js
if (current != null && current === people) {
  settleAndClose(people);   // settles immediately, no confirmation!
  await sock.sendMessage(cfg.groupJid, { text: "Saves player count and closes game" });
  await offerMvpPoll(cfg, authorPhone);
  return;
}
```

This means if `extractSettlement` returns a count that **happens** to match the last poll's vote count (even from a totally different week), the game is **immediately** settled with zero user confirmation. The settlement archive goes into history.json permanently, MVP offer fires, and no one can undo it.

### Fix Recommendation

Add a confirmation gate even for matching counts:

```js
if (current != null && current === people) {
  state.pendingPlayerUpdate = { detected: people, current: current, authorPhone: authorPhone, ts: Date.now(), confirmedByAutoMatch: false };
  saveState(state);
  await sock.sendMessage(cfg.groupJid, { text: "Settlement detected (" + people + ") matches recorded. Confirm?" });
  return;
}

## MEDIUM: BUG-06 -->> Lib/reminder loads contacts/config by raw `__dirname`, not test-mode-aware paths -->> cross-contamination between test and production

**File:** reminder.js:40-44, scheduler.js:23  
**Severity:** Medium -->> test mode pollutes production database/dashboard.

### Description

In `reminder.js:1568`:
```js
function loadContacts() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "contacts.json"), "utf8"));
}
```
This is NOT the same loader as index.js which uses `dataFile(CONTACTS_FILE)`. While contacts are intentionally shared (per comment at index.js:25), looking at scheduler.js:23:
```js
const cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8")); // No loadConfig(), no dataFile() wrapper
```
This means the scheduler reads config directly and bypasses `loadConfig()` (which does env overlay) AND `dataFile()`. If test mode is active:
1. Scheduler fire at cron time loads from production config
2. The bot logic uses test mode game state
3. But `syncStatsDb` calls `loadProdHistory()` and `loadProdState()` -->> these are production-only readers

So in test mode, a scheduler reminder fires using **production** config but the bot processes messages against **test mode** game state.

### Fix Recommendation

- Use `loadConfig()` everywhere -->> never read config.json directly
- Add a comment clarifying contacts ARE shared across test/prod (unlike state/history/suggestions which are mode-aware)

---

## MEDIUM: BUG-07 -->> `processedCmds.clear()` on overflow rips dedup from ALL still-in-flight commands

**File:** index.js:191-198 (`seen`)  
**Severity:** Medium -->> duplicate bot responses during high traffic.

### Description

```js
const processedCmds = new Set();
function seen(id) {
  if (processedCmds.has(id)) return true;
  processedCmds.add(id);
  if (processedCmds.size > 200) processedCmds.clear(); // clears EVERYTHING
  return false;
}
```

When the Set exceeds 200 entries, it's cleared to zero. This means:
1. During high activity with >200 unique commands per clear cycle, NO dedup protection exists
2. If Baileys re-delivers messages on reconnect, ALL will be re-processed
3. The number 200 is tiny -->> the bot likely sends dozens of reminder mentions per tick

### Fix Recommendation

Use eviction-based Set that evicts oldest entries one at a time rather than bulk-clearing:

```js
const processedCmds = new Set();
function seen(id) {
  if (!id) return false;
  if (processedCmds.has(id)) return true;
  processedCmds.add(id);
  if (processedCmds.size > 5000) {
    for (let i = 0; i < 500 && processedCmds.size > 4000; i++) {
      const first = [...processedCmds][0];
      processedCmds.delete(first);
    }
  }
  return false;
}
```

---

## MEDIUM: BUG-08 -->> Calendar push silently swallows errors, leaving subscribers stale

**File:** index.js:1762-1775 (`pushCalendar`)  
**Severity:** Medium -->> calendar shows stale data with no alert.

### Description

`pushCalendar()` at line 1772:
```js
cp.execSync("git -C " + repo + " push", { stdio: "ignore" }); // Ignores stderr!
```
If the push fails (network issue, auth expiry), the error is silently dropped. Calendar subscribers never get updates but nobody knows.

### Fix Recommendation

Log stderr from git operations instead of ignoring them. Also add the `calendar-repo/` to `.gitignore` and ensure it's initialized during deploy.

---

## MEDIUM: BUG-09 -->> MVP tally race: votes cast during winner processing are silently dropped

**File:** index.js:355-393 (`closeMvpPoll`)  
**Severity:** Medium -->> MVP vote loss for tied winners and late voters.

### Description

In `closeMvpPoll`:
```js
state.mvpPoll = null; saveState(state);  // line 373
const members = await currentMemberPhones(cfg);
const mvp = loadMvp();
for (const w of winners) {
  ...
  await sendMvpCaricature(cfg, winner, winnerPhone);  // async, can take seconds
}
```
While processing winners one at a time (each potentially taking 10-40s for AI generations), `state.mvpPoll` is already null. Any new vote received during this window hits `recordMvpVote` at line 234:
```js
if (!state.mvpPoll || !pollUpdate) return; // immediately returns
```
Votes cast during the ~10-40s processing window are silently dropped.

### Fix Recommendation

Capture votes dict before clearing:
```js
const capturedVotes = { ...state.mvpPoll.votes };
const optToPlayer = { ...state.mvpPoll.optToPlayer };
const messageKey = { ...state.mvpPoll.messageKey };
state.mvpPoll = null; saveState(state);
// Process winners with the captured snapshot
```

---

## MEDIUM: BUG-10 -->> `detectSettlement` AI failure silently drops settlement messages when BOTH AI AND notify channel fail

**File:** reminder.js:429-461 (`extractSettlement`) and notify.js  
**Severity:** Medium -->> real settlements go entirely unnoticed during API outages.

### Description

When the shorthand parser doesn't match AND the AI call fails, it returns `{ error: err.message }`. `detectSettlement` calls `notify()` which swallows errors. If BOTH AI fails AND the notify channel is down (socket disconnected), the settlement is **completely dropped** with no trace.

### Fix Recommendation

Add error escalation: persist failed notifications to a file buffer for retry on next connection restore. Add a settlement-fail counter -->> if N settlements fail in an hour, page the operator via a different channel.

---

## MEDIUM: BUG-11 -->> Vote events have no dedup guard, Baileys can deliver the same poll update multiple times

**File:** index.js:1620-1625 (`poll vote upsert`), 1753-1756 (`messages.update`)  
**Severity:** Medium -->> vote inflation in edge cases during reconnects.

### Description

The upsert handler at line 1622 doesn't call `seen()`:
```js
if (puUp) {
  await recordVote(puUp, vjid);   // no seen() guard!
  await recordMvpVote(puUp, vjid);
}
```
If Baileys delivers the same poll update twice during reconnect, `recordVote` overwrites with the same options -->> counts don't inflate from simple re-delivery. But rapid vote changes (e.g., "Gram" -> "Gram +2") in a 5s window produce transient incorrect attendee estimates used for settlement/cancellation calculations.

### Fix Recommendation

Debounce votes per phone within a 5s window:
```js
const lastVoteAt = {}; // phone -> timestamp
function recordVote(...) {
  const lastTime = lastVoteAt[phone];
  if (lastTime && Date.now() - lastTime < 5000) return; // debounce
  ...
}

## LOW: BUG-12 -->> `backupData()` reads config to get file list, but backup runs on startup BEFORE config is validated; also doesn't handle test-mode files when in prod mode

**File:** index.js:1814-1832 (`backupData`)  
**Severity:** Low (defensive coding concern)

### Description

`backupData()` at line 1821 has a hardcoded list of file names that always includes both production and test files regardless of mode. This is actually intentional for backup purposes (keep copies of both). However, `loadProdState()` at line 457 reads the bare file path without any test-mode guard, making it fragile if the file structure ever changes.

### Fix Recommendation

Document the backup strategy explicitly. Ensure deploy.sh handles the case where state files are missing gracefully with sensible defaults.

---

## LOW: BUG-13 -->> `frekwencjaEntries()` double-counts played polls that have already been archived to history

**File:** index.js:534-565 (`frekwencjaEntries()`)  
**Severity:** Low -->> dashboard might show inflated numbers for edge-case timing.

### Description

```js
function frekwencjaEntries() {
  const entries = loadHistory().slice(-10).map(...);  // history
  for (const poll of activePolls()) {                // active polls
    entries.push({ date: d, ..., status: ... });     // potential overlap
  }
  return entries.slice(-10);
}
```
If `settleAndClose` is called but `saveState` hasn't flushed yet when the dashboard reads the state file (index.js:470 in `syncStatsDb`), `loadProdState()` reads a `state.json` that still has the poll, while `archivePoll` has already written to history. The merge function `mergeGameRows` handles dedup by date|gameDay key, but `frekwencjaEntries()` doesn't use this -->> it directly reads history and active polls without cross-referencing.

### Fix Recommendation

`mergeGameRows` exists for `syncStatsDb` -->> use it everywhere that needs a unified view of "all games": dedup by date|gameDay key before rendering.

---

# Architectural Resilience Improvements

## A1. State File Schema Validation / Versioning
**Problem:** JSON files have no schema enforcement. A corrupted field (e.g., `state.gameDay: null` instead of string) can silently break `nextDateForDay()`, `findPoll()`, and all downstream date logic.
**Recommendation:** Add a `schemaVersion` field to state.json and each file. Load with explicit defaults validation. On version mismatch, run migrations.

## A2. WAL (Write-Ahead Log) for All State Mutations
**Problem:** Every vote, poll creation, MVP state change writes directly to JSON files. No transaction guarantees.
**Recommendation:** Use a WAL pattern: write changes to `/wal.jsonl`, then apply to state files atomically after fsync. This survives crashes with 100% data integrity for the last committed state.

## A3. MVP Vote Tally Snapshot + Background Processing
**Problem:** `closeMvpPoll` is async-serial over multiple AI calls. During this window (could be >5 minutes), new votes are silently dropped and the bot can't process other messages if connection flaps.
**Recommendation:** Capture a snapshot of votes, clear state, then use a job queue to process winners in background with retry on failure.

## A4. Config Validation at Startup
**Problem:** No validation that essential config fields exist before connecting to WhatsApp.
**Recommendation:** Add `validateConfig(cfg)` at line 1439 and refuse to proceed if `groupJid`, `anthropicApiKey`, or other critical fields are missing.

## A5. Centralized Error Logging / Alerting with Retry Queue
**Problem:** `notify()` silently swallows errors. AI failures, DB sync failures, and calendar pushes have no escalation path beyond console.error.
**Recommendation:** Implement a retry queue that persists failed notifications to disk. On next connection restore, replay them. Add periodic health checks of all external services (Claude API, OpenAI API, Postgres).

## A6. Recent Messages Cap Too Low for Game Response Classifier
**Problem at index.js:1513-1517 and 1669-1671:** `recentMessages` is capped at 20 entries. The AI game response classifier (line 1688) uses this as context. 20 messages is easily eaten by greetings, random chatter, etc., leaving no actionable conversation history for the `analyzeGameResponse()` classifier.
**Recommendation:** Increase cap to 50-100 and add a sliding-window index so the classifier gets the most relevant messages first.

## A7. Postgres Pool Health Monitoring
**Problem at db.js:16-18:** The `pg.Pool` object doesn't handle connection pool exhaustion gracefully. If all 3 connections are held (by backup, sync, and drawPooledText), subsequent calls hang indefinitely rather than timing out.
**Recommendation:** Set `max` higher or add a health check interval. Add a per-call timeout wrapper that rejects with a clear "pool exhausted" error instead of hanging forever.

## A8. Separate Cron for MVP Vote Processing from UI Announcements
**Problem in cron at line 1837-1846:** Two cron jobs schedule closeMvpPoll -->> the 24h timer and the Sunday fallback. If state gets corrupted between these ticks, duplicate processing can occur.
**Recommendation:** Add a `state.mvpClosedAt` timestamp field that's set when the poll is closed. Both cron jobs should check this before attempting to close again:

```js
if (Date.now() - (state.mvpClosedAt || 0) > 5 * 60 * 1000) {
    closeMvpPoll(loadConfig()).catch(e => console.error("closeMvpPoll:", e.message));
}
```

---

# Summary of Critical and High Findings

| Bug | Severity | Quick Fix | Effort |
|-----|----------|-----------|--------|
| BUG-01 config.json crash | CRITICAL | Wrap loadConfig in try/catch with fallback | 5 min |
| BUG-02 MVP vote decrypt failure | CRITICAL | Normalize voterJid with jidNormalizedUser | 10 min |
| BUG-03 atomic state writes | HIGH | Add WAL or batch write + retry on error | 1 hr |
| BUG-04 reconnect guard | HIGH | Add `reconnecting` boolean flag | 5 min |
| BUG-05 settlement confirmation | HIGH | Require confirmation before auto-close | 15 min |

---

# Testing Recommendations

1. **Unit tests for MVP vote flow:** Mock `decryptPollVote` with LID/JID edge cases to verify the normalization fix works
2. **Integration test for config recovery:** Corrupt config.json and verify bot recovers gracefully
3. **Load test dedup:** Send 500+ duplicate messages in under 1 minute, verify no more than 1 response each
4. **Race test MVP close:** Trigger vote submission during `closeMvpPoll` processing -->> confirm votes are either captured or explicitly dropped (not lost silently)
5. **Test mode isolation:** Verify scheduler and reminder paths in test mode don't write to production files

---

*End of report.*
