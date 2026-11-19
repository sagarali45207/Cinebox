import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import {
  NativeDownloader,
  isAndroidPlatform,
  isNativeDownloaderAvailable,
  toWebViewPlayableUrl,
} from './NativeDownloader';

export {
  NativeDownloader,
  isAndroidPlatform,
  isNativeDownloaderAvailable,
  toWebViewPlayableUrl,
};

export interface NativeDownloadStartOptions {
  taskId: string;
  url: string;
  fileName: string;
  title: string;
  subtitle?: string;
  mimeType?: string;
  headers?: Record<string, string>;
  saveToPublicDownloads?: boolean;
}

export interface NativeDownloadStartResult {
  taskId: string;
  downloadId?: number;
  filePath?: string;
}

export interface NativeDownloadProgressEvent {
  taskId: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  speedBytesPerSec?: number;
  waitingForNetwork?: boolean;
}

export interface NativeDownloadStateEvent {
  taskId: string;
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  receivedBytes?: number;
  totalBytes?: number;
  filePath?: string;
  waitingForNetwork?: boolean;
  error?: string;
}

export interface NativeDownloadEntryInfo {
  taskId: string;
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

export interface CineBoxDownloaderPlugin {
  startDownload(options: NativeDownloadStartOptions): Promise<NativeDownloadStartResult>;
  cancelDownload(options: { taskId: string }): Promise<void>;
  getStatus(options: { taskId: string }): Promise<NativeDownloadStateEvent>;
  listActiveTasks(): Promise<{ tasks: NativeDownloadStateEvent[] }>;
  listDownloads(): Promise<{ downloads: NativeDownloadEntryInfo[] }>;
  deleteFile(options: { filePath: string }): Promise<void>;
  getPlayableUrl(options: { filePath: string }): Promise<{ url: string }>;
  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (event: NativeDownloadProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'downloadStateChange',
    listenerFunc: (event: NativeDownloadStateEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export const CineBoxDownloader = registerPlugin<CineBoxDownloaderPlugin>('CineBoxDownloader');

export interface AndroidWebViewDownloadBridge {
  startDownload?: (url: string, fileName: string, title?: string, mimeType?: string) => boolean | void;
  download?: (url: string, fileName: string, title?: string) => boolean | void;
}

declare global {
  interface Window {
    CineBoxAndroid?: AndroidWebViewDownloadBridge;
    AndroidDownloader?: AndroidWebViewDownloadBridge;
  }
}

export type NativeDownloaderBackend =
  | 'capacitor-native'
  | 'capacitor-filesystem'
  | 'webview-bridge'
  | 'web';

export function getNativeDownloaderBackend(): NativeDownloaderBackend {
  return 'web';
}

export function isCapacitorNativeRuntime(): boolean {
  return false;
}

export function isCineBoxNativePluginAvailable(): boolean {
  return false;
}

export function buildAbsoluteMediaUrl(urlOrPath: string): string {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  if (typeof window !== 'undefined' && window.location?.origin && !window.location.origin.startsWith('capacitor://')) {
    return new URL(urlOrPath, window.location.origin).href;
  }
  return urlOrPath;
}

export function resolveNativePlayableUrl(localFileUri: string): string {
  if (!localFileUri) return '';
  return toWebViewPlayableUrl(localFileUri);
}

export function sanitizeNativeFileName(title: string, ext = 'mp4'): string {
  const cleanTitle = (title || 'cinebox-video')
    .replace(/[^a-zA-Z0-9._ -]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72) || 'cinebox_video';
  const cleanExt = (ext || 'mp4').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'mp4';
  return `${cleanExt ? `${cleanTitle}.${cleanExt}` : cleanTitle}`;
}

export function triggerAndroidWebViewBridgeDownload(_params: {
  url: string;
  fileName: string;
  title: string;
  mimeType: string;
}): boolean {
  return false;
}

export async function deleteNativeMediaFile(
  localFileUri?: string,
  storageBackend?: 'indexeddb' | 'capacitor-native' | 'capacitor-filesystem',
  taskId?: string,
): Promise<void> {
  if (!localFileUri && !taskId) return;
  try {
    if (isNativeDownloaderAvailable()) {
      await NativeDownloader.deletePrivateDownload({
        id: taskId,
        filePath: localFileUri,
      });
      return;
    }
    if (storageBackend === 'capacitor-native' && Capacitor.isPluginAvailable('CineBoxDownloader')) {
      if (localFileUri) {
        await CineBoxDownloader.deleteFile({ filePath: localFileUri });
      }
      return;
    }
    if ((storageBackend === 'capacitor-filesystem' || isCapacitorNativeRuntime()) && localFileUri) {
      if (localFileUri.startsWith('cinebox_downloads/')) {
        await Filesystem.deleteFile({
          path: localFileUri,
          directory: Directory.Data,
        });
      } else {
        await Filesystem.deleteFile({ path: localFileUri });
      }
    }
  } catch {
    // Ignore already-deleted native file
  }
}

export async function verifyNativeMediaFile(
  localFileUri: string,
  storageBackend?: 'indexeddb' | 'capacitor-native' | 'capacitor-filesystem',
  taskId?: string,
): Promise<string> {
  if (!localFileUri) throw new Error('Missing native file URI');
  if (isNativeDownloaderAvailable()) {
    const verification = await NativeDownloader.verifyPrivateFile({
      id: taskId,
      filePath: localFileUri,
    });
    if (!verification.exists || verification.sizeBytes <= 0 || !verification.playable) {
      throw new Error('Downloaded media file is missing or incomplete');
    }
    return toWebViewPlayableUrl(verification.webviewUrl || verification.filePath || localFileUri);
  }
  if (storageBackend === 'capacitor-native' && Capacitor.isPluginAvailable('CineBoxDownloader')) {
    const res = await CineBoxDownloader.getPlayableUrl({ filePath: localFileUri });
    return toWebViewPlayableUrl(res.url || localFileUri);
  }
  const statPath = localFileUri.startsWith('cinebox_downloads/')
    ? { path: localFileUri, directory: Directory.Data }
    : { path: localFileUri };
  const stat = await Filesystem.stat(statPath);
  if (Number(stat?.size || 0) <= 0) {
    throw new Error('Downloaded offline file is empty');
  }
  return toWebViewPlayableUrl(localFileUri);
}

export async function reattachCapacitorNativeDownload(params: {
  taskId: string;
  signal: AbortSignal;
  onProgress: (info: {
    receivedBytes: number;
    totalBytes: number;
    percent: number;
    speedBytesPerSec: number;
    waitingForNetwork?: boolean;
  }) => void;
}): Promise<{
  localFileUri: string;
  sizeBytes: number;
  storageBackend: 'capacitor-native';
}> {
  if (!isCineBoxNativePluginAvailable()) {
    throw new Error('Native plugin unavailable for reattach');
  }

  let lastBytesAt = performance.now();
  let lastBytesVal = 0;
  let emaSpeed = 0;
  const calcSpeed = (bytesNow: number): number => {
    const now = performance.now();
    const dt = (now - lastBytesAt) / 1000;
    if (dt >= 0.25) {
      const delta = Math.max(0, bytesNow - lastBytesVal);
      if (dt > 0.02) {
        const inst = delta / dt;
        emaSpeed = emaSpeed > 0 ? emaSpeed * 0.65 + inst * 0.35 : inst;
      }
      lastBytesAt = now;
      lastBytesVal = bytesNow;
    }
    return Math.round(emaSpeed);
  };

  if (isNativeDownloaderAvailable()) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let progressHandle: PluginListenerHandle | null = null;
      let stateHandle: PluginListenerHandle | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        params.signal.removeEventListener('abort', onAbort);
        void progressHandle?.remove().catch(() => {});
        void stateHandle?.remove().catch(() => {});
      };

      const finishSuccess = (filePath: string, sizeBytes: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ localFileUri: filePath, sizeBytes, storageBackend: 'capacitor-native' });
      };

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        void NativeDownloader.pauseDownload({ id: params.taskId }).catch(() => {});
        finishError(new DOMException('Aborted', 'AbortError'));
      };

      if (params.signal.aborted) {
        onAbort();
        return;
      }
      params.signal.addEventListener('abort', onAbort, { once: true });

      void (async () => {
        try {
          progressHandle = await NativeDownloader.addListener('downloadProgress', (ev) => {
            if ((ev.taskId !== params.taskId && ev.id !== params.taskId) || settled) return;
            const total = Math.max(0, Number(ev.totalBytes || 0));
            const received = Math.max(0, Number(ev.receivedBytes || 0));
            params.onProgress({
              receivedBytes: received,
              totalBytes: total,
              percent:
                typeof ev.percent === 'number'
                  ? Math.min(99, Math.round(ev.percent))
                  : total > 0
                    ? Math.min(99, Math.round((received / total) * 100))
                    : 0,
              speedBytesPerSec: ev.waitingForNetwork ? 0 : ev.speedBytesPerSec ?? calcSpeed(received),
              waitingForNetwork: ev.waitingForNetwork,
            });
          });

          stateHandle = await NativeDownloader.addListener('downloadStateChange', (ev) => {
            if ((ev.taskId !== params.taskId && ev.id !== params.taskId) || settled) return;
            if (ev.status === 'completed' && ev.filePath) {
              finishSuccess(ev.filePath, Number(ev.receivedBytes || ev.totalBytes || 0));
            } else if (ev.status === 'failed') {
              finishError(new Error(ev.error || 'Native download failed'));
            } else if (ev.status === 'cancelled' || ev.status === 'paused') {
              finishError(new DOMException('Aborted', 'AbortError'));
            }
          });

          const checkOnce = async () => {
            if (settled) return;
            const st = await NativeDownloader.getDownloadStatus({ id: params.taskId });
            if (settled) return;
            const received = Math.max(0, Number(st.receivedBytes || 0));
            const total = Math.max(0, Number(st.totalBytes || 0));
            if (st.status === 'downloading' || st.status === 'queued') {
              params.onProgress({
                receivedBytes: received,
                totalBytes: total,
                percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
                speedBytesPerSec: st.waitingForNetwork ? 0 : st.speedBytesPerSec ?? calcSpeed(received),
                waitingForNetwork: st.waitingForNetwork,
              });
            } else if (st.status === 'completed' && st.filePath) {
              finishSuccess(st.filePath, received || total);
            } else if (st.status === 'failed') {
              finishError(new Error(st.error || 'Native download failed'));
            } else if (st.status === 'cancelled' || st.status === 'paused') {
              finishError(new DOMException('Aborted', 'AbortError'));
            }
          };

          await checkOnce();
          pollTimer = setInterval(() => {
            void checkOnce().catch(() => {});
          }, 1000);
        } catch (err) {
          finishError(err instanceof Error ? err : new Error('Native task no longer active'));
        }
      })();
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let progressHandle: PluginListenerHandle | null = null;
    let stateHandle: PluginListenerHandle | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      params.signal.removeEventListener('abort', onAbort);
      void progressHandle?.remove().catch(() => {});
      void stateHandle?.remove().catch(() => {});
    };

    const finishSuccess = (filePath: string, sizeBytes: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        localFileUri: filePath,
        sizeBytes,
        storageBackend: 'capacitor-native',
      });
    };

    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      void CineBoxDownloader.cancelDownload({ taskId: params.taskId }).catch(() => {});
      finishError(new DOMException('Aborted', 'AbortError'));
    };

    if (params.signal.aborted) {
      onAbort();
      return;
    }
    params.signal.addEventListener('abort', onAbort, { once: true });

    void (async () => {
      try {
        progressHandle = await CineBoxDownloader.addListener('downloadProgress', (ev) => {
          if (ev.taskId !== params.taskId || settled) return;
          const total = Math.max(0, Number(ev.totalBytes || 0));
          const received = Math.max(0, Number(ev.receivedBytes || 0));
          const pct =
            typeof ev.percent === 'number' && ev.percent >= 0
              ? Math.min(99, Math.round(ev.percent))
              : total > 0
                ? Math.min(99, Math.round((received / total) * 100))
                : 0;
          params.onProgress({
            receivedBytes: received,
            totalBytes: total,
            percent: pct,
            speedBytesPerSec: ev.waitingForNetwork ? 0 : ev.speedBytesPerSec ?? calcSpeed(received),
            waitingForNetwork: ev.waitingForNetwork,
          });
        });

        stateHandle = await CineBoxDownloader.addListener('downloadStateChange', (ev) => {
          if (ev.taskId !== params.taskId || settled) return;
          if (ev.status === 'completed' && ev.filePath) {
            finishSuccess(ev.filePath, Number(ev.receivedBytes || ev.totalBytes || 0));
          } else if (ev.status === 'failed') {
            finishError(new Error(ev.error || 'Native download failed'));
          } else if (ev.status === 'cancelled') {
            finishError(new DOMException('Aborted', 'AbortError'));
          }
        });

        const checkOnce = async () => {
          if (settled) return;
          const st = await CineBoxDownloader.getStatus({ taskId: params.taskId });
          if (settled) return;
          const received = Math.max(0, Number(st.receivedBytes || 0));
          const total = Math.max(0, Number(st.totalBytes || 0));
          if (st.status === 'downloading' || st.status === 'queued') {
            params.onProgress({
              receivedBytes: received,
              totalBytes: total,
              percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
              speedBytesPerSec: st.waitingForNetwork ? 0 : calcSpeed(received),
              waitingForNetwork: st.waitingForNetwork,
            });
          } else if (st.status === 'completed' && st.filePath) {
            finishSuccess(st.filePath, received || total);
          } else if (st.status === 'failed') {
            finishError(new Error(st.error || 'Native download failed'));
          } else if (st.status === 'cancelled') {
            finishError(new DOMException('Aborted', 'AbortError'));
          }
        };

        await checkOnce();
        pollTimer = setInterval(() => {
          void checkOnce().catch(() => {});
        }, 1000);
      } catch (err) {
        finishError(err instanceof Error ? err : new Error('Native task no longer active'));
      }
    })();
  });
}

export async function downloadWithCapacitorNative(params: {
  taskId: string;
  url: string;
  fileName: string;
  title: string;
  subtitle?: string;
  mimeType: string;
  category?: 'movies' | 'series' | string;
  mediaId?: string;
  seriesTitle?: string;
  seasonNum?: number;
  episodeNum?: number;
  quality?: string;
  profile?: 'free' | 'premium';
  signal: AbortSignal;
  onProgress: (info: {
    receivedBytes: number;
    totalBytes: number;
    percent: number;
    speedBytesPerSec: number;
    etaSeconds?: number;
    retryCount?: number;
    lastCheckpoint?: string;
    waitingForNetwork?: boolean;
  }) => void;
}): Promise<{
  localFileUri: string;
  sizeBytes: number;
  storageBackend: 'capacitor-native' | 'capacitor-filesystem';
  hlsManifestPath?: string;
}> {
  const absUrl = buildAbsoluteMediaUrl(params.url);
  let lastBytesAt = performance.now();
  let lastBytesVal = 0;
  let emaSpeed = 0;

  const calcSpeed = (bytesNow: number): number => {
    const now = performance.now();
    const dt = (now - lastBytesAt) / 1000;
    if (dt >= 0.25) {
      const delta = Math.max(0, bytesNow - lastBytesVal);
      if (dt > 0.02) {
        const inst = delta / dt;
        emaSpeed = emaSpeed > 0 ? emaSpeed * 0.65 + inst * 0.35 : inst;
      }
      lastBytesAt = now;
      lastBytesVal = bytesNow;
    }
    return Math.round(emaSpeed);
  };

  // Tier 0: MovieBox-style NativeDownloader plugin (WorkManager + Range/HLS + Room + Stage 1 private storage)
  if (isNativeDownloaderAvailable()) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let progressHandle: PluginListenerHandle | null = null;
      let stateHandle: PluginListenerHandle | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        params.signal.removeEventListener('abort', onAbort);
        void progressHandle?.remove().catch(() => {});
        void stateHandle?.remove().catch(() => {});
      };

      const finishSuccess = (filePath: string, sizeBytes: number, hlsManifestPath?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          localFileUri: filePath,
          sizeBytes,
          storageBackend: 'capacitor-native',
          hlsManifestPath,
        });
      };

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        void NativeDownloader.pauseDownload({ id: params.taskId }).catch(() => {});
        finishError(new DOMException('Aborted', 'AbortError'));
      };

      if (params.signal.aborted) {
        onAbort();
        return;
      }
      params.signal.addEventListener('abort', onAbort, { once: true });

      void (async () => {
        try {
          progressHandle = await NativeDownloader.addListener('downloadProgress', (ev) => {
            if ((ev.taskId !== params.taskId && ev.id !== params.taskId) || settled) return;
            const total = Math.max(0, Number(ev.totalBytes || 0));
            const received = Math.max(0, Number(ev.receivedBytes || 0));
            const pct =
              typeof ev.percent === 'number' && ev.percent >= 0
                ? Math.min(99, Math.round(ev.percent))
                : total > 0
                  ? Math.min(99, Math.round((received / total) * 100))
                  : 0;
            const speed = ev.waitingForNetwork ? 0 : Number(ev.speedBytesPerSec || calcSpeed(received));
            params.onProgress({
              receivedBytes: received,
              totalBytes: total,
              percent: pct,
              speedBytesPerSec: speed,
              etaSeconds:
                speed > 0 && total > received
                  ? Math.max(1, Math.round((total - received) / speed))
                  : ev.etaSeconds,
              retryCount: ev.retryCount,
              lastCheckpoint: ev.lastCheckpoint,
              waitingForNetwork: ev.waitingForNetwork,
            });
          });

          stateHandle = await NativeDownloader.addListener('downloadStateChange', (ev) => {
            if ((ev.taskId !== params.taskId && ev.id !== params.taskId) || settled) return;
            if (ev.status === 'completed' && ev.filePath) {
              finishSuccess(
                ev.filePath,
                Number(ev.receivedBytes || ev.totalBytes || 0),
                ev.hlsManifestPath,
              );
            } else if (ev.status === 'failed') {
              finishError(new Error(ev.error || 'Native download failed'));
            } else if (ev.status === 'cancelled' || ev.status === 'paused') {
              finishError(new DOMException('Aborted', 'AbortError'));
            }
          });

          const startRes = await NativeDownloader.downloadFile({
            taskId: params.taskId,
            mediaId: params.mediaId,
            url: absUrl,
            fileName: params.fileName,
            category: params.category || (params.seriesTitle ? 'series' : 'movies'),
            title: params.title,
            subtitle: params.subtitle,
            seriesTitle: params.seriesTitle,
            seasonNum: params.seasonNum,
            episodeNum: params.episodeNum,
            quality: params.quality,
            mimeType: params.mimeType,
            profile: params.profile || 'free',
            baseFolder: 'Cinebox/Downloads',
          });

          pollTimer = setInterval(() => {
            if (settled) return;
            void NativeDownloader.getDownloadStatus({ id: params.taskId })
              .then((st) => {
                if (settled) return;
                const received = Math.max(0, Number(st.receivedBytes || 0));
                const total = Math.max(0, Number(st.totalBytes || 0));
                if (st.status === 'downloading' || st.status === 'queued') {
                  const speed = st.waitingForNetwork
                    ? 0
                    : Number(st.speedBytesPerSec || calcSpeed(received));
                  params.onProgress({
                    receivedBytes: received,
                    totalBytes: total,
                    percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
                    speedBytesPerSec: speed,
                    etaSeconds:
                      speed > 0 && total > received
                        ? Math.max(1, Math.round((total - received) / speed))
                        : st.etaSeconds,
                    retryCount: st.retryCount,
                    lastCheckpoint: st.lastCheckpoint,
                    waitingForNetwork: st.waitingForNetwork,
                  });
                } else if (st.status === 'completed' && (st.filePath || startRes.filePath)) {
                  finishSuccess(
                    st.filePath || startRes.filePath,
                    received || total,
                    st.hlsManifestPath,
                  );
                } else if (st.status === 'failed') {
                  finishError(new Error(st.error || 'Native download failed'));
                } else if (st.status === 'cancelled' || st.status === 'paused') {
                  finishError(new DOMException('Aborted', 'AbortError'));
                }
              })
              .catch(() => {});
          }, 900);
        } catch (err) {
          finishError(err instanceof Error ? err : new Error('Unable to start native download'));
        }
      })();
    });
  }

  // Tier 1: Legacy CineBoxDownloader Capacitor Native Plugin (private Stage 1 dir)
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('CineBoxDownloader')) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let progressHandle: PluginListenerHandle | null = null;
      let stateHandle: PluginListenerHandle | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        params.signal.removeEventListener('abort', onAbort);
        void progressHandle?.remove().catch(() => {});
        void stateHandle?.remove().catch(() => {});
      };

      const finishSuccess = (filePath: string, sizeBytes: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          localFileUri: filePath,
          sizeBytes,
          storageBackend: 'capacitor-native',
        });
      };

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        void CineBoxDownloader.cancelDownload({ taskId: params.taskId }).catch(() => {});
        finishError(new DOMException('Aborted', 'AbortError'));
      };

      if (params.signal.aborted) {
        onAbort();
        return;
      }
      params.signal.addEventListener('abort', onAbort, { once: true });

      void (async () => {
        try {
          progressHandle = await CineBoxDownloader.addListener('downloadProgress', (ev) => {
            if (ev.taskId !== params.taskId || settled) return;
            const total = Math.max(0, Number(ev.totalBytes || 0));
            const received = Math.max(0, Number(ev.receivedBytes || 0));
            const pct =
              typeof ev.percent === 'number' && ev.percent >= 0
                ? Math.min(99, Math.round(ev.percent))
                : total > 0
                  ? Math.min(99, Math.round((received / total) * 100))
                  : 0;
            params.onProgress({
              receivedBytes: received,
              totalBytes: total,
              percent: pct,
              speedBytesPerSec: ev.waitingForNetwork ? 0 : ev.speedBytesPerSec ?? calcSpeed(received),
              waitingForNetwork: ev.waitingForNetwork,
            });
          });

          stateHandle = await CineBoxDownloader.addListener('downloadStateChange', (ev) => {
            if (ev.taskId !== params.taskId || settled) return;
            if (ev.status === 'completed' && ev.filePath) {
              finishSuccess(ev.filePath, Number(ev.receivedBytes || ev.totalBytes || 0));
            } else if (ev.status === 'failed') {
              finishError(new Error(ev.error || 'Native download failed'));
            } else if (ev.status === 'cancelled') {
              finishError(new DOMException('Aborted', 'AbortError'));
            }
          });

          const startRes = await CineBoxDownloader.startDownload({
            taskId: params.taskId,
            url: absUrl,
            fileName: params.fileName,
            title: params.title,
            subtitle: params.subtitle,
            mimeType: params.mimeType,
            saveToPublicDownloads: false,
          });

          pollTimer = setInterval(() => {
            if (settled) return;
            void CineBoxDownloader.getStatus({ taskId: params.taskId })
              .then((st) => {
                if (settled) return;
                const received = Math.max(0, Number(st.receivedBytes || 0));
                const total = Math.max(0, Number(st.totalBytes || 0));
                if (st.status === 'downloading' || st.status === 'queued') {
                  params.onProgress({
                    receivedBytes: received,
                    totalBytes: total,
                    percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
                    speedBytesPerSec: st.waitingForNetwork ? 0 : calcSpeed(received),
                    waitingForNetwork: st.waitingForNetwork,
                  });
                } else if (st.status === 'completed' && (st.filePath || startRes.filePath)) {
                  finishSuccess(
                    st.filePath || startRes.filePath || '',
                    received || total,
                  );
                } else if (st.status === 'failed') {
                  finishError(new Error(st.error || 'Native download failed'));
                } else if (st.status === 'cancelled') {
                  finishError(new DOMException('Aborted', 'AbortError'));
                }
              })
              .catch(() => {});
          }, 1000);
        } catch (err) {
          finishError(err instanceof Error ? err : new Error('Unable to start native download'));
        }
      })();
    });
  }

  // Tier 2: Built-in Capacitor Filesystem native downloader (Directory.Data)
  const relPath = `cinebox_downloads/${params.taskId}_${params.fileName}`;
  await Filesystem.mkdir({
    path: 'cinebox_downloads',
    directory: Directory.Data,
    recursive: true,
  }).catch(() => {});

  let progressListener: PluginListenerHandle | null = null;
  const onAbort = () => {
    void Filesystem.deleteFile({ path: relPath, directory: Directory.Data }).catch(() => {});
  };
  params.signal.addEventListener('abort', onAbort, { once: true });

  try {
    progressListener = await Filesystem.addListener('progress', (prog) => {
      if (params.signal.aborted) return;
      if (prog.url && prog.url !== absUrl && !prog.url.includes(params.taskId)) return;
      const received = Math.max(0, Number(prog.bytes || 0));
      const total = Math.max(0, Number(prog.contentLength || 0));
      const pct = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0;
      params.onProgress({
        receivedBytes: received,
        totalBytes: total,
        percent: pct,
        speedBytesPerSec: calcSpeed(received),
      });
    });

    const dlRes = await Filesystem.downloadFile({
      url: absUrl,
      path: relPath,
      directory: Directory.Data,
      recursive: true,
      progress: true,
      headers: {
        Accept: '*/*',
      },
    });

    if (params.signal.aborted) {
      await Filesystem.deleteFile({ path: relPath, directory: Directory.Data }).catch(() => {});
      throw new DOMException('Aborted', 'AbortError');
    }

    const stat = await Filesystem.stat({
      path: relPath,
      directory: Directory.Data,
    }).catch(() => null);

    const uriRes = await Filesystem.getUri({
      path: relPath,
      directory: Directory.Data,
    }).catch(() => ({ uri: dlRes.path || relPath }));

    const sizeBytes = Number(stat?.size || lastBytesVal || 0);
    if (sizeBytes <= 0) {
      throw new Error('Downloaded file is empty');
    }

    return {
      localFileUri: uriRes.uri || dlRes.path || relPath,
      sizeBytes,
      storageBackend: 'capacitor-filesystem',
    };
  } finally {
    params.signal.removeEventListener('abort', onAbort);
    void progressListener?.remove().catch(() => {});
  }
}
