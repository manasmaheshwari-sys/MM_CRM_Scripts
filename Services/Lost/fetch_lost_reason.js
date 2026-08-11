/**
 * fetch_lost_reason.js
 *
 * Reads service IDs from column A of a Google Sheet,
 * fetches the `lostReason` field from Firestore `vaultServices` collection,
 * and writes the value into column W of the same sheet.
 *
 * Setup:
 *   npm install firebase-admin googleapis
 *
 * Run:
 *   node fetch_lost_reason.js
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const FIREBASE_SERVICE_ACCOUNT_PATH = "./service_account_key.json";
const SHEETS_SERVICE_ACCOUNT_PATH = "./service_account_key.json"; // can be same file if same SA has both access
const SPREADSHEET_ID = "1LDr2tULbRG-o1xH94tHXYyUN5FO03W7YR6AmouVt9FM"; // from the sheet URL
const SHEET_NAME = "Sheet1"; // tab name inside the spreadsheet

// Column A = service IDs (input), Column W = lostReason (output)
// Row 1 is assumed to be a header row; data starts at row 2
const ID_COLUMN = "A";
const OUTPUT_COLUMN = "W";
const START_ROW = 2;

// ─── INIT FIREBASE ────────────────────────────────────────────────────────────

const serviceAccount = require(FIREBASE_SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

// ─── INIT GOOGLE SHEETS ───────────────────────────────────────────────────────

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SHEETS_SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const sheets = await getSheetsClient();

  // 1. Read all values from column A (service IDs)
  const readRange = `${SHEET_NAME}!${ID_COLUMN}:${ID_COLUMN}`;
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: readRange,
  });

  const rows = readRes.data.values || [];

  if (rows.length <= 1) {
    console.log(
      "No service IDs found in column A (or only header row present).",
    );
    return;
  }

  // Skip header row (index 0), collect [rowIndex, serviceId] pairs
  const entries = [];
  for (let i = START_ROW - 1; i < rows.length; i++) {
    const serviceId = (rows[i][0] || "").trim();
    if (serviceId) {
      entries.push({ rowIndex: i + 1, serviceId }); // rowIndex is 1-based sheet row number
    }
  }

  console.log(
    `Found ${entries.length} service IDs. Fetching from Firestore...`,
  );

  // 2. Fetch lostReason for each service ID from Firestore
  const updates = []; // { range, value }

  for (const { rowIndex, serviceId } of entries) {
    try {
      const docRef = db.collection("vaultServices").doc(serviceId);
      const docSnap = await docRef.get();

      let lostReason = "";

      if (!docSnap.exists) {
        console.warn(`  [${serviceId}] Document not found in Firestore`);
        lostReason = "DOC_NOT_FOUND";
      } else {
        const data = docSnap.data();
        lostReason = data.lostReason ?? ""; // empty string if field doesn't exist
        console.log(`  [${serviceId}] lostReason = "${lostReason}"`);
      }

      // Column W = sheet row number
      const cellRange = `${SHEET_NAME}!${OUTPUT_COLUMN}${rowIndex}`;
      updates.push({
        range: cellRange,
        values: [[lostReason]],
      });
    } catch (err) {
      console.error(
        `  [${serviceId}] Error fetching from Firestore:`,
        err.message,
      );
      updates.push({
        range: `${SHEET_NAME}!${OUTPUT_COLUMN}${rowIndex}`,
        values: [["FETCH_ERROR"]],
      });
    }
  }

  // 3. Batch write all lostReason values to column W
  if (updates.length === 0) {
    console.log("Nothing to write.");
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: updates,
    },
  });

  console.log(
    `\nDone. Wrote lostReason for ${updates.length} rows into column W.`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
