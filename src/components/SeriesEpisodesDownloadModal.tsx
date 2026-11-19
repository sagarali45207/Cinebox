import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  HardDrive,
  Layers,
  Loader2,
  Pause,
  RotateCcw,
  X,
} from 'lucide-react';
import { fetchDownloadSizes, fetchSeriesDetail } from '../services/api';
import type {
  DownloadQuality,
  DownloadSizesResponse,
  EpisodeSummary,
  OfflineDownloadEntry,
  OfflineDownloadTaskState,
  SeriesDetail,
  SeriesSummary,
} from '../types/media';
import { parseDurationHintToSeconds } from '../utils/format';
import { formatBytes, formatSpeed } from '../utils/offlineDb';
import { useOfflineDownloads } from '../utils/offlineManager';
import { MediaImage } from './MediaImage';

interface SeriesEpisodesDownloadModalProps {
  open?: boolean;
  series?: SeriesSummary | null;
  seriesDetail?: SeriesDetail | null;
  initialSeason?: string;
  onClose: () => void;
  onOpenDownloads?: () => void;
}

const QUALITY_TABS: Array<{
  id: DownloadQuality;
  label: string;
  tier: string;
  bytesPerSec: number;
  fallbackPerHour: string;
}> = [
  {
    id: '360p',
    label: '360p',
    tier: 'Data Saver',
    bytesPerSec: 90_000,
    fallbackPerHour: '~320 MB/hr',
  },
  {
    id: '480p',
    label: '480p',
    tier: 'Standard SD',
    bytesPerSec: 150_000,
    fallbackPerHour: '~540 MB/hr',
  },
  {
    id: '720p',
    label: '720p',
    tier: 'HD Recommended',
    bytesPerSec: 220_000,
    fallbackPerHour: '~790 MB/hr',
  },
  {
    id: '1080p',
    label: '1080p',
    tier: 'Full HD',
    bytesPerSec: 460_000,
    fallbackPerHour: '~1.6 GB/hr',
  },
];

function resolveEpisodeSeconds(ep: EpisodeSummary, fallbackRunTime?: string): number {
  if (ep.durationSec && ep.durationSec > 0) return ep.durationSec;
  return parseDurationHintToSeconds(ep.duration || fallbackRunTime);
}

export function SeriesEpisodesDownloadModal({
  open,
  series,
  seriesDetail,
  initialSeason,
  onClose,
  onOpenDownloads,
}: SeriesEpisodesDownloadModalProps) {
  const isOpen = open !== undefined ? open : Boolean(series || seriesDetail);
  const headerSource = seriesDetail || series;

  const [fetchedDetail, setFetchedDetail] = useState<SeriesDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryNonce, setRetryNonce] = useState(0);

  const [activeQuality, setActiveQuality] = useState<DownloadQuality>('720p');
  const [selectedSeason, setSelectedSeason] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [queuedNotice, setQueuedNotice] = useState<{
    count: number;
    quality: DownloadQuality;
  } | null>(null);
  const [probedSample, setProbedSample] = useState<{
    episodeId: string;
    data: DownloadSizesResponse;
  } | null>(null);

  const { downloads, tasks, queueDownload, pauseDownload, resumeDownload } = useOfflineDownloads();

  const detail = seriesDetail || fetchedDetail;

  const downloadsMap = useMemo(() => {
    const map = new Map<string, OfflineDownloadEntry>();
    for (const item of downloads) {
      map.set(item.key, item);
    }
    return map;
  }, [downloads]);

  const tasksMap = useMemo(() => {
    const map = new Map<string, OfflineDownloadTaskState>();
    for (const [k, v] of Object.entries(tasks)) {
      map.set(k, v);
    }
    return map;
  }, [tasks]);

  useEffect(() => {
    if (!isOpen) {
      setFetchedDetail(null);
      setError('');
      setSelectedSeason('');
      setSelectedIds(new Set());
      setQueuedNotice(null);
      return;
    }

    if (seriesDetail) {
      const keys = Object.keys(seriesDetail.episodesBySeason || {}).sort(
        (a, b) => Number(a) - Number(b),
      );
      setFetchedDetail(null);
      setLoading(false);
      setError('');
      setSelectedSeason(
        initialSeason && keys.includes(initialSeason) ? initialSeason : keys[0] || '',
      );
      setSelectedIds(new Set());
      setQueuedNotice(null);
      return;
    }

    if (!series) return;

    const controller = new AbortController();
    setLoading(true);
    setError('');
    setFetchedDetail(null);
    setSelectedSeason('');
    setSelectedIds(new Set());
    setQueuedNotice(null);

    fetchSeriesDetail(series.seriesId, controller.signal)
      .then((res) => {
        setFetchedDetail(res);
        const keys = Object.keys(res.episodesBySeason || {}).sort((a, b) => Number(a) - Number(b));
        setSelectedSeason(
          initialSeason && keys.includes(initialSeason) ? initialSeason : keys[0] || '',
        );
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setError(err.message || 'Unable to load series episodes');
        setLoading(false);
      });

    return () => controller.abort();
  }, [isOpen, series, seriesDetail, initialSeason, retryNonce]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const seasonKeys = useMemo(() => {
    if (!detail) return [];
    return Object.keys(detail.episodesBySeason || {}).sort((a, b) => Number(a) - Number(b));
  }, [detail]);

  const visibleEpisodes: EpisodeSummary[] = useMemo(() => {
    if (!detail) return [];
    if (selectedSeason === 'all') {
      return seasonKeys.flatMap((sk) => detail.episodesBySeason[sk] || []);
    }
    if (!selectedSeason) return [];
    return detail.episodesBySeason[selectedSeason] || [];
  }, [detail, seasonKeys, selectedSeason]);

  const representativeEpisode = useMemo(() => {
    if (!detail) return null;
    const downloadableFirst = visibleEpisodes.find((ep) => Boolean(ep.playUrl));
    if (downloadableFirst) return downloadableFirst;
    for (const sk of seasonKeys) {
      const first = (detail.episodesBySeason[sk] || []).find((ep) => Boolean(ep.playUrl));
      if (first) return first;
    }
    return null;
  }, [detail, seasonKeys, visibleEpisodes]);

  useEffect(() => {
    if (!isOpen || !representativeEpisode) {
      if (!isOpen) setProbedSample(null);
      return;
    }
    if (probedSample?.episodeId === representativeEpisode.episodeId) return;

    const controller = new AbortController();
    const durationHint = resolveEpisodeSeconds(
      representativeEpisode,
      detail?.episodeRunTime,
    );

    fetchDownloadSizes(
      {
        kind: 'episode',
        id: representativeEpisode.episodeId,
        ext: representativeEpisode.extension,
        durationSec: durationHint > 0 ? durationHint : undefined,
      },
      controller.signal,
    )
      .then((res) => {
        setProbedSample({
          episodeId: representativeEpisode.episodeId,
          data: res,
        });
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
      });

    return () => controller.abort();
  }, [
    isOpen,
    representativeEpisode,
    detail?.episodeRunTime,
    probedSample?.episodeId,
  ]);

  const activeQualityMeta = useMemo(
    () => QUALITY_TABS.find((q) => q.id === activeQuality) || QUALITY_TABS[2],
    [activeQuality],
  );

  const resolveEpisodeEstimatedSize = (
    ep: EpisodeSummary,
    quality: DownloadQuality,
  ): { bytes: number; exact: boolean } => {
    const qKey = quality as '360p' | '480p' | '720p' | '1080p';
    const qualityTab = QUALITY_TABS.find((q) => q.id === quality) || QUALITY_TABS[2];
    const epSec = resolveEpisodeSeconds(ep, detail?.episodeRunTime);
    const probeSize = probedSample?.data?.sizes?.[qKey];

    if (
      probedSample &&
      probedSample.episodeId === ep.episodeId &&
      probeSize &&
      probeSize.bytes > 0
    ) {
      return {
        bytes: probeSize.bytes,
        exact: probeSize.exact,
      };
    }

    if (
      probedSample &&
      probeSize &&
      probeSize.bytes > 0 &&
      probedSample.data.durationSec > 0
    ) {
      const targetSec = epSec > 0 ? epSec : probedSample.data.durationSec;
      const bytesPerSec = probeSize.bytes / probedSample.data.durationSec;
      return {
        bytes: Math.round(targetSec * bytesPerSec),
        exact: false,
      };
    }

    const fallbackSec = epSec > 0 ? epSec : 42 * 60;
    return {
      bytes: Math.round(fallbackSec * qualityTab.bytesPerSec),
      exact: false,
    };
  };

  const isEpisodeSelectable = (ep: EpisodeSummary): boolean => {
    if (!ep.playUrl) return false;
    const key = `episode:${ep.episodeId}`;
    if (downloadsMap.has(key)) {
      return false;
    }
    const t = tasksMap.get(key);
    if (
      t &&
      (t.status === 'queued' ||
        t.status === 'downloading' ||
        t.status === 'paused' ||
        t.status === 'saving')
    ) {
      return false;
    }
    return true;
  };

  const handleSelectQualityTab = (nextQuality: DownloadQuality) => {
    setActiveQuality(nextQuality);
  };

  const downloadableEpisodes = visibleEpisodes.filter((ep) => isEpisodeSelectable(ep));
  const selectedEpisodes = downloadableEpisodes.filter((ep) => selectedIds.has(ep.episodeId));
  const allVisibleSelected =
    downloadableEpisodes.length > 0 && selectedEpisodes.length === downloadableEpisodes.length;

  const downloadedInVisibleCount = visibleEpisodes.filter((ep) =>
    downloadsMap.has(`episode:${ep.episodeId}`),
  ).length;

  const batchSizeSummary = useMemo(() => {
    if (selectedEpisodes.length === 0) return { bytes: 0, exact: false };
    let total = 0;
    let allExact = true;
    for (const ep of selectedEpisodes) {
      const est = resolveEpisodeEstimatedSize(ep, activeQuality);
      total += est.bytes;
      if (!est.exact) allExact = false;
    }
    return { bytes: total, exact: allExact };
  }, [selectedEpisodes, activeQuality, detail?.episodeRunTime, probedSample]);

  const handleSelectSeason = (seasonKey: string) => {
    setSelectedSeason(seasonKey);
    setSelectedIds(new Set());
  };

  const toggleEpisode = (episodeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(episodeId)) next.delete(episodeId);
      else next.add(episodeId);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(downloadableEpisodes.map((ep) => ep.episodeId)));
    }
  };

  const handleQueueSelected = () => {
    if (!detail || selectedEpisodes.length === 0) return;

    for (const ep of selectedEpisodes) {
      const sNum = ep.seasonNum || Number(selectedSeason) || 1;
      const est = resolveEpisodeEstimatedSize(ep, activeQuality);
      queueDownload({
        kind: 'episode',
        id: ep.episodeId,
        seriesId: detail.seriesId,
        seriesTitle: detail.cleanTitle,
        seasonNum: sNum,
        episodeNum: ep.episodeNum,
        title: `${detail.cleanTitle} — S${sNum}E${ep.episodeNum}`,
        subtitle: ep.title,
        categoryName: detail.categoryName || headerSource?.categoryName || 'Series',
        year: detail.year ?? headerSource?.year ?? null,
        rating: ep.rating || detail.rating || headerSource?.rating || 0,
        duration: ep.duration || detail.episodeRunTime,
        plot: ep.plot || detail.plot,
        poster: ep.thumbnail || detail.poster || headerSource?.poster || '',
        playUrl: ep.playUrl,
        extension: ep.extension,
        quality: activeQuality,
        expectedTotalBytes: est.bytes,
        isEstimatedTotal: !est.exact,
      });
    }

    setQueuedNotice({
      count: selectedEpisodes.length,
      quality: activeQuality,
    });
    setSelectedIds(new Set());
  };

  if (!isOpen || !headerSource) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="series-episodes-download-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full sm:max-w-2xl flex-col rounded-t-3xl sm:rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] shadow-lg overflow-hidden">
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-slate-300 dark:bg-white/20 sm:hidden" />

        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200/80 dark:border-white/[0.08] px-5 py-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <MediaImage
              src={headerSource.poster}
              alt={headerSource.cleanTitle}
              title={headerSource.cleanTitle}
              year={headerSource.year}
              variant="poster"
              className="h-14 w-10 shrink-0 rounded-lg border border-slate-200 dark:border-white/10"
              imgClassName="h-full w-full object-cover"
            />
            <div className="min-w-0">
              <h2
                id="series-episodes-download-title"
                className="font-display text-lg font-bold text-slate-900 dark:text-white truncate"
              >
                Download Episodes
              </h2>
              <p className="mt-0.5 truncate text-xs text-slate-600 dark:text-slate-400">
                {headerSource.cleanTitle}
                {headerSource.year ? ` · ${headerSource.year}` : ''}
                {seasonKeys.length > 0
                  ? ` · ${seasonKeys.length} season${seasonKeys.length > 1 ? 's' : ''}`
                  : ''}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close episode downloader"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quality-Based Tabs */}
        <div className="border-b border-slate-200/80 dark:border-white/[0.08] bg-slate-50/90 dark:bg-[#0B0E15] px-5 pt-3 pb-3">
          <div
            role="tablist"
            aria-label="Download quality tabs"
            className="grid grid-cols-2 sm:grid-cols-4 gap-2"
          >
            {QUALITY_TABS.map((tab) => {
              const active = activeQuality === tab.id;
              const sampleSize =
                probedSample?.data?.sizes?.[
                  tab.id as '360p' | '480p' | '720p' | '1080p'
                ];
              const tabSizeLabel =
                sampleSize && sampleSize.bytes > 0
                  ? `${sampleSize.exact ? '' : '~'}${formatBytes(sampleSize.bytes)}`
                  : tab.fallbackPerHour;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => handleSelectQualityTab(tab.id)}
                  className={`flex min-h-[52px] flex-col items-start justify-center rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                    active
                      ? 'border-[#E11D48] bg-[#E11D48] text-white'
                      : 'border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-800 dark:text-slate-200 hover:border-slate-300 dark:hover:border-white/25'
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-1">
                    <span className="font-display text-sm font-bold tabular-nums">
                      {tab.label}
                    </span>
                    <span
                      className={`text-[10px] font-medium tabular-nums ${
                        active ? 'text-white/90' : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {tabSizeLabel}
                    </span>
                  </div>
                  <span
                    className={`mt-0.5 text-[11px] font-medium truncate w-full ${
                      active ? 'text-white/85' : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {tab.tier}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Season Filter Bar */}
        {!loading && !error && seasonKeys.length > 0 && (
          <div className="border-b border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#111520] px-5 py-2.5 space-y-2.5">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              {seasonKeys.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleSelectSeason('all')}
                  className={`min-h-[36px] shrink-0 rounded-lg px-3 py-1 text-xs font-semibold transition-all whitespace-nowrap tabular-nums ${
                    selectedSeason === 'all'
                      ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-sm'
                      : 'border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/25'
                  }`}
                >
                  All Seasons
                </button>
              )}

              {seasonKeys.map((sk) => {
                const count = detail?.episodesBySeason[sk]?.length ?? 0;
                const active = selectedSeason === sk;
                return (
                  <button
                    key={sk}
                    type="button"
                    onClick={() => handleSelectSeason(sk)}
                    className={`min-h-[36px] shrink-0 rounded-lg px-3 py-1 text-xs font-semibold transition-all whitespace-nowrap tabular-nums ${
                      active
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-sm'
                        : 'border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/25'
                    }`}
                  >
                    Season {sk} ({count})
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 tabular-nums">
                <Layers className="h-3.5 w-3.5 text-slate-400" />
                <span>
                  {selectedSeason === 'all' ? 'All seasons' : `Season ${selectedSeason}`} ·{' '}
                  {visibleEpisodes.length} episode{visibleEpisodes.length === 1 ? '' : 's'}
                </span>
                {downloadedInVisibleCount > 0 && (
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                    · {downloadedInVisibleCount} downloaded
                  </span>
                )}
              </div>

              {downloadableEpisodes.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleSelectAllVisible}
                    className="min-h-[36px] rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                  >
                    {allVisibleSelected
                      ? 'Deselect All'
                      : `Select All (${downloadableEpisodes.length})`}
                  </button>
                  {selectedEpisodes.length > 0 && !allVisibleSelected && (
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set())}
                      className="min-h-[36px] rounded-lg px-2.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Episode List Body */}
        <div role="tabpanel" className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
          {queuedNotice && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-300/80 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/35 px-3.5 py-2.5 text-xs text-emerald-900 dark:text-emerald-200">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>
                  Queued {queuedNotice.count} episode{queuedNotice.count > 1 ? 's' : ''} in{' '}
                  {queuedNotice.quality}.
                </span>
              </div>
              {onOpenDownloads && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenDownloads();
                  }}
                  className="font-semibold text-emerald-700 dark:text-emerald-300 underline underline-offset-2 hover:opacity-80"
                >
                  Open Download Manager
                </button>
              )}
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Loader2 className="h-7 w-7 animate-spin text-[#E11D48]" />
              <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-300">
                Loading seasons &amp; episodes...
              </p>
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50/70 dark:bg-rose-950/20 p-6 text-center">
              <AlertCircle className="mx-auto h-6 w-6 text-rose-500" />
              <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                Failed to Load Episodes
              </p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{error}</p>
              <button
                type="button"
                onClick={() => setRetryNonce((n) => n + 1)}
                className="mt-4 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-[#E11D48] px-4 text-xs font-semibold text-white hover:opacity-95"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Retry</span>
              </button>
            </div>
          ) : visibleEpisodes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
              No episodes available for this selection.
            </div>
          ) : (
            visibleEpisodes.map((ep) => {
              const key = `episode:${ep.episodeId}`;
              const offlineItem = downloadsMap.get(key);
              const existingQuality = offlineItem?.quality || 'HD';
              const isDownloaded = Boolean(offlineItem);

              const task = tasksMap.get(key);
              const isQueuedOrRunning =
                task &&
                (task.status === 'queued' ||
                  task.status === 'downloading' ||
                  task.status === 'saving');
              const isPausedTask = task?.status === 'paused';
              const selectable = isEpisodeSelectable(ep);
              const checked = selectedIds.has(ep.episodeId);

              const epEstimate = resolveEpisodeEstimatedSize(ep, activeQuality);
              const epCode =
                selectedSeason === 'all'
                  ? `S${String(ep.seasonNum).padStart(2, '0')}E${String(ep.episodeNum).padStart(2, '0')}`
                  : `E${String(ep.episodeNum).padStart(2, '0')}`;

              return (
                <div
                  key={ep.episodeId}
                  onClick={
                    selectable
                      ? () => {
                          toggleEpisode(ep.episodeId);
                        }
                      : undefined
                  }
                  role={selectable ? 'checkbox' : undefined}
                  aria-checked={selectable ? checked : undefined}
                  aria-disabled={!selectable ? 'true' : undefined}
                  tabIndex={selectable ? 0 : undefined}
                  onKeyDown={
                    selectable
                      ? (e) => {
                          if (e.key === ' ' || e.key === 'Enter') {
                            e.preventDefault();
                            toggleEpisode(ep.episodeId);
                          }
                        }
                      : undefined
                  }
                  className={`flex items-center gap-3 rounded-xl border p-2.5 transition-colors ${
                    selectable
                      ? 'cursor-pointer'
                      : task
                        ? 'cursor-default select-none opacity-90'
                        : 'cursor-default pointer-events-none select-none opacity-80'
                  } ${
                    isDownloaded
                      ? 'border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-950/15'
                      : checked
                        ? 'border-[#E11D48] bg-rose-50/70 dark:bg-[#E11D48]/12'
                        : 'border-slate-200 dark:border-white/10 bg-slate-50/60 dark:bg-[#0B0E15]/80 hover:border-slate-300 dark:hover:border-white/20'
                  }`}
                >
                  {/* 44px touch-safe checkbox slot */}
                  <div className="flex h-11 w-9 shrink-0 items-center justify-center">
                    {isDownloaded ? (
                      <span
                        title={`Downloaded (${existingQuality})`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </span>
                    ) : isQueuedOrRunning ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[#E11D48]" />
                    ) : isPausedTask ? (
                      <Pause className="h-4 w-4 text-amber-500" />
                    ) : !ep.playUrl ? (
                      <span className="h-5 w-5 rounded border border-slate-300 dark:border-white/15 bg-slate-200/60 dark:bg-white/5" />
                    ) : (
                      <span
                        className={`inline-flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                          checked
                            ? 'border-[#E11D48] bg-[#E11D48] text-white'
                            : 'border-slate-300 dark:border-white/25 bg-white dark:bg-[#111520]'
                        }`}
                      >
                        {checked && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                      </span>
                    )}
                  </div>

                  {/* Episode Thumbnail */}
                  <MediaImage
                    src={ep.thumbnail || detail?.poster || headerSource.poster}
                    alt={ep.title}
                    title={ep.title}
                    variant="backdrop"
                    className="hidden sm:block h-12 w-20 shrink-0 rounded-lg border border-slate-200 dark:border-white/10"
                    imgClassName="h-full w-full object-cover"
                  />

                  {/* Metadata */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-[#E11D48] dark:text-rose-400 tabular-nums shrink-0">
                        {epCode}
                      </span>
                      <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                        {ep.title}
                      </p>
                    </div>

                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                      {ep.duration && <span>{ep.duration}</span>}
                      {ep.extension && (
                        <span>
                          {ep.duration
                            ? `· ${ep.extension.toUpperCase()}`
                            : ep.extension.toUpperCase()}
                        </span>
                      )}
                      {epEstimate.bytes > 0 && !isDownloaded && !isQueuedOrRunning && !isPausedTask && (
                        <span>
                          · {epEstimate.exact ? '' : '~'}
                          {formatBytes(epEstimate.bytes)} ({activeQuality})
                        </span>
                      )}

                      {isDownloaded && offlineItem && (
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                          · Downloaded ({existingQuality} · {formatBytes(offlineItem.sizeBytes)})
                        </span>
                      )}

                      {task?.status === 'downloading' && (
                        <span
                          className={`font-semibold ${
                            task.waitingForNetwork
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-[#E11D48] dark:text-rose-400'
                          }`}
                        >
                          {task.waitingForNetwork
                            ? `· Waiting for internet (${task.percent}%)`
                            : `· ${task.quality} · ${formatBytes(task.receivedBytes)}${task.totalBytes > 0 ? ` / ${task.isEstimatedTotal ? '~' : ''}${formatBytes(task.totalBytes)}` : ''} · ${task.percent}% · ${formatSpeed(task.speedBytesPerSec)}`}
                        </span>
                      )}

                      {task?.status === 'paused' && (
                        <span className="font-semibold text-amber-600 dark:text-amber-400">
                          · Paused ({task.quality} · {formatBytes(task.receivedBytes)}
                          {task.totalBytes > 0
                            ? ` / ${task.isEstimatedTotal ? '~' : ''}${formatBytes(task.totalBytes)}`
                            : ''})
                        </span>
                      )}

                      {task?.status === 'queued' && (
                        <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                          · Queued ({task.quality}
                          {task.totalBytes > 0
                            ? ` · ${task.isEstimatedTotal ? '~' : ''}${formatBytes(task.totalBytes)}`
                            : ''})
                        </span>
                      )}

                      {task?.status === 'saving' && (
                        <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                          · Saving offline...
                        </span>
                      )}

                      {task?.status === 'error' && (
                        <span className="font-semibold text-rose-600 dark:text-rose-400">
                          · {task.error || 'Interrupted'}
                        </span>
                      )}

                      {!ep.playUrl && !offlineItem && (
                        <span className="text-slate-400">· Stream unavailable</span>
                      )}
                    </div>

                    {task &&
                      (task.status === 'downloading' ||
                        task.status === 'paused' ||
                        task.status === 'saving') && (
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                          <div
                            className={`h-full transition-all duration-200 ${
                              task.status === 'paused'
                                ? 'bg-amber-500'
                                : 'bg-[#E11D48]'
                            }`}
                            style={{ width: `${Math.max(4, task.percent)}%` }}
                          />
                        </div>
                      )}
                  </div>

                  {task && (task.status === 'downloading' || task.status === 'queued') && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        pauseDownload(key);
                      }}
                      title="Pause download"
                      className="pointer-events-auto inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-500/15 px-2.5 text-xs font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/25"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      <span>Pause</span>
                    </button>
                  )}

                  {task && (task.status === 'paused' || task.status === 'error') && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void resumeDownload(key);
                      }}
                      title="Resume download"
                      className="pointer-events-auto inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-2.5 text-xs font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Resume</span>
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer Summary & Quality-Specific Download CTA */}
        <div className="border-t border-slate-200/80 dark:border-white/[0.08] bg-slate-50 dark:bg-[#0B0E15] px-5 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] sm:pb-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 tabular-nums">
              <HardDrive className="h-3.5 w-3.5 shrink-0" />
              <span>
                {selectedEpisodes.length > 0
                  ? `${selectedEpisodes.length} selected · ${batchSizeSummary.exact ? '' : '~'}${formatBytes(batchSizeSummary.bytes)} in ${activeQuality}`
                  : `Select episodes to download in ${activeQuality}`}
              </span>
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[44px] sm:min-h-[40px] rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 px-4 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
              >
                Close
              </button>
              <button
                type="button"
                disabled={selectedEpisodes.length === 0}
                onClick={handleQueueSelected}
                className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg bg-[#E11D48] px-4 sm:px-5 text-sm font-semibold text-white hover:bg-[#be123c] disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                <Download className="h-4 w-4" />
                <span>
                  Download{selectedEpisodes.length > 0 ? ` (${selectedEpisodes.length})` : ''} in{' '}
                  {activeQuality}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
