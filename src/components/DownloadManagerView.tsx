import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  Film,
  FolderOutput,
  HardDrive,
  Info,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Tv,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import type {
  DetailTarget,
  DownloadProfileMode,
  OfflineDownloadEntry,
  OfflineDownloadTaskState,
} from '../types/media';
import { formatRelativeTime } from '../utils/format';
import { formatBytes, formatSpeed } from '../utils/offlineDb';
import { useOfflineDownloads } from '../utils/offlineManager';
import { MediaImage } from './MediaImage';

interface DownloadManagerViewProps {
  isOnline: boolean;
  onOpenDetail: (target: DetailTarget) => void;
  onBrowseCatalog?: () => void;
}

type DownloadFilter = 'all' | 'movies' | 'series';

interface UnifiedSeriesGroup {
  groupKey: string;
  seriesId: string;
  seriesTitle: string;
  categoryName: string;
  year: string | null;
  poster: string;
  posterBlob?: Blob;
  completedBytes: number;
  activeReceivedBytes: number;
  activeTotalBytes: number;
  activeTotalEstimated: boolean;
  completed: OfflineDownloadEntry[];
  downloading: OfflineDownloadTaskState[];
  paused: OfflineDownloadTaskState[];
  queued: OfflineDownloadTaskState[];
  hasActiveDownloads: boolean;
  overallProgressPct: number;
  liveSpeedBytesPerSec: number;
  waitingForNetwork: boolean;
  defaultSeasonNum?: number;
}

function OfflinePoster({
  poster,
  posterBlob,
  title,
  year,
  className = '',
}: {
  poster: string;
  posterBlob?: Blob;
  title: string;
  year: string | null;
  className?: string;
}) {
  const [blobUrl, setBlobUrl] = useState('');

  useEffect(() => {
    if (!posterBlob) {
      setBlobUrl('');
      return;
    }
    const url = URL.createObjectURL(posterBlob);
    setBlobUrl(url);
    return () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore
      }
    };
  }, [posterBlob]);

  return (
    <MediaImage
      src={blobUrl || poster}
      alt={title}
      title={title}
      year={year}
      className={className}
      imgClassName="h-full w-full object-cover"
    />
  );
}

function formatEta(etaSeconds?: number): string {
  if (!etaSeconds || !Number.isFinite(etaSeconds) || etaSeconds <= 0) return '';
  if (etaSeconds < 60) return `${Math.round(etaSeconds)}s left`;
  const mins = Math.floor(etaSeconds / 60);
  const secs = Math.round(etaSeconds % 60);
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s left` : `${mins}m left`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m left`;
}

function getTurboBoostBadgeText(
  liveSpeedBytesPerSec: number,
  standardBytesPerSec?: number,
): string | null {
  if (!standardBytesPerSec || standardBytesPerSec <= 0 || liveSpeedBytesPerSec <= 0) {
    return null;
  }
  const diff = liveSpeedBytesPerSec - standardBytesPerSec;
  if (diff <= 0) return null;
  const pct = Math.round((diff / standardBytesPerSec) * 100);
  const mult = (liveSpeedBytesPerSec / standardBytesPerSec).toFixed(1);
  return pct >= 5 ? `+${pct}% (${mult}x faster)` : `+${formatSpeed(diff)}`;
}

function formatTaskProgressSize(task: OfflineDownloadTaskState): string {
  const received = Math.max(0, task.receivedBytes || 0);
  const total = Math.max(0, task.totalBytes || 0);
  if (total > 0) {
    const prefix = task.isEstimatedTotal ? '~' : '';
    return `${formatBytes(received)} / ${prefix}${formatBytes(total)}`;
  }
  if (received > 0) {
    return `${formatBytes(received)} downloaded`;
  }
  return 'Calculating size...';
}

export function DownloadManagerView({
  isOnline,
  onOpenDetail,
  onBrowseCatalog,
}: DownloadManagerViewProps) {
  const [filter, setFilter] = useState<DownloadFilter>('all');
  const [expandedSeriesKeys, setExpandedSeriesKeys] = useState<Set<string>>(() => new Set());
  const [expandedInfoKeys, setExpandedInfoKeys] = useState<Set<string>>(() => new Set());
  const {
    downloads,
    tasks,
    usedStorageBytes,
    browserUsageBytes,
    quotaBytes,
    downloadProfile,
    speedComparison,
    ready,
    pauseDownload,
    pauseAllDownloads,
    resumeDownload,
    resumeAllDownloads,
    cancelDownload,
    removeDownload,
    clearDownloads,
    transferDownload,
    deleteExportedCopy,
    setDownloadProfile,
    refreshDownloads,
  } = useOfflineDownloads();

  const toggleInfoExpanded = (key: string) => {
    setExpandedInfoKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    void refreshDownloads();
  }, [refreshDownloads]);

  const activeTasks = Object.values(tasks);
  const activeMovieTasks = useMemo(
    () => activeTasks.filter((t) => t.kind === 'movie'),
    [activeTasks],
  );
  const activeEpisodeTasks = useMemo(
    () => activeTasks.filter((t) => t.kind === 'episode'),
    [activeTasks],
  );
  const runningOrQueuedCount = useMemo(
    () => activeTasks.filter((t) => t.status === 'downloading' || t.status === 'queued').length,
    [activeTasks],
  );
  const resumableTasksCount = useMemo(
    () => activeTasks.filter((t) => t.status === 'paused' || t.status === 'error').length,
    [activeTasks],
  );

  const movieDownloads = useMemo(
    () => downloads.filter((d) => d.kind === 'movie'),
    [downloads],
  );
  const episodeDownloads = useMemo(
    () => downloads.filter((d) => d.kind === 'episode'),
    [downloads],
  );

  const moviesBytes = useMemo(
    () => movieDownloads.reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
    [movieDownloads],
  );
  const seriesBytes = useMemo(
    () => episodeDownloads.reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
    [episodeDownloads],
  );
  const activeBufferBytes = useMemo(
    () =>
      activeTasks.reduce(
        (sum, t) => sum + (t.receivedBytes || 0),
        0,
      ),
    [activeTasks],
  );
  const liveDownloadingSpeed = useMemo(
    () =>
      activeTasks.reduce(
        (sum, t) => sum + (t.status === 'downloading' ? t.speedBytesPerSec || 0 : 0),
        0,
      ),
    [activeTasks],
  );

  const unifiedSeriesGroups = useMemo<UnifiedSeriesGroup[]>(() => {
    const map = new Map<string, UnifiedSeriesGroup>();

    const ensureGroup = (seed: {
      groupKey: string;
      seriesId: string;
      seriesTitle: string;
      categoryName: string;
      year: string | null;
      poster: string;
      posterBlob?: Blob;
      seasonNum?: number;
    }): UnifiedSeriesGroup => {
      const existing = map.get(seed.groupKey);
      if (existing) {
        if (!existing.posterBlob && seed.posterBlob) existing.posterBlob = seed.posterBlob;
        if (!existing.poster && seed.poster) existing.poster = seed.poster;
        if (!existing.categoryName && seed.categoryName) existing.categoryName = seed.categoryName;
        if (!existing.year && seed.year) existing.year = seed.year;
        if (!existing.defaultSeasonNum && seed.seasonNum) existing.defaultSeasonNum = seed.seasonNum;
        return existing;
      }
      const created: UnifiedSeriesGroup = {
        groupKey: seed.groupKey,
        seriesId: seed.seriesId,
        seriesTitle: seed.seriesTitle,
        categoryName: seed.categoryName,
        year: seed.year,
        poster: seed.poster,
        posterBlob: seed.posterBlob,
        completedBytes: 0,
        activeReceivedBytes: 0,
        activeTotalBytes: 0,
        activeTotalEstimated: false,
        completed: [],
        downloading: [],
        paused: [],
        queued: [],
        hasActiveDownloads: false,
        overallProgressPct: 0,
        liveSpeedBytesPerSec: 0,
        waitingForNetwork: false,
        defaultSeasonNum: seed.seasonNum,
      };
      map.set(seed.groupKey, created);
      return created;
    };

    for (const ep of episodeDownloads) {
      const groupKey = ep.seriesId || ep.seriesTitle || ep.id;
      const group = ensureGroup({
        groupKey,
        seriesId: ep.seriesId || ep.id,
        seriesTitle: ep.seriesTitle || ep.title,
        categoryName: ep.categoryName,
        year: ep.year,
        poster: ep.poster,
        posterBlob: ep.posterBlob,
        seasonNum: ep.seasonNum,
      });
      group.completed.push(ep);
      group.completedBytes += ep.sizeBytes || 0;
    }

    for (const task of activeEpisodeTasks) {
      const fallbackId = task.id || task.key;
      const groupKey = task.seriesId || task.seriesTitle || fallbackId;
      const group = ensureGroup({
        groupKey,
        seriesId: task.seriesId || fallbackId,
        seriesTitle: task.seriesTitle || task.title,
        categoryName: task.categoryName || '',
        year: task.year ?? null,
        poster: task.poster || '',
        seasonNum: task.seasonNum,
      });
      if (task.status === 'downloading' || task.status === 'saving') {
        group.downloading.push(task);
      } else if (task.status === 'paused' || task.status === 'error') {
        group.paused.push(task);
      } else {
        group.queued.push(task);
      }
    }

    const sortByEpisode = <T extends { seasonNum?: number; episodeNum?: number }>(list: T[]) =>
      list.sort((a, b) => {
        const sDiff = (a.seasonNum ?? 1) - (b.seasonNum ?? 1);
        if (sDiff !== 0) return sDiff;
        return (a.episodeNum ?? 1) - (b.episodeNum ?? 1);
      });

    for (const group of map.values()) {
      sortByEpisode(group.completed);
      sortByEpisode(group.downloading);
      sortByEpisode(group.paused);
      sortByEpisode(group.queued);

      const activeList = [...group.downloading, ...group.paused, ...group.queued];
      group.hasActiveDownloads = activeList.length > 0;
      group.liveSpeedBytesPerSec = group.downloading.reduce(
        (sum, t) => sum + (t.speedBytesPerSec || 0),
        0,
      );
      group.waitingForNetwork = activeList.some((t) => Boolean(t.waitingForNetwork));

      if (activeList.length > 0) {
        const totalExpected = activeList.reduce(
          (sum, t) => sum + (t.totalBytes > 0 ? t.totalBytes : 0),
          0,
        );
        const totalReceived = activeList.reduce(
          (sum, t) => sum + (t.receivedBytes || 0),
          0,
        );
        group.activeReceivedBytes = totalReceived;
        group.activeTotalBytes = totalExpected;
        group.activeTotalEstimated = activeList.some(
          (t) => t.totalBytes > 0 && Boolean(t.isEstimatedTotal),
        );
        if (totalExpected > 0) {
          group.overallProgressPct = Math.min(
            100,
            Math.round((totalReceived / totalExpected) * 100),
          );
        } else {
          const avg =
            activeList.reduce((sum, t) => sum + (t.percent || 0), 0) / activeList.length;
          group.overallProgressPct = Math.min(100, Math.round(avg));
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.hasActiveDownloads !== b.hasActiveDownloads) {
        return a.hasActiveDownloads ? -1 : 1;
      }
      return a.seriesTitle.localeCompare(b.seriesTitle);
    });
  }, [episodeDownloads, activeEpisodeTasks]);

  const cineboxUsedBytes = usedStorageBytes + activeBufferBytes;
  const totalOriginUsedBytes = Math.max(browserUsageBytes, cineboxUsedBytes);
  const hasQuota = quotaBytes !== null && quotaBytes > 0;
  const availableBytes = hasQuota ? Math.max(0, quotaBytes - totalOriginUsedBytes) : null;
  const barDenominator = hasQuota ? quotaBytes : Math.max(cineboxUsedBytes, 1);

  const moviesBarPct =
    moviesBytes > 0 ? Math.min(100, (moviesBytes / barDenominator) * 100) : 0;
  const seriesBarPct =
    seriesBytes > 0 ? Math.min(100 - moviesBarPct, (seriesBytes / barDenominator) * 100) : 0;
  const activeBarPct =
    activeBufferBytes > 0
      ? Math.min(100 - moviesBarPct - seriesBarPct, (activeBufferBytes / barDenominator) * 100)
      : 0;

  const usedPercent = hasQuota ? Math.min(100, (cineboxUsedBytes / quotaBytes) * 100) : null;
  const usedPercentLabel =
    usedPercent === null
      ? null
      : usedPercent > 0 && usedPercent < 0.1
        ? '<0.1%'
        : `${usedPercent.toFixed(usedPercent >= 10 ? 0 : 1)}%`;

  const isLowStorage =
    hasQuota &&
    availableBytes !== null &&
    (availableBytes < 512 * 1024 * 1024 || totalOriginUsedBytes / quotaBytes >= 0.85);

  const showMovies = filter === 'all' || filter === 'movies';
  const showSeries = filter === 'all' || filter === 'series';

  const openOfflineMovie = (entry: OfflineDownloadEntry) => {
    onOpenDetail({
      kind: 'movie',
      id: entry.id,
      autoplay: true,
      preferOffline: true,
      initialMovie: {
        title: entry.title,
        subtitle: entry.categoryName,
        poster: entry.poster,
        playUrl: `/api/play/vod/${entry.id}.${entry.extension || 'mp4'}`,
        extension: entry.extension,
      },
    });
  };

  const openOfflineEpisode = (entry: OfflineDownloadEntry) => {
    onOpenDetail({
      kind: 'series',
      id: entry.seriesId || entry.id,
      episodeId: entry.id,
      seasonNum: entry.seasonNum,
      episodeNum: entry.episodeNum,
      preferOffline: true,
      autoplay: true,
    });
  };

  const openDownloadMoreForSeries = (group: UnifiedSeriesGroup) => {
    if (!group.seriesId) return;
    onOpenDetail({
      kind: 'series',
      id: group.seriesId,
      seasonNum: group.defaultSeasonNum,
      initialSeason: group.defaultSeasonNum ? String(group.defaultSeasonNum) : undefined,
      openDownloadModal: true,
    });
  };

  const toggleSeriesExpanded = (groupKey: string) => {
    setExpandedSeriesKeys((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const removeSeriesGroup = async (group: UnifiedSeriesGroup) => {
    for (const ep of group.completed) {
      await removeDownload(ep.key);
    }
    for (const task of [...group.downloading, ...group.paused, ...group.queued]) {
      cancelDownload(task.key);
    }
  };

  const allTabCount =
    movieDownloads.length + activeMovieTasks.length + unifiedSeriesGroups.length;
  const moviesTabCount = movieDownloads.length + activeMovieTasks.length;

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-20 space-y-6">
      {/* Header & Filter Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200/80 dark:border-white/[0.08] pb-5">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
            Download Manager
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 tabular-nums">
            {movieDownloads.length} movie{movieDownloads.length === 1 ? '' : 's'} ·{' '}
            {episodeDownloads.length} episode{episodeDownloads.length === 1 ? '' : 's'} ·{' '}
            {formatBytes(usedStorageBytes)} stored offline
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          {/* Free vs Premium Download Engine Profile Selector */}
          <div
            role="group"
            aria-label="Download speed profile"
            className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none"
          >
            {(
              [
                { id: 'free', label: 'Standard' },
                { id: 'premium', label: 'Turbo' },
              ] as Array<{ id: DownloadProfileMode; label: string }>
            ).map((prof) => (
              <button
                key={prof.id}
                type="button"
                onClick={() => void setDownloadProfile(prof.id)}
                title={
                  prof.id === 'premium'
                    ? 'Premium profile: higher bounded concurrency & queue priority'
                    : 'Free profile: conservative connections & standard queue priority'
                }
                className={`inline-flex min-h-[38px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all ${
                  downloadProfile === prof.id
                    ? prof.id === 'premium'
                      ? 'bg-amber-500 text-slate-950 shadow-sm'
                      : 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {prof.id === 'premium' && <Zap className="h-3 w-3" />}
                <span>{prof.label}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none">
            {(
              [
                { id: 'all', label: `All (${allTabCount})` },
                { id: 'movies', label: `Movies (${moviesTabCount})` },
                { id: 'series', label: `Series (${unifiedSeriesGroups.length})` },
              ] as Array<{ id: DownloadFilter; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`min-h-[38px] rounded-lg px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                  filter === tab.id
                    ? 'bg-[#E11D48] text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Premium Turbo Engine Speed Enhancement Indicator */}
      {downloadProfile === 'premium' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/50 dark:border-amber-500/30 bg-amber-50/85 dark:bg-amber-950/25 px-4 py-2.5 text-xs sm:text-sm text-amber-950 dark:text-amber-200 tabular-nums">
          <div className="flex items-center gap-2 min-w-0">
            <Zap className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="font-semibold">
              {(() => {
                const stdSpeed = speedComparison?.standardBytesPerSec || 0;
                const measuredTurbo =
                  liveDownloadingSpeed > 0
                    ? liveDownloadingSpeed
                    : speedComparison?.turboBytesPerSec || 0;
                if (stdSpeed > 0 && measuredTurbo > 0) {
                  const diff = measuredTurbo - stdSpeed;
                  const pct = Math.round((diff / stdSpeed) * 100);
                  const mult = (measuredTurbo / stdSpeed).toFixed(1);
                  if (diff > 0) {
                    return `Premium Turbo Active: +${formatSpeed(diff)} (+${pct}% · ${mult}x faster than Standard ${formatSpeed(stdSpeed)} → ${formatSpeed(measuredTurbo)})`;
                  }
                  return `Premium Turbo Active: ${formatSpeed(measuredTurbo)} (Standard baseline ${formatSpeed(stdSpeed)})`;
                }
                if (measuredTurbo > 0) {
                  return `Premium Turbo Active: ${formatSpeed(measuredTurbo)} measured · 6x parallel connections & 16 MiB pipeline`;
                }
                return 'Premium Turbo Active · 6x parallel chunk connections & 16 MiB pipeline (1 file at a time)';
              })()}
            </span>
          </div>
          <span className="text-[11px] font-medium text-amber-800 dark:text-amber-300/90">
            {speedComparison?.standardBytesPerSec &&
            (liveDownloadingSpeed > 0 || speedComparison?.turboBytesPerSec)
              ? '1 file at a time · Live speed boost'
              : '1 file at a time · Speed boost shown while downloading'}
          </span>
        </div>
      )}

      {/* Offline / Out-of-data readiness notice */}
      {!isOnline && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-300/70 dark:border-amber-500/30 bg-amber-50/80 dark:bg-amber-950/30 px-4 py-3 text-xs sm:text-sm text-amber-900 dark:text-amber-200">
          <WifiOff className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            Offline mode active — all downloaded movies and episodes below remain stored on your
            device and play without mobile data or Wi-Fi.
          </span>
        </div>
      )}

      {/* Local Device Storage Indicator */}
      <section
        aria-label="Local device storage usage"
        className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-4 sm:p-5 shadow-sm shadow-slate-900/5 dark:shadow-none space-y-3.5"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-2.5">
            <HardDrive className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <div className="min-w-0">
              <h2 className="font-display text-sm sm:text-base font-semibold text-slate-900 dark:text-white">
                Device Storage
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400 tabular-nums">
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {formatBytes(cineboxUsedBytes)}
                </span>{' '}
                used by CineBox
                {availableBytes !== null && (
                  <>
                    {' · '}
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                      {formatBytes(availableBytes)}
                    </span>{' '}
                    available
                  </>
                )}
              </p>
            </div>
          </div>

          {(downloads.length > 0 || activeTasks.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
              {resumableTasksCount > 0 && (
                <button
                  type="button"
                  onClick={() => resumeAllDownloads()}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-3.5 text-xs font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Resume All ({resumableTasksCount})</span>
                </button>
              )}
              {runningOrQueuedCount > 0 && (
                <button
                  type="button"
                  onClick={() => pauseAllDownloads()}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-500/15 px-3.5 text-xs font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/25 transition-colors whitespace-nowrap shrink-0"
                >
                  <Pause className="h-3.5 w-3.5" />
                  <span>Pause All</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => void clearDownloads()}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/30 px-3.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear All Downloads</span>
              </button>
            </div>
          )}
        </div>

        {/* Segmented Capacity Bar */}
        <div
          role="progressbar"
          aria-label="CineBox local download storage"
          aria-valuemin={0}
          aria-valuemax={quotaBytes ?? Math.max(cineboxUsedBytes, 1)}
          aria-valuenow={cineboxUsedBytes}
          className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.08]"
        >
          {moviesBytes > 0 && (
            <div
              className="h-full bg-[#E11D48] transition-all duration-300"
              style={{
                width: `${moviesBarPct}%`,
                minWidth: '6px',
              }}
              title={`Movies: ${formatBytes(moviesBytes)}`}
            />
          )}
          {seriesBytes > 0 && (
            <div
              className="h-full bg-indigo-500 transition-all duration-300"
              style={{
                width: `${seriesBarPct}%`,
                minWidth: '6px',
              }}
              title={`Series: ${formatBytes(seriesBytes)}`}
            />
          )}
          {activeBufferBytes > 0 && (
            <div
              className="h-full bg-sky-500 transition-all duration-300"
              style={{
                width: `${activeBarPct}%`,
                minWidth: '6px',
              }}
              title={`Downloading: ${formatBytes(activeBufferBytes)}`}
            />
          )}
        </div>

        {/* Breakdown & Available Space Details */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400 tabular-nums">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px] bg-[#E11D48] shrink-0" aria-hidden="true" />
              <span>Movies {formatBytes(moviesBytes)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px] bg-indigo-500 shrink-0" aria-hidden="true" />
              <span>Series {formatBytes(seriesBytes)}</span>
            </span>
            {activeBufferBytes > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px] bg-sky-500 shrink-0" aria-hidden="true" />
                <span>In progress {formatBytes(activeBufferBytes)}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-[2px] bg-slate-200 dark:bg-white/20 shrink-0"
                aria-hidden="true"
              />
              <span>
                Available{' '}
                {availableBytes !== null ? formatBytes(availableBytes) : '—'}
              </span>
            </span>
          </div>

          <p className="text-slate-500 dark:text-slate-400">
            {hasQuota && usedPercentLabel !== null && quotaBytes !== null
              ? `${usedPercentLabel} of ${formatBytes(quotaBytes)} browser storage`
              : 'Available device quota unavailable in this browser'}
          </p>
        </div>

        {isLowStorage && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-300/80 dark:border-amber-500/30 bg-amber-50/80 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              Available browser storage is running low ({formatBytes(availableBytes || 0)} left).
              Remove watched movies or episodes to make room for new downloads.
            </span>
          </div>
        )}
      </section>

      {/* Active & Queued Movie Downloads */}
      {showMovies && activeMovieTasks.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Download className="h-4 w-4 text-[#E11D48]" />
            <span>Downloading Movies ({activeMovieTasks.length})</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {activeMovieTasks.map((task) => {
              const isError = task.status === 'error';
              const isPaused = task.status === 'paused';
              const isWaiting = Boolean(task.waitingForNetwork);
              const isDownloading = task.status === 'downloading';
              const isQueued = task.status === 'queued';
              const isSaving = task.status === 'saving';
              const statusText = isWaiting
                ? 'Waiting for internet...'
                : isPaused
                  ? `Paused · ${task.percent}%`
                  : isQueued
                    ? 'Queued'
                    : isSaving
                      ? 'Saving to offline storage...'
                      : isError
                        ? task.error || 'Interrupted'
                        : `${task.percent}%`;

              return (
                <article
                  key={task.key}
                  className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-4 shadow-sm shadow-slate-900/5 dark:shadow-none space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        <span className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                          <Film className="h-3.5 w-3.5 text-[#E11D48] shrink-0" />
                          <span>Movie</span>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                          {task.quality}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`inline-flex items-center gap-1 font-semibold ${
                            isError
                              ? 'text-rose-600 dark:text-rose-400'
                              : isPaused || isWaiting
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-sky-600 dark:text-sky-400'
                          }`}
                        >
                          {isError ? (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          ) : isPaused ? (
                            <Pause className="h-3.5 w-3.5 shrink-0" />
                          ) : isWaiting ? (
                            <WifiOff className="h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                          )}
                          <span>{statusText}</span>
                        </span>
                      </p>

                      <h3 className="mt-1 truncate font-display text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                        {task.title}
                      </h3>
                      {task.subtitle && (
                        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                          {task.subtitle}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {(isPaused || isError) && (
                        <button
                          type="button"
                          onClick={() => void resumeDownload(task.key)}
                          aria-label={`Resume ${task.title}`}
                          title="Resume download"
                          className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-3 text-xs font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors whitespace-nowrap"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>Resume</span>
                        </button>
                      )}
                      {(isDownloading || isQueued) && (
                        <button
                          type="button"
                          onClick={() => pauseDownload(task.key)}
                          aria-label={`Pause ${task.title}`}
                          title="Pause download"
                          className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-500/15 px-3 text-xs font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/25 transition-colors whitespace-nowrap"
                        >
                          <Pause className="h-3.5 w-3.5" />
                          <span>Pause</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => cancelDownload(task.key)}
                        aria-label={isError ? `Dismiss ${task.title}` : `Cancel ${task.title}`}
                        title={isError ? 'Dismiss' : 'Cancel download'}
                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {(!isError || task.receivedBytes > 0 || task.totalBytes > 0) && (
                    <div className="space-y-1.5">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            isPaused || isWaiting || isError
                              ? 'bg-amber-500'
                              : 'bg-[#E11D48]'
                          }`}
                          style={{
                            width: `${isQueued ? 4 : Math.max(4, task.percent)}%`,
                          }}
                        />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300 tabular-nums">
                        <span className="font-medium">{formatTaskProgressSize(task)}</span>
                        <span className="inline-flex flex-wrap items-center justify-end gap-1.5 font-mono font-semibold text-slate-800 dark:text-slate-200">
                          {isPaused
                            ? `Paused at ${task.percent}%`
                            : isWaiting
                              ? `Paused offline · ${task.percent}%`
                              : isDownloading && task.speedBytesPerSec > 0
                                ? `${formatSpeed(task.speedBytesPerSec)} · ${task.percent}%${
                                    task.etaSeconds ? ` · ${formatEta(task.etaSeconds)}` : ''
                                  }`
                                : isSaving
                                  ? 'Verifying & saving...'
                                  : isQueued
                                    ? 'Waiting in queue'
                                    : `${task.percent}%`}
                          {downloadProfile === 'premium' && isDownloading && task.speedBytesPerSec > 0 && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                              <Zap className="h-2.5 w-2.5 shrink-0" />
                              <span>
                                {getTurboBoostBadgeText(
                                  task.speedBytesPerSec,
                                  speedComparison?.standardBytesPerSec,
                                ) || 'Turbo'}
                              </span>
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* Unified Series Downloads & Library (Single Card per Series) */}
      {showSeries && unifiedSeriesGroups.length > 0 && (
        <section className="space-y-3.5">
          <h2 className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Tv className="h-4 w-4 text-indigo-500" />
            <span>Series Downloads ({unifiedSeriesGroups.length})</span>
          </h2>

          <div className="space-y-4">
            {unifiedSeriesGroups.map((group) => {
              const isExpanded = expandedSeriesKeys.has(group.groupKey);
              const activeCount = group.downloading.length + group.paused.length + group.queued.length;
              const summaryQueueList = [...group.downloading, ...group.paused, ...group.queued];

              return (
                <article
                  key={group.groupKey}
                  className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] shadow-sm shadow-slate-900/5 dark:shadow-none overflow-hidden transition-colors hover:border-indigo-300/80 dark:hover:border-white/20"
                >
                  {/* Clickable Card Summary Header (Expands/Collapses) */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => toggleSeriesExpanded(group.groupKey)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleSeriesExpanded(group.groupKey);
                      }
                    }}
                    className="w-full cursor-pointer p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E11D48] space-y-3.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="w-14 sm:w-16 aspect-[2/3] shrink-0 overflow-hidden rounded-lg border border-slate-200/70 dark:border-white/5 bg-slate-100 dark:bg-[#090B10]">
                          <OfflinePoster
                            poster={group.poster}
                            posterBlob={group.posterBlob}
                            title={group.seriesTitle}
                            year={group.year}
                            className="h-full w-full"
                          />
                        </div>
                        <div className="min-w-0">
                          <h3 className="truncate font-display text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                            {group.seriesTitle}
                          </h3>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 dark:text-slate-400 tabular-nums">
                            {group.downloading.length > 0 && (
                              <span className="font-semibold text-sky-600 dark:text-sky-400">
                                {group.downloading.length} downloading
                              </span>
                            )}
                            {group.downloading.length > 0 &&
                              (group.paused.length > 0 || group.queued.length > 0 || group.completed.length > 0) && (
                                <span aria-hidden="true">·</span>
                              )}
                            {group.paused.length > 0 && (
                              <span className="font-semibold text-amber-600 dark:text-amber-400">
                                {group.paused.length} paused
                              </span>
                            )}
                            {group.paused.length > 0 &&
                              (group.queued.length > 0 || group.completed.length > 0) && (
                                <span aria-hidden="true">·</span>
                              )}
                            {group.queued.length > 0 && (
                              <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                                {group.queued.length} queued
                              </span>
                            )}
                            {group.queued.length > 0 && group.completed.length > 0 && (
                              <span aria-hidden="true">·</span>
                            )}
                            {group.completed.length > 0 && (
                              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                                {group.completed.length} complete
                              </span>
                            )}
                            {group.completedBytes > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{formatBytes(group.completedBytes)} saved</span>
                              </>
                            )}
                            {group.activeTotalBytes > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>
                                  {formatBytes(group.activeReceivedBytes)} /{' '}
                                  {group.activeTotalEstimated ? '~' : ''}
                                  {formatBytes(group.activeTotalBytes)}
                                </span>
                              </>
                            )}
                            {group.categoryName && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="truncate">{group.categoryName}</span>
                              </>
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeSeriesGroup(group);
                          }}
                          aria-label={`Remove ${group.seriesTitle} downloads`}
                          title="Remove series downloads"
                          className="inline-flex h-10 w-10 sm:w-auto sm:px-3 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors whitespace-nowrap"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Delete Series</span>
                        </button>
                        <span
                          aria-hidden="true"
                          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200/80 dark:border-white/10 bg-slate-50 dark:bg-black/30 text-slate-600 dark:text-slate-300"
                        >
                          {isExpanded ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Aggregate Active Series Progress Bar */}
                    {group.hasActiveDownloads && (
                      <div className="space-y-1.5">
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              group.waitingForNetwork || (group.paused.length > 0 && group.downloading.length === 0)
                                ? 'bg-amber-500'
                                : 'bg-[#E11D48]'
                            }`}
                            style={{
                              width: `${Math.max(4, group.overallProgressPct)}%`,
                            }}
                          />
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300 tabular-nums">
                          <span>
                            {group.waitingForNetwork
                              ? 'Waiting for internet to resume...'
                              : group.downloading.length > 0
                                ? `Downloading ${activeCount} episode${activeCount === 1 ? '' : 's'}`
                                : group.paused.length > 0 && group.queued.length === 0
                                  ? `${group.paused.length} episode${group.paused.length === 1 ? '' : 's'} paused · Expand to resume`
                                  : `${group.queued.length} episode${group.queued.length === 1 ? '' : 's'} queued`}
                            {group.activeTotalBytes > 0
                              ? ` · ${formatBytes(group.activeReceivedBytes)} / ${group.activeTotalEstimated ? '~' : ''}${formatBytes(group.activeTotalBytes)}`
                              : group.activeReceivedBytes > 0
                                ? ` · ${formatBytes(group.activeReceivedBytes)}`
                                : ''}
                          </span>
                          <span className="inline-flex flex-wrap items-center justify-end gap-1.5 font-mono font-semibold text-slate-800 dark:text-slate-200">
                            {group.liveSpeedBytesPerSec > 0
                              ? `${formatSpeed(group.liveSpeedBytesPerSec)} · ${group.overallProgressPct}%`
                              : `${group.overallProgressPct}%`}
                            {downloadProfile === 'premium' &&
                              group.downloading.length > 0 &&
                              group.liveSpeedBytesPerSec > 0 && (
                                <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                                  <Zap className="h-2.5 w-2.5 shrink-0" />
                                  <span>
                                    {getTurboBoostBadgeText(
                                      group.liveSpeedBytesPerSec,
                                      speedComparison?.standardBytesPerSec,
                                    ) || 'Turbo'}
                                  </span>
                                </span>
                              )}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Collapsed View: List of Queued / Paused / Active Episodes Preview */}
                    {!isExpanded && summaryQueueList.length > 0 && (
                      <div className="border-t border-slate-200/70 dark:border-white/[0.06] pt-3 space-y-1.5">
                        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                          Queue ({summaryQueueList.length}) · Click card to expand
                        </p>
                        <ul className="divide-y divide-slate-200/60 dark:divide-white/[0.05] rounded-lg border border-slate-200/70 dark:border-white/[0.06] bg-slate-50/70 dark:bg-[#0B0E15] px-3">
                          {summaryQueueList.map((task) => {
                            const epCode =
                              task.seasonNum && task.episodeNum
                                ? `S${String(task.seasonNum).padStart(2, '0')}E${String(task.episodeNum).padStart(2, '0')}`
                                : 'Episode';
                            const isError = task.status === 'error';
                            const isPausedTask = task.status === 'paused';
                            const isWait = Boolean(task.waitingForNetwork);
                            const isActiveTask =
                              task.status === 'downloading' || task.status === 'saving';
                            const sizeText = formatTaskProgressSize(task);
                            return (
                              <li
                                key={task.key}
                                className="flex items-center justify-between gap-3 py-2 text-xs tabular-nums"
                              >
                                <div className="min-w-0 flex-1 flex items-center gap-2">
                                  <span className="font-mono font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                                    {epCode}
                                  </span>
                                  <span className="truncate font-medium text-slate-900 dark:text-white">
                                    {task.subtitle || task.title}
                                  </span>
                                </div>
                                <span
                                  className={`shrink-0 font-semibold ${
                                    isError
                                      ? 'text-rose-600 dark:text-rose-400'
                                      : isPausedTask || isWait
                                        ? 'text-amber-600 dark:text-amber-400'
                                        : isActiveTask
                                          ? 'text-sky-600 dark:text-sky-400'
                                          : 'text-slate-500 dark:text-slate-400'
                                  }`}
                                >
                                  {isPausedTask
                                    ? `${sizeText} · Paused`
                                    : isError
                                      ? 'Interrupted · Expand to resume'
                                      : isWait
                                        ? `${sizeText} · Waiting`
                                        : task.status === 'saving'
                                          ? 'Saving...'
                                          : task.status === 'downloading'
                                            ? `${sizeText} · ${task.percent}%`
                                            : `${sizeText} · Queued`}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Expanded Breakdown: Completed (Playable) -> Downloading (Progress) -> Queued */}
                  {isExpanded && (
                    <div className="border-t border-slate-200/80 dark:border-white/[0.08] bg-slate-50/50 dark:bg-[#0B0E15]/60 px-4 py-4 space-y-5">
                      {/* 1. Completed Episodes (Clickable -> Instant Offline Media Player) */}
                      {group.completed.length > 0 && (
                        <div className="space-y-2">
                          <h4 className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5 tabular-nums">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                            <span>Complete ({group.completed.length})</span>
                          </h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                            {group.completed.map((ep) => {
                              const epCode =
                                ep.seasonNum && ep.episodeNum
                                  ? `S${String(ep.seasonNum).padStart(2, '0')}E${String(ep.episodeNum).padStart(2, '0')}`
                                  : 'Episode';
                              const tStatus = ep.transferStatus || 'not_exported';
                              const isTransferring = tStatus === 'transferring';
                              const isExported = tStatus === 'exported';
                              const isTransferFailed = tStatus === 'transfer_failed';
                              const infoOpen = expandedInfoKeys.has(ep.key);
                              return (
                                <div
                                  key={ep.key}
                                  className="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-2.5 hover:border-emerald-400/70 dark:hover:border-emerald-500/40 transition-colors space-y-2"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <button
                                      type="button"
                                      onClick={() => openOfflineEpisode(ep)}
                                      className="flex min-w-0 flex-1 items-center gap-3 text-left min-h-[44px]"
                                    >
                                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E11D48] text-white">
                                        <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums truncate">
                                          {epCode} · {ep.quality || 'HD'} · {formatBytes(ep.sizeBytes)}
                                          {isExported
                                            ? ' · Exported'
                                            : isTransferring
                                              ? ` · Transferring ${ep.transferProgress ?? 0}%`
                                              : isTransferFailed
                                                ? ' · Transfer failed'
                                                : ''}
                                        </p>
                                        <p className="truncate text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
                                          {ep.subtitle || ep.title}
                                        </p>
                                      </div>
                                    </button>

                                    <div className="flex items-center gap-1 shrink-0">
                                      <button
                                        type="button"
                                        onClick={() => toggleInfoExpanded(ep.key)}
                                        aria-label={`Download information for ${epCode}`}
                                        title="Download information"
                                        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                                          infoOpen
                                            ? 'bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300'
                                            : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10'
                                        }`}
                                      >
                                        <Info className="h-4 w-4" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => void removeDownload(ep.key)}
                                        aria-label={`Delete ${epCode}`}
                                        title="Delete private offline copy"
                                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </button>
                                    </div>
                                  </div>

                                  {/* Stage 2 Transfer Controls for Completed Episode */}
                                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200/60 dark:border-white/[0.06]">
                                    <span
                                      className={`text-[11px] font-medium tabular-nums ${
                                        isExported
                                          ? 'text-emerald-600 dark:text-emerald-400'
                                          : isTransferring
                                            ? 'text-sky-600 dark:text-sky-400'
                                            : isTransferFailed
                                              ? 'text-rose-600 dark:text-rose-400'
                                              : 'text-slate-500 dark:text-slate-400'
                                      }`}
                                    >
                                      {isExported
                                        ? 'Exported to local storage'
                                        : isTransferring
                                          ? `Transferring (${ep.transferProgress ?? 0}%)...`
                                          : isTransferFailed
                                            ? ep.transferError || 'Transfer failed'
                                            : 'Not exported'}
                                    </span>

                                    <div className="flex items-center gap-1.5">
                                      {!isExported && (
                                        <button
                                          type="button"
                                          disabled={isTransferring}
                                          onClick={() => void transferDownload(ep.key).catch(() => {})}
                                          className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-2.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 disabled:opacity-55 transition-colors whitespace-nowrap"
                                        >
                                          {isTransferring ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                          ) : (
                                            <FolderOutput className="h-3 w-3" />
                                          )}
                                          <span>
                                            {isTransferFailed
                                              ? 'Retry Transfer'
                                              : isTransferring
                                                ? 'Transferring...'
                                                : 'Transfer to Local Storage'}
                                          </span>
                                        </button>
                                      )}
                                      {isExported && (
                                        <button
                                          type="button"
                                          onClick={() => void deleteExportedCopy(ep.key)}
                                          title="Delete exported public copy while keeping private offline download"
                                          className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-2.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:border-rose-300 hover:text-rose-600 transition-colors whitespace-nowrap"
                                        >
                                          <span>Remove Exported Copy</span>
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {infoOpen && (
                                    <div className="rounded-md bg-slate-50 dark:bg-[#0B0E15] px-2.5 py-2 text-[11px] text-slate-600 dark:text-slate-300 space-y-0.5 tabular-nums">
                                      <p>
                                        <span className="text-slate-500">Quality &amp; Format:</span>{' '}
                                        {ep.quality || 'HD'} · {(ep.extension || 'mp4').toUpperCase()} ({formatBytes(ep.sizeBytes)})
                                      </p>
                                      <p className="truncate">
                                        <span className="text-slate-500">Offline Storage:</span>{' '}
                                        {ep.privateFilePath || ep.localFileUri || 'Offline IndexedDB library'}
                                      </p>
                                      {ep.exportedPath && (
                                        <p className="truncate">
                                          <span className="text-slate-500">Local Storage:</span>{' '}
                                          {ep.exportedPath}
                                        </p>
                                      )}
                                      <p>
                                        <span className="text-slate-500">Saved:</span>{' '}
                                        {formatRelativeTime(ep.downloadedAt)}
                                      </p>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* 2. Currently Downloading Episodes (Live Progress) */}
                      {group.downloading.length > 0 && (
                        <div className="space-y-2">
                          <h4 className="text-xs font-semibold text-sky-700 dark:text-sky-400 flex items-center gap-1.5 tabular-nums">
                            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                            <span>Downloading ({group.downloading.length})</span>
                          </h4>
                          <div className="space-y-2.5">
                            {group.downloading.map((task) => {
                              const epCode =
                                task.seasonNum && task.episodeNum
                                  ? `S${String(task.seasonNum).padStart(2, '0')}E${String(task.episodeNum).padStart(2, '0')}`
                                  : 'Episode';
                              const isWaiting = Boolean(task.waitingForNetwork);
                              const isSaving = task.status === 'saving';
                              return (
                                <div
                                  key={task.key}
                                  className="rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3 space-y-2"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                      <p className="text-[11px] font-semibold text-sky-600 dark:text-sky-400 tabular-nums">
                                        {epCode} · {task.quality} ·{' '}
                                        {isWaiting
                                          ? `Waiting for internet (${task.percent}%)`
                                          : isSaving
                                            ? 'Saving offline copy...'
                                            : `${task.percent}%`}
                                      </p>
                                      <p className="truncate text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
                                        {task.subtitle || task.title}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      {!isSaving && (
                                        <button
                                          type="button"
                                          onClick={() => pauseDownload(task.key)}
                                          aria-label={`Pause ${epCode}`}
                                          title="Pause download"
                                          className="inline-flex h-10 items-center gap-1 rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-500/15 px-2.5 text-xs font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/25 transition-colors whitespace-nowrap"
                                        >
                                          <Pause className="h-3.5 w-3.5" />
                                          <span>Pause</span>
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => cancelDownload(task.key)}
                                        aria-label={`Cancel ${epCode}`}
                                        title="Cancel download"
                                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                                      >
                                        <X className="h-4 w-4" />
                                      </button>
                                    </div>
                                  </div>

                                  <div className="space-y-1">
                                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                                      <div
                                        className={`h-full rounded-full transition-all duration-300 ${
                                          isWaiting
                                            ? 'bg-amber-500'
                                            : 'bg-[#E11D48]'
                                        }`}
                                        style={{ width: `${Math.max(4, task.percent)}%` }}
                                      />
                                    </div>
                                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                                      <span className="font-medium">
                                        {formatTaskProgressSize(task)}
                                      </span>
                                      <span className="inline-flex flex-wrap items-center justify-end gap-1.5 font-mono font-semibold text-slate-700 dark:text-slate-300">
                                        {isWaiting
                                          ? 'Paused offline'
                                          : task.speedBytesPerSec > 0
                                            ? `${formatSpeed(task.speedBytesPerSec)}${
                                                task.etaSeconds ? ` · ${formatEta(task.etaSeconds)}` : ''
                                              }`
                                            : isSaving
                                              ? 'Verifying & saving...'
                                              : `${task.percent}%`}
                                        {downloadProfile === 'premium' &&
                                          !isWaiting &&
                                          !isSaving &&
                                          task.speedBytesPerSec > 0 && (
                                            <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                                              <Zap className="h-2.5 w-2.5 shrink-0" />
                                              <span>
                                                {getTurboBoostBadgeText(
                                                  task.speedBytesPerSec,
                                                  speedComparison?.standardBytesPerSec,
                                                ) || 'Turbo'}
                                              </span>
                                            </span>
                                          )}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* 3. Paused / Interrupted Episodes (Resume from saved offset) */}
                      {group.paused.length > 0 && (
                        <div className="space-y-2">
                          <h4 className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1.5 tabular-nums">
                            <Pause className="h-3.5 w-3.5 shrink-0" />
                            <span>Paused ({group.paused.length})</span>
                          </h4>
                          <div className="space-y-2.5">
                            {group.paused.map((task) => {
                              const epCode =
                                task.seasonNum && task.episodeNum
                                  ? `S${String(task.seasonNum).padStart(2, '0')}E${String(task.episodeNum).padStart(2, '0')}`
                                  : 'Episode';
                              const isError = task.status === 'error';
                              return (
                                <div
                                  key={task.key}
                                  className="rounded-lg border border-amber-300/60 dark:border-amber-500/25 bg-white dark:bg-[#111520] p-3 space-y-2"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                      <p
                                        className={`text-[11px] font-semibold tabular-nums ${
                                          isError
                                            ? 'text-rose-600 dark:text-rose-400'
                                            : 'text-amber-600 dark:text-amber-400'
                                        }`}
                                      >
                                        {epCode} · {task.quality} ·{' '}
                                        {isError
                                          ? task.error || 'Interrupted'
                                          : `Paused (${task.percent}%)`}
                                      </p>
                                      <p className="truncate text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
                                        {task.subtitle || task.title}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <button
                                        type="button"
                                        onClick={() => void resumeDownload(task.key)}
                                        aria-label={`Resume ${epCode}`}
                                        title="Resume download"
                                        className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-3 text-xs font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors whitespace-nowrap"
                                      >
                                        <RotateCcw className="h-3.5 w-3.5" />
                                        <span>Resume</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => cancelDownload(task.key)}
                                        aria-label={`Cancel ${epCode}`}
                                        title="Cancel download"
                                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                                      >
                                        <X className="h-4 w-4" />
                                      </button>
                                    </div>
                                  </div>
                                  {(task.receivedBytes > 0 || task.totalBytes > 0) && (
                                    <div className="space-y-1">
                                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                                        <div
                                          className="h-full rounded-full bg-amber-500 transition-all duration-300"
                                          style={{ width: `${Math.max(4, task.percent)}%` }}
                                        />
                                      </div>
                                      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                                        <span>{formatTaskProgressSize(task)}</span>
                                        <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">
                                          {task.percent}%
                                        </span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* 4. Queued Episodes */}
                      {group.queued.length > 0 && (
                        <div className="space-y-2">
                          <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-400 flex items-center gap-1.5 tabular-nums">
                            <Clock className="h-3.5 w-3.5 shrink-0" />
                            <span>Queued ({group.queued.length})</span>
                          </h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                            {group.queued.map((task) => {
                              const epCode =
                                task.seasonNum && task.episodeNum
                                  ? `S${String(task.seasonNum).padStart(2, '0')}E${String(task.episodeNum).padStart(2, '0')}`
                                  : 'Episode';
                              const isWaiting = Boolean(task.waitingForNetwork);
                              return (
                                <div
                                  key={task.key}
                                  className="flex items-center justify-between gap-2.5 rounded-lg border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-2.5"
                                >
                                  <div className="min-w-0 flex-1 pl-1">
                                    <p
                                      className={`text-[11px] font-semibold tabular-nums ${
                                        isWaiting
                                          ? 'text-amber-600 dark:text-amber-400'
                                          : 'text-slate-500 dark:text-slate-400'
                                      }`}
                                    >
                                      {epCode} · {task.quality} ·{' '}
                                      {isWaiting
                                        ? 'Waiting for internet'
                                        : task.receivedBytes > 0
                                          ? `Queued (${task.percent}%)`
                                          : 'Queued'}{' '}
                                      · {formatTaskProgressSize(task)}
                                    </p>
                                    <p className="truncate text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
                                      {task.subtitle || task.title}
                                    </p>
                                  </div>

                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => pauseDownload(task.key)}
                                      aria-label={`Pause ${epCode}`}
                                      title="Pause queued episode"
                                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-500/15 dark:hover:text-amber-300 transition-colors"
                                    >
                                      <Pause className="h-4 w-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => cancelDownload(task.key)}
                                      aria-label={`Remove ${epCode} from queue`}
                                      title="Cancel queued episode"
                                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                                    >
                                      <X className="h-4 w-4" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Card Footer: Download More Button always at the end of the Series Card */}
                  {group.seriesId && (
                    <div className="flex items-center justify-between gap-3 border-t border-slate-200/80 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#0E121B] px-4 py-3">
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {isExpanded ? 'Click card header to collapse' : 'Tap card to expand episodes'}
                      </span>
                      <button
                        type="button"
                        onClick={() => openDownloadMoreForSeries(group)}
                        aria-label={`Download more episodes of ${group.seriesTitle}`}
                        className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-4 text-xs font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors whitespace-nowrap"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Download More</span>
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* Empty State */}
      {ready && downloads.length === 0 && activeTasks.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-10 sm:p-14 text-center">
          <Download className="mx-auto h-9 w-9 text-slate-400 dark:text-slate-500" />
          <h2 className="mt-3 font-display text-lg font-bold text-slate-900 dark:text-white">
            No Downloads Saved Yet
          </h2>
          <p className="mt-1.5 mx-auto max-w-md text-sm text-slate-600 dark:text-slate-400">
            Open any movie or series and choose Download in 360p, 720p, or 1080p. Saved titles
            stay playable here even when you are offline or out of data.
          </p>
          {onBrowseCatalog && isOnline && (
            <button
              type="button"
              onClick={onBrowseCatalog}
              className="mt-5 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-[#E11D48] px-5 text-sm font-semibold text-white hover:bg-[#be123c] transition-colors"
            >
              <span>Browse Movies &amp; Series</span>
            </button>
          )}
        </div>
      )}

      {/* Downloaded Movies Section */}
      {showMovies && movieDownloads.length > 0 && (
        <section className="space-y-3.5">
          <h2 className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Film className="h-4 w-4 text-[#E11D48]" />
            <span>Downloaded Movies ({movieDownloads.length})</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {movieDownloads.map((entry) => {
              const tStatus = entry.transferStatus || 'not_exported';
              const isTransferring = tStatus === 'transferring';
              const isExported = tStatus === 'exported';
              const isTransferFailed = tStatus === 'transfer_failed';
              const infoOpen = expandedInfoKeys.has(entry.key);

              return (
                <article
                  key={entry.key}
                  className="cinebox-card-elevated group flex flex-col gap-3 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3.5 shadow-sm shadow-slate-900/5 dark:shadow-none hover:border-emerald-400/60 dark:hover:border-emerald-500/40"
                >
                  <div className="flex gap-3.5">
                    <button
                      type="button"
                      onClick={() => openOfflineMovie(entry)}
                      aria-label={`Play ${entry.title} offline`}
                      className="relative w-20 sm:w-24 aspect-[2/3] shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-[#090B10] border border-slate-200/70 dark:border-white/5"
                    >
                      <OfflinePoster
                        poster={entry.poster}
                        posterBlob={entry.posterBlob}
                        title={entry.title}
                        year={entry.year}
                        className="h-full w-full"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-950 shadow">
                          <Play className="h-4 w-4 fill-current ml-0.5" />
                        </span>
                      </div>
                    </button>

                    <div className="min-w-0 flex-1 flex flex-col justify-between gap-2">
                      <div>
                        <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                          {entry.quality || 'HD'} · {formatBytes(entry.sizeBytes)} ·{' '}
                          {(entry.extension || 'mp4').toUpperCase()}
                        </p>
                        <h3 className="mt-0.5 line-clamp-1 font-display text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                          {entry.title}
                        </h3>
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums truncate">
                          {entry.categoryName}
                          {entry.subtitles && entry.subtitles.length > 0
                            ? ` · ${entry.subtitles.length} sub${entry.subtitles.length > 1 ? 's' : ''}`
                            : ''}
                          {` · ${formatRelativeTime(entry.downloadedAt)}`}
                        </p>
                        <p
                          className={`mt-1 text-[11px] font-semibold tabular-nums truncate ${
                            isExported
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : isTransferring
                                ? 'text-sky-600 dark:text-sky-400'
                                : isTransferFailed
                                  ? 'text-rose-600 dark:text-rose-400'
                                  : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {isExported
                            ? 'Exported to local storage'
                            : isTransferring
                              ? `Transferring (${entry.transferProgress ?? 0}%)...`
                              : isTransferFailed
                                ? entry.transferError || 'Transfer failed'
                                : 'Not exported'}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => openOfflineMovie(entry)}
                          className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-3 text-xs font-semibold text-white hover:bg-[#be123c] transition-colors whitespace-nowrap"
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                          <span>Play Offline</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleInfoExpanded(entry.key)}
                          aria-label={`Download information for ${entry.title}`}
                          title="Download information"
                          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                            infoOpen
                              ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300'
                              : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10'
                          }`}
                        >
                          <Info className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeDownload(entry.key)}
                          aria-label={`Delete ${entry.title} offline copy`}
                          title="Delete offline copy"
                          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Stage 2 Action Row: Transfer to Local Storage / Independent Exported Delete */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/70 dark:border-white/[0.06] pt-2.5">
                    {!isExported ? (
                      <button
                        type="button"
                        disabled={isTransferring}
                        onClick={() => void transferDownload(entry.key).catch(() => {})}
                        className="inline-flex min-h-[36px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-3 text-xs font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 disabled:opacity-55 transition-colors whitespace-nowrap"
                      >
                        {isTransferring ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FolderOutput className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {isTransferFailed
                            ? 'Retry Transfer to Local Storage'
                            : isTransferring
                              ? `Transferring (${entry.transferProgress ?? 0}%)...`
                              : 'Transfer to Local Storage'}
                        </span>
                      </button>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Exported</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => void deleteExportedCopy(entry.key)}
                          title="Delete exported public copy independently while keeping CineBox offline download"
                          className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-rose-300 hover:text-rose-600 transition-colors whitespace-nowrap"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>Remove Local Copy</span>
                        </button>
                      </>
                    )}
                  </div>

                  {infoOpen && (
                    <div className="rounded-lg bg-slate-50 dark:bg-[#0B0E15] px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300 space-y-1 tabular-nums">
                      <p>
                        <span className="text-slate-500">Quality &amp; Format:</span>{' '}
                        {entry.quality || 'HD'} · {(entry.extension || 'mp4').toUpperCase()} ({formatBytes(entry.sizeBytes)})
                      </p>
                      <p className="truncate">
                        <span className="text-slate-500">Offline Storage:</span>{' '}
                        {entry.privateFilePath || entry.localFileUri || 'Offline IndexedDB library'}
                      </p>
                      {entry.exportedPath && (
                        <p className="truncate">
                          <span className="text-slate-500">Local Storage:</span>{' '}
                          {entry.exportedPath}
                        </p>
                      )}
                      <p>
                        <span className="text-slate-500">Status:</span>{' '}
                        Offline Storage (Verified)
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
