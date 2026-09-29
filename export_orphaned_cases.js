/**
 * export_orphaned_cases.js
 *
 * READ-ONLY SCRIPT — Firestore .stream() reads only. No writes.
 *
 * Purpose:
 *   Finds cases stuck in the exact trap that almost swallowed SRI2438:
 *   the case is in a stage that SHOULD be actively waiting for someone to
 *   pick it up, nobody currently owns it, but isWaiting is false/missing —
 *   which means it's invisible to the "Queue Waiting Cases" panel and the
 *   normal assignment flow (per src/services/vault/queueEngine/
 *   queueWaitingCasesService.ts: that panel only ever queries
 *   isWaiting == true). A case like this can sit forever with no one
 *   assigned and nothing surfacing it, unless someone stumbles onto it
 *   manually and flips isWaiting to true themselves (as happened here).
 *
 * "Workable stage" uses the SAME isWorkableCase() definition as the real
 * queue panel, so this list is exactly "cases the panel would show if
 * isWaiting were set correctly, but isn't":
 *   (stage in [Doc, Filing, Ground] AND NOT (Filing + EC Applied substage))
 *   OR stage in [Qualified, Unqualified, Ground]
 *   OR (stage == Applied AND substage in [Correction Required, Approved])
 *
 * "Nobody owns it" = servicePOC is missing/null/empty.
 *
 * This does NOT fix anything — it only reports. Fixing isWaiting on a case
 * (as your tech lead did manually for SRI2438) is a Firestore WRITE, and
 * that's a deliberate decision for a person to make, not something a
 * read-only reporting script should do silently.
 *
 * Usage:
 *   node export_orphaned_cases.js [output.csv]
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
initializeApp({ credential: cert(require(SERVICE_ACCOUNT_PATH)) });
const db = getFirestore();
db.settings({ preferRest: true });

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

function fmtDate(epochSec) {
  if (epochSec === null || epochSec === undefined) return "";
  let ms = Number(epochSec);
  if (isNaN(ms)) return "";
  if (ms < 1e12) ms = ms * 1000;
  return new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function csvEscape(v) {
  const s = String(v === undefined || v === null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const outputPath = process.argv[2] || path.join(__dirname, "orphaned_cases.csv");

  console.log("Scanning vaultServices (serviceFlow=queue, bucket=active, serviceStatus=open) for orphaned/invisible cases...");

  const orphans = [];
  let scanned = 0;

  await new Promise((resolve, reject) => {
    const stream = db
      .collection("vaultServices")
      .where("serviceFlow", "==", "queue")
      .where("bucket", "==", "active")
      .where("serviceStatus", "==", "open")
      .stream();

    stream.on("data", (doc) => {
      scanned++;
      const d = doc.data();
      const hasPoc = d.servicePOC !== undefined && d.servicePOC !== null && String(d.servicePOC).trim() !== "";
      const isWaitingTrue = d.isWaiting === true;

      if (isWorkableCase(d) && !hasPoc && !isWaitingTrue) {
        orphans.push({
          serviceId: d.serviceId || doc.id,
          serviceName: d.serviceName || "",
          serviceStage: d.serviceStage || "",
          subStage: d.subStage || "",
          queueRole: d.queueRole || "",
          queueBucket: d.queueBucket || "",
          isWaiting: d.isWaiting === undefined ? "(missing)" : String(d.isWaiting),
          added: fmtDate(d.added),
          pipelineEnteredAt: fmtDate(d.pipelineEnteredAt),
          lastModified: fmtDate(d.lastModified),
          userName: d.userName || "",
          phoneNumber: d.phoneNumber || "",
        });
      }
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  console.log(`Scanned ${scanned} open/active queue-flow cases.`);
  console.log(`\nORPHANED (workable stage, no POC, isWaiting != true): ${orphans.length}\n`);

  orphans.forEach((o) =>
    console.log(`  ${o.serviceId} | ${o.serviceName} | ${o.serviceStage}/${o.subStage} | isWaiting=${o.isWaiting} | entered ${o.pipelineEnteredAt}`)
  );

  const header = [
    "serviceId", "serviceName", "serviceStage", "subStage", "queueRole", "queueBucket",
    "isWaiting", "added", "pipelineEnteredAt", "lastModified", "userName", "phoneNumber",
  ];
  const lines = [header.join(",")];
  for (const o of orphans) {
    lines.push(header.map((h) => csvEscape(o[h])).join(","));
  }
  fs.writeFileSync(outputPath, lines.join("\n"));
  console.log(`\nSaved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
