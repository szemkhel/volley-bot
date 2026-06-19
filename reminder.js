const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

// Stronger model for creative Polish prose; cheap model for classification.
const CREATIVE_MODEL = "claude-sonnet-4-6";
const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

const TEMPLATES = [
  "Hej {mentions}! Piłka woła, głosowanie czeka! Będziecie w {day}? 🏐",
  "{mentions} - ankieta na volleyball w {day} jest otwarta! Dajcie znać czy gracie 😄",
  "Przypomnienie dla {mentions}: jeszcze nie zagłosowaliście na mecz w {day}! 🏐",
];

const DAY_NAMES_PL = {
  friday:    "piątek",
  thursday:  "czwartek",
  wednesday: "środa",
  saturday:  "sobota",
  sunday:    "niedziela",
  monday:    "poniedziałek",
  tuesday:   "wtorek",
};

// Accusative forms for "Zaplanowałem przypomnienia na ..."
const DAY_NAMES_PL_ACC = {
  friday:    "piątek",
  thursday:  "czwartek",
  wednesday: "środę",
  saturday:  "sobotę",
  sunday:    "niedzielę",
  monday:    "poniedziałek",
  tuesday:   "wtorek",
};

function loadContacts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "contacts.json"), "utf8"));
  } catch { return {}; }
}

function stripMarkdown(text) {
  return text
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .trim();
}

async function detectGameDay(pollQuestion, recentMessages, config) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
    const context = recentMessages.slice(-10).map(m => `${m.sender}: ${m.text}`).join("\n");

    const resp = await client.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 20,
      messages: [{
        role: "user",
        content: `Pytanie ankiety: "${pollQuestion}"\n\nOstatnie wiadomości w grupie:\n${context || "(brak)"}\n\n` +
          `Na jaki dzień tygodnia jest zaplanowany mecz siatkarski? ` +
          `Odpowiedz TYLKO jednym słowem po angielsku bez żadnych wyjaśnień: friday, thursday, wednesday, saturday, sunday, monday lub tuesday.`
      }]
    });

    const answer = resp.content[0].text.trim().toLowerCase().split(/\s/)[0];
    const valid = ["friday", "thursday", "wednesday", "saturday", "sunday", "monday", "tuesday"];
    const detected = valid.includes(answer) ? answer : "friday";
    console.log("Detected game day:", detected, "(from:", answer + ")");
    return detected;
  } catch (err) {
    console.error("detectGameDay error:", err.message);
    return "friday";
  }
}

async function analyzeGameResponse(recentMessages, config) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
    const context = recentMessages.slice(-10).map(m => `${m.sender}: ${m.text}`).join("\n");

    const resp = await client.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 60,
      messages: [{
        role: "user",
        content: `Przeanalizuj wiadomości z grupy siatkarskiej:\n${context}\n\n` +
          `Odpowiedz TYLKO w formacie JSON (bez wyjaśnień):\n` +
          `{"playing": true, "day": "friday"} lub {"playing": false, "day": null} lub {"playing": null, "day": null}\n` +
          `playing=true jeśli grupa jasno planuje grać w tym tygodniu.\n` +
          `playing=false jeśli wyraźnie nie grają.\n` +
          `playing=null jeśli nie wiadomo jeszcze.\n` +
          `day = dzień po angielsku (friday/thursday/wednesday/saturday/sunday/monday/tuesday) lub null.`
      }]
    });

    const text = resp.content[0].text.trim();
    const match = text.match(/\{[^}]+\}/);
    if (!match) return { playing: null, day: null };
    const json = JSON.parse(match[0]);
    const valid = ["friday", "thursday", "wednesday", "saturday", "sunday", "monday", "tuesday"];
    return {
      playing: typeof json.playing === "boolean" ? json.playing : null,
      day: valid.includes(json.day) ? json.day : null,
    };
  } catch (err) {
    console.error("analyzeGameResponse error:", err.message);
    return { playing: null, day: null };
  }
}

async function generateReminder(nonVoters, config, isUrgent, gameDay = "friday") {
  const contacts = loadContacts();
  const names = nonVoters.map(v => v.name || contacts[v.phone] || v.phone);
  const dayPl = DAY_NAMES_PL[gameDay] || "piątek";

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });

    const urgency = isUrgent
      ? `To ostatnie przypomnienie przed ${dayPl}iem - musimy wiedzieć czy rezerwować kort!`
      : `To pierwsze przypomnienie w tym tygodniu.`;

    const resp = await client.messages.create({
      model: CREATIVE_MODEL,
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Napisz krótką wiadomość po polsku (1-2 zdania) do grupy znajomych przypominającą o głosowaniu w ankiecie na volleyball w ${dayPl}. ` +
          `Ton: ciepły, żartobliwy i koleżeński - jakbyś pisał do przyjaciół. Zero złośliwości ani zawstydzania. ` +
          `Bez formatowania markdown (bez #, **, itp). ` +
          urgency + ` Osoby które nie głosowały: ${names.join(", ")}. ` +
          `Użyj @imię dla każdej osoby dokładnie tak jak podano, bez polskich znaków w @wzmiankach.`
      }]
    });

    return stripMarkdown(resp.content[0].text);
  } catch (err) {
    console.error("Claude API error:", err.message);
    return fallback(nonVoters, contacts, dayPl);
  }
}

function fallback(nonVoters, contacts = {}, dayPl = "piątek") {
  const mentions = nonVoters.map(v => "@" + (v.name || contacts[v.phone] || v.phone)).join(", ");
  const t = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  return t.replace("{mentions}", mentions).replace("{day}", dayPl);
}

async function sendReminder(sock, state, config, isUrgent, gameDay) {
  if (!state.activePoll) {
    console.log("No active poll. Skipping reminder.");
    return { skipped: "no active poll" };
  }
  if (!config.groupJid) {
    console.log("Group JID not set. Skipping reminder.");
    return { skipped: "no group jid" };
  }

  try {
    const contacts = loadContacts();
    const metadata = await sock.groupMetadata(config.groupJid);
    const participants = metadata.participants.map(p => ({
      jid: p.id,
      phone: p.id.split("@")[0],
      name: p.notify || contacts[p.id.split("@")[0]] || null,
    }));

    const nonVoters = participants.filter(p => !state.voters[p.phone]);

    if (nonVoters.length === 0) {
      console.log("Everyone voted! No reminder needed.");
      return { everyoneVoted: true };
    }

    const day = gameDay || state.gameDay || "friday";
    console.log("Sending reminder to", nonVoters.length, "non-voters (game day:", day + ")...");
    let text = await generateReminder(nonVoters, config, isUrgent, day);

    for (const v of nonVoters) {
      const displayName = v.name || v.phone;
      text = text.replace(new RegExp("@" + displayName, "gi"), "@" + v.phone);
    }

    const mentions = nonVoters.map(v => v.jid);
    await sock.sendMessage(config.groupJid, { text, mentions });
    console.log("Reminder sent!");
    return { count: nonVoters.length, day };
  } catch (err) {
    console.error("Failed to send reminder:", err.message);
    return { error: err.message };
  }
}


async function interpretCommand(text, state, config) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
    const resp = await client.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 60,
      messages: [{
        role: "user",
        content: `Jesteś parserem komend dla bota przypominającego o siatkówce. Właściciel pisze (po polsku lub angielsku): "${text}"

` +
          `Sklasyfikuj intencję i odpowiedz TYLKO w JSON bez wyjaśnień:
` +
          `{"action":"status"} - pyta o stan/harmonogram/kto głosował
` +
          `{"action":"schedule","day":"thursday"} - chce ustawić dzień gry (day po angielsku)
` +
          `{"action":"remind"} - chce wysłać przypomnienie teraz
` +
          `{"action":"cancel"} - nie gramy w tym tygodniu / wyłącz przypomnienia
` +
          `{"action":"help"} - pyta co potrafisz
` +
          `{"action":"none"} - niejasne
` +
          `Dni: friday, thursday, wednesday, saturday, sunday, monday, tuesday.`
      }]
    });
    const m = resp.content[0].text.trim().match(/\{[^}]+\}/);
    if (!m) return { action: "none" };
    const j = JSON.parse(m[0]);
    const valid = ["friday","thursday","wednesday","saturday","sunday","monday","tuesday"];
    return { action: j.action || "none", day: valid.includes(j.day) ? j.day : null };
  } catch (err) {
    console.error("interpretCommand error:", err.message);
    return { action: "none" };
  }
}

async function generateMotivation(config) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
    const resp = await client.messages.create({
      model: CREATIVE_MODEL,
      max_tokens: 150,
      messages: [{
        role: "user",
        content: "Napisz krótką (1-2 zdania) wiadomość motywacyjną po polsku dla grupy znajomych grających w siatkówkę. Energiczna, żartobliwa, koleżeńska, może z jednym emoji 🏐. KONIECZNIE poprawna i naturalna polszczyzna — bez błędów gramatycznych, ortograficznych ani dziwnych sformułowań/kalek językowych. Bez formatowania markdown. Za każdym razem inna i kreatywna."
      }]
    });
    return stripMarkdown(resp.content[0].text);
  } catch (err) {
    console.error("generateMotivation error:", err.message);
    return "Dawajcie na trening, forma sama się nie zrobi! 🏐💪";
  }
}

async function generateMvpCongrats(name, votes, config) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
    const resp = await client.messages.create({
      model: CREATIVE_MODEL,
      max_tokens: 150,
      messages: [{
        role: "user",
        content: `Napisz krótkie (1-2 zdania) gratulacje po polsku dla gracza o imieniu "${name}", wybranego MVP tygodnia w siatkówce (${votes} głosów). Ciepłe, żartobliwe, koleżeńskie, z emoji 🏆🏐. KONIECZNIE poprawna, naturalna polszczyzna bez błędów językowych. Bez markdown.`
      }]
    });
    return stripMarkdown(resp.content[0].text);
  } catch (err) {
    console.error("generateMvpCongrats error:", err.message);
    return `Gratulacje ${name}! 🏆 Zasłużone MVP tygodnia! 🏐`;
  }
}

// Hidden weekly job: analyze the week's group chat → propose NEW bot commands/features (test group only)
async function proposeFeatures(messages, config) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
    const convo = messages.slice(-250).map(m => `${m.sender}: ${m.text}`).join("\n").slice(-7000);
    const existing = "ankieta, status, frekwencja, ranking, statystyki, mvp, motywacja, zmień, gramy, nie gramy, cofnij, rozlicz, przypomnij, pomoc, admin";
    const resp = await client.messages.create({
      model: CREATIVE_MODEL,
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `Jesteś asystentem rozwijającym bota WhatsApp dla grupy siatkarskiej. Bot ma już komendy: ${existing}.\n\n` +
          `Rozmowy z grupy z ostatniego tygodnia:\n${convo || "(brak rozmów)"}\n\n` +
          `Na podstawie tych rozmów zaproponuj 2-4 NOWE, konkretne komendy lub funkcje bota, które realnie pomogłyby tej grupie. Nie powtarzaj istniejących komend. ` +
          `Dla każdej propozycji: krótka nazwa komendy oraz jedno zdanie po co. Poprawna, naturalna polszczyzna, bez markdown. Zacznij od linijki "💡 Propozycje rozwoju bota (na podstawie rozmów z tygodnia):". ` +
          `WAŻNE: NIE wymyślaj na siłę. Jeśli z rozmów nie wynikają żadne sensowne, nowe pomysły, odpowiedz DOKŁADNIE: "Brak nowych pomysłów na rozwój bota w tym tygodniu. 🤖" i nic poza tym (bez nagłówka, bez listy).`
      }]
    });
    return resp.content[0].text.trim();
  } catch (err) {
    console.error("proposeFeatures error:", err.message);
    return null;
  }
}

// Extract real player count from a manual cost-split message (e.g. "po 14,55zł (160/11)... BLIK")
async function extractSettlement(text, hallCost, config) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey });
    const resp = await client.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 90,
      messages: [{
        role: "user",
        content: `Wiadomość z grupy siatkarskiej: "${text}"\n\n` +
          `Czy to rozliczenie kosztu wynajmu sali po treningu (podział kwoty między graczy, zwykle z prośbą o BLIK)? ` +
          `Pomocniczo: stały koszt sali to ${hallCost} zł.\n` +
          `Odpowiedz TYLKO w JSON, bez wyjaśnień: {"isSettlement": true/false, "people": liczba_lub_null, "total": kwota_calkowita_lub_null, "perPerson": kwota_na_osobe_lub_null}. ` +
          `"people" = na ile osób podzielono koszt (dzielnik, np. z "160/11" to 11). Jeśli czegoś nie ma w wiadomości, daj null.`
      }]
    });
    const m = resp.content[0].text.trim().match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    return {
      isSettlement: j.isSettlement === true,
      people: typeof j.people === "number" ? j.people : null,
      total: typeof j.total === "number" ? j.total : null,
      perPerson: typeof j.perPerson === "number" ? j.perPerson : null,
    };
  } catch (err) {
    console.error("extractSettlement error:", err.message);
    return null;
  }
}

module.exports = { sendReminder, generateReminder, detectGameDay, analyzeGameResponse, interpretCommand, generateMotivation, generateMvpCongrats, proposeFeatures, extractSettlement, DAY_NAMES_PL_ACC };
