require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");

const app = initializeApp({
  credential: cert(require("./service_account_key.json")),
});
const db = getFirestore(app);

const SHEET_ID = "1SW4s1ly2KoWJLQEujaCS66U_Vdh_uXiwpfJlPji3nF0";

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "./service_account_key.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function main() {
  const snap = await db.collection("vaultServices").get();
  const rows = [["Username", "Phone Number", "Service Name", "Matched Note"]];

  snap.forEach((doc) => {
    const data = doc.data();
    const notes = data.notes;

    if (Array.isArray(notes) && notes.length > 0) {
      notes.forEach((note) => {
        const content = note.noteContent || "";
        if (content.toLowerCase().includes("ticket")) {
          rows.push([
            data.userName || "",
            data.phoneNumber || "",
            data.serviceName || "",
            content,
          ]);
        }
      });
    }
  });

  console.log(`Found ${rows.length - 1} matching notes. Writing to sheet...`);

  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  console.log("Done. Sheet updated.");
}

main().catch((err) => console.error("Error:", err));
