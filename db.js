// Optional Postgres mirror of production game history → powers the public Grafana dashboard.
// Best-effort: if DATABASE_URL is unset or the DB is unreachable, every call is a safe no-op
// and the bot keeps running on its JSON files as before.
const { Pool } = require("pg");

let pool = null;
let warnedNoUrl = false;

function getPool() {
  if (pool) return pool;
  const cs = process.env.DATABASE_URL;
  if (!cs) {
    if (!warnedNoUrl) { console.log("[db] DATABASE_URL not set — Postgres stats mirror disabled"); warnedNoUrl = true; }
    return null;
  }
  pool = new Pool({ connectionString: cs, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  pool.on("error", (e) => console.error("[db] pool error:", e.message));
  return pool;
}

// Full idempotent resync of the PRODUCTION history (≤200 rows) into games + attendance.
// Cheap enough to run on startup, after each archive, and on a periodic backstop cron.
async function syncFromHistory(history) {
  const p = getPool();
  if (!p) return;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const h of (history || [])) {
      if (!h || !h.date) continue;
      const g = await client.query(
        `INSERT INTO games (game_date, game_day, game_time, status, question, voted, players, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (game_date, game_day) DO UPDATE SET
           game_time=EXCLUDED.game_time, status=EXCLUDED.status, question=EXCLUDED.question,
           voted=EXCLUDED.voted, players=EXCLUDED.players, updated_at=now()
         RETURNING id`,
        [h.date, h.gameDay || null, h.gameTime || null, h.status || null, h.question || null, h.voted || 0, h.players || 0]
      );
      const id = g.rows[0].id;
      // Attendance is small and can change (name backfill) → replace the set for this game.
      await client.query("DELETE FROM attendance WHERE game_id=$1", [id]);
      for (const a of (h.attendees || [])) {
        if (!a || !a.phone) continue;
        await client.query(
          "INSERT INTO attendance (game_id, player_phone, player_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [id, a.phone, a.name || null]
        );
      }
    }
    await client.query("COMMIT");
    console.log("[db] synced", (history || []).length, "games to Postgres");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[db] sync failed:", e.message);
  } finally {
    client.release();
  }
}

// Mirror the full player roster (so "0 games" people still show on the dashboard). Best-effort.
async function syncRoster(players) {
  const p = getPool();
  if (!p) return;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const pl of (players || [])) {
      if (!pl || !pl.phone) continue;
      await client.query(
        `INSERT INTO players (phone, name, updated_at) VALUES ($1,$2, now())
         ON CONFLICT (phone) DO UPDATE SET name=COALESCE(EXCLUDED.name, players.name), updated_at=now()`,
        [pl.phone, pl.name || null]
      );
    }
    await client.query("COMMIT");
    console.log("[db] synced", (players || []).length, "players to Postgres");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[db] roster sync failed:", e.message);
  } finally {
    client.release();
  }
}

// Mirror MVP winners (one per date) for the dashboard MVP panel. Best-effort.
async function syncMvp(mvpList) {
  const p = getPool();
  if (!p) return;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const m of (mvpList || [])) {
      if (!m || !m.date) continue;
      await client.query(
        `INSERT INTO mvp (mvp_date, phone, name, votes) VALUES ($1,$2,$3,$4)
         ON CONFLICT (mvp_date) DO UPDATE SET phone=EXCLUDED.phone, name=EXCLUDED.name, votes=EXCLUDED.votes`,
        [m.date, m.phone || null, m.name || null, m.votes || 0]
      );
    }
    await client.query("COMMIT");
    console.log("[db] synced", (mvpList || []).length, "MVP entries to Postgres");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[db] mvp sync failed:", e.message);
  } finally {
    client.release();
  }
}

// Pre-generated AI text pool (motywacja, MVP haiku, ...) — draws one unused row, marks it used,
// and returns it. Null means "no unused row" (pool empty or DB unreachable) — the caller falls
// back to a live AI call and refills the pool for next time. Reduces per-call Claude spend for
// text that doesn't need to be unique to a specific moment.
// SELECT ... FOR UPDATE SKIP LOCKED (not a plain UPDATE-with-subquery) is deliberate: two
// concurrent draws for the same kind must land on two DIFFERENT rows. A plain
// `UPDATE ... WHERE id = (SELECT ... LIMIT 1)` lets both statements' subqueries see the same
// unused row before either commits, so both would return the identical text and only one row
// actually ends up marked used. SKIP LOCKED makes the second draw skip the row the first already
// locked and pick a different one instead.
async function drawPooledText(kind) {
  const p = getPool();
  if (!p) return null;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query(
      "SELECT id, text FROM ai_text_pool WHERE kind=$1 AND used_at IS NULL ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED",
      [kind]
    );
    if (!sel.rows[0]) { await client.query("ROLLBACK"); return null; }
    await client.query("UPDATE ai_text_pool SET used_at = now() WHERE id=$1", [sel.rows[0].id]);
    await client.query("COMMIT");
    return sel.rows[0].text;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[db] drawPooledText failed:", e.message);
    return null;
  } finally {
    client.release();
  }
}

// Bulk-insert a fresh batch of unused texts for a kind. Best-effort — a failed refill just means
// the next draw falls through to a live AI call again, same as if the pool were still empty.
async function refillPool(kind, texts) {
  const p = getPool();
  if (!p || !texts || !texts.length) return;
  try {
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      for (const t of texts) {
        if (t) await client.query("INSERT INTO ai_text_pool (kind, text) VALUES ($1,$2)", [kind, t]);
      }
      await client.query("COMMIT");
      console.log("[db] refilled ai_text_pool:", kind, texts.length);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[db] refillPool failed:", e.message);
  }
}

module.exports = { syncFromHistory, syncRoster, syncMvp, drawPooledText, refillPool };
