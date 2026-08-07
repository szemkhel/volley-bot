// Pure, side-effect-free helpers — unit tested in test/lib.test.js
// (kept free of WhatsApp / state / network so they can run in CI)

const DAY_WORDS = {
  "poniedzialek": "monday", "poniedziałek": "monday",
  "wtorek": "tuesday",
  "sroda": "wednesday", "środa": "wednesday", "srode": "wednesday", "środę": "wednesday",
  "czwartek": "thursday",
  "piatek": "friday", "piątek": "friday",
  "sobota": "saturday", "sobote": "saturday", "sobotę": "saturday",
  "niedziela": "sunday", "niedziele": "sunday", "niedzielę": "sunday",
};

// How many players a vote-tally represents: "Gram"=1, "Gram i przyprowadzam +N"=1+N
function attendanceFromTally(tally) {
  let players = 0;
  for (const o in tally) {
    if (o === "Gram") players += tally[o];
    else if (/przyprowadzam/i.test(o)) {
      const m = o.match(/\+\s*(\d+)/);
      const extra = m ? parseInt(m[1], 10) : 1;
      players += tally[o] * (1 + extra);
    }
  }
  return players;
}

// Weight of a single voter's selected option(s)
function weightOfOptions(opts) {
  const t = {};
  for (const o of (opts || [])) t[o] = (t[o] || 0) + 1;
  return attendanceFromTally(t);
}

// Parse "piątek 20:00" / "czwartek 21" -> { day: "friday", time: "20:00" }
function parseAnkieta(text) {
  const lower = (text || "").toLowerCase();
  let day = null;
  for (const w in DAY_WORDS) { if (lower.includes(w)) { day = DAY_WORDS[w]; break; } }
  let time = null;
  const tm = lower.match(/(\d{1,2})[:.](\d{2})/);
  if (tm) time = tm[1].padStart(2, "0") + ":" + tm[2];
  else { const th = lower.match(/\b(\d{1,2})\b/); if (th) time = th[1].padStart(2, "0") + ":00"; }
  return { day, time };
}

// Next date (YYYY-MM-DD, Europe/Warsaw) for a weekday name; includes today if it matches.
// `now` is injectable for testing.
function nextDateForDay(dayName, now) {
  const map = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const target = map[dayName];
  if (target == null) return null;
  const warsawStr = (now || new Date()).toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
  const base = new Date(warsawStr + "T12:00:00");
  const add = (target - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + add);
  return base.toISOString().slice(0, 10);
}

// Authorization: owner (fromMe) always; otherwise must match owner LID or be in admins list
function isAdmin(senderPhone, isFromMe, admins, ownerLidPhone) {
  if (isFromMe) return true;
  if (!senderPhone) return false;
  if (ownerLidPhone && senderPhone === ownerLidPhone) return true;
  return (admins || []).indexOf(senderPhone) >= 0;
}

// From an extracted settlement {people,total,perPerson} + static hallCost → real player count (the divisor)
function settlementPeople(info, hallCost) {
  if (!info) return null;
  if (typeof info.people === "number" && info.people > 0) return Math.round(info.people);
  if (info.total > 0 && info.perPerson > 0) return Math.round(info.total / info.perPerson);
  if (info.perPerson > 0 && hallCost > 0) return Math.round(hallCost / info.perPerson);
  return null;
}

// Pick the poll matching a day (and optionally exact time) from a list. Returns the poll or null.
function matchPoll(polls, day, time) {
  let cand = (polls || []).filter(p => p.gameDay === day);
  if (time) cand = cand.filter(p => p.gameTime === time);
  return cand[0] || null;
}

// Parse an injury/absence duration (Polish, approximate) → number of days, or null if unrecognized.
// Supports: "3 dni", "2 tygodnie", "miesiąc", bare "tydzień"/"miesiac" (default count 1).
function parseAbsenceDays(text) {
  const t = (text || "").toLowerCase();
  const m = t.match(/(\d+)/);
  const n = m ? parseInt(m[1], 10) : 1;
  if (!n || n < 1) return null;
  if (/mies/.test(t)) return n * 30;         // miesiąc/miesiące/miesięcy/miesiac
  if (/tydz|tygod/.test(t)) return n * 7;    // tydzień/tygodnie/tygodni
  if (/dzie|dni/.test(t)) return n;          // dzień/dni
  return null;
}

// LIDs whose injury/absence is still active (end-date >= today). injuries = { lid: "YYYY-MM-DD" }.
// ISO date strings compare correctly lexicographically.
function activeInjuryLids(injuries, today) {
  const out = [];
  for (const lid in (injuries || {})) {
    if (injuries[lid] && injuries[lid] >= today) out.push(lid);
  }
  return out;
}

// Games attended per player (LID user-part) across archived history. Cancelled games don't count.
function attendanceCounts(history) {
  const counts = {};
  for (const h of (history || [])) {
    if (!h || h.status === "cancelled") continue;
    for (const a of (h.attendees || [])) {
      if (a && a.phone) counts[a.phone] = (counts[a.phone] || 0) + 1;
    }
  }
  return counts;
}

// A WhatsApp poll holds at most 12 options, but more than 12 people can play. Rather than keeping
// whoever happens to sit first in the list, keep the most regular players — season attendance
// desc, stable so equal counts preserve the original order (deterministic across runs).
function pickTopByAttendance(candidates, counts, limit) {
  const list = (candidates || []).slice();
  if (!limit || list.length <= limit) return list;
  return list
    .map((c, i) => ({ c: c, i: i, n: (counts || {})[c.phone] || 0 }))
    .sort((a, b) => (b.n - a.n) || (a.i - b.i))
    .slice(0, limit)
    .map(x => x.c);
}

// Whole days from `today` until `dateStr` (both "YYYY-MM-DD"). Negative = already past.
// Anchored at noon so a DST shift can't turn a boundary into an off-by-one.
function daysUntil(dateStr, today) {
  if (!dateStr || !today) return null;
  const a = new Date(today + "T12:00:00");
  const b = new Date(dateStr + "T12:00:00");
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Cheap, deterministic pre-parse for the "total/people" settlement shape this group actually
// uses ("po 25,00zł (200/8)...", "160/11"). Tried BEFORE the AI classifier in extractSettlement,
// so the common case survives an AI outage entirely (2026-08-07: a real settlement message went
// completely unrecognized because the classifier call failed on a zero-credit API key) and costs
// nothing on the happy path either. Returns null on no match, leaving the AI call as fallback for
// looser phrasing that doesn't spell out total/people directly.
function parseSettlementShorthand(text) {
  const m = (text || "").match(/(\d+(?:[.,]\d+)?)\s*\/\s*(\d+)\b/);
  if (!m) return null;
  const total = parseFloat(m[1].replace(",", "."));
  const people = parseInt(m[2], 10);
  if (!(total > 0) || !(people > 0)) return null;
  return { isSettlement: true, people: people, total: total, perPerson: Math.round((total / people) * 100) / 100 };
}

// Is an active-but-unsettled poll a MORE CURRENT source of "who played" than the latest archived
// history entry? True only when the poll's game already happened (gameDate <= today — a future
// poll is never a source) and post-dates whatever's in history. Exists because settlement can
// fail (AI outage, network) and leave a played game un-archived; without this check, MVP
// candidates silently fall back to a stale prior week instead of the game just played.
function pollBeatsHistory(pollGameDate, today, histDate) {
  if (!pollGameDate || !today || pollGameDate > today) return false;
  if (!histDate) return true;
  return pollGameDate > histDate;
}

// "Kort" is a TENNIS court — we rent a hala / sala / boisko. It leaked into reminders from our own
// prompt text. Detect rather than substitute: Polish case endings make a blind kort→sala swap
// ungrammatical ("zarezerwować kort" → "zarezerwować sala"), so callers regenerate instead.
// The `cie` branch is not redundant: the locative palatalises t→c ("na korcie"), so a plain
// "kort" stem misses it — which is exactly the form the model likes to use.
function hasBannedVenueWord(text) {
  return /\bkor(?:t\w*|cie)/i.test(text || "");
}

// LID user-parts that picked a given poll option. voters = { lid: { jid, options[] } }.
function votersChoosing(voters, label) {
  const out = [];
  for (const lid in (voters || {})) {
    const opts = (voters[lid] && voters[lid].options) || [];
    if (opts.indexOf(label) >= 0) out.push(lid);
  }
  return out;
}

// Dashboard rows = archived history + games still sitting as active polls (date passed, not yet
// settled). When BOTH describe the same game, HISTORY WINS: it carries the settled headcount,
// while the poll row only ever has the vote-based estimate.
// Without this, settleAndClose's ordering (archivePoll → syncStatsDb → removePoll → saveState)
// lets syncStatsDb re-read a state.json that still holds the poll, and the stale estimate
// upserts over the settled count on the same (date, gameDay) key — the dashboard then showed
// 5 voters instead of the 10 people who actually played (2026-07-31).
function mergeGameRows(history, pollRows) {
  const key = g => (g.date || "") + "|" + (g.gameDay || "");
  const archived = new Set((history || []).map(key));
  return (history || []).concat((pollRows || []).filter(p => !archived.has(key(p))));
}

// Exponential backoff between WhatsApp reconnects: 1s, 2s, 4s … capped (default 5 min).
// WhatsApp answers a rejected client version with 405 on EVERY attempt, so the old
// retry-immediately loop hammered the server every ~3s — a fast track to a number-level block.
function reconnectDelay(attempt, capMs) {
  const cap = capMs || 300000;
  const n = Math.min(Math.max(0, Math.floor(attempt) || 0), 30);
  return Math.min(1000 * Math.pow(2, n), cap);
}

// Health snapshot for the EXTERNAL monitor (GET /health) — the in-band WhatsApp notify is
// useless for this, since the thing that breaks is WhatsApp itself.
// "degraded" (HTTP 503) once the socket has been down past thresholdSec, or whenever a human
// is needed (re-pairing) — a restart can't fix that one, so the monitor must not retry it.
// The failure this exists to catch: on 2026-07-29 the socket died, systemd still reported
// `active`, internal crons kept ticking, and the outage went unnoticed for three days.
function healthReport(now, s, thresholdSec) {
  const limit = thresholdSec || 900;
  const connected = !!s.connected;
  // Never-connected-since-boot must read as down too, else a bot stuck in a connect loop
  // (no close event yet recorded) would report perfectly healthy.
  const downSince = connected ? null : (s.connDownAt || s.bootAt || now);
  const downForSec = downSince ? Math.max(0, Math.round((now - downSince) / 1000)) : 0;
  const needsRepair = !!s.needsRepair;
  const degraded = needsRepair || downForSec > limit;
  return {
    code: degraded ? 503 : 200,
    body: {
      status: degraded ? "degraded" : "ok",
      connected,
      downForSec,
      uptimeSec: Math.max(0, Math.round((now - (s.bootAt || now)) / 1000)),
      lastOpenAt: s.lastOpenAt || null,
      lastCloseAt: s.lastCloseAt || null,
      lastCloseCode: s.lastCloseCode == null ? null : s.lastCloseCode,
      lastMessageAt: s.lastMessageAt || null,
      needsRepair,
      openPolls: s.openPolls || 0,
      version: s.version || null,
    },
  };
}

module.exports = { DAY_WORDS, attendanceFromTally, weightOfOptions, parseAnkieta, nextDateForDay, isAdmin, settlementPeople, matchPoll, parseAbsenceDays, activeInjuryLids, reconnectDelay, healthReport, mergeGameRows, hasBannedVenueWord, votersChoosing, attendanceCounts, pickTopByAttendance, daysUntil,
parseSettlementShorthand, pollBeatsHistory };
