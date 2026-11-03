// poc_filing_report.js  (READ-ONLY)
// POC-wise Khata Filing / EC / BESCOM counts for a day (default: today IST). Usage: node poc_filing_report.js [YYYY-MM-DD]
// Walks vaultUsers.activity ("service stage" + "sub-stage" entries) per serviceId, rebuilds (stage, sub) in time order,
// and counts a service once per category per POC, credited to the activity entry's `user` (who made the move).
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

initializeApp({ credential: cert(require(path.join(__dirname, "service_account_key.json"))) });
const db = getFirestore();

const from = process.argv[2], to = process.argv[3];
const day = from + "_to_" + to;
const START = new Date(from + "T00:00:00+05:30").getTime() / 1000;
const END = new Date(to + "T00:00:00+05:30").getTime() / 1000 + 86400;
const dkey = (t) => new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const sec = (t) => (Number(t) > 1e12 ? Number(t) / 1000 : Number(t));
const lc = (s) => String(s || "").trim().toLowerCase();

const KHATA = new Set(["e-khata", "khata transfer", "new khata"]);
const BESCOM = new Set(["bescom", "bescom name change"]);
const DOC_FIL = new Set(["doc", "filing"]);

function classify(name, b, a) {
  // b / a = {stage, sub} before / after, all lowercased
  const out = [];
  if (b.stage === a.stage && b.sub === a.sub) return out;
  if (KHATA.has(name)) {
    const fromOk = DOC_FIL.has(b.stage) || (b.stage === "applied" && b.sub === "correction required");
    const toOk = a.stage === "applied" && ["awaiting", "approved", "correction applied"].includes(a.sub);
    if (fromOk && toOk) out.push("Khata Filing");
  }
  if (DOC_FIL.has(b.stage) && a.stage === "filing" && a.sub === "ec applied") out.push("EC");
  else if (name === "encumbrance certificate" && DOC_FIL.has(b.stage) && a.stage === "applied" && a.sub === "awaiting") out.push("EC");
  if (BESCOM.has(name) && (DOC_FIL.has(b.stage) || b.stage === "ground") && a.stage === "applied" && b.stage !== "applied") out.push("BESCOM");
  return out;
}

async function main() {
  console.log("Day (IST):", day);
  const svc = new Map(); // serviceId -> { name, poc }
  await new Promise((res, rej) =>
    db.collection("vaultServices").select("serviceId", "serviceName", "servicePOC").stream()
      .on("data", (d) => { const x = d.data(); if (x.serviceId) svc.set(x.serviceId, { name: lc(x.serviceName), poc: x.servicePOC }); })
      .on("end", res).on("error", rej));
  console.log("services loaded:", svc.size);

  const seen = new Set(); const counts = {}; const rows = []; let docs = 0;
  await new Promise((res, rej) =>
    db.collection("vaultUsers").select("activity").stream().on("data", (doc) => {
      docs++;
      const act = doc.data().activity; if (!act) return;
      const arr = (Array.isArray(act) ? act : Object.values(act)).filter((e) => e && (e.target === "service stage" || e.target === "sub-stage"));
      if (!arr.some((e) => sec(e.time) >= START && sec(e.time) < END)) return;
      const bySvc = {};
      for (const e of arr) (bySvc[e.serviceId || "?"] ||= []).push(e);
      for (const sid in bySvc) {
        const info = svc.get(sid); if (!info) continue;
        const byTime = new Map();
        for (const e of bySvc[sid]) { const t = sec(e.time); if (!byTime.has(t)) byTime.set(t, []); byTime.get(t).push(e); }
        let cur = { stage: null, sub: null };
        for (const t of [...byTime.keys()].sort((x, y) => x - y)) {
          const before = { ...cur };
          for (const e of byTime.get(t)) { if (e.target === "service stage") cur.stage = lc(e.to); else cur.sub = lc(e.to); }
          if (t < START || t >= END || !before.stage) continue;
          for (const cat of classify(info.name, before, cur)) {
            const actor = byTime.get(t)[0].user || "unknown";
            const dk = dkey(t); const k = `${cat}|${sid}|${actor}|${dk}`; if (seen.has(k)) continue; seen.add(k);
            (counts[actor] ||= {})[cat] = (counts[actor][cat] || 0) + 1;
            rows.push({ date: dk, actor, cat, serviceId: sid, userId: doc.id, serviceName: info.name, servicePOC: info.poc, from: `${before.stage}/${before.sub}`, to: `${cur.stage}/${cur.sub}`, time: new Date(t * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) });
          }
        }
      }
    }).on("end", res).on("error", rej));
  console.log("users scanned:", docs, "\n");

  const lines = ["POC NAME,Khata Filing,EC,BESCOM,Total"];
  for (const [a, c] of Object.entries(counts).sort((x, y) => Object.values(y[1]).reduce((s, n) => s + n, 0) - Object.values(x[1]).reduce((s, n) => s + n, 0))) {
    const k = c["Khata Filing"] || 0, e = c["EC"] || 0, b = c["BESCOM"] || 0;
    lines.push(`"${a}",${k},${e},${b},${k + e + b}`);
  }
  console.log(lines.join("\n"));
  fs.writeFileSync(path.join(__dirname, `POC_Filing_Range_${day}.csv`), lines.join("\n"));
  const h = Object.keys(rows[0] || { actor: 1 });
  fs.writeFileSync(path.join(__dirname, `POC_Filing_Range_${day}_detail.csv`), [h.join(","), ...rows.map((r) => h.map((k) => `"${r[k]}"`).join(","))].join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
