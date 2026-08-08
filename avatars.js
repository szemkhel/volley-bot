// Monthly local cache of group members' WhatsApp profile pictures — the source images for the
// MVP caricature feature. Fetched on a cron, not per-MVP: most people's avatars barely change
// week to week, and this keeps caricature generation from ever needing a live WhatsApp round trip.
// Stored under avatars/ (gitignored — real people's photos never belong in a public repo).
//
// Each refresh also re-runs an AI face-check on the fetched photo (see reminder.js
// analyzeFaceForCaricature) — this can't be a one-time check, since people change avatars.
// lib.nextAvatarMeta pins the last known single-face photo and keeps it even if a later avatar
// has no usable face (0) or several (2+, e.g. a group/couple photo).
const fs = require("fs");
const path = require("path");
const { nextAvatarMeta } = require("./lib");

const AVATARS_DIR = path.join(__dirname, "avatars");
const META_FILE = path.join(AVATARS_DIR, "meta.json");

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch { return {}; }
}
function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

// One person's photo. Returns { file, buf, ext }, or null if they have none / have restricted
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
  const file = phone + "." + ext;
  fs.writeFileSync(path.join(AVATARS_DIR, file), buf);
  return { file, buf, ext };
}

// Refreshes every current group member's photo and face-check. Best-effort per person — one
// failure (privacy setting, transient network hiccup, AI call failure) never blocks the rest. A
// small delay between people avoids hammering WhatsApp with N rapid-fire requests in a tight loop.
async function refreshAvatars(sock, groupJid, cfg) {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  const { analyzeFaceForCaricature } = require("./reminder");
  const meta = loadMeta();
  const md = await sock.groupMetadata(groupJid);
  const participants = md.participants || [];
  let ok = 0, skipped = 0, oneFace = 0, noFace = 0, multiFace = 0, faceCheckFailed = 0;
  for (const p of participants) {
    const phone = p.id.split("@")[0];
    const fetchedAt = new Date().toISOString();
    let fresh;
    try {
      const got = await fetchOneAvatar(sock, p.id, phone);
      if (!got) {
        fresh = { file: null, fetchedAt, faceCount: null, guessedGender: null };
        skipped++;
      } else {
        const mediaType = got.ext === "png" ? "image/png" : "image/jpeg";
        const analysis = await analyzeFaceForCaricature(got.buf, mediaType, cfg);
        fresh = { file: got.file, fetchedAt, faceCount: analysis.faceCount, guessedGender: analysis.guessedGender };
        ok++;
        if (analysis.faceCount === 1) oneFace++;
        else if (analysis.faceCount === 0) noFace++;
        else if (analysis.faceCount >= 2) multiFace++;
        else faceCheckFailed++;
      }
    } catch (e) {
      fresh = { file: null, fetchedAt, faceCount: null, guessedGender: null, error: e.message };
      skipped++;
    }
    meta[phone] = nextAvatarMeta(meta[phone], fresh);
    await new Promise(r => setTimeout(r, 400));
  }
  saveMeta(meta);
  return { total: participants.length, ok, skipped, oneFace, noFace, multiFace, faceCheckFailed };
}

module.exports = { refreshAvatars, loadMeta, AVATARS_DIR };
