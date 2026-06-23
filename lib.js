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

module.exports = { DAY_WORDS, attendanceFromTally, weightOfOptions, parseAnkieta, nextDateForDay, isAdmin, settlementPeople, matchPoll };
