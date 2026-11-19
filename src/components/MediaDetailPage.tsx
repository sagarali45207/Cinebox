import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  BellRing,
  Bookmark,
  CalendarClock,
  Check,
  CheckCircle2,
  Download,
  Film,
  Languages,
  Lock,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Search,
  ShieldAlert,
  Star,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import {
  fetchImdbCast,
  fetchLiveChannelDetail,
  fetchMovieDetail,
  fetchSeriesDetail,
  getCachedMovieDetail,
  getCachedMovieDetailSync,
  getCachedSeriesDetail,
  getCachedSeriesDetailSync,
  preloadStreamMedia,
} from '../services/api';
import type {
  ActivePlayback,
  CastMember,
  CatalogLanguageVariant,
  DetailTarget,
  DownloadQuality,
  EpgProgram,
  EpisodeSummary,
  ImdbCastResponse,
  LiveChannelSummary,
  MediaLanguagesResponse,
  MovieDetail,
  OfflineDownloadEntry,
  ProgramReminder,
  ReminderLeadMinutes,
  SeriesDetail,
  WatchHistoryEntry,
  WatchlistEntry,
} from '../types/media';
import { extractCardLanguage, extractYouTubeId, proxiedImageUrl } from '../utils/format';
import {
  createOfflinePlaybackUrl,
  formatBytes,
  formatSpeed,
  getOfflineDownload,
  listOfflineDownloads,
} from '../utils/offlineDb';
import { useOfflineDownloads } from '../utils/offlineManager';
import {
  isRestrictedContent,
  useAppSettings,
  verifyParentalPin,
} from '../utils/settings';
import { buildReminderId } from '../utils/storage';
import { DownloadQualityModal, type ResolvedDownloadSize } from './DownloadQualityModal';
import { EmbeddedPlayer } from './EmbeddedPlayer';
import { LoadingSpinner, PageLoader } from './LoadingSpinner';
import { MediaCard } from './MediaCard';
import { MediaImage } from './MediaImage';
import { MediaReviewsSection } from './MediaReviewsSection';
import { SeriesEpisodesDownloadModal } from './SeriesEpisodesDownloadModal';

function CastMemberAvatar({ name, photoUrl }: { name: string; photoUrl?: string }) {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [photoUrl]);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="relative mb-2.5 h-20 w-20 sm:h-24 sm:w-24 overflow-hidden rounded-full border-2 border-slate-200 dark:border-white/10 group-hover:border-[#E11D48] transition-colors bg-slate-100 dark:bg-[#090B10]">
      {photoUrl && !imgError ? (
        <img
          src={proxiedImageUrl(photoUrl)}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-110"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[#E11D48] font-display font-semibold text-white text-base">
          {initials || '?'}
        </div>
      )}
    </div>
  );
}

interface MediaDetailPageProps {
  target: DetailTarget;
  isActive?: boolean;
  watchlist: WatchlistEntry[];
  continueEntries: WatchHistoryEntry[];
  favoriteChannels: LiveChannelSummary[];
  reminders: ProgramReminder[];
  backLabel?: string;
  onBack: () => void;
  onNavigateDetail: (next: DetailTarget) => void;
  onSelectRelated?: (next: DetailTarget) => void;
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
  onToggleReminder: (
    channel: LiveChannelSummary,
    program: EpgProgram,
    leadMinutes?: ReminderLeadMinutes,
  ) => void;
  onChannelOpened?: (channel: LiveChannelSummary) => void;
  onProgress: (playback: ActivePlayback, currentTime: number, duration: number) => void;
  onOpenDownloads?: () => void;
  onSearchCastMember?: (
    member: CastMember,
    exclude?: { kind: 'movie' | 'series'; id: string },
  ) => void;
}

export function MediaDetailPage({
  target,
  isActive = true,
  watchlist,
  continueEntries,
  favoriteChannels,
  reminders,
  backLabel: customBackLabel,
  onBack,
  onNavigateDetail,
  onSelectRelated,
  onToggleSave,
  onToggleFavoriteChannel,
  onToggleReminder,
  onChannelOpened,
  onProgress,
  onOpenDownloads,
  onSearchCastMember,
}: MediaDetailPageProps) {
  const [movie, setMovie] = useState<MovieDetail | null>(null);
  const [series, setSeries] = useState<SeriesDetail | null>(null);
  const [liveChannel, setLiveChannel] = useState<LiveChannelSummary | null>(() =>
    target.kind === 'live' && target.channel ? target.channel : null,
  );
  const [relatedChannels, setRelatedChannels] = useState<LiveChannelSummary[]>([]);
  const [epgPrograms, setEpgPrograms] = useState<EpgProgram[]>([]);
  const [serverTimestamp, setServerTimestamp] = useState<number>(() =>
    Math.floor(Date.now() / 1000),
  );
  const [epgLoading, setEpgLoading] = useState(target.kind === 'live');
  const [epgFilter, setEpgFilter] = useState<'upcoming' | 'all'>('upcoming');

  const [selectedSeason, setSelectedSeason] = useState<string>('');
  const [activePlayback, setActivePlayback] = useState<ActivePlayback | null>(null);
  const [showTrailer, setShowTrailer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [languageData, setLanguageData] = useState<MediaLanguagesResponse | null>(null);
  const [imdbData, setImdbData] = useState<ImdbCastResponse | null>(null);
  const [imdbLoading, setImdbLoading] = useState(false);
  const [castDeptFilter, setCastDeptFilter] = useState<'all' | 'cast' | 'crew'>('all');
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<Set<string>>(() => new Set());
  const [qualityPrompt, setQualityPrompt] = useState<
    | { mode: 'movie' }
    | { mode: 'episodes'; episodes: EpisodeSummary[] }
    | null
  >(null);
  const [seriesDownloadOpen, setSeriesDownloadOpen] = useState(false);
  const [parentalPinInput, setParentalPinInput] = useState('');
  const [parentalPinError, setParentalPinError] = useState('');
  const { settings, parentalUnlocked, unlockParentalSession } = useAppSettings();

  const {
    downloads: offlineDownloads,
    tasks: offlineTasks,
    queueDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    removeDownload,
  } = useOfflineDownloads();

  const continueRef = useRef(continueEntries);
  const onChannelOpenedRef = useRef(onChannelOpened);
  const liveTimeRef = useRef(0);
  const offlineObjectUrlsRef = useRef<string[]>([]);
  const autoOpenedModalTargetRef = useRef<string>('');

  const revokeOfflineObjectUrls = () => {
    for (const url of offlineObjectUrlsRef.current) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore
      }
    }
    offlineObjectUrlsRef.current = [];
  };

  useEffect(() => {
    return () => {
      revokeOfflineObjectUrls();
    };
  }, []);

  useEffect(() => {
    if (!isActive) {
      setShowTrailer(false);
    }
  }, [isActive]);

  useEffect(() => {
    continueRef.current = continueEntries;
  }, [continueEntries]);

  useEffect(() => {
    onChannelOpenedRef.current = onChannelOpened;
  }, [onChannelOpened]);

  const offlineMap = useMemo(() => {
    const map = new Map<string, OfflineDownloadEntry>();
    for (const d of offlineDownloads) {
      map.set(d.key, d);
    }
    return map;
  }, [offlineDownloads]);

  // Fetch IMDb + Wikidata/TVmaze Cast & Crew pictures and roles for movies and series
  useEffect(() => {
    const currentTitle = movie?.cleanTitle || series?.cleanTitle;
    const currentYear = movie?.year || series?.year;
    const currentCast = movie?.cast || series?.cast;
    const currentDirector = movie?.director || series?.director;
    const currentTmdbId = movie?.tmdbId || series?.tmdbId;
    const currentKind = movie ? 'movie' : series ? 'series' : undefined;
    const currentId = movie ? movie.streamId : series ? series.seriesId : undefined;

    setImdbData(null);
    setCastDeptFilter('all');

    if (!currentTitle && !currentId) {
      setImdbLoading(false);
      return;
    }

    const controller = new AbortController();
    setImdbLoading(true);
    fetchImdbCast(
      {
        title: currentTitle,
        year: currentYear,
        cast: currentCast,
        director: currentDirector,
        kind: currentKind,
        id: currentId,
        tmdbId: currentTmdbId,
      },
      controller.signal,
    )
      .then((data) => {
        setImdbData(data);
        setImdbLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setImdbData(null);
        setImdbLoading(false);
      });

    return () => controller.abort();
  }, [
    movie?.streamId,
    series?.seriesId,
    movie?.cleanTitle,
    series?.cleanTitle,
    movie?.year,
    series?.year,
    movie?.cast,
    series?.cast,
    movie?.director,
    series?.director,
    movie?.tmdbId,
    series?.tmdbId,
  ]);

  const targetKey =
    target.kind === 'movie'
      ? `movie:${target.id}`
      : target.kind === 'series'
        ? `series:${target.id}:${target.episodeId || ''}`
        : `live:${target.id}:${target.initialCatchupProgram?.id || ''}`;

  useEffect(() => {
    const controller = new AbortController();
    setShowTrailer(false);
    setError('');
    setLanguageData(null);
    setSelectedEpisodeIds(new Set());
    setQualityPrompt(null);
    setSeriesDownloadOpen(false);
    autoOpenedModalTargetRef.current = '';
    setParentalPinInput('');
    setParentalPinError('');
    liveTimeRef.current = 0;

    if (target.kind === 'movie') {
      setSeries(null);
      setLiveChannel(null);
      setRelatedChannels([]);
      setEpgPrograms([]);
      setEpgLoading(false);

      const saved = continueRef.current.find(
        (c) => c.kind === 'movie' && c.id === target.id,
      );
      const initialResume = target.resumeSec ?? saved?.progressSec;

      const shouldUseOfflineFirst =
        Boolean(target.preferOffline) ||
        (typeof navigator !== 'undefined' && navigator.onLine === false);

      if (target.initialMovie && !shouldUseOfflineFirst && !offlineDownloads.some((d) => d.key === `movie:${target.id}`)) {
        setActivePlayback({
          kind: 'movie',
          id: target.id,
          title: target.initialMovie.title,
          subtitle: target.initialMovie.subtitle,
          poster: target.initialMovie.poster,
          playUrl: target.initialMovie.playUrl,
          extension: target.initialMovie.extension,
          resumeSec: initialResume,
        });
      } else {
        setActivePlayback(null);
      }

      setLoading(true);
      setMovie(null);

      let lastOfflineError = '';
      const hydrateOfflineMovie = async (resumeSec?: number): Promise<boolean> => {
        const [offlineMedia, cachedMovie] = await Promise.all([
          createOfflinePlaybackUrl(`movie:${target.id}`).catch((err: unknown) => {
            lastOfflineError = err instanceof Error ? err.message : '';
            return null;
          }),
          getCachedMovieDetail(target.id).catch(() => null),
        ]);
        if (!offlineMedia || controller.signal.aborted) return false;
        const entry = offlineMedia.entry;

        revokeOfflineObjectUrls();
        if (offlineMedia.url.startsWith('blob:')) {
          offlineObjectUrlsRef.current.push(offlineMedia.url);
        }
        if (offlineMedia.posterUrl && offlineMedia.posterUrl.startsWith('blob:')) {
          offlineObjectUrlsRef.current.push(offlineMedia.posterUrl);
        }

        const posterSrc = offlineMedia.posterUrl || cachedMovie?.poster || entry.poster;
        const offlineMovie: MovieDetail = cachedMovie
          ? {
              ...cachedMovie,
              poster: posterSrc,
              backdrop: cachedMovie.backdrop || posterSrc,
              playUrl: offlineMedia.url,
            }
          : {
              streamId: entry.id,
              name: entry.title,
              cleanTitle: entry.title,
              year: entry.year,
              qualityTag: null,
              poster: posterSrc,
              rating: entry.rating,
              added: Math.floor(entry.downloadedAt / 1000),
              categoryId: '',
              categoryName: entry.categoryName,
              extension: entry.extension,
              backdrop: posterSrc,
              plot: entry.plot || '',
              cast: '',
              director: '',
              genre: entry.categoryName,
              releaseDate: entry.year || '',
              duration: entry.duration || '',
              youtubeTrailer: '',
              tmdbId: '',
              playUrl: offlineMedia.url,
              related: [],
            };
        setMovie(offlineMovie);
        setError('');
        setLoading(false);
        setActivePlayback({
          kind: 'movie',
          id: entry.id,
          title: offlineMovie.cleanTitle || entry.title,
          subtitle: offlineMovie.categoryName || entry.categoryName,
          poster: posterSrc,
          playUrl: offlineMedia.url,
          extension: entry.extension,
          resumeSec,
          rating: offlineMovie.rating || entry.rating,
          isOffline: true,
          localFilePath: offlineMedia.rawNativePath || entry.privateFilePath || entry.localFileUri,
          offlineMimeType: entry.mimeType,
          offlineSubtitles: entry.subtitles,
          offlineDurationSec: entry.durationSec,
        });

        if (
          typeof navigator !== 'undefined' &&
          navigator.onLine !== false &&
          (!cachedMovie || !cachedMovie.cast)
        ) {
          fetchMovieDetail(target.id, controller.signal)
            .then((fresh) => {
              if (!controller.signal.aborted) {
                setMovie((prev) => (prev ? { ...fresh, playUrl: prev.playUrl } : fresh));
              }
            })
            .catch(() => {
              // Keep offline playback uninterrupted if metadata enrichment fails
            });
        }
        return true;
      };

      const cachedMovieSync = getCachedMovieDetailSync(target.id);
      if (cachedMovieSync) {
        setMovie(cachedMovieSync);
      }

      // Always prefer a verified locally downloaded copy first so downloaded movies play instantly without network buffering
      void hydrateOfflineMovie(initialResume).then((handled) => {
        if (handled || controller.signal.aborted) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setError(lastOfflineError || 'Offline movie copy is unavailable.');
          setLoading(false);
          return;
        }
        fetchMovieDetail(target.id, controller.signal)
          .then((d) => {
            setMovie(d);
            setLoading(false);
            setActivePlayback({
              kind: 'movie',
              id: d.streamId,
              title: d.cleanTitle,
              subtitle: d.categoryName,
              poster: d.poster,
              playUrl: d.playUrl,
              extension: d.extension,
              resumeSec: initialResume,
              rating: d.rating,
              language: extractCardLanguage(d.name, d.categoryName),
              year: d.year,
              imdbId: d.tmdbId?.startsWith('tt') ? d.tmdbId : undefined,
            });
          })
          .catch((err) => {
            if (err.name === 'AbortError') return;
            setError(lastOfflineError || err.message || 'Unable to load movie details');
            setLoading(false);
          });
      });
    } else if (target.kind === 'series') {
      setMovie(null);
      setLiveChannel(null);
      setRelatedChannels([]);
      setEpgPrograms([]);
      setEpgLoading(false);
      const cachedSeriesSync = getCachedSeriesDetailSync(target.id);
      if (cachedSeriesSync) {
        setSeries(cachedSeriesSync);
        setLoading(false);
      } else {
        setLoading(true);
        setSeries(null);
      }
      setActivePlayback(null);

      const hydrateOfflineSeries = async (): Promise<boolean> => {
        const preloadedMediaPromise = target.episodeId
          ? createOfflinePlaybackUrl(`episode:${target.episodeId}`).catch(() => null)
          : Promise.resolve(null);

        const [allOffline, cachedSeries, preloadedMedia] = await Promise.all([
          listOfflineDownloads().catch(() => []),
          getCachedSeriesDetail(target.id).catch(() => null),
          preloadedMediaPromise,
        ]);
        if (controller.signal.aborted) return false;

        const matchingEps = allOffline.filter(
          (item) =>
            item.kind === 'episode' &&
            (item.seriesId === target.id ||
              (target.episodeId && item.id === target.episodeId)),
        );
        if (matchingEps.length === 0 && !preloadedMedia) return false;

        const targetEntry =
          preloadedMedia?.entry ||
          (target.episodeId
            ? matchingEps.find((e) => e.id === target.episodeId)
            : undefined) ||
          matchingEps[0];

        if (!targetEntry) return false;

        const offlineMedia =
          preloadedMedia ||
          (await createOfflinePlaybackUrl(targetEntry.key).catch(() => null));
        if (!offlineMedia || controller.signal.aborted) return false;

        revokeOfflineObjectUrls();
        if (offlineMedia.url.startsWith('blob:')) {
          offlineObjectUrlsRef.current.push(offlineMedia.url);
        }
        if (offlineMedia.posterUrl && offlineMedia.posterUrl.startsWith('blob:')) {
          offlineObjectUrlsRef.current.push(offlineMedia.posterUrl);
        }

        // Merge cached SeriesDetail (all seasons, episode details, plot, cast, director) with offline episodes
        const episodesBySeason: Record<string, EpisodeSummary[]> = {};
        if (cachedSeries?.episodesBySeason) {
          for (const [sKey, list] of Object.entries(cachedSeries.episodesBySeason)) {
            episodesBySeason[sKey] = [...list];
          }
        }

        const seasonSet = new Set<number>(
          Object.keys(episodesBySeason)
            .map((k) => Number(k))
            .filter((n) => Number.isFinite(n)),
        );

        for (const epEntry of matchingEps) {
          const sNum = epEntry.seasonNum ?? 1;
          seasonSet.add(sNum);
          const sKey = String(sNum);
          if (!episodesBySeason[sKey]) episodesBySeason[sKey] = [];
          const existsInCache = episodesBySeason[sKey].some(
            (e) => e.episodeId === epEntry.id,
          );
          if (!existsInCache) {
            episodesBySeason[sKey].push({
              episodeId: epEntry.id,
              episodeNum: epEntry.episodeNum ?? 1,
              seasonNum: sNum,
              title: epEntry.subtitle || epEntry.title,
              plot: epEntry.plot || '',
              duration: epEntry.duration || '',
              durationSec: 0,
              thumbnail: epEntry.poster,
              rating: epEntry.rating,
              extension: epEntry.extension,
              playUrl: '',
            });
          }
        }
        for (const key of Object.keys(episodesBySeason)) {
          episodesBySeason[key].sort((a, b) => a.episodeNum - b.episodeNum);
        }

        const posterSrc =
          offlineMedia.posterUrl || cachedSeries?.poster || targetEntry.poster;

        const seasons =
          cachedSeries?.seasons && cachedSeries.seasons.length > 0
            ? cachedSeries.seasons
            : Array.from(seasonSet)
                .sort((a, b) => a - b)
                .map((num) => ({
                  seasonNumber: num,
                  name: `Season ${num}`,
                  episodeCount: (episodesBySeason[String(num)] || []).length,
                  cover: posterSrc,
                  airDate: targetEntry.year || '',
                }));

        const offlineSeries: SeriesDetail = cachedSeries
          ? {
              ...cachedSeries,
              poster: cachedSeries.poster || posterSrc,
              backdrop: cachedSeries.backdrop || posterSrc,
              seasons,
              episodesBySeason,
            }
          : {
              seriesId: targetEntry.seriesId || target.id,
              name: targetEntry.seriesTitle || targetEntry.title,
              cleanTitle: targetEntry.seriesTitle || targetEntry.title,
              year: targetEntry.year,
              poster: posterSrc,
              backdrop: posterSrc,
              plot: targetEntry.plot || '',
              genre: targetEntry.categoryName,
              releaseDate: targetEntry.year || '',
              rating: targetEntry.rating,
              lastModified: Math.floor(targetEntry.downloadedAt / 1000),
              categoryId: '',
              categoryName: targetEntry.categoryName,
              cast: '',
              director: '',
              youtubeTrailer: '',
              episodeRunTime: '',
              seasons,
              episodesBySeason,
              related: [],
            };

        const activeSeasonKey = String(targetEntry.seasonNum ?? 1);
        const cachedMatchedEp = (episodesBySeason[activeSeasonKey] || []).find(
          (e) => e.episodeId === targetEntry.id,
        );

        const epHist = continueRef.current.find(
          (c) => c.kind === 'episode' && c.id === targetEntry.id,
        );
        const resumeAt = target.resumeSec ?? epHist?.progressSec;

        setSeries(offlineSeries);
        setSelectedSeason(activeSeasonKey);
        setError('');
        setLoading(false);
        setActivePlayback({
          kind: 'episode',
          id: targetEntry.id,
          seriesId: offlineSeries.seriesId,
          title: cachedMatchedEp
            ? `${offlineSeries.cleanTitle} — S${cachedMatchedEp.seasonNum}E${cachedMatchedEp.episodeNum}`
            : targetEntry.title,
          subtitle: cachedMatchedEp?.title || targetEntry.subtitle,
          poster: cachedMatchedEp?.thumbnail || posterSrc,
          playUrl: offlineMedia.url,
          extension: targetEntry.extension,
          resumeSec: resumeAt,
          seriesDetail: offlineSeries,
          seasonNum: targetEntry.seasonNum,
          episodeNum: targetEntry.episodeNum,
          rating: offlineSeries.rating || targetEntry.rating,
          isOffline: true,
          localFilePath:
            offlineMedia.rawNativePath || targetEntry.privateFilePath || targetEntry.localFileUri,
          offlineMimeType: targetEntry.mimeType,
          offlineSubtitles: targetEntry.subtitles,
          offlineDurationSec: targetEntry.durationSec,
        });

        // If cache was cold and device is online, silently enrich series/episode details in background
        if (
          !cachedSeries &&
          typeof navigator !== 'undefined' &&
          navigator.onLine !== false
        ) {
          fetchSeriesDetail(target.id, controller.signal)
            .then((fresh) => {
              if (!controller.signal.aborted) {
                setSeries(fresh);
                setActivePlayback((prev) =>
                  prev && prev.isOffline && prev.seriesId === fresh.seriesId
                    ? { ...prev, seriesDetail: fresh }
                    : prev,
                );
              }
            })
            .catch(() => {
              // Ignore background enrichment errors when offline/restricted
            });
        }

        return true;
      };

      const shouldUseOfflineFirst =
        Boolean(target.preferOffline) ||
        (typeof navigator !== 'undefined' && navigator.onLine === false);

      const loadOnlineSeries = () =>
        fetchSeriesDetail(target.id, controller.signal).then(async (d) => {
          setSeries(d);
          const keys = Object.keys(d.episodesBySeason).sort(
            (a, b) => Number(a) - Number(b),
          );

          let initialEp: EpisodeSummary | undefined;
          if (target.episodeId) {
            for (const list of Object.values(d.episodesBySeason)) {
              const found = list.find((e) => e.episodeId === target.episodeId);
              if (found) {
                initialEp = found;
                break;
              }
            }
          }
          if (!initialEp && target.seasonNum !== undefined && target.episodeNum !== undefined) {
            const seasonList = d.episodesBySeason[String(target.seasonNum)] || [];
            initialEp = seasonList.find((e) => e.episodeNum === target.episodeNum);
          }

          let savedEntry: WatchHistoryEntry | undefined;
          if (!initialEp) {
            savedEntry = continueRef.current
              .filter(
                (c) =>
                  c.kind === 'episode' &&
                  (c.seriesId === d.seriesId ||
                    c.seriesTitle?.toLowerCase() === d.cleanTitle.toLowerCase()),
              )
              .sort((a, b) => b.updatedAt - a.updatedAt)[0];

            if (savedEntry) {
              for (const list of Object.values(d.episodesBySeason)) {
                const found = list.find((e) => e.episodeId === savedEntry?.id);
                if (found) {
                  initialEp = found;
                  break;
                }
              }
            }
          }

          if (!initialEp && keys.length > 0) {
            initialEp = d.episodesBySeason[keys[0]]?.[0];
          }

          const initialSeasonKey =
            (target.kind === 'series' &&
              target.initialSeason &&
              d.episodesBySeason[target.initialSeason] &&
              target.initialSeason) ||
            (initialEp ? String(initialEp.seasonNum) : keys[0] || '');
          setSelectedSeason(initialSeasonKey);

          if (initialEp) {
            const epHist = continueRef.current.find(
              (c) => c.kind === 'episode' && c.id === initialEp?.episodeId,
            );
            const resumeAt = target.resumeSec ?? epHist?.progressSec;
            const offlineEp = await getOfflineDownload(`episode:${initialEp.episodeId}`).catch(
              () => null,
            );
            if (offlineEp && !controller.signal.aborted) {
              const offlineMedia = await createOfflinePlaybackUrl(offlineEp.key).catch(() => null);
              if (offlineMedia && !controller.signal.aborted) {
                revokeOfflineObjectUrls();
                if (offlineMedia.url.startsWith('blob:')) {
                  offlineObjectUrlsRef.current.push(offlineMedia.url);
                }
                if (offlineMedia.posterUrl && offlineMedia.posterUrl.startsWith('blob:')) {
                  offlineObjectUrlsRef.current.push(offlineMedia.posterUrl);
                }
                setActivePlayback({
                  kind: 'episode',
                  id: initialEp.episodeId,
                  seriesId: d.seriesId,
                  title: `${d.cleanTitle} — S${initialEp.seasonNum}E${initialEp.episodeNum}`,
                  subtitle: initialEp.title,
                  poster: offlineMedia.posterUrl || initialEp.thumbnail || d.poster,
                  playUrl: offlineMedia.url,
                  extension: offlineEp.extension,
                  resumeSec: resumeAt,
                  seriesDetail: d,
                  seasonNum: initialEp.seasonNum,
                  episodeNum: initialEp.episodeNum,
                  rating: d.rating,
                  isOffline: true,
                  localFilePath:
                    offlineMedia.rawNativePath || offlineEp.privateFilePath || offlineEp.localFileUri,
                  offlineMimeType: offlineEp.mimeType,
                  offlineSubtitles: offlineEp.subtitles,
                  offlineDurationSec: offlineEp.durationSec,
                });
                setLoading(false);
                return;
              }
            }

            setActivePlayback({
              kind: 'episode',
              id: initialEp.episodeId,
              seriesId: d.seriesId,
              title: `${d.cleanTitle} — S${initialEp.seasonNum}E${initialEp.episodeNum}`,
              subtitle: initialEp.title,
              poster: initialEp.thumbnail || d.poster,
              playUrl: initialEp.playUrl,
              extension: initialEp.extension,
              resumeSec: resumeAt,
              seriesDetail: d,
              seasonNum: initialEp.seasonNum,
              episodeNum: initialEp.episodeNum,
              rating: d.rating,
              language: extractCardLanguage(d.name, d.categoryName),
              year: d.year,
              imdbId: d.tmdbId?.startsWith('tt') ? d.tmdbId : undefined,
            });
          }
          setLoading(false);
        });

      const runOnlineSeriesFallback = () => {
        loadOnlineSeries().catch(async (err) => {
          if (err.name === 'AbortError') return;
          const fellBack = await hydrateOfflineSeries();
          if (fellBack || controller.signal.aborted) return;
          setError(err.message || 'Unable to load series details');
          setLoading(false);
        });
      };

      if (shouldUseOfflineFirst) {
        void hydrateOfflineSeries().then((handled) => {
          if (handled || controller.signal.aborted) return;
          loadOnlineSeries().catch((err) => {
            if (err.name === 'AbortError') return;
            setError(err.message || 'Unable to load series details');
            setLoading(false);
          });
        });
      } else if (target.episodeId) {
        void getOfflineDownload(`episode:${target.episodeId}`)
          .catch(() => null)
          .then((found) => {
            if (controller.signal.aborted) return;
            if (found) {
              void hydrateOfflineSeries().then((handled) => {
                if (!handled && !controller.signal.aborted) {
                  runOnlineSeriesFallback();
                }
              });
            } else {
              runOnlineSeriesFallback();
            }
          });
      } else {
        runOnlineSeriesFallback();
      }
    } else {
      setMovie(null);
      setSeries(null);
      setRelatedChannels([]);
      setLoading(false);
      setEpgLoading(true);
      setEpgPrograms([]);
      setEpgFilter('upcoming');

      const seedChannel = target.channel || null;
      const catchupProg = target.initialCatchupProgram;
      setLiveChannel(seedChannel);

      if (catchupProg && seedChannel) {
        setActivePlayback({
          kind: 'catchup',
          id: seedChannel.streamId,
          title: `${seedChannel.name} — ${catchupProg.title}`,
          subtitle: `Catch-up Replay (${catchupProg.startLabel}–${catchupProg.stopLabel} UTC)`,
          poster: seedChannel.logo,
          playUrl: `/api/play/catchup/${seedChannel.streamId}?startTs=${catchupProg.startTimestamp}&duration=${catchupProg.archiveDurationMin}`,
          extension: 'ts',
          liveChannel: seedChannel,
        });
        onChannelOpenedRef.current?.(seedChannel);
      } else if (seedChannel) {
        setActivePlayback({
          kind: 'live',
          id: seedChannel.streamId,
          title: seedChannel.name,
          subtitle: seedChannel.categoryName,
          poster: seedChannel.logo,
          playUrl: seedChannel.playUrl,
          liveChannel: seedChannel,
          nowPlaying: seedChannel.nowPlaying,
          nextProgram: seedChannel.nextProgram,
        });
        onChannelOpenedRef.current?.(seedChannel);
      } else {
        setActivePlayback({
          kind: 'live',
          id: target.id,
          title: 'Live Channel',
          playUrl: `/api/play/live/${target.id}.ts`,
        });
      }

      fetchLiveChannelDetail(target.id, controller.signal)
        .then((res) => {
          setLiveChannel(res.channel);
          setEpgPrograms(res.programs);
          setRelatedChannels(res.related || []);
          setServerTimestamp(res.serverTimestamp);
          setEpgLoading(false);
          if (catchupProg) {
            setActivePlayback({
              kind: 'catchup',
              id: res.channel.streamId,
              title: `${res.channel.name} — ${catchupProg.title}`,
              subtitle: `Catch-up Replay (${catchupProg.startLabel}–${catchupProg.stopLabel} UTC)`,
              poster: res.channel.logo,
              playUrl: `/api/play/catchup/${res.channel.streamId}?startTs=${catchupProg.startTimestamp}&duration=${catchupProg.archiveDurationMin}`,
              extension: 'ts',
              liveChannel: res.channel,
            });
          } else {
            setActivePlayback({
              kind: 'live',
              id: res.channel.streamId,
              title: res.channel.name,
              subtitle: res.channel.categoryName,
              poster: res.channel.logo,
              playUrl: res.channel.playUrl,
              liveChannel: res.channel,
              nowPlaying: res.channel.nowPlaying,
              nextProgram: res.channel.nextProgram,
            });
          }
          onChannelOpenedRef.current?.(res.channel);
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          if (!seedChannel) {
            setError(err.message || 'Unable to load channel details');
          }
          setEpgLoading(false);
        });
    }

    return () => controller.abort();
  }, [targetKey]);

  // Preload initial stream segments/chunks immediately as soon as activePlayback resolves
  useEffect(() => {
    if (!activePlayback || activePlayback.isOffline || !activePlayback.id) return;
    if (activePlayback.kind === 'catchup') return;
    const controller = new AbortController();
    void preloadStreamMedia(
      {
        kind: activePlayback.kind,
        id: activePlayback.id,
        ext: activePlayback.extension,
        quality: settings.defaultQuality,
        startSec:
          activePlayback.resumeSec && activePlayback.resumeSec > 5
            ? Math.floor(activePlayback.resumeSec)
            : 0,
      },
      controller.signal,
    ).catch(() => {
      // Non-blocking warmup
    });
    return () => controller.abort();
  }, [
    activePlayback?.kind,
    activePlayback?.id,
    activePlayback?.extension,
    activePlayback?.isOffline,
    activePlayback?.resumeSec,
    settings.defaultQuality,
  ]);

  useEffect(() => {
    if (target.kind !== 'series' || !target.openDownloadModal || !series) return;
    if (series.seriesId !== target.id) return;
    const modalOpenKey = `${targetKey}:${target.initialSeason || ''}:${target.seasonNum || ''}`;
    if (autoOpenedModalTargetRef.current === modalOpenKey) return;
    autoOpenedModalTargetRef.current = modalOpenKey;

    if (target.initialSeason && series.episodesBySeason[target.initialSeason]) {
      setSelectedSeason(target.initialSeason);
    } else if (target.seasonNum && series.episodesBySeason[String(target.seasonNum)]) {
      setSelectedSeason(String(target.seasonNum));
    }
    setSeriesDownloadOpen(true);
  }, [target, targetKey, series]);

  const saved =
    target.kind === 'movie'
      ? watchlist.some((w) => w.key === `movie:${target.id}`)
      : target.kind === 'series'
        ? watchlist.some((w) => w.key === `series:${target.id}`)
        : false;

  const channelPinned =
    target.kind === 'live'
      ? favoriteChannels.some((c) => c.streamId === target.id)
      : false;

  const savedKeys = useMemo(() => new Set(watchlist.map((w) => w.key)), [watchlist]);
  const favoriteChannelIds = useMemo(
    () => new Set(favoriteChannels.map((c) => c.streamId)),
    [favoriteChannels],
  );
  const openRelated = onSelectRelated || onNavigateDetail;
  const relatedMovies = useMemo(
    () =>
      (movie?.related || []).filter(
        (m) =>
          !isRestrictedContent(
            { title: m.cleanTitle, categoryName: m.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
    [movie?.related, settings, parentalUnlocked],
  );
  const relatedSeries = useMemo(
    () =>
      (series?.related || []).filter(
        (s) =>
          !isRestrictedContent(
            { title: s.cleanTitle, categoryName: s.categoryName, genre: s.genre },
            settings,
            parentalUnlocked,
          ),
      ),
    [series?.related, settings, parentalUnlocked],
  );
  const visibleRelatedChannels = useMemo(
    () =>
      relatedChannels.filter(
        (c) =>
          !isRestrictedContent(
            { title: c.name, categoryName: c.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
    [relatedChannels, settings, parentalUnlocked],
  );

  const trailerId = extractYouTubeId(movie?.youtubeTrailer || series?.youtubeTrailer || '') || '';

  const seasonKeys = series
    ? Object.keys(series.episodesBySeason).sort((a, b) => Number(a) - Number(b))
    : [];
  const activeEpisodes =
    series && selectedSeason ? series.episodesBySeason[selectedSeason] || [] : [];

  const activeEpisodeDetail = useMemo<EpisodeSummary | null>(() => {
    if (!series || !activePlayback || activePlayback.kind !== 'episode') return null;
    for (const list of Object.values(series.episodesBySeason)) {
      const match = list.find((ep) => ep.episodeId === activePlayback.id);
      if (match) return match;
    }
    if (activePlayback.seasonNum !== undefined && activePlayback.episodeNum !== undefined) {
      const sList = series.episodesBySeason[String(activePlayback.seasonNum)] || [];
      return sList.find((ep) => ep.episodeNum === activePlayback.episodeNum) || null;
    }
    return null;
  }, [series, activePlayback]);

  const catalogVariants = languageData?.catalogVariants || [];

  const visibleEpgPrograms = useMemo(() => {
    if (epgFilter === 'all') return epgPrograms;
    const upcoming = epgPrograms.filter((p) => p.stopTimestamp >= serverTimestamp - 300);
    return upcoming.length > 0 ? upcoming : epgPrograms;
  }, [epgPrograms, epgFilter, serverTimestamp]);

  const nowProgram = useMemo(
    () =>
      epgPrograms.find(
        (p) =>
          p.isNowPlaying ||
          (p.startTimestamp <= serverTimestamp && p.stopTimestamp > serverTimestamp),
      ) ||
      liveChannel?.nowPlaying ||
      null,
    [epgPrograms, serverTimestamp, liveChannel?.nowPlaying],
  );

  const nextProgram = useMemo(() => {
    if (nowProgram) {
      const idx = epgPrograms.findIndex((p) => p.id === nowProgram.id);
      if (idx >= 0 && idx + 1 < epgPrograms.length) {
        return epgPrograms[idx + 1];
      }
    }
    return (
      epgPrograms.find((p) => p.startTimestamp > serverTimestamp) ||
      liveChannel?.nextProgram ||
      null
    );
  }, [epgPrograms, nowProgram, serverTimestamp, liveChannel?.nextProgram]);

  const nowProgressPct = useMemo(() => {
    if (!nowProgram || nowProgram.stopTimestamp <= nowProgram.startTimestamp) return 0;
    const pct =
      ((serverTimestamp - nowProgram.startTimestamp) /
        (nowProgram.stopTimestamp - nowProgram.startTimestamp)) *
      100;
    return Math.max(2, Math.min(100, Math.round(pct)));
  }, [nowProgram, serverTimestamp]);

  async function playEpisodeOnPage(ep: EpisodeSummary, shouldScrollTop = false) {
    if (!series) return;
    setShowTrailer(false);
    setSelectedSeason(String(ep.seasonNum));
    const savedEp = continueEntries.find(
      (c) => c.kind === 'episode' && c.id === ep.episodeId,
    );

    const epOfflineKey = `episode:${ep.episodeId}`;
    const hasOfflineCopy = offlineMap.has(epOfflineKey);

    if (hasOfflineCopy) {
      const offlineMedia = await createOfflinePlaybackUrl(epOfflineKey).catch(() => null);
      if (offlineMedia) {
        revokeOfflineObjectUrls();
        if (offlineMedia.url.startsWith('blob:')) {
          offlineObjectUrlsRef.current.push(offlineMedia.url);
        }
        if (offlineMedia.posterUrl && offlineMedia.posterUrl.startsWith('blob:')) {
          offlineObjectUrlsRef.current.push(offlineMedia.posterUrl);
        }
        setActivePlayback({
          kind: 'episode',
          id: ep.episodeId,
          seriesId: series.seriesId,
          title: `${series.cleanTitle} — S${ep.seasonNum}E${ep.episodeNum}`,
          subtitle: ep.title,
          poster: offlineMedia.posterUrl || ep.thumbnail || series.poster,
          playUrl: offlineMedia.url,
          extension: offlineMedia.entry.extension,
          resumeSec: savedEp?.progressSec,
          seriesDetail: series,
          seasonNum: ep.seasonNum,
          episodeNum: ep.episodeNum,
          rating: series.rating,
          isOffline: true,
          localFilePath:
            offlineMedia.rawNativePath ||
            offlineMedia.entry.privateFilePath ||
            offlineMedia.entry.localFileUri,
          offlineMimeType: offlineMedia.entry.mimeType,
          offlineSubtitles: offlineMedia.entry.subtitles,
          offlineDurationSec: offlineMedia.entry.durationSec,
        });
        if (shouldScrollTop) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }
    }

    setActivePlayback({
      kind: 'episode',
      id: ep.episodeId,
      seriesId: series.seriesId,
      title: `${series.cleanTitle} — S${ep.seasonNum}E${ep.episodeNum}`,
      subtitle: ep.title,
      poster: ep.thumbnail || series.poster,
      playUrl: ep.playUrl,
      extension: ep.extension,
      resumeSec: savedEp?.progressSec,
      seriesDetail: series,
      seasonNum: ep.seasonNum,
      episodeNum: ep.episodeNum,
      rating: series.rating,
      language: extractCardLanguage(series.name, series.categoryName),
      year: series.year,
      imdbId: series.tmdbId?.startsWith('tt') ? series.tmdbId : undefined,
    });
    if (shouldScrollTop) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function toggleEpisodeSelection(episodeId: string) {
    setSelectedEpisodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(episodeId)) next.delete(episodeId);
      else next.add(episodeId);
      return next;
    });
  }

  function handleConfirmDownloadQuality(
    quality: DownloadQuality,
    resolvedSize?: ResolvedDownloadSize,
  ) {
    if (!qualityPrompt) return;

    if (qualityPrompt.mode === 'movie' && movie) {
      queueDownload({
        kind: 'movie',
        id: movie.streamId,
        title: movie.cleanTitle,
        subtitle: movie.categoryName,
        categoryName: movie.categoryName,
        year: movie.year,
        rating: movie.rating,
        duration: movie.duration,
        plot: movie.plot,
        poster: movie.poster,
        playUrl: movie.playUrl,
        extension: movie.extension,
        quality,
        expectedTotalBytes:
          resolvedSize && resolvedSize.bytes > 0 ? resolvedSize.bytes : undefined,
        isEstimatedTotal:
          resolvedSize && resolvedSize.bytes > 0 ? !resolvedSize.exact : undefined,
      });
    } else if (qualityPrompt.mode === 'episodes' && series) {
      const refDuration = resolvedSize?.durationSec || 0;
      const bytesPerSec =
        resolvedSize && resolvedSize.bytes > 0 && refDuration > 0
          ? resolvedSize.bytes / refDuration
          : 0;
      for (const ep of qualityPrompt.episodes) {
        if (!ep.playUrl) continue;
        let expectedTotalBytes: number | undefined;
        let isEstimatedTotal = true;
        if (qualityPrompt.episodes.length === 1 && resolvedSize?.bytes) {
          expectedTotalBytes = resolvedSize.bytes;
          isEstimatedTotal = !resolvedSize.exact;
        } else if (bytesPerSec > 0 && ep.durationSec && ep.durationSec > 0) {
          expectedTotalBytes = Math.round(ep.durationSec * bytesPerSec);
        } else if (resolvedSize?.bytes) {
          expectedTotalBytes = resolvedSize.bytes;
        }
        queueDownload({
          kind: 'episode',
          id: ep.episodeId,
          seriesId: series.seriesId,
          seriesTitle: series.cleanTitle,
          seasonNum: ep.seasonNum,
          episodeNum: ep.episodeNum,
          title: `${series.cleanTitle} — S${ep.seasonNum}E${ep.episodeNum}`,
          subtitle: ep.title,
          categoryName: series.categoryName,
          year: series.year,
          rating: series.rating,
          duration: ep.duration || series.episodeRunTime,
          plot: ep.plot || series.plot,
          poster: ep.thumbnail || series.poster,
          playUrl: ep.playUrl,
          extension: ep.extension,
          quality,
          expectedTotalBytes,
          isEstimatedTotal: expectedTotalBytes ? isEstimatedTotal : undefined,
        });
      }
      if (qualityPrompt.episodes.length > 1) {
        setSelectedEpisodeIds(new Set());
      } else if (qualityPrompt.episodes[0]) {
        setSelectedEpisodeIds((prev) => {
          if (!prev.has(qualityPrompt.episodes[0].episodeId)) return prev;
          const next = new Set(prev);
          next.delete(qualityPrompt.episodes[0].episodeId);
          return next;
        });
      }
    }

    setQualityPrompt(null);
  }

  function handlePlayerSwitchPlayback(nextPlayback: ActivePlayback) {
    if (nextPlayback.kind === 'movie' && nextPlayback.id !== target.id) {
      onNavigateDetail({
        kind: 'movie',
        id: nextPlayback.id,
        autoplay: true,
        resumeSec: nextPlayback.resumeSec,
        initialMovie: {
          title: nextPlayback.title,
          subtitle: nextPlayback.subtitle,
          poster: nextPlayback.poster,
          playUrl: nextPlayback.playUrl,
          extension: nextPlayback.extension,
        },
      });
      return;
    }
    if (
      nextPlayback.kind === 'episode' &&
      nextPlayback.seriesId &&
      nextPlayback.seriesId !== target.id
    ) {
      onNavigateDetail({
        kind: 'series',
        id: nextPlayback.seriesId,
        episodeId: nextPlayback.id,
        seasonNum: nextPlayback.seasonNum,
        episodeNum: nextPlayback.episodeNum,
        resumeSec: nextPlayback.resumeSec,
      });
      return;
    }

    setActivePlayback(nextPlayback);
    if (nextPlayback.seasonNum !== undefined) {
      setSelectedSeason(String(nextPlayback.seasonNum));
    }
  }

  function handleVersionButtonSelect(variant: CatalogLanguageVariant) {
    if (variant.isCurrent) return;
    const resumeAt = Math.max(0, Math.floor(liveTimeRef.current));
    if (variant.kind === 'movie') {
      onNavigateDetail({
        kind: 'movie',
        id: variant.id,
        autoplay: true,
        resumeSec: resumeAt >= 1 ? resumeAt : undefined,
        initialMovie: {
          title: variant.cleanTitle,
          subtitle: variant.categoryName,
          poster: variant.poster,
          playUrl: variant.playUrl,
          extension: variant.extension,
        },
      });
    } else if (variant.seriesId) {
      onNavigateDetail({
        kind: 'series',
        id: variant.seriesId,
        episodeId: variant.id,
        seasonNum: variant.seasonNum,
        episodeNum: variant.episodeNum,
        resumeSec: resumeAt >= 1 ? resumeAt : undefined,
      });
    }
  }

  function handlePlayCatchup(prog: EpgProgram) {
    if (!liveChannel) return;
    setShowTrailer(false);
    setActivePlayback({
      kind: 'catchup',
      id: liveChannel.streamId,
      title: `${liveChannel.name} — ${prog.title}`,
      subtitle: `Catch-up Replay (${prog.startLabel}–${prog.stopLabel} UTC)`,
      poster: liveChannel.logo,
      playUrl: `/api/play/catchup/${liveChannel.streamId}?startTs=${prog.startTimestamp}&duration=${prog.archiveDurationMin}`,
      extension: 'ts',
      liveChannel,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleReturnToLive() {
    if (!liveChannel) return;
    setActivePlayback({
      kind: 'live',
      id: liveChannel.streamId,
      title: liveChannel.name,
      subtitle: liveChannel.categoryName,
      poster: liveChannel.logo,
      playUrl: liveChannel.playUrl,
      liveChannel,
      nowPlaying: nowProgram,
      nextProgram,
    });
  }

  const backLabel =
    customBackLabel ||
    (target.kind === 'movie'
      ? 'Back to Movies'
      : target.kind === 'series'
        ? 'Back to Series'
        : 'Back to Live TV');

  const activeCategory =
    movie?.categoryName || series?.categoryName || liveChannel?.categoryName || '';

  const restrictedTitle =
    movie?.cleanTitle ||
    (target.kind === 'movie' ? target.initialMovie?.title : '') ||
    series?.cleanTitle ||
    liveChannel?.name ||
    '';
  const restrictedCategory =
    movie?.categoryName ||
    (target.kind === 'movie' ? target.initialMovie?.subtitle : '') ||
    series?.categoryName ||
    liveChannel?.categoryName ||
    '';
  const restrictedGenre = movie?.genre || series?.genre || '';
  const isRestrictedLocked = isRestrictedContent(
    {
      title: restrictedTitle,
      categoryName: restrictedCategory,
      genre: restrictedGenre,
    },
    settings,
    parentalUnlocked,
  );

  const handleUnlockRestricted = (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyParentalPin(parentalPinInput, settings)) {
      setParentalPinError('Incorrect PIN. Please try again.');
      return;
    }
    setParentalPinInput('');
    setParentalPinError('');
    unlockParentalSession();
  };

  return (
    <div className="min-h-screen pb-16">
      {/* Sub-navigation bar */}
      <div className="border-b border-slate-200/80 dark:border-white/[0.06] bg-white dark:bg-[#0B0E15]">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8 py-2.5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg px-2 -ml-2 text-xs sm:text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-950 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span>{backLabel}</span>
          </button>

          {activeCategory && !isRestrictedLocked && (
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate max-w-[55%]">
              {activeCategory}
            </p>
          )}
        </div>
      </div>

      {/* Embedded top media player stage (always cinema dark) */}
      <section className="border-b border-slate-200 dark:border-white/[0.08] bg-[#04060A]">
        <div className="mx-auto max-w-[1440px] sm:px-6 lg:px-8 sm:py-4">
          {isRestrictedLocked ? (
            <div className="flex aspect-video max-h-[72vh] w-full flex-col items-center justify-center bg-[#06080D] p-6 sm:rounded-xl sm:border sm:border-white/10">
              <form
                onSubmit={handleUnlockRestricted}
                className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0E131F] p-6 text-center shadow-lg space-y-4"
              >
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
                  <ShieldAlert className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="font-display text-lg font-bold text-white">
                    Parental Control Locked
                  </h1>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    This title matches your active Parental Control filters. Enter your 4-digit PIN to unlock it for this session.
                  </p>
                </div>

                {parentalPinError && (
                  <p className="text-xs font-medium text-rose-400">{parentalPinError}</p>
                )}

                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={parentalPinInput}
                  onChange={(e) => {
                    setParentalPinInput(e.target.value.replace(/\D/g, '').slice(0, 4));
                    if (parentalPinError) setParentalPinError('');
                  }}
                  aria-label="Enter 4-digit Parental Control PIN"
                  placeholder="••••"
                  className="h-11 w-full rounded-xl border border-white/15 bg-[#070A11] px-4 text-center font-mono text-lg tracking-[0.45em] text-white focus:border-[#E11D48] focus:outline-none"
                />

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-4 text-xs font-semibold text-slate-200 hover:bg-white/10"
                  >
                    <Lock className="h-3.5 w-3.5" />
                    <span>Go Back</span>
                  </button>
                  <button
                    type="submit"
                    className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#E11D48] px-4 text-xs font-semibold text-white hover:bg-[#be123c] transition-colors"
                  >
                    <Unlock className="h-3.5 w-3.5" />
                    <span>Unlock</span>
                  </button>
                </div>
              </form>
            </div>
          ) : showTrailer && trailerId ? (
            <div className="relative aspect-video max-h-[72vh] w-full overflow-hidden bg-black sm:rounded-xl sm:border sm:border-white/10">
              <iframe
                title={`${movie?.cleanTitle || series?.cleanTitle || ''} Trailer`}
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailerId)}?autoplay=1`}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                className="h-full w-full border-0"
              />
              <button
                type="button"
                onClick={() => setShowTrailer(false)}
                className="absolute right-3 top-3 z-10 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/20 bg-black/80 px-3.5 text-xs font-semibold text-white hover:bg-[#E11D48] hover:border-[#E11D48] transition-colors"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Back to Stream</span>
              </button>
            </div>
          ) : activePlayback ? (
            <EmbeddedPlayer
              playback={activePlayback}
              isActive={isActive}
              autoPlay={Boolean(
                (target.kind !== 'live' && (target.autoplay || target.preferOffline)) ||
                  settings.autoPlayOnOpen,
              )}
              onProgress={(ct, dur) => onProgress(activePlayback, ct, dur)}
              onTimeTick={(sec) => {
                liveTimeRef.current = sec;
              }}
              onSelectEpisode={(ep) => playEpisodeOnPage(ep, false)}
              onSwitchPlayback={handlePlayerSwitchPlayback}
              onLanguagesResolved={setLanguageData}
              onReturnToLive={handleReturnToLive}
            />
          ) : (
            <div className="flex aspect-video max-h-[72vh] w-full flex-col items-center justify-center gap-4 bg-[#06080D] sm:rounded-xl sm:border sm:border-white/10">
              {error ? (
                <div className="px-6 text-center">
                  <p className="font-display text-lg font-semibold text-white">
                    Stream Unavailable
                  </p>
                  <p className="mt-1.5 text-sm text-slate-400">{error}</p>
                </div>
              ) : (
                <LoadingSpinner
                  size="lg"
                  tone="dark"
                  label={
                    target.kind !== 'live' && target.preferOffline
                      ? 'Opening offline video...'
                      : 'Preparing stream...'
                  }
                  sublabel={
                    target.kind !== 'live' && target.preferOffline
                      ? 'Loading from device storage'
                      : 'Connecting to direct stream'
                  }
                />
              )}
            </div>
          )}
        </div>
      </section>

      {/* Main Detail Content Area */}
      {!isRestrictedLocked && (
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 pt-6 space-y-10">
        {loading && !movie && !series && !liveChannel && (
          <div className="py-12 flex justify-center">
            <PageLoader label="Loading stream details..." sublabel="Fetching metadata, genres, and episodes" />
          </div>
        )}

        {error && !movie && !series && !liveChannel && (
          <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] p-8 text-center shadow-sm">
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white">
              Unable to Load Details
            </h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{error}</p>
            <button
              type="button"
              onClick={onBack}
              className="mt-5 inline-flex h-10 items-center rounded-lg bg-[#E11D48] px-5 text-sm font-semibold text-white hover:bg-[#BE123C]"
            >
              Go Back
            </button>
          </div>
        )}

        {/* MOVIE OR SERIES DETAIL */}
        {(movie || series) && (
          <>
            <div className="flex flex-col sm:flex-row gap-6 items-start">
              <div className="hidden sm:block w-32 shrink-0 overflow-hidden rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] shadow-md aspect-[2/3]">
                <MediaImage
                  src={movie?.poster || series?.poster}
                  alt={movie?.cleanTitle || series?.cleanTitle || ''}
                  title={movie?.cleanTitle || series?.cleanTitle || ''}
                  year={movie?.year || series?.year}
                  className="h-full w-full"
                />
              </div>

              <div className="min-w-0 flex-1">
                <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white text-balance">
                  {movie?.cleanTitle || series?.cleanTitle}
                </h1>

                {/* Unboxed zero-pill metadata */}
                <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs sm:text-sm text-slate-600 dark:text-slate-300 tabular-nums">
                  {(movie?.year || series?.year) && (
                    <span>{movie?.year || series?.year}</span>
                  )}
                  {(movie?.rating || series?.rating) ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-amber-600 dark:text-amber-400">
                        ★ {(movie?.rating || series?.rating || 0).toFixed(1)}
                      </span>
                    </>
                  ) : null}
                  {movie?.duration && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{movie.duration}</span>
                    </>
                  )}
                  {movie?.extension && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="uppercase">{movie.extension}</span>
                    </>
                  )}
                  {series && activePlayback?.seasonNum !== undefined && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-indigo-600 dark:text-indigo-400">
                        Playing S{activePlayback.seasonNum}E{activePlayback.episodeNum}
                      </span>
                    </>
                  )}
                  {(movie?.genre || series?.genre) && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-500 dark:text-slate-400">{movie?.genre || series?.genre}</span>
                    </>
                  )}
                </p>

                {/* Primary Actions */}
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (movie) {
                        onToggleSave({
                          kind: 'movie',
                          id: movie.streamId,
                          title: movie.cleanTitle,
                          poster: movie.poster,
                          year: movie.year,
                          rating: movie.rating,
                          categoryName: movie.categoryName,
                        });
                      } else if (series) {
                        onToggleSave({
                          kind: 'series',
                          id: series.seriesId,
                          title: series.cleanTitle,
                          poster: series.poster,
                          year: series.year,
                          rating: series.rating,
                          categoryName: series.categoryName,
                        });
                      }
                    }}
                    className={`inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors whitespace-nowrap ${
                      saved
                        ? 'border-[#E11D48] bg-[#E11D48] text-white'
                        : 'border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 shadow-sm shadow-slate-900/5 dark:shadow-none'
                    }`}
                  >
                    <Bookmark className={`h-4 w-4 ${saved ? 'fill-current' : ''}`} />
                    <span>{saved ? 'In Watchlist' : 'Add to Watchlist'}</span>
                  </button>

                  {trailerId && (
                    <button
                      type="button"
                      onClick={() => setShowTrailer((v) => !v)}
                      className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 px-4 text-sm font-medium text-slate-800 dark:text-white hover:bg-slate-100 dark:hover:bg-white/10 shadow-sm shadow-slate-900/5 dark:shadow-none whitespace-nowrap"
                    >
                      <Film className="h-4 w-4 text-[#E11D48]" />
                      <span>{showTrailer ? 'Back to Stream' : 'Watch Trailer'}</span>
                    </button>
                  )}

                  {series &&
                    (() => {
                      const allSeriesEps = Object.values(series.episodesBySeason).flat();
                      const playableCount = allSeriesEps.filter((ep) => Boolean(ep.playUrl)).length;
                      if (playableCount === 0) return null;

                      const savedCount = allSeriesEps.filter((ep) =>
                        offlineMap.has(`episode:${ep.episodeId}`),
                      ).length;
                      const activeCount = allSeriesEps.filter((ep) => {
                        const t = offlineTasks[`episode:${ep.episodeId}`];
                        return (
                          t &&
                          (t.status === 'queued' ||
                            t.status === 'downloading' ||
                            t.status === 'saving')
                        );
                      }).length;
                      const allDownloaded = savedCount >= playableCount && activeCount === 0;

                      if (allDownloaded) {
                        return (
                          <button
                            type="button"
                            disabled
                            aria-disabled="true"
                            className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 text-sm font-semibold text-emerald-700 dark:text-emerald-300 opacity-85 cursor-default pointer-events-none select-none whitespace-nowrap tabular-nums"
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            <span>Downloaded ({savedCount})</span>
                          </button>
                        );
                      }

                      return (
                        <button
                          type="button"
                          onClick={() => setSeriesDownloadOpen(true)}
                          className={`inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border px-4 text-sm font-medium shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors whitespace-nowrap tabular-nums ${
                            activeCount > 0
                              ? 'border-indigo-400/60 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25'
                              : 'border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 text-slate-800 dark:text-slate-200 hover:border-indigo-400 hover:bg-slate-100 dark:hover:bg-white/10'
                          }`}
                        >
                          {activeCount > 0 ? (
                            <Plus className="h-4 w-4 text-indigo-500" />
                          ) : (
                            <Download className="h-4 w-4 text-indigo-500" />
                          )}
                          <span>
                            {activeCount > 0
                              ? `Download More (${activeCount} active)`
                              : savedCount > 0
                                ? `Download More (${savedCount} saved)`
                                : 'Download'}
                          </span>
                        </button>
                      );
                    })()}

                  {movie && activePlayback?.resumeSec && activePlayback.resumeSec > 10 && (
                    <button
                      type="button"
                      onClick={() =>
                        onNavigateDetail({
                          kind: 'movie',
                          id: movie.streamId,
                          autoplay: true,
                          resumeSec: 0,
                        })
                      }
                      className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 px-4 text-sm font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 shadow-sm shadow-slate-900/5 dark:shadow-none whitespace-nowrap"
                    >
                      <RotateCcw className="h-4 w-4 text-indigo-500" />
                      <span>Restart Movie</span>
                    </button>
                  )}

                  {/* Movie Download for Offline Action */}
                  {movie &&
                    (() => {
                      const offlineKey = `movie:${movie.streamId}`;
                      const downloaded = offlineMap.get(offlineKey);
                      const task = offlineTasks[offlineKey];

                      if (downloaded) {
                        return (
                          <div className="inline-flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              disabled
                              aria-disabled="true"
                              className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 text-sm font-semibold text-emerald-700 dark:text-emerald-300 opacity-85 cursor-default pointer-events-none select-none whitespace-nowrap"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                              <span>
                                Downloaded ({downloaded.quality || 'HD'} ·{' '}
                                {formatBytes(downloaded.sizeBytes)})
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeDownload(offlineKey)}
                              aria-label="Remove offline download"
                              title="Remove offline download"
                              className="inline-flex min-h-[44px] sm:min-h-[40px] w-10 items-center justify-center rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        );
                      }

                      if (
                        task &&
                        (task.status === 'queued' ||
                          task.status === 'downloading' ||
                          task.status === 'saving')
                      ) {
                        return (
                          <div className="inline-flex flex-wrap items-center gap-1.5">
                            {task.status !== 'saving' && (
                              <button
                                type="button"
                                onClick={() => pauseDownload(offlineKey)}
                                title="Pause offline download"
                                className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-500/15 px-3.5 text-sm font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/25 transition-colors whitespace-nowrap tabular-nums"
                              >
                                <Pause className="h-4 w-4" />
                                <span>
                                  {task.waitingForNetwork
                                    ? `Waiting (${task.percent}%)`
                                    : task.status === 'queued'
                                      ? `Queued (${task.quality}) · Pause`
                                      : `${task.quality} · ${task.percent}% (${
                                          task.speedBytesPerSec > 0
                                            ? formatSpeed(task.speedBytesPerSec)
                                            : formatBytes(task.receivedBytes)
                                        }) · Pause`}
                                </span>
                              </button>
                            )}
                            {task.status === 'saving' && (
                              <span className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-4 text-sm font-semibold text-indigo-700 dark:text-indigo-200 whitespace-nowrap">
                                Saving offline...
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => cancelDownload(offlineKey)}
                              aria-label="Cancel offline download"
                              title="Cancel offline download"
                              className="inline-flex min-h-[44px] sm:min-h-[40px] w-10 items-center justify-center rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        );
                      }

                      if (task && (task.status === 'paused' || task.status === 'error')) {
                        return (
                          <div className="inline-flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void resumeDownload(offlineKey)}
                              className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border border-indigo-400/60 bg-indigo-50 dark:bg-indigo-500/15 px-4 text-sm font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors whitespace-nowrap tabular-nums"
                            >
                              <RotateCcw className="h-4 w-4" />
                              <span>
                                Resume Download
                                {task.percent > 0 ? ` (${task.percent}%)` : ''}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelDownload(offlineKey)}
                              aria-label="Cancel paused download"
                              title="Cancel download"
                              className="inline-flex min-h-[44px] sm:min-h-[40px] w-10 items-center justify-center rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        );
                      }

                      return (
                        <button
                          type="button"
                          onClick={() => setQualityPrompt({ mode: 'movie' })}
                          className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 px-4 text-sm font-medium text-slate-800 dark:text-slate-200 hover:border-indigo-400 hover:bg-slate-100 dark:hover:bg-white/10 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors whitespace-nowrap"
                        >
                          <Download className="h-4 w-4 text-indigo-500" />
                          <span>Download</span>
                        </button>
                      );
                    })()}
                </div>

                {/* Catalog Language Editions bar */}
                {catalogVariants.length > 1 && (
                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-400 mr-1">
                      <Languages className="h-3.5 w-3.5 text-indigo-500" />
                      <span>Audio Languages:</span>
                    </span>
                    {catalogVariants.map((variant) => (
                      <button
                        key={`${variant.kind}:${variant.id}`}
                        type="button"
                        onClick={() => handleVersionButtonSelect(variant)}
                        className={`min-h-[36px] rounded-lg border px-3 py-1 text-xs font-semibold transition-all whitespace-nowrap ${
                          variant.isCurrent
                            ? 'border-[#E11D48] bg-[#E11D48] text-white'
                            : 'border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-300 hover:border-indigo-400 dark:hover:border-white/25 hover:text-slate-950 dark:hover:text-white'
                        }`}
                      >
                        {variant.language}
                      </button>
                    ))}
                  </div>
                )}

                {/* Current Playing Episode Details (hydrated from cache memory / offline storage) */}
                {series && activePlayback?.kind === 'episode' && (
                  <div className="mt-4 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-slate-50/80 dark:bg-[#111520] p-3.5 sm:p-4 max-w-3xl">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 dark:text-slate-400 tabular-nums">
                      <span className="font-mono font-semibold text-[#E11D48]">
                        S{String(activePlayback.seasonNum ?? activeEpisodeDetail?.seasonNum ?? 1).padStart(2, '0')}E
                        {String(activePlayback.episodeNum ?? activeEpisodeDetail?.episodeNum ?? 1).padStart(2, '0')}
                      </span>
                      {(activeEpisodeDetail?.duration) && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{activeEpisodeDetail.duration}</span>
                        </>
                      )}
                      {activeEpisodeDetail?.rating ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-amber-600 dark:text-amber-400">
                            ★ {activeEpisodeDetail.rating.toFixed(1)}
                          </span>
                        </>
                      ) : null}
                      {activePlayback.isOffline && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                            Playing Offline
                          </span>
                        </>
                      )}
                    </div>
                    <h2 className="mt-1 text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                      {activeEpisodeDetail?.title || activePlayback.subtitle || activePlayback.title}
                    </h2>
                    {activeEpisodeDetail?.plot && (
                      <p className="mt-1.5 text-xs sm:text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                        {activeEpisodeDetail.plot}
                      </p>
                    )}
                  </div>
                )}

                {(movie?.plot || series?.plot) && (
                  <p className="mt-5 text-sm leading-relaxed text-slate-700 dark:text-slate-300 max-w-3xl">
                    {movie?.plot || series?.plot}
                  </p>
                )}

                {(() => {
                  const rawDirector = (movie?.director || series?.director || '').trim();
                  const rawCast = (movie?.cast || series?.cast || '').trim();
                  const isPlaceholder = (v: string) =>
                    !v || /^(?:n\/a|na|none|null|undefined|unknown|various|-+|--|\.\.\.)$/i.test(v);
                  const hasDirectorText = !isPlaceholder(rawDirector);
                  const hasCastText = !isPlaceholder(rawCast);
                  if (!hasDirectorText && !hasCastText) return null;
                  return (
                    <div className="mt-4 space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
                      {hasDirectorText && (
                        <p>
                          <span className="text-slate-500">Director:</span>{' '}
                          <span className="font-medium text-slate-800 dark:text-slate-200">
                            {rawDirector}
                          </span>
                        </p>
                      )}
                      {hasCastText && (
                        <p>
                          <span className="text-slate-500">Cast:</span>{' '}
                          <span className="font-medium text-slate-800 dark:text-slate-200">
                            {rawCast}
                          </span>
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Cast & Crew Section — automatically disabled when credits are unavailable */}
            {(() => {
              const allCredits = imdbData?.cast || [];
              const hasCrew = allCredits.some((m) => m.department === 'crew');
              const hasCast = allCredits.some((m) => m.department !== 'crew');
              const visibleCredits =
                castDeptFilter === 'all'
                  ? allCredits
                  : castDeptFilter === 'crew'
                    ? allCredits.filter((m) => m.department === 'crew')
                    : allCredits.filter((m) => m.department !== 'crew');
              const currentExclude = movie
                ? { kind: 'movie' as const, id: movie.streamId }
                : series
                  ? { kind: 'series' as const, id: series.seriesId }
                  : undefined;

              if (!imdbLoading && allCredits.length === 0) return null;

              const sectionTitle =
                hasCast && !hasCrew ? 'Cast' : !hasCast && hasCrew ? 'Crew' : 'Cast & Crew';

              return (
                <section className="border-t border-slate-200/80 dark:border-white/[0.08] pt-8">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                        {sectionTitle}
                      </h2>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Select any person to search other titles they appear in
                      </p>
                    </div>

                    {hasCast && hasCrew && (
                      <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none">
                        {(
                          [
                            { id: 'all', label: 'All' },
                            { id: 'cast', label: 'Cast' },
                            { id: 'crew', label: 'Crew' },
                          ] as Array<{ id: 'all' | 'cast' | 'crew'; label: string }>
                        ).map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setCastDeptFilter(tab.id)}
                            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${
                              castDeptFilter === tab.id
                                ? 'bg-[#E11D48] text-white'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {imdbLoading && allCredits.length === 0 ? (
                    <div className="flex items-center gap-3 py-6">
                      <LoadingSpinner size="sm" label="Loading cast & crew..." />
                    </div>
                  ) : visibleCredits.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3 sm:gap-4">
                      {visibleCredits.map((member, idx) => (
                        <button
                          key={`${member.name}-${member.department || 'cast'}-${idx}`}
                          type="button"
                          onClick={() => onSearchCastMember?.(member, currentExclude)}
                          title={`Search catalog for other content with ${member.name}`}
                          className="cinebox-card-elevated group flex flex-col items-center rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3 text-center shadow-sm shadow-slate-900/5 dark:shadow-none transition-all duration-200 hover:border-rose-300 dark:hover:border-[#E11D48]/40 dark:hover:bg-[#171D2B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                        >
                          <CastMemberAvatar name={member.name} photoUrl={member.photoUrl} />
                          <p className="w-full text-xs font-semibold text-slate-900 dark:text-white line-clamp-1 group-hover:text-[#E11D48] dark:group-hover:text-rose-400 transition-colors">
                            {member.name}
                          </p>
                          {member.role && (
                            <p className="mt-0.5 w-full text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1">
                              {member.role}
                            </p>
                          )}
                          <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-rose-600/80 dark:text-rose-400/85 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                            <Search className="h-2.5 w-2.5" />
                            <span>View credits</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })()}

            {/* Seasons & Episodes Section for Series */}
            {series && seasonKeys.length > 0 && (() => {
              const downloadableInSeason = activeEpisodes.filter((ep) => {
                if (!ep.playUrl) return false;
                const key = `episode:${ep.episodeId}`;
                const task = offlineTasks[key];
                const isBusy =
                  task &&
                  (task.status === 'queued' ||
                    task.status === 'downloading' ||
                    task.status === 'paused' ||
                    task.status === 'saving');
                return !isBusy && !offlineMap.has(key);
              });

              const allSeasonSelected =
                downloadableInSeason.length > 0 &&
                downloadableInSeason.every((ep) => selectedEpisodeIds.has(ep.episodeId));

              const allSeriesEpisodes = Object.values(series.episodesBySeason).flat();
              const activeSeriesTaskCount = allSeriesEpisodes.filter((ep) => {
                const t = offlineTasks[`episode:${ep.episodeId}`];
                return (
                  t &&
                  (t.status === 'queued' ||
                    t.status === 'downloading' ||
                    t.status === 'paused' ||
                    t.status === 'saving')
                );
              }).length;
              const selectedEpisodesList = allSeriesEpisodes.filter(
                (ep) => selectedEpisodeIds.has(ep.episodeId) && Boolean(ep.playUrl),
              );

              const handleToggleSelectAllSeason = () => {
                setSelectedEpisodeIds((prev) => {
                  const next = new Set(prev);
                  if (allSeasonSelected) {
                    for (const ep of downloadableInSeason) {
                      next.delete(ep.episodeId);
                    }
                  } else {
                    for (const ep of downloadableInSeason) {
                      next.add(ep.episodeId);
                    }
                  }
                  return next;
                });
              };

              return (
                <section className="border-t border-slate-200/80 dark:border-white/[0.08] pt-8">
                  <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                        Episodes
                      </h2>
                      {activeSeriesTaskCount > 0 && downloadableInSeason.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSeriesDownloadOpen(true)}
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-3 text-xs font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors whitespace-nowrap"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>Download More</span>
                        </button>
                      )}
                      {downloadableInSeason.length > 0 && (
                        <button
                          type="button"
                          onClick={handleToggleSelectAllSeason}
                          className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-3 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors whitespace-nowrap"
                        >
                          <span
                            className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
                              allSeasonSelected
                                ? 'border-[#E11D48] bg-[#E11D48] text-white'
                                : 'border-slate-300 dark:border-white/25'
                            }`}
                          >
                            {allSeasonSelected && <Check className="h-3 w-3 stroke-[3]" />}
                          </span>
                          <span>
                            {allSeasonSelected
                              ? `Deselect Season ${selectedSeason}`
                              : `Select All (${downloadableInSeason.length})`}
                          </span>
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-white dark:bg-[#111520] p-1 border border-slate-200 dark:border-white/[0.08] shadow-sm shadow-slate-900/5 dark:shadow-none">
                      {seasonKeys.map((sKey) => {
                        const active = sKey === selectedSeason;
                        return (
                          <button
                            key={sKey}
                            type="button"
                            onClick={() => setSelectedSeason(sKey)}
                            className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-colors ${
                              active
                                ? 'bg-[#E11D48] text-white'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            Season {sKey}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {selectedEpisodesList.length > 0 && (
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-300/70 dark:border-indigo-500/35 bg-indigo-50/80 dark:bg-indigo-950/30 px-4 py-3">
                      <p className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-white tabular-nums">
                        {selectedEpisodesList.length} episode
                        {selectedEpisodesList.length === 1 ? '' : 's'} selected for offline download
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedEpisodeIds(new Set())}
                          className="min-h-[38px] rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 px-3 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setQualityPrompt({
                              mode: 'episodes',
                              episodes: selectedEpisodesList,
                            })
                          }
                          className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-[#E11D48] px-4 text-xs font-semibold text-white hover:bg-[#be123c] transition-colors whitespace-nowrap"
                        >
                          <Download className="h-3.5 w-3.5" />
                          <span>Download Selected ({selectedEpisodesList.length})</span>
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {activeEpisodes.map((ep) => {
                      const isActiveEp =
                        activePlayback?.kind === 'episode' &&
                        activePlayback.id === ep.episodeId;
                      const hist = continueEntries.find(
                        (c) => c.kind === 'episode' && c.id === ep.episodeId,
                      );
                      const pct =
                        hist && hist.durationSec > 0
                          ? Math.min(
                              100,
                              Math.round((hist.progressSec / hist.durationSec) * 100),
                            )
                          : 0;
                      const epOfflineKey = `episode:${ep.episodeId}`;
                      const epDownloaded = offlineMap.get(epOfflineKey);
                      const epTask = offlineTasks[epOfflineKey];
                      const epBusy =
                        epTask &&
                        (epTask.status === 'queued' ||
                          epTask.status === 'downloading' ||
                          epTask.status === 'paused' ||
                          epTask.status === 'saving');
                      const isChecked = selectedEpisodeIds.has(ep.episodeId);
                      const canSelectEp = Boolean(ep.playUrl) && !epDownloaded && !epBusy;

                      return (
                        <article
                          key={ep.episodeId}
                          className={`cinebox-card-elevated group flex items-center gap-2.5 sm:gap-3 rounded-xl border p-2.5 sm:p-3 transition-all ${
                            isActiveEp
                              ? 'border-[#E11D48] bg-rose-50/70 dark:bg-[#E11D48]/10 shadow-sm'
                              : isChecked
                                ? 'border-indigo-400 bg-indigo-50/50 dark:border-indigo-500/50 dark:bg-indigo-500/10 shadow-sm'
                                : 'border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] hover:border-indigo-300 dark:hover:border-white/20 dark:hover:bg-[#171D2B] shadow-sm shadow-slate-900/5 dark:shadow-none'
                          }`}
                        >
                          {/* Multi-select checkbox (non-clickable once downloaded or active) */}
                          {ep.playUrl && (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={epDownloaded ? true : isChecked}
                              aria-disabled={!canSelectEp ? 'true' : undefined}
                              disabled={!canSelectEp}
                              onClick={() => toggleEpisodeSelection(ep.episodeId)}
                              aria-label={
                                epDownloaded
                                  ? `${ep.title} already downloaded`
                                  : isChecked
                                    ? `Uncheck ${ep.title}`
                                    : `Check ${ep.title} for batch download`
                              }
                              title={
                                epDownloaded
                                  ? 'Downloaded (cannot re-download)'
                                  : epBusy
                                    ? 'Download in progress'
                                    : 'Select episode for download'
                              }
                              className="inline-flex min-h-[44px] min-w-[36px] shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] disabled:cursor-default disabled:pointer-events-none"
                            >
                              <span
                                className={`inline-flex h-5 w-5 items-center justify-center rounded-md border transition-colors ${
                                  epDownloaded
                                    ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                    : isChecked
                                      ? 'border-[#E11D48] bg-[#E11D48] text-white'
                                      : 'border-slate-300 dark:border-white/25 bg-white dark:bg-[#090B10] group-hover:border-indigo-400'
                                }`}
                              >
                                {(epDownloaded || isChecked) && (
                                  <Check className="h-3.5 w-3.5 stroke-[2.75]" />
                                )}
                              </span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => void playEpisodeOnPage(ep, true)}
                            className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4 text-left"
                          >
                            <div className="relative h-20 w-28 sm:w-34 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-[#090B10]">
                              <MediaImage
                                src={ep.thumbnail}
                                alt={ep.title}
                                title={series.cleanTitle}
                                year={series.year}
                                variant="backdrop"
                                className="h-full w-full"
                              />
                              <div
                                className={`absolute inset-0 flex items-center justify-center bg-black/45 transition-opacity ${
                                  isActiveEp ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                                }`}
                              >
                                <Play className="h-6 w-6 fill-white text-white" />
                              </div>
                              {pct > 0 && (
                                <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
                                  <div
                                    className="h-full bg-[#E11D48]"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              )}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                                  E{String(ep.episodeNum).padStart(2, '0')}
                                </span>
                                {isActiveEp && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-semibold text-[#E11D48]">Playing</span>
                                  </>
                                )}
                                {ep.duration && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span>{ep.duration}</span>
                                  </>
                                )}
                                {ep.extension && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="uppercase">{ep.extension}</span>
                                  </>
                                )}
                                {epDownloaded && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                                      {epDownloaded.quality || 'HD'} ·{' '}
                                      {formatBytes(epDownloaded.sizeBytes)}
                                    </span>
                                  </>
                                )}
                              </div>
                              <h3 className="mt-1 text-sm font-semibold text-slate-900 dark:text-white line-clamp-1">
                                {ep.title}
                              </h3>
                              {ep.plot && (
                                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">
                                  {ep.plot}
                                </p>
                              )}
                            </div>
                          </button>

                          {/* Episode Offline Download / Status Action */}
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            {epDownloaded ? (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled
                                  aria-disabled="true"
                                  title={`Downloaded (${epDownloaded.quality || 'HD'} · ${formatBytes(epDownloaded.sizeBytes)})`}
                                  aria-label={`${ep.title} downloaded`}
                                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 opacity-85 cursor-default pointer-events-none select-none"
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void removeDownload(epOfflineKey)}
                                  title="Delete offline episode"
                                  aria-label={`Delete offline copy of ${ep.title}`}
                                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            ) : epTask && (epTask.status === 'paused' || epTask.status === 'error') ? (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => void resumeDownload(epOfflineKey)}
                                  title={
                                    epTask.status === 'error'
                                      ? `Resume interrupted download (${epTask.error || 'Error'})`
                                      : `Resume download (${epTask.percent}%)`
                                  }
                                  className="inline-flex h-10 items-center gap-1 rounded-lg border border-indigo-400/50 bg-indigo-50 dark:bg-indigo-500/15 px-2.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 tabular-nums whitespace-nowrap"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  <span>
                                    Resume{epTask.percent > 0 ? ` ${epTask.percent}%` : ''}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => cancelDownload(epOfflineKey)}
                                  title="Cancel episode download"
                                  aria-label={`Cancel download of ${ep.title}`}
                                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            ) : epTask ? (
                              <div className="flex items-center gap-1">
                                {epTask.status !== 'saving' && (
                                  <button
                                    type="button"
                                    onClick={() => pauseDownload(epOfflineKey)}
                                    title="Pause episode download"
                                    className="inline-flex h-10 items-center gap-1 rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-500/15 px-2.5 font-mono text-[11px] font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-500/25 tabular-nums whitespace-nowrap"
                                  >
                                    <Pause className="h-3.5 w-3.5" />
                                    <span>
                                      {epTask.waitingForNetwork
                                        ? 'Wait'
                                        : epTask.status === 'queued'
                                          ? 'Queued'
                                          : `${epTask.percent}%`}
                                    </span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => cancelDownload(epOfflineKey)}
                                  title="Cancel episode download"
                                  aria-label={`Cancel download of ${ep.title}`}
                                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 transition-colors"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  setQualityPrompt({ mode: 'episodes', episodes: [ep] })
                                }
                                title="Choose quality & download episode"
                                aria-label={`Download ${ep.title} for offline`}
                                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-black/40 text-slate-600 dark:text-slate-300 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors"
                              >
                                <Download className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })()}

            {/* User Ratings & Reviews Section */}
            <MediaReviewsSection
              kind={movie ? 'movie' : 'series'}
              mediaId={movie ? movie.streamId : series!.seriesId}
              mediaTitle={movie?.cleanTitle || series?.cleanTitle || ''}
              catalogRating={movie?.rating || series?.rating}
            />

            {/* More Like This — Genre & Category Matched Movies */}
            {movie && relatedMovies.length > 0 && (
              <section
                aria-label="More Like This"
                className="border-t border-slate-200/80 dark:border-white/[0.08] pt-8"
              >
                <div className="mb-5 flex flex-col sm:flex-row sm:items-end justify-between gap-2">
                  <div>
                    <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                      More Like This
                    </h2>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Similar movies matched by genre &amp; category
                      {movie.genre || movie.categoryName
                        ? ` · ${[movie.genre, movie.categoryName].filter(Boolean).join(' · ')}`
                        : ''}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2.5 sm:gap-4">
                  {relatedMovies.map((item) => (
                    <MediaCard
                      key={item.streamId}
                      compactMobile
                      title={item.cleanTitle}
                      poster={item.poster}
                      saved={savedKeys.has(`movie:${item.streamId}`)}
                      rating={item.rating}
                      addedAt={item.added}
                      language={extractCardLanguage(item.name, item.categoryName)}
                      year={item.year}
                      qualityTag={item.qualityTag}
                      categoryName={item.categoryName}
                      mediaType="Movie"
                      metaParts={[item.extension ? item.extension.toUpperCase() : '']}
                      onOpen={() =>
                        openRelated({
                          kind: 'movie',
                          id: item.streamId,
                          autoplay: true,
                          initialMovie: {
                            title: item.cleanTitle,
                            subtitle: item.categoryName,
                            poster: item.poster,
                            playUrl: `/api/play/vod/${item.streamId}.${item.extension || 'mp4'}`,
                            extension: item.extension,
                          },
                        })
                      }
                      onQuickPlay={() =>
                        openRelated({
                          kind: 'movie',
                          id: item.streamId,
                          autoplay: true,
                          initialMovie: {
                            title: item.cleanTitle,
                            subtitle: item.categoryName,
                            poster: item.poster,
                            playUrl: `/api/play/vod/${item.streamId}.${item.extension || 'mp4'}`,
                            extension: item.extension,
                          },
                        })
                      }
                      onToggleSave={() =>
                        onToggleSave({
                          kind: 'movie',
                          id: item.streamId,
                          title: item.cleanTitle,
                          poster: item.poster,
                          year: item.year,
                          rating: item.rating,
                          categoryName: item.categoryName,
                        })
                      }
                    />
                  ))}
                </div>
              </section>
            )}

            {/* More Like This — Genre & Category Matched Series */}
            {series && relatedSeries.length > 0 && (
              <section
                aria-label="More Like This"
                className="border-t border-slate-200/80 dark:border-white/[0.08] pt-8"
              >
                <div className="mb-5 flex flex-col sm:flex-row sm:items-end justify-between gap-2">
                  <div>
                    <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                      More Like This
                    </h2>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Similar series matched by genre &amp; category
                      {series.genre || series.categoryName
                        ? ` · ${[series.genre, series.categoryName].filter(Boolean).join(' · ')}`
                        : ''}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2.5 sm:gap-4">
                  {relatedSeries.map((item) => (
                    <MediaCard
                      key={item.seriesId}
                      compactMobile
                      title={item.cleanTitle}
                      poster={item.poster}
                      saved={savedKeys.has(`series:${item.seriesId}`)}
                      rating={item.rating}
                      addedAt={item.lastModified}
                      releaseDate={item.releaseDate}
                      language={extractCardLanguage(item.name, item.categoryName)}
                      year={item.year}
                      categoryName={item.genre || item.categoryName}
                      mediaType="Series"
                      onOpen={() =>
                        openRelated({
                          kind: 'series',
                          id: item.seriesId,
                        })
                      }
                      onToggleSave={() =>
                        onToggleSave({
                          kind: 'series',
                          id: item.seriesId,
                          title: item.cleanTitle,
                          poster: item.poster,
                          year: item.year,
                          rating: item.rating,
                          categoryName: item.categoryName,
                        })
                      }
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* LIVE TV CHANNEL DETAIL + RESPECTIVE EPG GUIDE */}
        {target.kind === 'live' && liveChannel && (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
              <div className="flex items-center gap-4 min-w-0">
                <MediaImage
                  src={liveChannel.logo}
                  alt={liveChannel.name}
                  category={liveChannel.categoryName}
                  variant="logo"
                  imgClassName="h-full w-full object-contain p-2"
                  className="h-16 w-24 shrink-0 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] shadow-sm"
                />
                <div className="min-w-0">
                  <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white truncate">
                    {liveChannel.name}
                  </h1>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-sm text-slate-600 dark:text-slate-400">
                    <span>{liveChannel.categoryName}</span>
                    {liveChannel.hasArchive && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-sky-600 dark:text-sky-400 font-medium">
                          Catch-up Available
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 shrink-0">
                {activePlayback?.kind === 'catchup' && (
                  <button
                    type="button"
                    onClick={handleReturnToLive}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-[#E11D48] px-4 text-sm font-semibold text-white hover:bg-[#BE123C] whitespace-nowrap"
                  >
                    <Radio className="h-4 w-4" />
                    <span>Return to Live</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => onToggleFavoriteChannel(liveChannel)}
                  className={`inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-colors whitespace-nowrap ${
                    channelPinned
                      ? 'border-amber-400 bg-amber-400/15 text-amber-600 dark:text-amber-300'
                      : 'border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 shadow-sm shadow-slate-900/5 dark:shadow-none'
                  }`}
                >
                  <Star className={`h-4 w-4 ${channelPinned ? 'fill-current' : ''}`} />
                  <span>{channelPinned ? 'Pinned Channel' : 'Pin Channel'}</span>
                </button>
              </div>
            </div>

            {/* Now Playing & Up Next Cards */}
            {(nowProgram || nextProgram) && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {nowProgram && (
                  <div className="rounded-xl border border-[#E11D48]/40 bg-white dark:bg-[#111520] p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                      <span className="font-semibold uppercase tracking-wider text-[#E11D48]">
                        On Now
                      </span>
                      <span className="font-mono text-slate-600 dark:text-slate-300">
                        {nowProgram.startLabel} – {nowProgram.stopLabel} UTC
                      </span>
                    </div>
                    <h2 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-white">
                      {nowProgram.title}
                    </h2>
                    {nowProgram.description && (
                      <p className="mt-1.5 text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed line-clamp-3">
                        {nowProgram.description}
                      </p>
                    )}
                    <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
                      <div
                        className="h-full bg-[#E11D48]"
                        style={{ width: `${nowProgressPct}%` }}
                      />
                    </div>
                  </div>
                )}

                {nextProgram && (() => {
                  const nextRemId = buildReminderId(
                    liveChannel.streamId,
                    nextProgram.startTimestamp,
                    nextProgram.id || nextProgram.title,
                  );
                  const nextHasReminder = reminders.some((r) => r.id === nextRemId);
                  return (
                    <div className="rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-5 shadow-sm flex flex-col justify-between gap-3">
                      <div>
                        <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                          <span className="font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                            Up Next
                          </span>
                          <span className="font-mono text-slate-500 dark:text-slate-400">
                            {nextProgram.startLabel} – {nextProgram.stopLabel} UTC
                          </span>
                        </div>
                        <h2 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-white">
                          {nextProgram.title}
                        </h2>
                        {nextProgram.description && (
                          <p className="mt-1.5 text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed line-clamp-3">
                            {nextProgram.description}
                          </p>
                        )}
                      </div>

                      {nextProgram.startTimestamp > serverTimestamp && (
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() => onToggleReminder(liveChannel, nextProgram, 5)}
                            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors ${
                              nextHasReminder
                                ? 'border-amber-400 bg-amber-400/15 text-amber-700 dark:text-amber-300'
                                : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 text-slate-700 dark:text-slate-200 hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25'
                            }`}
                          >
                            {nextHasReminder ? (
                              <>
                                <BellRing className="h-3.5 w-3.5" />
                                <span>Reminder Set (5m early)</span>
                              </>
                            ) : (
                              <>
                                <Bell className="h-3.5 w-3.5" />
                                <span>Remind Me</span>
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Channel EPG Program Guide */}
            <section className="border-t border-slate-200/80 dark:border-white/[0.08] pt-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <CalendarClock className="h-5 w-5 text-[#E11D48]" />
                    <span>Channel Program Guide (EPG)</span>
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {epgLoading
                      ? 'Fetching schedule from broadcaster...'
                      : epgPrograms.length > 0
                        ? `${epgPrograms.length} scheduled broadcasts · Times shown in UTC`
                        : 'Electronic program schedule for this channel'}
                  </p>
                </div>

                {epgPrograms.length > 0 && (
                  <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none self-start sm:self-auto">
                    <button
                      type="button"
                      onClick={() => setEpgFilter('upcoming')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-all ${
                        epgFilter === 'upcoming'
                          ? 'bg-[#E11D48] text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      On Now & Upcoming
                    </button>
                    <button
                      type="button"
                      onClick={() => setEpgFilter('all')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-colors ${
                        epgFilter === 'all'
                          ? 'bg-[#E11D48] text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      All Scheduled ({epgPrograms.length})
                    </button>
                  </div>
                )}
              </div>

              {epgLoading ? (
                <div className="py-10 flex justify-center">
                  <LoadingSpinner size="md" label="Loading channel schedule..." />
                </div>
              ) : visibleEpgPrograms.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-10 text-center">
                  <p className="font-display text-base font-semibold text-slate-900 dark:text-white">
                    No EPG Schedule Available
                  </p>
                  <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                    The stream provider did not return upcoming EPG listings for {liveChannel.name}.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {visibleEpgPrograms.map((prog) => {
                    const isCurrent =
                      prog.isNowPlaying ||
                      (prog.startTimestamp <= serverTimestamp &&
                        prog.stopTimestamp > serverTimestamp);
                    const isPast = prog.stopTimestamp <= serverTimestamp;
                    const isUpcoming = prog.startTimestamp > serverTimestamp;
                    const progRemId = buildReminderId(
                      liveChannel.streamId,
                      prog.startTimestamp,
                      prog.id || prog.title,
                    );
                    const hasReminder = reminders.some((r) => r.id === progRemId);
                    const canReplay =
                      (prog.hasArchive || liveChannel.hasArchive) &&
                      prog.startTimestamp < serverTimestamp;

                    return (
                      <div
                        key={prog.id}
                        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border p-4 transition-colors ${
                          isCurrent
                            ? 'border-[#E11D48]/60 bg-rose-50/70 dark:bg-[#E11D48]/[0.08]'
                            : hasReminder
                              ? 'border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/15'
                              : 'border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
                            <span className="font-mono text-slate-600 dark:text-slate-300">
                              {prog.startLabel} – {prog.stopLabel} UTC
                            </span>
                            {isCurrent ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-semibold text-[#E11D48]">On Now</span>
                              </>
                            ) : isPast ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-slate-500">Aired</span>
                              </>
                            ) : (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-slate-500 dark:text-slate-400">Upcoming</span>
                              </>
                            )}
                          </div>
                          <h3 className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                            {prog.title}
                          </h3>
                          {prog.description && (
                            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed line-clamp-2">
                              {prog.description}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 self-start sm:self-center">
                          {isUpcoming && (
                            <button
                              type="button"
                              onClick={() => onToggleReminder(liveChannel, prog, 5)}
                              className={`inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg border px-3.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                                hasReminder
                                  ? 'border-amber-400 bg-amber-400/15 text-amber-700 dark:text-amber-300'
                                  : 'border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-white/5 text-slate-800 dark:text-white hover:border-rose-300 hover:text-[#E11D48] dark:hover:bg-white/10'
                              }`}
                            >
                              {hasReminder ? (
                                <>
                                  <BellRing className="h-3.5 w-3.5" />
                                  <span>Reminder Set</span>
                                </>
                              ) : (
                                <>
                                  <Bell className="h-3.5 w-3.5" />
                                  <span>Remind Me</span>
                                </>
                              )}
                            </button>
                          )}

                          {canReplay && (
                            <button
                              type="button"
                              onClick={() => handlePlayCatchup(prog)}
                              className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-white/5 px-3.5 text-xs font-semibold text-slate-800 dark:text-white hover:bg-slate-100 dark:hover:bg-white/10 whitespace-nowrap"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              <span>Watch Replay</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* You May Like — Same Genre / Category Live Channels */}
            {visibleRelatedChannels.length > 0 && (
              <section className="border-t border-slate-200/80 dark:border-white/[0.08] pt-8">
                <div className="mb-5">
                  <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                    You May Like
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {liveChannel.categoryName}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {visibleRelatedChannels.map((ch) => {
                    const isPinned = favoriteChannelIds.has(ch.streamId);
                    return (
                      <article
                        key={ch.streamId}
                        className="cinebox-card-elevated group flex items-center gap-3 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3 shadow-sm shadow-slate-900/5 dark:shadow-none transition-all hover:border-sky-300 dark:hover:border-white/25 dark:hover:bg-[#171D2B]"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            openRelated({
                              kind: 'live',
                              id: ch.streamId,
                              channel: ch,
                            })
                          }
                          className="flex min-h-[44px] flex-1 items-center gap-3.5 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] rounded"
                        >
                          <MediaImage
                            src={ch.logo}
                            alt={ch.name}
                            category={ch.categoryName}
                            variant="logo"
                            imgClassName="h-full w-full object-contain p-2"
                            className="h-14 w-20 shrink-0 rounded-lg border border-slate-200/70 dark:border-white/5 bg-slate-100 dark:bg-[#090B10]"
                          />
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-white truncate group-hover:text-[#E11D48] transition-colors">
                              {ch.name}
                            </h3>
                            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 truncate">
                              {ch.nowPlaying ? ch.nowPlaying.title : ch.categoryName}
                            </p>
                            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums truncate">
                              {ch.nowPlaying
                                ? `${ch.nowPlaying.startLabel} – ${ch.nowPlaying.stopLabel}`
                                : ch.hasArchive
                                  ? 'Live · Catch-up'
                                  : 'Live Broadcast'}
                            </p>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => onToggleFavoriteChannel(ch)}
                          aria-label={isPinned ? `Unpin ${ch.name}` : `Pin ${ch.name}`}
                          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border transition-colors ${
                            isPinned
                              ? 'border-amber-400/50 bg-amber-400/15 text-amber-500 dark:text-amber-300'
                              : 'border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-black/40 text-slate-500 dark:text-slate-400 hover:text-amber-500 dark:hover:text-white'
                          }`}
                        >
                          <Star className={`h-4 w-4 ${isPinned ? 'fill-current' : ''}`} />
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </div>
      )}

      <DownloadQualityModal
        open={Boolean(qualityPrompt)}
        kind={
          qualityPrompt?.mode === 'movie'
            ? 'movie'
            : qualityPrompt?.mode === 'episodes'
              ? 'episode'
              : undefined
        }
        mediaId={
          qualityPrompt?.mode === 'movie'
            ? movie?.streamId
            : qualityPrompt?.mode === 'episodes'
              ? qualityPrompt.episodes[0]?.episodeId
              : undefined
        }
        extension={
          qualityPrompt?.mode === 'movie'
            ? movie?.extension
            : qualityPrompt?.mode === 'episodes'
              ? qualityPrompt.episodes[0]?.extension
              : undefined
        }
        title={
          qualityPrompt?.mode === 'movie'
            ? movie?.cleanTitle || 'Movie'
            : qualityPrompt?.mode === 'episodes'
              ? qualityPrompt.episodes.length === 1
                ? `${series?.cleanTitle || 'Series'} — S${qualityPrompt.episodes[0].seasonNum}E${qualityPrompt.episodes[0].episodeNum}`
                : series?.cleanTitle || 'Series Episodes'
              : ''
        }
        subtitle={
          qualityPrompt?.mode === 'movie'
            ? movie?.categoryName
            : qualityPrompt?.mode === 'episodes' && qualityPrompt.episodes.length === 1
              ? qualityPrompt.episodes[0].title
              : undefined
        }
        itemCount={qualityPrompt?.mode === 'episodes' ? qualityPrompt.episodes.length : 1}
        durationHint={
          qualityPrompt?.mode === 'movie'
            ? movie?.duration
            : qualityPrompt?.mode === 'episodes'
              ? qualityPrompt.episodes[0]?.duration || series?.episodeRunTime
              : undefined
        }
        onClose={() => setQualityPrompt(null)}
        onConfirm={handleConfirmDownloadQuality}
      />

      <SeriesEpisodesDownloadModal
        open={seriesDownloadOpen}
        seriesDetail={series}
        initialSeason={selectedSeason}
        onClose={() => setSeriesDownloadOpen(false)}
        onOpenDownloads={onOpenDownloads}
      />
    </div>
  );
}
