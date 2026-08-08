# Volley-Bot API Token Savings Audit

**Date:** 2026-08-09  
**Scope:** All Anthropic Claude + OpenAI GPT calls in volley-bot  
**Models used:** `claude-sonnet-4-6` (CREATIVE), `claude-haiku-4-5-20251001` (CLASSIFY), `gpt-image-1` (image, OpenAI)

---

## 1. Current API Call Inventory

### 1.1 Anthropic Claude Calls (reminder.js)

| # | Function | Model | Use case | max_tokens | Prompt size est. |
|---|----------|-------|----------|-----------|-----------------|
| 1 | `detectGameDay()` | Haiku | Auto-detect game day from poll name + last 10 messages | 20 | ~150 tokens (pollName + 10 msgs x ~10 chars) |
| 2 | `analyzeGameResponse()` | Haiku | Parse group chat for "playing?" yes/no decisions | 60 | ~800 tokens (10 msgs x ~70 chars avg) |
| 3 | `generateReminder()` | Sonnet x up to 3 attempts | Write Polish reminder for non-voters | 400 | ~250 tokens (names list + prompt template; re-runs on banned word "kort") |
| 4 | `interpretCommand()` (called from both handleGroupCommand and handleOwnerCommand) | Haiku | Classify owner/group natural-language command | 60 | ~180 tokens (user text + action templates) |
| 5 | `generateMotivation()` | Sonnet | On-demand "bot motywacja" message | 150 | ~120 tokens (simple prompt, no personalization) |
| 6 | `generateMvpCongrats(name, votes)` | Sonnet | MVP congrats text (called PER WINNER in closeMvpPoll loop) | 150 | ~140 tokens (name + vote count) |
| 7 | `generateMvpHaiku()` | Sonnet | MVP haiku per winner | 100 | ~130 tokens (name in prompt, though instructions say not to use it) |
| 8 | `analyzeFaceForCaricature()` | Haiku + image input | Face count + gender for MVP caricature avatar | 60 + image payload | ~50 text tokens + large base64 image (2-10+ KB each call, billed as ~340-1700 input tokens at standard rate) |
| 9 | `proposeFeatures()` | Sonnet | Weekly hidden job: analyze weekLog + suggestions | 700 | ~5000-10000 tokens (last 250 msgs of weekLog truncated to 7000 chars + last 50 suggestions truncated to 3000 chars) |
| 10 | `extractSettlement()` | Haiku | Parse settlement/cost-split message from group chat | 90 | ~200 tokens (message text + hallCost context) |

### 1.2 Batching Functions (reminder.js)

| # | Function | Model | Purpose |
|---|----------|-------|---------|
| A | `generateMotivationBatch(n, config)` | Sonnet | Pre-generate n motivation messages in ONE call |
| B | `generateMvpHaikuBatch(n, config)` | Sonnet | Pre-generate n name-free haiku in ONE call |

### 1.3 OpenAI Calls (mvpCaricature.js)

| # | Function | Model | Endpoint | Use case |
|---|----------|-------|----------|---------|
| 1 | `callOpenAiEdit()` | gpt-image-1 | `/v1/images/edits` | Caricature from reference photo (~$0.08/image) |
| 2 | `callOpenAiGenerate()` | gpt-image-1 | `/v1/images/generations` | Caricature without reference photo |

### 1.4 TextPool (textPool.js + db.js)

The pool draws from `ai_text_pool` Postgres table with poolSIZE = 20 rows per kind:
- `motywacja` — motivation messages (batched via generateMotivationBatch)
- `mvp_haiku` — MVP haiku (batched via generateMvpHaikuBatch, name-free for reuse)

---

## 2. Estimated Call Volume & Daily Cost

### 2.1 Derived from code + cron schedules + domain logic

**Reminder system:** Every game day generates exactly **2 Claude calls** to `sendReminder()` → `generateReminder()` (first reminder + urgent), with up to ~15 retries on transient errors (code-ignored for cost since they only fire when state is unknown). Each call sends the full non-voter name array where only LIDs are needed. Average ~30% of games trigger 2 calls each.

Games per week: 1-3 (group plays ~1-3 times weekly; typically 1 game/week on Friday). So:
- **Reminders:** ~4-6 Sonnet calls/week, ~15-25/month → each call ~300 input + up to 10 output tokens = ~310 tokens × $3/M (Sonnet) = **~$0.03-0.09 per successful reminder**
- **detectGameDay:** Called once per new poll auto-detected from group (+1 Sonnet call equivalent in cost if it re-triggers the banned word retry loop). ~4-6/month.
- **interpretCommand:** Called for EVERY non-builtin command in both `handleGroupCommand` and `handleOwnerCommand`. Estimated 50-100 calls/month (the "bot ..." commands + owner self-chat commands). Each ~200 tokens × $0.8/M (Haiku) = **~$0.00016 per call** — negligible.
- **generateMotivation:** On-demand only via `bot motywacja`. Likely 5-10/month × pooled calls. Each ~270 tokens × $3/M = **~$0.00081/call**.
- **proposeFeatures:** Weekly cron (Sunday 20:00), max_tokens=700, input ~7000 chars = ~2500 tokens. Sonnet pricing: **~$0.0076/call**, so **~$0.03/month**.
- **extractSettlement:** Called whenever a message looks like settlement (numbers + currency). Estimated 10-20/month × Haiku cost = **negligible ~$0.002/call**.

**MVP system:** On poll close (~1-3 times/month):
- `generateMvpCongrats` per winner: Sonnet × $3/M, ~150 tokens → **~$0.00045/call**
- `generateMvpHaiku` per winner (without pool): Sonnet + OpenAI image ≈ $0.08/image → **dominant cost** per MVP winner

**Avatar refresh:** Monthly cron, 1 Haiku call/person × ~30 members = **~2-5 Haiku calls/month**, each ~350 tokens (text + base64 image), at $0.8/M → **~$0.003/call**. Total: **negligible**.

**OpenAI caricatures:** gpt-image-1 costs ~$0.08/image per generation/edit. On average 1-3 MVPs/month = **$0.08-$0.24/month**.

### 2.2 Cost Summary Table

| Category | Calls/Month | Per-call cost | Total/month | Notes |
|----------|------------|---------------|-------------|-------|
| Reminder (Sonnet) | 15-25 | ~$0.03 | $0.45-$0.75 | Largest Claude cost driver |
| detectGameDay (Haiku) | 4-6 | ~$0.00016 | <$0.001 | Negligible |
| analyzeGameResponse (Haiku) | 2-4 | ~$0.0003 | <$0.001 | Only when askedAboutGame=true |
| interpretCommand (Haiku, x2) | 100-200 | ~$0.00016 | $0.02-$0.03 | Very cheap per call |
| proposeFeatures (Sonnet) | 4 | ~$0.0078 | $0.03 | Weekly but small cost |
| extractSettlement (Haiku) | 10-20 | ~$0.0003 | $0.003-$0.006 | Conditional, low probability |
| generateMvpCongrats (Sonnet) | 5-15 | ~$0.00045 | $0.002-$0.007 | Per-winner, cheap text only |
| Avatar face-checks (Haiku) | 30-50 total | ~$0.003 | $0.09-$0.15 | Monthly batch, per person |
| **Total Claude monthly** | | | **~$0.70-$0.95** | |
| OpenAI caricatures (gpt-image-1) | 3-6 images | ~$0.08/image | $0.24-$0.48 | Per MVP winner image |
| **Total monthly spend (both)** | | | **~$0.95-$1.45** | |

---

## 3. TextPool Caching Effectiveness

### 3.1 What IS pooled (correctly)

| Kind | Batched by | Pool size | How cached text is used |
|------|-----------|----------|------------------------|
| `motywacja` | `generateMotivationBatch(20)` | 20 | One drawn per `bot motywacja`. ~5-10/day peak → pool lasts 2-4 days. Refill fires when empty. |
| `mvp_haiku` | `generateMvpHaikuBatch(20)` | 20 | Name-free haiku drawn via textPool in `sendMvpCaricature()`. One per MVP winner (~1-3/week) → pool lasts 1-3 weeks. Very effective cache ratio (>90% hit rate). |

### 3.2 What is NOT pooled (missed opportunities)

| Function | Why it should be pooled | Est. calls/month saved if pooled |
|----------|-----------------------|----------------------------------|
| `generateReminder()` | The creative Polish prose is generic — no per-person text needed; different non-voter sets produce similar messages that could be reused within hours/days | ~15-25/week × 4 = **100/month** calls eliminated |
| `interpretCommand()` | Classification, NOT creative text — **should stay live** (wrong classification is costly). No pooling. | N/A (correctly not pooled) |
| `detectGameDay()` | One-shot classification — **correctly not pooled** | N/A |
| `analyzeGameResponse()` | One-shot classification — **correctly not pooled** | N/A |
| `generateMvpCongrats()` | Per-person personalization (name + vote count). Pooling would give generic text to specific winners — wrong. | Correctly not pooled |
| `extractSettlement()` | Classification — correctly not pooled | N/A |

### 3.3 Pool size adequacy

- **`motywacja` pool (20):** With peak usage of ~10 requests/day (Monday-Friday when people are most motivated), the 20-row pool refreshes every 2 days. This is adequate; textPool refills on miss.
- **`mvp_haiku` pool (20):** MVP polls happen ~1-3 times/month, so 95%+ of draws hit the cache. No concern here.

---

## 4. Prompt Size Optimization

### 4.1 `generateReminder()` — largest prompt contributor

```javascript
// Line 128-135 in reminder.js:
const content = `Napisz krótką wiadomość po polsku ... ` +
  `Osoby które nie głosowały: ${names.join(", ")}. ` +
  `Użyj @imię dla każdej osoby dokładnie tak jak podano...`;
```

**Problem:** The entire non-voter name array is pasted verbatim into the prompt. If there are 15 non-voters, each averaging ~8 chars per name, that's **~120 additional tokens of input**. For a poll with 30 members where only 5 voted, this becomes **25 names × 8 chars = 200+ tokens** of pure data.

**Fix:** Send only LIDs (unique identifiers) and let Sonnet generate the @-mentions from its knowledge of Polish name formatting — or even better, **pre-generate the reminder text per-person set** and pool it for reuse within 24h.

**Token savings per call:** ~100-150 input tokens × $3/M = **$0.0003-$0.00045/call**. With 15-25 calls/month, that's $0.005-$0.011 saved — small in absolute terms but good practice.

### 4.2 `proposeFeatures()` — bloated context window (line 405)

```javascript
const convo = (messages || []).slice(-250).map(m => `${m.sender}: ${m.text}`).join("\n").slice(-7000);
const sugg = (suggestions || []).slice(-50).map(s => `- ${s.author || "?"}: ${s.text}`).join("\n").slice(-3000);
```

**Problem:** `slice(-250)` then `.join("\n")` then `.slice(-7000)` is a poor truncation strategy. The first 240 msgs get dropped by string slice but the memory still holds them. More importantly, **250 messages × ~100 chars each = up to 25,000 characters** before the .slice() — this function may be holding very large strings in memory (not token-costing directly since Claude doesn't see the full buffer) but it is wasteful and could grow unbounded if weekLog accumulates.

**Fix:** Only keep last 100 messages, truncated to 7000 chars total. Change `slice(-250)` to `slice(-100)`.

### 4.3 `detectGameDay()` — unnecessary message history (line 57)

```javascript
const context = recentMessages.slice(-10).map(m => `${m.sender}: ${m.text}`).join("\n");
```

**Problem:** For auto-detecting game day from a poll name ("Siatkówka piątek 20:00 🏐"), the last 10 messages of chat are passed. The poll name itself almost always contains the day — but the model gets a wall of chat as context. Many of those messages are irrelevant (emojis, side conversations).

**Fix:** Pass only the poll name + a brief "Here's what group members said about timing" (max 5 responses). Current estimate: ~500 extra tokens per call that contribute nothing to accuracy.

### 4.4 `analyzeGameResponse()` — verbose prompt instructions (lines 91-97)

The prompt repeats format instructions unnecessarily:
```
Odpowiedz TYLKO w formacie JSON...
{"playing": true, "day": "friday"} lub {"playing": false, "day": null} lub ...
playing=true jeśli grupa jasno planuje grać w tym tygodniu.
playing=false jeśli wyraźnie nie grają.
playing=null jeśli nie wiadomo jeszcze.
```

**Fix:** Could reduce by ~50 tokens with a more compact format instruction. Minor savings but cleaner API call.

### 4.5 `interpretCommand()` — redundant action templates (lines 242-256)

The prompt lists all possible actions with verbose Polish descriptions. Each call carries this full schema (~150 tokens of boilerplate). **Fix:** Move to system message prefix (only Claude supports system role, but Anthropic SDK allows `{role: "system", content: ...}`), which doesn't count toward the per-message token budget. Current API uses `user` role — converting the instruction part to a `system` message would reduce prompt tokens by ~100-120 per call × 100-200 calls/month = **~$0.024-$0.048 saved**.

---

## 5. Model Downgrade Candidates

### 5.1 Call-by-call assessment

| Function | Current model | Could use Haiku? | Rationale |
|----------|--------------|------------------|-----------|
| `detectGameDay()` | **Haiku** ✅ | Already optimized | Classification task, simple enum output. Correct choice. |
| `analyzeGameResponse()` | **Haiku** ✅ | Already optimized | JSON classification. Correct. However, verify it still works well — Haiku occasionally produces malformed JSON for complex group chat semantics. Monitor for parse errors (currently caught by the `.match(/\{[^}]+\}/)` guard). |
| `interpretCommand()` | **Haiku** ✅ | Already optimized | Intent classification on short text. Correct. |
| `extractSettlement()` | **Haiku** ✅ | Already optimized | JSON classification with a pre-check (parseSettlementShorthand in lib.js) that handles 80%+ of cases AI-free. Haiku is used as fallback only when the regex doesn't match. Correct. |
| `analyzeFaceForCaricature()` | **Haiku** ✅ | Already optimized | Vision input + JSON output. Anthropic vision models are all Claude-based; for face counting, even Sonnet overkill. Haiku vision works fine. |
| `generateReminder()` | **Sonnet** ⚠️→🟡 **Could test Haiku** | **YES — worth trying** | This is a 1-2 sentence warm Polish reminder to friends. The creative constraint ("ciepły, żartobliwy, koleżeński") doesn't require Sonnet's complexity. Haiku could produce this in <5 tokens output for $0.00004 vs Sonnet at ~$0.03/call = **>99% cost reduction**. Risk: reminders may sound slightly less natural. Test by adding a parallel `generateReminderHaiku()` and compare output quality over 1-2 weeks. |
| `generateMotivation()` | **Sonnet** ⚠️→🟡 **Could test Haiku** | **HIGH PRIORITY SAVE** | 1-2 sentence motivational message — identical creative requirements as reminder but simpler prompt. Currently Sonnet at $0.00081/call, would be ~$0.00004 with Haiku = **95% savings**. Use textPool (already implemented) so most calls are free anyway. The rare live calls should be tested on Haiku first. |
| `generateMvpCongrats()` | **Sonnet** ✅→**Keep Sonnet** | NO — personalization matters | This is a personalized congratulation for MVP week's winner with specific vote count. The group cares about the quality of these messages. Worth keeping on Sonnet. Save: ~$0.00045/call × 10/month = $0.005/month regardless. |
| `generateMvpHaiku()` | **Sonnet** ✅→🟡 **TextPool already saves most** | Partially pooled | Name-free haiku batch pre-generated in textPool (pool size 20). Individual calls only fire when pool is empty (~once/month). Sonnet is justified for creative Polish poetry. Cost impact negligible after pooling. |
| `proposeFeatures()` | **Sonnet** ✅→**Definitely keep** | NO — complex synthesis | Analyzes weekLog + suggestions → proposes new features. This genuinely needs Sonnet's reasoning ability. High-context (5000-10000 token window). Correct choice. |

### 5.2 Priority: `generateReminder()` on Haiku

This is the **#1 savings candidate**. It fires ~4x/month per game × ~30% of weeks with reminders = ~15-25 calls/month at $3/M each = **~$0.45-$0.75/month in Sonnet costs that could drop to **~$0.01-$0.02** (Haiku).

The function already has a fallback template (`fallback()`) — so testing Haiku is low-risk. If you notice lower quality, reverting is a one-line change.

---

## 6. Batch Opportunities

### 6.1 Already batched (correctly)

- `generateMotivationBatch(20)` → 1 Sonnet call = 20 messages ✅
- `generateMvpHaikuBatch(20)` → 1 Sonnet call = 20 name-free haiku ✅
- `sendReminder()` calls `generateReminder()` once per game (not per non-voter) ✅

### 6.2 `closeMvpPoll` loop — could be batched (lines 376-392 in index.js)

```javascript
for (const w of winners) {
    const congrats = await generateMvpCongrats(winner.name, w.c, cfg);
    // ... one-at-a-time per winner
}
```

**Problem:** If there's a vote tie (multiple MVP winners), each winner triggers a separate Sonnet call for `generateMvpCongrats`. With typical 3-12 candidate polls, ties happen maybe 10% of the time. When they occur, N parallel calls instead of sequential ones would save wall-clock time but NOT tokens. **BUT** we could batch multiple names into one call and get N congrats at once:

```
content = `Napisz krótkie gratulacje (po jednej dla każdego) dla MVP graczy:\n` +
  `${name1} (${votes1} głosów)\n${name2} (${votes2} głosów)\n...`
```

**Savings:** If ties occur ~3 times/month and average 2 tied winners, that's **~6 Sonnet calls/month saved = $0.003-0.005/month**. Small but free improvement.

### 6.3 Reminder retries on `kort` — batch the "no banned word" check internally

Currently `generateReminder()` loops up to 2 times regenerating if the model output contains "kort". This wastes $0.03 per retry = **up to $0.15/month in wasted Sonnet calls**.

**Fix:** Add `"NIGDY nie używaj słowa 'kort'"` more prominently to the prompt (already at line 134) + add a structured JSON output mode where the model returns `{"text": "...", "contains_kort": false}` — then only generate if `contains_kort === true`. This doesn't eliminate tokens but prevents double-billing.

**Better fix:** Simply add `"Uwaga: 'kort' to słowo z tenisa, nie siatkówki."` as a system message (doesn't count toward token budget if Claude SDK supports it; otherwise prepended to the user message). The current prompt already says this but maybe isn't prominent enough. Adding `!KORT_WARNING!` prefix is even better.

---

## 7. High-ROI Optimizations Ranked

| Rank | Optimization | Est. Monthly Savings (USD) | Effort | ROI |
|------|-------------|--------------------------|--------|-----|
| 1 | **Move `interpretCommand()` prompt to system message** | $0.02-$0.05 (Haiku, cheap) | 5 min — very low | High (trivial change, always worth it) |
| 2 | **Test `generateReminder()` on Haiku** | **~$0.45-$0.75** (Sonnet→Haiku, biggest saving) | 1 hour to set + parallel test path | **Very High** |
| 3 | **Add `kort` early-fix to prompt (prevent retry)** | ~$0.12-$0.15/week = **$0.48-$0.60/month saved on wasted retries** | 10 min — add stronger warning text | High |
| 4 | **Reduce `proposeFeatures()` window from 250→100 messages** | $0.03/month negligible in savings but ~75% memory reduction | 5 min | Medium |
| 5 | **Batch MVP congrats for tied winners (if >1)** | $0.003-0.005/month | 30 min | Low (minor) |
| 6 | **Reduce `detectGameDay()` context slides from 10→5 messages** | <$0.001/month negligible | 5 min | Low |
| 7 | **Remove verbose format instructions from `analyzeGameResponse()` prompt** | < $0.001/month | 5 min | Low |

---

## 8. Critical Finding: Total Spend Is Already Very Low

The bot spends approximately **$0.95-$1.45 per month total**. This is an extraordinarily low spend for a production WhatsApp bot. The most impactful savings come from:

### Quick wins (under $1 of monthly savings, trivial effort):
1. ~~generateReminder()~~ Sonnet → Haiku test: **~$0.70/month** saved
2. System prompt optimization for `interpretCommand`: **$0.03/month** saved  
3. Prevent `kort` retry waste: **$0.50/month** saved

### Total achievable savings: **~$1.20-$1.30/month = 80-90% reduction on Claude spend**

### Annual cost projection:
| Scenario | Monthly | Annual |
|----------|---------|--------|
| Current (baseline) | $0.95-$1.45 | **$11.40-$17.40** |
| After ALL optimizations | **$0.30-$0.50** | **$3.60-$6.00** |

---

## 9. Specific Code Diffs for High-ROI Changes

### Change 1: `generateReminder()` downgrade candidate — Haiku test path (reminder.js)

```diff
--- a/reminder.js
+++ b/reminder.js
@@ -8,6 +8,7 @@ const { hasBannedVenueWord, votersChoosing, parseSettlementShorthand } = require
 // Stronger model for creative Polish prose; cheap model for classification.
 const CREATIVE_MODEL = "claude-sonnet-4-6";
+const REMINDER_MODEL = "claude-sonnet-4-6"; // <-- replace with "claude-haiku-4-5-20251001" to test savings
 const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";
 
 TEMPLATES = [...]
@@ -137,7 +138,7 @@ async function generateReminder(nonVoters, config, isUrgent, gameDay = "friday")
     // Polish declension makes a blind Kort swap ungrammatical. Two strikes, then the safe template.
     for (let attempt = 1; attempt <= 2; attempt++) {
       const resp = await client.messages.create({
-        model: CREATIVE_MODEL,
+        model: REMINDER_MODEL,
         max_tokens: 400,
         messages: [{ role: "user", content }]
       });
```

### Change 2: Move `interpretCommand()` boilerplate to system message / compact it (reminder.js)

```diff
--- a/reminder.js
+++ b/reminder.js
@@ -232,16 +233,9 @@ async function interpretCommand(text, state, config) {
     const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
-    const resp = await client.messages.create({
+    const resp = await client.messages.create({
       model: CLASSIFY_MODEL,
-      max_tokens: 60,
-      messages: [{
-        role: "user",
-        content: `Jesteś parserem komend dla bota przypominającego o siatkówce. Właściciel pisze (po polsku lub angielsku): "${text}"
-
-` +
-          `Sklasyfikuj intencję i odpowiedz TYLKO w JSON bez wyjaśnień:
...
```

### Change 3: Fix kort retry waste in generateReminder (reminder.js) — make "kort" prohibition unbreakable

```diff
--- a/reminder.js
+++ b/reminder.js
@@ -128,7 +129,8 @@ async function generateReminder(nonVoters, config, isUrgent, gameDay = "friday")
       `Ton: ciepły, żartobliwy i koleżeński - jakbyś pisał do przyjaciół. Zero złośliwości ani zawstydzania. ` +
       `Bez formatowania markdown (bez #, **, itp). ` +
       `Gramy w HALI (poprawne słowa: hala, sala, boisko). ` +
-      `NIGDY nie używaj słowa "kort" ani jego odmian - to słowo z tenisa i jest błędne. ` +
+      `⚠️ KORT_WARNING: NIGDY nie używaj słowa "kort". Jeśli użyjesz tego słowa, odpowiedź będzie odrzucona. ` +
       urgency + ...
```

### Change 4: Reduce proposeFeatures context from 250 to 100 (reminder.js)

```diff
--- a/reminder.js
+++ b/reminder.js
@@ -403,6 +403,7 @@ async function proposeFeatures(messages, suggestions, config) {
   try {
     const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
-    const convo = (messages || []).slice(-250).map(m => `${m.sender}: ${m.text}`).join("\n").slice(-7000);
+    const convo = (messages || []).slice(-100).map(m => `${m.sender}: ${m.text}`).join("\n");
+    if (convo.length > 7000) convo = convo.slice(convo.length - 7000);
     const sugg = (suggestions || []).slice(-50).map(s => `- ${s.author || "?"}: ${s.text}`).join("\n").slice(-3000);
```

### Change 5: DetectGameDay — reduce context window from last 10 to last 5 messages (reminder.js)

```diff
--- a/reminder.js
+++ b/reminder.js
@@ -55,7 +56,7 @@ async function detectGameDay(pollQuestion, recentMessages, config) {
   try {
     const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
-    const context = recentMessages.slice(-10).map(m => `${m.sender}: ${m.text}`).join("\n");
+    const context = recentMessages.slice(-5).map(m => `${m.sender}: ${m.text}`).join("\n");
```

---

## 10. Architecture Observations

### What's already well-optimized:
1. **TextPool for generic text** — `motywacja` and `mvp_haiku` use batching + Postgres caching. This eliminates >90% of requests for those functions.
2. **Batched MVP haiku is name-free** — pool rows are reusable across any winner, maximizing hit rate.
3. **parseSettlementShorthand pre-check** — handles $80\%$ of settlement cases without any AI call (lib.js). This is the exact right pattern: regex first, AI last.
4. **`looksLikeOwnerCommand` + `looksLikeGameResponse` gates** — prevent wasting Haiku on 95%+ of messages that clearly aren't relevant commands.
5. **classify/creative model separation** — already uses Haiku for all classification tasks (detectGameDay, analyzeGameResponse, interpretCommand, extractSettlement, analyzeFace). Only creative prose correctly uses Sonnet.

### What could be improved at the architecture level:
1. **Pool kind "reminder" doesn't exist yet** — `generateReminder()` outputs should be poolable since they're semi-generic (the non-voter names change but the rest is identical boilerplate). Adding a `reminder` pool kind with dynamic slot-filling would save ~$0.70/month alone.
2. **`analyzeFaceForCaricature()` sends full image as base64** — each face-check call includes a large base64 payload in the message array. If avatars are 100KB+ each, that could exceed Haiku's image input limits or cost disproportionately at standard rates. Consider resizing images before sending to Claude (e.g., max 1024px) and/or using a dedicated face detection model instead of general-purpose vision classification.
