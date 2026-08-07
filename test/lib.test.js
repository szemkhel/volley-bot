const test = require("node:test");
const assert = require("node:assert");
const { attendanceFromTally, weightOfOptions, parseAnkieta, nextDateForDay, isAdmin, settlementPeople, matchPoll, parseAbsenceDays, activeInjuryLids, reconnectDelay, healthReport, mergeGameRows, hasBannedVenueWord, votersChoosing, attendanceCounts, pickTopByAttendance, daysUntil,
  parseSettlementShorthand, pollBeatsHistory, looksLikeFullSurname, suggestedInitialName, newAttendeesFromMentions } = require("../lib");

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
  assert.deepStrictEqual(parseAnkieta("piątek 20:00"), { day: "friday", time: "20:00" });
  assert.deepStrictEqual(parseAnkieta("czwartek 21"), { day: "thursday", time: "21:00" });
  assert.deepStrictEqual(parseAnkieta("środa 19.30"), { day: "wednesday", time: "19:30" });
});

test("parseAnkieta: day without time", () => {
  assert.deepStrictEqual(parseAnkieta("sobota"), { day: "saturday", time: null });
});

test("parseAnkieta: no day", () => {
  assert.deepStrictEqual(parseAnkieta("zmień godzinę"), { day: null, time: null });
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
