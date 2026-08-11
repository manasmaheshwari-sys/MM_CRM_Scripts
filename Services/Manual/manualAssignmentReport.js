/**
 * servicePOCHumanExport.js — read-only.
 * Scans every vaultUsers doc's activity[] and writes one CSV row per entry where:
 *   - target matches one of --targets (default "service POC"), case-insensitive, AND
 *   - user !== "System"
 * Joins serviceId → serviceName from vaultServices.
 * Time is DD/MM/YYYY HH:MM:SS (IST).
 *
 * Usage:
 *   node functions/scripts/servicePOCHumanExport.js \
 *     [--targets="service POC"] [--out=service_poc_human_assignments.csv]
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

initializeApp({
  credential: cert(
    JSON.parse(fs.readFileSync("functions/serviceAccount.json", "utf8")),
  ),
});
const db = getFirestore();

const args = process.argv.slice(2);
const getArg = (n, d = "") => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const targetSet = new Set(
  getArg("targets", "service POC")
    .split("|")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean),
);
const OUT = getArg("out", "service_poc_human_assignments.csv");

const norm = (v) => (v || "").trim().toLowerCase();
const isSystem = (v) => norm(v) === "system";
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function fmtDate(sec) {
  if (!sec) return "";
  // DD/MM/YYYY HH:MM:SS in IST
  return new Date(sec * 1000)
    .toLocaleString("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(",", "");
}

async function main() {
  console.log(
    `Streaming vaultUsers... matching target(s): ${[...targetSet].join(" | ")}`,
  );
  const hits = [];
  const serviceIds = new Set();
  let scanned = 0;

  await new Promise((resolve, reject) => {
    const stream = db.collection("vaultUsers").stream();
    stream.on("data", (doc) => {
      scanned++;
      if (scanned % 5000 === 0) console.log(`  ${scanned} users...`);
      const acts = doc.data()?.activity;
      if (!Array.isArray(acts)) return;
      for (const e of acts) {
        if (!targetSet.has(norm(e.target))) continue;
        if (isSystem(e.user) || !(e.user || "").trim()) continue;
        const serviceId = e.serviceId || "";
        if (serviceId) serviceIds.add(serviceId);
        hits.push({
          userId: doc.id,
          serviceId,
          from: e.from ?? "",
          to: e.to ?? "",
          by: (e.user || "").trim(),
          time: e.time || 0,
          target: e.target || "",
          via: e.documentUpdatedInDb || "",
          piid: e.piid || "",
        });
      }
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  console.log(
    `\nScanned ${scanned} users | matching non-System entries: ${hits.length}`,
  );
  console.log(
    `Fetching ${serviceIds.size} service names from vaultServices...`,
  );
  const nameOf = new Map();
  const ids = [...serviceIds];
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids
      .slice(i, i + 300)
      .map((id) => db.collection("vaultServices").doc(id));
    const docs = await db.getAll(...refs);
    docs.forEach((d) => nameOf.set(d.id, d.data()?.serviceName || ""));
  }

  const header = [
    "Time (DD/MM/YYYY HH:MM:SS IST)",
    "Service Name",
    "Service Id",
    "User ID",
    "Assigned By (user)",
    "From (previous POC)",
    "To (new POC)",
    "Target",
    "Logged Via",
    "PIID",
    "Epoch",
  ];
  const body = hits
    .sort((a, b) => a.time - b.time)
    .map((h) => [
      fmtDate(h.time),
      nameOf.get(h.serviceId) || "",
      h.serviceId,
      h.userId,
      h.by,
      h.from,
      h.to,
      h.target,
      h.via,
      h.piid,
      h.time,
    ]);
  fs.writeFileSync(
    OUT,
    [header, ...body].map((r) => r.map(csvCell).join(",")).join("\n") + "\n",
    "utf8",
  );

  console.log(`💾 ${OUT}  (${body.length} rows)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("🔴 Fatal:", e);
  process.exit(1);
});
