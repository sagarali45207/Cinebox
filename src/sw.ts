/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST?: Array<string | { url: string; revision?: string | null }>;
};

interface BgFetchRegistrationLike {
  id: string;
  matchAll?: () => Promise<Array<{ request: Request; responseReady: Promise<Response> }>>;
}

interface BgFetchEventLike extends ExtendableEvent {
  registration: BgFetchRegistrationLike;
  updateUI?: (options: { title?: string }) => Promise<void>;
}

const CACHE_NAME = 'cinebox-shell-v1';
const OFFLINE_URL = '/offline.html';

const RAW_WB_MANIFEST = self.__WB_MANIFEST;

const MANIFEST_URLS: string[] = (() => {
  const entries = Array.isArray(RAW_WB_MANIFEST) ? RAW_WB_MANIFEST : [];
  const urls = new Set<string>([OFFLINE_URL]);
  for (const entry of entries) {
    const rawUrl = typeof entry === 'string' ? entry : entry?.url;
    if (!rawUrl) continue;
    const normalized = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
    urls.add(normalized);
  }
  return Array.from(urls);
})();

const HAS_PRECACHE_INDEX = MANIFEST_URLS.includes('/index.html');

self.addEventListener('install', (event) => {
  const urlsToCache = MANIFEST_URLS;
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          urlsToCache.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('cinebox-shell-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const payload = event.data as { type?: string; key?: string } | undefined;
  if (payload?.type === 'CINEBOX_KEEPALIVE') {
    event.ports?.[0]?.postMessage({ ok: true, ts: Date.now() });
  } else if (payload?.type === 'CINEBOX_CLAIM_CLIENTS') {
    event.waitUntil(
      self.clients.claim().then(() => {
        event.ports?.[0]?.postMessage({ ok: true, claimed: true });
      }),
    );
  } else if (payload?.type === 'CINEBOX_CLEAR_MEDIA_CACHE') {
    if (payload.key) {
      offlineEntryCache.delete(payload.key);
    } else {
      offlineEntryCache.clear();
    }
  }
});

async function notifyAllClients(message: unknown): Promise<void> {
  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const client of allClients) {
    client.postMessage(message);
  }
}

self.addEventListener('backgroundfetchsuccess', ((event: BgFetchEventLike) => {
  event.waitUntil(
    (async () => {
      try {
        await event.updateUI?.({ title: 'CineBox download ready' });
      } catch {
        // Ignore optional UI update error
      }
      await notifyAllClients({
        type: 'CINEBOX_BG_FETCH_RESULT',
        id: event.registration?.id,
        status: 'success',
      });
    })(),
  );
}) as EventListener);

self.addEventListener('backgroundfetchfail', ((event: BgFetchEventLike) => {
  event.waitUntil(
    notifyAllClients({
      type: 'CINEBOX_BG_FETCH_RESULT',
      id: event.registration?.id,
      status: 'failed',
    }),
  );
}) as EventListener);

self.addEventListener('backgroundfetchclick', ((event: BgFetchEventLike) => {
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      if (allClients.length > 0 && 'focus' in allClients[0]) {
        await allClients[0].focus();
      } else if (self.clients.openWindow) {
        await self.clients.openWindow('/');
      }
    })(),
  );
}) as EventListener);

async function fetchWithTimeout(request: Request, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const OFFLINE_MEDIA_PREFIX = '/__offline_media__/';
const OFFLINE_DB_NAME = 'cinebox_offline_v1';
const OFFLINE_ITEMS_STORE = 'items';
const OFFLINE_CHUNKS_STORE = 'chunks';
const OFFLINE_PENDING_TASKS_STORE = 'pending_tasks';
const SW_RANGE_SLICE_BYTES = 16 * 1024 * 1024;

interface CachedOfflineMediaMeta {
  totalSize: number;
  mimeType: string;
  chunkSizes: number[];
}

const offlineEntryCache = new Map<string, CachedOfflineMediaMeta>();
let cachedMediaDbPromise: Promise<IDBDatabase> | null = null;

function openOfflineMediaDb(): Promise<IDBDatabase> {
  if (cachedMediaDbPromise) return cachedMediaDbPromise;

  cachedMediaDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_ITEMS_STORE)) {
        db.createObjectStore(OFFLINE_ITEMS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(OFFLINE_CHUNKS_STORE)) {
        const chunkStore = db.createObjectStore(OFFLINE_CHUNKS_STORE, { keyPath: 'id' });
        chunkStore.createIndex('by_media', 'mediaKey', { unique: false });
      }
      if (!db.objectStoreNames.contains(OFFLINE_PENDING_TASKS_STORE)) {
        db.createObjectStore(OFFLINE_PENDING_TASKS_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        cachedMediaDbPromise = null;
        try {
          db.close();
        } catch {
          // ignore
        }
      };
      db.onclose = () => {
        cachedMediaDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      cachedMediaDbPromise = null;
      reject(req.error || new Error('Unable to open offline DB'));
    };
  });

  return cachedMediaDbPromise;
}

async function readOfflineEntryFromDb(key: string): Promise<{
  sizeBytes?: number;
  mimeType?: string;
  chunkCount?: number;
  chunkSizes?: number[];
} | null> {
  const db = await openOfflineMediaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_ITEMS_STORE, 'readonly');
    const req = tx.objectStore(OFFLINE_ITEMS_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function resolveOfflineMediaMeta(mediaKey: string): Promise<CachedOfflineMediaMeta | null> {
  const cached = offlineEntryCache.get(mediaKey);
  if (cached && cached.totalSize > 0 && cached.chunkSizes.length > 0) {
    return cached;
  }

  const entry = await readOfflineEntryFromDb(mediaKey);
  if (!entry) return null;

  let chunkSizes: number[];
  if (Array.isArray(entry.chunkSizes) && entry.chunkSizes.length > 0) {
    chunkSizes = entry.chunkSizes;
  } else {
    const db = await openOfflineMediaDb();
    const metas = await new Promise<Array<{ index: number; byteLength: number }>>((resolve, reject) => {
      const tx = db.transaction(OFFLINE_CHUNKS_STORE, 'readonly');
      const idx = tx.objectStore(OFFLINE_CHUNKS_STORE).index('by_media');
      const out: Array<{ index: number; byteLength: number }> = [];
      const curReq = idx.openCursor(IDBKeyRange.only(mediaKey));
      curReq.onsuccess = () => {
        const cur = curReq.result;
        if (cur) {
          const val = cur.value as { index: number; data?: ArrayBuffer };
          if (val?.data && val.data.byteLength > 0) {
            out.push({ index: val.index, byteLength: val.data.byteLength });
          }
          cur.continue();
        } else {
          out.sort((a, b) => a.index - b.index);
          resolve(out);
        }
      };
      curReq.onerror = () => reject(curReq.error);
    });
    chunkSizes = metas.map((m) => m.byteLength);
  }

  const totalSize = chunkSizes.reduce((acc, s) => acc + s, 0);
  if (chunkSizes.length === 0 || totalSize <= 0) {
    return null;
  }

  const meta: CachedOfflineMediaMeta = {
    totalSize,
    mimeType: entry.mimeType || 'video/mp4',
    chunkSizes,
  };
  if (offlineEntryCache.size > 24) {
    const firstKey = offlineEntryCache.keys().next().value;
    if (firstKey) offlineEntryCache.delete(firstKey);
  }
  offlineEntryCache.set(mediaKey, meta);
  return meta;
}

async function readChunkSliceByKey(
  mediaKey: string,
  chunkIndex: number,
  sliceStart: number,
  sliceEnd: number,
): Promise<Uint8Array | null> {
  const db = await openOfflineMediaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_CHUNKS_STORE, 'readonly');
    const req = tx.objectStore(OFFLINE_CHUNKS_STORE).get(`${mediaKey}:${chunkIndex}`);
    req.onsuccess = () => {
      const rec = req.result as { data?: ArrayBuffer } | undefined;
      if (!rec?.data) {
        offlineEntryCache.delete(mediaKey);
        resolve(null);
        return;
      }
      if (sliceStart === 0 && sliceEnd >= rec.data.byteLength) {
        resolve(new Uint8Array(rec.data));
      } else {
        resolve(new Uint8Array(rec.data.slice(sliceStart, sliceEnd)));
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function handleOfflineMediaRequest(request: Request, mediaKey: string): Promise<Response> {
  try {
    const meta = await resolveOfflineMediaMeta(mediaKey);
    if (!meta) {
      offlineEntryCache.delete(mediaKey);
      return new Response('Offline media not found', { status: 404 });
    }

    const { totalSize, mimeType, chunkSizes } = meta;
    const rangeHeader = request.headers.get('range');

    let start = 0;
    let end = totalSize - 1;
    let isRange = false;

    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/i);
      if (m) {
        isRange = true;
        start = Math.max(0, Number(m[1]));
        const reqEnd = m[2]
          ? Number(m[2])
          : Math.min(totalSize - 1, start + SW_RANGE_SLICE_BYTES - 1);
        end = Math.min(totalSize - 1, Math.max(start, reqEnd));
      }
    }

    if (start >= totalSize) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${totalSize}` },
      });
    }

    const responseLength = end - start + 1;
    const baseHeaders: Record<string, string> = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(responseLength),
      'Cache-Control': 'no-store',
    };
    if (isRange) {
      baseHeaders['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: isRange ? 206 : 200,
        headers: baseHeaders,
      });
    }

    const neededSlices: Array<{ chunkIndex: number; sliceStart: number; sliceEnd: number }> = [];
    let cursor = 0;
    for (let i = 0; i < chunkSizes.length; i++) {
      const chunkLen = chunkSizes[i];
      const cStart = cursor;
      const cEnd = cursor + chunkLen - 1;
      cursor += chunkLen;
      if (cEnd < start) continue;
      if (cStart > end) break;
      neededSlices.push({
        chunkIndex: i,
        sliceStart: Math.max(0, start - cStart),
        sliceEnd: Math.min(chunkLen, end - cStart + 1),
      });
    }

    if (neededSlices.length === 1) {
      const only = neededSlices[0];
      const bytes = await readChunkSliceByKey(
        mediaKey,
        only.chunkIndex,
        only.sliceStart,
        only.sliceEnd,
      );
      if (!bytes) {
        return new Response('Offline video data missing', { status: 404 });
      }
      return new Response(bytes.buffer as ArrayBuffer, {
        status: isRange ? 206 : 200,
        headers: baseHeaders,
      });
    }

    let sliceCursor = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (sliceCursor < neededSlices.length) {
            const slice = neededSlices[sliceCursor++];
            const bytes = await readChunkSliceByKey(
              mediaKey,
              slice.chunkIndex,
              slice.sliceStart,
              slice.sliceEnd,
            );
            if (bytes && bytes.byteLength > 0) {
              controller.enqueue(bytes);
              return;
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      status: isRange ? 206 : 200,
      headers: baseHeaders,
    });
  } catch {
    return new Response('Offline media read error', { status: 500 });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(OFFLINE_MEDIA_PREFIX)) {
    const encodedKey = url.pathname.slice(OFFLINE_MEDIA_PREFIX.length);
    const mediaKey = decodeURIComponent(encodedKey);
    event.respondWith(handleOfflineMediaRequest(request, mediaKey));
    return;
  }
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetchWithTimeout(request, 4500);
          if (networkRes && networkRes.ok) {
            return networkRes;
          }
          throw new Error('bad_navigation_status');
        } catch {
          const cache = await caches.open(CACHE_NAME);
          if (HAS_PRECACHE_INDEX) {
            const cachedIndex = await cache.match('/index.html', { ignoreSearch: true });
            if (cachedIndex) return cachedIndex;
          }
          const cachedOffline = await cache.match(OFFLINE_URL, { ignoreSearch: true });
          if (cachedOffline) return cachedOffline;
          return new Response(
            '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:48px"><h2>No Internet Connection</h2><p>Please check your Wi-Fi or mobile data and try again.</p></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  // Serve precached static assets cleanly when offline
  if (
    HAS_PRECACHE_INDEX ||
    url.pathname === OFFLINE_URL ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico')
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) {
          return cached;
        }
        try {
          const res = await fetch(request);
          if (res && res.ok && res.type === 'basic') {
            void cache.put(request, res.clone());
          }
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      })(),
    );
  }
});
