import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import { fetchRecommendations } from '../services/api';
import type {
  DetailTarget,
  HomePayload,
  RecommendationEntry,
  RecommendationsResponse,
  WatchHistoryEntry,
  WatchlistEntry,
} from '../types/media';
import { extractCardLanguage } from '../utils/format';
import { isRestrictedContent, useAppSettings } from '../utils/settings';
import {
  CANONICAL_FAVORITE_GENRES,
  getFavoriteGenres,
  getPositiveReviewedMedia,
  setFavoriteGenres,
  toggleFavoriteGenre,
} from '../utils/storage';
import { MediaCard } from './MediaCard';

interface RecommendedForYouSectionProps {
  home: HomePayload | null;
  continueEntries: WatchHistoryEntry[];
  watchlist: WatchlistEntry[];
  hoverPreviewEnabled: boolean;
  savedKeys: Set<string>;
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
}

type RecommendedFilter = 'all' | 'movies' | 'series';

const GENRE_KEYWORDS: Record<string, RegExp> = {
  'action-adventure': /\b(action|adventure|marvel|007|james bond|fast|rambo|mission|wick)\b/i,
  drama: /\b(drama|oscar|godfather|biograph|hum tv|geo|ary)\b/i,
  comedy: /\b(comedy|funny|stand-?up|kapil|umer sharif|sitcom)\b/i,
  'crime-thriller': /\b(crime|thriller|mystery|detective|murder|mafia|heist|cartel)\b/i,
  horror: /\b(horror|conjuring|annabelle|scary|ghost|vampire|zombie|evil)\b/i,
  'sci-fi-fantasy': /\b(sci-?fi|science fiction|fantasy|marvel|star wars|dune|matrix|avatar)\b/i,
  romance: /\b(romance|romantic|love)\b/i,
  'kids-family': /\b(kids|family|disney|pixar|cartoon|nick)\b/i,
  animation: /\b(animation|animated|anime|pixar|disney)\b/i,
  documentary: /\b(documentary|documentaries|planet|cosmos|biography)\b/i,
  sports: /\b(sport|sports|cricket|fifa|wwe|ufc|fighting|boxing)\b/i,
};

function buildLocalFallbackRecommendations(
  home: HomePayload | null,
  favoriteGenres: string[],
  continueEntries: WatchHistoryEntry[],
  watchlist: WatchlistEntry[],
): RecommendationEntry[] {
  if (!home) return [];

  const watchedMovieIds = new Set(
    continueEntries.filter((e) => e.kind === 'movie').map((e) => e.id),
  );
  const watchedSeriesIds = new Set(
    continueEntries.filter((e) => e.kind === 'episode' && e.seriesId).map((e) => e.seriesId!),
  );
  const watchedCategories = new Set(
    [
      ...continueEntries.map((e) => e.categoryName || ''),
      ...watchlist.map((w) => w.categoryName || ''),
    ]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const labelById = new Map(CANONICAL_FAVORITE_GENRES.map((g) => [g.id, g.label]));
  const out: RecommendationEntry[] = [];

  const trendingMovies = Array.isArray(home.trendingMovies) ? home.trendingMovies : [];
  for (const movie of trendingMovies) {
    if (watchedMovieIds.has(movie.streamId)) continue;
    const text = `${movie.cleanTitle} ${movie.categoryName}`;
    const matched = favoriteGenres.filter((gid) => GENRE_KEYWORDS[gid]?.test(text));
    const catHit = watchedCategories.has((movie.categoryName || '').trim().toLowerCase());
    const score =
      matched.length * 4 + (catHit ? 2.5 : 0) + (movie.rating || 6) * 0.45;
    const matchedLabels = matched.map((id) => labelById.get(id) || id);
    out.push({
      kind: 'movie',
      item: movie,
      score,
      reason:
        matchedLabels.length > 0
          ? `Favorite: ${matchedLabels[0]}`
          : catHit
            ? `Based on ${movie.categoryName}`
            : 'Top-rated pick',
      matchedGenres: matchedLabels,
    });
  }

  const popularSeries = Array.isArray(home.popularSeries) ? home.popularSeries : [];
  for (const series of popularSeries) {
    if (watchedSeriesIds.has(series.seriesId)) continue;
    const text = `${series.cleanTitle} ${series.genre} ${series.categoryName}`;
    const matched = favoriteGenres.filter((gid) => GENRE_KEYWORDS[gid]?.test(text));
    const catHit = watchedCategories.has((series.categoryName || '').trim().toLowerCase());
    const score =
      matched.length * 4 + (catHit ? 2.5 : 0) + (series.rating || 6) * 0.45;
    const matchedLabels = matched.map((id) => labelById.get(id) || id);
    out.push({
      kind: 'series',
      item: series,
      score,
      reason:
        matchedLabels.length > 0
          ? `Favorite: ${matchedLabels[0]}`
          : catHit
            ? `Based on ${series.categoryName}`
            : 'Top-rated series',
      matchedGenres: matchedLabels,
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 18);
}

export function RecommendedForYouSection({
  home,
  continueEntries,
  watchlist,
  hoverPreviewEnabled,
  savedKeys,
  onOpenDetail,
  onToggleSave,
}: RecommendedForYouSectionProps) {
  const [favoriteGenres, setFavoriteGenresState] = useState<string[]>(() =>
    getFavoriteGenres(),
  );
  const [showGenrePicker, setShowGenrePicker] = useState<boolean>(() => {
    const savedFavs = getFavoriteGenres();
    return (
      savedFavs.length === 0 &&
      continueEntries.length === 0 &&
      watchlist.length === 0
    );
  });
  const [kindFilter, setKindFilter] = useState<RecommendedFilter>('all');
  const [response, setResponse] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const { settings, parentalUnlocked } = useAppSettings();
  const trackRef = useRef<HTMLDivElement>(null);

  const signalPayload = useMemo(() => {
    const watchedMovieIds: string[] = [];
    const watchedSeriesIds: string[] = [];
    const seenMovies = new Set<string>();
    const seenSeries = new Set<string>();
    const watchedCategories = new Set<string>();
    const watchedLanguages = new Set<string>();

    for (const entry of continueEntries) {
      if (entry.kind === 'movie' && entry.id && !seenMovies.has(entry.id)) {
        seenMovies.add(entry.id);
        watchedMovieIds.push(entry.id);
      } else if (entry.kind === 'episode' && entry.seriesId && !seenSeries.has(entry.seriesId)) {
        seenSeries.add(entry.seriesId);
        watchedSeriesIds.push(entry.seriesId);
      }
      if (entry.categoryName) watchedCategories.add(entry.categoryName);
      const lang = entry.language || extractCardLanguage(entry.title, entry.categoryName);
      if (lang) watchedLanguages.add(lang);
    }

    const watchlistMovieIds: string[] = [];
    const watchlistSeriesIds: string[] = [];
    for (const w of watchlist) {
      if (w.kind === 'movie') watchlistMovieIds.push(w.id);
      else watchlistSeriesIds.push(w.id);
      if (w.categoryName) watchedCategories.add(w.categoryName);
    }

    return {
      favoriteGenres,
      watchedMovieIds: watchedMovieIds.slice(0, 20),
      watchedSeriesIds: watchedSeriesIds.slice(0, 20),
      watchlistMovieIds: watchlistMovieIds.slice(0, 20),
      watchlistSeriesIds: watchlistSeriesIds.slice(0, 20),
      watchedCategories: Array.from(watchedCategories).slice(0, 20),
      watchedLanguages: Array.from(watchedLanguages).slice(0, 10),
      likedTitles: getPositiveReviewedMedia().slice(0, 20),
      limit: 18,
    };
  }, [favoriteGenres, continueEntries, watchlist]);

  const signalFingerprint = useMemo(
    () => JSON.stringify(signalPayload),
    [signalPayload],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetchRecommendations(signalPayload, controller.signal)
        .then((data) => {
          setResponse(data);
          setLoading(false);
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          setLoading(false);
        });
    }, 90);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [signalFingerprint, signalPayload]);

  const fallbackItems = useMemo(
    () =>
      buildLocalFallbackRecommendations(
        home,
        favoriteGenres,
        continueEntries,
        watchlist,
      ),
    [home, favoriteGenres, continueEntries, watchlist],
  );

  const rawRecommendations =
    response && Array.isArray(response.items) && response.items.length > 0
      ? response.items
      : fallbackItems;

  const allRecommendations = useMemo(
    () =>
      rawRecommendations.filter((entry) =>
        entry.kind === 'movie'
          ? !isRestrictedContent(
              { title: entry.item.cleanTitle, categoryName: entry.item.categoryName },
              settings,
              parentalUnlocked,
            )
          : !isRestrictedContent(
              {
                title: entry.item.cleanTitle,
                categoryName: entry.item.categoryName,
                genre: entry.item.genre,
              },
              settings,
              parentalUnlocked,
            ),
      ),
    [rawRecommendations, settings, parentalUnlocked],
  );

  const filteredItems = useMemo(() => {
    if (kindFilter === 'movies') {
      return allRecommendations.filter((entry) => entry.kind === 'movie');
    }
    if (kindFilter === 'series') {
      return allRecommendations.filter((entry) => entry.kind === 'series');
    }
    return allRecommendations;
  }, [allRecommendations, kindFilter]);

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
  }, [filteredItems.length, kindFilter, updateScrollState]);

  const scrollByDirection = (direction: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    const step = Math.max(260, Math.round(el.clientWidth * 0.78));
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  };

  const handleToggleGenre = (genreId: string) => {
    setFavoriteGenresState(toggleFavoriteGenre(genreId));
  };

  const handleClearGenres = () => {
    setFavoriteGenresState(setFavoriteGenres([]));
  };

  const labelById = useMemo(
    () => new Map(CANONICAL_FAVORITE_GENRES.map((g) => [g.id, g.label])),
    [],
  );

  const tasteSummary = useMemo(() => {
    const favLabels = favoriteGenres
      .map((id) => labelById.get(id) || id)
      .slice(0, 3);
    const inferredLabels = (Array.isArray(response?.inferredGenres) ? response.inferredGenres : [])
      .map((g) => g.label)
      .filter((label) => !favLabels.includes(label))
      .slice(0, 2);

    const hasHistory = continueEntries.length > 0 || watchlist.length > 0;
    const combinedLabels = [...favLabels, ...inferredLabels].slice(0, 3);

    if (hasHistory && combinedLabels.length > 0) {
      return `Based on your watch history · ${combinedLabels.join(', ')}`;
    }
    if (favLabels.length > 0) {
      return `Personalized for ${favLabels.join(', ')}`;
    }
    if (hasHistory) {
      return 'Tailored from your recently watched titles and library';
    }
    return 'Pick favorite genres or watch titles to tailor your feed';
  }, [favoriteGenres, labelById, response?.inferredGenres, continueEntries.length, watchlist.length]);

  if (allRecommendations.length === 0 && !loading && !showGenrePicker) {
    return null;
  }

  return (
    <section aria-label="Recommended for You">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#E11D48]/12 text-[#E11D48] dark:text-rose-400">
            <Compass className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white leading-tight">
                Recommended for You
              </h2>
              {loading && (
                <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
                  Updating...
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
              {tasteSummary}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={showGenrePicker}
            onClick={() => setShowGenrePicker((prev) => !prev)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors whitespace-nowrap ${
              showGenrePicker || favoriteGenres.length > 0
                ? 'border-indigo-400/50 bg-indigo-50/80 text-indigo-700 dark:border-indigo-400/35 dark:bg-indigo-500/15 dark:text-indigo-200'
                : 'border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/25'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Favorite Genres</span>
            {favoriteGenres.length > 0 && (
              <span className="font-mono text-[11px] tabular-nums opacity-85">
                ({favoriteGenres.length})
              </span>
            )}
          </button>

          <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'movies', label: 'Movies' },
                { id: 'series', label: 'Series' },
              ] as Array<{ id: RecommendedFilter; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setKindFilter(tab.id)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  kindFilter === tab.id
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
              onClick={() => scrollByDirection(-1)}
              disabled={!canScrollLeft}
              aria-label="Scroll Recommended for You left"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => scrollByDirection(1)}
              disabled={!canScrollRight}
              aria-label="Scroll Recommended for You right"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Interactive Favorite Genres Selector */}
      {showGenrePicker && (
        <div className="mb-4 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3.5 shadow-sm shadow-slate-900/5 dark:shadow-none">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Select genres you enjoy to fine-tune your personal recommendations
            </p>
            {favoriteGenres.length > 0 && (
              <button
                type="button"
                onClick={handleClearGenres}
                className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline whitespace-nowrap"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Clear</span>
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {CANONICAL_FAVORITE_GENRES.map((genre) => {
              const active = favoriteGenres.includes(genre.id);
              return (
                <button
                  key={genre.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleToggleGenre(genre.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                    active
                      ? 'border-transparent bg-[#E11D48] text-white shadow-sm'
                      : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-slate-300 hover:border-rose-300 dark:hover:border-white/25 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {active && <Check className="h-3 w-3" />}
                  <span>{genre.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {filteredItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/60 dark:bg-[#111520]/60 px-5 py-8 text-center">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            No {kindFilter === 'movies' ? 'movies' : 'series'} matched your current filter.
          </p>
          {kindFilter !== 'all' && (
            <button
              type="button"
              onClick={() => setKindFilter('all')}
              className="mt-2.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              Show All Recommendations
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <div
            ref={trackRef}
            onScroll={updateScrollState}
            className="flex gap-2.5 sm:gap-4 overflow-x-auto scroll-smooth snap-x snap-mandatory pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          >
            {filteredItems.map((entry) =>
              entry.kind === 'movie' ? (
                <div
                  key={`rec-movie-${entry.item.streamId}`}
                  className="w-[calc((100%-1.25rem)/3)] sm:w-[180px] md:w-[196px] lg:w-[210px] shrink-0 snap-start"
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
                    categoryName={entry.reason || entry.item.categoryName}
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
                  key={`rec-series-${entry.item.seriesId}`}
                  className="w-[calc((100%-1.25rem)/3)] sm:w-[180px] md:w-[196px] lg:w-[210px] shrink-0 snap-start"
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
                    categoryName={entry.reason || entry.item.genre || entry.item.categoryName}
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
      )}
    </section>
  );
}
