// export_coupon_codes.js
// Queries Firestore `vaultUsers` collection for a `couponCode` field
// and writes the results to a Google Sheet.
//
// Setup:
//   npm install firebase-admin googleapis
//
// Usage:
//   node export_coupon_codes.js
//
// Requires service_account_key.json in the same directory, and that
// service account's client_email must be shared as an Editor on the
// target spreadsheet.

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const path = require("path");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
const SPREADSHEET_ID = "1Sd-6Pgx7G-OgCtIe8J0HVPthjeST6GwLhwUx9XME_p0";
const SHEET_TAB_NAME = "Coupon Code";

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

async function testConnection() {
  console.log("Testing Firestore connection (fetching 1 doc)...");
  const snap = await db.collection("vaultUsers").limit(1).get();
  console.log(`Connection OK. Sample doc exists: ${!snap.empty}`);
}

async function fetchCouponCodes() {
  const BATCH_SIZE = 300;
  const rows = [["Document ID", "Coupon Code"]];
  let totalScanned = 0;
  let lastDoc = null;
  let batchNum = 0;

  console.log('Fetching all documents from "vaultUsers" in batches...');

  while (true) {
    let query = db
      .collection("vaultUsers")
      .orderBy("__name__")
      .limit(BATCH_SIZE);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    batchNum += 1;
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (
        Object.prototype.hasOwnProperty.call(data, "couponCode") &&
        data.couponCode !== undefined &&
        data.couponCode !== null &&
        data.couponCode !== ""
      ) {
        rows.push([doc.id, data.couponCode]);
      }
    });

    totalScanned += snapshot.size;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    console.log(
      `  Batch ${batchNum}: fetched ${snapshot.size} docs (running total: ${totalScanned})`,
    );

    if (snapshot.size < BATCH_SIZE) break;
  }

  console.log(`Total documents scanned: ${totalScanned}`);
  console.log(
    `Found ${rows.length - 1} vaultUsers docs with a couponCode field.`,
  );
  return rows;
}

async function writeToSheet(rows) {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // Clear existing content in the tab before writing fresh data
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB_NAME}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  console.log(`Wrote ${rows.length} rows to the "${SHEET_TAB_NAME}" tab.`);
}

async function main() {
  try {
    await testConnection();
    const rows = await fetchCouponCodes();
    console.log("Writing to Google Sheet...");
    await writeToSheet(rows);
    console.log("Done.");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}

main();
