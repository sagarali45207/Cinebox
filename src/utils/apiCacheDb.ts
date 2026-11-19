const API_CACHE_DB_NAME = 'cinebox_api_cache_v1';
const API_CACHE_DB_VERSION = 1;
const STORE_RESPONSES = 'responses';
const INDEX_STORED_AT = 'by_storedAt';
const MAX_PERSISTENT_ENTRIES = 300;

export interface PersistentCacheRecord<T = unknown> {
  key: string;
  data: T;
  expiresAt: number;
  storedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let writeCountSincePrune = 0;

function hasIndexedDb(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

function openApiCacheDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = window.indexedDB.open(API_CACHE_DB_NAME, API_CACHE_DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_RESPONSES)) {
          const store = db.createObjectStore(STORE_RESPONSES, { keyPath: 'key' });
          store.createIndex(INDEX_STORED_AT, 'storedAt', { unique: false });
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => {
          dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      req.onerror = () => {
        dbPromise = null;
        resolve(null);
      };

      req.onblocked = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });

  return dbPromise;
}

export async function getPersistentApiCache<T>(
  key: string,
): Promise<{ record: PersistentCacheRecord<T>; isExpired: boolean } | null> {
  const db = await openApiCacheDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_RESPONSES, 'readonly');
      const store = tx.objectStore(STORE_RESPONSES);
      const req = store.get(key);
      req.onsuccess = () => {
        const record = req.result as PersistentCacheRecord<T> | undefined;
        if (!record || record.data === undefined) {
          resolve(null);
          return;
        }
        resolve({
          record,
          isExpired: record.expiresAt <= Date.now(),
        });
      };
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function pruneOldestPersistentEntries(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_RESPONSES, 'readwrite');
      const store = tx.objectStore(STORE_RESPONSES);
      const countReq = store.count();

      countReq.onsuccess = () => {
        const total = countReq.result || 0;
        const excess = total - MAX_PERSISTENT_ENTRIES;
        if (excess <= 0) {
          resolve();
          return;
        }
        const index = store.index(INDEX_STORED_AT);
        let deleted = 0;
        const cursorReq = index.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || deleted >= excess) {
            resolve();
            return;
          }
          cursor.delete();
          deleted += 1;
          cursor.continue();
        };
        cursorReq.onerror = () => resolve();
      };
      countReq.onerror = () => resolve();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function putPersistentApiCache(
  key: string,
  data: unknown,
  expiresAt: number,
): Promise<void> {
  const db = await openApiCacheDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_RESPONSES, 'readwrite');
      const store = tx.objectStore(STORE_RESPONSES);
      const record: PersistentCacheRecord = {
        key,
        data,
        expiresAt,
        storedAt: Date.now(),
      };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });

  writeCountSincePrune += 1;
  if (writeCountSincePrune >= 12) {
    writeCountSincePrune = 0;
    void pruneOldestPersistentEntries(db);
  }
}

export async function clearPersistentApiCache(): Promise<void> {
  const db = await openApiCacheDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_RESPONSES, 'readwrite');
      const store = tx.objectStore(STORE_RESPONSES);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
