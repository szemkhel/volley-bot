const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, "config.json");

const argNumber = process.argv[2] ? parseInt(process.argv[2]) : null;

async function run() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(path.join(DIR, "auth_info"));

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: authState,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection }) => {
    if (connection !== "open") return;

    console.log("Connected. Fetching groups...\n");

    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups)
      .filter(g => g.subject)
      .sort((a, b) => a.subject.localeCompare(b.subject));

    list.forEach((g, i) => {
      console.log(`[${i + 1}] ${g.subject} (${g.participants.length} members) — ${g.id}`);
    });

    if (argNumber === null) {
      console.log("\nRun again with the group number to select it: node find-group.js <number>");
      process.exit(0);
    }

    const idx = argNumber - 1;
    if (isNaN(idx) || !list[idx]) {
      console.log("Invalid choice.");
      process.exit(1);
    }

    const chosen = list[idx];
    console.log(`\nSelected: ${chosen.subject}`);
    console.log(`JID: ${chosen.id}`);
    console.log(`Members (${chosen.participants.length}):`);

    const members = chosen.participants.map(p => ({
      jid: p.id,
      phone: p.id.split("@")[0],
      name: p.notify || null,
    }));
    members.forEach(m => console.log(`  ${m.name || "(no name)"} — ${m.phone}`));

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    config.groupJid = chosen.id;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(DIR, "members.json"), JSON.stringify(members, null, 2));

    console.log("\nSaved groupJid to config.json and members to members.json.");
    process.exit(0);
  });
}

run().catch(e => { console.error(e.message); process.exit(1); });
