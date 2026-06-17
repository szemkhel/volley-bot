require("dotenv").config({ path: __dirname + "/.env" });
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, decryptPollVote, jidNormalizedUser } = require("@whiskeysockets/baileys");
const crypto = require("crypto");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const http = require("http");
const { notify } = require("./notify");

const DIR = __dirname;
const STATE_FILE = path.join(DIR, "state.json");
const CONFIG_FILE = path.join(DIR, "config.json");
const CONTACTS_FILE = path.join(DIR, "contacts.json");
const HISTORY_FILE = path.join(DIR, "history.json");
const PHONE = process.env.PHONE || "";

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
    catch { return { activePoll: null, voters: {}, gameDay: "friday", askedAboutGame: false }; }
  }
  return { activePoll: null, voters: {}, gameDay: "friday", askedAboutGame: false };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (process.env.ANTHROPIC_API_KEY) c.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.NOTIFY_JID) c.notifyJid = process.env.NOTIFY_JID;
  if (process.env.NOTIFY_LID) c.notifyLid = process.env.NOTIFY_LID;
  if (process.env.BLIK_NUMBER) c.blikNumber = process.env.BLIK_NUMBER;
  return c;
}

function saveConfig(c) {
  const out = Object.assign({}, c);
  delete out.anthropicApiKey; delete out.notifyJid; delete out.notifyLid; delete out.blikNumber;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2));
}

function loadContacts() {
  if (fs.existsSync(CONTACTS_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8")); }
    catch { return {}; }
  }
  return {};
}

function saveContacts(contacts) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}

function pollIsRecent(activePoll) {
  return activePoll && (Date.now() - activePoll.timestamp) < 7 * 24 * 60 * 60 * 1000;
}

let state = loadState();
let contacts = loadContacts();
let recentMessages = [];
let sock = null;
let reminderScheduled = false;
let connDownAt = null;


function voteTally() {
  const tally = {};
  let voted = 0;
  for (const k in (state.voters || {})) {
    voted++;
    const opts = (state.voters[k] && state.voters[k].options) || [];
    for (const o of opts) tally[o] = (tally[o] || 0) + 1;
  }
  return { voted, tally };
}

const processedCmds = new Set();
function seen(id) {
  if (!id) return false;
  if (processedCmds.has(id)) return true;
  processedCmds.add(id);
  if (processedCmds.size > 200) processedCmds.clear();
  return false;
}

async function recordVote(pollUpdate, voterJid) {
  if (!state.activePoll || !pollUpdate) return;
  const pollKey = pollUpdate.pollCreationMessageKey;
  if (pollKey && pollKey.id && pollKey.id !== state.activePoll.messageKey.id) return;
  if (!voterJid) return;
  const phone = voterJid.split("@")[0];
  let options = [];
  try {
    const poll = state.activePoll;
    if (poll.encKeyB64 && pollUpdate.vote) {
      const meta = decryptPollVote(pollUpdate.vote, {
        pollCreatorJid: poll.pollCreatorJid,
        pollMsgId: poll.messageKey.id,
        pollEncKey: Buffer.from(poll.encKeyB64, "base64"),
        voterJid,
      });
      const selected = (meta.selectedOptions || []).map(b => Buffer.from(b).toString("hex"));
      options = selected.map(h => poll.optionHashes && poll.optionHashes[h]).filter(Boolean);
    }
  } catch (e) {
    console.error("vote decrypt error:", e.message);
  }
  if (options.length === 0) { delete state.voters[phone]; }
  else { state.voters[phone] = { jid: voterJid, options }; }
  saveState(state);
  console.log("Vote recorded:", phone, options.length ? "-> " + options.join(", ") : "(empty/retracted)");
}

function nextDateForDay(dayName) {
  const map = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const target = map[dayName];
  if (target == null) return null;
  const warsawStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
  const base = new Date(warsawStr + "T12:00:00");
  const add = (target - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + add);
  return base.toISOString().slice(0, 10);
}

function archiveIfGamePassed(strict) {
  if (!state.activePoll || state.cancelled) return;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
  const gd = state.activePoll.gameDate;
  let passed;
  if (gd) passed = strict ? (today > gd) : (today >= gd);
  else {
    const wd = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: "Europe/Warsaw" }).toLowerCase();
    passed = (wd === state.gameDay);
  }
  if (passed) {
    console.log("[Auto-archive] game passed (gd=" + gd + ", today=" + today + ")");
    archiveCurrentPoll("played");
    state.activePoll = null;
    saveState(state);
  }
}

const POLL_OPTIONS = ["Gram", "Nie gram", "Nie wiem", "Gram i przyprowadzam +1", "Gram i przyprowadzam +2"];

const DAY_WORDS = {
  "poniedzialek": "monday", "poniedziałek": "monday",
  "wtorek": "tuesday",
  "sroda": "wednesday", "środa": "wednesday", "srode": "wednesday", "środę": "wednesday",
  "czwartek": "thursday",
  "piatek": "friday", "piątek": "friday",
  "sobota": "saturday", "sobote": "saturday", "sobotę": "saturday",
  "niedziela": "sunday", "niedziele": "sunday", "niedzielę": "sunday",
};

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

function loadHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return []; } }
function saveHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2)); }

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

function archiveCurrentPoll(status) {
  if (!state.activePoll) return;
  const { voted, tally } = voteTally();
  status = status || "played";
  if (status !== "cancelled" && voted === 0) return;
  const contacts = loadContacts();
  const attendees = [];
  for (const phone in state.voters) {
    if (weightOfOptions(state.voters[phone].options) > 0) attendees.push({ phone: phone, name: contacts[phone] || null });
  }
  const hist = loadHistory();
  hist.push({
    date: new Date().toISOString().slice(0, 10),
    gameDay: state.gameDay,
    gameTime: state.activePoll.gameTime || null,
    question: state.activePoll.question,
    status: status,
    voted: voted,
    tally: tally,
    attendees: attendees,
    players: (state.activePoll.realPlayers != null ? state.activePoll.realPlayers : attendanceFromTally(tally)),
  });
  if (hist.length > 200) hist.shift();
  saveHistory(hist);
  console.log("Archived poll:", status, state.gameDay, "players=" + attendanceFromTally(tally));
}

function frekwencjaText() {
  const NL = String.fromCharCode(10);
  const hist = loadHistory();
  const last = hist.slice(-10);
  const lines = [];
  for (const h of last) {
    const label = h.status === "cancelled" ? "odwołane" : "grane";
    lines.push(h.date + " graczy: " + (h.players || 0) + " status: " + label);
  }
  if (state.activePoll && !state.cancelled) {
    const today = new Date().toISOString().slice(0, 10);
    const t = voteTally();
    const cur = state.activePoll.realPlayers != null ? state.activePoll.realPlayers : attendanceFromTally(t.tally);
    lines.push(today + " graczy: " + cur + " status: w toku");
  }
  if (!lines.length) return "Brak danych frekwencji jeszcze. 🏐";
  return "Frekwencja 🏐" + NL + lines.join(NL);
}

async function createPoll(cfg, day, time, targetJid) {
  const { DAY_NAMES_PL_ACC } = require("./reminder");
  const { scheduleReminders } = require("./scheduler");
  const dayPl = DAY_NAMES_PL_ACC[day] || day || "";
  const name = "Siatkówka " + dayPl + (time ? " " + time : "") + " 🏐 — gracie?";
  const sent = await sock.sendMessage(targetJid, { poll: { name, values: POLL_OPTIONS, selectableCount: 1 } });

  archiveCurrentPoll("played");

  const optionHashes = {};
  for (const o of POLL_OPTIONS) optionHashes[crypto.createHash("sha256").update(Buffer.from(o)).digest("hex")] = o;
  const secret = sent.message?.messageContextInfo?.messageSecret;

  state.activePoll = {
    messageKey: { id: sent.key.id, remoteJid: targetJid },
    question: name,
    options: POLL_OPTIONS,
    optionHashes,
    pollCreatorJid: sock.user ? jidNormalizedUser(sock.user.lid || sock.user.id) : targetJid,
    encKeyB64: secret ? Buffer.from(secret).toString("base64") : null,
    gameTime: time || null,
    gameDate: nextDateForDay(day || state.gameDay || "friday"),
    timestamp: Date.now(),
  };
  state.voters = {};
  if (day) state.gameDay = day;
  state.cancelled = false;
  state.askedAboutGame = false;
  saveState(state);
  scheduleReminders(sock, state, saveState, cfg, state.gameDay);
  console.log("Poll created:", name, "encKey:", secret ? "yes" : "NO");
  return name;
}

function weightOfOptions(opts) {
  const t = {};
  for (const o of (opts || [])) t[o] = (t[o] || 0) + 1;
  return attendanceFromTally(t);
}

function buildSettlement(cost, realPeople, cfg) {
  const NL = String.fromCharCode(10);
  const perUnit = cost / realPeople;
  const groups = {};
  let accounted = 0;
  for (const phone in state.voters) {
    const v = state.voters[phone];
    const w = weightOfOptions(v.options);
    if (w <= 0) continue;
    accounted += w;
    const amount = Math.round(perUnit * w);
    (groups[amount] = groups[amount] || []).push(v.jid);
  }
  const lines = ["Rozliczenie sali:"];
  const mentions = [];
  const amounts = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
  for (const amt of amounts) {
    const jids = groups[amt];
    for (const j of jids) mentions.push(j);
    const tags = jids.map(function (j) { return "@" + j.split("@")[0]; }).join(", ");
    lines.push(amt + "pln " + tags);
  }
  const diff = realPeople - accounted;
  if (diff > 0) lines.push("(" + diff + " os. spoza ankiety — ok. " + Math.round(perUnit) + "pln/os.)");
  lines.push("Proszę o wpłatę blikiem na numer " + (cfg.blikNumber || "BRAK"));
  return { text: lines.join(NL), mentions: mentions, accounted: accounted };
}

function setRealPlayers(n) {
  if (state.activePoll) {
    state.activePoll.realPlayers = n;
    saveState(state);
    return;
  }
  const hist = loadHistory();
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].status !== "cancelled") { hist[i].players = n; hist[i].realPlayers = n; break; }
  }
  saveHistory(hist);
}

async function doSettlement(cfg, cost, people) {
  const st = buildSettlement(cost, people, cfg);
  await sock.sendMessage(cfg.groupJid, { text: st.text, mentions: st.mentions });
  setRealPlayers(people);
  state.pendingRozliczenie = null;
  saveState(state);
  await notify(sock, cfg, "Rozliczenie wysłane: " + cost + "pln / " + people + " osób.");
  return true;
}

async function finalizeRozliczenie(cfg) {
  const p = state.pendingRozliczenie;
  if (!p) return false;
  const pollPeople = attendanceFromTally(voteTally().tally);
  if (p.people === pollPeople) {
    return await doSettlement(cfg, p.cost, p.people);
  }
  p.stage = "confirm";
  p.ts = Date.now();
  saveState(state);
  await sock.sendMessage(cfg.groupJid, { text: "💰 Liczby się nie zgadzają — ankieta: " + pollPeople + ", podałeś: " + p.people + ". Rozliczyć na " + p.people + " osób (priorytet realnej liczby)? Napisz tak/nie." });
  return true;
}

async function handleRozliczenieAnswer(rtext, cfg) {
  const p = state.pendingRozliczenie;
  if (!p) return false;
  if (Date.now() - (p.ts || 0) > 15 * 60 * 1000) { state.pendingRozliczenie = null; saveState(state); return false; }
  if (p.stage === "cost") {
    const mm = rtext.match(/\d+([.,]\d+)?/);
    if (!mm) return false;
    p.cost = parseFloat(mm[0].replace(",", "."));
    p.stage = "people"; p.ts = Date.now(); saveState(state);
    await sock.sendMessage(cfg.groupJid, { text: "💰 Ile osób faktycznie grało? Podaj liczbę." });
    return true;
  }
  if (p.stage === "people") {
    const mm = rtext.match(/\d+/);
    if (!mm) return false;
    p.people = parseInt(mm[0], 10); p.ts = Date.now(); saveState(state);
    return await finalizeRozliczenie(cfg);
  }
  if (p.stage === "confirm") {
    if (/^(tak|t|ok|yes|potwierdzam)\b/i.test(rtext)) return await doSettlement(cfg, p.cost, p.people);
    if (/^(nie|n|no|anuluj)\b/i.test(rtext)) { state.pendingRozliczenie = null; saveState(state); await sock.sendMessage(cfg.groupJid, { text: "Anulowano rozliczenie." }); return true; }
    return false;
  }
  return false;
}

async function rankingText(cfg) {
  const NL = String.fromCharCode(10);
  const counts = {};
  const hist = loadHistory();
  for (const h of hist) {
    for (const a of (h.attendees || [])) {
      if (!counts[a.phone]) counts[a.phone] = { name: a.name || null, count: 0 };
      counts[a.phone].count++;
      if (a.name && !counts[a.phone].name) counts[a.phone].name = a.name;
    }
  }
  const contacts = loadContacts();
  if (state.activePoll && !state.cancelled) {
    for (const phone in state.voters) {
      if (weightOfOptions(state.voters[phone].options) <= 0) continue;
      if (!counts[phone]) counts[phone] = { name: contacts[phone] || null, count: 0 };
      counts[phone].count++;
    }
  }
  try {
    const meta = await sock.groupMetadata(cfg.groupJid);
    for (const p of meta.participants) {
      const phone = p.id.split("@")[0];
      if (!counts[phone]) counts[phone] = { name: contacts[phone] || p.notify || null, count: 0 };
      else if (!counts[phone].name) counts[phone].name = contacts[phone] || p.notify || null;
    }
  } catch (e) { console.error("ranking meta error:", e.message); }
  const rows = Object.keys(counts).map(function (p) { return { phone: p, name: counts[p].name, count: counts[p].count }; });
  if (!rows.length) return "Brak danych do rankingu jeszcze. 🏐";
  rows.sort(function (a, b) { return b.count - a.count; });
  const lines = ["Ranking obecności 🏐"];
  let i = 1;
  for (const r of rows) {
    lines.push(i + ". " + (r.name || ("Gracz " + r.phone.slice(-4))) + " — " + r.count + "x");
    i++;
  }
  return lines.join(NL);
}

async function handleGroupCommand(text, cfg) {

  const { interpretCommand, sendReminder, DAY_NAMES_PL_ACC } = require("./reminder");
  const { scheduleReminders } = require("./scheduler");
  const reply = async (t) => {
    await sock.sendMessage(cfg.groupJid, { text: t });
    await notify(sock, cfg, "Komenda z grupy: " + JSON.stringify(text));
  };
  if (!text || !text.trim()) {
    await reply("Cześć! 🏐 Komendy: \"bot ankieta piątek 20:00\", \"bot status\", \"bot frekwencja\", \"bot przypomnij\", \"bot nie gramy\".");
    return;
  }
  const low = text.trim().toLowerCase();
  if (low.startsWith("pomoc") || low.startsWith("help")) {
    await reply("Komendy 🏐\n• bot ankieta piątek 20:00 — nowa ankieta\n• bot status — liczba graczy\n• bot zmień dzień na czwartek / godzinę 21:00\n• bot frekwencja — frekwencja i trend\n• bot rozlicz — podziel koszt sali\n• bot ranking — obecność graczy\n• bot przypomnij — przypomnij teraz\n• bot pomoc — ta lista\n• bot nie gramy — odwołaj trening\n• bot cofnij odwołanie — przywróć trening");
    return;
  }
  if (low.startsWith("cofnij")) {
    if (!state.cancelled || !state.preCancel) { await reply("Nie ma czego cofać — w tym tygodniu trening nie był odwołany."); return; }
    state.activePoll = state.preCancel.activePoll || null;
    state.voters = state.preCancel.voters || {};
    if (state.preCancel.gameDay) state.gameDay = state.preCancel.gameDay;
    state.cancelled = false;
    state.preCancel = null;
    const hist = loadHistory();
    if (hist.length && hist[hist.length - 1].status === "cancelled") { hist.pop(); saveHistory(hist); }
    saveState(state);
    scheduleReminders(sock, state, saveState, cfg, state.gameDay);
    await reply("Cofnięto odwołanie — trening znów aktualny! 🏐");
    return;
  }
  if (low.startsWith("rozlicz")) {
    const nums = (text.match(/\d+([.,]\d+)?/g) || []).map(function (x) { return parseFloat(x.replace(",", ".")); });
    if (nums.length >= 2) {
      state.pendingRozliczenie = { cost: nums[0], people: Math.round(nums[1]), ts: Date.now() };
      saveState(state);
      await finalizeRozliczenie(cfg);
      return;
    }
    state.pendingRozliczenie = { stage: "cost", ts: Date.now() };
    saveState(state);
    await reply("💰 Ile wyniósł wynajem sali? Podaj kwotę w PLN.");
    return;
  }
  if (low.startsWith("ranking")) {
    await reply(await rankingText(cfg));
    return;
  }
  if (low.startsWith("ankieta") || low.startsWith("pool") || low.startsWith("pula")) {
    const { day, time } = parseAnkieta(text);
    if (!day) { await reply("Podaj dzień, np. \"bot ankieta piątek 20:00\". 🏐"); return; }
    const name = await createPoll(cfg, day, time, cfg.groupJid);
    await reply("Gotowe — utworzyłem ankietę: " + name);
    return;
  }
  if (low.startsWith("zmień") || low.startsWith("zmien") || low.startsWith("zmiana")) {
    if (!state.activePoll) { await reply("Nie ma aktywnej ankiety do zmiany. Najpierw: bot ankieta piątek 20:00"); return; }
    const pa = parseAnkieta(text);
    if (!pa.day && !pa.time) { await reply("Podaj co zmienić, np. \"bot zmień dzień na czwartek\" albo \"bot zmień godzinę 21:00\"."); return; }
    if (pa.day) state.gameDay = pa.day;
    if (pa.time) state.activePoll.gameTime = pa.time;
    state.cancelled = false; saveState(state);
    scheduleReminders(sock, state, saveState, cfg, state.gameDay);
    const dpl = DAY_NAMES_PL_ACC[state.gameDay] || state.gameDay;
    await reply("📢 Zmiana terminu treningu: " + dpl + (state.activePoll.gameTime ? " o " + state.activePoll.gameTime : "") + ". Ankieta pozostaje aktualna!");
    return;
  }
  if (low.startsWith("frekwencja") || low.startsWith("statystyki")) {
    await reply(frekwencjaText());
    return;
  }
  const cmd = await interpretCommand(text, state, cfg);
  console.log("[Group command]", JSON.stringify(text), "->", JSON.stringify(cmd));

  if (cmd.action === "status") {
    const dayPl = DAY_NAMES_PL_ACC[state.gameDay] || state.gameDay || "?";
    if (state.cancelled) { await reply(`Trening w ${dayPl} jest odwołany — w tym tygodniu nie gramy. 🏐`); return; }
    if (!state.activePoll) { await reply("Nie ma jeszcze aktywnej ankiety na ten tydzień. 🏐"); return; }
    const time = state.activePoll.gameTime ? " " + state.activePoll.gameTime : "";
    const { tally } = voteTally();
    const players = attendanceFromTally(tally);
    await reply(`Liczba graczy na trening w ${dayPl}${time} to: ${players}`);
  } else if (cmd.action === "schedule" && cmd.day) {
    if (!state.activePoll) state.activePoll = { messageKey:{id:"manual",remoteJid:cfg.groupJid}, question:"manual", options:[], timestamp:Date.now() };
    state.voters = {}; state.gameDay = cmd.day; state.cancelled = false; state.askedAboutGame = false;
    saveState(state);
    scheduleReminders(sock, state, saveState, cfg, cmd.day);
    await reply(`Ok, ustawiam grę na ${DAY_NAMES_PL_ACC[cmd.day] || cmd.day} i zaplanowałem przypomnienia! 🏐`);
  } else if (cmd.action === "remind") {
    const r = await sendReminder(sock, state, cfg, false, state.gameDay);
    if (r && r.everyoneVoted) await reply("Wszyscy już zagłosowali! 🎉");
    else if (r && r.skipped) await reply("Nie mogę teraz przypomnieć (brak aktywnej ankiety). 🏐");
    else await notify(sock, cfg, "Komenda z grupy: przypomnij -> wysłano");
  } else if (cmd.action === "cancel") {
    state.preCancel = { activePoll: state.activePoll, voters: state.voters, gameDay: state.gameDay };
    archiveCurrentPoll("cancelled");
    state.activePoll = null; state.voters = {}; state.cancelled = true; state.askedAboutGame = false; saveState(state);
    await reply(`Ok, w tym tygodniu nie gramy — trening odwołany. Do następnego razu! 🏐`);
  } else if (cmd.action === "help") {
    await reply("Komendy 🏐\n• bot ankieta piątek 20:00 — nowa ankieta\n• bot status — liczba graczy\n• bot zmień dzień na czwartek / godzinę 21:00\n• bot frekwencja — frekwencja i trend\n• bot rozlicz — podziel koszt sali\n• bot ranking — obecność graczy\n• bot przypomnij — przypomnij teraz\n• bot nie gramy — odwołaj trening\n• bot cofnij odwołanie — przywróć trening");
  } else {
    await reply("Nie zrozumiałem 🤔 Spróbuj: \"bot status\", \"bot gramy w czwartek\", \"bot przypomnij\".");
  }
}

async function handleOwnerCommand(text, cfg) {
  const { interpretCommand, sendReminder, DAY_NAMES_PL_ACC } = require("./reminder");
  const { scheduleReminders } = require("./scheduler");
  const low = text.trim().toLowerCase();
  if (low === "test on" || low === "test" || low === "tryb testowy") {
    if (!cfg.testGroupJid) { await notify(sock, cfg, "Brak grupy testowej (testGroupJid)."); return; }
    if (cfg.groupJid !== cfg.testGroupJid) { cfg.realGroupJid = cfg.groupJid; cfg.groupJid = cfg.testGroupJid; saveConfig(cfg); }
    await notify(sock, cfg, "🧪 TRYB TESTOWY włączony — agent działa na grupie testowej.");
    return;
  }
  if (low === "test off" || low === "produkcja" || low === "prod") {
    if (cfg.realGroupJid) { cfg.groupJid = cfg.realGroupJid; saveConfig(cfg); }
    await notify(sock, cfg, "✅ Tryb PRODUKCYJNY — agent działa na prawdziwej grupie.");
    return;
  }
  if (low.startsWith("pomoc") || low.startsWith("help")) {
    await notify(sock, cfg, "Komendy:\n• ankieta piątek 20:00 — nowa ankieta\n• status — liczba graczy\n• zmień dzień na czwartek / godzinę 21:00\n• frekwencja — frekwencja i trend\n• rozlicz — podziel koszt sali\n• ranking — obecność graczy\n• przypomnij — przypomnij teraz\n• gramy w czwartek — ustaw dzień\n• pomoc — ta lista\n• nie gramy — odwołaj\n• cofnij odwołanie — przywróć trening\n• test on / test off — grupa testowa");
    return;
  }
  if (low.startsWith("cofnij")) {
    if (!state.cancelled || !state.preCancel) { await notify(sock, cfg, "Nie ma czego cofać — trening nie był odwołany."); return; }
    state.activePoll = state.preCancel.activePoll || null;
    state.voters = state.preCancel.voters || {};
    if (state.preCancel.gameDay) state.gameDay = state.preCancel.gameDay;
    state.cancelled = false;
    state.preCancel = null;
    const hist = loadHistory();
    if (hist.length && hist[hist.length - 1].status === "cancelled") { hist.pop(); saveHistory(hist); }
    saveState(state);
    scheduleReminders(sock, state, saveState, cfg, state.gameDay);
    await notify(sock, cfg, "Cofnięto odwołanie — trening znów aktualny.");
    return;
  }
  if (low.startsWith("rozlicz")) {
    const nums = (text.match(/\d+([.,]\d+)?/g) || []).map(function (x) { return parseFloat(x.replace(",", ".")); });
    if (nums.length >= 2) {
      state.pendingRozliczenie = { cost: nums[0], people: Math.round(nums[1]), ts: Date.now() };
      saveState(state);
      await finalizeRozliczenie(cfg);
      await notify(sock, cfg, "Rozliczenie przetworzone — sprawdź grupę.");
      return;
    }
    await notify(sock, cfg, "Podaj kwotę i liczbę osób, np. rozlicz 100 10. Pełny dialog działa w grupie: bot rozlicz.");
    return;
  }
  if (low.startsWith("ranking")) {
    await notify(sock, cfg, await rankingText(cfg));
    return;
  }
  if (low.startsWith("ankieta") || low.startsWith("pool")) {
    const { day, time } = parseAnkieta(text);
    if (!day) { await notify(sock, cfg, "Podaj dzień, np. \"ankieta piątek 20:00\"."); return; }
    const name = await createPoll(cfg, day, time, cfg.groupJid);
    await notify(sock, cfg, "Utworzyłem ankietę w aktywnej grupie: " + name);
    return;
  }
  if (low.startsWith("zmień") || low.startsWith("zmien") || low.startsWith("zmiana")) {
    if (!state.activePoll) { await notify(sock, cfg, "Nie ma aktywnej ankiety do zmiany."); return; }
    const pa = parseAnkieta(text);
    if (!pa.day && !pa.time) { await notify(sock, cfg, "Podaj zmianę, np. \"zmień dzień na czwartek\" albo \"zmień godzinę 21:00\"."); return; }
    if (pa.day) state.gameDay = pa.day;
    if (pa.time) state.activePoll.gameTime = pa.time;
    state.cancelled = false; saveState(state);
    scheduleReminders(sock, state, saveState, cfg, state.gameDay);
    const dpl = DAY_NAMES_PL_ACC[state.gameDay] || state.gameDay;
    await sock.sendMessage(cfg.groupJid, { text: "📢 Zmiana terminu treningu: " + dpl + (state.activePoll.gameTime ? " o " + state.activePoll.gameTime : "") + ". Ankieta pozostaje aktualna!" });
    await notify(sock, cfg, "Zmieniono termin i ogłoszono w grupie.");
    return;
  }
  if (low.startsWith("frekwencja") || low.startsWith("statystyki")) {
    await notify(sock, cfg, frekwencjaText());
    return;
  }
  const cmd = await interpretCommand(text, state, cfg);
  console.log("[Owner command]", JSON.stringify(text), "->", JSON.stringify(cmd));

  if (cmd.action === "status") {
    const poll = state.activePoll;
    const dayPl = DAY_NAMES_PL_ACC[state.gameDay] || state.gameDay || "?";
    const { voted, tally } = voteTally();
    const players = attendanceFromTally(tally);
    let m = `Status:\n• Dzień gry: ${dayPl}\n• Ankieta: ${state.cancelled ? "ODWOŁANA" : (poll ? "aktywna" : "brak")}\n• Liczba graczy: ${players}`;
    const tk = Object.keys(tally);
    if (tk.length) { for (const o of tk) m += `\n   - ${o}: ${tally[o]}`; }
    else if (voted > 0) m += "\n   (głosy zaszyfrowane — brak rozbicia)";
    m += `\n• Zagłosowało: ${voted}`;
    if (state.askedAboutGame) m += "\n• Czekam na odpowiedź grupy czy gramy";
    await notify(sock, cfg, m);
  } else if (cmd.action === "schedule" && cmd.day) {
    if (!state.activePoll) state.activePoll = { messageKey:{id:"manual",remoteJid:cfg.groupJid}, question:"manual", options:[], timestamp:Date.now() };
    state.voters = {}; state.gameDay = cmd.day; state.cancelled = false; state.askedAboutGame = false;
    saveState(state);
    scheduleReminders(sock, state, saveState, cfg, cmd.day);
  } else if (cmd.action === "remind") {
    const r = await sendReminder(sock, state, cfg, false, state.gameDay);
    if (r && r.count) await notify(sock, cfg, `Wysłano przypomnienie do ${r.count} osób.`);
    else if (r && r.everyoneVoted) await notify(sock, cfg, "Wszyscy już zagłosowali — nie wysłałem.");
    else if (r && r.skipped) await notify(sock, cfg, `Pominięto: ${r.skipped}.`);
  } else if (cmd.action === "cancel") {
    state.preCancel = { activePoll: state.activePoll, voters: state.voters, gameDay: state.gameDay };
    archiveCurrentPoll("cancelled");
    state.activePoll = null; state.voters = {}; state.cancelled = true; state.askedAboutGame = false; saveState(state);
    await notify(sock, cfg, "Ok, anulowałem przypomnienia — trening odwołany na ten tydzień.");
  } else if (cmd.action === "help") {
    await notify(sock, cfg, "Komendy:\n• ankieta piątek 20:00 — nowa ankieta\n• status — liczba graczy\n• zmień dzień na czwartek / godzinę 21:00\n• frekwencja — frekwencja i trend\n• rozlicz — podziel koszt sali\n• ranking — obecność graczy\n• przypomnij — przypomnij teraz\n• gramy w czwartek — ustaw dzień\n• nie gramy — odwołaj\n• cofnij odwołanie — przywróć trening\n• test on / test off — grupa testowa");
  } else {
    await notify(sock, cfg, "Nie zrozumiałem. Spróbuj: \"status\", \"gramy w czwartek\", \"przypomnij teraz\" albo \"nie gramy\".");
  }
}

async function connectToWhatsApp() {
  const config = loadConfig();
  const { state: authState, saveCreds } = await useMultiFileAuthState(path.join(DIR, "auth_info"));

  sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: authState,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("contacts.upsert", (newContacts) => {
    let changed = false;
    for (const c of newContacts) {
      const phone = c.id.split("@")[0];
      const name = c.notify || c.name || c.verifiedName;
      if (name && !contacts[phone]) {
        contacts[phone] = name;
        changed = true;
      }
    }
    if (changed) {
      saveContacts(contacts);
      console.log("Contacts cache updated:", Object.keys(contacts).length, "entries");
    }
  });

  sock.ev.on("messaging-history.set", async ({ messages: histMsgs }) => {
    const cfg = loadConfig();
    if (!cfg.groupJid || !histMsgs?.length) return;
    let added = 0;
    for (const msg of histMsgs) {
      if (msg.key.remoteJid !== cfg.groupJid) continue;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!text) continue;
      const senderJid = msg.key.participant || msg.key.remoteJid;
      const senderName = contacts[senderJid?.split("@")[0]] || msg.pushName || senderJid?.split("@")[0];
      recentMessages.push({ sender: senderName, text });
      added++;
    }
    if (added > 0) {
      if (recentMessages.length > 20) recentMessages = recentMessages.slice(-20);
      console.log("Loaded", added, "messages from history into context.");
    }
    if (pollIsRecent(state.activePoll) && recentMessages.length > 0) {
      const { detectGameDay } = require("./reminder");
      const detected = await detectGameDay(state.activePoll.question, recentMessages, cfg);
      if (detected !== (state.gameDay || "friday")) {
        console.log("Startup re-detection: game day", state.gameDay || "friday", "->", detected);
        state.gameDay = detected;
        saveState(state);
        const { scheduleReminders } = require("./scheduler");
        scheduleReminders(sock, state, saveState, cfg, detected);
      }
    }
  });

  if (!authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE);
        console.log("\n==========================================");
        console.log("  Pairing code: " + code);
        console.log("==========================================\n");
      } catch (err) {
        console.error("Failed to get pairing code:", err.message);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        if (!connDownAt) connDownAt = Date.now();
        console.log("Reconnecting...");
        connectToWhatsApp();
      } else {
        console.log("Logged out. Delete auth_info/ and restart.");
        try { fs.writeFileSync(path.join(DIR, "NEEDS_REPAIR.txt"), new Date().toISOString() + " - WhatsApp wylogowany, wymagane ponowne parowanie\n"); } catch (e) {}
      }
    } else if (connection === "open") {
      console.log("WhatsApp connected!");
      console.log("[DBG sock.user]", JSON.stringify(sock.user));
      if (connDownAt) {
        const mins = Math.round((Date.now() - connDownAt) / 60000);
        connDownAt = null;
        if (mins >= 3) { try { await notify(sock, config, "✅ Połączenie przywrócone po ~" + mins + " min przerwy."); } catch (e) {} }
      }
      archiveIfGamePassed(true);
      if (!reminderScheduled) {
        reminderScheduled = true;
        const { scheduleReminders } = require("./scheduler");
        scheduleReminders(sock, state, saveState, config, state.gameDay);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    const cfg = loadConfig();

    for (const msg of messages) {
      if (!msg.message) continue;

      if ((cfg.notifyJid && msg.key.remoteJid === cfg.notifyJid) || (cfg.notifyLid && msg.key.remoteJid === cfg.notifyLid)) {
        const ctext = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (ctext && !ctext.startsWith("🤖") && !seen(msg.key.id)) await handleOwnerCommand(ctext, cfg);
        continue;
      }

      // Group command interface — Polish trigger "bot ..."
      if (cfg.groupJid && msg.key.remoteJid === cfg.groupJid) {
        const gtext = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (gtext && /^bot\b/i.test(gtext.trim()) && !gtext.startsWith("🤖") && !seen(msg.key.id)) {
          await handleGroupCommand(gtext.trim().replace(/^bot\b[\s,:]*/i, ""), cfg);
          continue;
        }
      }

      // Rozliczenie answer capture (before fromMe skip so owner can answer)
      if (state.pendingRozliczenie && cfg.groupJid && msg.key.remoteJid === cfg.groupJid) {
        const rtext = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (rtext && !rtext.startsWith("💰") && !rtext.startsWith("🤖") && !/^bot\b/i.test(rtext)) {
          const done = await handleRozliczenieAnswer(rtext, cfg);
          if (done) continue;
        }
      }

      // Poll vote via upsert (owner's own vote arrives fromMe)
      const puUp = msg.message.pollUpdateMessage;
      if (puUp) {
        console.log("[DBG vote-upsert] type=" + type + " fromMe=" + msg.key.fromMe + " participant=" + msg.key.participant + " remoteJid=" + msg.key.remoteJid);
        const vjid = msg.key.participant || ((msg.key.fromMe && sock.user) ? jidNormalizedUser(sock.user.id) : msg.key.remoteJid);
        await recordVote(puUp, vjid);
        continue;
      }

      if (type !== "notify") continue;
      if (msg.key.fromMe) continue;

      const senderJid = msg.key.participant || msg.key.remoteJid;
      if (senderJid && msg.pushName) {
        const phone = senderJid.split("@")[0];
        if (!contacts[phone]) {
          contacts[phone] = msg.pushName;
          saveContacts(contacts);
        }
      }

      if (cfg.groupJid && msg.key.remoteJid === cfg.groupJid) {
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
          const senderName = contacts[senderJid?.split("@")[0]] || msg.pushName || senderJid?.split("@")[0];
          recentMessages.push({ sender: senderName, text });
          if (recentMessages.length > 20) recentMessages.shift();

          if (text.startsWith("!gameday ")) {
            const newDay = text.split(" ")[1]?.trim().toLowerCase();
            const valid = ["friday", "thursday", "wednesday", "saturday", "sunday", "monday", "tuesday"];
            if (valid.includes(newDay)) {
              if (!state.activePoll) {
                state.activePoll = { messageKey: { id: "manual", remoteJid: cfg.groupJid }, question: "manual override", options: [], timestamp: Date.now() };
              }
              state.voters = {};
              state.gameDay = newDay;
              state.askedAboutGame = false;
              saveState(state);
              const { scheduleReminders } = require("./scheduler");
              scheduleReminders(sock, state, saveState, cfg, newDay);
              const { DAY_NAMES_PL_ACC } = require("./reminder");
              await sock.sendMessage(cfg.groupJid, { text: `Dzień gry ustawiony na ${DAY_NAMES_PL_ACC[newDay] || newDay}. Przypomnienia zaplanowane! 🏐` });
              console.log("Game day manually set to:", newDay);
            }
          } else if (state.askedAboutGame) {
            const { analyzeGameResponse, DAY_NAMES_PL_ACC } = require("./reminder");
            const result = await analyzeGameResponse(recentMessages, cfg);
            if (result.playing === true && result.day) {
              state.askedAboutGame = false;
              state.gameDay = result.day;
              if (!state.activePoll) {
                state.activePoll = { messageKey: { id: "auto", remoteJid: cfg.groupJid }, question: "auto-detected", options: [], timestamp: Date.now() };
              }
              state.voters = {};
              saveState(state);
              const { scheduleReminders } = require("./scheduler");
              scheduleReminders(sock, state, saveState, cfg, result.day);
              await sock.sendMessage(cfg.groupJid, { text: `Super! Zaplanowałem przypomnienia na ${DAY_NAMES_PL_ACC[result.day] || result.day} 🏐` });
              console.log("[Game response] Playing on", result.day);
              await notify(sock, cfg, `Grupa potwierdziła grę (${result.day}) w odpowiedzi na pytanie.`);
            } else if (result.playing === false) {
              state.askedAboutGame = false;
              state.activePoll = null;
              saveState(state);
              await sock.sendMessage(cfg.groupJid, { text: "Ok, nie gramy w tym tygodniu! Do zobaczenia następnym razem 🏐" });
              console.log("[Game response] No game this week.");
              await notify(sock, cfg, "Grupa potwierdziła: nie gramy w tym tygodniu.");
            }
          }
        }
      }

      if (cfg.groupJid && msg.key.remoteJid !== cfg.groupJid) continue;

      const pollMsg = msg.message.pollCreationMessage || msg.message.pollCreationMessageV2 || msg.message.pollCreationMessageV3;

      if (pollMsg) {
        console.log("Poll detected:", pollMsg.name, "in", msg.key.remoteJid);
        if (!cfg.groupJid) {
          cfg.groupJid = msg.key.remoteJid;
          saveConfig(cfg);
        }
        archiveCurrentPoll("played");
        const optNames = (pollMsg.options || []).map(o => o.optionName);
        const optionHashes = {};
        for (const o of optNames) optionHashes[crypto.createHash("sha256").update(Buffer.from(o)).digest("hex")] = o;
        const secret = msg.message.messageContextInfo?.messageSecret;
        state.activePoll = { messageKey: { id: msg.key.id, remoteJid: msg.key.remoteJid }, question: pollMsg.name, options: optNames, optionHashes, pollCreatorJid: (msg.key.participant || msg.key.remoteJid), encKeyB64: secret ? Buffer.from(secret).toString("base64") : null, timestamp: Date.now() };
        state.voters = {};
        state.cancelled = false;
        state.askedAboutGame = false;
        saveState(state);
        console.log("Poll tracking started.");
        await notify(sock, cfg, `Wykryto nową ankietę: "${pollMsg.name}". Śledzę głosy.`);
        const { detectGameDay } = require("./reminder");
        const detectedDay = await detectGameDay(pollMsg.name, recentMessages, cfg);
        if (detectedDay !== (state.gameDay || "friday")) {
          console.log("Game day changed:", state.gameDay || "friday", "->", detectedDay);
          state.gameDay = detectedDay;
          saveState(state);
          const { scheduleReminders } = require("./scheduler");
          scheduleReminders(sock, state, saveState, cfg, detectedDay);
        }
      }
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      const pu = update.update?.message?.pollUpdateMessage;
      const puArr = update.update?.pollUpdates;
      if (pu || (puArr && puArr.length)) {
        console.log("[DBG vote-update] hasMsgPU=" + !!pu + " pollUpdates=" + (puArr ? puArr.length : 0) + " key=" + JSON.stringify(update.key));
      }
      const voterJid = update.key.participant || update.key.remoteJid;
      if (pu) await recordVote(pu, voterJid);
      else if (puArr && puArr.length) { for (const p of puArr) await recordVote(p, voterJid); }
    }
  });
}

connectToWhatsApp();

function pushCalendar() {
  try {
    const repo = path.join(DIR, "calendar-repo");
    if (!fs.existsSync(path.join(repo, ".git"))) return;
    fs.copyFileSync(path.join(DIR, "calendar.ics"), path.join(repo, "calendar.ics"));
    const cp = require("child_process");
    const changed = cp.execSync("git -C " + repo + " status --porcelain", { encoding: "utf8" }).trim();
    if (!changed) return;
    cp.execSync("git -C " + repo + " add calendar.ics");
    cp.execSync('git -C ' + repo + ' commit -m "update calendar"');
    cp.execSync("git -C " + repo + " push", { stdio: "ignore" });
    console.log("[Calendar] pushed to git");
  } catch (e) { console.error("calendar push error:", e.message); }
}

function writeCalendar(cfg) {
  try {
    const CRLF = "\r\n";
    const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//VolleyBot//PL", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Siatkówka 🏐", "X-WR-TIMEZONE:Europe/Warsaw"];
    const events = {};
    const hist = loadHistory();
    for (const h of hist) {
      if (h.status === "cancelled" || !h.date) continue;
      events[h.date] = { date: h.date, time: h.gameTime || cfg.defaultTime || "20:00" };
    }
    if (state.activePoll && !state.cancelled && state.activePoll.gameDate) {
      events[state.activePoll.gameDate] = { date: state.activePoll.gameDate, time: state.activePoll.gameTime || cfg.defaultTime || "20:00" };
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    for (const key in events) {
      const e = events[key];
      const dt = e.date.replace(/-/g, "");
      const parts = (e.time || "20:00").split(":");
      const hh = String(parts[0]).padStart(2, "0");
      const mm = String(parts[1] || "00").padStart(2, "0");
      const endHH = String((parseInt(hh, 10) + 2) % 24).padStart(2, "0");
      out.push("BEGIN:VEVENT");
      out.push("UID:game-" + e.date + "@volleybot");
      out.push("DTSTAMP:" + stamp);
      out.push("DTSTART;TZID=Europe/Warsaw:" + dt + "T" + hh + mm + "00");
      out.push("DTEND;TZID=Europe/Warsaw:" + dt + "T" + endHH + mm + "00");
      out.push("SUMMARY:Siatkówka 🏐");
      out.push("END:VEVENT");
    }
    out.push("END:VCALENDAR");
    fs.writeFileSync(path.join(DIR, "calendar.ics"), out.join(CRLF) + CRLF);
    pushCalendar();
  } catch (e) { console.error("calendar error:", e.message); }
}

function backupData() {
  try {
    const dir = path.join(DIR, "backups");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
    const dest = path.join(dir, day);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest);
    for (const f of ["state.json", "history.json", "contacts.json", "config.json"]) {
      const src = path.join(DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
    }
    const entries = fs.readdirSync(dir).filter(function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(x); }).sort();
    while (entries.length > 14) {
      const old = entries.shift();
      fs.rmSync(path.join(dir, old), { recursive: true, force: true });
    }
    console.log("[Backup] saved", day);
  } catch (e) { console.error("backup error:", e.message); }
}

const TZ = loadConfig().timezone || "Europe/Warsaw";

// Monday 10:00 — detect game day from recent messages/poll
cron.schedule("0 10 * * 1", async () => {
  console.log("[Monday check] Scanning for game day info...");
  const cfg = loadConfig();
  if (!cfg.groupJid || !sock) return;
  if (pollIsRecent(state.activePoll) || recentMessages.length > 0) {
    const { detectGameDay } = require("./reminder");
    const question = state.activePoll?.question || "Kiedy gramy w siatkówkę w tym tygodniu?";
    const detected = await detectGameDay(question, recentMessages, cfg);
    if (detected !== (state.gameDay || "friday")) {
      console.log("[Monday check] Game day:", detected, "— rescheduling");
      state.gameDay = detected;
      saveState(state);
      const { scheduleReminders } = require("./scheduler");
      scheduleReminders(sock, state, saveState, cfg, detected);
    } else {
      console.log("[Monday check] Game day confirmed:", detected);
    }
  } else {
    console.log("[Monday check] No messages or poll yet.");
  }
}, { timezone: TZ });

// Tuesday 12:00 — ask group if no poll found yet
cron.schedule("0 12 * * 2", async () => {
  console.log("[Tuesday check] Checking for active poll...");
  const cfg = loadConfig();
  if (!cfg.groupJid || !sock) return;
  if (pollIsRecent(state.activePoll)) {
    console.log("[Tuesday check] Poll exists. No action needed.");
    return;
  }
  console.log("[Tuesday check] No poll — asking group.");
  await sock.sendMessage(cfg.groupJid, { text: "Hej! 🏐 Gramy w tym tygodniu? Jeszcze nie widzę ankiety..." });
  state.askedAboutGame = true;
  saveState(state);
  await notify(sock, cfg, "Brak ankiety do wtorku — zapytałem grupę czy gramy w tym tygodniu.");
}, { timezone: TZ });

// Daily 23:00 — archive the game on its day as "played", stop reminders
cron.schedule("0 23 * * *", () => { archiveIfGamePassed(false); }, { timezone: TZ });

// Monday 08:00 — auto-post the weekly poll (default day/time) if none exists yet
cron.schedule("0 8 * * 1", async () => {
  const cfg = loadConfig();
  if (!cfg.groupJid || !sock) return;
  if (pollIsRecent(state.activePoll) && !state.cancelled) {
    console.log("[Auto-poll] active poll already exists — skipping");
    return;
  }
  console.log("[Auto-poll] posting weekly poll:", cfg.defaultDay, cfg.defaultTime);
  await createPoll(cfg, cfg.defaultDay || "friday", cfg.defaultTime || "20:00", cfg.groupJid);
}, { timezone: TZ });

// Nightly 03:00 — backup data files (keep last 14 days)
cron.schedule("0 3 * * *", backupData, { timezone: TZ });
backupData();

// Calendar ICS feed (subscribable) — regenerate hourly + serve over HTTP
writeCalendar(loadConfig());
cron.schedule("0 * * * *", () => writeCalendar(loadConfig()), { timezone: TZ });
http.createServer((req, res) => {
  if (req.url === "/" || req.url.indexOf("/calendar.ics") === 0 || req.url.indexOf("/siatkowka.ics") === 0) {
    try {
      const ics = fs.readFileSync(path.join(DIR, "calendar.ics"));
      res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8" });
      res.end(ics);
    } catch (e) { res.writeHead(404); res.end("no calendar yet"); }
  } else { res.writeHead(404); res.end(); }
}).listen(loadConfig().calendarPort || 3000, () => console.log("[Calendar] serving on port", loadConfig().calendarPort || 3000));
