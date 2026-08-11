// export_acn_services.js
// Fetches vaultServices where serviceSource in ["Partners","partners"], serviceSubsource=ACN
// (serviceSource casing is inconsistent in the data, so both variants are queried)
// Enriches each service with:
//   - agent info from vaultAcnAgents (via acnAgentId as doc id)
//   - proforma info from vaultProforma (matched via proformaServices[].serviceId)
// Writes to the "Manas Data" tab of the Google Sheet with Service Id, Customer, Agent, Proforma, and Service status/date fields.

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");

// ---- CONFIG ----
const SERVICE_ACCOUNT_PATH = "../service_account_key.json";
const SHEET_ID = "1c8JyxzCiIWM1ANkSDJyOl-wkJJ89QSS6Yc1d4fMdQlk";
const SHEET_TAB_NAME = "Manas Data";
const SERVICE_SOURCE_VALUES = ["Partners", "partners"];

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
db.settings({ preferRest: true });

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

function toDate(unix) {
  if (!unix) return "";
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

async function fetchAllServices() {
  const results = [];
  let lastDoc = null;
  const pageSize = 500;

  while (true) {
    let query = db
      .collection("vaultServices")
      .where("serviceSource", "in", SERVICE_SOURCE_VALUES)
      .where("serviceSubsource", "==", "ACN")
      .orderBy("__name__")
      .limit(pageSize);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) {
      results.push({ id: doc.id, ...doc.data() });
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < pageSize) break;
  }

  return results;
}

async function fetchAgentMap(agentIds) {
  const uniqueIds = [...new Set(agentIds.filter(Boolean))];
  const agentMap = {};

  const chunkSize = 300;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const refs = chunk.map((id) => db.collection("vaultAcnAgents").doc(id));
    const docs = await db.getAll(...refs);
    docs.forEach((docSnap) => {
      if (docSnap.exists) {
        agentMap[docSnap.id] = docSnap.data();
      }
    });
  }

  return agentMap;
}

async function fetchProformaMap(serviceIds) {
  const wanted = new Set(serviceIds.filter(Boolean));
  const proformaMap = {};

  const snapshot = await db.collection("vaultProforma").get();
  snapshot.docs.forEach((doc) => {
    const data = doc.data();
    (data.proformaServices || []).forEach((svc) => {
      if (svc.serviceId && wanted.has(svc.serviceId)) {
        proformaMap[svc.serviceId] = data;
      }
    });
  });

  return proformaMap;
}

async function main() {
  console.log("Fetching vaultServices (serviceSource in Partners/partners, serviceSubsource=ACN)...");
  const services = await fetchAllServices();
  console.log(`Found ${services.length} matching services.`);

  const agentIds = services.map((s) => s.acnAgentId);
  console.log("Fetching mapped agents from vaultAcnAgents...");
  const agentMap = await fetchAgentMap(agentIds);
  console.log(`Resolved ${Object.keys(agentMap).length} unique agents.`);

  console.log("Fetching vaultProforma and matching by serviceId...");
  const proformaMap = await fetchProformaMap(services.map((s) => s.id));
  console.log(`Resolved ${Object.keys(proformaMap).length} matched proformas.`);

  const rows = [
    [
      "Service Id",
      "Service Name",
      "Customer Name",
      "Customer Number",
      "Agent Name",
      "Agent Number",
      "Proforma Id",
      "PI Status",
      "PI Created Date",
      "PI Total Amount",
      "PI Total Amount Received",
      "Service Amount",
      "Service Amount Received",
      "Service Bucket",
      "Service Status",
      "Service Stage",
      "Service Substage",
      "Service Creation Date",
      "Service Closed Date",
    ],
  ];

  for (const service of services) {
    const serviceId = service.id;
    const serviceName = service.serviceName || "";
    const customerName = service.userName || "";
    const customerNumber = service.phoneNumber || "";
    const agent = agentMap[service.acnAgentId] || {};
    const agentName = agent.agentName || "";
    const agentNumber = agent.phoneNumber || "";

    const proforma = proformaMap[serviceId] || null;
    const proformaId = proforma ? proforma.piid || "" : "";
    const piStatus = proforma ? proforma.proformaStatus || "" : "";
    const piCreatedDate = proforma ? toDate(proforma.added) : "";
    const piTotalAmount = proforma ? proforma.totalAmount : "";
    const piTotalAmountReceived = proforma ? proforma.totalPaid : "";

    const serviceAmount = service.serviceAmount;
    const serviceAmountReceived = service.amountPaid;
    const serviceBucket = service.bucket;
    const serviceStatus = service.serviceStatus;
    const serviceStage = service.serviceStage;
    const serviceSubstage = service.subStage;
    const serviceCreationDate = toDate(service.added);
    const closedTransition = (service.bucketTransitions || []).find((t) => t.bucket === "closed");
    const serviceClosedDate = closedTransition ? toDate(closedTransition.enteredAt) : "";

    rows.push([
      serviceId,
      serviceName,
      customerName,
      customerNumber,
      agentName,
      agentNumber,
      proformaId,
      piStatus,
      piCreatedDate,
      piTotalAmount,
      piTotalAmountReceived,
      serviceAmount,
      serviceAmountReceived,
      serviceBucket,
      serviceStatus,
      serviceStage,
      serviceSubstage,
      serviceCreationDate,
      serviceClosedDate,
    ]);
  }

  console.log(`Writing ${rows.length} rows to "${SHEET_TAB_NAME}" tab...`);
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_NAME}!A:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  console.log(`Done. Wrote ${services.length} rows to the "${SHEET_TAB_NAME}" tab.`);
}

main().catch((err) => {
  console.error("Error running export:", err);
  process.exit(1);
});
