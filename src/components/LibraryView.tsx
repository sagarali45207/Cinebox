import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Bell,
  BellRing,
  Bookmark,
  Clock,
  Film,
  HardDrive,
  HardDriveDownload,
  History,
  Loader2,
  Play,
  Radio,
  Star,
  Trash2,
  Tv,
  X,
} from 'lucide-react';
import type {
  DetailTarget,
  LiveChannelSummary,
  OfflineDownloadEntry,
  ProgramReminder,
  WatchHistoryEntry,
  WatchlistEntry,
} from '../types/media';
import { extractCardLanguage, formatRelativeTime } from '../utils/format';
import { formatLocalTimeFromUnix, formatReminderCountdown } from '../utils/notifications';
import { formatBytes, formatSpeed } from '../utils/offlineDb';
import { useOfflineDownloads } from '../utils/offlineManager';
import { MediaCard } from './MediaCard';
import { MediaImage } from './MediaImage';

export type LibraryTab = 'watchlist' | 'history' | 'downloads' | 'channels' | 'reminders';

interface LibraryViewProps {
  continueEntries: WatchHistoryEntry[];
  watchlist: WatchlistEntry[];
  favoriteChannels: LiveChannelSummary[];
  recentChannels: LiveChannelSummary[];
  reminders: ProgramReminder[];
  initialSection?: LibraryTab;
  sectionNonce?: number;
  onOpenContinue: (entry: WatchHistoryEntry) => void;
  onOpenDetail: (target: DetailTarget) => void;
  onToggleSave: (payload: {
    kind: 'movie' | 'series';
    id: string;
    title: string;
    poster: string;
    year: string | null;
    rating: number;
    categoryName: string;
  }) => void;
  onToggleFavoriteChannel: (channel: LiveChannelSummary) => void;
  onRemoveContinue: (key: string) => void;
  onClearContinue: () => void;
  onRemoveRecentChannel: (streamId: string) => void;
  onClearRecentChannels: () => void;
  onRemoveReminder: (id: string) => void;
  onClearReminders: () => void;
}

function OfflinePoster({
  entry,
  className = '',
}: {
  entry: OfflineDownloadEntry;
  className?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string>('');

  useEffect(() => {
    if (!entry.posterBlob) {
      setBlobUrl('');
      return;
    }
    const url = URL.createObjectURL(entry.posterBlob);
    setBlobUrl(url);
    return () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore cleanup failure
      }
    };
  }, [entry.posterBlob]);

  return (
    <MediaImage
      src={blobUrl || entry.poster}
      alt={entry.seriesTitle || entry.title}
      title={entry.seriesTitle || entry.title}
      year={entry.year}
      className={className}
      imgClassName="h-full w-full object-cover"
    />
  );
}

export function LibraryView({
  continueEntries,
  watchlist,
  favoriteChannels,
  recentChannels,
  reminders,
  initialSection,
  sectionNonce,
  onOpenContinue,
  onOpenDetail,
  onToggleSave,
  onToggleFavoriteChannel,
  onRemoveContinue,
  onClearContinue,
  onRemoveRecentChannel,
  onClearRecentChannels,
  onRemoveReminder,
  onClearReminders,
}: LibraryViewProps) {
  const [section, setSection] = useState<LibraryTab>(initialSection || 'watchlist');

  useEffect(() => {
    if (initialSection) {
      setSection(initialSection);
    }
  }, [initialSection, sectionNonce]);

  const {
    downloads,
    tasks,
    usedStorageBytes,
    quotaBytes,
    cancelDownload,
    removeDownload,
    clearDownloads,
  } = useOfflineDownloads();

  const activeTasks = Object.values(tasks);
  const offlineBadgeCount = downloads.length + activeTasks.length;
  const favoriteIds = new Set(favoriteChannels.map((c) => c.streamId));
  const quotaRatio =
    quotaBytes && quotaBytes > 0
      ? Math.min(100, Math.max(2, Math.round((usedStorageBytes / quotaBytes) * 100)))
      : null;

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 py-8 pb-16 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200/80 dark:border-white/[0.08] pb-6">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
            Library
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 tabular-nums">
            {watchlist.length} saved · {continueEntries.length} in progress ·{' '}
            {downloads.length} offline · {favoriteChannels.length} pinned · {recentChannels.length} recent channels
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setSection('watchlist')}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
              section === 'watchlist'
                ? 'bg-[#E11D48] text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Bookmark className="h-3.5 w-3.5" />
            <span>Watchlist ({watchlist.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setSection('history')}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
              section === 'history'
                ? 'bg-[#E11D48] text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <History className="h-3.5 w-3.5" />
            <span>Continue ({continueEntries.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setSection('downloads')}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
              section === 'downloads'
                ? 'bg-[#E11D48] text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <HardDriveDownload className="h-3.5 w-3.5" />
            <span>Offline ({offlineBadgeCount})</span>
          </button>

          <button
            type="button"
            onClick={() => setSection('channels')}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
              section === 'channels'
                ? 'bg-[#E11D48] text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Radio className="h-3.5 w-3.5" />
            <span>Channels ({favoriteChannels.length + recentChannels.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setSection('reminders')}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
              section === 'reminders'
                ? 'bg-[#E11D48] text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Bell className="h-3.5 w-3.5" />
            <span>Reminders ({reminders.length})</span>
          </button>
        </div>
      </div>

      {section === 'watchlist' && (
        <section>
          {watchlist.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-12 text-center">
              <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                Your Watchlist Is Empty
              </p>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                Save any movie or series using the bookmark button to keep it organized here.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-6">
              {watchlist.map((item) => (
                <MediaCard
                  key={item.key}
                  title={item.title}
                  poster={item.poster}
                  saved={true}
                  rating={item.rating}
                  language={extractCardLanguage(item.title, item.categoryName)}
                  year={item.year}
                  categoryName={item.categoryName}
                  mediaType={item.kind === 'series' ? 'Series' : 'Movie'}
                  onOpen={() => {
                    if (item.kind === 'movie') {
                      onOpenDetail({
                        kind: 'movie',
                        id: item.id,
                        autoplay: true,
                        initialMovie: {
                          title: item.title,
                          subtitle: item.categoryName,
                          poster: item.poster,
                          playUrl: `/api/play/vod/${item.id}.mp4`,
                        },
                      });
                    } else {
                      onOpenDetail({ kind: 'series', id: item.id });
                    }
                  }}
                  onToggleSave={() =>
                    onToggleSave({
                      kind: item.kind,
                      id: item.id,
                      title: item.title,
                      poster: item.poster,
                      year: item.year,
                      rating: item.rating,
                      categoryName: item.categoryName,
                    })
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}

      {section === 'history' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <History className="h-4 w-4 text-[#E11D48]" />
              <span>Recently Watched Streams</span>
            </h2>
            {continueEntries.length > 0 && (
              <button
                type="button"
                onClick={onClearContinue}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-3.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear History</span>
              </button>
            )}
          </div>

          {continueEntries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-12 text-center">
              <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                No Watch History Yet
              </p>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                Movies and episodes you start watching appear here with automatic resume points.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-6">
              {continueEntries.map((entry) => {
                const ratio =
                  entry.durationSec > 0 ? entry.progressSec / entry.durationSec : 0;
                const displayTitle = entry.seriesTitle || entry.title;
                return (
                  <MediaCard
                    key={entry.key}
                    title={displayTitle}
                    poster={entry.poster}
                    rating={entry.rating}
                    language={
                      entry.language ||
                      extractCardLanguage(displayTitle, entry.categoryName)
                    }
                    categoryName={
                      entry.kind === 'episode' && entry.title !== entry.seriesTitle
                        ? entry.title
                        : entry.categoryName
                    }
                    mediaType={entry.kind === 'episode' ? 'Episode' : 'Movie'}
                    progressRatio={ratio}
                    metaParts={[
                      entry.kind === 'episode' && entry.seasonNum
                        ? `S${entry.seasonNum}E${entry.episodeNum}`
                        : '',
                      `${Math.round(ratio * 100)}%`,
                      formatRelativeTime(entry.updatedAt),
                    ]}
                    onOpen={() => onOpenContinue(entry)}
                    onQuickPlay={() => onOpenContinue(entry)}
                    onRemove={() => onRemoveContinue(entry.key)}
                    removeLabel={`Remove ${displayTitle} from watch history`}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      {section === 'downloads' && (
        <section className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-4 shadow-sm shadow-slate-900/5 dark:shadow-none">
            <div className="space-y-1.5 min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <h2 className="font-display text-base sm:text-lg font-semibold text-slate-900 dark:text-white">
                  Offline Downloads (IndexedDB)
                </h2>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 tabular-nums">
                {formatBytes(usedStorageBytes)} stored locally
                {quotaBytes ? ` · ${formatBytes(quotaBytes)} browser storage available` : ''}
                {downloads.length > 0 ? ` · ${downloads.length} ready offline` : ''}
              </p>
              {quotaRatio !== null && usedStorageBytes > 0 && (
                <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-[width]"
                    style={{ width: `${quotaRatio}%` }}
                  />
                </div>
              )}
            </div>

            {(downloads.length > 0 || activeTasks.length > 0) && (
              <button
                type="button"
                onClick={() => void clearDownloads()}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/30 px-3.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors self-start sm:self-auto whitespace-nowrap"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear All Offline</span>
              </button>
            )}
          </div>

          {activeTasks.length > 0 && (
            <div className="space-y-3">
              <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Active &amp; Queued Downloads ({activeTasks.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeTasks.map((task) => {
                  const isError = task.status === 'error';
                  const statusLabel =
                    task.status === 'queued'
                      ? 'Queued'
                      : task.status === 'saving'
                        ? 'Saving to IndexedDB...'
                        : task.status === 'error'
                          ? task.error || 'Download failed'
                          : `Downloading ${task.percent}%`;

                  return (
                    <div
                      key={task.key}
                      className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-4 shadow-sm shadow-slate-900/5 dark:shadow-none space-y-2.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                            {task.kind === 'episode' ? (
                              <Tv className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                            ) : (
                              <Film className="h-3.5 w-3.5 text-[#E11D48] shrink-0" />
                            )}
                            <span>{task.kind === 'episode' ? 'Episode' : 'Movie'}</span>
                            <span>·</span>
                            <span>{task.quality}</span>
                            <span>·</span>
                            <span
                              className={`inline-flex items-center gap-1 ${
                                isError
                                  ? 'text-rose-600 dark:text-rose-400 font-semibold'
                                  : 'text-sky-600 dark:text-sky-400 font-semibold'
                              }`}
                            >
                              {isError ? (
                                <AlertCircle className="h-3 w-3 shrink-0" />
                              ) : (
                                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                              )}
                              <span className="truncate">{statusLabel}</span>
                            </span>
                          </div>
                          <h4 className="mt-1 truncate font-display text-sm font-semibold text-slate-900 dark:text-white">
                            {task.title}
                          </h4>
                        </div>

                        <button
                          type="button"
                          onClick={() => cancelDownload(task.key)}
                          aria-label={isError ? `Dismiss ${task.title}` : `Cancel ${task.title}`}
                          title={isError ? 'Dismiss' : 'Cancel download'}
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {!isError && (
                        <div className="space-y-1">
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                            <div
                              className="h-full rounded-full bg-[#E11D48] transition-[width] duration-300"
                              style={{
                                width: `${task.status === 'queued' ? 4 : Math.max(4, task.percent)}%`,
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                            <span>
                              {formatBytes(task.receivedBytes)}
                              {task.totalBytes > 0
                                ? ` / ${task.isEstimatedTotal ? '~' : ''}${formatBytes(task.totalBytes)}`
                                : ''}
                            </span>
                            <span>
                              {task.status === 'downloading' && task.speedBytesPerSec > 0
                                ? `${formatSpeed(task.speedBytesPerSec)} · ${task.percent}%`
                                : `${task.percent}%`}
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

          {downloads.length === 0 && activeTasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-12 text-center">
              <HardDriveDownload className="mx-auto h-8 w-8 text-slate-400 dark:text-slate-500" />
              <p className="mt-3 font-display text-lg font-semibold text-slate-900 dark:text-white">
                No Offline Downloads Yet
              </p>
              <p className="mt-1.5 mx-auto max-w-md text-sm text-slate-600 dark:text-slate-400">
                Open any movie or series episode and click &ldquo;Download for Offline&rdquo; to
                store it inside IndexedDB for playback without an internet connection.
              </p>
            </div>
          ) : downloads.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {downloads.map((entry) => {
                const isEpisode = entry.kind === 'episode';
                const heading = isEpisode
                  ? entry.seriesTitle || entry.title
                  : entry.title;
                const episodeTag =
                  isEpisode && entry.seasonNum && entry.episodeNum
                    ? `S${String(entry.seasonNum).padStart(2, '0')}E${String(entry.episodeNum).padStart(2, '0')}`
                    : isEpisode
                      ? 'Episode'
                      : 'Movie';

                const openOffline = () => {
                  if (entry.kind === 'movie') {
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
                  } else {
                    onOpenDetail({
                      kind: 'series',
                      id: entry.seriesId || entry.id,
                      episodeId: entry.id,
                      seasonNum: entry.seasonNum,
                      episodeNum: entry.episodeNum,
                      preferOffline: true,
                    });
                  }
                };

                return (
                  <article
                    key={entry.key}
                    className="cinebox-card-elevated group flex gap-3.5 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3.5 shadow-sm shadow-slate-900/5 dark:shadow-none hover:border-emerald-300 dark:hover:border-emerald-500/40"
                  >
                    <button
                      type="button"
                      onClick={openOffline}
                      aria-label={`Play ${heading} offline`}
                      className="relative w-20 sm:w-24 aspect-[2/3] shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-[#090B10] border border-slate-200/70 dark:border-white/5"
                    >
                      <OfflinePoster entry={entry} className="h-full w-full" />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-950 shadow">
                          <Play className="h-4 w-4 fill-current ml-0.5" />
                        </span>
                      </div>
                    </button>

                    <div className="min-w-0 flex-1 flex flex-col justify-between gap-2">
                      <div>
                        <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                          {episodeTag} · {formatBytes(entry.sizeBytes)} ·{' '}
                          {(entry.extension || 'mp4').toUpperCase()}
                        </p>
                        <h3 className="mt-0.5 line-clamp-1 font-display text-sm font-bold text-slate-900 dark:text-white">
                          {heading}
                        </h3>
                        {isEpisode && entry.subtitle && (
                          <p className="mt-0.5 line-clamp-1 text-xs text-slate-600 dark:text-slate-300">
                            {entry.subtitle}
                          </p>
                        )}
                        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums truncate">
                          {entry.categoryName}
                          {entry.subtitles && entry.subtitles.length > 0
                            ? ` · ${entry.subtitles.length} subtitle${entry.subtitles.length > 1 ? 's' : ''}`
                            : ''}
                          {` · Saved ${formatRelativeTime(entry.downloadedAt)}`}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={openOffline}
                          className="inline-flex min-h-[34px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-3 text-xs font-semibold text-white shadow-sm hover:bg-[#BE123C] transition-colors whitespace-nowrap"
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                          <span>Play Offline</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeDownload(entry.key)}
                          aria-label={`Remove offline copy of ${heading}`}
                          title="Delete offline copy"
                          className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>
      )}

      {section === 'channels' && (
        <section className="space-y-8">
          <div className="space-y-4">
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
              Pinned Channels
            </h2>
            {favoriteChannels.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-10 text-center">
                <p className="font-display text-base font-semibold text-slate-900 dark:text-white">
                  No Pinned Channels
                </p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Star any Live TV channel to keep quick access here.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {favoriteChannels.map((ch) => (
                  <article
                    key={ch.streamId}
                    className="cinebox-card-elevated group flex items-center gap-3 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3 shadow-sm shadow-slate-900/5 dark:shadow-none hover:border-sky-300 dark:hover:border-white/25 dark:hover:bg-[#171D2B]"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onOpenDetail({ kind: 'live', id: ch.streamId, channel: ch })
                      }
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <MediaImage
                        src={ch.logo}
                        alt={ch.name}
                        category={ch.categoryName}
                        variant="logo"
                        imgClassName="h-full w-full object-contain p-1.5"
                        className="h-12 w-16 shrink-0 rounded-lg border border-slate-200/70 dark:border-white/5 bg-slate-100 dark:bg-[#090B10]"
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-white group-hover:text-[#E11D48]">
                          {ch.name}
                        </h3>
                        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                          {ch.categoryName}
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleFavoriteChannel(ch)}
                      aria-label={`Unpin ${ch.name}`}
                      title={`Unpin ${ch.name}`}
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-amber-400/50 bg-amber-400/15 text-amber-500 dark:text-amber-300"
                    >
                      <Star className="h-4 w-4 fill-current" />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-4 border-t border-slate-200/80 dark:border-white/[0.08] pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Clock className="h-4 w-4 text-slate-400" />
                <span>Recently Watched Channels</span>
              </h2>
              {recentChannels.length > 0 && (
                <button
                  type="button"
                  onClick={onClearRecentChannels}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-3 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clear Recent</span>
                </button>
              )}
            </div>

            {recentChannels.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-10 text-center">
                <p className="font-display text-base font-semibold text-slate-900 dark:text-white">
                  No Recently Watched Channels
                </p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Live TV channels you watch will appear here for quick access.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {recentChannels.map((ch) => {
                  const isPinned = favoriteIds.has(ch.streamId);
                  return (
                    <article
                      key={ch.streamId}
                      className="cinebox-card-elevated group flex items-center gap-2.5 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3 shadow-sm shadow-slate-900/5 dark:shadow-none hover:border-sky-300 dark:hover:border-white/25 dark:hover:bg-[#171D2B]"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          onOpenDetail({ kind: 'live', id: ch.streamId, channel: ch })
                        }
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <MediaImage
                          src={ch.logo}
                          alt={ch.name}
                          category={ch.categoryName}
                          variant="logo"
                          imgClassName="h-full w-full object-contain p-1.5"
                          className="h-12 w-16 shrink-0 rounded-lg border border-slate-200/70 dark:border-white/5 bg-slate-100 dark:bg-[#090B10]"
                        />
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-white group-hover:text-[#E11D48]">
                            {ch.name}
                          </h3>
                          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                            {ch.categoryName}
                          </p>
                        </div>
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onToggleFavoriteChannel(ch)}
                          aria-label={isPinned ? `Unpin ${ch.name}` : `Pin ${ch.name}`}
                          title={isPinned ? `Unpin ${ch.name}` : `Pin ${ch.name}`}
                          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                            isPinned
                              ? 'border-amber-400/50 bg-amber-400/15 text-amber-500 dark:text-amber-300'
                              : 'border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:text-amber-500 dark:hover:text-white'
                          }`}
                        >
                          <Star className={`h-4 w-4 ${isPinned ? 'fill-current' : ''}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveRecentChannel(ch.streamId)}
                          aria-label={`Remove ${ch.name} from recent channels`}
                          title={`Remove ${ch.name} from recent channels`}
                          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-black/40 text-slate-500 dark:text-slate-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {section === 'reminders' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <BellRing className="h-4 w-4 text-[#E11D48]" />
              <span>Scheduled TV &amp; Event Reminders</span>
            </h2>
            {reminders.length > 0 && (
              <button
                type="button"
                onClick={onClearReminders}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-3.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear Reminders</span>
              </button>
            )}
          </div>

          {reminders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-12 text-center">
              <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                No Show Reminders Set
              </p>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                Browse the TV Guide or any Live TV channel schedule and click &ldquo;Remind Me&rdquo;
                to get notified before a show starts.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {reminders.map((rem) => {
                const countdown = formatReminderCountdown(rem.startTimestamp, rem.stopTimestamp);
                const localTime = formatLocalTimeFromUnix(rem.startTimestamp);
                return (
                  <article
                    key={rem.id}
                    className="cinebox-card-elevated flex items-center gap-3 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3.5 shadow-sm shadow-slate-900/5 dark:shadow-none"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onOpenDetail({
                          kind: 'live',
                          id: rem.streamId,
                          channel: rem.channelSnapshot,
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <MediaImage
                        src={rem.channelLogo}
                        alt={rem.channelName}
                        title={rem.channelName}
                        category={rem.channelCategory}
                        variant="logo"
                        imgClassName="h-full w-full object-contain p-1.5"
                        className="h-12 w-16 shrink-0 rounded-lg border border-slate-200/70 dark:border-white/5 bg-slate-100 dark:bg-[#090B10]"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold text-[#E11D48] tabular-nums">
                          {countdown} · {rem.leadMinutes === 0 ? 'At start' : `${rem.leadMinutes}m early`}
                        </p>
                        <h3 className="mt-0.5 truncate text-sm font-semibold text-slate-900 dark:text-white">
                          {rem.programTitle}
                        </h3>
                        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                          {rem.channelName} · {rem.startLabel} UTC{localTime ? ` (${localTime})` : ''}
                        </p>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => onRemoveReminder(rem.id)}
                      aria-label={`Remove reminder for ${rem.programTitle}`}
                      title="Remove reminder"
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
