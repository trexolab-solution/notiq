import { openDB, type IDBPDatabase } from "idb";
import type { SessionData } from "../types";

const DB_NAME = "smart-note";
const DB_VERSION = 1;
const STORE = "session";

let db: IDBPDatabase | null = null;

async function getDB(): Promise<IDBPDatabase> {
  if (db) {
    // Verify connection is still usable; reset if stale
    try {
      // A quick read to validate the connection
      const tx = db.transaction(STORE, "readonly");
      tx.abort();
    } catch {
      db = null;
    }
  }
  if (db) return db;
  try {
    db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE);
        }
      },
    });
    return db;
  } catch (e) {
    db = null;
    throw e;
  }
}

export async function saveSession(data: SessionData): Promise<void> {
  const database = await getDB();
  await database.put(STORE, data, "current");
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const database = await getDB();
    return (await database.get(STORE, "current")) ?? null;
  } catch {
    return null;
  }
}

