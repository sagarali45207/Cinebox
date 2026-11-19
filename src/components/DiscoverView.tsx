import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Film,
  Flame,
  HardDriveDownload,
  Search,
} from 'lucide-react';
import type {
  DetailTarget,
  HomePayload,
  MovieSummary,
  NavTab,
  SeriesSummary,
  WatchHistoryEntry,
  WatchlistEntry,
} from '../types/media';
import { extractCardLanguage } from '../utils/format';
import { isRestrictedContent, useAppSettings } from '../utils/settings';
import { ComingSoonSection } from './ComingSoonSection';
import { PageLoader } from './LoadingSpinner';
import { MediaCard } from './MediaCard';
import { MediaImage } from './MediaImage';
import { RecommendedForYouSection } from './RecommendedForYouSection';
import { SpotlightHeroSlider, type VodHeroSlide } from './SpotlightHeroSlider';
import AdsterraAd from "./AdsterraAd";
import AdsterraNative from "./AdsterraNative"

interface DiscoverViewProps {
  home: HomePayload | null;
  loading: boolean;
  error: string;
  continueEntries: WatchHistoryEntry[];
  watchlist: WatchlistEntry[];
  onRetry: () => void;
  onNavigate: (tab: NavTab) => void;
  onOpenSearch: () => void;
  onOpenDetail: (target: DetailTarget) => void;
  onOpenContinue: (entry: WatchHistoryEntry) => void;
  onToggleSave: (payload: {
    kind: 'movie' | 'series';
    id: string;
    title: string;
    poster: string;
    year: string | null;
    rating: number;
    categoryName: string;
  }) => void;
  onRemoveContinue: (key: string | string[]) => void;
  offlineCount?: number;
  onOpenOfflineDownloads?: () => void;
}

type TrendingFilter = 'all' | 'movies' | 'series';

type TrendingSliderEntry =
  | { kind: 'movie'; item: MovieSummary }
  | { kind: 'series'; item: SeriesSummary };

const HOVER_TRAILER_STORAGE_KEY = 'cinebox_hover_trailers_v1';
const SLIDER_TRACK_CLASS =
  'flex gap-2.5 sm:gap-4 overflow-x-auto scroll-smooth snap-x snap-mandatory pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';
const SLIDER_CARD_CLASS =
  'w-[calc((100%-1.25rem)/3)] sm:w-[180px] md:w-[196px] lg:w-[210px] shrink-0 snap-start';

function useHorizontalSlider(resetKey: string | number) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = trackRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    setCanScrollLeft(el.scrollLeft > 8);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollTo({ left: 0, behavior: 'auto' });
    const raf = window.requestAnimationFrame(updateScrollState);
    window.addEventListener('resize', updateScrollState);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [resetKey, updateScrollState]);

  const scrollBy = useCallback((direction: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    const step = Math.max(240, Math.round(el.clientWidth * 0.78));
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  }, []);

  return { trackRef, canScrollLeft, canScrollRight, updateScrollState, scrollBy };
}

export function DiscoverView({
  home,
  loading,
  error,
  continueEntries,
  watchlist,
  onRetry,
  onNavigate,
  onOpenSearch,
  onOpenDetail,
  onOpenContinue,
  onToggleSave,
  onRemoveContinue,
  offlineCount = 0,
  onOpenOfflineDownloads,
}: DiscoverViewProps) {
  const [trendingFilter, setTrendingFilter] = useState<TrendingFilter>('all');
  const [hoverPreviewEnabled, setHoverPreviewEnabled] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem(HOVER_TRAILER_STORAGE_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const { settings, parentalUnlocked } = useAppSettings();

  const heroItems = useMemo(
    () =>
      (home?.heroItems || []).filter(
        (item) =>
          !isRestrictedContent(
            { title: item.cleanTitle, categoryName: item.categoryName, genre: item.genre },
            settings,
            parentalUnlocked,
          ),
      ),
    [home?.heroItems, settings, parentalUnlocked],
  );

  const discoverHeroSlides = useMemo<VodHeroSlide[]>(
    () =>
      heroItems.map((item) => ({
        kind: 'movie',
        id: item.streamId,
        kicker: 'Featured Premiere',
        title: item.cleanTitle,
        categoryName: item.categoryName,
        language: extractCardLanguage(item.name, item.categoryName),
        rating: item.rating,
        year: item.year,
        metaText: item.duration,
        genre: item.genre,
        plot: item.plot,
        poster: item.poster,
        backdrop: item.backdrop,
        youtubeTrailer: item.youtubeTrailer,
        primaryActionLabel: 'Watch Now',
        secondaryActionLabel: 'More Details',
        onPrimaryAction: () =>
          onOpenDetail({
            kind: 'movie',
            id: item.streamId,
            autoplay: true,
            initialMovie: {
              title: item.cleanTitle,
              subtitle: item.categoryName,
              poster: item.poster,
              playUrl: item.playUrl,
              extension: item.extension,
            },
          }),
        onSecondaryAction: () =>
          onOpenDetail({
            kind: 'movie',
            id: item.streamId,
            initialMovie: {
              title: item.cleanTitle,
              subtitle: item.categoryName,
              poster: item.poster,
              playUrl: item.playUrl,
              extension: item.extension,
            },
          }),
      })),
    [heroItems, onOpenDetail],
  );

  const handleToggleHoverPreview = () => {
    setHoverPreviewEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(HOVER_TRAILER_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const visibleContinueEntries = useMemo(() => {
    const filtered = continueEntries.filter(
      (item) =>
        !isRestrictedContent(
          {
            title: item.seriesTitle || item.title,
            categoryName: item.categoryName,
          },
          settings,
          parentalUnlocked,
        ),
    );
    return [...filtered].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [continueEntries, settings, parentalUnlocked]);

  const groupedContinueEntries = useMemo(() => {
    interface ContinueCardGroup {
      groupKey: string;
      primary: WatchHistoryEntry;
      keys: string[];
      episodeCount: number;
    }

    const groups: ContinueCardGroup[] = [];
    const bySeriesId = new Map<string, ContinueCardGroup>();
    const bySeriesTitle = new Map<string, ContinueCardGroup>();

    for (const item of visibleContinueEntries) {
      if (item.kind !== 'episode') {
        groups.push({
          groupKey: item.key,
          primary: item,
          keys: [item.key],
          episodeCount: 0,
        });
        continue;
      }

      const normSeriesId = item.seriesId?.trim() || '';
      const normSeriesTitle = item.seriesTitle?.trim().toLowerCase() || '';
      const existingGroup =
        (normSeriesId ? bySeriesId.get(normSeriesId) : undefined) ||
        (normSeriesTitle ? bySeriesTitle.get(normSeriesTitle) : undefined);

      if (existingGroup) {
        existingGroup.keys.push(item.key);
        existingGroup.episodeCount += 1;
        if (normSeriesId && !bySeriesId.has(normSeriesId)) {
          bySeriesId.set(normSeriesId, existingGroup);
        }
        if (normSeriesTitle && !bySeriesTitle.has(normSeriesTitle)) {
          bySeriesTitle.set(normSeriesTitle, existingGroup);
        }
        continue;
      }

      const groupKey = normSeriesId
        ? `series:${normSeriesId}`
        : normSeriesTitle
          ? `series-title:${normSeriesTitle}`
          : item.key;

      const created: ContinueCardGroup = {
        groupKey,
        primary: item,
        keys: [item.key],
        episodeCount: 1,
      };
      groups.push(created);
      if (normSeriesId) bySeriesId.set(normSeriesId, created);
      if (normSeriesTitle) bySeriesTitle.set(normSeriesTitle, created);
    }

    return groups;
  }, [visibleContinueEntries]);

  const visibleTrendingMovies = useMemo(
    () =>
      (home?.trendingMovies || []).filter(
        (m) =>
          !isRestrictedContent(
            { title: m.cleanTitle, categoryName: m.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
    [home?.trendingMovies, settings, parentalUnlocked],
  );

  const visiblePopularSeries = useMemo(
    () =>
      (home?.popularSeries || []).filter(
        (s) =>
          !isRestrictedContent(
            { title: s.cleanTitle, categoryName: s.categoryName, genre: s.genre },
            settings,
            parentalUnlocked,
          ),
      ),
    [home?.popularSeries, settings, parentalUnlocked],
  );

  const visibleFeaturedLive = useMemo(
    () =>
      (home?.featuredLive || []).filter(
        (c) =>
          !isRestrictedContent(
            { title: c.name, categoryName: c.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
    [home?.featuredLive, settings, parentalUnlocked],
  );

  const trendingNowItems = useMemo<TrendingSliderEntry[]>(() => {
    const movies = visibleTrendingMovies.map(
      (item): TrendingSliderEntry => ({ kind: 'movie', item }),
    );
    const series = visiblePopularSeries.map(
      (item): TrendingSliderEntry => ({ kind: 'series', item }),
    );

    if (trendingFilter === 'movies') return movies;
    if (trendingFilter === 'series') return series;

    // Interleave trending movies and popular series, prioritizing highest ratings
    const sortedMovies = [...movies].sort((a, b) => b.item.rating - a.item.rating);
    const sortedSeries = [...series].sort((a, b) => b.item.rating - a.item.rating);
    const merged: TrendingSliderEntry[] = [];
    const maxLen = Math.max(sortedMovies.length, sortedSeries.length);
    for (let i = 0; i < maxLen && merged.length < 20; i++) {
      if (i < sortedMovies.length) merged.push(sortedMovies[i]);
      if (merged.length < 20 && i < sortedSeries.length) merged.push(sortedSeries[i]);
    }
    return merged;
  }, [visibleTrendingMovies, visiblePopularSeries, trendingFilter]);

  const continueSlider = useHorizontalSlider(groupedContinueEntries.length);
  const trendingSlider = useHorizontalSlider(`${trendingNowItems.length}:${trendingFilter}`);
  const trendingMoviesSlider = useHorizontalSlider(visibleTrendingMovies.length);
  const popularSeriesSlider = useHorizontalSlider(visiblePopularSeries.length);

  const savedKeys = new Set(watchlist.map((w) => w.key));

  if (loading && !home) {
    return (
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 py-12 min-h-[72vh] flex flex-col items-center justify-center">
        <PageLoader
          label="Loading featured movies, series & live channels..."
          sublabel="Synchronizing catalog and EPG highlights"
          className="py-12"
        />
      </div>
    );
  }

  if (error && !home) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20 text-center">
        <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          Unable to Connect to Catalog
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{error}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg bg-[#E11D48] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#BE123C]"
          >
            Retry Connection
          </button>
          {onOpenOfflineDownloads && (
            <button
              type="button"
              onClick={onOpenOfflineDownloads}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-[#111520] px-5 py-2.5 text-sm font-semibold text-slate-800 dark:text-white shadow-sm hover:border-emerald-400 dark:hover:border-emerald-500/50 transition-colors"
            >
              <HardDriveDownload className="h-4 w-4 text-emerald-500" />
              <span>
                Offline Downloads{offlineCount > 0 ? ` (${offlineCount})` : ''}
              </span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-16">
      {/* Spotlight Hero Slider */}
      {discoverHeroSlides.length > 0 && (
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6">
          <SpotlightHeroSlider
            slides={discoverHeroSlides}
            ariaLabel="Featured Premiere Slider"
            hoverPreviewEnabled={hoverPreviewEnabled}
          />
        </div>
      )}

      {/* Search Bar & Hover Trailer Option */}
      <section className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 pt-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200/80 dark:border-white/[0.08] pb-6">
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex h-11 w-full sm:max-w-md items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-4 text-left text-sm text-slate-500 dark:text-slate-400 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-indigo-400/60 dark:hover:border-white/25 hover:text-slate-900 dark:hover:text-slate-200"
          >
            <span className="flex items-center gap-2.5 truncate">
              <Search className="h-4 w-4 shrink-0 text-[#E11D48]" />
              <span className="truncate">Search movies, series, and live channels...</span>
            </span>
            <kbd className="hidden sm:inline-block rounded border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
              ⌘K
            </kbd>
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={hoverPreviewEnabled}
            onClick={handleToggleHoverPreview}
            title="Auto-play a short muted trailer when hovering over a poster for more than 1.5 seconds"
            className={`inline-flex h-11 items-center justify-between sm:justify-start gap-3 rounded-xl border px-3.5 text-left transition-colors shadow-sm shadow-slate-900/5 dark:shadow-none ${
              hoverPreviewEnabled
                ? 'border-[#E11D48]/35 bg-rose-50/70 dark:border-rose-500/35 dark:bg-rose-500/10 text-slate-900 dark:text-white'
                : 'border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/20'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Film
                className={`h-4 w-4 shrink-0 ${
                  hoverPreviewEnabled
                    ? 'text-[#E11D48] dark:text-rose-400'
                    : 'text-slate-400 dark:text-slate-500'
                }`}
              />
              <span className="flex flex-col leading-tight">
                <span className="text-xs font-semibold">Hover Trailer Preview</span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400">
                  Auto-play after 1.5s hover
                </span>
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                hoverPreviewEnabled
                  ? 'bg-[#E11D48]'
                  : 'bg-slate-300 dark:bg-white/15'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                  hoverPreviewEnabled ? 'translate-x-4.5' : 'translate-x-1'
                }`}
              />
            </span>
          </button>
        </div>
      </section>
<div className="home-screen">

  {/* Existing IPTV content */}

  <AdsterraNative />

  {/* Remaining IPTV content */}

</div>
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 space-y-12 pt-8">
        {/* Continue Watching */}
        {groupedContinueEntries.length > 0 && (
          <section aria-label="Continue Watching">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                Continue Watching
              </h2>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => onNavigate('library')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline"
                >
                  <span>View Library</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
                {(continueSlider.canScrollLeft || continueSlider.canScrollRight) && (
                  <div className="hidden sm:flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => continueSlider.scrollBy(-1)}
                      disabled={!continueSlider.canScrollLeft}
                      aria-label="Scroll Continue Watching left"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => continueSlider.scrollBy(1)}
                      disabled={!continueSlider.canScrollRight}
                      aria-label="Scroll Continue Watching right"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="relative">
              <div
                ref={continueSlider.trackRef}
                onScroll={continueSlider.updateScrollState}
                className={SLIDER_TRACK_CLASS}
              >
                {groupedContinueEntries.slice(0, 12).map((group) => {
                  const item = group.primary;
                  const ratio = item.durationSec > 0 ? item.progressSec / item.durationSec : 0;
                  const displayTitle = item.seriesTitle ? `${item.seriesTitle}` : item.title;
                  const isMultiEpisodeSeries = item.kind === 'episode' && group.episodeCount > 1;
                  const epCode =
                    item.kind === 'episode' && item.seasonNum
                      ? `S${item.seasonNum}E${item.episodeNum}`
                      : '';
                  return (
                    <div key={group.groupKey} className={SLIDER_CARD_CLASS}>
                      <MediaCard
                        compactMobile
                        title={displayTitle}
                        poster={item.poster}
                        rating={item.rating}
                        language={
                          item.language || extractCardLanguage(displayTitle, item.categoryName)
                        }
                        categoryName={
                          item.kind === 'episode' && item.title !== item.seriesTitle
                            ? item.title
                            : item.categoryName
                        }
                        mediaType={
                          isMultiEpisodeSeries
                            ? 'Series'
                            : item.kind === 'episode'
                              ? 'Episode'
                              : 'Movie'
                        }
                        metaParts={
                          isMultiEpisodeSeries
                            ? [epCode, `${Math.round(ratio * 100)}%`, `${group.episodeCount} eps`]
                            : [epCode, `${Math.round(ratio * 100)}% watched`]
                        }
                        progressRatio={ratio}
                        hoverPreviewEnabled={hoverPreviewEnabled}
                        previewKind={item.kind === 'episode' ? 'series' : 'movie'}
                        previewId={item.kind === 'episode' ? item.seriesId : item.id}
                        onOpen={() => onOpenContinue(item)}
                        onQuickPlay={() => onOpenContinue(item)}
                        onRemove={() => onRemoveContinue(group.keys)}
                        removeLabel={`Remove ${displayTitle} from continue watching`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* Personalized Recommendations */}
        {home && (
          <RecommendedForYouSection
            home={home}
            continueEntries={continueEntries}
            watchlist={watchlist}
            hoverPreviewEnabled={hoverPreviewEnabled}
            savedKeys={savedKeys}
            onOpenDetail={onOpenDetail}
            onToggleSave={onToggleSave}
          />
        )}

        {/* Coming Soon — Upcoming Releases */}
        <ComingSoonSection
          onOpenDetail={onOpenDetail}
          onOpenSearch={onOpenSearch}
        />

        {/* Trending Now Horizontal Slider */}
        {trendingNowItems.length > 0 && (
          <section aria-label="Trending Now">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#E11D48]/12 text-[#E11D48] dark:text-rose-400">
                  <Flame className="h-4.5 w-4.5" />
                </div>
                <div>
                  <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white leading-tight">
                    Trending Now
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Popular movies &amp; series from your catalog
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none">
                  {(
                    [
                      { id: 'all', label: 'All' },
                      { id: 'movies', label: 'Movies' },
                      { id: 'series', label: 'Series' },
                    ] as Array<{ id: TrendingFilter; label: string }>
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setTrendingFilter(tab.id)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                        trendingFilter === tab.id
                          ? 'bg-[#E11D48] text-white shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="hidden sm:flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => trendingSlider.scrollBy(-1)}
                    disabled={!trendingSlider.canScrollLeft}
                    aria-label="Scroll Trending Now left"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => trendingSlider.scrollBy(1)}
                    disabled={!trendingSlider.canScrollRight}
                    aria-label="Scroll Trending Now right"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="relative">
              <div
                ref={trendingSlider.trackRef}
                onScroll={trendingSlider.updateScrollState}
                className={SLIDER_TRACK_CLASS}
              >
                {trendingNowItems.map((entry) =>
                  entry.kind === 'movie' ? (
                    <div
                      key={`trend-movie-${entry.item.streamId}`}
                      className={SLIDER_CARD_CLASS}
                    >
                      <MediaCard
                        compactMobile
                        title={entry.item.cleanTitle}
                        poster={entry.item.poster}
                        saved={savedKeys.has(`movie:${entry.item.streamId}`)}
                        rating={entry.item.rating}
                        addedAt={entry.item.added}
                        language={extractCardLanguage(
                          entry.item.name,
                          entry.item.categoryName,
                        )}
                        year={entry.item.year}
                        qualityTag={entry.item.qualityTag}
                        categoryName={entry.item.categoryName}
                        mediaType="Movie"
                        metaParts={[
                          entry.item.extension ? entry.item.extension.toUpperCase() : '',
                        ]}
                        hoverPreviewEnabled={hoverPreviewEnabled}
                        previewKind="movie"
                        previewId={entry.item.streamId}
                        onOpen={() =>
                          onOpenDetail({
                            kind: 'movie',
                            id: entry.item.streamId,
                            autoplay: true,
                            initialMovie: {
                              title: entry.item.cleanTitle,
                              subtitle: entry.item.categoryName,
                              poster: entry.item.poster,
                              playUrl: `/api/play/vod/${entry.item.streamId}.${entry.item.extension || 'mp4'}`,
                              extension: entry.item.extension,
                            },
                          })
                        }
                        onQuickPlay={() =>
                          onOpenDetail({
                            kind: 'movie',
                            id: entry.item.streamId,
                            autoplay: true,
                            initialMovie: {
                              title: entry.item.cleanTitle,
                              subtitle: entry.item.categoryName,
                              poster: entry.item.poster,
                              playUrl: `/api/play/vod/${entry.item.streamId}.${entry.item.extension || 'mp4'}`,
                              extension: entry.item.extension,
                            },
                          })
                        }
                        onToggleSave={() =>
                          onToggleSave({
                            kind: 'movie',
                            id: entry.item.streamId,
                            title: entry.item.cleanTitle,
                            poster: entry.item.poster,
                            year: entry.item.year,
                            rating: entry.item.rating,
                            categoryName: entry.item.categoryName,
                          })
                        }
                      />
                    </div>
                  ) : (
                    <div
                      key={`trend-series-${entry.item.seriesId}`}
                      className={SLIDER_CARD_CLASS}
                    >
                      <MediaCard
                        compactMobile
                        title={entry.item.cleanTitle}
                        poster={entry.item.poster}
                        saved={savedKeys.has(`series:${entry.item.seriesId}`)}
                        rating={entry.item.rating}
                        addedAt={entry.item.lastModified}
                        releaseDate={entry.item.releaseDate}
                        language={extractCardLanguage(
                          entry.item.name,
                          entry.item.categoryName,
                        )}
                        year={entry.item.year}
                        categoryName={entry.item.genre || entry.item.categoryName}
                        mediaType="Series"
                        hoverPreviewEnabled={hoverPreviewEnabled}
                        previewKind="series"
                        previewId={entry.item.seriesId}
                        onOpen={() =>
                          onOpenDetail({ kind: 'series', id: entry.item.seriesId })
                        }
                        onToggleSave={() =>
                          onToggleSave({
                            kind: 'series',
                            id: entry.item.seriesId,
                            title: entry.item.cleanTitle,
                            poster: entry.item.poster,
                            year: entry.item.year,
                            rating: entry.item.rating,
                            categoryName: entry.item.categoryName,
                          })
                        }
                      />
                    </div>
                  ),
                )}
              </div>
            </div>
          </section>
        )}
        <div className="home-screen">

  {/* Existing IPTV content */}

  <AdsterraAd />

  {/* Remaining IPTV content */}

</div>
        {/* Trending Movies */}
        {visibleTrendingMovies.length > 0 && (
          <section aria-label="Trending Movies">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                Trending Movies
              </h2>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => onNavigate('movies')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline"
                >
                  <span>Browse All Movies</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
                <div className="hidden sm:flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => trendingMoviesSlider.scrollBy(-1)}
                    disabled={!trendingMoviesSlider.canScrollLeft}
                    aria-label="Scroll Trending Movies left"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => trendingMoviesSlider.scrollBy(1)}
                    disabled={!trendingMoviesSlider.canScrollRight}
                    aria-label="Scroll Trending Movies right"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
            <div className="relative">
              <div
                ref={trendingMoviesSlider.trackRef}
                onScroll={trendingMoviesSlider.updateScrollState}
                className={SLIDER_TRACK_CLASS}
              >
                {visibleTrendingMovies.slice(0, 18).map((movie) => (
                  <div key={movie.streamId} className={SLIDER_CARD_CLASS}>
                    <MediaCard
                      compactMobile
                      title={movie.cleanTitle}
                      poster={movie.poster}
                      saved={savedKeys.has(`movie:${movie.streamId}`)}
                      rating={movie.rating}
                      addedAt={movie.added}
                      language={extractCardLanguage(movie.name, movie.categoryName)}
                      year={movie.year}
                      qualityTag={movie.qualityTag}
                      categoryName={movie.categoryName}
                      mediaType="Movie"
                      metaParts={[movie.extension ? movie.extension.toUpperCase() : '']}
                      hoverPreviewEnabled={hoverPreviewEnabled}
                      previewKind="movie"
                      previewId={movie.streamId}
                      onOpen={() =>
                        onOpenDetail({
                          kind: 'movie',
                          id: movie.streamId,
                          autoplay: true,
                          initialMovie: {
                            title: movie.cleanTitle,
                            subtitle: movie.categoryName,
                            poster: movie.poster,
                            playUrl: `/api/play/vod/${movie.streamId}.${movie.extension || 'mp4'}`,
                            extension: movie.extension,
                          },
                        })
                      }
                      onQuickPlay={() =>
                        onOpenDetail({
                          kind: 'movie',
                          id: movie.streamId,
                          autoplay: true,
                          initialMovie: {
                            title: movie.cleanTitle,
                            subtitle: movie.categoryName,
                            poster: movie.poster,
                            playUrl: `/api/play/vod/${movie.streamId}.${movie.extension || 'mp4'}`,
                            extension: movie.extension,
                          },
                        })
                      }
                      onToggleSave={() =>
                        onToggleSave({
                          kind: 'movie',
                          id: movie.streamId,
                          title: movie.cleanTitle,
                          poster: movie.poster,
                          year: movie.year,
                          rating: movie.rating,
                          categoryName: movie.categoryName,
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
<div className="home-screen">

  {/* Existing IPTV content */}

  <AdsterraNative />

  {/* Remaining IPTV content */}

</div>
        {/* Popular Series */}
        {visiblePopularSeries.length > 0 && (
          <section aria-label="Popular Series">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                Popular Series
              </h2>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => onNavigate('series')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  <span>Browse All Series</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
                <div className="hidden sm:flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => popularSeriesSlider.scrollBy(-1)}
                    disabled={!popularSeriesSlider.canScrollLeft}
                    aria-label="Scroll Popular Series left"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => popularSeriesSlider.scrollBy(1)}
                    disabled={!popularSeriesSlider.canScrollRight}
                    aria-label="Scroll Popular Series right"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
            <div className="relative">
              <div
                ref={popularSeriesSlider.trackRef}
                onScroll={popularSeriesSlider.updateScrollState}
                className={SLIDER_TRACK_CLASS}
              >
                {visiblePopularSeries.slice(0, 18).map((s) => (
                  <div key={s.seriesId} className={SLIDER_CARD_CLASS}>
                    <MediaCard
                      compactMobile
                      title={s.cleanTitle}
                      poster={s.poster}
                      saved={savedKeys.has(`series:${s.seriesId}`)}
                      rating={s.rating}
                      addedAt={s.lastModified}
                      releaseDate={s.releaseDate}
                      language={extractCardLanguage(s.name, s.categoryName)}
                      year={s.year}
                      categoryName={s.genre || s.categoryName}
                      mediaType="Series"
                      hoverPreviewEnabled={hoverPreviewEnabled}
                      previewKind="series"
                      previewId={s.seriesId}
                      onOpen={() => onOpenDetail({ kind: 'series', id: s.seriesId })}
                      onToggleSave={() =>
                        onToggleSave({
                          kind: 'series',
                          id: s.seriesId,
                          title: s.cleanTitle,
                          poster: s.poster,
                          year: s.year,
                          rating: s.rating,
                          categoryName: s.categoryName,
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Live On Air Now */}
        {visibleFeaturedLive.length > 0 && (
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                Live On Air Now
              </h2>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => onNavigate('live')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-sky-600 dark:text-sky-400 hover:underline"
                >
                  <span>All Channels</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {visibleFeaturedLive.slice(0, 8).map((ch) => (
                <button
                  key={ch.streamId}
                  type="button"
                  onClick={() => onOpenDetail({ kind: 'live', id: ch.streamId, channel: ch })}
                  className="cinebox-card-elevated group flex items-center gap-3.5 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3 text-left shadow-sm shadow-slate-900/5 dark:shadow-none transition-all hover:border-sky-300 dark:hover:border-white/25 dark:hover:bg-[#171D2B]"
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
                        : 'Live Broadcast'}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
