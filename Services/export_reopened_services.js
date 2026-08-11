const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const FIREBASE_SERVICE_ACCOUNT_PATH = "./service_account_key.json";
const COLLECTION_NAME = "vaultServices";
const OUTPUT_CSV_PATH = "./reopened_services.csv";
const MAX_CYCLES = 4; // fixed at 4 closed/reopened pairs per your requirement
const INCLUDE_ZERO_REOPENS = false; // set true to include every service, even with 0 reopens

// ─── INIT FIREBASE ────────────────────────────────────────────────────────────

const serviceAccount = require(FIREBASE_SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Convert epoch seconds (or ms) to DD-MM-YY string in IST
function formatDateIST(epochValue) {
  if (epochValue === undefined || epochValue === null || epochValue === "")
    return "";

  let ms = Number(epochValue);
  if (isNaN(ms)) return "";

  // Heuristic: treat as seconds if it looks like a 10-digit epoch, else assume ms
  if (ms < 1e12) ms = ms * 1000;

  const date = new Date(ms);
  if (isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).formatToParts(date);

  const day = parts.find((p) => p.type === "day").value;
  const month = parts.find((p) => p.type === "month").value;
  const year = parts.find((p) => p.type === "year").value;

  return `${day}-${month}-${year}`;
}

// Safely turn servicePOC (could be string, object, or ref-like map) into a display string
function formatPOC(poc) {
  if (poc === undefined || poc === null) return "";
  if (typeof poc === "string") return poc;
  if (typeof poc === "object") {
    return poc.name || poc.email || poc.id || JSON.stringify(poc);
  }
  return String(poc);
}

// Escape a value for safe CSV output
function csvEscape(value) {
  const str = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Walk bucketTransitions (already in stored order) and extract closed periods.
// A new "closed period" starts each time bucket becomes "closed" after being something
// else (ignoring back-to-back duplicate "closed" entries). Each closed period is recorded
// on its own - with or without a reopen - so a closed period that hasn't reopened YET
// (e.g. the service is still currently closed) still shows up as its own closedDateN,
// just with a blank reopenedDateN, instead of being silently dropped.
function extractReopenCycles(bucketTransitions) {
  let currentBucket = "";

  if (!Array.isArray(bucketTransitions) || bucketTransitions.length === 0) {
    return {
      closedDates: [],
      reopenedDates: [],
      reopenedCount: 0,
      currentBucket,
    };
  }

  currentBucket = bucketTransitions[bucketTransitions.length - 1]?.bucket || "";

  const closedPeriods = []; // [{ closedAt, reopenedAt }]
  let openIndex = -1; // index of the most recent unresolved (not yet reopened) closed period

  for (let i = 0; i < bucketTransitions.length; i++) {
    const entry = bucketTransitions[i];
    const bucketName = (entry?.bucket || "").toLowerCase();
    const prevBucketName = (
      bucketTransitions[i - 1]?.bucket || ""
    ).toLowerCase();

    if (bucketName === "closed" && prevBucketName !== "closed") {
      // Start of a new closed period
      closedPeriods.push({ closedAt: entry.enteredAt, reopenedAt: null });
      openIndex = closedPeriods.length - 1;
    } else if (bucketName === "active" && openIndex !== -1) {
      // This resolves the most recent open closed period, whatever bucket(s) it
      // passed through in between (e.g. "blocked", "pre active")
      closedPeriods[openIndex].reopenedAt = entry.enteredAt;
      openIndex = -1;
    }
  }

  const closedDates = closedPeriods.map((p) => p.closedAt);
  const reopenedDates = closedPeriods.map((p) => p.reopenedAt);
  const reopenedCount = closedPeriods.filter(
    (p) => p.reopenedAt !== null,
  ).length;

  return { closedDates, reopenedDates, reopenedCount, currentBucket };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching all documents from "${COLLECTION_NAME}"...`);
  const snapshot = await db.collection(COLLECTION_NAME).get();
  console.log(`Found ${snapshot.size} documents. Processing...`);

  const rows = [];

  snapshot.forEach((doc) => {
    const data = doc.data();
    const serviceId = doc.id || data.serviceId || "";

    const { closedDates, reopenedDates, reopenedCount, currentBucket } =
      extractReopenCycles(data.bucketTransitions);

    if (!INCLUDE_ZERO_REOPENS && reopenedCount === 0) return;

    const row = {
      serviceId,
      reopenedCount,
      currentBucket,
      serviceStatus: data.serviceStatus ?? "",
      serviceStage: data.serviceStage ?? "",
      subStage: data.subStage ?? "",
      servicePOC: formatPOC(data.servicePOC),
    };

    for (let c = 0; c < MAX_CYCLES; c++) {
      row[`closedDate${c + 1}`] = formatDateIST(closedDates[c]);
      row[`reopenedDate${c + 1}`] = formatDateIST(reopenedDates[c]);
    }

    rows.push(row);
  });

  console.log(
    `${rows.length} services had at least one Closed -> Active reopen.`,
  );

  // ─── BUILD CSV ───────────────────────────────────────────────────────────
  const headers = ["serviceId"];
  for (let c = 1; c <= MAX_CYCLES; c++) {
    headers.push(`closedDate${c}`, `reopenedDate${c}`);
  }
  headers.push(
    "reopenedCount",
    "currentBucket",
    "serviceStatus",
    "serviceStage",
    "subStage",
    "servicePOC",
  );

  const lines = [headers.join(",")];

  for (const row of rows) {
    const line = headers.map((h) => csvEscape(row[h])).join(",");
    lines.push(line);
  }

  fs.writeFileSync(OUTPUT_CSV_PATH, lines.join("\n"), "utf8");
  console.log(`Done. CSV written to ${OUTPUT_CSV_PATH}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
