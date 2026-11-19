import { useSyncExternalStore } from 'react';
import { sanitizeNativeFileName } from '../plugins/cineboxDownloader';
import { fetchDownloadSizes, fetchSubtitles } from '../services/api';
import type {
  DownloadProfileMode,
  DownloadQuality,
  DownloadSpeedComparison,
  OfflineDownloadEntry,
  OfflineDownloadTaskState,
  OfflineSubtitleCache,
} from '../types/media';
import { parseDurationHintToSeconds, proxiedImageUrl } from './format';
import {
  clearAllOfflineDownloads,
  createOfflinePlaybackUrl,
  deleteOfflineChunksForKey,
  deleteOfflineDownload,
  deletePendingDownloadTask,
  estimateOfflineStorage,
  getOfflineDownload,
  getPendingDownloadTask,
  getStoredChunkProgress,
  isIndexedDbAvailable,
  listOfflineDownloads,
  listPendingDownloadTasks,
  patchOfflineDownloadEntry,
  putOfflineChunk,
  saveOfflineMetadata,
  savePendingDownloadTask,
  type PersistedDownloadTask,
  type PersistedDownloadTaskInput,
} from './offlineDb';
import { loadAppSettings, saveAppSettings } from './settings';

export interface QueueOfflineDownloadInput {
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
  expectedTotalBytes?: number;
  isEstimatedTotal?: boolean;
  replaceExisting?: boolean;
}

interface InternalQueueEntry extends QueueOfflineDownloadInput {
  resumeChunkIndex?: number;
  resumeOffset?: number;
  resumeTotalBytes?: number;
  resumeIsEstimatedTotal?: boolean;
  resumeDirectUrl?: string;
  resumeExt?: string;
  resumeMimeType?: string;
  resumeMode?: 'native' | 'direct' | 'transcode';
  resumeJobId?: string;
  nativeTaskId?: string;
}

interface SpeedTelemetryStore {
  standardBytesPerSec: number;
  standardUpdatedAt: number;
  turboBytesPerSec: number;
  turboUpdatedAt: number;
}

interface OfflineSnapshot {
  downloads: OfflineDownloadEntry[];
  tasks: Record<string, OfflineDownloadTaskState>;
  usedStorageBytes: number;
  browserUsageBytes: number;
  quotaBytes: number | null;
  downloadProfile: DownloadProfileMode;
  speedComparison: DownloadSpeedComparison | null;
  ready: boolean;
}

const STANDARD_CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB conservative chunks in Standard mode
const TURBO_CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB high-throughput chunks in Turbo mode
const TURBO_TRANSCODE_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MiB single-request transcode slices in Turbo mode
const TURBO_DIRECT_WORKERS = 6;
const SPEED_TELEMETRY_STORAGE_KEY = 'cinebox_dl_speed_telemetry_v1';
const SPEED_TELEMETRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadSpeedTelemetry(): SpeedTelemetryStore {
  const empty: SpeedTelemetryStore = {
    standardBytesPerSec: 0,
    standardUpdatedAt: 0,
    turboBytesPerSec: 0,
    turboUpdatedAt: 0,
  };
  if (typeof window === 'undefined' || !window.localStorage) return empty;
  try {
    const raw = window.localStorage.getItem(SPEED_TELEMETRY_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<SpeedTelemetryStore>;
    const now = Date.now();
    const stdValid =
      typeof parsed.standardBytesPerSec === 'number' &&
      parsed.standardBytesPerSec > 0 &&
      typeof parsed.standardUpdatedAt === 'number' &&
      now - parsed.standardUpdatedAt <= SPEED_TELEMETRY_TTL_MS;
    const turboValid =
      typeof parsed.turboBytesPerSec === 'number' &&
      parsed.turboBytesPerSec > 0 &&
      typeof parsed.turboUpdatedAt === 'number' &&
      now - parsed.turboUpdatedAt <= SPEED_TELEMETRY_TTL_MS;
    return {
      standardBytesPerSec: stdValid ? Math.round(parsed.standardBytesPerSec!) : 0,
      standardUpdatedAt: stdValid ? parsed.standardUpdatedAt! : 0,
      turboBytesPerSec: turboValid ? Math.round(parsed.turboBytesPerSec!) : 0,
      turboUpdatedAt: turboValid ? parsed.turboUpdatedAt! : 0,
    };
  } catch {
    return empty;
  }
}

let speedTelemetry: SpeedTelemetryStore = loadSpeedTelemetry();

function buildSpeedComparison(store: SpeedTelemetryStore): DownloadSpeedComparison | null {
  const std = Math.max(0, Math.round(store.standardBytesPerSec));
  const turbo = Math.max(0, Math.round(store.turboBytesPerSec));
  if (std <= 0 && turbo <= 0) return null;
  if (std > 0 && turbo > 0) {
    const increaseBytesPerSec = Math.round(turbo - std);
    const increasePercent = Math.round((increaseBytesPerSec / std) * 100);
    const multiplier = Number((turbo / std).toFixed(2));
    return {
      standardBytesPerSec: std,
      turboBytesPerSec: turbo,
      increaseBytesPerSec,
      increasePercent,
      multiplier,
    };
  }
  return {
    standardBytesPerSec: std,
    turboBytesPerSec: turbo,
    increaseBytesPerSec: 0,
    increasePercent: 0,
    multiplier: turbo > 0 ? 1 : 0,
  };
}

function recordMeasuredThroughput(profile: DownloadProfileMode, bytesPerSec: number): void {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0 || bytesPerSec > 500_000_000) return;
  const now = Date.now();
  if (profile === 'premium') {
    const freshPrev =
      speedTelemetry.turboBytesPerSec > 0 && now - speedTelemetry.turboUpdatedAt < 30 * 60 * 1000;
    const blended = freshPrev
      ? Math.round(speedTelemetry.turboBytesPerSec * 0.55 + bytesPerSec * 0.45)
      : Math.round(bytesPerSec);
    speedTelemetry = {
      ...speedTelemetry,
      turboBytesPerSec: blended,
      turboUpdatedAt: now,
    };
  } else {
    const freshPrev =
      speedTelemetry.standardBytesPerSec > 0 &&
      now - speedTelemetry.standardUpdatedAt < 30 * 60 * 1000;
    const blended = freshPrev
      ? Math.round(speedTelemetry.standardBytesPerSec * 0.55 + bytesPerSec * 0.45)
      : Math.round(bytesPerSec);
    speedTelemetry = {
      ...speedTelemetry,
      standardBytesPerSec: blended,
      standardUpdatedAt: now,
    };
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(SPEED_TELEMETRY_STORAGE_KEY, JSON.stringify(speedTelemetry));
    } catch {
      // ignore storage quota errors
    }
  }
  snapshot = {
    ...snapshot,
    speedComparison: buildSpeedComparison(speedTelemetry),
  };
  emitChange();
}

function isTurboProfile(): boolean {
  return snapshot.downloadProfile === 'premium';
}

function getChunkSizeForProfile(): number {
  return isTurboProfile() ? TURBO_CHUNK_SIZE_BYTES : STANDARD_CHUNK_SIZE_BYTES;
}

function getMaxConcurrentTasks(): number {
  return 1;
}

function notifySwClearMediaCache(key?: string): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'CINEBOX_CLEAR_MEDIA_CACHE',
        key,
      });
    }
  } catch {
    // ignore
  }
}

let snapshot: OfflineSnapshot = {
  downloads: [],
  tasks: {},
  usedStorageBytes: 0,
  browserUsageBytes: 0,
  quotaBytes: null,
  downloadProfile: loadAppSettings().downloadProfile,
  speedComparison: buildSpeedComparison(speedTelemetry),
  ready: false,
};

const listeners = new Set<() => void>();
const queue: InternalQueueEntry[] = [];
const activeControllers = new Map<string, AbortController>();
const pauseRequestedKeys = new Set<string>();
const activeJobIds = new Map<string, string>();
let isPageUnloading = false;
let activeWorkerCount = 0;
let initialized = false;
let recoveryInProgress = false;
let swKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function updateSnapshot(patch: Partial<OfflineSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  emitChange();
}

function updateTask(key: string, patch: Partial<OfflineDownloadTaskState>) {
  const prev = snapshot.tasks[key];
  if (!prev) return;
  snapshot = {
    ...snapshot,
    tasks: {
      ...snapshot.tasks,
      [key]: { ...prev, ...patch },
    },
  };
  emitChange();
}

function removeTask(key: string) {
  if (!(key in snapshot.tasks)) return;
  const nextTasks = { ...snapshot.tasks };
  delete nextTasks[key];
  snapshot = { ...snapshot, tasks: nextTasks };
  emitChange();
}

function toPersistedInput(input: QueueOfflineDownloadInput): PersistedDownloadTaskInput {
  return {
    kind: input.kind,
    id: input.id,
    seriesId: input.seriesId,
    seriesTitle: input.seriesTitle,
    seasonNum: input.seasonNum,
    episodeNum: input.episodeNum,
    title: input.title,
    subtitle: input.subtitle,
    categoryName: input.categoryName,
    year: input.year,
    rating: input.rating,
    duration: input.duration,
    plot: input.plot,
    poster: input.poster,
    playUrl: input.playUrl,
    extension: input.extension,
    quality: input.quality,
  };
}

function startSwKeepaliveIfNeeded() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (swKeepaliveTimer) return;
  swKeepaliveTimer = setInterval(() => {
    const hasActiveTasks = Object.values(snapshot.tasks).some(
      (t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'saving',
    );
    if (!hasActiveTasks) {
      if (swKeepaliveTimer) {
        clearInterval(swKeepaliveTimer);
        swKeepaliveTimer = null;
      }
      return;
    }
    try {
      navigator.serviceWorker.controller?.postMessage({ type: 'CINEBOX_KEEPALIVE' });
    } catch {
      // Ignore SW keepalive failure
    }
  }, 25_000);
}

export async function refreshOfflineDownloads(): Promise<void> {
  try {
    const [downloads, est] = await Promise.all([
      listOfflineDownloads(),
      estimateOfflineStorage(),
    ]);
    const downloadsSizeSum = downloads.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
    updateSnapshot({
      downloads,
      usedStorageBytes: downloadsSizeSum,
      browserUsageBytes: Math.max(est.usedBytes || 0, downloadsSizeSum),
      quotaBytes: est.quotaBytes,
      ready: true,
    });
  } catch {
    updateSnapshot({ ready: true });
  }
}

async function finalizeOfflineDownloadRecord(params: {
  key: string;
  item: QueueOfflineDownloadInput;
  quality: DownloadQuality;
  ext: string;
  mimeType: string;
  sizeBytes: number;
  chunkCount: number;
  durationSec?: number;
  storageBackend?: 'indexeddb' | 'capacitor-native' | 'capacitor-filesystem';
  localFileUri?: string;
  hlsManifestPath?: string;
  profile?: DownloadProfileMode;
  signal: AbortSignal;
}): Promise<void> {
  const {
    key,
    item,
    quality,
    ext,
    mimeType,
    sizeBytes,
    chunkCount,
    durationSec,
    storageBackend,
    localFileUri,
    hlsManifestPath,
    profile,
    signal,
  } = params;

  updateTask(key, {
    status: 'saving',
    receivedBytes: sizeBytes,
    totalBytes: sizeBytes,
    isEstimatedTotal: false,
    waitingForNetwork: false,
    speedBytesPerSec: 0,
    etaSeconds: 0,
    percent: 99,
  });

  const verifiedChunks = await getStoredChunkProgress(key);
  if (verifiedChunks.contiguousCount <= 0 || verifiedChunks.totalBytes <= 0) {
    throw new Error('Offline video verification failed: stored media chunks are missing.');
  }

  const [posterBlob, subtitles] = await Promise.all([
    fetchPosterBlobBestEffort(item.poster, signal),
    fetchOfflineSubtitlesBestEffort(item, signal),
  ]);

  const entry: OfflineDownloadEntry = {
    key,
    kind: item.kind,
    id: item.id,
    seriesId: item.seriesId,
    seriesTitle: item.seriesTitle,
    seasonNum: item.seasonNum,
    episodeNum: item.episodeNum,
    title: item.title,
    subtitle: item.subtitle,
    categoryName: item.categoryName,
    year: item.year,
    rating: item.rating,
    duration: item.duration,
    durationSec: durationSec && durationSec > 0 ? durationSec : undefined,
    plot: item.plot,
    poster: item.poster,
    posterBlob,
    extension: ext,
    mimeType,
    quality,
    sizeBytes: verifiedChunks.totalBytes || sizeBytes,
    chunkCount: verifiedChunks.contiguousCount || chunkCount,
    chunkSizes: verifiedChunks.chunkSizes,
    downloadedAt: Date.now(),
    subtitles,
    storageBackend: storageBackend || 'indexeddb',
    localFileUri,
    privateFilePath: localFileUri,
    hlsManifestPath,
    isVerifiedPlayable: true,
    transferStatus: 'not_exported',
    transferProgress: 0,
    downloadProfile: profile || snapshot.downloadProfile,
  };

  await saveOfflineMetadata(entry);
  notifySwClearMediaCache(key);
  await deletePendingDownloadTask(key).catch(() => {});
  removeTask(key);
  await refreshOfflineDownloads();
}

async function recoverPendingDownloads(): Promise<void> {
  if (recoveryInProgress || !isIndexedDbAvailable()) return;
  recoveryInProgress = true;

  try {
    const [existingDownloads, pendingTasks] = await Promise.all([
      listOfflineDownloads(),
      listPendingDownloadTasks(),
    ]);
    const completedKeys = new Set(existingDownloads.map((d) => d.key));

    for (const pending of pendingTasks) {
      const key = pending.key;
      if (completedKeys.has(key)) {
        await deletePendingDownloadTask(key).catch(() => {});
        await deleteOfflineChunksForKey(key).catch(() => {});
        continue;
      }

      if (activeControllers.has(key)) continue;
      if (queue.some((q) => `${q.kind}:${q.id}` === key)) continue;

      const chunkProg = await getStoredChunkProgress(key).catch(() => ({
        contiguousCount: 0,
        totalBytes: 0,
      }));
      const canByteResume =
        (pending.mode === 'direct' || pending.mode === 'transcode') && chunkProg.contiguousCount > 0;
      const resumeOffset = canByteResume ? chunkProg.totalBytes : pending.receivedBytes || 0;
      const resumeChunks = canByteResume ? chunkProg.contiguousCount : 0;
      if (!canByteResume && chunkProg.contiguousCount > 0) {
        await deleteOfflineChunksForKey(key).catch(() => {});
      }

      const resumePct =
        pending.totalBytes > 0 && resumeOffset > 0
          ? Math.min(99, Math.round((resumeOffset / pending.totalBytes) * 100))
          : 0;

      // Preserve explicitly paused tasks with exact saved % so user resumes from where they left off
      if (pending.status === 'paused') {
        snapshot = {
          ...snapshot,
          tasks: {
            ...snapshot.tasks,
            [key]: {
              key,
              id: pending.input.id,
              title: pending.input.title,
              subtitle: pending.input.subtitle,
              kind: pending.input.kind,
              seriesId: pending.input.seriesId,
              seriesTitle: pending.input.seriesTitle,
              seasonNum: pending.input.seasonNum,
              episodeNum: pending.input.episodeNum,
              categoryName: pending.input.categoryName,
              year: pending.input.year,
              poster: pending.input.poster,
              quality: pending.quality,
              status: 'paused',
              receivedBytes: resumeOffset,
              totalBytes: pending.totalBytes || 0,
              isEstimatedTotal: pending.isEstimatedTotal,
              speedBytesPerSec: 0,
              percent: resumePct,
              waitingForNetwork: false,
            },
          },
        };
        emitChange();
        continue;
      }

      snapshot = {
        ...snapshot,
        tasks: {
          ...snapshot.tasks,
          [key]: {
            key,
            id: pending.input.id,
            title: pending.input.title,
            subtitle: pending.input.subtitle,
            kind: pending.input.kind,
            seriesId: pending.input.seriesId,
            seriesTitle: pending.input.seriesTitle,
            seasonNum: pending.input.seasonNum,
            episodeNum: pending.input.episodeNum,
            categoryName: pending.input.categoryName,
            year: pending.input.year,
            poster: pending.input.poster,
            quality: pending.quality,
            status: 'queued',
            receivedBytes: resumeOffset,
            totalBytes: pending.totalBytes || 0,
            isEstimatedTotal: pending.isEstimatedTotal,
            speedBytesPerSec: 0,
            percent: resumePct,
            waitingForNetwork: typeof navigator !== 'undefined' && navigator.onLine === false,
          },
        },
      };
      emitChange();

      queue.push({
        ...pending.input,
        quality: pending.quality,
        resumeChunkIndex: resumeChunks,
        resumeOffset,
        resumeTotalBytes: pending.totalBytes,
        resumeIsEstimatedTotal: pending.isEstimatedTotal,
        resumeDirectUrl: pending.directUrl,
        resumeExt: pending.ext,
        resumeMimeType: pending.mimeType,
        resumeMode:
          pending.mode === 'direct'
            ? 'direct'
            : pending.mode === 'transcode'
              ? 'transcode'
              : undefined,
        resumeJobId: pending.jobId,
      });
    }

    if (queue.length > 0) {
      startSwKeepaliveIfNeeded();
      void processQueue();
    }
  } finally {
    recoveryInProgress = false;
  }
}

function ensureInitialized() {
  if (initialized) return;
  initialized = true;

  void (async () => {
    await refreshOfflineDownloads();
    await recoverPendingDownloads();
  })();

  if (typeof window !== 'undefined') {
    const handleForegroundOrOnline = () => {
      isPageUnloading = false;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      // Recover any error-interrupted tasks automatically when connectivity or foreground returns
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        for (const task of Object.values(snapshot.tasks)) {
          if (task.status === 'error') {
            void resumeOfflineDownload(task.key);
          }
        }
      }
      void recoverPendingDownloads();
    };

    const handlePageHide = () => {
      isPageUnloading = true;
      // Pause backend transcode FFmpeg jobs gently with keepalive so progress survives app close & auto-resumes on reopen
      for (const jobId of activeJobIds.values()) {
        if (!jobId) continue;
        try {
          void fetch(`/api/play/download/job/${encodeURIComponent(jobId)}/pause`, {
            method: 'POST',
            keepalive: true,
          }).catch(() => {});
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener('online', handleForegroundOrOnline);
    window.addEventListener('pageshow', handleForegroundOrOnline);
    window.addEventListener('focus', handleForegroundOrOnline);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          handleForegroundOrOnline();
        }
      });
    }
  }
}

function parseContentRangeTotal(headerVal: string | null): {
  start: number;
  end: number;
  total: number | null;
} | null {
  if (!headerVal) return null;
  const m = headerVal.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

function inferMimeFromExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'avi':
      return 'video/x-msvideo';
    case 'ts':
      return 'video/mp2t';
    default:
      return 'video/mp4';
  }
}

async function fetchPosterBlobBestEffort(poster: string, signal: AbortSignal): Promise<Blob | undefined> {
  const url = proxiedImageUrl(poster);
  if (!url) return undefined;
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return undefined;
    const blob = await resp.blob();
    return blob.size > 0 && blob.size <= 5 * 1024 * 1024 ? blob : undefined;
  } catch {
    return undefined;
  }
}

async function fetchOfflineSubtitlesBestEffort(
  item: QueueOfflineDownloadInput,
  signal: AbortSignal,
): Promise<OfflineSubtitleCache[] | undefined> {
  try {
    const res = await fetchSubtitles(
      {
        kind: item.kind === 'episode' ? 'series' : 'movie',
        streamId: item.id,
        seriesId: item.seriesId,
        season: item.seasonNum,
        episode: item.episodeNum,
        title: item.seriesTitle || item.title,
        year: item.year,
      },
      signal,
    );
    const candidates = (res.subtitles || []).slice(0, 2);
    if (candidates.length === 0) return undefined;

    const cached: OfflineSubtitleCache[] = [];
    for (const sub of candidates) {
      try {
        const vttResp = await fetch(sub.vttUrl, { signal });
        if (!vttResp.ok) continue;
        const vttText = await vttResp.text();
        if (vttText && vttText.includes('-->')) {
          cached.push({
            id: sub.id,
            language: sub.language,
            vttText,
          });
        }
      } catch {
        // Ignore single subtitle fetch error
      }
    }
    return cached.length > 0 ? cached : undefined;
  } catch {
    return undefined;
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [800, 1500, 2500, 3500, 5000, 6500, 8000, 10000, 12000, 15000];
const MAX_WARMUP_POLLS = 60;
const CHUNK_REQUEST_TIMEOUT_MS = 25_000;

function pauseActiveRemoteVideos(): void {
  if (typeof document === 'undefined') return;
  try {
    const videos = document.querySelectorAll('video');
    videos.forEach((v) => {
      const src = v.currentSrc || v.getAttribute('src') || '';
      if (src && !src.startsWith('blob:') && !v.paused) {
        try {
          v.pause();
        } catch {
          // ignore
        }
      }
    });
  } catch {
    // ignore
  }
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForOnlineIfNeeded(
  signal: AbortSignal,
  maxWaitMs = 15_000,
  onWaitingChange?: (waiting: boolean) => void,
): Promise<void> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (typeof navigator === 'undefined' || navigator.onLine !== false || typeof window === 'undefined') {
    onWaitingChange?.(false);
    return;
  }
  onWaitingChange?.(true);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      signal.removeEventListener('abort', onAbort);
    };
    const onOnline = () => {
      cleanup();
      onWaitingChange?.(false);
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, maxWaitMs);

    window.addEventListener('online', onOnline, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(headerVal: string | null, fallbackMs: number): number {
  if (!headerVal) return fallbackMs;
  const sec = Number(headerVal.trim());
  if (Number.isFinite(sec) && sec > 0) {
    return Math.min(15_000, Math.max(800, Math.round(sec * 1000)));
  }
  return fallbackMs;
}

interface RangeChunkResult {
  resp: Response;
  buf: ArrayBuffer | null;
}

async function readResponseArrayBufferWithProgress(
  resp: Response,
  onBytesRead?: (deltaBytes: number) => void,
): Promise<ArrayBuffer> {
  if (!onBytesRead || !resp.body) {
    return resp.arrayBuffer();
  }
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      parts.push(value);
      total += value.byteLength;
      onBytesRead(value.byteLength);
    }
  }
  if (parts.length === 1 && parts[0].byteOffset === 0 && parts[0].byteLength === parts[0].buffer.byteLength) {
    return parts[0].buffer as ArrayBuffer;
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    merged.set(part, pos);
    pos += part.byteLength;
  }
  return merged.buffer;
}

async function fetchRangeChunkWithRetry(
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  options?: {
    maxOnlineRetries?: number;
    waitIndefinitelyOffline?: boolean;
    onWaitingChange?: (waiting: boolean) => void;
    onBytesRead?: (deltaBytes: number) => void;
  },
): Promise<RangeChunkResult> {
  const maxOnlineRetries = options?.maxOnlineRetries ?? RETRY_DELAYS_MS.length;
  const waitIndefinitelyOffline = options?.waitIndefinitelyOffline ?? true;
  const onWaitingChange = options?.onWaitingChange;
  const onBytesRead = options?.onBytesRead;

  let onlineAttempt = 0;
  let warmupPolls = 0;

  while (true) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    await waitForOnlineIfNeeded(signal, 15_000, onWaitingChange);

    const attemptCtrl = new AbortController();
    let timedOut = false;
    const onParentAbort = () => attemptCtrl.abort();
    if (signal.aborted) {
      attemptCtrl.abort();
    } else {
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timeoutId = setTimeout(() => {
      timedOut = true;
      attemptCtrl.abort();
    }, CHUNK_REQUEST_TIMEOUT_MS);

    let nextDelayOverride: number | null = null;
    let isWarmupPoll = false;
    let isOfflineOutage = false;

    try {
      const resp = await fetch(url, {
        headers: {
          Accept: '*/*',
          ...headers,
        },
        signal: attemptCtrl.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });

      onWaitingChange?.(false);

      const downloadStatus = (resp.headers.get('x-download-status') || '').toLowerCase();

      if (resp.status === 202 || downloadStatus === 'preparing') {
        if (warmupPolls < MAX_WARMUP_POLLS) {
          isWarmupPoll = true;
          warmupPolls += 1;
          nextDelayOverride = parseRetryAfterMs(resp.headers.get('retry-after'), 600);
          await resp.body?.cancel().catch(() => {});
          throw new Error('Server preparing stream');
        }
        await resp.body?.cancel().catch(() => {});
        throw new Error('Server took too long preparing media stream');
      }

      if (!resp.ok) {
        if (resp.status === 503 && warmupPolls < MAX_WARMUP_POLLS) {
          const clone = resp.clone();
          const bodyJson = (await clone.json().catch(() => null)) as { retryable?: boolean } | null;
          if (bodyJson?.retryable) {
            isWarmupPoll = true;
            warmupPolls += 1;
            nextDelayOverride = parseRetryAfterMs(resp.headers.get('retry-after'), 600);
            await resp.body?.cancel().catch(() => {});
            throw new Error('Retryable HTTP 503 warmup');
          }
        }

        if (RETRYABLE_HTTP_STATUSES.has(resp.status) && onlineAttempt < maxOnlineRetries) {
          const baseBackoff = RETRY_DELAYS_MS[onlineAttempt] ?? 10_000;
          const headerDelay = parseRetryAfterMs(resp.headers.get('retry-after'), baseBackoff);
          nextDelayOverride = Math.max(baseBackoff, headerDelay);
          await resp.body?.cancel().catch(() => {});
          throw new Error(`Retryable HTTP ${resp.status}`);
        }
        return { resp, buf: null };
      }

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('mpegurl')) {
        return { resp, buf: null };
      }

      const isRangeResp =
        resp.status === 206 ||
        resp.headers.has('content-range') ||
        resp.headers.has('x-download-eof');

      if (isRangeResp) {
        const buf = await readResponseArrayBufferWithProgress(resp, onBytesRead);
        return { resp, buf };
      }

      return { resp, buf: null };
    } catch (err) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (!timedOut && err instanceof Error && err.name === 'AbortError') {
        throw err;
      }

      const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const isTransportDrop =
        browserOffline ||
        timedOut ||
        (err instanceof TypeError && /network|fetch|failed|load/i.test(err.message));

      if (waitIndefinitelyOffline && (browserOffline || (isTransportDrop && onlineAttempt >= maxOnlineRetries))) {
        // Connectivity outage (tunnel/airplane mode/cell switch/screen sleep): wait patiently for reconnect!
        isOfflineOutage = true;
        onWaitingChange?.(true);
        nextDelayOverride = browserOffline ? 12_000 : 8_000;
      } else if (!isWarmupPoll && onlineAttempt >= maxOnlineRetries) {
        if (timedOut) {
          throw new Error('Download request timed out after multiple retries');
        }
        throw err;
      }
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onParentAbort);
    }

    const baseDelay = nextDelayOverride ?? (RETRY_DELAYS_MS[onlineAttempt] ?? 10_000);
    const jitter = Math.floor(Math.random() * 250);
    if (!isWarmupPoll && !isOfflineOutage) {
      onlineAttempt += 1;
    }
    if (isOfflineOutage && typeof window !== 'undefined') {
      // Wait up to baseDelay OR immediately wake when 'online' event fires
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('online', onWake);
          signal.removeEventListener('abort', onAbort);
        };
        const onWake = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, baseDelay + jitter);
        window.addEventListener('online', onWake, { once: true });
        signal.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      await sleepWithSignal(baseDelay + jitter, signal);
    }
  }
}

function createDownloadJobId(): string {
  return `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildTranscodedDownloadUrl(
  item: QueueOfflineDownloadInput,
  quality: DownloadQuality,
  rawExt: string,
  jobId: string,
  durationSec = 0,
): string {
  const qs = new URLSearchParams({
    quality,
    ext: rawExt,
    job: jobId,
  });
  if (Number.isFinite(durationSec) && durationSec > 0) {
    qs.set('durationSec', String(Math.round(durationSec)));
  }
  return `/api/play/download/${item.kind === 'episode' ? 'series' : 'vod'}/${encodeURIComponent(
    item.id,
  )}?${qs.toString()}`;
}

function buildDirectFileDownloadUrl(
  item: QueueOfflineDownloadInput,
  quality: DownloadQuality,
  rawExt: string,
): string {
  const safeName = sanitizeNativeFileName(item.title, rawExt).replace(/\.[a-zA-Z0-9]+$/, '');
  return `/api/play/download-file/${item.kind === 'episode' ? 'series' : 'vod'}/${encodeURIComponent(
    item.id,
  )}?quality=${encodeURIComponent(quality)}&ext=${encodeURIComponent(rawExt)}&filename=${encodeURIComponent(safeName)}`;
}

function parseDurationStringSec(dur?: string): number {
  return parseDurationHintToSeconds(dur);
}

function isLikelyHtmlOrJsonPayload(buf: ArrayBuffer): boolean {
  if (!buf || buf.byteLength < 6) return false;
  const sample = new Uint8Array(buf, 0, Math.min(64, buf.byteLength));
  let idx = 0;
  while (idx < sample.length && (sample[idx] === 32 || sample[idx] === 9 || sample[idx] === 10 || sample[idx] === 13)) {
    idx += 1;
  }
  const first = sample[idx];
  if (first !== 60 && first !== 123) return false; // '<' or '{'
  const text = new TextDecoder().decode(sample.slice(idx)).toLowerCase();
  return (
    text.startsWith('<!doctype') ||
    text.startsWith('<html') ||
    text.startsWith('{"error"') ||
    text.startsWith('#extm3u')
  );
}

async function probeDownloadCodecCompatibility(
  item: QueueOfflineDownloadInput,
  rawExt: string,
  signal: AbortSignal,
): Promise<{ browserSafeDirect: boolean; durationSec: number; ranProbe: boolean }> {
  const isBrowserContainer = rawExt === 'mp4' || rawExt === 'm4v' || rawExt === 'webm';
  const probeCtrl = new AbortController();
  const onAbort = () => probeCtrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => probeCtrl.abort(), 5000);

  try {
    const resp = await fetch(
      `/api/play/probe/${item.kind === 'episode' ? 'series' : 'vod'}/${encodeURIComponent(
        item.id,
      )}?ext=${encodeURIComponent(rawExt)}`,
      { signal: probeCtrl.signal, cache: 'no-store' },
    );
    if (!resp.ok) {
      return { browserSafeDirect: false, durationSec: 0, ranProbe: true };
    }
    const data = (await resp.json().catch(() => null)) as {
      videoCodec?: string;
      pixFmt?: string;
      audioCodec?: string;
      durationSec?: number;
    } | null;
    if (!data) {
      return { browserSafeDirect: false, durationSec: 0, ranProbe: true };
    }
    const vCodec = (data.videoCodec || '').toLowerCase();
    const pixFmt = (data.pixFmt || '').toLowerCase();
    const aCodec = (data.audioCodec || '').toLowerCase();
    const safeVideo =
      vCodec === 'h264' ||
      vCodec === 'avc1' ||
      vCodec === 'vp8' ||
      vCodec === 'vp9' ||
      vCodec === 'av1';
    const isTenBit = pixFmt.includes('10');
    const safeAudio =
      aCodec === '' ||
      aCodec === 'aac' ||
      aCodec === 'mp3' ||
      aCodec === 'opus' ||
      aCodec === 'vorbis' ||
      aCodec === 'flac';
    return {
      browserSafeDirect: isBrowserContainer && safeVideo && !isTenBit && safeAudio,
      durationSec: Number(data.durationSec || 0) || 0,
      ranProbe: true,
    };
  } catch {
    return { browserSafeDirect: false, durationSec: 0, ranProbe: true };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function downloadSingleItem(item: InternalQueueEntry): Promise<void> {
  const key = `${item.kind}:${item.id}`;

  // Double-check database before transferring bytes so a downloaded item is never re-downloaded
  const alreadySaved = await getOfflineDownload(key).catch(() => null);
  if (alreadySaved) {
    await deletePendingDownloadTask(key).catch(() => {});
    removeTask(key);
    await refreshOfflineDownloads();
    return;
  }

  const controller = new AbortController();
  activeControllers.set(key, controller);
  const quality: DownloadQuality = item.quality || '720p';

  pauseActiveRemoteVideos();

  const rawExt = (item.extension || 'mp4').toLowerCase();
  const directFileUrl = item.resumeDirectUrl || buildDirectFileDownloadUrl(item, quality, rawExt);
  const existingTaskSnapshot = snapshot.tasks[key];
  const initialTotalBytes =
    item.resumeTotalBytes && item.resumeTotalBytes > 0
      ? item.resumeTotalBytes
      : item.expectedTotalBytes && item.expectedTotalBytes > 0
        ? item.expectedTotalBytes
        : existingTaskSnapshot?.totalBytes && existingTaskSnapshot.totalBytes > 0
          ? existingTaskSnapshot.totalBytes
          : 0;
  const initialIsEstimated =
    item.resumeTotalBytes && item.resumeTotalBytes > 0
      ? Boolean(item.resumeIsEstimatedTotal)
      : item.expectedTotalBytes && item.expectedTotalBytes > 0
        ? Boolean(item.isEstimatedTotal)
        : existingTaskSnapshot?.totalBytes && existingTaskSnapshot.totalBytes > 0
          ? Boolean(existingTaskSnapshot.isEstimatedTotal)
          : false;

  updateTask(key, {
    status: 'downloading',
    quality,
    receivedBytes: item.resumeOffset || 0,
    totalBytes: initialTotalBytes,
    isEstimatedTotal: initialIsEstimated,
    speedBytesPerSec: 0,
    percent:
      initialTotalBytes > 0 && item.resumeOffset
        ? Math.min(99, Math.round((item.resumeOffset / initialTotalBytes) * 100))
        : 0,
    waitingForNetwork: false,
    error: undefined,
    storageBackend: 'indexeddb',
  });

  // Skip slow upstream ffprobe wait unless 1080p browser-container (where direct Range bypasses transcoding).
  let detectedDurationSec = parseDurationStringSec(item.duration);
  let useDirectRangeStream = item.resumeMode === 'direct';

  if (
    !item.resumeMode &&
    quality === '1080p' &&
    (rawExt === 'mp4' || rawExt === 'm4v' || rawExt === 'webm')
  ) {
    const probe = await probeDownloadCodecCompatibility(item, rawExt, controller.signal);
    if (probe.durationSec > 0) {
      detectedDurationSec = probe.durationSec;
    }
    if (probe.browserSafeDirect) {
      useDirectRangeStream = true;
    }
  }

  let jobId = useDirectRangeStream ? '' : (item.resumeJobId || createDownloadJobId());
  if (jobId) {
    activeJobIds.set(key, jobId);
  } else {
    activeJobIds.delete(key);
  }
  let requestUrl = useDirectRangeStream
    ? directFileUrl
    : buildTranscodedDownloadUrl(item, quality, rawExt, jobId, detectedDurationSec);

  const pauseServerJob = () => {
    if (!jobId) return;
    void fetch(`/api/play/download/job/${encodeURIComponent(jobId)}/pause`, {
      method: 'POST',
      keepalive: true,
    }).catch(() => {});
  };

  const cancelServerJob = () => {
    if (!jobId) return;
    void fetch(`/api/play/download/job/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => {});
  };

  let ext = item.resumeExt || (useDirectRangeStream ? rawExt : 'mp4');
  let mimeType = item.resumeMimeType || inferMimeFromExtension(ext);
  let offset = item.resumeOffset || 0;
  let chunkIndex = item.resumeChunkIndex || 0;
  let receivedBytes = item.resumeOffset || 0;
  let totalBytes: number | null = initialTotalBytes > 0 ? initialTotalBytes : null;
  let isEstimatedTotal = initialIsEstimated;

  let lastCheckpointAt = 0;
  const persistCheckpoint = async (
    statusOverride?: 'downloading' | 'paused' | 'error',
    errorMsg?: string,
    forceImmediate = false,
  ) => {
    const now = Date.now();
    if (!forceImmediate && statusOverride === 'downloading' && now - lastCheckpointAt < 2000) {
      return;
    }
    lastCheckpointAt = now;
    await savePendingDownloadTask({
      key,
      input: toPersistedInput(item),
      quality,
      status: statusOverride || 'downloading',
      mode: useDirectRangeStream ? 'direct' : 'transcode',
      jobId: jobId || undefined,
      directUrl: directFileUrl,
      ext,
      mimeType,
      chunkCount: chunkIndex,
      receivedBytes,
      totalBytes: totalBytes || 0,
      isEstimatedTotal,
      nextOffset: offset,
      waitingForNetwork:
        statusOverride === 'paused' ? false : snapshot.tasks[key]?.waitingForNetwork,
      error: errorMsg,
      updatedAt: now,
    }).catch(() => {});
  };

  const pendingDbWrites = new Set<Promise<void>>();
  let dbWriteError: Error | null = null;

  const enqueueChunkWrite = async (targetChunkIndex: number, data: ArrayBuffer) => {
    if (dbWriteError) throw dbWriteError;
    while (pendingDbWrites.size >= 3) {
      await Promise.race(pendingDbWrites);
      if (dbWriteError) throw dbWriteError;
    }
    const writePromise = putOfflineChunk(key, targetChunkIndex, data)
      .catch((err) => {
        if (!dbWriteError) {
          dbWriteError = err instanceof Error ? err : new Error('Failed to store offline chunk');
        }
      })
      .finally(() => {
        pendingDbWrites.delete(writePromise);
      });
    pendingDbWrites.add(writePromise);
  };

  const flushPendingWrites = async () => {
    if (pendingDbWrites.size > 0) {
      await Promise.all(Array.from(pendingDbWrites));
    }
    if (dbWriteError) throw dbWriteError;
  };

  try {
    if (chunkIndex === 0 || offset === 0) {
      await deleteOfflineChunksForKey(key);
      notifySwClearMediaCache(key);
      offset = 0;
      chunkIndex = 0;
      receivedBytes = 0;
    }

    await persistCheckpoint('downloading', undefined, true);

    let sessionRestarts = 0;
    let switchedModeOnStartError = item.resumeMode === 'direct' && offset > 0;

    const sessionStartedAt = performance.now();
    const initialResumeBytes = receivedBytes;
    let liveStreamBytes = receivedBytes;
    let lastSpeedAt = performance.now();
    let lastSpeedBytes = receivedBytes;
    let lastTelemetryPushAt = 0;
    let emaSpeed = 0;
    let suppressTelemetryForSingleProbe = false;

    const measureSpeed = (nowBytes: number, force = false): number => {
      const now = performance.now();
      const elapsedSec = (now - lastSpeedAt) / 1000;
      if (force || elapsedSec >= 0.2) {
        const deltaBytes = Math.max(0, nowBytes - lastSpeedBytes);
        if (elapsedSec > 0.02) {
          const instant = deltaBytes / elapsedSec;
          emaSpeed = emaSpeed > 0 ? emaSpeed * 0.6 + instant * 0.4 : instant;
        }
        lastSpeedAt = now;
        lastSpeedBytes = nowBytes;
        const deltaFromStart = nowBytes - initialResumeBytes;
        if (
          !suppressTelemetryForSingleProbe &&
          emaSpeed > 0 &&
          deltaFromStart >= 256 * 1024 &&
          now - lastTelemetryPushAt >= 1000
        ) {
          lastTelemetryPushAt = now;
          recordMeasuredThroughput(snapshot.downloadProfile, emaSpeed);
        }
      }
      return Math.round(emaSpeed);
    };

    const pushStreamingUiProgress = (deltaBytes: number, totalOverride?: number | null) => {
      if (deltaBytes <= 0) return;
      liveStreamBytes += deltaBytes;
      const now = performance.now();
      if (now - lastSpeedAt < 200) return;
      const speed = measureSpeed(liveStreamBytes, false);
      const tBytes = totalOverride ?? totalBytes;
      const effectiveTotal = tBytes && tBytes > 0 ? Math.max(tBytes, liveStreamBytes) : 0;
      const pct =
        effectiveTotal > 0
          ? Math.min(99, Math.round((liveStreamBytes / effectiveTotal) * 100))
          : 0;
      const etaSeconds =
        speed > 0 && effectiveTotal > liveStreamBytes
          ? Math.max(1, Math.round((effectiveTotal - liveStreamBytes) / speed))
          : undefined;
      updateTask(key, {
        receivedBytes: liveStreamBytes,
        totalBytes: effectiveTotal,
        isEstimatedTotal,
        speedBytesPerSec: speed,
        etaSeconds,
        percent: pct,
        waitingForNetwork: false,
      });
    };

    const switchFallbackModeAtStart = (): boolean => {
      if (switchedModeOnStartError || offset !== 0 || controller.signal.aborted) {
        return false;
      }
      switchedModeOnStartError = true;
      if (useDirectRangeStream) {
        useDirectRangeStream = false;
        jobId = createDownloadJobId();
        activeJobIds.set(key, jobId);
        requestUrl = buildTranscodedDownloadUrl(item, quality, rawExt, jobId, detectedDurationSec);
        ext = 'mp4';
        mimeType = 'video/mp4';
      } else {
        cancelServerJob();
        jobId = '';
        activeJobIds.delete(key);
        useDirectRangeStream = true;
        requestUrl = directFileUrl;
        ext = rawExt;
        mimeType = inferMimeFromExtension(rawExt);
      }
      return true;
    };

    while (true) {
      if (controller.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // High-speed Parallel HTTP Range Engine when direct stream size is known and Turbo mode is enabled
      if (
        useDirectRangeStream &&
        totalBytes &&
        !isEstimatedTotal &&
        offset < totalBytes &&
        isTurboProfile()
      ) {
        const sliceSize = getChunkSizeForProfile();
        const slices: Array<{ chunkIndex: number; start: number; end: number }> = [];
        let cursor = offset;
        let nextIdx = chunkIndex;
        while (cursor < totalBytes) {
          const endByte = Math.min(totalBytes - 1, cursor + sliceSize - 1);
          slices.push({ chunkIndex: nextIdx++, start: cursor, end: endByte });
          cursor = endByte + 1;
        }

        if (slices.length > 1) {
          let queueCursor = 0;
          let maxWorkers = Math.min(TURBO_DIRECT_WORKERS, slices.length);
          let activeWorkers = 0;
          let fatalError: unknown = null;
          let completedAll = false;

          const fetchSingleSliceComplete = async (slice: {
            chunkIndex: number;
            start: number;
            end: number;
          }): Promise<ArrayBuffer> => {
            const expectedLen = slice.end - slice.start + 1;
            let partStart = slice.start;
            const collected: Uint8Array[] = [];
            let collectedLen = 0;

            while (partStart <= slice.end) {
              const partResult = await fetchRangeChunkWithRetry(
                requestUrl,
                { Range: `bytes=${partStart}-${slice.end}` },
                controller.signal,
                {
                  maxOnlineRetries: RETRY_DELAYS_MS.length,
                  waitIndefinitelyOffline: true,
                  onBytesRead: (delta) => pushStreamingUiProgress(delta, totalBytes),
                  onWaitingChange: (waiting) => {
                    updateTask(key, {
                      waitingForNetwork: waiting,
                      speedBytesPerSec: waiting ? 0 : snapshot.tasks[key]?.speedBytesPerSec || 0,
                    });
                  },
                },
              );
              const { resp: pResp, buf: pBuf } = partResult;
              if (pResp.status === 429 || pResp.status === 503 || pResp.status === 403) {
                maxWorkers = Math.max(1, Math.floor(maxWorkers / 2));
              }
              if (!pResp.ok || !pBuf || pBuf.byteLength === 0) {
                await pResp.body?.cancel().catch(() => {});
                throw new Error(`Range slice failed (HTTP ${pResp.status})`);
              }
              collected.push(new Uint8Array(pBuf));
              collectedLen += pBuf.byteLength;
              partStart += pBuf.byteLength;
              if (collectedLen >= expectedLen) break;
            }

            if (collected.length === 1 && collected[0].byteLength === expectedLen) {
              return collected[0].buffer as ArrayBuffer;
            }
            const merged = new Uint8Array(collectedLen);
            let pos = 0;
            for (const c of collected) {
              merged.set(c, pos);
              pos += c.byteLength;
            }
            return merged.buffer;
          };

          await new Promise<void>((resolve, reject) => {
            const launchMore = () => {
              if (fatalError || completedAll) return;
              if (!isTurboProfile()) {
                maxWorkers = 1;
              }
              while (activeWorkers < maxWorkers && queueCursor < slices.length) {
                const slice = slices[queueCursor++];
                activeWorkers += 1;
                void fetchSingleSliceComplete(slice)
                  .then(async (buf) => {
                    await enqueueChunkWrite(slice.chunkIndex, buf);
                    receivedBytes += buf.byteLength;
                    if (slice.end + 1 > offset) {
                      offset = slice.end + 1;
                    }
                    if (slice.chunkIndex + 1 > chunkIndex) {
                      chunkIndex = slice.chunkIndex + 1;
                    }
                    void persistCheckpoint('downloading');
                  })
                  .catch((err) => {
                    if (!fatalError) {
                      fatalError = err;
                      controller.abort();
                    }
                  })
                  .finally(() => {
                    activeWorkers -= 1;
                    if (fatalError) {
                      if (activeWorkers === 0) reject(fatalError);
                      return;
                    }
                    if (queueCursor >= slices.length && activeWorkers === 0) {
                      completedAll = true;
                      resolve();
                      return;
                    }
                    launchMore();
                  });
              }
            };
            launchMore();
          });

          await flushPendingWrites();
          receivedBytes = liveStreamBytes = totalBytes;
          chunkIndex = nextIdx;
          offset = totalBytes;
          break;
        }
      }

      const isDiscoveringBaselineForTurbo =
        isTurboProfile() &&
        useDirectRangeStream &&
        offset === 0 &&
        !totalBytes &&
        speedTelemetry.standardBytesPerSec === 0;
      suppressTelemetryForSingleProbe = isDiscoveringBaselineForTurbo;

      const activeChunkSize = isDiscoveringBaselineForTurbo
        ? STANDARD_CHUNK_SIZE_BYTES
        : useDirectRangeStream
          ? getChunkSizeForProfile()
          : isTurboProfile()
            ? TURBO_TRANSCODE_CHUNK_BYTES
            : STANDARD_CHUNK_SIZE_BYTES;
      const rangeEnd = offset + activeChunkSize - 1;
      const profileParam = isTurboProfile() ? 'turbo' : 'standard';
      const chunkFetchUrl = useDirectRangeStream
        ? requestUrl
        : `${requestUrl}&offset=${offset}&len=${activeChunkSize}&profile=${profileParam}`;
      const fastFallbackRetries =
        !switchedModeOnStartError && offset === 0 ? 3 : RETRY_DELAYS_MS.length;

      const chunkAttemptStartedAt = performance.now();
      let result: RangeChunkResult;

      try {
        result = await fetchRangeChunkWithRetry(
          chunkFetchUrl,
          {
            Range: `bytes=${offset}-${rangeEnd}`,
          },
          controller.signal,
          {
            maxOnlineRetries: fastFallbackRetries,
            waitIndefinitelyOffline: offset > 0 || switchedModeOnStartError,
            onBytesRead: (delta) => pushStreamingUiProgress(delta),
            onWaitingChange: (waiting) => {
              updateTask(key, {
                waitingForNetwork: waiting,
                speedBytesPerSec: waiting ? 0 : snapshot.tasks[key]?.speedBytesPerSec || 0,
              });
            },
          },
        );
      } catch (err) {
        if (switchFallbackModeAtStart()) {
          continue;
        }
        throw err;
      }

      const { resp, buf } = result;

      // Recover gracefully if server job expired (HTTP 410) after long shutdown
      if (resp.status === 410 && !useDirectRangeStream && sessionRestarts < 2) {
        await resp.body?.cancel().catch(() => {});
        await flushPendingWrites();
        sessionRestarts += 1;
        await deleteOfflineChunksForKey(key);
        offset = 0;
        chunkIndex = 0;
        receivedBytes = 0;
        liveStreamBytes = 0;
        totalBytes = item.expectedTotalBytes && item.expectedTotalBytes > 0 ? item.expectedTotalBytes : null;
        isEstimatedTotal = totalBytes ? Boolean(item.isEstimatedTotal) : false;
        jobId = createDownloadJobId();
        activeJobIds.set(key, jobId);
        requestUrl = buildTranscodedDownloadUrl(item, quality, rawExt, jobId, detectedDurationSec);
        await persistCheckpoint('downloading', undefined, true);
        updateTask(key, {
          receivedBytes: 0,
          totalBytes: totalBytes || 0,
          isEstimatedTotal,
          speedBytesPerSec: 0,
          percent: 0,
          waitingForNetwork: false,
        });
        continue;
      }

      // If resuming near EOF returned 416 Range Not Satisfiable when we already have bytes, treat as EOF
      if (resp.status === 416 && useDirectRangeStream && offset > 0 && chunkIndex > 0) {
        await resp.body?.cancel().catch(() => {});
        break;
      }

      if (!resp.ok) {
        if (switchFallbackModeAtStart()) {
          await resp.body?.cancel().catch(() => {});
          continue;
        }
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(
          typeof errBody?.error === 'string'
            ? errBody.error
            : `Download failed with HTTP ${resp.status}`,
        );
      }

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('mpegurl') || contentType.includes('text/html') || contentType.includes('application/json')) {
        if (useDirectRangeStream && switchFallbackModeAtStart()) {
          await resp.body?.cancel().catch(() => {});
          continue;
        }
        await resp.body?.cancel().catch(() => {});
        throw new Error(
          contentType.includes('mpegurl')
            ? 'HLS (.m3u8) adaptive playlists cannot be saved directly for offline playback.'
            : 'Upstream returned an error document instead of video data.',
        );
      }
      if (contentType && contentType !== 'application/octet-stream') {
        mimeType = contentType.split(';')[0].trim();
        if (mimeType === 'video/mp4') ext = 'mp4';
      }

      const contentRange = parseContentRangeTotal(resp.headers.get('content-range'));
      const eofHeader = resp.headers.get('x-download-eof');
      const directTotalHeader = Number(resp.headers.get('x-direct-total-bytes') || 0);
      const estHeader = Number(resp.headers.get('x-estimated-total-bytes') || 0);
      const durationHeader = Number(resp.headers.get('x-media-duration-sec') || 0);
      if (Number.isFinite(durationHeader) && durationHeader > 0) {
        detectedDurationSec = durationHeader;
      }
      if (Number.isFinite(directTotalHeader) && directTotalHeader > 0) {
        totalBytes = directTotalHeader;
        isEstimatedTotal = false;
      } else if ((!totalBytes || isEstimatedTotal) && Number.isFinite(estHeader) && estHeader > 0) {
        totalBytes = estHeader;
        isEstimatedTotal = true;
      }

      if (buf !== null) {
        if (buf.byteLength === 0) {
          break;
        }
        if (chunkIndex === 0 && isLikelyHtmlOrJsonPayload(buf)) {
          if (useDirectRangeStream && switchFallbackModeAtStart()) {
            continue;
          }
          throw new Error('Provider returned an invalid error response instead of video data.');
        }

        if (contentRange?.total) {
          totalBytes = contentRange.total;
          isEstimatedTotal = false;
        }

        if (isDiscoveringBaselineForTurbo && buf.byteLength >= 256 * 1024) {
          const singleElapsedSec = Math.max(0.05, (performance.now() - chunkAttemptStartedAt) / 1000);
          recordMeasuredThroughput('free', buf.byteLength / singleElapsedSec);
        }
        suppressTelemetryForSingleProbe = false;

        await enqueueChunkWrite(chunkIndex, buf);
        chunkIndex += 1;
        receivedBytes += buf.byteLength;
        liveStreamBytes = Math.max(liveStreamBytes, receivedBytes);
        offset = (contentRange ? contentRange.end : offset + buf.byteLength - 1) + 1;

        void persistCheckpoint('downloading');

        const speed = measureSpeed(receivedBytes, true);
        const effectiveTotal =
          totalBytes && totalBytes > 0 ? Math.max(totalBytes, receivedBytes) : 0;
        const pct =
          eofHeader === '1'
            ? 99
            : effectiveTotal > 0
              ? Math.min(99, Math.round((receivedBytes / effectiveTotal) * 100))
              : 0;
        const etaSeconds =
          speed > 0 && effectiveTotal > receivedBytes
            ? Math.max(1, Math.round((effectiveTotal - receivedBytes) / speed))
            : undefined;
        updateTask(key, {
          receivedBytes,
          totalBytes: effectiveTotal,
          isEstimatedTotal,
          speedBytesPerSec: speed,
          etaSeconds,
          percent: pct,
          waitingForNetwork: false,
        });

        if (eofHeader === '1') {
          break;
        }
        if (eofHeader === '0') {
          continue;
        }

        if (totalBytes && !isEstimatedTotal && offset >= totalBytes) {
          break;
        }
        if (useDirectRangeStream && !totalBytes && buf.byteLength === 0) {
          break;
        }
      } else {
        suppressTelemetryForSingleProbe = false;
        // Fallback non-range 200 OK stream: buffer in profile-sized chunks to IndexedDB
        const lenHeader = Number(resp.headers.get('content-length') || 0);
        if (Number.isFinite(lenHeader) && lenHeader > 0) {
          totalBytes = lenHeader;
          isEstimatedTotal = false;
        }

        if (!resp.body) {
          const fullBuf = await resp.arrayBuffer();
          await enqueueChunkWrite(0, fullBuf);
          chunkIndex = 1;
          receivedBytes = fullBuf.byteLength;
          offset = receivedBytes;
          await persistCheckpoint('downloading', undefined, true);
          break;
        }

        const reader = resp.body.getReader();
        let pendingParts: Uint8Array[] = [];
        let pendingLen = 0;

        const flushPending = async () => {
          if (pendingLen === 0) return;
          const merged = new Uint8Array(pendingLen);
          let pos = 0;
          for (const part of pendingParts) {
            merged.set(part, pos);
            pos += part.byteLength;
          }
          pendingParts = [];
          pendingLen = 0;
          await enqueueChunkWrite(chunkIndex, merged.buffer);
          chunkIndex += 1;
          offset += merged.byteLength;
          void persistCheckpoint('downloading');
        };

        let lastUiPush = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          pendingParts.push(value);
          pendingLen += value.byteLength;
          receivedBytes += value.byteLength;

          if (pendingLen >= getChunkSizeForProfile()) {
            await flushPending();
          }

          const now = performance.now();
          if (now - lastUiPush >= 200) {
            lastUiPush = now;
            const speed = measureSpeed(receivedBytes, false);
            const effectiveTotal =
              totalBytes && totalBytes > 0
                ? Math.max(totalBytes, receivedBytes)
                : 0;
            const pct =
              effectiveTotal > 0
                ? Math.min(99, Math.round((receivedBytes / effectiveTotal) * 100))
                : 0;
            updateTask(key, {
              receivedBytes,
              totalBytes: effectiveTotal,
              isEstimatedTotal,
              speedBytesPerSec: speed,
              percent: pct,
              waitingForNetwork: false,
            });
          }
        }

        await flushPending();
        const finalSpeed = measureSpeed(receivedBytes, true);
        updateTask(key, {
          receivedBytes,
          totalBytes: receivedBytes,
          isEstimatedTotal: false,
          speedBytesPerSec: finalSpeed,
          percent: 99,
          waitingForNetwork: false,
        });
        break;
      }
    }

    await flushPendingWrites();

    const totalElapsedSec = (performance.now() - sessionStartedAt) / 1000;
    const netDownloadedBytes = receivedBytes - initialResumeBytes;
    if (totalElapsedSec >= 0.8 && netDownloadedBytes >= 256 * 1024) {
      recordMeasuredThroughput(
        snapshot.downloadProfile,
        Math.round(netDownloadedBytes / totalElapsedSec),
      );
    }

    if (receivedBytes <= 0 || chunkIndex === 0) {
      throw new Error('No video bytes received from server');
    }

    await finalizeOfflineDownloadRecord({
      key,
      item,
      quality,
      ext,
      mimeType,
      sizeBytes: receivedBytes,
      chunkCount: chunkIndex,
      durationSec: detectedDurationSec,
      storageBackend: 'indexeddb',
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (pauseRequestedKeys.has(key)) {
        pauseRequestedKeys.delete(key);
        pauseServerJob();
        await flushPendingWrites().catch(() => {});
        const savedProg = await getStoredChunkProgress(key).catch(() => ({
          contiguousCount: chunkIndex,
          totalBytes: receivedBytes,
        }));
        chunkIndex = savedProg.contiguousCount;
        offset = savedProg.totalBytes;
        receivedBytes = savedProg.totalBytes;
        await persistCheckpoint('paused', undefined, true);
        updateTask(key, {
          status: 'paused',
          receivedBytes,
          speedBytesPerSec: 0,
          waitingForNetwork: false,
          error: undefined,
        });
        return;
      }
      if (isPageUnloading) {
        pauseServerJob();
        return;
      }
      cancelServerJob();
      await deleteOfflineChunksForKey(key).catch(() => {});
      notifySwClearMediaCache(key);
      await deletePendingDownloadTask(key).catch(() => {});
      removeTask(key);
      return;
    }

    const errMsg = err instanceof Error ? err.message : 'Download failed';
    // Pause server job cleanly & preserve downloaded chunks on BOTH direct and transcode modes
    pauseServerJob();
    await flushPendingWrites().catch(() => {});
    const savedProg = await getStoredChunkProgress(key).catch(() => ({
      contiguousCount: chunkIndex,
      totalBytes: receivedBytes,
    }));
    chunkIndex = savedProg.contiguousCount;
    offset = savedProg.totalBytes;
    receivedBytes = savedProg.totalBytes;
    await persistCheckpoint('error', errMsg, true);
    updateTask(key, {
      status: 'error',
      receivedBytes,
      speedBytesPerSec: 0,
      waitingForNetwork: false,
      error: errMsg,
    });
  } finally {
    activeControllers.delete(key);
    activeJobIds.delete(key);
    pauseRequestedKeys.delete(key);
  }
}

async function runWorkerLoop() {
  activeWorkerCount += 1;
  startSwKeepaliveIfNeeded();
  try {
    while (queue.length > 0 && activeWorkerCount <= getMaxConcurrentTasks()) {
      const nextItem = queue.shift();
      if (!nextItem) continue;
      const key = `${nextItem.kind}:${nextItem.id}`;
      if (!snapshot.tasks[key] || snapshot.tasks[key].status !== 'queued') {
        continue;
      }
      await downloadSingleItem(nextItem);
    }
  } finally {
    activeWorkerCount = Math.max(0, activeWorkerCount - 1);
  }
}

async function processQueue() {
  const targetWorkers = getMaxConcurrentTasks();
  while (queue.length > 0 && activeWorkerCount < targetWorkers) {
    void runWorkerLoop();
  }
}

export function queueOfflineDownload(input: QueueOfflineDownloadInput): void {
  ensureInitialized();
  if (!isIndexedDbAvailable()) return;

  const key = `${input.kind}:${input.id}`;
  const quality: DownloadQuality = input.quality || '720p';

  // Strictly block re-downloading any movie or episode already downloaded
  const existingDownload = snapshot.downloads.find((d) => d.key === key);
  if (existingDownload) {
    return;
  }

  const existingTask = snapshot.tasks[key];
  if (
    existingTask &&
    (existingTask.status === 'queued' ||
      existingTask.status === 'downloading' ||
      existingTask.status === 'saving')
  ) {
    return;
  }

  if (existingTask && (existingTask.status === 'paused' || existingTask.status === 'error')) {
    void resumeOfflineDownload(key);
    return;
  }

  const seededTotalBytes =
    input.expectedTotalBytes && Number.isFinite(input.expectedTotalBytes) && input.expectedTotalBytes > 0
      ? Math.round(input.expectedTotalBytes)
      : 0;
  const seededIsEstimated = seededTotalBytes > 0 ? Boolean(input.isEstimatedTotal) : false;

  snapshot = {
    ...snapshot,
    tasks: {
      ...snapshot.tasks,
      [key]: {
        key,
        id: input.id,
        title: input.title,
        subtitle: input.subtitle,
        kind: input.kind,
        seriesId: input.seriesId,
        seriesTitle: input.seriesTitle,
        seasonNum: input.seasonNum,
        episodeNum: input.episodeNum,
        categoryName: input.categoryName,
        year: input.year,
        poster: input.poster,
        quality,
        status: 'queued',
        receivedBytes: 0,
        totalBytes: seededTotalBytes,
        isEstimatedTotal: seededIsEstimated,
        speedBytesPerSec: 0,
        percent: 0,
        waitingForNetwork: typeof navigator !== 'undefined' && navigator.onLine === false,
      },
    },
  };
  emitChange();

  const rawExt = (input.extension || 'mp4').toLowerCase();

  void savePendingDownloadTask({
    key,
    input: toPersistedInput({ ...input, quality }),
    quality,
    status: 'queued',
    mode: 'transcode',
    directUrl: buildDirectFileDownloadUrl(input, quality, rawExt),
    ext: rawExt,
    mimeType: inferMimeFromExtension(rawExt),
    chunkCount: 0,
    receivedBytes: 0,
    totalBytes: seededTotalBytes,
    isEstimatedTotal: seededIsEstimated,
    nextOffset: 0,
    updatedAt: Date.now(),
  }).catch(() => {});

  if (seededTotalBytes <= 0) {
    const durationHintSec = parseDurationHintToSeconds(input.duration);
    void fetchDownloadSizes({
      kind: input.kind,
      id: input.id,
      ext: rawExt,
      durationSec: durationHintSec > 0 ? durationHintSec : undefined,
      quick: true,
    })
      .then((res) => {
        const sizeInfo =
          quality !== 'auto'
            ? res?.sizes?.[quality as keyof typeof res.sizes]
            : undefined;
        if (!sizeInfo || !sizeInfo.bytes || sizeInfo.bytes <= 0) return;
        const current = snapshot.tasks[key];
        if (!current || (current.totalBytes && current.totalBytes > 0 && !current.isEstimatedTotal)) {
          return;
        }
        if (!current.totalBytes || current.totalBytes <= 0) {
          updateTask(key, {
            totalBytes: sizeInfo.bytes,
            isEstimatedTotal: !sizeInfo.exact,
          });
          void getPendingDownloadTask(key)
            .then((pending) => {
              if (!pending || pending.totalBytes > 0) return;
              return savePendingDownloadTask({
                ...pending,
                totalBytes: sizeInfo.bytes,
                isEstimatedTotal: !sizeInfo.exact,
              });
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  queue.push({ ...input, quality, expectedTotalBytes: seededTotalBytes, isEstimatedTotal: seededIsEstimated });
  void processQueue();
}

export function pauseOfflineDownload(key: string): void {
  ensureInitialized();
  const idx = queue.findIndex((item) => `${item.kind}:${item.id}` === key);
  if (idx >= 0) {
    queue.splice(idx, 1);
  }

  const ctrl = activeControllers.get(key);
  if (ctrl) {
    pauseRequestedKeys.add(key);
    ctrl.abort();
    return;
  }

  const task = snapshot.tasks[key];
  if (!task || task.status === 'paused' || task.status === 'saving') return;

  updateTask(key, {
    status: 'paused',
    speedBytesPerSec: 0,
    waitingForNetwork: false,
    error: undefined,
  });

  void getPendingDownloadTask(key)
    .then((pending) => {
      if (!pending) return;
      return savePendingDownloadTask({
        ...pending,
        status: 'paused',
        waitingForNetwork: false,
        error: undefined,
        updatedAt: Date.now(),
      });
    })
    .catch(() => {});
}

export function pauseAllOfflineDownloads(): void {
  for (const task of Object.values(snapshot.tasks)) {
    if (task.status === 'downloading' || task.status === 'queued') {
      pauseOfflineDownload(task.key);
    }
  }
}

export async function resumeOfflineDownload(key: string): Promise<void> {
  ensureInitialized();
  pauseRequestedKeys.delete(key);

  const existingDownload = snapshot.downloads.find((d) => d.key === key);
  if (existingDownload) {
    removeTask(key);
    await deletePendingDownloadTask(key).catch(() => {});
    return;
  }

  const pending = await getPendingDownloadTask(key).catch(() => null);
  if (!pending) return;
  if (activeControllers.has(key)) return;
  if (queue.some((q) => `${q.kind}:${q.id}` === key)) return;

  const chunkProg = await getStoredChunkProgress(key).catch(() => ({
    contiguousCount: 0,
    totalBytes: 0,
  }));
  const canByteResume =
    (pending.mode === 'direct' || pending.mode === 'transcode') && chunkProg.contiguousCount > 0;
  const resumeOffset = canByteResume ? chunkProg.totalBytes : 0;
  const resumeChunks = canByteResume ? chunkProg.contiguousCount : 0;

  if (!canByteResume && chunkProg.contiguousCount > 0) {
    await deleteOfflineChunksForKey(key).catch(() => {});
  }

  await savePendingDownloadTask({
    ...pending,
    status: 'queued',
    error: undefined,
    waitingForNetwork: typeof navigator !== 'undefined' && navigator.onLine === false,
    updatedAt: Date.now(),
  }).catch(() => {});

  updateTask(key, {
    status: 'queued',
    error: undefined,
    waitingForNetwork: typeof navigator !== 'undefined' && navigator.onLine === false,
    receivedBytes: resumeOffset,
    percent:
      pending.totalBytes > 0 && resumeOffset > 0
        ? Math.min(99, Math.round((resumeOffset / pending.totalBytes) * 100))
        : 0,
  });

  queue.push({
    ...pending.input,
    quality: pending.quality,
    resumeChunkIndex: resumeChunks,
    resumeOffset,
    resumeTotalBytes: pending.totalBytes,
    resumeIsEstimatedTotal: pending.isEstimatedTotal,
    resumeDirectUrl: pending.directUrl,
    resumeExt: pending.ext,
    resumeMimeType: pending.mimeType,
    resumeMode:
      pending.mode === 'direct'
        ? 'direct'
        : pending.mode === 'transcode'
          ? 'transcode'
          : undefined,
    resumeJobId: pending.jobId,
  });
  void processQueue();
}

export function resumeAllOfflineDownloads(): void {
  for (const task of Object.values(snapshot.tasks)) {
    if (task.status === 'paused' || task.status === 'error') {
      void resumeOfflineDownload(task.key);
    }
  }
}

export function cancelOfflineDownload(key: string): void {
  pauseRequestedKeys.delete(key);
  const idx = queue.findIndex((item) => `${item.kind}:${item.id}` === key);
  if (idx >= 0) {
    queue.splice(idx, 1);
  }
  const activeJobId = activeJobIds.get(key);
  if (activeJobId) {
    activeJobIds.delete(key);
    void fetch(`/api/play/download/job/${encodeURIComponent(activeJobId)}`, {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => {});
  } else {
    void getPendingDownloadTask(key)
      .then((pending) => {
        if (pending?.jobId) {
          void fetch(`/api/play/download/job/${encodeURIComponent(pending.jobId)}`, {
            method: 'DELETE',
            keepalive: true,
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }
  const ctrl = activeControllers.get(key);
  if (ctrl) {
    ctrl.abort();
  }
  removeTask(key);
  void deleteOfflineChunksForKey(key);
  void deletePendingDownloadTask(key);
}

export async function removeOfflineDownload(key: string): Promise<void> {
  cancelOfflineDownload(key);
  await deleteOfflineDownload(key);
  notifySwClearMediaCache(key);
  await refreshOfflineDownloads();
}

export async function clearOfflineDownloads(): Promise<void> {
  for (const key of Object.keys(snapshot.tasks)) {
    cancelOfflineDownload(key);
  }
  await clearAllOfflineDownloads();
  notifySwClearMediaCache();
  await refreshOfflineDownloads();
}

export async function setDownloadProfileMode(profile: DownloadProfileMode): Promise<void> {
  const current = loadAppSettings();
  saveAppSettings({ ...current, downloadProfile: profile });
  updateSnapshot({ downloadProfile: profile });
  if (activeWorkerCount === 0 && queue.length > 0) {
    void processQueue();
  }
}

function patchEntryInSnapshot(key: string, patch: Partial<OfflineDownloadEntry>): void {
  snapshot = {
    ...snapshot,
    downloads: snapshot.downloads.map((d) => (d.key === key ? { ...d, ...patch } : d)),
  };
  emitChange();
}

/**
 * Stage 2 ("Transfer to Local Storage"):
 * Exports an already-downloaded private offline media file into Android MediaStore
 * (Movies/Cinebox/ or Downloads/Cinebox/) WITHOUT re-downloading or transcoding.
 * Preserves Stage 1 private offline file intact on success and on failure.
 */
export async function transferDownloadToLocalStorage(
  key: string,
  destination: 'movies' | 'downloads' = 'movies',
): Promise<void> {
  const entry = snapshot.downloads.find((d) => d.key === key) || (await getOfflineDownload(key));
  if (!entry) {
    throw new Error('Offline download item not found.');
  }
  if (entry.transferStatus === 'transferring') return;

  const safeName = sanitizeNativeFileName(entry.title, entry.extension || 'mp4');
  patchEntryInSnapshot(key, {
    transferStatus: 'transferring',
    transferProgress: 5,
    transferError: undefined,
  });
  await patchOfflineDownloadEntry(key, {
    transferStatus: 'transferring',
    transferProgress: 5,
    transferError: undefined,
  }).catch(() => {});

  // Pure JavaScript Local Storage Export strictly from IndexedDB chunks (ZERO network fetch, NO native plugin)
  let fallbackObjectUrlToRevoke: string | null = null;
  try {
    const local = await createOfflinePlaybackUrl(key);
    if (local.posterUrl?.startsWith('blob:')) URL.revokeObjectURL(local.posterUrl);
    if (local.url.startsWith('blob:')) fallbackObjectUrlToRevoke = local.url;
    const sourceUrl = local.url;

    if ('showSaveFilePicker' in window) {
      const resp = await fetch(sourceUrl);
      if (!resp.ok || !resp.body) {
        throw new Error('Unable to read local offline media buffer');
      }
      const savePicker = (
        window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName: string;
          }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>;
        }
      ).showSaveFilePicker;
      const handle = await savePicker({ suggestedName: safeName });
      const writable = await handle.createWritable();
      await resp.body.pipeTo(writable);
    } else {
      const a = document.createElement('a');
      a.href = sourceUrl;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    const okPatch: Partial<OfflineDownloadEntry> = {
      transferStatus: 'exported',
      transferProgress: 100,
      exportedPath: `${destination === 'movies' ? 'Movies' : 'Downloads'}/${safeName}`,
      exportedAt: Date.now(),
      transferError: undefined,
    };
    await patchOfflineDownloadEntry(key, okPatch);
    patchEntryInSnapshot(key, okPatch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to export offline file';
    const failPatch: Partial<OfflineDownloadEntry> = {
      transferStatus: 'transfer_failed',
      transferProgress: 0,
      transferError: msg,
    };
    await patchOfflineDownloadEntry(key, failPatch).catch(() => {});
    patchEntryInSnapshot(key, failPatch);
    throw err;
  } finally {
    if (fallbackObjectUrlToRevoke) {
      const u = fallbackObjectUrlToRevoke;
      setTimeout(() => URL.revokeObjectURL(u), 20_000);
    }
  }
}

export async function deleteExportedDownloadCopy(key: string): Promise<void> {
  const entry = snapshot.downloads.find((d) => d.key === key) || (await getOfflineDownload(key));
  if (!entry) return;
  const resetPatch: Partial<OfflineDownloadEntry> = {
    transferStatus: 'not_exported',
    transferProgress: 0,
    exportedUri: undefined,
    exportedPath: undefined,
    exportedAt: undefined,
    transferError: undefined,
  };
  await patchOfflineDownloadEntry(key, resetPatch).catch(() => {});
  patchEntryInSnapshot(key, resetPatch);
}

function subscribe(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): OfflineSnapshot {
  return snapshot;
}

export function useOfflineDownloads() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    downloads: state.downloads,
    tasks: state.tasks,
    usedStorageBytes: state.usedStorageBytes,
    browserUsageBytes: state.browserUsageBytes,
    quotaBytes: state.quotaBytes,
    downloadProfile: state.downloadProfile,
    speedComparison: state.speedComparison,
    ready: state.ready,
    queueDownload: queueOfflineDownload,
    pauseDownload: pauseOfflineDownload,
    pauseAllDownloads: pauseAllOfflineDownloads,
    resumeDownload: resumeOfflineDownload,
    resumeAllDownloads: resumeAllOfflineDownloads,
    cancelDownload: cancelOfflineDownload,
    removeDownload: removeOfflineDownload,
    clearDownloads: clearOfflineDownloads,
    transferDownload: transferDownloadToLocalStorage,
    deleteExportedCopy: deleteExportedDownloadCopy,
    setDownloadProfile: setDownloadProfileMode,
    refreshDownloads: refreshOfflineDownloads,
  };
}
