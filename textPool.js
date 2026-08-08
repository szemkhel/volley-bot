// Pre-generates AI text in batches and stashes the unused rows in Postgres (ai_text_pool, LXC 107)
// so most requests for a "generic" AI text (no per-call personalization) draw an already-written
// row instead of spending a fresh Claude call. Only worth it for text that doesn't need to be
// unique to a specific person/moment — see reminder.js generateMotivationBatch/generateMvpHaikuBatch
// for what currently qualifies.
//
// Falls back to a single live call (via generateOneFn, passed by the caller) whenever the DB is
// unset/unreachable or the batch generator itself fails — never blocks the caller, same as every
// other AI call in this codebase.
const POOL_SIZE = 20;

// generateOneFn takes no arguments — callers pass a closure over whatever a single live call needs
// (e.g. `() => generateMvpHaiku(winner.name, cfg)`), since that signature varies per kind.
async function getPooledText(kind, config, generateBatchFn, generateOneFn, poolSize = POOL_SIZE) {
  const db = require("./db");
  const cached = await db.drawPooledText(kind);
  if (cached) return cached;
  const batch = await generateBatchFn(poolSize, config);
  if (!batch || !batch.length) return generateOneFn();
  const [first, ...rest] = batch;
  if (rest.length) await db.refillPool(kind, rest);
  return first;
}

module.exports = { getPooledText, POOL_SIZE };
