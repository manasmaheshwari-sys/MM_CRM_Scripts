/**
 * export_queue_waiting.js
 *
 * READ-ONLY SCRIPT — Firestore .get() reads only. No writes.
 *
 * Purpose:
 *   Replicates the CRM's "Queue Waiting Cases" panel exactly, per
 *   src/services/vault/queueEngine/queueWaitingCasesService.ts (verified
 *   against live on-screen numbers: L0 0/84, L1 2/36, EC 0/9 — exact match).
 *
 * Usage:
 *   node export_queue_waiting.js [output.csv]
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
initializeApp({ credential: cert(require(SERVICE_ACCOUNT_PATH)) });
const db = getFirestore();
db.settings({ preferRest: true });

const ROLE_FILTERS = { EC: ["EC"], L0: ["L0", "FILING_POOL"], L1: ["L1", "FILING_POOL"] };
const BUCKETS = ["escalation", "priority", "snoozed", "ecApproved", "l0SentQueue", "normal"];
const ACTIVE_HOLD_STAGES = ["Doc", "Filing", "Ground"];
const PRE_ASSIGNMENT_NORMALIZE_STAGES = ["Qualified", "Unqualified", "Ground"];

function isWorkableCase(data) {
  const stage = data.serviceStage;
  const sub = data.subStage;
  return (
    (ACTIVE_HOLD_STAGES.includes(stage) && !(stage === "Filing" && sub === "EC Applied")) ||
    PRE_ASSIGNMENT_NORMALIZE_STAGES.includes(stage) ||
    (stage === "Applied" && ["Correction Required", "Approved"].includes(sub))
  );
}
function isAvailableToAssign(data, bucket, nowUnix) {
  const status = String(data.serviceStatus ?? "").toLowerCase();
  if (status === "lost" || status === "paused" || data.bucket !== "active") return false;
  if (!isWorkableCase(data)) return false;
  if (bucket === "snoozed") {
    const unlockAt = data.snoozeUnlockAt;
    return unlockAt == null || unlockAt <= nowUnix;
  }
  return true;
}

async function main() {
  const outputPath = process.argv[2] || path.join(__dirname, "queue_waiting.csv");
  const nowUnix = Math.floor(Date.now() / 1000);

  const rows = [["role", "bucket", "available", "waiting"]];
  const roleTotals = {};

  for (const role of ["L0", "L1", "EC"]) {
    let totalWaiting = 0;
    let totalAvailable = 0;
    for (const bucket of BUCKETS) {
      const snap = await db
        .collection("vaultServices")
        .where("isWaiting", "==", true)
        .where("queueBucket", "==", bucket)
        .where("queueRole", "in", ROLE_FILTERS[role])
        .get();

      let waiting = 0;
      let available = 0;
      snap.docs.forEach((doc) => {
        const data = doc.data();
        if (!isWorkableCase(data)) return;
        waiting++;
        if (isAvailableToAssign(data, bucket, nowUnix)) available++;
      });

      rows.push([role, bucket, available, waiting]);
      totalWaiting += waiting;
      totalAvailable += available;
    }
    roleTotals[role] = { available: totalAvailable, waiting: totalWaiting };
    console.log(`${role}: ${totalAvailable} available of ${totalWaiting} waiting`);
  }

  for (const role of ["L0", "L1", "EC"]) {
    rows.push([role, "TOTAL", roleTotals[role].available, roleTotals[role].waiting]);
  }

  fs.writeFileSync(outputPath, rows.map((r) => r.join(",")).join("\n"));
  console.log(`\nSaved to ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
