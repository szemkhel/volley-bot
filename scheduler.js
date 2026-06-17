const cron = require("node-cron");
const fs = require("fs");
const { sendReminder, DAY_NAMES_PL_ACC } = require("./reminder");
const { notify } = require("./notify");

let activeCrons = [];

const DAY_SCHEDULES = {
  friday:    { first: "0 18 * * 2", urgent: "0 17 * * 3", labels: ["Tuesday 18:00", "Wednesday 17:00"] },
  thursday:  { first: "0 18 * * 1", urgent: "0 17 * * 2", labels: ["Monday 18:00", "Tuesday 17:00"] },
  wednesday: { first: "0 18 * * 0", urgent: "0 17 * * 1", labels: ["Sunday 18:00", "Monday 17:00"] },
  saturday:  { first: "0 18 * * 3", urgent: "0 17 * * 4", labels: ["Wednesday 18:00", "Thursday 17:00"] },
};

async function fireReminder(sock, state, day, isUrgent) {
  const cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));
  const label = isUrgent ? "Pilne przypomnienie" : "Pierwsze przypomnienie";
  const result = await sendReminder(sock, state, cfg, isUrgent, day);
  const dayPl = DAY_NAMES_PL_ACC[day] || day;
  if (result?.count) {
    await notify(sock, cfg, `${label} (${dayPl}) wysłane do ${result.count} osób bez głosu.`);
  } else if (result?.everyoneVoted) {
    await notify(sock, cfg, `${label} (${dayPl}): wszyscy już zagłosowali, nic nie wysłano.`);
  } else if (result?.skipped) {
    await notify(sock, cfg, `${label} (${dayPl}) pominięte: ${result.skipped}.`);
  } else if (result?.error) {
    await notify(sock, cfg, `⚠️ Błąd przy wysyłaniu (${dayPl}): ${result.error}`);
  }
}

function scheduleReminders(sock, state, saveState, config, gameDay) {
  activeCrons.forEach(c => c.destroy());
  activeCrons = [];

  const tz = config.timezone || "Europe/Warsaw";
  const day = gameDay || state.gameDay || "friday";
  const schedule = DAY_SCHEDULES[day] || DAY_SCHEDULES.friday;

  const j1 = cron.schedule(schedule.first, async () => {
    console.log("[Scheduler] First reminder fired for", day);
    await fireReminder(sock, state, day, false);
  }, { timezone: tz });

  const j2 = cron.schedule(schedule.urgent, async () => {
    console.log("[Scheduler] Urgent reminder fired for", day);
    await fireReminder(sock, state, day, true);
  }, { timezone: tz });

  activeCrons = [j1, j2];

  console.log("Reminders scheduled (" + tz + ") for game on " + day + ":");
  console.log("  First:", schedule.labels[0]);
  console.log("  Urgent:", schedule.labels[1]);

  notify(sock, config, `Przypomnienia zaplanowane na grę: ${DAY_NAMES_PL_ACC[day] || day} (${schedule.labels[0]} + ${schedule.labels[1]}).`);
}

module.exports = { scheduleReminders };
