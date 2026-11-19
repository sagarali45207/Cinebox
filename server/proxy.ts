import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import type { AudioTrackInfo, MediaLanguagesResponse, SubtitleTrackInfo } from './types.ts';
import {
  buildCatchupUrl,
  buildUpstreamStreamUrl,
  findCatalogLanguageVariants,
  getConfig,
} from './xtream.ts';

const execFileAsync = promisify(execFile);

function resolveFfmpegBinary(): string {
  const candidates = [
    process.env.FFMPEG_PATH || '',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      try {
        fs.chmodSync(candidate, 0o755);
      } catch {
        // Ignore permission errors on read-only layers
      }
      return candidate;
    }
  }
  return 'ffmpeg';
}

function resolveFfprobeBinary(): string {
  const candidates = [
    process.env.FFPROBE_PATH || '',
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      try {
        fs.chmodSync(candidate, 0o755);
      } catch {
        // Ignore permission errors on read-only layers
      }
      return candidate;
    }
  }
  return 'ffprobe';
}

const FFMPEG_BIN = resolveFfmpegBinary();
const FFPROBE_BIN = resolveFfprobeBinary();

function applyStreamCorsHeaders(
  req: Request,
  res: Response,
  extraExposeHeaders = '',
): void {
  const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (requestOrigin && requestOrigin !== '*') {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Range, Authorization, Accept, X-Requested-With',
  );
  const baseExpose =
    'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, X-Media-Duration-Sec, X-Stream-Has-Audio, X-Stream-EOF, X-Download-EOF, X-Download-Total-Bytes, X-Estimated-Total-Bytes, X-Direct-Total-Bytes';
  res.setHeader(
    'Access-Control-Expose-Headers',
    extraExposeHeaders ? `${baseExpose}, ${extraExposeHeaders}` : baseExpose,
  );
}

// =============================================================================
// Internal 127.0.0.1 HTTP Loopback Proxy for FFmpeg / FFprobe
// Statically linked glibc binaries (ffmpeg-static / ffprobe-static) segfault on
// gVisor / Cloud Run inside getaddrinfo() -> dlopen("libnss_dns.so.2") when passed
// any hostname URL. Routing inputs through 127.0.0.1 bypasses glibc NSS completely,
// handles HTTP redirects and Range requests in Node, and rewrites HLS manifests.
// =============================================================================

interface LoopbackTargetEntry {
  url: string;
  expiresAt: number;
}

const FFMPEG_LOOPBACK_TTL_MS = 6 * 60 * 60 * 1000;
const FFMPEG_LOOPBACK_MAX_ENTRIES = 600;
const ffmpegLoopbackTokens = new Map<string, LoopbackTargetEntry>();
let ffmpegLoopbackServerPromise: Promise<number> | null = null;

function registerLoopbackTarget(targetUrl: string): string {
  const now = Date.now();
  for (const [existingToken, entry] of ffmpegLoopbackTokens.entries()) {
    if (entry.expiresAt <= now) {
      ffmpegLoopbackTokens.delete(existingToken);
      continue;
    }
    if (entry.url === targetUrl) {
      entry.expiresAt = now + FFMPEG_LOOPBACK_TTL_MS;
      return existingToken;
    }
  }

  while (ffmpegLoopbackTokens.size >= FFMPEG_LOOPBACK_MAX_ENTRIES) {
    const oldestKey = ffmpegLoopbackTokens.keys().next().value;
    if (!oldestKey) break;
    ffmpegLoopbackTokens.delete(oldestKey);
  }

  const token = crypto.randomBytes(12).toString('hex');
  ffmpegLoopbackTokens.set(token, {
    url: targetUrl,
    expiresAt: now + FFMPEG_LOOPBACK_TTL_MS,
  });
  return token;
}

function rewritePlaylistForLoopback(
  playlistText: string,
  baseUrl: string,
  loopbackBase: string,
): string {
  const proxify = (rawUri: string) => {
    const resolved = new URL(rawUri, baseUrl).href;
    const tok = registerLoopbackTarget(resolved);
    return `${loopbackBase}/u/${tok}`;
  };
  return playlistText
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${proxify(uri)}"`);
      }
      return proxify(trimmed);
    })
    .join('\n');
}

function ensureFfmpegLoopbackProxy(): Promise<number> {
  if (ffmpegLoopbackServerPromise) return ffmpegLoopbackServerPromise;

  ffmpegLoopbackServerPromise = new Promise<number>((resolve, reject) => {
    let boundPort = 0;
    const server = http.createServer(async (req, res) => {
      const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
      const match = (req.url || '').match(/^\/u\/([a-f0-9]+)(?:$|\?)/i);
      const token = match?.[1] || '';
      const entry = token ? ffmpegLoopbackTokens.get(token) : undefined;

      if (!entry || entry.expiresAt <= Date.now()) {
        if (token) ffmpegLoopbackTokens.delete(token);
        res.statusCode = 404;
        res.end('Expired loopback stream token');
        return;
      }

      entry.expiresAt = Date.now() + FFMPEG_LOOPBACK_TTL_MS;

      const controller = new AbortController();
      const onSocketClose = () => {
        if (!res.writableFinished && !controller.signal.aborted) {
          controller.abort();
        }
      };
      req.on('aborted', onSocketClose);
      res.on('close', onSocketClose);

      try {
        const headers: Record<string, string> = {
          'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          Accept: '*/*',
        };
        if (typeof req.headers.range === 'string' && req.headers.range) {
          headers.Range = req.headers.range;
        }

        const upstream = await fetch(entry.url, {
          method,
          headers,
          redirect: 'follow',
          signal: controller.signal,
        });

        const finalUrl = upstream.url || entry.url;
        const rawCtype = upstream.headers.get('content-type') || '';
        const isPlaylist =
          upstream.ok &&
          (finalUrl.toLowerCase().includes('.m3u8') || rawCtype.toLowerCase().includes('mpegurl'));

        if (isPlaylist) {
          const text = method === 'HEAD' ? '' : await upstream.text();
          if (method === 'HEAD') {
            await upstream.body?.cancel().catch(() => {});
          }
          if (controller.signal.aborted || res.writableEnded) return;
          const rewritten = rewritePlaylistForLoopback(
            text,
            finalUrl,
            `http://127.0.0.1:${boundPort}`,
          );
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (method !== 'HEAD') {
            res.setHeader('Content-Length', String(Buffer.byteLength(rewritten)));
          }
          res.end(method === 'HEAD' ? undefined : rewritten);
          return;
        }

        res.statusCode = upstream.status;
        if (rawCtype) res.setHeader('Content-Type', rawCtype);
        const contentRange = upstream.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);
        const contentLength = upstream.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        const acceptRanges = upstream.headers.get('accept-ranges');
        if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
        res.setHeader('Cache-Control', 'no-store');

        if (method === 'HEAD' || !upstream.body) {
          await upstream.body?.cancel().catch(() => {});
          res.end();
          return;
        }

        const nodeStream = Readable.fromWeb(upstream.body as never, {
          highWaterMark: 256 * 1024,
        });
        const cleanupStream = () => {
          if (!nodeStream.destroyed) nodeStream.destroy();
        };
        controller.signal.addEventListener('abort', cleanupStream, { once: true });
        res.on('close', cleanupStream);
        nodeStream.on('error', () => {
          if (!res.writableEnded) res.end();
        });
        nodeStream.pipe(res);
      } catch {
        if (!controller.signal.aborted && !res.headersSent) {
          res.statusCode = 502;
          res.end('Upstream loopback proxy error');
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    });

    server.once('error', (err) => {
      ffmpegLoopbackServerPromise = null;
      reject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && addr.port) {
        boundPort = addr.port;
        server.unref?.();
        resolve(addr.port);
      } else {
        ffmpegLoopbackServerPromise = null;
        reject(new Error('Failed to bind FFmpeg loopback proxy port'));
      }
    });
  });

  return ffmpegLoopbackServerPromise;
}

async function wrapFfmpegInputUrl(rawUrl: string): Promise<string> {
  if (!/^https?:\/\//i.test(rawUrl)) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]') {
      return rawUrl;
    }
    const port = await ensureFfmpegLoopbackProxy();
    const token = registerLoopbackTarget(rawUrl);
    return `http://127.0.0.1:${port}/u/${token}`;
  } catch {
    return rawUrl;
  }
}

interface CachedImage {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
}

interface HlsTokenEntry {
  url: string;
  expiresAt: number;
}

interface ResolvedUrlEntry {
  finalUrl: string;
  expiresAt: number;
}

interface ProbeSummary {
  videoCodec: string;
  pixFmt: string;
  audioCodec: string;
  durationSec: number;
  audioTracks: AudioTrackInfo[];
  subtitleTracks: SubtitleTrackInfo[];
  expiresAt: number;
}

interface VodChunkEntry {
  start: number;
  end: number; // inclusive
  totalSize: number | null;
  contentType: string;
  data: Buffer;
  expiresAt: number;
}

const imageCache = new Map<string, CachedImage>();
const hlsTokenMap = new Map<string, HlsTokenEntry>();
const resolvedUrlCache = new Map<string, ResolvedUrlEntry>();
const inFlightResolves = new Map<string, Promise<string>>();
const probeCache = new Map<string, ProbeSummary>();
const inFlightProbes = new Map<string, Promise<ProbeSummary>>();
const vodChunkCache = new Map<string, VodChunkEntry[]>();
const inFlightPrefetches = new Map<string, AbortController>();

let activeLiveController: AbortController | null = null;
let activeVodController: AbortController | null = null;
let activeVodKey = '';
let activeTranscodeProc: ChildProcess | null = null;
let lastVodStreamActivityAt = 0;

// Serialize upstream connection acquisition to avoid colliding with provider max_connections=1
let upstreamLockChain: Promise<void> = Promise.resolve();

function withUpstreamGate<T>(fn: () => Promise<T>): Promise<T> {
  const next = upstreamLockChain.then(fn, fn);
  upstreamLockChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const MAX_IMAGE_CACHE = 250;
const IMAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const HLS_TOKEN_TTL_MS = 15 * 60 * 1000;
const RESOLVED_URL_TTL_MS = 4 * 60 * 1000;
const PROBE_CACHE_TTL_MS = 15 * 60 * 1000;
const VOD_CHUNK_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_VOD_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB maximizes CDN throughput vs TTFB under 32 MiB proxy caps
const MAX_VOD_CHUNKS_PER_STREAM = 8; // up to 64 MiB rolling buffer per active media

function isPrivateOrBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h === '::1' ||
    h.startsWith('127.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    h.startsWith('169.254.') ||
    h.startsWith('0.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) ||
    h.endsWith('.local')
  );
}

function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
    case 'avi':
      return 'video/x-msvideo';
    case 'mov':
      return 'video/quicktime';
    case 'ts':
      return 'video/mp2t';
    case 'm3u8':
      return 'application/vnd.apple.mpegurl';
    default:
      return 'application/octet-stream';
  }
}

function registerHlsToken(targetUrl: string): string {
  const now = Date.now();
  if (hlsTokenMap.size > 4000) {
    for (const [k, v] of hlsTokenMap.entries()) {
      if (v.expiresAt <= now) hlsTokenMap.delete(k);
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  hlsTokenMap.set(token, { url: targetUrl, expiresAt: now + HLS_TOKEN_TTL_MS });
  return token;
}

function rewritePlaylist(playlistText: string, baseUrl: string): string {
  const proxify = (rawUri: string) => {
    const resolved = new URL(rawUri, baseUrl).href;
    const token = registerHlsToken(resolved);
    return `/api/play/hls?token=${token}`;
  };

  return playlistText
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${proxify(uri)}"`);
      }
      return proxify(trimmed);
    })
    .join('\n');
}

function parseRequestedByteRange(rawRange: string | undefined): {
  start: number;
  end: number;
  requestedExplicitEnd: number | undefined;
} {
  if (!rawRange) {
    return { start: 0, end: MAX_VOD_CHUNK_BYTES - 1, requestedExplicitEnd: undefined };
  }
  const match = rawRange.match(/bytes=(\d+)-(\d*)/i);
  if (!match) {
    return { start: 0, end: MAX_VOD_CHUNK_BYTES - 1, requestedExplicitEnd: undefined };
  }
  const start = Number(match[1]);
  const reqEnd = match[2] ? Number(match[2]) : undefined;
  if (!Number.isFinite(start) || start < 0) {
    return { start: 0, end: MAX_VOD_CHUNK_BYTES - 1, requestedExplicitEnd: undefined };
  }
  const maxEnd = start + MAX_VOD_CHUNK_BYTES - 1;
  const end =
    reqEnd !== undefined && Number.isFinite(reqEnd) && reqEnd >= start
      ? Math.min(reqEnd, maxEnd)
      : maxEnd;
  return { start, end, requestedExplicitEnd: reqEnd };
}

function parseContentRangeMeta(
  headerVal: string | null,
  fallbackStart: number,
  fallbackLen: number,
): { start: number; end: number; totalSize: number | null } {
  if (headerVal) {
    const m = headerVal.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (m) {
      return {
        start: Number(m[1]),
        end: Number(m[2]),
        totalSize: m[3] === '*' ? null : Number(m[3]),
      };
    }
  }
  return {
    start: fallbackStart,
    end: fallbackStart + Math.max(0, fallbackLen - 1),
    totalSize: null,
  };
}

function storeVodChunk(key: string, entry: VodChunkEntry): void {
  if (entry.data.length === 0 || entry.data.length > MAX_VOD_CHUNK_BYTES + 4096) return;
  const now = Date.now();
  // Prune stale streams
  if (vodChunkCache.size > 6) {
    for (const [k, list] of vodChunkCache.entries()) {
      const valid = list.filter((item) => item.expiresAt > now);
      if (valid.length === 0 || k !== key) {
        if (valid.length === 0) vodChunkCache.delete(k);
        else vodChunkCache.set(k, valid);
      }
    }
    if (vodChunkCache.size > 6) {
      const oldestKey = vodChunkCache.keys().next().value;
      if (oldestKey && oldestKey !== key) vodChunkCache.delete(oldestKey);
    }
  }

  const list = (vodChunkCache.get(key) || []).filter(
    (c) => c.expiresAt > now && !(c.start === entry.start && c.end === entry.end),
  );
  list.push(entry);
  while (list.length > MAX_VOD_CHUNKS_PER_STREAM) {
    list.shift();
  }
  vodChunkCache.set(key, list);
}

function lookupVodChunk(key: string, offset: number): VodChunkEntry | undefined {
  const list = vodChunkCache.get(key);
  if (!list) return undefined;
  const now = Date.now();
  return list.find((c) => c.expiresAt > now && offset >= c.start && offset <= c.end);
}

function abortPrefetches(exceptKey?: string): void {
  for (const [key, ctrl] of inFlightPrefetches.entries()) {
    if (key !== exceptKey) {
      ctrl.abort();
      inFlightPrefetches.delete(key);
    }
  }
}

async function releaseActiveLiveConnection(): Promise<void> {
  if (activeLiveController) {
    activeLiveController.abort();
    activeLiveController = null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function releaseActiveVodConnections(): Promise<void> {
  abortPrefetches();
  if (activeVodController) {
    activeVodController.abort();
    activeVodController = null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function killActiveTranscode(): boolean {
  if (activeTranscodeProc && !activeTranscodeProc.killed) {
    try {
      activeTranscodeProc.kill('SIGKILL');
    } catch {
      // ignore
    }
    activeTranscodeProc = null;
    return true;
  }
  return false;
}

function isUpstreamStreamBusy(): boolean {
  if (activeLiveController) return true;
  if (activeVodController) return true;
  if (activeTranscodeProc && !activeTranscodeProc.killed) return true;
  if (hlsSessions.size > 0) return true;
  return Date.now() - lastVodStreamActivityAt < 1200;
}

const ISO_LANGUAGE_LABELS: Record<string, string> = {
  eng: 'English',
  en: 'English',
  hin: 'Hindi',
  hi: 'Hindi',
  tam: 'Tamil',
  ta: 'Tamil',
  tel: 'Telugu',
  te: 'Telugu',
  mal: 'Malayalam',
  ml: 'Malayalam',
  kan: 'Kannada',
  kn: 'Kannada',
  ben: 'Bangla',
  bn: 'Bangla',
  pan: 'Punjabi',
  pa: 'Punjabi',
  mar: 'Marathi',
  mr: 'Marathi',
  guj: 'Gujarati',
  gu: 'Gujarati',
  urd: 'Urdu',
  ur: 'Urdu',
  tur: 'Turkish',
  tr: 'Turkish',
  spa: 'Spanish',
  es: 'Spanish',
  fre: 'French',
  fra: 'French',
  fr: 'French',
  ger: 'German',
  deu: 'German',
  de: 'German',
  ita: 'Italian',
  it: 'Italian',
  por: 'Portuguese',
  pt: 'Portuguese',
  ara: 'Arabic',
  ar: 'Arabic',
  per: 'Persian',
  fas: 'Persian',
  fa: 'Persian',
  kor: 'Korean',
  ko: 'Korean',
  jpn: 'Japanese',
  ja: 'Japanese',
  chi: 'Chinese',
  zho: 'Chinese',
  zh: 'Chinese',
  rus: 'Russian',
  ru: 'Russian',
  ind: 'Indonesian',
  id: 'Indonesian',
  tha: 'Thai',
  th: 'Thai',
  vie: 'Vietnamese',
  vi: 'Vietnamese',
  dut: 'Dutch',
  nld: 'Dutch',
  nl: 'Dutch',
  pol: 'Polish',
  pl: 'Polish',
  ukr: 'Ukrainian',
  uk: 'Ukrainian',
};

function mapIsoLanguageLabel(code: string): string {
  const clean = code.trim().toLowerCase();
  if (!clean || clean === 'und' || clean === 'unk') return '';
  return ISO_LANGUAGE_LABELS[clean] || clean.toUpperCase();
}

async function resolveRedirectedMediaUrl(
  upstreamUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const now = Date.now();
  const cached = resolvedUrlCache.get(upstreamUrl);
  if (cached && cached.expiresAt > now) {
    return cached.finalUrl;
  }

  const existing = inFlightResolves.get(upstreamUrl);
  if (existing && !signal) {
    return existing;
  }

  const run = (async () => {
    const resolveCtrl = new AbortController();
    const timeoutId = setTimeout(() => resolveCtrl.abort(), 6000);
    const onCallerAbort = () => resolveCtrl.abort();
    if (signal) {
      if (signal.aborted) resolveCtrl.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const probe = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          Range: 'bytes=0-1',
        },
        redirect: 'follow',
        signal: resolveCtrl.signal,
      });

      try {
        await probe.body?.cancel();
      } catch {
        // ignore
      }

      if (probe.ok && probe.url) {
        resolvedUrlCache.set(upstreamUrl, {
          finalUrl: probe.url,
          expiresAt: Date.now() + RESOLVED_URL_TTL_MS,
        });
        return probe.url;
      }
      return upstreamUrl;
    } finally {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onCallerAbort);
      }
      inFlightResolves.delete(upstreamUrl);
    }
  })();

  if (!signal) {
    inFlightResolves.set(upstreamUrl, run);
  }
  return run;
}

async function probeMediaCodecs(mediaUrl: string): Promise<ProbeSummary> {
  const now = Date.now();
  const hit = probeCache.get(mediaUrl);
  if (hit && hit.expiresAt > now) {
    return hit;
  }

  const pending = inFlightProbes.get(mediaUrl);
  if (pending) {
    return pending;
  }

  const run = (async (): Promise<ProbeSummary> => {
    // Wait briefly if another stream request is actively establishing connection on max_connections=1
    for (let i = 0; i < 6 && isUpstreamStreamBusy(); i++) {
      await new Promise((r) => setTimeout(r, 350));
    }

    const resolved = await resolveRedirectedMediaUrl(mediaUrl).catch(() => mediaUrl);
    const safeProbeInput = await wrapFfmpegInputUrl(resolved);
    try {
      const { stdout } = await execFileAsync(
        FFPROBE_BIN,
        [
          '-v',
          'error',
          '-analyzeduration',
          '750000',
          '-probesize',
          '750000',
          '-user_agent',
          'VLC/3.0.18 LibVLC/3.0.18',
          '-show_entries',
          'stream=index,codec_name,codec_type,channels,channel_layout,pix_fmt:stream_tags=language,title:stream_disposition=default',
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          safeProbeInput,
        ],
        { timeout: 7500 },
      );
      const parsed = JSON.parse(stdout) as {
        streams?: Array<{
          index?: number;
          codec_name?: string;
          codec_type?: string;
          pix_fmt?: string;
          channels?: number;
          channel_layout?: string;
          tags?: { language?: string; title?: string };
          disposition?: { default?: number };
        }>;
        format?: { duration?: string };
      };
      const streams = parsed.streams || [];
      const vStream = streams.find((s) => s.codec_type === 'video');
      const audioStreams = streams.filter((s) => s.codec_type === 'audio');
      const subStreams = streams.filter((s) => s.codec_type === 'subtitle');

      const audioTracks: AudioTrackInfo[] = audioStreams.map((s, audioIdx) => {
        const langCode = String(s.tags?.language || '').trim().toLowerCase();
        const langLabel = mapIsoLanguageLabel(langCode);
        const rawTitle = String(s.tags?.title || '').trim();
        return {
          index: audioIdx,
          languageCode: langCode,
          languageLabel: langLabel || `Track ${audioIdx + 1}`,
          title: rawTitle,
          codec: String(s.codec_name || '').toLowerCase(),
          channels: Number(s.channels || 0) || 0,
          channelLayout: String(s.channel_layout || '').trim(),
          isDefault: s.disposition?.default === 1 || audioIdx === 0,
        };
      });

      const subtitleTracks: SubtitleTrackInfo[] = subStreams.map((s, subIdx) => {
        const langCode = String(s.tags?.language || '').trim().toLowerCase();
        const langLabel = mapIsoLanguageLabel(langCode);
        const rawTitle = String(s.tags?.title || '').trim();
        const codec = String(s.codec_name || '').toLowerCase();
        let format: SubtitleTrackInfo['format'] = 'unknown';
        if (codec.includes('vtt') || codec.includes('webvtt')) format = 'vtt';
        else if (codec.includes('subrip') || codec.includes('srt')) format = 'srt';
        else if (codec.includes('ass')) format = 'ass';
        else if (codec.includes('ssa')) format = 'ssa';
        else if (codec.includes('mov_text')) format = 'mov_text';
        else if (codec.includes('dvd') || codec.includes('pgs') || codec.includes('hdmv')) format = 'bitmap';

        return {
          id: `embedded:${subIdx}`,
          index: subIdx,
          languageCode: langCode,
          languageLabel: langLabel || rawTitle || `Subtitle ${subIdx + 1}`,
          title: rawTitle || (langLabel ? `${langLabel} Subtitles` : `Subtitle ${subIdx + 1}`),
          codec,
          format,
          source: 'embedded',
          isDefault: s.disposition?.default === 1,
        };
      });

      const defaultAudio = audioTracks.find((t) => t.isDefault) || audioTracks[0];
      const summary: ProbeSummary = {
        videoCodec: String(vStream?.codec_name || '').toLowerCase(),
        pixFmt: String(vStream?.pix_fmt || '').toLowerCase(),
        audioCodec: defaultAudio?.codec || '',
        durationSec: Number(parsed.format?.duration || 0) || 0,
        audioTracks,
        subtitleTracks,
        expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
      };
      probeCache.set(mediaUrl, summary);
      return summary;
    } catch {
      return {
        videoCodec: '',
        pixFmt: '',
        audioCodec: '',
        durationSec: 0,
        audioTracks: [],
        subtitleTracks: [],
        expiresAt: Date.now() + 60_000,
      };
    } finally {
      inFlightProbes.delete(mediaUrl);
    }
  })();

  inFlightProbes.set(mediaUrl, run);
  return run;
}

function scheduleVodPrefetch(
  upstreamUrl: string,
  nextStart: number,
  totalSize: number | null,
  fallbackExt: string,
  aheadDepth = 2,
): void {
  if (aheadDepth <= 0) return;
  if (totalSize !== null && nextStart >= totalSize) return;
  if (lookupVodChunk(upstreamUrl, nextStart)) {
    if (aheadDepth > 1) {
      const existing = lookupVodChunk(upstreamUrl, nextStart);
      if (existing) {
        scheduleVodPrefetch(
          upstreamUrl,
          existing.end + 1,
          existing.totalSize ?? totalSize,
          fallbackExt,
          aheadDepth - 1,
        );
      }
    }
    return;
  }
  if (
    downloadJobs.size > 0 ||
    activeLiveController ||
    activeVodController ||
    hlsSessions.size > 0 ||
    (activeTranscodeProc && !activeTranscodeProc.killed)
  ) {
    return;
  }

  const prefetchKey = `${upstreamUrl}:${nextStart}`;
  if (inFlightPrefetches.has(prefetchKey)) return;

  abortPrefetches(prefetchKey);

  const ac = new AbortController();
  inFlightPrefetches.set(prefetchKey, ac);
  const nextEnd =
    totalSize !== null
      ? Math.min(totalSize - 1, nextStart + MAX_VOD_CHUNK_BYTES - 1)
      : nextStart + MAX_VOD_CHUNK_BYTES - 1;

  void (async () => {
    try {
      // Short yield so immediate browser seek requests take precedence
      await new Promise((r) => setTimeout(r, 60));
      if (ac.signal.aborted || activeLiveController || activeVodController) return;

      const cachedTarget = resolvedUrlCache.get(upstreamUrl);
      const target =
        cachedTarget && cachedTarget.expiresAt > Date.now() ? cachedTarget.finalUrl : upstreamUrl;

      const resp = await fetch(target, {
        method: 'GET',
        headers: {
          'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          Range: `bytes=${nextStart}-${nextEnd}`,
        },
        redirect: 'follow',
        signal: ac.signal,
      });

      if (!resp.ok || !resp.body || ac.signal.aborted) {
        try {
          await resp.body?.cancel();
        } catch {
          // ignore
        }
        return;
      }

      const rawCtype = resp.headers.get('content-type') || '';
      if (rawCtype.toLowerCase().includes('text/html') || rawCtype.toLowerCase().includes('mpegurl')) {
        await resp.body.cancel().catch(() => {});
        return;
      }

      if (resp.url && resp.url !== upstreamUrl) {
        resolvedUrlCache.set(upstreamUrl, {
          finalUrl: resp.url,
          expiresAt: Date.now() + RESOLVED_URL_TTL_MS,
        });
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      if (ac.signal.aborted || buf.length === 0) return;

      const meta = parseContentRangeMeta(
        resp.headers.get('content-range'),
        nextStart,
        buf.length,
      );
      const contentType =
        rawCtype && rawCtype !== 'application/octet-stream'
          ? rawCtype
          : mimeForExtension(fallbackExt);

      storeVodChunk(upstreamUrl, {
        start: meta.start,
        end: meta.end,
        totalSize: meta.totalSize,
        contentType,
        data: buf,
        expiresAt: Date.now() + VOD_CHUNK_CACHE_TTL_MS,
      });

      if (aheadDepth > 1 && !ac.signal.aborted) {
        scheduleVodPrefetch(
          upstreamUrl,
          meta.end + 1,
          meta.totalSize ?? totalSize,
          fallbackExt,
          aheadDepth - 1,
        );
      }
    } catch {
      // Prefetch errors are silently ignored
    } finally {
      inFlightPrefetches.delete(prefetchKey);
    }
  })();
}

async function serveVodStream(
  upstreamUrl: string,
  req: Request,
  res: Response,
  fallbackExt: string,
): Promise<void> {
  lastVodStreamActivityAt = Date.now();
  const { start, end, requestedExplicitEnd } = parseRequestedByteRange(
    typeof req.headers.range === 'string' ? req.headers.range : undefined,
  );

  // Instant zero-TTFB cache hit for sequential playback & scrubbing within cached blocks
  const cachedHit = req.method !== 'HEAD' ? lookupVodChunk(upstreamUrl, start) : undefined;
  if (cachedHit) {
    const sliceOffsetStart = start - cachedHit.start;
    const desiredEnd = Math.min(cachedHit.end, end);
    const sliceLen = Math.max(0, desiredEnd - start + 1);
    const sliceBuf = cachedHit.data.subarray(sliceOffsetStart, sliceOffsetStart + sliceLen);

    res.status(206);
    res.setHeader('Content-Type', cachedHit.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Range',
      `bytes ${start}-${start + sliceBuf.length - 1}/${cachedHit.totalSize ?? '*'}`,
    );
    res.setHeader('Content-Length', String(sliceBuf.length));
    res.send(sliceBuf);

    // Proactively prefetch next sequential 8 MiB slice once client passes 40% into current block
    const nextStart = cachedHit.end + 1;
    if (
      sliceOffsetStart >= Math.floor(cachedHit.data.length * 0.35) ||
      start + sliceBuf.length >= cachedHit.end
    ) {
      scheduleVodPrefetch(upstreamUrl, nextStart, cachedHit.totalSize, fallbackExt);
    }
    return;
  }

  // Cancel background prefetches cleanly so upstream bandwidth goes exclusively to active playback
  abortPrefetches();
  if (activeVodController && activeVodKey !== upstreamUrl) {
    activeVodController.abort();
    activeVodController = null;
  }

  const controller = new AbortController();
  activeVodController = controller;
  activeVodKey = upstreamUrl;

  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
    if (activeVodController === controller) {
      activeVodController = null;
    }
    controller.abort();
  });

  const rangeHeader =
    req.method === 'HEAD'
      ? (typeof req.headers.range === 'string' ? req.headers.range : 'bytes=0-1')
      : `bytes=${start}-${end}`;

  const fetchUpstream = async () => {
    const now = Date.now();
    const cachedTarget = resolvedUrlCache.get(upstreamUrl);
    let target =
      cachedTarget && cachedTarget.expiresAt > now ? cachedTarget.finalUrl : upstreamUrl;

    const doFetch = async (url: string) => {
      const timer = setTimeout(() => controller.abort(), 16000);
      try {
        const resp = await fetch(url, {
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
          headers: {
            'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
            Range: rangeHeader,
          },
          redirect: 'follow',
          signal: controller.signal,
        });
        clearTimeout(timer);
        return resp;
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    };

    try {
      let resp = await doFetch(target);
      if (target !== upstreamUrl && resp.status >= 400 && !clientClosed) {
        await resp.body?.cancel().catch(() => {});
        resolvedUrlCache.delete(upstreamUrl);
        target = upstreamUrl;
        resp = await doFetch(upstreamUrl);
      }
      return resp;
    } catch (err) {
      if (target !== upstreamUrl && !clientClosed) {
        resolvedUrlCache.delete(upstreamUrl);
        return doFetch(upstreamUrl);
      }
      throw err;
    }
  };

  let upstream: globalThis.Response;
  try {
    // Only serialize initial connection opening if another request is mid-handshake
    upstream = await withUpstreamGate(() => fetchUpstream());
  } catch (err) {
    if (activeVodController === controller) activeVodController = null;
    if (clientClosed || controller.signal.aborted) {
      if (!clientClosed && !res.headersSent) {
        res.status(504).json({ error: 'Upstream media connection timed out' });
      }
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unable to reach media server';
    if (!res.headersSent) {
      res.status(502).json({ error: msg });
    }
    return;
  }

  if (clientClosed) {
    if (activeVodController === controller) activeVodController = null;
    controller.abort();
    return;
  }

  if (upstream.status >= 400) {
    if (activeVodController === controller) activeVodController = null;
    if (!res.headersSent) {
      res.status(upstream.status === 404 ? 404 : upstream.status === 416 ? 416 : 502).json({
        error: `Media provider returned HTTP ${upstream.status}`,
      });
    }
    return;
  }

  const finalUrl = upstream.url || upstreamUrl;
  if (finalUrl && finalUrl !== upstreamUrl) {
    resolvedUrlCache.set(upstreamUrl, {
      finalUrl,
      expiresAt: Date.now() + RESOLVED_URL_TTL_MS,
    });
  }

  const rawCtype = upstream.headers.get('content-type') || '';
  if (rawCtype.toLowerCase().includes('text/html')) {
    if (activeVodController === controller) activeVodController = null;
    controller.abort();
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Channel or media stream is currently offline on the provider',
      });
    }
    return;
  }

  const isPlaylist =
    finalUrl.toLowerCase().includes('.m3u8') ||
    rawCtype.toLowerCase().includes('mpegurl');

  if (isPlaylist) {
    if (activeVodController === controller) activeVodController = null;
    try {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, finalUrl);
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.send(rewritten);
    } catch {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Failed to parse HLS playlist' });
      }
    }
    return;
  }

  const contentType =
    rawCtype && rawCtype !== 'application/octet-stream'
      ? rawCtype
      : mimeForExtension(fallbackExt);

  res.status(upstream.status);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  const acceptRanges = upstream.headers.get('accept-ranges');
  res.setHeader(
    'Accept-Ranges',
    acceptRanges && acceptRanges.toLowerCase() === 'none' ? 'none' : 'bytes',
  );

  const contentRangeHeader = upstream.headers.get('content-range');
  if (contentRangeHeader) res.setHeader('Content-Range', contentRangeHeader);
  const contentLengthHeader = upstream.headers.get('content-length');
  if (contentLengthHeader) res.setHeader('Content-Length', contentLengthHeader);

  if (req.method === 'HEAD' || !upstream.body) {
    if (activeVodController === controller) activeVodController = null;
    res.end();
    return;
  }

  res.flushHeaders();

  const nodeStream = Readable.fromWeb(upstream.body as never, {
    highWaterMark: 256 * 1024,
  });
  const shouldBufferForCache =
    (requestedExplicitEnd === undefined || requestedExplicitEnd - start >= 64 * 1024) &&
    Number(contentLengthHeader || 0) <= MAX_VOD_CHUNK_BYTES + 4096;
  const collected: Buffer[] = [];
  let collectedBytes = 0;

  const cleanup = () => {
    if (activeVodController === controller) activeVodController = null;
    if (!nodeStream.destroyed) nodeStream.destroy();
    if (!res.writableEnded) res.end();
  };

  controller.signal.addEventListener('abort', cleanup, { once: true });
  res.on('close', cleanup);

  nodeStream.on('data', (chunk: Buffer) => {
    lastVodStreamActivityAt = Date.now();
    if (shouldBufferForCache && collectedBytes + chunk.length <= MAX_VOD_CHUNK_BYTES + 4096) {
      collected.push(chunk);
      collectedBytes += chunk.length;
    }
  });

  nodeStream.on('end', () => {
    if (activeVodController === controller) activeVodController = null;
    lastVodStreamActivityAt = Date.now();
    if (shouldBufferForCache && collectedBytes > 0 && !clientClosed) {
      const fullBuf = Buffer.concat(collected, collectedBytes);
      const meta = parseContentRangeMeta(contentRangeHeader, start, fullBuf.length);
      storeVodChunk(upstreamUrl, {
        start: meta.start,
        end: meta.end,
        totalSize: meta.totalSize,
        contentType,
        data: fullBuf,
        expiresAt: Date.now() + VOD_CHUNK_CACHE_TTL_MS,
      });
      // Immediately start fetching the next 8 MiB slice while client decodes this chunk
      scheduleVodPrefetch(upstreamUrl, meta.end + 1, meta.totalSize, fallbackExt);
    }
    if (!res.writableEnded) res.end();
  });

  nodeStream.on('error', () => {
    if (activeVodController === controller) activeVodController = null;
    if (!res.writableEnded) res.end();
  });

  res.on('error', () => {
    if (activeVodController === controller) activeVodController = null;
    if (!nodeStream.destroyed) nodeStream.destroy();
  });

  nodeStream.pipe(res);
}

function findTsSyncOffset(buf: Buffer): number {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x47) {
      if (i + 188 < buf.length) {
        if (buf[i + 188] === 0x47) return i;
      } else {
        return i;
      }
    }
  }
  return -1;
}

async function pipeLiveStream(
  upstreamUrl: string,
  req: Request,
  res: Response,
  fallbackExt: string,
): Promise<void> {
  destroyAllHlsSessions();
  const killedTranscode = killActiveTranscode();
  await releaseActiveVodConnections();
  await releaseActiveLiveConnection();
  if (killedTranscode) {
    await new Promise((r) => setTimeout(r, 80));
  }

  const controller = new AbortController();
  activeLiveController = controller;

  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
    if (activeLiveController === controller) {
      activeLiveController = null;
    }
    controller.abort();
  });

  const openUpstream = async (target: string): Promise<globalThis.Response> => {
    const connectTimer = setTimeout(() => controller.abort(), 16000);
    try {
      const resp = await fetch(target, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: {
          'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          ...(req.headers.range ? { Range: String(req.headers.range) } : {}),
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(connectTimer);
      return resp;
    } catch (err) {
      clearTimeout(connectTimer);
      throw err;
    }
  };

  let upstream: globalThis.Response;
  try {
    upstream = await openUpstream(upstreamUrl);
  } catch (err) {
    if (activeLiveController === controller) activeLiveController = null;
    if (clientClosed || controller.signal.aborted) {
      if (!clientClosed && !res.headersSent) {
        res.status(504).json({ error: 'Live channel connection timed out' });
      }
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unable to reach live stream server';
    if (!res.headersSent) {
      res.status(502).json({ error: msg });
    }
    return;
  }

  if (clientClosed) {
    if (activeLiveController === controller) activeLiveController = null;
    controller.abort();
    return;
  }

  if (upstream.status >= 400) {
    if (activeLiveController === controller) activeLiveController = null;
    if (!res.headersSent) {
      res.status(upstream.status === 404 ? 404 : 502).json({
        error: `Media provider returned HTTP ${upstream.status}`,
      });
    }
    return;
  }

  const finalUrl = upstream.url || upstreamUrl;
  const rawCtype = upstream.headers.get('content-type') || '';
  if (rawCtype.toLowerCase().includes('text/html')) {
    if (activeLiveController === controller) activeLiveController = null;
    controller.abort();
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Channel or media stream is currently offline on the provider',
      });
    }
    return;
  }

  const isPlaylist =
    finalUrl.toLowerCase().includes('.m3u8') ||
    rawCtype.toLowerCase().includes('mpegurl');

  if (isPlaylist) {
    if (activeLiveController === controller) activeLiveController = null;
    try {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, finalUrl);
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.send(rewritten);
    } catch {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Failed to parse HLS playlist' });
      }
    }
    return;
  }

  const contentType =
    rawCtype && rawCtype !== 'application/octet-stream'
      ? rawCtype
      : mimeForExtension(fallbackExt);
  const alignTsPackets = contentType.toLowerCase().includes('mp2t') || fallbackExt === 'ts';

  res.status(upstream.status);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  if (req.method === 'HEAD' || !upstream.body) {
    if (activeLiveController === controller) activeLiveController = null;
    res.end();
    return;
  }

  res.flushHeaders();

  // Stream continuously with initial micro-burst prebuffer & strict 188-byte TS packet framing
  const pump = async (initialResp: globalThis.Response) => {
    let currentResp: globalThis.Response | null = initialResp;
    let retries = 0;
    const INITIAL_PREBUFFER_BYTES = 32 * 1024;
    const INITIAL_PREBUFFER_MAX_MS = 140;
    let initialFlushDone = !alignTsPackets;
    let initialStartedAt = Date.now();
    let prebufferChunks: Buffer[] = [];
    let prebufferBytes = 0;

    const writeOut = async (buf: Buffer) => {
      const canContinue = res.write(buf);
      if (!canContinue) {
        await new Promise<void>((resolve) => {
          const onDrain = () => {
            res.off('close', onClose);
            resolve();
          };
          const onClose = () => {
            res.off('drain', onDrain);
            resolve();
          };
          res.once('drain', onDrain);
          res.once('close', onClose);
        });
      }
    };

    while (!clientClosed && !controller.signal.aborted && !res.writableEnded) {
      if (!currentResp?.body) break;
      const reader = currentResp.body.getReader();
      let gotBytesThisAttempt = false;
      let remainder: Buffer = Buffer.alloc(0);
      let tsSynced = false;

      try {
        while (!clientClosed && !controller.signal.aborted && !res.writableEnded) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;

          gotBytesThisAttempt = true;
          let outChunk: Buffer;

          if (alignTsPackets) {
            let combined: Buffer =
              remainder.length > 0
                ? Buffer.concat([remainder, Buffer.from(value)])
                : Buffer.from(value);

            if (!tsSynced) {
              const offset = findTsSyncOffset(combined);
              if (offset < 0) {
                // Keep small window in case sync byte arrives next
                remainder = combined.length > 376 ? combined.subarray(combined.length - 188) : combined;
                continue;
              }
              combined = combined.subarray(offset);
              tsSynced = true;
            }

            const usableLen = Math.floor(combined.length / 188) * 188;
            remainder = combined.subarray(usableLen);
            if (usableLen === 0) continue;
            outChunk = combined.subarray(0, usableLen);
          } else {
            outChunk = Buffer.from(value);
          }

          if (!initialFlushDone) {
            prebufferChunks.push(outChunk);
            prebufferBytes += outChunk.length;
            if (
              prebufferBytes < INITIAL_PREBUFFER_BYTES &&
              Date.now() - initialStartedAt < INITIAL_PREBUFFER_MAX_MS
            ) {
              continue;
            }
            initialFlushDone = true;
            const merged =
              prebufferChunks.length === 1 ? prebufferChunks[0] : Buffer.concat(prebufferChunks);
            prebufferChunks = [];
            prebufferBytes = 0;
            await writeOut(merged);
            continue;
          }

          await writeOut(outChunk);
        }
      } catch {
        // Handle transient upstream TCP termination and seamlessly attempt reconnect below
      } finally {
        reader.releaseLock();
      }

      if (!initialFlushDone && prebufferChunks.length > 0 && !clientClosed && !res.writableEnded) {
        initialFlushDone = true;
        const merged =
          prebufferChunks.length === 1 ? prebufferChunks[0] : Buffer.concat(prebufferChunks);
        prebufferChunks = [];
        prebufferBytes = 0;
        await writeOut(merged);
      }

      if (clientClosed || controller.signal.aborted || res.writableEnded) break;
      if (gotBytesThisAttempt) retries = 0;
      else retries += 1;
      if (retries > 3) break;

      await new Promise((r) => setTimeout(r, 250));
      if (clientClosed || controller.signal.aborted) break;

      try {
        const next = await openUpstream(upstreamUrl);
        if (!next.ok || !next.body) {
          await next.body?.cancel().catch(() => {});
          break;
        }
        currentResp = next;
        initialStartedAt = Date.now();
      } catch {
        break;
      }
    }

    if (activeLiveController === controller) activeLiveController = null;
    if (!res.writableEnded) res.end();
  };

  void pump(upstream);
}

export async function handleImageProxy(req: Request, res: Response): Promise<void> {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!rawUrl) {
    res.status(400).send('Missing url');
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).send('Invalid url');
    return;
  }

  if (!/^https?:$/.test(parsed.protocol) || isPrivateOrBlockedHost(parsed.hostname)) {
    res.status(403).send('Host not allowed');
    return;
  }

  const now = Date.now();
  const cached = imageCache.get(parsed.href);
  if (cached && cached.expiresAt > now) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(cached.buffer);
    return;
  }

  try {
    const upstream = await fetch(parsed.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.toLowerCase().startsWith('image/')) {
      res.status(404).send('Not an image');
      return;
    }

    const arrayBuf = await upstream.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    if (buf.length > 0 && buf.length <= 1_500_000) {
      if (imageCache.size >= MAX_IMAGE_CACHE) {
        const firstKey = imageCache.keys().next().value;
        if (firstKey) imageCache.delete(firstKey);
      }
      imageCache.set(parsed.href, {
        buffer: buf,
        contentType,
        expiresAt: now + IMAGE_CACHE_TTL_MS,
      });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch {
    res.status(502).send('Cannot reach image host');
  }
}

export async function handleLivePlay(req: Request, res: Response): Promise<void> {
  const rawParam = String(req.params.streamId || '');
  const match = rawParam.match(/^(\d+)(?:\.(ts|m3u8))?$/i);
  if (!match) {
    res.status(400).json({ error: 'Invalid live stream ID' });
    return;
  }

  destroyAllHlsSessions();
  destroyAllQualitySessions();

  const streamId = match[1];
  const queryFormat = req.query.format === 'm3u8' ? 'm3u8' : req.query.format === 'ts' ? 'ts' : '';
  const ext = (match[2] || queryFormat || getConfig().format).toLowerCase();
  const upstreamUrl = buildUpstreamStreamUrl('live', streamId, ext);

  await pipeLiveStream(upstreamUrl, req, res, ext);
}

export async function handleVodPlay(req: Request, res: Response): Promise<void> {
  const rawParam = String(req.params.streamId || '');
  const match = rawParam.match(/^(\d+)(?:\.([a-zA-Z0-9]+))?$/);
  if (!match) {
    res.status(400).json({ error: 'Invalid VOD stream ID' });
    return;
  }

  destroyAllHlsSessions();
  destroyAllQualitySessions();
  killActiveTranscode();
  await releaseActiveLiveConnection();

  const streamId = match[1];
  const ext = (match[2] || 'mp4').toLowerCase();
  const upstreamUrl = buildUpstreamStreamUrl('movie', streamId, ext);

  await serveVodStream(upstreamUrl, req, res, ext);
}

export async function handleSeriesPlay(req: Request, res: Response): Promise<void> {
  const rawParam = String(req.params.episodeId || '');
  const match = rawParam.match(/^(\d+)(?:\.([a-zA-Z0-9]+))?$/);
  if (!match) {
    res.status(400).json({ error: 'Invalid episode ID' });
    return;
  }

  destroyAllHlsSessions();
  destroyAllQualitySessions();
  killActiveTranscode();
  await releaseActiveLiveConnection();

  const episodeId = match[1];
  const ext = (match[2] || 'mp4').toLowerCase();
  const upstreamUrl = buildUpstreamStreamUrl('series', episodeId, ext);

  await serveVodStream(upstreamUrl, req, res, ext);
}

export async function handleTranscodeInfo(req: Request, res: Response): Promise<void> {
  const kind = req.params.kind === 'series' ? 'series' : req.params.kind === 'vod' ? 'movie' : null;
  const id = String(req.params.id || '').replace(/\.[a-zA-Z0-9]+$/, '');
  const ext = String(req.query.ext || 'mp4').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';

  if (!kind || !/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Invalid media target' });
    return;
  }

  const upstreamUrl = buildUpstreamStreamUrl(kind, id, ext);
  const summary = await probeMediaCodecs(upstreamUrl);
  res.json(summary);
}

interface ParsedHlsVariant {
  id: string;
  label: string;
  quality: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  codecs?: string;
  url: string;
  source: 'upstream-hls';
}

function parseHlsMasterVariants(playlistText: string, baseUrl: string): ParsedHlsVariant[] {
  const lines = playlistText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const variants: ParsedHlsVariant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
    const uriLine = lines.slice(i + 1).find((candidate) => !candidate.startsWith('#'));
    if (!uriLine) continue;

    const bwMatch = attrs.match(/BANDWIDTH=(\d+)/i);
    const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/i);
    const codecsMatch = attrs.match(/CODECS="([^"]+)"/i);
    const nameMatch = attrs.match(/NAME="([^"]+)"/i);

    const width = resMatch ? Number(resMatch[1]) : undefined;
    const height = resMatch ? Number(resMatch[2]) : undefined;
    const bandwidth = bwMatch ? Number(bwMatch[1]) : undefined;
    const quality = height
      ? `${height}p`
      : nameMatch?.[1] || (bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : 'auto');
    const resolved = new URL(uriLine, baseUrl).href;
    const token = registerHlsToken(resolved);

    variants.push({
      id: `hls_${height || bandwidth || i}_${variants.length}`,
      label: height ? `${height}p${bandwidth ? ` · ${(bandwidth / 1_000_000).toFixed(1)} Mbps` : ''}` : quality,
      quality,
      width,
      height,
      bandwidth,
      codecs: codecsMatch?.[1],
      url: `/api/play/hls?token=${token}`,
      source: 'upstream-hls',
    });
  }

  return variants.sort((a, b) => (b.height || b.bandwidth || 0) - (a.height || a.bandwidth || 0));
}

const variantCache = new Map<
  string,
  { expiresAt: number; payload: Record<string, unknown> }
>();

export async function handleInspectStreamVariants(req: Request, res: Response): Promise<void> {
  const parsed = parseQualityTarget(req);
  if (!parsed.kind || !parsed.upstreamUrl) {
    res.status(400).json({ error: parsed.error || 'Invalid media target' });
    return;
  }

  const upstreamUrl = parsed.upstreamUrl;
  const cacheKey = `${parsed.kind}:${parsed.id}:${parsed.ext}`;
  const hit = variantCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    res.json(hit.payload);
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const isLikelyHls =
      parsed.ext.toLowerCase() === 'm3u8' || upstreamUrl.toLowerCase().includes('.m3u8');

    const probeResp = await withUpstreamGate(() =>
      fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          ...(isLikelyHls ? {} : { Range: 'bytes=0-1' }),
        },
        redirect: 'follow',
        signal: controller.signal,
      }),
    ).finally(() => clearTimeout(timer));

    const finalUrl = probeResp.url || upstreamUrl;
    if (finalUrl && finalUrl !== upstreamUrl) {
      resolvedUrlCache.set(upstreamUrl, {
        finalUrl,
        expiresAt: Date.now() + RESOLVED_URL_TTL_MS,
      });
    }

    const ctype = (probeResp.headers.get('content-type') || '').toLowerCase();
    const isHls =
      ctype.includes('mpegurl') ||
      finalUrl.toLowerCase().includes('.m3u8') ||
      isLikelyHls;

    if (isHls && probeResp.ok) {
      const text = await probeResp.text();
      const masterVariants = parseHlsMasterVariants(text, finalUrl);
      const token = registerHlsToken(finalUrl);
      const payload = {
        isMasterPlaylist: masterVariants.length > 0,
        isHls: true,
        mimeType: 'application/vnd.apple.mpegurl',
        acceptRanges: false,
        contentLength: 0,
        directUrl: `/api/play/hls?token=${token}`,
        variants:
          masterVariants.length > 0
            ? masterVariants
            : [
                {
                  id: 'original-hls',
                  label: 'Original Stream',
                  quality: 'auto',
                  url: `/api/play/hls?token=${token}`,
                  source: 'original',
                },
                { id: '1080p', label: '1080p Full HD', quality: '1080p', height: 1080, source: 'transcode' },
                { id: '720p', label: '720p HD', quality: '720p', height: 720, source: 'transcode' },
                { id: '480p', label: '480p SD', quality: '480p', height: 480, source: 'transcode' },
                { id: '360p', label: '360p Data Saver', quality: '360p', height: 360, source: 'transcode' },
              ],
      };
      variantCache.set(cacheKey, { expiresAt: Date.now() + 90_000, payload });
      res.json(payload);
      return;
    }

    await probeResp.body?.cancel().catch(() => {});
    const cr = parseContentRangeMeta(probeResp.headers.get('content-range'), 0, 1);
    const clHeader = Number(probeResp.headers.get('content-length') || '0');
    const totalLength = cr.totalSize || (probeResp.status === 200 && clHeader > 0 ? clHeader : 0);
    const acceptRanges =
      probeResp.status === 206 ||
      (probeResp.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');

    const payload = {
      isMasterPlaylist: false,
      isHls: false,
      mimeType:
        ctype && ctype !== 'application/octet-stream' ? ctype : mimeForExtension(parsed.ext),
      acceptRanges,
      contentLength: totalLength,
      variants: [
        { id: 'original', label: 'Original Quality', quality: 'auto', source: 'original' },
        { id: '1080p', label: '1080p Full HD', quality: '1080p', height: 1080, source: 'transcode' },
        { id: '720p', label: '720p HD', quality: '720p', height: 720, source: 'transcode' },
        { id: '480p', label: '480p SD', quality: '480p', height: 480, source: 'transcode' },
        { id: '360p', label: '360p Data Saver', quality: '360p', height: 360, source: 'transcode' },
      ],
    };
    variantCache.set(cacheKey, { expiresAt: Date.now() + 120_000, payload });
    res.json(payload);
  } catch {
    res.json({
      isMasterPlaylist: false,
      isHls: parsed.ext === 'm3u8',
      mimeType: mimeForExtension(parsed.ext),
      acceptRanges: false,
      contentLength: 0,
      variants: [
        { id: 'original', label: 'Original Quality', quality: 'auto', source: 'original' },
        { id: '1080p', label: '1080p Full HD', quality: '1080p', height: 1080, source: 'transcode' },
        { id: '720p', label: '720p HD', quality: '720p', height: 720, source: 'transcode' },
        { id: '480p', label: '480p SD', quality: '480p', height: 480, source: 'transcode' },
        { id: '360p', label: '360p Data Saver', quality: '360p', height: 360, source: 'transcode' },
      ],
    });
  }
}

export interface QualitySizeEstimate {
  bytes: number;
  exact: boolean;
  mode: 'direct' | 'transcode';
}

export interface DownloadSizeSummary {
  kind: 'movie' | 'series';
  id: string;
  ext: string;
  contentLength: number;
  durationSec: number;
  browserSafeDirect: boolean;
  isHls: boolean;
  sizes: Record<'360p' | '480p' | '720p' | '1080p', QualitySizeEstimate>;
  expiresAt: number;
}

const downloadSizeCache = new Map<string, DownloadSizeSummary>();
const inFlightDownloadSizeLookups = new Map<string, Promise<DownloadSizeSummary>>();

function buildQualitySizesFromMeta(
  contentLength: number,
  durationSec: number,
  browserSafeDirect: boolean,
): Record<'360p' | '480p' | '720p' | '1080p', QualitySizeEstimate> {
  const tiers: Array<'360p' | '480p' | '720p' | '1080p'> = ['360p', '480p', '720p', '1080p'];
  const ratioFallback: Record<'360p' | '480p' | '720p' | '1080p', number> = {
    '360p': 0.2,
    '480p': 0.34,
    '720p': 0.52,
    '1080p': 0.85,
  };
  const out = {} as Record<'360p' | '480p' | '720p' | '1080p', QualitySizeEstimate>;

  for (const q of tiers) {
    if (q === '1080p' && browserSafeDirect && contentLength > 0) {
      out[q] = { bytes: contentLength, exact: true, mode: 'direct' };
      continue;
    }
    const preset = getDownloadPreset(q);
    if (durationSec > 0) {
      out[q] = {
        bytes: Math.round(durationSec * preset.estBytesPerSec),
        exact: false,
        mode: 'transcode',
      };
    } else if (contentLength > 0) {
      out[q] = {
        bytes: Math.max(1024 * 1024, Math.round(contentLength * ratioFallback[q])),
        exact: false,
        mode: 'transcode',
      };
    } else {
      out[q] = { bytes: 0, exact: false, mode: 'transcode' };
    }
  }
  return out;
}

async function resolveDownloadSizeSummary(
  kind: 'movie' | 'series',
  id: string,
  ext: string,
  fallbackDurationSec = 0,
  skipFfprobe = false,
): Promise<DownloadSizeSummary> {
  const cleanExt = (ext || 'mp4').toLowerCase();
  const cacheKey = `${kind}:${id}:${cleanExt}`;
  const now = Date.now();
  const cached = downloadSizeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if (cached.durationSec === 0 && fallbackDurationSec > 0) {
      const updated: DownloadSizeSummary = {
        ...cached,
        durationSec: fallbackDurationSec,
        sizes: buildQualitySizesFromMeta(
          cached.contentLength,
          fallbackDurationSec,
          cached.browserSafeDirect,
        ),
      };
      downloadSizeCache.set(cacheKey, updated);
      return updated;
    }
    return cached;
  }

  const pending = inFlightDownloadSizeLookups.get(cacheKey);
  if (pending) return pending;

  const upstreamUrl = buildUpstreamStreamUrl(kind, id, cleanExt);

  const run = (async (): Promise<DownloadSizeSummary> => {
    let contentLength = 0;
    let isHls = cleanExt === 'm3u8' || upstreamUrl.toLowerCase().includes('.m3u8');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const cachedRedirect = resolvedUrlCache.get(upstreamUrl);
      const targetUrl =
        cachedRedirect && cachedRedirect.expiresAt > Date.now()
          ? cachedRedirect.finalUrl
          : upstreamUrl;

      const resp = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          ...(isHls ? {} : { Range: 'bytes=0-0' }),
        },
        redirect: 'follow',
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      const finalUrl = resp.url || upstreamUrl;
      if (finalUrl && finalUrl !== upstreamUrl && resp.ok) {
        resolvedUrlCache.set(upstreamUrl, {
          finalUrl,
          expiresAt: Date.now() + RESOLVED_URL_TTL_MS,
        });
      }

      const ctype = (resp.headers.get('content-type') || '').toLowerCase();
      isHls = isHls || ctype.includes('mpegurl') || finalUrl.toLowerCase().includes('.m3u8');

      if (resp.ok && !isHls) {
        const cr = parseContentRangeMeta(resp.headers.get('content-range'), 0, 1);
        const cl = Number(resp.headers.get('content-length') || '0');
        contentLength = cr.totalSize || (resp.status === 200 && cl > 1 ? cl : 0);
      }
      await resp.body?.cancel().catch(() => {});
    } catch {
      // Fall through to probe / fallback
    }

    const cachedProbe = probeCache.get(upstreamUrl);
    let durationSec =
      cachedProbe && cachedProbe.expiresAt > Date.now() ? cachedProbe.durationSec : 0;

    if (durationSec <= 0 && !isHls && !skipFfprobe) {
      const probed = await probeMediaCodecs(upstreamUrl).catch(() => null);
      if (probed && probed.durationSec > 0) {
        durationSec = probed.durationSec;
      }
    }

    if (durationSec <= 0 && fallbackDurationSec > 0) {
      durationSec = fallbackDurationSec;
    }

    const browserSafeDirect =
      !isHls && (cleanExt === 'mp4' || cleanExt === 'm4v' || cleanExt === 'webm');

    const summary: DownloadSizeSummary = {
      kind,
      id,
      ext: cleanExt,
      contentLength,
      durationSec,
      browserSafeDirect,
      isHls,
      sizes: buildQualitySizesFromMeta(contentLength, durationSec, browserSafeDirect),
      expiresAt: Date.now() + (contentLength > 0 || durationSec > 0 ? 15 * 60_000 : 45_000),
    };

    if (downloadSizeCache.size > 400) {
      const firstKey = downloadSizeCache.keys().next().value;
      if (firstKey) downloadSizeCache.delete(firstKey);
    }
    downloadSizeCache.set(cacheKey, summary);
    return summary;
  })().finally(() => {
    inFlightDownloadSizeLookups.delete(cacheKey);
  });

  inFlightDownloadSizeLookups.set(cacheKey, run);
  return run;
}

export async function handleDownloadSizes(req: Request, res: Response): Promise<void> {
  const parsed = parseQualityTarget(req);
  if (!parsed.kind || (parsed.kind !== 'movie' && parsed.kind !== 'series') || !parsed.upstreamUrl) {
    res.status(400).json({ error: parsed.error || 'Only movies and series episodes support size probes' });
    return;
  }

  const fallbackDur = Math.max(0, Number(req.query.durationSec || 0) || 0);
  const skipProbe = req.query.quick === '1';
  const summary = await resolveDownloadSizeSummary(
    parsed.kind,
    parsed.id,
    parsed.ext,
    fallbackDur,
    skipProbe,
  );
  res.json(summary);
}

export async function handleMediaLanguages(req: Request, res: Response): Promise<void> {
  const rawKind = String(req.params.kind || '').toLowerCase();
  const kind: 'movie' | 'episode' | null =
    rawKind === 'movie' || rawKind === 'vod'
      ? 'movie'
      : rawKind === 'episode' || rawKind === 'series'
        ? 'episode'
        : null;

  const id = String(req.params.id || '').replace(/\.[a-zA-Z0-9]+$/, '');
  if (!kind || !/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Invalid media target' });
    return;
  }

  const ext = String(req.query.ext || 'mp4').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
  const seriesId = typeof req.query.seriesId === 'string' ? req.query.seriesId.trim() : '';
  const seasonNum = Number(req.query.seasonNum || 0) || undefined;
  const episodeNum = Number(req.query.episodeNum || 0) || undefined;
  const titleHint = typeof req.query.title === 'string' ? req.query.title.trim() : undefined;
  const skipProbe = req.query.skipProbe === '1';

  const upstreamKind = kind === 'episode' ? 'series' : 'movie';
  const upstreamUrl = buildUpstreamStreamUrl(upstreamKind, id, ext);

  const [catalogRes, probeRes] = await Promise.allSettled([
    findCatalogLanguageVariants({
      kind,
      id,
      seriesId: seriesId || undefined,
      seasonNum,
      episodeNum,
      titleHint,
    }),
    skipProbe ? Promise.resolve(null) : probeMediaCodecs(upstreamUrl),
  ]);

  const catalog =
    catalogRes.status === 'fulfilled'
      ? catalogRes.value
      : { activeLanguage: 'Original', variants: [] };
  const probe = probeRes.status === 'fulfilled' ? probeRes.value : null;

  const payload: MediaLanguagesResponse = {
    activeLanguage: catalog.activeLanguage,
    catalogVariants: catalog.variants,
    audioTracks: probe?.audioTracks || [],
    subtitleTracks: probe?.subtitleTracks || [],
  };

  res.json(payload);
}

const QUALITY_STREAM_DIR = path.join(os.tmpdir(), 'cinebox-qstream');
const QUALITY_SESSION_IDLE_TTL_MS = 60_000;
const QUALITY_BUFFER_PAUSE_AHEAD_BYTES = 20 * 1024 * 1024;
const QUALITY_BUFFER_RESUME_AHEAD_BYTES = 10 * 1024 * 1024;
const QUALITY_CHUNK_CAP_BYTES = 4 * 1024 * 1024;

try {
  fs.rmSync(QUALITY_STREAM_DIR, { recursive: true, force: true });
} catch {
  // ignore
}

interface QualityStreamSession {
  jobId: string;
  kind: 'movie' | 'series' | 'live' | 'catchup';
  upstreamUrl: string;
  safeUpstreamUrl: string;
  quality: StreamQualityPreset;
  container: 'mp4' | 'webm';
  startSec: number;
  audioIdx: number;
  hasAudio: boolean;
  durationSec: number;
  filePath: string;
  fd: number;
  proc: ChildProcess;
  totalProduced: number;
  lastServedOffset: number;
  eof: boolean;
  error: string | null;
  killedByUser: boolean;
  paused: boolean;
  lastAccessedAt: number;
  waiters: Set<() => void>;
}

const qualitySessions = new Map<string, QualityStreamSession>();
const pendingQualitySessionInits = new Map<string, Promise<QualityStreamSession | null>>();

function wakeQualitySessionWaiters(session: QualityStreamSession): void {
  if (session.waiters.size === 0) return;
  const list = Array.from(session.waiters);
  session.waiters.clear();
  for (const fn of list) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

function destroyQualitySession(jobId: string): void {
  const session = qualitySessions.get(jobId);
  if (!session) return;
  qualitySessions.delete(jobId);
  session.killedByUser = true;
  if (session.proc && !session.proc.killed) {
    try {
      session.proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  if (session.fd >= 0) {
    try {
      fs.closeSync(session.fd);
    } catch {
      // ignore
    }
    session.fd = -1;
  }
  try {
    fs.rmSync(session.filePath, { force: true });
  } catch {
    // ignore
  }
  wakeQualitySessionWaiters(session);
}

function destroyAllQualitySessions(exceptJobId?: string): void {
  for (const id of Array.from(qualitySessions.keys())) {
    if (id !== exceptJobId) {
      destroyQualitySession(id);
    }
  }
}

function sweepIdleQualitySessions(): void {
  const now = Date.now();
  for (const [id, session] of qualitySessions.entries()) {
    if (now - session.lastAccessedAt > QUALITY_SESSION_IDLE_TTL_MS) {
      destroyQualitySession(id);
    }
  }
}

const qualitySweepTimer = setInterval(sweepIdleQualitySessions, 15_000);
qualitySweepTimer.unref?.();

function readFileSliceSync(fd: number, start: number, len: number): Buffer {
  if (fd < 0 || len <= 0) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(len);
  let totalRead = 0;
  while (totalRead < len) {
    const n = fs.readSync(fd, out, totalRead, len - totalRead, start + totalRead);
    if (n <= 0) break;
    totalRead += n;
  }
  return totalRead === len ? out : out.subarray(0, totalRead);
}

function waitForQualitySessionCondition(
  session: QualityStreamSession,
  predicate: () => boolean,
  timeoutMs: number,
  reqAborted: () => boolean,
): Promise<boolean> {
  if (predicate() || reqAborted()) return Promise.resolve(predicate());
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.waiters.delete(onNotify);
    };
    const onNotify = () => {
      if (reqAborted() || predicate()) {
        cleanup();
        resolve(predicate());
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(predicate());
    }, timeoutMs);
    session.waiters.add(onNotify);
  });
}

function evaluateQualityThrottle(session: QualityStreamSession): void {
  if (session.eof || session.killedByUser) return;
  const ahead = session.totalProduced - session.lastServedOffset;
  if (!session.paused && ahead >= QUALITY_BUFFER_PAUSE_AHEAD_BYTES) {
    session.paused = true;
    session.proc?.stdout?.pause();
  } else if (session.paused && ahead <= QUALITY_BUFFER_RESUME_AHEAD_BYTES) {
    session.paused = false;
    session.proc?.stdout?.resume();
  }
}

function attachQualityFfmpegProcess(
  session: QualityStreamSession,
  inputUrl: string,
  allowRedirectRetry: boolean,
  upstreamRetryCount = 0,
): void {
  const isLiveOrCatchup = session.kind === 'live' || session.kind === 'catchup';
  const spec = getStreamQualitySpec(session.quality);

  const args: string[] = [
    '-v',
    'error',
    '-fflags',
    '+genpts+discardcorrupt',
    '-probesize',
    '350000',
    '-analyzeduration',
    '350000',
    '-rw_timeout',
    '12000000',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '3',
    '-user_agent',
    'VLC/3.0.18 LibVLC/3.0.18',
  ];
  if (session.startSec > 0 && !isLiveOrCatchup) {
    args.push('-ss', String(session.startSec));
  }
  args.push(
    '-i',
    inputUrl,
    '-map',
    '0:v:0',
    '-map',
    `0:a:${session.audioIdx}?`,
    '-sn',
    '-vf',
    spec.scale,
  );

  if (session.container === 'webm') {
    args.push(
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-lag-in-frames',
      '0',
      '-error-resilient',
      '1',
      '-b:v',
      spec.maxrate,
      '-maxrate',
      spec.maxrate,
      '-bufsize',
      spec.bufsize,
      '-g',
      '48',
      '-keyint_min',
      '48',
      '-threads',
      session.quality === '1080p' ? '3' : '2',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-b:a',
      spec.audioBitrate,
      '-avoid_negative_ts',
      'make_zero',
      '-max_muxing_queue_size',
      '1024',
      '-f',
      'webm',
      'pipe:1',
    );
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-profile:v',
      spec.profile,
      '-level:v',
      spec.level,
      '-threads',
      session.quality === '1080p' ? '3' : '2',
      '-preset',
      spec.preset,
      '-tune',
      'zerolatency',
      '-crf',
      spec.crf,
      '-maxrate',
      spec.maxrate,
      '-bufsize',
      spec.bufsize,
      '-g',
      '30',
      '-keyint_min',
      '30',
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-b:a',
      spec.audioBitrate,
      '-avoid_negative_ts',
      'make_zero',
      '-max_muxing_queue_size',
      '1024',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    );
  }

  const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  session.proc = proc;
  let stderrBuf = '';
  let stdoutEnded = false;

  proc.on('error', (err) => {
    if (session.killedByUser) {
      wakeQualitySessionWaiters(session);
      return;
    }
    session.error = err.message || 'Unable to launch FFmpeg transcoder';
    wakeQualitySessionWaiters(session);
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-500);
  });

  proc.stdout?.on('data', (chunk: Buffer) => {
    if (session.killedByUser || session.fd < 0 || chunk.length === 0) return;
    try {
      fs.writeSync(session.fd, chunk, 0, chunk.length, session.totalProduced);
      session.totalProduced += chunk.length;
    } catch (err) {
      session.error = err instanceof Error ? err.message : 'Quality stream buffer write failed';
    }
    evaluateQualityThrottle(session);
    wakeQualitySessionWaiters(session);
  });

  proc.stdout?.on('end', () => {
    stdoutEnded = true;
    wakeQualitySessionWaiters(session);
  });

  proc.on('exit', (code, signal) => {
    if (session.killedByUser) {
      wakeQualitySessionWaiters(session);
      return;
    }

    if (session.totalProduced === 0 && allowRedirectRetry && inputUrl !== session.safeUpstreamUrl) {
      resolvedUrlCache.delete(session.upstreamUrl);
      session.paused = false;
      attachQualityFfmpegProcess(session, session.safeUpstreamUrl, false, upstreamRetryCount);
      return;
    }

    if (session.totalProduced === 0 && upstreamRetryCount < 2 && code !== 0) {
      resolvedUrlCache.delete(session.upstreamUrl);
      session.paused = false;
      setTimeout(() => {
        if (session.killedByUser || !qualitySessions.has(session.jobId)) return;
        attachQualityFfmpegProcess(session, session.safeUpstreamUrl, false, upstreamRetryCount + 1);
      }, 700);
      return;
    }

    if (code === 0 && (stdoutEnded || session.totalProduced > 0)) {
      session.eof = true;
    } else {
      session.error =
        stderrBuf.trim() || `Quality stream transcode exited (code ${code ?? signal ?? 'unknown'})`;
    }
    wakeQualitySessionWaiters(session);
  });
}

async function getOrCreateQualitySession(params: {
  jobId: string;
  kind: 'movie' | 'series' | 'live' | 'catchup';
  upstreamUrl: string;
  quality: StreamQualityPreset;
  container: 'mp4' | 'webm';
  startSec: number;
  audioIdx: number;
}): Promise<QualityStreamSession | null> {
  sweepIdleQualitySessions();
  const existing = qualitySessions.get(params.jobId);
  if (existing && !existing.killedByUser) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  const inInit = pendingQualitySessionInits.get(params.jobId);
  if (inInit) {
    return inInit;
  }

  const initPromise = (async (): Promise<QualityStreamSession | null> => {
    destroyAllQualitySessions(params.jobId);
    destroyAllHlsSessions();
    const killedPrev = killActiveTranscode();
    await releaseActiveVodConnections();
    await releaseActiveLiveConnection();
    if (killedPrev) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const isLiveOrCatchup = params.kind === 'live' || params.kind === 'catchup';
    let durationSec = 0;
    let safeAudioIdx = params.audioIdx;
    let hasAudio = true;

    if (!isLiveOrCatchup) {
      const cachedProbe = probeCache.get(params.upstreamUrl);
      if (cachedProbe && cachedProbe.expiresAt > Date.now()) {
        durationSec = cachedProbe.durationSec || 0;
        hasAudio = cachedProbe.audioTracks.length > 0 || Boolean(cachedProbe.audioCodec);
        if (cachedProbe.audioTracks.length > 0 && safeAudioIdx >= cachedProbe.audioTracks.length) {
          safeAudioIdx = 0;
        }
      } else if (safeAudioIdx > 0) {
        const probed = await probeMediaCodecs(params.upstreamUrl).catch(() => null);
        if (probed) {
          durationSec = probed.durationSec || 0;
          hasAudio = probed.audioTracks.length > 0 || Boolean(probed.audioCodec);
          if (probed.audioTracks.length > 0 && safeAudioIdx >= probed.audioTracks.length) {
            safeAudioIdx = 0;
          }
        }
      }
    }

    const cachedRedirect = resolvedUrlCache.get(params.upstreamUrl);
    const inputUrl =
      cachedRedirect && cachedRedirect.expiresAt > Date.now()
        ? cachedRedirect.finalUrl
        : params.upstreamUrl;
    const safeUpstreamUrl = await wrapFfmpegInputUrl(params.upstreamUrl);
    const safeInputUrl =
      inputUrl !== params.upstreamUrl ? await wrapFfmpegInputUrl(inputUrl) : safeUpstreamUrl;

    fs.mkdirSync(QUALITY_STREAM_DIR, { recursive: true });
    const filePath = path.join(
      QUALITY_STREAM_DIR,
      `${params.jobId.replace(/[^a-zA-Z0-9_-]/g, '')}.${params.container}`,
    );
    const fd = fs.openSync(filePath, 'w+');

    const created: QualityStreamSession = {
      jobId: params.jobId,
      kind: params.kind,
      upstreamUrl: params.upstreamUrl,
      safeUpstreamUrl,
      quality: params.quality,
      container: params.container,
      startSec: isLiveOrCatchup ? 0 : params.startSec,
      audioIdx: safeAudioIdx,
      hasAudio,
      durationSec,
      filePath,
      fd,
      proc: null as unknown as ChildProcess,
      totalProduced: 0,
      lastServedOffset: 0,
      eof: false,
      error: null,
      killedByUser: false,
      paused: false,
      lastAccessedAt: Date.now(),
      waiters: new Set(),
    };
    qualitySessions.set(params.jobId, created);
    attachQualityFfmpegProcess(created, safeInputUrl, safeInputUrl !== safeUpstreamUrl, 0);
    return created;
  })().finally(() => {
    pendingQualitySessionInits.delete(params.jobId);
  });

  pendingQualitySessionInits.set(params.jobId, initPromise);
  return initPromise;
}

function parseQualityTarget(req: Request): {
  kind: 'movie' | 'series' | 'live' | 'catchup' | null;
  id: string;
  ext: string;
  quality: StreamQualityPreset;
  container: 'mp4' | 'webm';
  startSec: number;
  audioIdx: number;
  upstreamUrl: string | null;
  error?: string;
} {
  const rawKind = String(req.params.kind || '').toLowerCase();
  const kind: 'movie' | 'series' | 'live' | 'catchup' | null =
    rawKind === 'series' || rawKind === 'episode'
      ? 'series'
      : rawKind === 'vod' || rawKind === 'movie'
        ? 'movie'
        : rawKind === 'live'
          ? 'live'
          : rawKind === 'catchup'
            ? 'catchup'
            : null;
  const id = String(req.params.id || '').replace(/\.[a-zA-Z0-9]+$/, '');
  const ext =
    String(req.query.ext || (kind === 'live' || kind === 'catchup' ? 'ts' : 'mp4')).replace(
      /[^a-zA-Z0-9]/g,
      '',
    ) || 'mp4';
  const rawQ = String(
    req.query.quality || (req.query.mode === 'smooth' ? '480p' : '720p'),
  ).toLowerCase();
  const quality: StreamQualityPreset =
    rawQ === '360p' || rawQ === '480p' || rawQ === '720p' || rawQ === '1080p' ? rawQ : '720p';
  const rawContainer = String(req.query.container || 'mp4').toLowerCase();
  const container: 'mp4' | 'webm' = rawContainer === 'webm' ? 'webm' : 'mp4';
  const startSec = Math.max(0, Math.floor(Number(req.query.start || 0) || 0));
  const audioIdx = Math.max(0, Math.floor(Number(req.query.audio ?? 0) || 0));

  if (!kind || !/^\d+$/.test(id)) {
    return {
      kind: null,
      id,
      ext,
      quality,
      container,
      startSec,
      audioIdx,
      upstreamUrl: null,
      error: 'Invalid media target',
    };
  }

  let upstreamUrl: string;
  if (kind === 'catchup') {
    const startTs = Number(req.query.startTs || 0);
    const durationMin = Number(req.query.duration || 60);
    if (!startTs || !Number.isFinite(startTs)) {
      return {
        kind,
        id,
        ext,
        quality,
        container,
        startSec,
        audioIdx,
        upstreamUrl: null,
        error: 'Missing startTs parameter',
      };
    }
    const d = new Date(startTs * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const startFormatted = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate(),
    )}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
    upstreamUrl = buildCatchupUrl(id, durationMin, startFormatted);
  } else {
    upstreamUrl = buildUpstreamStreamUrl(kind, id, ext);
  }

  return { kind, id, ext, quality, container, startSec, audioIdx, upstreamUrl };
}

export async function handleCloseQualitySession(req: Request, res: Response): Promise<void> {
  const jobId = String(req.params.jobId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (jobId) {
    destroyQualitySession(jobId);
  }
  res.json({ ok: true });
}

export async function handleQualityChunkStream(req: Request, res: Response): Promise<void> {
  const parsed = parseQualityTarget(req);
  if (!parsed.kind || !parsed.upstreamUrl) {
    res.status(400).json({ error: parsed.error || 'Invalid media target' });
    return;
  }

  const rawJobId = typeof req.query.job === 'string' ? req.query.job.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  const jobId =
    rawJobId ||
    `q_${parsed.kind}_${parsed.id}_${parsed.quality}_${parsed.container}_${parsed.startSec}_${parsed.audioIdx}`;
  const warmOnly = req.query.warmOnly === '1' || req.query.warmOnly === 'true';

  const queryOffsetRaw = req.query.offset !== undefined ? Number(req.query.offset) : NaN;
  const queryLenRaw = req.query.len !== undefined ? Number(req.query.len) : NaN;
  const effectiveRange =
    typeof req.headers.range === 'string'
      ? req.headers.range
      : Number.isFinite(queryOffsetRaw) && queryOffsetRaw >= 0
        ? `bytes=${Math.floor(queryOffsetRaw)}-${
            Math.floor(queryOffsetRaw) +
            Math.min(
              QUALITY_CHUNK_CAP_BYTES,
              Math.max(1, Number.isFinite(queryLenRaw) && queryLenRaw > 0 ? Math.floor(queryLenRaw) : 1536 * 1024),
            ) -
            1
          }`
        : undefined;

  const { start, end: parsedEnd } = parseRequestedByteRange(effectiveRange);
  const end = Math.min(parsedEnd, start + QUALITY_CHUNK_CAP_BYTES - 1);

  let reqClosed = false;
  res.on('close', () => {
    reqClosed = true;
    const active = qualitySessions.get(jobId);
    if (active) wakeQualitySessionWaiters(active);
  });

  if (!qualitySessions.has(jobId) && !pendingQualitySessionInits.has(jobId) && start > 0 && !warmOnly) {
    res.status(410).json({ error: 'Quality stream session expired. Retrying from current position.' });
    return;
  }

  const session = await getOrCreateQualitySession({
    jobId,
    kind: parsed.kind,
    upstreamUrl: parsed.upstreamUrl,
    quality: parsed.quality,
    container: parsed.container,
    startSec: parsed.startSec,
    audioIdx: parsed.audioIdx,
  });

  if (reqClosed || !session) return;

  session.lastAccessedAt = Date.now();
  if (!warmOnly && start > session.lastServedOffset) {
    session.lastServedOffset = start;
    evaluateQualityThrottle(session);
  }

  const minTargetBytes = warmOnly ? 1 : start + 1;
  const ready = await waitForQualitySessionCondition(
    session,
    () =>
      session.totalProduced >= minTargetBytes ||
      session.eof ||
      session.error !== null ||
      session.killedByUser,
    4_800,
    () => reqClosed,
  );

  if (reqClosed) return;

  if (!ready && session.totalProduced < minTargetBytes && !session.eof && !session.error) {
    res.setHeader('Retry-After', '1');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Download-Status', 'preparing');
    res.status(202).json({
      status: 'preparing',
      retryable: true,
      jobId,
      bufferedBytes: session.totalProduced,
      durationSec: session.durationSec,
      hasAudio: session.hasAudio,
    });
    return;
  }

  if (session.totalProduced < minTargetBytes) {
    if (session.error) {
      const msg = session.error;
      destroyQualitySession(jobId);
      res.status(502).json({ error: msg });
      return;
    }
    if (session.eof) {
      if (warmOnly) {
        res.status(200).json({
          ready: true,
          jobId,
          bufferedBytes: session.totalProduced,
          durationSec: session.durationSec,
          hasAudio: session.hasAudio,
        });
        return;
      }
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      applyStreamCorsHeaders(req, res);
      res.setHeader('X-Stream-EOF', '1');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }
    res.status(504).json({ error: 'Stream warmup stalled' });
    return;
  }

  if (warmOnly) {
    res.status(200).json({
      ready: true,
      jobId,
      bufferedBytes: session.totalProduced,
      durationSec: session.durationSec,
      hasAudio: session.hasAudio,
    });
    return;
  }

  // Coalesce briefly: small 384 KiB on chunk 0 for instant first frame, up to 1.5 MiB thereafter
  const targetSpan = start === 0 ? 384 * 1024 : 1536 * 1024;
  const coalesceTarget = Math.min(end + 1, start + targetSpan);
  if (!session.eof && !session.error && session.totalProduced < coalesceTarget) {
    await waitForQualitySessionCondition(
      session,
      () => session.totalProduced >= coalesceTarget || session.eof || session.error !== null,
      850,
      () => reqClosed,
    );
    if (reqClosed) return;
  }

  const sliceEnd = Math.min(end, session.totalProduced - 1);
  const outBuf = readFileSliceSync(session.fd, start, sliceEnd - start + 1);
  const isFinalByte = session.eof && sliceEnd === session.totalProduced - 1;
  const totalLabel = session.eof ? String(session.totalProduced) : '*';

  session.lastServedOffset = Math.max(session.lastServedOffset, sliceEnd + 1);
  evaluateQualityThrottle(session);

  res.status(206);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  applyStreamCorsHeaders(req, res);
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Range', `bytes ${start}-${sliceEnd}/${totalLabel}`);
  res.setHeader('Content-Length', String(outBuf.length));
  res.setHeader('X-Stream-EOF', isFinalByte ? '1' : '0');
  res.setHeader('X-Stream-Has-Audio', session.hasAudio ? '1' : '0');
  if (session.durationSec > 0) {
    res.setHeader('X-Media-Duration-Sec', String(Math.round(session.durationSec)));
  }
  res.send(outBuf);
}

export async function handleTranscodePlay(req: Request, res: Response): Promise<void> {
  const parsed = parseQualityTarget(req);
  if (!parsed.kind || !parsed.upstreamUrl) {
    res.status(400).json({ error: parsed.error || 'Invalid media target' });
    return;
  }

  const rawJobId = typeof req.query.job === 'string' ? req.query.job.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  const jobId =
    rawJobId ||
    `nat_${parsed.kind}_${parsed.id}_${parsed.quality}_${parsed.container}_${parsed.startSec}_${parsed.audioIdx}`;

  let reqClosed = false;
  res.on('close', () => {
    reqClosed = true;
    const active = qualitySessions.get(jobId);
    if (active) wakeQualitySessionWaiters(active);
  });

  const session = await getOrCreateQualitySession({
    jobId,
    kind: parsed.kind,
    upstreamUrl: parsed.upstreamUrl,
    quality: parsed.quality,
    container: parsed.container,
    startSec: parsed.startSec,
    audioIdx: parsed.audioIdx,
  });

  if (reqClosed || !session) return;
  session.lastAccessedAt = Date.now();
  const outMime = session.container === 'webm' ? 'video/webm' : 'video/mp4';

  // Wait up to 18s for container header initial bytes
  const ready = await waitForQualitySessionCondition(
    session,
    () => session.totalProduced > 0 || session.eof || session.error !== null || session.killedByUser,
    18_000,
    () => reqClosed,
  );
  if (reqClosed) return;

  if (!ready || session.totalProduced === 0) {
    const errMsg = session.error || 'Unable to start transcoded video stream';
    destroyQualitySession(jobId);
    if (!res.headersSent) {
      res.status(502).json({ error: errMsg });
    }
    return;
  }

  if (req.method === 'HEAD') {
    res.status(200);
    res.setHeader('Content-Type', outMime);
    res.setHeader('Accept-Ranges', session.container === 'webm' ? 'none' : 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    applyStreamCorsHeaders(req, res);
    if (session.durationSec > 0) {
      res.setHeader('X-Media-Duration-Sec', String(Math.round(session.durationSec)));
    }
    res.end();
    return;
  }

  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  if (session.container !== 'webm' && rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/i);
    if (m) {
      const rStart = Number(m[1]);
      const rExplicitEnd = m[2] ? Number(m[2]) : NaN;
      if (Number.isFinite(rExplicitEnd) && rExplicitEnd >= rStart && rExplicitEnd - rStart <= 512 * 1024) {
        const probeReady = await waitForQualitySessionCondition(
          session,
          () =>
            session.totalProduced > rStart ||
            session.eof ||
            session.error !== null ||
            session.killedByUser,
          8_000,
          () => reqClosed,
        );
        if (reqClosed) return;
        if (!probeReady || session.totalProduced <= rStart) {
          res.status(416).end();
          return;
        }
        const sEnd = Math.min(rExplicitEnd, session.totalProduced - 1);
        const buf = readFileSliceSync(session.fd, rStart, sEnd - rStart + 1);
        res.status(206);
        res.setHeader('Content-Type', outMime);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-store');
        applyStreamCorsHeaders(req, res);
        res.setHeader('Content-Range', `bytes ${rStart}-${sEnd}/${session.eof ? session.totalProduced : '*'}`);
        res.setHeader('Content-Length', String(buf.length));
        res.send(buf);
        return;
      }
    }
  }

  // Continuous progressive stream read sequentially from session.fd.
  // Always serve valid HTTP 200 + Accept-Ranges: none so Chrome and Android WebView MediaPlayer/ExoPlayer
  // never reject open-ended responses with an invalid "bytes X-*/*" Content-Range header.
  let readCursor = 0;

  res.status(200);
  res.setHeader('Content-Type', outMime);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  applyStreamCorsHeaders(req, res);
  res.setHeader('Accept-Ranges', 'none');
  if (session.durationSec > 0) {
    res.setHeader('X-Media-Duration-Sec', String(Math.round(session.durationSec)));
  }
  res.flushHeaders();

  while (!reqClosed && !res.writableEnded && !session.killedByUser) {
    session.lastAccessedAt = Date.now();
    if (readCursor < session.totalProduced) {
      const avail = Math.min(256 * 1024, session.totalProduced - readCursor);
      const chunk = readFileSliceSync(session.fd, readCursor, avail);
      if (chunk.length > 0) {
        readCursor += chunk.length;
        session.lastServedOffset = Math.max(session.lastServedOffset, readCursor);
        evaluateQualityThrottle(session);
        const ok = res.write(chunk);
        if (!ok) {
          await new Promise<void>((resolve) => {
            if (reqClosed || res.writableEnded) {
              resolve();
              return;
            }
            const onDrainOrClose = () => {
              res.off('drain', onDrainOrClose);
              res.off('close', onDrainOrClose);
              resolve();
            };
            res.once('drain', onDrainOrClose);
            res.once('close', onDrainOrClose);
          });
        }
        continue;
      }
    }
    if (session.eof || session.error !== null) {
      break;
    }
    await waitForQualitySessionCondition(
      session,
      () =>
        session.totalProduced > readCursor ||
        session.eof ||
        session.error !== null ||
        session.killedByUser,
      10_000,
      () => reqClosed,
    );
  }

  if (!res.writableEnded) {
    res.end();
  }
}

const DOWNLOAD_JOBS_DIR = path.join(os.tmpdir(), 'cinebox-dl');
const DOWNLOAD_CHUNK_CAP_BYTES = 16 * 1024 * 1024; // 16 MiB chunks maximize throughput cleanly
const DOWNLOAD_BUFFER_PAUSE_STANDARD_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_BUFFER_RESUME_STANDARD_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_BUFFER_PAUSE_TURBO_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_BUFFER_RESUME_TURBO_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_JOB_IDLE_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_JOB_PAUSED_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours for paused/backgrounded tasks

try {
  fs.rmSync(DOWNLOAD_JOBS_DIR, { recursive: true, force: true });
} catch {
  // ignore
}

const DOWNLOAD_USER_AGENTS = [
  'VLC/3.0.18 LibVLC/3.0.18',
  'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TQ3A.230805.001)',
  'Lavf/60.16.100',
];

function sanitizeDownloadFilename(rawTitle: string, ext: string): string {
  const cleanBase = rawTitle
    .replace(/[^a-zA-Z0-9._ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'cinebox-video';
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'mp4';
  return `${cleanBase}.${safeExt}`;
}

async function releaseConflictingStreamsForDownload(): Promise<void> {
  const hadActive = Boolean(
    activeTranscodeProc ||
      activeVodController ||
      activeLiveController ||
      hlsSessions.size > 0 ||
      qualitySessions.size > 0 ||
      inFlightPrefetches.size > 0,
  );
  if (!hadActive) return;
  destroyAllHlsSessions();
  destroyAllQualitySessions();
  killActiveTranscode();
  await releaseActiveVodConnections();
  await releaseActiveLiveConnection();
  vodChunkCache.clear();
  await new Promise((r) => setTimeout(r, 180));
}

interface DownloadJob {
  jobId: string;
  upstreamUrl: string;
  safeUpstreamUrl: string;
  quality: '360p' | '480p' | '720p' | '1080p';
  profile: 'standard' | 'turbo';
  filePath: string;
  fd: number;
  proc: ChildProcess;
  totalProduced: number;
  lastServedOffset: number;
  eof: boolean;
  error: string | null;
  killedByUser: boolean;
  clientPaused: boolean;
  sigStopped: boolean;
  estimatedTotalBytes: number;
  durationSec: number;
  lastAccessedAt: number;
  paused: boolean;
  waiters: Set<() => void>;
}

const downloadJobs = new Map<string, DownloadJob>();

function wakeDownloadJobWaiters(job: DownloadJob): void {
  if (job.waiters.size === 0) return;
  const list = Array.from(job.waiters);
  job.waiters.clear();
  for (const fn of list) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

function destroyDownloadJob(jobId: string): void {
  const job = downloadJobs.get(jobId);
  if (!job) return;
  downloadJobs.delete(jobId);
  job.killedByUser = true;
  if (job.proc && !job.proc.killed) {
    try {
      if (job.sigStopped) job.proc.kill('SIGCONT');
    } catch {
      // ignore
    }
    try {
      job.proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  if (job.fd >= 0) {
    try {
      fs.closeSync(job.fd);
    } catch {
      // ignore
    }
    job.fd = -1;
  }
  try {
    fs.rmSync(job.filePath, { force: true });
  } catch {
    // ignore
  }
  wakeDownloadJobWaiters(job);
}

function sweepIdleDownloadJobs(): void {
  const now = Date.now();
  for (const [id, job] of downloadJobs.entries()) {
    const ttl = job.clientPaused ? DOWNLOAD_JOB_PAUSED_TTL_MS : DOWNLOAD_JOB_IDLE_TTL_MS;
    if (now - job.lastAccessedAt > ttl) {
      destroyDownloadJob(id);
    }
  }
}

const downloadJobSweepTimer = setInterval(sweepIdleDownloadJobs, 20_000);
downloadJobSweepTimer.unref?.();

function getDownloadPreset(quality: '360p' | '480p' | '720p' | '1080p') {
  if (quality === '360p') {
    return {
      scale: "scale=-2:'min(360,trunc(ih/2)*2)',setsar=1,format=yuv420p",
      crf: '28',
      maxrate: '750k',
      bufsize: '1500k',
      audioBitrate: '96k',
      level: '3.1',
      estBytesPerSec: 90_000,
    };
  }
  if (quality === '480p') {
    return {
      scale: "scale=-2:'min(480,trunc(ih/2)*2)',setsar=1,format=yuv420p",
      crf: '26',
      maxrate: '1250k',
      bufsize: '2500k',
      audioBitrate: '128k',
      level: '3.1',
      estBytesPerSec: 150_000,
    };
  }
  if (quality === '1080p') {
    return {
      scale: "scale=-2:'min(1080,trunc(ih/2)*2)',setsar=1,format=yuv420p",
      crf: '21',
      maxrate: '4000k',
      bufsize: '8000k',
      audioBitrate: '192k',
      level: '4.0',
      estBytesPerSec: 460_000,
    };
  }
  return {
    scale: "scale=-2:'min(720,trunc(ih/2)*2)',setsar=1,format=yuv420p",
    crf: '24',
    maxrate: '1800k',
    bufsize: '3600k',
    audioBitrate: '128k',
    level: '4.0',
    estBytesPerSec: 220_000,
  };
}

const pendingDownloadJobInits = new Map<string, Promise<DownloadJob | null>>();

function buildDownloadFfmpegArgs(
  inputUrl: string,
  preset: ReturnType<typeof getDownloadPreset>,
  isTurbo = false,
): string[] {
  const args = [
    '-v',
    'error',
    '-fflags',
    '+genpts+discardcorrupt',
    '-probesize',
    isTurbo ? '350000' : '500000',
    '-analyzeduration',
    isTurbo ? '350000' : '500000',
    '-rw_timeout',
    '12000000',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '3',
    '-user_agent',
    'VLC/3.0.18 LibVLC/3.0.18',
    '-i',
    inputUrl,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-vf',
    preset.scale,
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-level:v',
    preset.level,
    '-threads',
    isTurbo ? '0' : '2',
    '-preset',
    isTurbo ? 'ultrafast' : 'veryfast',
  ];
  if (isTurbo) {
    args.push('-tune', 'zerolatency');
  }
  args.push(
    '-crf',
    preset.crf,
    '-maxrate',
    preset.maxrate,
    '-bufsize',
    preset.bufsize,
    '-g',
    '48',
    '-keyint_min',
    '48',
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-b:a',
    preset.audioBitrate,
    '-avoid_negative_ts',
    'make_zero',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  );
  return args;
}

function evaluateDownloadThrottle(job: DownloadJob): void {
  if (job.eof || job.killedByUser || job.clientPaused) return;
  const ahead = job.totalProduced - job.lastServedOffset;
  const pauseAt =
    job.profile === 'turbo' ? DOWNLOAD_BUFFER_PAUSE_TURBO_BYTES : DOWNLOAD_BUFFER_PAUSE_STANDARD_BYTES;
  const resumeAt =
    job.profile === 'turbo' ? DOWNLOAD_BUFFER_RESUME_TURBO_BYTES : DOWNLOAD_BUFFER_RESUME_STANDARD_BYTES;
  if (!job.paused && ahead >= pauseAt) {
    job.paused = true;
    job.proc?.stdout?.pause();
  } else if (job.paused && ahead <= resumeAt) {
    job.paused = false;
    job.proc?.stdout?.resume();
  }
}

function attachDownloadProcess(
  job: DownloadJob,
  inputUrl: string,
  preset: ReturnType<typeof getDownloadPreset>,
  allowRedirectRetry: boolean,
  upstreamRetryCount = 0,
): void {
  const proc = spawn(FFMPEG_BIN, buildDownloadFfmpegArgs(inputUrl, preset, job.profile === 'turbo'), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.proc = proc;
  let stderrBuf = '';
  let stdoutEnded = false;

  proc.on('error', (err) => {
    if (job.killedByUser) {
      wakeDownloadJobWaiters(job);
      return;
    }
    job.error = err.message || 'Unable to launch FFmpeg download worker';
    wakeDownloadJobWaiters(job);
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-500);
  });

  proc.stdout?.on('data', (chunk: Buffer) => {
    if (job.killedByUser || job.fd < 0 || chunk.length === 0) return;
    try {
      fs.writeSync(job.fd, chunk, 0, chunk.length, job.totalProduced);
      job.totalProduced += chunk.length;
    } catch (err) {
      job.error = err instanceof Error ? err.message : 'Download file write error';
    }
    evaluateDownloadThrottle(job);
    wakeDownloadJobWaiters(job);
  });

  proc.stdout?.on('end', () => {
    stdoutEnded = true;
    wakeDownloadJobWaiters(job);
  });

  proc.on('exit', (code, signal) => {
    if (job.killedByUser) {
      wakeDownloadJobWaiters(job);
      return;
    }

    if (job.totalProduced === 0 && allowRedirectRetry && inputUrl !== job.safeUpstreamUrl) {
      resolvedUrlCache.delete(job.upstreamUrl);
      job.paused = false;
      attachDownloadProcess(job, job.safeUpstreamUrl, preset, false, upstreamRetryCount);
      return;
    }

    if (job.totalProduced === 0 && upstreamRetryCount < 3 && code !== 0) {
      resolvedUrlCache.delete(job.upstreamUrl);
      job.paused = false;
      const retryDelayMs = 800 + upstreamRetryCount * 700;
      setTimeout(() => {
        if (job.killedByUser || !downloadJobs.has(job.jobId)) return;
        attachDownloadProcess(job, job.safeUpstreamUrl, preset, false, upstreamRetryCount + 1);
      }, retryDelayMs);
      return;
    }

    if (code === 0 && stdoutEnded) {
      job.eof = true;
    } else if (code === 0 && job.totalProduced > 0) {
      job.eof = true;
    } else {
      job.error =
        stderrBuf.trim() ||
        `Download transcode interrupted (exit ${code ?? signal ?? 'unknown'})`;
    }
    wakeDownloadJobWaiters(job);
  });
}

function sliceJobBytes(job: DownloadJob, sliceStart: number, sliceEnd: number): Buffer {
  const len = Math.max(0, sliceEnd - sliceStart + 1);
  return readFileSliceSync(job.fd, sliceStart, len);
}

function waitForJobCondition(
  job: DownloadJob,
  predicate: () => boolean,
  timeoutMs: number,
  reqAborted: () => boolean,
): Promise<boolean> {
  if (predicate() || reqAborted()) return Promise.resolve(predicate());

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.waiters.delete(onNotify);
    };
    const onNotify = () => {
      if (reqAborted() || predicate()) {
        cleanup();
        resolve(predicate());
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(predicate());
    }, timeoutMs);

    job.waiters.add(onNotify);
  });
}

export async function handlePauseOfflineDownloadJob(req: Request, res: Response): Promise<void> {
  const jobId = String(req.params.jobId || '').trim();
  const job = jobId ? downloadJobs.get(jobId) : undefined;
  if (job) {
    job.clientPaused = true;
    job.lastAccessedAt = Date.now();
    try {
      job.proc?.stdout?.pause();
    } catch {
      // ignore
    }
    if (job.proc && !job.proc.killed && !job.eof && !job.sigStopped) {
      try {
        job.proc.kill('SIGSTOP');
        job.sigStopped = true;
      } catch {
        // ignore if unsupported
      }
    }
    res.json({ ok: true, totalProduced: job.totalProduced });
    return;
  }
  res.json({ ok: true, totalProduced: 0 });
}

export async function handleCancelOfflineDownloadJob(req: Request, res: Response): Promise<void> {
  const jobId = String(req.params.jobId || '').trim();
  if (jobId) {
    destroyDownloadJob(jobId);
  }
  res.json({ ok: true });
}

export async function handleOfflineDirectFileDownload(
  req: Request,
  res: Response,
): Promise<void> {
  const rawKind = String(req.params.kind || '').toLowerCase();
  const kind =
    rawKind === 'series' || rawKind === 'episode'
      ? 'series'
      : rawKind === 'vod' || rawKind === 'movie'
        ? 'movie'
        : null;
  const id = String(req.params.id || '').replace(/\.[a-zA-Z0-9]+$/, '');
  const ext = String(req.query.ext || 'mp4').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
  const rawFilename = typeof req.query.filename === 'string' ? req.query.filename : `cinebox-${id}`;
  const isInline = req.query.inline === '1' || req.query.inline === 'true';
  const quality = String(req.query.quality || '1080p').toLowerCase();

  if (!kind || !/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Invalid media download target' });
    return;
  }

  // Only release active streaming sessions if any exist so parallel Range downloads never stall each other
  if (
    activeTranscodeProc ||
    activeVodController ||
    activeLiveController ||
    hlsSessions.size > 0 ||
    qualitySessions.size > 0
  ) {
    await releaseConflictingStreamsForDownload();
  }

  const upstreamUrl = buildUpstreamStreamUrl(kind, id, ext);
  const controller = new AbortController();
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
    controller.abort();
  });

  const requestedRange = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const queryOffsetRaw = req.query.offset !== undefined ? Number(req.query.offset) : NaN;
  const queryLenRaw = req.query.len !== undefined ? Number(req.query.len) : NaN;
  const effectiveRange =
    requestedRange ||
    (Number.isFinite(queryOffsetRaw) && queryOffsetRaw >= 0
      ? `bytes=${Math.floor(queryOffsetRaw)}-${
          Math.floor(queryOffsetRaw) +
          Math.min(
            DOWNLOAD_CHUNK_CAP_BYTES,
            Math.max(1, Number.isFinite(queryLenRaw) && queryLenRaw > 0 ? Math.floor(queryLenRaw) : DOWNLOAD_CHUNK_CAP_BYTES),
          ) -
          1
        }`
      : undefined);

  let upstream: globalThis.Response | null = null;
  let lastStatus = 502;
  let lastErrorMsg = 'Unable to connect to media provider for download';

  for (let attempt = 0; attempt < 4; attempt++) {
    if (clientClosed) return;
    const now = Date.now();
    const cachedRedirect = resolvedUrlCache.get(upstreamUrl);
    const targetUrl =
      attempt === 0 && cachedRedirect && cachedRedirect.expiresAt > now
        ? cachedRedirect.finalUrl
        : upstreamUrl;

    const ua = DOWNLOAD_USER_AGENTS[attempt % DOWNLOAD_USER_AGENTS.length];
    const attemptTimer = setTimeout(() => controller.abort(), 20_000);

    try {
      const isHeadProbe = req.method === 'HEAD';
      const headers: Record<string, string> = {
        'User-Agent': ua,
        Accept: '*/*',
      };
      if (isHeadProbe) {
        headers.Range = 'bytes=0-0';
      } else if (effectiveRange) {
        headers.Range = effectiveRange;
      }

      const resp = await fetch(targetUrl, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(attemptTimer);

      const ctype = (resp.headers.get('content-type') || '').toLowerCase();
      if (resp.status >= 400 || ctype.includes('text/html')) {
        lastStatus = resp.status >= 400 ? resp.status : 502;
        lastErrorMsg = ctype.includes('text/html')
          ? 'Media stream is currently offline on the provider'
          : `Media provider returned HTTP ${resp.status}`;
        await resp.body?.cancel().catch(() => {});
        resolvedUrlCache.delete(upstreamUrl);

        const retryable =
          resp.status === 403 ||
          resp.status === 429 ||
          resp.status >= 500 ||
          ctype.includes('text/html');
        if (retryable && attempt < 3 && !clientClosed) {
          await new Promise((r) => setTimeout(r, 450 + attempt * 500));
          continue;
        }
        break;
      }

      upstream = resp;
      break;
    } catch (err) {
      clearTimeout(attemptTimer);
      if (clientClosed) return;
      resolvedUrlCache.delete(upstreamUrl);
      lastErrorMsg = err instanceof Error ? err.message : 'Upstream network error';
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 450 + attempt * 500));
        continue;
      }
    }
  }

  if (clientClosed) return;

  if (!upstream) {
    // Never emit 503 if upstream failed — return 502 JSON or cleanly fail transcode fallback
    if (!res.headersSent) {
      res.status(lastStatus === 404 ? 404 : lastStatus === 416 ? 416 : 502).json({
        error: lastErrorMsg,
      });
    }
    return;
  }

  const finalUrl = upstream.url || upstreamUrl;
  if (finalUrl && finalUrl !== upstreamUrl) {
    resolvedUrlCache.set(upstreamUrl, {
      finalUrl,
      expiresAt: Date.now() + RESOLVED_URL_TTL_MS,
    });
  }

  const rawCtype = upstream.headers.get('content-type') || '';
  const isPlaylist =
    finalUrl.toLowerCase().includes('.m3u8') || rawCtype.toLowerCase().includes('mpegurl');

  // If the upstream source is an HLS playlist (.m3u8) and caller wants a single downloadable MP4 file,
  // remux cleanly into a downloadable fragmented MP4 stream on the fly.
  if (isPlaylist) {
    await upstream.body?.cancel().catch(() => {});
    if (req.method === 'HEAD') {
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Disposition',
        `${isInline ? 'inline' : 'attachment'}; filename="${sanitizeDownloadFilename(rawFilename, 'mp4')}"`,
      );
      res.end();
      return;
    }

    const preset = getDownloadPreset(
      quality === '360p' || quality === '1080p' ? (quality as '360p' | '1080p') : '720p',
    );
    const safeFinalUrl = await wrapFfmpegInputUrl(finalUrl);
    const proc = spawn(FFMPEG_BIN, buildDownloadFfmpegArgs(safeFinalUrl, preset), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let headersSent = false;
    let stderrBuf = '';

    proc.on('error', (err) => {
      if (!headersSent && !res.headersSent) {
        res.status(502).json({
          error: err.message || 'Unable to launch FFmpeg download transcoder',
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-400);
    });

    proc.stdout?.once('data', (firstChunk: Buffer) => {
      if (res.closed || res.writableEnded) {
        proc.kill('SIGKILL');
        return;
      }
      headersSent = true;
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      applyStreamCorsHeaders(req, res);
      res.setHeader(
        'Content-Disposition',
        `${isInline ? 'inline' : 'attachment'}; filename="${sanitizeDownloadFilename(rawFilename, 'mp4')}"`,
      );
      res.flushHeaders();
      res.write(firstChunk);
      proc.stdout?.pipe(res);
    });

    proc.on('exit', (code) => {
      if (!headersSent && !res.headersSent) {
        res.status(502).json({
          error: stderrBuf.trim() || `Download stream exited with code ${code ?? 'unknown'}`,
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    res.on('close', () => {
      if (!proc.killed) proc.kill('SIGKILL');
    });
    return;
  }

  const contentType =
    rawCtype && rawCtype !== 'application/octet-stream' ? rawCtype : mimeForExtension(ext);
  const resolvedExt = contentType.includes('mp4')
    ? 'mp4'
    : contentType.includes('matroska')
      ? 'mkv'
      : ext;

  res.status(upstream.status);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  applyStreamCorsHeaders(req, res);
  res.setHeader(
    'Content-Disposition',
    `${isInline ? 'inline' : 'attachment'}; filename="${sanitizeDownloadFilename(rawFilename, resolvedExt)}"`,
  );

  const acceptRanges = upstream.headers.get('accept-ranges');
  const contentRangeHeader = upstream.headers.get('content-range');
  const contentLengthHeader = upstream.headers.get('content-length');
  const crMatchDirect = contentRangeHeader?.match(/bytes\s+\d+-\d+\/(\d+)/i);
  const resolvedDirectTotal =
    crMatchDirect?.[1] ||
    (upstream.status === 200 && contentLengthHeader && contentLengthHeader !== '0'
      ? contentLengthHeader
      : '');
  if (resolvedDirectTotal) {
    res.setHeader('X-Direct-Total-Bytes', resolvedDirectTotal);
  }

  if (req.method === 'HEAD') {
    await upstream.body?.cancel().catch(() => {});
    res.status(200);
    res.setHeader(
      'Accept-Ranges',
      acceptRanges && acceptRanges.toLowerCase() === 'none' ? 'none' : 'bytes',
    );
    if (resolvedDirectTotal) {
      res.setHeader('Content-Length', resolvedDirectTotal);
    }
    res.end();
    return;
  }

  res.setHeader(
    'Accept-Ranges',
    acceptRanges && acceptRanges.toLowerCase() === 'none' ? 'none' : 'bytes',
  );
  if (contentRangeHeader) res.setHeader('Content-Range', contentRangeHeader);
  if (contentLengthHeader) res.setHeader('Content-Length', contentLengthHeader);

  if (!upstream.body) {
    res.end();
    return;
  }

  res.flushHeaders();
  const nodeStream = Readable.fromWeb(upstream.body as never, {
    highWaterMark: 1024 * 1024,
  });

  const cleanup = () => {
    if (!nodeStream.destroyed) nodeStream.destroy();
    if (!res.writableEnded) res.end();
  };

  res.on('close', cleanup);
  nodeStream.on('end', () => {
    if (!res.writableEnded) res.end();
  });
  nodeStream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  nodeStream.pipe(res);
}

export async function handleOfflineDownloadStream(req: Request, res: Response): Promise<void> {
  const mode = String(req.query.mode || '').toLowerCase();
  if (mode === 'file' || req.query.direct === '1' || req.query.direct === 'true') {
    await handleOfflineDirectFileDownload(req, res);
    return;
  }

  const rawKind = String(req.params.kind || '').toLowerCase();
  const kind =
    rawKind === 'series' || rawKind === 'episode'
      ? 'series'
      : rawKind === 'vod' || rawKind === 'movie'
        ? 'movie'
        : null;
  const id = String(req.params.id || '').replace(/\.[a-zA-Z0-9]+$/, '');
  const ext = String(req.query.ext || 'mp4').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
  const rawQuality = String(req.query.quality || '720p').toLowerCase();
  const quality: '360p' | '480p' | '720p' | '1080p' =
    rawQuality === '360p' || rawQuality === '480p' || rawQuality === '1080p' ? rawQuality : '720p';
  const requestProfile: 'standard' | 'turbo' =
    String(req.query.profile || '').toLowerCase() === 'turbo' ? 'turbo' : 'standard';
  const rawJobId = typeof req.query.job === 'string' ? req.query.job.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  const queryOffsetRaw = req.query.offset !== undefined ? Number(req.query.offset) : NaN;
  const queryLenRaw = req.query.len !== undefined ? Number(req.query.len) : NaN;
  const effectiveRangeHeader =
    typeof req.headers.range === 'string'
      ? req.headers.range
      : Number.isFinite(queryOffsetRaw) && queryOffsetRaw >= 0
        ? `bytes=${Math.floor(queryOffsetRaw)}-${
            Math.floor(queryOffsetRaw) +
            Math.min(
              DOWNLOAD_CHUNK_CAP_BYTES,
              Math.max(1, Number.isFinite(queryLenRaw) && queryLenRaw > 0 ? Math.floor(queryLenRaw) : DOWNLOAD_CHUNK_CAP_BYTES),
            ) -
            1
          }`
        : undefined;

  if (!kind || !/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Invalid media download target' });
    return;
  }

  // HEAD probes from Android DownloadManager / native clients: delegate cleanly to direct file probe
  if (req.method === 'HEAD') {
    await handleOfflineDirectFileDownload(req, res);
    return;
  }

  const upstreamUrl = buildUpstreamStreamUrl(kind, id, ext);
  const preset = getDownloadPreset(quality);
  const cachedProbe = probeCache.get(upstreamUrl);
  const queryDurationSec = Math.max(0, Number(req.query.durationSec || 0) || 0);
  const cachedSizeSummary = downloadSizeCache.get(`${kind}:${id}:${ext.toLowerCase()}`);
  const durationSec =
    (cachedProbe && cachedProbe.expiresAt > Date.now() ? cachedProbe.durationSec : 0) ||
    (cachedSizeSummary && cachedSizeSummary.expiresAt > Date.now() ? cachedSizeSummary.durationSec : 0) ||
    queryDurationSec;
  const estimatedTotalBytes =
    durationSec > 0
      ? Math.round(durationSec * preset.estBytesPerSec)
      : cachedSizeSummary && cachedSizeSummary.expiresAt > Date.now()
        ? cachedSizeSummary.sizes[quality]?.bytes || 0
        : 0;

  // Chunked Byte-Range Job Mode (prevents 32 MiB proxy caps, TTFB timeouts, and mobile/WebView 503 drops)
  if (rawJobId || effectiveRangeHeader) {
    const jobId =
      rawJobId || `anon-${kind}-${id}-${quality}-${crypto.randomBytes(6).toString('hex')}`;
    const { start, end: parsedEnd } = parseRequestedByteRange(effectiveRangeHeader);
    const end = Math.min(parsedEnd, start + DOWNLOAD_CHUNK_CAP_BYTES - 1);

    let reqClosed = false;
    res.on('close', () => {
      reqClosed = true;
      const active = downloadJobs.get(jobId);
      if (active) wakeDownloadJobWaiters(active);
    });

    sweepIdleDownloadJobs();
    let job = downloadJobs.get(jobId);

    if (!job) {
      const existingInit = pendingDownloadJobInits.get(jobId);
      if (existingInit) {
        job = (await existingInit) ?? undefined;
        if (reqClosed) return;
      }
    }

    if (!job) {
      if (start > 0) {
        res.status(410).json({ error: 'Download session expired. Retrying from start.' });
        return;
      }

      const initPromise = (async (): Promise<DownloadJob | null> => {
        // Keep paused download jobs intact and run 1 active download job at a time
        const activeNonPaused = Array.from(downloadJobs.entries()).filter(
          ([existingId, existingJob]) => existingId !== jobId && !existingJob.clientPaused,
        );
        const maxActive = 1;
        while (activeNonPaused.length >= maxActive) {
          const evicted = activeNonPaused.shift();
          if (evicted) destroyDownloadJob(evicted[0]);
        }
        // Keep at most 2 paused jobs to conserve temp disk space
        const pausedIds = Array.from(downloadJobs.entries())
          .filter(([id, j]) => id !== jobId && j.clientPaused)
          .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
        while (pausedIds.length > 2) {
          const oldest = pausedIds.shift();
          if (oldest) destroyDownloadJob(oldest[0]);
        }

        await releaseConflictingStreamsForDownload();

        const cachedRedirect = resolvedUrlCache.get(upstreamUrl);
        let inputUrl: string;
        if (cachedRedirect && cachedRedirect.expiresAt > Date.now()) {
          inputUrl = cachedRedirect.finalUrl;
        } else {
          inputUrl = await resolveRedirectedMediaUrl(upstreamUrl).catch(() => upstreamUrl);
          if (inputUrl !== upstreamUrl) {
            await new Promise((r) => setTimeout(r, 120));
          }
        }
        const safeUpstreamUrl = await wrapFfmpegInputUrl(upstreamUrl);
        const safeInputUrl =
          inputUrl !== upstreamUrl ? await wrapFfmpegInputUrl(inputUrl) : safeUpstreamUrl;

        let resolvedDurationSec = durationSec;
        let resolvedEstimatedBytes = estimatedTotalBytes;
        if (resolvedEstimatedBytes <= 0) {
          const quickSize = await resolveDownloadSizeSummary(
            kind,
            id,
            ext,
            queryDurationSec,
            false,
          ).catch(() => null);
          if (quickSize) {
            resolvedDurationSec = quickSize.durationSec || resolvedDurationSec;
            resolvedEstimatedBytes =
              quickSize.sizes[quality]?.bytes ||
              (resolvedDurationSec > 0
                ? Math.round(resolvedDurationSec * preset.estBytesPerSec)
                : 0);
          }
        }

        fs.mkdirSync(DOWNLOAD_JOBS_DIR, { recursive: true });
        const filePath = path.join(DOWNLOAD_JOBS_DIR, `${jobId}.mp4`);
        const fd = fs.openSync(filePath, 'w+');

        const created: DownloadJob = {
          jobId,
          upstreamUrl,
          safeUpstreamUrl,
          quality,
          profile: requestProfile,
          filePath,
          fd,
          proc: null as unknown as ChildProcess,
          totalProduced: 0,
          lastServedOffset: 0,
          eof: false,
          error: null,
          killedByUser: false,
          clientPaused: false,
          sigStopped: false,
          estimatedTotalBytes: resolvedEstimatedBytes,
          durationSec: resolvedDurationSec,
          lastAccessedAt: Date.now(),
          paused: false,
          waiters: new Set(),
        };
        downloadJobs.set(jobId, created);
        attachDownloadProcess(
          created,
          safeInputUrl,
          preset,
          safeInputUrl !== safeUpstreamUrl,
          0,
        );
        return created;
      })().finally(() => {
        pendingDownloadJobInits.delete(jobId);
      });

      pendingDownloadJobInits.set(jobId, initPromise);
      job = (await initPromise) ?? undefined;
      if (reqClosed || !job) return;
    }

    job.lastAccessedAt = Date.now();
    job.profile = requestProfile;
    if (job.clientPaused || job.sigStopped) {
      job.clientPaused = false;
      if (job.sigStopped && job.proc && !job.proc.killed) {
        try {
          job.proc.kill('SIGCONT');
        } catch {
          // ignore
        }
        job.sigStopped = false;
      }
      job.paused = false;
      try {
        job.proc?.stdout?.resume();
      } catch {
        // ignore
      }
    }

    if (start > job.lastServedOffset) {
      job.lastServedOffset = start;
    }
    evaluateDownloadThrottle(job);

    const hasFirstByteOrTerminal = await waitForJobCondition(
      job,
      () =>
        job!.totalProduced > start || job!.eof || job!.error !== null || job!.killedByUser,
      5_500,
      () => reqClosed,
    );

    if (reqClosed) return;

    if (!hasFirstByteOrTerminal && job.totalProduced <= start && !job.eof && !job.error) {
      // Respond cleanly with 202 Accepted before reverse-proxy timeouts so Android WebView/CDNs never treat warmup as 503
      res.setHeader('Retry-After', '1');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Download-Status', 'preparing');
      res.status(202).json({
        status: 'preparing',
        bufferedBytes: job.totalProduced,
        retryable: true,
      });
      return;
    }

    if (job.totalProduced <= start) {
      if (job.error) {
        const msg = job.error;
        destroyDownloadJob(jobId);
        res.status(502).json({ error: msg });
        return;
      }
      if (job.eof) {
        res.status(200);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-store');
        applyStreamCorsHeaders(req, res);
        res.setHeader('X-Download-EOF', '1');
        res.setHeader('X-Download-Total-Bytes', String(job.totalProduced));
        res.setHeader('Content-Length', '0');
        res.end();
        setTimeout(() => destroyDownloadJob(jobId), 3000);
        return;
      }
      res.status(504).json({ error: 'Download stream stalled' });
      return;
    }

    // Short coalesce only when less than 512 KiB is ready so chunks stream immediately without stalling
    const minImmediateBytes = 512 * 1024;
    if (!job.eof && !job.error && job.totalProduced - start < minImmediateBytes) {
      const coalesceTarget = Math.min(end + 1, start + 1024 * 1024);
      await waitForJobCondition(
        job,
        () => job!.totalProduced >= coalesceTarget || job!.eof || job!.error !== null,
        job.profile === 'turbo' ? 120 : 240,
        () => reqClosed,
      );
      if (reqClosed) return;
    }

    const sliceEnd = Math.min(end, job.totalProduced - 1);
    const outBuf = sliceJobBytes(job, start, sliceEnd);
    const isFinalByte = job.eof && sliceEnd === job.totalProduced - 1;
    const totalLabel = job.eof ? String(job.totalProduced) : '*';

    job.lastServedOffset = Math.max(job.lastServedOffset, sliceEnd + 1);
    evaluateDownloadThrottle(job);

    res.status(206);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    applyStreamCorsHeaders(req, res);
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Range', `bytes ${start}-${sliceEnd}/${totalLabel}`);
    res.setHeader('Content-Length', String(outBuf.length));
    res.setHeader('X-Download-EOF', isFinalByte ? '1' : '0');
    if (job.estimatedTotalBytes > 0) {
      res.setHeader('X-Estimated-Total-Bytes', String(job.estimatedTotalBytes));
    }
    if (job.durationSec > 0) {
      res.setHeader('X-Media-Duration-Sec', String(Math.round(job.durationSec)));
    }
    res.send(outBuf);

    if (isFinalByte) {
      setTimeout(() => destroyDownloadJob(jobId), 5000);
    }
    return;
  }

  // Fallback direct unchunked stream: only bypass transcoding when 1080p browser-safe container
  if (quality === '1080p' && (ext === 'mp4' || ext === 'm4v' || ext === 'webm')) {
    await handleOfflineDirectFileDownload(req, res);
    return;
  }

  await releaseConflictingStreamsForDownload();

  const inputUrl = await resolveRedirectedMediaUrl(upstreamUrl).catch(() => upstreamUrl);
  const safeInputUrl = await wrapFfmpegInputUrl(inputUrl);
  const proc = spawn(FFMPEG_BIN, buildDownloadFfmpegArgs(safeInputUrl, preset), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let headersSent = false;
  let stderrBuf = '';

  proc.on('error', (err) => {
    if (!headersSent && !res.headersSent) {
      res.status(502).json({
        error: err.message || 'Unable to launch FFmpeg offline download transcoder',
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-400);
  });

  proc.stdout?.once('data', (firstChunk: Buffer) => {
    if (res.closed || res.writableEnded) {
      proc.kill('SIGKILL');
      return;
    }
    headersSent = true;
    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    applyStreamCorsHeaders(req, res);
    if (estimatedTotalBytes > 0) {
      res.setHeader('X-Estimated-Total-Bytes', String(estimatedTotalBytes));
    }
    if (durationSec > 0) {
      res.setHeader('X-Media-Duration-Sec', String(Math.round(durationSec)));
    }
    res.flushHeaders();
    res.write(firstChunk);
    proc.stdout?.pipe(res);
  });

  proc.on('exit', (code) => {
    if (!headersSent && !res.headersSent) {
      res.status(502).json({
        error: stderrBuf.trim() || `Download transcode exited with code ${code ?? 'unknown'}`,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  res.on('close', () => {
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  });
}

export async function handleCatchupPlay(req: Request, res: Response): Promise<void> {
  const rawParam = String(req.params.streamId || '').replace(/\.(ts|m3u8)$/i, '');
  if (!/^\d+$/.test(rawParam)) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  const startTs = Number(req.query.startTs || 0);
  const durationMin = Number(req.query.duration || 60);
  if (!startTs || !Number.isFinite(startTs)) {
    res.status(400).json({ error: 'Missing startTs parameter' });
    return;
  }

  const d = new Date(startTs * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const startFormatted = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;

  const upstreamUrl = buildCatchupUrl(rawParam, durationMin, startFormatted);
  await pipeLiveStream(upstreamUrl, req, res, 'ts');
}


export async function handleHlsTokenProxy(
  req: Request,
  res: Response,
): Promise<void> {
  const token = typeof req.query.token === 'string'
    ? req.query.token
    : '';

  const entry = hlsTokenMap.get(token);

  if (!entry || entry.expiresAt <= Date.now()) {
    hlsTokenMap.delete(token);
    res.status(404).send('Expired or invalid stream token');
    return;
  }

  await proxyHlsResource(entry.url, req, res);
}


async function proxyHlsResource(
  targetUrl: string,
  req: Request,
  res: Response,
): Promise<void> {
  const controller = new AbortController();

  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  res.on('close', abort);

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
    };

    if (req.headers.range) {
      headers.Range = String(req.headers.range);
    }

    const upstream = await fetch(targetUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      if (!res.headersSent && !res.writableEnded) {
        res.status(upstream.status).send('Unable to load HLS resource');
      }
      return;
    }

    const finalUrl = upstream.url || targetUrl;
    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist =
      finalUrl.toLowerCase().includes('.m3u8') ||
      contentType.toLowerCase().includes('mpegurl');

    if (isPlaylist) {
      const playlist = req.method === 'HEAD' ? '' : await upstream.text();
      if (req.method === 'HEAD') {
        await upstream.body?.cancel().catch(() => {});
      }

      if (controller.signal.aborted || res.writableEnded) return;

      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      applyStreamCorsHeaders(req, res);

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const rewritten = rewritePlaylist(playlist, finalUrl);
      res.send(rewritten);
      return;
    }

    // Do not treat VTT, subtitle files, or other HLS resources as TS.
    res.status(upstream.status);
    res.setHeader(
      'Content-Type',
      contentType || 'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'no-store');
    applyStreamCorsHeaders(req, res);
    res.setHeader('X-Accel-Buffering', 'no');

    const contentRange = upstream.headers.get('content-range');
    const contentLength = upstream.headers.get('content-length');
    const acceptRanges = upstream.headers.get('accept-ranges');

    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    res.setHeader(
      'Accept-Ranges',
      acceptRanges && acceptRanges.toLowerCase() === 'none' ? 'none' : 'bytes',
    );

    if (req.method === 'HEAD' || !upstream.body) {
      await upstream.body?.cancel().catch(() => {});
      res.end();
      return;
    }

    res.flushHeaders();

    const nodeStream = Readable.fromWeb(upstream.body as never);

    const cleanup = () => {
      if (!nodeStream.destroyed) {
        nodeStream.destroy();
      }
    };

    controller.signal.addEventListener('abort', cleanup, { once: true });
    res.on('close', cleanup);

    nodeStream.on('error', () => {
      if (!res.writableEnded) res.end();
    });

    nodeStream.pipe(res);
  } catch (err) {
    if (controller.signal.aborted || res.writableEnded) return;

    if (!res.headersSent) {
      res.status(502).send('Unable to proxy HLS resource');
    } else {
      res.end();
    }
  } finally {
    res.off('close', abort);
  }
}

// =============================================================================
// Backend Pre-Buffered HLS Streaming Sessions (360p / 480p / 720p / 1080p)
// =============================================================================

export type StreamQualityPreset = '360p' | '480p' | '720p' | '1080p';

interface HlsStreamSession {
  sessionId: string;
  dir: string;
  playlistPath: string;
  upstreamUrl: string;
  kind: 'movie' | 'series' | 'live' | 'catchup';
  quality: StreamQualityPreset;
  startOffsetSec: number;
  durationSec: number;
  proc: ChildProcess;
  stoppedByThrottle: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  killed: boolean;
  stderrTail: string;
  lastAccessedAt: number;
  lastRequestedSeg: number;
  highestSeenSeg: number;
  throttleTimer: NodeJS.Timeout | null;
}

const HLS_BASE_DIR = path.join(os.tmpdir(), 'cinebox-hls');
const HLS_SESSION_IDLE_TTL_MS = 120_000;
const hlsSessions = new Map<string, HlsStreamSession>();

// Clean any leftover temp directories from previous server runs
try {
  fs.rmSync(HLS_BASE_DIR, { recursive: true, force: true });
} catch {
  // ignore
}

function getStreamQualitySpec(quality: StreamQualityPreset) {
  switch (quality) {
    case '360p':
      return {
        scale: "scale=-2:'min(360,trunc(ih/2)*2)',setsar=1,format=yuv420p",
        crf: '28',
        maxrate: '750k',
        bufsize: '1500k',
        audioBitrate: '96k',
        profile: 'baseline',
        level: '3.0',
        preset: 'ultrafast',
      };
    case '480p':
      return {
        scale: "scale=-2:'min(480,trunc(ih/2)*2)',setsar=1,format=yuv420p",
        crf: '26',
        maxrate: '1250k',
        bufsize: '2500k',
        audioBitrate: '128k',
        profile: 'baseline',
        level: '3.0',
        preset: 'ultrafast',
      };
    case '1080p':
      return {
        scale: "scale=-2:'min(1080,trunc(ih/2)*2)',setsar=1,format=yuv420p",
        crf: '22',
        maxrate: '4500k',
        bufsize: '9000k',
        audioBitrate: '192k',
        profile: 'main',
        level: '4.0',
        preset: 'ultrafast',
      };
    case '720p':
    default:
      return {
        scale: "scale=-2:'min(720,trunc(ih/2)*2)',setsar=1,format=yuv420p",
        crf: '24',
        maxrate: '2400k',
        bufsize: '4800k',
        audioBitrate: '128k',
        profile: 'main',
        level: '3.1',
        preset: 'ultrafast',
      };
  }
}

function destroyHlsSession(sessionId: string): void {
  const session = hlsSessions.get(sessionId);
  if (!session) return;
  hlsSessions.delete(sessionId);
  session.killed = true;
  if (session.throttleTimer) {
    clearInterval(session.throttleTimer);
    session.throttleTimer = null;
  }
  if (!session.exited && !session.proc.killed) {
    try {
      session.proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  try {
    fs.rmSync(session.dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function destroyAllHlsSessions(exceptId?: string): void {
  for (const id of Array.from(hlsSessions.keys())) {
    if (id !== exceptId) {
      destroyHlsSession(id);
    }
  }
}

function sweepIdleHlsSessions(): void {
  const now = Date.now();
  for (const [id, session] of hlsSessions.entries()) {
    if (now - session.lastAccessedAt > HLS_SESSION_IDLE_TTL_MS) {
      destroyHlsSession(id);
    }
  }
}

const hlsSessionSweepTimer = setInterval(sweepIdleHlsSessions, 15_000);
hlsSessionSweepTimer.unref?.();

function parsePlaylistCommittedSegments(playlistText: string): {
  segments: string[];
  ended: boolean;
  highestSegNum: number;
} {
  const segments: string[] = [];
  let highestSegNum = -1;
  const ended = playlistText.includes('#EXT-X-ENDLIST');
  for (const line of playlistText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    segments.push(trimmed);
    const m = trimmed.match(/seg_(\d+)\.ts/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > highestSegNum) highestSegNum = n;
    }
  }
  return { segments, ended, highestSegNum };
}

function evaluateSessionThrottle(session: HlsStreamSession): void {
  if (session.killed || session.exited) return;
  if (session.kind === 'live' || session.kind === 'catchup') return;
  try {
    if (!fs.existsSync(session.playlistPath)) return;
    const text = fs.readFileSync(session.playlistPath, 'utf8');
    const { highestSegNum } = parsePlaylistCommittedSegments(text);
    if (highestSegNum >= 0) {
      session.highestSeenSeg = highestSegNum;
    }
    // Never SIGSTOP ffmpeg mid-VOD read: upstream IPTV CDNs close idle TCP sockets, causing EOF stalls
  } catch {
    // ignore
  }
}

function buildHlsFfmpegArgs(params: {
  inputUrl: string;
  isLiveOrCatchup: boolean;
  startSec: number;
  safeAudioIdx: number;
  quality: StreamQualityPreset;
  spec: ReturnType<typeof getStreamQualitySpec>;
  segPattern: string;
  playlistPath: string;
}): string[] {
  const { inputUrl, isLiveOrCatchup, startSec, safeAudioIdx, quality, spec, segPattern, playlistPath } = params;
  const args: string[] = [
    '-v',
    'error',
    '-fflags',
    '+genpts+discardcorrupt',
    '-probesize',
    '350000',
    '-analyzeduration',
    '350000',
    '-rw_timeout',
    '12000000',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '3',
    '-user_agent',
    'VLC/3.0.18 LibVLC/3.0.18',
  ];

  if (startSec > 0 && !isLiveOrCatchup) {
    args.push('-ss', String(startSec));
  }

  args.push(
    '-i',
    inputUrl,
    '-map',
    '0:v:0',
    '-map',
    `0:a:${safeAudioIdx}?`,
    '-sn',
    '-vf',
    spec.scale,
    '-c:v',
    'libx264',
    '-profile:v',
    spec.profile,
    '-level:v',
    spec.level,
    '-threads',
    quality === '1080p' ? '3' : '2',
    '-preset',
    spec.preset,
    '-tune',
    'zerolatency',
    '-crf',
    spec.crf,
    '-maxrate',
    spec.maxrate,
    '-bufsize',
    spec.bufsize,
    '-g',
    '30',
    '-keyint_min',
    '30',
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-b:a',
    spec.audioBitrate,
    '-avoid_negative_ts',
    'make_zero',
    '-max_muxing_queue_size',
    '1024',
    '-f',
    'hls',
    '-hls_time',
    '1',
  );

  if (isLiveOrCatchup) {
    args.push(
      '-hls_list_size',
      '10',
      '-hls_flags',
      'temp_file+delete_segments+independent_segments',
    );
  } else {
    args.push(
      '-hls_list_size',
      '0',
      '-hls_playlist_type',
      'event',
      '-hls_flags',
      'temp_file+independent_segments',
    );
  }

  args.push('-hls_segment_filename', segPattern, playlistPath);
  return args;
}

async function startHlsSessionInternal(
  req: Request,
  res: Response,
  params: {
    rawKind: string;
    id: string;
    ext: string;
    rawQuality: string;
    startSec: number;
    audioIdx: number;
    hintDurationSec: number;
    startTs: number;
    durationMin: number;
  },
): Promise<void> {
  const rawKind = params.rawKind.toLowerCase();
  const kind: 'movie' | 'series' | 'live' | 'catchup' | null =
    rawKind === 'series' || rawKind === 'episode'
      ? 'series'
      : rawKind === 'vod' || rawKind === 'movie'
        ? 'movie'
        : rawKind === 'live'
          ? 'live'
          : rawKind === 'catchup'
            ? 'catchup'
            : null;
  const id = params.id.replace(/\.[a-zA-Z0-9]+$/, '');
  const ext =
    (params.ext || (kind === 'live' || kind === 'catchup' ? 'ts' : 'mp4')).replace(
      /[^a-zA-Z0-9]/g,
      '',
    ) || 'mp4';
  const rawQuality = params.rawQuality.toLowerCase();
  const quality: StreamQualityPreset =
    rawQuality === '360p' ||
    rawQuality === '480p' ||
    rawQuality === '720p' ||
    rawQuality === '1080p'
      ? rawQuality
      : '720p';
  const startSec = Math.max(0, Math.floor(params.startSec || 0));
  const audioIdx = Math.max(0, Math.floor(params.audioIdx || 0));
  const hintDurationSec = Math.max(0, Number(params.hintDurationSec || 0) || 0);

  if (!kind || !/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Invalid media target' });
    return;
  }

  let upstreamUrl: string;
  if (kind === 'catchup') {
    const startTs = Number(params.startTs || 0);
    const durationMin = Number(params.durationMin || 60);
    if (!startTs || !Number.isFinite(startTs)) {
      res.status(400).json({ error: 'Missing startTs parameter' });
      return;
    }
    const d = new Date(startTs * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const startFormatted = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate(),
    )}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
    upstreamUrl = buildCatchupUrl(id, durationMin, startFormatted);
  } else {
    upstreamUrl = buildUpstreamStreamUrl(kind, id, ext);
  }

  // Check if a preloaded / active HLS session already matches this exact stream, quality, and start offset
  for (const existing of hlsSessions.values()) {
    if (
      !existing.killed &&
      existing.upstreamUrl === upstreamUrl &&
      existing.quality === quality &&
      existing.startOffsetSec === (kind === 'live' || kind === 'catchup' ? 0 : startSec) &&
      Date.now() - existing.lastAccessedAt < 25_000 &&
      fs.existsSync(existing.playlistPath)
    ) {
      try {
        const text = fs.readFileSync(existing.playlistPath, 'utf8');
        const parsedExisting = parsePlaylistCommittedSegments(text);
        if (parsedExisting.segments.length >= 1) {
          existing.lastAccessedAt = Date.now();
          res.setHeader('Cache-Control', 'no-store');
          res.json({
            sessionId: existing.sessionId,
            playlistUrl: `/api/play/hls-session/${existing.sessionId}/playlist.m3u8`,
            quality,
            startOffsetSec: existing.startOffsetSec,
            durationSec: existing.durationSec || hintDurationSec,
            bufferedSegments: parsedExisting.segments.length,
            reusedPreload: true,
          });
          return;
        }
      } catch {
        // fall through to fresh creation
      }
    }
  }

  // Release any previous active connections cleanly so single-connection IPTV servers never collide
  destroyAllHlsSessions();
  killActiveTranscode();
  await releaseActiveVodConnections();
  await releaseActiveLiveConnection();

  const isLiveOrCatchup = kind === 'live' || kind === 'catchup';
  let durationSec = hintDurationSec;
  let safeAudioIdx = audioIdx;

  if (!isLiveOrCatchup) {
    const cachedProbe = probeCache.get(upstreamUrl);
    const cachedSize = downloadSizeCache.get(`${kind}:${id}:${ext.toLowerCase()}`);
    if (cachedProbe && cachedProbe.expiresAt > Date.now()) {
      durationSec = cachedProbe.durationSec || durationSec;
      if (cachedProbe.audioTracks.length > 0 && safeAudioIdx >= cachedProbe.audioTracks.length) {
        safeAudioIdx = 0;
      }
    } else if (safeAudioIdx > 0) {
      // Only spend time probing before ffmpeg if user explicitly picked an alternate audio track
      const probed = await probeMediaCodecs(upstreamUrl).catch(() => null);
      if (probed) {
        durationSec = probed.durationSec || durationSec;
        if (probed.audioTracks.length > 0 && safeAudioIdx >= probed.audioTracks.length) {
          safeAudioIdx = 0;
        }
      }
    } else if (cachedSize && cachedSize.expiresAt > Date.now() && cachedSize.durationSec > 0) {
      durationSec = cachedSize.durationSec;
    }
  }

  // Use warm redirect target if cached; otherwise let loopback proxy follow redirects cleanly
  const cachedRedirect = resolvedUrlCache.get(upstreamUrl);
  const resolvedInputUrl =
    cachedRedirect && cachedRedirect.expiresAt > Date.now()
      ? cachedRedirect.finalUrl
      : upstreamUrl;
  const safeUpstreamUrl = await wrapFfmpegInputUrl(upstreamUrl);
  const safeResolvedInputUrl =
    resolvedInputUrl !== upstreamUrl
      ? await wrapFfmpegInputUrl(resolvedInputUrl)
      : safeUpstreamUrl;

  const sessionId = crypto.randomBytes(8).toString('hex');
  const dir = path.join(HLS_BASE_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const playlistPath = path.join(dir, 'playlist.m3u8');
  const segPattern = path.join(dir, 'seg_%05d.ts');
  const spec = getStreamQualitySpec(quality);

  const session: HlsStreamSession = {
    sessionId,
    dir,
    playlistPath,
    upstreamUrl,
    kind,
    quality,
    startOffsetSec: isLiveOrCatchup ? 0 : startSec,
    durationSec,
    proc: null as unknown as ChildProcess,
    stoppedByThrottle: false,
    exited: false,
    exitCode: null,
    exitSignal: null,
    killed: false,
    stderrTail: '',
    lastAccessedAt: Date.now(),
    lastRequestedSeg: 0,
    highestSeenSeg: 0,
    throttleTimer: null,
  };

  hlsSessions.set(sessionId, session);

  const spawnForUrl = (urlToPlay: string) => {
    session.exited = false;
    session.exitCode = null;
    session.exitSignal = null;
    session.stderrTail = '';
    const args = buildHlsFfmpegArgs({
      inputUrl: urlToPlay,
      isLiveOrCatchup,
      startSec,
      safeAudioIdx,
      quality,
      spec,
      segPattern,
      playlistPath,
    });
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    session.proc = proc;
    proc.on('error', (err) => {
      if (session.proc !== proc) return;
      session.stderrTail = `${session.stderrTail}\n${err.message || 'Unable to launch FFmpeg'}`.slice(-500);
      session.exited = true;
      session.exitCode = -1;
      if (session.throttleTimer) {
        clearInterval(session.throttleTimer);
        session.throttleTimer = null;
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      session.stderrTail = (session.stderrTail + chunk.toString('utf8')).slice(-500);
    });
    proc.on('exit', (code, signal) => {
      if (session.proc !== proc) return;
      session.exited = true;
      session.exitCode = code;
      session.exitSignal = signal;
      if (session.throttleTimer) {
        clearInterval(session.throttleTimer);
        session.throttleTimer = null;
      }
    });
  };

  spawnForUrl(safeResolvedInputUrl);

  if (!isLiveOrCatchup) {
    session.throttleTimer = setInterval(() => {
      evaluateSessionThrottle(session);
    }, 2500);
    session.throttleTimer.unref?.();
  }

  let abortedByCaller = false;
  req.on('close', () => {
    // Only destroy if response wasn't sent yet (caller cancelled creation)
    if (!res.headersSent) {
      abortedByCaller = true;
      destroyHlsSession(sessionId);
    }
  });

  // Pre-buffer the first 1s segment before returning playlist URL to player for minimum TTFB
  const targetReadySegments = 1;
  let retriedFreshUpstream = false;
  const deadline = Date.now() + 14_000;
  let readySegments = 0;

  while (!abortedByCaller && !session.killed && Date.now() < deadline) {
    if (fs.existsSync(playlistPath)) {
      try {
        const text = fs.readFileSync(playlistPath, 'utf8');
        const parsed = parsePlaylistCommittedSegments(text);
        readySegments = parsed.segments.length;
        if (readySegments >= targetReadySegments || (parsed.ended && readySegments >= 1)) {
          break;
        }
      } catch {
        // ignore transient read
      }
    }
    if (session.exited) {
      if (readySegments >= 1) break;
      if (!retriedFreshUpstream && safeResolvedInputUrl !== safeUpstreamUrl) {
        retriedFreshUpstream = true;
        resolvedUrlCache.delete(upstreamUrl);
        spawnForUrl(safeUpstreamUrl);
        continue;
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  if (abortedByCaller || session.killed) return;

  if (readySegments === 0) {
    const errMsg =
      session.stderrTail.trim() ||
      `Unable to pre-buffer stream (${session.exitSignal ?? session.exitCode ?? 'timeout'})`;
    destroyHlsSession(sessionId);
    if (!res.headersSent) {
      res.status(502).json({ error: errMsg });
    }
    return;
  }

  session.lastAccessedAt = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    sessionId,
    playlistUrl: `/api/play/hls-session/${sessionId}/playlist.m3u8`,
    quality,
    startOffsetSec: session.startOffsetSec,
    durationSec: session.durationSec,
    bufferedSegments: readySegments,
  });
}

export async function handleCreateHlsSession(req: Request, res: Response): Promise<void> {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  await startHlsSessionInternal(req, res, {
    rawKind: String(body.kind || ''),
    id: String(body.id || ''),
    ext: String(body.ext || ''),
    rawQuality: String(body.quality || '720p'),
    startSec: Number(body.startSec || 0) || 0,
    audioIdx: Number(body.audio || 0) || 0,
    hintDurationSec: Number(body.durationSec || 0) || 0,
    startTs: Number(body.startTs || 0) || 0,
    durationMin: Number(body.duration || 60) || 60,
  });
}

export async function handleStartHlsSessionGet(req: Request, res: Response): Promise<void> {
  await startHlsSessionInternal(req, res, {
    rawKind: String(req.params.kind || ''),
    id: String(req.params.id || ''),
    ext: String(req.query.ext || ''),
    rawQuality: String(req.query.quality || '720p'),
    startSec: Number(req.query.startSec || req.query.start || 0) || 0,
    audioIdx: Number(req.query.audio || 0) || 0,
    hintDurationSec: Number(req.query.durationSec || 0) || 0,
    startTs: Number(req.query.startTs || 0) || 0,
    durationMin: Number(req.query.duration || 60) || 60,
  });
}

export async function handleHlsSessionPlaylist(req: Request, res: Response): Promise<void> {
  const sessionId = String(req.params.sessionId || '').replace(/[^a-f0-9]/gi, '');
  const session = hlsSessions.get(sessionId);
  if (!session || session.killed || !fs.existsSync(session.playlistPath)) {
    res.status(404).send('HLS session not found or expired');
    return;
  }

  session.lastAccessedAt = Date.now();
  evaluateSessionThrottle(session);

  try {
    const playlist = fs.readFileSync(session.playlistPath, 'utf8');
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    applyStreamCorsHeaders(req, res);
    res.setHeader('Content-Length', String(Buffer.byteLength(playlist)));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.send(playlist);
  } catch {
    res.status(502).send('Unable to read HLS playlist');
  }
}

export async function handleHlsSessionSegment(req: Request, res: Response): Promise<void> {
  const sessionId = String(req.params.sessionId || '').replace(/[^a-f0-9]/gi, '');
  const segment = String(req.params.segment || '');
  if (!/^seg_\d+\.ts$/.test(segment)) {
    res.status(400).send('Invalid segment name');
    return;
  }

  const session = hlsSessions.get(sessionId);
  if (!session || session.killed) {
    res.status(404).send('HLS session expired');
    return;
  }

  session.lastAccessedAt = Date.now();
  const segMatch = segment.match(/^seg_(\d+)\.ts$/);
  if (segMatch) {
    const segNum = Number(segMatch[1]);
    if (Number.isFinite(segNum) && segNum > session.lastRequestedSeg) {
      session.lastRequestedSeg = segNum;
    }
  }
  evaluateSessionThrottle(session);

  const filePath = path.join(session.dir, segment);
  if (!fs.existsSync(filePath) && !session.exited && !session.killed) {
    const waitDeadline = Date.now() + 900;
    while (!fs.existsSync(filePath) && !session.exited && !session.killed && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  if (!fs.existsSync(filePath)) {
    res.status(404).send('Segment not found');
    return;
  }

  res.setHeader('Content-Type', 'video/mp2t');
  applyStreamCorsHeaders(req, res);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Cache-Control',
    session.kind === 'live' || session.kind === 'catchup'
      ? 'no-store'
      : 'private, max-age=180',
  );
  res.sendFile(filePath);
}

export async function handleCloseHlsSession(req: Request, res: Response): Promise<void> {
  const sessionId = String(req.params.sessionId || '').replace(/[^a-f0-9]/gi, '');
  if (sessionId) {
    destroyHlsSession(sessionId);
  }
  res.json({ ok: true });
}

export async function handlePreloadStream(req: Request, res: Response): Promise<void> {
  const rawKind = String(req.params.kind || '').toLowerCase();
  const kind: 'movie' | 'series' | 'live' | null =
    rawKind === 'series' || rawKind === 'episode'
      ? 'series'
      : rawKind === 'vod' || rawKind === 'movie'
        ? 'movie'
        : rawKind === 'live'
          ? 'live'
          : null;
  const id = String(req.params.id || '').replace(/\.[a-zA-Z0-9]+$/, '');
  const ext = String(req.query.ext || (kind === 'live' ? 'ts' : 'mp4')).replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
  const qualityRaw = String(req.query.quality || 'auto').toLowerCase();

  if (!kind || !/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Invalid preload target' });
    return;
  }

  const upstreamUrl = buildUpstreamStreamUrl(kind, id, ext);

  // If another playback stream is actively occupying single-connection upstream bandwidth, skip intrusive preload
  if (isUpstreamStreamBusy()) {
    res.json({ ok: true, skipped: 'busy' });
    return;
  }

  // Direct stream preload: warm redirect + first 8 MiB chunk into RAM cache
  if (qualityRaw === 'auto' || kind === 'live') {
    if (!lookupVodChunk(upstreamUrl, 0) && kind !== 'live') {
      scheduleVodPrefetch(upstreamUrl, 0, null, ext, 1);
    } else {
      void resolveRedirectedMediaUrl(upstreamUrl).catch(() => upstreamUrl);
    }
    res.json({ ok: true, mode: 'direct', preloading: true });
    return;
  }

  // Quality preset preload: kick off HLS session creation if no active session exists yet
  const preset: StreamQualityPreset =
    qualityRaw === '360p' || qualityRaw === '480p' || qualityRaw === '720p' || qualityRaw === '1080p'
      ? qualityRaw
      : '720p';
  const startSec = Math.max(0, Math.floor(Number(req.query.startSec || req.query.start || 0) || 0));

  for (const existing of hlsSessions.values()) {
    if (
      !existing.killed &&
      existing.upstreamUrl === upstreamUrl &&
      existing.quality === preset &&
      existing.startOffsetSec === startSec
    ) {
      res.json({
        ok: true,
        mode: 'hls',
        sessionId: existing.sessionId,
        playlistUrl: `/api/play/hls-session/${existing.sessionId}/playlist.m3u8`,
        reused: true,
      });
      return;
    }
  }

  // Fire background HLS session warmup without blocking caller
  const sessionId = crypto.randomBytes(8).toString('hex');
  const dir = path.join(HLS_BASE_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const playlistPath = path.join(dir, 'playlist.m3u8');
  const segPattern = path.join(dir, 'seg_%05d.ts');
  const spec = getStreamQualitySpec(preset);
  const cachedRedirect = resolvedUrlCache.get(upstreamUrl);
  const resolvedInput =
    cachedRedirect && cachedRedirect.expiresAt > Date.now() ? cachedRedirect.finalUrl : upstreamUrl;
  const safeResolvedInput = await wrapFfmpegInputUrl(resolvedInput);

  const session: HlsStreamSession = {
    sessionId,
    dir,
    playlistPath,
    upstreamUrl,
    kind,
    quality: preset,
    startOffsetSec: startSec,
    durationSec: Math.max(0, Number(req.query.durationSec || 0) || 0),
    proc: null as unknown as ChildProcess,
    stoppedByThrottle: false,
    exited: false,
    exitCode: null,
    exitSignal: null,
    killed: false,
    stderrTail: '',
    lastAccessedAt: Date.now(),
    lastRequestedSeg: 0,
    highestSeenSeg: 0,
    throttleTimer: null,
  };
  hlsSessions.set(sessionId, session);

  const args = buildHlsFfmpegArgs({
    inputUrl: safeResolvedInput,
    isLiveOrCatchup: false,
    startSec,
    safeAudioIdx: 0,
    quality: preset,
    spec,
    segPattern,
    playlistPath,
  });
  const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  session.proc = proc;
  proc.on('error', (err) => {
    if (session.proc !== proc) return;
    session.stderrTail = `${session.stderrTail}\n${err.message || 'Unable to launch FFmpeg'}`.slice(-500);
    session.exited = true;
    session.exitCode = -1;
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    session.stderrTail = (session.stderrTail + chunk.toString('utf8')).slice(-500);
  });
  proc.on('exit', (code, signal) => {
    if (session.proc !== proc) return;
    session.exited = true;
    session.exitCode = code;
    session.exitSignal = signal;
  });

  res.json({
    ok: true,
    mode: 'hls',
    sessionId,
    playlistUrl: `/api/play/hls-session/${sessionId}/playlist.m3u8`,
  });
}


