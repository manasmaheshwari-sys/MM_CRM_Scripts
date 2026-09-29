/**
 * sync_workbook_to_google_sheet.js
 *
 * Mirrors the local Queue_Flow_Data_Analysis.xlsx into an existing Google
 * Sheet, EXACTLY as it looks locally — same tabs, formatting, tables,
 * charts, formulas.
 *
 * HOW IT WORKS (and why — two dead ends got us here):
 *   1. The obvious approach — Drive's files.update with a media body,
 *      letting Drive's own Office importer overwrite the TARGET file's
 *      content in place — is blocked on some Sheets by a Workspace-level
 *      security policy: confirmed 403 "insufficientFilePermissions" even
 *      with Editor role, specifically on a file with several internal
 *      collaborators. (It DOES work on a file with only the owner + this
 *      service account on it — see STAGING_SHEET_ID below.)
 *   2. Uploading the .xlsx as a brand-new file (to then copy sheets out of)
 *      fails too: service accounts get 0 bytes of personal Drive storage
 *      by default, and creating a new file with binary content needs quota
 *      billed to the uploader.
 *
 * The combination that actually works: refresh a persistent STAGING sheet
 * (owned by the real user, shared only with this service account, content-
 * replace already proven to work on it — approach #1 succeeds here because
 * it has no other collaborators) via the normal Drive overwrite, then use
 * the Sheets API's sheets.copyTo to copy each tab from staging into the
 * real target spreadsheet. copyTo is a structured Sheets-API operation
 * (not a raw Drive content-replace), and IS allowed on the target even
 * though #1 wasn't — confirmed by testing.
 *
 * IMPORTANT: this OVERWRITES the entire target Google Sheet (all tabs) with
 * the local workbook's content every time it runs. Anything typed directly
 * into that Google Sheet between runs will be lost on the next sync — this
 * is meant to be a read-only mirror of the local .xlsx, not a two-way sync.
 *
 * Auth: uses the SAME service_account_key.json as the rest of these scripts.
 * The TARGET Google Sheet must be shared with that service account's email
 * as Editor: vault-proptech-crm-mailer@vault-proptech.iam.gserviceaccount.com
 * The STAGING sheet must also be shared with it as Editor (one-time setup;
 * it's a throwaway working file, not meant for anyone to look at directly).
 *
 * Usage:
 *   node sync_workbook_to_google_sheet.js
 *   node sync_workbook_to_google_sheet.js <path-to-xlsx> <targetSheetId> [stagingSheetId]
 */

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
const DEFAULT_XLSX_PATH = path.join(__dirname, "Queue_Flow_Data_Analysis.xlsx");
const DEFAULT_TARGET_SHEET_ID = "1KPInrAhZVJiqyfNPXxXemIlB1qjsLUrxh2rMjRgFu1g";
// A plain Google Sheet, owned by a real user, shared ONLY with the service
// account (no other collaborators) — that's what makes the direct Drive
// content-replace work on it. Used purely as scratch space for this sync.
const DEFAULT_STAGING_SHEET_ID = "1w7Sq2HZZ2xGUjywrNuUi3vQBqe3-7h77MOrToxjyDzE";

const XLSX_PATH = process.argv[2] || DEFAULT_XLSX_PATH;
const TARGET_SHEET_ID = process.argv[3] || DEFAULT_TARGET_SHEET_ID;
const STAGING_SHEET_ID = process.argv[4] || DEFAULT_STAGING_SHEET_ID;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function replaceTabs(sheetsApi, targetId, newSheetIds) {
  const targetMeta = await sheetsApi.spreadsheets.get({ spreadsheetId: targetId, fields: "sheets.properties" });
  const targetSheetsBefore = targetMeta.data.sheets.map((s) => s.properties);
  const newIdSet = new Set(newSheetIds.map((s) => s.newSheetId));
  const oldSheets = targetSheetsBefore.filter((s) => !newIdSet.has(s.sheetId));

  const requests = [];
  // Delete the old tabs FIRST — they're renamed the same as what we're about
  // to rename the new copies to, so deleting after would collide on name.
  // Keep at least one sheet in the file at all times (Sheets requires >=1
  // visible sheet), so if somehow ALL sheets would be deleted, skip the last one.
  const deletable = oldSheets.length === targetSheetsBefore.length ? oldSheets.slice(1) : oldSheets;
  for (const s of deletable) {
    requests.push({ deleteSheet: { sheetId: s.sheetId } });
  }
  newSheetIds.forEach(({ title, newSheetId }, index) => {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: newSheetId, title, index },
        fields: "title,index",
      },
    });
  });

  if (requests.length > 0) {
    await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: targetId, requestBody: { requests } });
  }
}

async function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`File not found: ${XLSX_PATH}. Run build_workbook.py first.`);
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
  const drive = google.drive({ version: "v3", auth });
  const sheetsApi = google.sheets({ version: "v4", auth });

  console.log(`1) Refreshing staging sheet ${STAGING_SHEET_ID} from ${XLSX_PATH}...`);
  await drive.files.update({
    fileId: STAGING_SHEET_ID,
    media: { mimeType: XLSX_MIME, body: fs.createReadStream(XLSX_PATH) },
  });

  console.log(`2) Copying every tab from staging into target ${TARGET_SHEET_ID}...`);
  const stagingMeta = await sheetsApi.spreadsheets.get({ spreadsheetId: STAGING_SHEET_ID, fields: "sheets.properties" });
  const sourceSheetsInFileOrder = stagingMeta.data.sheets.map((s) => s.properties);
  // Copy order matters: every other tab has formulas referencing "Raw Data"
  // by name (e.g. ='Raw Data'!A2:A1036). If a tab referencing it is copied
  // into the target BEFORE "Raw Data" exists there, Google Sheets bakes in
  // an "Unresolved sheet name" #REF! error at copy-time that persists even
  // after "Raw Data" shows up later — it doesn't self-heal. So copy
  // "Raw Data" (no dependencies of its own) first, then everything else in
  // its normal order.
  const sourceSheets = [
    ...sourceSheetsInFileOrder.filter((s) => s.title === "Raw Data"),
    ...sourceSheetsInFileOrder.filter((s) => s.title !== "Raw Data"),
  ];

  const newSheetIds = [];
  for (const props of sourceSheets) {
    const copyResp = await sheetsApi.spreadsheets.sheets.copyTo({
      spreadsheetId: STAGING_SHEET_ID,
      sheetId: props.sheetId,
      requestBody: { destinationSpreadsheetId: TARGET_SHEET_ID },
    });
    newSheetIds.push({ title: props.title, newSheetId: copyResp.data.sheetId });
    console.log(`   copied "${props.title}"`);
  }

  // Copy order (dependency-safe) and final visible tab order (matching the
  // source file) are different things — re-sort back to file order now.
  const fileOrderTitles = sourceSheetsInFileOrder.map((s) => s.title);
  const newSheetIdsInFileOrder = [...newSheetIds].sort(
    (a, b) => fileOrderTitles.indexOf(a.title) - fileOrderTitles.indexOf(b.title)
  );

  console.log("3) Removing target's old tabs, renaming + reordering the new ones...");
  await replaceTabs(sheetsApi, TARGET_SHEET_ID, newSheetIdsInFileOrder);

  // 4) Repair pass. copyTo brings over values/formatting/charts fine, but a
  // formula referencing another tab BY NAME (e.g. ='Raw Data'!A2:A1036) gets
  // permanently marked "Unresolved sheet name" if that tab didn't already
  // exist in the destination at the exact moment of copy — and, critically,
  // that broken state does NOT self-heal once the tab shows up later; the
  // formula has to be re-entered. So for every tab except "Raw Data" (pure
  // values, nothing to repair, and huge — skip it for speed), re-pull its
  // formulas from staging (now guaranteed correct, since staging is a plain
  // single-file spreadsheet with no cross-file copy involved) and re-enter
  // them into the target. This only touches cell contents, not formatting/
  // charts, which are already correct from the copyTo step.
  console.log("4) Repairing cross-tab formula references (re-entering formulas)...");
  for (const props of sourceSheetsInFileOrder) {
    if (props.title === "Raw Data") continue;
    const formulaVals = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: STAGING_SHEET_ID,
      range: props.title,
      valueRenderOption: "FORMULA",
    });
    const values = formulaVals.data.values;
    if (!values || values.length === 0) continue;
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: TARGET_SHEET_ID,
      range: `'${props.title}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
    console.log(`   repaired "${props.title}" (${values.length} rows)`);
  }

  const meta = await drive.files.get({ fileId: TARGET_SHEET_ID, fields: "name,webViewLink,modifiedTime" });
  console.log(`\nDone. "${meta.data.name}" updated at ${meta.data.modifiedTime}`);
  console.log(`Link: ${meta.data.webViewLink}`);
}

main().catch((err) => {
  console.error("Error syncing to Google Sheet:", err.message);
  if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
