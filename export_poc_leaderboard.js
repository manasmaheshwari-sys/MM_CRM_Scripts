/**
 * export_poc_leaderboard.js
 *
 * READ-ONLY SCRIPT — Firestore .stream() reads only. No writes.
 *
 * Purpose:
 *   Replicates the CRM's own "Total POCs" admin leaderboard exactly, per
 *   src/services/vault/admin/adminLeaderboardService.ts (from the crm-vault-main
 *   codebase shared by the user), scoped to the queue-flow launch window
 *   (24 Aug 2026 -> now). Reads directly from `vaultAgentActivityMetrics`,
 *   NOT from vaultServices notes/activity (that was the wrong source used
 *   in earlier scripts — this replaces those per-POC numbers).
 *
 * Reducer logic (verified against live data, matches CRM exactly):
 *   metricType === 'FILING_COMPLETED' -> filed += 1
 *                                        totalFilingTime += payload.durationSeconds
 *                                        escalated += payload.escalated ? 1 : 0
 *   metricType === 'EC_APPLIED'       -> ecFiled += 1 (also feeds totalFilingTime, per source)
 *   metricType === 'REWORK'           -> rework += 1
 *   metricType === 'SKIPPED'          -> skipped += 1
 *   metricType === 'PAUSED'           -> paused += 1
 *   metricType === 'RECLAIMED'        -> reclaimed += 1
 *   metricType === 'NOT_CONNECTED'    -> notConnected += 1
 *   metricType === 'LOST'             -> lost += 1
 *   metricType === 'BLOCKED'          -> blocked += 1
 *   metricType === 'CASE_CLOSED'      -> revenue += Number(payload.revenue) || 0
 *                                        onTime += payload.slaBreached === false ? 1 : 0
 *   metricType === 'BREAK_DURATION'   -> breakSeconds += payload.durationSeconds
 *                                        (ONLY when payload.breakReason is 'tea' or 'lunch')
 *
 * Usage:
 *   node export_poc_leaderboard.js [output.csv] [startEpochSeconds] [endEpochSeconds]
 *   (defaults: startEpochSeconds = launch (24 Aug 2026 00:00 IST), endEpochSeconds = now)
 *
 *   For "today only" (matches the CRM admin dashboard's default view), pass
 *   today's IST day boundaries — see export_poc_leaderboard_today.js, which
 *   is a thin wrapper that computes those and calls this same logic.
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
initializeApp({ credential: cert(require(SERVICE_ACCOUNT_PATH)) });
const db = getFirestore();
db.settings({ preferRest: true });

const LAUNCH_EPOCH = Math.floor(new Date("2026-08-24T00:00:00+05:30").getTime() / 1000);
const START_EPOCH = process.argv[3] ? Number(process.argv[3]) : LAUNCH_EPOCH;
const END_EPOCH = process.argv[4] ? Number(process.argv[4]) : null;

function csvEscape(v) {
  const s = String(v === undefined || v === null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

async function main() {
  const outputPath = process.argv[2] || path.join(__dirname, "poc_leaderboard.csv");

  console.log(
    `Streaming vaultAgentActivityMetrics where timestamp >= ${START_EPOCH}` +
      (END_EPOCH ? ` and <= ${END_EPOCH}` : " (no end bound)") +
      ` (${new Date(START_EPOCH * 1000).toISOString()}${END_EPOCH ? " -> " + new Date(END_EPOCH * 1000).toISOString() : ""})...`
  );

  const byPoc = new Map(); // pocId -> metrics

  function getPoc(pocId, pocName) {
    if (!byPoc.has(pocId)) {
      byPoc.set(pocId, {
        pocId,
        pocName: pocName || pocId,
        filed: 0,
        totalFilingTime: 0,
        escalated: 0,
        ecFiled: 0,
        rework: 0,
        skipped: 0,
        paused: 0,
        reclaimed: 0,
        notConnected: 0,
        lost: 0,
        blocked: 0,
        revenue: 0,
        onTime: 0,
        caseClosedCount: 0,
        breakSeconds: 0,
        totalEventsSeen: 0,
      });
    }
    return byPoc.get(pocId);
  }

  let total = 0;
  const metricTypeCounts = {};

  await new Promise((resolve, reject) => {
    let q = db.collection("vaultAgentActivityMetrics").where("timestamp", ">=", START_EPOCH);
    if (END_EPOCH) q = q.where("timestamp", "<=", END_EPOCH);
    const stream = q.stream();

    stream.on("data", (doc) => {
      total++;
      const d = doc.data();
      metricTypeCounts[d.metricType] = (metricTypeCounts[d.metricType] || 0) + 1;
      if (!d.pocId) return;

      const m = getPoc(d.pocId, d.pocName);
      m.totalEventsSeen++;
      const payload = d.payload || {};

      switch (d.metricType) {
        case "FILING_COMPLETED":
          m.filed += 1;
          m.totalFilingTime += Number(payload.durationSeconds) || 0;
          m.escalated += payload.escalated ? 1 : 0;
          break;
        case "EC_APPLIED":
          m.ecFiled += 1;
          m.totalFilingTime += Number(payload.durationSeconds) || 0;
          break;
        case "REWORK":
          m.rework += 1;
          break;
        case "SKIPPED":
          m.skipped += 1;
          break;
        case "PAUSED":
          m.paused += 1;
          break;
        case "RECLAIMED":
          m.reclaimed += 1;
          break;
        case "NOT_CONNECTED":
          m.notConnected += 1;
          break;
        case "LOST":
          m.lost += 1;
          break;
        case "BLOCKED":
          m.blocked += 1;
          break;
        case "CASE_CLOSED":
          m.caseClosedCount += 1;
          m.revenue += Number(payload.revenue) || 0;
          m.onTime += payload.slaBreached === false ? 1 : 0;
          break;
        case "BREAK_DURATION":
          if (payload.breakReason === "tea" || payload.breakReason === "lunch") {
            m.breakSeconds += Number(payload.durationSeconds) || 0;
          }
          break;
        default:
          break; // ASSIGNED / UNASSIGNED / other event types not part of the leaderboard
      }

      if (total % 500 === 0) console.log(`  ...processed ${total} events`);
    });

    stream.on("error", reject);
    stream.on("end", resolve);
  });

  console.log(`\nDone. Total events in window: ${total}`);
  console.log("Metric type breakdown:", metricTypeCounts);

  const rows = [...byPoc.values()].sort((a, b) => b.filed - a.filed);

  const header = [
    "pocId", "pocName", "filed", "hrsPerCase", "revenue", "rework", "skipped", "paused",
    "reclaimed", "notConnected", "lost", "blocked", "ecFiled", "escalatedFiled",
    "onTimeClosed", "caseClosedCount", "onTimePct", "breakTime", "breakSeconds",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const hrsPerCase = r.filed > 0 ? +(r.totalFilingTime / r.filed / 3600).toFixed(2) : 0;
    const onTimePct = r.caseClosedCount > 0 ? +((r.onTime / r.caseClosedCount) * 100).toFixed(1) : "";
    lines.push(
      [
        r.pocId,
        r.pocName,
        r.filed,
        hrsPerCase,
        r.revenue,
        r.rework,
        r.skipped,
        r.paused,
        r.reclaimed,
        r.notConnected,
        r.lost,
        r.blocked,
        r.ecFiled,
        r.escalated,
        r.onTime,
        r.caseClosedCount,
        onTimePct,
        fmtDuration(r.breakSeconds),
        Math.round(r.breakSeconds),
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  fs.writeFileSync(outputPath, lines.join("\n"));
  console.log(`\nSaved leaderboard for ${rows.length} POCs to ${outputPath}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
