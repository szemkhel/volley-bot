// Generates the MVP-of-the-week caricature image via OpenAI's gpt-image-1. Uses the pinned "good"
// face from avatars.js (image edit — much better likeness than a text description) when one
// exists, otherwise falls back to a generic invented caricature with a best-guess gender (text
// generation). The Polish haiku (from reminder.js generateMvpHaiku) is baked into the image itself
// — everything else (MVP count, congrats) stays in the WhatsApp message text, since cramming more
// than one text block into a single gpt-image-1 generation was tested and produced misspellings.
const fs = require("fs");
const path = require("path");

// Locked across every generation so caricatures read as "the same artist, different week" —
// jersey/outfit color is deliberately NOT locked here, it's left to vary freely per generation.
const STYLE = "Playful hand-drawn caricature illustration style, bold black outlines, dramatic " +
  "energetic motion lines radiating in the background, warm color palette. Indoor volleyball " +
  "court setting with the net visible. Player wears a colorful volleyball jersey and shorts, any " +
  "color scheme. Big exaggerated caricature proportions (larger head, expressive face), big " +
  "confident triumphant grin.";

const POSES = [
  "leaping high to spike the ball with a powerful smash, arm cocked back, one leg kicked up for balance",
  "serving an ace — arm extended high overhead about to strike the ball, athletic ready stance",
  "diving low for a defensive dig just above the floor, one arm outstretched, dramatic low angle",
  "blocking at the net — both arms raised high above the net, intense focused expression, jumping",
  "setting the ball with fingertips raised overhead, delicate precise hand position",
  "a dynamic volleyball action pose of your own choosing, dramatic and full of energy",
];

function randomPose() {
  return POSES[Math.floor(Math.random() * POSES.length)];
}

function bannerPrompt(haiku) {
  return "At the bottom of the image, include a decorative banner or plaque styled to match the " +
    "hand-drawn illustration (like a trophy plaque), with this Polish haiku rendered clearly and " +
    "legibly, spelled EXACTLY as given, including all Polish diacritical marks: '" +
    haiku.replace(/\n/g, " / ") + "'. Only this haiku text — nothing else written anywhere in the image.";
}

async function callOpenAiEdit(apiKey, imageBuffer, filename, prompt) {
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("image[]", new Blob([imageBuffer]), filename);
  form.append("prompt", prompt);
  form.append("size", "1024x1536");
  form.append("n", "1");
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
    body: form,
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error("OpenAI edit " + res.status + ": " + (await res.text()).slice(0, 300));
  const j = await res.json();
  return Buffer.from(j.data[0].b64_json, "base64");
}

async function callOpenAiGenerate(apiKey, prompt) {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1536", n: 1 }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error("OpenAI generate " + res.status + ": " + (await res.text()).slice(0, 300));
  const j = await res.json();
  return Buffer.from(j.data[0].b64_json, "base64");
}

// referenceFile = absolute path to a pinned single-face avatar photo, or null → generic fallback
// using guessedGender. Returns a PNG buffer.
async function generateCaricature(apiKey, referenceFile, guessedGender, haiku) {
  const pose = randomPose();
  const banner = bannerPrompt(haiku);
  if (referenceFile && fs.existsSync(referenceFile)) {
    const prompt = "Turn this person into a cartoon caricature captured mid-action during a " +
      "volleyball game, " + pose + ". " + STYLE + " Keep the person's recognizable facial " +
      "features: hairstyle, facial hair, glasses if present in the reference photo. " + banner;
    return await callOpenAiEdit(apiKey, fs.readFileSync(referenceFile), path.basename(referenceFile), prompt);
  }
  const genderWord = guessedGender === "female" ? "female" : "male";
  const prompt = "A friendly-looking adult " + genderWord + " amateur volleyball player, " +
    "invented features (not based on any real person), captured mid-action during a volleyball " +
    "game, " + pose + ". " + STYLE + " " + banner;
  return await callOpenAiGenerate(apiKey, prompt);
}

module.exports = { generateCaricature, randomPose, POSES, STYLE };
