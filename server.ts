import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearAllCaches,
  getAccountSummary,
  getChannelEpg,
  getComingSoonReleases,
  getEpgGuide,
  getHomePayload,
  getLiveCategories,
  getLiveChannelDetail,
  getMovieCategories,
  getMovieDetail,
  getPersonalizedRecommendations,
  getSeriesCategories,
  getSeriesDetail,
  omniSearch,
  queryLiveChannels,
  queryMovies,
  querySeries,
  resetConfig,
  searchByPerson,
  setStreamFormat,
  updateConfig,
} from './server/xtream.ts';
import {
  handleCancelOfflineDownloadJob,
  handleCatchupPlay,
  handleCloseHlsSession,
  handleCloseQualitySession,
  handleCreateHlsSession,
  handleDownloadSizes,
  handleHlsSessionPlaylist,
  handleHlsSessionSegment,
  handleHlsTokenProxy,
  handleImageProxy,
  handleInspectStreamVariants,
  handleLivePlay,
  handleMediaLanguages,
  handleOfflineDirectFileDownload,
  handleOfflineDownloadStream,
  handlePauseOfflineDownloadJob,
  handlePreloadStream,
  handleQualityChunkStream,
  handleSeriesPlay,
  handleStartHlsSessionGet,
  handleTranscodeInfo,
  handleTranscodePlay,
  handleVodPlay,
} from './server/proxy.ts';
import {
  downloadAndConvertToVtt,
  getFullCastWithPictures,
  getSubtitlesForStream,
  searchImdbTitle,
} from './server/imdb.ts';
import { lookupChannelLogo } from './server/channelLogos.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveServerPort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  const envPort = Number(process.env.PORT || 0);
  const nginxPort = Number(process.env.NGINX_PORT || 0);
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT || 3000);
  if (envPort && nginxPort && envPort === nginxPort) {
    return defaultAppPort;
  }
  return envPort || defaultAppPort;
}

const PORT = resolveServerPort();

function resolveApiCacheControl(reqPath: string): string {
  if (
    reqPath === '/home' ||
    reqPath === '/coming-soon' ||
    reqPath === '/movies' ||
    reqPath.startsWith('/movies/') ||
    reqPath === '/series' ||
    reqPath.startsWith('/series/') ||
    reqPath.startsWith('/trailer/') ||
    reqPath.startsWith('/media/languages/') ||
    reqPath.startsWith('/imdb/') ||
    reqPath === '/channel-logo' ||
    reqPath.startsWith('/subtitles/list/') ||
    reqPath === '/search/person'
  ) {
    return 'private, max-age=1800, stale-while-revalidate=3600';
  }
  if (
    reqPath === '/live' ||
    reqPath.startsWith('/live/') ||
    reqPath.startsWith('/epg/') ||
    reqPath === '/search'
  ) {
    return 'private, max-age=300, stale-while-revalidate=600';
  }
  return 'no-store';
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.use('/api', (req, res, next) => {
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '*';
    res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
    if (requestOrigin && requestOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Range, Authorization, Accept, X-Requested-With',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, X-Media-Duration-Sec, X-Stream-Has-Audio, X-Stream-EOF, X-Download-EOF, X-Download-Total-Bytes, X-Estimated-Total-Bytes, X-Direct-Total-Bytes',
    );

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Cache-Control', 'no-store');
      next();
      return;
    }
    const cachePolicy = resolveApiCacheControl(req.path);
    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (!res.hasHeader('Cache-Control')) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          res.setHeader('Cache-Control', cachePolicy);
        } else {
          res.setHeader('Cache-Control', 'no-store');
        }
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/account', async (_req, res) => {
    try {
      const account = await getAccountSummary();
      res.json(account);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to fetch account info',
      });
    }
  });

  app.post('/api/settings/connection', async (req, res) => {
    try {
      const { host, username, password, format } = req.body || {};
      const account = await updateConfig({
        host: String(host || ''),
        username: String(username || ''),
        password: String(password || ''),
        format: format === 'm3u8' ? 'm3u8' : 'ts',
      });
      res.json(account);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Connection failed',
      });
    }
  });

  app.post('/api/settings/format', (req, res) => {
    const format = req.body?.format === 'm3u8' ? 'm3u8' : 'ts';
    const updated = setStreamFormat(format);
    res.json({ format: updated.format });
  });

  app.post('/api/settings/reset', async (_req, res) => {
    try {
      const account = await resetConfig();
      res.json(account);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to reset connection',
      });
    }
  });

  app.post('/api/settings/refresh-cache', (_req, res) => {
    clearAllCaches();
    res.json({ ok: true });
  });

  app.get('/api/home', async (_req, res) => {
    try {
      const data = await getHomePayload();
      res.json(data);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load home showcase',
      });
    }
  });

  app.get('/api/coming-soon', async (_req, res) => {
    try {
      const items = await getComingSoonReleases();
      res.json({ items });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load upcoming releases',
      });
    }
  });

  app.post('/api/recommendations', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const data = await getPersonalizedRecommendations({
        favoriteGenres: Array.isArray(body.favoriteGenres) ? body.favoriteGenres : [],
        watchedMovieIds: Array.isArray(body.watchedMovieIds) ? body.watchedMovieIds : [],
        watchedSeriesIds: Array.isArray(body.watchedSeriesIds) ? body.watchedSeriesIds : [],
        watchlistMovieIds: Array.isArray(body.watchlistMovieIds) ? body.watchlistMovieIds : [],
        watchlistSeriesIds: Array.isArray(body.watchlistSeriesIds) ? body.watchlistSeriesIds : [],
        watchedCategories: Array.isArray(body.watchedCategories) ? body.watchedCategories : [],
        watchedLanguages: Array.isArray(body.watchedLanguages) ? body.watchedLanguages : [],
        likedTitles: Array.isArray(body.likedTitles) ? body.likedTitles : [],
        limit: typeof body.limit === 'number' ? body.limit : 18,
      });
      res.json(data);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to generate recommendations',
      });
    }
  });

  app.get('/api/search', async (req, res) => {
    try {
      const q = String(req.query.q || '');
      const data = await omniSearch(q);
      res.json(data);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Search failed',
      });
    }
  });

  app.get('/api/search/person', async (req, res) => {
    try {
      const name = String(req.query.name || '').trim();
      if (!name) {
        return res.status(400).json({ error: 'Person name is required' });
      }
      const imdbId = req.query.imdbId ? String(req.query.imdbId).trim() : undefined;
      const excludeKindRaw = String(req.query.excludeKind || '');
      const excludeKind =
        excludeKindRaw === 'movie' || excludeKindRaw === 'series'
          ? excludeKindRaw
          : undefined;
      const excludeId = req.query.excludeId ? String(req.query.excludeId).trim() : undefined;
      const data = await searchByPerson({ name, imdbId, excludeKind, excludeId });
      res.json(data);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Person credit search failed',
      });
    }
  });

  app.get('/api/movies/categories', async (_req, res) => {
    try {
      const categories = await getMovieCategories();
      res.json({ categories });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load movie categories',
      });
    }
  });

  app.get('/api/movies', async (req, res) => {
    try {
      const sortParam = String(req.query.sort || 'newest');
      const sort =
        sortParam === 'rating' || sortParam === 'az' ? sortParam : 'newest';
      const result = await queryMovies({
        categoryId: String(req.query.categoryId || ''),
        genre: String(req.query.genre || ''),
        q: String(req.query.q || ''),
        sort,
        page: Number(req.query.page || 1),
        limit: Number(req.query.limit || 36),
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load movies',
      });
    }
  });

  app.get('/api/movies/:id', async (req, res) => {
    try {
      const detail = await getMovieDetail(String(req.params.id || ''));
      res.json(detail);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load movie details',
      });
    }
  });

  app.get('/api/series/categories', async (_req, res) => {
    try {
      const categories = await getSeriesCategories();
      res.json({ categories });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load series categories',
      });
    }
  });

  app.get('/api/series', async (req, res) => {
    try {
      const sortParam = String(req.query.sort || 'newest');
      const sort =
        sortParam === 'rating' || sortParam === 'az' ? sortParam : 'newest';
      const result = await querySeries({
        categoryId: String(req.query.categoryId || ''),
        genre: String(req.query.genre || ''),
        q: String(req.query.q || ''),
        sort,
        page: Number(req.query.page || 1),
        limit: Number(req.query.limit || 36),
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load series',
      });
    }
  });

  app.get('/api/series/:id', async (req, res) => {
    try {
      const detail = await getSeriesDetail(String(req.params.id || ''));
      res.json(detail);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load series details',
      });
    }
  });

  app.get('/api/trailer/:kind/:id', async (req, res) => {
    try {
      const kind = String(req.params.kind || '').toLowerCase();
      const id = String(req.params.id || '').trim();
      if (!id || (kind !== 'movie' && kind !== 'series')) {
        return res.status(400).json({ error: 'Invalid trailer target' });
      }
      if (kind === 'movie') {
        const detail = await getMovieDetail(id, { includeRelated: false });
        return res.json({ youtubeTrailer: detail.youtubeTrailer || '' });
      }
      const detail = await getSeriesDetail(id, { includeRelated: false });
      return res.json({ youtubeTrailer: detail.youtubeTrailer || '' });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to resolve trailer preview',
      });
    }
  });

  app.get('/api/live/categories', async (_req, res) => {
    try {
      const categories = await getLiveCategories();
      res.json({ categories });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load channel categories',
      });
    }
  });

  app.get('/api/live', async (req, res) => {
    try {
      const result = await queryLiveChannels({
        categoryId: String(req.query.categoryId || ''),
        genre: String(req.query.genre || ''),
        q: String(req.query.q || ''),
        hasEpg: req.query.hasEpg === 'true',
        hasCatchup: req.query.hasCatchup === 'true',
        page: Number(req.query.page || 1),
        limit: Number(req.query.limit || 48),
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load live channels',
      });
    }
  });

  app.get('/api/live/:id', async (req, res) => {
    try {
      const detail = await getLiveChannelDetail(String(req.params.id || ''));
      res.json(detail);
    } catch (err) {
      res.status(404).json({
        error: err instanceof Error ? err.message : 'Unable to load live channel details',
      });
    }
  });

  app.get('/api/live/:id/epg', async (req, res) => {
    try {
      const account = await getAccountSummary().catch(() => null);
      const programs = await getChannelEpg(
        String(req.params.id || ''),
        account?.serverTimestamp,
      );
      res.json({ programs, serverTimestamp: account?.serverTimestamp || Math.floor(Date.now() / 1000) });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load channel EPG',
      });
    }
  });

  app.get('/api/epg/guide', async (req, res) => {
    try {
      const guide = await getEpgGuide({
        categoryId: String(req.query.categoryId || ''),
        q: String(req.query.q || ''),
        catchupOnly: req.query.catchupOnly === 'true',
        windowOffsetHours: Number(req.query.offsetHours || 0),
        windowHours: req.query.windowHours ? Number(req.query.windowHours) : undefined,
        page: Number(req.query.page || 1),
        limit: Number(req.query.limit || 18),
      });
      res.json(guide);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load EPG TV guide',
      });
    }
  });

  // Media & Image Proxy Endpoints
  app.get('/api/proxy/image', handleImageProxy);
  app.get('/api/play/live/:streamId', handleLivePlay);
  app.head('/api/play/live/:streamId', handleLivePlay);
  app.get('/api/play/vod/:streamId', handleVodPlay);
  app.head('/api/play/vod/:streamId', handleVodPlay);
  app.get('/api/play/series/:episodeId', handleSeriesPlay);
  app.head('/api/play/series/:episodeId', handleSeriesPlay);
  app.get('/api/play/probe/:kind/:id', handleTranscodeInfo);
  app.get('/api/play/variants/:kind/:id', handleInspectStreamVariants);
  app.get('/api/play/download-info/:kind/:id', handleInspectStreamVariants);
  app.get('/api/play/download-sizes/:kind/:id', handleDownloadSizes);
  app.get('/api/play/transcode/:kind/:id', handleTranscodePlay);
  app.head('/api/play/transcode/:kind/:id', handleTranscodePlay);
  app.get('/api/play/quality-chunk/:kind/:id', handleQualityChunkStream);
  app.delete('/api/play/quality-session/:jobId', handleCloseQualitySession);
  app.get('/api/play/download/:kind/:id', handleOfflineDownloadStream);
  app.head('/api/play/download/:kind/:id', handleOfflineDownloadStream);
  app.get('/api/play/download-file/:kind/:id', handleOfflineDirectFileDownload);
  app.head('/api/play/download-file/:kind/:id', handleOfflineDirectFileDownload);
  app.post('/api/play/download/job/:jobId/pause', handlePauseOfflineDownloadJob);
  app.delete('/api/play/download/job/:jobId', handleCancelOfflineDownloadJob);
  app.get('/api/media/languages/:kind/:id', handleMediaLanguages);
  app.get('/api/play/catchup/:streamId', handleCatchupPlay);
  app.head('/api/play/catchup/:streamId', handleCatchupPlay);
  app.get('/api/play/preload/:kind/:id', handlePreloadStream);
  app.post('/api/play/preload/:kind/:id', handlePreloadStream);
  app.get('/api/play/hls', handleHlsTokenProxy);
  app.head('/api/play/hls', handleHlsTokenProxy);
  app.get('/api/play/hls-start/:kind/:id', handleStartHlsSessionGet);
  app.post('/api/play/hls-session', handleCreateHlsSession);
  app.get('/api/play/hls-session/:sessionId/playlist.m3u8', handleHlsSessionPlaylist);
  app.head('/api/play/hls-session/:sessionId/playlist.m3u8', handleHlsSessionPlaylist);
  app.get('/api/play/hls-session/:sessionId/:segment', handleHlsSessionSegment);
  app.head('/api/play/hls-session/:sessionId/:segment', handleHlsSessionSegment);
  app.delete('/api/play/hls-session/:sessionId', handleCloseHlsSession);

  // IMDb Cast, Crew & Pictures Endpoint
  app.get('/api/imdb/cast', async (req, res) => {
    try {
      let title = String(req.query.title || '');
      let year = req.query.year ? String(req.query.year) : null;
      let castStr = String(req.query.cast || '');
      let directorStr = String(req.query.director || '');
      let tmdbId = String(req.query.tmdbId || '');
      const kind = String(req.query.kind || '');
      const id = String(req.query.id || '');

      // If id is provided and metadata is missing, look up detail from Xtream
      if (id && (!title || !castStr || !directorStr || !tmdbId)) {
        if (kind === 'series') {
          const detail = await getSeriesDetail(id, { includeRelated: false }).catch(() => null);
          if (detail) {
            title = title || detail.cleanTitle;
            year = year || detail.year;
            castStr = castStr || detail.cast;
            directorStr = directorStr || detail.director;
            tmdbId = tmdbId || detail.tmdbId || '';
          }
        } else {
          const detail = await getMovieDetail(id, { includeRelated: false }).catch(() => null);
          if (detail) {
            title = title || detail.cleanTitle;
            year = year || detail.year;
            castStr = castStr || detail.cast;
            directorStr = directorStr || detail.director;
            tmdbId = tmdbId || detail.tmdbId || '';
          }
        }
      }

      if (!title) {
        return res.status(400).json({ error: 'Title or stream ID is required' });
      }

      const result = await getFullCastWithPictures(title, year, castStr, directorStr, kind, tmdbId);
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to load IMDb cast',
      });
    }
  });

  // IMDb Thumbnail / Poster Fallback Endpoint
  app.get('/api/imdb/poster', async (req, res) => {
    try {
      const title = String(req.query.title || '');
      const year = req.query.year ? String(req.query.year) : null;
      const kind = req.query.kind ? String(req.query.kind) : undefined;
      if (!title) {
        return res.status(400).json({ error: 'Title is required' });
      }

      const found = await searchImdbTitle(title, year, kind);
      if (found && found.poster) {
        if (req.query.redirect === 'true') {
          return res.redirect(`/api/proxy/image?url=${encodeURIComponent(found.poster)}`);
        }
        return res.json({ poster: found.poster, imdbId: found.imdbId });
      }
      res.status(404).json({ error: 'No IMDb poster found' });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to query IMDb thumbnail',
      });
    }
  });

  // Authentic TV Channel Logo Fallback Endpoint (iptv-org)
  app.get('/api/channel-logo', async (req, res) => {
    try {
      const name = String(req.query.name || '').trim();
      const category = String(req.query.category || '').trim();
      if (!name) {
        return res.json({ logo: null });
      }
      const logo = await lookupChannelLogo(name, category);
      res.json({ logo });
    } catch {
      res.json({ logo: null });
    }
  });

  // Subtitles by Stream ID (Movie or Series Episode)
  app.get('/api/subtitles/list/:kind/:streamId', async (req, res) => {
    try {
      const { kind, streamId } = req.params;
      const season = req.query.season ? Number(req.query.season) : undefined;
      const episode = req.query.episode ? Number(req.query.episode) : undefined;
      const customQuery = String(req.query.q || '').trim();
      let title = String(req.query.title || '');
      let year = req.query.year ? String(req.query.year) : null;
      let imdbId = String(req.query.imdbId || '');

      if (!customQuery && (!imdbId || !title || !year)) {
        if (kind === 'series' || kind === 'episode') {
          const seriesId = String(req.query.seriesId || streamId);
          const detail = await getSeriesDetail(seriesId, { includeRelated: false }).catch(() => null);
          if (detail) {
            if (!title) title = detail.cleanTitle;
            if (!year) year = detail.year;
            if (!imdbId && detail.tmdbId && detail.tmdbId.startsWith('tt')) {
              imdbId = detail.tmdbId;
            }
          }
        } else {
          const detail = await getMovieDetail(streamId, { includeRelated: false }).catch(() => null);
          if (detail) {
            if (!title) title = detail.cleanTitle;
            if (!year) year = detail.year;
            if (!imdbId && detail.tmdbId && detail.tmdbId.startsWith('tt')) {
              imdbId = detail.tmdbId;
            }
          }
        }
      }

      const result = await getSubtitlesForStream({
        imdbId,
        title,
        year,
        kind: kind === 'series' || kind === 'episode' ? 'series' : 'movie',
        season,
        episode,
        query: customQuery || undefined,
      });

      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to search subtitles',
      });
    }
  });

  // WebVTT Subtitle Proxy Endpoint
  app.get('/api/subtitles/vtt', async (req, res) => {
    try {
      const url = String(req.query.url || '');
      if (!url) {
        return res.status(400).send('Subtitle download URL is required');
      }

      const vttContent = await downloadAndConvertToVtt(url);
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(vttContent);
    } catch (err) {
      res.status(502).send('WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n[Subtitles unavailable]');
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    if (process.env.DISABLE_HMR !== 'false') {
      process.env.DISABLE_HMR = 'true';
    }
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        watch: null,
      },
      appType: 'spa',
    });
    // Vite 8 still executes wsTransport.connect() inside /@vite/client in middlewareMode;
    // serve a clean HMR-disabled client shim preserving updateStyle/removeStyle/createHotContext without WebSockets.
    app.get('/@vite/client', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(`
const sheetsMap = new Map();
export class ErrorOverlay extends HTMLElement {}
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  const noop = () => {};
  return {
    data: {},
    accept: noop,
    acceptExports: noop,
    dispose: noop,
    prune: noop,
    invalidate: noop,
    decline: noop,
    on: noop,
    off: noop,
    send: noop,
  };
}
export function injectQuery(url, queryToInject) {
  if (!url || (url[0] !== '.' && url[0] !== '/')) return url;
  const pathname = url.replace(/[?#].*$/, '');
  const parsed = new URL(url, 'http://vite.dev');
  return pathname + '?' + queryToInject + (parsed.search ? '&' + parsed.search.slice(1) : '') + (parsed.hash || '');
}
`.trimStart());
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CineBox server listening on http://0.0.0.0:${PORT}`);
    // Pre-warm Xtream catalogs & categories + Coming Soon releases in background so initial tab switches are instant
    void Promise.allSettled([
      getHomePayload(),
      getMovieCategories(),
      getSeriesCategories(),
      getLiveCategories(),
      getComingSoonReleases(),
    ]);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
