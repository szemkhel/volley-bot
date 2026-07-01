const cron = require("node-cron");
const fs = require("fs");
const { sendReminder, DAY_NAMES_PL_ACC } = require("./reminder");
const { notify } = require("./notify");

let activeCrons = [];

// First reminder = 3 days before game day; urgent = 2 days before (cron weekday: 0=Sun..6=Sat)
const DAY_SCHEDULES = {
  friday:    { first: "0 18 * * 2", urgent: "0 17 * * 3", labels: ["wt 18:00", "śr 17:00"] },
  thursday:  { first: "0 18 * * 1", urgent: "0 17 * * 2", labels: ["pn 18:00", "wt 17:00"] },
  wednesday: { first: "0 18 * * 0", urgent: "0 17 * * 1", labels: ["nd 18:00", "pn 17:00"] },
  saturday:  { first: "0 18 * * 3", urgent: "0 17 * * 4", labels: ["śr 18:00", "czw 17:00"] },
  sunday:    { first: "0 18 * * 4", urgent: "0 17 * * 5", labels: ["czw 18:00", "pt 17:00"] },
  monday:    { first: "0 18 * * 5", urgent: "0 17 * * 6", labels: ["pt 18:00", "sb 17:00"] },
  tuesday:   { first: "0 18 * * 6", urgent: "0 17 * * 0", labels: ["sb 18:00", "nd 17:00"] },
};

// `getSock` returns the CURRENT socket — never capture it, the WA socket is recreated on every reconnect.
async function fireReminder(getSock, getPollForDay, day, isUrgent) {
  const cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));
  const label = isUrgent ? "Pilne przypomnienie" : "Pierwsze przypomnienie";
  const dayPl = DAY_NAMES_PL_ACC[day] || day;

  // The socket reconnects frequently; a fire can land during a brief outage. Retry on transient
  // connection errors (reading the live socket each attempt) so the reminder isn't silently lost.
  const maxAttempts = 15;
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const poll = getPollForDay(day);
    if (!poll) return; // game for that day no longer tracked (e.g. cancelled meanwhile)
    result = await sendReminder(getSock(), poll, cfg, isUrgent);
    if (!result || !result.error) break; // sent, everyone voted, or non-retryable skip
    const transient = /connection|closed|timed?\s*out|timeout|lost|not open|socket/i.test(result.error);
    if (!transient || attempt === maxAttempts) break;
    console.log(`[Scheduler] ${label} (${dayPl}) send failed: ${result.error} — retry ${attempt}/${maxAttempts} in 60s`);
    await new Promise(r => setTimeout(r, 60000));
  }

  const sock = getSock();
  if (result && result.count) {
    await notify(sock, cfg, `${label} (${dayPl}) wysłane do ${result.count} osób bez głosu.`);
  } else if (result && result.everyoneVoted) {
    await notify(sock, cfg, `${label} (${dayPl}): wszyscy już zagłosowali.`);
  } else if (result && result.error) {
    await notify(sock, cfg, `⚠️ Błąd przy wysyłaniu (${dayPl}): ${result.error}`);
  }
}

// Schedules reminders for EVERY tracked game (one cron pair per distinct game day).
// `state.polls` is the source of truth; getPollForDay re-reads at fire time so a cancelled game is skipped.
function scheduleReminders(getSock, state, saveState, config) {
  activeCrons.forEach(c => c.destroy());
  activeCrons = [];

  const tz = config.timezone || "Europe/Warsaw";
  const polls = (state.polls || []);
  const days = Array.from(new Set(polls.map(p => p.gameDay)));
  const getPollForDay = (day) => (state.polls || []).find(p => p.gameDay === day) || null;

  const scheduledLabels = [];
  for (const day of days) {
    const schedule = DAY_SCHEDULES[day];
    if (!schedule) continue;
    const j1 = cron.schedule(schedule.first, async () => {
      console.log("[Scheduler] First reminder fired for", day);
      await fireReminder(getSock, getPollForDay, day, false);
    }, { timezone: tz });
    const j2 = cron.schedule(schedule.urgent, async () => {
      console.log("[Scheduler] Urgent reminder fired for", day);
      await fireReminder(getSock, getPollForDay, day, true);
    }, { timezone: tz });
    activeCrons.push(j1, j2);
    scheduledLabels.push((DAY_NAMES_PL_ACC[day] || day) + " (" + schedule.labels[0] + " + " + schedule.labels[1] + ")");
  }

  if (scheduledLabels.length) console.log("Reminders scheduled (" + tz + "):", scheduledLabels.join("; "));
  else console.log("No games tracked — no reminders scheduled.");
}

module.exports = { scheduleReminders, DAY_SCHEDULES };
