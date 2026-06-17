const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const { sendReminder } = require("./reminder");

const DIR = __dirname;

async function run() {
  const config = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
  const state = JSON.parse(fs.readFileSync(path.join(DIR, "state.json"), "utf8"));
  const { state: authState, saveCreds } = await useMultiFileAuthState(path.join(DIR, "auth_info"));

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: authState,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection }) => {
    if (connection === "open") {
      console.log("Connected. Sending reminder for", state.gameDay, "...");
      await sendReminder(sock, state, config, true, state.gameDay);
      console.log("Done.");
      setTimeout(() => process.exit(0), 2000);
    }
  });
}

run().catch(e => { console.error(e.message); process.exit(1); });
