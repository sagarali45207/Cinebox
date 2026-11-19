import type {
  AccountSummary,
  CatalogLanguageVariant,
  CatalogStats,
  CategoryItem,
  ComingSoonItem,
  EpgChannelGuide,
  EpgGuideResponse,
  EpgProgram,
  EpisodeSummary,
  GenreItem,
  HomePayload,
  LiveChannelDetailResponse,
  LiveChannelSummary,
  MovieDetail,
  MovieSummary,
  RecommendationEntry,
  RecommendationRequest,
  RecommendationsResponse,
  SeasonSummary,
  SeriesDetail,
  SeriesSummary,
  StreamFormat,
  XtreamConfig,
} from './types.ts';
import { lookupChannelLogoSync, warmChannelLogoIndex } from './channelLogos.ts';
import { fetchUpcomingReleases, getPersonFilmographyTitles } from './imdb.ts';

const DEFAULT_CONFIG: XtreamConfig = {
  host: (process.env.IPTV_HOST || 'http://opplex.ch:8080').replace(/\/+$/, ''),
  username: process.env.IPTV_USERNAME || 'shahzam',
  password: process.env.IPTV_PASSWORD || '5432189',
  format: process.env.IPTV_FORMAT === 'm3u8' ? 'm3u8' : 'ts',
  isDefault: true,
};

let activeConfig: XtreamConfig = { ...DEFAULT_CONFIG };

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const emptyEpgStreams = new Map<string, number>();

const CATEGORY_TTL_MS = 60 * 60 * 1000;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const DETAIL_TTL_MS = 60 * 60 * 1000;
const EPG_TTL_MS = 20 * 60 * 1000;
const ACCOUNT_TTL_MS = 5 * 60 * 1000;
const EMPTY_EPG_TTL_MS = 30 * 60 * 1000;

const SEPARATOR_REGEX = /#{4,}|={4,}|-{6,}|\*{4,}|_{6,}/;

export function getConfig(): XtreamConfig {
  return activeConfig;
}

export function clearAllCaches(): void {
  cache.clear();
  inFlight.clear();
  emptyEpgStreams.clear();
}

export async function updateConfig(input: {
  host: string;
  username: string;
  password: string;
  format?: StreamFormat;
}): Promise<AccountSummary> {
  const cleanHost = input.host.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+(?::\d+)?$/i.test(cleanHost)) {
    throw new Error('Invalid Xtream host URL. Must start with http:// or https://');
  }
  const cleanUser = input.username.trim();
  const cleanPass = input.password.trim();
  if (!cleanUser || !cleanPass) {
    throw new Error('Username and password are required.');
  }
  const format: StreamFormat = input.format === 'm3u8' ? 'm3u8' : 'ts';

  const nextConfig: XtreamConfig = {
    host: cleanHost,
    username: cleanUser,
    password: cleanPass,
    format,
    isDefault:
      cleanHost === DEFAULT_CONFIG.host &&
      cleanUser === DEFAULT_CONFIG.username &&
      cleanPass === DEFAULT_CONFIG.password,
  };

  // Probe the connection before applying
  const probeUrl = `${nextConfig.host}/player_api.php?username=${encodeURIComponent(
    nextConfig.username,
  )}&password=${encodeURIComponent(nextConfig.password)}`;

  const res = await fetch(probeUrl, {
    headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Xtream server returned HTTP ${res.status}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const userInfo = raw.user_info as Record<string, unknown> | undefined;
  if (!userInfo || Number(userInfo.auth) !== 1) {
    throw new Error('Authentication failed on Xtream server.');
  }

  activeConfig = nextConfig;
  clearAllCaches();
  return getAccountSummary();
}

export async function resetConfig(): Promise<AccountSummary> {
  activeConfig = { ...DEFAULT_CONFIG };
  clearAllCaches();
  return getAccountSummary();
}

export function setStreamFormat(format: StreamFormat): XtreamConfig {
  activeConfig = {
    ...activeConfig,
    format: format === 'm3u8' ? 'm3u8' : 'ts',
  };
  cache.delete('account_summary');
  return activeConfig;
}

export function buildUpstreamStreamUrl(
  kind: 'live' | 'movie' | 'series',
  id: string,
  ext: string,
): string {
  const cfg = activeConfig;
  const user = encodeURIComponent(cfg.username);
  const pass = encodeURIComponent(cfg.password);
  const cleanId = encodeURIComponent(id);
  const cleanExt = ext.replace(/[^a-zA-Z0-9]/g, '') || (kind === 'live' ? cfg.format : 'mp4');
  return `${cfg.host}/${kind}/${user}/${pass}/${cleanId}.${cleanExt}`;
}

export function buildCatchupUrl(streamId: string, durationMin: number, startParam: string): string {
  const cfg = activeConfig;
  const user = encodeURIComponent(cfg.username);
  const pass = encodeURIComponent(cfg.password);
  const dur = Math.max(1, Math.min(360, Math.round(durationMin)));
  return `${cfg.host}/timeshift/${user}/${pass}/${dur}/${encodeURIComponent(startParam)}/${encodeURIComponent(streamId)}.ts`;
}

async function cachedFetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) {
    return pending;
  }

  const promise = loader()
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      inFlight.delete(key);
      return value;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });

  inFlight.set(key, promise);
  return promise;
}

async function xtreamJson<T>(action?: string, params: Record<string, string> = {}): Promise<T> {
  const cfg = activeConfig;
  const search = new URLSearchParams({
    username: cfg.username,
    password: cfg.password,
  });
  if (action) {
    search.set('action', action);
  }
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') {
      search.set(k, v);
    }
  }
  const url = `${cfg.host}/player_api.php?${search.toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    throw new Error(`Xtream API error: HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Xtream server returned non-JSON response');
  }
}

function normalizeImageUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\\\//g, '/');
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}

function parseTitleMeta(rawName: string): {
  cleanTitle: string;
  year: string | null;
  qualityTag: string | null;
} {
  let clean = rawName.trim();
  let year: string | null = null;
  let qualityTag: string | null = null;

  const yearMatch = clean.match(/\b(19\d{2}|20[0-3]\d)\b/);
  if (yearMatch) {
    year = yearMatch[1];
  }

  const qualityMatch = clean.match(/\b(4K|2160P|UHD|FHD|1080P|HD|720P|CAM|HDCAM|TS)\b/i);
  if (qualityMatch) {
    qualityTag = qualityMatch[1].toUpperCase();
  }

  clean = clean
    .replace(/\(\s*(CAM|HDCAM|TS|HDTS|4K|FHD|HD)\s*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { cleanTitle: clean || rawName, year, qualityTag };
}

function decodeBase64Utf8(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const trimmed = raw.trim();
  // Check if plausible base64
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 4 && trimmed.length % 4 === 0) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
      // Verify printable output without replacement characters
      if (decoded && !decoded.includes('\uFFFD')) {
        return decoded.trim();
      }
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function formatUnixClock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseRating(val: unknown, fiveBased?: unknown): number {
  const r = Number(val);
  if (Number.isFinite(r) && r > 0) {
    return Math.min(10, Math.round(r * 10) / 10);
  }
  const r5 = Number(fiveBased);
  if (Number.isFinite(r5) && r5 > 0) {
    return Math.min(10, Math.round(r5 * 2 * 10) / 10);
  }
  return 0;
}

function isDividerEntry(name: string): boolean {
  if (!name) return true;
  return SEPARATOR_REGEX.test(name);
}

export async function getAccountSummary(): Promise<AccountSummary> {
  return cachedFetch('account_summary', ACCOUNT_TTL_MS, async () => {
    const raw = await xtreamJson<{
      user_info?: Record<string, unknown>;
      server_info?: Record<string, unknown>;
    }>();
    const u = raw.user_info || {};
    const s = raw.server_info || {};
    const allowed = Array.isArray(u.allowed_output_formats)
      ? u.allowed_output_formats.map((f) => String(f))
      : ['ts'];

    let hostDomain = activeConfig.host;
    try {
      hostDomain = new URL(activeConfig.host).hostname;
    } catch {
      // keep raw
    }

    return {
      status: String(u.status || 'Unknown'),
      username: String(u.username || activeConfig.username),
      message: String(u.message || ''),
      expDate: u.exp_date ? Number(u.exp_date) : null,
      createdAt: u.created_at ? Number(u.created_at) : null,
      activeCons: Number(u.active_cons || 0),
      maxConnections: Number(u.max_connections || 1),
      allowedOutputFormats: allowed,
      preferredFormat: activeConfig.format,
      hostDomain,
      serverTimezone: String(s.timezone || 'UTC'),
      serverTimestamp: Number(s.timestamp_now || Math.floor(Date.now() / 1000)),
      serverTimeNow: String(s.time_now || ''),
      isDefault: activeConfig.isDefault,
    };
  });
}

async function getRawCategories(
  action: 'get_live_categories' | 'get_vod_categories' | 'get_series_categories',
): Promise<Map<string, string>> {
  return cachedFetch(`raw_cats_${action}`, CATEGORY_TTL_MS, async () => {
    const list = await xtreamJson<Array<{ category_id?: unknown; category_name?: unknown }>>(action);
    const map = new Map<string, string>();
    if (Array.isArray(list)) {
      for (const item of list) {
        const id = String(item.category_id ?? '').trim();
        const name = String(item.category_name ?? 'Uncategorized').trim();
        if (id) map.set(id, name);
      }
    }
    return map;
  });
}

export async function getAllMovies(): Promise<MovieSummary[]> {
  return cachedFetch('all_vod_streams', CATALOG_TTL_MS, async () => {
    const [rawList, catMap] = await Promise.all([
      xtreamJson<Array<Record<string, unknown>>>('get_vod_streams'),
      getRawCategories('get_vod_categories'),
    ]);

    if (!Array.isArray(rawList)) return [];
    const movies: MovieSummary[] = [];

    for (const item of rawList) {
      const streamId = String(item.stream_id ?? '').trim();
      const name = String(item.name ?? '').trim();
      if (!/^\d+$/.test(streamId) || isDividerEntry(name)) continue;

      const categoryId = String(item.category_id ?? '').trim();
      const meta = parseTitleMeta(name);

      movies.push({
        streamId,
        name,
        cleanTitle: meta.cleanTitle,
        year: meta.year,
        qualityTag: meta.qualityTag,
        poster: normalizeImageUrl(item.stream_icon),
        rating: parseRating(item.rating, item.rating_5based),
        added: Number(item.added || 0),
        categoryId,
        categoryName: catMap.get(categoryId) || 'Movies',
        extension: String(item.container_extension || 'mp4').toLowerCase(),
      });
    }

    return movies;
  });
}

export async function getAllSeries(): Promise<SeriesSummary[]> {
  return cachedFetch('all_series', CATALOG_TTL_MS, async () => {
    const [rawList, catMap] = await Promise.all([
      xtreamJson<Array<Record<string, unknown>>>('get_series'),
      getRawCategories('get_series_categories'),
    ]);

    if (!Array.isArray(rawList)) return [];
    const seriesList: SeriesSummary[] = [];

    for (const item of rawList) {
      const seriesId = String(item.series_id ?? '').trim();
      const name = String(item.name ?? '').trim();
      if (!/^\d+$/.test(seriesId) || isDividerEntry(name)) continue;

      const categoryId = String(item.category_id ?? '').trim();
      const meta = parseTitleMeta(name);
      const backdrops = Array.isArray(item.backdrop_path) ? item.backdrop_path : [];
      const backdrop = normalizeImageUrl(backdrops[0] ?? '');

      seriesList.push({
        seriesId,
        name,
        cleanTitle: meta.cleanTitle,
        year: meta.year || (typeof item.releaseDate === 'string' && item.releaseDate.slice(0, 4)) || null,
        poster: normalizeImageUrl(item.cover),
        backdrop,
        plot: String(item.plot || ''),
        genre: String(item.genre || ''),
        releaseDate: String(item.releaseDate || ''),
        rating: parseRating(item.rating, item.rating_5based),
        lastModified: Number(item.last_modified || 0),
        categoryId,
        categoryName: catMap.get(categoryId) || 'Series',
      });
    }

    return seriesList;
  });
}

export async function getAllLiveChannels(): Promise<LiveChannelSummary[]> {
  return cachedFetch('all_live_streams', CATALOG_TTL_MS, async () => {
    const [rawList, catMap] = await Promise.all([
      xtreamJson<Array<Record<string, unknown>>>('get_live_streams'),
      getRawCategories('get_live_categories'),
    ]);

    if (!Array.isArray(rawList)) return [];
    const channels: LiveChannelSummary[] = [];

    for (const item of rawList) {
      const streamId = String(item.stream_id ?? '').trim();
      const name = String(item.name ?? '').trim();
      if (!/^\d+$/.test(streamId) || isDividerEntry(name)) continue;

      const categoryId = String(item.category_id ?? '').trim();
      const formatExt = activeConfig.format;

      channels.push({
        streamId,
        num: Number(item.num || channels.length + 1),
        name,
        logo: normalizeImageUrl(item.stream_icon),
        categoryId,
        categoryName: catMap.get(categoryId) || 'Live TV',
        epgChannelId: String(item.epg_channel_id || '').trim(),
        hasArchive: Number(item.tv_archive) === 1,
        archiveDurationDays: Number(item.tv_archive_duration || 0),
        playUrl: `/api/play/live/${streamId}.${formatExt}`,
      });
    }

    return channels;
  });
}

export async function getMovieCategories(): Promise<CategoryItem[]> {
  const [movies, catMap] = await Promise.all([
    getAllMovies(),
    getRawCategories('get_vod_categories'),
  ]);
  const counts = new Map<string, number>();
  for (const m of movies) {
    counts.set(m.categoryId, (counts.get(m.categoryId) || 0) + 1);
  }
  const result: CategoryItem[] = [];
  for (const [id, name] of catMap.entries()) {
    const count = counts.get(id) || 0;
    if (count > 0) result.push({ categoryId: id, categoryName: name, count });
  }
  return result;
}

export async function getSeriesCategories(): Promise<CategoryItem[]> {
  const [series, catMap] = await Promise.all([
    getAllSeries(),
    getRawCategories('get_series_categories'),
  ]);
  const counts = new Map<string, number>();
  for (const s of series) {
    counts.set(s.categoryId, (counts.get(s.categoryId) || 0) + 1);
  }
  const result: CategoryItem[] = [];
  for (const [id, name] of catMap.entries()) {
    const count = counts.get(id) || 0;
    if (count > 0) result.push({ categoryId: id, categoryName: name, count });
  }
  return result;
}

export async function getLiveCategories(): Promise<CategoryItem[]> {
  const [channels, catMap] = await Promise.all([
    getAllLiveChannels(),
    getRawCategories('get_live_categories'),
  ]);
  const counts = new Map<string, number>();
  for (const ch of channels) {
    counts.set(ch.categoryId, (counts.get(ch.categoryId) || 0) + 1);
  }
  const result: CategoryItem[] = [];
  for (const [id, name] of catMap.entries()) {
    const count = counts.get(id) || 0;
    if (count > 0) result.push({ categoryId: id, categoryName: name, count });
  }
  return result;
}

type GenreEntry = { id: string; label: string; group: 'genre' | 'cinema' };

const MOVIE_GENRE_RULES: Array<{
  id: string;
  label: string;
  group: 'genre' | 'cinema';
  catRx?: RegExp;
  titleRx?: RegExp;
}> = [
  {
    id: 'action-adventure',
    label: 'Action & Adventure',
    group: 'genre',
    catRx: /\b(marvel|007|james bond|fast & furious|indiana jones|die hard|rambo|rocky|bruce lee|van damme|blockbuster|predator|terminator|alien|action)\b/i,
    titleRx: /\b(avengers|spider-?man|batman|superman|john wick|mission:? impossible|fast & furious|transformers|mad max|gladiator|deadpool|iron man|thor|captain america|black panther|jurassic|terminator|rambo|die hard|james bond|007|predator|matrix|top gun|expendables|extraction|equalizer|taken|bourne|karate|kung fu|venom|aquaman|wonder woman|wolverine|logan)\b/i,
  },
  {
    id: 'drama',
    label: 'Drama',
    group: 'genre',
    catRx: /\b(godfather|oscar winning|stage drama|telefilms?|denzel washington|morgan freeman)\b/i,
    titleRx: /\b(godfather|shawshank|schindler|forrest gump|oppenheimer|green mile|pulp fiction|scarface|goodfellas|parasite|joker|whiplash|spotlight|12 angry men|braveheart|bohemian rhapsody|father|whale|tar|fabelmans|past lives|anatomy of a fall)\b/i,
  },
  {
    id: 'comedy',
    label: 'Comedy',
    group: 'genre',
    catRx: /\b(comedy|kapil sharma|umer sharif)\b/i,
    titleRx: /\b(comedy|stand-?up|hangover|scary movie|home alone|zoolander|anchorman|superbad|deadpool|minions|despicable me|mr\.? bean|jumanji|ghostbusters|rush hour|shrek|ice age|american pie|borat|barbie|bridesmaids|mean girls|hangover|free guy|ted)\b/i,
  },
  {
    id: 'horror',
    label: 'Horror',
    group: 'genre',
    catRx: /\bhorror\b/i,
    titleRx: /\b(horror|conjuring|annabelle|insidious|exorcist|halloween|scream|nightmare|friday the 13th|terrifier|chucky|sinister|paranormal|the nun|poltergeist|dracula|vampire|zombie|resident evil|evil dead|final destination|silent hill|hereditary|midsommar|get out|a quiet place|nosferatu|smile|talk to me|m3gan)\b/i,
  },
  {
    id: 'crime-thriller',
    label: 'Crime & Thriller',
    group: 'genre',
    catRx: /\b(godfather|007)\b/i,
    titleRx: /\b(crime|thriller|murder|detective|cartel|mafia|heist|knives out|se7en|zodiac|shutter island|gone girl|prisoners|sicario|departed|goodfellas|scarface|no country for old men|silence of the lambs|hitman|nightcrawler|reacher|nobody)\b/i,
  },
  {
    id: 'romance',
    label: 'Romance',
    group: 'genre',
    catRx: /\b(romant|romance|beauties)\b/i,
    titleRx: /\b(romance|romantic|titanic|the notebook|me before you|dilwale|mohabbatein|aashiqui|kabir singh|jab we met|veer-?zaara|kuch kuch|devdas|la la land|pride & prejudice|anyone but you|past lives|after we|fault in our stars)\b/i,
  },
  {
    id: 'sci-fi-fantasy',
    label: 'Sci-Fi & Fantasy',
    group: 'genre',
    catRx: /\b(marvel|star wars|harry potter|jurassic|alien|predator|terminator)\b/i,
    titleRx: /\b(star wars|harry potter|lord of the rings|hobbit|avatar|dune|interstellar|inception|matrix|blade runner|guardians of the galaxy|doctor strange|terminator|alien|predator|jurassic|transformers|back to the future|ready player one|everything everywhere|star trek|arrival|gravity|the martian|ex machina|wonka|wicked)\b/i,
  },
  {
    id: 'kids-family',
    label: 'Kids & Family',
    group: 'genre',
    catRx: /\bkids\b/i,
    titleRx: /\b(kids|disney|pixar|frozen|toy story|finding nemo|finding dory|incredibles|moana|encanto|coco|lion king|aladdin|cinderella|zootopia|ratatouille|inside out|spider-verse|shrek|kung fu panda|how to train your dragon|despicable me|minions|super mario|sonic|paddington|pokemon|mufasa|wild robot|garfield|elemental)\b/i,
  },
  {
    id: 'documentary',
    label: 'Documentary',
    group: 'genre',
    catRx: /\bdocumentar/i,
    titleRx: /\b(documentary|planet earth|our planet|cosmos|untold|making of|biography)\b/i,
  },
  {
    id: 'sports',
    label: 'Sports & Fighting',
    group: 'genre',
    catRx: /\b(cricket|fifa|wwe|ufc|aew|wrestling|fight)\b/i,
  },
  {
    id: 'music-shows',
    label: 'Music & Shows',
    group: 'genre',
    catRx: /\b(indian idol|awards show|musical)\b/i,
  },
  {
    id: 'short-films',
    label: 'Short Films',
    group: 'genre',
    catRx: /\bshort film\b/i,
  },
  {
    id: '4k-uhd',
    label: '4K Ultra HD',
    group: 'genre',
    catRx: /\b4k\b/i,
  },
  {
    id: 'cinema-english',
    label: 'Hollywood & English',
    group: 'cinema',
    catRx: /\b(english|marvel|007|oscar|blockbuster|denzel washington|morgan freeman|horror movies|romantic movies|documentaries)\b/i,
  },
  {
    id: 'cinema-indian',
    label: 'Bollywood & Hindi',
    group: 'cinema',
    catRx: /\b(indian|hindi|bollywood|kapil|khanna|kumar|khan|bachchan|kapoor)\b/i,
  },
  {
    id: 'cinema-south-indian',
    label: 'South Indian',
    group: 'cinema',
    catRx: /\b(tamil|telugu|malayalam|kannada|south indian)\b/i,
  },
  {
    id: 'cinema-turkish',
    label: 'Turkish Cinema',
    group: 'cinema',
    catRx: /\bturkish\b/i,
  },
  {
    id: 'cinema-pakistani',
    label: 'Pakistani',
    group: 'cinema',
    catRx: /\bpakistan|\bwaheed murad|\bumer sharif|\bnadeem\b/i,
  },
  {
    id: 'cinema-punjabi',
    label: 'Punjabi',
    group: 'cinema',
    catRx: /\bpunjabi\b/i,
  },
  {
    id: 'cinema-bangla',
    label: 'Bangla',
    group: 'cinema',
    catRx: /\bbangla\b/i,
  },
  {
    id: 'cinema-regional',
    label: 'Marathi & Gujarati',
    group: 'cinema',
    catRx: /\b(marathi|gujarati)\b/i,
  },
];

function extractMovieGenreEntries(movie: MovieSummary): GenreEntry[] {
  const out: GenreEntry[] = [];
  const cat = movie.categoryName || '';
  const title = movie.cleanTitle || movie.name || '';
  for (const rule of MOVIE_GENRE_RULES) {
    const hitCat = rule.catRx ? rule.catRx.test(cat) : false;
    const hitTitle = rule.titleRx ? rule.titleRx.test(title) : false;
    const hitQuality = rule.id === '4k-uhd' && movie.qualityTag === '4K';
    if (hitCat || hitTitle || hitQuality) {
      out.push({ id: rule.id, label: rule.label, group: rule.group });
    }
  }
  return out;
}

function normalizeSeriesGenreLabel(raw: string): Array<{ id: string; label: string }> {
  const t = raw.trim();
  if (!t) return [];
  const lower = t.toLowerCase();
  if (lower === 'tv mini series' || lower === 'mini-series') return [];
  if (lower === 'drama and mystery') {
    return [
      { id: 'drama', label: 'Drama' },
      { id: 'mystery', label: 'Mystery' },
    ];
  }
  if (lower === 'animation & kids') {
    return [
      { id: 'animation', label: 'Animation' },
      { id: 'kids', label: 'Kids' },
    ];
  }
  if (lower === 'reality-tv' || lower === 'reality tv' || lower === 'reality') {
    return [{ id: 'reality', label: 'Reality' }];
  }
  if (lower === 'talk show' || lower === 'talk') {
    return [{ id: 'talk', label: 'Talk' }];
  }
  if (lower === 'sci-fi' || lower === 'science fiction' || lower === 'fantasy' || lower === 'sci-fi & fantasy') {
    return [{ id: 'sci-fi-fantasy', label: 'Sci-Fi & Fantasy' }];
  }
  if (lower === 'action' || lower === 'adventure' || lower === 'action & adventure') {
    return [{ id: 'action-adventure', label: 'Action & Adventure' }];
  }
  if (lower === 'animated' || lower === 'anime' || lower === 'animation') {
    return [{ id: 'animation', label: 'Animation' }];
  }
  if (lower === 'war' || lower === 'politics' || lower === 'war & politics') {
    return [{ id: 'war-politics', label: 'War & Politics' }];
  }
  if (lower === 'kids' || lower === 'children') {
    return [{ id: 'kids', label: 'Kids' }];
  }
  if (lower === 'sport' || lower === 'sports') {
    return [{ id: 'sports', label: 'Sports' }];
  }
  const id = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) return [];
  const label = t.replace(/\b\w/g, (ch) => ch.toUpperCase());
  return [{ id, label }];
}

function extractSeriesGenreEntries(series: SeriesSummary): GenreEntry[] {
  const map = new Map<string, GenreEntry>();
  const add = (id: string, label: string, group: 'genre' | 'cinema') => {
    if (!map.has(id)) map.set(id, { id, label, group });
  };

  if (series.genre && series.genre.trim()) {
    for (const part of series.genre.split(/[,/]+/)) {
      for (const norm of normalizeSeriesGenreLabel(part)) {
        add(norm.id, norm.label, 'genre');
      }
    }
  }

  const cat = series.categoryName || '';
  if (/\breality\b/i.test(cat)) add('reality', 'Reality', 'genre');
  if (/\b(cricket|sport|wwe|ufc|fifa)\b/i.test(cat)) add('sports', 'Sports', 'genre');
  if (/\b(kids|cartoon|nick|disney)\b/i.test(cat)) add('kids', 'Kids', 'genre');
  if (/\banime\b/i.test(cat)) add('animation', 'Animation', 'genre');
  if (/\bdocumentar/i.test(cat)) add('documentary', 'Documentary', 'genre');
  if (
    map.size === 0 &&
    /\b(hum tv|geo tv|ary digital|green tv|express tv|urdu 1|aaj|ptv|play entertainment|mun tv|tv one|aplus|aan tv|aur life|star plus|zee tv|colors|sony \(set\)|star bharat|epic tv|asianet)\b/i.test(
      cat,
    )
  ) {
    add('drama', 'Drama', 'genre');
  }
  if (map.size === 0 && /\b(sab|tvf|comedy)\b/i.test(cat)) {
    add('comedy', 'Comedy', 'genre');
  }

  // Regional / Platform cinema collections for broader discovery
  if (/\benglish\b|\bnetflix\b|\bamazon prime\b|\bhbo\b|\bstarz\b|\bhulu\b|\bpeacock\b|\bparamount\b|\bapple\b/i.test(cat)) {
    add('cinema-english', 'English & Streaming', 'cinema');
  }
  if (/\b(hindi|indian|zee5|sony liv|mx player|hotstar|voot|hungama|tvf|jio cinema|colors|star plus|star bharat|zee tv|sab|mtv hindi|asianet)\b/i.test(cat)) {
    add('cinema-indian', 'Indian & Hindi', 'cinema');
  }
  if (/\b(hum tv|geo|ary|green tv|express tv|urdu|ptv|pakistan|mun tv|aan tv|aur life|aplus)\b/i.test(cat)) {
    add('cinema-pakistani', 'Pakistani Dramas', 'cinema');
  }
  if (/\bturkish\b/i.test(cat)) {
    add('cinema-turkish', 'Turkish Series', 'cinema');
  }

  return Array.from(map.values());
}

function buildDynamicGenres<T>(
  items: T[],
  extractor: (item: T) => GenreEntry[],
): { genres: GenreItem[]; itemGenresMap: Map<T, Set<string>> } {
  const counts = new Map<string, GenreItem>();
  const itemGenresMap = new Map<T, Set<string>>();

  for (const item of items) {
    const entries = extractor(item);
    const ids = new Set<string>();
    for (const entry of entries) {
      ids.add(entry.id);
      const existing = counts.get(entry.id);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(entry.id, {
          id: entry.id,
          label: entry.label,
          count: 1,
          group: entry.group,
        });
      }
    }
    itemGenresMap.set(item, ids);
  }

  const genres = Array.from(counts.values())
    .filter((g) => g.count > 0)
    .sort((a, b) => {
      if ((a.group || 'genre') !== (b.group || 'genre')) {
        return a.group === 'genre' ? -1 : 1;
      }
      return b.count - a.count || a.label.localeCompare(b.label);
    });

  return { genres, itemGenresMap };
}

export async function queryMovies(opts: {
  categoryId?: string;
  genre?: string;
  q?: string;
  sort?: 'newest' | 'rating' | 'az';
  page?: number;
  limit?: number;
}): Promise<{
  items: MovieSummary[];
  total: number;
  page: number;
  totalPages: number;
  genres: GenreItem[];
}> {
  const all = await getAllMovies();
  let filtered = all;

  if (opts.categoryId) {
    filtered = filtered.filter((m) => m.categoryId === opts.categoryId);
  }
  if (opts.q && opts.q.trim()) {
    const term = opts.q.trim().toLowerCase();
    filtered = filtered.filter(
      (m) =>
        m.name.toLowerCase().includes(term) ||
        m.categoryName.toLowerCase().includes(term),
    );
  }

  // Deduplicate multi-language / duplicate editions so each title appears only once
  const unique = dedupeMovies(filtered);
  const { genres, itemGenresMap } = buildDynamicGenres(unique, extractMovieGenreEntries);

  const selectedGenre = (opts.genre || '').trim().toLowerCase();
  const genreFiltered = selectedGenre
    ? unique.filter((m) => itemGenresMap.get(m)?.has(selectedGenre))
    : unique;

  const sorted = [...genreFiltered];
  const sort = opts.sort || 'newest';
  if (sort === 'newest') {
    sorted.sort((a, b) => b.added - a.added);
  } else if (sort === 'rating') {
    sorted.sort((a, b) => b.rating - a.rating || b.added - a.added);
  } else if (sort === 'az') {
    sorted.sort((a, b) => a.cleanTitle.localeCompare(b.cleanTitle));
  }

  const limit = Math.max(1, Math.min(100, opts.limit || 36));
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.max(1, Math.min(totalPages, opts.page || 1));
  const start = (page - 1) * limit;

  return {
    items: sorted.slice(start, start + limit),
    total,
    page,
    totalPages,
    genres,
  };
}

export async function querySeries(opts: {
  categoryId?: string;
  genre?: string;
  q?: string;
  sort?: 'newest' | 'rating' | 'az';
  page?: number;
  limit?: number;
}): Promise<{
  items: SeriesSummary[];
  total: number;
  page: number;
  totalPages: number;
  genres: GenreItem[];
}> {
  const all = await getAllSeries();
  let filtered = all;

  if (opts.categoryId) {
    filtered = filtered.filter((s) => s.categoryId === opts.categoryId);
  }
  if (opts.q && opts.q.trim()) {
    const term = opts.q.trim().toLowerCase();
    filtered = filtered.filter(
      (s) =>
        s.name.toLowerCase().includes(term) ||
        s.genre.toLowerCase().includes(term) ||
        s.categoryName.toLowerCase().includes(term),
    );
  }

  // Deduplicate multi-language / duplicate editions so each series appears only once
  const unique = dedupeSeries(filtered);
  const { genres, itemGenresMap } = buildDynamicGenres(unique, extractSeriesGenreEntries);

  const selectedGenre = (opts.genre || '').trim().toLowerCase();
  const genreFiltered = selectedGenre
    ? unique.filter((s) => itemGenresMap.get(s)?.has(selectedGenre))
    : unique;

  const sorted = [...genreFiltered];
  const sort = opts.sort || 'newest';
  if (sort === 'newest') {
    sorted.sort((a, b) => b.lastModified - a.lastModified);
  } else if (sort === 'rating') {
    sorted.sort((a, b) => b.rating - a.rating || b.lastModified - a.lastModified);
  } else if (sort === 'az') {
    sorted.sort((a, b) => a.cleanTitle.localeCompare(b.cleanTitle));
  }

  const limit = Math.max(1, Math.min(100, opts.limit || 36));
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.max(1, Math.min(totalPages, opts.page || 1));
  const start = (page - 1) * limit;

  return {
    items: sorted.slice(start, start + limit),
    total,
    page,
    totalPages,
    genres,
  };
}

const LIVE_GENRE_RULES: Array<{
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

function extractLiveGenreEntries(channel: LiveChannelSummary): GenreEntry[] {
  const out: GenreEntry[] = [];
  const cat = channel.categoryName || '';
  const name = channel.name || '';
  for (const rule of LIVE_GENRE_RULES) {
    const hitCat = rule.catRx ? rule.catRx.test(cat) : false;
    const hitName = rule.nameRx ? rule.nameRx.test(name) : false;
    if (hitCat || hitName) {
      out.push({ id: rule.id, label: rule.label, group: rule.group });
    }
  }
  return out;
}

export async function queryLiveChannels(opts: {
  categoryId?: string;
  genre?: string;
  q?: string;
  hasEpg?: boolean;
  hasCatchup?: boolean;
  page?: number;
  limit?: number;
}): Promise<{
  items: LiveChannelSummary[];
  total: number;
  page: number;
  totalPages: number;
  genres: GenreItem[];
}> {
  warmChannelLogoIndex();
  const all = await getAllLiveChannels();
  let filtered = all;

  if (opts.categoryId) {
    filtered = filtered.filter((c) => c.categoryId === opts.categoryId);
  }
  if (opts.hasEpg) {
    filtered = filtered.filter((c) => Boolean(c.epgChannelId));
  }
  if (opts.hasCatchup) {
    filtered = filtered.filter((c) => c.hasArchive);
  }
  if (opts.q && opts.q.trim()) {
    const term = opts.q.trim().toLowerCase();
    filtered = filtered.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        c.categoryName.toLowerCase().includes(term),
    );
  }

  const { genres, itemGenresMap } = buildDynamicGenres(filtered, extractLiveGenreEntries);
  const selectedGenre = (opts.genre || '').trim().toLowerCase();
  const genreFiltered = selectedGenre
    ? filtered.filter((c) => itemGenresMap.get(c)?.has(selectedGenre))
    : filtered;

  const limit = Math.max(1, Math.min(100, opts.limit || 48));
  const total = genreFiltered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.max(1, Math.min(totalPages, opts.page || 1));
  const start = (page - 1) * limit;
  const slice = genreFiltered.slice(start, start + limit);

  // Enrich channels that have an epgChannelId with quick now-playing status (max 12 concurrent)
  const account = await getAccountSummary().catch(() => null);
  const nowSec = account?.serverTimestamp || Math.floor(Date.now() / 1000);

  const epgTargets = slice.filter((ch) => ch.epgChannelId).slice(0, 16);
  const epgMap = new Map<string, EpgProgram[]>();
  await mapWithConcurrency(epgTargets, 6, async (ch) => {
    const list = await getChannelEpg(ch.streamId, nowSec).catch(() => []);
    epgMap.set(ch.streamId, list);
  });

  const enriched = slice.map((ch) => {
    const fallbackLogo = !ch.logo ? lookupChannelLogoSync(ch.name, ch.categoryName) : null;
    const resolvedLogo = ch.logo || fallbackLogo || '';
    const programs = epgMap.get(ch.streamId);
    if (!programs || programs.length === 0) {
      return resolvedLogo !== ch.logo ? { ...ch, logo: resolvedLogo } : ch;
    }
    const currentIdx = programs.findIndex(
      (p) => p.startTimestamp <= nowSec && p.stopTimestamp > nowSec,
    );
    const nowPlaying = currentIdx >= 0 ? programs[currentIdx] : null;
    const nextProgram =
      currentIdx >= 0 && currentIdx + 1 < programs.length
        ? programs[currentIdx + 1]
        : programs.find((p) => p.startTimestamp > nowSec) || null;
    return { ...ch, logo: resolvedLogo, nowPlaying, nextProgram };
  });

  return {
    items: enriched,
    total,
    page,
    totalPages,
    genres,
  };
}

export async function getMovieDetail(
  streamId: string,
  opts?: { includeRelated?: boolean },
): Promise<MovieDetail> {
  if (!/^\d+$/.test(streamId)) {
    throw new Error('Invalid movie ID.');
  }

  const allMovies = await getAllMovies();
  const detail = await cachedFetch(`vod_detail_${streamId}`, DETAIL_TTL_MS, async () => {
    const raw = await xtreamJson<{ info?: Record<string, unknown>; movie_data?: Record<string, unknown> }>(
      'get_vod_info',
      { vod_id: streamId },
    );

    const summary = allMovies.find((m) => m.streamId === streamId);
    const info = raw.info || {};
    const data = raw.movie_data || {};
    const name = String(data.name || info.name || summary?.name || `Movie #${streamId}`);
    const meta = parseTitleMeta(name);
    const ext = String(data.container_extension || summary?.extension || 'mp4').toLowerCase();
    const backdrops = Array.isArray(info.backdrop_path) ? info.backdrop_path : [];
    const poster =
      normalizeImageUrl(info.cover_big) ||
      normalizeImageUrl(info.movie_image) ||
      summary?.poster ||
      '';
    const backdrop = normalizeImageUrl(backdrops[0]) || poster;
    const runtimeRaw = String(info.duration || info.episode_run_time || '').trim();
    const duration =
      runtimeRaw && /^\d+$/.test(runtimeRaw) ? `${runtimeRaw} min` : runtimeRaw || '';

    return {
      streamId,
      name,
      cleanTitle: meta.cleanTitle,
      year:
        meta.year ||
        (typeof info.releasedate === 'string' && info.releasedate.slice(0, 4)) ||
        summary?.year ||
        null,
      qualityTag: meta.qualityTag || summary?.qualityTag || null,
      poster,
      backdrop,
      rating: parseRating(info.rating, info.rating_5based) || summary?.rating || 0,
      added: Number(data.added || summary?.added || 0),
      categoryId: String(data.category_id || summary?.categoryId || ''),
      categoryName: summary?.categoryName || 'Movies',
      extension: ext,
      plot: String(info.plot || info.description || ''),
      cast: String(info.actors || info.cast || ''),
      director: String(info.director || ''),
      genre: String(info.genre || ''),
      releaseDate: String(info.releasedate || ''),
      duration,
      youtubeTrailer: String(info.youtube_trailer || '').trim(),
      tmdbId: String(info.tmdb_id || info.imdb_id || '').trim(),
      playUrl: `/api/play/vod/${streamId}.${ext}`,
    };
  });

  if (opts?.includeRelated === false) {
    return detail;
  }

  return {
    ...detail,
    related: findRelatedMovies(detail, allMovies, 18),
  };
}

export async function getSeriesDetail(
  seriesId: string,
  opts?: { includeRelated?: boolean },
): Promise<SeriesDetail> {
  if (!/^\d+$/.test(seriesId)) {
    throw new Error('Invalid series ID.');
  }

  const allSeries = await getAllSeries();
  const detail = await cachedFetch(`series_detail_${seriesId}`, DETAIL_TTL_MS, async () => {
    const raw = await xtreamJson<{
      seasons?: Array<Record<string, unknown>>;
      info?: Record<string, unknown>;
      episodes?: Record<string, Array<Record<string, unknown>>>;
    }>('get_series_info', { series_id: seriesId });

    const summary = allSeries.find((s) => s.seriesId === seriesId);
    const info = raw.info || {};
    const name = String(info.name || summary?.name || `Series #${seriesId}`);
    const meta = parseTitleMeta(name);
    const backdrops = Array.isArray(info.backdrop_path) ? info.backdrop_path : [];
    const poster = normalizeImageUrl(info.cover) || summary?.poster || '';
    const backdrop = normalizeImageUrl(backdrops[0]) || summary?.backdrop || poster;

    const rawEpisodes = raw.episodes || {};
    const episodesBySeason: Record<string, EpisodeSummary[]> = {};
    const seasonKeys = Object.keys(rawEpisodes).sort((a, b) => Number(a) - Number(b));

    for (const sKey of seasonKeys) {
      const list = Array.isArray(rawEpisodes[sKey]) ? rawEpisodes[sKey] : [];
      episodesBySeason[sKey] = list.map((ep, idx) => {
        const epId = String(ep.id ?? '').trim();
        const epInfo = (ep.info as Record<string, unknown>) || {};
        const ext = String(ep.container_extension || 'mp4').toLowerCase();
        const epNum = Number(ep.episode_num || idx + 1);
        const durSec = Number(epInfo.duration_secs || 0);
        const durText =
          String(epInfo.duration || '').trim() ||
          (durSec > 0 ? `${Math.round(durSec / 60)}m` : '');

        return {
          episodeId: epId,
          episodeNum: epNum,
          seasonNum: Number(ep.season || sKey) || Number(sKey) || 1,
          title: String(ep.title || `Episode ${epNum}`),
          plot: String(epInfo.plot || ''),
          duration: durText,
          durationSec: durSec,
          thumbnail: normalizeImageUrl(epInfo.movie_image) || backdrop || poster,
          rating: parseRating(epInfo.rating),
          extension: ext,
          playUrl: `/api/play/series/${epId}.${ext}`,
        };
      });
    }

    const rawSeasons = Array.isArray(raw.seasons) ? raw.seasons : [];
    const seasons: SeasonSummary[] =
      rawSeasons.length > 0
        ? rawSeasons.map((s, idx) => {
            const num = Number(s.season_number ?? idx + 1);
            const eps = episodesBySeason[String(num)] || [];
            return {
              seasonNumber: num,
              name: String(s.name || `Season ${num}`),
              episodeCount: Number(s.episode_count || eps.length),
              cover: normalizeImageUrl(s.cover_big || s.cover) || poster,
              airDate: String(s.air_date || ''),
            };
          })
        : seasonKeys.map((k) => ({
            seasonNumber: Number(k),
            name: `Season ${k}`,
            episodeCount: (episodesBySeason[k] || []).length,
            cover: poster,
            airDate: '',
          }));

    return {
      seriesId,
      name,
      cleanTitle: meta.cleanTitle,
      year:
        meta.year ||
        (typeof info.releaseDate === 'string' && info.releaseDate.slice(0, 4)) ||
        summary?.year ||
        null,
      poster,
      backdrop,
      plot: String(info.plot || summary?.plot || ''),
      genre: String(info.genre || summary?.genre || ''),
      releaseDate: String(info.releaseDate || summary?.releaseDate || ''),
      rating: parseRating(info.rating, info.rating_5based) || summary?.rating || 0,
      lastModified: Number(info.last_modified || summary?.lastModified || 0),
      categoryId: String(info.category_id || summary?.categoryId || ''),
      categoryName: summary?.categoryName || 'Series',
      cast: String(info.cast || ''),
      director: String(info.director || ''),
      youtubeTrailer: String(info.youtube_trailer || '').trim(),
      episodeRunTime: String(info.episode_run_time || ''),
      tmdbId: String(info.tmdb_id || info.imdb_id || '').trim(),
      seasons,
      episodesBySeason,
    };
  });

  if (opts?.includeRelated === false) {
    return detail;
  }

  return {
    ...detail,
    related: findRelatedSeries(detail, allSeries, 18),
  };
}

export async function getChannelEpg(
  streamId: string,
  serverNowSec?: number,
): Promise<EpgProgram[]> {
  if (!/^\d+$/.test(streamId)) return [];

  const emptyAt = emptyEpgStreams.get(streamId);
  if (emptyAt && emptyAt > Date.now()) {
    return [];
  }

  return cachedFetch(`epg_table_${streamId}`, EPG_TTL_MS, async () => {
    const raw = await xtreamJson<{ epg_listings?: Array<Record<string, unknown>> }>(
      'get_simple_data_table',
      { stream_id: streamId },
    );

    const listings = Array.isArray(raw?.epg_listings) ? raw.epg_listings : [];
    if (listings.length === 0) {
      emptyEpgStreams.set(streamId, Date.now() + EMPTY_EPG_TTL_MS);
      return [];
    }

    const now = serverNowSec || Math.floor(Date.now() / 1000);
    const parsed: EpgProgram[] = [];

    for (const item of listings) {
      const startTs = Number(item.start_timestamp || 0);
      const stopTs = Number(item.stop_timestamp || 0);
      if (!startTs || !stopTs || stopTs <= startTs) continue;

      const title = decodeBase64Utf8(item.title) || 'Untitled Broadcast';
      const description = decodeBase64Utf8(item.description);
      const isNowPlaying =
        Number(item.now_playing) === 1 || (startTs <= now && stopTs > now);
      const hasArchive = Number(item.has_archive) === 1;
      const archiveDurationMin = Math.max(
        1,
        Math.round((stopTs - startTs) / 60),
      );

      parsed.push({
        id: String(item.id || `${streamId}_${startTs}`),
        title,
        description,
        startTimestamp: startTs,
        stopTimestamp: stopTs,
        startLabel: formatUnixClock(startTs),
        stopLabel: formatUnixClock(stopTs),
        isNowPlaying,
        hasArchive,
        archiveDurationMin,
      });
    }

    parsed.sort((a, b) => a.startTimestamp - b.startTimestamp);
    return parsed;
  });
}

export async function getLiveChannelDetail(
  streamId: string,
): Promise<LiveChannelDetailResponse> {
  if (!/^\d+$/.test(streamId)) {
    throw new Error('Invalid live channel ID.');
  }

  const [allChannels, account] = await Promise.all([
    getAllLiveChannels(),
    getAccountSummary().catch(() => null),
  ]);

  const channel = allChannels.find((c) => c.streamId === streamId);
  if (!channel) {
    throw new Error('Live channel not found.');
  }

  const serverTimestamp = account?.serverTimestamp || Math.floor(Date.now() / 1000);
  const rawPrograms = await getChannelEpg(streamId, serverTimestamp).catch(() => []);
  const programs = rawPrograms.map((p) => ({
    ...p,
    isNowPlaying: p.startTimestamp <= serverTimestamp && p.stopTimestamp > serverTimestamp,
  }));

  const currentIdx = programs.findIndex((p) => p.isNowPlaying);
  const nowPlaying = currentIdx >= 0 ? programs[currentIdx] : null;
  const nextProgram =
    currentIdx >= 0 && currentIdx + 1 < programs.length
      ? programs[currentIdx + 1]
      : programs.find((p) => p.startTimestamp > serverTimestamp) || null;

  const baseRelated = findRelatedLiveChannels(channel, allChannels, 12);
  const related = await enrichLiveRecommendationsWithEpg(baseRelated, serverTimestamp);

  return {
    channel: { ...channel, nowPlaying, nextProgram },
    programs,
    related,
    serverTimestamp,
  };
}

export async function getEpgGuide(opts: {
  categoryId?: string;
  q?: string;
  catchupOnly?: boolean;
  windowOffsetHours?: number;
  windowHours?: number;
  page?: number;
  limit?: number;
}): Promise<EpgGuideResponse> {
  warmChannelLogoIndex();
  const [allChannels, account] = await Promise.all([
    getAllLiveChannels(),
    getAccountSummary().catch(() => null),
  ]);

  const serverNow = account?.serverTimestamp || Math.floor(Date.now() / 1000);
  const offsetHours = Math.max(-24, Math.min(24, opts.windowOffsetHours || 0));
  const spanHours = Math.max(4, Math.min(24, opts.windowHours || 6));
  // Align window start to nearest 30-min boundary - 1h + offset
  const baseHalfHour = Math.floor(serverNow / 1800) * 1800;
  const windowStart = baseHalfHour - 3600 + offsetHours * 3600;
  const windowEnd = windowStart + spanHours * 3600;

  const totalEpgChannels = allChannels.filter((c) => Boolean(c.epgChannelId)).length;

  let pool = allChannels;
  if (opts.categoryId) {
    pool = pool.filter((c) => c.categoryId === opts.categoryId);
  }
  if (opts.catchupOnly) {
    pool = pool.filter((c) => c.hasArchive);
  }
  if (opts.q && opts.q.trim()) {
    const term = opts.q.trim().toLowerCase();
    pool = pool.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        c.categoryName.toLowerCase().includes(term),
    );
  } else {
    // When browsing full TV guide without text search, show channels with EPG IDs first
    const withEpg = pool.filter(
      (c) => Boolean(c.epgChannelId) && (emptyEpgStreams.get(c.streamId) || 0) <= Date.now(),
    );
    if (withEpg.length > 0) {
      pool = withEpg;
    }
  }

  const limit = Math.max(1, Math.min(30, opts.limit || 18));
  const totalMatchingChannels = pool.length;
  const totalPages = Math.max(1, Math.ceil(totalMatchingChannels / limit));
  const page = Math.max(1, Math.min(totalPages, opts.page || 1));
  const start = (page - 1) * limit;
  const slice = pool.slice(start, start + limit);

  const guides: EpgChannelGuide[] = await mapWithConcurrency(slice, 8, async (ch) => {
    const fallbackLogo = !ch.logo ? lookupChannelLogoSync(ch.name, ch.categoryName) : null;
    const channelWithLogo = !ch.logo && fallbackLogo ? { ...ch, logo: fallbackLogo } : ch;
    if (!ch.epgChannelId) {
      return { channel: channelWithLogo, programs: [] };
    }
    const allPrograms = await getChannelEpg(ch.streamId, serverNow).catch(() => []);
    const visible = allPrograms
      .filter((p) => p.stopTimestamp > windowStart && p.startTimestamp < windowEnd)
      .map((p) => ({
        ...p,
        isNowPlaying: p.startTimestamp <= serverNow && p.stopTimestamp > serverNow,
      }));
    const nowPlaying =
      allPrograms.find((p) => p.startTimestamp <= serverNow && p.stopTimestamp > serverNow) || null;
    return {
      channel: { ...channelWithLogo, nowPlaying },
      programs: visible,
    };
  });

  return {
    channels: guides,
    totalEpgChannels,
    totalMatchingChannels,
    page,
    totalPages,
    serverTimestamp: serverNow,
    windowStart,
    windowEnd,
  };
}

export async function getHomePayload(): Promise<HomePayload> {
  return cachedFetch('home_payload', 10 * 60 * 1000, async () => {
    const [allMovies, allSeries, allLive, account] = await Promise.all([
      getAllMovies(),
      getAllSeries(),
      getAllLiveChannels(),
      getAccountSummary().catch(() => null),
    ]);

    const serverNow = account?.serverTimestamp || Math.floor(Date.now() / 1000);

    // Deduplicate multi-language movies & series for clean non-repetitive showcase
    const uniqueMovies = dedupeMovies(allMovies);
    const uniqueSeries = dedupeSeries(allSeries);

    // Pick crisp, high-rated, recent non-CAM movies with posters for hero & trending
    const qualityMovies = uniqueMovies.filter(
      (m) =>
        Boolean(m.poster) &&
        !/\b(CAM|HDCAM|TS|HDTS)\b/i.test(m.name) &&
        m.rating >= 6.4,
    );

    const recentQuality = [...qualityMovies].sort((a, b) => b.added - a.added);
    const topRatedQuality = [...qualityMovies].sort(
      (a, b) => b.rating - a.rating || b.added - a.added,
    );

    // Prioritize English / Global 4K / FHD recent releases for hero spotlight
    const spotlightCandidates = recentQuality
      .filter((m) => /ENGLISH|4K|FHD|HOLLYWOOD/i.test(m.categoryName))
      .slice(0, 6);
    const fallbackCandidates = recentQuality.slice(0, 6);
    const heroSource =
      spotlightCandidates.length >= 4 ? spotlightCandidates : fallbackCandidates;

    const heroDetailsRaw = await mapWithConcurrency(heroSource.slice(0, 5), 5, async (m) => {
      try {
        return await getMovieDetail(m.streamId, { includeRelated: false });
      } catch {
        return null;
      }
    });
    const heroItems = heroDetailsRaw.filter((d): d is MovieDetail => d !== null);

    // Trending movies (diverse top recent + top rated)
    const trendingMovies = recentQuality.slice(0, 18);
    if (trendingMovies.length < 18) {
      for (const m of topRatedQuality) {
        if (trendingMovies.length >= 18) break;
        if (!trendingMovies.some((x) => x.streamId === m.streamId)) {
          trendingMovies.push(m);
        }
      }
    }

    // Popular series with posters
    const popularSeries = uniqueSeries
      .filter((s) => Boolean(s.poster))
      .sort((a, b) => b.rating - a.rating || b.lastModified - a.lastModified)
      .slice(0, 18);

    // Featured Live channels (prioritize channels with logos + EPG)
    const epgCandidates = allLive
      .filter((c) => Boolean(c.epgChannelId) && Boolean(c.logo))
      .slice(0, 24);
    const backupLive = allLive.filter((c) => Boolean(c.epgChannelId)).slice(0, 24);
    const livePool = epgCandidates.length >= 12 ? epgCandidates : backupLive;

    const featuredEnriched = await mapWithConcurrency(livePool.slice(0, 16), 6, async (ch) => {
      const programs = await getChannelEpg(ch.streamId, serverNow).catch(() => []);
      const nowPlaying =
        programs.find((p) => p.startTimestamp <= serverNow && p.stopTimestamp > serverNow) || null;
      const nextProgram =
        programs.find((p) => p.startTimestamp > serverNow) || null;
      return { ...ch, nowPlaying, nextProgram };
    });

    // Prefer channels that actually returned live EPG data first
    featuredEnriched.sort((a, b) => Number(Boolean(b.nowPlaying)) - Number(Boolean(a.nowPlaying)));
    const featuredLive = featuredEnriched.slice(0, 12);

    const stats: CatalogStats = {
      movieCount: uniqueMovies.length,
      seriesCount: uniqueSeries.length,
      liveCount: allLive.length,
      epgChannelCount: allLive.filter((c) => Boolean(c.epgChannelId)).length,
      catchupCount: allLive.filter((c) => c.hasArchive).length,
    };

    return {
      heroItems,
      trendingMovies,
      popularSeries,
      featuredLive,
      stats,
    };
  });
}

function normalizeCreditMatchTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[’'`".,:;!?&+_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCachedPersonDetailMatches(personName: string): {
  movieIds: Set<string>;
  seriesIds: Set<string>;
} {
  const movieIds = new Set<string>();
  const seriesIds = new Set<string>();
  const needle = personName.trim().toLowerCase();
  if (needle.length < 3) return { movieIds, seriesIds };

  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) continue;
    if (key.startsWith('vod_detail_')) {
      const detail = entry.value as MovieDetail | undefined;
      if (!detail) continue;
      const hay = `${detail.cast || ''} ${detail.director || ''}`.toLowerCase();
      if (hay.includes(needle)) {
        movieIds.add(detail.streamId);
      }
    } else if (key.startsWith('series_detail_')) {
      const detail = entry.value as SeriesDetail | undefined;
      if (!detail) continue;
      const hay = `${detail.cast || ''} ${detail.director || ''} ${detail.plot || ''}`.toLowerCase();
      if (hay.includes(needle)) {
        seriesIds.add(detail.seriesId);
      }
    }
  }

  return { movieIds, seriesIds };
}

function computeSearchScore(
  tokens: string[],
  fullTerm: string,
  primaryTitle: string,
  rawName: string,
  categoryName: string,
  extraFields: string[],
  cachedMatch: boolean,
): number {
  const titleLower = primaryTitle.toLowerCase();
  const rawLower = rawName.toLowerCase();
  const catLower = categoryName.toLowerCase();
  const combinedExtra = extraFields.join(' ').toLowerCase();

  let score = 0;
  if (titleLower === fullTerm) score += 120;
  else if (titleLower.startsWith(fullTerm)) score += 90;
  else if (titleLower.includes(fullTerm)) score += 65;
  else if (rawLower.includes(fullTerm)) score += 48;

  let matchedAllTokens = true;
  let tokenScore = 0;
  for (const tok of tokens) {
    if (titleLower.includes(tok)) {
      tokenScore += titleLower.startsWith(tok) ? 18 : 14;
    } else if (rawLower.includes(tok)) {
      tokenScore += 10;
    } else if (catLower.includes(tok) || combinedExtra.includes(tok)) {
      tokenScore += 6;
    } else {
      matchedAllTokens = false;
      break;
    }
  }

  if (matchedAllTokens && tokens.length > 0) {
    score += tokenScore;
  }

  if (cachedMatch) {
    score += 32;
  }

  return matchedAllTokens || cachedMatch ? score : 0;
}

export async function omniSearch(q: string): Promise<{
  movies: MovieSummary[];
  series: SeriesSummary[];
  live: LiveChannelSummary[];
}> {
  const term = q.trim().toLowerCase();
  if (!term) {
    return { movies: [], series: [], live: [] };
  }

  const tokens = term.split(/\s+/).filter(Boolean);
  const [allMovies, allSeries, allLive] = await Promise.all([
    getAllMovies(),
    getAllSeries(),
    getAllLiveChannels(),
  ]);

  const cachedMatches = getCachedPersonDetailMatches(term);

  const scoredMovies: Array<{ item: MovieSummary; score: number }> = [];
  for (const m of allMovies) {
    const score = computeSearchScore(
      tokens,
      term,
      m.cleanTitle || m.name,
      m.name,
      m.categoryName || '',
      [m.year || ''],
      cachedMatches.movieIds.has(m.streamId),
    );
    if (score > 0) scoredMovies.push({ item: m, score });
  }
  scoredMovies.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.rating - a.item.rating ||
      b.item.added - a.item.added,
  );
  const movies = dedupeMovies(scoredMovies.map((x) => x.item)).slice(0, 24);

  const scoredSeries: Array<{ item: SeriesSummary; score: number }> = [];
  for (const s of allSeries) {
    const score = computeSearchScore(
      tokens,
      term,
      s.cleanTitle || s.name,
      s.name,
      s.categoryName || '',
      [s.genre || '', s.year || ''],
      cachedMatches.seriesIds.has(s.seriesId),
    );
    if (score > 0) scoredSeries.push({ item: s, score });
  }
  scoredSeries.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.rating - a.item.rating ||
      b.item.lastModified - a.item.lastModified,
  );
  const series = dedupeSeries(scoredSeries.map((x) => x.item)).slice(0, 24);

  const scoredLive: Array<{ item: LiveChannelSummary; score: number }> = [];
  for (const c of allLive) {
    const score = computeSearchScore(
      tokens,
      term,
      c.name,
      c.name,
      c.categoryName || '',
      [c.nowPlaying?.title || ''],
      false,
    );
    if (score > 0) scoredLive.push({ item: c, score });
  }
  scoredLive.sort((a, b) => b.score - a.score || a.item.num - b.item.num);
  const live = scoredLive.map((x) => x.item).slice(0, 24);

  return { movies, series, live };
}

export async function searchByPerson(opts: {
  name: string;
  imdbId?: string;
  excludeKind?: 'movie' | 'series';
  excludeId?: string;
}): Promise<{
  personName: string;
  movies: MovieSummary[];
  series: SeriesSummary[];
  live: LiveChannelSummary[];
  matchedTitlesCount: number;
}> {
  const cleanName = opts.name.trim();
  if (!cleanName) {
    return { personName: '', movies: [], series: [], live: [], matchedTitlesCount: 0 };
  }

  const [allMovies, allSeries, allLive, filmographyTitles] = await Promise.all([
    getAllMovies(),
    getAllSeries(),
    getAllLiveChannels(),
    getPersonFilmographyTitles(cleanName, opts.imdbId),
  ]);

  const normalizedCredits = new Set<string>();
  for (const title of filmographyTitles) {
    const norm = normalizeCreditMatchTitle(title);
    if (norm.length >= 2) {
      normalizedCredits.add(norm);
    }
  }

  const cachedMatches = getCachedPersonDetailMatches(cleanName);
  const nameLower = cleanName.toLowerCase();

  const rawMatchedMovies = allMovies.filter((m) => {
    if (opts.excludeKind === 'movie' && opts.excludeId && m.streamId === opts.excludeId) {
      return false;
    }
    if (cachedMatches.movieIds.has(m.streamId)) return true;
    if (nameLower.length >= 4 && m.name.toLowerCase().includes(nameLower)) return true;
    const norm = normalizeCreditMatchTitle(m.cleanTitle || m.name);
    return norm.length >= 2 && normalizedCredits.has(norm);
  });

  const rawMatchedSeries = allSeries.filter((s) => {
    if (opts.excludeKind === 'series' && opts.excludeId && s.seriesId === opts.excludeId) {
      return false;
    }
    if (cachedMatches.seriesIds.has(s.seriesId)) return true;
    if (nameLower.length >= 4 && s.name.toLowerCase().includes(nameLower)) return true;
    const norm = normalizeCreditMatchTitle(s.cleanTitle || s.name);
    return norm.length >= 2 && normalizedCredits.has(norm);
  });

  const movies = dedupeMovies(rawMatchedMovies)
    .sort((a, b) => b.rating - a.rating || b.added - a.added)
    .slice(0, 24);

  const series = dedupeSeries(rawMatchedSeries)
    .sort((a, b) => b.rating - a.rating || b.lastModified - a.lastModified)
    .slice(0, 24);

  const live =
    nameLower.length >= 4
      ? allLive.filter((c) => c.name.toLowerCase().includes(nameLower)).slice(0, 8)
      : [];

  return {
    personName: cleanName,
    movies,
    series,
    live,
    matchedTitlesCount: filmographyTitles.length,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const KNOWN_LANGUAGE_MAP: Record<string, string> = {
  english: 'English',
  eng: 'English',
  hindi: 'Hindi',
  hin: 'Hindi',
  tamil: 'Tamil',
  tam: 'Tamil',
  telugu: 'Telugu',
  tel: 'Telugu',
  malayalam: 'Malayalam',
  mal: 'Malayalam',
  kannada: 'Kannada',
  kan: 'Kannada',
  punjabi: 'Punjabi',
  pan: 'Punjabi',
  bangla: 'Bangla',
  bengali: 'Bangla',
  ben: 'Bangla',
  gujarati: 'Gujarati',
  guj: 'Gujarati',
  marathi: 'Marathi',
  mar: 'Marathi',
  urdu: 'Urdu',
  urd: 'Urdu',
  bhojpuri: 'Bhojpuri',
  turkish: 'Turkish',
  tur: 'Turkish',
  spanish: 'Spanish',
  spa: 'Spanish',
  espanol: 'Spanish',
  latino: 'Spanish',
  castellano: 'Spanish',
  french: 'French',
  fre: 'French',
  fra: 'French',
  german: 'German',
  ger: 'German',
  deu: 'German',
  deutsch: 'German',
  italian: 'Italian',
  ita: 'Italian',
  portuguese: 'Portuguese',
  por: 'Portuguese',
  dublado: 'Portuguese',
  arabic: 'Arabic',
  ara: 'Arabic',
  persian: 'Persian',
  farsi: 'Persian',
  per: 'Persian',
  fas: 'Persian',
  korean: 'Korean',
  kor: 'Korean',
  japanese: 'Japanese',
  jpn: 'Japanese',
  chinese: 'Chinese',
  chi: 'Chinese',
  zho: 'Chinese',
  mandarin: 'Chinese',
  cantonese: 'Chinese',
  russian: 'Russian',
  rus: 'Russian',
  indonesian: 'Indonesian',
  ind: 'Indonesian',
  thai: 'Thai',
  tha: 'Thai',
  vietnamese: 'Vietnamese',
  vie: 'Vietnamese',
  dutch: 'Dutch',
  dut: 'Dutch',
  nld: 'Dutch',
  polish: 'Polish',
  pol: 'Polish',
  swedish: 'Swedish',
  swe: 'Swedish',
  norwegian: 'Norwegian',
  nor: 'Norwegian',
  danish: 'Danish',
  dan: 'Danish',
  finnish: 'Finnish',
  fin: 'Finnish',
  greek: 'Greek',
  gre: 'Greek',
  ell: 'Greek',
  hebrew: 'Hebrew',
  heb: 'Hebrew',
  tagalog: 'Tagalog',
  filipino: 'Tagalog',
  tgl: 'Tagalog',
  malay: 'Malay',
  may: 'Malay',
  msa: 'Malay',
};

const LANGUAGE_MODIFIERS = new Set([
  'dub',
  'dubbed',
  'audio',
  'sub',
  'subs',
  'subbed',
  'subtitle',
  'subtitles',
  'dual',
  'multi',
  'original',
  'version',
  'lang',
]);

const QUALITY_AND_NOISE_TAG_REGEX =
  /^(?:cam|hdcam|ts|hdts|4k|uhd|fhd|hd|sd|2160p|1080p|720p|480p|new|hevc|x265|x264|webrip|bluray|hdr)$/i;

function parseLanguageTokens(rawInner: string): string | null {
  const normalized = rawInner.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;

  // Handle "Dual Audio" / "Multi Audio"
  if (/^dual[\s-]+audio$/i.test(normalized)) return 'Dual Audio';
  if (/^multi[\s-]+audio$/i.test(normalized)) return 'Multi Audio';

  // Check tokens separated by commas, slashes, pluses, or ampersands
  const segments = normalized
    .split(/[,/+&]+|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === 0) return null;

  const detected: string[] = [];
  let hasSubModifier = false;

  for (const seg of segments) {
    const words = seg.toLowerCase().split(/[\s-]+/).filter(Boolean);
    if (words.length === 0) continue;

    let matchedLang: string | null = null;
    let allRecognized = true;

    for (const w of words) {
      if (KNOWN_LANGUAGE_MAP[w]) {
        matchedLang = KNOWN_LANGUAGE_MAP[w];
      } else if (w === 'sub' || w === 'subs' || w === 'subbed' || w === 'subtitle' || w === 'subtitles') {
        hasSubModifier = true;
      } else if (LANGUAGE_MODIFIERS.has(w)) {
        // modifier recognized
      } else {
        allRecognized = false;
        break;
      }
    }

    if (!allRecognized || !matchedLang) {
      return null;
    }

    if (!detected.includes(matchedLang)) {
      detected.push(matchedLang);
    }
  }

  if (detected.length === 0) return null;
  if (detected.length === 1) {
    return hasSubModifier ? `${detected[0]} Sub` : detected[0];
  }
  return detected.join(' / ');
}

function inferLanguageFromCategory(categoryName: string): string {
  const upper = categoryName.trim();
  if (!upper) return 'Original';

  const dubbedMatch = upper.match(
    /\b(hindi|tamil|telugu|malayalam|kannada|punjabi|bangla|bengali|urdu|marathi|gujarati|turkish|spanish|french|arabic|english)\s+dubbed\b/i,
  );
  if (dubbedMatch) {
    const key = dubbedMatch[1].toLowerCase();
    return KNOWN_LANGUAGE_MAP[key] || dubbedMatch[1];
  }

  // Match leading category segment before | / -
  const lead = upper.split(/[|/-]/)[0]?.trim() || '';
  const leadWords = lead.toLowerCase().split(/\s+/).filter(Boolean);
  for (const w of leadWords) {
    if (KNOWN_LANGUAGE_MAP[w]) {
      return KNOWN_LANGUAGE_MAP[w];
    }
  }
  if (leadWords.includes('bollywood')) return 'Hindi';

  return 'Original';
}

const PREFIX_LANG_CODES: Record<string, string> = {
  en: 'English',
  eng: 'English',
  english: 'English',
  hi: 'Hindi',
  hin: 'Hindi',
  hindi: 'Hindi',
  ta: 'Tamil',
  tam: 'Tamil',
  tamil: 'Tamil',
  te: 'Telugu',
  tel: 'Telugu',
  telugu: 'Telugu',
  ml: 'Malayalam',
  mal: 'Malayalam',
  malayalam: 'Malayalam',
  kn: 'Kannada',
  kan: 'Kannada',
  kannada: 'Kannada',
  pa: 'Punjabi',
  pan: 'Punjabi',
  pun: 'Punjabi',
  punjabi: 'Punjabi',
  bn: 'Bangla',
  ben: 'Bangla',
  bangla: 'Bangla',
  bengali: 'Bangla',
  ur: 'Urdu',
  urd: 'Urdu',
  urdu: 'Urdu',
  fr: 'French',
  fre: 'French',
  fra: 'French',
  french: 'French',
  es: 'Spanish',
  spa: 'Spanish',
  spanish: 'Spanish',
  de: 'German',
  ger: 'German',
  deu: 'German',
  german: 'German',
  it: 'Italian',
  ita: 'Italian',
  italian: 'Italian',
  pt: 'Portuguese',
  por: 'Portuguese',
  portuguese: 'Portuguese',
  ar: 'Arabic',
  ara: 'Arabic',
  arabic: 'Arabic',
  tr: 'Turkish',
  tur: 'Turkish',
  turkish: 'Turkish',
  ko: 'Korean',
  kor: 'Korean',
  korean: 'Korean',
  ja: 'Japanese',
  jpn: 'Japanese',
  japanese: 'Japanese',
  zh: 'Chinese',
  chi: 'Chinese',
  zho: 'Chinese',
  chinese: 'Chinese',
  ru: 'Russian',
  rus: 'Russian',
  russian: 'Russian',
  dual: 'Dual Audio',
  multi: 'Multi Audio',
};

function parseCatalogIdentity(
  rawName: string,
  categoryName: string,
): {
  baseKey: string;
  year: string | null;
  language: string;
  isCam: boolean;
} {
  let working = rawName.normalize('NFKC').trim();
  let year: string | null = null;
  let language: string | null = null;
  const isCam = /\b(CAM|HDCAM|TS|HDTS)\b/i.test(working);

  // Check leading language prefix like "EN | Movie Title" or "HI - Movie Title" or "EN: Movie Title"
  const prefixMatch = working.match(/^([A-Za-z]{2,12})\s*[|:\-–]\s+(.+)$/);
  if (prefixMatch) {
    const code = prefixMatch[1].toLowerCase();
    if (PREFIX_LANG_CODES[code]) {
      language = PREFIX_LANG_CODES[code];
      working = prefixMatch[2].trim();
    }
  }

  // Inspect parenthetical/bracketed groups, removing language, year, and quality markers
  working = working.replace(/([(\[])\s*([^()[\]]+?)\s*[)\]]/g, (full, _open, inner: string) => {
    const trimmed = inner.trim();
    if (/^(19\d{2}|20[0-3]\d)$/.test(trimmed)) {
      if (!year) year = trimmed;
      return ' ';
    }
    if (QUALITY_AND_NOISE_TAG_REGEX.test(trimmed)) {
      return ' ';
    }
    const lang = parseLanguageTokens(trimmed);
    if (lang) {
      if (!language) language = lang;
      return ' ';
    }
    return full;
  });

  // Check trailing delimiter + language marker (e.g. "Title - Hindi Dubbed", "Title | Hindi", "Title - English")
  const trailingLangMatch = working.match(
    /(?:\s*[|\-–:]\s*|\s+)(Hindi(?:\s+Dubbed)?|Tamil(?:\s+Dubbed)?|Telugu(?:\s+Dubbed)?|Malayalam(?:\s+Dubbed)?|Kannada(?:\s+Dubbed)?|Punjabi(?:\s+Dubbed)?|Urdu(?:\s+Dubbed)?|Turkish(?:\s+Dubbed)?|English(?:\s+Dubbed)?|Spanish(?:\s+Dubbed)?|French(?:\s+Dubbed)?|Arabic(?:\s+Dubbed)?|Bangla(?:\s+Dubbed)?|Dual\s+Audio|Multi\s+Audio)\s*$/i,
  );
  if (trailingLangMatch) {
    const lang = parseLanguageTokens(trailingLangMatch[1]);
    if (lang && !language) language = lang;
    working = working.slice(0, trailingLangMatch.index).trim();
  }

  // Strip trailing standalone quality tags (e.g. "Title 4K", "Title 1080p")
  working = working.replace(/\s+\b(4K|2160P|UHD|FHD|1080P|720P|CAM|HDCAM|HDR|HEVC)\b\s*$/i, '').trim();

  // Fallback trailing year outside parentheses
  if (!year) {
    const trailingYear = working.match(/\s+(19\d{2}|20[0-3]\d)$/);
    if (trailingYear) {
      year = trailingYear[1];
      working = working.slice(0, trailingYear.index).trim();
    }
  }

  const baseKey = working
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  return {
    baseKey,
    year,
    language: language || inferLanguageFromCategory(categoryName),
    isCam,
  };
}

function scoreLanguagePreference(language: string, categoryName: string): number {
  const langLower = language.toLowerCase();
  let score = 0;
  if (langLower === 'original' || langLower === 'english') {
    score += 60;
  } else if (langLower === 'dual audio' || langLower === 'multi audio') {
    score += 45;
  } else {
    score += 10;
  }
  if (!isDubOrSubCategory(categoryName)) {
    score += 30;
  }
  return score;
}

function dedupeMovies(movies: MovieSummary[]): MovieSummary[] {
  if (movies.length <= 1) return movies;

  // Group by baseKey first so year-less dubbed versions merge with year-tagged originals
  const byBase = new Map<
    string,
    Array<{ movie: MovieSummary; ident: ReturnType<typeof parseCatalogIdentity> }>
  >();

  for (const movie of movies) {
    const ident = parseCatalogIdentity(movie.name, movie.categoryName);
    const key = ident.baseKey.length >= 2 ? ident.baseKey : `id:${movie.streamId}`;
    let list = byBase.get(key);
    if (!list) {
      list = [];
      byBase.set(key, list);
    }
    list.push({ movie, ident });
  }

  const result: MovieSummary[] = [];

  for (const group of byBase.values()) {
    if (group.length === 1) {
      result.push(group[0].movie);
      continue;
    }

    // Separate entries if they clearly have different release years (e.g. remakes)
    const distinctYears = new Set(group.map((g) => g.ident.year).filter(Boolean));
    const subBuckets = new Map<string, typeof group>();
    const defaultYearBucket = distinctYears.size === 1 ? Array.from(distinctYears)[0]! : 'none';

    for (const entry of group) {
      const bucketKey = entry.ident.year || defaultYearBucket;
      let bucket = subBuckets.get(bucketKey);
      if (!bucket) {
        bucket = [];
        subBuckets.set(bucketKey, bucket);
      }
      bucket.push(entry);
    }

    for (const bucket of subBuckets.values()) {
      let best = bucket[0];
      let bestScore =
        (best.ident.isCam ? 0 : 200) +
        scoreLanguagePreference(best.ident.language, best.movie.categoryName) +
        (best.movie.extension === 'mp4' ? 20 : 0) +
        (best.movie.poster ? 15 : 0) +
        Math.min(10, best.movie.rating);

      for (let i = 1; i < bucket.length; i++) {
        const cand = bucket[i];
        const candScore =
          (cand.ident.isCam ? 0 : 200) +
          scoreLanguagePreference(cand.ident.language, cand.movie.categoryName) +
          (cand.movie.extension === 'mp4' ? 20 : 0) +
          (cand.movie.poster ? 15 : 0) +
          Math.min(10, cand.movie.rating);

        if (
          candScore > bestScore ||
          (candScore === bestScore && cand.movie.added > best.movie.added)
        ) {
          best = cand;
          bestScore = candScore;
        }
      }

      result.push(best.movie);
    }
  }

  return result;
}

function dedupeSeries(seriesList: SeriesSummary[]): SeriesSummary[] {
  if (seriesList.length <= 1) return seriesList;

  const byBase = new Map<
    string,
    Array<{ series: SeriesSummary; ident: ReturnType<typeof parseCatalogIdentity> }>
  >();

  for (const series of seriesList) {
    const ident = parseCatalogIdentity(series.name, series.categoryName);
    const key = ident.baseKey.length >= 2 ? ident.baseKey : `id:${series.seriesId}`;
    let list = byBase.get(key);
    if (!list) {
      list = [];
      byBase.set(key, list);
    }
    list.push({ series, ident });
  }

  const result: SeriesSummary[] = [];

  for (const group of byBase.values()) {
    if (group.length === 1) {
      result.push(group[0].series);
      continue;
    }

    const distinctYears = new Set(group.map((g) => g.ident.year).filter(Boolean));
    const subBuckets = new Map<string, typeof group>();
    const defaultYearBucket = distinctYears.size === 1 ? Array.from(distinctYears)[0]! : 'none';

    for (const entry of group) {
      const bucketKey = entry.ident.year || defaultYearBucket;
      let bucket = subBuckets.get(bucketKey);
      if (!bucket) {
        bucket = [];
        subBuckets.set(bucketKey, bucket);
      }
      bucket.push(entry);
    }

    for (const bucket of subBuckets.values()) {
      let best = bucket[0];
      let bestScore =
        scoreLanguagePreference(best.ident.language, best.series.categoryName) +
        (best.series.poster ? 20 : 0) +
        Math.min(10, best.series.rating);

      for (let i = 1; i < bucket.length; i++) {
        const cand = bucket[i];
        const candScore =
          scoreLanguagePreference(cand.ident.language, cand.series.categoryName) +
          (cand.series.poster ? 20 : 0) +
          Math.min(10, cand.series.rating);

        if (
          candScore > bestScore ||
          (candScore === bestScore && cand.series.lastModified > best.series.lastModified)
        ) {
          best = cand;
          bestScore = candScore;
        }
      }

      result.push(best.series);
    }
  }

  return result;
}

export async function findCatalogLanguageVariants(opts: {
  kind: 'movie' | 'episode';
  id: string;
  seriesId?: string;
  seasonNum?: number;
  episodeNum?: number;
  titleHint?: string;
}): Promise<{
  activeLanguage: string;
  variants: CatalogLanguageVariant[];
}> {
  if (opts.kind === 'movie') {
    const allMovies = await getAllMovies();
    const target = allMovies.find((m) => m.streamId === opts.id);
    if (!target) {
      return { activeLanguage: 'Original', variants: [] };
    }

    const targetIdent = parseCatalogIdentity(target.name, target.categoryName);
    if (targetIdent.baseKey.length < 2) {
      return { activeLanguage: targetIdent.language, variants: [] };
    }

    const candidates: Array<{
      movie: MovieSummary;
      ident: ReturnType<typeof parseCatalogIdentity>;
    }> = [];

    for (const m of allMovies) {
      const ident = parseCatalogIdentity(m.name, m.categoryName);
      if (ident.baseKey !== targetIdent.baseKey) continue;
      if (targetIdent.year && ident.year && targetIdent.year !== ident.year) continue;
      candidates.push({ movie: m, ident });
    }

    // Deduplicate by normalized language key, always keeping active movie for its language
    const byLanguage = new Map<
      string,
      { movie: MovieSummary; ident: ReturnType<typeof parseCatalogIdentity> }
    >();

    for (const cand of candidates) {
      const langKey = cand.ident.language.toLowerCase();
      const existing = byLanguage.get(langKey);
      if (!existing) {
        byLanguage.set(langKey, cand);
        continue;
      }
      if (cand.movie.streamId === target.streamId) {
        byLanguage.set(langKey, cand);
        continue;
      }
      if (existing.movie.streamId === target.streamId) {
        continue;
      }
      // Prefer non-CAM, MP4 over MKV, then newer
      const candScore =
        (cand.ident.isCam ? 0 : 100) +
        (cand.movie.extension === 'mp4' ? 20 : 0);
      const existScore =
        (existing.ident.isCam ? 0 : 100) +
        (existing.movie.extension === 'mp4' ? 20 : 0);
      if (
        candScore > existScore ||
        (candScore === existScore && cand.movie.added > existing.movie.added)
      ) {
        byLanguage.set(langKey, cand);
      }
    }

    const variants: CatalogLanguageVariant[] = Array.from(byLanguage.values())
      .map(({ movie, ident }) => ({
        kind: 'movie' as const,
        id: movie.streamId,
        language: ident.language,
        fullTitle: movie.name,
        cleanTitle: movie.cleanTitle,
        categoryName: movie.categoryName,
        extension: movie.extension || 'mp4',
        playUrl: `/api/play/vod/${movie.streamId}.${movie.extension || 'mp4'}`,
        poster: movie.poster,
        isCurrent: movie.streamId === target.streamId,
      }))
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.language.localeCompare(b.language);
      });

    return {
      activeLanguage: targetIdent.language,
      variants,
    };
  }

  // Series episode variant discovery
  const allSeries = await getAllSeries();
  let targetSeries = opts.seriesId
    ? allSeries.find((s) => s.seriesId === opts.seriesId)
    : undefined;

  if (!targetSeries && opts.titleHint) {
    const cleanHint = opts.titleHint.split(' — S')[0]?.trim().toLowerCase();
    if (cleanHint) {
      targetSeries = allSeries.find(
        (s) => s.cleanTitle.toLowerCase() === cleanHint || s.name.toLowerCase() === cleanHint,
      );
    }
  }

  if (!targetSeries) {
    return { activeLanguage: 'Original', variants: [] };
  }

  const targetIdent = parseCatalogIdentity(targetSeries.name, targetSeries.categoryName);
  if (targetIdent.baseKey.length < 2) {
    return { activeLanguage: targetIdent.language, variants: [] };
  }

  const seriesCandidates: Array<{
    series: SeriesSummary;
    ident: ReturnType<typeof parseCatalogIdentity>;
  }> = [];

  for (const s of allSeries) {
    const ident = parseCatalogIdentity(s.name, s.categoryName);
    if (ident.baseKey !== targetIdent.baseKey) continue;
    if (targetIdent.year && ident.year && targetIdent.year !== ident.year) continue;
    seriesCandidates.push({ series: s, ident });
  }

  const byLanguage = new Map<
    string,
    { series: SeriesSummary; ident: ReturnType<typeof parseCatalogIdentity> }
  >();
  for (const cand of seriesCandidates) {
    const langKey = cand.ident.language.toLowerCase();
    const existing = byLanguage.get(langKey);
    if (!existing) {
      byLanguage.set(langKey, cand);
      continue;
    }
    if (cand.series.seriesId === targetSeries.seriesId) {
      byLanguage.set(langKey, cand);
      continue;
    }
    if (existing.series.seriesId === targetSeries.seriesId) {
      continue;
    }
    if (cand.series.lastModified > existing.series.lastModified) {
      byLanguage.set(langKey, cand);
    }
  }

  const dedupedSeries = Array.from(byLanguage.values()).slice(0, 8);
  const seasonNum = opts.seasonNum && opts.seasonNum > 0 ? opts.seasonNum : 1;
  const episodeNum = opts.episodeNum && opts.episodeNum > 0 ? opts.episodeNum : 1;

  const resolvedVariantsRaw = await mapWithConcurrency(dedupedSeries, 4, async ({ series, ident }) => {
    const isCurrentSeries = series.seriesId === targetSeries.seriesId;
    try {
      const detail = await getSeriesDetail(series.seriesId, { includeRelated: false });
      const seasonEps = detail.episodesBySeason[String(seasonNum)] || [];
      let matchedEp =
        (isCurrentSeries ? seasonEps.find((e) => e.episodeId === opts.id) : undefined) ||
        seasonEps.find((e) => e.episodeNum === episodeNum);

      // Search all seasons if current ID wasn't in the expected season key
      if (!matchedEp && isCurrentSeries) {
        for (const list of Object.values(detail.episodesBySeason)) {
          const found = list.find((e) => e.episodeId === opts.id);
          if (found) {
            matchedEp = found;
            break;
          }
        }
      }

      if (!matchedEp) return null;

      return {
        kind: 'episode' as const,
        id: matchedEp.episodeId,
        seriesId: series.seriesId,
        seasonNum: matchedEp.seasonNum,
        episodeNum: matchedEp.episodeNum,
        language: ident.language,
        fullTitle: series.name,
        cleanTitle: detail.cleanTitle,
        categoryName: series.categoryName,
        extension: matchedEp.extension || 'mp4',
        playUrl: matchedEp.playUrl,
        poster: matchedEp.thumbnail || series.poster,
        isCurrent: matchedEp.episodeId === opts.id || isCurrentSeries,
      } satisfies CatalogLanguageVariant;
    } catch {
      if (!isCurrentSeries) return null;
      return {
        kind: 'episode' as const,
        id: opts.id,
        seriesId: series.seriesId,
        seasonNum,
        episodeNum,
        language: ident.language,
        fullTitle: series.name,
        cleanTitle: series.cleanTitle,
        categoryName: series.categoryName,
        extension: 'mp4',
        playUrl: `/api/play/series/${opts.id}.mp4`,
        poster: series.poster,
        isCurrent: true,
      } satisfies CatalogLanguageVariant;
    }
  });

  const variants = resolvedVariantsRaw
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return a.language.localeCompare(b.language);
    });

  return {
    activeLanguage: targetIdent.language,
    variants,
  };
}

// ---------- Same-Genre Recommendations ("You May Like") ----------

const GENRE_STOPWORDS = new Set([
  'general',
  'movies',
  'movie',
  'series',
  'tv',
  'all',
  '4k',
  'fhd',
  'uhd',
  'hd',
  'sd',
  'cam',
  '2160p',
  '1080p',
  '720p',
  'multi',
  'language',
  'dubbed',
  'subtitles',
  'collection',
  '24/7',
  '24x7',
  'only',
  'live',
]);

const LANGUAGE_REGION_KEYWORDS = [
  'english',
  'indian',
  'hindi',
  'bollywood',
  'south indian',
  'punjabi',
  'tamil',
  'telugu',
  'malayalam',
  'kannada',
  'marathi',
  'gujarati',
  'bangla',
  'bengali',
  'pakistan',
  'pakistani',
  'urdu',
  'turkish',
  'turkey',
  'arabic',
  'korean',
  'uk',
  'usa',
  'canada',
  'europe',
  'asia',
  'africa',
  'australia',
  'middle east',
];

function parseGenreTokens(raw: string): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  const parts = raw
    .toLowerCase()
    .split(/[,/|&]+|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (!GENRE_STOPWORDS.has(part) && !/^(19|20)\d{2}$/.test(part) && part.length >= 2) {
      out.add(part);
    }
    const words = part.split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (!GENRE_STOPWORDS.has(w) && !/^(19|20)\d{2}$/.test(w) && w.length >= 3) {
        out.add(w);
      }
    }
  }
  return Array.from(out);
}

function extractRegionKeys(text: string): Set<string> {
  const lower = text.toLowerCase();
  const keys = new Set<string>();
  for (const kw of LANGUAGE_REGION_KEYWORDS) {
    if (lower.includes(kw)) {
      if (kw === 'bollywood' || kw === 'hindi' || kw === 'indian') {
        keys.add('india');
      } else if (kw === 'pakistani' || kw === 'pakistan' || kw === 'urdu') {
        keys.add('pakistan');
      } else if (kw === 'bengali' || kw === 'bangla') {
        keys.add('bangla');
      } else if (kw === 'turkish' || kw === 'turkey') {
        keys.add('turkey');
      } else {
        keys.add(kw);
      }
    }
  }
  return keys;
}

function getMovieCategoryGenreMatchers(genres: string[]): RegExp[] {
  const matchers: RegExp[] = [];
  const joined = genres.join(' ').toLowerCase();
  if (!joined) return matchers;
  if (/\bhorror\b/.test(joined)) matchers.push(/\bhorror\b/i);
  if (/\bcomedy\b/.test(joined)) matchers.push(/\bcomedy\b|\bkapil\b|\bumer sharif\b/i);
  if (/\bromanc/.test(joined)) matchers.push(/\bromant|\bromance/i);
  if (/\bdocumentar/.test(joined)) matchers.push(/\bdocumentar/i);
  if (/\b(animation|family|kids)\b/.test(joined)) matchers.push(/\bkids\b|\banimat/i);
  if (/\bsport/.test(joined)) matchers.push(/\b(cricket|fifa|wwe|ufc|aew)\b/i);
  if (/\b(music|musical)\b/.test(joined)) matchers.push(/\b(music|musical|idol)\b/i);
  if (/\bstage\b|\bdrama\b/.test(joined)) matchers.push(/\bstage drama\b/i);
  if (/\b(action|adventure|sci-fi|fantasy|thriller|crime)\b/.test(joined)) {
    matchers.push(/\b(marvel|007|fast & furious|jurassic|indiana jones|alien|predator|die hard|terminator|rambo|rocky|godfather|bruce lee|van damme|blockbuster|oscar)\b/i);
  }
  return matchers;
}

function isDubOrSubCategory(categoryName: string): boolean {
  return /\b(dubbed|subtitles?|multi language)\b/i.test(categoryName);
}

function isGenericYearOrBucketCategory(categoryName: string): boolean {
  return /\b(4k|fhd|uhd|cam|general|1999-2020|netflix|201\d|202\d)\b/i.test(categoryName);
}

function normalizeLiveChannelBaseKey(name: string): string {
  return name
    .replace(/^[A-Z]{2,4}\s*[:|]\s*/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(4k|uhd|fhd|hd|sd|hevc|h\.?265|raw|vip|backup|50fps|60fps)\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function findRelatedMovies(
  detail: MovieDetail,
  allMovies: MovieSummary[],
  limit = 18,
): MovieSummary[] {
  const currentIdent = parseCatalogIdentity(detail.name, detail.categoryName);
  const targetGenres = parseGenreTokens(detail.genre);
  const targetMovieGenreEntries = extractMovieGenreEntries({
    ...detail,
    name: `${detail.name} ${detail.genre}`,
  }).filter((g) => g.group === 'genre' && g.id !== '4k-uhd');
  const targetMovieGenreIds = new Set(targetMovieGenreEntries.map((g) => g.id));
  const catGenreMatchers = getMovieCategoryGenreMatchers(targetGenres);
  const targetRegions = extractRegionKeys(detail.categoryName);
  const targetPrefix = detail.categoryName.split('|')[0]?.trim().toLowerCase() || '';
  const targetCatTokens = extractCategoryFlavorTokens(detail.categoryName);
  const targetIsDubOrSub = isDubOrSubCategory(detail.categoryName);
  const targetIsGenericBucket = isGenericYearOrBucketCategory(detail.categoryName);
  const targetYearNum = detail.year ? Number(detail.year) : NaN;

  const scored: Array<{ movie: MovieSummary; score: number }> = [];

  for (const m of allMovies) {
    if (m.streamId === detail.streamId) continue;

    let score = 0;
    const catLower = m.categoryName.toLowerCase();
    const candIdent = parseCatalogIdentity(m.name, m.categoryName);

    let matchedExplicitGenreCat = false;
    for (const rx of catGenreMatchers) {
      if (rx.test(m.categoryName)) {
        score += 310;
        matchedExplicitGenreCat = true;
      }
    }

    if (targetMovieGenreIds.size > 0) {
      const candGenres = extractMovieGenreEntries(m).filter(
        (g) => g.group === 'genre' && g.id !== '4k-uhd',
      );
      for (const cg of candGenres) {
        if (targetMovieGenreIds.has(cg.id)) {
          score += 110;
        }
      }
    }

    if (detail.categoryId && m.categoryId === detail.categoryId) {
      // Dedicated franchise/genre folders match closely; generic year buckets rank below explicit genre categories
      score += targetIsGenericBucket && catGenreMatchers.length > 0 ? 75 : 190;
    }

    for (const g of targetGenres) {
      if (catLower.includes(g)) {
        score += 70;
      }
      if (g.length >= 4 && m.cleanTitle.toLowerCase().includes(g)) {
        score += 35;
      }
    }

    if (targetCatTokens.length > 0) {
      const candCatTokens = new Set(extractCategoryFlavorTokens(m.categoryName));
      for (const tok of targetCatTokens) {
        if (candCatTokens.has(tok)) {
          score += 30;
        }
      }
    }

    if (targetPrefix && catLower.split('|')[0]?.trim() === targetPrefix) {
      score += 45;
    }

    if (candIdent.language === currentIdent.language) {
      score += 60;
    }

    if (!targetIsDubOrSub && isDubOrSubCategory(m.categoryName)) {
      score -= 110;
    }

    if (targetRegions.size > 0) {
      const mRegions = extractRegionKeys(m.categoryName);
      for (const r of targetRegions) {
        if (mRegions.has(r)) {
          score += matchedExplicitGenreCat ? 40 : 45;
          break;
        }
      }
    }

    if (Number.isFinite(targetYearNum) && m.year && /^\d{4}$/.test(m.year)) {
      const diff = Math.abs(targetYearNum - Number(m.year));
      if (diff <= 2) score += 25;
      else if (diff <= 5) score += 12;
    }

    const isCam = /\b(CAM|HDCAM|TS|HDTS)\b/i.test(m.name);
    if (!isCam) score += 35;
    if (m.poster) score += 25;
    if (m.rating > 0) score += Math.min(24, m.rating * 2.2);

    scored.push({ movie: m, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.movie.rating - a.movie.rating ||
      b.movie.added - a.movie.added,
  );

  const selected: MovieSummary[] = [];
  const seenKeys = new Set<string>();
  if (currentIdent.baseKey) seenKeys.add(currentIdent.baseKey);

  const cap = Math.min(scored.length, 320);
  for (let i = 0; i < cap && selected.length < limit; i++) {
    const candidate = scored[i].movie;
    const ident = parseCatalogIdentity(candidate.name, candidate.categoryName);
    const dedupeKey = ident.baseKey || `id:${candidate.streamId}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    selected.push(candidate);
  }

  return selected;
}

function findRelatedSeries(
  detail: SeriesDetail,
  allSeries: SeriesSummary[],
  limit = 18,
): SeriesSummary[] {
  const currentIdent = parseCatalogIdentity(detail.name, detail.categoryName);
  const targetGenres = parseGenreTokens(detail.genre);
  const topicFallbackTokens =
    targetGenres.length === 0 ? parseGenreTokens(detail.categoryName) : [];
  const targetSeriesGenreIds = new Set(
    extractSeriesGenreEntries(detail)
      .filter((g) => g.group === 'genre')
      .map((g) => g.id),
  );
  const targetRegions = extractRegionKeys(`${detail.categoryName} ${detail.name}`);
  const targetPrefix = detail.categoryName.split('|')[0]?.trim().toLowerCase() || '';
  const targetCatTokens = extractCategoryFlavorTokens(detail.categoryName);
  const targetIsDubOrSub = isDubOrSubCategory(detail.categoryName);
  const targetYearNum = detail.year ? Number(detail.year) : NaN;

  const scored: Array<{ series: SeriesSummary; score: number }> = [];

  for (const s of allSeries) {
    if (s.seriesId === detail.seriesId) continue;

    let score = 0;
    const candIdent = parseCatalogIdentity(s.name, s.categoryName);

    if (targetGenres.length > 0 && s.genre) {
      const candGenres = parseGenreTokens(s.genre);
      for (const g of targetGenres) {
        if (candGenres.some((cg) => cg === g || cg.includes(g) || g.includes(cg))) {
          score += 125;
        }
      }
    } else if (topicFallbackTokens.length > 0) {
      const candTopic = `${s.genre} ${s.categoryName} ${s.cleanTitle}`.toLowerCase();
      for (const tok of topicFallbackTokens) {
        if (tok.length >= 4 && candTopic.includes(tok)) {
          score += 80;
        }
      }
    }

    if (targetSeriesGenreIds.size > 0) {
      const candGenreIds = extractSeriesGenreEntries(s).filter((g) => g.group === 'genre');
      for (const cg of candGenreIds) {
        if (targetSeriesGenreIds.has(cg.id)) {
          score += 85;
        }
      }
    }

    if (detail.categoryId && s.categoryId === detail.categoryId) {
      score += 90;
    }

    if (targetCatTokens.length > 0) {
      const candCatTokens = new Set(extractCategoryFlavorTokens(s.categoryName));
      for (const tok of targetCatTokens) {
        if (candCatTokens.has(tok)) {
          score += 30;
        }
      }
    }

    const catLower = s.categoryName.toLowerCase();
    if (targetPrefix && catLower.split('|')[0]?.trim() === targetPrefix) {
      score += 45;
    }

    if (candIdent.language === currentIdent.language) {
      score += 85;
    } else if (!targetIsDubOrSub && (isDubOrSubCategory(s.categoryName) || candIdent.language !== 'Original')) {
      score -= 80;
    }

    if (targetRegions.size > 0) {
      const sRegions = extractRegionKeys(`${s.categoryName} ${s.name}`);
      for (const r of targetRegions) {
        if (sRegions.has(r)) {
          score += 45;
          break;
        }
      }
    }

    if (Number.isFinite(targetYearNum) && s.year && /^\d{4}$/.test(s.year)) {
      const diff = Math.abs(targetYearNum - Number(s.year));
      if (diff <= 2) score += 20;
      else if (diff <= 5) score += 10;
    }

    if (s.poster) score += 20;
    if (s.rating > 0) score += Math.min(24, s.rating * 2.2);

    scored.push({ series: s, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.series.rating - a.series.rating ||
      b.series.lastModified - a.series.lastModified,
  );

  const selected: SeriesSummary[] = [];
  const seenKeys = new Set<string>();
  if (currentIdent.baseKey) seenKeys.add(currentIdent.baseKey);

  const cap = Math.min(scored.length, 300);
  for (let i = 0; i < cap && selected.length < limit; i++) {
    const candidate = scored[i].series;
    const ident = parseCatalogIdentity(candidate.name, candidate.categoryName);
    const dedupeKey = ident.baseKey || `id:${candidate.seriesId}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    selected.push(candidate);
  }

  return selected;
}

const LIVE_GENRE_MATCHERS: Array<{ key: string; rx: RegExp }> = [
  { key: 'cricket', rx: /\b(cricket|ptv sports|a sports|ten cricket|willow)\b/i },
  { key: 'football', rx: /\b(football|soccer|epl|mls|uefa|laliga|bundesliga|premier)\b/i },
  { key: 'basketball', rx: /\b(nba|wnba|basketball)\b/i },
  { key: 'motorsport', rx: /\b(f1|motogp|formula\s*1|nascar|racing)\b/i },
  { key: 'fighting', rx: /\b(ufc|wwe|boxing|mma|aew|fight)\b/i },
  { key: 'sports', rx: /\b(sports?|espn|tsn|bein|sky sports|star sports|ten sports|sony ten|hub sports|nfl|mlb|nhl|golf|tennis|rugby|dazn|tnt sports|eurosport)\b/i },
  { key: 'news', rx: /\b(news|cnn|bbc news|bbc world|msnbc|cnbc|fox news|bloomberg|al jazeera|sky news|geo news|ary news|samaa|dunya|wion|ndtv|aaj tak|euronews|france 24)\b/i },
  { key: 'movies', rx: /\b(movies?|cinema|hbo|starz|showtime|flix|film|star gold|sony max|zee cinema|zee action|b4u movies|colors cineplex|&pictures)\b/i },
  { key: 'kids', rx: /\b(kids|cartoon|nick|nickelodeon|disney|pogo|hungama|cbbc|boomerang|baby tv|babyfirst)\b/i },
  { key: 'music', rx: /\b(music|songs?|singers?|mtv|vh1|9xm|b4u music|mastiii)\b/i },
  { key: 'documentary', rx: /\b(documentar|discovery|nat geo|national geographic|animal planet|history|science|tlc|investigation)\b/i },
  { key: 'entertainment', rx: /\b(entertainment|drama|comedy|reality|web series|hum tv|geo tv|ary digital|star plus|colors|zee tv|sony tv)\b/i },
  { key: 'religious', rx: /\b(religious|islamic|quran|makkah|madina|madani|christian|gospel|god tv)\b/i },
];

function extractLiveGenreKeys(channel: LiveChannelSummary): Set<string> {
  const combined = `${channel.categoryName} ${channel.name}`;
  const keys = new Set<string>();
  for (const { key, rx } of LIVE_GENRE_MATCHERS) {
    if (rx.test(combined)) {
      keys.add(key);
    }
  }
  return keys;
}

function getLiveAffinityRegions(regions: Set<string>): Set<string> {
  const expanded = new Set(regions);
  if (regions.has('pakistan')) expanded.add('india');
  if (regions.has('india')) expanded.add('pakistan');
  if (regions.has('uk') || regions.has('usa') || regions.has('canada') || regions.has('australia') || regions.has('english')) {
    expanded.add('uk');
    expanded.add('usa');
    expanded.add('english');
  }
  return expanded;
}

function findRelatedLiveChannels(
  channel: LiveChannelSummary,
  allChannels: LiveChannelSummary[],
  limit = 12,
): LiveChannelSummary[] {
  const targetGenres = extractLiveGenreKeys(channel);
  const targetRegions = getLiveAffinityRegions(
    extractRegionKeys(`${channel.categoryName} ${channel.name}`),
  );
  const targetPrefix = channel.categoryName.split('|')[0]?.trim().toLowerCase() || '';
  const targetBaseKey = normalizeLiveChannelBaseKey(channel.name);

  const scored: Array<{ channel: LiveChannelSummary; score: number }> = [];

  for (const c of allChannels) {
    if (c.streamId === channel.streamId) continue;

    let score = 0;
    const sameCategory = Boolean(channel.categoryId && c.categoryId === channel.categoryId);
    let genreOverlapCount = 0;

    if (targetGenres.size > 0) {
      const cGenres = extractLiveGenreKeys(c);
      for (const g of targetGenres) {
        if (cGenres.has(g)) {
          genreOverlapCount += 1;
        }
      }
      score += genreOverlapCount * 170;
    }

    if (sameCategory) {
      // Same category with matching genre (or no specific genre detected) ranks highest; mixed country-buckets with mismatched genre rank below cross-category genre matches
      score += targetGenres.size === 0 || genreOverlapCount > 0 ? 150 : 75;
    }

    const cPrefix = c.categoryName.split('|')[0]?.trim().toLowerCase() || '';
    if (targetPrefix && cPrefix === targetPrefix) {
      score += 45;
    }

    if (targetRegions.size > 0) {
      const cRegions = extractRegionKeys(`${c.categoryName} ${c.name}`);
      for (const r of targetRegions) {
        if (cRegions.has(r)) {
          score += 55;
          break;
        }
      }
    }

    if (c.logo) score += 15;
    if (c.epgChannelId) score += 10;

    scored.push({ channel: c, score });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.channel.num - b.channel.num,
  );

  const selected: LiveChannelSummary[] = [];
  const seenBaseKeys = new Set<string>();
  if (targetBaseKey) seenBaseKeys.add(targetBaseKey);

  const cap = Math.min(scored.length, 600);
  for (let i = 0; i < cap && selected.length < limit; i++) {
    const candidate = scored[i].channel;
    const baseKey = normalizeLiveChannelBaseKey(candidate.name) || `id:${candidate.streamId}`;
    if (seenBaseKeys.has(baseKey)) continue;
    seenBaseKeys.add(baseKey);
    selected.push(candidate);
  }

  return selected;
}

async function enrichLiveRecommendationsWithEpg(
  channels: LiveChannelSummary[],
  nowSec: number,
): Promise<LiveChannelSummary[]> {
  if (channels.length === 0) return channels;

  const enrichWork = mapWithConcurrency(channels, 6, async (ch) => {
    if (!ch.epgChannelId) return ch;
    try {
      const programs = await getChannelEpg(ch.streamId, nowSec);
      const currentIdx = programs.findIndex(
        (p) => p.startTimestamp <= nowSec && p.stopTimestamp > nowSec,
      );
      const nowPlaying = currentIdx >= 0 ? programs[currentIdx] : null;
      const nextProgram =
        currentIdx >= 0 && currentIdx + 1 < programs.length
          ? programs[currentIdx + 1]
          : programs.find((p) => p.startTimestamp > nowSec) || null;
      return { ...ch, nowPlaying, nextProgram };
    } catch {
      return ch;
    }
  });

  // Never stall channel detail page waiting on slow external EPG feeds
  const timeoutFallback = new Promise<LiveChannelSummary[]>((resolve) =>
    setTimeout(() => resolve(channels), 900),
  );

  return Promise.race([enrichWork, timeoutFallback]);
}

const CANONICAL_GENRE_LABELS: Record<string, string> = {
  'action-adventure': 'Action & Adventure',
  drama: 'Drama',
  comedy: 'Comedy',
  'crime-thriller': 'Crime & Thriller',
  crime: 'Crime',
  thriller: 'Thriller',
  horror: 'Horror',
  'sci-fi-fantasy': 'Sci-Fi & Fantasy',
  romance: 'Romance',
  'kids-family': 'Kids & Family',
  kids: 'Kids',
  family: 'Family',
  animation: 'Animation',
  documentary: 'Documentary',
  mystery: 'Mystery',
  sports: 'Sports',
  reality: 'Reality',
  'war-politics': 'War & Politics',
  'cinema-english': 'Hollywood & English',
  'cinema-indian': 'Bollywood & Hindi',
  'cinema-south-indian': 'South Indian',
  'cinema-pakistani': 'Pakistani',
  'cinema-turkish': 'Turkish',
};

const GENRE_ALIAS_EXPANSIONS: Record<string, string[]> = {
  'action-adventure': ['action-adventure', 'action', 'adventure'],
  'crime-thriller': ['crime-thriller', 'crime', 'thriller', 'mystery'],
  crime: ['crime', 'crime-thriller', 'thriller'],
  thriller: ['thriller', 'crime-thriller', 'mystery'],
  mystery: ['mystery', 'crime-thriller', 'thriller'],
  'kids-family': ['kids-family', 'kids', 'family', 'animation'],
  kids: ['kids', 'kids-family', 'family', 'animation'],
  family: ['family', 'kids-family', 'kids'],
  animation: ['animation', 'kids-family', 'kids'],
  'sci-fi-fantasy': ['sci-fi-fantasy', 'sci-fi', 'fantasy'],
  drama: ['drama'],
  comedy: ['comedy'],
  horror: ['horror'],
  romance: ['romance'],
  documentary: ['documentary'],
  sports: ['sports'],
};

function expandGenreAliases(id: string): string[] {
  const clean = id.trim().toLowerCase();
  if (!clean) return [];
  return GENRE_ALIAS_EXPANSIONS[clean] || [clean];
}

function extractCategoryFlavorTokens(rawCategory: string): string[] {
  if (!rawCategory) return [];
  const stopWords = new Set([
    'movies',
    'movie',
    'series',
    'all',
    'new',
    'latest',
    'top',
    'best',
    'vip',
    'hd',
    'fhd',
    'uhd',
    '4k',
    'vod',
    'tv',
    'shows',
    'the',
    'and',
    'for',
    'collection',
  ]);
  return rawCategory
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((tok) => tok.trim())
    .filter((tok) => tok.length >= 3 && !stopWords.has(tok));
}

function inferServerLanguage(name: string, categoryName: string): string {
  const combined = `${name} ${categoryName}`.toLowerCase();
  if (/\b(hindi|bollywood)\b/.test(combined)) return 'hindi';
  if (/\b(urdu|pakistan|lollywood|hum tv|geo|ary)\b/.test(combined)) return 'urdu';
  if (/\b(tamil|kollywood)\b/.test(combined)) return 'tamil';
  if (/\b(telugu|tollywood)\b/.test(combined)) return 'telugu';
  if (/\b(malayalam)\b/.test(combined)) return 'malayalam';
  if (/\b(punjabi)\b/.test(combined)) return 'punjabi';
  if (/\b(turkish)\b/.test(combined)) return 'turkish';
  if (/\b(arabic)\b/.test(combined)) return 'arabic';
  if (/\b(korean|k-drama|kdrama)\b/.test(combined)) return 'korean';
  if (/\b(japanese|anime)\b/.test(combined)) return 'japanese';
  if (/\b(spanish|latino)\b/.test(combined)) return 'spanish';
  if (/\b(french)\b/.test(combined)) return 'french';
  if (/\b(english|hollywood|netflix|hbo|amazon prime|disney|apple tv)\b/.test(combined)) {
    return 'english';
  }
  return '';
}

function inferGenresFromRawCategoryText(categoryText: string): string[] {
  if (!categoryText) return [];
  const found: string[] = [];
  for (const rule of MOVIE_GENRE_RULES) {
    if (rule.catRx && rule.catRx.test(categoryText)) {
      found.push(rule.id);
    }
  }
  if (/\b(drama)\b/i.test(categoryText) && !found.includes('drama')) found.push('drama');
  if (/\b(comedy|stand-?up)\b/i.test(categoryText) && !found.includes('comedy')) found.push('comedy');
  if (/\b(action|adventure)\b/i.test(categoryText) && !found.includes('action-adventure')) {
    found.push('action-adventure');
  }
  if (/\b(thriller|crime|mystery)\b/i.test(categoryText) && !found.includes('crime-thriller')) {
    found.push('crime-thriller');
  }
  if (/\b(horror|scary)\b/i.test(categoryText) && !found.includes('horror')) found.push('horror');
  if (/\b(sci-?fi|fantasy)\b/i.test(categoryText) && !found.includes('sci-fi-fantasy')) {
    found.push('sci-fi-fantasy');
  }
  if (/\b(romance|romantic)\b/i.test(categoryText) && !found.includes('romance')) {
    found.push('romance');
  }
  if (/\b(anime|animation|cartoon|kids|family)\b/i.test(categoryText)) {
    if (!found.includes('kids-family')) found.push('kids-family');
    if (/\b(anime|animation)\b/i.test(categoryText) && !found.includes('animation')) {
      found.push('animation');
    }
  }
  if (/\bdocumentar/i.test(categoryText) && !found.includes('documentary')) {
    found.push('documentary');
  }
  return found;
}

export async function getPersonalizedRecommendations(
  req: RecommendationRequest,
): Promise<RecommendationsResponse> {
  const [allMovies, allSeries] = await Promise.all([getAllMovies(), getAllSeries()]);

  const uniqueMovies = dedupeMovies(allMovies);
  const uniqueSeries = dedupeSeries(allSeries);

  const movieById = new Map<string, MovieSummary>();
  for (const m of allMovies) {
    movieById.set(m.streamId, m);
  }
  const seriesById = new Map<string, SeriesSummary>();
  for (const s of allSeries) {
    seriesById.set(s.seriesId, s);
  }

  const favoriteGenres = Array.from(
    new Set(
      (req.favoriteGenres || [])
        .map((g) => String(g || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const watchedMovieIds = (req.watchedMovieIds || []).map((id) => String(id).trim()).filter(Boolean);
  const watchedSeriesIds = (req.watchedSeriesIds || []).map((id) => String(id).trim()).filter(Boolean);
  const watchlistMovieIds = (req.watchlistMovieIds || []).map((id) => String(id).trim()).filter(Boolean);
  const watchlistSeriesIds = (req.watchlistSeriesIds || [])
    .map((id) => String(id).trim())
    .filter(Boolean);

  const likedRatingMap = new Map<string, number>();
  for (const liked of req.likedTitles || []) {
    if (liked && liked.id && liked.rating >= 4) {
      likedRatingMap.set(`${liked.kind}:${liked.id}`, liked.rating);
    }
  }

  // Exclude already watched and watchlist items (plus same clean titles)
  const excludedMovieIds = new Set<string>([...watchedMovieIds, ...watchlistMovieIds]);
  const excludedSeriesIds = new Set<string>([...watchedSeriesIds, ...watchlistSeriesIds]);
  const excludedNormalizedTitles = new Set<string>();

  for (const id of excludedMovieIds) {
    const m = movieById.get(id);
    if (m) excludedNormalizedTitles.add(normalizeCreditMatchTitle(m.cleanTitle));
  }
  for (const id of excludedSeriesIds) {
    const s = seriesById.get(id);
    if (s) excludedNormalizedTitles.add(normalizeCreditMatchTitle(s.cleanTitle));
  }

  // Build user taste weights
  const genreWeights = new Map<string, number>();
  const favoriteAliasSet = new Set<string>();
  const inferredHistoryScores = new Map<string, { label: string; score: number }>();
  const genreSourceTitle = new Map<string, string>();
  const categoryTokenWeights = new Map<string, number>();
  const languageWeights = new Map<string, number>();

  const addGenreWeight = (
    genreId: string,
    weight: number,
    opts?: { fromHistory?: boolean; label?: string; sourceTitle?: string },
  ) => {
    const aliases = expandGenreAliases(genreId);
    for (let i = 0; i < aliases.length; i++) {
      const alias = aliases[i];
      const factor = i === 0 ? 1 : 0.78;
      genreWeights.set(alias, (genreWeights.get(alias) || 0) + weight * factor);
      if (opts?.sourceTitle && !genreSourceTitle.has(alias)) {
        genreSourceTitle.set(alias, opts.sourceTitle);
      }
    }
    if (opts?.fromHistory) {
      const prev = inferredHistoryScores.get(genreId);
      const label = opts.label || CANONICAL_GENRE_LABELS[genreId] || genreId;
      inferredHistoryScores.set(genreId, {
        label,
        score: (prev?.score || 0) + weight,
      });
    }
  };

  // 1. Explicit user favorite genres (highest priority)
  for (const favId of favoriteGenres) {
    for (const alias of expandGenreAliases(favId)) {
      favoriteAliasSet.add(alias);
    }
    addGenreWeight(favId, 5.2, { label: CANONICAL_GENRE_LABELS[favId] || favId });
  }

  // 2. Watch history movies (recency weighted: earlier items in array are more recent)
  watchedMovieIds.forEach((id, idx) => {
    const movie = movieById.get(id);
    if (!movie) return;
    const recencyFactor = Math.max(0.55, 1.2 - idx * 0.08);
    const likedBonus = likedRatingMap.has(`movie:${id}`) ? 1.5 : 1.0;
    const weight = 3.1 * recencyFactor * likedBonus;

    for (const g of extractMovieGenreEntries(movie)) {
      if (g.id === '4k-uhd') continue;
      addGenreWeight(g.id, weight, {
        fromHistory: g.group !== 'cinema',
        label: g.label,
        sourceTitle: movie.cleanTitle,
      });
    }
    for (const tok of extractCategoryFlavorTokens(movie.categoryName)) {
      categoryTokenWeights.set(tok, (categoryTokenWeights.get(tok) || 0) + 1.2 * recencyFactor);
    }
    const lang = inferServerLanguage(movie.name, movie.categoryName);
    if (lang) {
      languageWeights.set(lang, (languageWeights.get(lang) || 0) + 1.5 * recencyFactor);
    }
  });

  // 3. Watch history series
  watchedSeriesIds.forEach((id, idx) => {
    const series = seriesById.get(id);
    if (!series) return;
    const recencyFactor = Math.max(0.55, 1.2 - idx * 0.08);
    const likedBonus = likedRatingMap.has(`series:${id}`) ? 1.5 : 1.0;
    const weight = 3.1 * recencyFactor * likedBonus;

    for (const g of extractSeriesGenreEntries(series)) {
      addGenreWeight(g.id, weight, {
        fromHistory: g.group !== 'cinema',
        label: g.label,
        sourceTitle: series.cleanTitle,
      });
    }
    for (const tok of extractCategoryFlavorTokens(series.categoryName)) {
      categoryTokenWeights.set(tok, (categoryTokenWeights.get(tok) || 0) + 1.2 * recencyFactor);
    }
    const lang = inferServerLanguage(series.name, series.categoryName);
    if (lang) {
      languageWeights.set(lang, (languageWeights.get(lang) || 0) + 1.5 * recencyFactor);
    }
  });

  // 4. Watchlist items (explicit interest)
  for (const id of watchlistMovieIds) {
    const movie = movieById.get(id);
    if (!movie) continue;
    for (const g of extractMovieGenreEntries(movie)) {
      if (g.id === '4k-uhd') continue;
      addGenreWeight(g.id, 2.2, {
        fromHistory: g.group !== 'cinema',
        label: g.label,
        sourceTitle: movie.cleanTitle,
      });
    }
    for (const tok of extractCategoryFlavorTokens(movie.categoryName)) {
      categoryTokenWeights.set(tok, (categoryTokenWeights.get(tok) || 0) + 0.8);
    }
    const lang = inferServerLanguage(movie.name, movie.categoryName);
    if (lang) {
      languageWeights.set(lang, (languageWeights.get(lang) || 0) + 0.9);
    }
  }

  for (const id of watchlistSeriesIds) {
    const series = seriesById.get(id);
    if (!series) continue;
    for (const g of extractSeriesGenreEntries(series)) {
      addGenreWeight(g.id, 2.2, {
        fromHistory: g.group !== 'cinema',
        label: g.label,
        sourceTitle: series.cleanTitle,
      });
    }
    for (const tok of extractCategoryFlavorTokens(series.categoryName)) {
      categoryTokenWeights.set(tok, (categoryTokenWeights.get(tok) || 0) + 0.8);
    }
    const lang = inferServerLanguage(series.name, series.categoryName);
    if (lang) {
      languageWeights.set(lang, (languageWeights.get(lang) || 0) + 0.9);
    }
  }

  // 5. Fallback category & language strings from client
  for (const rawCat of req.watchedCategories || []) {
    for (const gid of inferGenresFromRawCategoryText(rawCat)) {
      addGenreWeight(gid, 1.6, {
        fromHistory: !gid.startsWith('cinema-'),
        label: CANONICAL_GENRE_LABELS[gid] || gid,
      });
    }
    for (const tok of extractCategoryFlavorTokens(rawCat)) {
      categoryTokenWeights.set(tok, (categoryTokenWeights.get(tok) || 0) + 0.7);
    }
  }
  for (const rawLang of req.watchedLanguages || []) {
    const clean = String(rawLang || '').trim().toLowerCase();
    if (clean && clean !== 'dual audio' && clean !== 'multi audio') {
      languageWeights.set(clean, (languageWeights.get(clean) || 0) + 1.3);
    }
  }

  const personalized =
    favoriteGenres.length > 0 ||
    genreWeights.size > 0 ||
    categoryTokenWeights.size > 0 ||
    languageWeights.size > 0;

  // Determine recency normalization bounds
  let maxAdded = 0;
  for (const m of uniqueMovies) {
    if (m.added > maxAdded) maxAdded = m.added;
  }
  let maxModified = 0;
  for (const s of uniqueSeries) {
    if (s.lastModified > maxModified) maxModified = s.lastModified;
  }

  const buildReason = (
    matchedLabels: string[],
    matchedFavLabels: string[],
    matchedSourceTitle: string | undefined,
    matchedLangLabel: string | undefined,
    rating: number,
  ): string => {
    if (matchedFavLabels.length >= 2) {
      return `Matches ${matchedFavLabels.slice(0, 2).join(' & ')}`;
    }
    if (matchedFavLabels.length === 1) {
      return `Favorite: ${matchedFavLabels[0]}`;
    }
    if (matchedSourceTitle && matchedLabels.length > 0) {
      const shortTitle =
        matchedSourceTitle.length > 18
          ? `${matchedSourceTitle.slice(0, 17).trimEnd()}…`
          : matchedSourceTitle;
      return `Because you watch ${shortTitle}`;
    }
    if (matchedLabels.length >= 2) {
      return `Matches ${matchedLabels.slice(0, 2).join(' & ')}`;
    }
    if (matchedLabels.length === 1) {
      return `Based on ${matchedLabels[0]}`;
    }
    if (matchedLangLabel) {
      const prettyLang = matchedLangLabel.charAt(0).toUpperCase() + matchedLangLabel.slice(1);
      return `${prettyLang} pick for you`;
    }
    if (rating >= 7.8) return 'Critically acclaimed pick';
    return 'Recommended pick';
  };

  const scoredMovies: Array<RecommendationEntry & { kind: 'movie' }> = [];
  for (const m of uniqueMovies) {
    if (!m.poster || /\b(CAM|HDCAM|TS|HDTS)\b/i.test(m.name)) continue;
    if (excludedMovieIds.has(m.streamId)) continue;
    const normTitle = normalizeCreditMatchTitle(m.cleanTitle);
    if (normTitle && excludedNormalizedTitles.has(normTitle)) continue;

    const entries = extractMovieGenreEntries(m).filter((g) => g.id !== '4k-uhd');
    const genreContribs: Array<{ id: string; label: string; weight: number; isFav: boolean }> = [];
    for (const entry of entries) {
      const w = genreWeights.get(entry.id) || 0;
      if (w > 0) {
        genreContribs.push({
          id: entry.id,
          label: entry.label,
          weight: w,
          isFav: favoriteAliasSet.has(entry.id),
        });
      }
    }
    genreContribs.sort((a, b) => b.weight - a.weight);

    const topContribs = genreContribs.slice(0, 3);
    const genreScore = topContribs.reduce((sum, item, idx) => sum + item.weight / (idx + 1), 0);

    let catBonus = 0;
    for (const tok of extractCategoryFlavorTokens(m.categoryName)) {
      const tw = categoryTokenWeights.get(tok);
      if (tw) {
        catBonus = Math.min(2.2, catBonus + Math.min(1.1, tw * 0.45));
      }
    }

    const lang = inferServerLanguage(m.name, m.categoryName);
    const langBonus = lang && languageWeights.has(lang) ? Math.min(2.2, (languageWeights.get(lang) || 0) * 0.7) : 0;

    // Require strong rating when not matched to taste signals
    if (personalized && genreScore === 0 && catBonus < 0.8 && m.rating < 6.8) continue;
    if (!personalized && m.rating < 6.8) continue;

    const qualityScore = (m.rating > 0 ? m.rating : 5.8) * 0.44;
    const recencyScore = maxAdded > 0 && m.added > 0 ? Math.max(0, Math.min(0.9, (m.added / maxAdded) * 0.9)) : 0;
    const totalScore = Math.round((genreScore + catBonus + langBonus + qualityScore + recencyScore) * 100) / 100;

    const matchedLabels = topContribs.map((c) => c.label);
    const matchedFavLabels = topContribs.filter((c) => c.isFav).map((c) => c.label);
    const sourceTitle = topContribs[0] ? genreSourceTitle.get(topContribs[0].id) : undefined;
    const reason = buildReason(
      matchedLabels,
      matchedFavLabels,
      sourceTitle,
      langBonus > 0 ? lang : undefined,
      m.rating,
    );

    scoredMovies.push({
      kind: 'movie',
      item: m,
      score: totalScore,
      reason,
      matchedGenres: matchedLabels,
    });
  }

  const scoredSeries: Array<RecommendationEntry & { kind: 'series' }> = [];
  for (const s of uniqueSeries) {
    if (!s.poster || /\b(CAM|HDCAM|TS|HDTS)\b/i.test(s.name)) continue;
    if (excludedSeriesIds.has(s.seriesId)) continue;
    const normTitle = normalizeCreditMatchTitle(s.cleanTitle);
    if (normTitle && excludedNormalizedTitles.has(normTitle)) continue;

    const entries = extractSeriesGenreEntries(s);
    const genreContribs: Array<{ id: string; label: string; weight: number; isFav: boolean }> = [];
    for (const entry of entries) {
      const w = genreWeights.get(entry.id) || 0;
      if (w > 0) {
        genreContribs.push({
          id: entry.id,
          label: entry.label,
          weight: w,
          isFav: favoriteAliasSet.has(entry.id),
        });
      }
    }
    genreContribs.sort((a, b) => b.weight - a.weight);

    const topContribs = genreContribs.slice(0, 3);
    const genreScore = topContribs.reduce((sum, item, idx) => sum + item.weight / (idx + 1), 0);

    let catBonus = 0;
    for (const tok of extractCategoryFlavorTokens(s.categoryName)) {
      const tw = categoryTokenWeights.get(tok);
      if (tw) {
        catBonus = Math.min(2.2, catBonus + Math.min(1.1, tw * 0.45));
      }
    }

    const lang = inferServerLanguage(s.name, s.categoryName);
    const langBonus = lang && languageWeights.has(lang) ? Math.min(2.2, (languageWeights.get(lang) || 0) * 0.7) : 0;

    if (personalized && genreScore === 0 && catBonus < 0.8 && s.rating < 6.8) continue;
    if (!personalized && s.rating < 6.8) continue;

    const qualityScore = (s.rating > 0 ? s.rating : 5.8) * 0.44;
    const recencyScore =
      maxModified > 0 && s.lastModified > 0
        ? Math.max(0, Math.min(0.9, (s.lastModified / maxModified) * 0.9))
        : 0;
    const totalScore = Math.round((genreScore + catBonus + langBonus + qualityScore + recencyScore) * 100) / 100;

    const matchedLabels = topContribs.map((c) => c.label);
    const matchedFavLabels = topContribs.filter((c) => c.isFav).map((c) => c.label);
    const sourceTitle = topContribs[0] ? genreSourceTitle.get(topContribs[0].id) : undefined;
    const reason = buildReason(
      matchedLabels,
      matchedFavLabels,
      sourceTitle,
      langBonus > 0 ? lang : undefined,
      s.rating,
    );

    scoredSeries.push({
      kind: 'series',
      item: s,
      score: totalScore,
      reason,
      matchedGenres: matchedLabels,
    });
  }

  scoredMovies.sort((a, b) => b.score - a.score || b.item.rating - a.item.rating);
  scoredSeries.sort((a, b) => b.score - a.score || b.item.rating - a.item.rating);

  const limit = Math.max(6, Math.min(36, Number(req.limit) || 18));
  const combined = [...scoredMovies.slice(0, 60), ...scoredSeries.slice(0, 60)].sort(
    (a, b) => b.score - a.score,
  );

  // Pick top items while keeping healthy category diversity and movie/series balance
  const selected: RecommendationEntry[] = [];
  const usedIds = new Set<string>();
  const categoryCount = new Map<string, number>();

  for (const candidate of combined) {
    if (selected.length >= limit) break;
    const key =
      candidate.kind === 'movie'
        ? `movie:${candidate.item.streamId}`
        : `series:${candidate.item.seriesId}`;
    if (usedIds.has(key)) continue;

    const catKey = `${candidate.kind}:${candidate.item.categoryId || candidate.item.categoryName}`;
    const catUsed = categoryCount.get(catKey) || 0;
    if (catUsed >= 3) continue;

    usedIds.add(key);
    categoryCount.set(catKey, catUsed + 1);
    selected.push(candidate);
  }

  // Relax category cap if needed to reach requested limit
  if (selected.length < limit) {
    for (const candidate of combined) {
      if (selected.length >= limit) break;
      const key =
        candidate.kind === 'movie'
          ? `movie:${candidate.item.streamId}`
          : `series:${candidate.item.seriesId}`;
      if (usedIds.has(key)) continue;
      usedIds.add(key);
      selected.push(candidate);
    }
  }

  const inferredGenres = Array.from(inferredHistoryScores.entries())
    .filter(([id]) => !id.startsWith('cinema-'))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 4)
    .map(([id, info]) => ({ id, label: info.label }));

  return {
    items: selected,
    inferredGenres,
    favoriteGenres,
    personalized,
  };
}

export async function getComingSoonReleases(): Promise<ComingSoonItem[]> {
  return cachedFetch('coming_soon_catalog_matched', 30 * 60 * 1000, async () => {
    const [upcoming, allMovies, allSeries] = await Promise.all([
      fetchUpcomingReleases().catch(() => []),
      getAllMovies().catch(() => [] as MovieSummary[]),
      getAllSeries().catch(() => [] as SeriesSummary[]),
    ]);

    const movieByNormTitle = new Map<string, MovieSummary>();
    for (const m of dedupeMovies(allMovies)) {
      const key = normalizeCreditMatchTitle(m.cleanTitle || m.name);
      if (key && !movieByNormTitle.has(key)) {
        movieByNormTitle.set(key, m);
      }
    }

    const seriesByNormTitle = new Map<string, SeriesSummary>();
    for (const s of dedupeSeries(allSeries)) {
      const key = normalizeCreditMatchTitle(s.cleanTitle || s.name);
      if (key && !seriesByNormTitle.has(key)) {
        seriesByNormTitle.set(key, s);
      }
    }

    return upcoming.map((item) => {
      const key = normalizeCreditMatchTitle(item.title);
      const matchedMovie = item.kind === 'movie' && key ? movieByNormTitle.get(key) : undefined;
      const matchedSeries = item.kind === 'series' && key ? seriesByNormTitle.get(key) : undefined;

      return {
        ...item,
        matchedCatalogId: matchedMovie?.streamId || matchedSeries?.seriesId,
        matchedCatalogKind: matchedMovie ? 'movie' : matchedSeries ? 'series' : undefined,
      };
    });
  });
}


