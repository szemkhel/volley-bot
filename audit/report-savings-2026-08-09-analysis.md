# Analysis of `report-savings-2026-08-09.md`

This report is broadly sound on architecture (it correctly identifies the existing `textPool`/gate
work as already well done) but its **#1 and #2 "high ROI" recommendations are both invalidated by
this project's own documented history**, which the auditor didn't check. That's the headline finding
below — everything else is comparatively minor polish on a system that already costs about
$1/month.

---

## REJECT — the report's top recommendation contradicts a documented, already-tested finding

### 1. "Test `generateReminder()`/`generateMotivation()` on Haiku" — already tried, already rejected
**Verified: this exact experiment has already been run and its result is recorded in `CLAUDE.md`
itself** (line 37-38): *"`CREATIVE_MODEL = "claude-sonnet-4-6"` for Polish prose (reminders,
motivation, MVP congrats — **Haiku produced poor Polish**)"*. This is not a hypothetical concern the
auditor is right to flag for testing — it's a documented conclusion from prior direct experience on
this exact codebase. The report's §5.2 claims this is "the #1 savings candidate" worth ~$0.70/month
and frames it as low-risk because "the function already has a fallback template." That framing
misses that the *live, non-fallback* output quality is precisely what was already tested and found
wanting.
**Action:** Do NOT re-test Haiku for `generateReminder`/`generateMotivation`/`generateMvpCongrats` —
this is the entire reason `CREATIVE_MODEL` exists as a separate constant from `CLASSIFY_MODEL` in
the first place. If a future model generation changes this calculus (e.g., a future Haiku version
with genuinely better Polish), that's worth revisiting, but "test claude-haiku-4-5 on this" is not a
new idea — it's the rejected baseline.
**Effort:** 0 — explicitly do not implement.

This single correction removes **~75% of the report's claimed achievable savings** (its own table
puts this at $0.70 of a claimed $1.20-1.30/month total achievable). What's left below is real but
small.

---

## DO — cheap, correct, worth doing

### 2. `proposeFeatures()` context window: 250 → 100 messages
**Verified: real, low-risk.** `reminder.js:405` does `slice(-250)...slice(-7000)` as described.
Trimming to `slice(-100)` before the character-slice is a strict improvement — less unnecessary
data even after the character cap, and this function already runs weekly with plenty of headroom
for quality (the report is right that the 7000-char final truncation was already doing most of the
real limiting, so this is closer to a memory/tidiness win than a quantifiable cost win — the report's
own $0.03/month estimate for this one is more honest than its headline number).
**Action:** Apply the report's diff (Change 4) essentially as written.
**Effort:** ~5 min.

### 3. `kort`-retry prompt hardening
**Verified: the retry loop is real** (`reminder.js:139-148`, up to 2 attempts, confirmed by direct
read). Whether it fires often enough to matter is **not measured** anywhere in the report or in this
codebase (no counter/log aggregation exists for how often `hasBannedVenueWord` triggers a retry) —
the report's "$0.50/month wasted" figure is a guess with no supporting data, not a measurement.
**Action:** Still fine to do — strengthening the prompt wording (or adding a more prominent
warning) is free and can only help, regardless of the real frequency. Don't treat the dollar
estimate as reliable; treat this as "cheap and directionally correct," not "measured savings."
**Effort:** ~10 min.

### 4. Move `interpretCommand()`'s boilerplate instructions to `system` parameter — **but not for the reason given**
**Verdict: worth doing, report's stated mechanism is factually wrong.** The report claims moving
instructions to a `system` role "doesn't count toward the per-message token budget" — **this is
incorrect**. Anthropic bills `system` parameter content as input tokens exactly like any other
prompt text; there is no free lunch from using `system` alone. The only way to actually reduce
billed tokens on a *repeated* prefix is Anthropic's prompt caching feature (explicit
`cache_control: {type: "ephemeral"}` breakpoints), which this codebase does not currently use
anywhere and the report never mentions.
**Action:** Moving the boilerplate to `system` is still worth doing for code clarity (separates
instructions from user data, which also modestly helps the F2 prompt-injection concern from the
security report), just don't expect it to save money by itself. If real prompt-caching savings are
wanted, that's a distinct, larger change: add `cache_control` breakpoints on the shared instruction
text in `interpretCommand`, `detectGameDay`, `analyzeGameResponse`, `extractSettlement` — these are
the highest-volume, most-repeated-prompt-shape calls per the report's own inventory (§1.1), so
they're the right candidates *if* someone wants to chase real caching savings later. Given total
spend is ~$1/month, this is a "nice to have," not a priority.
**Effort:** ~15 min for the `system`-param refactor (clarity only); prompt caching itself would be a
separate, larger task not worth doing at this spend level.

### 5. Batch `generateMvpCongrats` for tied winners
**Verdict: real, correctly assessed as low-value by the report itself** ("$0.003-0.005/month").
**Action:** Skip — not worth the code complexity of batching a rare (ties are uncommon) multi-name
prompt for a few tenths of a cent a month. Note also that this would need the same "text must stay
per-person personalized" handling the report itself flags elsewhere as a reason NOT to pool congrats
text — batching within one call while keeping personalization is a reasonable middle ground, but
still not worth it at this scale.
**Effort:** skip.

---

## SKIP — negligible or the report's own numbers say so

- **`detectGameDay()` context 10→5 messages, `analyzeGameResponse()` prompt trimming**: the report's
  own estimates are `<$0.001/month` for both. Not worth a code change or a review cycle.
- **§6.2 batching tied-winner congrats, §4.5 exact token counts**: precision here doesn't matter at
  sub-cent monthly amounts.

---

## Context worth adding that the report missed entirely

### 6. The actual historical cost-blowup cause is not in this report, and it's already fixed
This report analyzes API call *shape and volume estimated from reading the code*, but it has no
visibility into what actually happened in production. The real root cause of the "used all credits"
incidents that prompted this whole investigation was **two unconditional AI calls firing on every
message regardless of relevance** (the owner's self-chat catch-all, and the group-chat classifier
during the `askedAboutGame` window) — both already found and fixed (see project history / PR #51,
`lib.looksLikeOwnerCommand`/`looksLikeGameResponse`). The savings report actually already notices
these gates exist and correctly praises them (§10, point 4: *"prevent wasting Haiku on 95%+ of
messages that clearly aren't relevant commands"*) — it just doesn't realize it's looking at the
fix for the actual incident, not a hypothetical.
**Action:** None needed — flagging this for completeness so whoever picks up "further savings work"
understands the big win already happened, and everything in this report is optimizing an
already-healthy system.

### 7. Sanity-check the report's own headline number
The report concludes total spend is ~$0.95-$1.45/month currently, achievable to ~$0.30-$0.50/month
after all its suggestions. With recommendation #1 rejected (see above), realistic achievable
additional savings from the remaining DO items is on the order of **$0.05-$0.15/month** — real, but
not worth prioritized engineering time over anything else in this audit batch. Treat this whole
report as "do the free/trivial items opportunistically, don't schedule dedicated work."

---

## Priority order for job creation

1. Do NOT implement the Haiku-downgrade recommendations (§1) — this is the important correction.
2. Items 2-4 above (`proposeFeatures` trim, `kort` prompt hardening, `system`-param cleanup) — bundle
   into one small opportunistic PR, no urgency.
3. Everything else — skip.
