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

module.exports = { syncFromHistory };
