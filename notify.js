// Sends agent activity log to the owner's "Message Yourself" chat.
async function notify(sock, config, text) {
  try {
    const jid = process.env.NOTIFY_JID || config.notifyJid;
    if (!jid || !sock) return;
    const stamp = new Date().toLocaleTimeString("pl-PL", { timeZone: config.timezone || "Europe/Warsaw", hour: "2-digit", minute: "2-digit" });
    await sock.sendMessage(jid, { text: `🤖 [${stamp}] ${text}` });
  } catch (err) {
    console.error("notify error:", err.message);
  }
}

module.exports = { notify };
