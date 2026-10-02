/**
 * should_run_refresh.js
 *
 * READ-ONLY gate for the GitHub Actions workflow. GitHub's cron drops or delays
 * most scheduled ticks, so the workflow ticks every ~15 min and this decides
 * whether a refresh is actually due: true only if the most recent target slot
 * (11:00, 13:00, 15:00, 17:00, 18:00, 19:00 IST) has started, is no more than
 * MAX_LATE_MIN old, and the dashboard hasn't been refreshed since that slot.
 * "Refreshed" is read from the Overview!A1 stamp, so a refresh by ANY runner
 * (this workflow, the Windows task, a manual run) counts and nothing runs twice.
 *
 * Writes `run=true|false` to $GITHUB_OUTPUT (or just prints it locally).
 * Fails open: if the stamp can't be read/parsed, it says run=true.
 */
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SPREADSHEET_ID = "1KPInrAhZVJiqyfNPXxXemIlB1qjsLUrxh2rMjRgFu1g";
const SLOT_HOURS_IST = [11, 13, 15, 17, 18, 19];
const MAX_LATE_MIN = 90;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function decide(msg, run) {
  console.log(`${run ? "RUN" : "SKIP"}: ${msg}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  process.exit(0);
}

// Parses "Last updated at: 3 Oct 2026, 3:51 am IST" into epoch ms.
function parseStamp(text) {
  const m = /Last updated at:\s*(\d{1,2})\s+(\w{3})\w*\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(text || "");
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[6].toLowerCase() === "pm") hour += 12;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  return Date.UTC(Number(m[3]), month, Number(m[1]), hour, Number(m[5])) - IST_OFFSET_MS;
}

(async () => {
  // GATE_NOW_ISO is only for testing the decision branches (e.g. 2026-10-03T11:20:00+05:30).
  const nowMs = process.env.GATE_NOW_ISO ? new Date(process.env.GATE_NOW_ISO).getTime() : Date.now();
  const ist = new Date(nowMs + IST_OFFSET_MS); // read with getUTC* = IST wall clock
  const dayStartIstUtcMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS;

  const started = SLOT_HOURS_IST.filter((h) => dayStartIstUtcMs + h * 3600 * 1000 <= nowMs);
  if (started.length === 0) return decide("no slot has started yet today (first is 11:00 IST)", false);
  const slotMs = dayStartIstUtcMs + started[started.length - 1] * 3600 * 1000;
  const lateMin = Math.round((nowMs - slotMs) / 60000);
  if (lateMin > MAX_LATE_MIN) return decide(`latest slot ${started[started.length - 1]}:00 IST is ${lateMin} min old (> ${MAX_LATE_MIN}) — too stale to run for it`, false);

  let stampMs = null;
  try {
    const keyFile = path.join(__dirname, "service_account_key.json");
    const auth = new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Overview!A1" });
    stampMs = parseStamp(res.data.values && res.data.values[0] && res.data.values[0][0]);
  } catch (e) {
    return decide(`could not read the dashboard stamp (${e.message}) — running to be safe`, true);
  }
  if (stampMs === null) return decide("could not parse the dashboard's Last-updated stamp — running to be safe", true);

  if (stampMs >= slotMs) return decide(`dashboard already refreshed at/after the ${started[started.length - 1]}:00 IST slot`, false);
  return decide(`slot ${started[started.length - 1]}:00 IST started ${lateMin} min ago and the dashboard hasn't been refreshed since`, true);
})();
