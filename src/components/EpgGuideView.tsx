import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellRing,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  Columns3,
  LayoutGrid,
  Play,
  Radio,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { fetchEpgGuide, fetchLiveCategories } from '../services/api';
import type {
  CategoryItem,
  DetailTarget,
  EpgGuideResponse,
  EpgProgram,
  LiveChannelSummary,
  ProgramReminder,
  ReminderLeadMinutes,
} from '../types/media';
import { formatNumber } from '../utils/format';
import {
  loadViewFilters,
  saveViewFilters,
  type EpgFilterSnapshot,
} from '../utils/navPersistence';
import { formatLocalTimeFromUnix } from '../utils/notifications';
import {
  isRestrictedCategory,
  isRestrictedContent,
  useAppSettings,
} from '../utils/settings';
import { buildReminderId } from '../utils/storage';
import { MediaImage } from './MediaImage';
import { LoadingSpinner } from './LoadingSpinner';

interface EpgGuideViewProps {
  reminders: ProgramReminder[];
  onToggleReminder: (
    channel: LiveChannelSummary,
    program: EpgProgram,
    leadMinutes?: ReminderLeadMinutes,
  ) => void;
  onUpdateReminderLeadTime: (id: string, leadMinutes: ReminderLeadMinutes) => void;
  onOpenReminders: () => void;
  onOpenDetail: (target: DetailTarget) => void;
}

type GuideViewMode = 'timeline' | 'cards';
type TimelineDensity = 'cozy' | 'compact';

const PX_PER_MIN: Record<TimelineDensity, number> = {
  cozy: 4.2, // 252 px / hour, 126 px / 30 min
  compact: 2.8, // 168 px / hour, 84 px / 30 min
};

const WINDOW_HOURS = 24;

function formatUtcTime(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatUtcDateShort(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function formatDurationMinutes(startSec: number, stopSec: number): string {
  const mins = Math.max(1, Math.round((stopSec - startSec) / 60));
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

const DEFAULT_EPG_FILTERS: EpgFilterSnapshot = {
  categoryId: '',
  query: '',
  catchupOnly: false,
  offsetHours: 0,
  viewMode: 'timeline',
  density: 'cozy',
  page: 1,
};

export function EpgGuideView({
  reminders,
  onToggleReminder,
  onUpdateReminderLeadTime,
  onOpenReminders,
  onOpenDetail,
}: EpgGuideViewProps) {
  const initialFiltersRef = useRef<EpgFilterSnapshot | null>(null);
  if (!initialFiltersRef.current) {
    initialFiltersRef.current = loadViewFilters<EpgFilterSnapshot>('epg', DEFAULT_EPG_FILTERS);
  }
  const initialFilters = initialFiltersRef.current;

  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoryId, setCategoryId] = useState(initialFilters.categoryId);
  const [queryInput, setQueryInput] = useState(initialFilters.query);
  const [debouncedQuery, setDebouncedQuery] = useState(initialFilters.query);
  const [catchupOnly, setCatchupOnly] = useState(initialFilters.catchupOnly);
  const [offsetHours, setOffsetHours] = useState(initialFilters.offsetHours);
  const [page, setPage] = useState(initialFilters.page);

  const [viewMode, setViewMode] = useState<GuideViewMode>(initialFilters.viewMode);
  const [density, setDensity] = useState<TimelineDensity>(initialFilters.density);
  const [selectedSlot, setSelectedSlot] = useState<{
    channel: LiveChannelSummary;
    program: EpgProgram;
  } | null>(null);
  const [leadMinutes, setLeadMinutes] = useState<ReminderLeadMinutes>(5);

  const [guide, setGuide] = useState<EpgGuideResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { settings, parentalUnlocked } = useAppSettings();

  const timelineScrollRef = useRef<HTMLDivElement>(null);

  const reminderById = useMemo(() => {
    const map = new Map<string, ProgramReminder>();
    for (const rem of reminders) {
      map.set(rem.id, rem);
    }
    return map;
  }, [reminders]);

  useEffect(() => {
    saveViewFilters<EpgFilterSnapshot>('epg', {
      categoryId,
      query: debouncedQuery,
      catchupOnly,
      offsetHours,
      viewMode,
      density,
      page,
    });
  }, [categoryId, debouncedQuery, catchupOnly, offsetHours, viewMode, density, page]);

  useEffect(() => {
    const trimmed = queryInput.trim();
    if (trimmed === debouncedQuery.trim()) return;
    const timer = window.setTimeout(() => {
      setDebouncedQuery(trimmed);
      setPage(1);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [queryInput, debouncedQuery]);

  useEffect(() => {
    const controller = new AbortController();
    fetchLiveCategories(controller.signal)
      .then((res) => setCategories(res.categories))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSelectedSlot(null);

    fetchEpgGuide(
      {
        categoryId,
        q: debouncedQuery,
        catchupOnly,
        offsetHours,
        windowHours: WINDOW_HOURS,
        page,
        limit: 16,
      },
      controller.signal,
    )
      .then((res) => {
        setGuide(res);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setError(err.message || 'Unable to load EPG guide');
        setLoading(false);
      });

    return () => controller.abort();
  }, [categoryId, debouncedQuery, catchupOnly, offsetHours, page]);

  useEffect(() => {
    if (!selectedSlot) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedSlot(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedSlot]);

  const visibleCategories = useMemo(
    () =>
      categories.filter(
        (c) => !isRestrictedCategory(c.categoryName, settings, parentalUnlocked),
      ),
    [categories, settings, parentalUnlocked],
  );

  const channels = useMemo(
    () =>
      (guide?.channels || []).filter(
        (entry) =>
          !isRestrictedContent(
            { title: entry.channel.name, categoryName: entry.channel.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
    [guide?.channels, settings, parentalUnlocked],
  );
  const totalPages = guide?.totalPages || 1;
  const serverNow = guide?.serverTimestamp || Math.floor(Date.now() / 1000);
  const windowStart = guide?.windowStart || Math.floor(serverNow / 1800) * 1800 - 3600;
  const windowEnd = guide?.windowEnd || windowStart + WINDOW_HOURS * 3600;

  const pxPerMin = PX_PER_MIN[density];
  const totalDurationMin = Math.max(60, (windowEnd - windowStart) / 60);
  const totalWidthPx = Math.round(totalDurationMin * pxPerMin);

  const nowInWindow = serverNow >= windowStart && serverNow <= windowEnd;
  const nowOffsetPx = nowInWindow
    ? Math.round(((serverNow - windowStart) / 60) * pxPerMin)
    : null;

  // Build 30-minute timeline tick markers across [windowStart, windowEnd)
  const timeTicks = useMemo(() => {
    const ticks: Array<{
      ts: number;
      leftPx: number;
      widthPx: number;
      label: string;
      dateBadge: string | null;
      isHour: boolean;
    }> = [];
    const firstTick = Math.ceil(windowStart / 1800) * 1800;
    for (let ts = firstTick; ts < windowEnd; ts += 1800) {
      const leftPx = Math.round(((ts - windowStart) / 60) * pxPerMin);
      const nextTs = Math.min(windowEnd, ts + 1800);
      const widthPx = Math.round(((nextTs - ts) / 60) * pxPerMin);
      const d = new Date(ts * 1000);
      const mins = d.getUTCMinutes();
      const hrs = d.getUTCHours();
      const isMidnight = hrs === 0 && mins === 0;
      const isFirst = ts === firstTick;
      ticks.push({
        ts,
        leftPx,
        widthPx,
        label: formatUtcTime(ts),
        dateBadge: isFirst || isMidnight ? formatUtcDateShort(ts) : null,
        isHour: mins === 0,
      });
    }
    return ticks;
  }, [windowStart, windowEnd, pxPerMin]);

  const scrollToNow = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const container = timelineScrollRef.current;
      if (!container) return;
      if (nowOffsetPx !== null) {
        container.scrollTo({
          left: Math.max(0, nowOffsetPx - 110),
          behavior,
        });
      } else {
        container.scrollTo({ left: 0, behavior });
      }
    },
    [nowOffsetPx],
  );

  // Auto-align horizontal timeline to the live "Now" marker when guide loads or density changes
  useEffect(() => {
    if (loading || viewMode !== 'timeline' || channels.length === 0) return;
    const raf = window.requestAnimationFrame(() => {
      scrollToNow('auto');
    });
    return () => window.cancelAnimationFrame(raf);
  }, [loading, viewMode, channels.length, guide?.windowStart, pxPerMin, scrollToNow]);

  const scrollTimelineBy = (deltaPx: number) => {
    const container = timelineScrollRef.current;
    if (!container) return;
    container.scrollBy({ left: deltaPx, behavior: 'smooth' });
  };

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-16">
      {/* Header */}
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 border-b border-slate-200/80 dark:border-white/[0.08] pb-5 sm:pb-6">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-2.5">
            <CalendarClock className="h-6 w-6 text-[#E11D48]" />
            <span>TV Program Guide</span>
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 tabular-nums">
            {guide
              ? `${formatNumber(guide.totalMatchingChannels)} channels · ${WINDOW_HOURS}h day schedule (${formatUtcDateShort(windowStart)} ${formatUtcTime(windowStart)} – ${formatUtcDateShort(windowEnd)} ${formatUtcTime(windowEnd)} UTC)`
              : 'Loading program schedules...'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Timeline vs Card View Toggle */}
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none">
            <button
              type="button"
              onClick={() => setViewMode('timeline')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                viewMode === 'timeline'
                  ? 'bg-[#E11D48] text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
              }`}
            >
              <Columns3 className="h-3.5 w-3.5" />
              <span>Timeline</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('cards')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                viewMode === 'cards'
                  ? 'bg-[#E11D48] text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span>Cards</span>
            </button>
          </div>

          {/* Window Day-Shift Controls */}
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none">
            <button
              type="button"
              onClick={() => setOffsetHours((h) => Math.max(-24, h - 6))}
              disabled={offsetHours <= -24}
              className="px-2.5 sm:px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white rounded-lg disabled:opacity-40"
            >
              -6h
            </button>
            <button
              type="button"
              onClick={() => {
                if (offsetHours === 0 && viewMode === 'timeline') {
                  scrollToNow('smooth');
                } else {
                  setOffsetHours(0);
                }
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                offsetHours === 0
                  ? 'bg-[#E11D48] text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
              }`}
            >
              Live Now
            </button>
            <button
              type="button"
              onClick={() => setOffsetHours((h) => Math.min(24, h + 6))}
              disabled={offsetHours >= 24}
              className="px-2.5 sm:px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white rounded-lg disabled:opacity-40"
            >
              +6h
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setCatchupOnly((v) => !v);
              setPage(1);
            }}
            className={`min-h-[38px] rounded-xl border px-3.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              catchupOnly
                ? 'border-[#E11D48] bg-[#E11D48] text-white shadow-sm'
                : 'border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            Catch-up Enabled Only
          </button>

          <button
            type="button"
            onClick={onOpenReminders}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border px-3.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              reminders.length > 0
                ? 'border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/15 text-[#E11D48] dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-500/25'
                : 'border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            {reminders.length > 0 ? (
              <BellRing className="h-3.5 w-3.5" />
            ) : (
              <Bell className="h-3.5 w-3.5" />
            )}
            <span>Reminders ({reminders.length})</span>
          </button>
        </div>
      </div>

      {/* Category & Channel Filters */}
      <div className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-5">
          <select
            aria-label="Filter TV guide by category"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
            className="h-11 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] px-3.5 text-sm text-slate-900 dark:text-white shadow-sm shadow-slate-900/5 dark:shadow-none focus:border-[#E11D48] focus:outline-none"
          >
            <option value="">All Networks &amp; Countries</option>
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
            placeholder="Filter channels by name..."
            className="h-11 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] pl-10 pr-4 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 shadow-sm shadow-slate-900/5 dark:shadow-none focus:border-[#E11D48] focus:outline-none"
          />
        </div>
      </div>

      {/* Content */}
      <div className="mt-6">
        {loading ? (
          <div className="rounded-2xl border border-slate-200/80 dark:border-white/[0.06] bg-white/80 dark:bg-[#111520]/40 p-12 text-center min-h-[400px] flex items-center justify-center shadow-sm">
            <LoadingSpinner
              label={
                debouncedQuery
                  ? `Searching TV schedule for "${debouncedQuery}"...`
                  : 'Loading channel program schedules...'
              }
              size="lg"
            />
          </div>
        ) : error ? (
          <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] p-10 text-center">
            <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
              EPG Guide Unavailable
            </p>
            <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{error}</p>
          </div>
        ) : channels.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-12 text-center">
            <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
              No Channels Matched
            </p>
            <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
              Try adjusting your network category or search filter.
            </p>
          </div>
        ) : viewMode === 'timeline' ? (
          <div className="space-y-3">
            {/* Timeline Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] px-3.5 py-2.5 shadow-sm shadow-slate-900/5 dark:shadow-none">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900 dark:text-white">
                  <Clock className="h-3.5 w-3.5 text-[#E11D48]" />
                  <span>Horizontal Day Timeline</span>
                </span>
                <span className="hidden sm:inline text-slate-400">·</span>
                <span className="hidden sm:inline text-slate-500 dark:text-slate-400">
                  Scroll horizontally or click any program block for details
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Density Switcher */}
                <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#0B0E16] p-0.5">
                  <button
                    type="button"
                    onClick={() => setDensity('cozy')}
                    className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                      density === 'cozy'
                        ? 'bg-white dark:bg-[#1A2132] text-slate-900 dark:text-white shadow-sm'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    Detailed
                  </button>
                  <button
                    type="button"
                    onClick={() => setDensity('compact')}
                    className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                      density === 'compact'
                        ? 'bg-white dark:bg-[#1A2132] text-slate-900 dark:text-white shadow-sm'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    Compact
                  </button>
                </div>

                {/* Horizontal Pan Buttons */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => scrollTimelineBy(-Math.round(pxPerMin * 180))}
                    aria-label="Scroll timeline earlier by 3 hours"
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#0B0E16] px-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">3h</span>
                  </button>

                  {nowInWindow && (
                    <button
                      type="button"
                      onClick={() => scrollToNow('smooth')}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#E11D48]/10 border border-[#E11D48]/30 px-2.5 text-xs font-semibold text-[#E11D48] hover:bg-[#E11D48]/20 transition-colors"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-[#E11D48]" />
                      <span>Now</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => scrollTimelineBy(Math.round(pxPerMin * 180))}
                    aria-label="Scroll timeline later by 3 hours"
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#0B0E16] px-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10"
                  >
                    <span className="hidden sm:inline">3h</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Unified Horizontal Scrollable Timeline Grid */}
            <div className="rounded-2xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] shadow-sm shadow-slate-900/5 dark:shadow-none overflow-hidden">
              <div
                ref={timelineScrollRef}
                className="overflow-x-auto overscroll-x-contain relative"
              >
                <div className="min-w-max">
                  {/* Sticky Time Ruler Header */}
                  <div className="flex border-b border-slate-200 dark:border-white/[0.08] bg-slate-50/95 dark:bg-[#0B0E16]/95">
                    {/* Top-Left Sticky Corner */}
                    <div className="sticky left-0 z-30 w-[148px] sm:w-[216px] md:w-[248px] shrink-0 border-r border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-[#0B0E16] px-3 sm:px-4 py-2.5 flex items-center justify-between shadow-[4px_0_12px_-4px_rgba(15,23,42,0.08)] dark:shadow-[4px_0_14px_-4px_rgba(0,0,0,0.6)]">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        Channels
                      </span>
                      <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
                        UTC
                      </span>
                    </div>

                    {/* Time Ruler Track */}
                    <div
                      className="relative h-11 shrink-0 select-none"
                      style={{ width: `${totalWidthPx}px` }}
                    >
                      {timeTicks.map((tick) => (
                        <div
                          key={tick.ts}
                          style={{ left: `${tick.leftPx}px`, width: `${tick.widthPx}px` }}
                          className={`absolute inset-y-0 border-l px-2 flex flex-col justify-center ${
                            tick.isHour
                              ? 'border-slate-300/80 dark:border-white/[0.12]'
                              : 'border-slate-200/70 dark:border-white/[0.05]'
                          }`}
                        >
                          {tick.dateBadge && (
                            <span className="text-[9px] font-bold uppercase tracking-wider text-[#E11D48] leading-none mb-0.5">
                              {tick.dateBadge}
                            </span>
                          )}
                          <span
                            className={`font-mono text-[11px] tabular-nums leading-none ${
                              tick.isHour
                                ? 'font-semibold text-slate-800 dark:text-slate-200'
                                : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {tick.label}
                          </span>
                        </div>
                      ))}

                      {/* Live NOW Pill Marker on Ruler */}
                      {nowOffsetPx !== null && (
                        <div
                          style={{ left: `${nowOffsetPx}px` }}
                          className="pointer-events-none absolute top-0 bottom-0 z-20 -translate-x-1/2 flex flex-col items-center"
                        >
                          <span className="mt-1 rounded-full bg-[#E11D48] px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-white shadow-md">
                            Now
                          </span>
                          <div className="w-[2px] flex-1 bg-[#E11D48]" />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Channel Schedule Rows */}
                  <div className="divide-y divide-slate-200/80 dark:divide-white/[0.06]">
                    {channels.map(({ channel, programs }) => (
                      <div key={channel.streamId} className="flex group/row">
                        {/* Sticky Left Channel Cell */}
                        <div className="sticky left-0 z-20 w-[148px] sm:w-[216px] md:w-[248px] shrink-0 h-[82px] border-r border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] group-hover/row:bg-slate-50/95 dark:group-hover/row:bg-[#151B29] transition-colors px-2.5 sm:px-3.5 flex items-center justify-between gap-2 shadow-[4px_0_12px_-4px_rgba(15,23,42,0.08)] dark:shadow-[4px_0_14px_-4px_rgba(0,0,0,0.6)]">
                          <button
                            type="button"
                            onClick={() =>
                              onOpenDetail({ kind: 'live', id: channel.streamId, channel })
                            }
                            className="flex min-w-0 flex-1 items-center gap-2.5 text-left group/ch"
                          >
                            <MediaImage
                              src={channel.logo}
                              alt={channel.name}
                              title={channel.name}
                              category={channel.categoryName}
                              variant="logo"
                              imgClassName="h-full w-full object-contain p-1"
                              className="h-10 w-12 sm:h-11 sm:w-14 shrink-0 rounded-lg border border-slate-200/80 dark:border-white/10 bg-slate-100 dark:bg-[#090B10]"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs sm:text-sm font-semibold text-slate-900 dark:text-white group-hover/ch:text-[#E11D48] transition-colors">
                                {channel.name}
                              </p>
                              <p className="mt-0.5 truncate text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400">
                                {channel.categoryName}
                              </p>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              onOpenDetail({ kind: 'live', id: channel.streamId, channel })
                            }
                            aria-label={`Watch ${channel.name} live`}
                            title="Watch Live"
                            className="hidden sm:inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#E11D48]/10 text-[#E11D48] hover:bg-[#E11D48] hover:text-white transition-colors"
                          >
                            <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
                          </button>
                        </div>

                        {/* Horizontal Timeline Track */}
                        <div
                          className="relative h-[82px] shrink-0 bg-slate-50/40 dark:bg-[#0B0E16]/50"
                          style={{ width: `${totalWidthPx}px` }}
                        >
                          {/* Background Vertical Grid Lines */}
                          {timeTicks.map((tick) => (
                            <div
                              key={tick.ts}
                              style={{ left: `${tick.leftPx}px` }}
                              className={`pointer-events-none absolute inset-y-0 border-l ${
                                tick.isHour
                                  ? 'border-slate-200/90 dark:border-white/[0.08]'
                                  : 'border-slate-200/45 dark:border-white/[0.03]'
                              }`}
                            />
                          ))}

                          {/* Vertical NOW Needle */}
                          {nowOffsetPx !== null && (
                            <div
                              style={{ left: `${nowOffsetPx}px` }}
                              className="pointer-events-none absolute inset-y-0 z-10 w-[2px] -translate-x-1/2 bg-[#E11D48]/85 shadow-[0_0_8px_rgba(225,29,72,0.5)]"
                            />
                          )}

                          {/* Program Slots */}
                          {programs.length === 0 ? (
                            <div className="flex h-full items-center px-5">
                              <span className="text-xs text-slate-400 dark:text-slate-500 italic">
                                No program schedule published for this 24-hour window.
                              </span>
                            </div>
                          ) : (
                            programs.map((prog) => {
                              const clampedStart = Math.max(windowStart, prog.startTimestamp);
                              const clampedEnd = Math.min(windowEnd, prog.stopTimestamp);
                              if (clampedEnd <= clampedStart) return null;

                              const leftPx = ((clampedStart - windowStart) / 60) * pxPerMin;
                              const rawWidthPx = ((clampedEnd - clampedStart) / 60) * pxPerMin;
                              const widthPx = Math.max(26, rawWidthPx - 3);

                              const isCurrent =
                                prog.isNowPlaying ||
                                (prog.startTimestamp <= serverNow &&
                                  prog.stopTimestamp > serverNow);
                               const isPast = prog.stopTimestamp <= serverNow;
                               const isUpcoming = prog.startTimestamp > serverNow;
                               const reminderId = buildReminderId(
                                 channel.streamId,
                                 prog.startTimestamp,
                                 prog.id || prog.title,
                               );
                               const hasReminder = reminderById.has(reminderId);
                               const canReplay =
                                 (prog.hasArchive || channel.hasArchive) &&
                                 prog.startTimestamp < serverNow;

                               const progressPct = isCurrent
                                 ? Math.max(
                                     2,
                                     Math.min(
                                       100,
                                       Math.round(
                                         ((serverNow - prog.startTimestamp) /
                                           Math.max(1, prog.stopTimestamp - prog.startTimestamp)) *
                                           100,
                                       ),
                                     ),
                                   )
                                 : 0;

                               return (
                                 <div
                                   key={prog.id}
                                   style={{
                                     left: `${leftPx + 1.5}px`,
                                     width: `${widthPx}px`,
                                   }}
                                   className="absolute top-1.5 bottom-1.5"
                                 >
                                   <button
                                     type="button"
                                     onClick={() => {
                                       const existing = reminderById.get(reminderId);
                                       if (existing) setLeadMinutes(existing.leadMinutes);
                                       setSelectedSlot({ channel, program: prog });
                                     }}
                                     title={`${prog.title} (${prog.startLabel} – ${prog.stopLabel} UTC)`}
                                     className={`relative flex h-full w-full flex-col justify-between overflow-hidden rounded-lg border px-2.5 py-1.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                                       isCurrent
                                         ? 'border-[#E11D48]/60 bg-rose-50 dark:bg-[#E11D48]/15 shadow-sm'
                                         : hasReminder
                                           ? 'border-amber-400/70 dark:border-amber-400/50 bg-amber-50/70 dark:bg-amber-950/25 shadow-sm'
                                           : isPast
                                             ? 'border-slate-200/80 dark:border-white/[0.06] bg-slate-100/75 dark:bg-[#0D111A]/80 opacity-80 hover:opacity-100 hover:border-slate-300 dark:hover:border-white/20'
                                             : 'border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#141927] hover:border-sky-300 dark:hover:border-sky-500/40 hover:shadow-sm'
                                     }`}
                                   >
                                     <div className="flex items-center justify-between gap-1.5 min-w-0 w-full">
                                       <span className="truncate font-mono text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
                                         {prog.startLabel}–{prog.stopLabel}
                                       </span>
                                       {isCurrent ? (
                                         <span className="shrink-0 rounded bg-[#E11D48] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                                           Live
                                         </span>
                                       ) : isUpcoming && hasReminder ? (
                                         <span
                                           title="Reminder set"
                                           className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600 dark:text-amber-300"
                                         >
                                           <BellRing className="h-2.5 w-2.5" />
                                           {widthPx >= 115 && <span>Alert</span>}
                                         </span>
                                       ) : canReplay && widthPx >= 76 ? (
                                         <span
                                           role="button"
                                           tabIndex={-1}
                                           onClick={(e) => {
                                             e.stopPropagation();
                                             onOpenDetail({
                                               kind: 'live',
                                               id: channel.streamId,
                                               channel,
                                               initialCatchupProgram: prog,
                                             });
                                           }}
                                           title={`Watch replay of ${prog.title}`}
                                           className="inline-flex shrink-0 items-center gap-0.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-sky-600 dark:text-sky-400 hover:bg-sky-500 hover:text-white transition-colors"
                                         >
                                           <RotateCcw className="h-2.5 w-2.5" />
                                           {widthPx >= 115 && <span>Replay</span>}
                                         </span>
                                       ) : null}
                                     </div>

                                    <div className="min-w-0 w-full">
                                      <p
                                        className={`truncate text-xs font-semibold ${
                                          isCurrent
                                            ? 'text-slate-950 dark:text-white'
                                            : 'text-slate-800 dark:text-slate-100'
                                        }`}
                                      >
                                        {prog.title}
                                      </p>
                                      {prog.description && widthPx >= 150 && (
                                        <p className="truncate text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                                          {prog.description}
                                        </p>
                                      )}
                                    </div>

                                    {/* Elapsed Progress Strip for Currently Airing Show */}
                                    {isCurrent && (
                                      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-slate-200/80 dark:bg-white/10">
                                        <div
                                          className="h-full bg-[#E11D48]"
                                          style={{ width: `${progressPct}%` }}
                                        />
                                      </div>
                                    )}
                                  </button>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Card View Mode */
          <div className="space-y-4">
            {channels.map(({ channel, programs }) => (
              <section
                key={channel.streamId}
                className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-4 shadow-sm shadow-slate-900/5 dark:shadow-none space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      onOpenDetail({ kind: 'live', id: channel.streamId, channel })
                    }
                    className="flex min-w-0 items-center gap-3 text-left group"
                  >
                    <MediaImage
                      src={channel.logo}
                      alt={channel.name}
                      title={channel.name}
                      category={channel.categoryName}
                      variant="logo"
                      imgClassName="h-full w-full object-contain p-1.5"
                      className="h-12 w-16 shrink-0 rounded-lg border border-slate-200/70 dark:border-white/5 bg-slate-100 dark:bg-[#090B10]"
                    />
                    <div className="min-w-0">
                      <h2 className="truncate text-sm sm:text-base font-semibold text-slate-900 dark:text-white group-hover:text-[#E11D48] transition-colors">
                        {channel.name}
                      </h2>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {channel.categoryName}
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      onOpenDetail({ kind: 'live', id: channel.streamId, channel })
                    }
                    className="min-h-[38px] rounded-lg bg-[#E11D48] px-4 text-xs font-semibold text-white shadow-sm hover:bg-[#BE123C] whitespace-nowrap"
                  >
                    Watch Live
                  </button>
                </div>

                {programs.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-1">
                    {programs.slice(0, 9).map((prog) => {
                      const isCurrent =
                        prog.isNowPlaying ||
                        (prog.startTimestamp <= serverNow && prog.stopTimestamp > serverNow);
                      const isUpcoming = prog.startTimestamp > serverNow;
                      const reminderId = buildReminderId(
                        channel.streamId,
                        prog.startTimestamp,
                        prog.id || prog.title,
                      );
                      const hasReminder = reminderById.has(reminderId);
                      const canReplay =
                        (prog.hasArchive || channel.hasArchive) &&
                        prog.startTimestamp < serverNow;
                      return (
                        <div
                          key={prog.id}
                          onClick={() => {
                            const existing = reminderById.get(reminderId);
                            if (existing) setLeadMinutes(existing.leadMinutes);
                            setSelectedSlot({ channel, program: prog });
                          }}
                          className={`cursor-pointer flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors ${
                            isCurrent
                              ? 'border-[#E11D48]/50 bg-rose-50/80 dark:bg-[#E11D48]/[0.08]'
                              : hasReminder
                                ? 'border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20'
                                : 'border-slate-200/80 dark:border-white/[0.06] bg-slate-50/70 dark:bg-[#0B0E16] hover:border-sky-300 dark:hover:border-white/20'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                              {prog.startLabel} – {prog.stopLabel} UTC
                              {isCurrent && (
                                <span className="ml-2 font-sans font-semibold text-[#E11D48]">
                                  On Now
                                </span>
                              )}
                            </p>
                            <p className="mt-1 truncate text-xs font-semibold text-slate-900 dark:text-white">
                              {prog.title}
                            </p>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            {isUpcoming && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onToggleReminder(channel, prog, leadMinutes);
                                }}
                                aria-label={
                                  hasReminder
                                    ? `Cancel reminder for ${prog.title}`
                                    : `Set reminder for ${prog.title}`
                                }
                                title={hasReminder ? 'Reminder Set (Click to cancel)' : 'Remind Me'}
                                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ${
                                  hasReminder
                                    ? 'border-amber-400 bg-amber-400/20 text-amber-600 dark:text-amber-300'
                                    : 'border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25'
                                }`}
                              >
                                {hasReminder ? (
                                  <BellRing className="h-3.5 w-3.5" />
                                ) : (
                                  <Bell className="h-3.5 w-3.5" />
                                )}
                              </button>
                            )}

                            {canReplay && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenDetail({
                                    kind: 'live',
                                    id: channel.streamId,
                                    channel,
                                    initialCatchupProgram: prog,
                                  });
                                }}
                                aria-label={`Watch replay of ${prog.title}`}
                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/15"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    No program schedule listed for this time window.
                  </p>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* Program Details Inspector Modal */}
      {selectedSlot && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4"
          onClick={() => setSelectedSlot(null)}
          role="dialog"
          aria-modal="true"
          aria-label={selectedSlot.program.title}
        >
          <div
            className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] p-5 shadow-lg space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <MediaImage
                  src={selectedSlot.channel.logo}
                  alt={selectedSlot.channel.name}
                  title={selectedSlot.channel.name}
                  category={selectedSlot.channel.categoryName}
                  variant="logo"
                  imgClassName="h-full w-full object-contain p-1.5"
                  className="h-12 w-16 shrink-0 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-[#090B10]"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                    {selectedSlot.channel.name}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {selectedSlot.channel.categoryName}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedSlot(null)}
                aria-label="Close program details"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-slate-50/80 dark:bg-[#0B0E16] p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
                <span className="font-mono font-medium text-slate-600 dark:text-slate-300">
                  {selectedSlot.program.startLabel} – {selectedSlot.program.stopLabel} UTC
                </span>
                <span className="text-slate-400">·</span>
                <span className="text-slate-500 dark:text-slate-400">
                  {formatDurationMinutes(
                    selectedSlot.program.startTimestamp,
                    selectedSlot.program.stopTimestamp,
                  )}
                </span>
                {selectedSlot.program.isNowPlaying ||
                (selectedSlot.program.startTimestamp <= serverNow &&
                  selectedSlot.program.stopTimestamp > serverNow) ? (
                  <span className="rounded-md bg-[#E11D48] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                    On Now
                  </span>
                ) : selectedSlot.program.stopTimestamp <= serverNow ? (
                  <span className="rounded-md bg-slate-200 dark:bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:text-slate-300">
                    Aired
                  </span>
                ) : (
                  <span className="rounded-md bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 dark:text-indigo-300">
                    Upcoming
                  </span>
                )}
              </div>

              <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                {selectedSlot.program.title}
              </h3>

              {selectedSlot.program.description ? (
                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  {selectedSlot.program.description}
                </p>
              ) : (
                <p className="text-xs text-slate-500 dark:text-slate-400 italic">
                  No program synopsis provided by the broadcaster.
                </p>
              )}

              <p className="pt-1 text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                Local start: {formatLocalTimeFromUnix(selectedSlot.program.startTimestamp)}
              </p>
            </div>

            {/* Upcoming Program Reminder Controls */}
            {selectedSlot.program.startTimestamp > serverNow && (() => {
              const slotReminderId = buildReminderId(
                selectedSlot.channel.streamId,
                selectedSlot.program.startTimestamp,
                selectedSlot.program.id || selectedSlot.program.title,
              );
              const activeReminder = reminderById.get(slotReminderId);

              return (
                <div className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#0B0E16] p-3.5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                      {activeReminder ? (
                        <BellRing className="h-3.5 w-3.5 text-amber-500" />
                      ) : (
                        <Bell className="h-3.5 w-3.5 text-[#E11D48]" />
                      )}
                      <span>
                        {activeReminder
                          ? `Alert active (${activeReminder.leadMinutes === 0 ? 'At start' : `${activeReminder.leadMinutes}m before`})`
                          : 'Notify me before broadcast'}
                      </span>
                    </span>

                    <div className="flex items-center gap-1 rounded-lg bg-white dark:bg-[#111520] border border-slate-200/80 dark:border-white/10 p-0.5">
                      {([0, 5, 10, 15] as ReminderLeadMinutes[]).map((mins) => (
                        <button
                          key={mins}
                          type="button"
                          onClick={() => {
                            setLeadMinutes(mins);
                            if (activeReminder) {
                              onUpdateReminderLeadTime(activeReminder.id, mins);
                            }
                          }}
                          className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                            (activeReminder ? activeReminder.leadMinutes : leadMinutes) === mins
                              ? 'bg-[#E11D48] text-white'
                              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          {mins === 0 ? 'Start' : `${mins}m`}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      onToggleReminder(selectedSlot.channel, selectedSlot.program, leadMinutes)
                    }
                    className={`w-full inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl border px-4 text-xs font-semibold transition-colors ${
                      activeReminder
                        ? 'border-amber-400/70 bg-amber-400/15 text-amber-700 dark:text-amber-300 hover:bg-amber-400/25'
                        : 'border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/25'
                    }`}
                  >
                    {activeReminder ? (
                      <>
                        <BellRing className="h-4 w-4" />
                        <span>Cancel Show Reminder</span>
                      </>
                    ) : (
                      <>
                        <Bell className="h-4 w-4" />
                        <span>
                          Set Reminder ({leadMinutes === 0 ? 'At start' : `${leadMinutes}m before`})
                        </span>
                      </>
                    )}
                  </button>
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
              {(selectedSlot.program.hasArchive || selectedSlot.channel.hasArchive) &&
                selectedSlot.program.startTimestamp < serverNow && (
                  <button
                    type="button"
                    onClick={() => {
                      const { channel, program } = selectedSlot;
                      setSelectedSlot(null);
                      onOpenDetail({
                        kind: 'live',
                        id: channel.streamId,
                        channel,
                        initialCatchupProgram: program,
                      });
                    }}
                    className="inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-sky-300 dark:border-sky-500/35 bg-sky-50 dark:bg-sky-950/30 px-4 text-xs font-semibold text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/40"
                  >
                    <RotateCcw className="h-4 w-4" />
                    <span>Watch Catch-up Replay</span>
                  </button>
                )}

              <button
                type="button"
                onClick={() => {
                  const { channel } = selectedSlot;
                  setSelectedSlot(null);
                  onOpenDetail({ kind: 'live', id: channel.streamId, channel });
                }}
                className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#E11D48] px-5 text-xs font-semibold text-white shadow-sm hover:bg-[#BE123C]"
              >
                <Radio className="h-4 w-4" />
                <span>Watch Channel Live</span>
              </button>
            </div>
          </div>
        </div>
      )}

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
  );
}
