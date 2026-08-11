// exportInternalAgents.js
// Reads all documents from the "vaultInternalAgents" collection and exports
// name, phoneNumber, and email into an Excel file.
//
// Usage:
//   node exportInternalAgents.js
//
// Requirements:
//   npm install firebase-admin xlsx

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import xlsx from "xlsx";
import { readFileSync } from "fs";

// ---- CONFIG ----
// Path to your Firebase service account JSON key file
const SERVICE_ACCOUNT_PATH = "./service_account_key.json";
// Output Excel file name
const OUTPUT_FILE = "vaultInternalAgents_export.xlsx";
// Collection to read from
const COLLECTION_NAME = "vaultInternalAgents";

// ---- INIT FIREBASE ----
const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

async function main() {
  console.log(`Fetching documents from "${COLLECTION_NAME}"...`);

  const snapshot = await db.collection(COLLECTION_NAME).get();

  if (snapshot.empty) {
    console.log("No documents found in the collection.");
    return;
  }

  const rows = [];

  snapshot.forEach((doc) => {
    const data = doc.data();

    rows.push({
      docId: doc.id,
      name: data.name ?? "",
      phoneNumber: data.phoneNumber ?? "",
      email: data.email ?? "",
    });
  });

  console.log(`Fetched ${rows.length} documents. Writing Excel file...`);

  // Build worksheet with only the required columns (docId kept as reference,
  // remove the line below if you don't want it in the sheet)
  const worksheetData = rows.map((r) => ({
    docId: r.docId,
    name: r.name,
    phoneNumber: r.phoneNumber,
    email: r.email,
  }));

  const worksheet = xlsx.utils.json_to_sheet(worksheetData, {
    header: ["docId", "name", "phoneNumber", "email"],
  });

  // Auto-size columns roughly
  worksheet["!cols"] = [
    { wch: 12 }, // docId
    { wch: 25 }, // name
    { wch: 16 }, // phoneNumber
    { wch: 30 }, // email
  ];

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "InternalAgents");

  xlsx.writeFile(workbook, OUTPUT_FILE);

  console.log(`Done. File saved as: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
