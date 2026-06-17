const test = require("node:test");
const assert = require("node:assert");
const { attendanceFromTally, weightOfOptions, parseAnkieta, nextDateForDay, isAdmin } = require("../lib");

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
