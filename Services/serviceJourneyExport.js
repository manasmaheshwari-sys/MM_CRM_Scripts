/**
 * serviceJourneyExport.js
 *
 * Queries the `vaultUsers` collection in Firestore, walks each user's
 * `activity` array, and builds a per-service "journey" row showing the
 * sequence of service-stage and sub-stage transitions over time.
 * Writes the result to a Google Sheet.
 *
 * Usage:
 *   node serviceJourneyExport.js
 *
 * Requires:
 *   npm install firebase-admin googleapis
 *
 * Place your Firebase service account key JSON and your Google Sheets
 * service account key JSON paths in the CONFIG block below (they can be
 * the same key if that service account has access to both Firestore and
 * the target Sheet — just share the Sheet with the service account email).
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// ============================== CONFIG ==============================

const CONFIG = {
  // Path to your Firebase service account key JSON
  firebaseServiceAccountPath: path.join(__dirname, "service_account_key.json"),

  // Path to your Google Sheets service account key JSON (same file as above,
  // assuming this service account also has Sheets API access + is shared
  // on the target spreadsheet)
  sheetsServiceAccountPath: path.join(__dirname, "service_account_key.json"),

  // Target spreadsheet ID (from the sheet URL) and tab name
  spreadsheetId: "1C9lp5Jf5N80C9GTOMYbJoFXrFbFMTzejpEHaCw-bTSw",
  sheetName: "Service Journey",

  // Firestore collection to read
  usersCollection: "vaultUsers",

  // Which activity array field to read on each user doc
  activityField: "activity",

  // Which target values count as "stage" vs "sub-stage" events
  stageTargetValue: "service stage",
  subStageTargetValue: "sub-stage",

  // Local cache file — the built sheet rows get saved here right before the
  // Sheets write, so if that write fails (bad ID, permissions, etc.) you can
  // fix the config and re-run with `--from-cache` to skip re-querying
  // Firestore entirely and write instantly from the cache.
  cacheFilePath: path.join(__dirname, "journeyRowsCache.json"),
};

// Candidate field names to try (in order) when looking up customer name
// on a vaultUsers doc, based on the actual vaultUsers schema shared.
const CANDIDATE_NAME_FIELDS = ["userName", "name", "customerName", "fullName"];

// Timezone used when converting epoch seconds to a readable date/time string.
const DISPLAY_TIMEZONE = "Asia/Kolkata";

// ============================== HELPERS ==============================

function pickField(docData, candidates) {
  for (const field of candidates) {
    if (
      docData[field] !== undefined &&
      docData[field] !== null &&
      docData[field] !== ""
    ) {
      return docData[field];
    }
  }
  return "N/A";
}

/**
 * vaultUsers stores phone numbers in a `phoneNos` array of maps, e.g.:
 *   phoneNos: [ { number: "+919986028376", phoneNumber: "+919986028376", addedOn: ... } ]
 * We grab the first entry's number. Falls back to flat fields for safety.
 */
function getCustomerPhone(docData) {
  if (Array.isArray(docData.phoneNos) && docData.phoneNos.length > 0) {
    const first = docData.phoneNos[0];
    if (first && (first.number || first.phoneNumber)) {
      return first.number || first.phoneNumber;
    }
  }
  return pickField(docData, ["phone", "phoneNumber", "mobile", "mobileNumber"]);
}

/**
 * Converts a Unix epoch (seconds) value to a readable date/time string in
 * the configured timezone. Passes through non-numeric / missing values
 * unchanged (so "N/A" or empty strings stay as-is).
 */
function formatEpoch(value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "N/A"
  ) {
    return value === undefined || value === null ? "" : value;
  }
  const num = typeof value === "number" ? value : parseInt(value, 10);
  if (isNaN(num)) return value; // not actually a timestamp, leave as-is
  const ms = num < 10_000_000_000 ? num * 1000 : num; // seconds vs ms guard
  const date = new Date(ms);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    timeZone: DISPLAY_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/**
 * Formats a "joined" time value that may contain multiple epoch timestamps
 * separated by " | " (from multiple sub-stage events under one stage).
 */
function formatEpochJoined(value) {
  if (!value) return value;
  return value
    .split(" | ")
    .map((v) => formatEpoch(v))
    .join(" | ");
}

/**
 * Given the sorted (by time asc), filtered activity entries for ONE
 * serviceId, build the alternating Stage/StageTime/SubStage/SubStageTime
 * sequence.
 *
 * Returns an array of objects: { stage, stageTime, subStage, subStageTime }
 * — one per stage transition, with any sub-stage events that happened
 * under that stage attached to it.
 */
function buildJourney(entries, stageTarget, subStageTarget) {
  const journey = [];
  let current = null;

  for (const entry of entries) {
    if (entry.target === stageTarget) {
      // Start a new stage slot
      current = {
        stage: entry.to,
        stageTime: entry.time,
        subStages: [],
      };
      journey.push(current);
    } else if (entry.target === subStageTarget) {
      if (current) {
        current.subStages.push({ value: entry.to, time: entry.time });
      } else {
        // A sub-stage event happened before any service-stage event was seen.
        // Create a placeholder stage slot so we don't lose the data.
        current = {
          stage: "N/A",
          stageTime: "N/A",
          subStages: [{ value: entry.to, time: entry.time }],
        };
        journey.push(current);
      }
    }
  }

  return journey.map((slot) => ({
    stage: slot.stage,
    stageTime: slot.stageTime,
    subStage: slot.subStages.map((s) => s.value).join(" | ") || "",
    subStageTime: slot.subStages.map((s) => s.time).join(" | ") || "",
  }));
}

// ============================== MAIN ==============================

async function main() {
  console.log("Starting serviceJourneyExport...");
  console.log(`Node version: ${process.version}`);

  const useCache = process.argv.includes("--from-cache");
  let sheetRows;

  if (useCache) {
    console.log(
      `--from-cache flag detected. Loading cached rows from ${CONFIG.cacheFilePath}...`,
    );
    if (!fs.existsSync(CONFIG.cacheFilePath)) {
      throw new Error(
        `Cache file not found at ${CONFIG.cacheFilePath}. Run the script once without --from-cache ` +
          `first so it can build and save the cache.`,
      );
    }
    sheetRows = JSON.parse(fs.readFileSync(CONFIG.cacheFilePath, "utf8"));
    console.log(
      `Loaded ${sheetRows.length - 1} cached rows from disk. Skipping Firestore fetch entirely.`,
    );
  } else {
    // ---- Init Firebase ----
    console.log(
      `Reading service account key from: ${CONFIG.firebaseServiceAccountPath}`,
    );
    if (!fs.existsSync(CONFIG.firebaseServiceAccountPath)) {
      throw new Error(
        `Service account key file not found at ${CONFIG.firebaseServiceAccountPath}. ` +
          `Make sure service_account_key.json is in the same folder as this script.`,
      );
    }
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(
        fs.readFileSync(CONFIG.firebaseServiceAccountPath, "utf8"),
      );
    } catch (e) {
      throw new Error(
        `Could not parse service_account_key.json — is it valid JSON? (${e.message})`,
      );
    }
    console.log(
      `Service account project: ${serviceAccount.project_id || "(unknown)"}`,
    );

    console.log("Initializing Firebase Admin app...");
    initializeApp({ credential: cert(serviceAccount) });
    const db = getFirestore();
    console.log("Firebase Admin initialized.");

    if (CONFIG.spreadsheetId === "YOUR_SPREADSHEET_ID_HERE") {
      console.warn(
        "WARNING: CONFIG.spreadsheetId is still the placeholder value. " +
          "Set it to your real spreadsheet ID before the Sheets write step will work.",
      );
    }

    console.log(
      `Connecting to Firestore collection "${CONFIG.usersCollection}"...`,
    );

    // rows keyed for output; also track max stage depth for dynamic columns
    const rows = [];
    let maxStages = 0;
    let processedDocs = 0;
    let skippedDocs = 0;

    // Heartbeat so the terminal never goes silent, even before the first
    // document arrives (e.g. if the connection is slow to establish).
    const startTime = Date.now();
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `  ...still working (${secs}s elapsed, ${processedDocs} docs read so far)`,
      );
    }, 5000);

    try {
      await new Promise((resolve, reject) => {
        const stream = db.collection(CONFIG.usersCollection).stream();

        stream.on("data", (doc) => {
          processedDocs++;
          if (processedDocs === 1 || processedDocs % 100 === 0) {
            console.log(
              `  Progress: ${processedDocs} docs read — ${rows.length} journey rows built so far`,
            );
          }

          const data = doc.data();
          const userId = doc.id;
          const activity = Array.isArray(data[CONFIG.activityField])
            ? data[CONFIG.activityField]
            : [];

          if (activity.length === 0) {
            skippedDocs++;
            return;
          }

          const customerName = pickField(data, CANDIDATE_NAME_FIELDS);
          const customerPhone = getCustomerPhone(data);

          // Filter to only stage / sub-stage events
          const relevant = activity.filter(
            (a) =>
              a &&
              (a.target === CONFIG.stageTargetValue ||
                a.target === CONFIG.subStageTargetValue),
          );

          if (relevant.length === 0) {
            skippedDocs++;
            return;
          }

          // Group by serviceId — one journey row per service
          const byService = {};
          for (const entry of relevant) {
            const sid = entry.serviceId || "UNKNOWN_SERVICE_ID";
            if (!byService[sid]) byService[sid] = [];
            byService[sid].push(entry);
          }

          for (const serviceId of Object.keys(byService)) {
            const entries = byService[serviceId].slice().sort((a, b) => {
              const ta = typeof a.time === "number" ? a.time : 0;
              const tb = typeof b.time === "number" ? b.time : 0;
              return ta - tb;
            });

            const journey = buildJourney(
              entries,
              CONFIG.stageTargetValue,
              CONFIG.subStageTargetValue,
            );

            if (journey.length > maxStages) maxStages = journey.length;

            rows.push({
              userId,
              serviceId,
              customerName,
              customerPhone,
              journey,
            });
          }
        });

        stream.on("error", (err) => reject(err));
        stream.on("end", () => resolve());
      });
    } finally {
      clearInterval(heartbeat);
    }

    console.log(
      `Done processing. Read ${processedDocs} docs total. Built ${rows.length} service-journey rows (${skippedDocs} docs skipped — no activity/no relevant events). Max stage depth: ${maxStages}.`,
    );

    // ---- Build header row dynamically ----
    const header = ["User ID", "Service ID", "Customer Name", "Customer Phone"];
    for (let i = 1; i <= maxStages; i++) {
      header.push(
        `Stage ${i}`,
        `Stage ${i} Time`,
        `Sub-Stage ${i}`,
        `Sub-Stage ${i} Time`,
      );
    }

    // ---- Build data rows (with epoch times converted to readable date/time) ----
    console.log("Formatting timestamps and building sheet rows...");
    sheetRows = [header];
    for (const row of rows) {
      const line = [
        row.userId,
        row.serviceId,
        row.customerName,
        row.customerPhone,
      ];
      for (let i = 0; i < maxStages; i++) {
        const slot = row.journey[i];
        if (slot) {
          line.push(
            slot.stage,
            formatEpoch(slot.stageTime),
            slot.subStage,
            formatEpochJoined(slot.subStageTime),
          );
        } else {
          line.push("", "", "", "");
        }
      }
      sheetRows.push(line);
    }
    console.log(`Built ${sheetRows.length - 1} formatted data rows.`);

    // Save to local cache so a failure in the Sheets step below doesn't force
    // a full Firestore re-fetch — just fix CONFIG and re-run with --from-cache.
    try {
      fs.writeFileSync(CONFIG.cacheFilePath, JSON.stringify(sheetRows));
      console.log(`Cached rows to ${CONFIG.cacheFilePath}.`);
    } catch (e) {
      console.warn(`Could not write cache file (non-fatal): ${e.message}`);
    }
  } // end of else (non-cache) branch

  // ---- Write to Google Sheets ----
  console.log(
    `Reading Sheets service account key from: ${CONFIG.sheetsServiceAccountPath}`,
  );
  if (!fs.existsSync(CONFIG.sheetsServiceAccountPath)) {
    throw new Error(
      `Sheets service account key file not found at ${CONFIG.sheetsServiceAccountPath}`,
    );
  }
  console.log("Authenticating with Google Sheets API...");
  const sheetsAuth = new google.auth.GoogleAuth({
    keyFile: CONFIG.sheetsServiceAccountPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({
    version: "v4",
    auth: await sheetsAuth.getClient(),
  });
  console.log("Authenticated.");

  try {
    console.log(`Clearing existing content in "${CONFIG.sheetName}"...`);
    await sheets.spreadsheets.values.clear({
      spreadsheetId: CONFIG.spreadsheetId,
      range: CONFIG.sheetName,
    });
    console.log("Cleared.");

    console.log(
      `Writing ${sheetRows.length - 1} rows to "${CONFIG.sheetName}"...`,
    );
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.spreadsheetId,
      range: `${CONFIG.sheetName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: sheetRows },
    });
  } catch (err) {
    if (err.code === 404) {
      throw new Error(
        `Spreadsheet not found. Double-check CONFIG.spreadsheetId ("${CONFIG.spreadsheetId}") is correct.`,
      );
    }
    if (err.code === 403) {
      throw new Error(
        `Permission denied writing to the spreadsheet. Share the sheet with this service account's ` +
          `client_email (found in service_account_key.json) as an Editor.`,
      );
    }
    if (err.message && err.message.includes("Unable to parse range")) {
      throw new Error(
        `Tab "${CONFIG.sheetName}" doesn't exist in the spreadsheet. Create a tab with that exact name, ` +
          `or update CONFIG.sheetName.`,
      );
    }
    throw err;
  }

  console.log(
    `Done. Wrote ${sheetRows.length - 1} rows (+ header) to "${CONFIG.sheetName}".`,
  );
}

main().catch((err) => {
  console.error("Script failed:");
  console.error(err);
  process.exit(1);
});
