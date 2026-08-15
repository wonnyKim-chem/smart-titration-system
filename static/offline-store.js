const DATABASE_NAME = "titration-offline-v1";
const STORE_NAME = "measurements";
const DATABASE_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("channelSynced", ["channel", "synced"]);
      store.createIndex("timestamp", "timestamp");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function saveMeasurement(channel, measurement) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put({
    ...measurement,
    channel,
    synced: 0,
    createdAt: Date.now(),
  });
  await transactionDone(transaction);
  database.close();
  return measurement;
}

export async function getPendingMeasurements(channel, limit = 200) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("channelSynced");
  const request = index.openCursor(IDBKeyRange.only([channel, 0]));
  const records = [];

  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || records.length >= limit) {
        resolve();
        return;
      }
      records.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });

  await transactionDone(transaction);
  database.close();
  return records;
}

export async function markMeasurementsSynced(ids) {
  if (!ids.length) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);

  for (const id of ids) {
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) return;
      store.put({ ...request.result, synced: 1, syncedAt: Date.now() });
    };
  }

  await transactionDone(transaction);
  database.close();
}

export function getClientId(channel) {
  const clientKey = `titration-client-${channel}`;
  let clientId = localStorage.getItem(clientKey);
  if (!clientId) {
    clientId = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
    localStorage.setItem(clientKey, clientId);
  }
  return clientId;
}

export function createMeasurementId(channel) {
  const clientId = getClientId(channel);
  const nonce = Math.random().toString(36).slice(2, 9);
  return `${channel}-${clientId}-${Date.now()}-${nonce}`;
}