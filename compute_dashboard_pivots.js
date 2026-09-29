/**
 * compute_dashboard_pivots.js
 *
 * READ-ONLY SCRIPT — Firestore .get()/.where() reads only. No writes to Firestore.
 * The only writes this script performs are Google Sheets API writes to the
 * target spreadsheet (new/overwritten tabs), same pattern as exportPausedCases.js.
 *
 * Computes the daily dashboard tables and writes each to its own tab:
 *   1. "Pipeline Breakdown"     — cases entering pipeline today (fresh vs rotation)
 *   2. "Workable Cases"         — live workable-stage snapshot (bucket=active only)
 *   3. "Cases Worked Today"     — filings / doc-shared-closed / corrections / snoozed
 *   4. "POC Wise Work"          — per-POC filings/paused/RNR/correction/lost/closed/blocked
 *   5. "Bucket Breakdown"       — all serviceFlow=queue docs, by lifecycle bucket
 *   6. "Active Stage Breakdown" — of the Active bucket, by stage/substage x status
 *
 * Usage:
 *   node compute_dashboard_pivots.js
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const path = require("path");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
initializeApp({ credential: cert(require(SERVICE_ACCOUNT_PATH)) });
const db = getFirestore();
db.settings({ preferRest: true });

const SPREADSHEET_ID = "1KPInrAhZVJiqyfNPXxXemIlB1qjsLUrxh2rMjRgFu1g";

// Mirrors the Snapshot tab's "Pending for filing" funnel tier (build_workbook.py
// funnel_tiers) exactly — explicit workable (stage, substage) pairs, NOT the whole
// Doc/Filing stage. Filing/EC Applied is deliberately excluded: it's a BBMP
// dependency (external wait, same as Applied/Awaiting), not something a POC can
// act on — the Active Stage Breakdown tab itself classifies it that way. Fixed
// 15 Sep 2026 after a broader stage-level match silently counted 41 EC-Applied
// cases as "Fileable" workable work. EC Approved stays included (still workable).
const FILEABLE_PAIRS = [["Doc", "To Validate"], ["Filing", "In Queue"], ["Filing", "In Process"], ["Filing", "EC Approved"]];
const CORRECTION_SUBSTAGES = ["Correction Required"];

// ---------------------------------------------------------------- helpers

function startOfTodayIST() {
  const now = new Date();
  const istDateStr = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).toLocaleDateString("en-CA");
  return Math.floor(new Date(`${istDateStr}T00:00:00+05:30`).getTime() / 1000);
}
const TODAY_START = startOfTodayIST();
const TODAY_END = TODAY_START + 86400;

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function writeTab(sheets, tabName, values) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingTitles = meta.data.sheets.map((s) => s.properties.title);
  if (!existingTitles.includes(tabName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
  console.log(`  wrote ${values.length} rows to tab "${tabName}"`);
}

// Single source of truth for "what happened today" — both Table 3 (Cases
// Worked on Today) and Table 4 (POC Wise Work Today) must derive Filings from
// this exact same event log, deduped by serviceId, or the two totals drift
// apart. (Previously Table 3 counted filings by checking which cases are
// STILL sitting in Applied/Awaiting right now — a live snapshot that silently
// dropped any case that filed today and then also moved further the same day.)
let todaysEventsCache = null;
async function getTodaysEvents() {
  if (todaysEventsCache) return todaysEventsCache;
  const metricsSnap = await db.collection("vaultAgentActivityMetrics").get();
  const todays = [];
  metricsSnap.forEach((doc) => {
    const x = doc.data();
    const t = x.timestamp && x.timestamp._seconds ? x.timestamp._seconds : Number(x.timestamp);
    if (isNaN(t) || t < TODAY_START || t >= TODAY_END) return;
    todays.push(x);
  });
  todaysEventsCache = todays;
  return todays;
}

// Activity-log helpers — restored 23 Sep 2026. The raw FILING_COMPLETED/EC_APPLIED
// events in vaultAgentActivityMetrics can misattribute a filing: found a live case
// (SRB5758) where an admin (Vinod Bennur, authType api_key) bulk-pushed a case
// through To Close -> Filing -> Applied/Awaiting -> Correction Required in 16
// seconds, and the metric event credited it to Priyadarshini Moparty (the case's
// assigned POC) even though she never touched it. Per explicit instruction, a
// filing only counts if (a) the case's real per-user activity log shows an actual
// Doc/Filing -> Applied/Awaiting stage transition today, and (b) whoever performed
// it (the log's own `user` field) is the case's actual assigned POC — not an
// admin/System override acting on someone else's case.
const userActivityCache = new Map();
async function getUserActivity(userId) {
  if (!userId) return [];
  if (userActivityCache.has(userId)) return userActivityCache.get(userId);
  const doc = await db.collection("vaultUsers").doc(userId).get();
  const activity = doc.exists ? doc.data().activity || [] : [];
  userActivityCache.set(userId, activity);
  return activity;
}

// Walks one case's stage/substage activity entries in time order and returns the
// {time, actor} of the FIRST transition today that lands on (targetStage,
// targetSub) coming directly from a stage in fromStages — or null if none found.
function findStageTransitionToday(activity, serviceId, fromStages, targetStage, targetSub) {
  const relevant = activity.filter((a) => a && a.serviceId === serviceId && ["service stage", "sub-stage"].includes(a.target));
  const byTime = new Map();
  for (const a of relevant) {
    if (!byTime.has(a.time)) byTime.set(a.time, []);
    byTime.get(a.time).push(a);
  }
  const times = [...byTime.keys()].sort((x, y) => x - y);
  let curStage = null, curSub = null;
  for (const t of times) {
    const entries = byTime.get(t);
    const stageBefore = curStage;
    for (const a of entries) {
      if (a.target === "service stage") curStage = a.to;
      else if (a.target === "sub-stage") curSub = a.to;
    }
    if (t >= TODAY_START && t < TODAY_END && curStage === targetStage && curSub === targetSub && stageBefore && fromStages.includes(stageBefore)) {
      return { time: t, actor: entries[0].user };
    }
  }
  return null;
}

const CONCURRENCY = 6;
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Single source of truth for "genuine filings today" — shared by Table 3 (Cases
// Worked on Today) and Table 4 (POC Wise Work Today) so both derive the exact
// same verified set. Candidates come from the FILING_COMPLETED/EC_APPLIED
// activity-metric events (broad net, unrestricted by current stage), but each
// candidate is then verified against the case's real per-user activity log:
// kept only if (a) a genuine Doc/Filing -> Applied/Awaiting (or Doc -> Filing/EC
// Applied) transition actually happened today, and (b) the person who performed
// it matches the case's current servicePOC — filtering out admin/System
// overrides that the metrics log had wrongly attributed to the assigned POC.
let verifiedFilingsCache = null;
async function getVerifiedFilingsToday() {
  if (verifiedFilingsCache) return verifiedFilingsCache;
  const todays = await getTodaysEvents();
  const candidateIds = new Set();
  todays.forEach((x) => {
    if (x.metricType === "FILING_COMPLETED" || x.metricType === "EC_APPLIED") candidateIds.add(x.serviceId);
  });

  const result = new Map(); // serviceId -> { actor, isEc }
  await mapLimit([...candidateIds], CONCURRENCY, async (serviceId) => {
    const snap = await db.collection("vaultServices").where("serviceId", "==", serviceId).limit(1).get();
    if (snap.empty) return;
    const d = snap.docs[0].data();
    const activity = await getUserActivity(d.userId);
    const regular = findStageTransitionToday(activity, serviceId, ["Doc", "Filing"], "Applied", "Awaiting");
    const ec = findStageTransitionToday(activity, serviceId, ["Doc"], "Filing", "EC Applied");
    const hit = regular || ec;
    if (!hit) return; // no genuine transition found today — exclude
    if (!hit.actor || hit.actor === "System" || hit.actor !== d.servicePOC) return; // not done by the POC themselves
    result.set(serviceId, { actor: hit.actor, isEc: !!ec && !regular });
  });

  verifiedFilingsCache = result;
  return result;
}

// ---------------------------------------------------------------- Table 1 + 2 (share the workable-pair query)

async function computeTable1AndWorkable() {
  const pipelineSnap = await db.collection("vaultServices").where("pipelineEnteredAt", ">=", TODAY_START).where("pipelineEnteredAt", "<", TODAY_END).get();
  const qbSnap = await db.collection("vaultServices").where("queueBucketEnteredAt", ">=", TODAY_START).where("queueBucketEnteredAt", "<", TODAY_END).get();

  let fresh = 0, rotation = 0, totalQb = 0;
  qbSnap.forEach((doc) => {
    const d = doc.data();
    if (d.serviceFlow !== "queue") return;
    totalQb++;
    const bt = Array.isArray(d.bucketTransitions) ? d.bucketTransitions : [];
    const wentActiveToday = bt.some((t) => t.bucket === "active" && Number(t.enteredAt) >= TODAY_START && Number(t.enteredAt) < TODAY_END);
    if (wentActiveToday) fresh++;
    else rotation++;
  });

  const table1 = [
    ["Today's Pipeline/Queue Breakdown", ""],
    ["Total Cases Entering Pipeline Today", totalQb],
    ["Existing Case Rotation", rotation],
    ["Fresh", fresh],
  ];

  // Table 2 — bucket MUST be 'active' (fixes the blocked-bucket contamination bug found 10 Sep).
  // Not-snoozed is checked client-side since it's a queueBucket inequality alongside other equalities.
  // IMPORTANT: the snoozed exclusion only applies to OPEN cases (it's there to stop an
  // open-but-time-locked case from being counted as freely workable). It must NOT be applied
  // to PAUSED cases — pausing a case in this CRM always routes it through queueBucket=snoozed,
  // so filtering paused cases by notSnoozed zeroes the row out entirely (fixed 15 Sep 2026,
  // found via a live check showing 0 not-snoozed out of 64+8+2 actual paused workable cases).
  const notSnoozed = (doc) => doc.data().queueBucket !== "snoozed";
  const countPairs = async (pairs, status, excludeSnoozed) => {
    let n = 0;
    for (const [stage, sub] of pairs) {
      const snap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", status).where("serviceStage", "==", stage).where("subStage", "==", sub).get();
      n += excludeSnoozed ? snap.docs.filter(notSnoozed).length : snap.size;
    }
    return n;
  };

  const fileable = await countPairs(FILEABLE_PAIRS, "open", true);
  const totalPausedFileable = await countPairs(FILEABLE_PAIRS, "paused", false);
  const correctionOpenSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "open").where("serviceStage", "==", "Applied").where("subStage", "in", CORRECTION_SUBSTAGES).get();
  const correctionPausedSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "paused").where("serviceStage", "==", "Applied").where("subStage", "in", CORRECTION_SUBSTAGES).get();
  const approvedOpenSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "open").where("serviceStage", "==", "Applied").where("subStage", "==", "Approved").get();
  const approvedPausedSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "paused").where("serviceStage", "==", "Applied").where("subStage", "==", "Approved").get();

  const correctionFiling = correctionOpenSnap.docs.filter(notSnoozed).length;
  const verifyingApproved = approvedOpenSnap.docs.filter(notSnoozed).length;
  const totalOpen = fileable + correctionFiling + verifyingApproved;
  const totalPausedWorkable = totalPausedFileable + correctionPausedSnap.size + approvedPausedSnap.size;

  const pct = (n) => (totalOpen > 0 ? `${((n / totalOpen) * 100).toFixed(0)}%` : "0%");

  // This table counts every case CURRENTLY SITTING in a workable stage — whether
  // it's already assigned to a POC and being worked, still queued unassigned, or
  // open-but-time-locked (snoozed with a future unlock). It is NOT the same
  // question as Snapshot tab's "Queue right now → Available now", which counts
  // only cases free to hand to a POC this instant (isWaiting + not paused + not
  // still snoozed). The two numbers measure different things by design and will
  // never match — label baked in permanently (19 Sep 2026) so this doesn't need
  // re-explaining every time the two tables are compared side by side.
  const table2 = [
    ["Workable Cases", ""],
    ["Total cases in workable stages (assigned + queued + time-locked)", totalOpen],
    ["Fileable (Doc,Filing)", `${fileable} (${pct(fileable)})`],
    ["Correction Filing", `${correctionFiling} (${pct(correctionFiling)})`],
    ["Verifying approved document", `${verifyingApproved} (${pct(verifyingApproved)})`],
    ["Paused (workable stages, not counted in total)", totalPausedWorkable],
  ];

  return { table1, table2, totalQb, qbSnap };
}

// ---------------------------------------------------------------- Table 3

async function computeTable3(totalQb) {
  const todays = await getTodaysEvents();

  // Snoozed (Pause + RNR) — same bug pattern as Filings: this used to count
  // docs where queueBucketEnteredAt fell today AND queueBucket is CURRENTLY
  // "snoozed" — a proxy that misses any RNR'd case whose cooldown doesn't
  // route through the snoozed bucket, and misses paused cases whose
  // queueBucketEnteredAt wasn't bumped today. Fixed 18 Sep 2026 to count
  // unique serviceIds with an actual PAUSED or RNR event logged today,
  // straight from the same activity log that powers the POC table's
  // Paused/RNR columns — found via a live mismatch (27 here vs 57 summed
  // from the POC table for the same day).
  const snoozedTodayIds = new Set();
  todays.forEach((x) => {
    if (x.metricType === "PAUSED") snoozedTodayIds.add(x.serviceId);
    else if (x.metricType === "NOT_CONNECTED") {
      const cs = (x.payload && x.payload.callStatus) || "";
      if (/^rnr/.test(cs)) snoozedTodayIds.add(x.serviceId);
    }
  });
  const snoozedToday = snoozedTodayIds.size;

  // Filings — verified against the real activity log (see getVerifiedFilingsToday):
  // only counts a case if its stage genuinely moved Doc/Filing -> Applied/Awaiting
  // (or Doc -> Filing/EC Applied) today, AND the person who did it is that case's
  // actual assigned POC. Fixed 23 Sep 2026 after finding a case where an admin
  // bulk-pushed a stage change and the raw FILING_COMPLETED metric event wrongly
  // credited it to the case's assigned POC, who never touched it.
  const verifiedFilings = await getVerifiedFilingsToday();
  let filedCount = 0, ecFiledCount = 0;
  verifiedFilings.forEach(({ isEc }) => (isEc ? ecFiledCount++ : filedCount++));
  const totalFilings = filedCount + ecFiledCount;

  // Final Doc Shared & Payment Collected — active -> closed bucket move, today
  const closedSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "closed").get();
  let closedToday = 0;
  closedSnap.forEach((doc) => {
    const cbe = Number(doc.data().currentBucketEnteredAt);
    if (cbe >= TODAY_START && cbe < TODAY_END) closedToday++;
  });

  // Correction filed — every CORRECTION_APPLIED event logged today, deduped by serviceId.
  const correctionFiledIds = new Set();
  todays.forEach((x) => {
    if (x.metricType === "CORRECTION_APPLIED") correctionFiledIds.add(x.serviceId);
  });
  const correctionFiledCount = correctionFiledIds.size;

  // Correction Required pool size (denominator), active bucket only
  const correctionReqSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "open").where("serviceStage", "==", "Applied").where("subStage", "==", "Correction Required").get();
  const correctionReqPool = correctionReqSnap.size;

  const fileablePoolSnap = await Promise.all(
    [["Doc", "To Validate"], ["Filing", "In Queue"], ["Filing", "In Process"], ["Filing", "EC Approved"]].map(([s, sub]) =>
      db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "open").where("serviceStage", "==", s).where("subStage", "==", sub).get()
    )
  );
  const fileablePool = fileablePoolSnap.reduce((sum, s) => sum + s.size, 0);

  const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "0%");

  const table3 = [
    ["Cases Worked on Today", "", ""],
    ["Category", "Count", "Percentage"],
    ["Filings", `${totalFilings} (${ecFiledCount} ECs included) / ${fileablePool}`, pct(totalFilings, fileablePool)],
    ["Final Doc Shared & Payment Collected", closedToday, "-"],
    ["Correction filed", `${correctionFiledCount}/${correctionReqPool}`, pct(correctionFiledCount, correctionReqPool)],
    ["Snoozed (Pause + RNR)", `${snoozedToday}/${totalQb}`, pct(snoozedToday, totalQb)],
    ["Cases moved back to sales", 0, "0%"],
  ];
  return table3;
}

// ---------------------------------------------------------------- Table 4

async function computeTable4() {
  // Pull the real new-flow POC roster live (stream=queue_flow AND at least one role flag) —
  // do NOT hardcode names, so cleanup (like removing stale test/duplicate docs) is
  // automatically reflected next run.
  const agentsSnap = await db.collection("vaultInternalAgents").get();
  const pocRoles = {};
  agentsSnap.forEach((doc) => {
    const x = doc.data();
    const stream = String(x.stream || "").toLowerCase().replace(/\s+/g, "");
    const isQueueFlow = ["specialist", "queueflow", "queue_flow"].includes(stream) && (x.isEc || x.isL0 || x.isL1 || x.isClosure);
    if (!isQueueFlow || !x.name) return;
    const roles = [];
    if (x.isEc) roles.push("EC");
    if (x.isL0) roles.push("L0");
    if (x.isL1) roles.push("L1");
    if (x.isClosure) roles.push("Closure");
    if (x.onBreak) roles.push("on break");
    pocRoles[x.name] = roles.join("/");
  });
  const POCS = Object.keys(pocRoles);

  // live workable-visible count per POC (bucket=active fix applied) — same stage
  // groups as the Workable Cases table above, so per-POC counts sum to that total.
  // Also keep the breakdown per category so the cell can show e.g.
  // "5 (2 filing pending, 2 correction required, 1 approved verification)".
  const visible = {};
  const visibleBreakdown = {};
  for (const poc of POCS) {
    const notSnoozed = (doc) => doc.data().queueBucket !== "snoozed";
    let fileableCount = 0;
    for (const [stage, sub] of FILEABLE_PAIRS) {
      const snap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "open").where("servicePOC", "==", poc).where("serviceStage", "==", stage).where("subStage", "==", sub).get();
      fileableCount += snap.docs.filter(notSnoozed).length;
    }
    const correctionSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "open").where("servicePOC", "==", poc).where("serviceStage", "==", "Applied").where("subStage", "in", CORRECTION_SUBSTAGES).get();
    const approvedSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "active").where("serviceStatus", "==", "open").where("servicePOC", "==", poc).where("serviceStage", "==", "Applied").where("subStage", "==", "Approved").get();
    const correctionCount = correctionSnap.docs.filter(notSnoozed).length;
    const approvedCount = approvedSnap.docs.filter(notSnoozed).length;
    visible[poc] = fileableCount + correctionCount + approvedCount;
    visibleBreakdown[poc] = { fileableCount, correctionCount, approvedCount };
  }

  const formatVisible = (poc) => {
    const { fileableCount, correctionCount, approvedCount } = visibleBreakdown[poc];
    const parts = [];
    if (fileableCount) parts.push(`${fileableCount} filing pending`);
    if (correctionCount) parts.push(`${correctionCount} correction required`);
    if (approvedCount) parts.push(`${approvedCount} approved verification`);
    return parts.length ? `${visible[poc]} (${parts.join(", ")})` : "0";
  };

  // today's activity metrics — shared with Table 3 so both tables' Filings
  // numbers are derived from the exact same event log (see getTodaysEvents).
  const todays = await getTodaysEvents();

  const stats = {};
  POCS.forEach((p) => (stats[p] = { assignedIds: new Set(), filingIds: new Set(), paused: 0, rnr: 0, correctionApplied: 0, lost: 0, closed: 0, blocked: 0, missingDocIds: new Set(), actedIds: new Set() }));
  todays.forEach((x) => {
    const poc = x.pocName;
    if (!(poc in stats)) return;
    const s = stats[poc];
    if (x.metricType === "ASSIGNED") s.assignedIds.add(x.serviceId);
    else if (x.metricType === "PAUSED") { s.paused++; s.actedIds.add(x.serviceId); }
    else if (x.metricType === "NOT_CONNECTED") {
      const cs = (x.payload && x.payload.callStatus) || "";
      if (/^rnr/.test(cs)) { s.rnr++; s.actedIds.add(x.serviceId); }
    } else if (x.metricType === "CORRECTION_APPLIED") { s.correctionApplied++; s.actedIds.add(x.serviceId); }
    else if (x.metricType === "LOST") { s.lost++; s.actedIds.add(x.serviceId); }
    else if (x.metricType === "CASE_CLOSED") { s.closed++; s.actedIds.add(x.serviceId); }
    else if (x.metricType === "BLOCKED") { s.blocked++; s.actedIds.add(x.serviceId); }
    // DOC_INCOMPLETE — POC reviewed the case and flagged it missing documents.
    // Deduped by serviceId since the same case can be flagged more than once a day.
    else if (x.metricType === "DOC_INCOMPLETE") { s.missingDocIds.add(x.serviceId); s.actedIds.add(x.serviceId); }
  });

  // Filings — attributed by the verified activity-log actor (see
  // getVerifiedFilingsToday), not by the metrics log's pocName, since that field
  // can point at the case's assigned POC even when someone else (an admin/System
  // override) actually performed the stage change.
  const verifiedFilings = await getVerifiedFilingsToday();
  verifiedFilings.forEach(({ actor }, serviceId) => {
    if (!(actor in stats)) return;
    stats[actor].filingIds.add(serviceId);
    stats[actor].actedIds.add(serviceId);
  });

  // "Total Assigned Today" only counts assigned cases that were actually
  // actionable — either they're CURRENTLY sitting in a workable stage/substage
  // (Applied/Awaiting, To Close/Doc Shared, and closed-bucket cases don't
  // qualify), OR the POC logged a real action on them today (a filing, RNR,
  // missing-doc flag, etc.). The second half matters because acting on a case
  // can itself move it OUT of the workable bucket (e.g. flagging Missing
  // Documents shifts bucket to pre-active) — without it, a POC's own work
  // would make their count look smaller, not larger.
  const isWorkableStage = (stage, sub) =>
    FILEABLE_PAIRS.some(([s, su]) => s === stage && su === sub) ||
    (stage === "Applied" && (CORRECTION_SUBSTAGES.includes(sub) || sub === "Approved"));

  const allAssignedIds = [...new Set(POCS.flatMap((p) => [...stats[p].assignedIds]))];
  const stageById = {};
  for (let i = 0; i < allAssignedIds.length; i += 10) {
    const chunk = allAssignedIds.slice(i, i + 10);
    if (chunk.length === 0) continue;
    const snap = await db.collection("vaultServices").where("serviceId", "in", chunk).get();
    snap.docs.forEach((doc) => {
      const d = doc.data();
      stageById[d.serviceId] = { bucket: d.bucket, stage: d.serviceStage, sub: d.subStage };
    });
  }
  const workableAssignedCount = (poc) =>
    [...stats[poc].assignedIds].filter((id) => {
      if (stats[poc].actedIds.has(id)) return true;
      const d = stageById[id];
      return d && d.bucket === "active" && isWorkableStage(d.stage, d.sub);
    }).length;

  const table4 = [["POC", "Role", "Total Assigned Today", "Cases Pending Work (live)", "Filings", "Missing Documents", "Paused", "RNR", "Correction Applied", "Lost", "Closed", "Blocked"]];
  POCS.sort((a, b) => (stats[b].filingIds.size - stats[a].filingIds.size) || (visible[b] - visible[a]))
    .forEach((poc) => {
      const s = stats[poc];
      table4.push([poc, pocRoles[poc], workableAssignedCount(poc), formatVisible(poc), s.filingIds.size, s.missingDocIds.size, s.paused, s.rnr, s.correctionApplied, s.lost, s.closed, s.blocked]);
    });
  return table4;
}

// ---------------------------------------------------------------- Table 5 + 6 (Queue Lifecycle Tables)

// Task tagline shown to the POC on the workable card — mirrors
// src/pages/vault/services/WorkableCardComponents/stageTaglines.ts in the CRM
// codebase (default variant only; EC/BESCOM overrides omitted here for simplicity).
const STAGE_TAGLINES = {
  "Doc / To Validate": "Verify the documents of the customer and start filing the {serviceName} application.",
  "Filing / In Queue": "The {serviceName} case was rejected. Please re-apply carefully with correct details and documents.",
  "Filing / In Process": "Verify the documents of the customer and start filing the {serviceName} application.",
  "Filing / EC Approved": "Please file the {serviceName} application. EC has already been approved.",
  "Applied / Correction Required": "File the required correction of the {serviceName} application carefully.",
  "Applied / Approved": "The {serviceName} application has been approved — download the approved document and verify all customer details are correct.",
};

// Meaning classification per stage/substage — matches the reference sheet exactly.
const STAGE_MEANING = {
  "Doc / To Validate": "Workable - POC Dependency",
  "Filing / In Queue": "Workable - POC Dependency",
  "Filing / In Process": "Workable - POC Dependency",
  "Filing / EC Applied": "BBMP Dependency",
  "Filing / EC Approved": "Workable - POC Dependency",
  "Applied / Awaiting": "BBMP Dependency",
  "Applied / Correction Required": "Workable - POC Dependency",
  "Applied / Correction Applied": "BBMP Dependency",
  "Applied / Approved": "Workable - POC Dependency",
  "To Close / Doc Shared": "Customer Dependency",
};

// Fixed display order, matching the reference sheet row numbering.
const STAGE_DISPLAY_ORDER = [
  ["2.1", "Doc", "To Validate"],
  ["2.2", "Filing", "In Queue"],
  ["2.3", "Filing", "In Process"],
  ["2.4", "Filing", "EC Applied"],
  ["2.5", "Filing", "EC Approved"],
  ["2.6", "Applied", "Awaiting"],
  ["2.7", "Applied", "Correction Required"],
  ["2.8", "Applied", "Correction Applied"],
  ["2.8", "Applied", "Approved"],
  ["3.0", "To Close", "Doc Shared"],
];

async function computeTable5AndTable6() {
  const allSnap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").get();
  const N = allSnap.size;

  const bucketCounts = { "pre active": 0, active: 0, blocked: 0, closedArch: 0 };
  const activeDocs = [];
  allSnap.forEach((doc) => {
    const d = doc.data();
    const bucket = String(d.bucket || "").toLowerCase();
    if (bucket === "pre active") bucketCounts["pre active"]++;
    else if (bucket === "active") { bucketCounts.active++; activeDocs.push(d); }
    else if (bucket === "blocked") bucketCounts.blocked++;
    else if (bucket === "closed" || bucket === "archived") bucketCounts.closedArch++;
  });

  const pct1 = (n) => (N > 0 ? `${Math.round((n / N) * 100)}%` : "0%");

  const table5 = [
    [`Where are all ${N.toLocaleString("en-IN")} cases in their lifecycle right now?`, "", "", ""],
    ["Bucket", "Meaning", "Count", "%"],
    ["1. Pre-active", "Moved back - missing docs", bucketCounts["pre active"], pct1(bucketCounts["pre active"])],
    ["2. Active", "Running services", bucketCounts.active, pct1(bucketCounts.active)],
    ["3. Blocked", "Moved to block", bucketCounts.blocked, pct1(bucketCounts.blocked)],
    ["4. Closed & Arch.", "Completed services", bucketCounts.closedArch, pct1(bucketCounts.closedArch)],
  ];

  // Table 6 — within Active bucket only
  const M = activeDocs.length;
  const rows = {};
  let anyClosedStatusFootnote = false;
  activeDocs.forEach((d) => {
    const key = `${d.serviceStage || "?"} / ${d.subStage || "?"}`;
    if (!rows[key]) rows[key] = { open: 0, paused: 0, lost: 0, other: 0 };
    const status = String(d.serviceStatus || "").toLowerCase();
    if (status === "open") rows[key].open++;
    else if (status === "paused") rows[key].paused++;
    else if (status === "lost") rows[key].lost++;
    else { rows[key].other++; if (status === "closed") anyClosedStatusFootnote = true; }
  });

  const pct2 = (n) => (M > 0 ? `${Math.round((n / M) * 100)}%` : "0%");

  const table6 = [
    [`Of the ${M.toLocaleString("en-IN")} Active cases - where exactly are they stuck?`, "", "", "", "", "", ""],
    ["Stage-Substage", "What do POC see as the task?", "Meaning", "Open", "Paused", "Lost", "Total", "Percentage"],
  ];
  let sumTotal = 0;
  for (const [num, stage, sub] of STAGE_DISPLAY_ORDER) {
    const key = `${stage} / ${sub}`;
    const r = rows[key] || { open: 0, paused: 0, lost: 0, other: 0 };
    const total = r.open + r.paused + r.lost + r.other;
    sumTotal += total;
    const tagline = STAGE_TAGLINES[key] || "-";
    const meaning = STAGE_MEANING[key] || "";
    table6.push([`${num} ${key}`, tagline, meaning, r.open, r.paused, r.lost, total, pct2(total)]);
  }
  if (anyClosedStatusFootnote) {
    table6.push(["Note: some Active-bucket docs have serviceStatus=='closed' — included in Total but not shown as their own column.", "", "", "", "", "", "", ""]);
  }
  // sanity check row
  table6.push(["Sanity check: sum of Totals above", "", "", "", "", "", sumTotal, sumTotal === M ? "matches M ✓" : `MISMATCH — M=${M}`]);

  return { table5, table6 };
}

// ---------------------------------------------------------------- Table 7 (Missing Documents Aging)

async function computeTable7MissingDocsAging() {
  const snap = await db.collection("vaultServices").where("serviceFlow", "==", "queue").where("bucket", "==", "pre active").where("serviceStatus", "==", "open").where("serviceStage", "==", "qualified").get();
  const now = Math.floor(Date.now() / 1000);
  // Aging is by SERVICE CREATION DATE (the "added" field), not by when the case
  // was flagged Missing Documents — per explicit instruction, since a case's
  // real age is how long the SR itself has existed, not how long it's carried
  // this particular flag.
  const BUCKET_DEFS = [
    ["0-3 days", 0, 3],
    ["3-7 days", 3, 7],
    ["7-15 days", 7, 15],
    ["15-30 days", 15, 30],
    ["30+ days", 30, Infinity],
  ];
  const counts = BUCKET_DEFS.map(() => 0);
  const total = snap.size;
  snap.forEach((doc) => {
    const added = Number(doc.data().added);
    const daysSince = added ? (now - added) / 86400 : 0;
    const idx = BUCKET_DEFS.findIndex(([, lo, hi]) => daysSince >= lo && daysSince <= hi);
    counts[idx >= 0 ? idx : BUCKET_DEFS.length - 1]++;
  });
  const pct = (n) => (total > 0 ? `${((n / total) * 100).toFixed(0)}%` : "0%");

  const table7 = [
    ["Missing Documents — Aging (by service creation date)", "", ""],
    ["Age", "Count", "% of total"],
    ...BUCKET_DEFS.map(([label], i) => [label, counts[i], pct(counts[i])]),
    ["Total", total, "100%"],
  ];
  return { table7 };
}

// ---------------------------------------------------------------- Single-tab layout engine

const SNAPSHOT_TAB = "Overview";

// Colors matched to the reference sheet: tan/cream section-title bar, blue column-header bar.
const TITLE_BG = { red: 0.996, green: 0.902, blue: 0.804 }; // ~#FEE6CD, cream/tan
const HEADER_BG = { red: 0.788, green: 0.855, blue: 0.973 }; // ~#C9DAF8, light blue
const THIN_BLACK = { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 } };

// A "block" is { rows: string[][], titleRowIdxs: number[], headerRowIdx: number|null }.
// titleRowIdxs = rows (0-based, within this block) that get merged across the full
// block width, bolded, centered, and given the tan background (e.g. "Workable Cases").
// headerRowIdx = the single row (0-based) that's the blue bolded column-header row
// (e.g. "Category | Count | Percentage"), or null if the block has no such row.
function makeBlock(rows, titleRowIdxs, headerRowIdx) {
  const numCols = Math.max(...rows.map((r) => r.length));
  return { rows, titleRowIdxs, headerRowIdx, numCols, numRows: rows.length };
}

// Places a block into the sparse grid at (startRow, startCol) [0-based], records the
// formatting requests needed (merges, backgrounds, bold, borders), and returns the
// occupied {endRow, endCol} (both exclusive) so callers can lay out the next block.
function placeBlock(grid, formatRequests, sheetId, startRow, startCol, block) {
  block.rows.forEach((row, r) => {
    for (let c = 0; c < block.numCols; c++) {
      const rIdx = startRow + r;
      const cIdx = startCol + c;
      if (!grid[rIdx]) grid[rIdx] = [];
      grid[rIdx][cIdx] = row[c] !== undefined ? row[c] : "";
    }
  });

  const fullRange = (r0, r1, c0, c1) => ({
    sheetId,
    startRowIndex: startRow + r0,
    endRowIndex: startRow + r1,
    startColumnIndex: startCol + c0,
    endColumnIndex: startCol + c1,
  });

  // Border around the whole block, including inner gridlines.
  formatRequests.push({
    updateBorders: {
      range: fullRange(0, block.numRows, 0, block.numCols),
      top: THIN_BLACK, bottom: THIN_BLACK, left: THIN_BLACK, right: THIN_BLACK,
      innerHorizontal: THIN_BLACK, innerVertical: THIN_BLACK,
    },
  });

  // Title rows: merge across full width, bold, centered, tan background.
  block.titleRowIdxs.forEach((r) => {
    formatRequests.push({ mergeCells: { range: fullRange(r, r + 1, 0, block.numCols), mergeType: "MERGE_ALL" } });
    formatRequests.push({
      repeatCell: {
        range: fullRange(r, r + 1, 0, block.numCols),
        cell: { userEnteredFormat: { backgroundColor: TITLE_BG, textFormat: { bold: true }, horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
      },
    });
  });

  // Column-header row: blue background, bold, no merge (keeps per-column labels visible).
  if (block.headerRowIdx !== null && block.headerRowIdx !== undefined) {
    const r = block.headerRowIdx;
    formatRequests.push({
      repeatCell: {
        range: fullRange(r, r + 1, 0, block.numCols),
        cell: { userEnteredFormat: { backgroundColor: HEADER_BG, textFormat: { bold: true }, horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
      },
    });
  }

  // First column of non-title, non-header rows is bold+left-aligned label text
  // (matches the reference sheet's row-label styling, e.g. "Total Workable cases...").
  block.rows.forEach((row, r) => {
    if (block.titleRowIdxs.includes(r) || r === block.headerRowIdx) return;
    formatRequests.push({
      repeatCell: {
        range: fullRange(r, r + 1, 0, 1),
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      },
    });
  });

  return { endRow: startRow + block.numRows, endCol: startCol + block.numCols };
}

function gridToValues(grid) {
  // Build with an explicit for-loop (not .map/.reduce) — `grid` is a sparse array
  // (rows/cells are set by direct index assignment, e.g. grid[5][3] = x, leaving
  // earlier indices as unset holes). Array methods like .map skip holes and leave
  // them as holes in the result too, which JSON.stringify then serializes as
  // `null` — and the Sheets API silently drops/shifts null rows on write. Looping
  // by numeric index and defaulting every unset row/cell to "" guarantees a fully
  // dense, hole-free 2D array with no gaps for JSON to mangle.
  let maxCol = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i]) maxCol = Math.max(maxCol, grid[i].length);
  }
  const values = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    const out = new Array(maxCol).fill("");
    if (row) {
      for (let c = 0; c < row.length; c++) {
        out[c] = row[c] === undefined || row[c] === null ? "" : row[c];
      }
    }
    values.push(out);
  }
  return values;
}

async function ensureSheet(sheets, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (existing) return existing.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Dashboard pivots — ${new Date(TODAY_START * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })} (IST)`);

  console.log("1/6 Pipeline breakdown + workable cases...");
  const { table1, table2, totalQb } = await computeTable1AndWorkable();

  console.log("2/6 Cases worked today (filings/correction/snoozed)...");
  const table3 = await computeTable3(totalQb);

  console.log("3/6 POC-wise work today...");
  const table4 = await computeTable4();

  console.log("4/6 Queue lifecycle tables (bucket breakdown + active stage breakdown)...");
  const { table5, table6 } = await computeTable5AndTable6();

  console.log("5/6 Missing Documents aging...");
  const { table7 } = await computeTable7MissingDocsAging();

  console.log("6/6 Laying out and writing the single 'Overview' tab...");
  const sheets = await getSheetsClient();
  const sheetId = await ensureSheet(sheets, SNAPSHOT_TAB);
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${SNAPSHOT_TAB}!A:Z` });
  // Clear any leftover formatting from a previous run (merges/colors/borders) before
  // re-applying fresh ones, since row/column counts can shift day to day.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ updateCells: { range: { sheetId }, fields: "userEnteredFormat" } }] },
  });

  const grid = [];
  const formatRequests = [];

  const nowIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  grid[0] = [`Last updated at: ${nowIST} IST`];
  formatRequests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { italic: true } } },
      fields: "userEnteredFormat.textFormat",
    },
  });

  const GAP = 1; // blank column/row between blocks

  // --- Row group 1: Pipeline Breakdown | Workable Cases | Cases Worked Today ---
  const blockPipeline = makeBlock(table1, [0], null);
  const blockWorkable = makeBlock(table2, [0], null);
  const blockWorked = makeBlock(table3, [0], 1);

  const row1Start = 2; // leave row 1 blank under the "Last updated" line
  const p1 = placeBlock(grid, formatRequests, sheetId, row1Start, 0, blockPipeline);
  const p2 = placeBlock(grid, formatRequests, sheetId, row1Start, p1.endCol + GAP, blockWorkable);
  const p3 = placeBlock(grid, formatRequests, sheetId, row1Start, p2.endCol + GAP, blockWorked);
  const row1End = Math.max(p1.endRow, p2.endRow, p3.endRow);

  // --- Row group 2: POC Wise Work (full width) ---
  const blockPoc = makeBlock(table4, [], 0);
  // table4 has no dedicated title row — prepend one so it matches the visual style
  // of every other block (tan title bar above a blue column-header row).
  blockPoc.rows = [["POC Wise Work Today", ...Array(blockPoc.numCols - 1).fill("")], ...blockPoc.rows];
  blockPoc.titleRowIdxs = [0];
  blockPoc.headerRowIdx = 1;
  blockPoc.numRows = blockPoc.rows.length;

  const row2Start = row1End + GAP + 1;
  const p4 = placeBlock(grid, formatRequests, sheetId, row2Start, 0, blockPoc);

  // --- Row group 3: Bucket Breakdown | Active Stage Breakdown ---
  const blockBucket = makeBlock(table5, [0], 1);
  const blockActiveStage = makeBlock(table6, [0], 1);

  const row3Start = p4.endRow + GAP + 1;
  const p5 = placeBlock(grid, formatRequests, sheetId, row3Start, 0, blockBucket);

  // Active Stage Breakdown goes on its own row group, full width, below
  // everything else — keeps it from cramping column widths next to Bucket
  // Breakdown, and gives its long tagline text room to wrap.
  const row4Start = p5.endRow + GAP + 1;
  const activeStageCol = 0;
  const p6 = placeBlock(grid, formatRequests, sheetId, row4Start, activeStageCol, blockActiveStage);

  // The tagline ("What do POC see as the task?") column holds long sentences —
  // wrap it instead of letting auto-resize blow the column out to one
  // unreadable line, and cap its pixel width explicitly.
  const taglineCol = activeStageCol + 1; // 2nd column within blockActiveStage
  formatRequests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: row4Start + 2, endRowIndex: p6.endRow, startColumnIndex: taglineCol, endColumnIndex: taglineCol + 1 },
      cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
      fields: "userEnteredFormat.wrapStrategy",
    },
  });

  // --- Row group 5: Missing Documents Aging ---
  const blockAging = makeBlock(table7, [0], 1);
  const row5Start = p6.endRow + GAP + 1;
  const p7 = placeBlock(grid, formatRequests, sheetId, row5Start, 0, blockAging);

  // Center-align every cell written so far (values + labels), applied last so
  // it doesn't get overridden by earlier per-block formatting (which only set
  // background/bold, not alignment, except title/header rows which already
  // center — this just extends that to every other cell too).
  const lastRow = p7.endRow;
  const lastCol = Math.max(p3.endCol, p4.endCol, p6.endCol, p7.endCol);
  formatRequests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: lastCol },
      cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
      fields: "userEnteredFormat.horizontalAlignment",
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SNAPSHOT_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: gridToValues(grid) },
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: formatRequests } });

  // Clean up the old separate tabs from before consolidation — everything now
  // lives in the single "Overview" tab above.
  const OLD_TABS = ["Pipeline Breakdown", "Workable Cases", "Cases Worked Today", "POC Wise Work", "Bucket Breakdown", "Active Stage Breakdown", "Easy Snapshot"];
  const meta2 = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const deleteRequests = meta2.data.sheets
    .filter((s) => OLD_TABS.includes(s.properties.title))
    .map((s) => ({ deleteSheet: { sheetId: s.properties.sheetId } }));
  if (deleteRequests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: deleteRequests } });
    console.log(`  removed ${deleteRequests.length} old separate tab(s)`);
  }

  // Fixed column widths, locked to what the user manually approved as the final
  // look (captured directly from the sheet on 10 Sep 2026) — NOT auto-resize,
  // which would re-stretch columns differently on every run based on whatever
  // that day's longest string happens to be. Columns beyond index 10 aren't
  // covered by any block, so they're left at the sheet's default width.
  const FIXED_COLUMN_WIDTHS = [366, 320, 187, 305, 62, 54, 236, 159, 80, 51, 58];
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: FIXED_COLUMN_WIDTHS.map((pixelSize, i) => ({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
          properties: { pixelSize },
          fields: "pixelSize",
        },
      })),
    },
  });

  // Pin Overview to the first tab position — this script runs LAST in the daily
  // pipeline (after sync_workbook_to_google_sheet.js, which sets the workbook's
  // own tab order and doesn't know Overview exists), so it must claim index 0
  // itself every run rather than relying on wherever addSheet happened to put it.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId, index: 0 }, fields: "index" } }] },
  });

  console.log(`\nDone — "${SNAPSHOT_TAB}" tab updated with all 6 tables, formatted, and pinned to position 1.`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exitCode = 1;
});
