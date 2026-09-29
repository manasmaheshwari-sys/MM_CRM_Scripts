/**
 * export_poc_leaderboard_today.js
 *
 * READ-ONLY SCRIPT — spawns export_poc_leaderboard.js with today's IST day
 * boundaries, so it only counts vaultAgentActivityMetrics events from today.
 * This matches the CRM admin dashboard's default "Today" view (the CRM uses
 * the browser's local-time day boundary; this uses IST since that's the
 * business's operating timezone for a server-run daily script).
 *
 * Usage:
 *   node export_poc_leaderboard_today.js [output.csv]
 */

const path = require("path");
const { execFileSync } = require("child_process");

function startOfTodayIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  istNow.setHours(0, 0, 0, 0);
  // Re-anchor: compute the IST midnight as a real UTC instant.
  const istDateStr = istNow.toLocaleDateString("en-CA"); // YYYY-MM-DD in local (already IST-shifted) terms
  return Math.floor(new Date(`${istDateStr}T00:00:00+05:30`).getTime() / 1000);
}

const startEpoch = startOfTodayIST();
const endEpoch = startEpoch + 86400 - 1; // 23:59:59 IST same day
const outputPath = process.argv[2] || path.join(__dirname, "poc_leaderboard_today.csv");

console.log(
  `Today (IST): ${new Date(startEpoch * 1000).toISOString()} -> ${new Date(endEpoch * 1000).toISOString()}`
);

execFileSync(
  process.execPath,
  [path.join(__dirname, "export_poc_leaderboard.js"), outputPath, String(startEpoch), String(endEpoch)],
  { stdio: "inherit" }
);
