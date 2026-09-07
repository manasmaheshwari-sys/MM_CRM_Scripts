/**
 * exportPausedCases.js
 *
 * READ-ONLY SCRIPT — this script performs Firestore .get()/.where() queries ONLY.
 * It never calls .set(), .update(), .add(), or .delete() on any Firestore document.
 * It does not modify vaultServices or any other collection in any way.
 *
 * What it does:
 * 1. Queries `vaultServices` where serviceStatus == "paused"
 * 2. For each matching doc, pulls pause-reason info out of the `notes` array
 *    (specifically entries where noteType === "system" or that carry a pauseMetadata block,
 *    but we actually pull pauseMetadata from EVERY note entry that has it, plus we also check
 *    a top-level `pausedMetadata` field if present on the doc)
 * 3. Also grabs name, service id, phone number, serviceName for each case
 * 4. Writes everything to the given Google Sheet (one row per pause-reason found;
 *    if a service has multiple pause notes, it gets multiple rows)
 *
 * Requirements:
 *   npm install firebase-admin googleapis
 *
 * Auth:
 *   - Firestore: uses service_account_key.json (same as your other MM_CRM_Scripts)
 *   - Google Sheets: uses the SAME service_account_key.json IF that service account
 *     has been added as an Editor on the target Google Sheet. If you use a different
 *     Google service account for Sheets, point GOOGLE_SHEETS_KEY_PATH at it below.
 *
 *     To share the sheet with the service account:
 *       1. Open service_account_key.json, copy the "client_email" value
 *       2. Open the Google Sheet -> Share -> paste that email -> give Editor access
 *
 * Usage:
 *   node exportPausedCases.js
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const path = require("path");

// ---------- CONFIG ----------
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
const GOOGLE_SHEETS_KEY_PATH = SERVICE_ACCOUNT_PATH; // change if Sheets uses a different SA
const SPREADSHEET_ID = "1R9P_RHJl5qxTZZytT3UyFwLaN0mT9Fb1hwehjEoOvZM";
const SHEET_NAME = "PausedCases"; // will be created if it doesn't exist
const COLLECTION = "vaultServices";
// -----------------------------

// ---- Firebase init (READ ONLY usage — no writes are performed against Firestore) ----
const serviceAccount = require(SERVICE_ACCOUNT_PATH);
initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
db.settings({ preferRest: true });

// ---- Google Sheets init ----
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SHEETS_KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

function safe(v, fallback = "") {
  return v === undefined || v === null ? fallback : v;
}

function fmtDateOnly(ts) {
  // Firestore Timestamp or epoch (seconds/ms) -> "YYYY-MM-DD" (date only, no time)
  if (!ts) return "";
  let d;
  if (typeof ts === "object" && typeof ts.toDate === "function") {
    d = ts.toDate();
  } else if (typeof ts === "number") {
    // heuristics: if seconds (10 digits) vs ms (13 digits)
    const ms = ts.toString().length <= 10 ? ts * 1000 : ts;
    d = new Date(ms);
  } else if (typeof ts === "string" && /^\d+$/.test(ts)) {
    const num = Number(ts);
    const ms = ts.length <= 10 ? num * 1000 : num;
    d = new Date(ms);
  } else {
    return String(ts);
  }
  if (isNaN(d.getTime())) return String(ts);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Extract pause-reason rows from a single vaultServices doc.
 * Looks at:
 *  - doc.notes[] array -> entries that have noteType/noteContent and/or pauseMetadata
 *  - doc.pausedMetadata (top-level, if present, as a fallback/extra row)
 */
function extractPauseReasons(docId, data) {
  const rows = [];

  const name = safe(
    data.userName || data.customerName || data.name || data.clientName,
  );
  const phone = safe(
    data.phoneNumber || data.phone || data.mobileNumber || data.customerPhone,
  );
  const serviceName = safe(
    data.serviceName || data.service || data.serviceType,
  );
  const srid = safe(data.srid || data.serviceId || docId);

  const notes = Array.isArray(data.notes) ? data.notes : [];

  // pauseMetadata lives at the TOP LEVEL of the service doc (sibling of notes),
  // not nested inside individual note entries.
  const pm = data.pauseMetadata || data.pausedMetadata || null;
  const pausedBy = safe(pm && pm.pausedBy);
  const pausedUntil = fmtDateOnly(pm && pm.pausedUntil);
  const dependencyServiceId = safe(pm && pm.dependencyServiceId);
  const dueToDependency =
    pm && typeof pm.dueToDependency === "boolean" ? pm.dueToDependency : "";

  let foundAny = false;

  // Pull pause-related note(s) for context/reason text.
  // Real note fields: noteContent, type ("pause note"), noteEntryDateTime, noteId
  notes.forEach((note, idx) => {
    if (!note) return;
    const noteType = safe(note.type);
    const noteContent = safe(note.noteContent);
    const isPauseRelated =
      /pause/i.test(noteType) || /pause/i.test(noteContent);

    if (!isPauseRelated) return;

    foundAny = true;
    rows.push({
      docId,
      srid,
      name,
      phone,
      serviceName,
      source: `notes[${idx}] (noteId ${safe(note.noteId)})`,
      noteType,
      addedAt: fmtDateOnly(note.noteEntryDateTime),
      noteContent,
      dependencyServiceId,
      dueToDependency,
      pausedBy,
      pausedUntil,
    });
  });

  // If no pause-type note was found but the doc still has pauseMetadata, record it once
  if (!foundAny && pm) {
    foundAny = true;
    rows.push({
      docId,
      srid,
      name,
      phone,
      serviceName,
      source: "pauseMetadata (top-level, no matching note)",
      noteType: "",
      addedAt: "",
      noteContent: "",
      dependencyServiceId,
      dueToDependency,
      pausedBy,
      pausedUntil,
    });
  }

  // If a paused doc has no identifiable pause note or metadata, still record it once so nothing is silently dropped
  if (!foundAny) {
    rows.push({
      docId,
      srid,
      name,
      phone,
      serviceName,
      source: "(no pause note/metadata found)",
      noteType: "",
      addedAt: "",
      noteContent: "",
      dependencyServiceId: "",
      dueToDependency: "",
      pausedBy: "",
      pausedUntil: "",
    });
  }

  return rows;
}

async function fetchPausedCases() {
  console.log(
    `Querying ${COLLECTION} where serviceStatus == "paused" (read-only)...`,
  );

  const results = [];
  let lastDoc = null;
  const pageSize = 500;

  // cursor-based pagination on __name__, consistent with your other scripts
  while (true) {
    let q = db
      .collection(COLLECTION)
      .where("serviceStatus", "==", "paused")
      .orderBy("__name__")
      .limit(pageSize);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get(); // READ ONLY
    if (snap.empty) break;

    snap.docs.forEach((doc) => {
      const rows = extractPauseReasons(doc.id, doc.data());
      results.push(...rows);
    });

    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(
      `  ...fetched ${snap.docs.length} docs (running total rows: ${results.length})`,
    );

    if (snap.docs.length < pageSize) break;
  }

  return results;
}

async function writeToSheet(rows) {
  const sheets = await getSheetsClient();

  const header = [
    "Doc ID",
    "Service ID (SRID)",
    "Name",
    "Phone Number",
    "Service Name",
    "Source",
    "Note Type",
    "Note Date",
    "Note Content / Reason",
    "Dependency Service ID",
    "Due To Dependency",
    "Paused By",
    "Paused Until",
  ];

  const values = [
    header,
    ...rows.map((r) => [
      r.docId,
      r.srid,
      r.name,
      r.phone,
      r.serviceName,
      r.source,
      r.noteType,
      r.addedAt,
      r.noteContent,
      r.dependencyServiceId,
      r.dueToDependency,
      r.pausedBy,
      r.pausedUntil,
    ]),
  ];

  // Ensure target sheet/tab exists; create it if missing (this is a Sheets API write,
  // not a Firestore write — no Firestore data is touched)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingTitles = meta.data.sheets.map((s) => s.properties.title);

  if (!existingTitles.includes(SHEET_NAME)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
  }

  // Clear existing content in that tab, then write fresh
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });

  console.log(`Wrote ${rows.length} rows to sheet tab "${SHEET_NAME}".`);
}

async function main() {
  try {
    const rows = await fetchPausedCases();
    console.log(`Total pause-reason rows extracted: ${rows.length}`);

    if (rows.length === 0) {
      console.log("No paused cases found. Nothing to write.");
      return;
    }

    await writeToSheet(rows);
    console.log("Done.");
  } catch (err) {
    console.error("Error:", err);
    process.exitCode = 1;
  }
}

main();
