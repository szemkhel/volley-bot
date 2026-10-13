const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { sendReminder, DAY_NAMES_PL_ACC } = require("./reminder");
const { activeInjuryLids, confirmedPlayers, squadIsFull, reminderSkipAt, reminderSlots,
  rollCallSlot, rollCallMessage, votersChoosing, settlementCost } = require("./lib");
const { notify } = require("./notify");

let activeCrons = [];

// `getSock` returns the CURRENT socket — never capture it, the WA socket is recreated on every reconnect.
// `getExcluded` returns the LIDs to skip (players on injury/absence break), re-read at fire time.
async function fireReminder(getSock, getPollForDay, getExcluded, day, isUrgent, slotLabel) {
  const cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));
  const label = (isUrgent ? "Pilne przypomnienie" : "Przypomnienie") + (slotLabel ? " (" + slotLabel + ")" : "");
  const dayPl = DAY_NAMES_PL_ACC[day] || day;

  // Squad already full? Then there is nothing to chase and the tag-everyone reminder is just spam.
  // Checked here rather than inside sendReminder so a MANUAL `bot przypomnij` still always sends —
  // that one is an explicit human decision. Both scheduled runs are gated independently against the
  // live vote count, so a drop-out between the first and the urgent slot re-arms the urgent one.
  const threshold = reminderSkipAt(cfg);
  const pollNow = getPollForDay(day);
  if (!pollNow) return; // game no longer tracked (e.g. cancelled meanwhile)
  if (squadIsFull(pollNow, threshold)) {
    const have = confirmedPlayers(pollNow);
    console.log(`[Scheduler] ${label} (${dayPl}) skipped — ${have} players already signed up (threshold ${threshold})`);
    await notify(getSock(), cfg, `${label} (${dayPl}) pominięte — jest już ${have} zapisanych (próg ${threshold}).`);
    return;
  }

  // The socket reconnects frequently; a fire can land during a brief outage. Retry on transient
  // connection errors (reading the live socket each attempt) so the reminder isn't silently lost.
  const maxAttempts = 15;
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const poll = getPollForDay(day);
    if (!poll) return; // game for that day no longer tracked (e.g. cancelled meanwhile)
    result = await sendReminder(getSock(), poll, cfg, isUrgent, getExcluded());
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

// Closing roll call, the morning the hall can still be cancelled free of charge (Wednesday for a
// Friday game). Voting closed the evening before, so this is the group's last chance to act on a
// thin turnout — and the moment someone has to tell the hall. Krzysztof S., 2026-10-12: "w środę
// rano w zależności od frekwencji odstępujemy lub nie".
async function fireRollCall(getSock, getPollForDay, day) {
  const cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));
  const dayPl = DAY_NAMES_PL_ACC[day] || day;
  const poll = getPollForDay(day);
  if (!poll) return; // cancelled or already settled — nothing to close
  if (!cfg.groupJid) return;

  let contacts = {};
  try { contacts = JSON.parse(fs.readFileSync(path.join(__dirname, "contacts.json"), "utf8")); } catch (_) {}
  const names = [];
  for (const label of ["Gram", "Gram i przyprowadzam +1", "Gram i przyprowadzam +2"]) {
    for (const lid of votersChoosing(poll.voters, label)) {
      const name = contacts[lid] || ("Gracz " + lid.slice(-4));
      const plus = label.endsWith("+1") ? " (+1)" : label.endsWith("+2") ? " (+2)" : "";
      if (names.indexOf(name + plus) < 0) names.push(name + plus);
    }
  }
  // Only the people who can actually cancel the booking get tagged, and only when it matters —
  // an "everything is fine" roll call that pings the admins every week would stop being read.
  const admins = (cfg.admins || []).filter(Boolean);
  const msg = rollCallMessage({
    dayPl: dayPl, time: poll.gameTime, confirmed: confirmedPlayers(poll),
    minPlayers: cfg.minPlayers, cost: settlementCost(poll, cfg), names: names,
    callout: admins.length ? admins.map(a => "@" + a).join(" ") : "",
  });
  const payload = { text: msg.text };
  if (msg.needsCancel && admins.length) payload.mentions = admins.map(a => a + "@lid");

  console.log("[Scheduler] roll call (" + dayPl + "):", confirmedPlayers(poll), "confirmed,", msg.needsCancel ? "BELOW minimum" : "playing");
  try {
    await getSock().sendMessage(cfg.groupJid, payload);
    await notify(getSock(), cfg, "Zamknięcie ankiety (" + dayPl + "): " + confirmedPlayers(poll) + " zapisanych" +
      (msg.needsCancel ? " — PONIŻEJ minimum, trzeba odwołać halę." : "."));
  } catch (e) {
    console.error("[Scheduler] roll call failed:", e.message);
    await notify(getSock(), cfg, "⚠️ Nie udało się wysłać zamknięcia ankiety (" + dayPl + "): " + e.message);
  }
}

// Schedules reminders for EVERY tracked game (one cron per slot per distinct game day, plus the
// roll call). `state.polls` is the source of truth; getPollForDay re-reads at fire time so a
// cancelled game is skipped.
function scheduleReminders(getSock, state, saveState, config) {
  activeCrons.forEach(c => c.destroy());
  activeCrons = [];

  const tz = config.timezone || "Europe/Warsaw";
  const polls = (state.polls || []);
  const days = Array.from(new Set(polls.map(p => p.gameDay)));
  // `!p.cancelled` matters: the crons are registered per game day and live until the next
  // scheduleReminders call, so a game cancelled AFTER they were set up would otherwise still get
  // its reminders — tagging everyone about a game that isn't happening (2026-10-13: the Friday
  // game was cancelled on Monday, the Tuesday 18:00 cron was still armed for it).
  const getPollForDay = (day) => (state.polls || []).find(p => p.gameDay === day && !p.cancelled) || null;
  const getExcluded = () => activeInjuryLids(state.injuries, new Date().toLocaleDateString("en-CA", { timeZone: tz }));

  const scheduledLabels = [];
  for (const day of days) {
    const slots = reminderSlots(day, config);
    if (!slots.length) continue;
    for (const slot of slots) {
      const j = cron.schedule(slot.cron, async () => {
        console.log("[Scheduler] Reminder fired for", day, "(" + slot.label + (slot.urgent ? ", last call" : "") + ")");
        await fireReminder(getSock, getPollForDay, getExcluded, day, slot.urgent, slot.label);
      }, { timezone: tz });
      activeCrons.push(j);
    }
    const rc = rollCallSlot(day, config);
    if (rc) {
      const jr = cron.schedule(rc.cron, async () => {
        console.log("[Scheduler] Roll call fired for", day, "(" + rc.label + ")");
        await fireRollCall(getSock, getPollForDay, day);
      }, { timezone: tz });
      activeCrons.push(jr);
    }
    scheduledLabels.push((DAY_NAMES_PL_ACC[day] || day) + " (" + slots.map(s => s.label).join(" + ") +
      (rc ? "; zamknięcie " + rc.label : "") + ")");
  }

  if (scheduledLabels.length) console.log("Reminders scheduled (" + tz + "):", scheduledLabels.join("; "));
  else console.log("No games tracked — no reminders scheduled.");
}

module.exports = { scheduleReminders, fireRollCall };
