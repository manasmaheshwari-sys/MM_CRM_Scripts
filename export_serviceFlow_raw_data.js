/**
 * export_serviceFlow_raw_data.js
 *
 * READ-ONLY SCRIPT — Firestore .stream() reads only. No writes.
 *
 * Purpose:
 *   Streams every vaultServices doc with serviceFlow == "queue" and writes
 *   one row per case with the fields needed for the queue-flow usage report
 *   (headline, pipeline health, movement/friction) to a CSV for Excel.
 *
 * Usage:
 *   node export_serviceFlow_raw_data.js [output.csv]
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
initializeApp({ credential: cert(require(SERVICE_ACCOUNT_PATH)) });
const db = getFirestore();
db.settings({ preferRest: true });

const LAUNCH_EPOCH = Math.floor(new Date("2026-08-24T00:00:00+05:30").getTime() / 1000);
const NOW_EPOCH = Math.floor(Date.now() / 1000);

function toEpoch(v) {
  if (v === undefined || v === null || v === "") return null;
  let ms = Number(v);
  if (isNaN(ms)) return null;
  return ms < 1e12 ? ms : Math.floor(ms / 1000);
}
function fmtDate(epochSec) {
  if (epochSec === null) return "";
  return new Date(epochSec * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function safe(v, fb = "") {
  return v === undefined || v === null ? fb : v;
}
function csvEscape(v) {
  const s = String(v === undefined || v === null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const outputPath = process.argv[2] || path.join(__dirname, "serviceFlow_raw_data.csv");

  const header = [
    "serviceId", "serviceName", "servicePOC", "acquisitionPOC", "queueRole", "queueBucket",
    "bucket", "serviceStatus", "serviceStage", "subStage",
    "createdDate", "pipelineEnteredDate", "isNewSinceLaunch",
    "currentBucketEnteredDate", "isClosed", "closedSinceLaunch",
    "endToEndTatDays", "slaTargetDate", "metSla",
    "serviceAmount", "amountPaid", "invoiced", "paymentStatus",
    "callStatus", "isRnrCallStatus", "escalated", "escalatedLevel",
    "reAppliedCount", "pausedNow", "pauseNoteCount", "notConnectedRnrNoteCount",
    "stageTransitionNoteCount", "tatOverdueTaskCount",
    "activePipelineAgingDays", "activePipelineAgingBucket",
    "isWorkableNow",
    "leadType", "isFiled", "isPaymentReceived", "isPendingForFiling", "currentPauseReason",
    "inFlightAgingDays", "inFlightAgingBucket",
    // Appended at the END (not inserted earlier) so every existing column letter
    // stays put — build_workbook.py has ~50 hardcoded column-letter references
    // (rng("G"), rng("H"), etc.) keyed to the layout above; adding columns here
    // instead of in the middle keeps all of those correct without touching them.
    "customerName", "phoneNumber",
    // Also appended (same reasoning as above) — full pause detail, mirroring
    // exportPausedCases.js's PausedCases sheet columns exactly.
    "pausedNoteType", "pausedNoteDate", "pausedReasonDetail",
    "pauseDependencyServiceId", "pauseDueToDependency", "pausedByDetail", "pausedUntilDetail",
    // Customer email — lives on the linked vaultUsers doc (field emailAddress),
    // not on the vaultServices doc itself, so it needs a separate lookup below.
    "customerEmail",
    // Also appended (same reasoning) — who flagged the case Missing Documents
    // (updateBy.missingDocuments, the per-field audit tracker MissingDocsModal
    // writes when it sets the `missingDocuments` field) and the Sales POC
    // (serviceSalesPOC, not the acquisition/lead-source POC in column D).
    "missingDocsMarkedBy", "serviceSalesPOC", "missingDocList",
  ];

  const rows = [header.join(",")];
  let total = 0;

  const WORKABLE = new Set([
    "Doc / To Validate",
    "Filing / In Queue",
    "Filing / In Process",
    "Filing / EC Approved",
    "Applied / Correction Required",
  ]);

  // Collect docs first (still streamed for memory efficiency), then resolve
  // customer emails in a second, concurrency-limited async pass — the
  // "stream" API's data handler isn't awaited, so an async per-row Firestore
  // lookup can't happen inline inside it.
  const docs = [];
  await new Promise((resolve, reject) => {
    const stream = db.collection("vaultServices").where("serviceFlow", "==", "queue").stream();
    stream.on("data", (doc) => docs.push({ id: doc.id, data: doc.data() }));
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  const userEmailCache = new Map();
  async function getCustomerEmail(userId) {
    if (!userId) return "";
    if (userEmailCache.has(userId)) return userEmailCache.get(userId);
    let email = "";
    try {
      const userDoc = await db.collection("vaultUsers").doc(userId).get();
      email = userDoc.exists ? safe(userDoc.data().emailAddress) : "";
    } catch (err) {
      console.error(`  failed to fetch email for userId ${userId}: ${err.message}`);
    }
    userEmailCache.set(userId, email);
    return email;
  }

  const CONCURRENCY = 8;
  async function mapLimit(items, limit, fn) {
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  await mapLimit(docs, CONCURRENCY, async ({ id, data: d }) => {
      const doc = { id };
      total++;

      const bucket = safe(d.bucket);
      const status = safe(d.serviceStatus);
      const stage = safe(d.serviceStage);
      const sub = safe(d.subStage);

      const createdAt = toEpoch(d.added);
      const pipelineEnteredAt = toEpoch(d.pipelineEnteredAt);
      const closedAt = bucket === "closed" ? toEpoch(d.currentBucketEnteredAt) : null;
      const slaTargetEpoch = d.tat ? toEpoch(d.tat.serviceTat) : null;

      const isNewSinceLaunch = pipelineEnteredAt !== null && pipelineEnteredAt >= LAUNCH_EPOCH;
      const isClosed = bucket === "closed";
      const closedSinceLaunch = isClosed && closedAt !== null && closedAt >= LAUNCH_EPOCH;
      const endToEndTatDays =
        isClosed && closedAt !== null && createdAt !== null
          ? +((closedAt - createdAt) / 86400).toFixed(2)
          : "";
      const metSla =
        isClosed && closedAt !== null && slaTargetEpoch !== null ? (closedAt <= slaTargetEpoch ? "Yes" : "No") : "";

      const callStatus = safe(d.callStatus);
      const isRnr = /^rnr/i.test(callStatus);

      const notes = Array.isArray(d.notes) ? d.notes : [];
      const pauseNoteCount = notes.filter((n) => n && n.type === "pause note").length;
      const notConnectedRnrNoteCount = notes.filter(
        (n) => n && n.type === "not connected note" && /rnr/i.test(safe(n.noteReason))
      ).length;
      const stageTransitionNoteCount = notes.filter((n) => n && n.type === "stage transition note").length;

      const tasks = Array.isArray(d.communicationTasks) ? d.communicationTasks : [];
      const tatOverdueTaskCount = tasks.filter((t) => t && t.triggerEvent === "tat_overdue").length;

      let agingDays = "";
      let agingBucket = "";
      const isActive = status === "open" && bucket !== "closed" && bucket !== "archived";
      if (isActive) {
        const anchor = toEpoch(d.currentPocAssignedAt) ?? toEpoch(d.waitingSince);
        if (anchor !== null) {
          const days = (NOW_EPOCH - anchor) / 86400;
          agingDays = +days.toFixed(2);
          agingBucket = days <= 1 ? "0-1d" : days <= 3 ? "1-3d" : days <= 7 ? "3-7d" : "7d+";
        } else {
          agingBucket = "unknown";
        }
      }

      // Broader "in flight" aging: same anchor logic, but covers OPEN and PAUSED cases
      // (anything still in the flow, not closed/archived) — used for stage-level aging
      // views (e.g. Pending for Filing) where paused cases shouldn't silently disappear.
      let inFlightAgingDays = "";
      let inFlightAgingBucket = "";
      const isInFlight = bucket !== "closed" && bucket !== "archived";
      if (isInFlight) {
        const anchor = toEpoch(d.currentPocAssignedAt) ?? toEpoch(d.waitingSince);
        if (anchor !== null) {
          const days = (NOW_EPOCH - anchor) / 86400;
          inFlightAgingDays = +days.toFixed(2);
          inFlightAgingBucket = days <= 1 ? "0-1d" : days <= 3 ? "1-3d" : days <= 7 ? "3-7d" : "7d+";
        } else {
          inFlightAgingBucket = "unknown";
        }
      }

      const stageSubKey = `${stage} / ${sub}`;
      const isWorkableNow = isActive && WORKABLE.has(stageSubKey) ? "Yes" : "No";

      // Old Lead = case existed before the flow launched; New Lead = created on/after launch.
      const leadType = createdAt !== null && createdAt >= LAUNCH_EPOCH ? "New Lead" : "Old Lead";

      // "Filed" = application has been filed with the authority (appliedDate is set).
      const isFiled = toEpoch(d.appliedDate) !== null ? "Yes" : "No";

      // "Payment Received" = any amount collected against the service.
      const isPaymentReceived = (Number(d.amountPaid) || 0) > 0 ? "Yes" : "No";

      // "Pending for Filing" = docs are in, sitting in the Filing queue, not yet filed.
      const isPendingForFiling = stage === "Filing" && sub === "In Queue" ? "Yes" : "No";

      // Reason from the most recent "pause note", only meaningful for currently-paused cases.
      let currentPauseReason = "";
      if (status === "paused") {
        const pauseNotes = notes
          .filter((n) => n && n.type === "pause note")
          .map((n) => ({ time: toEpoch(n.noteEntryDateTime) || 0, reason: safe(n.noteReason, "(no reason)") }));
        if (pauseNotes.length > 0) {
          pauseNotes.sort((a, b) => b.time - a.time);
          currentPauseReason = pauseNotes[0].reason;
        } else {
          currentPauseReason = "(no reason)";
        }
      }

      // Fuller pause detail — mirrors exportPausedCases.js's extractPauseReasons
      // exactly: pausedBy/pausedUntil/dependency come from the doc's TOP-LEVEL
      // pauseMetadata (sibling of notes), while note type/date/content come from
      // the most recent note that looks pause-related (broader match than just
      // type === "pause note" — exportPausedCases.js matches on either the type
      // OR the content mentioning "pause", since some pause notes are logged
      // under other note types). noteContent (not noteReason) is the real
      // free-text reason — noteReason/pauseMetadata.reason is often just a vague
      // dropdown value ("Other", blank), as found when auditing paused cases
      // earlier — noteContent nearly always has the actual explanation.
      let pausedNoteType = "", pausedNoteDate = "", pausedReasonDetail = "";
      let pausedByDetail = "", pausedUntilDetail = "", pauseDependencyServiceId = "", pauseDueToDependency = "";
      if (status === "paused") {
        const pm = d.pauseMetadata || null;
        pausedByDetail = safe(pm && pm.pausedBy);
        pausedUntilDetail = fmtDate(toEpoch(pm && pm.pausedUntil));
        pauseDependencyServiceId = safe(pm && pm.dependencyServiceId);
        pauseDueToDependency = pm && typeof pm.dueToDependency === "boolean" ? (pm.dueToDependency ? "Yes" : "No") : "";

        const pauseRelatedNotes = notes
          .filter((n) => n && (/pause/i.test(safe(n.type)) || /pause/i.test(safe(n.noteContent))))
          .map((n) => ({ time: toEpoch(n.noteEntryDateTime) || 0, type: safe(n.type), content: safe(n.noteContent) }));
        if (pauseRelatedNotes.length > 0) {
          pauseRelatedNotes.sort((a, b) => b.time - a.time);
          const latest = pauseRelatedNotes[0];
          pausedNoteType = latest.type;
          pausedNoteDate = fmtDate(latest.time || null);
          pausedReasonDetail = latest.content;
        }
      }

      const customerEmail = await getCustomerEmail(d.userId);

      rows.push(
        [
          safe(d.serviceId || doc.id),
          safe(d.serviceName),
          safe(d.servicePOC, "Unassigned"),
          safe(d.acquisitionPOC),
          safe(d.queueRole, "(unassigned)"),
          safe(d.queueBucket, "(none)"),
          bucket,
          status,
          stage,
          sub,
          fmtDate(createdAt),
          fmtDate(pipelineEnteredAt),
          isNewSinceLaunch ? "Yes" : "No",
          fmtDate(closedAt),
          isClosed ? "Yes" : "No",
          closedSinceLaunch ? "Yes" : "No",
          endToEndTatDays,
          fmtDate(slaTargetEpoch),
          metSla,
          Number(d.serviceAmount) || 0,
          Number(d.amountPaid) || 0,
          d.invoiced === true ? "Yes" : "No",
          safe(d.paymentStatus),
          callStatus,
          isRnr ? "Yes" : "No",
          d.escalated === true ? "Yes" : "No",
          safe(d.escalatedLevel, ""),
          Number(d.reAppliedCount) || 0,
          status === "paused" ? "Yes" : "No",
          pauseNoteCount,
          notConnectedRnrNoteCount,
          stageTransitionNoteCount,
          tatOverdueTaskCount,
          agingDays,
          agingBucket,
          isWorkableNow,
          leadType,
          isFiled,
          isPaymentReceived,
          isPendingForFiling,
          currentPauseReason,
          inFlightAgingDays,
          inFlightAgingBucket,
          safe(d.userName),
          safe(d.phoneNumber),
          pausedNoteType,
          pausedNoteDate,
          pausedReasonDetail,
          pauseDependencyServiceId,
          pauseDueToDependency,
          pausedByDetail,
          pausedUntilDetail,
          customerEmail,
          safe(d.updateBy && d.updateBy.missingDocuments, ""),
          safe(d.serviceSalesPOC, ""),
          safe(Array.isArray(d.missingDocuments) ? d.missingDocuments.join(", ") : "", ""),
        ]
          .map(csvEscape)
          .join(",")
      );

      if (total % 200 === 0) console.log(`  ...processed ${total} docs`);
  });

  fs.writeFileSync(outputPath, rows.join("\n"));
  console.log(`\nDone. ${total} rows written to ${outputPath}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
