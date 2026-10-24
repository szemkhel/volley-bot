// `bot zaloguj` (ZGR-14) end to end: the real module against a fake WhatsApp socket and a local
// HTTP stub of zgrajka.com that checks the Ed25519 signature the way the service does.
// Made-up LIDs and names only; nothing here is a real person or group.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const crypto = require("crypto");
const { createZgrajkaLogin, TOO_MANY_TEXT, DOWN_TEXT } = require("../zgrajkaLogin");
const { ZGRAJKA_SIGNATURE_CONTEXT } = require("../lib");

const GROUP = "120363000000000000@g.us";
const PLAYER = "100000000000001";
const STRANGER = "100000000000009";
const OWNER = "100000000000077";
const SELF_CHAT = "48500000000@s.whatsapp.net";
const CONNECTION = "0b6f4c9e-2d1a-4e7b-9c3f-5a8d1e2f3b4c";
// "ORIGIN" is replaced by the stub with its own address, so the link is on the configured site.
const LINK = "ORIGIN/w/" + "T".repeat(43);

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

// The service: verifies the signature over the exact body, then answers `next()` (status, body).
function stubService(next) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const ok = crypto.verify(null, Buffer.from(ZGRAJKA_SIGNATURE_CONTEXT + raw), publicKey, Buffer.from(req.headers["x-zgrajka-signature"] || "", "base64"));
      requests.push({ path: req.url, body: JSON.parse(raw), signed: ok, type: req.headers["content-type"] });
      const [status, body] = ok ? next(requests.length) : [401, { error: { code: "unauthorized" } }];
      if (status === "drop") return req.socket.destroy();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body).replaceAll("ORIGIN", "http://127.0.0.1:" + server.address().port));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ url: "http://127.0.0.1:" + server.address().port, requests, close: () => server.close() })));
}

function fakeSock({ participants = [PLAYER, OWNER], pnToLid = {} } = {}) {
  const sent = [];
  return {
    sent,
    user: { id: "48500000000:5@s.whatsapp.net", lid: OWNER + ":5@lid" },
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: "x" } }; },
    groupMetadata: async (jid) => {
      assert.strictEqual(jid, GROUP);
      return { participants: participants.map((p) => ({ id: p + "@lid" })) };
    },
    signalRepository: { lidMapping: { getLIDForPN: async (pn) => pnToLid[pn] || null } },
  };
}

function setup(service, sockOpts, opts = {}) {
  const sock = fakeSock(sockOpts);
  const notes = [];
  let clock = Date.parse("2026-10-24T08:00:00Z");
  const login = createZgrajkaLogin({
    getSock: () => sock,
    notifyOwner: async (t) => notes.push(t),
    signingKey: "signingKey" in opts ? opts.signingKey : privateKey,
    nameOf: (lid) => (lid === PLAYER ? "Ania" : null),
    selfChatJid: () => SELF_CHAT,
    now: () => clock,
  });
  const cfg = { groupJid: GROUP, zgrajka: { enabled: true, url: service ? service.url + "/" : "", connectionId: CONNECTION }, ...opts.cfg };
  return { sock, notes, login, cfg, tick: (ms) => (clock += ms) };
}

const groupMsg = (from, fromMe = false) => ({ key: { id: "m" + Math.random(), remoteJid: GROUP, participant: from + "@lid", fromMe }, pushName: "Push" });
const privateMsg = (jid) => ({ key: { id: "p" + Math.random(), remoteJid: jid, fromMe: false }, pushName: "Push" });
const links = (sock) => sock.sent.filter((s) => typeof s.content.text === "string" && s.content.text.includes("/w/"));

test("group: one ✅ on the command, one private message to the sender, nothing posted in the group", async () => {
  const svc = await stubService(() => [201, { url: LINK, expiresAt: "2026-10-24T08:10:00.000Z" }]);
  try {
    const { sock, login, cfg } = setup(svc);
    const msg = groupMsg(PLAYER);
    await login.onGroupCommand(msg, cfg);
    assert.deepStrictEqual(sock.sent.map((s) => s.jid), [GROUP, PLAYER + "@lid"]);
    assert.deepStrictEqual(sock.sent[0].content, { react: { text: "✅", key: msg.key } });
    const dm = sock.sent[1].content.text;
    assert.ok(dm.startsWith("🤖SiatkoBot🤖 Twój link do Zgrajki (ważny 10 minut, tylko dla Ciebie):\n" + LINK.replace("ORIGIN", svc.url)));
    assert.ok(!sock.sent.some((s) => s.jid === GROUP && "text" in s.content));
    assert.strictEqual(svc.requests.length, 1);
    const r = svc.requests[0];
    assert.strictEqual(r.path, "/api/v1/bot/sign-in-links");
    assert.strictEqual(r.signed, true);
    assert.strictEqual(r.type, "application/json");
    assert.strictEqual(r.body.lid, PLAYER);
    assert.strictEqual(r.body.name, "Ania");
    assert.strictEqual(r.body.connectionId, CONNECTION);
    assert.match(r.body.nonce, /^[A-Za-z0-9_-]{16,64}$/);
  } finally { svc.close(); }
});

test("every link goes only to the requester's own chat", async () => {
  const svc = await stubService(() => [201, { url: LINK }]);
  try {
    const { sock, login, cfg, tick } = setup(svc, { participants: [PLAYER, "100000000000002"] });
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    tick(1000);
    await login.onGroupCommand(groupMsg("100000000000002"), cfg);
    tick(1000);
    await login.onPrivateMessage(privateMsg(PLAYER + "@lid"), cfg);
    const got = links(sock).map((s) => s.jid);
    const asked = svc.requests.map((r) => r.body.lid + "@lid");
    assert.deepStrictEqual(got, asked);
  } finally { svc.close(); }
});

test("a repeat within 2 minutes gets only the ✅, no new link and no request", async () => {
  const svc = await stubService(() => [201, { url: LINK }]);
  try {
    const { sock, login, cfg, tick } = setup(svc);
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    tick(119_000);
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    assert.strictEqual(svc.requests.length, 1);
    assert.strictEqual(links(sock).length, 1);
    assert.strictEqual(sock.sent.filter((s) => s.content.react).length, 2);
    tick(2_000);
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    assert.strictEqual(svc.requests.length, 2);
  } finally { svc.close(); }
});

test("private chat: a participant gets the link in that chat; a stranger gets nothing and no request is made", async () => {
  const svc = await stubService(() => [201, { url: LINK }]);
  try {
    const { sock, login, cfg } = setup(svc);
    await login.onPrivateMessage(privateMsg(STRANGER + "@lid"), cfg);
    assert.strictEqual(sock.sent.length, 0);
    assert.strictEqual(svc.requests.length, 0);
    await login.onPrivateMessage(privateMsg(PLAYER + "@lid"), cfg);
    assert.deepStrictEqual(sock.sent.map((s) => s.jid), [PLAYER + "@lid"]);
  } finally { svc.close(); }
});

test("private chat from a phone JID: mapped to the LID, the phone number never reaches the service", async () => {
  const svc = await stubService(() => [201, { url: LINK }]);
  try {
    const phone = "48500000001@s.whatsapp.net";
    const { sock, login, cfg } = setup(svc, { pnToLid: { [phone]: PLAYER + "@lid" } });
    await login.onPrivateMessage(privateMsg(phone), cfg);
    assert.deepStrictEqual(sock.sent.map((s) => s.jid), [phone]);
    assert.strictEqual(svc.requests[0].body.lid, PLAYER);
    assert.ok(!JSON.stringify(svc.requests).includes("48500000001"));
    // No mapping known: silence, no request.
    await login.onPrivateMessage(privateMsg("48500000002@s.whatsapp.net"), cfg);
    assert.strictEqual(svc.requests.length, 1);
  } finally { svc.close(); }
});

test("the owner's own command goes to the owner's self-chat", async () => {
  const svc = await stubService(() => [201, { url: LINK }]);
  try {
    const { sock, login, cfg } = setup(svc);
    await login.onGroupCommand(groupMsg(OWNER, true), cfg);
    assert.deepStrictEqual(links(sock).map((s) => s.jid), [SELF_CHAT]);
    assert.strictEqual(svc.requests[0].body.lid, OWNER);
  } finally { svc.close(); }
});

test("feature off: no message, no reaction, no request", async () => {
  const svc = await stubService(() => [201, { url: LINK }]);
  try {
    const { sock, login, cfg } = setup(svc);
    cfg.zgrajka.enabled = false;
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    await login.onPrivateMessage(privateMsg(PLAYER + "@lid"), cfg);
    assert.strictEqual(sock.sent.length, 0);
    assert.strictEqual(svc.requests.length, 0);
  } finally { svc.close(); }
});

test("player limit: 'Za dużo prób' at most once an hour, to the player only", async () => {
  const svc = await stubService(() => [429, { error: { code: "player_limit" } }]);
  try {
    const { sock, login, cfg, tick } = setup(svc);
    for (let i = 0; i < 3; i++) { await login.onGroupCommand(groupMsg(PLAYER), cfg); tick(5 * 60_000); }
    assert.deepStrictEqual(sock.sent, [{ jid: PLAYER + "@lid", content: { text: TOO_MANY_TEXT } }]);
    tick(60 * 60_000);
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    assert.strictEqual(sock.sent.length, 2);
  } finally { svc.close(); }
});

test("service down: one 'chwilowo nie odpowiada' to the player, one alert to the owner without the token or LID", async () => {
  const svc = await stubService(() => [503, { error: { code: "internal" } }]);
  try {
    const { sock, notes, login, cfg, tick } = setup(svc);
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    tick(60_000);
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    assert.deepStrictEqual(sock.sent, [{ jid: PLAYER + "@lid", content: { text: DOWN_TEXT } }]);
    assert.strictEqual(notes.length, 1);
    assert.ok(!notes[0].includes(PLAYER));
  } finally { svc.close(); }
});

test("unreachable service counts as down", async () => {
  const { sock, notes, login, cfg } = setup({ url: "http://127.0.0.1:9" });
  await login.onGroupCommand(groupMsg(PLAYER), cfg);
  assert.deepStrictEqual(sock.sent.map((s) => s.content.text), [DOWN_TEXT]);
  assert.match(notes[0], /błąd połączenia/);
});

test("a dropped connection is retried once with a fresh nonce", async () => {
  const svc = await stubService((n) => (n === 1 ? ["drop"] : [201, { url: LINK }]));
  try {
    const { sock, login, cfg } = setup(svc);
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    assert.strictEqual(svc.requests.length, 2);
    assert.notStrictEqual(svc.requests[0].body.nonce, svc.requests[1].body.nonce);
    assert.strictEqual(links(sock).length, 1);
  } finally { svc.close(); }
});

test("refused signature (wrong key): nothing to the player, the owner is told, never the link", async () => {
  const svc = await stubService(() => [201, { url: LINK }]);
  try {
    const { sock, notes, login, cfg } = setup(svc, undefined, { signingKey: crypto.generateKeyPairSync("ed25519").privateKey });
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    assert.strictEqual(sock.sent.length, 0);
    assert.match(notes[0], /401/);
  } finally { svc.close(); }
});

test("enabled without a key or URL: silent to the player, one alert to the owner", async () => {
  const { sock, notes, login, cfg } = setup(null, undefined, { signingKey: null });
  await login.onGroupCommand(groupMsg(PLAYER), cfg);
  assert.strictEqual(sock.sent.length, 0);
  assert.strictEqual(notes.length, 1);
});

test("only https (or a local http service) is ever called", async () => {
  const { sock, notes, login, cfg } = setup(null);
  cfg.zgrajka.url = "http://zgrajka.test";
  await login.onGroupCommand(groupMsg(PLAYER), cfg);
  assert.strictEqual(sock.sent.length, 0);
  assert.match(notes[0], /https/);
});

test("a 201 whose link isn't on the configured site is never sent to the player", async () => {
  const svc = await stubService(() => [201, { url: "https://evil.example/w/" + "T".repeat(43) }]);
  try {
    const { sock, notes, login, cfg } = setup(svc);
    await login.onGroupCommand(groupMsg(PLAYER), cfg);
    assert.strictEqual(sock.sent.length, 0);
    assert.match(notes[0], /nieoczekiwaną/);
  } finally { svc.close(); }
});

test("a failing socket never escapes into the message handler", async () => {
  const svc = await stubService(() => [201, { url: LINK }]);
  try {
    const { sock, login, cfg } = setup(svc);
    sock.sendMessage = async () => { throw new Error("Connection Closed"); };
    await assert.doesNotReject(login.onGroupCommand(groupMsg(PLAYER), cfg));
  } finally { svc.close(); }
});
