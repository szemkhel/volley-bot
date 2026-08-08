require("dotenv").config({ path: __dirname + "/.env" });
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, decryptPollVote, jidNormalizedUser, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const crypto = require("crypto");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const http = require("http");
const { notify } = require("./notify");
const { DAY_WORDS, attendanceFromTally, weightOfOptions, parseAnkieta, nextDateForDay, isAdmin, settlementPeople, matchPoll, parseAbsenceDays, activeInjuryLids, reconnectDelay, healthReport, mergeGameRows, attendanceCounts, pickTopByAttendance, daysUntil,
  pollBeatsHistory, looksLikeFullSurname, suggestedInitialName, newAttendeesFromMentions,
  topTiedEntries, mvpWinCount, looksLikeOwnerCommand, looksLikeGameResponse } = require("./lib");

const DIR = __dirname;
const STATE_FILE = path.join(DIR, "state.json");
const CONFIG_FILE = path.join(DIR, "config.json");
const CONTACTS_FILE = path.join(DIR, "contacts.json");
const HISTORY_FILE = path.join(DIR, "history.json");
const MVP_FILE = path.join(DIR, "mvp.json");
const WEEKLOG_FILE = path.join(DIR, "weeklog.json");
const SUGGEST_FILE = path.join(DIR, "suggestions.json");
const PHONE = process.env.PHONE || "";

// Separate stats per chat: in TEST mode (groupJid === testGroupJid) the bot reads/writes *.test.json,
// so testing never pollutes production stats. contacts/config stay shared; calendar = production only.
function isTestMode() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); return !!(c.groupJid && c.testGroupJid && c.groupJid === c.testGroupJid); }
  catch { return false; }
}
let testMode = isTestMode();
function dataFile(base) { return testMode ? base.replace(/\.json$/, ".test.json") : base; }

function loadState() {
  const f = dataFile(STATE_FILE);
  let s = { polls: [], gameDay: "friday", askedAboutGame: false };
  if (fs.existsSync(f)) {
    try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch { s = { polls: [], gameDay: "friday", askedAboutGame: false }; }
  }
  return migrateState(s);
}

// Multi-poll model: state.polls = [ poll, ... ]; each poll has its own voters/gameDay/gameDate/gameTime.
// Migrate the old single-poll shape (activePoll + top-level voters/cancelled) into polls[].
function migrateState(s) {
  if (!Array.isArray(s.polls)) {
    s.polls = [];
    if (s.activePoll && !s.cancelled) {
      s.activePoll.voters = s.voters || {};
      if (!s.activePoll.gameDay) s.activePoll.gameDay = s.gameDay || "friday";
      s.polls.push(s.activePoll);
    }
  }
  for (const p of s.polls) { if (!p.voters) p.voters = {}; if (!p.gameDay) p.gameDay = s.gameDay || "friday"; }
  delete s.activePoll; delete s.voters; delete s.cancelled;
  if (!s.gameDay) s.gameDay = "friday";
  return s;
}

function saveState(state) {
  fs.writeFileSync(dataFile(STATE_FILE), JSON.stringify(state, null, 2));
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

// User-submitted suggestions (`bot sugestia ...`) — mode-aware so test ones don't mix with prod
function loadSuggestions() { try { return JSON.parse(fs.readFileSync(dataFile(SUGGEST_FILE), "utf8")); } catch { return []; } }
function saveSuggestions(s) { fs.writeFileSync(dataFile(SUGGEST_FILE), JSON.stringify(s, null, 2)); }
function addSuggestion(author, text) {
  const s = loadSuggestions();
  s.push({ author: author, text: text, date: new Date().toISOString().slice(0, 10), ts: Date.now() });
  if (s.length > 200) s.shift();
  saveSuggestions(s);
}

// Persistent rolling log of group chat for the hidden weekly feature-proposal job
function loadWeekLog() { try { return JSON.parse(fs.readFileSync(dataFile(WEEKLOG_FILE), "utf8")); } catch { return []; } }
function saveWeekLog(l) { fs.writeFileSync(dataFile(WEEKLOG_FILE), JSON.stringify(l, null, 2)); }
function appendWeekLog(entry) {
  weekLog.push(entry);
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
  weekLog = weekLog.filter(m => (m.ts || 0) > cutoff).slice(-1000);
  saveWeekLog(weekLog);
}

function pollIsRecent(activePoll) {
  return activePoll && (Date.now() - activePoll.timestamp) < 7 * 24 * 60 * 60 * 1000;
}

const BOT_TAG = "🤖SiatkoBot🤖";

let state = loadState();
let contacts = loadContacts();
let weekLog = loadWeekLog();
let recentMessages = [];
let sock = null;
let reminderScheduled = false;
// Always resolve the CURRENT socket: `sock` is reassigned on every reconnect, so cron
// closures must read it live (not capture a stale, closed socket at schedule time).
const getSock = () => sock;
let connDownAt = null;

// Liveness reported by GET /health to the external monitor. Deliberately derived from the
// SOCKET, not the process: systemd said `active` for three days in Jul 2026 while the
// WhatsApp connection was dead and every cron kept happily ticking.
const BOOT_AT = Date.now();
const health = { connected: false, lastOpenAt: null, lastCloseAt: null, lastCloseCode: null, lastMessageAt: null };
let reconnectAttempts = 0;
let reconnectTimer = null;

// One reconnect in flight at a time, with growing delay. Close events can arrive several at
// once (and 405 rejects instantly), so an unguarded immediate retry becomes a request storm.
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay(reconnectAttempts++);
  console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToWhatsApp(); }, delay);
}


// --- Multi-poll helpers ---
function tallyOf(poll) {
  const tally = {};
  let voted = 0;
  const voters = (poll && poll.voters) || {};
  for (const k in voters) {
    voted++;
    const opts = (voters[k] && voters[k].options) || [];
    for (const o of opts) tally[o] = (tally[o] || 0) + 1;
  }
  return { voted, tally };
}
function attendanceOf(poll) {
  if (!poll) return 0;
  return poll.realPlayers != null ? poll.realPlayers : attendanceFromTally(tallyOf(poll).tally);
}
function todayWarsaw() { return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" }); }
// Current Warsaw wall-clock: { date: "YYYY-MM-DD", minutes: H*60+M } — for comparing against reminder fire times
function nowWarsaw() {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
  const [h, m] = now.toLocaleTimeString("en-GB", { timeZone: "Europe/Warsaw", hour12: false }).split(":").map(Number);
  return { date, minutes: h * 60 + m };
}
function allPolls() { return (state.polls || []); }                                  // everything tracked (incl. disabled)
function activePolls() { return allPolls().filter(p => !p.cancelled); }              // not disabled
function upcomingPolls() { const t = todayWarsaw(); return activePolls().filter(p => !p.gameDate || p.gameDate >= t); } // future/today games
function pollsForDay(day) { return upcomingPolls().filter(p => p.gameDay === day); }
function findPoll(day, time) { return matchPoll(activePolls(), day, time); }
// Settlement / "current" target: most recent active poll (by gameDate/timestamp), else null
function primaryPoll() {
  const ps = activePolls();
  if (!ps.length) return null;
  return ps.slice().sort((a, b) => (b.gameDate || "").localeCompare(a.gameDate || "") || (b.timestamp || 0) - (a.timestamp || 0))[0];
}
function removePoll(poll) { state.polls = allPolls().filter(p => p !== poll); }

// A MANUAL `bot przypomnij` this close to the game is a last call, so it should behave like the
// scheduled urgent run — i.e. also chase the "Nie wiem" voters, since there's barely time left to
// cancel the hall. Earlier in the week it stays a gentle nudge.
const LAST_CALL_DAYS = 2;
function isLastCall(poll) {
  const d = daysUntil(poll && poll.gameDate, todayWarsaw());
  return d != null && d <= LAST_CALL_DAYS;
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
  if (!pollUpdate || !voterJid) return;
  const pollKey = pollUpdate.pollCreationMessageKey;
  if (!pollKey || !pollKey.id) return;
  // Route the vote to whichever tracked poll it belongs to (incl. disabled, so votes survive re-enable)
  const poll = allPolls().find(p => p.messageKey && p.messageKey.id === pollKey.id);
  if (!poll) return;
  const phone = voterJid.split("@")[0];
  let options = [];
  try {
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
  if (!poll.voters) poll.voters = {};
  if (options.length === 0) { delete poll.voters[phone]; }
  else { poll.voters[phone] = { jid: voterJid, options }; }
  saveState(state);
  console.log("Vote recorded:", phone, "(" + poll.gameDay + ")", options.length ? "-> " + options.join(", ") : "(empty/retracted)");
}

function loadMvp() { try { return JSON.parse(fs.readFileSync(dataFile(MVP_FILE), "utf8")); } catch { return []; } }
function saveMvp(m) { fs.writeFileSync(dataFile(MVP_FILE), JSON.stringify(m, null, 2)); }

async function recordMvpVote(pollUpdate, voterJid) {
  if (!state.mvpPoll || !pollUpdate) return;
  const pk = pollUpdate.pollCreationMessageKey;
  if (pk && pk.id && pk.id !== state.mvpPoll.messageKey.id) return;
  if (!voterJid) return;
  const phone = voterJid.split("@")[0];
  let option = null;
  try {
    const p = state.mvpPoll;
    if (p.encKeyB64 && pollUpdate.vote) {
      const meta = decryptPollVote(pollUpdate.vote, {
        pollCreatorJid: p.pollCreatorJid,
        pollMsgId: p.messageKey.id,
        pollEncKey: Buffer.from(p.encKeyB64, "base64"),
        voterJid,
      });
      const sel = (meta.selectedOptions || []).map(b => Buffer.from(b).toString("hex"));
      const opts = sel.map(h => p.optionHashes && p.optionHashes[h]).filter(Boolean);
      option = opts[0] || null;
    }
  } catch (e) { console.error("mvp decrypt error:", e.message); }
  if (!option) delete state.mvpPoll.votes[phone];
  else state.mvpPoll.votes[phone] = option;
  saveState(state);
  console.log("MVP vote:", phone, "->", option || "(none)");
}

// Who can be voted MVP: players who declared "yes" (weight > 0) for the most recent PLAYED game.
// Normally that's history's last entry — a settlement archives the game before this runs. But
// settlement can fail (2026-08-07: the AI classifier died on a zero-credit key) and leave a
// played game un-archived; in that case the open poll for that already-happened game is the more
// current source, and using stale history instead silently offers MVP for the WRONG week's
// attendees. pollBeatsHistory() picks whichever is actually newer; a poll for an upcoming
// (not-yet-played) game never qualifies. Shared with offerMvpPoll() so the names in the question
// can't drift from the names on the poll.
function mvpCandidates() {
  const contacts = loadContacts();
  const hist = loadHistory();
  let bestHist = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.status !== "cancelled" && h.attendees && h.attendees.length) { bestHist = h; break; }
  }
  const today = todayWarsaw();
  const playedPoll = activePolls()
    .filter(p => p.gameDate && p.gameDate <= today)
    .sort((a, b) => (b.gameDate || "").localeCompare(a.gameDate || ""))[0] || null;
  if (playedPoll && pollBeatsHistory(playedPoll.gameDate, today, bestHist && bestHist.date)) {
    const out = [];
    for (const phone in playedPoll.voters) {
      if (weightOfOptions(playedPoll.voters[phone].options) > 0) out.push({ phone: phone, name: contacts[phone] || ("Gracz " + phone.slice(-4)) });
    }
    return out;
  }
  if (bestHist) return bestHist.attendees.map(a => ({ phone: a.phone, name: a.name || contacts[a.phone] || ("Gracz " + a.phone.slice(-4)) }));
  return [];
}

// HARD WhatsApp limit: a poll accepts at most 12 options (100 chars each). This is NOT our
// choice — Baileys does not validate it, so sending more just gets the poll rejected server-side
// and no vote appears at all. Do not raise this without a different voting mechanism.
const MVP_MAX_OPTIONS = 12;

async function createMvpPoll(cfg) {
  const all = mvpCandidates();
  if (all.length < 2) { await sock.sendMessage(cfg.groupJid, { text: "Za mało graczy z ostatniego meczu na głosowanie MVP. 🏐" }); return; }
  // More players than poll slots. Keeping the first 12 of an arbitrarily ordered list punished
  // whoever happened to sit past position 12, so pick the most regular players by season
  // attendance instead. Someone is still left out — nothing else fits in a WhatsApp poll — but
  // the choice is now deterministic and defensible, and the omission is reported to the owner.
  let candidates = pickTopByAttendance(all, attendanceCounts(loadHistory()), MVP_MAX_OPTIONS);
  if (all.length > candidates.length) {
    const kept = new Set(candidates.map(c => c.phone));
    const omitted = all.filter(c => !kept.has(c.phone));
    console.log("[MVP] " + omitted.length + " player(s) did not fit the " + MVP_MAX_OPTIONS + "-option poll:", omitted.map(c => c.name).join(", "));
    await notify(sock, cfg, "⚠️ MVP: zagrało " + all.length + " osób, a ankieta WhatsAppa mieści " + MVP_MAX_OPTIONS + ". Wybrałem osoby z najwyższą frekwencją; nie zmieścili się: " + omitted.map(c => c.name).join(", ") + ".");
  }
  const seenN = {};
  const finalOpts = candidates.map(c => { let n = c.name; if (seenN[n]) { seenN[n]++; n = n + " (" + seenN[n] + ")"; } else seenN[n] = 1; return n; });
  const concludeAt = Date.now() + 24 * 60 * 60 * 1000;
  const deadline = new Date(concludeAt).toLocaleString("pl-PL", { timeZone: cfg.timezone || "Europe/Warsaw", weekday: "long", hour: "2-digit", minute: "2-digit" });
  const sent = await sock.sendMessage(cfg.groupJid, { poll: { name: "MVP tygodnia 🏆 — kto był najlepszy? (głosowanie do " + deadline + ")", values: finalOpts, selectableCount: 1 } });
  const optionHashes = {};
  for (const o of finalOpts) optionHashes[crypto.createHash("sha256").update(Buffer.from(o)).digest("hex")] = o;
  const optToPlayer = {};
  candidates.forEach((c, i) => { optToPlayer[finalOpts[i]] = { phone: c.phone, name: c.name }; });
  const secret = sent.message?.messageContextInfo?.messageSecret;
  state.mvpPoll = {
    messageKey: { id: sent.key.id, remoteJid: cfg.groupJid },
    optionHashes, optToPlayer,
    pollCreatorJid: sock.user ? jidNormalizedUser(sock.user.lid || sock.user.id) : cfg.groupJid,
    encKeyB64: secret ? Buffer.from(secret).toString("base64") : null,
    votes: {}, timestamp: Date.now(), concludeAt: concludeAt,
  };
  saveState(state);
  await notify(sock, cfg, "Utworzono głosowanie MVP (" + finalOpts.length + " kandydatów). Zamknięcie za 24h (" + deadline + ").");
  console.log("MVP poll created with", finalOpts.length, "candidates");
}

// Best-effort caricature+haiku surprise for one MVP winner. An OpenAI outage, missing key, or
// network hiccup must never block the MVP announcement text (already sent by the caller) or the
// loop over other tied winners — every failure is caught here and reported to the owner instead.
async function sendMvpCaricature(cfg, winner, winnerPhone) {
  const apiKey = process.env.OPENAI_API_KEY || cfg.openaiApiKey;
  if (!apiKey) { console.log("[MVP Caricature] no OPENAI_API_KEY configured — skipping"); return; }
  try {
    const { loadMeta, AVATARS_DIR } = require("./avatars");
    const { generateCaricature } = require("./mvpCaricature");
    const { generateMvpHaiku, generateMvpHaikuBatch } = require("./reminder");
    const { getPooledText } = require("./textPool");
    const meta = winnerPhone ? loadMeta()[winnerPhone] : null;
    const referenceFile = meta && meta.goodFaceFile ? path.join(AVATARS_DIR, meta.goodFaceFile) : null;
    const guessedGender = meta && meta.guessedGender;
    const haiku = await getPooledText("mvp_haiku", cfg, generateMvpHaikuBatch, () => generateMvpHaiku(winner.name, cfg));
    const img = await generateCaricature(apiKey, referenceFile, guessedGender, haiku);
    await sock.sendMessage(cfg.groupJid, { image: img, caption: BOT_TAG + "\n🏆🎨" });
  } catch (e) {
    console.error("[MVP Caricature] failed for", winner.name, ":", e.message);
    await notify(sock, cfg, "⚠️ Nie udało się wygenerować karykatury MVP dla " + winner.name + ": " + e.message);
  }
}

async function closeMvpPoll(cfg) {
  if (!state.mvpPoll) return;
  const { generateMvpCongrats } = require("./reminder");
  const tally = {};
  for (const phone in state.mvpPoll.votes) { const o = state.mvpPoll.votes[phone]; tally[o] = (tally[o] || 0) + 1; }
  const winners = topTiedEntries(tally);
  const optToPlayer = state.mvpPoll.optToPlayer || {};
  if (!winners.length) {
    await sock.sendMessage(cfg.groupJid, { text: "Nikt nie zagłosował na MVP w tym tygodniu. 🏐" });
    state.mvpPoll = null; saveState(state); return;
  }
  // Consume the poll BEFORE processing winners, not after. Per winner this now awaits a Claude
  // haiku call + an OpenAI image generation (~10-40s combined) — a process restart mid-loop (e.g.
  // an auto-deploy landing at the wrong moment) used to leave state.mvpPoll on disk untouched, so
  // the next hourly cron tick replayed the WHOLE winner list from scratch: duplicate mvp.json
  // entries, duplicate group announcements, duplicate OpenAI-billed images. Clearing it up front
  // means a crash mid-loop can drop a not-yet-processed winner's announcement, but can never
  // duplicate one — losing one message is far cheaper than duplicating paid image generations.
  state.mvpPoll = null; saveState(state);
  const members = await currentMemberPhones(cfg);
  const mvp = loadMvp();
  for (const w of winners) {
    const winner = optToPlayer[w.o] || { name: w.o, phone: null };
    mvp.push({ date: new Date().toISOString().slice(0, 10), phone: winner.phone, name: winner.name, votes: w.c });
    saveMvp(mvp);
    const congrats = await generateMvpCongrats(winner.name, w.c, cfg);
    // An MVP who left the group can't be tagged — fall back to the plain name rather than a dead @tag.
    const winnerPhone = winner.phone ? winner.phone.split("@")[0] : null;
    const canTag = !!winnerPhone && (!members || members.has(winnerPhone));
    if (winnerPhone && !canTag) console.log("[MVP] winner", winner.name, "no longer in the group — no @mention");
    const mentions = canTag ? [winnerPhone + "@lid"] : [];
    const tag = canTag ? ("@" + winnerPhone) : winner.name;
    const nth = mvpWinCount(mvp, winner.phone);
    const nthNote = nth > 1 ? ("\nTo już " + nth + ". raz MVP dla " + winner.name + "! 🏆") : "";
    await sock.sendMessage(cfg.groupJid, { text: "🏆 MVP tygodnia: " + tag + " (" + w.c + " głosów)!\n" + congrats + nthNote, mentions });
    console.log("MVP closed, winner:", winner.name, w.c);
    await sendMvpCaricature(cfg, winner, winnerPhone);
  }
}

async function statystykiText(mentionedJid, cfg) {
  const contacts = loadContacts();
  if (!mentionedJid) return "Oznacz osobę, np. \"bot statystyki @Marek\". 🏐";
  const phone = mentionedJid.split("@")[0];
  const hist = loadHistory();
  const played = hist.filter(h => h.status !== "cancelled");
  let games = 0, lastDate = null;
  for (const h of played) {
    if ((h.attendees || []).some(a => a.phone === phone)) { games++; lastDate = h.date; }
  }
  const livePlaying = activePolls().filter(p => p.voters[phone] && weightOfOptions(p.voters[phone].options) > 0).length;
  games += livePlaying;
  const total = played.length + activePolls().length;
  const pct = total ? Math.round(games / total * 100) : 0;
  const mvpWins = loadMvp().filter(m => m.phone === phone).length;
  const name = contacts[phone] || ("@" + phone);
  let m = "Statystyki — " + name + " 🏐\n";
  m += "Obecność: " + games + " / " + total + " gier (" + pct + "%)\n";
  m += "MVP: " + mvpWins + "x 🏆";
  if (lastDate) m += "\nOstatni trening: " + lastDate;
  return m;
}

// Finalize (move to history + drop) polls only once game date + grace has passed without a rozliczenie.
// Until then a poll stays tracked (key preserved) so it can be re-enabled or settled.
function finalizePolls() {
  const cfg = loadConfig();
  const grace = Number(cfg.finalizeGraceDays) || 3;
  const today = todayWarsaw();
  let changed = false;
  for (const poll of allPolls().slice()) {
    if (!poll.gameDate) continue;
    const cutoff = new Date(poll.gameDate + "T12:00:00");
    cutoff.setDate(cutoff.getDate() + grace);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    if (today > cutoffStr) {
      const status = poll.cancelled ? "cancelled" : "played";
      console.log("[Finalize] closing " + poll.gameDay + " (" + poll.gameDate + ", +" + grace + "d) as " + status);
      archivePoll(poll, status);
      removePoll(poll);
      changed = true;
    }
  }
  if (changed) saveState(state);
}

// Settle a game and close it immediately (rozliczenie = game definitely happened, count known).
// extraAttendees = people @-mentioned to resolve a headcount drift (lib.newAttendeesFromMentions)
// — not in the poll at all, so they need to be merged into the archived attendee list explicitly.
function settleAndClose(people, extraAttendees) {
  const pp = primaryPoll();
  if (pp) { pp.realPlayers = people; archivePoll(pp, "played", extraAttendees); removePoll(pp); saveState(state); return; }
  setRealPlayers(people); // no active poll → history fallback (extraAttendees not applicable)
}

const POLL_OPTIONS = ["Gram", "Nie gram", "Nie wiem", "Gram i przyprowadzam +1", "Gram i przyprowadzam +2"];

function loadHistory() { try { return JSON.parse(fs.readFileSync(dataFile(HISTORY_FILE), "utf8")); } catch { return []; } }
function saveHistory(h) { fs.writeFileSync(dataFile(HISTORY_FILE), JSON.stringify(h, null, 2)); }
// Production history (calendar + dashboard must reflect production regardless of mode)
function loadProdHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return []; } }

function loadProdState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function loadProdMvp() { try { return JSON.parse(fs.readFileSync(MVP_FILE, "utf8")); } catch { return []; } }

// Best-effort mirror of PRODUCTION games into Postgres (powers the public Grafana dashboard).
// Shows: archived history + PLAYED games still sitting as active polls (date passed, not cancelled,
// not yet rozliczone/finalized) so they appear right away. Player count = real headcount once settled,
// else the vote-based estimate. Upcoming (not-yet-played) games are not shown. No-op without DATABASE_URL.
function syncStatsDb() {
  try {
    const hist = loadProdHistory();
    const today = todayWarsaw();
    const contacts = loadContacts();
    const db = require("./db");
    const played = ((loadProdState().polls) || [])
      .filter(p => !p.cancelled && p.gameDate && p.gameDate < today)
      .map(p => {
        const attendees = [];
        for (const phone in (p.voters || {})) if (weightOfOptions(p.voters[phone].options) > 0) attendees.push({ phone: phone, name: contacts[phone] || null });
        return { date: p.gameDate, gameDay: p.gameDay, gameTime: p.gameTime || null, question: p.question, status: "played", voted: tallyOf(p).voted, players: attendanceOf(p), attendees: attendees };
      });
    db.syncFromHistory(mergeGameRows(hist, played)).catch(e => console.error("[db] sync error:", e.message));
    // Roster so players with 0 games still appear: group members + anyone who ever attended.
    const roster = {};
    try {
      const members = JSON.parse(fs.readFileSync(path.join(DIR, "members.json"), "utf8"));
      for (const m of (members || [])) if (m && m.phone) roster[m.phone] = contacts[m.phone] || m.name || null;
    } catch (_) {}
    for (const h of hist) for (const a of (h.attendees || [])) if (a && a.phone && !roster[a.phone]) roster[a.phone] = contacts[a.phone] || a.name || null;
    for (const p of played) for (const a of p.attendees) if (a.phone && !roster[a.phone]) roster[a.phone] = a.name || null;
    const players = Object.keys(roster).map(phone => ({ phone: phone, name: roster[phone] }));
    db.syncRoster(players).catch(e => console.error("[db] roster error:", e.message));
    db.syncMvp(loadProdMvp()).catch(e => console.error("[db] mvp error:", e.message));
  } catch (e) { console.error("[db] sync error:", e.message); }
}

// Appended to ranking/frekwencja/statystyki messages when a public dashboard URL is configured.
function statsLink(cfg) {
  const NL = String.fromCharCode(10);
  return (cfg && cfg.statsUrl) ? (NL + NL + "📊 Więcej danych pod tym linkiem:" + NL + cfg.statsUrl) : "";
}

function archivePoll(poll, status, extraAttendees) {
  if (!poll) return;
  const { voted, tally } = tallyOf(poll);
  status = status || "played";
  if (status !== "cancelled" && voted === 0 && !(extraAttendees && extraAttendees.length)) return;
  const contacts = loadContacts();
  const attendees = [];
  const seenPhones = new Set();
  for (const phone in poll.voters) {
    if (weightOfOptions(poll.voters[phone].options) > 0) { attendees.push({ phone: phone, name: contacts[phone] || null }); seenPhones.add(phone); }
  }
  // Extra attendees named via @mention to resolve a headcount drift — merged in, not counted twice
  // if someone got both a real vote AND a redundant tag.
  for (const e of (extraAttendees || [])) {
    if (!e || !e.phone || seenPhones.has(e.phone)) continue;
    attendees.push({ phone: e.phone, name: contacts[e.phone] || null });
    seenPhones.add(e.phone);
  }
  const hist = loadHistory();
  hist.push({
    date: poll.gameDate || new Date().toISOString().slice(0, 10),
    gameDay: poll.gameDay,
    gameTime: poll.gameTime || null,
    question: poll.question,
    status: status,
    voted: voted,
    tally: tally,
    attendees: attendees,
    players: (poll.realPlayers != null ? poll.realPlayers : attendanceFromTally(tally)),
  });
  if (hist.length > 200) hist.shift();
  saveHistory(hist);
  console.log("Archived poll:", status, poll.gameDay, "players=" + attendanceFromTally(tally) + (extraAttendees && extraAttendees.length ? " (+" + extraAttendees.length + " dopisanych)" : ""));
  if (!testMode) syncStatsDb();
}

// Shared data: last 10 archived games + current in-progress poll → [{date,gameDay,status,players}]
function frekwencjaEntries() {
  const entries = loadHistory().slice(-10).map(h => ({ date: h.date, gameDay: h.gameDay, status: h.status, players: h.players || 0 }));
  const today = todayWarsaw();
  for (const poll of activePolls()) {
    const d = poll.gameDate || today;
    // game already happened (awaiting rozliczenie/finalize) → "grane"; still upcoming → "w toku"
    entries.push({ date: d, gameDay: poll.gameDay, status: (poll.gameDate && poll.gameDate < today) ? "played" : "wtoku", players: attendanceOf(poll) });
  }
  return entries.slice(-10);
}

function frekwencjaText() {
  const NL = String.fromCharCode(10);
  const entries = frekwencjaEntries();
  if (!entries.length) return "Brak danych frekwencji jeszcze. 🏐";
  const lines = entries.map(e => {
    const label = e.status === "cancelled" ? "odwołane" : (e.status === "wtoku" ? "w toku" : "grane");
    return e.date + " graczy: " + e.players + " status: " + label;
  });
  return "Frekwencja 🏐" + NL + lines.join(NL);
}

// Render the latest chart to a PNG Buffer in-memory (no storage); null if nothing/render fails
function frekwencjaChart(cfg) {
  try {
    const entries = frekwencjaEntries();
    if (!entries.length) return null;
    const { renderFrekwencjaChart } = require("./chart");
    return renderFrekwencjaChart(entries, Number(cfg && cfg.optimumPlayers) || 12);
  } catch (e) { console.error("frekwencjaChart error:", e.message); return null; }
}

async function createPoll(cfg, day, time, targetJid) {
  const { DAY_NAMES_PL_ACC } = require("./reminder");
  const { scheduleReminders } = require("./scheduler");
  const gday = day || state.gameDay || "friday";
  const dayPl = DAY_NAMES_PL_ACC[gday] || gday || "";
  const name = "Siatkówka " + dayPl + (time ? " " + time : "") + " 🏐 — gracie?";
  const sent = await sock.sendMessage(targetJid, { poll: { name, values: POLL_OPTIONS, selectableCount: 1 } });

  // Replace any existing tracked poll for the SAME day (re-post, incl. disabled); leave other days intact
  for (const p of allPolls().filter(p => p.gameDay === gday)) removePoll(p);

  const optionHashes = {};
  for (const o of POLL_OPTIONS) optionHashes[crypto.createHash("sha256").update(Buffer.from(o)).digest("hex")] = o;
  const secret = sent.message?.messageContextInfo?.messageSecret;

  const poll = {
    messageKey: { id: sent.key.id, remoteJid: targetJid },
    question: name,
    options: POLL_OPTIONS,
    optionHashes,
    pollCreatorJid: sock.user ? jidNormalizedUser(sock.user.lid || sock.user.id) : targetJid,
    encKeyB64: secret ? Buffer.from(secret).toString("base64") : null,
    gameDay: gday,
    gameTime: time || null,
    gameDate: nextDateForDay(gday),
    voters: {},
    timestamp: Date.now(),
  };
  state.polls.push(poll);
  state.askedAboutGame = false;
  saveState(state);
  scheduleReminders(getSock, state, saveState, cfg);
  console.log("Poll created:", name, "encKey:", secret ? "yes" : "NO");
  return name;
}

// memberPhones = Set of LID user-parts currently in the group, or null when unknown.
// Someone who voted and then LEFT still owes for the game, so they stay in `accounted` and keep
// their line — but they're named in plain text instead of @-tagged, because a mention of a
// non-member renders as a dead tag for everyone in the chat.
// extraAttendees = people @-mentioned to resolve a headcount drift (lib.newAttendeesFromMentions)
// — not in the poll, so unlike a real voter there's no way to know if they'd have brought a
// +1/+2 guest; they're split at the base weight of 1.
function buildSettlement(cost, realPeople, cfg, poll, memberPhones, extraAttendees) {
  const NL = String.fromCharCode(10);
  const perUnit = cost / realPeople;
  const contacts = loadContacts();
  const groups = {};
  let accounted = 0;
  let dropped = 0;
  const voters = (poll && poll.voters) || {};
  for (const phone in voters) {
    const v = voters[phone];
    const w = weightOfOptions(v.options);
    if (w <= 0) continue;
    accounted += w;
    const isMember = !memberPhones || memberPhones.has(phone);
    if (!isMember) dropped++;
    const amount = Math.round(perUnit * w);
    (groups[amount] = groups[amount] || []).push({ jid: v.jid, phone: phone, isMember: isMember });
  }
  for (const e of (extraAttendees || [])) {
    if (!e || !e.phone) continue;
    accounted += 1;
    const isMember = !memberPhones || memberPhones.has(e.phone);
    if (!isMember) dropped++;
    const amount = Math.round(perUnit * 1);
    (groups[amount] = groups[amount] || []).push({ jid: e.jid || (e.phone + "@lid"), phone: e.phone, isMember: isMember });
  }
  const lines = ["Rozliczenie sali:"];
  const mentions = [];
  const amounts = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
  for (const amt of amounts) {
    const people = groups[amt];
    for (const p of people) if (p.isMember) mentions.push(p.jid);
    const tags = people.map(function (p) {
      return p.isMember ? ("@" + p.phone) : (contacts[p.phone] || ("Gracz " + p.phone.slice(-4)));
    }).join(", ");
    lines.push(amt + "pln " + tags);
  }
  if (dropped > 0) console.log("[Settlement]", dropped, "payer(s) no longer in the group — named without @mention");
  const diff = realPeople - accounted;
  if (diff > 0) lines.push("(" + diff + " os. spoza ankiety — ok. " + Math.round(perUnit) + "pln/os.)");
  lines.push("Proszę o wpłatę blikiem na numer " + (cfg.blikNumber || "BRAK"));
  return { text: lines.join(NL), mentions: mentions, accounted: accounted };
}

function setRealPlayers(n) {
  const pp = primaryPoll();
  if (pp) {
    pp.realPlayers = n;
    saveState(state);
    return;
  }
  const hist = loadHistory();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].status === "cancelled") continue;
    const age = Date.now() - new Date((hist[i].date || today) + "T12:00:00").getTime();
    if (age < 3 * 24 * 60 * 60 * 1000) { hist[i].players = n; hist[i].realPlayers = n; saveHistory(hist); if (!testMode) syncStatsDb(); return; }
    break; // most recent non-cancelled game is too old — fall through to create a fresh entry
  }
  // No recent game on record → create a "played" entry (e.g. played without a poll)
  hist.push({ date: today, gameDay: state.gameDay, gameTime: null, question: "rozliczenie", status: "played", voted: 0, tally: {}, attendees: [], players: n, realPlayers: n });
  if (hist.length > 200) hist.shift();
  saveHistory(hist);
  if (!testMode) syncStatsDb();
}

function getCurrentPlayerCount() {
  const pp = primaryPoll();
  if (pp) return attendanceOf(pp);
  const hist = loadHistory();
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].status === "cancelled") continue;
    const age = Date.now() - new Date((hist[i].date) + "T12:00:00").getTime();
    if (age < 3 * 24 * 60 * 60 * 1000) return hist[i].players != null ? hist[i].players : 0;
    break;
  }
  return null;
}

async function detectSettlement(text, authorPhone, cfg) {
  if (!/\d/.test(text) || !/(z[łl]\b|zlotych|pln|blik)/i.test(text)) return;
  const hallCost = Number(cfg.hallCost) || 160;
  const { extractSettlement } = require("./reminder");
  const info = await extractSettlement(text, hallCost, cfg);
  if (info && info.error) {
    // The message passed the keyword gate (looks like a settlement) but we couldn't classify it —
    // most likely the AI call itself failed (e.g. 2026-08-07: the bot's own API key ran out of
    // credits). Staying silent here is how a real settlement went unnoticed for a whole evening;
    // say something instead of pretending nothing happened.
    console.error("[Settlement] extractSettlement failed:", info.error);
    await notify(sock, cfg, "⚠️ Wygląda na rozliczenie, ale nie mogłem go odczytać (" + info.error + "). Sprawdź ręcznie: \"" + text.slice(0, 200) + "\"");
    return;
  }
  if (!info || !info.isSettlement) return;
  const people = settlementPeople(info, hallCost);
  if (!people || people < 2 || people > 50) return;
  const current = getCurrentPlayerCount();
  console.log("[Settlement] detected people=" + people + " current=" + current);
  if (current != null && current === people) {
    settleAndClose(people);
    await sock.sendMessage(cfg.groupJid, { text: "📊 Zapisuję liczbę graczy z rozliczenia: " + people + " i zamykam grę. 🏐" });
    await notify(sock, cfg, "Rozliczenie wykryte: " + people + " graczy (zgodne z zapisem).");
    await offerMvpPoll(cfg, authorPhone);
    return;
  }
  state.pendingPlayerUpdate = { detected: people, current: current, authorPhone: authorPhone, ts: Date.now() };
  saveState(state);
  await sock.sendMessage(cfg.groupJid, { text: "📊 Z rozliczenia wychodzi " + people + " graczy" + (current != null ? " (u mnie zapisane: " + current + ")" : "") + ". Zaktualizować liczbę graczy na " + people + "? Napisz tak/nie, albo oznacz osoby, które mam dodać do dzisiejszych statystyk (np. @Patryk @Kuba)." });
}

// mentionedJids: tagging is an ALTERNATIVE to tak/nie (per the drift question above), so it's
// checked first and wins over any tak/nie text riding along in the same message.
async function handlePlayerUpdateAnswer(text, senderPhone, isFromMe, cfg, mentionedJids) {
  const p = state.pendingPlayerUpdate;
  if (!p) return false;
  if (Date.now() - (p.ts || 0) > 30 * 60 * 1000) { state.pendingPlayerUpdate = null; saveState(state); return false; }
  const allowed = (senderPhone && senderPhone === p.authorPhone) || isAdmin(senderPhone, isFromMe, cfg.admins || [], (cfg.notifyLid || "").split("@")[0]);
  if (mentionedJids && mentionedJids.length) {
    if (!allowed) return false;
    const extra = newAttendeesFromMentions(mentionedJids, primaryPoll());
    state.pendingPlayerUpdate = null; saveState(state);
    if (!extra.length) {
      // Everyone tagged already voted "Gram" — nothing new, same outcome as a plain "tak".
      settleAndClose(p.detected);
      await sock.sendMessage(cfg.groupJid, { text: "✅ Zaktualizowano liczbę graczy na " + p.detected + " i zamknąłem rozliczenie. 🏐" });
      await notify(sock, cfg, "Liczba graczy zaktualizowana z rozliczenia na " + p.detected + ".");
      await offerMvpPoll(cfg, p.authorPhone);
      return true;
    }
    const finalPeople = attendanceOf(primaryPoll()) + extra.length;
    settleAndClose(finalPeople, extra);
    await sock.sendMessage(cfg.groupJid, { text: "✅ Dopisałem " + extra.length + " os. i zamknąłem rozliczenie na " + finalPeople + " graczy. 🏐", mentions: extra.map(e => e.jid) });
    await notify(sock, cfg, "Liczba graczy zaktualizowana z rozliczenia na " + finalPeople + " (+" + extra.length + " dopisanych).");
    await offerMvpPoll(cfg, p.authorPhone);
    return true;
  }
  const low = (text || "").trim().toLowerCase();
  const yes = /^(tak|t|ok|aktualizuj|zaktualizuj|potwierdzam)\b/.test(low);
  const no = /^(nie|n|zostaw|anuluj)\b/.test(low);
  if (!yes && !no) return false;
  if (!allowed) return false;
  if (yes) {
    settleAndClose(p.detected);
    state.pendingPlayerUpdate = null; saveState(state);
    await sock.sendMessage(cfg.groupJid, { text: "✅ Zaktualizowano liczbę graczy na " + p.detected + " i zamknąłem rozliczenie. 🏐" });
    await notify(sock, cfg, "Liczba graczy zaktualizowana z rozliczenia na " + p.detected + ".");
    await offerMvpPoll(cfg, p.authorPhone);
  } else {
    state.pendingPlayerUpdate = null; saveState(state);
    await sock.sendMessage(cfg.groupJid, { text: "Ok, zostawiam " + (p.current != null ? p.current : "obecną liczbę") + " graczy." });
  }
  return true;
}

// A settlement is the moment the game is definitively closed and the attendee list is final —
// the natural point to run an MVP vote. Ask rather than post unprompted: not every game warrants
// one. Fired from every settlement path (auto-detected and `bot rozlicz`), since all of them
// funnel through settleAndClose().
async function offerMvpPoll(cfg, authorPhone) {
  if (state.mvpPoll) return;                      // a vote is already running
  const cands = mvpCandidates();
  if (cands.length < 2) return;                   // createMvpPoll would refuse anyway — don't ask
  state.pendingMvpOffer = { authorPhone: authorPhone || null, ts: Date.now() };
  saveState(state);
  // Same selection rule as createMvpPoll, so the names offered are exactly the names voted on.
  const names = pickTopByAttendance(cands, attendanceCounts(loadHistory()), MVP_MAX_OPTIONS).map(c => c.name).join(", ");
  await sock.sendMessage(cfg.groupJid, { text: "🏆 Zrobić głosowanie MVP za ten mecz?" + String.fromCharCode(10) + "Kandydaci: " + names + "." + String.fromCharCode(10) + "Napisz tak/nie." });
}

async function handleImieConfirmAnswer(text, senderPhone, isFromMe, cfg) {
  const p = state.pendingImieConfirm;
  if (!p) return false;
  if (Date.now() - (p.ts || 0) > 10 * 60 * 1000) { state.pendingImieConfirm = null; saveState(state); return false; }
  const low = (text || "").trim().toLowerCase();
  const yes = /^(tak|t|ok|potwierdzam)\b/.test(low);
  const no = /^(nie|n|anuluj)\b/.test(low);
  if (!yes && !no) return false;
  // Same rule as the other confirmations: whoever asked for the change, or any admin.
  const okToAnswer = (senderPhone && senderPhone === p.authorPhone) || isAdmin(senderPhone, isFromMe, cfg.admins || [], (cfg.notifyLid || "").split("@")[0]);
  if (!okToAnswer) return false;
  state.pendingImieConfirm = null; saveState(state);
  if (yes) {
    contacts[p.phone] = p.name;
    saveContacts(contacts);
    if (!testMode) syncStatsDb();
    await sock.sendMessage(cfg.groupJid, { text: "Zapisałem imię: " + p.name + " ✅ Zaktualizuje się w statystykach i na panelu." });
  } else {
    await sock.sendMessage(cfg.groupJid, { text: "Ok, nie zapisuję. Podaj krótszą wersję, np. z samym inicjałem nazwiska." });
  }
  return true;
}

async function handleMvpOfferAnswer(text, senderPhone, isFromMe, cfg) {
  const p = state.pendingMvpOffer;
  if (!p) return false;
  if (Date.now() - (p.ts || 0) > 30 * 60 * 1000) { state.pendingMvpOffer = null; saveState(state); return false; }
  const low = (text || "").trim().toLowerCase();
  const yes = /^(tak|t|ok|jasne|dawaj|wystaw|potwierdzam)\b/.test(low);
  const no = /^(nie|n|pomiń|pomin|anuluj|bez)\b/.test(low);
  if (!yes && !no) return false;
  // Same rule as the player-count confirmation: whoever posted the settlement, or any admin.
  const allowed = (senderPhone && senderPhone === p.authorPhone) || isAdmin(senderPhone, isFromMe, cfg.admins || [], (cfg.notifyLid || "").split("@")[0]);
  if (!allowed) return false;
  state.pendingMvpOffer = null; saveState(state);
  if (yes) await createMvpPoll(cfg);
  else await sock.sendMessage(cfg.groupJid, { text: "Ok, bez głosowania MVP w tym tygodniu. 🏐" });
  return true;
}

// LID user-parts currently in the group, or null if the lookup fails. Callers must treat null as
// "membership unknown" and FAIL OPEN — a metadata hiccup must never block a settlement or MVP.
async function currentMemberPhones(cfg) {
  try {
    const md = await sock.groupMetadata(cfg.groupJid);
    const set = new Set((md.participants || []).map(p => p.id.split("@")[0]));
    return set.size ? set : null;
  } catch (e) {
    console.error("[Members] group metadata lookup failed:", e.message, "— skipping membership filter");
    return null;
  }
}

async function doSettlement(cfg, cost, people, extraAttendees) {
  const st = buildSettlement(cost, people, cfg, primaryPoll(), await currentMemberPhones(cfg), extraAttendees);
  await sock.sendMessage(cfg.groupJid, { text: st.text, mentions: st.mentions });
  settleAndClose(people, extraAttendees);
  state.pendingRozliczenie = null;
  saveState(state);
  await notify(sock, cfg, "Rozliczenie wysłane: " + cost + "pln / " + people + " osób." + (extraAttendees && extraAttendees.length ? " (+" + extraAttendees.length + " dopisanych)" : ""));
  await offerMvpPoll(cfg, null);
  return true;
}

async function finalizeRozliczenie(cfg) {
  const p = state.pendingRozliczenie;
  if (!p) return false;
  const pollPeople = attendanceOf(primaryPoll());
  if (p.people === pollPeople) {
    return await doSettlement(cfg, p.cost, p.people);
  }
  p.stage = "confirm";
  p.ts = Date.now();
  saveState(state);
  await sock.sendMessage(cfg.groupJid, { text: "💰 Liczby się nie zgadzają — ankieta: " + pollPeople + ", podałeś: " + p.people + ". Rozliczyć na " + p.people + " osób? Napisz tak/nie, albo oznacz osoby, które mam dodać do dzisiejszych statystyk (np. @Patryk @Kuba)." });
  return true;
}

// mentionedJids only matters at the "confirm" stage — tagging is an ALTERNATIVE to tak/nie there,
// so it wins over any tak/nie text in the same message and skips the regex checks entirely.
async function handleRozliczenieAnswer(rtext, cfg, mentionedJids) {
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
    if (mentionedJids && mentionedJids.length) {
      const extra = newAttendeesFromMentions(mentionedJids, primaryPoll());
      // Everyone tagged already voted "Gram" — nothing new to add, fall back to the plain count.
      if (!extra.length) return await doSettlement(cfg, p.cost, p.people);
      const finalPeople = attendanceOf(primaryPoll()) + extra.length;
      return await doSettlement(cfg, p.cost, finalPeople, extra);
    }
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
  for (const poll of activePolls()) {
    for (const phone in poll.voters) {
      if (weightOfOptions(poll.voters[phone].options) <= 0) continue;
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
  // Skip members with 0 attendance AND no known name (pure noise — silent, never-played LIDs)
  const rows = Object.keys(counts)
    .map(function (p) { return { phone: p, name: counts[p].name, count: counts[p].count }; })
    .filter(function (r) { return r.count > 0 || r.name; });
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

// Newest entry in releases.json = the version currently running (reported by /health).
function currentVersion() {
  try { return (JSON.parse(fs.readFileSync(path.join(DIR, "releases.json"), "utf8"))[0] || {}).version || null; }
  catch { return null; }
}

// Release notes ("bot zmiany [n]"): n = how many latest versions (default 1 = current only)
function zmianyText(n) {
  let releases = [];
  try { releases = JSON.parse(fs.readFileSync(path.join(DIR, "releases.json"), "utf8")); } catch {}
  if (!releases.length) return "Brak informacji o wersjach. 🏐";
  const count = Math.max(1, Math.min(n || 1, releases.length));
  const NL = String.fromCharCode(10);
  const blocks = releases.slice(0, count).map(r =>
    "📌 " + r.version + " (" + r.date + ")" + NL + (r.notes || []).map(x => "• " + x).join(NL)
  );
  return "Zmiany w bocie 🏐" + NL + NL + blocks.join(NL + NL);
}

// Status of all (or one day's) tracked games this week
function statusText(dayWord) {
  const { DAY_NAMES_PL_ACC } = require("./reminder");
  let polls = activePolls();
  if (dayWord) { const d = DAY_WORDS[dayWord] || dayWord; polls = pollsForDay(d); }
  if (!polls.length) return dayWord ? ("Brak gry w " + dayWord + " w tym tygodniu. 🏐") : "Nie ma teraz aktywnej ankiety. 🏐";
  const fmt = p => (DAY_NAMES_PL_ACC[p.gameDay] || p.gameDay) + (p.gameTime ? " " + p.gameTime : "");
  if (polls.length === 1) return "Liczba graczy na trening w " + fmt(polls[0]) + " to: " + attendanceOf(polls[0]);
  const NL = String.fromCharCode(10);
  const sorted = polls.slice().sort((a, b) => (a.gameDate || "").localeCompare(b.gameDate || ""));
  return "Gry w tym tygodniu 🏐" + NL + sorted.map(p => "• " + fmt(p) + ": " + attendanceOf(p) + " graczy").join(NL);
}

// Cancel a game. text = full command (after "bot "). Returns {ok,msg,day?}
function doCancel(text) {
  const { DAY_NAMES_PL_ACC } = require("./reminder");
  const rest = text.replace(/^.*?nie\s+gramy/i, "").trim();
  const pa = parseAnkieta(rest);
  const polls = activePolls();
  let target = null;
  if (pa.day) {
    target = findPoll(pa.day, pa.time);
    if (!target) return { ok: false, msg: "Nie znalazłem gry w " + (DAY_NAMES_PL_ACC[pa.day] || pa.day) + (pa.time ? " o " + pa.time : "") + " w tym tygodniu. 🏐" };
  } else {
    if (polls.length === 0) return { ok: false, msg: "Nie ma teraz żadnej zaplanowanej gry do odwołania." };
    if (polls.length > 1) return { ok: false, msg: "Jest kilka gier w tym tygodniu — podaj którą odwołać, np. \"bot nie gramy wtorek\"." };
    target = polls[0];
  }
  // Soft-disable: keep the poll (and its key/votes) so it can be re-enabled with "bot cofnij"
  target.cancelled = true;
  state.lastCancel = { day: target.gameDay, time: target.gameTime || null };
  saveState(state);
  const dpl = DAY_NAMES_PL_ACC[target.gameDay] || target.gameDay;
  return { ok: true, day: target.gameDay, msg: "Ok, odwołuję trening: " + dpl + (target.gameTime ? " o " + target.gameTime : "") + ". (Można przywrócić: bot cofnij) 🏐" };
}

// Undo the last cancellation — re-enable the disabled poll in place (key/votes intact)
function doUndo() {
  const { DAY_NAMES_PL_ACC } = require("./reminder");
  const lc = state.lastCancel;
  let poll = lc ? matchPoll(allPolls().filter(p => p.cancelled), lc.day, lc.time) : null;
  if (!poll) poll = allPolls().filter(p => p.cancelled).slice(-1)[0];
  if (!poll) return { ok: false, msg: "Nie ma czego cofać — w tym tygodniu nic nie było odwołane." };
  poll.cancelled = false;
  state.lastCancel = null;
  saveState(state);
  const dpl = DAY_NAMES_PL_ACC[poll.gameDay] || poll.gameDay;
  return { ok: true, msg: "Cofnięto odwołanie — trening w " + dpl + (poll.gameTime ? " o " + poll.gameTime : "") + " znów aktualny! 🏐" };
}

// Admin "przypomniajki": list still-upcoming reminders for this week's active games.
// Reminder times mirror the scheduler: first = game day −3 @ 18:00, urgent = game day −2 @ 17:00.
function przypomniajkiText() {
  const { DAY_NAMES_PL } = require("./reminder");
  const { DAY_SCHEDULES } = require("./scheduler");
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const addDays = (ymd, delta) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };
  const now = nowWarsaw();
  const isUpcoming = (date, min) => date > now.date || (date === now.date && min > now.minutes);

  const polls = upcomingPolls().slice().sort((a, b) => (a.gameDate || "").localeCompare(b.gameDate || ""));
  const blocks = [];
  for (const poll of polls) {
    const sched = DAY_SCHEDULES[poll.gameDay];
    if (!sched || !poll.gameDate) continue;
    const lines = [];
    if (isUpcoming(addDays(poll.gameDate, -3), 18 * 60)) lines.push("   • pierwsze: " + sched.labels[0]);
    if (isUpcoming(addDays(poll.gameDate, -2), 17 * 60)) lines.push("   • pilne: " + sched.labels[1]);
    if (!lines.length) continue;
    const head = "🏐 " + cap(DAY_NAMES_PL[poll.gameDay] || poll.gameDay) + (poll.gameTime ? " " + poll.gameTime : "");
    blocks.push(head + "\n" + lines.join("\n"));
  }
  if (!blocks.length) return "🔔 Brak nadchodzących przypomnień w tym tygodniu. 🏐";
  return "🔔 Zaplanowane przypomnienia (nadchodzące):\n\n" + blocks.join("\n\n");
}

// Change day/time of a game (single-poll case; ambiguous when multiple)
function applyZmien(text) {
  const { DAY_NAMES_PL_ACC } = require("./reminder");
  const polls = activePolls();
  if (!polls.length) return { ok: false, msg: "Nie ma aktywnej ankiety do zmiany. Najpierw: bot ankieta piątek 20:00" };
  const pa = parseAnkieta(text);
  if (!pa.day && !pa.time) return { ok: false, msg: "Podaj co zmienić, np. \"bot zmień dzień na czwartek\" albo \"bot zmień godzinę 21:00\"." };
  if (polls.length > 1) return { ok: false, msg: "Jest kilka gier w tym tygodniu — zmiana działa gdy jest jedna. Odwołaj wybraną (\"bot nie gramy <dzień>\") i utwórz nową ankietę." };
  const target = polls[0];
  if (pa.day) { target.gameDay = pa.day; target.gameDate = nextDateForDay(pa.day); }
  if (pa.time) target.gameTime = pa.time;
  saveState(state);
  const dpl = DAY_NAMES_PL_ACC[target.gameDay] || target.gameDay;
  return { ok: true, msg: "📢 Zmiana terminu treningu: " + dpl + (target.gameTime ? " o " + target.gameTime : "") + ". Ankieta pozostaje aktualna!" };
}

async function handleGroupCommand(text, cfg, mentioned, senderPhone, isFromMe) {

  const { interpretCommand, sendReminder, DAY_NAMES_PL_ACC } = require("./reminder");
  const { scheduleReminders } = require("./scheduler");
  const reply = async (t) => {
    await sock.sendMessage(cfg.groupJid, { text: t });
    await notify(sock, cfg, "Komenda z grupy: " + JSON.stringify(text));
  };
  // Authorization: owner (fromMe) + configured admins (by lid/phone) can run state-changing commands
  const admins = cfg.admins || [];
  const ownerLidPhone = (cfg.notifyLid || "").split("@")[0];
  const allowed = isAdmin(senderPhone, !!isFromMe, admins, ownerLidPhone);
  const denyIfNotAdmin = async () => {
    if (allowed) return false;
    await sock.sendMessage(cfg.groupJid, { text: "⛔ Ta komenda jest tylko dla adminów. Poproś organizatora." });
    return true;
  };
  if (!text || !text.trim()) {
    await reply("Cześć! 🏐 Komendy: \"bot ankieta piątek 20:00\", \"bot status\", \"bot frekwencja\", \"bot przypomnij\", \"bot nie gramy\".");
    return;
  }
  const low = text.trim().toLowerCase();
  if (low.startsWith("pomoc") || low.startsWith("help")) {
    await reply("Komendy 🏐\nDla wszystkich:\n• bot status — liczba graczy\n• bot frekwencja — frekwencja i trend\n• bot ranking — obecność graczy\n• bot statystyki @osoba — statystyki gracza\n• bot kontuzja <czas> — zgłoś dłuższą przerwę (pomijam Cię w przypomnieniach)\n• bot motywacja — motywacja od bota\n• bot kalendarz — jak dodać kalendarz treningów\n• bot zmiany [ile] — co nowego w bocie\n• bot sugestia <treść> — zaproponuj komendę/funkcję\nTylko admini 🛡️:\n• bot ankieta piątek 20:00 — nowa ankieta\n• bot zmień dzień/godzinę — zmiana terminu\n• bot mvp — głosowanie MVP\n• bot rozlicz — podziel koszt sali\n• bot koszt sali 160 — ustaw koszt wynajmu\n• bot przypomnij — przypomnij teraz\n• bot przypominajki — lista nadchodzących przypomnień\n• bot nie gramy / cofnij odwołanie\n• bot imie @osoba Imię S. — popraw czyjeś imię w statystykach (bez pełnego nazwiska)");
    return;
  }
  if (low.startsWith("sugestia") || low.startsWith("sugestie") || low.startsWith("propozycja") || low.startsWith("pomysł") || low.startsWith("pomysl")) {
    const body = text.replace(/^\s*(sugestia|sugestie|propozycja|pomys[łl])\b[\s:,-]*/i, "").trim();
    if (!body) { await reply("Napisz swoją sugestię po komendzie, np. \"bot sugestia dodaj komendę pogoda na trening\". 💡"); return; }
    const c = loadContacts();
    const author = isFromMe ? "Organizator" : (c[senderPhone] || ("…" + (senderPhone || "").slice(-4)));
    addSuggestion(author, body);
    await reply("Dzięki! 🙌 Zapisałem Twoją sugestię — trafi do przeglądu rozwoju bota.");
    await notify(sock, cfg, "💡 Nowa sugestia od " + author + ": " + body);
    return;
  }
  if (low.startsWith("admin")) {
    if (!isFromMe) { await sock.sendMessage(cfg.groupJid, { text: "⛔ Tylko właściciel może zarządzać adminami." }); return; }
    cfg.admins = cfg.admins || [];
    const c = loadContacts();
    const nameOf = p => c[p] || ("…" + p.slice(-4));
    const targets = (mentioned || []).map(j => j.split("@")[0]);
    if (!targets.length) {
      // "bot admin" with no handle → list current admins
      const names = cfg.admins.map(nameOf);
      await reply("Admini 🛡️: " + (names.length ? names.join(", ") : "(brak — tylko właściciel)"));
      return;
    }
    // "bot admin @osoba" → toggle (add if not admin, remove if already admin)
    const added = [], removed = [];
    for (const t of targets) {
      const i = cfg.admins.indexOf(t);
      if (i >= 0) { cfg.admins.splice(i, 1); removed.push(nameOf(t)); }
      else { cfg.admins.push(t); added.push(nameOf(t)); }
    }
    saveConfig(cfg);
    let m = "";
    if (added.length) m += "Dodano admina 🛡️: " + added.join(", ");
    if (removed.length) m += (m ? "\n" : "") + "Usunięto admina: " + removed.join(", ");
    await reply(m);
    return;
  }
  if (low.startsWith("cofnij")) {
    if (await denyIfNotAdmin()) return;
    const r = doUndo();
    if (r.ok) scheduleReminders(getSock, state, saveState, cfg);
    await reply(r.msg);
    return;
  }
  if (low.startsWith("nie gramy") || low.startsWith("nie gram ")) {
    if (await denyIfNotAdmin()) return;
    const r = doCancel(text);
    scheduleReminders(getSock, state, saveState, cfg);
    await reply(r.msg);
    return;
  }
  if (low.startsWith("status")) {
    const dayWord = Object.keys(DAY_WORDS).find(w => low.includes(w));
    await reply(statusText(dayWord) + statsLink(cfg));
    return;
  }
  if (low.startsWith("rozlicz")) {
    if (await denyIfNotAdmin()) return;
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
    await reply(await rankingText(cfg) + statsLink(cfg));
    return;
  }
  if (low.startsWith("statystyki") || low.startsWith("staty")) {
    await reply(await statystykiText(mentioned && mentioned[0], cfg) + statsLink(cfg));
    return;
  }
  if (low.startsWith("motywacja") || low.startsWith("motywuj")) {
    const { generateMotivation, generateMotivationBatch } = require("./reminder");
    const { getPooledText } = require("./textPool");
    await reply(await getPooledText("motywacja", cfg, generateMotivationBatch, () => generateMotivation(cfg)));
    return;
  }
  if (low.startsWith("zmiany") || low.startsWith("changelog") || low.startsWith("wersja")) {
    const n = parseInt((text.match(/\d+/) || [])[0], 10);
    await reply(zmianyText(n || 1));
    return;
  }
  if (low.startsWith("kalendarz") || low.startsWith("kalendarium") || low.startsWith("calendar")) {
    const url = cfg.calendarUrl || "https://raw.githubusercontent.com/szemkhel/volley-bot/calendar/calendar.ics";
    await reply(
      "📅 Kalendarz treningów\n\n" +
      "Dodaj go do telefonu — będziesz mieć terminy treningów, a zmiana dnia lub godziny zaktualizuje się automatycznie.\n\n" +
      "Link do kalendarza:\n" + url + "\n\n" +
      "• Google Calendar (najłatwiej): wejdź na https://calendar.google.com/calendar/u/0/r/settings/addbyurl , wklej powyższy link i kliknij „Dodaj kalendarz”.\n" +
      "• iPhone: Ustawienia → Kalendarz → Konta → Dodaj konto → Inne → „Dodaj subskrybowany kalendarz” → wklej link."
    );
    return;
  }
  if (low.startsWith("koszt")) {
    const n = (text.match(/\d+([.,]\d+)?/) || [])[0];
    if (!n) { await reply("Koszt sali: " + (cfg.hallCost || 160) + " zł.\nAby zmienić (admin): bot koszt sali 160"); return; }
    if (await denyIfNotAdmin()) return;
    cfg.hallCost = parseFloat(n.replace(",", "."));
    saveConfig(cfg);
    await reply("Ustawiono koszt sali na " + cfg.hallCost + " zł. 🏐");
    return;
  }
  if (low.startsWith("mvp")) {
    if (await denyIfNotAdmin()) return;
    await createMvpPoll(cfg);
    return;
  }
  if (low.startsWith("ankieta") || low.startsWith("pool") || low.startsWith("pula")) {
    if (await denyIfNotAdmin()) return;
    const { day, time } = parseAnkieta(text);
    if (!day) { await reply("Podaj dzień, np. \"bot ankieta piątek 20:00\". 🏐"); return; }
    const name = await createPoll(cfg, day, time, cfg.groupJid);
    await reply("Gotowe — utworzyłem ankietę: " + name);
    return;
  }
  if (low.startsWith("zmień") || low.startsWith("zmien") || low.startsWith("zmiana")) {
    if (await denyIfNotAdmin()) return;
    const r = applyZmien(text);
    if (r.ok) scheduleReminders(getSock, state, saveState, cfg);
    await reply(r.msg);
    return;
  }
  if (low.startsWith("frekwencja") || low.startsWith("statystyki")) {
    const caption = frekwencjaText() + statsLink(cfg);
    const img = frekwencjaChart(cfg);
    if (img) { await sock.sendMessage(cfg.groupJid, { image: img, caption: BOT_TAG + "\n" + caption }); await notify(sock, cfg, "Komenda z grupy: frekwencja (z wykresem)"); }
    else await reply(caption);
    return;
  }
  if (low.startsWith("przypomniajki") || low.startsWith("przypominajki") || low.startsWith("przypomnienia")) {
    if (await denyIfNotAdmin()) return;
    await reply(przypomniajkiText());
    return;
  }
  // Injury/long absence — skip a player in reminders for a period. Self: "bot kontuzja 2 tygodnie".
  // For someone else (admin only): "bot kontuzja @osoba miesiąc". End early: "bot kontuzja koniec".
  if (low.startsWith("kontuz")) {
    const target = (mentioned || [])[0];
    let targetPhone = target ? target.split("@")[0] : senderPhone;
    if (target && !allowed) { await reply("⛔ Kontuzję dla innej osoby może zgłosić tylko admin. Dla siebie: \"bot kontuzja 2 tygodnie\"."); return; }
    if (!targetPhone) { await reply("Nie wiem kogo dotyczy kontuzja — spróbuj z grupy albo oznacz osobę."); return; }
    const rest = text.replace(/^\s*kontuz\w*/i, "").replace(/@\d+/g, "").trim();
    const who = target ? (loadContacts()[targetPhone] || ("@" + targetPhone)) : "Ciebie";
    if (/^(koniec|wracam|zdrow|0)\b/i.test(rest) || rest === "") {
      if (rest === "") { await reply("Podaj czas przerwy, np. \"bot kontuzja 2 tygodnie\" albo \"bot kontuzja miesiąc\". Koniec przerwy: \"bot kontuzja koniec\". 🩹"); return; }
      if (state.injuries) delete state.injuries[targetPhone];
      saveState(state);
      await reply("💪 Koniec przerwy dla " + who + " — znów przypominam o głosowaniu. 🏐");
      return;
    }
    const days = parseAbsenceDays(rest);
    if (!days) { await reply("Nie zrozumiałem czasu. Podaj np. \"bot kontuzja 2 tygodnie\", \"bot kontuzja miesiąc\" albo \"bot kontuzja 5 dni\". 🩹"); return; }
    const d = new Date(todayWarsaw() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days);
    const until = d.toISOString().slice(0, 10);
    state.injuries = state.injuries || {};
    state.injuries[targetPhone] = until;
    saveState(state);
    await reply("🩹 Zapisałem przerwę dla " + who + " do " + until + " (~" + days + " dni). Pomijam w przypomnieniach do tego czasu. Wróć wcześniej: \"bot kontuzja koniec\".");
    return;
  }
  // Any admin can set a player's display name (mention resolves to the LID, matching attendance
  // keys — unlike address-book contacts, which key by phone number and don't propagate in this
  // LID group). Guarded against writing a FULL surname: these names feed the public stats
  // dashboard, so the convention is first name + at most a short initial. Anything longer asks
  // for confirmation instead of silently writing it.
  if (allowed && (low.startsWith("imię") || low.startsWith("imie") || low.startsWith("nazwa"))) {
    const target = (mentioned || [])[0];
    if (!target) { await reply("Oznacz osobę i podaj imię, np. \"bot imie @osoba Krzysztof S.\". 🏐"); return; }
    const phone = target.split("@")[0];
    const name = text.replace(/^\s*(imię|imie|nazwa)\b/i, "").replace(/@\d+/g, "").trim();
    if (!name) { await reply("Podaj imię po oznaczeniu, np. \"bot imie @osoba Krzysztof S.\"."); return; }
    if (looksLikeFullSurname(name)) {
      state.pendingImieConfirm = { phone: phone, name: name, authorPhone: senderPhone, ts: Date.now() };
      saveState(state);
      await reply("\"" + name + "\" wygląda na pełne nazwisko — zwykle zapisujemy tylko inicjał, np. \"" + suggestedInitialName(name) + "\". Zapisać mimo to pełne nazwisko? Napisz tak/nie.");
      return;
    }
    contacts[phone] = name;
    saveContacts(contacts);
    if (!testMode) syncStatsDb();
    await reply("Zapisałem imię: " + name + " ✅ Zaktualizuje się w statystykach i na panelu.");
    return;
  }

  const cmd = await interpretCommand(text, state, cfg);
  console.log("[Group command]", JSON.stringify(text), "->", JSON.stringify(cmd));

  if ((cmd.action === "schedule" || cmd.action === "remind" || cmd.action === "cancel") && await denyIfNotAdmin()) return;

  if (cmd.action === "status") {
    await reply(statusText(null));
  } else if (cmd.action === "schedule" && cmd.day) {
    state.gameDay = cmd.day; state.askedAboutGame = false;
    saveState(state);
    scheduleReminders(getSock, state, saveState, cfg);
    await reply(`Ok, domyślny dzień gry to ${DAY_NAMES_PL_ACC[cmd.day] || cmd.day}. Użyj "bot ankieta ${DAY_NAMES_PL_ACC[cmd.day] || cmd.day} 20:00" by wystawić ankietę. 🏐`);
  } else if (cmd.action === "remind") {
    let total = 0;
    const injured = activeInjuryLids(state.injuries, todayWarsaw());
    for (const poll of activePolls()) { const r = await sendReminder(sock, poll, cfg, isLastCall(poll), injured); if (r && r.count) total += r.count; }
    if (!activePolls().length) await reply("Nie mogę teraz przypomnieć (brak aktywnej ankiety). 🏐");
    else if (total === 0) await reply("Wszyscy już zagłosowali! 🎉");
    else await notify(sock, cfg, "Komenda z grupy: przypomnij -> " + total);
  } else if (cmd.action === "cancel") {
    const r = doCancel(text);
    scheduleReminders(getSock, state, saveState, cfg);
    await reply(r.msg);
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
    testMode = true;
    state = loadState(); weekLog = loadWeekLog();
    scheduleReminders(getSock, state, saveState, cfg);
    await notify(sock, cfg, "🧪 TRYB TESTOWY włączony — osobne statystyki (*.test.json).");
    return;
  }
  if (low === "test off" || low === "produkcja" || low === "prod") {
    if (cfg.realGroupJid) { cfg.groupJid = cfg.realGroupJid; saveConfig(cfg); }
    testMode = false;
    state = loadState(); weekLog = loadWeekLog();
    scheduleReminders(getSock, state, saveState, cfg);
    await notify(sock, cfg, "✅ Tryb PRODUKCYJNY — statystyki produkcyjne.");
    return;
  }
  if (low.startsWith("pomoc") || low.startsWith("help")) {
    await notify(sock, cfg, "Komendy:\n• ankieta piątek 20:00 — nowa ankieta\n• status — liczba graczy\n• zmień dzień na czwartek / godzinę 21:00\n• frekwencja — frekwencja i trend\n• rozlicz — podziel koszt sali\n• ranking — obecność graczy\n• przypomnij — przypomnij teraz\n• przypominajki — lista nadchodzących przypomnień\n• gramy w czwartek — ustaw dzień\n• pomoc — ta lista\n• nie gramy — odwołaj\n• cofnij odwołanie — przywróć trening\n• test on / test off — grupa testowa");
    return;
  }
  // HIDDEN, OWNER-ONLY: manual trigger for the monthly avatar cache (normally runs 1st @ 04:00).
  // Not in pomoc/README — this is plumbing for the MVP caricature feature, not a user command.
  if (low === "avatary" || low === "odśwież avatary" || low === "odswiez avatary") {
    if (!cfg.groupJid) { await notify(sock, cfg, "Brak groupJid."); return; }
    await notify(sock, cfg, "🔄 Zaczynam odświeżać avatary i sprawdzać twarze (AI) — może to potrwać kilka minut, dam znać jak skończę.");
    try {
      const r = await require("./avatars").refreshAvatars(sock, cfg.groupJid, cfg);
      await notify(sock, cfg,
        "📸 Avatary odświeżone: " + r.ok + "/" + r.total + " pobranych zdjęć, " + r.skipped + " bez zdjęcia/prywatność.\n" +
        "🧑‍🎨 Sprawdzenie twarzy: " + r.oneFace + " z jedną twarzą (nadają się na karykaturę), " +
        r.noFace + " bez twarzy, " + r.multiFace + " z kilkoma twarzami (zdjęcie grupowe)" +
        (r.faceCheckFailed ? ", " + r.faceCheckFailed + " błąd sprawdzania" : "") + ".");
    } catch (e) {
      await notify(sock, cfg, "Błąd odświeżania avatarów: " + e.message);
    }
    return;
  }
  // HIDDEN, OWNER-ONLY: manual re-send of the most recent MVP caricature — recovery trigger for
  // when the automated send fails after the poll has already closed (closeMvpPoll only runs once
  // per poll, so a failed caricature never gets a second try on its own). Not in pomoc/README.
  if (low === "karykatura" || low === "wyślij karykaturę" || low === "wyslij karykature") {
    const mvp = loadMvp();
    const last = mvp[mvp.length - 1];
    if (!last) { await notify(sock, cfg, "Brak zapisanych zwycięzców MVP."); return; }
    if (!cfg.groupJid) { await notify(sock, cfg, "Brak groupJid."); return; }
    await notify(sock, cfg, "🔄 Generuję karykaturę dla " + last.name + "...");
    const winnerPhone = last.phone ? last.phone.split("@")[0] : null;
    await sendMvpCaricature(cfg, { name: last.name, phone: last.phone }, winnerPhone);
    await notify(sock, cfg, "Gotowe — sprawdź grupę (jeśli generowanie się nie powiodło, dostałbyś osobny komunikat o błędzie).");
    return;
  }
  if (low.startsWith("cofnij")) {
    const r = doUndo();
    if (r.ok) scheduleReminders(getSock, state, saveState, cfg);
    await notify(sock, cfg, r.msg);
    return;
  }
  if (low.startsWith("przypomniajki") || low.startsWith("przypominajki") || low.startsWith("przypomnienia")) {
    await notify(sock, cfg, przypomniajkiText());
    return;
  }
  if (low.startsWith("nie gramy") || low.startsWith("nie gram ")) {
    const r = doCancel(text);
    scheduleReminders(getSock, state, saveState, cfg);
    await notify(sock, cfg, r.msg);
    return;
  }
  if (low.startsWith("status")) {
    const dayWord = Object.keys(DAY_WORDS).find(w => low.includes(w));
    await notify(sock, cfg, statusText(dayWord));
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
  if (low.startsWith("zmiany") || low.startsWith("changelog") || low.startsWith("wersja")) {
    const n = parseInt((text.match(/\d+/) || [])[0], 10);
    await notify(sock, cfg, zmianyText(n || 1));
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
    const r = applyZmien(text);
    if (r.ok) { scheduleReminders(getSock, state, saveState, cfg); await sock.sendMessage(cfg.groupJid, { text: r.msg }); await notify(sock, cfg, "Zmieniono termin i ogłoszono w grupie."); }
    else await notify(sock, cfg, r.msg);
    return;
  }
  if (low.startsWith("frekwencja") || low.startsWith("statystyki")) {
    const img = frekwencjaChart(cfg);
    const dest = process.env.NOTIFY_JID || cfg.notifyJid;
    if (img && dest) await sock.sendMessage(dest, { image: img, caption: "🤖 " + frekwencjaText() });
    else await notify(sock, cfg, frekwencjaText());
    return;
  }
  // Self-chat doubles as a personal scratchpad — don't spend an AI call classifying notes that
  // obviously aren't bot commands (this used to fire on every single message typed there).
  if (!looksLikeOwnerCommand(text)) { console.log("[Owner command] skipped (no command keywords):", JSON.stringify(text)); return; }
  const cmd = await interpretCommand(text, state, cfg);
  console.log("[Owner command]", JSON.stringify(text), "->", JSON.stringify(cmd));

  if (cmd.action === "status") {
    await notify(sock, cfg, statusText(null));
  } else if (cmd.action === "schedule" && cmd.day) {
    state.gameDay = cmd.day; state.askedAboutGame = false;
    saveState(state);
    scheduleReminders(getSock, state, saveState, cfg);
    await notify(sock, cfg, "Domyślny dzień gry: " + (DAY_NAMES_PL_ACC[cmd.day] || cmd.day));
  } else if (cmd.action === "remind") {
    let total = 0;
    const injured = activeInjuryLids(state.injuries, todayWarsaw());
    for (const poll of activePolls()) { const r = await sendReminder(sock, poll, cfg, isLastCall(poll), injured); if (r && r.count) total += r.count; }
    await notify(sock, cfg, activePolls().length ? ("Przypomnienie wysłane do " + total + " osób.") : "Brak aktywnej ankiety.");
  } else if (cmd.action === "cancel") {
    const r = doCancel(text);
    scheduleReminders(getSock, state, saveState, cfg);
    await notify(sock, cfg, r.msg);
  } else if (cmd.action === "help") {
    await notify(sock, cfg, "Komendy:\n• ankieta piątek 20:00 — nowa ankieta\n• status — liczba graczy\n• zmień dzień na czwartek / godzinę 21:00\n• frekwencja — frekwencja i trend\n• rozlicz — podziel koszt sali\n• ranking — obecność graczy\n• przypomnij — przypomnij teraz\n• gramy w czwartek — ustaw dzień\n• nie gramy — odwołaj\n• cofnij odwołanie — przywróć trening\n• test on / test off — grupa testowa");
  } else {
    await notify(sock, cfg, "Nie zrozumiałem. Spróbuj: \"status\", \"gramy w czwartek\", \"przypomnij teraz\" albo \"nie gramy\".");
  }
}

async function connectToWhatsApp() {
  const config = loadConfig();
  const { state: authState, saveCreds } = await useMultiFileAuthState(path.join(DIR, "auth_info"));

  // Baileys pins a WA Web client version at release time. WhatsApp eventually retires that
  // version and then rejects EVERY connect with `405 Connection Failure` — which is exactly
  // what killed the bot on 2026-07-29. Resolve the current version at connect time instead;
  // if the lookup fails (no network yet), fall back to the bundled one rather than not starting.
  let waVersion = null;
  try {
    waVersion = (await fetchLatestBaileysVersion()).version;
    console.log("[Conn] WA Web version", waVersion.join("."));
  } catch (e) {
    console.error("[Conn] version lookup failed, using bundled default:", e.message);
  }

  sock = makeWASocket({
    logger: pino({ level: process.env.LOG_LEVEL || "warn" }),
    auth: authState,
    printQRInTerminal: false,
    ...(waVersion ? { version: waVersion } : {}),
    // Stability: keep the WS alive against NAT/idle timeouts, don't contest presence with the
    // owner's phone, and use a stable client signature. Mitigates the periodic ~30-60min drops.
    browser: ["Volley Bot", "Chrome", "1.0.0"],
    keepAliveIntervalMs: 15000,
    markOnlineOnConnect: false,
  });

  // Tag every GROUP message with the bot name so members know it's the bot,
  // not the owner's personal account (bot runs on the owner's number).
  const _send = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, content, options) => {
    if (jid && typeof jid === "string" && jid.endsWith("@g.us") && content && typeof content === "object") {
      if (typeof content.text === "string" && content.text.indexOf(BOT_TAG) !== 0) {
        content = Object.assign({}, content, { text: BOT_TAG + "\n" + content.text });
      } else if (content.poll && typeof content.poll.name === "string" && content.poll.name.indexOf(BOT_TAG) !== 0) {
        content = Object.assign({}, content, { poll: Object.assign({}, content.poll, { name: BOT_TAG + " " + content.poll.name }) });
      }
    }
    return _send(jid, content, options);
  };

  sock.ev.on("creds.update", saveCreds);

  // Address-book name (c.name / verifiedName) = owner-set, AUTHORITATIVE → always updates.
  // pushName (c.notify) only fills an empty name (never overwrites a saved one).
  // Handles new contacts AND renames, and re-syncs the dashboard so a name change propagates everywhere.
  const applyContactUpdate = (list) => {
    let changed = false;
    for (const c of (list || [])) {
      if (!c || !c.id) continue;
      const phone = c.id.split("@")[0];
      const book = c.name || c.verifiedName;
      if (book && contacts[phone] !== book) { contacts[phone] = book; changed = true; }
      else if (!contacts[phone] && c.notify) { contacts[phone] = c.notify; changed = true; }
    }
    if (changed) {
      saveContacts(contacts);
      if (!testMode) syncStatsDb();
      console.log("Contacts cache updated:", Object.keys(contacts).length, "entries");
    }
  };
  sock.ev.on("contacts.upsert", applyContactUpdate);
  sock.ev.on("contacts.update", applyContactUpdate);

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
    // Per-poll day is fixed at creation; no global re-detection needed in multi-poll model.
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
      const reason = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === code) || "unknown";
      console.log(`[Conn] closed — statusCode=${code} (${reason}) msg=${lastDisconnect?.error?.message || ""}`);
      health.connected = false;
      health.lastCloseAt = new Date().toISOString();
      health.lastCloseCode = code == null ? null : code;
      if (code !== DisconnectReason.loggedOut) {
        if (!connDownAt) connDownAt = Date.now();
        scheduleReconnect();
      } else {
        console.log("Logged out. Delete auth_info/ and restart.");
        try { fs.writeFileSync(path.join(DIR, "NEEDS_REPAIR.txt"), new Date().toISOString() + " - WhatsApp wylogowany, wymagane ponowne parowanie\n"); } catch (e) {}
      }
    } else if (connection === "open") {
      console.log("WhatsApp connected!");
      health.connected = true;
      health.lastOpenAt = new Date().toISOString();
      reconnectAttempts = 0;   // only a real open resets the backoff — a failed attempt must not
      console.log("[DBG sock.user]", JSON.stringify(sock.user));
      // Seed owner's own name into contacts (own messages are fromMe → never cached otherwise)
      try {
        if (sock.user && sock.user.name) {
          const ownerKey = jidNormalizedUser(sock.user.lid || sock.user.id).split("@")[0];
          if (ownerKey && !contacts[ownerKey]) { contacts[ownerKey] = sock.user.name; saveContacts(contacts); console.log("Seeded owner name:", ownerKey, "->", sock.user.name); }
        }
      } catch (e) { console.error("owner seed error:", e.message); }
      if (connDownAt) {
        const mins = Math.round((Date.now() - connDownAt) / 60000);
        connDownAt = null;
        if (mins >= 3) { try { await notify(sock, config, "✅ Połączenie przywrócone po ~" + mins + " min przerwy."); } catch (e) {} }
      }
      finalizePolls();
      if (!reminderScheduled) {
        reminderScheduled = true;
        const { scheduleReminders } = require("./scheduler");
        scheduleReminders(getSock, state, saveState, config);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    const cfg = loadConfig();
    // Proof that traffic actually flows. `connected` can stay true on a half-open socket,
    // so the monitor gets this as a second, independent signal of real activity.
    if (messages && messages.length) health.lastMessageAt = new Date().toISOString();

    for (const msg of messages) {
      if (!msg.message) continue;
      // Shared across the answer-capture blocks below: @-mentions let an admin resolve a
      // headcount drift by naming who to add, as an alternative to a plain tak/nie.
      const mentionedJid = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

      if ((cfg.notifyJid && msg.key.remoteJid === cfg.notifyJid) || (cfg.notifyLid && msg.key.remoteJid === cfg.notifyLid)) {
        const ctext = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (ctext && !ctext.startsWith("🤖") && !seen(msg.key.id)) await handleOwnerCommand(ctext, cfg);
        continue;
      }

      // Group command interface — Polish trigger "bot ..."
      if (cfg.groupJid && msg.key.remoteJid === cfg.groupJid) {
        const gtext = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (gtext && /^bot\b/i.test(gtext.trim()) && !gtext.startsWith("🤖") && !seen(msg.key.id)) {
          const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const sJid = msg.key.participant || msg.key.remoteJid;
          const sPhone = sJid ? sJid.split("@")[0] : "";
          await handleGroupCommand(gtext.trim().replace(/^bot\b[\s,:]*/i, ""), cfg, mentioned, sPhone, !!msg.key.fromMe);
          continue;
        }
      }

      // Rozliczenie answer capture (before fromMe skip so owner can answer)
      if (state.pendingRozliczenie && cfg.groupJid && msg.key.remoteJid === cfg.groupJid) {
        const rtext = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (rtext && !rtext.startsWith("💰") && !rtext.startsWith("🤖") && !/^bot\b/i.test(rtext)) {
          const done = await handleRozliczenieAnswer(rtext, cfg, mentionedJid);
          if (done) continue;
        }
      }

      // Poll vote via upsert (owner's own vote arrives fromMe)
      const puUp = msg.message.pollUpdateMessage;
      if (puUp) {
        console.log("[DBG vote-upsert] type=" + type + " fromMe=" + msg.key.fromMe + " participant=" + msg.key.participant + " remoteJid=" + msg.key.remoteJid);
        const vjid = msg.key.participant || ((msg.key.fromMe && sock.user) ? jidNormalizedUser(sock.user.id) : msg.key.remoteJid);
        await recordVote(puUp, vjid);
        await recordMvpVote(puUp, vjid);
        continue;
      }

      // Week-log capture (hidden weekly proposal job): all group chat incl. OWNER's own messages,
      // but NOT the bot's own tagged messages, notify echoes, command prompts, or "bot ..." commands.
      if (cfg.groupJid && msg.key.remoteJid === cfg.groupJid) {
        const wtext = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (wtext && wtext.indexOf(BOT_TAG) !== 0 && !wtext.startsWith("🤖") && !wtext.startsWith("💰") && !/^bot\b/i.test(wtext.trim())) {
          const wjid = msg.key.participant || msg.key.remoteJid;
          const wname = msg.key.fromMe ? "Ja (organizator)" : (contacts[wjid?.split("@")[0]] || msg.pushName || wjid?.split("@")[0]);
          appendWeekLog({ sender: wname, text: wtext, ts: Date.now() });
        }
      }

      // Settlement monitor: manual cost-split messages → real player count (incl. owner; before fromMe skip)
      if (cfg.groupJid && msg.key.remoteJid === cfg.groupJid) {
        const stext = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (stext && stext.indexOf(BOT_TAG) !== 0 && !stext.startsWith("🤖") && !stext.startsWith("💰") && !/^bot\b/i.test(stext.trim()) && !seen("money:" + msg.key.id)) {
          const aPhone = (msg.key.participant || msg.key.remoteJid || "").split("@")[0];
          let consumed = false;
          if (state.pendingPlayerUpdate) consumed = await handlePlayerUpdateAnswer(stext, aPhone, !!msg.key.fromMe, cfg, mentionedJid);
          // MVP offer comes AFTER the player-count question, so a "tak" can never be stolen from it.
          // In practice they never overlap: the offer is only created once that one is resolved.
          if (!consumed && state.pendingMvpOffer) consumed = await handleMvpOfferAnswer(stext, aPhone, !!msg.key.fromMe, cfg);
          if (!consumed && state.pendingImieConfirm) consumed = await handleImieConfirmAnswer(stext, aPhone, !!msg.key.fromMe, cfg);
          if (consumed) continue;
          await detectSettlement(stext, aPhone, cfg);
        }
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
              state.gameDay = newDay;
              state.askedAboutGame = false;
              saveState(state);
              const { scheduleReminders } = require("./scheduler");
              scheduleReminders(getSock, state, saveState, cfg);
              const { DAY_NAMES_PL_ACC } = require("./reminder");
              await sock.sendMessage(cfg.groupJid, { text: `Domyślny dzień gry ustawiony na ${DAY_NAMES_PL_ACC[newDay] || newDay}. 🏐` });
              console.log("Default game day set to:", newDay);
            }
          } else if (state.askedAboutGame && looksLikeGameResponse(text)) {
            const { analyzeGameResponse, DAY_NAMES_PL_ACC } = require("./reminder");
            const result = await analyzeGameResponse(recentMessages, cfg);
            if (result.playing === true && result.day) {
              state.askedAboutGame = false;
              saveState(state);
              if (!pollsForDay(result.day).length) {
                const name = await createPoll(cfg, result.day, null, cfg.groupJid);
                console.log("[Game response] Playing on", result.day, "— poll created");
                await notify(sock, cfg, `Grupa potwierdziła grę (${result.day}) — wystawiłem ankietę: ${name}`);
              }
            } else if (result.playing === false) {
              state.askedAboutGame = false;
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
        const optNames = (pollMsg.options || []).map(o => o.optionName);
        const optionHashes = {};
        for (const o of optNames) optionHashes[crypto.createHash("sha256").update(Buffer.from(o)).digest("hex")] = o;
        const secret = msg.message.messageContextInfo?.messageSecret;
        // Determine which day this poll is for, then add/replace that day's poll (don't evict others)
        const { detectGameDay } = require("./reminder");
        const detectedDay = await detectGameDay(pollMsg.name, recentMessages, cfg) || state.gameDay || "friday";
        for (const p of allPolls().filter(p => p.gameDay === detectedDay)) removePoll(p);
        const pa = parseAnkieta(pollMsg.name);
        const poll = {
          messageKey: { id: msg.key.id, remoteJid: msg.key.remoteJid },
          question: pollMsg.name, options: optNames, optionHashes,
          pollCreatorJid: (msg.key.participant || msg.key.remoteJid),
          encKeyB64: secret ? Buffer.from(secret).toString("base64") : null,
          gameDay: detectedDay, gameTime: pa.time || null, gameDate: nextDateForDay(detectedDay),
          voters: {}, timestamp: Date.now(),
        };
        state.polls.push(poll);
        state.askedAboutGame = false;
        saveState(state);
        console.log("Poll tracking started for", detectedDay);
        await notify(sock, cfg, `Wykryto nową ankietę (${detectedDay}): "${pollMsg.name}". Śledzę głosy.`);
        const { scheduleReminders } = require("./scheduler");
        scheduleReminders(getSock, state, saveState, cfg);
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
      if (pu) { await recordVote(pu, voterJid); await recordMvpVote(pu, voterJid); }
      else if (puArr && puArr.length) { for (const p of puArr) { await recordVote(p, voterJid); await recordMvpVote(p, voterJid); } }
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
    const hist = loadProdHistory(); // calendar always reflects production, never test data
    for (const h of hist) {
      if (h.status === "cancelled" || !h.date) continue;
      events[h.date] = { date: h.date, time: h.gameTime || cfg.defaultTime || "20:00" };
    }
    if (!testMode) {
      for (const poll of activePolls()) {
        if (poll.gameDate) events[poll.gameDate] = { date: poll.gameDate, time: poll.gameTime || cfg.defaultTime || "20:00" };
      }
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
    for (const f of ["state.json", "history.json", "contacts.json", "config.json", "mvp.json", "weeklog.json", "suggestions.json", "state.test.json", "history.test.json", "mvp.test.json", "weeklog.test.json", "suggestions.test.json"]) {
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

// Hourly — close the MVP poll 24h after it was posted (new polls carry concludeAt)
cron.schedule("5 * * * *", () => {
  if (state.mvpPoll && state.mvpPoll.concludeAt && Date.now() >= state.mvpPoll.concludeAt) {
    closeMvpPoll(loadConfig()).catch(e => console.error("closeMvpPoll(24h):", e.message));
  }
}, { timezone: TZ });

// Sunday 21:00 — fallback close for any lingering MVP poll (e.g. legacy polls with no concludeAt)
cron.schedule("0 21 * * 0", () => {
  closeMvpPoll(loadConfig()).catch(e => console.error("closeMvpPoll:", e.message));
}, { timezone: TZ });

// Sunday 20:00 — HIDDEN: analyze the week's group chat → DM feature proposals to TEST group ONLY (never the real group)
cron.schedule("0 20 * * 0", async () => {
  const cfg = loadConfig();
  if (!cfg.testGroupJid || !sock) return;
  // Production data ONLY (read files directly, not in-memory weekLog which may be test-mode's)
  let prodLog = [];
  try { prodLog = JSON.parse(fs.readFileSync(WEEKLOG_FILE, "utf8")); } catch {}
  const recent = prodLog.filter(m => Date.now() - (m.ts || 0) < 7 * 24 * 60 * 60 * 1000);
  let suggestions = [];
  try { suggestions = JSON.parse(fs.readFileSync(SUGGEST_FILE, "utf8")); } catch {}
  if (!recent.length && !suggestions.length) { console.log("[FeatureProposals] nothing to analyze — skipping"); return; }
  try {
    const { proposeFeatures } = require("./reminder");
    const text = await proposeFeatures(recent, suggestions, cfg);
    if (text) {
      await sock.sendMessage(cfg.testGroupJid, { text });
      console.log("[FeatureProposals] sent (" + recent.length + " msgs, " + suggestions.length + " suggestions)");
    }
  } catch (e) { console.error("[FeatureProposals] error:", e.message); }
  // Prune the production week-log + clear the processed production suggestion inbox
  try { fs.writeFileSync(WEEKLOG_FILE, JSON.stringify(recent, null, 2)); } catch {}
  if (!testMode) weekLog = recent;
  try { fs.writeFileSync(SUGGEST_FILE, "[]"); } catch {}
}, { timezone: TZ });

// Tuesday 12:00 — ask group if no poll found yet
cron.schedule("0 12 * * 2", async () => {
  console.log("[Tuesday check] Checking for active poll...");
  const cfg = loadConfig();
  if (!cfg.groupJid || !sock) return;
  if (activePolls().length) {
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
cron.schedule("0 23 * * *", () => { finalizePolls(); }, { timezone: TZ });

// Monday — auto-post the weekly poll at 10:00, re-checked hourly until 20:00 as a backstop.
//
// A single transient failure used to cost the whole week: on 2026-08-03 the socket dropped (408)
// in the very second the cron fired, the in-flight send died on WhatsApp's group-metadata query
// (500), the exception escaped the cron callback, and nobody was told — even though the
// connection was back 12s later. Reminders got this protection in v1.11 (scheduler.fireReminder);
// the auto-poll never did. Hence: retry in-place, an hourly backstop, and an owner alert.
//
// `state.autoPollWeek` (= that Monday's date) marks the week as HANDLED, so the backstop can't
// re-post after someone deliberately cancels — pollsForDay() alone would go empty on a cancel
// and the next hourly tick would happily post again.
async function autoPostWeeklyPoll() {
  const cfg = loadConfig();
  if (!cfg.groupJid) return;
  const defDay = cfg.defaultDay || "friday";
  const week = todayWarsaw();   // cron runs Mondays only, so today IS the week key
  if (state.autoPollWeek === week) return;
  if (pollsForDay(defDay).length) {
    console.log("[Auto-poll] poll for", defDay, "already exists — skipping");
    state.autoPollWeek = week; saveState(state);
    return;
  }
  console.log("[Auto-poll] posting weekly poll:", defDay, cfg.defaultTime);
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!getSock()) throw new Error("socket not connected");
      // Read the live socket each attempt — `sock` is reassigned on every reconnect.
      const name = await createPoll(cfg, defDay, cfg.defaultTime || "20:00", cfg.groupJid);
      state.autoPollWeek = week; saveState(state);
      console.log("[Auto-poll] posted:", name);
      return;
    } catch (e) {
      console.error(`[Auto-poll] attempt ${attempt}/${maxAttempts} failed:`, e.message);
      if (attempt === maxAttempts) {
        // Don't mark the week handled — the hourly backstop gets another go.
        try { await notify(getSock(), cfg, "⚠️ Nie udało się wystawić cotygodniowej ankiety (" + e.message + "). Spróbuję ponownie za godzinę."); } catch (_) {}
        return;
      }
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}
cron.schedule("0 10-20 * * 1", autoPostWeeklyPoll, { timezone: TZ });

// Nightly 03:00 — backup data files (keep last 14 days)
cron.schedule("0 3 * * *", backupData, { timezone: TZ });
backupData();

// Mirror production history → Postgres for the public Grafana dashboard (startup + 15-min backstop).
syncStatsDb();
cron.schedule("*/15 * * * *", syncStatsDb, { timezone: TZ });

// Monthly 04:00 on the 1st — refresh cached member avatars (feeds MVP caricatures). Skipped in
// test mode so a test-group run never overwrites the real cache with test-group participants.
cron.schedule("0 4 1 * *", () => {
  const cfg = loadConfig();
  if (testMode || !cfg.groupJid || !sock) return;
  require("./avatars").refreshAvatars(sock, cfg.groupJid, cfg)
    .then(r => console.log("[Avatars] refreshed:", JSON.stringify(r)))
    .catch(e => console.error("[Avatars] refresh error:", e.message));
}, { timezone: TZ });

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
  } else if (req.url === "/health") {
    // Scraped by the external monitor (separate tool, outside this repo). 200 = healthy,
    // 503 = degraded, no answer at all = process dead — all three are meaningful to it.
    // Keep the payload free of secrets and of anything that identifies group members:
    // port 3000 also serves the public calendar feed.
    let needsRepair = false;
    try { needsRepair = fs.existsSync(path.join(DIR, "NEEDS_REPAIR.txt")); } catch (e) {}
    const { code, body } = healthReport(Date.now(), {
      bootAt: BOOT_AT,
      connDownAt,
      needsRepair,
      openPolls: (state.polls || []).filter(p => !p.cancelled).length,
      version: currentVersion(),
      ...health,
    });
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  } else { res.writeHead(404); res.end(); }
}).listen(loadConfig().calendarPort || 3000, () => console.log("[Calendar] serving on port", loadConfig().calendarPort || 3000));
