// Monthly local cache of group members' WhatsApp profile pictures — the source images for the
// MVP caricature feature. Fetched on a cron, not per-MVP: most people's avatars barely change
// week to week, and this keeps caricature generation from ever needing a live WhatsApp round trip.
// Stored under avatars/ (gitignored — real people's photos never belong in a public repo).
const fs = require("fs");
const path = require("path");

const AVATARS_DIR = path.join(__dirname, "avatars");
const META_FILE = path.join(AVATARS_DIR, "meta.json");

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch { return {}; }
}
function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

// One person's photo. Returns the saved file path, or null if they have none / have restricted
// who can see it — WhatsApp returns the same "nothing" for both, so we can't tell which.
async function fetchOneAvatar(sock, jid, phone) {
  let url;
  try {
    url = await sock.profilePictureUrl(jid, "image");
  } catch (e) {
    return null;
  }
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (res.headers.get("content-type") || "").includes("png") ? "png" : "jpg";
  const file = path.join(AVATARS_DIR, phone + "." + ext);
  fs.writeFileSync(file, buf);
  return file;
}

// Refreshes every current group member. Best-effort per person — one failure (privacy setting,
// transient network hiccup) never blocks the rest. A small delay between people avoids hammering
// WhatsApp with N rapid-fire requests in a tight loop.
async function refreshAvatars(sock, groupJid) {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  const meta = loadMeta();
  const md = await sock.groupMetadata(groupJid);
  const participants = md.participants || [];
  let ok = 0, skipped = 0;
  for (const p of participants) {
    const phone = p.id.split("@")[0];
    try {
      const file = await fetchOneAvatar(sock, p.id, phone);
      if (file) { meta[phone] = { file: path.basename(file), fetchedAt: new Date().toISOString(), ok: true }; ok++; }
      else { meta[phone] = { file: null, fetchedAt: new Date().toISOString(), ok: false }; skipped++; }
    } catch (e) {
      meta[phone] = { file: null, fetchedAt: new Date().toISOString(), ok: false, error: e.message };
      skipped++;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  saveMeta(meta);
  return { total: participants.length, ok: ok, skipped: skipped };
}

module.exports = { refreshAvatars, loadMeta, AVATARS_DIR };
