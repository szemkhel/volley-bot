const { generateReminder } = require("./reminder");
const fs = require("fs");
const path = require("path");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

let allMembers;
const membersFile = path.join(__dirname, "members.json");
if (fs.existsSync(membersFile)) {
  allMembers = JSON.parse(fs.readFileSync(membersFile, "utf8"));
  console.log("Using real group members from members.json\n");
} else {
  console.log("members.json not found — using fake members (run find-group.js first)\n");
  allMembers = [
    { phone: "48600111222", name: "Marek" },
    { phone: "48600333444", name: "Ania" },
    { phone: "48600555666", name: "Tomek" },
    { phone: "48600777888", name: "Kasia" },
    { phone: "48600999000", name: "Pawel" },
    { phone: "48601234567", name: "Zofia" },
  ];
}

// Simulate: first 2 people voted, rest didn't
const voters = {};
allMembers.slice(0, 2).forEach(m => { voters[m.phone] = true; });
const nonVoters = allMembers.filter(m => !voters[m.phone]);

async function run() {
  console.log("=== SMOKE TEST ===\n");
  console.log("All members:", allMembers.map(m => m.name || m.phone).join(", "));
  console.log("Voted (simulated):", allMembers.slice(0, 2).map(m => m.name || m.phone).join(", "));
  console.log("Non-voters:", nonVoters.map(m => m.name || m.phone).join(", "));
  console.log();

  console.log("--- TUESDAY reminder (first, light) ---");
  const tuesdayMsg = await generateReminder(nonVoters, config, false);
  console.log(tuesdayMsg);
  console.log();

  console.log("--- WEDNESDAY reminder (urgent) ---");
  const wednesdayMsg = await generateReminder(nonVoters, config, true);
  console.log(wednesdayMsg);
  console.log();

  console.log("=== END TEST ===");
}

run().catch(console.error);
