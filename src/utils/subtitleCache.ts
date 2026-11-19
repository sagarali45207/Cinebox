export interface DownloadedSubtitleRecord {
  id: string;
  streamKey: string;
  language: string;
  languageCode: string;
  label: string;
  fileName?: string;
  format: string;
  source: 'opensubtitles' | 'embedded' | 'custom';
  vttText: string;
  offsetSec: number;
  downloadedAt: number;
}

const STORAGE_KEY = 'cinebox_downloaded_subtitles_v1';
const ACTIVE_KEY = 'cinebox_active_subtitle_by_stream_v1';
const MAX_CACHED_SUBTITLES = 32;

function readAllRecords(): DownloadedSubtitleRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DownloadedSubtitleRecord[]) : [];
  } catch {
    return [];
  }
}

function writeAllRecords(records: DownloadedSubtitleRecord[]): void {
  const sorted = [...records]
    .sort((a, b) => b.downloadedAt - a.downloadedAt)
    .slice(0, MAX_CACHED_SUBTITLES);

  for (let limit = sorted.length; limit >= 1; limit--) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted.slice(0, limit)));
      return;
    } catch {
      // Trim oldest entries if localStorage quota is tight
    }
  }
}

export function buildSubtitleStreamKey(kind: string, id: string): string {
  const normKind = kind === 'series' || kind === 'episode' ? 'episode' : 'movie';
  return `${normKind}:${id}`;
}

export function getDownloadedSubtitlesForStream(
  streamKey: string,
): DownloadedSubtitleRecord[] {
  return readAllRecords()
    .filter((r) => r.streamKey === streamKey)
    .sort((a, b) => b.downloadedAt - a.downloadedAt);
}

export function getDownloadedSubtitle(
  streamKey: string,
  subId: string,
): DownloadedSubtitleRecord | null {
  return (
    readAllRecords().find((r) => r.streamKey === streamKey && r.id === subId) || null
  );
}

export function saveDownloadedSubtitle(
  record: Omit<DownloadedSubtitleRecord, 'downloadedAt'>,
): DownloadedSubtitleRecord {
  const next: DownloadedSubtitleRecord = {
    ...record,
    downloadedAt: Date.now(),
  };
  const existing = readAllRecords().filter(
    (r) => !(r.streamKey === next.streamKey && r.id === next.id),
  );
  writeAllRecords([next, ...existing]);
  setPreferredActiveSubtitleId(next.streamKey, next.id);
  return next;
}

export function updateDownloadedSubtitleOffset(
  streamKey: string,
  subId: string,
  offsetSec: number,
): void {
  const all = readAllRecords();
  let changed = false;
  const updated = all.map((r) => {
    if (r.streamKey === streamKey && r.id === subId) {
      changed = true;
      return { ...r, offsetSec: Math.round(offsetSec * 10) / 10, downloadedAt: Date.now() };
    }
    return r;
  });
  if (changed) {
    writeAllRecords(updated);
  }
}

export function removeDownloadedSubtitle(streamKey: string, subId: string): void {
  const remaining = readAllRecords().filter(
    (r) => !(r.streamKey === streamKey && r.id === subId),
  );
  writeAllRecords(remaining);
  if (getPreferredActiveSubtitleId(streamKey) === subId) {
    setPreferredActiveSubtitleId(streamKey, null);
  }
}

export function getPreferredActiveSubtitleId(streamKey: string): string | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return map[streamKey] || null;
  } catch {
    return null;
  }
}

export function setPreferredActiveSubtitleId(
  streamKey: string,
  subId: string | null,
): void {
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (subId) {
      map[streamKey] = subId;
    } else {
      delete map[streamKey];
    }
    window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

export function convertClientSrtOrVttToVtt(rawText: string): string {
  let clean = rawText.replace(/^\uFEFF/, '').trim();
  clean = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  clean = clean.replace(/^WEBVTT[^\n]*\n+/i, '');
  clean = clean.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})(\s*-->\s*)(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    (_m, s1: string, ms1: string, arrow: string, s2: string, ms2: string) => {
      const pad1 = s1.length === 7 ? `0${s1}` : s1;
      const pad2 = s2.length === 7 ? `0${s2}` : s2;
      return `${pad1}.${ms1}${arrow}${pad2}.${ms2}`;
    },
  );
  return `WEBVTT\n\n${clean}`;
}
