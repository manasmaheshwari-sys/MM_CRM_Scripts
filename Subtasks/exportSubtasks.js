/**
 * exportSubtasks.js
 *
 * Exports ALL documents + ALL fields from the "vaultServiceSubtasks" Firestore
 * collection into a Google Sheet, splitting known UNIX timestamp fields
 * (createdAt, completedAt, dueDate, reminderAt, reminderDismissedAt) into
 * separate "<field> Date" / "<field> Time" columns (IST, since Vault ops is Bengaluru-based).
 *
 * Usage:
 *   node exportSubtasks.js
 *
 * Requirements:
 *   npm install firebase-admin googleapis
 *   - service_account_key.json (Firebase Admin SDK key) in same folder
 *   - The SAME service account (or another one you configure below) must be
 *     shared as an Editor on the target Google Sheet, OR you use OAuth.
 *     Easiest: share the sheet with the client_email found in
 *     service_account_key.json (Firestore SA can double as Sheets SA if you
 *     enable the Sheets API on that GCP project and share the sheet with it).
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const serviceAccount = require("./service_account_key.json");

// ---------- CONFIG ----------
const SPREADSHEET_ID = "1kizCefRsodlUP-yY2M7uUeDn8tG43pI3ScZA4m2yIRU";
const SHEET_NAME = "Raw Data";
const COLLECTION_NAME = "vaultServiceSubtasks";
const PAGE_SIZE = 500;

// Fields that are UNIX timestamps (seconds or ms — auto-detected) needing Date/Time split
const TIMESTAMP_FIELDS = [
  "createdAt",
  "completedAt",
  "dueDate",
  "reminderAt",
  "reminderDismissedAt",
];

const TIMEZONE = "Asia/Kolkata";
// -----------------------------

initializeApp({
  credential: cert(serviceAccount),
  preferRest: true,
});

const db = getFirestore();

/**
 * Convert a Firestore timestamp-ish value into a JS Date.
 * Handles: Firestore Timestamp objects, {_seconds,_nanoseconds}, unix seconds, unix ms, ISO strings.
 */
function toJsDate(value) {
  if (value === null || value === undefined || value === "") return null;

  // Firestore Timestamp instance
  if (typeof value.toDate === "function") {
    return value.toDate();
  }

  // Plain object shape { _seconds, _nanoseconds } or { seconds, nanoseconds }
  if (typeof value === "object") {
    const secs = value._seconds ?? value.seconds;
    if (typeof secs === "number") {
      return new Date(secs * 1000);
    }
    return null;
  }

  if (typeof value === "number") {
    // Heuristic: treat values > 1e12 as milliseconds, else seconds
    return value > 1e12 ? new Date(value) : new Date(value * 1000);
  }

  if (typeof value === "string") {
    // Try numeric string first
    if (/^\d+$/.test(value)) {
      const num = Number(value);
      return num > 1e12 ? new Date(num) : new Date(num * 1000);
    }
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function formatDatePart(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date); // YYYY-MM-DD
}

function formatTimePart(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date); // HH:mm:ss
}

/**
 * Flatten a value for sheet output. Objects/arrays become JSON strings
 * (excluding the timestamp fields, which are handled separately).
 */
function stringifyValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    // Firestore Timestamp leftover (shouldn't hit here for TIMESTAMP_FIELDS)
    if (typeof value.toDate === "function") {
      return value.toDate().toISOString();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

async function fetchAllDocuments() {
  console.log(`Fetching all documents from "${COLLECTION_NAME}"...`);
  const allDocs = [];
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
    if (snapshot.empty) break;

    snapshot.docs.forEach((doc) => {
      allDocs.push({ id: doc.id, data: doc.data() });
    });

    batchNum += 1;
    console.log(
      `  Batch ${batchNum}: ${snapshot.docs.length} docs (running total: ${allDocs.length})`,
    );

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    if (snapshot.docs.length < PAGE_SIZE) break;
  }

  console.log(`Total documents fetched: ${allDocs.length}`);
  return allDocs;
}

function buildHeadersAndRows(docs) {
  // Discover the full set of fields across all documents (excluding timestamp fields,
  // which get their own Date/Time columns instead of a raw column).
  const otherFieldsSet = new Set();

  docs.forEach(({ data }) => {
    Object.keys(data).forEach((key) => {
      if (!TIMESTAMP_FIELDS.includes(key)) {
        otherFieldsSet.add(key);
      }
    });
  });

  const otherFields = Array.from(otherFieldsSet).sort();

  // Header row: docId, ...otherFields (alphabetical), then for each timestamp field: "<field> Date", "<field> Time"
  const headers = ["docId", ...otherFields];
  TIMESTAMP_FIELDS.forEach((tsField) => {
    headers.push(`${tsField} Date`, `${tsField} Time`);
  });

  const rows = docs.map(({ id, data }) => {
    const row = [id];

    otherFields.forEach((field) => {
      row.push(stringifyValue(data[field]));
    });

    TIMESTAMP_FIELDS.forEach((tsField) => {
      const rawVal = data[tsField];
      const jsDate = toJsDate(rawVal);
      row.push(formatDatePart(jsDate));
      row.push(formatTimePart(jsDate));
    });

    return row;
  });

  return { headers, rows };
}

async function writeToGoogleSheet(headers, rows) {
  console.log("Authenticating with Google Sheets API...");

  const authClient = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth: authClient });

  // Ensure target sheet/tab exists; create it if not.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheet = meta.data.sheets.find(
    (s) => s.properties.title === SHEET_NAME,
  );

  if (!existingSheet) {
    console.log(`Sheet tab "${SHEET_NAME}" not found — creating it.`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
  } else {
    console.log(`Clearing existing content in "${SHEET_NAME}"...`);
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:ZZ`,
    });
  }

  console.log(`Writing ${rows.length} rows (+ header) to "${SHEET_NAME}"...`);

  // Sheets API has a practical single-request cell limit; chunk if huge.
  const CHUNK_SIZE = 5000; // rows per write call
  const allData = [headers, ...rows];

  for (let i = 0; i < allData.length; i += CHUNK_SIZE) {
    const chunk = allData.slice(i, i + CHUNK_SIZE);
    const startRow = i + 1; // 1-indexed
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${startRow}`,
      // USER_ENTERED makes Sheets parse strings the way it would if you typed
      // them in manually — "2026-07-24" becomes a real Date, "14:00:00" becomes
      // a real Time. RAW (the old setting) stores them as literal text instead,
      // which is why date/time cells were showing up with a leading apostrophe.
      valueInputOption: "USER_ENTERED",
      requestBody: { values: chunk },
    });
    console.log(`  Wrote rows ${startRow} - ${startRow + chunk.length - 1}`);
  }

  console.log("Applying explicit Date/Time number formats...");
  await applyDateTimeFormatting(sheets, headers);

  console.log("Done writing to Google Sheet.");
}

/**
 * Force explicit number formats on every "<field> Date" / "<field> Time" column
 * so they render consistently even if Sheets' auto-detection guesses a
 * different date/time style than you want. Runs after the values write so the
 * columns already exist with data in them.
 */
async function applyDateTimeFormatting(sheets, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetProps = meta.data.sheets.find(
    (s) => s.properties.title === SHEET_NAME,
  ).properties;
  const sheetId = sheetProps.sheetId;

  const requests = [];

  TIMESTAMP_FIELDS.forEach((tsField) => {
    const dateColIdx = headers.indexOf(`${tsField} Date`);
    const timeColIdx = headers.indexOf(`${tsField} Time`);

    if (dateColIdx !== -1) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1, // skip header row
            startColumnIndex: dateColIdx,
            endColumnIndex: dateColIdx + 1,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }

    if (timeColIdx !== -1) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            startColumnIndex: timeColIdx,
            endColumnIndex: timeColIdx + 1,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "TIME", pattern: "hh:mm:ss" },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
  });

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }
}

async function main() {
  try {
    const docs = await fetchAllDocuments();

    if (docs.length === 0) {
      console.log("No documents found in collection. Exiting.");
      return;
    }

    const { headers, rows } = buildHeadersAndRows(docs);
    await writeToGoogleSheet(headers, rows);

    console.log("Export complete ✅");
  } catch (err) {
    console.error("Export failed:", err);
    process.exitCode = 1;
  }
}

main();
