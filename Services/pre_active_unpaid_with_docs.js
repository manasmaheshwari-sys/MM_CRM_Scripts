// pre_active_unpaid_with_docs.js
//
// Finds vaultServices docs where:
//   bucket      == "pre active"
//   invoiced    == true
//   amountPaid  == 0
// then, for each match, looks up vaultUsers by the service doc's userId field,
// and keeps only cases where vaultUsers.hasDocuments == true.
// Also pulls:
//   - Lead creation date  <- vaultUsers.added (epoch -> YYYY-MM-DD)
//   - Proforma creation date <- vaultProforma doc matched on userId field, .added (epoch -> YYYY-MM-DD)
// Writes matches to a CSV.
//
// Usage:
//   node pre_active_unpaid_with_docs.js
//
// Place service_account_key.json in the same folder (or update SERVICE_ACCOUNT_PATH below).

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
const OUTPUT_CSV = path.join(__dirname, "pre_active_unpaid_with_docs.csv");
const PAGE_SIZE = 300;

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount),
});

// preferRest avoids gRPC hangs on some restricted/corporate networks
const db = getFirestore();
db.settings({ preferRest: true });

// --- CSV helpers ---------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(fields) {
  return fields.map(csvEscape).join(",");
}

// --- Step 1: fetch target vaultServices docs -----------------------------

async function fetchTargetServices() {
  const results = [];
  let lastDoc = null;

  while (true) {
    let query = db
      .collection("vaultServices")
      .where("bucket", "==", "pre active")
      .where("invoiced", "==", true)
      .where("amountPaid", "==", 0)
      .orderBy("__name__")
      .limit(PAGE_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc.id);
    }

    const snap = await query.get();
    if (snap.empty) break;

    snap.docs.forEach((doc) => results.push(doc));
    lastDoc = snap.docs[snap.docs.length - 1];

    if (snap.docs.length < PAGE_SIZE) break;
  }

  return results;
}

// --- Step 2: look up vaultUsers by userId ---------------------------------
// Tries userId as the vaultUsers document ID first (fast path).
// Falls back to a query on a "userId" field in vaultUsers if no doc is found
// at that ID, in case userId in vaultServices doesn't match the document ID.

async function getUserDoc(userId) {
  if (!userId) return null;

  const byId = await db.collection("vaultUsers").doc(userId).get();
  if (byId.exists) return byId;

  const bySnap = await db
    .collection("vaultUsers")
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (!bySnap.empty) return bySnap.docs[0];

  return null;
}

// --- Step 3: look up vaultProforma by userId field ------------------------
// Spec: search the userId field in vaultProforma (not the doc ID). If
// multiple proforma docs match, the first one found is used.

async function getProformaDoc(userId) {
  if (!userId) return null;

  const snap = await db
    .collection("vaultProforma")
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (!snap.empty) return snap.docs[0];

  return null;
}

// --- Epoch -> date helper --------------------------------------------------
// Handles both seconds and milliseconds epoch values, and Firestore Timestamp
// objects (which have a toDate() method). Returns date only, e.g. "2026-07-21".

function epochToDateString(value) {
  if (value === null || value === undefined || value === "") return "";

  let ms;

  if (typeof value === "object" && typeof value.toDate === "function") {
    // Firestore Timestamp
    ms = value.toDate().getTime();
  } else {
    const num = Number(value);
    if (Number.isNaN(num)) return "";
    // Seconds epoch is ~10 digits, ms epoch is ~13 digits.
    ms = num < 1e12 ? num * 1000 : num;
  }

  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";

  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// --- Main -----------------------------------------------------------------

async function main() {
  console.log(
    "Fetching vaultServices matching bucket='pre active', invoiced=true, amountPaid=0 ...",
  );
  const serviceDocs = await fetchTargetServices();
  console.log(`Found ${serviceDocs.length} target service doc(s).`);

  const rows = [];
  const userCache = new Map();

  for (const doc of serviceDocs) {
    const data = doc.data();
    const userId = data.userId;

    if (!userId) {
      console.log(`Service ${doc.id}: no userId field, skipping.`);
      continue;
    }

    let userDoc;
    if (userCache.has(userId)) {
      userDoc = userCache.get(userId);
    } else {
      userDoc = await getUserDoc(userId);
      userCache.set(userId, userDoc);
    }

    if (!userDoc) {
      console.log(
        `Service ${doc.id}: userId ${userId} not found in vaultUsers, skipping.`,
      );
      continue;
    }

    const userData = userDoc.data();
    if (userData.hasDocuments !== true) {
      continue;
    }

    const leadCreationDate = epochToDateString(userData.added);

    let proformaDoc;
    if (userCache.has(`proforma:${userId}`)) {
      proformaDoc = userCache.get(`proforma:${userId}`);
    } else {
      proformaDoc = await getProformaDoc(userId);
      userCache.set(`proforma:${userId}`, proformaDoc);
    }
    const proformaCreationDate = proformaDoc
      ? epochToDateString(proformaDoc.data().added)
      : "";

    rows.push({
      serviceDocId: doc.id,
      userId: userId,
      userDocId: userDoc.id,
      bucket: data.bucket,
      invoiced: data.invoiced,
      amountPaid: data.amountPaid,
      hasDocuments: userData.hasDocuments,
      serviceName: data.serviceName || data.service || "",
      userName: userData.name || userData.userName || "",
      userPhone: userData.phone || userData.phoneNumber || "",
      leadCreationDate: leadCreationDate,
      proformaCreationDate: proformaCreationDate,
    });
  }

  console.log(`${rows.length} matching case(s) after hasDocuments filter.`);

  const header = [
    "serviceDocId",
    "userId",
    "userDocId",
    "bucket",
    "invoiced",
    "amountPaid",
    "hasDocuments",
    "serviceName",
    "userName",
    "userPhone",
    "leadCreationDate",
    "proformaCreationDate",
  ];

  const lines = [toCsvRow(header)];
  for (const row of rows) {
    lines.push(toCsvRow(header.map((key) => row[key])));
  }

  fs.writeFileSync(OUTPUT_CSV, lines.join("\n"), "utf8");
  console.log(`Written to ${OUTPUT_CSV}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
