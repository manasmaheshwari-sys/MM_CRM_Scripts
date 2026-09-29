const { google } = require("googleapis");
const path = require("path");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service_account_key.json");
const SPREADSHEET_ID = "1KPInrAhZVJiqyfNPXxXemIlB1qjsLUrxh2rMjRgFu1g";

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  // Confirmed directly against Raw Data's actual header row: 43 original
  // columns (A..AQ), then customerName=AR, phoneNumber=AS, and (added for the
  // Paused cases tab specifically) 7 pause-detail columns AT..AZ appended after.
  const ALL_COLS = "A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z,AA,AB,AC,AD,AE,AF,AG,AH,AI,AJ,AK,AL,AM,AN,AO,AP,AQ".split(",");
  const REST = ALL_COLS.filter((c) => c !== "A").join(", ");

  const TABS = [
    {
      name: "Missing Documents",
      where: "G='pre active' and H='open' and I='qualified'",
      // BB = missingDocsMarkedBy (updateBy.missingDocuments), BC = serviceSalesPOC,
      // BD = missingDocList (the actual doc names, straight from the missingDocuments array field).
      select: `A, AR, AS, BA, BB, BC, BD, ${REST}`,
      labels: "label AR 'Customer Name', AS 'Phone Number', BA 'Email', BB 'Marked Missing Docs By', BC 'Sales POC', BD 'Missing Doc List'",
    },
    {
      name: "Paused cases",
      where: "G='active' and H='paused' and F='snoozed'",
      // Extra pause-detail columns, right after Phone Number: who paused it,
      // when, till when, and the real free-text reason (AV = pausedReasonDetail
      // is note CONTENT, not the vague dropdown reason — see export script
      // comment for why that distinction matters).
      select: `A, AR, AS, AY, AU, AZ, AV, ${REST}`,
      labels: "label AR 'Customer Name', AS 'Phone Number', AY 'Paused By', AU 'Paused On', AZ 'Paused Until', AV 'Pause Reason'",
    },
    {
      // Fixed 15 Sep 2026: this used to filter G='active' and F='snoozed' and
      // H!='paused' — that's an unrelated "active, snoozed-bucket, not-paused"
      // slice, not actual RNR cases. Column Y (isRnrCallStatus) is the real
      // live flag — "Yes" when the case's LAST logged call outcome was RNR —
      // but Y alone is stale/historical: callStatus is never cleared once a
      // case moves on, so cases already reassigned/reopened (queueBucket back
      // to normal/escalation) still read "rnr*" forever even though they're
      // no longer stuck. Adding F='snoozed' restricts this to cases that are
      // BOTH RNR-flagged AND still actually parked waiting on a callback —
      // found 15 Sep 2026 when Y='Yes' alone returned 100 cases but 65 of
      // them had already left the snoozed queue.
      name: "RNR",
      where: "Y='Yes' and F='snoozed'",
      select: `A, AR, AS, ${REST}`,
      labels: "label AR 'Customer Name', AS 'Phone Number'",
    },
    {
      name: "Correction Required",
      where: "G='active' and (H='open' or H='paused') and I='Applied' and J='Correction Required'",
      select: `A, AR, AS, ${REST}`,
      labels: "label AR 'Customer Name', AS 'Phone Number'",
    },
  ];

  // The QUERY output spans 44 columns (A, AQ, AR, then B..AP) — a freshly
  // created sheet defaults to 26 columns (A:Z), which is too narrow for that
  // range and causes the Sheets API to reject "A:AR"-style references
  // ("Unable to parse range") since column AR (44) doesn't exist on the grid
  // yet. Expand each tab's grid first.
  let meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: "sheets.properties" });
  let bySheetName = {};
  meta.data.sheets.forEach((s) => (bySheetName[s.properties.title] = s.properties));

  // Recreate any of the three tabs that don't exist (e.g. wiped by
  // sync_workbook_to_google_sheet.js, which deletes every tab not sourced
  // from the local workbook).
  const addRequests = TABS.filter((t) => !bySheetName[t.name]).map((t) => ({
    addSheet: { properties: { title: t.name, gridProperties: { columnCount: 60 } } },
  }));
  if (addRequests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: addRequests } });
    console.log(`Recreated ${addRequests.length} missing tab(s): ${addRequests.map((r) => r.addSheet.properties.title).join(", ")}`);
    meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: "sheets.properties" });
    bySheetName = {};
    meta.data.sheets.forEach((s) => (bySheetName[s.properties.title] = s.properties));
  }

  const resizeRequests = TABS.filter((t) => bySheetName[t.name] && bySheetName[t.name].gridProperties.columnCount < 60).map((t) => ({
    updateSheetProperties: {
      properties: { sheetId: bySheetName[t.name].sheetId, gridProperties: { columnCount: 60 } },
      fields: "gridProperties.columnCount",
    },
  }));
  if (resizeRequests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: resizeRequests } });
    console.log(`Expanded ${resizeRequests.length} tab(s) to 50 columns`);
  }

  for (const t of TABS) {
    const query = `select ${t.select} where ${t.where} ${t.labels}`;
    const formula = `=QUERY('Raw Data'!A1:BD, "${query}", 1)`;
    await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `'${t.name}'!A:BD` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${t.name}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[formula]] },
    });
    console.log(`Updated "${t.name}"`);
  }

  console.log("\nVerifying...");
  for (const t of TABS) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${t.name}'!A1:E3` });
    console.log(`--- ${t.name} ---`);
    (res.data.values || []).forEach((r) => console.log(r.join(" | ")));
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
