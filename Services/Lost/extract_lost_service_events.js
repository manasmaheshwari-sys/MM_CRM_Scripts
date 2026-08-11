// extract_lost_service_events.js
// Queries vaultUsers collection, scans each doc's "activity" array (sub-keys "0","1","2"...)
// Finds entries where: action = "changed", from = "open", target = "service status", to = "lost"
// Outputs CSV with: serviceId, user, date, time (epoch converted to standard date/time)

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");

// ---- CONFIG ----
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json"); // update path if needed
const OUTPUT_CSV = path.join(__dirname, "lost_service_events.csv");
const BATCH_SIZE = 500;

// ---- INIT ----
initializeApp({
  credential: cert(require(SERVICE_ACCOUNT_PATH)),
});

const db = getFirestore();
db.settings({ preferRest: true });

// ---- EPOCH CONVERSION ----
// Handles epoch in seconds or milliseconds automatically
function epochToDateTime(epoch) {
  if (epoch === undefined || epoch === null || epoch === "") {
    return { date: "", time: "" };
  }
  let ms = Number(epoch);
  if (isNaN(ms)) return { date: "", time: "" };
  // if it looks like seconds (10 digits), convert to ms
  if (ms < 1e12) ms = ms * 1000;

  const d = new Date(ms);
  if (isNaN(d.getTime())) return { date: "", time: "" };

  const date = d.toISOString().split("T")[0]; // YYYY-MM-DD
  const time = d.toTimeString().split(" ")[0]; // HH:MM:SS (local server time)
  return { date, time };
}

// ---- CSV ESCAPE ----
function csvEscape(val) {
  if (val === undefined || val === null) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---- MAIN ----
async function main() {
  const rows = [];
  let lastDoc = null;
  let totalDocsScanned = 0;
  let totalMatches = 0;

  console.log("Starting scan of vaultUsers collection...");

  while (true) {
    let query = db
      .collection("vaultUsers")
      .orderBy("__name__")
      .limit(BATCH_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      totalDocsScanned++;
      const data = doc.data();
      const activity = data.activity;

      if (!activity) continue;

      // activity may be an array or a map with keys "0","1","2"...
      const entries = Array.isArray(activity)
        ? activity
        : Object.values(activity);

      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;

        const action = entry.action;
        const from = entry.from;
        const target = entry.target;
        const to = entry.to;

        if (
          action === "changed" &&
          from === "open" &&
          target === "service status" &&
          to === "lost"
        ) {
          const { date, time } = epochToDateTime(entry.time);
          rows.push({
            serviceId: entry.serviceId ?? "",
            user: entry.user ?? "",
            epoch: entry.time ?? "",
            date,
            time,
          });
          totalMatches++;
        }
      }
    }

    console.log(
      `Scanned ${totalDocsScanned} docs so far, matches found: ${totalMatches}`,
    );

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < BATCH_SIZE) break;
  }

  // ---- WRITE CSV ----
  const header = "serviceId,user,epoch,date,time\n";
  const body = rows
    .map(
      (r) =>
        `${csvEscape(r.serviceId)},${csvEscape(r.user)},${csvEscape(r.epoch)},${csvEscape(r.date)},${csvEscape(r.time)}`,
    )
    .join("\n");

  fs.writeFileSync(OUTPUT_CSV, header + body, "utf8");

  console.log(`\nDone. Total docs scanned: ${totalDocsScanned}`);
  console.log(`Total matching activity events: ${totalMatches}`);
  console.log(`CSV written to: ${OUTPUT_CSV}`);
}

main().catch((err) => {
  console.error("Error running script:", err);
  process.exit(1);
});
