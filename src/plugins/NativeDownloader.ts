import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { DownloadProfileMode, TransferStatus } from '../types/media';

export type DownloadCategory = 'movies' | 'series' | 'downloads' | string;

export interface NativeDownloadFileOptions {
  url: string;
  fileName: string;
  category: DownloadCategory;
  taskId?: string;
  mediaId?: string;
  title?: string;
  subtitle?: string;
  seriesTitle?: string;
  seasonNum?: number;
  episodeNum?: number;
  quality?: string;
  mimeType?: string;
  headers?: Record<string, string>;
  profile?: DownloadProfileMode;
  preferEngine?: 'auto' | 'chunked' | 'download_manager' | 'hls';
  baseFolder?: 'Cinebox/Downloads' | 'Downloads';
}

export interface NativeDownloadStartResult {
  id: string;
  taskId: string;
  downloadId?: number;
  filePath: string;
  privateDir: string;
  engine: 'chunked' | 'hls' | 'download_manager';
}

export interface NativeDownloadStatusResult {
  id: string;
  taskId: string;
  mediaId?: string;
  title?: string;
  category?: string;
  quality?: string;
  status:
    | 'queued'
    | 'downloading'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  speedBytesPerSec: number;
  etaSeconds?: number;
  retryCount?: number;
  lastCheckpoint?: string;
  filePath: string;
  hlsManifestPath?: string;
  mimeType?: string;
  transferStatus: TransferStatus;
  transferProgress?: number;
  exportedUri?: string;
  exportedPath?: string;
  isVerifiedPlayable?: boolean;
  waitingForNetwork?: boolean;
  profile?: DownloadProfileMode;
  error?: string;
}

export interface NativeTransferResult {
  taskId: string;
  transferStatus: TransferStatus;
  exportedUri: string;
  exportedPath: string;
  sizeBytes: number;
  verified: boolean;
}

export interface NativeTransferProgressEvent {
  taskId: string;
  copiedBytes: number;
  totalBytes: number;
  percent: number;
  transferStatus: TransferStatus;
}

export interface NativePlayableVerification {
  exists: boolean;
  playable: boolean;
  sizeBytes: number;
  filePath: string;
  webviewUrl: string;
  mimeType: string;
  isHlsDirectory?: boolean;
}

export interface NativeExternalPlayerResult {
  launched: boolean;
  chooserShown: boolean;
  uri: string;
  mimeType: string;
}

export interface NativeExoPlayerResult {
  launched: boolean;
  lastPositionMs?: number;
  durationMs?: number;
  completed?: boolean;
}

export interface NativeStorageSummary {
  privateRootPath: string;
  moviesDirPath: string;
  seriesDirPath: string;
  privateBytesUsed: number;
  freeBytesAvailable: number;
  completedCount: number;
  activeCount: number;
}

export interface NativeDownloaderPlugin {
  /**
   * Direct Capacitor method matching downloadFile(url, fileName, category).
   * Persists media into Android/data/com.cinebox.app/files/Cinebox/Downloads/{Movies|Series}
   * (or Android/data/com.cinebox.app/files/Downloads when baseFolder='Downloads' or category='downloads').
   */
  downloadFile(options: NativeDownloadFileOptions): Promise<NativeDownloadStartResult>;

  /**
   * Query download & transfer state from Room + WorkManager + DownloadManager.
   */
  getDownloadStatus(options: { id: string }): Promise<NativeDownloadStatusResult>;

  pauseDownload(options: { id: string }): Promise<void>;
  resumeDownload(options: { id: string }): Promise<NativeDownloadStartResult>;
  retryDownload(options: { id: string }): Promise<NativeDownloadStartResult>;
  cancelDownload(options: { id: string }): Promise<void>;
  deletePrivateDownload(options: { id?: string; filePath?: string }): Promise<void>;

  /**
   * Stage 2: Copy verified private file into Android MediaStore public storage
   * (Movies/Cinebox/ or Downloads/Cinebox/) without re-downloading or transcoding.
   */
  transferToLocalStorage(options: {
    id: string;
    filePath: string;
    fileName?: string;
    category?: DownloadCategory;
    destination?: 'movies' | 'downloads';
    mimeType?: string;
    title?: string;
  }): Promise<NativeTransferResult>;

  /**
   * Delete ONLY the exported public MediaStore copy while preserving Stage 1 private offline file.
   */
  deleteExportedCopy(options: { id: string; exportedUri: string }): Promise<void>;

  verifyPrivateFile(options: { id?: string; filePath: string }): Promise<NativePlayableVerification>;
  getPlayableUri(options: { filePath: string }): Promise<{ url: string; filePath: string }>;

  playOfflineWithExoPlayer(options: {
    id?: string;
    filePath: string;
    title: string;
    subtitle?: string;
    mimeType?: string;
    resumePositionMs?: number;
    subtitles?: Array<{ language: string; label?: string; vttText: string }>;
  }): Promise<NativeExoPlayerResult>;

  playStreamWithExoPlayer(options: {
    url: string;
    title: string;
    subtitle?: string;
    quality?: string;
    mimeType?: string;
    headers?: Record<string, string>;
    resumePositionMs?: number;
  }): Promise<NativeExoPlayerResult>;

  openInExternalPlayer(options: {
    url?: string;
    filePath?: string;
    title: string;
    mimeType?: string;
    headers?: Record<string, string>;
  }): Promise<NativeExternalPlayerResult>;

  setDownloadProfile(options: { profile: DownloadProfileMode }): Promise<{ profile: DownloadProfileMode }>;
  getDownloadProfile(): Promise<{ profile: DownloadProfileMode }>;

  listDownloads(): Promise<{ downloads: NativeDownloadStatusResult[] }>;
  listActiveTasks(): Promise<{ tasks: NativeDownloadStatusResult[] }>;
  getStorageSummary(): Promise<NativeStorageSummary>;

  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (event: NativeDownloadStatusResult) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'downloadStateChange',
    listenerFunc: (event: NativeDownloadStatusResult) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'transferProgress',
    listenerFunc: (event: NativeTransferProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'transferStateChange',
    listenerFunc: (event: NativeTransferResult & { error?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const NativeDownloader = registerPlugin<NativeDownloaderPlugin>('NativeDownloader');

/**
 * Android download plugin execution is disabled by user preference;
 * all downloads and offline exports run in pure JavaScript/IndexedDB.
 */
export function isNativeDownloaderAvailable(): boolean {
  return false;
}

export function isAndroidPlatform(): boolean {
  try {
    if (Capacitor.getPlatform() === 'android') return true;
  } catch {
    // Ignore when Capacitor bridge is unavailable
  }
  if (typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '')) {
    return true;
  }
  return false;
}

export type ExternalAndroidPlayerTarget =
  | 'chooser'
  | 'vlc'
  | 'mx'
  | 'mpv';

const ANDROID_PLAYER_PACKAGES: Record<Exclude<ExternalAndroidPlayerTarget, 'chooser'>, string> = {
  vlc: 'org.videolan.vlc',
  mx: 'com.mxtech.videoplayer.ad',
  mpv: 'is.xyz.mpv',
};

export function buildAndroidPlayerIntentUrl(params: {
  url: string;
  title?: string;
  mimeType?: string;
  player?: ExternalAndroidPlayerTarget;
}): string {
  const rawUrl = (params.url || '').trim();
  if (
    !rawUrl ||
    rawUrl.startsWith('blob:') ||
    rawUrl.startsWith('capacitor:') ||
    rawUrl.startsWith('data:') ||
    rawUrl.startsWith('/__offline_media__/')
  ) {
    return '';
  }

  let absUrl = rawUrl;
  if (!/^https?:\/\//i.test(absUrl)) {
    if (typeof window !== 'undefined' && window.location?.origin) {
      absUrl = new URL(absUrl, window.location.origin).toString();
    } else {
      return '';
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(absUrl);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '';
  }

  const scheme = parsed.protocol.replace(/:$/, '');
  const hostAndPath = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  const mime = (params.mimeType || 'video/*').trim();
  const title = (params.title || 'CineBox Video').trim();
  const targetPlayer = params.player || 'chooser';

  const intentParts = [
    `scheme=${scheme}`,
    'action=android.intent.action.VIEW',
    `type=${mime}`,
    `S.title=${encodeURIComponent(title)}`,
    `S.android.intent.extra.TITLE=${encodeURIComponent(title)}`,
  ];

  if (targetPlayer !== 'chooser') {
    const pkg = ANDROID_PLAYER_PACKAGES[targetPlayer];
    if (pkg) {
      intentParts.push(`package=${pkg}`);
    }
  }

  return `intent://${hostAndPath}#Intent;${intentParts.join(';')};end`;
}

/**
 * Pure JavaScript Android intent:// launcher (no Capacitor/Kotlin bridge required).
 * Uses a temporary anchor click so the SPA stays intact while Android hands off to ExoPlayer / VLC / MX / MPV / System Chooser.
 */
export function launchAndroidExternalPlayerIntent(params: {
  url: string;
  title?: string;
  mimeType?: string;
  player?: ExternalAndroidPlayerTarget;
}): { launched: boolean; intentUrl: string; error?: string } {
  if (typeof document === 'undefined') {
    return { launched: false, intentUrl: '', error: 'Browser document unavailable' };
  }
  const intentUrl = buildAndroidPlayerIntentUrl(params);
  if (!intentUrl) {
    return {
      launched: false,
      intentUrl: '',
      error: 'A direct http/https stream URL is required for Android player intents.',
    };
  }

  const link = document.createElement('a');
  link.href = intentUrl;
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  return { launched: true, intentUrl };
}

export function toWebViewPlayableUrl(rawPathOrUri: string): string {
  if (!rawPathOrUri) return '';
  if (/^(https?:\/\/|blob:|data:|\/__offline_media__\/)/i.test(rawPathOrUri)) {
    return rawPathOrUri;
  }
  return rawPathOrUri;
}

export async function downloadFile(
  _url: string,
  _fileName: string,
  _category: DownloadCategory = 'downloads',
  _extra?: Partial<Omit<NativeDownloadFileOptions, 'url' | 'fileName' | 'category'>>,
): Promise<NativeDownloadStartResult> {
  throw new Error('Android native download plugin is disabled; use the JavaScript offline downloader.');
}

export async function getDownloadStatus(_id: string): Promise<NativeDownloadStatusResult> {
  throw new Error('Android native download plugin is disabled.');
}

export default NativeDownloader;
