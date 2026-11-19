import type {
  AccountSummary,
  CategoryItem,
  ComingSoonItem,
  DownloadSizesResponse,
  EpgGuideResponse,
  EpgProgram,
  HomePayload,
  LiveChannelDetailResponse,
  LiveChannelSummary,
  MediaLanguagesResponse,
  MovieDetail,
  MovieSummary,
  PaginatedResponse,
  PersonCreditsResponse,
  RecommendationRequest,
  RecommendationsResponse,
  SeriesDetail,
  SeriesSummary,
  StreamFormat,
  StreamVariantsResponse,
  ImdbCastResponse,
  SubtitlesResponse,
} from '../types/media';

import {
  clearPersistentApiCache,
  getPersistentApiCache,
  putPersistentApiCache,
} from '../utils/apiCacheDb';
import { clearNavPersistence } from '../utils/navPersistence';
import { sanitizeUserErrorMessage } from '../utils/networkError';

const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes keeps catalogs/details loaded one-time
const LIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes keeps live channels, channel details & EPG instant
const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENT_CACHE_ENTRIES = 400;
const LOCAL_CACHE_PREFIX = 'cinebox_api_v1:';
const CACHE_EPOCH_KEY = 'cinebox_cache_epoch';
const LOCAL_PERSISTED_PATHS = new Set([
  '/api/home',
  '/api/movies/categories',
  '/api/series/categories',
  '/api/live/categories',
]);

const clientCatalogCache = new Map<string, { expiresAt: number; data: unknown }>();
const inFlightRequests = new Map<string, Promise<unknown>>();

function getCacheEpoch(): number {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(CACHE_EPOCH_KEY);
      const parsed = raw ? Number(raw) : 0;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
  } catch {
    // Ignore storage access errors
  }
  return 0;
}

function bumpCacheEpoch(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const next = getCacheEpoch() + 1;
      window.localStorage.setItem(CACHE_EPOCH_KEY, String(next));
    }
  } catch {
    // Ignore storage access errors
  }
}

function buildCacheFetchUrl(url: string): string {
  const epoch = getCacheEpoch();
  if (epoch <= 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}_v=${epoch}`;
}

function clearStorageByPrefix(storage: Storage | undefined, prefix: string): void {
  if (!storage) return;
  const toRemove: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (k && k.startsWith(prefix)) {
      toRemove.push(k);
    }
  }
  for (const k of toRemove) {
    storage.removeItem(k);
  }
}

export function clearClientCatalogCache(clearNavigation = false): void {
  clientCatalogCache.clear();
  inFlightRequests.clear();
  bumpCacheEpoch();
  void clearPersistentApiCache();
  if (clearNavigation) {
    clearNavPersistence();
  }
  try {
    if (typeof window !== 'undefined') {
      clearStorageByPrefix(window.localStorage, LOCAL_CACHE_PREFIX);
      clearStorageByPrefix(window.sessionStorage, LOCAL_CACHE_PREFIX);
    }
  } catch {
    // Ignore storage access errors
  }
}

function persistLocalSnapshot(key: string, expiresAt: number, data: unknown): void {
  if (!LOCAL_PERSISTED_PATHS.has(key)) return;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const serialized = JSON.stringify({ expiresAt, data });
      if (serialized.length <= 512 * 1024) {
        window.localStorage.setItem(LOCAL_CACHE_PREFIX + key, serialized);
      }
    }
  } catch {
    // Ignore storage quota errors
  }
}

function getCachedEntrySync<T>(key: string): T | undefined {
  const now = Date.now();
  const hit = clientCatalogCache.get(key);
  if (hit) {
    if (hit.expiresAt <= now) {
      clientCatalogCache.delete(key);
    } else {
      clientCatalogCache.delete(key);
      clientCatalogCache.set(key, hit);
      return hit.data as T;
    }
  }

  if (LOCAL_PERSISTED_PATHS.has(key)) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(LOCAL_CACHE_PREFIX + key);
        if (raw) {
          const parsed = JSON.parse(raw) as { expiresAt: number; data: T };
          if (parsed && parsed.expiresAt > now && parsed.data !== undefined) {
            clientCatalogCache.set(key, { expiresAt: parsed.expiresAt, data: parsed.data });
            return parsed.data;
          }
          window.localStorage.removeItem(LOCAL_CACHE_PREFIX + key);
        }
      }
    } catch {
      // Ignore storage access/parse errors
    }
  }
  return undefined;
}

function setCachedEntrySync(key: string, data: unknown, ttlMs = CATALOG_CACHE_TTL_MS): number {
  const expiresAt = Date.now() + ttlMs;
  if (clientCatalogCache.has(key)) {
    clientCatalogCache.delete(key);
  }
  while (clientCatalogCache.size >= MAX_CLIENT_CACHE_ENTRIES) {
    const oldestKey = clientCatalogCache.keys().next().value;
    if (oldestKey === undefined) break;
    clientCatalogCache.delete(oldestKey);
  }
  clientCatalogCache.set(key, { expiresAt, data });
  persistLocalSnapshot(key, expiresAt, data);
  return expiresAt;
}

function awaitWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new Error(
      sanitizeUserErrorMessage(err instanceof Error ? err.message : undefined),
    );
  }
  let data: unknown = null;
  let parseFailed = false;
  try {
    data = await res.json();
  } catch {
    parseFailed = true;
  }
  if (!res.ok) {
    const errObj = data && typeof data === 'object' ? (data as { error?: unknown }) : null;
    const rawMsg =
      errObj && typeof errObj.error === 'string'
        ? errObj.error
        : `Request failed with status ${res.status}`;
    throw new Error(sanitizeUserErrorMessage(rawMsg));
  }
  if (parseFailed || data === null) {
    throw new Error(sanitizeUserErrorMessage('Invalid response from server'));
  }
  return data as T;
}

function getStaleOrFreshMemoryCache<T>(key: string): T | undefined {
  const hit = clientCatalogCache.get(key);
  if (hit && hit.data !== undefined) {
    return hit.data as T;
  }
  return undefined;
}

export async function getCachedApiResponse<T>(key: string): Promise<T | null> {
  const memHit = getStaleOrFreshMemoryCache<T>(key);
  if (memHit !== undefined) return memHit;
  const idbHit = await getPersistentApiCache<T>(key);
  if (idbHit && idbHit.record.data !== undefined) {
    setCachedEntrySync(key, idbHit.record.data, CATALOG_CACHE_TTL_MS);
    return idbHit.record.data;
  }
  return null;
}

export function getCachedSeriesDetailSync(id: string): SeriesDetail | undefined {
  return getStaleOrFreshMemoryCache<SeriesDetail>(`/api/series/${encodeURIComponent(id)}`);
}

export function getCachedSeriesDetail(id: string): Promise<SeriesDetail | null> {
  return getCachedApiResponse<SeriesDetail>(`/api/series/${encodeURIComponent(id)}`);
}

export function getCachedMovieDetailSync(id: string): MovieDetail | undefined {
  return getStaleOrFreshMemoryCache<MovieDetail>(`/api/movies/${encodeURIComponent(id)}`);
}

export function getCachedMovieDetail(id: string): Promise<MovieDetail | null> {
  return getCachedApiResponse<MovieDetail>(`/api/movies/${encodeURIComponent(id)}`);
}

function invalidateCachedEntry(key: string): void {
  clientCatalogCache.delete(key);
  if (LOCAL_PERSISTED_PATHS.has(key)) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(LOCAL_CACHE_PREFIX + key);
      }
    } catch {
      // Ignore storage errors
    }
  }
}

async function requestJsonCached<T>(
  url: string,
  signal?: AbortSignal,
  ttlMs = CATALOG_CACHE_TTL_MS,
  validate?: (data: unknown) => data is T,
): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const cached = getCachedEntrySync<T>(url);
  if (cached !== undefined) {
    if (!validate || validate(cached)) {
      return cached;
    }
    invalidateCachedEntry(url);
  }

  let pending = inFlightRequests.get(url) as Promise<T> | undefined;
  if (!pending) {
    pending = (async () => {
      const idbHit = await getPersistentApiCache<T>(url);
      const validIdbHit =
        idbHit && (!validate || validate(idbHit.record.data)) ? idbHit : null;

      if (validIdbHit && !validIdbHit.isExpired) {
        const remainingMs = Math.max(1000, validIdbHit.record.expiresAt - Date.now());
        setCachedEntrySync(url, validIdbHit.record.data, remainingMs);
        return validIdbHit.record.data;
      }

      // If browser reports offline and we have a persistent cached copy, return it immediately without network wait
      if (validIdbHit && typeof navigator !== 'undefined' && navigator.onLine === false) {
        setCachedEntrySync(url, validIdbHit.record.data, 60_000);
        return validIdbHit.record.data;
      }

      try {
        const data = await requestJson<T>(buildCacheFetchUrl(url));
        if (validate && !validate(data)) {
          throw new Error(sanitizeUserErrorMessage('Invalid response payload'));
        }
        const expiresAt = setCachedEntrySync(url, data, ttlMs);
        void putPersistentApiCache(url, data, expiresAt);
        return data;
      } catch (err) {
        // Stale-if-error fallback so Android WebView cold boots offline or on spotty cellular still work
        if (validIdbHit) {
          setCachedEntrySync(url, validIdbHit.record.data, 60_000);
          return validIdbHit.record.data;
        }
        throw err;
      }
    })().finally(() => {
      if (inFlightRequests.get(url) === pending) {
        inFlightRequests.delete(url);
      }
    });
    inFlightRequests.set(url, pending);
  }

  return awaitWithAbortSignal(pending, signal);
}

function isValidHomePayload(data: unknown): data is HomePayload {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Partial<HomePayload>;
  return (
    Array.isArray(obj.heroItems) &&
    Array.isArray(obj.trendingMovies) &&
    Array.isArray(obj.popularSeries) &&
    Array.isArray(obj.featuredLive)
  );
}

export async function fetchHome(signal?: AbortSignal): Promise<HomePayload> {
  const data = await requestJsonCached<HomePayload>(
    '/api/home',
    signal,
    CATALOG_CACHE_TTL_MS,
    isValidHomePayload,
  );
  return {
    heroItems: Array.isArray(data?.heroItems) ? data.heroItems : [],
    trendingMovies: Array.isArray(data?.trendingMovies) ? data.trendingMovies : [],
    popularSeries: Array.isArray(data?.popularSeries) ? data.popularSeries : [],
    featuredLive: Array.isArray(data?.featuredLive) ? data.featuredLive : [],
    stats: data?.stats || {
      movieCount: 0,
      seriesCount: 0,
      liveCount: 0,
      epgChannelCount: 0,
      catchupCount: 0,
    },
  };
}

export function fetchComingSoon(signal?: AbortSignal): Promise<{ items: ComingSoonItem[] }> {
  return requestJsonCached<{ items: ComingSoonItem[] }>(
    '/api/coming-soon',
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function fetchRecommendations(
  payload: RecommendationRequest,
  signal?: AbortSignal,
): Promise<RecommendationsResponse> {
  return requestJson<RecommendationsResponse>('/api/recommendations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

export function fetchAccount(signal?: AbortSignal): Promise<AccountSummary> {
  return requestJsonCached<AccountSummary>('/api/account', signal, ACCOUNT_CACHE_TTL_MS);
}

export function fetchMovieCategories(signal?: AbortSignal): Promise<{ categories: CategoryItem[] }> {
  return requestJsonCached<{ categories: CategoryItem[] }>('/api/movies/categories', signal);
}

export function fetchMovies(
  params: {
    categoryId?: string;
    genre?: string;
    q?: string;
    sort?: 'newest' | 'rating' | 'az';
    page?: number;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<PaginatedResponse<MovieSummary>> {
  const qs = new URLSearchParams();
  if (params.categoryId) qs.set('categoryId', params.categoryId);
  if (params.genre) qs.set('genre', params.genre);
  if (params.q) qs.set('q', params.q);
  if (params.sort) qs.set('sort', params.sort);
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  return requestJsonCached<PaginatedResponse<MovieSummary>>(`/api/movies?${qs.toString()}`, signal);
}

export function fetchMovieDetail(id: string, signal?: AbortSignal): Promise<MovieDetail> {
  return requestJsonCached<MovieDetail>(`/api/movies/${encodeURIComponent(id)}`, signal);
}

export function fetchSeriesCategories(signal?: AbortSignal): Promise<{ categories: CategoryItem[] }> {
  return requestJsonCached<{ categories: CategoryItem[] }>('/api/series/categories', signal);
}

export function fetchSeriesList(
  params: {
    categoryId?: string;
    genre?: string;
    q?: string;
    sort?: 'newest' | 'rating' | 'az';
    page?: number;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<PaginatedResponse<SeriesSummary>> {
  const qs = new URLSearchParams();
  if (params.categoryId) qs.set('categoryId', params.categoryId);
  if (params.genre) qs.set('genre', params.genre);
  if (params.q) qs.set('q', params.q);
  if (params.sort) qs.set('sort', params.sort);
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  return requestJsonCached<PaginatedResponse<SeriesSummary>>(`/api/series?${qs.toString()}`, signal);
}

export function fetchSeriesDetail(id: string, signal?: AbortSignal): Promise<SeriesDetail> {
  return requestJsonCached<SeriesDetail>(`/api/series/${encodeURIComponent(id)}`, signal);
}

export function fetchTrailerPreview(
  kind: 'movie' | 'series',
  id: string,
  signal?: AbortSignal,
): Promise<{ youtubeTrailer: string }> {
  return requestJsonCached<{ youtubeTrailer: string }>(
    `/api/trailer/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function fetchLiveCategories(signal?: AbortSignal): Promise<{ categories: CategoryItem[] }> {
  return requestJsonCached<{ categories: CategoryItem[] }>('/api/live/categories', signal, CATALOG_CACHE_TTL_MS);
}

export function fetchLiveChannels(
  params: {
    categoryId?: string;
    genre?: string;
    q?: string;
    hasEpg?: boolean;
    hasCatchup?: boolean;
    page?: number;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<PaginatedResponse<LiveChannelSummary>> {
  const qs = new URLSearchParams();
  if (params.categoryId) qs.set('categoryId', params.categoryId);
  if (params.genre) qs.set('genre', params.genre);
  if (params.q) qs.set('q', params.q);
  if (params.hasEpg) qs.set('hasEpg', 'true');
  if (params.hasCatchup) qs.set('hasCatchup', 'true');
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  return requestJsonCached<PaginatedResponse<LiveChannelSummary>>(
    `/api/live?${qs.toString()}`,
    signal,
    LIVE_CACHE_TTL_MS,
  );
}

export function fetchLiveChannelDetail(
  streamId: string,
  signal?: AbortSignal,
): Promise<LiveChannelDetailResponse> {
  return requestJsonCached<LiveChannelDetailResponse>(
    `/api/live/${encodeURIComponent(streamId)}`,
    signal,
    LIVE_CACHE_TTL_MS,
  );
}

export function fetchChannelEpg(
  streamId: string,
  signal?: AbortSignal,
): Promise<{ programs: EpgProgram[]; serverTimestamp: number }> {
  return requestJsonCached<{ programs: EpgProgram[]; serverTimestamp: number }>(
    `/api/live/${encodeURIComponent(streamId)}/epg`,
    signal,
    LIVE_CACHE_TTL_MS,
  );
}

export function fetchEpgGuide(
  params: {
    categoryId?: string;
    q?: string;
    catchupOnly?: boolean;
    offsetHours?: number;
    windowHours?: number;
    page?: number;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<EpgGuideResponse> {
  const qs = new URLSearchParams();
  if (params.categoryId) qs.set('categoryId', params.categoryId);
  if (params.q) qs.set('q', params.q);
  if (params.catchupOnly) qs.set('catchupOnly', 'true');
  if (params.offsetHours !== undefined) qs.set('offsetHours', String(params.offsetHours));
  if (params.windowHours !== undefined) qs.set('windowHours', String(params.windowHours));
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  return requestJsonCached<EpgGuideResponse>(
    `/api/epg/guide?${qs.toString()}`,
    signal,
    LIVE_CACHE_TTL_MS,
  );
}

export function omniSearch(
  q: string,
  signal?: AbortSignal,
): Promise<{
  movies: MovieSummary[];
  series: SeriesSummary[];
  live: LiveChannelSummary[];
}> {
  return requestJsonCached(`/api/search?q=${encodeURIComponent(q)}`, signal, LIVE_CACHE_TTL_MS);
}

export async function updateConnection(payload: {
  host: string;
  username: string;
  password: string;
  format: StreamFormat;
}): Promise<AccountSummary> {
  const res = await requestJson<AccountSummary>('/api/settings/connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  clearClientCatalogCache(true);
  return res;
}

export function updateStreamFormat(format: StreamFormat): Promise<{ format: StreamFormat }> {
  return requestJson<{ format: StreamFormat }>('/api/settings/format', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format }),
  });
}

export async function resetConnection(): Promise<AccountSummary> {
  const res = await requestJson<AccountSummary>('/api/settings/reset', { method: 'POST' });
  clearClientCatalogCache(true);
  return res;
}

export async function refreshServerCache(): Promise<{ ok: boolean }> {
  const res = await requestJson<{ ok: boolean }>('/api/settings/refresh-cache', { method: 'POST' });
  clearClientCatalogCache(false);
  return res;
}

export function fetchMediaLanguages(
  params: {
    kind: 'movie' | 'episode';
    id: string;
    extension?: string;
    seriesId?: string;
    seasonNum?: number;
    episodeNum?: number;
    title?: string;
    skipProbe?: boolean;
  },
  signal?: AbortSignal,
): Promise<MediaLanguagesResponse> {
  const qs = new URLSearchParams();
  if (params.extension) qs.set('ext', params.extension);
  if (params.seriesId) qs.set('seriesId', params.seriesId);
  if (params.seasonNum) qs.set('seasonNum', String(params.seasonNum));
  if (params.episodeNum) qs.set('episodeNum', String(params.episodeNum));
  if (params.title) qs.set('title', params.title);
  if (params.skipProbe) qs.set('skipProbe', '1');
  return requestJsonCached<MediaLanguagesResponse>(
    `/api/media/languages/${encodeURIComponent(params.kind)}/${encodeURIComponent(
      params.id,
    )}?${qs.toString()}`,
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function searchByPerson(
  params: {
    name: string;
    imdbId?: string;
    excludeKind?: 'movie' | 'series';
    excludeId?: string;
  },
  signal?: AbortSignal,
): Promise<PersonCreditsResponse> {
  const qs = new URLSearchParams();
  qs.set('name', params.name);
  if (params.imdbId) qs.set('imdbId', params.imdbId);
  if (params.excludeKind) qs.set('excludeKind', params.excludeKind);
  if (params.excludeId) qs.set('excludeId', params.excludeId);
  return requestJsonCached<PersonCreditsResponse>(
    `/api/search/person?${qs.toString()}`,
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function fetchImdbCast(
  params: {
    title?: string;
    year?: string | null;
    cast?: string;
    director?: string;
    kind?: string;
    id?: string;
    tmdbId?: string;
  },
  signal?: AbortSignal,
): Promise<ImdbCastResponse> {
  const qs = new URLSearchParams();
  if (params.title) qs.set('title', params.title);
  if (params.year) qs.set('year', params.year);
  if (params.cast) qs.set('cast', params.cast);
  if (params.director) qs.set('director', params.director);
  if (params.kind) qs.set('kind', params.kind);
  if (params.id) qs.set('id', params.id);
  if (params.tmdbId) qs.set('tmdbId', params.tmdbId);
  return requestJsonCached<ImdbCastResponse>(
    `/api/imdb/cast?${qs.toString()}`,
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function fetchImdbPoster(
  title: string,
  year?: string | null,
  signal?: AbortSignal,
): Promise<{ poster: string; imdbId?: string }> {
  const qs = new URLSearchParams();
  qs.set('title', title);
  if (year) qs.set('year', year);
  return requestJsonCached<{ poster: string; imdbId?: string }>(
    `/api/imdb/poster?${qs.toString()}`,
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function fetchChannelLogo(
  name: string,
  category?: string,
  signal?: AbortSignal,
): Promise<{ logo: string | null }> {
  const qs = new URLSearchParams();
  qs.set('name', name);
  if (category) qs.set('category', category);
  return requestJsonCached<{ logo: string | null }>(
    `/api/channel-logo?${qs.toString()}`,
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function fetchSubtitles(
  params: {
    kind: string;
    streamId: string;
    season?: number;
    episode?: number;
    title?: string;
    year?: string | null;
    seriesId?: string;
    imdbId?: string;
    q?: string;
  },
  signal?: AbortSignal,
): Promise<SubtitlesResponse> {
  const qs = new URLSearchParams();
  if (params.season !== undefined) qs.set('season', String(params.season));
  if (params.episode !== undefined) qs.set('episode', String(params.episode));
  if (params.title) qs.set('title', params.title);
  if (params.year) qs.set('year', params.year);
  if (params.seriesId) qs.set('seriesId', params.seriesId);
  if (params.imdbId) qs.set('imdbId', params.imdbId);
  if (params.q) qs.set('q', params.q);
  return requestJsonCached<SubtitlesResponse>(
    `/api/subtitles/list/${encodeURIComponent(params.kind)}/${encodeURIComponent(
      params.streamId,
    )}?${qs.toString()}`,
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function fetchStreamVariants(
  kind: 'movie' | 'episode' | 'series' | 'live' | 'catchup' | 'vod',
  id: string,
  ext = 'mp4',
  signal?: AbortSignal,
): Promise<StreamVariantsResponse & { directUrl?: string }> {
  const apiKind = kind === 'episode' ? 'series' : kind === 'movie' ? 'vod' : kind;
  const qs = new URLSearchParams();
  if (ext) qs.set('ext', ext);
  return requestJson<StreamVariantsResponse & { directUrl?: string }>(
    `/api/play/variants/${encodeURIComponent(apiKind)}/${encodeURIComponent(id)}?${qs.toString()}`,
    { signal },
  );
}

export function fetchDownloadSizes(
  params: {
    kind: 'movie' | 'episode' | 'series' | 'vod';
    id: string;
    ext?: string;
    durationSec?: number;
    quick?: boolean;
  },
  signal?: AbortSignal,
): Promise<DownloadSizesResponse> {
  const apiKind = params.kind === 'episode' ? 'series' : params.kind === 'movie' ? 'vod' : params.kind;
  const qs = new URLSearchParams();
  if (params.ext) qs.set('ext', params.ext);
  if (params.durationSec && Number.isFinite(params.durationSec) && params.durationSec > 0) {
    qs.set('durationSec', String(Math.round(params.durationSec)));
  }
  if (params.quick) qs.set('quick', '1');
  return requestJsonCached<DownloadSizesResponse>(
    `/api/play/download-sizes/${encodeURIComponent(apiKind)}/${encodeURIComponent(
      params.id,
    )}?${qs.toString()}`,
    signal,
    CATALOG_CACHE_TTL_MS,
  );
}

export function preloadStreamMedia(
  params: {
    kind: 'movie' | 'episode' | 'series' | 'live' | 'vod';
    id: string;
    ext?: string;
    quality?: string;
    startSec?: number;
    durationSec?: number;
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; mode?: string; sessionId?: string; playlistUrl?: string; skipped?: string }> {
  const apiKind = params.kind === 'episode' ? 'series' : params.kind === 'vod' ? 'movie' : params.kind;
  const qs = new URLSearchParams();
  if (params.ext) qs.set('ext', params.ext);
  if (params.quality) qs.set('quality', params.quality);
  if (params.startSec && params.startSec > 0) qs.set('startSec', String(Math.floor(params.startSec)));
  if (params.durationSec && params.durationSec > 0) qs.set('durationSec', String(Math.floor(params.durationSec)));
  return fetch(
    `/api/play/preload/${encodeURIComponent(apiKind)}/${encodeURIComponent(params.id)}?${qs.toString()}`,
    { method: 'GET', cache: 'no-store', signal },
  )
    .then((r) => r.json())
    .catch(() => ({ ok: false }));
}


