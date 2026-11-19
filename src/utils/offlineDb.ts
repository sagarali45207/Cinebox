import { deleteNativeMediaFile } from '../plugins/cineboxDownloader';
import type { DownloadQuality, OfflineDownloadEntry } from '../types/media';

const DB_NAME = 'cinebox_offline_v1';
const DB_VERSION = 2;
const ITEMS_STORE = 'items';
const CHUNKS_STORE = 'chunks';
const PENDING_TASKS_STORE = 'pending_tasks';
const CHUNKS_MEDIA_INDEX = 'by_media';

interface ChunkRecord {
  id: string;
  mediaKey: string;
  index: number;
  data: ArrayBuffer;
}

export interface PersistedDownloadTaskInput {
  kind: 'movie' | 'episode';
  id: string;
  seriesId?: string;
  seriesTitle?: string;
  seasonNum?: number;
  episodeNum?: number;
  title: string;
  subtitle?: string;
  categoryName: string;
  year: string | null;
  rating: number;
  duration?: string;
  plot?: string;
  poster: string;
  playUrl: string;
  extension?: string;
  quality?: DownloadQuality;
}

export interface PersistedDownloadTask {
  key: string;
  input: PersistedDownloadTaskInput;
  quality: DownloadQuality;
  status: 'queued' | 'downloading' | 'paused' | 'saving' | 'error';
  mode: 'native' | 'direct' | 'transcode';
  jobId?: string;
  nativeTaskId?: string;
  directUrl?: string;
  ext: string;
  mimeType: string;
  chunkCount: number;
  receivedBytes: number;
  totalBytes: number;
  isEstimatedTotal: boolean;
  nextOffset: number;
  waitingForNetwork?: boolean;
  error?: string;
  updatedAt: number;
}

export function isIndexedDbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

let cachedDbPromise: Promise<IDBDatabase> | null = null;

function openOfflineDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB is not supported in this browser'));
  }
  if (cachedDbPromise) {
    return cachedDbPromise;
  }

  cachedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        db.createObjectStore(ITEMS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunkStore = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
        chunkStore.createIndex(CHUNKS_MEDIA_INDEX, 'mediaKey', { unique: false });
      }
      if (!db.objectStoreNames.contains(PENDING_TASKS_STORE)) {
        db.createObjectStore(PENDING_TASKS_STORE, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        cachedDbPromise = null;
        try {
          db.close();
        } catch {
          // ignore
        }
      };
      db.onclose = () => {
        cachedDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      cachedDbPromise = null;
      reject(req.error || new Error('Unable to open offline storage'));
    };
  });

  return cachedDbPromise;
}

export async function listOfflineDownloads(): Promise<OfflineDownloadEntry[]> {
  if (!isIndexedDbAvailable()) return [];
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ITEMS_STORE, 'readonly');
    const store = tx.objectStore(ITEMS_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = Array.isArray(req.result) ? (req.result as OfflineDownloadEntry[]) : [];
      items.sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
      resolve(items);
    };
    req.onerror = () => reject(req.error || new Error('Failed to list offline downloads'));
  });
}

export async function getOfflineDownload(key: string): Promise<OfflineDownloadEntry | null> {
  if (!isIndexedDbAvailable()) return null;
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ITEMS_STORE, 'readonly');
    const req = tx.objectStore(ITEMS_STORE).get(key);
    req.onsuccess = () => resolve((req.result as OfflineDownloadEntry | undefined) || null);
    req.onerror = () => reject(req.error || new Error('Failed to read offline entry'));
  });
}

export async function putOfflineChunk(
  mediaKey: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, 'readwrite');
    const record: ChunkRecord = {
      id: `${mediaKey}:${index}`,
      mediaKey,
      index,
      data,
    };
    const req = tx.objectStore(CHUNKS_STORE).put(record);
    req.onerror = () => reject(req.error || new Error('Failed to write offline video chunk'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB write transaction failed'));
  });
}

export async function hasFirstOfflineChunk(mediaKey: string): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  const db = await openOfflineDb();
  return new Promise((resolve) => {
    const tx = db.transaction(CHUNKS_STORE, 'readonly');
    const req = tx.objectStore(CHUNKS_STORE).getKey(`${mediaKey}:0`);
    req.onsuccess = () => resolve(req.result !== undefined);
    req.onerror = () => resolve(false);
  });
}

export async function getStoredChunkProgress(mediaKey: string): Promise<{
  contiguousCount: number;
  totalBytes: number;
  chunkSizes: number[];
}> {
  if (!isIndexedDbAvailable()) return { contiguousCount: 0, totalBytes: 0, chunkSizes: [] };
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, 'readonly');
    const store = tx.objectStore(CHUNKS_STORE);
    const index = store.index(CHUNKS_MEDIA_INDEX);
    const entries: Array<{ index: number; byteLength: number }> = [];
    const curReq = index.openCursor(IDBKeyRange.only(mediaKey));
    curReq.onsuccess = () => {
      const cur = curReq.result;
      if (cur) {
        const row = cur.value as ChunkRecord | undefined;
        if (row && row.data && row.data.byteLength > 0) {
          entries.push({ index: row.index, byteLength: row.data.byteLength });
        }
        cur.continue();
      } else {
        entries.sort((a, b) => a.index - b.index);
        let expectedIdx = 0;
        let totalBytes = 0;
        const chunkSizes: number[] = [];
        for (const row of entries) {
          if (row.index !== expectedIdx || row.byteLength <= 0) {
            break;
          }
          totalBytes += row.byteLength;
          chunkSizes.push(row.byteLength);
          expectedIdx += 1;
        }
        resolve({ contiguousCount: expectedIdx, totalBytes, chunkSizes });
      }
    };
    curReq.onerror = () => reject(curReq.error || new Error('Failed to inspect stored chunks'));
  });
}

export async function savePendingDownloadTask(task: PersistedDownloadTask): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_TASKS_STORE, 'readwrite');
    const req = tx.objectStore(PENDING_TASKS_STORE).put(task);
    req.onerror = () => reject(req.error || new Error('Failed to save pending download task'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB pending task transaction failed'));
  });
}

export async function getPendingDownloadTask(key: string): Promise<PersistedDownloadTask | null> {
  if (!isIndexedDbAvailable()) return null;
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_TASKS_STORE, 'readonly');
    const req = tx.objectStore(PENDING_TASKS_STORE).get(key);
    req.onsuccess = () => resolve((req.result as PersistedDownloadTask | undefined) || null);
    req.onerror = () => reject(req.error || new Error('Failed to read pending download task'));
  });
}

export async function listPendingDownloadTasks(): Promise<PersistedDownloadTask[]> {
  if (!isIndexedDbAvailable()) return [];
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_TASKS_STORE, 'readonly');
    const req = tx.objectStore(PENDING_TASKS_STORE).getAll();
    req.onsuccess = () => {
      const items = Array.isArray(req.result) ? (req.result as PersistedDownloadTask[]) : [];
      items.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      resolve(items);
    };
    req.onerror = () => reject(req.error || new Error('Failed to list pending download tasks'));
  });
}

export async function deletePendingDownloadTask(key: string): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_TASKS_STORE, 'readwrite');
    tx.objectStore(PENDING_TASKS_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to delete pending download task'));
  });
}

export async function saveOfflineMetadata(entry: OfflineDownloadEntry): Promise<void> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ITEMS_STORE, PENDING_TASKS_STORE], 'readwrite');
    tx.objectStore(ITEMS_STORE).put(entry);
    tx.objectStore(PENDING_TASKS_STORE).delete(entry.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB metadata transaction failed'));
  });
}

export async function patchOfflineDownloadEntry(
  key: string,
  patch: Partial<OfflineDownloadEntry>,
): Promise<OfflineDownloadEntry | null> {
  if (!isIndexedDbAvailable()) return null;
  const existing = await getOfflineDownload(key);
  if (!existing) return null;
  const next: OfflineDownloadEntry = { ...existing, ...patch };
  await saveOfflineMetadata(next);
  return next;
}

export async function deleteOfflineChunksForKey(mediaKey: string): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, 'readwrite');
    const store = tx.objectStore(CHUNKS_STORE);
    const index = store.index(CHUNKS_MEDIA_INDEX);
    const range = IDBKeyRange.only(mediaKey);
    const cursorReq = index.openKeyCursor(range);

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error || new Error('Failed to prune chunks'));
    tx.oncomplete = () => resolve();
  });
}

export async function deleteOfflineDownload(key: string): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  const existing = await getOfflineDownload(key).catch(() => null);
  if (existing?.localFileUri) {
    await deleteNativeMediaFile(existing.localFileUri, existing.storageBackend, key);
  }
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ITEMS_STORE, CHUNKS_STORE, PENDING_TASKS_STORE], 'readwrite');
    tx.objectStore(ITEMS_STORE).delete(key);
    tx.objectStore(PENDING_TASKS_STORE).delete(key);

    const chunkStore = tx.objectStore(CHUNKS_STORE);
    const index = chunkStore.index(CHUNKS_MEDIA_INDEX);
    const cursorReq = index.openKeyCursor(IDBKeyRange.only(key));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        chunkStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to delete offline download'));
  });
}

export async function clearAllOfflineDownloads(): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  const existing = await listOfflineDownloads().catch(() => []);
  await Promise.allSettled(
    existing
      .filter((e) => Boolean(e.localFileUri))
      .map((e) => deleteNativeMediaFile(e.localFileUri, e.storageBackend)),
  );
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ITEMS_STORE, CHUNKS_STORE, PENDING_TASKS_STORE], 'readwrite');
    tx.objectStore(ITEMS_STORE).clear();
    tx.objectStore(CHUNKS_STORE).clear();
    tx.objectStore(PENDING_TASKS_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to clear offline downloads'));
  });
}

async function ensureServiceWorkerControlsPage(timeoutMs = 1200): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  if (navigator.serviceWorker.controller) {
    return true;
  }
  try {
    const reg = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (navigator.serviceWorker.controller) {
      return true;
    }
    const activeWorker = reg?.active;
    if (activeWorker) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, 500);
        const onCtrl = () => {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('controllerchange', onCtrl);
          finish();
        };
        navigator.serviceWorker.addEventListener('controllerchange', onCtrl);
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('controllerchange', onCtrl);
          finish();
        };
        activeWorker.postMessage({ type: 'CINEBOX_CLAIM_CLIENTS' }, [channel.port2]);
      });
    }
    return Boolean(navigator.serviceWorker.controller);
  } catch {
    return Boolean(navigator.serviceWorker.controller);
  }
}

export async function createOfflineBlobPlaybackUrl(
  key: string,
  mimeTypeOverride?: string,
): Promise<string> {
  const entry = await getOfflineDownload(key);
  if (!entry) {
    throw new Error('Offline media record not found in local storage');
  }

  const db = await openOfflineDb();
  const blobParts = await new Promise<Array<{ index: number; part: Blob }>>((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, 'readonly');
    const store = tx.objectStore(CHUNKS_STORE);
    const index = store.index(CHUNKS_MEDIA_INDEX);
    const parts: Array<{ index: number; part: Blob }> = [];
    const curReq = index.openCursor(IDBKeyRange.only(key));
    curReq.onsuccess = () => {
      const cur = curReq.result;
      if (cur) {
        const rec = cur.value as ChunkRecord | undefined;
        if (rec?.data && rec.data.byteLength > 0) {
          parts.push({ index: rec.index, part: new Blob([rec.data]) });
        }
        cur.continue();
      } else {
        parts.sort((a, b) => a.index - b.index);
        resolve(parts);
      }
    };
    curReq.onerror = () => reject(curReq.error || new Error('Failed to load offline chunks'));
  });

  if (blobParts.length === 0) {
    throw new Error('Offline video chunks are missing or corrupted');
  }

  const blob = new Blob(
    blobParts.map((p) => p.part),
    { type: mimeTypeOverride || entry.mimeType || 'video/mp4' },
  );
  return URL.createObjectURL(blob);
}

export async function createOfflinePlaybackUrl(key: string): Promise<{
  url: string;
  entry: OfflineDownloadEntry;
  posterUrl?: string;
  rawNativePath?: string;
}> {
  const entry = await getOfflineDownload(key);
  if (!entry) {
    throw new Error('Offline media record not found in local storage');
  }

  // O(1) first-chunk check (< 2ms) when metadata is verified; falls back to full check only for unverified legacy entries
  if (entry.isVerifiedPlayable && entry.sizeBytes > 0 && entry.chunkCount > 0) {
    const hasFirst = await hasFirstOfflineChunk(key);
    if (!hasFirst) {
      throw new Error(
        'Offline video data is missing from browser storage. Please remove and re-download this title.',
      );
    }
  } else {
    const chunkStats = await getStoredChunkProgress(key);
    if (chunkStats.contiguousCount === 0 || chunkStats.totalBytes <= 0) {
      throw new Error(
        'Offline video data is missing from browser storage. Please remove and re-download this title.',
      );
    }
  }

  const posterUrl = entry.posterBlob ? URL.createObjectURL(entry.posterBlob) : undefined;

  // Immediate Service Worker streaming when SW already controls the page (0ms wait)
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
    return {
      url: `/__offline_media__/${encodeURIComponent(key)}`,
      entry,
      posterUrl,
    };
  }

  const swActive = await ensureServiceWorkerControlsPage(450);
  if (swActive) {
    return {
      url: `/__offline_media__/${encodeURIComponent(key)}`,
      entry,
      posterUrl,
    };
  }

  const blobUrl = await createOfflineBlobPlaybackUrl(key, entry.mimeType);
  return { url: blobUrl, entry, posterUrl };
}

export async function estimateOfflineStorage(): Promise<{
  usedBytes: number;
  quotaBytes: number | null;
}> {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return {
        usedBytes: Number(est.usage || 0),
        quotaBytes: typeof est.quota === 'number' ? est.quota : null,
      };
    }
  } catch {
    // Ignore storage estimate failure
  }
  return { usedBytes: 0, quotaBytes: null };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 10 || idx <= 1 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s';
  return `${formatBytes(bytesPerSec)}/s`;
}
