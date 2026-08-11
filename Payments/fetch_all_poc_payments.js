/**
 * fetch_all_poc_payments_csv.js
 *
 * Scans BOTH the `vaultProforma` and `vaultInvoices` collections in
 * Firestore. For every document in either collection, looks at its
 * `payments` array field and pulls out EVERY payment entry regardless
 * of `agentName` (no filtering — all agents included). Writes all
 * matches to a local CSV file, tagging each row with which collection,
 * document, and agent it came from.
 *
 * Usage:
 *   node fetch_all_poc_payments_csv.js
 *
 * Requires:
 *   npm install firebase-admin
 *
 * Expects:
 *   - The Firestore service account key at SERVICE_ACCOUNT_PATH.
 */

const fs = require("fs");
const path = require("path");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// ---- CONFIG ----------------------------------------------------------
const SERVICE_ACCOUNT_PATH =
  process.env.SERVICE_ACCOUNT_PATH ||
  "C:\\Users\\manas\\Downloads\\MM_CRM_Scripts\\service_account_key.json";

const COLLECTIONS = ["vaultProforma", "vaultInvoices"];
const OUTPUT_CSV_PATH =
  process.env.OUTPUT_CSV_PATH ||
  "C:\\Users\\manas\\Downloads\\MM_CRM_Scripts\\all_agent_payments.csv";
// -----------------------------------------------------------------------

// ---- Init Firebase Admin (modular API) --------------------------------
const serviceAccount = require(SERVICE_ACCOUNT_PATH);
initializeApp({
  credential: cert(serviceAccount),
});
const db = getFirestore();
// -----------------------------------------------------------------------

function stringifyValue(val) {
  if (val === undefined || val === null) return "";
  // Firestore Timestamp objects have a toDate() method.
  if (val && typeof val.toDate === "function") {
    return val.toDate().toISOString();
  }
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

// Escapes a value for safe inclusion in a CSV cell.
function csvEscape(val) {
  const str = val === undefined || val === null ? "" : String(val);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function extractMatches(collectionName, data) {
  const matches = [];

  if (collectionName === "vaultProforma") {
    // Structure: doc -> proformaServices (array) -> each service ->
    // payments (array) -> entries with agentName
    const services = Array.isArray(data.proformaServices)
      ? data.proformaServices
      : [];

    services.forEach((service, serviceIdx) => {
      const payments = Array.isArray(service && service.payments)
        ? service.payments
        : [];

      payments.forEach((p) => {
        if (p && typeof p === "object") {
          matches.push({ payment: p, serviceIdx });
        }
      });
    });
  } else {
    // Default / vaultInvoices structure: doc -> payments (array) directly
    const payments = Array.isArray(data.payments) ? data.payments : [];
    payments.forEach((p) => {
      if (p && typeof p === "object") {
        matches.push({ payment: p, serviceIdx: null });
      }
    });
  }

  return matches;
}

async function main() {
  const matchRecords = []; // { collection, docId, serviceIdx, payment }
  const collectionSummary = {};

  for (const collectionName of COLLECTIONS) {
    console.log(`Scanning collection "${collectionName}"...`);
    const snapshot = await db.collection(collectionName).get();

    let docCount = 0;
    let matchCount = 0;

    snapshot.forEach((doc) => {
      docCount++;
      const data = doc.data();
      const matches = extractMatches(collectionName, data);

      matches.forEach(({ payment, serviceIdx }) => {
        matchRecords.push({
          collection: collectionName,
          docId: doc.id,
          serviceIdx,
          payment,
        });
      });
      matchCount += matches.length;
    });

    collectionSummary[collectionName] = { docCount, matchCount };
    console.log(
      `  ${docCount} document(s) scanned, ${matchCount} payment(s) found.`,
    );
  }

  console.log(`\nTotal matched payment entries: ${matchRecords.length}`);

  // ---- Build CSV rows -----------------------------------------------------
  // Union of all field names across every matched payment object, so every
  // field becomes its own column regardless of collection/document.
  const fieldNames = [];
  matchRecords.forEach(({ payment }) => {
    Object.keys(payment).forEach((k) => {
      if (!fieldNames.includes(k)) fieldNames.push(k);
    });
  });

  const csvHeader = [
    "Collection",
    "Document ID",
    "Service Index",
    ...fieldNames,
  ];
  const csvDataRows = matchRecords.map(
    ({ collection, docId, serviceIdx, payment }) => [
      collection,
      docId,
      serviceIdx === null || serviceIdx === undefined ? "" : String(serviceIdx),
      ...fieldNames.map((f) => stringifyValue(payment[f])),
    ],
  );

  const csvLines = [csvHeader, ...csvDataRows].map((row) =>
    row.map(csvEscape).join(","),
  );
  const csvContent = csvLines.join("\r\n");

  // ---- Write to CSV file ---------------------------------------------------
  console.log(
    `\nWriting ${csvDataRows.length} row(s) to "${OUTPUT_CSV_PATH}"...`,
  );
  fs.mkdirSync(path.dirname(OUTPUT_CSV_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_CSV_PATH, csvContent, "utf8");
  console.log("Done. CSV written.");

  // ---- Summary ------------------------------------------------------------
  console.log("\n=== SUMMARY ===");
  COLLECTIONS.forEach((c) => {
    const s = collectionSummary[c];
    console.log(`${c}: ${s.docCount} docs scanned, ${s.matchCount} payment(s)`);
  });

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
