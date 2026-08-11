/**
 * find_duplicate_serviceid.js
 *
 * Queries the vaultProforma collection in Firestore. Each proforma document
 * has an array field "proformaServices", where each element has a "serviceId".
 * This script finds serviceId values that appear across MORE THAN ONE
 * proforma document, and writes all matching proforma details to a CSV.
 *
 * Usage:
 *   node find_duplicate_serviceid.js
 *
 * Requires:
 *   npm install firebase-admin
 *   service_account_key.json in the same folder (or update SERVICE_ACCOUNT_PATH below)
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
const OUTPUT_CSV = path.join(__dirname, "duplicate_serviceid_proformas.csv");
const PAGE_SIZE = 300;

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount),
});

// preferRest avoids gRPC hangs on some restricted networks
const db = getFirestore();
db.settings({ preferRest: true });

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function fetchAllProformas() {
  const allDocs = [];
  let lastDoc = null;
  let batchNum = 0;

  while (true) {
    let query = db
      .collection("vaultProforma")
      .orderBy("__name__")
      .limit(PAGE_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    snapshot.docs.forEach((doc) => allDocs.push(doc));
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    batchNum++;
    console.log(
      `Fetched batch ${batchNum}, total docs so far: ${allDocs.length}`,
    );

    if (snapshot.docs.length < PAGE_SIZE) break;
  }

  return allDocs;
}

async function main() {
  console.log("Fetching all vaultProforma documents...");
  const proformaDocs = await fetchAllProformas();
  console.log(`Total proforma documents fetched: ${proformaDocs.length}`);

  // Map: serviceId -> array of { proformaId, proformaData, serviceEntry }
  const serviceIdMap = new Map();

  for (const doc of proformaDocs) {
    const data = doc.data();

    // Skip proformas that are "lost" or marked deleted — these should not
    // be considered when checking for duplicate serviceId across proformas.
    const isLost =
      typeof data.proformaStatus === "string" &&
      data.proformaStatus.trim().toLowerCase() === "lost";
    const isDeleted = data.isDeleted === true;
    if (isLost || isDeleted) continue;

    const proformaServices = Array.isArray(data.proformaServices)
      ? data.proformaServices
      : [];

    // Track unique serviceIds within THIS proforma doc, so we don't
    // double count if the same serviceId appears twice in one doc's array.
    const seenInThisDoc = new Set();

    for (const serviceEntry of proformaServices) {
      const serviceId = serviceEntry && serviceEntry.serviceId;
      if (!serviceId) continue;
      if (seenInThisDoc.has(serviceId)) continue;
      seenInThisDoc.add(serviceId);

      if (!serviceIdMap.has(serviceId)) {
        serviceIdMap.set(serviceId, []);
      }
      serviceIdMap.get(serviceId).push({
        proformaId: doc.id,
        proformaData: data,
        serviceEntry,
      });
    }
  }

  // Keep only serviceIds that appear in MORE THAN ONE proforma document
  const duplicateEntries = [];
  for (const [serviceId, entries] of serviceIdMap.entries()) {
    if (entries.length > 1) {
      duplicateEntries.push({ serviceId, entries });
    }
  }

  console.log(
    `Found ${duplicateEntries.length} serviceId(s) appearing in multiple proforma documents.`,
  );

  // Build CSV rows
  const header = [
    "Proforma ID",
    "Duplicate Count",
    "User ID",
    "Service ID",
    "Customer Name",
    "Phone Number",
    "Sales POC",
    "Total Amount",
    "Total Paid",
    "Proforma Status",
    "Deleted?",
  ];

  const rows = [header.map(csvEscape).join(",")];

  for (const { serviceId, entries } of duplicateEntries) {
    for (const { proformaData } of entries) {
      const row = [
        proformaData.piid || "",
        entries.length,
        proformaData.userId || "",
        serviceId,
        proformaData.userName || "",
        proformaData.phoneNumber || "",
        proformaData.salesPOC || "",
        proformaData.totalAmount || "",
        proformaData.totalPaid || "",
        proformaData.proformaStatus || "",
        proformaData.isDeleted !== undefined ? proformaData.isDeleted : "",
      ];

      rows.push(row.map(csvEscape).join(","));
    }
  }

  fs.writeFileSync(OUTPUT_CSV, rows.join("\n"), "utf8");
  console.log(`CSV written to: ${OUTPUT_CSV}`);
  console.log(`Total rows written (excluding header): ${rows.length - 1}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
