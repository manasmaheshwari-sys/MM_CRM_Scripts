/**
 * export_meta_marketing_data.js
 *
 * READ-ONLY SCRIPT — Firestore .get() reads only. No writes.
 *
 * Pulls one row per Meta LEAD for the Meta marketing report's "Data" tab.
 *
 * A lead is a vaultServices doc with serviceSource = Meta / facebook / instagram (any
 * case) that is, or has been, in bucket "pre active" (current bucket or any
 * bucketTransitions entry), and whose owning vaultUsers.acquisitionPOC is
 * ACQUISITION_POC (Manas Pandit). Lead date = the service's `added` (IST).
 *   - Interest / Connected by come from the owning vaultUsers doc (CRM status only).
 *   - Qualified = this service's serviceStage is "qualified" (vs "unqualified"), or it
 *     has already moved on to bucket active.
 *   - Moved to Active = bucketTransitions shows "active" after "pre active", or the
 *     current bucket is active.
 *   - Proforma / money = this service's line inside vaultProforma.proformaServices
 *     (draft and lost proformas excluded).
 *   - Test leads (userName contains "test") are kept but flagged Is Test = 1.
 *
 * Usage:
 *   node export_meta_marketing_data.js [output.json]
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

initializeApp({ credential: cert(require(path.join(__dirname, "service_account_key.json"))) });
const db = getFirestore();
db.settings({ preferRest: true });

const OUTPUT = path.resolve(process.argv[2] || path.join(__dirname, "Meta_Leads_Data.json"));
const ACQUISITION_POC = "Manas Pandit";
const META_SOURCES = ["Meta", "meta", "META", "facebook", "Facebook", "instagram", "Instagram"];

const istDate = (ts) => (ts ? new Date(Number(ts) * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : "");

// A real sales call connect wins over the WhatsApp bot, so a bot lead the sales team
// later spoke to counts under "Sales team".
function connectedBy(u) {
  if (Number(u.connectedAttempts) > 0 || String(u.callStatus || "").toLowerCase() === "connected") return "Sales team";
  if (u.whatsappConversationInitiated === true) return "WhatsApp bot";
  return "Not connected";
}

async function inChunks(collection, field, values, fields) {
  const out = [];
  for (let i = 0; i < values.length; i += 30) {
    const snap = await db.collection(collection).where(field, "in", values.slice(i, i + 30)).select(...fields).get();
    snap.forEach((d) => out.push({ _id: d.id, ...d.data() }));
  }
  return out;
}

async function main() {
  // ---------- Meta services that are / were pre active
  const snap = await db
    .collection("vaultServices")
    .where("serviceSource", "in", META_SOURCES)
    .select("serviceId", "userId", "serviceName", "serviceSource", "serviceSubsource", "utmParams", "added", "bucket", "bucketTransitions", "serviceStage", "subStage", "serviceStatus")
    .get();
  const services = [];
  snap.forEach((d) => {
    const s = { ...d.data(), serviceId: d.data().serviceId || d.id };
    const bt = (Array.isArray(s.bucketTransitions) ? s.bucketTransitions : []).filter((t) => t && t.bucket).sort((a, b) => Number(a.enteredAt) - Number(b.enteredAt));
    const cur = String(s.bucket || "").toLowerCase();
    const preIdx = bt.findIndex((t) => t.bucket === "pre active");
    if (preIdx < 0 && cur !== "pre active") return;
    const activeAfter = preIdx >= 0 ? bt.slice(preIdx + 1).find((t) => t.bucket === "active") : null;
    s._movedToActive = Boolean(activeAfter) || cur === "active";
    s._activeAt = activeAfter ? Number(activeAfter.enteredAt) : null;
    s._preAt = preIdx >= 0 ? Number(bt[preIdx].enteredAt) : null;
    services.push(s);
  });
  services.sort((a, b) => Number(a.added) - Number(b.added));
  console.log(`Meta services: ${snap.size}, of which pre-active leads: ${services.length}`);

  // ---------- Owning users (CRM interest / call status)
  const userIds = [...new Set(services.map((s) => s.userId).filter(Boolean))];
  const users = new Map();
  for (const u of await inChunks("vaultUsers", "userId", userIds, ["userId", "userName", "userInterest", "callStatus", "connectedAttempts", "callAttempts", "whatsappConversationInitiated", "salesPOC", "acquisitionPOC"])) {
    users.set(u.userId || u._id, u);
  }

  // Only leads whose user was acquired by ACQUISITION_POC (trim / case-insensitive)
  const pocKey = ACQUISITION_POC.toLowerCase();
  const before = services.length;
  for (let i = services.length - 1; i >= 0; i--) {
    const u = users.get(services[i].userId);
    if (!u || String(u.acquisitionPOC || "").trim().toLowerCase() !== pocKey) services.splice(i, 1);
  }
  console.log(`acquisitionPOC = ${ACQUISITION_POC}: ${services.length} of ${before} leads kept`);

  // ---------- Proforma lines per service
  const pfByService = new Map();
  for (const p of await inChunks("vaultProforma", "userId", userIds, ["userId", "piid", "proformaStatus", "isDrafted", "proformaServices"])) {
    const st = String(p.proformaStatus || "").toLowerCase();
    if (p.isDrafted === true || st === "draft" || st === "lost") continue;
    for (const line of Array.isArray(p.proformaServices) ? p.proformaServices : []) {
      if (!line || !line.serviceId || line.isDeleted === true) continue;
      if (!pfByService.has(line.serviceId)) pfByService.set(line.serviceId, []);
      pfByService.get(line.serviceId).push({ piid: p.piid, amount: Number(line.serviceAmount) || 0, paid: Number(line.amountPaid) || 0 });
    }
  }

  const rows = services.map((s) => {
    const u = users.get(s.userId) || {};
    const pf = pfByService.get(s.serviceId) || [];
    const invoiced = pf.reduce((x, p) => x + p.amount, 0);
    const paid = pf.reduce((x, p) => x + p.paid, 0);
    const stage = String(s.serviceStage || "");
    return {
      "Service ID": s.serviceId,
      "User ID": s.userId || "",
      "User Name": u.userName || "",
      "Lead Date": istDate(s.added),
      "Service Name": s.serviceName || "",
      Subsource: s.serviceSubsource || "",
      "UTM Campaign": (s.utmParams && s.utmParams.utm_campaign) || "",
      Interest: String(u.userInterest || "").toLowerCase(),
      "Connected By": connectedBy(u),
      "Call Status": u.callStatus || "",
      "Call Attempts": Number(u.callAttempts) || 0,
      "Connected Attempts": Number(u.connectedAttempts) || 0,
      "Service Stage": stage,
      "Sub Stage": s.subStage || "",
      Bucket: s.bucket || "",
      "Service Status": s.serviceStatus || "",
      Qualified: stage.toLowerCase() === "qualified" || s._movedToActive ? 1 : 0,
      "Moved to Active": s._movedToActive ? 1 : 0,
      "Pre-Active Date": istDate(s._preAt),
      "Active Date": istDate(s._activeAt),
      Proformas: new Set(pf.map((p) => p.piid)).size,
      "Proforma Raised": pf.length ? 1 : 0,
      "Invoiced Amount": invoiced,
      "Paid Amount": paid,
      Paid: paid > 0 ? 1 : 0,
      "Sales POC": u.salesPOC || "",
      "Acquisition POC": u.acquisitionPOC || "",
      "Is Test": /test/i.test(u.userName || "") ? 1 : 0,
    };
  });

  const start = rows.length ? rows[0]["Lead Date"] : new Date().toISOString().slice(0, 10);
  fs.writeFileSync(OUTPUT, JSON.stringify({ start, generatedAt: new Date().toISOString(), rows }, null, 1));

  const real = rows.filter((r) => !r["Is Test"]);
  const c = (f) => real.filter(f).length;
  console.log(`test leads flagged: ${rows.length - real.length}; first lead date ${start}`);
  console.log(`connected sales=${c((r) => r["Connected By"] === "Sales team")} bot=${c((r) => r["Connected By"] === "WhatsApp bot")} none=${c((r) => r["Connected By"] === "Not connected")}`);
  console.log(`interest ${JSON.stringify(real.reduce((m, r) => ((m[r.Interest] = (m[r.Interest] || 0) + 1), m), {}))}`);
  console.log(`stages ${JSON.stringify(real.reduce((m, r) => ((m[r["Service Stage"]] = (m[r["Service Stage"]] || 0) + 1), m), {}))}`);
  console.log(`qualified=${c((r) => r.Qualified)} active=${c((r) => r["Moved to Active"])} proforma=${c((r) => r["Proforma Raised"])} paid=${c((r) => r.Paid)} invoiced=${real.reduce((s, r) => s + r["Invoiced Amount"], 0)} paidAmt=${real.reduce((s, r) => s + r["Paid Amount"], 0)}`);
  const byMonth = real.reduce((m, r) => ((m[r["Lead Date"].slice(0, 7)] = (m[r["Lead Date"].slice(0, 7)] || 0) + 1), m), {});
  console.log(`by month ${JSON.stringify(byMonth)}`);
  console.log(`Wrote ${OUTPUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
