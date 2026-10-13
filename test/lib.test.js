const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { attendanceFromTally, weightOfOptions, confirmedPlayers, squadIsFull, reminderSkipAt, parseAnkieta, formatPln, pollName, settlementCost, parseRozliczArgs, pickSettlementPoll, pollHasStarted, nextDateForDay, isAdmin, settlementPeople, matchPoll, parseAbsenceDays, activeInjuryLids, reconnectDelay, healthReport, mergeGameRows, hasBannedVenueWord, votersChoosing, attendanceCounts, pickTopByAttendance, daysUntil,
  parseSettlementShorthand, pollBeatsHistory, looksLikeFullSurname, suggestedInitialName, newAttendeesFromMentions, extraMvpCandidates,
  nextAvatarMeta, topTiedEntries, mvpWinCount, looksLikeOwnerCommand, looksLikeGameResponse,
  authStateSnapshot, authStateDiffEvents, reminderSlots, cronForSlot, votingDeadline, lastCallDays,
  rollCallSlot, rollCallMessage } = require("../lib");

test("newAttendeesFromMentions: only genuinely new people, deduped", () => {
  const poll = { voters: {
    "111": { jid: "111@lid", options: ["Gram"] },
    "222": { jid: "222@lid", options: ["Nie gram"] },
  } };
  const out = newAttendeesFromMentions(["333@lid", "111@lid", "333@lid"], poll);
  assert.deepStrictEqual(out.map(o => o.phone), ["333"]);   // 111 already voted Gram, 333 repeated
});

test("newAttendeesFromMentions: a 'Nie gram' voter still counts as new if tagged", () => {
  const poll = { voters: { "222": { jid: "222@lid", options: ["Nie gram"] } } };
  assert.deepStrictEqual(newAttendeesFromMentions(["222@lid"], poll).map(o => o.phone), ["222"]);
});

test("newAttendeesFromMentions: empty/missing inputs", () => {
  assert.deepStrictEqual(newAttendeesFromMentions([], { voters: {} }), []);
  assert.deepStrictEqual(newAttendeesFromMentions(null, null), []);
});

test("extraMvpCandidates: adds tagged non-candidates, resolves names, dedups", () => {
  const existing = [{ phone: "111", name: "Anna" }, { phone: "222", name: "Bartek" }];
  const contacts = { "333": "Zuzia" };
  const out = extraMvpCandidates(["333@lid", "111@lid", "333@lid", "70444@lid"], existing, contacts);
  // 111 is already a candidate, 333 repeated → one 333; 70444 unknown → "Gracz 0444" (last 4)
  assert.deepStrictEqual(out, [
    { phone: "333", name: "Zuzia" },
    { phone: "70444", name: "Gracz 0444" },
  ]);
});

test("extraMvpCandidates: empty/missing inputs", () => {
  assert.deepStrictEqual(extraMvpCandidates([], [], {}), []);
  assert.deepStrictEqual(extraMvpCandidates(null, null, null), []);
});

test("looksLikeFullSurname: bare or short initials pass, full surnames flagged", () => {
  assert.strictEqual(looksLikeFullSurname("Franek S"), false);
  assert.strictEqual(looksLikeFullSurname("Krzysztof S."), false);
  assert.strictEqual(looksLikeFullSurname("Paweł Ku"), false);      // two letters is OK
  assert.strictEqual(looksLikeFullSurname("Krzysztof"), false);      // first name only
  assert.strictEqual(looksLikeFullSurname("Krzysztof Suski"), true);
  assert.strictEqual(looksLikeFullSurname("Zuzanna Rydzewska"), true);
  assert.strictEqual(looksLikeFullSurname(""), false);
  assert.strictEqual(looksLikeFullSurname(null), false);
});

test("suggestedInitialName: first name + initial of the next word", () => {
  assert.strictEqual(suggestedInitialName("Krzysztof Suski"), "Krzysztof S.");
  assert.strictEqual(suggestedInitialName("Zuzanna Rydzewska"), "Zuzanna R.");
  assert.strictEqual(suggestedInitialName("Krzysztof"), "Krzysztof");   // nothing to shorten
});

test("parseSettlementShorthand: extracts total/people, computes perPerson", () => {
  assert.deepStrictEqual(parseSettlementShorthand("po 25,00zł (200/8)"), { isSettlement: true, people: 8, total: 200, perPerson: 25 });
  assert.deepStrictEqual(parseSettlementShorthand("160/11 na BLIK"), { isSettlement: true, people: 11, total: 160, perPerson: 14.55 });
});

test("parseSettlementShorthand: no match → null", () => {
  assert.strictEqual(parseSettlementShorthand("dzięki za grę, do zobaczenia!"), null);
  assert.strictEqual(parseSettlementShorthand(""), null);
  assert.strictEqual(parseSettlementShorthand(null), null);
  assert.strictEqual(parseSettlementShorthand("0/8"), null);   // zero total is not a real split
});

test("pollBeatsHistory: a played, unsettled poll outranks stale history", () => {
  assert.strictEqual(pollBeatsHistory("2026-08-07", "2026-08-07", "2026-07-31"), true);
  assert.strictEqual(pollBeatsHistory("2026-08-07", "2026-08-07", null), true);
});

test("pollBeatsHistory: a future (not-yet-played) poll never qualifies", () => {
  assert.strictEqual(pollBeatsHistory("2026-08-14", "2026-08-07", "2026-07-31"), false);
});

test("pollBeatsHistory: history already covers this game or is newer", () => {
  assert.strictEqual(pollBeatsHistory("2026-07-31", "2026-08-07", "2026-07-31"), false);
  assert.strictEqual(pollBeatsHistory("2026-07-24", "2026-08-07", "2026-07-31"), false);
});

test("attendanceCounts: counts played games only", () => {
  const hist = [
    { status: "played", attendees: [{ phone: "111" }, { phone: "222" }] },
    { status: "played", attendees: [{ phone: "111" }] },
    { status: "cancelled", attendees: [{ phone: "333" }] },
    { status: "played" },
  ];
  assert.deepStrictEqual(attendanceCounts(hist), { "111": 2, "222": 1 });
  assert.deepStrictEqual(attendanceCounts(null), {});
});

test("pickTopByAttendance: keeps the most regular players", () => {
  const cands = [{ phone: "a" }, { phone: "b" }, { phone: "c" }, { phone: "d" }];
  const counts = { a: 1, b: 9, c: 5, d: 0 };
  assert.deepStrictEqual(pickTopByAttendance(cands, counts, 2).map(c => c.phone), ["b", "c"]);
});

test("pickTopByAttendance: under the limit returns everyone, order untouched", () => {
  const cands = [{ phone: "a" }, { phone: "b" }];
  assert.deepStrictEqual(pickTopByAttendance(cands, { a: 0, b: 7 }, 12).map(c => c.phone), ["a", "b"]);
  assert.deepStrictEqual(pickTopByAttendance(cands, {}, 0).map(c => c.phone), ["a", "b"]);
});

test("pickTopByAttendance: ties keep original order (deterministic)", () => {
  const cands = [{ phone: "x" }, { phone: "y" }, { phone: "z" }];
  assert.deepStrictEqual(pickTopByAttendance(cands, { x: 3, y: 3, z: 3 }, 2).map(c => c.phone), ["x", "y"]);
  assert.deepStrictEqual(pickTopByAttendance(cands, {}, 2).map(c => c.phone), ["x", "y"]);
});

test("daysUntil: whole days, sign, and bad input", () => {
  assert.strictEqual(daysUntil("2026-08-07", "2026-08-05"), 2);
  assert.strictEqual(daysUntil("2026-08-05", "2026-08-05"), 0);
  assert.strictEqual(daysUntil("2026-08-03", "2026-08-05"), -2);
  assert.strictEqual(daysUntil("2026-11-01", "2026-10-25"), 7);   // spans the DST change
  assert.strictEqual(daysUntil(null, "2026-08-05"), null);
  assert.strictEqual(daysUntil("nonsense", "2026-08-05"), null);
});

test("hasBannedVenueWord: catches kort and its declensions", () => {
  assert.strictEqual(hasBannedVenueWord("musimy zarezerwować kort"), true);
  assert.strictEqual(hasBannedVenueWord("rezerwacja kortu na piątek"), true);
  assert.strictEqual(hasBannedVenueWord("gramy na korcie"), true);
  assert.strictEqual(hasBannedVenueWord("KORTY są wolne"), true);
});

test("hasBannedVenueWord: leaves correct venue words and lookalikes alone", () => {
  assert.strictEqual(hasBannedVenueWord("musimy zarezerwować salę"), false);
  assert.strictEqual(hasBannedVenueWord("gramy w hali na boisku"), false);
  assert.strictEqual(hasBannedVenueWord("komfortowa hala"), false);   // "kort" not at a word start
  assert.strictEqual(hasBannedVenueWord(""), false);
  assert.strictEqual(hasBannedVenueWord(null), false);
});

test("votersChoosing: picks only the given option", () => {
  const voters = {
    "111": { jid: "111@lid", options: ["Gram"] },
    "222": { jid: "222@lid", options: ["Nie wiem"] },
    "333": { jid: "333@lid", options: ["Nie gram"] },
    "444": { jid: "444@lid", options: ["Nie wiem"] },
    "555": { jid: "555@lid" },
  };
  assert.deepStrictEqual(votersChoosing(voters, "Nie wiem").sort(), ["222", "444"]);
  assert.deepStrictEqual(votersChoosing(voters, "Gram"), ["111"]);
  assert.deepStrictEqual(votersChoosing({}, "Nie wiem"), []);
  assert.deepStrictEqual(votersChoosing(null, "Nie wiem"), []);
});

test("mergeGameRows: settled history wins over the stale poll estimate", () => {
  const hist = [{ date: "2026-07-31", gameDay: "friday", players: 10 }];
  const polls = [{ date: "2026-07-31", gameDay: "friday", players: 5 }];
  const out = mergeGameRows(hist, polls);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].players, 10);
});

test("mergeGameRows: poll rows for games not yet archived are kept", () => {
  const hist = [{ date: "2026-07-24", gameDay: "friday", players: 12 }];
  const polls = [{ date: "2026-07-31", gameDay: "friday", players: 5 }];
  assert.deepStrictEqual(mergeGameRows(hist, polls).map(g => g.players), [12, 5]);
});

test("mergeGameRows: same date, different day is a different game", () => {
  const hist = [{ date: "2026-07-31", gameDay: "friday", players: 10 }];
  const polls = [{ date: "2026-07-31", gameDay: "tuesday", players: 6 }];
  assert.strictEqual(mergeGameRows(hist, polls).length, 2);
});

test("mergeGameRows: empty/missing inputs", () => {
  assert.deepStrictEqual(mergeGameRows(null, null), []);
  assert.deepStrictEqual(mergeGameRows([], [{ date: "2026-07-31", gameDay: "friday" }]).length, 1);
});

test("reconnectDelay: exponential, capped", () => {
  assert.strictEqual(reconnectDelay(0), 1000);
  assert.strictEqual(reconnectDelay(1), 2000);
  assert.strictEqual(reconnectDelay(4), 16000);
  assert.strictEqual(reconnectDelay(99), 300000);   // cap, no overflow to Infinity
  assert.strictEqual(reconnectDelay(-1), 1000);
});

test("healthReport: connected → 200 ok", () => {
  const now = 10_000_000;
  const r = healthReport(now, { connected: true, bootAt: now - 60_000, lastOpenAt: "2026-08-01T00:00:00.000Z" });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.status, "ok");
  assert.strictEqual(r.body.downForSec, 0);
  assert.strictEqual(r.body.uptimeSec, 60);
});

test("healthReport: short outage stays ok, long one degrades", () => {
  const now = 10_000_000;
  const base = { connected: false, bootAt: now - 3_600_000 };
  assert.strictEqual(healthReport(now, { ...base, connDownAt: now - 60_000 }).code, 200);
  assert.strictEqual(healthReport(now, { ...base, connDownAt: now - 1_800_000 }).code, 503);
  assert.strictEqual(healthReport(now, { ...base, connDownAt: now - 1_800_000 }).body.downForSec, 1800);
});

test("healthReport: never connected since boot counts as down", () => {
  const now = 10_000_000;
  const r = healthReport(now, { connected: false, bootAt: now - 1_800_000 });
  assert.strictEqual(r.code, 503);
  assert.strictEqual(r.body.downForSec, 1800);
});

test("healthReport: needsRepair degrades immediately, even while connected", () => {
  const now = 10_000_000;
  const r = healthReport(now, { connected: true, bootAt: now - 60_000, needsRepair: true });
  assert.strictEqual(r.code, 503);
  assert.strictEqual(r.body.needsRepair, true);
});

test("healthReport: custom threshold", () => {
  const now = 10_000_000;
  const s = { connected: false, bootAt: now - 3_600_000, connDownAt: now - 120_000 };
  assert.strictEqual(healthReport(now, s, 60).code, 503);
  assert.strictEqual(healthReport(now, s, 300).code, 200);
});

test("parseAbsenceDays: units", () => {
  assert.strictEqual(parseAbsenceDays("2 tygodnie"), 14);
  assert.strictEqual(parseAbsenceDays("tydzień"), 7);
  assert.strictEqual(parseAbsenceDays("miesiąc"), 30);
  assert.strictEqual(parseAbsenceDays("3 miesiące"), 90);
  assert.strictEqual(parseAbsenceDays("5 dni"), 5);
  assert.strictEqual(parseAbsenceDays("1 dzień"), 1);
});

test("parseAbsenceDays: unrecognized → null", () => {
  assert.strictEqual(parseAbsenceDays("kiedyś"), null);
  assert.strictEqual(parseAbsenceDays(""), null);
  assert.strictEqual(parseAbsenceDays("0 tygodni"), null);
});

test("activeInjuryLids: only end-date >= today", () => {
  const inj = { "111": "2026-07-10", "222": "2026-07-05", "333": "2026-08-01" };
  assert.deepStrictEqual(activeInjuryLids(inj, "2026-07-07").sort(), ["111", "333"]);
  assert.deepStrictEqual(activeInjuryLids({}, "2026-07-07"), []);
  assert.deepStrictEqual(activeInjuryLids(null, "2026-07-07"), []);
});

test("attendanceFromTally: Gram counts as 1 each", () => {
  assert.strictEqual(attendanceFromTally({ "Gram": 3 }), 3);
});

test("attendanceFromTally: +1 = 2, +2 = 3", () => {
  assert.strictEqual(attendanceFromTally({ "Gram i przyprowadzam +1": 1 }), 2);
  assert.strictEqual(attendanceFromTally({ "Gram i przyprowadzam +2": 1 }), 3);
});

test("attendanceFromTally: mixed", () => {
  assert.strictEqual(attendanceFromTally({
    "Gram": 1,
    "Gram i przyprowadzam +1": 1,
    "Gram i przyprowadzam +2": 1,
  }), 6);
});

test("attendanceFromTally: Nie gram / Nie wiem count as 0", () => {
  assert.strictEqual(attendanceFromTally({ "Nie gram": 2, "Nie wiem": 1 }), 0);
});

test("weightOfOptions: single options", () => {
  assert.strictEqual(weightOfOptions(["Gram"]), 1);
  assert.strictEqual(weightOfOptions(["Gram i przyprowadzam +1"]), 2);
  assert.strictEqual(weightOfOptions(["Gram i przyprowadzam +2"]), 3);
  assert.strictEqual(weightOfOptions(["Nie gram"]), 0);
  assert.strictEqual(weightOfOptions([]), 0);
});

test("parseAnkieta: day + time", () => {
  assert.deepStrictEqual(parseAnkieta("piątek 20:00"), { day: "friday", time: "20:00", cost: null });
  assert.deepStrictEqual(parseAnkieta("czwartek 21"), { day: "thursday", time: "21:00", cost: null });
  assert.deepStrictEqual(parseAnkieta("środa 19.30"), { day: "wednesday", time: "19:30", cost: null });
});

test("parseAnkieta: day without time", () => {
  assert.deepStrictEqual(parseAnkieta("sobota"), { day: "saturday", time: null, cost: null });
});

test("parseAnkieta: no day", () => {
  assert.deepStrictEqual(parseAnkieta("zmień godzinę"), { day: null, time: null, cost: null });
});

test("parseAnkieta: <dzień> <godzina> <cena>", () => {
  assert.deepStrictEqual(parseAnkieta("ankieta sobota 18:00 390"), { day: "saturday", time: "18:00", cost: 390 });
  assert.deepStrictEqual(parseAnkieta("ankieta sobota 18 390"), { day: "saturday", time: "18:00", cost: 390 });
  assert.deepStrictEqual(parseAnkieta("ankieta sobota 390"), { day: "saturday", time: null, cost: 390 });   // 390 is no hour
  assert.deepStrictEqual(parseAnkieta("ankieta sobota 20:30 90"), { day: "saturday", time: "20:30", cost: 90 });
});

test("parseAnkieta: price with currency, in any position", () => {
  assert.deepStrictEqual(parseAnkieta("sobota 18:00 koszt 390 zł"), { day: "saturday", time: "18:00", cost: 390 });
  assert.deepStrictEqual(parseAnkieta("sobota 18:00 390pln"), { day: "saturday", time: "18:00", cost: 390 });
  assert.deepStrictEqual(parseAnkieta("sobota 18:00 koszt 390,50 zł"), { day: "saturday", time: "18:00", cost: 390.5 });
  // A decimal price placed BEFORE the time must not be half-read as a "90.50" kick-off
  assert.deepStrictEqual(parseAnkieta("sobota 390.50 18:00"), { day: "saturday", time: "18:00", cost: 390.5 });
});

test("parseAnkieta: only real hours count as a time", () => {
  // The old `\d{1,2}` read these as 90:00 — now a number that can't be an hour is the price
  assert.deepStrictEqual(parseAnkieta("sobota 90"), { day: "saturday", time: null, cost: 90 });
  // An invalid "25:00" must not leak its "00" out as midnight, nor its "25" as a price
  assert.deepStrictEqual(parseAnkieta("sobota 25:00 390"), { day: "saturday", time: null, cost: 390 });
  assert.deepStrictEqual(parseAnkieta("sobota 18:00 0"), { day: "saturday", time: "18:00", cost: null });
});

test("parseAnkieta: other callers (zmień / nie gramy / poll title) never pick up a price", () => {
  assert.deepStrictEqual(parseAnkieta("zmień dzień na czwartek"), { day: "thursday", time: null, cost: null });
  assert.deepStrictEqual(parseAnkieta("nie gramy wtorek 20:00"), { day: "tuesday", time: "20:00", cost: null });
  assert.deepStrictEqual(parseAnkieta("Siatkówka piątek 20:00 🏐 — gracie?"), { day: "friday", time: "20:00", cost: null });
});

test("formatPln: whole złoty clean, fractions with a Polish comma", () => {
  assert.strictEqual(formatPln(390), "390");
  assert.strictEqual(formatPln(390.5), "390,50");
  assert.strictEqual(formatPln("abc"), "");
});

test("pollName: price shown only when given; plain title unchanged", () => {
  assert.strictEqual(pollName("sobotę", "18:00", 390), "Siatkówka sobotę 18:00, koszt 390 zł 🏐 — gracie?");
  assert.strictEqual(pollName("piątek", "20:00", null), "Siatkówka piątek 20:00 🏐 — gracie?");
  assert.strictEqual(pollName("piątek", null, 0), "Siatkówka piątek 🏐 — gracie?");
});

test("settlementCost: the poll's own price wins, then bot koszt sali, then 160", () => {
  assert.strictEqual(settlementCost({ hallCost: 390 }, { hallCost: 160 }), 390);
  assert.strictEqual(settlementCost({ hallCost: null }, { hallCost: 180 }), 180);
  assert.strictEqual(settlementCost(null, {}), 160);
});

test("parseRozliczArgs: two numbers = cost + people, with or without a poll price", () => {
  assert.deepStrictEqual(parseRozliczArgs("rozlicz 400 13", 390), { cost: 400, people: 13 });
  assert.deepStrictEqual(parseRozliczArgs("rozlicz 160 11", null), { cost: 160, people: 11 });
});

test("parseRozliczArgs: poll price lets you skip the cost", () => {
  assert.deepStrictEqual(parseRozliczArgs("rozlicz", 390), { cost: 390, people: null });   // dialog asks headcount only
  assert.deepStrictEqual(parseRozliczArgs("rozlicz 13", 390), { cost: 390, people: 13 });
  assert.deepStrictEqual(parseRozliczArgs("rozlicz 400", 390), { cost: 400, people: null }); // too big for people → price override
  assert.deepStrictEqual(parseRozliczArgs("rozlicz 1", 390), { cost: 390, people: null });   // nonsense headcount ignored
});

test("parseRozliczArgs: without a poll price a lone number is ignored, as before", () => {
  assert.deepStrictEqual(parseRozliczArgs("rozlicz 13", null), { cost: null, people: null });
  assert.deepStrictEqual(parseRozliczArgs("rozlicz", undefined), { cost: null, people: null });
});

test("nextDateForDay: same-week future day", () => {
  // 2026-06-15 is a Monday
  assert.strictEqual(nextDateForDay("friday", new Date("2026-06-15T10:00:00Z")), "2026-06-19");
});

test("nextDateForDay: today counts as the day", () => {
  // 2026-06-19 is a Friday
  assert.strictEqual(nextDateForDay("friday", new Date("2026-06-19T10:00:00Z")), "2026-06-19");
});

test("nextDateForDay: wraps to next week", () => {
  // From Friday 2026-06-19, next Tuesday is 2026-06-23
  assert.strictEqual(nextDateForDay("tuesday", new Date("2026-06-19T10:00:00Z")), "2026-06-23");
});

test("nextDateForDay: invalid day -> null", () => {
  assert.strictEqual(nextDateForDay("nonsense", new Date("2026-06-15T10:00:00Z")), null);
});

test("isAdmin: owner (fromMe) always allowed", () => {
  assert.strictEqual(isAdmin("", true, [], ""), true);
  assert.strictEqual(isAdmin("999", true, [], "111"), true);
});

test("isAdmin: owner LID allowed", () => {
  assert.strictEqual(isAdmin("272211084579057", false, [], "272211084579057"), true);
});

test("isAdmin: listed admin allowed", () => {
  assert.strictEqual(isAdmin("555", false, ["555", "777"], "111"), true);
});

test("isAdmin: non-admin denied", () => {
  assert.strictEqual(isAdmin("888", false, ["555"], "111"), false);
  assert.strictEqual(isAdmin("", false, ["555"], "111"), false);
});

test("settlementPeople: explicit people wins", () => {
  assert.strictEqual(settlementPeople({ people: 11, total: 160, perPerson: 14.55 }, 160), 11);
});

test("settlementPeople: from total/perPerson", () => {
  assert.strictEqual(settlementPeople({ people: null, total: 160, perPerson: 14.55 }, 999), 11);
});

test("settlementPeople: back-calc from hallCost/perPerson", () => {
  assert.strictEqual(settlementPeople({ people: null, total: null, perPerson: 14.55 }, 160), 11);
  assert.strictEqual(settlementPeople({ people: null, perPerson: 20 }, 160), 8);
});

test("settlementPeople: nothing usable → null", () => {
  assert.strictEqual(settlementPeople({ people: null, total: null, perPerson: null }, 160), null);
  assert.strictEqual(settlementPeople(null, 160), null);
});

test("matchPoll: by day", () => {
  const polls = [{ gameDay: "friday", gameTime: "20:00" }, { gameDay: "tuesday", gameTime: "18:00" }];
  assert.strictEqual(matchPoll(polls, "tuesday").gameTime, "18:00");
  assert.strictEqual(matchPoll(polls, "friday").gameTime, "20:00");
});

test("matchPoll: by day + time", () => {
  const polls = [{ gameDay: "friday", gameTime: "20:00" }, { gameDay: "friday", gameTime: "21:00" }];
  assert.strictEqual(matchPoll(polls, "friday", "21:00").gameTime, "21:00");
  assert.strictEqual(matchPoll(polls, "friday", "22:00"), null);
});

test("matchPoll: no match → null", () => {
  assert.strictEqual(matchPoll([{ gameDay: "friday" }], "monday"), null);
  assert.strictEqual(matchPoll([], "friday"), null);
});

test("nextAvatarMeta: single face pins goodFaceFile", () => {
  const out = nextAvatarMeta(null, { file: "111.jpg", fetchedAt: "2026-08-01T00:00:00Z", faceCount: 1, guessedGender: "male" });
  assert.strictEqual(out.goodFaceFile, "111.jpg");
  assert.strictEqual(out.goodFaceUpdatedAt, "2026-08-01T00:00:00Z");
  assert.strictEqual(out.guessedGender, "male");
});

test("nextAvatarMeta: no face keeps previously pinned good face", () => {
  const prev = { goodFaceFile: "111.jpg", goodFaceUpdatedAt: "2026-07-01T00:00:00Z", guessedGender: "male" };
  const out = nextAvatarMeta(prev, { file: "111.jpg", fetchedAt: "2026-08-01T00:00:00Z", faceCount: 0, guessedGender: null });
  assert.strictEqual(out.goodFaceFile, "111.jpg");
  assert.strictEqual(out.goodFaceUpdatedAt, "2026-07-01T00:00:00Z");
  assert.strictEqual(out.faceCount, 0);
});

test("nextAvatarMeta: multiple faces (group photo) also keeps pinned good face", () => {
  const prev = { goodFaceFile: "111.jpg", goodFaceUpdatedAt: "2026-07-01T00:00:00Z" };
  const out = nextAvatarMeta(prev, { file: "111-new.jpg", fetchedAt: "2026-08-01T00:00:00Z", faceCount: 2, guessedGender: null });
  assert.strictEqual(out.goodFaceFile, "111.jpg");
  assert.strictEqual(out.faceCount, 2);
});

test("nextAvatarMeta: fetch failure (faceCount null) doesn't clear pinned good face", () => {
  const prev = { goodFaceFile: "111.jpg", goodFaceUpdatedAt: "2026-07-01T00:00:00Z" };
  const out = nextAvatarMeta(prev, { file: null, fetchedAt: "2026-08-01T00:00:00Z", faceCount: null, guessedGender: null });
  assert.strictEqual(out.goodFaceFile, "111.jpg");
  assert.strictEqual(out.latestFile, null);
});

test("nextAvatarMeta: a low-confidence gender guess (group photo) is never pinned", () => {
  const out = nextAvatarMeta(null, { file: "111.jpg", fetchedAt: "2026-08-01T00:00:00Z", faceCount: 2, guessedGender: "female" });
  assert.strictEqual(out.guessedGender, null);
});

test("nextAvatarMeta: a later confident guess corrects a previously pinned one", () => {
  const prev = { guessedGender: "male" };
  const out = nextAvatarMeta(prev, { file: "111.jpg", fetchedAt: "2026-08-01T00:00:00Z", faceCount: 1, guessedGender: "female" });
  assert.strictEqual(out.guessedGender, "female");
});

test("topTiedEntries: single winner", () => {
  const out = topTiedEntries({ "Ala": 3, "Bob": 1 });
  assert.deepStrictEqual(out, [{ o: "Ala", c: 3 }]);
});

test("topTiedEntries: genuine tie returns all top scorers", () => {
  const out = topTiedEntries({ "Ala": 2, "Bob": 2, "Cel": 1 });
  assert.deepStrictEqual(out.map(e => e.o).sort(), ["Ala", "Bob"]);
});

test("topTiedEntries: empty tally → []", () => {
  assert.deepStrictEqual(topTiedEntries({}), []);
  assert.deepStrictEqual(topTiedEntries(null), []);
});

test("mvpWinCount: counts matching phone entries", () => {
  const mvp = [{ phone: "111@lid" }, { phone: "222@lid" }, { phone: "111@lid" }];
  assert.strictEqual(mvpWinCount(mvp, "111@lid"), 2);
  assert.strictEqual(mvpWinCount(mvp, "333@lid"), 0);
});

test("mvpWinCount: null phone → 0", () => {
  assert.strictEqual(mvpWinCount([{ phone: "111@lid" }], null), 0);
});

test("looksLikeOwnerCommand: unrelated personal note → false", () => {
  assert.strictEqual(looksLikeOwnerCommand("kupić mleko po pracy"), false);
  assert.strictEqual(looksLikeOwnerCommand("pamiętaj o wizycie u lekarza"), false);
});

test("looksLikeOwnerCommand: recognizes command-ish phrasing", () => {
  assert.strictEqual(looksLikeOwnerCommand("jaki jest status?"), true);
  assert.strictEqual(looksLikeOwnerCommand("ustaw dzień na czwartek"), true);
  assert.strictEqual(looksLikeOwnerCommand("pomoc"), true);
  assert.strictEqual(looksLikeOwnerCommand("wyślij przypomnienie"), true);
});

test("looksLikeOwnerCommand: bare day name counts", () => {
  assert.strictEqual(looksLikeOwnerCommand("piątek 20:00"), true);
});

test("looksLikeGameResponse: unrelated banter → false", () => {
  assert.strictEqual(looksLikeGameResponse("co tam u ciebie"), false);
  assert.strictEqual(looksLikeGameResponse("haha dobre"), false);
});

test("looksLikeGameResponse: yes/no/day signals → true", () => {
  assert.strictEqual(looksLikeGameResponse("tak"), true);
  assert.strictEqual(looksLikeGameResponse("nie dzisiaj"), true);
  assert.strictEqual(looksLikeGameResponse("to lecimy w piątek"), true);
  assert.strictEqual(looksLikeGameResponse("gramy!"), true);
});

// ---- auth_info/ hardening (kanban t_75f2e967) ----

test("authStateDiffEvents: identical snapshots → no events", () => {
  const snap = { dir: "auth_info", mtime: 1000, size: 4096, files: [
    { name: "creds.json", mtime: 1000, size: 100 },
    { name: "keys.json", mtime: 2000, size: 200 },
  ]};
  assert.deepStrictEqual(authStateDiffEvents(snap, snap), []);
});

test("authStateDiffEvents: new file is flagged", () => {
  const prev = { dir: "d", mtime: 1, size: 1, files: [{ name: "creds.json", mtime: 1, size: 100 }] };
  const curr = { dir: "d", mtime: 1, size: 1, files: [
    { name: "creds.json", mtime: 1, size: 100 },
    { name: "NEW_KEY.json", mtime: 2, size: 50 },
  ]};
  const events = authStateDiffEvents(prev, curr);
  assert.ok(events.some(e => e.includes("new file") && e.includes("NEW_KEY.json")));
});

test("authStateDiffEvents: missing file is flagged", () => {
  const prev = { dir: "d", mtime: 1, size: 1, files: [{ name: "creds.json", mtime: 1, size: 100 }] };
  const curr = { dir: "d", mtime: 1, size: 1, files: [] };
  const events = authStateDiffEvents(prev, curr);
  assert.ok(events.some(e => e.includes("missing file") && e.includes("creds.json")));
});

test("authStateDiffEvents: size change is flagged", () => {
  const prev = { dir: "d", mtime: 1, size: 1, files: [{ name: "creds.json", mtime: 1, size: 100 }] };
  const curr = { dir: "d", mtime: 1, size: 1, files: [{ name: "creds.json", mtime: 1, size: 150 }] };
  const events = authStateDiffEvents(prev, curr);
  assert.ok(events.some(e => e.includes("size changed") && e.includes("creds.json")));
});

test("authStateDiffEvents: mtime change >1s is flagged, <1s ignored", () => {
  const prev = { dir: "d", mtime: 1, size: 1, files: [{ name: "creds.json", mtime: 1000, size: 100 }] };
  const far = { dir: "d", mtime: 1, size: 1, files: [{ name: "creds.json", mtime: 5000, size: 100 }] };
  const near = { dir: "d", mtime: 1, size: 1, files: [{ name: "creds.json", mtime: 1500, size: 100 }] };
  assert.ok(authStateDiffEvents(prev, far).some(e => e.includes("mtime changed")));
  assert.deepStrictEqual(authStateDiffEvents(prev, near), []);
});

test("authStateDiffEvents: null prev (first run) → no events (baseline)", () => {
  assert.deepStrictEqual(authStateDiffEvents(null, { dir: "d", mtime: 1, size: 1, files: [] }), []);
});

test("authStateSnapshot: reads real dir and sorts files by name", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "auth-"));
  fs.writeFileSync(path.join(d, "z.json"), "zzz");
  fs.writeFileSync(path.join(d, "a.json"), "aa");
  fs.mkdirSync(path.join(d, "subdir")); // non-file entry — must be skipped
  const snap = authStateSnapshot(d);
  assert.strictEqual(snap.dir, d);
  assert.strictEqual(snap.files.length, 2);
  assert.strictEqual(snap.files[0].name, "a.json");
  assert.strictEqual(snap.files[1].name, "z.json");
  fs.rmSync(d, { recursive: true, force: true });
});

test("confirmedPlayers: counts Gram as 1 and guests as 1+N, ignores no/undecided", () => {
  const poll = { voters: {
    "111": { options: ["Gram"] },
    "222": { options: ["Gram i przyprowadzam +2"] },
    "333": { options: ["Nie gram"] },
    "444": { options: ["Nie wiem"] },
  } };
  assert.strictEqual(confirmedPlayers(poll), 4);   // 1 + 3
  assert.strictEqual(confirmedPlayers({ voters: {} }), 0);
  assert.strictEqual(confirmedPlayers(null), 0);
});

test("squadIsFull: true only once the threshold is reached", () => {
  const withGram = n => ({ voters: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [String(i), { options: ["Gram"] }])) });
  assert.strictEqual(squadIsFull(withGram(11), 12), false);
  assert.strictEqual(squadIsFull(withGram(12), 12), true);   // >= threshold, not >
  assert.strictEqual(squadIsFull(withGram(15), 12), true);
});

test("squadIsFull: guests count toward the threshold", () => {
  // 10 solo players + one bringing +2 = 13 heads, so the reminder is pointless at 12
  const voters = { "x": { options: ["Gram i przyprowadzam +2"] } };
  for (let i = 0; i < 10; i++) voters[String(i)] = { options: ["Gram"] };
  assert.strictEqual(squadIsFull({ voters }, 12), true);
});

test("squadIsFull: a missing or non-positive threshold never silences reminders", () => {
  const full = { voters: { a: { options: ["Gram"] }, b: { options: ["Gram"] } } };
  assert.strictEqual(squadIsFull(full, 0), false);
  assert.strictEqual(squadIsFull(full, -1), false);
  assert.strictEqual(squadIsFull(full, undefined), false);
  assert.strictEqual(squadIsFull(full, "nonsense"), false);
});

test("reminderSkipAt: reminderSkipAt wins, then optimumPlayers, then 12", () => {
  assert.strictEqual(reminderSkipAt({ reminderSkipAt: 10, optimumPlayers: 12 }), 10);
  assert.strictEqual(reminderSkipAt({ optimumPlayers: 14 }), 14);
  assert.strictEqual(reminderSkipAt({}), 12);
  assert.strictEqual(reminderSkipAt({ reminderSkipAt: 0 }), 0);   // explicit opt-out survives
});

// The week that motivated the fix: the weekly Friday game + an extra, pricier Saturday game.
const FRI = { gameDay: "friday", gameDate: "2026-09-18", gameTime: "20:00", timestamp: 1 };
const SAT = { gameDay: "saturday", gameDate: "2026-09-19", gameTime: "18:00", hallCost: 390, timestamp: 2 };
const at = (date, hhmm) => { const [h, m] = hhmm.split(":").map(Number); return { date, minutes: h * 60 + m }; };

test("pickSettlementPoll: Friday evening settles Friday, not the later Saturday game", () => {
  // Old rule (latest date) picked SAT here: wrong voters, 390 zł, and SAT archived a day early.
  assert.strictEqual(pickSettlementPoll([FRI, SAT], at("2026-09-18", "22:00")), FRI);
});

test("pickSettlementPoll: Saturday before its kick-off still settles Friday", () => {
  // Saturday's DATE is today, but it hasn't started — the date alone must not make it "played".
  assert.strictEqual(pickSettlementPoll([FRI, SAT], at("2026-09-19", "10:00")), FRI);
});

test("pickSettlementPoll: once both have been played, the most recent one", () => {
  assert.strictEqual(pickSettlementPoll([FRI, SAT], at("2026-09-19", "20:30")), SAT);
});

test("pickSettlementPoll: nothing played yet → the soonest upcoming game", () => {
  assert.strictEqual(pickSettlementPoll([SAT, FRI], at("2026-09-17", "12:00")), FRI);
});

test("pickSettlementPoll: today's game without a start time counts as played", () => {
  const satNoTime = Object.assign({}, SAT, { gameTime: null });
  assert.strictEqual(pickSettlementPoll([FRI, satNoTime], at("2026-09-19", "08:00")), satNoTime);
});

test("pickSettlementPoll: a single open game is returned whatever the clock says", () => {
  // The ordinary week must behave exactly as before. It still answers "which game" ahead of
  // kick-off — whether settling that early is allowed at all is pollHasStarted's call.
  assert.strictEqual(pickSettlementPoll([SAT], at("2026-09-15", "09:00")), SAT);
  assert.strictEqual(pickSettlementPoll([], at("2026-09-15", "09:00")), null);
});

test("pollHasStarted: past date yes, future date no", () => {
  assert.strictEqual(pollHasStarted(FRI, at("2026-09-19", "10:00")), true);
  assert.strictEqual(pollHasStarted(SAT, at("2026-09-18", "23:00")), false);
});

test("pollHasStarted: on the day, the start time decides", () => {
  assert.strictEqual(pollHasStarted(SAT, at("2026-09-19", "17:59")), false);
  assert.strictEqual(pollHasStarted(SAT, at("2026-09-19", "18:00")), true);  // kick-off counts
  assert.strictEqual(pollHasStarted(SAT, at("2026-09-19", "22:30")), true);
});

test("pollHasStarted: today with no start time counts as started", () => {
  assert.strictEqual(pollHasStarted({ gameDate: "2026-09-19" }, at("2026-09-19", "00:30")), true);
});

test("pollHasStarted: the 2026-10-12 incident — a game 3 days out is not settleable", () => {
  // Hall rates were being discussed on Monday ("80zl za godzinę"); 200 zł / 80 = 3 matched the 3
  // "Gram" votes and the bot archived Thursday's game, deleting the poll people were still voting in.
  const thu = { gameDay: "thursday", gameDate: "2026-10-15", gameTime: "20:00", timestamp: 1 };
  assert.strictEqual(pollHasStarted(thu, at("2026-10-12", "15:24")), false);
  assert.strictEqual(pollHasStarted(thu, at("2026-10-15", "22:10")), true);  // after the game: fine
});

test("pollHasStarted: missing poll, date or clock is never 'started'", () => {
  assert.strictEqual(pollHasStarted(null, at("2026-09-19", "10:00")), false);
  assert.strictEqual(pollHasStarted({ gameTime: "20:00" }, at("2026-09-19", "10:00")), false);
  assert.strictEqual(pollHasStarted(FRI, null), false);
  assert.strictEqual(pollHasStarted(FRI, {}), false);
});

test("pickSettlementPoll: cancelled games are never picked", () => {
  const friCancelled = Object.assign({}, FRI, { cancelled: true });
  assert.strictEqual(pickSettlementPoll([friCancelled, SAT], at("2026-09-18", "22:00")), SAT);
  assert.strictEqual(pickSettlementPoll([friCancelled], at("2026-09-18", "22:00")), null);
});

// --- Reminder slots / voting deadline / roll call (v1.38, the 2026-10-12 group decision) ---

test("reminderSlots: a Friday game nudges Mon PM, Tue AM, Tue PM — nothing on Wednesday", () => {
  const slots = reminderSlots("friday", {});
  assert.deepStrictEqual(slots.map(s => s.cron), ["0 18 * * 1", "0 10 * * 2", "0 18 * * 2"]);
  assert.deepStrictEqual(slots.map(s => s.label), ["pn 18:00", "wt 10:00", "wt 18:00"]);
  // Only the last one is the last call (chases the "Nie wiem" voters)
  assert.deepStrictEqual(slots.map(s => s.urgent), [false, false, true]);
  // Wednesday is weekday 3 — the morning the hall still gets cancelled free, never a reminder day
  assert.ok(slots.every(s => s.weekday !== 3));
});

test("reminderSlots: offsets wrap backwards across the week", () => {
  assert.deepStrictEqual(reminderSlots("monday", {}).map(s => s.label), ["czw 18:00", "pt 10:00", "pt 18:00"]);
  assert.deepStrictEqual(reminderSlots("sunday", {}).map(s => s.label), ["śr 18:00", "czw 10:00", "czw 18:00"]);
});

test("reminderSlots: config overrides the defaults and sorts chronologically", () => {
  const cfg = { reminderSlots: [{ daysBefore: 3, time: "19:30", urgent: true }, { daysBefore: 5, time: "09:00" }] };
  const slots = reminderSlots("friday", cfg);
  assert.deepStrictEqual(slots.map(s => s.label), ["nd 09:00", "wt 19:30"]);
  assert.deepStrictEqual(slots.map(s => s.cron), ["0 9 * * 0", "30 19 * * 2"]);
});

test("reminderSlots: a malformed slot is dropped, the rest still fire", () => {
  // A typo in config must never take the whole schedule down with it.
  const cfg = { reminderSlots: [{ daysBefore: 4, time: "25:00" }, { daysBefore: 9, time: "18:00" }, { daysBefore: 3, time: "bzdura" }, { daysBefore: 2, time: "08:30" }] };
  assert.deepStrictEqual(reminderSlots("friday", cfg).map(s => s.label), ["śr 08:30"]);
  assert.deepStrictEqual(reminderSlots("nieistniejący", {}), []);
});

test("cronForSlot: 0 days before = game day itself", () => {
  assert.strictEqual(cronForSlot("friday", 0, "09:05").cron, "5 9 * * 5");
  assert.strictEqual(cronForSlot("friday", 7, "09:00"), null);   // more than a week out
  assert.strictEqual(cronForSlot("friday", -1, "09:00"), null);
  assert.strictEqual(cronForSlot("friday", 2, "9:00").label, "śr 09:00");  // single-digit hour padded
});

test("votingDeadline: the day of the LAST reminder, in the genitive we print", () => {
  assert.deepStrictEqual(votingDeadline("friday", {}), { daysBefore: 3, weekday: 2, dayGen: "wtorku", short: "wt" });
  assert.strictEqual(votingDeadline("sunday", {}).dayGen, "czwartku");
  assert.strictEqual(votingDeadline("friday", { reminderSlots: [{ daysBefore: 1, time: "12:00" }] }).dayGen, "czwartku");
});

test("lastCallDays: follows the deadline, so a manual przypomnij matches the schedule", () => {
  assert.strictEqual(lastCallDays({}), 3);   // was a hardcoded 2 before the deadline moved
  assert.strictEqual(lastCallDays({ reminderSlots: [{ daysBefore: 1, time: "18:00", urgent: true }] }), 1);
});

test("rollCallSlot: Wednesday 08:00 for a Friday game, and switchable off", () => {
  assert.strictEqual(rollCallSlot("friday", {}).cron, "0 8 * * 3");
  assert.strictEqual(rollCallSlot("friday", {}).label, "śr 08:00");
  assert.strictEqual(rollCallSlot("friday", { rollCall: false }), null);
  assert.strictEqual(rollCallSlot("friday", { rollCall: { daysBefore: 2, time: "07:15" } }).cron, "15 7 * * 3");
});

test("rollCallMessage: enough players → we play, with the per-head cost", () => {
  const m = rollCallMessage({ dayPl: "piątek", time: "20:00", confirmed: 11, minPlayers: 6, cost: 160, names: ["Marek", "Kuba"] });
  assert.strictEqual(m.needsCancel, false);
  assert.match(m.text, /Gramy 🏐 — 11 zapisanych, ok\. 15 zł od osoby\./);
  assert.match(m.text, /Zapisani: Marek, Kuba\./);
});

test("rollCallMessage: below the minimum → cancel today, and tag whoever can do it", () => {
  const m = rollCallMessage({ dayPl: "piątek", time: "20:00", confirmed: 4, minPlayers: 6, cost: 160, names: ["Marek"], callout: "@7584962621670" });
  assert.strictEqual(m.needsCancel, true);
  assert.match(m.text, /Tylko 4 zapisanych \(minimum 6\)\./);
  assert.match(m.text, /@7584962621670 — decyzja o odwołaniu hali musi paść dziś rano/);
});

test("rollCallMessage: no cost, no names, no minimum configured", () => {
  const m = rollCallMessage({ dayPl: "sobotę", confirmed: 3 });
  assert.strictEqual(m.needsCancel, false);   // no minPlayers → never demands a cancellation
  assert.strictEqual(m.text, "⏰ Ankieta na sobotę zamknięta.\nGramy 🏐 — 3 zapisanych.");
});

test("pollName: the voting deadline rides in the poll title", () => {
  assert.strictEqual(pollName("piątek", "20:00", null, "wtorku"), "Siatkówka piątek 20:00 🏐 — gracie? (głosy do wtorku)");
  assert.strictEqual(pollName("sobotę", "18:00", 390, "środy"), "Siatkówka sobotę 18:00, koszt 390 zł 🏐 — gracie? (głosy do środy)");
  assert.strictEqual(pollName("piątek", "20:00", null), "Siatkówka piątek 20:00 🏐 — gracie?");  // unchanged without one
});
