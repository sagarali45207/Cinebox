import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Globe2,
  Play,
  Radio,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react';
import {
  fetchLiveCategories,
  fetchLiveChannels,
} from '../services/api';
import type {
  CategoryItem,
  GenreItem,
  HomePayload,
  LiveChannelSummary,
} from '../types/media';
import { formatNumber } from '../utils/format';
import {
  loadViewFilters,
  saveViewFilters,
  type LiveFilterSnapshot,
} from '../utils/navPersistence';
import {
  isRestrictedCategory,
  isRestrictedContent,
  useAppSettings,
} from '../utils/settings';
import { MediaImage } from './MediaImage';
import { LoadingSpinner } from './LoadingSpinner';
import { SpotlightHeroSlider, type LiveHeroSlide } from './SpotlightHeroSlider';

interface LiveTvViewProps {
  home?: HomePayload | null;
  favoriteChannels: LiveChannelSummary[];
  onSelectChannel: (channel: LiveChannelSummary) => void;
  onToggleFavoriteChannel: (channel: LiveChannelSummary) => void;
}

type LiveFilterMode = 'all' | 'epg' | 'catchup' | 'favorites';

const FAVORITES_GENRE_RULES: Array<{
  id: string;
  label: string;
  group: 'genre' | 'cinema';
  catRx?: RegExp;
  nameRx?: RegExp;
}> = [
  {
    id: 'sports',
    label: 'Sports',
    group: 'genre',
    catRx: /\b(sports?|cricket|football|soccer|espn|mls|rugby|sky uk 4k|fox australia|dstv super|f1|motogp|golf|tennis|bein|spark|hub sports|epl|nfl|mlb|nba|ufc|wwe|aew)\b/i,
    nameRx: /\b(sports?|cricket|football|soccer|espn|fox sports|sky sports|bein|eurosport|nba|nfl|mlb|nhl|ten sports|ptv sports|sony ten|star sports|willow|dazn|tsn|super ?sport|bt sport|tnt sports|f1|racing|golf|tennis)\b/i,
  },
  {
    id: 'news',
    label: 'News',
    group: 'genre',
    catRx: /\bnews\b/i,
    nameRx: /\b(news|cnn|bbc news|sky news|al ?jazeera|fox news|msnbc|cnbc|bloomberg|euronews|geo news|ary news|dawn news|samaa|dunya|express news|ndtv|aaj tak|india today|republic|wion|france 24|dw|trt world)\b/i,
  },
  {
    id: 'movies',
    label: 'Movies & Cinema',
    group: 'genre',
    catRx: /\b(movies?|cinema|netflix|amazon)\b/i,
    nameRx: /\b(movies?|cinema|kino|film|hbo|starz|showtime|cinemax|sony max|zee cinema|star gold|colors cineplex|b4u movies|tcm|sky cinema|paramount|amc)\b/i,
  },
  {
    id: 'entertainment',
    label: 'Entertainment',
    group: 'genre',
    catRx: /\b(entertainment|bigg boss|web series|general|tv)\b/i,
    nameRx: /\b(entertainment|drama|comedy|star plus|zee tv|colors|sony|hum tv|geo tv|ary digital|itv|bbc one|bbc two|cbs|nbc|abc|fox|btv|nova tv|tlc|bravo|syfy)\b/i,
  },
  {
    id: 'kids',
    label: 'Kids & Family',
    group: 'genre',
    catRx: /\bkids\b/i,
    nameRx: /\b(kids|cartoon|nick|nickelodeon|disney|pogo|hungama|boomerang|cbeebies|babytv|sonic|discovery kids|cbcc|tiny pop)\b/i,
  },
  {
    id: 'documentary',
    label: 'Documentary',
    group: 'genre',
    catRx: /\bdocumentary\b/i,
    nameRx: /\b(documentary|discovery|nat ?geo|national geographic|history|animal planet|science|planet earth|travel|wild|investigation|crime)\b/i,
  },
  {
    id: 'music',
    label: 'Music & Songs',
    group: 'genre',
    catRx: /\b(music|songs|singers)\b/i,
    nameRx: /\b(music|songs|mtv|vh1|9xm|b4u music|mastiii|zing|zoom|trace|clubland|box hits)\b/i,
  },
  {
    id: 'ppv-events',
    label: 'PPV & Live Events',
    group: 'genre',
    catRx: /\b(ppv|live events|live only)\b/i,
  },
  {
    id: '4k-uhd',
    label: '4K Ultra HD',
    group: 'genre',
    catRx: /\b(4k|2160p|uhd)\b/i,
    nameRx: /\b(4k|2160p|uhd)\b/i,
  },
  {
    id: 'religious',
    label: 'Religious & Spiritual',
    group: 'genre',
    catRx: /\b(islamic|quran|religion|religious|christian|spiritual)\b/i,
    nameRx: /\b(quran|makkah|madina|peace tv|madani|iqra|qtv|aastha|sanskar|god tv|ewtn|tbn)\b/i,
  },
  {
    id: 'region-india',
    label: 'India & Hindi',
    group: 'cinema',
    catRx: /\b(india|hindi)\b/i,
  },
  {
    id: 'region-uk-usa',
    label: 'UK, USA & English',
    group: 'cinema',
    catRx: /\b(english|uk|usa|us|canada|espn|nfl|mlb|nba|epl|sky uk)\b/i,
    nameRx: /^(uk|us|usa|ca)\s*[:|-]/i,
  },
  {
    id: 'region-pakistan',
    label: 'Pakistan & Urdu',
    group: 'cinema',
    catRx: /\b(pakistan|urdu)\b/i,
    nameRx: /^(pk|pak)\s*[:|-]/i,
  },
  {
    id: 'region-europe',
    label: 'Europe',
    group: 'cinema',
    catRx: /\b(europe|bulgaria|germany|france|spain|italy|poland|romania|greece|netherlands|portugal|turkey|turkish)\b/i,
    nameRx: /^(bg|de|fr|es|it|pl|ro|gr|nl|pt|tr)\s*[:|-]/i,
  },
  {
    id: 'region-arabic',
    label: 'Arabic & Middle East',
    group: 'cinema',
    catRx: /\b(arabic|bein|middle east|uae|saudi|egypt|osn|mbc)\b/i,
    nameRx: /^(ar|ae|sa|eg)\s*[:|-]/i,
  },
  {
    id: 'region-south-india',
    label: 'South Indian',
    group: 'cinema',
    catRx: /\b(tamil|telugu|malayalam|kannada)\b/i,
  },
  {
    id: 'region-punjabi',
    label: 'Punjabi',
    group: 'cinema',
    catRx: /\bpunjabi\b/i,
  },
  {
    id: 'region-bengali',
    label: 'Bengali',
    group: 'cinema',
    catRx: /\b(bengali|bangla)\b/i,
  },
  {
    id: 'region-regional',
    label: 'Marathi & Gujarati',
    group: 'cinema',
    catRx: /\b(marathi|gujarati)\b/i,
  },
];

function matchChannelGenres(channel: LiveChannelSummary): string[] {
  const cat = channel.categoryName || '';
  const name = channel.name || '';
  const hits: string[] = [];
  for (const rule of FAVORITES_GENRE_RULES) {
    if ((rule.catRx && rule.catRx.test(cat)) || (rule.nameRx && rule.nameRx.test(name))) {
      hits.push(rule.id);
    }
  }
  return hits;
}

const DEFAULT_LIVE_FILTERS: LiveFilterSnapshot = {
  categoryId: '',
  selectedGenre: '',
  filterMode: 'all',
  query: '',
  page: 1,
};

export function LiveTvView({
  home,
  favoriteChannels,
  onSelectChannel,
  onToggleFavoriteChannel,
}: LiveTvViewProps) {
  const initialFiltersRef = useRef<LiveFilterSnapshot | null>(null);
  if (!initialFiltersRef.current) {
    initialFiltersRef.current = loadViewFilters<LiveFilterSnapshot>('live', DEFAULT_LIVE_FILTERS);
  }
  const initialFilters = initialFiltersRef.current;

  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoryId, setCategoryId] = useState(initialFilters.categoryId);
  const [selectedGenre, setSelectedGenre] = useState(initialFilters.selectedGenre);
  const [genreSearch, setGenreSearch] = useState('');
  const [genres, setGenres] = useState<GenreItem[]>([]);
  const [mobileGenresOpen, setMobileGenresOpen] = useState(false);

  const [filterMode, setFilterMode] = useState<LiveFilterMode>(initialFilters.filterMode);
  const [queryInput, setQueryInput] = useState(initialFilters.query);
  const [debouncedQuery, setDebouncedQuery] = useState(initialFilters.query);
  const [page, setPage] = useState(initialFilters.page);

  const [channels, setChannels] = useState<LiveChannelSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const { settings, parentalUnlocked } = useAppSettings();

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const favIds = useMemo(
    () => new Set(favoriteChannels.map((c) => c.streamId)),
    [favoriteChannels],
  );

  useEffect(() => {
    saveViewFilters<LiveFilterSnapshot>('live', {
      categoryId,
      selectedGenre,
      filterMode,
      query: debouncedQuery,
      page,
    });
  }, [categoryId, selectedGenre, filterMode, debouncedQuery, page]);

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
    fetchLiveCategories(controller.signal)
      .then((res) => setCategories(res.categories))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!mobileGenresOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileGenresOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileGenresOpen]);

  useEffect(() => {
    if (filterMode === 'favorites') {
      const term = debouncedQuery.trim().toLowerCase();
      const baseFiltered = favoriteChannels.filter((c) => {
        if (categoryId && c.categoryId !== categoryId) return false;
        if (
          term &&
          !c.name.toLowerCase().includes(term) &&
          !c.categoryName.toLowerCase().includes(term)
        ) {
          return false;
        }
        return true;
      });

      const counts = new Map<string, number>();
      const channelGenreMap = new Map<string, Set<string>>();
      for (const ch of baseFiltered) {
        const matched = matchChannelGenres(ch);
        channelGenreMap.set(ch.streamId, new Set(matched));
        for (const gid of matched) {
          counts.set(gid, (counts.get(gid) || 0) + 1);
        }
      }

      const favGenres: GenreItem[] = FAVORITES_GENRE_RULES.filter(
        (r) => (counts.get(r.id) || 0) > 0,
      )
        .map((r) => ({
          id: r.id,
          label: r.label,
          count: counts.get(r.id) || 0,
          group: r.group,
        }))
        .sort((a, b) => b.count - a.count);

      const filtered = selectedGenre
        ? baseFiltered.filter((c) => channelGenreMap.get(c.streamId)?.has(selectedGenre))
        : baseFiltered;

      setGenres(favGenres);
      setChannels(filtered);
      setTotal(filtered.length);
      setTotalPages(1);
      setLoading(false);
      setError('');
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');

    fetchLiveChannels(
      {
        categoryId,
        genre: selectedGenre,
        q: debouncedQuery,
        hasEpg: filterMode === 'epg',
        hasCatchup: filterMode === 'catchup',
        page,
        limit: 48,
      },
      controller.signal,
    )
      .then((res) => {
        setChannels(res.items);
        setTotal(res.total);
        setTotalPages(res.totalPages);
        if (Array.isArray(res.genres)) setGenres(res.genres);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setError(err.message || 'Unable to load channels');
        setLoading(false);
      });

    return () => controller.abort();
  }, [categoryId, selectedGenre, debouncedQuery, filterMode, page, favoriteChannels]);

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

  const visibleChannels = useMemo(
    () =>
      channels.filter(
        (c) =>
          !isRestrictedContent(
            { title: c.name, categoryName: c.categoryName },
            settings,
            parentalUnlocked,
          ),
      ),
    [channels, settings, parentalUnlocked],
  );

  const activeGenreObj = useMemo(
    () => genres.find((g) => g.id === selectedGenre) || null,
    [genres, selectedGenre],
  );

  const groupedGenres = useMemo(() => {
    const term = genreSearch.trim().toLowerCase();
    const safe = genres.filter(
      (g) => !isRestrictedCategory(g.label, settings, parentalUnlocked),
    );
    const list = term
      ? safe.filter((g) => g.label.toLowerCase().includes(term))
      : safe;
    return {
      core: list.filter((g) => g.group !== 'cinema'),
      regions: list.filter((g) => g.group === 'cinema'),
    };
  }, [genres, genreSearch, settings, parentalUnlocked]);

  const quickGenres = useMemo(() => {
    const safe = genres.filter(
      (g) => !isRestrictedCategory(g.label, settings, parentalUnlocked),
    );
    const coreFirst = safe.filter((g) => g.group !== 'cinema');
    const regionNext = safe.filter((g) => g.group === 'cinema');
    return [...coreFirst, ...regionNext].slice(0, 14);
  }, [genres, settings, parentalUnlocked]);

  const handleSelectGenre = (genreId: string) => {
    setSelectedGenre((prev) => (prev === genreId ? '' : genreId));
    setPage(1);
    setMobileGenresOpen(false);
  };

  const clearAllFilters = () => {
    setCategoryId('');
    setSelectedGenre('');
    setGenreSearch('');
    setQueryInput('');
    setDebouncedQuery('');
    setFilterMode('all');
    setPage(1);
  };

  const renderGenreList = (onPick?: () => void) => (
    <>
      <div className="space-y-1">
        <button
          type="button"
          onClick={() => {
            setSelectedGenre('');
            setPage(1);
            onPick?.();
          }}
          className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 lg:py-2 text-left text-xs font-semibold transition-all ${
            !selectedGenre
              ? 'bg-gradient-to-r from-[#E11D48] to-sky-500 text-white shadow-sm shadow-sky-500/20'
              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.06]'
          }`}
        >
          <span className="flex items-center gap-2 truncate">
            <Radio className="h-3.5 w-3.5 shrink-0 opacity-85" />
            <span className="truncate">All Live Channels</span>
          </span>
        </button>

        {groupedGenres.core.map((g) => {
          const active = selectedGenre === g.id;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => handleSelectGenre(g.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 lg:py-2 text-left text-xs font-medium transition-all ${
                active
                  ? 'bg-gradient-to-r from-[#E11D48] to-sky-500 text-white font-semibold shadow-sm shadow-sky-500/20'
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

      {groupedGenres.regions.length > 0 && (
        <div className="border-t border-slate-200/80 dark:border-white/[0.08] pt-3 space-y-1">
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            <Globe2 className="h-3 w-3" />
            <span>Regions &amp; Languages</span>
          </div>
          {groupedGenres.regions.map((g) => {
            const active = selectedGenre === g.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => handleSelectGenre(g.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 lg:py-2 text-left text-xs font-medium transition-all ${
                  active
                    ? 'bg-gradient-to-r from-[#E11D48] to-sky-500 text-white font-semibold shadow-sm shadow-sky-500/20'
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

      {groupedGenres.core.length === 0 && groupedGenres.regions.length === 0 && (
        <p className="px-2 py-4 text-center text-xs text-slate-500 dark:text-slate-400">
          No matching genres found.
        </p>
      )}
    </>
  );

  const activeCategoryName = useMemo(
    () => visibleCategories.find((c) => c.categoryId === categoryId)?.categoryName || '',
    [visibleCategories, categoryId],
  );

  const heroSlides = useMemo<LiveHeroSlide[]>(() => {
    const filtersActive = Boolean(
      categoryId || selectedGenre || debouncedQuery || filterMode !== 'all',
    );

    const safeFeatured = (home?.featuredLive || []).filter(
      (ch) =>
        !isRestrictedContent(
          { title: ch.name, categoryName: ch.categoryName },
          settings,
          parentalUnlocked,
        ),
    );
    const featuredMap = new Map<string, LiveChannelSummary>();
    for (const ch of safeFeatured) {
      featuredMap.set(ch.streamId, ch);
    }

    const scoreChannel = (ch: LiveChannelSummary) =>
      (ch.nowPlaying ? 400 : 0) +
      (ch.logo ? 120 : 0) +
      (ch.hasArchive ? 40 : 0) +
      (ch.epgChannelId ? 20 : 0);

    const pool: LiveChannelSummary[] = [];
    const seen = new Set<string>();
    const pushUniqueChannel = (ch: LiveChannelSummary) => {
      if (seen.has(ch.streamId)) return;
      const enriched = featuredMap.get(ch.streamId);
      const merged: LiveChannelSummary = enriched
        ? {
            ...ch,
            nowPlaying: ch.nowPlaying || enriched.nowPlaying,
            nextProgram: ch.nextProgram || enriched.nextProgram,
          }
        : ch;
      seen.add(ch.streamId);
      pool.push(merged);
    };

    if (!filtersActive && safeFeatured.length > 0) {
      const sortedFeatured = [...safeFeatured].sort((a, b) => scoreChannel(b) - scoreChannel(a));
      for (const ch of sortedFeatured) {
        if (pool.length >= 8) break;
        pushUniqueChannel(ch);
      }
    }

    const sortedVisible = [...visibleChannels]
      .map((ch) => {
        const enriched = featuredMap.get(ch.streamId);
        return enriched
          ? {
              ...ch,
              nowPlaying: ch.nowPlaying || enriched.nowPlaying,
              nextProgram: ch.nextProgram || enriched.nextProgram,
            }
          : ch;
      })
      .sort((a, b) => scoreChannel(b) - scoreChannel(a));

    for (const ch of sortedVisible) {
      if (pool.length >= 8) break;
      pushUniqueChannel(ch);
    }

    const fallbackKicker = debouncedQuery
      ? 'Matching Channel'
      : filterMode === 'favorites'
        ? 'Pinned Channel'
        : filterMode === 'catchup'
          ? 'Catch-up Replay'
          : activeGenreObj
            ? activeGenreObj.label
            : activeCategoryName || 'Live Broadcast';

    return pool.slice(0, 8).map((ch) => {
      const np = ch.nowPlaying;
      let progress: number | undefined;
      if (np && np.stopTimestamp > np.startTimestamp) {
        const raw = ((nowSec - np.startTimestamp) / (np.stopTimestamp - np.startTimestamp)) * 100;
        progress = Math.max(0, Math.min(100, Math.round(raw)));
      }
      return {
        kind: 'live',
        id: ch.streamId,
        kicker: np ? 'On Air Now' : fallbackKicker,
        title: ch.name,
        channelNumber: ch.num,
        categoryName: ch.categoryName,
        logo: ch.logo,
        hasArchive: ch.hasArchive,
        hasEpg: Boolean(ch.epgChannelId || np),
        nowPlayingTitle: np?.title,
        nowPlayingTime: np ? `${np.startLabel} – ${np.stopLabel}` : undefined,
        nowPlayingDescription: np?.description,
        nowPlayingProgress: progress,
        nextProgramTitle: ch.nextProgram?.title,
        nextProgramTime: ch.nextProgram
          ? `${ch.nextProgram.startLabel} – ${ch.nextProgram.stopLabel}`
          : undefined,
        primaryActionLabel: 'Watch Live',
        secondaryActionLabel: ch.epgChannelId || np ? 'TV Guide' : 'Channel Info',
        onPrimaryAction: () => onSelectChannel(ch),
        onSecondaryAction: () => onSelectChannel(ch),
      };
    });
  }, [
    home?.featuredLive,
    visibleChannels,
    categoryId,
    selectedGenre,
    debouncedQuery,
    filterMode,
    activeGenreObj,
    activeCategoryName,
    nowSec,
    settings,
    parentalUnlocked,
    onSelectChannel,
  ]);

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 pb-16">
      {heroSlides.length > 0 && (
        <div className="mb-7">
          <SpotlightHeroSlider
            slides={heroSlides}
            ariaLabel="Featured Live Channels Slider"
            compact
          />
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-200/80 dark:border-white/[0.08] pb-5 sm:pb-6">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">
            Live TV
          </h1>
          
        </div>

        <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-1 shadow-sm shadow-slate-900/5 dark:shadow-none self-start lg:self-auto max-w-full">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'epg', label: 'With EPG' },
              { id: 'catchup', label: 'Catch-up' },
              { id: 'favorites', label: `Favorites (${favoriteChannels.length})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setFilterMode(tab.id);
                setPage(1);
              }}
              className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-all ${
                filterMode === tab.id
                  ? 'bg-gradient-to-r from-[#E11D48] to-sky-500 text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Category & Search Filters */}
      <div className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-5">
          <select
            aria-label="Filter live channels by category"
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
            placeholder="Search channel name or country..."
            className="h-11 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] pl-10 pr-4 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 shadow-sm shadow-slate-900/5 dark:shadow-none focus:border-[#E11D48] focus:outline-none"
          />
        </div>
      </div>

      {/* Mobile & Tablet Responsive Genre Quick Bar + Drawer Trigger */}
      {genres.length > 0 && (
        <div className="mt-4 lg:hidden flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMobileGenresOpen(true)}
            className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border px-3.5 text-xs font-semibold transition-all shadow-sm ${
              selectedGenre
                ? 'border-transparent bg-gradient-to-r from-[#E11D48] to-sky-500 text-white shadow-sky-500/20'
                : 'border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-800 dark:text-white hover:border-sky-300 dark:hover:border-white/25'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>{activeGenreObj ? activeGenreObj.label : 'All Genres'}</span>
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] tabular-nums ${
                selectedGenre
                  ? 'bg-white/20 text-white'
                  : 'bg-slate-100 dark:bg-white/[0.08] text-slate-600 dark:text-slate-300'
              }`}
            >
              {genres.length}
            </span>
          </button>

          <div className="flex flex-1 items-center gap-2 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              type="button"
              onClick={() => {
                setSelectedGenre('');
                setPage(1);
              }}
              className={`h-9 shrink-0 rounded-xl border px-3 text-xs font-semibold whitespace-nowrap transition-all ${
                !selectedGenre
                  ? 'border-transparent bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-sm'
                  : 'border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/20'
              }`}
            >
              All
            </button>

            {quickGenres.map((g) => {
              const active = selectedGenre === g.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => handleSelectGenre(g.id)}
                  className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium whitespace-nowrap transition-all ${
                    active
                      ? 'border-transparent bg-gradient-to-r from-[#E11D48] to-sky-500 text-white font-semibold shadow-sm'
                      : 'border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] text-slate-700 dark:text-slate-300 hover:border-sky-300 dark:hover:border-white/20'
                  }`}
                >
                  <span>{g.label}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
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
        </div>
      )}

      {/* Mobile & Tablet Genre Filter Bottom Sheet / Drawer */}
      {mobileGenresOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 lg:hidden"
          onClick={() => setMobileGenresOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Browse live TV genres"
        >
          <div
            className="flex w-full sm:max-w-md max-h-[85vh] flex-col rounded-t-2xl sm:rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] shadow-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center pt-2.5 pb-1 sm:hidden">
              <span className="h-1 w-10 rounded-full bg-slate-300 dark:bg-white/20" />
            </div>

            <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 dark:border-white/[0.08] px-4 py-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#E11D48]/12 text-[#E11D48] dark:text-rose-400">
                  <SlidersHorizontal className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                    Browse Live Genres
                  </h2>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                    {genres.length} categories &amp; regions available
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {selectedGenre && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedGenre('');
                      setPage(1);
                      setMobileGenresOpen(false);
                    }}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-[#E11D48] hover:bg-rose-50 dark:hover:bg-rose-950/30"
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setMobileGenresOpen(false)}
                  aria-label="Close genre filters"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {genres.length > 6 && (
              <div className="px-4 pt-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={genreSearch}
                    onChange={(e) => setGenreSearch(e.target.value)}
                    placeholder="Filter genres & regions..."
                    className="h-10 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/80 dark:bg-[#0B0E16] pl-9 pr-3 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {renderGenreList(() => setMobileGenresOpen(false))}
            </div>
          </div>
        </div>
      )}

      {/* Responsive Desktop Sidebar + Main Live Channels Content */}
      <div className="mt-6 lg:mt-7 flex flex-col lg:flex-row lg:items-start gap-7">
        {/* Desktop Sticky Dynamic Genre Sidebar */}
        <aside
          aria-label="Live TV genre filters"
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
                renderGenreList()
              )}
            </div>
          </div>
        </aside>

        {/* Main Content Grid */}
        <div className="flex-1 min-w-0">
          {/* Active Genre Indicator Banner (all devices) */}
          {activeGenreObj && (
            <div className="flex items-center justify-between gap-3 mb-5 rounded-xl border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-950/25 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-700 dark:text-slate-200">
                <span className="font-medium text-slate-500 dark:text-slate-400">
                  Selected Genre:
                </span>
                <span className="font-bold text-slate-900 dark:text-white">
                  {activeGenreObj.label}
                </span>
                <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                  ({formatNumber(total)} channels)
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedGenre('');
                  setPage(1);
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white/85 dark:bg-white/10 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-white/20 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
                <span>Clear</span>
              </button>
            </div>
          )}

          {loading ? (
            <div className="rounded-2xl border border-slate-200/80 dark:border-white/[0.06] bg-white/80 dark:bg-[#111520]/40 p-12 text-center min-h-[420px] flex items-center justify-center shadow-sm">
              <LoadingSpinner
                label={
                  debouncedQuery
                    ? `Searching live channels for "${debouncedQuery}"...`
                    : filterMode === 'favorites'
                      ? 'Loading favorite channels...'
                      : 'Loading live TV channels...'
                }
                size="lg"
              />
            </div>
          ) : error ? (
            <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] p-10 text-center">
              <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                Channel Feed Unavailable
              </p>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{error}</p>
            </div>
          ) : visibleChannels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-white/70 dark:bg-[#111520]/60 p-12 text-center">
              <p className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                No Channels Found
              </p>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                {filterMode === 'favorites' && !selectedGenre && !categoryId && !debouncedQuery
                  ? 'Star any live channel to keep it pinned here.'
                  : 'No channels matched your active filters.'}
              </p>
              {(categoryId || selectedGenre || debouncedQuery || filterMode !== 'all') && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#E11D48] to-sky-500 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-95"
                >
                  Clear All Filters
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-3.5 sm:gap-4">
              {visibleChannels.map((ch) => {
                const isFav = favIds.has(ch.streamId);
                return (
                  <article
                    key={ch.streamId}
                    className="cinebox-card-elevated group flex flex-col overflow-hidden rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] shadow-sm shadow-slate-900/5 dark:shadow-none transition-all hover:border-sky-300 dark:hover:border-white/25 dark:hover:bg-[#171D2B]"
                  >
                    <div className="relative aspect-[16/10] bg-slate-100 dark:bg-[#090B10] border-b border-slate-200/70 dark:border-white/[0.05]">
                      <button
                        type="button"
                        onClick={() => onSelectChannel(ch)}
                        aria-label={`Open ${ch.name}`}
                        className="flex h-full w-full items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                      >
                        <MediaImage
                          src={ch.logo}
                          alt={ch.name}
                          title={ch.name}
                          category={ch.categoryName}
                          variant="logo"
                          className="h-full w-full"
                          imgClassName="h-full w-full object-contain p-2.5 sm:p-3"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#E11D48] text-white shadow-md">
                            <Play className="h-5 w-5 fill-current ml-0.5" />
                          </span>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => onToggleFavoriteChannel(ch)}
                        aria-label={isFav ? `Unpin ${ch.name}` : `Pin ${ch.name} to favorites`}
                        className={`absolute right-2 top-2 inline-flex h-9 w-9 sm:h-8 sm:w-8 items-center justify-center rounded-md border transition-opacity ${
                          isFav
                            ? 'border-amber-400 bg-amber-400/20 text-amber-500 dark:text-amber-300 opacity-100'
                            : 'border-slate-300/70 dark:border-white/10 bg-white/85 dark:bg-black/60 text-slate-600 dark:text-slate-300 opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-amber-500 dark:hover:text-white'
                        }`}
                      >
                        <Star className={`h-3.5 w-3.5 ${isFav ? 'fill-current' : ''}`} />
                      </button>
                    </div>

                    <div className="flex flex-1 flex-col justify-between p-3">
                      <div>
                        <button
                          type="button"
                          onClick={() => onSelectChannel(ch)}
                          className="text-left text-sm font-semibold text-slate-900 dark:text-white line-clamp-1 hover:text-[#E11D48] transition-colors"
                        >
                          {ch.name}
                        </button>
                        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 line-clamp-1">
                          {ch.nowPlaying ? ch.nowPlaying.title : ch.categoryName}
                        </p>
                      </div>

                      <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                        <span className="truncate">
                          {ch.nowPlaying
                            ? `${ch.nowPlaying.startLabel}–${ch.nowPlaying.stopLabel}`
                            : ch.hasArchive
                              ? 'Catch-up'
                              : 'Live'}
                        </span>
                        {ch.epgChannelId && (
                          <button
                            type="button"
                            onClick={() => onSelectChannel(ch)}
                            className="shrink-0 font-semibold text-sky-600 dark:text-sky-400 hover:underline"
                          >
                            EPG Guide
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {!loading && totalPages > 1 && filterMode !== 'favorites' && (
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
    </div>
  );
}
