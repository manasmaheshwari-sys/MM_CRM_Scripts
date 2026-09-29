/**
 * run_daily_report.js
 *
 * Orchestrator — runs every export script, rebuilds and recalculates the
 * Queue_Flow_Data_Analysis.xlsx workbook, then mirrors it into the Google
 * Sheet, in the right order. This is the ONE script to run daily to refresh
 * everything — local workbook AND the shared Google Sheet.
 *
 * All the individual steps are READ-ONLY against Firestore (see each
 * script's own header comment). This orchestrator only runs local
 * node/python processes, writes to local files, and overwrites the target
 * Google Sheet's content (see sync_workbook_to_google_sheet.js) — no
 * Firestore writes.
 *
 * Usage (from this directory):
 *   node run_daily_report.js
 *
 * To automate: Windows Task Scheduler -> Create Task -> Trigger: Daily at
 * whatever time -> Action: Start a program ->
 *   Program: node
 *   Arguments: run_daily_report.js
 *   Start in: C:\Users\manas\Downloads\MM_CRM_Scripts
 */

const { execFileSync } = require("child_process");
const path = require("path");

const DIR = __dirname;
// Point this at your actual Python (the one where `pip install pandas openpyxl` succeeded).
const PYTHON = process.env.PYTHON_BIN || "python";
// The workbook-building script — update this path if you move it into this folder.
const BUILD_WORKBOOK_PY =
  process.env.BUILD_WORKBOOK_PY ||
  path.join(DIR, "build_workbook.py");
const RECALC_EXCEL_PY =
  process.env.RECALC_EXCEL_PY ||
  path.join(DIR, "recalc_excel.py");

function step(label, cmd, args) {
  console.log(`\n=== ${label} ===`);
  const start = Date.now();
  execFileSync(cmd, args, { cwd: DIR, stdio: "inherit" });
  console.log(`--- done in ${((Date.now() - start) / 1000).toFixed(1)}s ---`);
}

// The Excel-COM recalc step only works on Windows with a licensed local Excel
// install (win32com automates the real Excel.Application). It's SKIPPED
// automatically in CI (GitHub Actions sets CI=true) or on any non-Windows
// runner, and can be forced off locally too via SKIP_EXCEL_RECALC=true.
// This is safe to skip because it isn't actually load-bearing for the Google
// Sheet output: sync_workbook_to_google_sheet.js uploads the raw .xlsx via
// the Drive API, which converts it into native Sheets formulas that Google
// Sheets recalculates itself on import — verified 29 Sep 2026 by syncing an
// un-recalculated workbook directly and confirming the Snapshot tab's
// formulas (SUMPRODUCT/COUNTIF chains, the "Check: OK" sanity rows, etc.)
// all computed correctly with no #VALUE!/blank cells. The recalc step only
// matters for someone opening Queue_Flow_Data_Analysis.xlsx directly in
// Excel and wanting pre-computed values baked in rather than live formulas.
const SKIP_RECALC = process.env.CI === "true" || process.env.SKIP_EXCEL_RECALC === "true" || process.platform !== "win32";

function main() {
  console.log(`Daily report refresh started: ${new Date().toString()}`);

  // Self-healing: whichever `python` this machine/session resolves to, make
  // sure it actually has the packages build_workbook.py/recalc_excel.py need.
  // This is idempotent — if they're already installed, pip just confirms
  // that in ~1s and does nothing. pywin32 is Windows-only (Excel COM), so
  // it's only requested when the recalc step will actually run.
  const pipPackages = ["pandas", "openpyxl"];
  if (!SKIP_RECALC) pipPackages.push("pywin32");
  step("0/10 Ensure Python dependencies are installed", PYTHON, ["-m", "pip", "install", "--quiet", ...pipPackages]);

  step("1/10 Pull raw case data (vaultServices, serviceFlow=queue)", "node", ["export_serviceFlow_raw_data.js"]);
  step("2/10 Pull POC leaderboard, since launch", "node", ["export_poc_leaderboard.js"]);
  step("3/10 Pull POC leaderboard, today only", "node", ["export_poc_leaderboard_today.js"]);
  step("4/10 Pull Queue Waiting Cases snapshot", "node", ["export_queue_waiting.js"]);
  step("5/10 Scan for orphaned cases (isWaiting stuck false)", "node", ["export_orphaned_cases.js"]);
  step("6/10 Rebuild the Excel workbook", PYTHON, [BUILD_WORKBOOK_PY]);
  if (SKIP_RECALC) {
    console.log("\n=== 7/10 Recalculate formulas (Excel COM) — SKIPPED (not on Windows / CI) ===");
  } else {
    step("7/10 Recalculate formulas (Excel COM)", PYTHON, [RECALC_EXCEL_PY]);
  }
  step("8/10 Mirror workbook into Google Sheet", "node", ["sync_workbook_to_google_sheet.js"]);
  step("9/10 Compute daily dashboard pivots (single 'Overview' tab)", "node", ["compute_dashboard_pivots.js"]);
  step("10/10 Recreate filtered view tabs (Missing Documents, Paused cases, RNR)", "node", ["update_filtered_tab_queries.js"]);

  console.log("\nAll done. Queue_Flow_Data_Analysis.xlsx, the Google Sheet, the 'Overview' tab, and the 3 filtered-view tabs are all up to date.");
}

main();
