import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Clapperboard,
  Film,
  History,
  Loader2,
  Radio,
  Search,
  User,
  X,
} from 'lucide-react';
import { omniSearch, searchByPerson } from '../services/api';
import type {
  CastMember,
  DetailTarget,
  LiveChannelSummary,
  MovieSummary,
  SeriesSummary,
} from '../types/media';
import { proxiedImageUrl } from '../utils/format';
import {
  isRestrictedContent,
  loadRecentSearches,
  MAX_RECENT_SEARCHES,
  saveRecentSearches,
  useAppSettings,
} from '../utils/settings';
import { LoadingSpinner } from './LoadingSpinner';
import { MediaImage } from './MediaImage';

type SearchScope = 'all' | 'movies' | 'series' | 'live';

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 5);
  if (!text || tokens.length === 0) return <>{text}</>;

  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const rx = new RegExp(`(${escaped.join('|')})`, 'ig');
  const parts = text.split(rx);

  return (
    <>
      {parts.map((part, idx) =>
        idx % 2 === 1 ? (
          <mark
            key={idx}
            className="rounded bg-rose-500/15 px-0.5 font-semibold text-[#E11D48] dark:bg-rose-400/20 dark:text-rose-300"
          >
            {part}
          </mark>
        ) : (
          <Fragment key={idx}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export interface SearchPersonContext {
  member: CastMember;
  excludeKind?: 'movie' | 'series';
  excludeId?: string;
}

interface OmniSearchModalProps {
  initialPerson?: SearchPersonContext | null;
  onClose: () => void;
  onOpenDetail: (target: DetailTarget) => void;
}

export function OmniSearchModal({
  initialPerson = null,
  onClose,
  onOpenDetail,
}: OmniSearchModalProps) {
  const { settings, parentalUnlocked } = useAppSettings();

  const [activePerson, setActivePerson] = useState<SearchPersonContext | null>(initialPerson);
  const [query, setQuery] = useState(initialPerson ? initialPerson.member.name : '');
  const [debounced, setDebounced] = useState(
    initialPerson ? initialPerson.member.name : '',
  );
  const [scope, setScope] = useState<SearchScope>('all');
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecentSearches());
  const [loading, setLoading] = useState(Boolean(initialPerson));
  const [error, setError] = useState('');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [matchedTitlesCount, setMatchedTitlesCount] = useState<number | null>(null);
  const [results, setResults] = useState<{
    movies: MovieSummary[];
    series: SeriesSummary[];
    live: LiveChannelSummary[];
  }>({ movies: [], series: [], live: [] });
  const [activeIndex, setActiveIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const settledQueryRef = useRef<string>('');
  const resultButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const recordRecentSearch = useCallback(
    (rawTerm: string) => {
      if (!settings.saveSearchHistory) return;
      const trimmed = rawTerm.trim();
      if (trimmed.length < 2) return;
      setRecentSearches((prev) => {
        const lower = trimmed.toLowerCase();
        const next = [
          trimmed,
          ...prev.filter((item) => item.toLowerCase() !== lower),
        ].slice(0, MAX_RECENT_SEARCHES);
        return saveRecentSearches(next);
      });
    },
    [settings.saveSearchHistory],
  );

  const removeRecentSearch = useCallback((term: string) => {
    const lower = term.toLowerCase();
    setRecentSearches((prev) => {
      const next = prev.filter((item) => item.toLowerCase() !== lower);
      return saveRecentSearches(next);
    });
  }, []);

  const clearRecentSearches = useCallback(() => {
    setRecentSearches([]);
    saveRecentSearches([]);
  }, []);

  const handleClose = useCallback(() => {
    if (!activePerson && settledQueryRef.current.length >= 2) {
      recordRecentSearch(settledQueryRef.current);
    }
    onClose();
  }, [activePerson, onClose, recordRecentSearch]);

  useEffect(() => {
    setActivePerson(initialPerson);
    setAvatarFailed(false);
    setMatchedTitlesCount(null);
    setScope('all');
    if (initialPerson) {
      setQuery(initialPerson.member.name);
      setDebounced(initialPerson.member.name);
    }
  }, [initialPerson]);

  useEffect(() => {
    if (!initialPerson) {
      inputRef.current?.focus();
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleClose, initialPerson]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(query.trim());
    }, 120);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();

    if (activePerson) {
      settledQueryRef.current = '';
      setLoading(true);
      setError('');
      searchByPerson(
        {
          name: activePerson.member.name,
          imdbId: activePerson.member.imdbId,
          excludeKind: activePerson.excludeKind,
          excludeId: activePerson.excludeId,
        },
        controller.signal,
      )
        .then((res) => {
          setResults({ movies: res.movies, series: res.series, live: res.live });
          setMatchedTitlesCount(res.matchedTitlesCount);
          setLoading(false);
          setActiveIndex(-1);
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          setError(err.message || 'Unable to search credits');
          setLoading(false);
        });

      return () => controller.abort();
    }

    if (debounced.length < 2) {
      settledQueryRef.current = '';
      setResults({ movies: [], series: [], live: [] });
      setMatchedTitlesCount(null);
      setLoading(false);
      setError('');
      setActiveIndex(-1);
      return;
    }

    setLoading(true);
    setError('');
    setMatchedTitlesCount(null);

    omniSearch(debounced, controller.signal)
      .then((res) => {
        setResults(res);
        setLoading(false);
        setActiveIndex(-1);
        const count = res.movies.length + res.series.length + res.live.length;
        settledQueryRef.current = count > 0 ? debounced : '';
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        settledQueryRef.current = '';
        setError(err.message || 'Search failed');
        setLoading(false);
      });

    return () => controller.abort();
  }, [activePerson, debounced]);

  const safeResults = useMemo(() => {
    return {
      movies: results.movies.filter(
        (m) =>
          !isRestrictedContent(
            { title: m.cleanTitle || m.name, categoryName: m.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
      series: results.series.filter(
        (s) =>
          !isRestrictedContent(
            {
              title: s.cleanTitle || s.name,
              categoryName: s.categoryName,
              genre: s.genre,
            },
            settings,
            parentalUnlocked,
          ),
      ),
      live: results.live.filter(
        (c) =>
          !isRestrictedContent(
            { title: c.name, categoryName: c.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
    };
  }, [results, settings, parentalUnlocked]);

  const matchingRecentSuggestions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed || activePerson) return [];
    return recentSearches
      .filter((term) => {
        const lower = term.toLowerCase();
        return lower !== trimmed && lower.includes(trimmed);
      })
      .slice(0, 5);
  }, [query, recentSearches, activePerson]);

  const totalCount =
    safeResults.movies.length + safeResults.series.length + safeResults.live.length;

  const displayedMovies = scope === 'all' || scope === 'movies' ? safeResults.movies : [];
  const displayedSeries = scope === 'all' || scope === 'series' ? safeResults.series : [];
  const displayedLive = scope === 'all' || scope === 'live' ? safeResults.live : [];
  const displayedCount =
    displayedMovies.length + displayedSeries.length + displayedLive.length;

  const commitAndNavigate = useCallback(
    (target: DetailTarget) => {
      if (!activePerson) {
        const current = (debounced || query).trim();
        if (current.length >= 2) {
          recordRecentSearch(current);
        }
      }
      onClose();
      onOpenDetail(target);
    },
    [activePerson, debounced, query, recordRecentSearch, onClose, onOpenDetail],
  );

  const flatTargets = useMemo<DetailTarget[]>(() => {
    const list: DetailTarget[] = [];
    for (const m of displayedMovies) {
      list.push({
        kind: 'movie',
        id: m.streamId,
        autoplay: true,
        initialMovie: {
          title: m.cleanTitle,
          subtitle: m.categoryName,
          poster: m.poster,
          playUrl: `/api/play/vod/${m.streamId}.${m.extension || 'mp4'}`,
          extension: m.extension,
        },
      });
    }
    for (const s of displayedSeries) {
      list.push({ kind: 'series', id: s.seriesId });
    }
    for (const ch of displayedLive) {
      list.push({ kind: 'live', id: ch.streamId, channel: ch });
    }
    return list;
  }, [displayedMovies, displayedSeries, displayedLive]);

  const applyRecentSearch = (term: string) => {
    setQuery(term);
    setDebounced(term);
    setScope('all');
    recordRecentSearch(term);
    inputRef.current?.focus();
  };

  useEffect(() => {
    if (activeIndex >= 0 && resultButtonRefs.current[activeIndex]) {
      resultButtonRefs.current[activeIndex]?.scrollIntoView({
        block: 'nearest',
      });
    }
  }, [activeIndex]);

  const personInitials = activePerson
    ? activePerson.member.name
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
    : '';

  const showInitialLoading = loading && totalCount === 0;
  const showRefreshingIndicator = loading && totalCount > 0;
  const isIdleMode = !activePerson && query.trim().length < 2 && debounced.length < 2;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={
        activePerson
          ? `Filmography search for ${activePerson.member.name}`
          : 'Search Catalog'
      }
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-10 sm:pt-16 pb-8"
    >
      <div className="flex max-h-[84vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#0E121C] shadow-lg">
        {/* Search Input Row */}
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-white/[0.08] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[#E11D48]" />
          <input
            ref={inputRef}
            type="text"
            inputMode="search"
            value={query}
            onChange={(e) => {
              const nextVal = e.target.value;
              setQuery(nextVal);
              setActiveIndex(-1);
              if (activePerson) {
                setActivePerson(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && flatTargets.length > 0) {
                e.preventDefault();
                setActiveIndex((prev) => (prev + 1) % flatTargets.length);
              } else if (e.key === 'ArrowUp' && flatTargets.length > 0) {
                e.preventDefault();
                setActiveIndex((prev) =>
                  prev <= 0 ? flatTargets.length - 1 : prev - 1,
                );
              } else if (e.key === 'Enter') {
                if (activeIndex >= 0 && flatTargets[activeIndex]) {
                  e.preventDefault();
                  commitAndNavigate(flatTargets[activeIndex]);
                  return;
                }
                if (!activePerson) {
                  const trimmed = query.trim();
                  if (trimmed.length >= 2) {
                    setDebounced(trimmed);
                    recordRecentSearch(trimmed);
                  }
                }
              }
            }}
            placeholder="Search movies, series, genres, or live TV channels..."
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none"
          />

          {showRefreshingIndicator && (
            <span
              aria-label="Updating search results"
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-slate-400 dark:text-slate-500"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E11D48]" />
              <span className="hidden sm:inline">Searching</span>
            </span>
          )}

          {query.length > 0 && !activePerson && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setDebounced('');
                setScope('all');
                setActiveIndex(-1);
                settledQueryRef.current = '';
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white transition-colors"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close search"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Selected Cast / Crew Context Header */}
        {activePerson && (
          <div className="flex items-center justify-between gap-3 border-b border-slate-200/80 dark:border-white/[0.08] bg-slate-50/80 dark:bg-white/[0.03] px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-slate-200 dark:border-white/15 bg-slate-200 dark:bg-[#171D2B]">
                {activePerson.member.photoUrl && !avatarFailed ? (
                  <img
                    src={proxiedImageUrl(activePerson.member.photoUrl)}
                    alt={activePerson.member.name}
                    referrerPolicy="no-referrer"
                    onError={() => setAvatarFailed(true)}
                    className="h-full w-full object-cover object-top"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-[#E11D48] text-xs font-semibold text-white">
                    {personInitials || <User className="h-4 w-4" />}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {activePerson.member.name}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate tabular-nums">
                  {activePerson.member.role ? `${activePerson.member.role} · ` : ''}
                  {loading
                    ? 'Searching catalog credits...'
                    : `${totalCount} other ${totalCount === 1 ? 'title' : 'titles'} in catalog`}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setActivePerson(null);
                setQuery('');
                setDebounced('');
                setScope('all');
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
            >
              Clear Filter
            </button>
          </div>
        )}

        {/* Dynamic Matching Recent Suggestions Bar when typing */}
        {matchingRecentSuggestions.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-200/80 dark:border-white/[0.06] bg-slate-50/70 dark:bg-white/[0.02] px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <History className="h-3 w-3 text-[#E11D48]" />
              <span>Recent:</span>
            </span>
            {matchingRecentSuggestions.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => applyRecentSearch(term)}
                className="shrink-0 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#151B28] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 transition-colors whitespace-nowrap"
              >
                {term}
              </button>
            ))}
          </div>
        )}

        {/* Dynamic Category Scope Tabs (Shown when results exist) */}
        {totalCount > 0 && (
          <div className="flex items-center justify-between gap-3 border-b border-slate-200/80 dark:border-white/[0.06] px-4 py-2 bg-white/70 dark:bg-[#0B0E16]">
            <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {(
                [
                  { id: 'all', label: 'All', count: totalCount },
                  { id: 'movies', label: 'Movies', count: safeResults.movies.length },
                  { id: 'series', label: 'Series', count: safeResults.series.length },
                  { id: 'live', label: 'Live TV', count: safeResults.live.length },
                ] as Array<{ id: SearchScope; label: string; count: number }>
              )
                .filter((tab) => tab.id === 'all' || tab.count > 0)
                .map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setScope(tab.id);
                      setActiveIndex(-1);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors tabular-nums ${
                      scope === tab.id
                        ? 'bg-[#E11D48] text-white shadow-sm'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.06] hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={
                        scope === tab.id ? 'text-white/85' : 'text-slate-400 dark:text-slate-500'
                      }
                    >
                      {tab.count}
                    </span>
                  </button>
                ))}
            </div>

            <span className="hidden sm:inline text-[11px] text-slate-400 dark:text-slate-500 whitespace-nowrap">
              ↑↓ navigate · ↵ open
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {isIdleMode ? (
            recentSearches.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400">
                    <History className="h-3.5 w-3.5 text-[#E11D48]" />
                    <span>Recent Searches</span>
                  </h2>
                  <button
                    type="button"
                    onClick={clearRecentSearches}
                    className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-[#E11D48] dark:hover:text-rose-400 transition-colors"
                  >
                    Clear all
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {recentSearches.map((term) => (
                    <div
                      key={term}
                      className="group flex items-center rounded-xl border border-slate-200/80 dark:border-white/[0.06] bg-slate-50/70 dark:bg-white/[0.02] hover:bg-rose-50/60 dark:hover:bg-white/[0.06] hover:border-rose-300 dark:hover:border-white/15 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => applyRecentSearch(term)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left"
                      >
                        <History className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500 group-hover:text-[#E11D48] transition-colors" />
                        <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                          {term}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRecentSearch(term)}
                        aria-label={`Remove ${term} from recent searches`}
                        className="mr-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 dark:text-slate-500 hover:bg-slate-200/70 dark:hover:bg-white/10 hover:text-slate-700 dark:hover:text-white transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                <p className="pt-1 text-center text-xs text-slate-400 dark:text-slate-500">
                  {settings.saveSearchHistory
                    ? 'Type at least 2 characters to search across Movies, Series, and Live TV.'
                    : 'Search history saving is paused in Settings. Type 2+ characters to search.'}
                </p>
              </section>
            ) : (
              <div className="py-10 text-center space-y-2">
                <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                  Search across all Movies, Series, Genres &amp; Live TV Channels
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  {settings.saveSearchHistory
                    ? 'Type 2 or more characters — your recent searches will appear here.'
                    : 'Search history saving is disabled in Settings.'}
                </p>
              </div>
            )
          ) : !activePerson && query.trim().length === 1 ? (
            <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
              Keep typing — enter at least 2 characters for live results.
            </div>
          ) : showInitialLoading ? (
            <div className="py-12 flex items-center justify-center">
              <LoadingSpinner
                label={
                  activePerson
                    ? `Finding titles featuring ${activePerson.member.name}...`
                    : `Searching catalog for "${debounced}"...`
                }
                size="md"
              />
            </div>
          ) : error ? (
            <div className="py-10 text-center text-sm text-rose-600 dark:text-rose-300">
              {error}
            </div>
          ) : displayedCount === 0 ? (
            <div className="py-10 text-center space-y-3">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {activePerson
                  ? `No other movies or series featuring ${activePerson.member.name} were found in your current catalog.`
                  : totalCount > 0
                    ? `No ${scope} matched “${debounced}”. Try switching to All.`
                    : `No titles or channels matched “${debounced}”.`}
              </p>
              {activePerson && matchedTitlesCount !== null && matchedTitlesCount > 0 && (
                <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  Checked {matchedTitlesCount} known credits against your catalog.
                </p>
              )}
              {activePerson && (
                <button
                  type="button"
                  onClick={() => {
                    const name = activePerson.member.name;
                    setActivePerson(null);
                    setQuery(name);
                    setDebounced(name);
                    recordRecentSearch(name);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 transition-colors"
                >
                  <Search className="h-3.5 w-3.5" />
                  <span>Search keyword &ldquo;{activePerson.member.name}&rdquo;</span>
                </button>
              )}
            </div>
          ) : (
            (() => {
              let runningIndex = -1;
              return (
                <>
                  {displayedMovies.length > 0 && (
                    <section className="space-y-2.5">
                      <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 tabular-nums">
                        <Film className="h-3.5 w-3.5 text-[#E11D48]" />
                        <span>Movies ({displayedMovies.length})</span>
                      </h2>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {displayedMovies.map((m) => {
                          runningIndex += 1;
                          const itemIdx = runningIndex;
                          const isFocused = activeIndex === itemIdx;
                          return (
                            <button
                              key={m.streamId}
                              ref={(el) => {
                                resultButtonRefs.current[itemIdx] = el;
                              }}
                              type="button"
                              onClick={() => {
                                commitAndNavigate({
                                  kind: 'movie',
                                  id: m.streamId,
                                  autoplay: true,
                                  initialMovie: {
                                    title: m.cleanTitle,
                                    subtitle: m.categoryName,
                                    poster: m.poster,
                                    playUrl: `/api/play/vod/${m.streamId}.${m.extension || 'mp4'}`,
                                    extension: m.extension,
                                  },
                                });
                              }}
                              className={`flex min-h-[56px] items-center gap-3 rounded-xl border p-2 text-left transition-colors ${
                                isFocused
                                  ? 'border-[#E11D48] bg-rose-50/80 dark:bg-white/10'
                                  : 'border-slate-200/80 dark:border-white/[0.06] bg-slate-50/70 dark:bg-white/[0.02] hover:bg-rose-50/60 dark:hover:bg-white/[0.06] hover:border-rose-300 dark:hover:border-white/15'
                              }`}
                            >
                              <MediaImage
                                src={m.poster}
                                alt={m.cleanTitle}
                                title={m.cleanTitle}
                                year={m.year}
                                variant="poster"
                                className="h-14 w-10 shrink-0 rounded"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                                  <HighlightMatch text={m.cleanTitle} query={debounced} />
                                </p>
                                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                  {m.year ? `${m.year} · ` : ''}
                                  <HighlightMatch text={m.categoryName} query={debounced} />
                                </p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {displayedSeries.length > 0 && (
                    <section className="space-y-2.5">
                      <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 tabular-nums">
                        <Clapperboard className="h-3.5 w-3.5 text-indigo-500" />
                        <span>Series ({displayedSeries.length})</span>
                      </h2>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {displayedSeries.map((s) => {
                          runningIndex += 1;
                          const itemIdx = runningIndex;
                          const isFocused = activeIndex === itemIdx;
                          return (
                            <button
                              key={s.seriesId}
                              ref={(el) => {
                                resultButtonRefs.current[itemIdx] = el;
                              }}
                              type="button"
                              onClick={() => {
                                commitAndNavigate({ kind: 'series', id: s.seriesId });
                              }}
                              className={`flex min-h-[56px] items-center gap-3 rounded-xl border p-2 text-left transition-colors ${
                                isFocused
                                  ? 'border-indigo-500 bg-indigo-50/80 dark:bg-white/10'
                                  : 'border-slate-200/80 dark:border-white/[0.06] bg-slate-50/70 dark:bg-white/[0.02] hover:bg-indigo-50/60 dark:hover:bg-white/[0.06] hover:border-indigo-300 dark:hover:border-white/15'
                              }`}
                            >
                              <MediaImage
                                src={s.poster}
                                alt={s.cleanTitle}
                                title={s.cleanTitle}
                                year={s.year}
                                variant="poster"
                                className="h-14 w-10 shrink-0 rounded"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                                  <HighlightMatch text={s.cleanTitle} query={debounced} />
                                </p>
                                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                  {s.year ? `${s.year} · ` : ''}
                                  <HighlightMatch
                                    text={s.genre || s.categoryName}
                                    query={debounced}
                                  />
                                </p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {displayedLive.length > 0 && (
                    <section className="space-y-2.5">
                      <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 tabular-nums">
                        <Radio className="h-3.5 w-3.5 text-sky-500" />
                        <span>Live TV ({displayedLive.length})</span>
                      </h2>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {displayedLive.map((ch) => {
                          runningIndex += 1;
                          const itemIdx = runningIndex;
                          const isFocused = activeIndex === itemIdx;
                          return (
                            <button
                              key={ch.streamId}
                              ref={(el) => {
                                resultButtonRefs.current[itemIdx] = el;
                              }}
                              type="button"
                              onClick={() => {
                                commitAndNavigate({
                                  kind: 'live',
                                  id: ch.streamId,
                                  channel: ch,
                                });
                              }}
                              className={`flex min-h-[56px] items-center gap-3 rounded-xl border p-2 text-left transition-colors ${
                                isFocused
                                  ? 'border-sky-500 bg-sky-50/80 dark:bg-white/10'
                                  : 'border-slate-200/80 dark:border-white/[0.06] bg-slate-50/70 dark:bg-white/[0.02] hover:bg-sky-50/60 dark:hover:bg-white/[0.06] hover:border-sky-300 dark:hover:border-white/15'
                              }`}
                            >
                              <MediaImage
                                src={ch.logo}
                                alt={ch.name}
                                category={ch.categoryName}
                                variant="logo"
                                imgClassName="h-full w-full object-contain p-1.5"
                                className="h-11 w-14 shrink-0 rounded bg-slate-100 dark:bg-[#090B10]"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                                  <HighlightMatch text={ch.name} query={debounced} />
                                </p>
                                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                                  <HighlightMatch
                                    text={
                                      ch.nowPlaying?.title
                                        ? `${ch.categoryName} · ${ch.nowPlaying.title}`
                                        : ch.categoryName
                                    }
                                    query={debounced}
                                  />
                                </p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}
                </>
              );
            })()
          )}
        </div>
      </div>
    </div>
  );
}
