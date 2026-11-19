import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellRing,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Play,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { fetchComingSoon } from '../services/api';
import type { ComingSoonItem, DetailTarget } from '../types/media';
import { MediaImage } from './MediaImage';

interface ComingSoonSectionProps {
  onOpenDetail: (target: DetailTarget) => void;
  onOpenSearch: () => void;
}

type ReleaseFilter = 'all' | 'movie' | 'series';

const REMINDERS_STORAGE_KEY = 'cinebox_coming_soon_reminders_v1';

const SLIDER_TRACK_CLASS =
  'flex gap-2.5 sm:gap-4 overflow-x-auto scroll-smooth snap-x snap-mandatory pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';
const SLIDER_CARD_CLASS =
  'w-[calc((100%-1.25rem)/3)] sm:w-[180px] md:w-[196px] lg:w-[210px] shrink-0 snap-start';

function loadSavedReminders(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(REMINDERS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function formatCountdown(
  daysUntil?: number | null,
  releaseDate?: string,
  releaseLabel?: string,
): string {
  if (typeof daysUntil === 'number' && Number.isFinite(daysUntil)) {
    if (daysUntil <= 0) return 'Releases Today';
    if (daysUntil === 1) return 'In 1 day';
    if (daysUntil <= 45) return `In ${daysUntil} days`;
  }
  if (releaseLabel) return releaseLabel;
  if (releaseDate) {
    const ts = Date.parse(releaseDate);
    if (Number.isFinite(ts)) {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
      }).format(new Date(ts));
    }
  }
  return 'Coming Soon';
}

function formatFullReleaseDate(releaseDate?: string, releaseLabel?: string): string {
  if (!releaseDate) return releaseLabel || 'Release date TBA';
  const ts = Date.parse(releaseDate);
  if (!Number.isFinite(ts)) return releaseLabel || releaseDate;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(ts));
}

export function ComingSoonSection({
  onOpenDetail,
  onOpenSearch,
}: ComingSoonSectionProps) {
  const [items, setItems] = useState<ComingSoonItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<ReleaseFilter>('all');
  const [selectedItem, setSelectedItem] = useState<ComingSoonItem | null>(null);
  const [reminders, setReminders] = useState<Set<string>>(loadSavedReminders);

  const trackRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    fetchComingSoon(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setItems(Array.isArray(res.items) ? res.items : []);
        setLoading(false);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setFailed(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedItem) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedItem(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedItem]);

  const filteredItems = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter((item) => item.kind === filter);
  }, [items, filter]);

  const updateScrollState = useCallback(() => {
    const el = trackRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 8);
    setCanScrollRight(maxScroll - el.scrollLeft > 8);
  }, []);

  useEffect(() => {
    const id = window.requestAnimationFrame(updateScrollState);
    window.addEventListener('resize', updateScrollState);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [filter, filteredItems.length, updateScrollState]);

  const scrollBy = useCallback((direction: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    const step = Math.max(240, Math.round(el.clientWidth * 0.8));
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  }, []);

  const toggleReminder = useCallback((id: string) => {
    setReminders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      try {
        window.localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Ignore storage quota issues
      }
      return next;
    });
  }, []);

  if (!loading && (failed || items.length === 0)) {
    return null;
  }

  return (
    <section aria-label="Coming Soon">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#E11D48]/12 text-[#E11D48] dark:text-rose-400">
            <CalendarClock className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white leading-tight">
              Coming Soon
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Upcoming movie releases &amp; series premieres
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'movie', label: 'Movies' },
                { id: 'series', label: 'Series' },
              ] as Array<{ id: ReleaseFilter; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`min-h-8 px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  filter === tab.id
                    ? 'bg-[#E11D48] text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {(canScrollLeft || canScrollRight) && (
            <div className="hidden sm:flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => scrollBy(-1)}
                disabled={!canScrollLeft}
                aria-label="Scroll Coming Soon left"
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => scrollBy(1)}
                disabled={!canScrollRight}
                aria-label="Scroll Coming Soon right"
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-200 shadow-sm shadow-slate-900/5 dark:shadow-none transition-colors hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 disabled:opacity-35 disabled:hover:border-slate-200 dark:disabled:hover:border-white/[0.08]"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className={SLIDER_TRACK_CLASS} aria-busy="true" aria-label="Loading upcoming releases">
          {Array.from({ length: 7 }).map((_, idx) => (
            <div
              key={idx}
              className={`${SLIDER_CARD_CLASS} overflow-hidden rounded-lg sm:rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#111520]`}
            >
              <div className="aspect-[2/3] w-full animate-pulse bg-slate-200 dark:bg-white/[0.06]" />
              <div className="space-y-2 p-2.5 sm:p-3">
                <div className="h-3.5 w-4/5 animate-pulse rounded bg-slate-200 dark:bg-white/[0.08]" />
                <div className="h-2.5 w-3/5 animate-pulse rounded bg-slate-200/80 dark:bg-white/[0.06]" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-white/70 dark:bg-[#111520]/80 px-4 py-6 text-center text-xs text-slate-600 dark:text-slate-400">
          No upcoming {filter === 'movie' ? 'movies' : 'series'} scheduled right now.
        </div>
      ) : (
        <div className="relative">
          <div
            ref={trackRef}
            onScroll={updateScrollState}
            className={SLIDER_TRACK_CLASS}
          >
            {filteredItems.map((item) => {
              const isReminded = reminders.has(item.id);
              const countdown = formatCountdown(
                item.daysUntil,
                item.releaseDate,
                item.releaseLabel,
              );
              const shortDate = formatFullReleaseDate(item.releaseDate, item.releaseLabel);
              const inlineMeta = [
                item.kind === 'series' ? 'Series' : 'Movie',
                item.genre || '',
              ]
                .filter(Boolean)
                .join(' · ');

              return (
                <article
                  key={item.id}
                  className={`${SLIDER_CARD_CLASS} cinebox-card-elevated group relative flex flex-col overflow-hidden rounded-lg sm:rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] shadow-sm shadow-slate-900/5 dark:shadow-none`}
                >
                  <div className="relative aspect-[2/3] w-full overflow-hidden bg-slate-100 dark:bg-[#0B0E17]">
                    <button
                      type="button"
                      onClick={() => setSelectedItem(item)}
                      className="block h-full w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                      aria-label={`View upcoming release details for ${item.title}`}
                    >
                      <MediaImage
                        src={item.poster}
                        alt={item.title}
                        title={item.title}
                        year={item.year}
                        category={item.genre}
                        variant="poster"
                        className="h-full w-full"
                        imgClassName="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                      />
                    </button>

                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />

                    <span className="pointer-events-none absolute bottom-2 left-2.5 right-10 text-[11px] font-bold tracking-tight text-white drop-shadow">
                      {countdown}
                    </span>

                    <button
                      type="button"
                      onClick={() => toggleReminder(item.id)}
                      aria-pressed={isReminded}
                      aria-label={
                        isReminded
                          ? `Remove reminder for ${item.title}`
                          : `Remind me when ${item.title} releases`
                      }
                      title={isReminded ? 'Reminder saved' : 'Remind me'}
                      className={`absolute right-1.5 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-lg border backdrop-blur-sm transition-colors ${
                        isReminded
                          ? 'border-rose-400/60 bg-[#E11D48] text-white'
                          : 'border-white/15 bg-black/55 text-white/90 hover:bg-black/75'
                      }`}
                    >
                      {isReminded ? (
                        <BellRing className="h-4 w-4" />
                      ) : (
                        <Bell className="h-4 w-4" />
                      )}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setSelectedItem(item)}
                    className="flex flex-1 flex-col justify-between p-2.5 sm:p-3 text-left transition-colors hover:bg-slate-50/70 dark:hover:bg-white/[0.02]"
                  >
                    <div>
                      <h3 className="line-clamp-1 font-display text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
                        {item.title}
                      </h3>
                      <p className="mt-1 line-clamp-1 text-[11px] font-medium text-[#E11D48] dark:text-rose-400">
                        {shortDate}
                      </p>
                    </div>
                    {inlineMeta && (
                      <p className="mt-1 line-clamp-1 text-[11px] text-slate-500 dark:text-slate-400">
                        {inlineMeta}
                      </p>
                    )}
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {/* Coming Soon Preview Modal */}
      {selectedItem && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="coming-soon-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => setSelectedItem(null)}
        >
          <div
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-900 dark:text-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative h-44 sm:h-52 w-full overflow-hidden bg-slate-900">
              <MediaImage
                src={selectedItem.backdrop || selectedItem.poster}
                alt={selectedItem.title}
                title={selectedItem.title}
                year={selectedItem.year}
                variant="backdrop"
                className="h-full w-full"
                imgClassName="h-full w-full object-cover opacity-55"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-white via-white/30 to-black/35 dark:from-[#111520] dark:via-[#111520]/45 dark:to-black/40" />

              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                aria-label="Close release preview"
                className="absolute right-3 top-3 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/20 bg-black/60 text-white hover:bg-black/80 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative -mt-16 px-5 pb-6 sm:px-6">
              <div className="flex flex-col sm:flex-row gap-4 sm:items-end">
                <div className="h-32 w-22 sm:h-36 sm:w-24 shrink-0 overflow-hidden rounded-xl border border-slate-200 dark:border-white/15 bg-slate-100 dark:bg-[#0B0E17] shadow-lg">
                  <MediaImage
                    src={selectedItem.poster}
                    alt={selectedItem.title}
                    title={selectedItem.title}
                    year={selectedItem.year}
                    variant="poster"
                    className="h-full w-full"
                  />
                </div>

                <div className="min-w-0 flex-1 pt-1">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[#E11D48] dark:text-rose-400">
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>
                      {formatCountdown(
                        selectedItem.daysUntil,
                        selectedItem.releaseDate,
                        selectedItem.releaseLabel,
                      )}
                    </span>
                  </p>
                  <h3
                    id="coming-soon-modal-title"
                    className="mt-1 font-display text-xl sm:text-2xl font-bold leading-snug text-slate-900 dark:text-white"
                  >
                    {selectedItem.title}
                  </h3>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                    {[
                      selectedItem.kind === 'series' ? 'TV Series' : 'Feature Film',
                      formatFullReleaseDate(selectedItem.releaseDate, selectedItem.releaseLabel),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </div>

              {selectedItem.genre && (
                <p className="mt-4 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Genres:{' '}
                  <span className="text-slate-800 dark:text-slate-200">{selectedItem.genre}</span>
                </p>
              )}

              {selectedItem.overview && (
                <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300 line-clamp-4">
                  {selectedItem.overview}
                </p>
              )}

              {selectedItem.stars && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Starring:{' '}
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {selectedItem.stars}
                  </span>
                </p>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-2.5">
                {selectedItem.matchedCatalogId && selectedItem.matchedCatalogKind ? (
                  <button
                    type="button"
                    onClick={() => {
                      const targetKind = selectedItem.matchedCatalogKind!;
                      const targetId = selectedItem.matchedCatalogId!;
                      setSelectedItem(null);
                      onOpenDetail({ kind: targetKind, id: targetId });
                    }}
                    className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#E11D48] px-4 text-sm font-semibold text-white shadow-md shadow-rose-600/20 hover:bg-rose-500 transition-colors"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    <span>Open in Catalog</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedItem(null);
                      onOpenSearch();
                    }}
                    className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#E11D48] px-4 text-sm font-semibold text-white shadow-md shadow-rose-600/20 hover:bg-rose-500 transition-colors"
                  >
                    <Search className="h-4 w-4" />
                    <span>Search Catalog</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => toggleReminder(selectedItem.id)}
                  aria-pressed={reminders.has(selectedItem.id)}
                  className={`inline-flex h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition-colors ${
                    reminders.has(selectedItem.id)
                      ? 'border-[#E11D48]/40 bg-rose-50 text-[#E11D48] dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-300'
                      : 'border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-white/[0.04] text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-white/25'
                  }`}
                >
                  {reminders.has(selectedItem.id) ? (
                    <>
                      <BellRing className="h-4 w-4" />
                      <span>Reminder Saved</span>
                    </>
                  ) : (
                    <>
                      <Bell className="h-4 w-4" />
                      <span>Remind Me</span>
                    </>
                  )}
                </button>

                {selectedItem.imdbId && (
                  <a
                    href={`https://www.imdb.com/title/${encodeURIComponent(selectedItem.imdbId)}/`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 px-3.5 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/[0.05] transition-colors"
                  >
                    <span>IMDb</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
