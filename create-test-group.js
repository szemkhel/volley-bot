const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, "config.json");

async function run() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(path.join(DIR, "auth_info"));
  const sock = makeWASocket({ logger: pino({ level: "silent" }), auth: authState, printQRInTerminal: false });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection }) => {
    if (connection !== "open") return;
    try {
      console.log("Connected. Creating test group...");
      const meta = await sock.groupCreate("Volley TEST 🏐🧪", []);
      console.log("Created group JID:", meta.id);
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      cfg.testGroupJid = meta.id;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      console.log("Saved testGroupJid to config.json");
      setTimeout(() => process.exit(0), 1500);
    } catch (err) {
      console.error("Create failed:", err.message);
      setTimeout(() => process.exit(1), 1000);
    }
  });
}
run().catch(e => { console.error(e.message); process.exit(1); });
