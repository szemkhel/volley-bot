// `bot zaloguj` (ZGR-14): a player gets a one-time zgrajka.com sign-in link in a private message.
// Being in the group is the proof of who they are, so the bot only ever asks for a link for
// someone it has just seen write in the group (or a group participant writing to it privately),
// and only ever sends that link to that person's own chat.
//
// Needs only node built-ins and lib.js (no Baileys), so the whole flow is tested in CI against a
// fake socket and a local HTTP stub of the service (test/zgrajkaLogin.test.js).
//
// Never logged or sent to notify(): the link, its token, the player's LID or name.

const crypto = require("crypto");
const {
  isDroppedConnection, zgrajkaSignInBody, signZgrajkaBody, zalogujCoolingDown, lidUserOf,
} = require("./lib");

const BOT_TAG = "🤖SiatkoBot🤖";
const HOUR = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const linkText = (url) =>
  BOT_TAG + " Twój link do Zgrajki (ważny 10 minut, tylko dla Ciebie):\n" + url +
  "\n\nNie przekazuj go nikomu. Jeśli to nie Ty, zignoruj tę wiadomość.";
const TOO_MANY_TEXT = BOT_TAG + " Za dużo prób logowania. Spróbuj ponownie za godzinę.";
const DOWN_TEXT = BOT_TAG + " Zgrajka chwilowo nie odpowiada. Spróbuj za kilka minut.";

// getSock: a getter, never the socket itself — Baileys reconnects and replaces it (CLAUDE.md).
// notifyOwner(text): DM to the owner's self-chat. nameOf(lid): name from contacts.json, if any.
// selfChatJid(cfg): where the owner's own link goes (the chat notify() writes to).
function createZgrajkaLogin({
  getSock,
  notifyOwner,
  signingKey,
  nameOf = () => null,
  selfChatJid = (cfg) => cfg.notifyJid || cfg.notifyLid,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  newNonce = () => crypto.randomBytes(16).toString("base64url"),
}) {
  const lastLinkAt = new Map(); // LID → ms of the last link sent (2-minute cooldown)
  const tooManyAt = new Map(); // LID → ms of the last "Za dużo prób" (at most once an hour)
  const downAt = new Map(); // LID → ms of the last "chwilowo nie odpowiada"
  let ownerAlertAt = -Infinity; // one owner alert an hour, whatever the cause

  async function alertOwner(text) {
    if (now() - ownerAlertAt < HOUR) return;
    ownerAlertAt = now();
    try { await notifyOwner("🔑 Zgrajka (bot zaloguj): " + text); } catch (e) { console.error("[zaloguj] notify failed:", e.message); }
  }

  // The requester's LID: a LID JID directly, a phone JID only through Baileys' own LID mapping.
  // Without a LID the bot does nothing: a phone number never goes to the service.
  async function lidOf(jid) {
    const direct = lidUserOf(jid);
    if (direct) return direct;
    try {
      const mapped = await getSock().signalRepository?.lidMapping?.getLIDForPN?.(jid);
      return lidUserOf(mapped);
    } catch {
      return null;
    }
  }

  // Fails closed: if the group can't be read, nobody gets a link from a private chat.
  async function isParticipant(cfg, lid) {
    try {
      const md = await getSock().groupMetadata(cfg.groupJid);
      return (md.participants || []).some((p) => lidUserOf(p.id) === lid || lidUserOf(p.lid) === lid);
    } catch (e) {
      console.error("[zaloguj] group metadata lookup failed:", e.message);
      return false;
    }
  }

  // A fresh body (timestamp, nonce, signature) per attempt: if the first attempt did reach the
  // service before the connection broke, repeating its nonce would only get a 401 (replay).
  async function post(cfg, lid, name) {
    const z = cfg.zgrajka;
    const once = () => {
      const body = zgrajkaSignInBody({ connectionId: z.connectionId, lid, name, ts: now(), nonce: newNonce() });
      return fetchImpl(z.url.replace(/\/+$/, "") + "/api/v1/bot/sign-in-links", {
        method: "POST",
        headers: { "content-type": "application/json", "x-zgrajka-signature": signZgrajkaBody(body, signingKey) },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    };
    try {
      return await once();
    } catch (e) {
      if (!isDroppedConnection(e)) throw e;
      return await once();
    }
  }

  // Asks for the link and delivers it. `replyJid` is the requester's own chat, the only place a
  // link or a notice about it is ever sent. `reactKey` is the group message to put ✅ on.
  async function deliver(cfg, lid, pushName, replyJid, reactKey) {
    const z = cfg.zgrajka || {};
    const sock = () => getSock();
    const react = async () => { if (reactKey) await sock().sendMessage(cfg.groupJid, { react: { text: "✅", key: reactKey } }); };

    if (zalogujCoolingDown(lastLinkAt, lid, now())) { await react(); return; }
    if (!z.url || !z.connectionId || !signingKey) {
      await alertOwner("włączone, ale brakuje zgrajka.url, zgrajka.connectionId albo klucza ZGRAJKA_BOT_SIGNING_KEY.");
      return;
    }

    let res = null;
    let failure = null;
    try {
      res = await post(cfg, lid, nameOf(lid) || pushName);
    } catch (e) {
      failure = e.name === "TimeoutError" ? "brak odpowiedzi w 10 s" : "błąd połączenia (" + (e.cause?.code || e.name) + ")";
    }

    if (res && res.status === 201) {
      const { url } = await res.json();
      lastLinkAt.set(lid, now());
      await react();
      await sock().sendMessage(replyJid, { text: linkText(url) });
      return;
    }
    const code = res ? await res.json().then((j) => j?.error?.code, () => null) : null;
    if (res && res.status === 429 && code === "player_limit") {
      if (now() - (tooManyAt.get(lid) ?? -Infinity) >= HOUR) {
        tooManyAt.set(lid, now());
        await sock().sendMessage(replyJid, { text: TOO_MANY_TEXT });
      }
      return;
    }
    if (res && res.status === 401) {
      // Nothing to the player: this is the bot's setup (key, connection id, clock), not theirs.
      await alertOwner("Zgrajka odrzuciła podpisane żądanie (HTTP 401). Sprawdź klucz, connectionId i zegar.");
      return;
    }
    await alertOwner(failure || (code === "bot_limit" ? "limit linków dla bota na tę godzinę." : "HTTP " + (res ? res.status : "?")));
    if (now() - (downAt.get(lid) ?? -Infinity) >= 10 * 60 * 1000) {
      downAt.set(lid, now());
      await sock().sendMessage(replyJid, { text: DOWN_TEXT });
    }
  }

  return {
    // "bot zaloguj" in the group. The link goes to the sender's own chat; the owner's own
    // command (fromMe) goes to the owner's self-chat. The group itself gets only the ✅.
    async onGroupCommand(msg, cfg) {
      if (!cfg.zgrajka?.enabled) return;
      if (msg.key.fromMe) {
        const lid = lidUserOf(getSock().user?.lid);
        const self = selfChatJid(cfg);
        if (lid && self) await deliver(cfg, lid, msg.pushName, self, msg.key);
        return;
      }
      const lid = await lidOf(msg.key.participant);
      if (!lid) return;
      await deliver(cfg, lid, msg.pushName, lid + "@lid", msg.key);
    },

    // "zaloguj" written to the bot's number privately: answered in that chat, and only for
    // people who are in the group. Anyone else gets silence and no request is made.
    async onPrivateMessage(msg, cfg) {
      if (!cfg.zgrajka?.enabled || msg.key.fromMe) return;
      const lid = await lidOf(msg.key.remoteJid);
      if (!lid || !(await isParticipant(cfg, lid))) return;
      await deliver(cfg, lid, msg.pushName, msg.key.remoteJid, null);
    },
  };
}

module.exports = { createZgrajkaLogin, linkText, TOO_MANY_TEXT, DOWN_TEXT };
