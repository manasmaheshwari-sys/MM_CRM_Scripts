const { initializeApp, cert } = require("firebase-admin/app");
const {
  getFirestore,
  Timestamp,
  GeoPoint,
  DocumentReference,
} = require("firebase-admin/firestore");
const fs = require("fs");

const serviceAccount = require("./service_account_key.json");

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

const rows = [];
const visited = new Set();

function getType(value) {
  if (value === null) return "null";
  if (value instanceof Timestamp) return "timestamp";
  if (value instanceof GeoPoint) return "geopoint";
  if (value instanceof DocumentReference) return "reference";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function flatten(obj, prefix = "") {
  const result = {};

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Timestamp) &&
      !(value instanceof GeoPoint) &&
      !(value instanceof DocumentReference)
    ) {
      Object.assign(result, flatten(value, path));
    } else {
      result[path] = value;
    }
  }

  return result;
}

async function scanCollection(collectionRef, fullPath) {
  if (visited.has(fullPath)) return;
  visited.add(fullPath);

  console.log("Scanning:", fullPath);

  const snapshot = await collectionRef.get();

  for (const doc of snapshot.docs) {
    const flat = flatten(doc.data());

    for (const [field, value] of Object.entries(flat)) {
      rows.push({
        Collection: fullPath,
        DocumentID: doc.id,
        Field: field,
        Type: getType(value),
      });
    }

    const subs = await doc.ref.listCollections();

    for (const sub of subs) {
      await scanCollection(sub, `${fullPath}/${sub.id}`);
    }
  }
}

async function main() {
  const rootCollections = await db.listCollections();

  for (const col of rootCollections) {
    await scanCollection(col, col.id);
  }

  const header = "Collection,DocumentID,Field,Type\n";

  const csv =
    header +
    rows
      .map(
        (r) => `"${r.Collection}","${r.DocumentID}","${r.Field}","${r.Type}"`,
      )
      .join("\n");

  fs.writeFileSync("firestore_schema.csv", csv);

  console.log("\nDone.");
  console.log(`Rows written: ${rows.length}`);
  console.log("Saved as firestore_schema.csv");
}

main().catch(console.error);
