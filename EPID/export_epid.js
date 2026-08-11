/**
 * export_all_fields.js
 *
 * Queries EVERY document in the `vaultServices` Firestore collection
 * (no filter on serviceStage/bucket/etc.) and writes ALL fields found
 * across all documents to a CSV. Since different docs can have different
 * fields, the column set is the UNION of every field name seen across
 * the whole collection (epId included automatically, since it's just
 * one of the fields).
 *
 * Usage:
 *   node export_all_fields.js
 *
 * Requirements:
 *   - service_account_key.json in the same directory (Firebase Admin SDK service account)
 *   - npm install firebase-admin
 *
 * Output:
 *   all_fields_export_<timestamp>.csv in the same directory
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

// ---------- Config ----------
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
const COLLECTION_NAME = "vaultServices";
const PAGE_SIZE = 500; // firestore read batch size

// ---------- Init ----------
const serviceAccount = require(SERVICE_ACCOUNT_PATH);

const app = initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore(app);
db.settings({ preferRest: true });

// ---------- Helpers ----------

/**
 * Escapes a single CSV field value. Objects/arrays are JSON-stringified
 * so nested data (e.g. timestamps, sub-objects) doesn't break the CSV.
 */
function csvEscape(value) {
  if (value === undefined || value === null) return "";

  let str;
  if (value && typeof value.toDate === "function") {
    // Firestore Timestamp
    str = value.toDate().toISOString();
  } else if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }

  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Fetches ALL documents from vaultServices using cursor-based pagination
 * ordered by __name__ (document ID) — no filters applied.
 */
async function fetchAllDocs() {
  const docs = [];
  let lastDoc = null;
  let batchNum = 0;

  while (true) {
    let query = db
      .collection(COLLECTION_NAME)
      .orderBy("__name__")
      .limit(PAGE_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    batchNum += 1;

    if (snapshot.empty) {
      break;
    }

    snapshot.forEach((doc) => {
      const data = doc.data();
      // Client-side filter: skip docs where epId is missing/blank/null.
      const epIdVal = data.epId;
      const hasEpId =
        epIdVal !== undefined &&
        epIdVal !== null &&
        String(epIdVal).trim() !== "";
      if (hasEpId) {
        docs.push({ id: doc.id, data });
      }
    });

    console.log(
      `Batch ${batchNum}: scanned ${snapshot.docs.length} docs, kept ${docs.length} with non-empty epId so far`,
    );

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    if (snapshot.docs.length < PAGE_SIZE) {
      break; // last page
    }
  }

  return docs;
}

async function main() {
  console.log(
    `Querying ALL documents in "${COLLECTION_NAME}" where epId is non-empty...`,
  );

  const docs = await fetchAllDocs();

  if (docs.length === 0) {
    console.log("No documents found. No CSV written.");
    return;
  }

  // Build the union of all field names across every document,
  // preserving first-seen order, with docId first and epId pulled up front
  // (after docId) for convenience.
  const fieldOrder = [];
  const seenFields = new Set();

  docs.forEach(({ data }) => {
    Object.keys(data).forEach((key) => {
      if (!seenFields.has(key)) {
        seenFields.add(key);
        fieldOrder.push(key);
      }
    });
  });

  // Put docId first, then epId (if present) right after, then everything else.
  const orderedColumns = ["docId"];
  if (seenFields.has("epId")) {
    orderedColumns.push("epId");
  }
  fieldOrder.forEach((key) => {
    if (key !== "epId") orderedColumns.push(key);
  });

  const header = orderedColumns.map(csvEscape).join(",");

  const lines = docs.map(({ id, data }) => {
    return orderedColumns
      .map((col) => (col === "docId" ? csvEscape(id) : csvEscape(data[col])))
      .join(",");
  });

  const csvContent = [header, ...lines].join("\n");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(__dirname, `all_fields_export_${timestamp}.csv`);

  fs.writeFileSync(outputPath, csvContent, "utf8");

  console.log(
    `\nDone. ${docs.length} rows, ${orderedColumns.length} columns written to:`,
  );
  console.log(outputPath);
  console.log("\nColumns found:", orderedColumns.join(", "));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  });
