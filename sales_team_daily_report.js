/**
 * sales_team_daily_report.js
 *
 * READ-ONLY on Firestore (.get() only). Writes ONLY to a new tab in the target Google Sheet
 * (default tab "Daily Report (Auto)"); never touches Sheet1.
 *
 * Logic (confirmed with user 2026-11-13):
 *   Window   Daily = one IST day (default: yesterday). MTD = 1st of that day's month -> that day.
 *   POCs     vaultInternalAgents where status active and (department sales OR role salesPOC),
 *            shown only if they have any call / PI / payment in the MTD window.
 *            Names from other sources are mapped via sales_report_config.json "aliases" or by
 *            normalised-prefix match to a unique agent. Unmatched names keep their raw label.
 *   Calls    vaultAcefoneCallLogs only, inbound + outbound. A call is "connected" when
 *            talkTimeSec >= 20 AND outcome === "answered". Counted as UNIQUE leads (vaultUserId)
 *            per agent: Daily = unique within that day (a lead called on two days shows in both
 *            daily reports); MTD = unique across the month.
 *   Talk time  not built in the current scope.
 *   PI Created  vaultProforma count by `added` date, attributed to `createdBy`.
 *   PI %        PI Created / Calls Taken.
 *   PI Count    same PIs as PI Created. Conversion = those PIs with totalPaid > 0 (paid at any time).
 *   Achieved / Collected by  payments inside vaultProforma.proformaServices[].payments[] whose
 *            paymentDate is in the window, credited to payment.agentName, paymentAmount as stored
 *            (what was actually collected, GST included). All agents are listed in Collected by.
 *   Target   sales_report_config.json "defaultTarget" (₹4,00,000) or per-person "targets".
 *
 * Usage:
 *   node sales_team_daily_report.js [YYYY-MM-DD] [--dry]
 *   Needs ./service_account_key.json (Firestore) and ./sheets_service_account_key.json (Sheets,
 *   sheet shared with its client email as Editor). Without the Sheets key it runs as a dry run.
 * Env: SHEET_ID, SHEET_TAB
 */
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

const SHEET_ID = process.env.SHEET_ID || "1wmMecwuC1lxrnpIk7hiA30KnRVts_t2azxddVWtFAbA";
const SHEET_TAB = process.env.SHEET_TAB || "Daily Report (Auto)";
const KEY = path.join(__dirname, "service_account_key.json");
const SHEETS_KEY_OWN = path.join(__dirname, "sheets_service_account_key.json");
// Use a dedicated Sheets key if present, otherwise reuse the Firebase service account
const SHEETS_KEY = fs.existsSync(SHEETS_KEY_OWN) ? SHEETS_KEY_OWN : KEY;
const CONFIG_PATH = path.join(__dirname, "sales_report_config.json");
const config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : { defaultTarget: 400000, targets: {}, aliases: {} };
config.defaultTarget ??= 400000; config.targets ??= {}; config.aliases ??= {};

initializeApp({ credential: cert(require(KEY)) });
const db = getFirestore();
db.settings({ preferRest: true });

// ---------- dates (IST) ----------
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
function yesterdayIst() { const d = istNow(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
const epoch = (s, end) => Math.floor(new Date(`${s}T${end ? "23:59:59" : "00:00:00"}+05:30`).getTime() / 1000);

// ---------- name resolution ----------
const norm = (s) => String(s || "").toLowerCase().replace(/-?extension/g, "").replace(/[^a-z]/g, "");
let agentNames = []; // canonical sales agent names
const resolveCache = new Map();
function resolve(raw) {
  if (!raw) return "(unattributed)";
  if (resolveCache.has(raw)) return resolveCache.get(raw);
  let out = config.aliases[raw] || null;
  if (!out) {
    const n = norm(raw);
    const hits = agentNames.filter((a) => { const m = norm(a); return m === n || (n.length >= 4 && (m.startsWith(n) || n.startsWith(m))); });
    out = hits.length === 1 ? hits[0] : raw.trim();
  }
  resolveCache.set(raw, out);
  return out;
}

async function loadSalesAgents() {
  const snap = await db.collection("vaultInternalAgents").get();
  const set = new Set();
  snap.forEach((d) => {
    const x = d.data();
    const sales = /sales/i.test(x.department || "") || x.role === "salesPOC";
    if (sales && x.status === "active" && x.name && !/service delivery/i.test(x.department || "")) set.add(x.name.trim());
  });
  return [...set];
}

// ---------- accumulators ----------
const mk = () => ({ leadsD: new Set(), leadsM: new Set(), talkD: 0, talkM: 0, piD: 0, piM: 0, paidPiD: 0, paidPiM: 0, payD: 0, payM: 0 });
const by = new Map();
const get = (n) => { if (!by.has(n)) by.set(n, mk()); return by.get(n); };

// ---------- formatting ----------
const rgb = (h) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });
const INR = '[>=10000000]"₹"##\\,##\\,##\\,##0;[>=100000]"₹"##\\,##\\,##0;"₹"##,##0';

async function formatTab(sheets, spreadsheetId, tab, o) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sh = meta.data.sheets.find((s) => s.properties.title === tab);
  const sheetId = sh.properties.sheetId;
  // drop old conditional rules so reruns stay clean
  const reqs = (sh.conditionalFormats || []).map(() => ({ deleteConditionalFormatRule: { sheetId, index: 0 } }));
  const rg = (r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
  const fmt = (range, f, fields) => reqs.push({ repeatCell: { range, cell: { userEnteredFormat: f }, fields: fields || "userEnteredFormat" } });
  const NAVY = "#1F3A5F", BLUE = "#2F6DB5", BAND = "#EEF4FB", TOTAL = "#D6E4F5";
  const left = (r, c) => fmt(rg(r, r + 1, c, c + 1), { horizontalAlignment: "LEFT" }, "userEnteredFormat.horizontalAlignment");

  fmt(rg(0, 200, 0, 22), { backgroundColor: rgb("#FFFFFF"), textFormat: { fontFamily: "Arial", fontSize: 10 }, verticalAlignment: "MIDDLE" });
  reqs.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { hideGridlines: true } }, fields: "gridProperties.hideGridlines" } });
  const widths = [14, 170, 130, 110, 100, 18, 170, 130, 110, 100, 18, 170, 120, 120, 110, 110, 18, 190, 130, 110];
  widths.forEach((w, i) => reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: "pixelSize" } }));

  const white = { foregroundColor: rgb("#FFFFFF") };
  const title = (r, c0, c1) => fmt(rg(r, r + 1, c0, c1), { backgroundColor: rgb(NAVY), textFormat: { ...white, bold: true, fontSize: 11 }, horizontalAlignment: "LEFT" });
  const head = (r, c0, c1) => fmt(rg(r, r + 1, c0, c1), { backgroundColor: rgb(BLUE), textFormat: { ...white, bold: true }, horizontalAlignment: "CENTER", wrapStrategy: "WRAP" });
  const body = (r0, n, c0, c1) => {
    for (let i = 0; i < n; i++) fmt(rg(r0 + i, r0 + i + 1, c0, c1), { backgroundColor: rgb(i % 2 ? BAND : "#FFFFFF") }, "userEnteredFormat.backgroundColor");
    fmt(rg(r0, r0 + n, c0 + 1, c1), { horizontalAlignment: "CENTER" }, "userEnteredFormat.horizontalAlignment");
  };
  const total = (r, c0, c1) => {
    fmt(rg(r, r + 1, c0, c1), { backgroundColor: rgb(TOTAL), textFormat: { bold: true }, borders: { top: { style: "SOLID_MEDIUM", color: rgb(NAVY) } } }, "userEnteredFormat(backgroundColor,textFormat,borders)");
    fmt(rg(r, r + 1, c0 + 1, c1), { horizontalAlignment: "CENTER" }, "userEnteredFormat.horizontalAlignment");
  };
  const numfmt = (r0, r1, c, pattern, type) => fmt(rg(r0, r1, c, c + 1), { numberFormat: { type: type || "PERCENT", pattern } }, "userEnteredFormat.numberFormat");
  const scale = (r0, r1, c, lo, hi, reverse) => reqs.push({ addConditionalFormatRule: { index: 0, rule: { ranges: [rg(r0, r1, c, c + 1)], gradientRule: {
    minpoint: { color: rgb(reverse ? "#63BE7B" : "#F8696B"), type: "NUMBER", value: String(lo) },
    midpoint: { color: rgb("#FFEB84"), type: "NUMBER", value: String((lo + hi) / 2) },
    maxpoint: { color: rgb(reverse ? "#F8696B" : "#63BE7B"), type: "NUMBER", value: String(hi) } } } } });

  const n = o.n, tot1 = 2 + n, r2 = o.r2, tot2 = r2 + 2 + n;
  for (const c of [o.B, o.G]) {
    title(0, c, c + 4); head(1, c, c + 4); body(2, n, c, c + 4); total(tot1, c, c + 4);
    title(r2, c, c + 4); head(r2 + 1, c, c + 4); body(r2 + 2, n, c, c + 4); total(tot2, c, c + 4);
    numfmt(2, tot1 + 1, c + 3, "0%"); numfmt(r2 + 2, tot2 + 1, c + 3, "0%");
    scale(2, tot1, c + 3, 0, 0.25);        // PI %: red = low, green = 25%+
    scale(r2 + 2, tot2, c + 3, 0, 1);      // Conversion %: red = 0, green = 100%
    left(1, c); left(r2 + 1, c);
  }
  const L = o.L; title(0, L, L + 5); head(1, L, L + 5); body(2, n, L, L + 5); total(2 + n, L, L + 5);
  numfmt(2, n + 3, L + 1, INR, "NUMBER"); numfmt(2, n + 3, L + 2, INR, "NUMBER");
  numfmt(2, n + 3, L + 3, "0.0%"); numfmt(2, n + 3, L + 4, "0.0%");
  scale(2, 2 + n, L + 3, 0, 1); scale(2, 2 + n, L + 4, 0, 1, true); // Achieved % green high, Deficit % red high
  left(1, L);
  const R = o.R; head(0, R, R + 3); body(1, o.m, R, R + 3); left(0, R);
  numfmt(1, o.m + 1, R + 1, INR, "NUMBER"); numfmt(1, o.m + 1, R + 2, INR, "NUMBER");
  fmt(rg(o.lastRow - 1, o.lastRow, 0, 10), { textFormat: { italic: true, fontSize: 9, foregroundColor: rgb("#777777") }, horizontalAlignment: "LEFT" });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: reqs } });
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || yesterdayIst();
  const monthStart = day.slice(0, 8) + "01";
  const dS = epoch(day), dE = epoch(day, true), mS = epoch(monthStart);
  console.log(`Daily=${day}  MTD=${monthStart}..${day}  (IST)${dry ? "  [DRY RUN]" : ""}`);

  agentNames = await loadSalesAgents();
  console.log(`Active sales agents in CRM: ${agentNames.length}`);

  // Calls (Acefone logs)
  const calls = await db.collection("vaultAcefoneCallLogs").where("added", ">=", mS).where("added", "<=", dE).get();
  calls.forEach((doc) => {
    const c = doc.data();
    // inbound + outbound both count; attribute to the answering agent
    const a = get(resolve(c.agent_name || (c.agents && c.agents[0] && c.agents[0].name)));
    const t = Number(c.talkTimeSec) || 0;
    const inDay = c.added >= dS;
    // connected = talk >= 20s AND outcome is "answered" (no_answer never counts, whatever the duration)
    if (t >= 20 && c.outcome === "answered") {
      const lead = c.vaultUserId || c.call_to_number;
      a.leadsM.add(lead); if (inDay) a.leadsD.add(lead);
    }
  });

  // PIs created + paid
  const pis = await db.collection("vaultProforma").where("added", ">=", mS).where("added", "<=", dE).get();
  pis.forEach((doc) => {
    const p = doc.data();
    const a = get(resolve(p.createdBy));
    const paid = (Number(p.totalPaid) || 0) > 0;
    a.piM++; if (paid) a.paidPiM++;
    if (p.added >= dS) { a.piD++; if (paid) a.paidPiD++; }
  });

  // Payments by payment date
  const pays = await db.collection("vaultProforma").where("lastPaymentAt", ">=", mS).get();
  pays.forEach((doc) => {
    for (const sv of doc.data().proformaServices || []) for (const p of sv.payments || []) {
      if (typeof p.paymentDate !== "number" || p.paymentDate < mS || p.paymentDate > dE) continue;
      const a = get(resolve(p.agentName));
      const amt = Number(p.paymentAmount) || 0;
      a.payM += amt; if (p.paymentDate >= dS) a.payD += amt;
    }
  });

  // ---------- build tables ----------
  const salesSet = new Set(agentNames);
  const pocs = [...by.entries()].filter(([n, v]) => salesSet.has(n) &&
    (v.leadsM.size || v.piM || v.payM)).map(([n]) => n).sort();
  const pct = (a, b) => (b ? a / b : 0); // fraction; formatted as % in the sheet
  const sum = (f) => pocs.reduce((s, n) => s + f(by.get(n)), 0);

  const grid = [];
  const put = (r, c, v) => { (grid[r] ??= [])[c] = v; };
  const B = 1, G = 6, L = 11, R = 17; // column offsets (A=0)

  // Block 1: Calls to PI
  const callsBlock = (r0, col, tag, kl, kp) => {
    put(r0, col, "Calls to PI"); put(r0, col + 1, tag);
    ["Sales POC", "Calls Taken ( >20 sec) Unique", "PI Created", "PI %"].forEach((h, i) => put(r0 + 1, col + i, h));
    pocs.forEach((n, i) => { const v = by.get(n); const l = v[kl].size, p = v[kp];
      [n, l, p, pct(p, l)].forEach((x, j) => put(r0 + 2 + i, col + j, x)); });
    const tl = sum((v) => v[kl].size), tp = sum((v) => v[kp]);
    ["Total", tl, tp, pct(tp, tl)].forEach((x, j) => put(r0 + 2 + pocs.length, col + j, x));
  };
  callsBlock(0, B, "Daily", "leadsD", "piD");
  callsBlock(0, G, "MTD", "leadsM", "piM");

  // Block 2: PI to Conversion
  const r2 = pocs.length + 4;
  const convBlock = (col, tag, kp, kc) => {
    put(r2, col, "PI to Conversion"); put(r2, col + 1, tag);
    ["Sales POC", "PI Count", "Conversion", "Conversion %"].forEach((h, i) => put(r2 + 1, col + i, h));
    pocs.forEach((n, i) => { const v = by.get(n);
      [n, v[kp], v[kc], pct(v[kc], v[kp])].forEach((x, j) => put(r2 + 2 + i, col + j, x)); });
    const tp = sum((v) => v[kp]), tc = sum((v) => v[kc]);
    ["Total", tp, tc, pct(tc, tp)].forEach((x, j) => put(r2 + 2 + pocs.length, col + j, x));
  };
  convBlock(B, "Daily", "piD", "paidPiD");
  convBlock(G, "MTD", "piM", "paidPiM");

  // (talk-time table intentionally skipped in the current scope)

  // Block 4: target vs achieved (MTD)
  put(0, L, "Daily Report"); put(0, L + 1, `MTD to ${day}`);
  ["Sales POC", "Monthly Target", "Achieved", "Achieved %", "Deficit %"].forEach((h, i) => put(1, L + i, h));
  let tT = 0, tA = 0;
  const byAch = [...pocs].sort((a, b) => by.get(b).payM - by.get(a).payM);
  byAch.forEach((n, i) => {
    const t = config.targets[n] ?? config.defaultTarget, a = by.get(n).payM; tT += t; tA += a;
    const p = t ? a / t : 0;
    [n, t, a, p, Math.max(0, 1 - p)].forEach((x, j) => put(2 + i, L + j, x));
  });
  const tp = tT ? tA / tT : 0;
  ["Total", tT, tA, tp, Math.max(0, 1 - tp)].forEach((x, j) => put(2 + pocs.length, L + j, x));

  // Block 5: collected by (all agents, MTD)
  put(0, R, "Collected by (MTD)"); put(0, R + 1, "Amount (INR)"); put(0, R + 2, "Daily");
  const collectors = [...by.entries()].filter(([, v]) => v.payM).sort((a, b) => b[1].payM - a[1].payM);
  collectors.forEach(([n, v], i) => { put(1 + i, R, n); put(1 + i, R + 1, v.payM); put(1 + i, R + 2, v.payD); });

  // normalise holes
  const width = Math.max(...grid.filter(Boolean).map((r) => r.length));
  const values = Array.from({ length: grid.length }, (_, i) => Array.from({ length: width }, (_, j) => grid[i]?.[j] ?? ""));
  values.push([]); values.push(["", `Generated ${istNow().toISOString().slice(0, 16).replace("T", " ")} IST · Daily=${day} · MTD=${monthStart}..${day}`]);

  console.table(values.slice(0, 40).map((r) => r.slice(0, 5)));
  console.log(`POCs shown: ${pocs.length}; non-sales payment collectors: ${[...by.entries()].filter(([n, v]) => v.payM && !salesSet.has(n)).length}`);
  const unmatched = [...by.keys()].filter((n) => !salesSet.has(n));
  console.log("Names not matched to an active sales agent:", unmatched.join(" | "));

  if (dry) { console.log("Dry run: nothing written to the sheet."); return; }

  const { google } = require("googleapis");
  const auth = new google.auth.GoogleAuth({ keyFile: SHEETS_KEY, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  if (!meta.data.sheets.some((s) => s.properties.title === SHEET_TAB)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] } });
  }
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${SHEET_TAB}'` });
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${SHEET_TAB}'!A1`, valueInputOption: "RAW", requestBody: { values } });
  console.log(`Wrote ${values.length} rows to tab "${SHEET_TAB}".`);
  await formatTab(sheets, SHEET_ID, SHEET_TAB, { n: pocs.length, m: collectors.length, r2, B, G, L, R, lastRow: values.length });
  console.log("Formatting applied.");
}

main().catch((e) => { console.error(e); process.exit(1); });
