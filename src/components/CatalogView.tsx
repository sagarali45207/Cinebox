import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Film,
  Globe2,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  fetchMovieCategories,
  fetchMovies,
  fetchSeriesCategories,
  fetchSeriesList,
} from '../services/api';
import type {
  CategoryItem,
  DetailTarget,
  GenreItem,
  HomePayload,
  MovieDetail,
  MovieSummary,
  SeriesSummary,
  WatchlistEntry,
} from '../types/media';
import { extractCardLanguage, formatNumber } from '../utils/format';
import {
  loadViewFilters,
  saveViewFilters,
  type CatalogFilterSnapshot,
} from '../utils/navPersistence';
import {
  isParentalActiveAndLocked,
  isRestrictedCategory,
  isRestrictedContent,
  useAppSettings,
} from '../utils/settings';
import { PageLoader } from './LoadingSpinner';
import { MediaCard } from './MediaCard';
import { SeriesEpisodesDownloadModal } from './SeriesEpisodesDownloadModal';
import { SpotlightHeroSlider, type VodHeroSlide } from './SpotlightHeroSlider';
import AdsterraNative from "./AdsterraNative"


interface CatalogViewProps {
  mode: 'movies' | 'series';
  home?: HomePayload | null;
  watchlist: WatchlistEntry[];
  onOpenDetail: (target: DetailTarget) => void;
  onOpenDownloads?: () => void;
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

const SORT_OPTIONS: Array<{ id: 'newest' | 'rating' | 'az'; label: string }> = [
  { id: 'newest', label: 'Newest' },
  { id: 'rating', label: 'Top Rated' },
  { id: 'az', label: 'A–Z' },
];

const DEFAULT_CATALOG_FILTERS: CatalogFilterSnapshot = {
  categoryId: '',
  selectedGenre: '',
  sort: 'newest',
  query: '',
  page: 1,
};

export function CatalogView({
  mode,
  home,
  watchlist,
  onOpenDetail,
  onOpenDownloads,
  onToggleSave,
}: CatalogViewProps) {
  const initialFiltersRef = useRef<CatalogFilterSnapshot | null>(null);
  if (!initialFiltersRef.current) {
    initialFiltersRef.current = loadViewFilters<CatalogFilterSnapshot>(mode, DEFAULT_CATALOG_FILTERS);
  }
  const initialFilters = initialFiltersRef.current;
  const prevModeRef = useRef(mode);

  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoryId, setCategoryId] = useState(initialFilters.categoryId);
  const [selectedGenre, setSelectedGenre] = useState(initialFilters.selectedGenre);
  const [genreSearch, setGenreSearch] = useState('');
  const [genres, setGenres] = useState<GenreItem[]>([]);
  const [sort, setSort] = useState<'newest' | 'rating' | 'az'>(initialFilters.sort);
  const [queryInput, setQueryInput] = useState(initialFilters.query);
  const [debouncedQuery, setDebouncedQuery] = useState(initialFilters.query);
  const [page, setPage] = useState(initialFilters.page);

  const [movies, setMovies] = useState<MovieSummary[]>([]);
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadSeries, setDownloadSeries] = useState<SeriesSummary | null>(null);
  const [hoverPreviewEnabled] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem('cinebox_hover_trailers_v1');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const { settings, parentalUnlocked } = useAppSettings();

  const savedKeys = new Set(watchlist.map((w) => w.key));

  useEffect(() => {
    if (prevModeRef.current === mode) return;
    prevModeRef.current = mode;
    const restored = loadViewFilters<CatalogFilterSnapshot>(mode, DEFAULT_CATALOG_FILTERS);
    setCategoryId(restored.categoryId);
    setSelectedGenre(restored.selectedGenre);
    setGenreSearch('');
    setGenres([]);
    setSort(restored.sort);
    setQueryInput(restored.query);
    setDebouncedQuery(restored.query);
    setPage(restored.page);
    setCategories([]);
    setDownloadSeries(null);
  }, [mode]);

  useEffect(() => {
    saveViewFilters<CatalogFilterSnapshot>(mode, {
      categoryId,
      selectedGenre,
      sort,
      query: debouncedQuery,
      page,
    });
  }, [mode, categoryId, selectedGenre, sort, debouncedQuery, page]);

  useEffect(() => {
    const trimmed = queryInput.trim();
    if (trimmed === debouncedQuery.trim()) return;
    const timer = window.setTimeout(() => {
      setDebouncedQuery(trimmed);
      setPage(1);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [queryInput, debouncedQuery]);

  useEffect(() => {
    const controller = new AbortController();
    const loader = mode === 'movies' ? fetchMovieCategories : fetchSeriesCategories;
    loader(controller.signal)
      .then((res) => setCategories(res.categories))
      .catch(() => {});
    return () => controller.abort();
  }, [mode]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');

    if (mode === 'movies') {
      fetchMovies(
        {
          categoryId,
          genre: selectedGenre,
          q: debouncedQuery,
          sort,
          page,
          limit: 36,
        },
        controller.signal,
      )
        .then((res) => {
          setMovies(res.items);
          setSeries([]);
          setTotal(res.total);
          setTotalPages(res.totalPages);
          if (Array.isArray(res.genres)) setGenres(res.genres);
          setLoading(false);
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          setError(err.message || 'Unable to load movies');
          setLoading(false);
        });
    } else {
      fetchSeriesList(
        {
          categoryId,
          genre: selectedGenre,
          q: debouncedQuery,
          sort,
          page,
          limit: 36,
        },
        controller.signal,
      )
        .then((res) => {
          setSeries(res.items);
          setMovies([]);
          setTotal(res.total);
          setTotalPages(res.totalPages);
          if (Array.isArray(res.genres)) setGenres(res.genres);
          setLoading(false);
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          setError(err.message || 'Unable to load series');
          setLoading(false);
        });
    }

    return () => controller.abort();
  }, [mode, categoryId, selectedGenre, debouncedQuery, sort, page]);

  // Clear selectedGenre automatically if current collection/search no longer contains it
  useEffect(() => {
    if (selectedGenre && genres.length > 0 && !genres.some((g) => g.id === selectedGenre)) {
      setSelectedGenre('');
      setPage(1);
    }
  }, [genres, selectedGenre]);

  const visibleCategories = useMemo(
    () =>
      categories.filter(
        (c) => !isRestrictedCategory(c.categoryName, settings, parentalUnlocked),
      ),
    [categories, settings, parentalUnlocked],
  );

  const visibleMovies = useMemo(
    () =>
      movies.filter(
        (m) =>
          !isRestrictedContent(
            { title: m.cleanTitle, categoryName: m.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
    [movies, settings, parentalUnlocked],
  );

  const visibleSeries = useMemo(
    () =>
      series.filter(
        (s) =>
          !isRestrictedContent(
            { title: s.cleanTitle, categoryName: s.categoryName, genre: s.genre },
            settings,
            parentalUnlocked,
          ),
      ),
    [series, settings, parentalUnlocked],
  );

  const kidsLocked =
    isParentalActiveAndLocked(settings, parentalUnlocked) && settings.parental.kidsMode;

  const activeGenreObj = useMemo(
    () => genres.find((g) => g.id === selectedGenre) || null,
    [genres, selectedGenre],
  );

  const filteredSidebarGenres = useMemo(() => {
    const term = genreSearch.trim().toLowerCase();
    const safeGenres = kidsLocked
      ? genres.filter((g) => g.id !== 'horror' && g.id !== 'crime-thriller')
      : genres;
    const list = term
      ? safeGenres.filter((g) => g.label.toLowerCase().includes(term))
      : safeGenres;
    return {
      core: list.filter((g) => g.group !== 'cinema'),
      cinema: list.filter((g) => g.group === 'cinema'),
    };
  }, [genres, genreSearch, kidsLocked]);

  const handleSelectGenre = (genreId: string) => {
    setSelectedGenre((prev) => (prev === genreId ? '' : genreId));
    setPage(1);
  };

  const clearAllFilters = () => {
    setCategoryId('');
    setSelectedGenre('');
    setGenreSearch('');
    setQueryInput('');
    setDebouncedQuery('');
    setPage(1);
  };

  const activeCategoryName = useMemo(
    () => visibleCategories.find((c) => c.categoryId === categoryId)?.categoryName || '',
    [visibleCategories, categoryId],
  );

  const heroSlides = useMemo<VodHeroSlide[]>(() => {
    const filtersActive = Boolean(categoryId || selectedGenre || debouncedQuery);
    const kickerLabel = debouncedQuery
      ? 'Matching Spotlight'
      : activeGenreObj
        ? `Top in ${activeGenreObj.label}`
        : activeCategoryName
          ? activeCategoryName
          : mode === 'movies'
            ? 'Movies Spotlight'
            : 'Series Spotlight';

    if (mode === 'movies') {
      const heroDetailMap = new Map<string, MovieDetail>();
      for (const item of home?.heroItems || []) {
        if (
          !isRestrictedContent(
            { title: item.cleanTitle, categoryName: item.categoryName, genre: item.genre },
            settings,
            parentalUnlocked,
          )
        ) {
          heroDetailMap.set(item.streamId, item);
        }
      }

      const pool: MovieSummary[] = [];
      const seen = new Set<string>();
      const pushUnique = (m: MovieSummary) => {
        if (seen.has(m.streamId)) return;
        if (
          isRestrictedContent(
            { title: m.cleanTitle, categoryName: m.categoryName },
            settings,
            parentalUnlocked,
          )
        ) {
          return;
        }
        seen.add(m.streamId);
        pool.push(m);
      };

      if (!filtersActive) {
        for (const item of home?.heroItems || []) pushUnique(item);
        for (const item of home?.trendingMovies || []) {
          if (pool.length >= 6) break;
          pushUnique(item);
        }
      }

      const sortedVisible = [...visibleMovies].sort((a, b) => {
        const aRich = heroDetailMap.has(a.streamId) ? 1 : 0;
        const bRich = heroDetailMap.has(b.streamId) ? 1 : 0;
        if (aRich !== bRich) return bRich - aRich;
        if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
        return (b.added || 0) - (a.added || 0);
      });

      for (const item of sortedVisible) {
        if (pool.length >= 6) break;
        pushUnique(item);
      }

      return pool.slice(0, 6).map((m) => {
        const detail = heroDetailMap.get(m.streamId);
        const playUrl = detail?.playUrl || `/api/play/vod/${m.streamId}.${m.extension || 'mp4'}`;
        return {
          kind: 'movie',
          id: m.streamId,
          kicker: kickerLabel,
          title: m.cleanTitle,
          categoryName: m.categoryName,
          language: extractCardLanguage(m.name, m.categoryName),
          rating: m.rating,
          year: m.year,
          metaText:
            detail?.duration ||
            m.qualityTag ||
            (m.extension ? m.extension.toUpperCase() : undefined),
          genre: detail?.genre,
          plot: detail?.plot,
          poster: m.poster,
          backdrop: detail?.backdrop || m.poster,
          youtubeTrailer: detail?.youtubeTrailer,
          primaryActionLabel: 'Watch Now',
          secondaryActionLabel: 'More Details',
          onPrimaryAction: () =>
            onOpenDetail({
              kind: 'movie',
              id: m.streamId,
              autoplay: true,
              initialMovie: {
                title: m.cleanTitle,
                subtitle: m.categoryName,
                poster: m.poster,
                playUrl,
                extension: m.extension,
              },
            }),
          onSecondaryAction: () =>
            onOpenDetail({
              kind: 'movie',
              id: m.streamId,
              initialMovie: {
                title: m.cleanTitle,
                subtitle: m.categoryName,
                poster: m.poster,
                playUrl,
                extension: m.extension,
              },
            }),
        };
      });
    }

    const pool: SeriesSummary[] = [];
    const seen = new Set<string>();
    const pushUniqueSeries = (s: SeriesSummary) => {
      if (seen.has(s.seriesId)) return;
      if (
        isRestrictedContent(
          { title: s.cleanTitle, categoryName: s.categoryName, genre: s.genre },
          settings,
          parentalUnlocked,
        )
      ) {
        return;
      }
      seen.add(s.seriesId);
      pool.push(s);
    };

    const scoreSeries = (s: SeriesSummary) =>
      (s.backdrop ? 200 : 0) + (s.plot ? 100 : 0) + (s.rating || 0) * 10;

    if (!filtersActive) {
      const safePopular = [...(home?.popularSeries || [])].sort(
        (a, b) => scoreSeries(b) - scoreSeries(a),
      );
      for (const s of safePopular) {
        if (pool.length >= 6) break;
        pushUniqueSeries(s);
      }
    }

    const sortedVisibleSeries = [...visibleSeries].sort(
      (a, b) => scoreSeries(b) - scoreSeries(a),
    );
    for (const s of sortedVisibleSeries) {
      if (pool.length >= 6) break;
      pushUniqueSeries(s);
    }

    return pool.slice(0, 6).map((s) => ({
      kind: 'series',
      id: s.seriesId,
      kicker: kickerLabel,
      title: s.cleanTitle,
      categoryName: s.categoryName,
      language: extractCardLanguage(s.name, s.categoryName),
      rating: s.rating,
      year: s.year,
      metaText: 'Series',
      genre: s.genre,
      plot: s.plot,
      poster: s.poster,
      backdrop: s.backdrop || s.poster,
      primaryActionLabel: 'Watch Series',
      secondaryActionLabel: 'Explore Episodes',
      onPrimaryAction: () =>
        onOpenDetail({
          kind: 'series',
          id: s.seriesId,
        }),
      onSecondaryAction: () =>
        onOpenDetail({
          kind: 'series',
          id: s.seriesId,
        }),
    }));
  }, [
    mode,
    home?.heroItems,
    home?.trendingMovies,
    home?.popularSeries,
    visibleMovies,
    visibleSeries,
    categoryId,
    selectedGenre,
    debouncedQuery,
    activeGenreObj,
    activeCategoryName,
    settings,
    parentalUnlocked,
    onOpenDetail,
  ]);

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 pb-16">
      {heroSlides.length > 0 && (
        <div className="mb-7">
          <SpotlightHeroSlider
            slides={heroSlides}
            ariaLabel={mode === 'movies' ? 'Featured Movies Slider' : 'Featured Series Slider'}
            hoverPreviewEnabled={hoverPreviewEnabled}
            compact
          />
        </div>
      )}

      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-200/80 dark:border-white/[0.08] pb-6">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
            {mode === 'movies' ? 'Movies' : 'Series'}
          </h1>
          
        </div>

        <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none self-start lg:self-auto">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                setSort(opt.id);
                setPage(1);
              }}
              className={`min-h-[36px] px-3.5 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-colors ${
                sort === opt.id
                  ? 'bg-[#E11D48] text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-5">
          <select
            aria-label={`Filter ${mode} by collection`}
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
            className="h-11 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-3.5 text-sm text-slate-900 dark:text-white shadow-sm shadow-slate-900/5 dark:shadow-none focus:border-[#E11D48] focus:outline-none"
          >
            <option value="">
              {mode === 'movies' ? 'All Movie Collections' : 'All Series Collections'}
            </option>
            {visibleCategories.map((c) => (
              <option key={c.categoryId} value={c.categoryId}>
                {c.categoryName} ({formatNumber(c.count)})
              </option>
            ))}
          </select>
        </div>

        <div className="relative md:col-span-7">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder={`Search ${mode === 'movies' ? 'movies' : 'series'} by title...`}
            className="h-11 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] pl-10 pr-4 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 shadow-sm shadow-slate-900/5 dark:shadow-none focus:border-[#E11D48] focus:outline-none"
          />
        </div>
      </div>

      {/* Desktop Genre Sidebar + Catalog Content */}
      <div className="mt-7 flex flex-col lg:flex-row lg:items-start gap-7">
        {/* Desktop-Only Dynamic Genre Filter Sidebar */}
        <aside
          aria-label={`${mode === 'movies' ? 'Movie' : 'Series'} genre filters`}
          className="hidden lg:block w-64 xl:w-72 shrink-0 sticky top-20 self-start"
        >
          <div className="rounded-2xl border border-slate-200/90 dark:border-white/[0.08] bg-white/95 dark:bg-[#111520]/95 p-4 shadow-sm shadow-slate-900/5 dark:shadow-none">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200/80 dark:border-white/[0.08]">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#E11D48]/12 text-[#E11D48] dark:text-rose-400">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  Browse Genres
                </h2>
              </div>
              {selectedGenre && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedGenre('');
                    setPage(1);
                  }}
                  className="text-[11px] font-semibold text-[#E11D48] hover:text-rose-700 dark:hover:text-rose-300 transition-colors"
                >
                  Reset
                </button>
              )}
            </div>

            {genres.length > 8 && (
              <div className="relative mt-3">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={genreSearch}
                  onChange={(e) => setGenreSearch(e.target.value)}
                  placeholder="Filter genres..."
                  className="h-9 w-full rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50/80 dark:bg-[#0B0E16] pl-8 pr-3 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
                />
              </div>
            )}

            <div className="mt-3 max-h-[calc(100vh-15rem)] overflow-y-auto pr-1 space-y-4">
              {loading && genres.length === 0 ? (
                <div className="space-y-2 py-1">
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="h-9 rounded-lg bg-slate-100 dark:bg-white/[0.04]"
                    />
                  ))}
                </div>
              ) : (
                <>
                  {/* All Genres option */}
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedGenre('');
                        setPage(1);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs font-semibold transition-colors ${
                        !selectedGenre
                          ? 'bg-[#E11D48] text-white shadow-sm'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06]'
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <Film className="h-3.5 w-3.5 shrink-0 opacity-85" />
                        <span className="truncate">
                          All {mode === 'movies' ? 'Movies' : 'Series'}
                        </span>
                      </span>
                    </button>

                    {filteredSidebarGenres.core.map((g) => {
                      const active = selectedGenre === g.id;
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => handleSelectGenre(g.id)}
                          className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors ${
                            active
                              ? 'bg-[#E11D48] text-white font-semibold shadow-sm'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          <span className="truncate">{g.label}</span>
                          <span
                            className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums ${
                              active
                                ? 'bg-white/20 text-white'
                                : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {formatNumber(g.count)}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {filteredSidebarGenres.cinema.length > 0 && (
                    <div className="border-t border-slate-200/80 dark:border-white/[0.08] pt-3 space-y-1">
                      <div className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                        <Globe2 className="h-3 w-3" />
                        <span>Cinema &amp; Regions</span>
                      </div>
                      {filteredSidebarGenres.cinema.map((g) => {
                        const active = selectedGenre === g.id;
                        return (
                          <button
                            key={g.id}
                            type="button"
                            onClick={() => handleSelectGenre(g.id)}
                            className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors ${
                              active
                                ? 'bg-[#E11D48] text-white font-semibold shadow-sm'
                                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06] hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <span className="truncate">{g.label}</span>
                            <span
                              className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums ${
                                active
                                  ? 'bg-white/20 text-white'
                                  : 'bg-slate-100 dark:bg-white/[0.06] text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              {formatNumber(g.count)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {filteredSidebarGenres.core.length === 0 &&
                    filteredSidebarGenres.cinema.length === 0 && (
                      <p className="px-2 py-4 text-center text-xs text-slate-500 dark:text-slate-400">
                        No matching genres found.
                      </p>
                    )}
                </>
              )}
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 min-w-0">
          {/* Active Desktop Genre Indicator Bar */}
          {activeGenreObj && (
            <div className="hidden lg:flex items-center justify-between gap-3 mb-5 rounded-xl border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-950/25 px-4 py-2.5">
              <div className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200">
                <span className="font-medium text-slate-500 dark:text-slate-400">
                  Selected Genre:
                </span>
                <span className="font-bold text-slate-900 dark:text-white">
                  {activeGenreObj.label}
                </span>
                <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                  ({formatNumber(total)} titles)
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedGenre('');
                  setPage(1);
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-white/80 dark:bg-white/10 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-white/20 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                <span>Clear</span>
              </button>
            </div>
          )}

          {loading ? (
            <PageLoader
              label={`Loading ${mode === 'movies' ? 'movies' : 'series'} from catalog...`}
              sublabel="Fetching titles, posters, ratings, and collections"
              className="py-24"
            />
          ) : error ? (
            <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] p-10 text-center">
              <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                Catalog Unavailable
              </p>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{error}</p>
            </div>
          ) : mode === 'movies' && visibleMovies.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-12 text-center">
              <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                No Movies Found
              </p>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                Try clearing your genre, collection filter, or search query.
              </p>
              {(categoryId || selectedGenre || debouncedQuery) && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[#BE123C]"
                >
                  Clear All Filters
                </button>
              )}
            </div>
          ) : mode === 'series' && visibleSeries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-12 text-center">
              <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                No Series Found
              </p>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                Try clearing your genre, collection filter, or search query.
              </p>
              {(categoryId || selectedGenre || debouncedQuery) && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[#BE123C]"
                >
                  Clear All Filters
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6">
              {mode === 'movies'
                ? visibleMovies.map((movie) => (
                    <MediaCard
                      key={movie.streamId}
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
                  ))
                : visibleSeries.map((item) => (
                    <MediaCard
                      key={item.seriesId}
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
                        onOpenDetail({
                          kind: 'series',
                          id: item.seriesId,
                        })
                      }
                      onDownload={() => setDownloadSeries(item)}
                      downloadLabel={`Download episodes of ${item.cleanTitle}`}
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
          )}
          <div className="home-screen">

  {/* Existing IPTV content */}

  <AdsterraNative />

  {/* Remaining IPTV content */}

</div>
          {/* Pagination */}
          {!loading && totalPages > 1 && (
            <div className="mt-10 flex items-center justify-between border-t border-slate-200/80 dark:border-white/[0.08] pt-6">
              <p className="text-xs text-slate-600 dark:text-slate-400 tabular-nums">
                Page {page} of {formatNumber(totalPages)}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => {
                    setPage((p) => Math.max(1, p - 1));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-3.5 text-xs font-medium text-slate-800 dark:text-white disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-white/10 shadow-sm shadow-slate-900/5 dark:shadow-none"
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => {
                    setPage((p) => Math.min(totalPages, p + 1));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-3.5 text-xs font-medium text-slate-800 dark:text-white disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-white/10 shadow-sm shadow-slate-900/5 dark:shadow-none"
                >
                  <span>Next</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <SeriesEpisodesDownloadModal
        series={downloadSeries}
        onClose={() => setDownloadSeries(null)}
        onOpenDownloads={onOpenDownloads}
      />
    </div>
  );
}
