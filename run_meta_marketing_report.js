/**
 * run_meta_marketing_report.js
 *
 * Daily refresh of the Meta marketing report:
 *   1. export_meta_marketing_data.js     -> Meta_Leads_Data.json   (Firestore, read-only)
 *   2. build_meta_marketing_report.py    -> Meta_Marketing_Report.xlsx
 *   3. sync_workbook_to_google_sheet.js  -> mirrors the xlsx into the Google Sheet
 *      (via a staging sheet + sheets.copyTo; see that script for why)
 *
 * The Google Sheet is a read-only mirror: every run overwrites all tabs, so the
 * View/Date selector on the Report tab resets to Weekly / today each day.
 *
 * Both sheets are owned by manasmaheshwari@vaultproptech.com and shared with the
 * service account as Editor. The staging sheet must have no other collaborators.
 *
 * Usage:
 *   node run_meta_marketing_report.js
 *   node run_meta_marketing_report.js <targetSheetId> <stagingSheetId>
 *   node run_meta_marketing_report.js --no-sync      (build the xlsx only)
 */

const { execFileSync } = require("child_process");
const path = require("path");

const DIR = __dirname;
const PYTHON = process.env.PYTHON_BIN || "python";
const NO_SYNC = process.argv.includes("--no-sync");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// "Meta Marketing Report" and its private staging copy
const DEFAULT_TARGET_SHEET_ID = "1-_eCL2av078lPGsdnAM3fn7hk2wYIWjUNjJm4tWr-HQ";
const DEFAULT_STAGING_SHEET_ID = "1E2t0og_nZjCTpTD7DBShSE57s2HWTbH7Pd5b06Xw4OQ";
const TARGET = args[0] || process.env.META_REPORT_SHEET_ID || DEFAULT_TARGET_SHEET_ID;
const STAGING = args[1] || process.env.META_REPORT_STAGING_SHEET_ID || DEFAULT_STAGING_SHEET_ID;
const XLSX = path.join(DIR, "Meta_Marketing_Report.xlsx");

function step(label, cmd, cmdArgs) {
  console.log(`\n=== ${label} ===`);
  execFileSync(cmd, cmdArgs, { cwd: DIR, stdio: "inherit" });
}

step("1/3 Export Meta leads from Firestore", "node", ["export_meta_marketing_data.js"]);
step("2/3 Build Meta_Marketing_Report.xlsx", PYTHON, ["build_meta_marketing_report.py"]);

if (NO_SYNC) {
  console.log("\n=== 3/3 Google Sheet sync — skipped (--no-sync) ===");
} else if (!TARGET || !STAGING) {
  console.error("\nMissing META_REPORT_SHEET_ID / META_REPORT_STAGING_SHEET_ID — cannot sync.");
  process.exit(1);
} else {
  step("3/3 Mirror workbook into Google Sheet", "node", ["sync_workbook_to_google_sheet.js", XLSX, TARGET, STAGING]);
}
