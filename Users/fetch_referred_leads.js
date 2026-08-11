/**
 * fetch_referred_leads.js
 *
 * Queries the `vaultUsers` collection in Firestore, checks every document
 * for a non-null `referredByUserId` field, prints matching leads to the
 * terminal, and writes them to a Google Sheet.
 *
 * Usage:
 *   node fetch_referred_leads.js
 *
 * Requires:
 *   npm install firebase-admin googleapis
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const path = require("path");

// ============================== CONFIG ==============================

const CONFIG = {
  // Path to your Firebase service account key JSON
  firebaseServiceAccountPath: path.join(__dirname, "service_account_key.json"),

  // Path to your Google Sheets service account key JSON (can be the same
  // file as above if that service account also has Sheets API access +
  // is shared as an editor on the target spreadsheet)
  sheetsServiceAccountPath: path.join(__dirname, "service_account_key.json"),

  // Target spreadsheet ID and tab name
  spreadsheetId: "1Sd-6Pgx7G-OgCtIe8J0HVPthjeST6GwLhwUx9XME_p0",
  sheetName: "Referred Leads",

  // Firestore collection to read
  usersCollection: "vaultUsers",
};

// ============================== HELPERS ==============================

function toReadable(value) {
  if (value === null || value === undefined) return "";
  // Firestore Timestamp
  if (typeof value === "object" && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

// ============================== MAIN ==============================

async function main() {
  // --- Init Firebase ---
  const serviceAccount = require(CONFIG.firebaseServiceAccountPath);
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();
  db.settings({ preferRest: true }); // avoid gRPC hangs on restrictive networks

  console.log("Testing Firestore connection (fetching 1 doc)...");
  const testSnap = await db.collection(CONFIG.usersCollection).limit(1).get();
  console.log(`Connection OK. Sample doc exists: ${!testSnap.empty}`);

  console.log(
    `Fetching all documents from "${CONFIG.usersCollection}" in batches...`,
  );

  const BATCH_SIZE = 300;
  const MAX_RETRIES = 4;
  const { FieldPath } = require("firebase-admin/firestore");

  const referredLeads = [];
  let lastDoc = null;
  let totalFetched = 0;
  let batchNum = 0;

  while (true) {
    batchNum += 1;
    let query = db
      .collection(CONFIG.usersCollection)
      .orderBy(FieldPath.documentId())
      .limit(BATCH_SIZE);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    let snap;
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        snap = await query.get();
        break;
      } catch (err) {
        if (attempt > MAX_RETRIES) {
          console.error(
            `Batch ${batchNum} failed after ${MAX_RETRIES} retries.`,
          );
          throw err;
        }
        const waitMs = attempt * 1500;
        console.warn(
          `Batch ${batchNum} attempt ${attempt} failed (${err.message}). Retrying in ${waitMs}ms...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    if (snap.empty) break;

    snap.forEach((doc) => {
      const data = doc.data();
      const referredByUserId = data.referredByUserId;

      if (referredByUserId !== null && referredByUserId !== undefined) {
        referredLeads.push({
          docId: doc.id,
          referredByUserId,
          userName: data.userName ?? "",
          phoneNumber: data.phoneNumber ?? "",
          email: data.email ?? "",
          createdAt: toReadable(data.createdAt),
        });
      }
    });

    totalFetched += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(
      `  Batch ${batchNum}: fetched ${snap.size} docs (running total: ${totalFetched})`,
    );

    if (snap.size < BATCH_SIZE) break; // last page
  }

  console.log(`Total documents scanned: ${totalFetched}`);

  console.log(`\nFound ${referredLeads.length} referred lead(s):\n`);

  if (referredLeads.length === 0) {
    console.log("No documents with a non-null referredByUserId were found.");
    return;
  }

  // --- Print to terminal ---
  referredLeads.forEach((lead, i) => {
    console.log(
      `${i + 1}. docId: ${lead.docId} | userName: ${lead.userName} | ` +
        `phone: ${lead.phoneNumber} | referredByUserId: ${lead.referredByUserId}`,
    );
  });

  // --- Write to Google Sheet ---
  console.log("\nWriting to Google Sheet...");

  const sheetsAuth = new google.auth.GoogleAuth({
    keyFile: CONFIG.sheetsServiceAccountPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({
    version: "v4",
    auth: await sheetsAuth.getClient(),
  });

  const headers = [
    "Doc ID",
    "User Name",
    "Phone Number",
    "Email",
    "Referred By User ID",
    "Created At",
  ];
  const rows = referredLeads.map((lead) => [
    lead.docId,
    lead.userName,
    lead.phoneNumber,
    lead.email,
    lead.referredByUserId,
    lead.createdAt,
  ]);

  // Ensure the target tab exists; create it if not.
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: CONFIG.spreadsheetId,
  });
  const existingSheet = spreadsheet.data.sheets.find(
    (s) => s.properties.title === CONFIG.sheetName,
  );
  if (!existingSheet) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: CONFIG.sheetName } } }],
      },
    });
  }

  // Clear existing content on that tab before writing (avoids stale rows).
  await sheets.spreadsheets.values.clear({
    spreadsheetId: CONFIG.spreadsheetId,
    range: CONFIG.sheetName,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${CONFIG.sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [headers, ...rows],
    },
  });

  console.log(
    `Done. Wrote ${rows.length} row(s) to "${CONFIG.sheetName}" tab.`,
  );
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
