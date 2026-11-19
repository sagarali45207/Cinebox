import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  FastForward,
  Languages,
  ListVideo,
  Lock,
  Maximize,
  Minimize,
  Minus,
  Pause,
  PictureInPicture2,
  Play,
  Plus,
  Radio,
  Ratio,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Settings2,
  Subtitles,
  Sun,
  Trash2,
  Unlock,
  Upload,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  isAndroidPlatform,
  launchAndroidExternalPlayerIntent,
  type ExternalAndroidPlayerTarget,
} from '../plugins/NativeDownloader';
import {
  fetchMediaLanguages,
  fetchStreamVariants,
  fetchSubtitles,
  preloadStreamMedia,
} from '../services/api';
import { createOfflineBlobPlaybackUrl } from '../utils/offlineDb';
import type {
  ActivePlayback,
  AspectRatioMode,
  EpisodeSummary,
  MediaLanguagesResponse,
  StreamVariantsResponse,
  SubtitleTrack,
  VideoQualityOption,
} from '../types/media';
import { formatNumber, formatPlaybackTime, proxiedImageUrl } from '../utils/format';
import { useAppSettings, type SubtitleLanguagePref } from '../utils/settings';
import {
  buildSubtitleStreamKey,
  convertClientSrtOrVttToVtt,
  getDownloadedSubtitle,
  getDownloadedSubtitlesForStream,
  getPreferredActiveSubtitleId,
  removeDownloadedSubtitle,
  saveDownloadedSubtitle,
  setPreferredActiveSubtitleId,
  updateDownloadedSubtitleOffset,
  type DownloadedSubtitleRecord,
} from '../utils/subtitleCache';
import { LoadingSpinner } from './LoadingSpinner';

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

function pickPreferredSubtitleTrack(
  subs: SubtitleTrack[],
  pref: SubtitleLanguagePref,
): SubtitleTrack | null {
  if (subs.length === 0 || pref === 'off') return null;
  if (pref === 'auto') {
    return subs.find((s) => s.language.toLowerCase() === 'english') || subs[0];
  }
  const targetLower = pref.toLowerCase();
  return (
    subs.find(
      (s) =>
        s.language.toLowerCase() === targetLower ||
        s.label.toLowerCase().includes(targetLower),
    ) || subs[0]
  );
}

const ASPECT_RATIO_OPTIONS: Array<{
  id: AspectRatioMode;
  label: string;
  shortLabel: string;
  desc: string;
}> = [
  { id: 'fit', label: 'Fit (Original)', shortLabel: 'Fit', desc: 'Original aspect ratio' },
  { id: 'fill', label: 'Fill (Crop)', shortLabel: 'Fill', desc: 'Edge-to-edge full frame' },
  { id: 'stretch', label: 'Stretch', shortLabel: 'Stretch', desc: 'Stretch to fill screen' },
  { id: '16:9', label: '16:9 Widescreen', shortLabel: '16:9', desc: 'Standard HD frame' },
  { id: '4:3', label: '4:3 Classic', shortLabel: '4:3', desc: 'Classic TV proportion' },
  { id: '21:9', label: '21:9 Cinema', shortLabel: '21:9', desc: 'Ultrawide theatrical' },
];

const VIDEO_QUALITY_OPTIONS: Array<{
  id: VideoQualityOption;
  label: string;
  shortLabel: string;
  desc: string;
}> = [
  { id: 'auto', label: 'Auto (Direct)', shortLabel: 'Auto', desc: 'Original · Adaptive stream' },
  { id: '1080p', label: '1080p Full HD', shortLabel: '1080p', desc: '4.5 Mbps · High definition' },
  { id: '720p', label: '720p HD', shortLabel: '720p', desc: '2.4 Mbps · Balanced HD' },
  { id: '480p', label: '480p SD', shortLabel: '480p', desc: '1.2 Mbps · Fast start' },
  { id: '360p', label: '360p Data Saver', shortLabel: '360p', desc: '750 Kbps · Low bandwidth' },
];

function inferExternalMimeType(ext?: string, url?: string): string {
  const cleanExt = (ext || '').toLowerCase().replace(/^\./, '');
  const u = (url || '').toLowerCase();
  if (cleanExt === 'm3u8' || u.includes('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (cleanExt === 'mkv' || u.includes('.mkv')) return 'video/x-matroska';
  if (cleanExt === 'ts' || u.includes('.ts')) return 'video/mp2t';
  if (cleanExt === 'webm' || u.includes('.webm')) return 'video/webm';
  if (cleanExt === 'avi' || u.includes('.avi')) return 'video/x-msvideo';
  return 'video/mp4';
}

function buildAbsoluteExternalStreamUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('blob:') || rawUrl.startsWith('capacitor:') || rawUrl.startsWith('/__offline_media__/')) {
    return '';
  }
  if (/^https?:\/\//i.test(rawUrl) || rawUrl.startsWith('file://') || rawUrl.startsWith('content://')) {
    return rawUrl;
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(rawUrl, window.location.origin).toString();
  }
  return rawUrl;
}

interface EmbeddedPlayerProps {
  playback: ActivePlayback;
  isActive?: boolean;
  autoPlay?: boolean;
  onProgress: (currentTime: number, duration: number) => void;
  onTimeTick?: (currentTime: number) => void;
  onSelectEpisode?: (episode: EpisodeSummary) => void;
  onSwitchPlayback?: (nextPlayback: ActivePlayback) => void;
  onLanguagesResolved?: (data: MediaLanguagesResponse | null) => void;
  onReturnToLive?: () => void;
}

function parseVttCues(vttText: string): SubtitleCue[] {
  const lines = vttText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const cues: SubtitleCue[] = [];
  let i = 0;

  function parseTime(tStr: string): number {
    const clean = tStr.trim().replace(',', '.');
    const parts = clean.split(':');
    if (parts.length === 3) {
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      const s = Number(parts[2]);
      return Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)
        ? h * 3600 + m * 60 + s
        : 0;
    }
    if (parts.length === 2) {
      const m = Number(parts[0]);
      const s = Number(parts[1]);
      return Number.isFinite(m) && Number.isFinite(s) ? m * 60 + s : 0;
    }
    return 0;
  }

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      const [startStr, rest] = line.split('-->');
      const endToken = (rest || '').trim().split(/\s+/)[0] || '';
      const start = parseTime(startStr);
      const end = parseTime(endToken);
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        // Strip VTT/HTML tags and ASS braces
        const cleanLine = lines[i]
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/<[^>]*>/g, '')
          .trim();
        if (cleanLine) textLines.push(cleanLine);
        i++;
      }
      if (textLines.length > 0 && end > start) {
        cues.push({ start, end, text: textLines.join('\n') });
      }
    } else {
      i++;
    }
  }

  return cues;
}

function findActiveSubtitleCueText(
  cues: SubtitleCue[],
  videoTimeSec: number,
  offsetSec: number,
): string {
  if (cues.length === 0) return '';
  // Positive offset delays subtitles ("+0.5s Later"), so lookup time in cue timeline shifts earlier
  const lookupTime = videoTimeSec - offsetSec;
  const active = cues.filter((c) => lookupTime >= c.start && lookupTime <= c.end);
  if (active.length === 0) return '';
  return active.map((c) => c.text).join('\n');
}

export function EmbeddedPlayer({
  playback,
  isActive = true,
  autoPlay = true,
  onProgress,
  onTimeTick,
  onSelectEpisode,
  onSwitchPlayback,
  onLanguagesResolved,
  onReturnToLive,
}: EmbeddedPlayerProps) {
  const { settings } = useAppSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  const subtitlePrefAppliedKeyRef = useRef('');

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<mpegts.Player | null>(null);

  useEffect(() => {
    if (!isActive) {
      const video = videoRef.current;
      if (video && !video.paused) {
        try {
          video.pause();
        } catch {
          // ignore
        }
      }
      if (mpegtsRef.current) {
        try {
          mpegtsRef.current.pause();
        } catch {
          // ignore
        }
      }
    }
  }, [isActive]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [brightness, setBrightness] = useState(1);
  const [controlsLocked, setControlsLocked] = useState(false);
  const [lockPromptVisible, setLockPromptVisible] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [hasError, setHasError] = useState(false);
  const [offlineErrorMsg, setOfflineErrorMsg] = useState('');
  const [isFastForwarding, setIsFastForwarding] = useState(false);

  // Aspect Ratio & Video Quality (360p-1080p + Backend Pre-Buffered HLS)
  const [aspectMode, setAspectMode] = useState<AspectRatioMode>(() => settings.defaultAspectRatio);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [selectedQuality, setSelectedQuality] = useState<VideoQualityOption>(
    () => settings.defaultQuality,
  );
  const [hlsSeekNonce, setHlsSeekNonce] = useState(0);
  const [preparingBuffer, setPreparingBuffer] = useState(false);
  const [streamVariantsData, setStreamVariantsData] = useState<StreamVariantsResponse | null>(null);
  const streamVariantsRef = useRef<StreamVariantsResponse | null>(null);
  streamVariantsRef.current = streamVariantsData;
  const androidNative = useMemo(() => isAndroidPlatform(), []);
  const isAndroidWebView = useMemo(
    () =>
      androidNative ||
      (typeof navigator !== 'undefined' &&
        /;\s*wv\)|Android.*Version\/[\d.]+/i.test(navigator.userAgent || '')),
    [androidNative],
  );

  // Subtitles, Quality, Aspect & Audio Track Menus
  const [openMenu, setOpenMenu] = useState<
    'languages' | 'subtitles' | 'episodes' | 'quality' | 'aspect' | null
  >(null);
  const [episodeSeasonTab, setEpisodeSeasonTab] = useState<string>('');
  const [languageData, setLanguageData] = useState<MediaLanguagesResponse | null>(null);
  const [languagesLoading, setLanguagesLoading] = useState(false);

  // Subtitles Downloader, Cache & Sync State
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [downloadedSubs, setDownloadedSubs] = useState<DownloadedSubtitleRecord[]>([]);
  const [activeSubtitle, setActiveSubtitle] = useState<SubtitleTrack | null>(null);
  const [subtitlesLoading, setSubtitlesLoading] = useState(false);
  const [downloadingSubId, setDownloadingSubId] = useState<string | null>(null);
  const [subtitleDownloadError, setSubtitleDownloadError] = useState('');
  const [subtitleLangFilter, setSubtitleLangFilter] = useState('');
  const [subtitleSearchInput, setSubtitleSearchInput] = useState('');
  const [subtitleSearchQuery, setSubtitleSearchQuery] = useState('');
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleOffsetSec, setSubtitleOffsetSec] = useState(0);
  const [activeCueText, setActiveCueText] = useState<string>('');
  const [subtitleColor, setSubtitleColor] = useState<'white' | 'yellow' | 'cyan'>('white');
  const [subtitleSize, setSubtitleSize] = useState<'normal' | 'large' | 'small'>('normal');
  const subtitleFileInputRef = useRef<HTMLInputElement>(null);

  const subtitleCuesRef = useRef<SubtitleCue[]>(subtitleCues);
  subtitleCuesRef.current = subtitleCues;
  const subtitlesEnabledRef = useRef<boolean>(subtitlesEnabled);
  subtitlesEnabledRef.current = subtitlesEnabled;
  const subtitleOffsetSecRef = useRef<number>(subtitleOffsetSec);
  subtitleOffsetSecRef.current = subtitleOffsetSec;

  const onProgressRef = useRef(onProgress);
  const onTimeTickRef = useRef(onTimeTick);
  const onLanguagesResolvedRef = useRef(onLanguagesResolved);
  const initialResumeAppliedRef = useRef(false);
  const lastProgressEmitRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const autoRetriedKeyRef = useRef<string>('');
  const autoHlsFallbackKeyRef = useRef<string>('');
  const autoDirectFallbackKeyRef = useRef<string>('');
  const isCleaningUpRef = useRef(false);
  const liveTimeRef = useRef(0);
  const effectiveDurationRef = useRef(0);
  const volumeRef = useRef(volume);
  const brightnessRef = useRef(brightness);
  const lastRenderedSecRef = useRef(-1);
  const lastRenderedDurRef = useRef(-1);
  const lastCueTextRef = useRef('');
  const lastStageSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const hlsRecoveryAttemptRef = useRef('');

  // Backend HLS Pre-Buffered Session Refs
  const activeHlsSessionIdRef = useRef<string | null>(null);
  const hlsOffsetSecRef = useRef(0);
  const hlsTotalDurationRef = useRef(0);
  const encodedLocalDurationRef = useRef(0);
  const pendingStartSeekSecRef = useRef<number | null>(null);
  const hlsSeekDebounceRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const lastMediaSessionPosUpdateRef = useRef(0);

  // Double-tap seek & swipe gesture refs
  const lastTapRef = useRef<{ time: number; side: 'left' | 'center' | 'right' }>({
    time: 0,
    side: 'center',
  });
  const singleTapTimerRef = useRef<number | null>(null);
  const holdFastForwardTimerRef = useRef<number | null>(null);
  const fastForwardPausedBeforeRef = useRef(false);
  const seekFeedbackTimerRef = useRef<number | null>(null);
  const gestureHudTimerRef = useRef<number | null>(null);
  const lockPromptTimerRef = useRef<number | null>(null);

  const activeSwipeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    relX: number;
    rectWidth: number;
    rectHeight: number;
    mode: 'pending' | 'brightness' | 'volume' | 'seek' | 'fastforward';
    startValue: number;
    seekTargetSec: number;
    hasMoved: boolean;
  } | null>(null);

  const [gestureHud, setGestureHud] = useState<
    | { type: 'brightness'; percent: number }
    | { type: 'volume'; percent: number; muted: boolean }
    | { type: 'seek'; targetSec: number; deltaSec: number }
    | { type: 'badge'; label: string; value: string }
    | null
  >(null);

  const [seekFeedback, setSeekFeedback] = useState<{
    side: 'left' | 'right';
    totalSec: number;
    nonce: number;
  } | null>(null);

  // Native HTML5 AudioTracks (when supported by browser)
  const [nativeAudioTracks, setNativeAudioTracks] = useState<
    Array<{ index: number; label: string; language: string; enabled: boolean }>
  >([]);

  const showTemporaryGestureHud = useCallback(
    (
      hud:
        | { type: 'brightness'; percent: number }
        | { type: 'volume'; percent: number; muted: boolean }
        | { type: 'seek'; targetSec: number; deltaSec: number }
        | { type: 'badge'; label: string; value: string },
      autoHideMs = 0,
    ) => {
      if (gestureHudTimerRef.current !== null) {
        window.clearTimeout(gestureHudTimerRef.current);
        gestureHudTimerRef.current = null;
      }
      setGestureHud(hud);
      if (autoHideMs > 0) {
        gestureHudTimerRef.current = window.setTimeout(() => {
          setGestureHud(null);
        }, autoHideMs);
      }
    },
    [],
  );

  const scheduleHideGestureHud = useCallback((delayMs = 750) => {
    if (gestureHudTimerRef.current !== null) {
      window.clearTimeout(gestureHudTimerRef.current);
    }
    gestureHudTimerRef.current = window.setTimeout(() => {
      setGestureHud(null);
    }, delayMs);
  }, []);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    onTimeTickRef.current = onTimeTick;
  }, [onTimeTick]);

  useEffect(() => {
    onLanguagesResolvedRef.current = onLanguagesResolved;
  }, [onLanguagesResolved]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    brightnessRef.current = brightness;
  }, [brightness]);

  const isLiveStream = playback.kind === 'live';
  const isCatchupStream = playback.kind === 'catchup';
  const isVodStream = playback.kind === 'movie' || playback.kind === 'episode';

  const playbackIdentityKey = `${playback.kind}:${playback.id}:${playback.playUrl}`;
  const subtitleStreamKey = useMemo(
    () => buildSubtitleStreamKey(playback.kind, playback.id),
    [playback.kind, playback.id],
  );

  // Observe stage dimensions for exact explicit Aspect Ratio sizing (16:9, 4:3, 21:9)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      const prev = lastStageSizeRef.current;
      if (Math.abs(prev.width - width) <= 1 && Math.abs(prev.height - height) <= 1) {
        return;
      }
      lastStageSizeRef.current = { width, height };
      setStageSize({ width, height });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset playback state cleanly whenever stream changes
  useEffect(() => {
    initialResumeAppliedRef.current = false;
    lastProgressEmitRef.current = 0;
    autoRetriedKeyRef.current = '';
    autoHlsFallbackKeyRef.current = '';
    hlsRecoveryAttemptRef.current = '';
    lastRenderedSecRef.current = -1;
    hlsOffsetSecRef.current = 0;
    hlsTotalDurationRef.current = 0;
    encodedLocalDurationRef.current = 0;
    pendingStartSeekSecRef.current = null;
    if (hlsSeekDebounceRef.current !== null) {
      window.clearTimeout(hlsSeekDebounceRef.current);
      hlsSeekDebounceRef.current = null;
    }

    const resumeStart =
      isVodStream && playback.resumeSec && playback.resumeSec > 3
        ? Math.floor(playback.resumeSec)
        : 0;

    const seededDuration =
      playback.isOffline && playback.offlineDurationSec && playback.offlineDurationSec > 0
        ? playback.offlineDurationSec
        : 0;
    lastRenderedDurRef.current = seededDuration > 0 ? seededDuration : -1;
    lastCueTextRef.current = '';
    setSelectedQuality(settingsRef.current.defaultQuality);
    setAspectMode(settingsRef.current.defaultAspectRatio);
    setCurrentTime(resumeStart);
    liveTimeRef.current = resumeStart;
    setDuration(seededDuration);
    effectiveDurationRef.current = seededDuration;
    setHasError(false);
    setOfflineErrorMsg('');
    setBuffering(!playback.isOffline);
    setPreparingBuffer(false);
    setOpenMenu(null);
    setControlsLocked(false);
    setLockPromptVisible(false);
    setControlsVisible(true);
    setActiveCueText('');

    if (playback.seasonNum !== undefined) {
      setEpisodeSeasonTab(String(playback.seasonNum));
    } else if (playback.seriesDetail) {
      const firstKey = Object.keys(playback.seriesDetail.episodesBySeason).sort(
        (a, b) => Number(a) - Number(b),
      )[0];
      setEpisodeSeasonTab(firstKey || '');
    } else {
      setEpisodeSeasonTab('');
    }
  }, [playbackIdentityKey]);

  // Fetch available catalog language editions on mount (skip upstream ffprobe until stream is flowing or menu opens)
  const shouldFullProbeLanguages =
    isPlaying || openMenu === 'languages' || openMenu === 'subtitles';
  useEffect(() => {
    if (!isVodStream || playback.isOffline) {
      setLanguageData(null);
      setLanguagesLoading(false);
      onLanguagesResolvedRef.current?.(null);
      return;
    }

    const controller = new AbortController();
    let probeTimer: number | null = null;
    setLanguagesLoading(true);
    const basePayload = {
      kind: (playback.kind === 'episode' ? 'episode' : 'movie') as 'movie' | 'episode',
      id: playback.id,
      extension: playback.extension,
      seriesId: playback.seriesDetail?.seriesId || playback.seriesId,
      seasonNum: playback.seasonNum,
      episodeNum: playback.episodeNum,
      title: playback.seriesDetail?.cleanTitle || playback.title,
    };

    // Pass skipProbe: true first for zero upstream connection contention on mount
    fetchMediaLanguages({ ...basePayload, skipProbe: true }, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setLanguageData(res);
        setLanguagesLoading(false);
        onLanguagesResolvedRef.current?.(res);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setLanguagesLoading(false);
      });

    if (shouldFullProbeLanguages) {
      probeTimer = window.setTimeout(() => {
        fetchMediaLanguages({ ...basePayload, skipProbe: false }, controller.signal)
          .then((res) => {
            if (controller.signal.aborted) return;
            setLanguageData(res);
            onLanguagesResolvedRef.current?.(res);
          })
          .catch(() => {
            // Keep fast catalog language response if full ffprobe fails
          });
      }, openMenu === 'languages' || openMenu === 'subtitles' ? 0 : 1800);
    }

    return () => {
      if (probeTimer !== null) window.clearTimeout(probeTimer);
      controller.abort();
    };
  }, [
    isVodStream,
    playback.isOffline,
    playback.kind,
    playback.id,
    playback.extension,
    playback.seriesId,
    playback.seriesDetail?.seriesId,
    playback.seriesDetail?.cleanTitle,
    playback.seasonNum,
    playback.episodeNum,
    playback.title,
    shouldFullProbeLanguages,
    openMenu,
  ]);

  const syncActiveCueAtTime = useCallback((videoTimeSec: number) => {
    const nextText =
      !subtitlesEnabledRef.current || subtitleCuesRef.current.length === 0
        ? ''
        : findActiveSubtitleCueText(
            subtitleCuesRef.current,
            videoTimeSec,
            subtitleOffsetSecRef.current,
          );
    if (nextText === lastCueTextRef.current) return;
    lastCueTextRef.current = nextText;
    setActiveCueText(nextText);
  }, []);

  // Keep visible cue synchronized immediately when cues, offset, or toggle change
  useEffect(() => {
    syncActiveCueAtTime(liveTimeRef.current);
  }, [subtitleCues, subtitlesEnabled, subtitleOffsetSec, syncActiveCueAtTime]);

  const downloadAndSyncSubtitle = useCallback(
    async (
      sub: SubtitleTrack,
      opts?: { silent?: boolean; keepMenuOpen?: boolean },
    ): Promise<boolean> => {
      if (!isVodStream) return false;
      setSubtitleDownloadError('');

      // Check local offline/downloaded cache first
      if (sub.vttUrl.startsWith('offline:') && playback.offlineSubtitles) {
        const targetId = sub.vttUrl.slice('offline:'.length);
        const found = playback.offlineSubtitles.find((s) => s.id === targetId);
        if (found) {
          const cues = parseVttCues(found.vttText);
          setActiveSubtitle(sub);
          setSubtitleCues(cues);
          setSubtitleOffsetSec(0);
          setSubtitlesEnabled(true);
          if (!opts?.keepMenuOpen) setOpenMenu(null);
          return cues.length > 0;
        }
      }

      const cachedLocal = getDownloadedSubtitle(subtitleStreamKey, sub.id);
      if (cachedLocal) {
        const cues = parseVttCues(cachedLocal.vttText);
        setActiveSubtitle(sub);
        setSubtitleCues(cues);
        setSubtitleOffsetSec(cachedLocal.offsetSec || 0);
        setSubtitlesEnabled(true);
        setPreferredActiveSubtitleId(subtitleStreamKey, sub.id);
        if (!opts?.keepMenuOpen) setOpenMenu(null);
        if (!opts?.silent) {
          showTemporaryGestureHud(
            { type: 'badge', label: 'Subtitles Synced', value: sub.language },
            1300,
          );
        }
        return cues.length > 0;
      }

      setDownloadingSubId(sub.id);
      try {
        const res = await fetch(sub.vttUrl);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const vttText = await res.text();
        const cues = parseVttCues(vttText);
        if (cues.length === 0) {
          throw new Error('Subtitle file contains no timed cues');
        }

        saveDownloadedSubtitle({
          id: sub.id,
          streamKey: subtitleStreamKey,
          language: sub.language,
          languageCode: sub.languageCode,
          label: sub.label,
          fileName: sub.fileName,
          format: sub.format,
          source: sub.source || 'opensubtitles',
          vttText,
          offsetSec: 0,
        });
        setDownloadedSubs(getDownloadedSubtitlesForStream(subtitleStreamKey));
        setActiveSubtitle(sub);
        setSubtitleCues(cues);
        setSubtitleOffsetSec(0);
        setSubtitlesEnabled(true);
        if (!opts?.keepMenuOpen) setOpenMenu(null);
        if (!opts?.silent) {
          showTemporaryGestureHud(
            { type: 'badge', label: 'Subtitles Downloaded & Synced', value: sub.language },
            1500,
          );
        }
        return true;
      } catch (err) {
        if (!opts?.silent) {
          setSubtitleDownloadError(
            err instanceof Error
              ? `Could not download ${sub.language} subtitle (${err.message}). Try another release.`
              : `Could not download ${sub.language} subtitle. Try another release.`,
          );
        }
        return false;
      } finally {
        setDownloadingSubId((cur) => (cur === sub.id ? null : cur));
      }
    },
    [isVodStream, playback.offlineSubtitles, subtitleStreamKey, showTemporaryGestureHud],
  );

  // Restore cached downloaded subtitles & reset custom query when stream changes
  useEffect(() => {
    setSubtitleLangFilter('');
    setSubtitleSearchInput('');
    setSubtitleSearchQuery('');
    setSubtitleDownloadError('');
    setDownloadingSubId(null);

    if (!isVodStream) {
      setDownloadedSubs([]);
      setSubtitles([]);
      setActiveSubtitle(null);
      setSubtitleCues([]);
      setSubtitleOffsetSec(0);
      return;
    }

    if (playback.isOffline) {
      setDownloadedSubs([]);
      setSubtitlesLoading(false);
      const offlineList: SubtitleTrack[] = (playback.offlineSubtitles || []).map((s) => ({
        id: s.id,
        language: s.language,
        languageCode: s.language.slice(0, 2).toLowerCase(),
        label: s.language,
        format: 'vtt',
        source: 'opensubtitles',
        downloadUrl: '',
        vttUrl: `offline:${s.id}`,
      }));
      setSubtitles(offlineList);
      if (settingsRef.current.preferredSubtitleLang === 'off') {
        setSubtitlesEnabled(false);
        setActiveSubtitle(null);
        setSubtitleCues([]);
      } else if (offlineList.length > 0) {
        const picked = pickPreferredSubtitleTrack(
          offlineList,
          settingsRef.current.preferredSubtitleLang,
        );
        if (picked) {
          void downloadAndSyncSubtitle(picked, { silent: true, keepMenuOpen: true });
        }
      } else {
        setActiveSubtitle(null);
        setSubtitleCues([]);
      }
      return;
    }

    const cachedRecords = getDownloadedSubtitlesForStream(subtitleStreamKey);
    setDownloadedSubs(cachedRecords);

    if (cachedRecords.length > 0) {
      const preferredId = getPreferredActiveSubtitleId(subtitleStreamKey);
      const recordToRestore =
        (preferredId ? cachedRecords.find((r) => r.id === preferredId) : undefined) ||
        cachedRecords[0];

      if (settingsRef.current.preferredSubtitleLang === 'off') {
        setSubtitlesEnabled(false);
        setActiveSubtitle(null);
        setSubtitleCues([]);
        setSubtitleOffsetSec(0);
      } else if (recordToRestore) {
        subtitlePrefAppliedKeyRef.current = playbackIdentityKey;
        const cues = parseVttCues(recordToRestore.vttText);
        setActiveSubtitle({
          id: recordToRestore.id,
          language: recordToRestore.language,
          languageCode: recordToRestore.languageCode,
          label: recordToRestore.label,
          format: recordToRestore.format,
          fileName: recordToRestore.fileName,
          source: recordToRestore.source,
          downloadUrl: '',
          vttUrl: `cached:${recordToRestore.id}`,
        });
        setSubtitleCues(cues);
        setSubtitleOffsetSec(recordToRestore.offsetSec || 0);
        setSubtitlesEnabled(true);
      }
    } else {
      setActiveSubtitle(null);
      setSubtitleCues([]);
      setSubtitleOffsetSec(0);
    }
  }, [
    isVodStream,
    playback.isOffline,
    playback.offlineSubtitles,
    playbackIdentityKey,
    subtitleStreamKey,
    downloadAndSyncSubtitle,
  ]);

  // Fetch multi-language subtitles from backend (auto-matched + optional custom search query)
  useEffect(() => {
    if (!isVodStream || playback.isOffline) return;

    const controller = new AbortController();
    setSubtitlesLoading(true);
    setSubtitleDownloadError('');
    fetchSubtitles(
      {
        kind: playback.kind === 'episode' ? 'series' : 'movie',
        streamId: playback.id,
        seriesId: playback.seriesDetail?.seriesId || playback.seriesId,
        season: playback.seasonNum,
        episode: playback.episodeNum,
        title: playback.seriesDetail?.cleanTitle || playback.title,
        year: playback.year ?? playback.seriesDetail?.year,
        imdbId: playback.imdbId,
        q: subtitleSearchQuery || undefined,
      },
      controller.signal,
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        const subs = res.subtitles || [];
        setSubtitles(subs);
        setSubtitlesLoading(false);

        if (
          !subtitleSearchQuery &&
          subtitlePrefAppliedKeyRef.current !== playbackIdentityKey
        ) {
          subtitlePrefAppliedKeyRef.current = playbackIdentityKey;
          const pref = settingsRef.current.preferredSubtitleLang;
          if (pref === 'off') {
            setSubtitlesEnabled(false);
            setActiveSubtitle(null);
          } else if (subs.length > 0) {
            const preferred = pickPreferredSubtitleTrack(subs, pref);
            if (preferred) {
              void downloadAndSyncSubtitle(preferred, { silent: true, keepMenuOpen: true });
            }
          }
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setSubtitlesLoading(false);
      });

    return () => controller.abort();
  }, [
    isVodStream,
    playback.isOffline,
    playback.kind,
    playback.id,
    playback.seriesId,
    playback.seriesDetail?.seriesId,
    playback.seriesDetail?.cleanTitle,
    playback.seriesDetail?.year,
    playback.seasonNum,
    playback.episodeNum,
    playback.title,
    playback.year,
    playback.imdbId,
    playbackIdentityKey,
    subtitleSearchQuery,
    downloadAndSyncSubtitle,
  ]);

  // Reveal & Auto-hide transport controls
  const revealControls = useCallback(
    (forcePlaying?: boolean) => {
      setControlsVisible(true);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      const playingNow =
        typeof forcePlaying === 'boolean'
          ? forcePlaying
          : Boolean(videoRef.current && !videoRef.current.paused && !videoRef.current.ended);
      if (playingNow && !openMenu) {
        hideTimerRef.current = window.setTimeout(() => {
          setControlsVisible(false);
        }, 3400);
      }
    },
    [openMenu],
  );

  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [revealControls]);

  // Screen orientation locking for mobile landscape in fullscreen
  const lockOrientationLandscape = useCallback(async () => {
    try {
      if (
        typeof screen !== 'undefined' &&
        screen.orientation &&
        typeof screen.orientation.lock === 'function'
      ) {
        await screen.orientation.lock('landscape').catch(() => {});
      } else if (typeof (screen as unknown as { lockOrientation?: (s: string) => boolean }).lockOrientation === 'function') {
        (screen as unknown as { lockOrientation: (s: string) => boolean }).lockOrientation('landscape');
      } else if (typeof (screen as unknown as { webkitLockOrientation?: (s: string) => boolean }).webkitLockOrientation === 'function') {
        (screen as unknown as { webkitLockOrientation: (s: string) => boolean }).webkitLockOrientation('landscape');
      }
    } catch {
      // Screen orientation lock may be restricted or unsupported on some devices
    }
  }, []);

  const unlockOrientation = useCallback(() => {
    try {
      if (
        typeof screen !== 'undefined' &&
        screen.orientation &&
        typeof screen.orientation.unlock === 'function'
      ) {
        screen.orientation.unlock();
      } else if (typeof (screen as unknown as { unlockOrientation?: () => boolean }).unlockOrientation === 'function') {
        (screen as unknown as { unlockOrientation: () => boolean }).unlockOrientation();
      } else if (typeof (screen as unknown as { webkitUnlockOrientation?: () => boolean }).webkitUnlockOrientation === 'function') {
        (screen as unknown as { webkitUnlockOrientation: () => boolean }).webkitUnlockOrientation();
      }
    } catch {
      // Ignore
    }
  }, []);

  // Listen to fullscreen changes across vendor implementations
  useEffect(() => {
    const onFsChange = () => {
      const isFs = Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement,
      );
      setIsFullscreen(isFs);
      if (isFs) {
        lockOrientationLandscape();
      } else {
        unlockOrientation();
      }
    };

    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      unlockOrientation();
    };
  }, [lockOrientationLandscape, unlockOrientation]);

  // Inspect available stream variants after initial stream handshake settles (avoids upstream connection collision)
  useEffect(() => {
    if (playback.isOffline || !playback.id || playback.kind === 'catchup') {
      setStreamVariantsData(null);
      return;
    }
    const controller = new AbortController();
    const delayTimer = window.setTimeout(() => {
      fetchStreamVariants(playback.kind, playback.id, playback.extension, controller.signal)
        .then((res) => {
          if (!controller.signal.aborted) {
            setStreamVariantsData(res);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setStreamVariantsData(null);
          }
        });
    }, 900);
    return () => {
      window.clearTimeout(delayTimer);
      controller.abort();
    };
  }, [playback.isOffline, playback.kind, playback.id, playback.extension]);

  // Active stream mount preload: immediately warm initial stream chunks/playlist segments on mount
  useEffect(() => {
    if (playback.isOffline || !playback.id || playback.kind === 'catchup') return;
    if (selectedQuality !== 'auto' && !isLiveStream) {
      // HLS session quality path warms segment 0 inside hls-start & prefetches initial .ts segments in attachHlsUrl
      return;
    }
    const controller = new AbortController();
    const resumeTarget =
      isVodStream && playback.resumeSec && playback.resumeSec > 5 ? Math.floor(playback.resumeSec) : 0;
    void preloadStreamMedia(
      {
        kind: playback.kind,
        id: playback.id,
        ext: playback.extension,
        quality: selectedQuality,
        startSec: resumeTarget,
      },
      controller.signal,
    ).catch(() => {
      // Non-critical preload warmup
    });
    return () => controller.abort();
  }, [
    playback.isOffline,
    playback.kind,
    playback.id,
    playback.extension,
    playback.resumeSec,
    selectedQuality,
    isLiveStream,
    isVodStream,
  ]);

  // Direct stream only
  const resolvedMediaUrl = playback.playUrl;

  const closeActiveQualitySession = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    if (activeHlsSessionIdRef.current === sessionId) {
      activeHlsSessionIdRef.current = null;
    }
    try {
      void fetch(`/api/play/hls-session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => {});
      void fetch(`/api/play/quality-session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Ignore cleanup failures
    }
  }, []);

  useEffect(() => {
    const onPageHide = () => {
      closeActiveQualitySession(activeHlsSessionIdRef.current);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [closeActiveQualitySession]);

  // Video engine attachment (Direct pre-buffered OR Download-Pattern Buffered fMP4 360p-1080p)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;
    const sessionController = new AbortController();
    let createdQualityJobId: string | null = null;
    let mseObjectUrl: string | null = null;
    let activeMediaSource: MediaSource | null = null;
    let mseFirstFrameWatchdog: number | null = null;
    let usingNativeTranscodeFallback = false;
    let switchToNativeTranscode: (() => void) | null = null;
    let fallbackBlobUrl: string | null = null;
    let triedOfflineBlobFallback = false;

    setHasError(false);
    setOfflineErrorMsg('');
    setBuffering(!playback.isOffline);

    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    const clearMseWatchdog = () => {
      if (mseFirstFrameWatchdog !== null) {
        window.clearTimeout(mseFirstFrameWatchdog);
        mseFirstFrameWatchdog = null;
      }
    };

    const revokeMseResources = () => {
      clearMseWatchdog();
      if (activeMediaSource) {
        try {
          if (activeMediaSource.readyState === 'open') {
            activeMediaSource.endOfStream();
          }
        } catch {
          // ignore
        }
        activeMediaSource = null;
      }
      if (mseObjectUrl) {
        try {
          URL.revokeObjectURL(mseObjectUrl);
        } catch {
          // ignore
        }
        mseObjectUrl = null;
      }
    };

    const cleanupEngines = () => {
      isCleaningUpRef.current = true;
      revokeMseResources();
      if (hlsRef.current) {
        const hls = hlsRef.current;
        hlsRef.current = null;
        try {
          hls.destroy();
        } catch {
          // ignore
        }
      }
      if (mpegtsRef.current) {
        const ts = mpegtsRef.current;
        mpegtsRef.current = null;
        try {
          ts.pause();
        } catch {
          // ignore
        }
        try {
          ts.detachMediaElement();
        } catch {
          // ignore
        }
        try {
          ts.unload();
        } catch {
          // ignore
        }
        try {
          ts.destroy();
        } catch {
          // ignore
        }
      }
      try {
        if (!video.paused) video.pause();
        if (video.getAttribute('src') || video.currentSrc) {
          video.removeAttribute('src');
          video.load();
        }
      } catch {
        // ignore
      }
      isCleaningUpRef.current = false;
    };

    cleanupEngines();
    video.volume = volume;
    video.muted = isMuted;

    const useBackendQuality = !playback.isOffline && selectedQuality !== 'auto';
    if (!useBackendQuality) {
      hlsOffsetSecRef.current = 0;
      hlsTotalDurationRef.current = 0;
      encodedLocalDurationRef.current = 0;
    }

    const triggerPlaybackFailure = () => {
      if (disposed) return;
      cleanupEngines();
      setPreparingBuffer(false);
      setBuffering(false);
      setIsPlaying(false);
      setHasError(true);
    };

    const scheduleCleanRetryOrFail = () => {
      if (disposed) return;
      cleanupEngines();
      if (autoRetriedKeyRef.current !== playbackIdentityKey) {
        autoRetriedKeyRef.current = playbackIdentityKey;
        setBuffering(true);
        setHasError(false);
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          if (!disposed) {
            setReloadNonce((n) => n + 1);
          }
        }, 650);
      } else {
        setPreparingBuffer(false);
        setBuffering(false);
        setIsPlaying(false);
        setHasError(true);
      }
    };

    const onLoadedMetadata = () => {
      if (disposed) return;
      if (playback.isOffline) {
        setPreparingBuffer(false);
        setBuffering(false);
      }
      const fallbackOfflineDur =
        playback.isOffline && playback.offlineDurationSec && playback.offlineDurationSec > 0
          ? playback.offlineDurationSec
          : 0;
      const rawDur =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : fallbackOfflineDur;
      encodedLocalDurationRef.current = rawDur;

      const effectiveDur = useBackendQuality
        ? hlsTotalDurationRef.current > 0
          ? hlsTotalDurationRef.current
          : rawDur > 0
            ? hlsOffsetSecRef.current + rawDur
            : 0
        : rawDur;
      if (effectiveDur > 0) {
        effectiveDurationRef.current = effectiveDur;
        if (Math.abs(effectiveDur - lastRenderedDurRef.current) >= 1) {
          lastRenderedDurRef.current = effectiveDur;
          setDuration(effectiveDur);
        }
      }

      if (useBackendQuality) {
        const totalDur =
          hlsTotalDurationRef.current > 0
            ? hlsTotalDurationRef.current
            : hlsOffsetSecRef.current + rawDur;
        if (totalDur > 0) {
          effectiveDurationRef.current = totalDur;
          lastRenderedDurRef.current = totalDur;
          setDuration(totalDur);
        }
      } else if (rawDur > 0) {
        effectiveDurationRef.current = rawDur;
        lastRenderedDurRef.current = rawDur;
        setDuration(rawDur);
      }

      // Inspect native video.audioTracks if supported by browser
      const rawAudioTracks = (
        video as unknown as {
          audioTracks?: {
            length: number;
            [idx: number]: { label?: string; language?: string; enabled: boolean };
          };
        }
      ).audioTracks;
      if (rawAudioTracks && rawAudioTracks.length > 0) {
        const list: Array<{ index: number; label: string; language: string; enabled: boolean }> = [];
        for (let i = 0; i < rawAudioTracks.length; i++) {
          const t = rawAudioTracks[i];
          list.push({
            index: i,
            label: t.label || t.language || `Audio Track ${i + 1}`,
            language: t.language || '',
            enabled: Boolean(t.enabled),
          });
        }
        setNativeAudioTracks(list);
      } else {
        setNativeAudioTracks([]);
      }

      if (!useBackendQuality && isVodStream && !initialResumeAppliedRef.current) {
        const resumeTarget =
          pendingStartSeekSecRef.current !== null
            ? pendingStartSeekSecRef.current
            : playback.resumeSec;
        pendingStartSeekSecRef.current = null;
        if (
          resumeTarget &&
          resumeTarget > 5 &&
          rawDur > 0 &&
          resumeTarget < rawDur - 15
        ) {
          initialResumeAppliedRef.current = true;
          try {
            video.currentTime = resumeTarget;
          } catch {
            // ignore
          }
        }
      }
    };

    const onPlaying = () => {
      if (disposed) return;
      clearMseWatchdog();
      setPreparingBuffer(false);
      setBuffering(false);
      setHasError(false);
      setIsPlaying(true);
      revealControls(true);
    };

    const onCanPlay = () => {
      if (disposed) return;
      clearMseWatchdog();
      setPreparingBuffer(false);
      setBuffering(false);
    };

    const onSeeked = () => {
      if (disposed) return;
      setBuffering(false);
    };

    const onPause = () => {
      if (disposed) return;
      setIsPlaying(false);
      setBuffering(false);
      revealControls(false);
      if (isVodStream && liveTimeRef.current > 3) {
        onProgressRef.current(liveTimeRef.current, effectiveDurationRef.current);
      }
    };

    const onEnded = () => {
      if (disposed) return;
      setIsPlaying(false);
      setBuffering(false);
      revealControls(false);
      if (isVodStream && liveTimeRef.current > 3) {
        onProgressRef.current(liveTimeRef.current, effectiveDurationRef.current);
      }
    };

    const onLoadedData = () => {
      if (disposed) return;
      clearMseWatchdog();
      setPreparingBuffer(false);
      setBuffering(false);
    };

    const onWaiting = () => {
      if (disposed || playback.isOffline) return;
      if (!video.paused) {
        setBuffering(true);
      }
    };

    const onTimeUpdate = () => {
      if (disposed) return;
      const rawTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const effectiveTime = useBackendQuality ? hlsOffsetSecRef.current + rawTime : rawTime;
      liveTimeRef.current = effectiveTime;
      onTimeTickRef.current?.(effectiveTime);

      const wholeSec = Math.floor(effectiveTime);
      if (wholeSec !== lastRenderedSecRef.current) {
        lastRenderedSecRef.current = wholeSec;
        setCurrentTime(effectiveTime);
      }

      const fallbackOfflineDur =
        playback.isOffline && playback.offlineDurationSec && playback.offlineDurationSec > 0
          ? playback.offlineDurationSec
          : 0;
      const rawDur =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : fallbackOfflineDur;
      if (rawDur > 0) {
        encodedLocalDurationRef.current = rawDur;
      }

      const effectiveDur = useBackendQuality
        ? hlsTotalDurationRef.current > 0
          ? hlsTotalDurationRef.current
          : rawDur > 0
            ? hlsOffsetSecRef.current + rawDur
            : 0
        : rawDur;
      if (effectiveDur > 0) {
        effectiveDurationRef.current = effectiveDur;
        if (Math.abs(effectiveDur - lastRenderedDurRef.current) >= 1) {
          lastRenderedDurRef.current = effectiveDur;
          setDuration(effectiveDur);
        }
      }

      // Sync current subtitle cue using live refs (avoids redundant state writes)
      syncActiveCueAtTime(effectiveTime);

      if (isVodStream && effectiveTime > 3) {
        const now = Date.now();
        if (now - lastProgressEmitRef.current > 5000) {
          lastProgressEmitRef.current = now;
          onProgressRef.current(effectiveTime, effectiveDur);
        }
      }
    };

    const onVideoError = () => {
      if (disposed || isCleaningUpRef.current || !video.error) return;
      if (!video.getAttribute('src') && !hlsRef.current && !mpegtsRef.current) return;
      if (hlsRef.current) return;

      // Offline fallback: if Service Worker /__offline_media__/ playback errored, assemble Blob from IndexedDB chunks once
      if (
        playback.isOffline &&
        !triedOfflineBlobFallback &&
        resolvedMediaUrl.startsWith('/__offline_media__/')
      ) {
        triedOfflineBlobFallback = true;
        const offlineKey = `${playback.kind === 'episode' ? 'episode' : 'movie'}:${playback.id}`;
        setBuffering(true);
        setHasError(false);
        void createOfflineBlobPlaybackUrl(offlineKey, playback.offlineMimeType)
          .then((blobUrl) => {
            if (disposed) {
              try {
                URL.revokeObjectURL(blobUrl);
              } catch {
                // ignore
              }
              return;
            }
            fallbackBlobUrl = blobUrl;
            isCleaningUpRef.current = true;
            try {
              video.pause();
              video.removeAttribute('src');
              video.load();
            } catch {
              // ignore
            }
            isCleaningUpRef.current = false;
            video.preload = 'auto';
            video.src = blobUrl;
            attemptPlayOrPromptGesture();
          })
          .catch((err: unknown) => {
            if (disposed) return;
            setOfflineErrorMsg(
              err instanceof Error
                ? err.message
                : 'Offline video could not be decoded in this browser.',
            );
            triggerPlaybackFailure();
          });
        return;
      }

      if (playback.isOffline) {
        setOfflineErrorMsg((prev) =>
          prev ||
          'Offline video failed to play in this browser/WebView. Remove and re-download or export to Local Storage.',
        );
        triggerPlaybackFailure();
        return;
      }

      // If MSE fMP4 failed on an Android WebView, fall back to warmed progressive /api/play/transcode MP4
      if (useBackendQuality && !usingNativeTranscodeFallback && switchToNativeTranscode) {
        switchToNativeTranscode();
        return;
      }

      // If both HLS and progressive transcode failed (e.g. transcoder unavailable), fall back to Direct ('auto') once
      if (
        useBackendQuality &&
        usingNativeTranscodeFallback &&
        autoDirectFallbackKeyRef.current !== playbackIdentityKey &&
        autoHlsFallbackKeyRef.current !== playbackIdentityKey
      ) {
        autoDirectFallbackKeyRef.current = playbackIdentityKey;
        pendingStartSeekSecRef.current = isVodStream ? Math.floor(liveTimeRef.current || 0) : 0;
        setSelectedQuality('auto');
        return;
      }

      const urlLower = resolvedMediaUrl.toLowerCase();
      const isTsSource =
        !urlLower.includes('.m3u8') &&
        (isLiveStream || isCatchupStream || urlLower.endsWith('.ts'));

      // Auto-upgrade direct VOD files with unsupported browser codecs (e.g. MKV/HEVC/AC3) to 720p WebView-safe MP4
      if (
        !useBackendQuality &&
        !playback.isOffline &&
        isVodStream &&
        autoHlsFallbackKeyRef.current !== playbackIdentityKey
      ) {
        autoHlsFallbackKeyRef.current = playbackIdentityKey;
        pendingStartSeekSecRef.current = Math.floor(liveTimeRef.current || 0);
        setSelectedQuality('720p');
        return;
      }

      if (isTsSource && !useBackendQuality) {
        scheduleCleanRetryOrFail();
      } else {
        triggerPlaybackFailure();
      }
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('error', onVideoError);

    let hlsWatchdogTimer: number | null = null;
    let nativeHlsWatchdogTimer: number | null = null;
    const clearHlsWatchdog = () => {
      if (hlsWatchdogTimer !== null) {
        window.clearTimeout(hlsWatchdogTimer);
        hlsWatchdogTimer = null;
      }
      if (nativeHlsWatchdogTimer !== null) {
        window.clearTimeout(nativeHlsWatchdogTimer);
        nativeHlsWatchdogTimer = null;
      }
    };

    const onHlsReadyCleanup = () => {
      clearHlsWatchdog();
    };
    video.addEventListener('loadeddata', onHlsReadyCleanup);
    video.addEventListener('canplay', onHlsReadyCleanup);
    video.addEventListener('playing', onHlsReadyCleanup);

    const attemptPlayOrPromptGesture = () => {
      if (disposed) return;
      if (!autoPlayRef.current) {
        setPreparingBuffer(false);
        setBuffering(false);
        setIsPlaying(false);
        revealControls(false);
        return;
      }
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err: unknown) => {
          if (disposed) return;
          const errName =
            err && typeof err === 'object' && 'name' in err
              ? String((err as { name?: string }).name || '')
              : '';
          setPreparingBuffer(false);
          setBuffering(false);
          if (errName === 'NotAllowedError') {
            setIsPlaying(false);
            revealControls(false);
          }
        });
      }
    };

    const preloadFirstHlsSegments = async (playlistUrl: string) => {
      if (disposed || sessionController.signal.aborted) return;
      try {
        const playlistResp = await fetch(playlistUrl, {
          method: 'GET',
          signal: sessionController.signal,
        });
        if (!playlistResp.ok || disposed) return;
        const manifestText = await playlistResp.text();
        if (disposed || sessionController.signal.aborted) return;

        const baseUrl = new URL(playlistUrl, window.location.origin);
        const lines = manifestText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

        // If master playlist points to a variant playlist, follow first variant once
        const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
        if (isMaster) {
          const variantLine = lines.find((l) => !l.startsWith('#'));
          if (variantLine) {
            const variantUrl = new URL(variantLine, baseUrl).href;
            await preloadFirstHlsSegments(variantUrl);
          }
          return;
        }

        // Preload initialization map (EXT-X-MAP) + first 3 media segments into browser HTTP cache
        const segmentUrls: string[] = [];
        const initMatch = manifestText.match(/#EXT-X-MAP:URI="([^"]+)"/i);
        if (initMatch?.[1]) {
          segmentUrls.push(new URL(initMatch[1], baseUrl).href);
        }
        for (const line of lines) {
          if (line.startsWith('#')) continue;
          segmentUrls.push(new URL(line, baseUrl).href);
          if (segmentUrls.length >= 4) break;
        }

        await Promise.all(
          segmentUrls.map((segUrl) =>
            fetch(segUrl, {
              method: 'GET',
              signal: sessionController.signal,
            })
              .then((r) => r.arrayBuffer())
              .catch(() => null),
          ),
        );
      } catch {
        // Non-blocking segment preload
      }
    };

    const attachHlsUrl = (sourceUrl: string, startAtBeginningForEvent: boolean) => {
      // Immediately prefetch playlist + first segments on attach to minimize time to first frame
      void preloadFirstHlsSegments(sourceUrl);

      const canPlayNativeHls = Boolean(
        video.canPlayType('application/vnd.apple.mpegurl') ||
          video.canPlayType('application/x-mpegURL'),
      );

      const attachNativeHls = () => {
        if (disposed) return;
        clearHlsWatchdog();
        if (hlsRef.current) {
          const oldHls = hlsRef.current;
          hlsRef.current = null;
          try {
            oldHls.destroy();
          } catch {
            // ignore
          }
        }
        isCleaningUpRef.current = true;
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch {
          // ignore
        }
        isCleaningUpRef.current = false;
        video.preload = 'auto';
        video.src = sourceUrl;
        attemptPlayOrPromptGesture();

        if (useBackendQuality && !usingNativeTranscodeFallback && switchToNativeTranscode) {
          nativeHlsWatchdogTimer = window.setTimeout(() => {
            nativeHlsWatchdogTimer = null;
            if (
              !disposed &&
              !usingNativeTranscodeFallback &&
              video.readyState < 2 &&
              switchToNativeTranscode
            ) {
              switchToNativeTranscode();
            }
          }, 5500);
        }
      };

      // On Android WebView / Web-to-APK, MSE Hls.js blob: URLs often stall silently on 360p-1080p streams.
      // Prefer native HLS (<video src>) when supported, or switch directly to progressive MP4 transcode.
      if (isAndroidWebView && useBackendQuality) {
        if (canPlayNativeHls) {
          attachNativeHls();
        } else if (!usingNativeTranscodeFallback && switchToNativeTranscode) {
          switchToNativeTranscode();
        } else {
          triggerPlaybackFailure();
        }
        return;
      }

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: false,
          lowLatencyMode: false,
          startPosition: startAtBeginningForEvent ? 0 : -1,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 15,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 3,
          fragLoadingMaxRetry: 4,
          fragLoadingRetryDelay: 350,
          xhrSetup: (xhr) => {
            xhr.withCredentials = false;
          },
        });
        hlsRef.current = hls;
        let networkRecoveries = 0;
        let mediaRecoveries = 0;
        let nativeFallbackTried = false;
        let hlsProgressed = false;

        // Unconditional startup watchdog (covers environments where canPlayNativeHls is false, e.g. Android WebView/proxy)
        clearHlsWatchdog();
        hlsWatchdogTimer = window.setTimeout(() => {
          hlsWatchdogTimer = null;
          if (
            !disposed &&
            hlsRef.current === hls &&
            !hlsProgressed &&
            video.readyState < 2
          ) {
            if (canPlayNativeHls && !nativeFallbackTried) {
              nativeFallbackTried = true;
              attachNativeHls();
            } else if (useBackendQuality && !usingNativeTranscodeFallback && switchToNativeTranscode) {
              switchToNativeTranscode();
            }
          }
        }, 5500);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (disposed || hlsRef.current !== hls) return;
          hlsProgressed = true;
          attemptPlayOrPromptGesture();
        });

        hls.on(Hls.Events.FRAG_LOADED, () => {
          if (disposed || hlsRef.current !== hls) return;
          hlsProgressed = true;
        });

        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (disposed || hlsRef.current !== hls || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
            networkRecoveries += 1;
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
            mediaRecoveries += 1;
            hls.recoverMediaError();
          } else if (canPlayNativeHls && !nativeFallbackTried) {
            nativeFallbackTried = true;
            attachNativeHls();
          } else if (useBackendQuality && !usingNativeTranscodeFallback) {
            clearHlsWatchdog();
            if (!hlsProgressed && switchToNativeTranscode) {
              // Fast-fail directly to progressive MP4 transcode if HLS MSE fails before first segment
              switchToNativeTranscode();
              return;
            }
            const recoveryKey = `${playbackIdentityKey}:${selectedQuality}`;
            if (hlsRecoveryAttemptRef.current !== recoveryKey) {
              // Transparently recreate HLS session once at current timestamp (e.g. after long pause TTL cleanup)
              hlsRecoveryAttemptRef.current = recoveryKey;
              pendingStartSeekSecRef.current = isVodStream
                ? Math.max(0, Math.floor(liveTimeRef.current || 0))
                : 0;
              setBuffering(true);
              setHasError(false);
              setHlsSeekNonce((n) => n + 1);
            } else if (switchToNativeTranscode) {
              switchToNativeTranscode();
            } else {
              triggerPlaybackFailure();
            }
          } else {
            clearHlsWatchdog();
            triggerPlaybackFailure();
          }
        });

        hls.loadSource(sourceUrl);
        hls.attachMedia(video);
      } else if (canPlayNativeHls) {
        attachNativeHls();
      } else if (useBackendQuality && !usingNativeTranscodeFallback && switchToNativeTranscode) {
        switchToNativeTranscode();
      } else {
        triggerPlaybackFailure();
      }
    };

    if (useBackendQuality) {
      // 1) If upstream source already exposes an HLS variant matching selectedQuality, play it directly via Hls.js!
      const detected = streamVariantsRef.current;
      const upstreamHlsMatch =
        detected?.isHls && detected.variants
          ? detected.variants.find(
              (v) =>
                v.source === 'upstream-hls' &&
                v.url &&
                v.quality.toLowerCase() === String(selectedQuality).toLowerCase(),
            )
          : undefined;

      const startSec = isVodStream
        ? Math.max(
            0,
            Math.floor(
              pendingStartSeekSecRef.current !== null
                ? pendingStartSeekSecRef.current
                : playback.resumeSec && playback.resumeSec > 5 && !initialResumeAppliedRef.current
                  ? playback.resumeSec
                  : liveTimeRef.current || 0,
            ),
          )
        : 0;
      pendingStartSeekSecRef.current = null;
      initialResumeAppliedRef.current = true;

      let catchupStartTs = 0;
      let catchupDuration = 60;
      if (isCatchupStream) {
        try {
          const parsed = new URL(playback.playUrl, window.location.origin);
          catchupStartTs = Number(parsed.searchParams.get('startTs') || 0);
          catchupDuration = Number(parsed.searchParams.get('duration') || 60);
        } catch {
          // ignore
        }
      }

      const apiKind = isLiveStream
        ? 'live'
        : isCatchupStream
          ? 'catchup'
          : playback.kind === 'episode'
            ? 'series'
            : 'vod';
      const rawExt = playback.extension || (isLiveStream || isCatchupStream ? 'ts' : 'mp4');
      const catchupQuery =
        isCatchupStream && catchupStartTs > 0
          ? `&startTs=${encodeURIComponent(String(catchupStartTs))}&duration=${encodeURIComponent(String(catchupDuration))}`
          : '';

      switchToNativeTranscode = () => {
        if (disposed || usingNativeTranscodeFallback) return;
        usingNativeTranscodeFallback = true;
        clearHlsWatchdog();
        sessionController.abort();
        isCleaningUpRef.current = true;
        revokeMseResources();
        if (hlsRef.current) {
          try {
            hlsRef.current.destroy();
          } catch {
            // ignore
          }
          hlsRef.current = null;
        }
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch {
          // ignore
        }
        isCleaningUpRef.current = false;
        const fallbackStartSec = isVodStream
          ? Math.max(startSec, Math.floor(liveTimeRef.current || 0))
          : 0;
        const supportsWebm = Boolean(
          video.canPlayType('video/webm; codecs="vp8, opus"') ||
            video.canPlayType('video/webm; codecs="vp8, vorbis"'),
        );
        // Android hardware decoders play H.264/AAC MP4 reliably; avoid VP8/WebM inside Android WebView
        const containerParam = !isAndroidWebView && supportsWebm ? '&container=webm' : '';
        const nativeTranscodeUrl = `/api/play/transcode/${apiKind}/${encodeURIComponent(
          playback.id,
        )}?quality=${encodeURIComponent(selectedQuality)}&start=${fallbackStartSec}&ext=${encodeURIComponent(
          rawExt,
        )}${catchupQuery}${containerParam}`;
        hlsOffsetSecRef.current = fallbackStartSec;
        setPreparingBuffer(false);
        setBuffering(true);
        video.preload = 'auto';
        video.src = nativeTranscodeUrl;
        attemptPlayOrPromptGesture();
      };

      if (upstreamHlsMatch?.url) {
        setPreparingBuffer(false);
        attachHlsUrl(upstreamHlsMatch.url, false);
      } else {
        // 2) Create WebView-safe /api/play/hls-start via GET (avoids Web-to-APK POST body drops) with WebM/MP4 fallback
        setPreparingBuffer(true);

        const startHlsSessionEngine = async () => {
          const knownDurationSec =
            effectiveDurationRef.current > 0 ? Math.floor(effectiveDurationRef.current) : undefined;
          const hlsKind =
            playback.kind === 'episode' ? 'series' : apiKind === 'vod' ? 'movie' : apiKind;
          const qs = new URLSearchParams({
            quality: selectedQuality,
            startSec: String(startSec),
            ext: rawExt,
          });
          if (knownDurationSec) {
            qs.set('durationSec', String(knownDurationSec));
          }
          if (catchupStartTs > 0) {
            qs.set('startTs', String(catchupStartTs));
            qs.set('duration', String(catchupDuration));
          }
          const resp = await fetch(
            `/api/play/hls-start/${encodeURIComponent(hlsKind)}/${encodeURIComponent(
              playback.id,
            )}?${qs.toString()}`,
            {
              method: 'GET',
              cache: 'no-store',
              signal: sessionController.signal,
            },
          );

          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }

          const payload = (await resp.json()) as {
            sessionId: string;
            playlistUrl: string;
            startOffsetSec?: number;
            durationSec?: number;
          };

          if (disposed || sessionController.signal.aborted) {
            if (payload.sessionId) {
              closeActiveQualitySession(payload.sessionId);
            }
            return;
          }

          createdQualityJobId = payload.sessionId;
          activeHlsSessionIdRef.current = payload.sessionId;
          hlsOffsetSecRef.current = Number(payload.startOffsetSec ?? startSec);
          hlsTotalDurationRef.current = Number(payload.durationSec || 0);
          encodedLocalDurationRef.current = 0;

          if (hlsTotalDurationRef.current > 0) {
            effectiveDurationRef.current = hlsTotalDurationRef.current;
            lastRenderedDurRef.current = hlsTotalDurationRef.current;
            setDuration(hlsTotalDurationRef.current);
          }
          lastRenderedSecRef.current = Math.floor(hlsOffsetSecRef.current);
          setCurrentTime(hlsOffsetSecRef.current);
          liveTimeRef.current = hlsOffsetSecRef.current;
          setPreparingBuffer(false);

          attachHlsUrl(payload.playlistUrl, startSec > 0);
        };

        void startHlsSessionEngine().catch((err) => {
          if (disposed || sessionController.signal.aborted || err?.name === 'AbortError') return;
          if (!usingNativeTranscodeFallback && switchToNativeTranscode) {
            switchToNativeTranscode();
          } else {
            triggerPlaybackFailure();
          }
        });
      }
    } else {
      const urlLower = resolvedMediaUrl.toLowerCase();
      const isHlsSource = urlLower.includes('.m3u8');
      const isTsSource =
        !isHlsSource &&
        (isLiveStream || isCatchupStream || urlLower.endsWith('.ts'));

      if (isHlsSource) {
        attachHlsUrl(resolvedMediaUrl, false);
      } else if (isTsSource && mpegts.isSupported()) {
        try {
          mpegts.LoggingControl.enableError = false;
          mpegts.LoggingControl.enableWarn = false;
          mpegts.LoggingControl.enableInfo = false;
          mpegts.LoggingControl.enableVerbose = false;
        } catch {
          // ignore
        }

        const tsPlayer = mpegts.createPlayer(
          {
            type: 'mpegts',
            url: resolvedMediaUrl,
            isLive: isLiveStream,
            cors: true,
          },
          {
            enableWorker: false,
            enableStashBuffer: true,
            stashInitialSize: 512,
            liveBufferLatencyChasing: false,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 30,
            autoCleanupMinBackwardDuration: 15,
            fixAudioTimestampGap: true,
          },
        );
        mpegtsRef.current = tsPlayer;

        tsPlayer.on(mpegts.Events.ERROR, () => {
          if (disposed || mpegtsRef.current !== tsPlayer) return;
          scheduleCleanRetryOrFail();
        });

        tsPlayer.attachMediaElement(video);
        tsPlayer.load();
        if (autoPlayRef.current) {
          video.play().catch(() => {
            if (!disposed) setBuffering(false);
          });
        } else {
          setPreparingBuffer(false);
          setBuffering(false);
          setIsPlaying(false);
          revealControls(false);
        }
      } else {
        video.preload = 'auto';
        video.src = resolvedMediaUrl;
        if (playback.isOffline) {
          setPreparingBuffer(false);
          setBuffering(false);
        }
        if (autoPlayRef.current) {
          video.play().catch(() => {
            if (!disposed) setBuffering(false);
          });
        } else {
          setPreparingBuffer(false);
          setBuffering(false);
          setIsPlaying(false);
          revealControls(false);
        }
      }
    }

    return () => {
      disposed = true;
      clearHlsWatchdog();
      clearMseWatchdog();
      sessionController.abort();
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (isVodStream && liveTimeRef.current > 3) {
        onProgressRef.current(liveTimeRef.current, effectiveDurationRef.current);
      }
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('loadeddata', onHlsReadyCleanup);
      video.removeEventListener('canplay', onHlsReadyCleanup);
      video.removeEventListener('playing', onHlsReadyCleanup);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('error', onVideoError);
      cleanupEngines();
      if (fallbackBlobUrl) {
        try {
          URL.revokeObjectURL(fallbackBlobUrl);
        } catch {
          // ignore
        }
        fallbackBlobUrl = null;
      }
      closeActiveQualitySession(createdQualityJobId);
    };
  }, [
    resolvedMediaUrl,
    reloadNonce,
    selectedQuality,
    hlsSeekNonce,
    isLiveStream,
    isCatchupStream,
    isVodStream,
    playbackIdentityKey,
    playback.isOffline,
    playback.kind,
    playback.id,
    playback.extension,
    playback.playUrl,
    playback.offlineMimeType,
    playback.offlineDurationSec,
    closeActiveQualitySession,
    isAndroidWebView,
  ]);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      video.play().catch(() => {});
      setIsPlaying(true);
      revealControls(true);
    } else {
      video.pause();
      setIsPlaying(false);
      setBuffering(false);
      revealControls(false);
    }
  }, [revealControls]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
    revealControls();
  }, [revealControls]);

  const flashLockPrompt = useCallback(() => {
    setLockPromptVisible(true);
    if (lockPromptTimerRef.current !== null) {
      window.clearTimeout(lockPromptTimerRef.current);
    }
    lockPromptTimerRef.current = window.setTimeout(() => {
      setLockPromptVisible(false);
    }, 2400);
  }, []);

  const applyGestureBrightness = useCallback((nextValue: number) => {
    const clamped = Math.max(0.2, Math.min(1.5, nextValue));
    brightnessRef.current = clamped;
    setBrightness(clamped);
    showTemporaryGestureHud({
      type: 'brightness',
      percent: Math.round(clamped * 100),
    });
  }, [showTemporaryGestureHud]);

  const applyGestureVolume = useCallback((nextValue: number) => {
    const clamped = Math.max(0, Math.min(1, nextValue));
    volumeRef.current = clamped;
    setVolume(clamped);
    const video = videoRef.current;
    if (video) {
      video.volume = clamped;
      video.muted = clamped === 0;
    }
    setIsMuted(clamped === 0);
    showTemporaryGestureHud({
      type: 'volume',
      percent: Math.round(clamped * 100),
      muted: clamped === 0,
    });
  }, [showTemporaryGestureHud]);

  const handleVolumeChange = useCallback(
    (nextVol: number) => {
      const clamped = Math.max(0, Math.min(1, nextVol));
      volumeRef.current = clamped;
      setVolume(clamped);
      const video = videoRef.current;
      if (video) {
        video.volume = clamped;
        video.muted = clamped === 0;
        setIsMuted(clamped === 0);
      }
      revealControls();
    },
    [revealControls],
  );

  const seekTo = useCallback(
    (targetSec: number) => {
      if (!isVodStream) return;
      const clamped = Math.max(
        0,
        effectiveDurationRef.current > 0
          ? Math.min(effectiveDurationRef.current - 1, targetSec)
          : targetSec,
      );
      lastRenderedSecRef.current = Math.floor(clamped);
      setCurrentTime(clamped);
      liveTimeRef.current = clamped;

      const isUsingQualityTranscode = !playback.isOffline && selectedQuality !== 'auto';
      if (isUsingQualityTranscode) {
        const localStart = hlsOffsetSecRef.current;
        const vid = videoRef.current;
        let bufStart = 0;
        let bufEnd = encodedLocalDurationRef.current;
        if (vid && vid.buffered.length > 0) {
          bufStart = vid.buffered.start(0);
          bufEnd = vid.buffered.end(vid.buffered.length - 1);
        }
        if (
          bufEnd - bufStart > 1.5 &&
          clamped >= localStart + bufStart &&
          clamped <= localStart + bufEnd - 1.5
        ) {
          if (vid) {
            try {
              vid.currentTime = clamped - localStart;
            } catch {
              // ignore
            }
          }
        } else {
          pendingStartSeekSecRef.current = Math.floor(clamped);
          if (hlsSeekDebounceRef.current !== null) {
            window.clearTimeout(hlsSeekDebounceRef.current);
          }
          hlsSeekDebounceRef.current = window.setTimeout(() => {
            hlsSeekDebounceRef.current = null;
            setHlsSeekNonce((n) => n + 1);
          }, 260);
        }
      } else if (videoRef.current) {
        try {
          videoRef.current.currentTime = clamped;
        } catch {
          // ignore
        }
      }
      revealControls();
    },
    [isVodStream, playback.isOffline, selectedQuality, revealControls],
  );

  // Keep device screen awake whenever media player is active & re-acquire after interruptions
  const setNativeWebViewKeepAwake = useCallback((keepOn: boolean) => {
    try {
      const win = window as unknown as {
        Android?: { setKeepScreenOn?: (v: boolean) => void; keepScreenOn?: (v: boolean) => void };
        keepScreenOn?: (v: boolean) => void;
      };
      if (typeof win.Android?.setKeepScreenOn === 'function') {
        win.Android.setKeepScreenOn(keepOn);
      } else if (typeof win.Android?.keepScreenOn === 'function') {
        win.Android.keepScreenOn(keepOn);
      } else if (typeof win.keepScreenOn === 'function') {
        win.keepScreenOn(keepOn);
      }
    } catch {
      // Ignore WebView bridge absence
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    setNativeWebViewKeepAwake(false);
    const current = wakeLockRef.current;
    wakeLockRef.current = null;
    if (current) {
      void current.release().catch(() => {});
    }
  }, [setNativeWebViewKeepAwake]);

  const acquireWakeLock = useCallback(async () => {
    if (!isActive || !isPlaying || hasError || !settings.keepScreenAwake) return;
    if (
      typeof document !== 'undefined' &&
      document.visibilityState !== 'visible'
    ) {
      return;
    }
    setNativeWebViewKeepAwake(true);
    if (wakeLockRef.current) return;

    const nav = typeof navigator !== 'undefined'
      ? (navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
        })
      : null;

    if (!nav?.wakeLock?.request) return;

    try {
      const sentinel = await nav.wakeLock.request('screen');
      if (!isActive || !isPlaying || hasError || !settings.keepScreenAwake || document.visibilityState !== 'visible') {
        await sentinel.release().catch(() => {});
        return;
      }
      wakeLockRef.current = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLockRef.current === sentinel) {
          wakeLockRef.current = null;
        }
      });
    } catch {
      // WakeLock may require a user gesture or active visible tab; retried cleanly on play/visibility
    }
  }, [isActive, isPlaying, hasError, settings.keepScreenAwake, setNativeWebViewKeepAwake]);

  useEffect(() => {
    if (!isActive || !isPlaying || hasError || !settings.keepScreenAwake) {
      releaseWakeLock();
      return;
    }

    void acquireWakeLock();

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        void acquireWakeLock();
      } else {
        releaseWakeLock();
      }
    };
    const onFsOrWakeRetry = () => {
      void acquireWakeLock();
    };
    const videoEl = videoRef.current;

    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('fullscreenchange', onFsOrWakeRetry);
    document.addEventListener('webkitfullscreenchange', onFsOrWakeRetry);
    videoEl?.addEventListener('play', onFsOrWakeRetry);
    videoEl?.addEventListener('playing', onFsOrWakeRetry);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('fullscreenchange', onFsOrWakeRetry);
      document.removeEventListener('webkitfullscreenchange', onFsOrWakeRetry);
      videoEl?.removeEventListener('play', onFsOrWakeRetry);
      videoEl?.removeEventListener('playing', onFsOrWakeRetry);
      releaseWakeLock();
    };
  }, [isActive, isPlaying, hasError, settings.keepScreenAwake, acquireWakeLock, releaseWakeLock]);

  // Keep Media Session metadata, state & transport controls active so OS/WebView won't throttle playback
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const mediaSession = navigator.mediaSession;

    if (!isActive || hasError) {
      try {
        mediaSession.playbackState = 'none';
      } catch {
        // ignore
      }
      return;
    }

    try {
      const posterSrc = proxiedImageUrl(playback.poster);
      mediaSession.metadata = new MediaMetadata({
        title: playback.title || 'CineBox Stream',
        artist: playback.subtitle || (isLiveStream ? 'Live TV' : 'CineBox'),
        album: 'CineBox',
        artwork: posterSrc ? [{ src: posterSrc, sizes: '512x512' }] : undefined,
      });
    } catch {
      // Ignore MediaMetadata errors on older WebViews
    }

    const safeSetHandler = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported action in current browser/WebView
      }
    };

    safeSetHandler('play', () => {
      const video = videoRef.current;
      if (video && video.paused) {
        video.play().catch(() => {});
        setIsPlaying(true);
        void acquireWakeLock();
      }
    });
    safeSetHandler('pause', () => {
      const video = videoRef.current;
      if (video && !video.paused) {
        video.pause();
        setIsPlaying(false);
      }
    });
    safeSetHandler(
      'seekbackward',
      isVodStream
        ? (details) => {
            const offset = details.seekOffset || 10;
            seekTo(liveTimeRef.current - offset);
          }
        : null,
    );
    safeSetHandler(
      'seekforward',
      isVodStream
        ? (details) => {
            const offset = details.seekOffset || 10;
            seekTo(liveTimeRef.current + offset);
          }
        : null,
    );
    safeSetHandler(
      'seekto',
      isVodStream
        ? (details) => {
            if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime)) {
              seekTo(details.seekTime);
            }
          }
        : null,
    );

    return () => {
      safeSetHandler('play', null);
      safeSetHandler('pause', null);
      safeSetHandler('seekbackward', null);
      safeSetHandler('seekforward', null);
      safeSetHandler('seekto', null);
    };
  }, [
    isActive,
    hasError,
    isLiveStream,
    isVodStream,
    playback.title,
    playback.subtitle,
    playback.poster,
    acquireWakeLock,
    seekTo,
  ]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const mediaSession = navigator.mediaSession;
    try {
      mediaSession.playbackState = !isActive || hasError ? 'none' : isPlaying ? 'playing' : 'paused';
      if (
        isActive &&
        !hasError &&
        isVodStream &&
        duration > 0 &&
        Number.isFinite(currentTime) &&
        typeof mediaSession.setPositionState === 'function'
      ) {
        const now = Date.now();
        if (now - lastMediaSessionPosUpdateRef.current >= 1000 || !isPlaying) {
          lastMediaSessionPosUpdateRef.current = now;
          mediaSession.setPositionState({
            duration,
            playbackRate: isFastForwarding ? 2 : 1,
            position: Math.max(0, Math.min(duration, currentTime)),
          });
        }
      }
    } catch {
      // Ignore unsupported position state calls
    }
  }, [isActive, hasError, isPlaying, isVodStream, isFastForwarding, duration, currentTime]);

  const stopHoldFastForward = useCallback(() => {
    if (holdFastForwardTimerRef.current !== null) {
      window.clearTimeout(holdFastForwardTimerRef.current);
      holdFastForwardTimerRef.current = null;
    }
    setIsFastForwarding(false);
    const video = videoRef.current;
    if (video) {
      try {
        if (video.playbackRate !== 1) {
          video.playbackRate = 1;
        }
        if (fastForwardPausedBeforeRef.current && !video.paused) {
          video.pause();
        }
      } catch {
        // ignore
      }
    }
    fastForwardPausedBeforeRef.current = false;
  }, []);

  useEffect(() => {
    if (!isActive || controlsLocked || hasError) {
      stopHoldFastForward();
    }
  }, [isActive, controlsLocked, hasError, playbackIdentityKey, stopHoldFastForward]);

  const triggerSeekStep = useCallback(
    (side: 'left' | 'right', deltaSec: number) => {
      seekTo(liveTimeRef.current + deltaSec);
      setSeekFeedback((prev) => ({
        side,
        totalSec:
          prev && prev.side === side
            ? prev.totalSec + Math.abs(deltaSec)
            : Math.abs(deltaSec),
        nonce: Date.now(),
      }));
      if (seekFeedbackTimerRef.current !== null) {
        window.clearTimeout(seekFeedbackTimerRef.current);
      }
      seekFeedbackTimerRef.current = window.setTimeout(() => {
        setSeekFeedback(null);
      }, 750);
    },
    [seekTo],
  );

  useEffect(() => {
    return () => {
      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
      }
      if (holdFastForwardTimerRef.current !== null) {
        window.clearTimeout(holdFastForwardTimerRef.current);
      }
      if (seekFeedbackTimerRef.current !== null) {
        window.clearTimeout(seekFeedbackTimerRef.current);
      }
      if (gestureHudTimerRef.current !== null) {
        window.clearTimeout(gestureHudTimerRef.current);
      }
      if (lockPromptTimerRef.current !== null) {
        window.clearTimeout(lockPromptTimerRef.current);
      }
      if (hlsSeekDebounceRef.current !== null) {
        window.clearTimeout(hlsSeekDebounceRef.current);
      }
      const video = videoRef.current;
      if (video) {
        try {
          video.playbackRate = 1;
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const handleStageTap = useCallback(
    (clientX: number) => {
      if (openMenu) {
        setOpenMenu(null);
        revealControls();
        return;
      }

      const container = containerRef.current;
      if (!container) {
        togglePlayPause();
        return;
      }

      const rect = container.getBoundingClientRect();
      const relX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
      const side: 'left' | 'center' | 'right' =
        relX < 0.38 ? 'left' : relX > 0.62 ? 'right' : 'center';

      const now = Date.now();
      const isDoubleTap =
        isVodStream &&
        (side === 'left' || side === 'right') &&
        now - lastTapRef.current.time <= 350 &&
        lastTapRef.current.side === side;

      if (isDoubleTap) {
        if (singleTapTimerRef.current !== null) {
          window.clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        lastTapRef.current = { time: now, side };
        triggerSeekStep(side, side === 'left' ? -10 : 10);
        return;
      }

      lastTapRef.current = { time: now, side };

      if (isVodStream && (side === 'left' || side === 'right')) {
        if (singleTapTimerRef.current !== null) {
          window.clearTimeout(singleTapTimerRef.current);
        }
        singleTapTimerRef.current = window.setTimeout(() => {
          singleTapTimerRef.current = null;
          const isCoarsePointer =
            typeof window !== 'undefined' &&
            window.matchMedia?.('(pointer: coarse)').matches;
          if (isCoarsePointer && !controlsVisible) {
            revealControls();
          } else {
            togglePlayPause();
          }
        }, 260);
      } else {
        if (singleTapTimerRef.current !== null) {
          window.clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        const isCoarsePointer =
          typeof window !== 'undefined' &&
          window.matchMedia?.('(pointer: coarse)').matches;
        if (isCoarsePointer && !controlsVisible) {
          revealControls();
        } else {
          togglePlayPause();
        }
      }
    },
    [openMenu, isVodStream, controlsVisible, revealControls, togglePlayPause, triggerSeekStep],
  );

  const handleStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (holdFastForwardTimerRef.current !== null) {
        window.clearTimeout(holdFastForwardTimerRef.current);
        holdFastForwardTimerRef.current = null;
      }
      if (isPlaying && !wakeLockRef.current) {
        void acquireWakeLock();
      }
      if (openMenu) {
        activeSwipeRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          relX: 0.5,
          rectWidth: 1,
          rectHeight: 1,
          mode: 'pending',
          startValue: 0,
          seekTargetSec: 0,
          hasMoved: false,
        };
        return;
      }

      const stageEl = e.currentTarget;
      const rect = stageEl.getBoundingClientRect();
      const relX = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      const pointerId = e.pointerId;

      activeSwipeRef.current = {
        pointerId,
        startX: e.clientX,
        startY: e.clientY,
        relX,
        rectWidth: Math.max(1, rect.width),
        rectHeight: Math.max(1, rect.height),
        mode: 'pending',
        startValue:
          relX < 0.5
            ? brightnessRef.current
            : videoRef.current?.muted
              ? 0
              : volumeRef.current,
        seekTargetSec: liveTimeRef.current,
        hasMoved: false,
      };

      // Touch-and-hold anywhere on mobile screen to fast-forward at 2x speed
      if (
        !controlsLocked &&
        !hasError &&
        (isVodStream || isCatchupStream) &&
        e.pointerType !== 'mouse'
      ) {
        holdFastForwardTimerRef.current = window.setTimeout(() => {
          holdFastForwardTimerRef.current = null;
          const swipe = activeSwipeRef.current;
          const video = videoRef.current;
          if (!swipe || swipe.pointerId !== pointerId || swipe.mode !== 'pending' || swipe.hasMoved) {
            return;
          }
          if (!video) return;
          if (singleTapTimerRef.current !== null) {
            window.clearTimeout(singleTapTimerRef.current);
            singleTapTimerRef.current = null;
          }
          swipe.mode = 'fastforward';
          swipe.hasMoved = true;
          fastForwardPausedBeforeRef.current = Boolean(video.paused);
          try {
            stageEl.setPointerCapture(pointerId);
          } catch {
            // Ignore pointer capture restriction
          }
          try {
            video.playbackRate = 2;
            if (video.paused) {
              void video.play().catch(() => {});
            }
          } catch {
            // ignore
          }
          setIsFastForwarding(true);
        }, 380);
      }
    },
    [openMenu, isPlaying, acquireWakeLock, controlsLocked, hasError, isVodStream, isCatchupStream],
  );

  const handleStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const swipe = activeSwipeRef.current;
      if (!swipe || swipe.pointerId !== e.pointerId) return;
      if (openMenu || controlsLocked) return;
      if (swipe.mode === 'fastforward') return;

      const dx = e.clientX - swipe.startX;
      const dy = e.clientY - swipe.startY;
      const distance = Math.hypot(dx, dy);

      if (swipe.mode === 'pending') {
        if (distance < 10) return;

        if (holdFastForwardTimerRef.current !== null) {
          window.clearTimeout(holdFastForwardTimerRef.current);
          holdFastForwardTimerRef.current = null;
        }

        // Cancel pending single-tap play/pause when dragging starts
        if (singleTapTimerRef.current !== null) {
          window.clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }

        if (
          Math.abs(dx) > Math.abs(dy) * 1.25 &&
          isVodStream &&
          effectiveDurationRef.current > 0
        ) {
          swipe.mode = 'seek';
          swipe.startValue = liveTimeRef.current;
          swipe.seekTargetSec = liveTimeRef.current;
        } else if (Math.abs(dy) >= Math.abs(dx)) {
          if (swipe.relX < 0.5) {
            swipe.mode = 'brightness';
            swipe.startValue = brightnessRef.current;
          } else {
            swipe.mode = 'volume';
            swipe.startValue = videoRef.current?.muted ? 0 : volumeRef.current;
          }
        } else {
          return;
        }

        swipe.hasMoved = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Ignore pointer capture restriction
        }
      }

      if (!swipe.hasMoved) return;

      if (swipe.mode === 'brightness') {
        const travelPx = Math.max(150, swipe.rectHeight * 0.7);
        const deltaRatio = -dy / travelPx;
        applyGestureBrightness(swipe.startValue + deltaRatio * 1.3);
      } else if (swipe.mode === 'volume') {
        const travelPx = Math.max(150, swipe.rectHeight * 0.7);
        const deltaRatio = -dy / travelPx;
        applyGestureVolume(swipe.startValue + deltaRatio);
      } else if (swipe.mode === 'seek') {
        const spanSec = Math.min(180, Math.max(45, effectiveDurationRef.current * 0.12));
        const deltaSec = (dx / Math.max(220, swipe.rectWidth)) * spanSec;
        const maxDur = effectiveDurationRef.current;
        const target = Math.max(
          0,
          maxDur > 0 ? Math.min(maxDur - 1, swipe.startValue + deltaSec) : swipe.startValue + deltaSec,
        );
        swipe.seekTargetSec = target;
        showTemporaryGestureHud({
          type: 'seek',
          targetSec: target,
          deltaSec: Math.round(target - swipe.startValue),
        });
      }
    },
    [
      openMenu,
      controlsLocked,
      isVodStream,
      applyGestureBrightness,
      applyGestureVolume,
      showTemporaryGestureHud,
    ],
  );

  const handleStagePointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
      const swipe = activeSwipeRef.current;
      if (!swipe || swipe.pointerId !== e.pointerId) return;
      activeSwipeRef.current = null;

      if (holdFastForwardTimerRef.current !== null) {
        window.clearTimeout(holdFastForwardTimerRef.current);
        holdFastForwardTimerRef.current = null;
      }

      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore
      }

      if (swipe.mode === 'fastforward') {
        stopHoldFastForward();
        return;
      }

      if (swipe.hasMoved) {
        if (!cancelled && swipe.mode === 'seek' && isVodStream) {
          seekTo(swipe.seekTargetSec);
        }
        scheduleHideGestureHud(750);
        return;
      }

      if (cancelled) return;

      if (controlsLocked) {
        flashLockPrompt();
        return;
      }

      handleStageTap(e.clientX);
    },
    [
      controlsLocked,
      flashLockPrompt,
      handleStageTap,
      isVodStream,
      scheduleHideGestureHud,
      seekTo,
      stopHoldFastForward,
    ],
  );

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    const isFs = Boolean(
      document.fullscreenElement ||
        (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement,
    );

    if (isFs) {
      if (document.exitFullscreen) {
        await document.exitFullscreen().catch(() => {});
      } else if ((document as unknown as { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen) {
        await (document as unknown as { webkitExitFullscreen: () => Promise<void> }).webkitExitFullscreen().catch(() => {});
      }
      unlockOrientation();
    } else {
      try {
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        } else if ((el as unknown as { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen) {
          await (el as unknown as { webkitRequestFullscreen: () => Promise<void> }).webkitRequestFullscreen();
        }
        // Lock landscape orientation immediately on user touch/click
        await lockOrientationLandscape();
      } catch (err) {
        console.warn('Fullscreen request failed:', err);
      }
    }
    revealControls();
  }, [revealControls, lockOrientationLandscape, unlockOrientation]);

  const togglePip = useCallback(() => {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      video.requestPictureInPicture?.().catch(() => {});
    }
    revealControls();
  }, [revealControls]);

  const handleRetry = useCallback(() => {
    autoRetriedKeyRef.current = '';
    hlsRecoveryAttemptRef.current = '';
    if (!playback.isOffline && selectedQuality !== 'auto' && isVodStream) {
      pendingStartSeekSecRef.current = Math.floor(liveTimeRef.current || 0);
    }
    setHasError(false);
    setBuffering(true);
    setReloadNonce((n) => n + 1);
  }, [playback.isOffline, selectedQuality, isVodStream]);

  const handleSelectQuality = useCallback(
    (nextQuality: VideoQualityOption) => {
      setOpenMenu(null);
      if (nextQuality === selectedQuality) return;
      if (isVodStream) {
        pendingStartSeekSecRef.current = Math.floor(liveTimeRef.current || 0);
        initialResumeAppliedRef.current = false;
      }
      setSelectedQuality(nextQuality);
      const label =
        VIDEO_QUALITY_OPTIONS.find((q) => q.id === nextQuality)?.label || nextQuality;
      showTemporaryGestureHud({ type: 'badge', label: 'Quality', value: label }, 1200);
      revealControls();
    },
    [selectedQuality, isVodStream, showTemporaryGestureHud, revealControls],
  );

  const handleSelectAspectMode = useCallback(
    (nextAspect: AspectRatioMode) => {
      setOpenMenu(null);
      setAspectMode(nextAspect);
      const label =
        ASPECT_RATIO_OPTIONS.find((a) => a.id === nextAspect)?.label || nextAspect;
      showTemporaryGestureHud({ type: 'badge', label: 'Aspect Ratio', value: label }, 1100);
      revealControls();
    },
    [showTemporaryGestureHud, revealControls],
  );

  const handleLaunchAndroidPlayer = useCallback(
    (targetPlayer: ExternalAndroidPlayerTarget = 'chooser') => {
      if (!androidNative) return;
      setOpenMenu(null);

      const video = videoRef.current;
      if (video && !video.paused) {
        try {
          video.pause();
        } catch {
          // ignore
        }
      }
      if (isVodStream && liveTimeRef.current > 3) {
        onProgressRef.current(liveTimeRef.current, effectiveDurationRef.current);
      }

      if (playback.isOffline) {
        showTemporaryGestureHud(
          {
            type: 'badge',
            label: 'External Player',
            value: 'Use "Transfer to Local Storage" in Downloads to open offline files externally',
          },
          3200,
        );
        return;
      }

      const matchedUpstreamUrl =
        streamVariantsRef.current?.variants?.find((v) => v.source === 'upstream-hls' && v.url)?.url;
      const targetUrl = matchedUpstreamUrl
        ? buildAbsoluteExternalStreamUrl(matchedUpstreamUrl)
        : buildAbsoluteExternalStreamUrl(resolvedMediaUrl);

      if (!targetUrl) {
        showTemporaryGestureHud(
          {
            type: 'badge',
            label: 'External Player',
            value: 'A direct http/https stream URL is required for Android player intents',
          },
          2800,
        );
        return;
      }

      const mimeType =
        playback.offlineMimeType || inferExternalMimeType(playback.extension, targetUrl);
      const res = launchAndroidExternalPlayerIntent({
        url: targetUrl,
        title: playback.title,
        mimeType,
        player: targetPlayer,
      });

      if (!res.launched) {
        showTemporaryGestureHud(
          {
            type: 'badge',
            label: 'External Player',
            value: res.error || 'Unable to launch Android player intent',
          },
          2800,
        );
        return;
      }

      const playerNames: Record<ExternalAndroidPlayerTarget, string> = {
        chooser: 'Android Player Chooser',
        vlc: 'VLC Player',
        mx: 'MX Player',
        mpv: 'MPV Player',
      };
      showTemporaryGestureHud(
        {
          type: 'badge',
          label: 'Opening via JS Intent',
          value: playerNames[targetPlayer],
        },
        2000,
      );
    },
    [
      androidNative,
      isVodStream,
      playback.extension,
      playback.isOffline,
      playback.offlineMimeType,
      playback.title,
      resolvedMediaUrl,
      showTemporaryGestureHud,
    ],
  );

  const handleSelectCatalogVariant = useCallback(
    (variantIndex: number) => {
      const variant = languageData?.catalogVariants[variantIndex];
      if (!variant || variant.isCurrent || !onSwitchPlayback) return;
      const at = Math.floor(liveTimeRef.current || 0);
      setOpenMenu(null);
      if (variant.kind === 'movie') {
        onSwitchPlayback({
          kind: 'movie',
          id: variant.id,
          title: variant.cleanTitle,
          subtitle: variant.categoryName,
          poster: variant.poster,
          playUrl: variant.playUrl,
          extension: variant.extension,
          resumeSec: at >= 1 ? at : undefined,
        });
      } else if (variant.seriesId) {
        onSwitchPlayback({
          kind: 'episode',
          id: variant.id,
          seriesId: variant.seriesId,
          seasonNum: variant.seasonNum,
          episodeNum: variant.episodeNum,
          title: `${variant.cleanTitle} — S${variant.seasonNum ?? 1}E${variant.episodeNum ?? 1}`,
          subtitle: variant.categoryName,
          poster: variant.poster,
          playUrl: variant.playUrl,
          extension: variant.extension,
          seriesDetail: playback.seriesDetail,
          resumeSec: at >= 1 ? at : undefined,
        });
      }
    },
    [languageData?.catalogVariants, onSwitchPlayback, playback.seriesDetail],
  );

  const handleSelectNativeAudioTrack = useCallback((trackIdx: number) => {
    const video = videoRef.current;
    if (!video) return;
    const rawAudioTracks = (
      video as unknown as {
        audioTracks?: {
          length: number;
          [idx: number]: { label?: string; language?: string; enabled: boolean };
        };
      }
    ).audioTracks;
    if (!rawAudioTracks) return;
    for (let i = 0; i < rawAudioTracks.length; i++) {
      rawAudioTracks[i].enabled = i === trackIdx;
    }
    setNativeAudioTracks((prev) =>
      prev.map((t) => ({ ...t, enabled: t.index === trackIdx })),
    );
    setOpenMenu(null);
  }, []);

  const catalogVariants = languageData?.catalogVariants || [];
  const hasMultipleLanguages =
    catalogVariants.length > 1 || nativeAudioTracks.length > 1;
  const seasonKeys = playback.seriesDetail
    ? Object.keys(playback.seriesDetail.episodesBySeason).sort(
        (a, b) => Number(a) - Number(b),
      )
    : [];
  const activeDrawerEpisodes =
    playback.seriesDetail && episodeSeasonTab
      ? playback.seriesDetail.episodesBySeason[episodeSeasonTab] || []
      : [];

  const totalDisplayDur = duration > 0 ? duration : 0;

  const videoFrameStyle = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = { filter: `brightness(${brightness})` };
    if (aspectMode === 'fit') {
      return { ...base, width: '100%', height: '100%', objectFit: 'contain' };
    }
    if (aspectMode === 'fill') {
      return { ...base, width: '100%', height: '100%', objectFit: 'cover' };
    }
    if (aspectMode === 'stretch') {
      return { ...base, width: '100%', height: '100%', objectFit: 'fill' };
    }
    const targetRatio = aspectMode === '16:9' ? 16 / 9 : aspectMode === '4:3' ? 4 / 3 : 21 / 9;
    if (stageSize.width > 0 && stageSize.height > 0) {
      if (stageSize.width / stageSize.height > targetRatio) {
        const h = stageSize.height;
        const w = Math.round(h * targetRatio);
        return { ...base, width: `${w}px`, height: `${h}px`, objectFit: 'fill' };
      }
      const w = stageSize.width;
      const h = Math.round(w / targetRatio);
      return { ...base, width: `${w}px`, height: `${h}px`, objectFit: 'fill' };
    }
    return {
      ...base,
      width: '100%',
      height: '100%',
      aspectRatio: aspectMode.replace(':', ' / '),
      objectFit: 'fill',
    };
  }, [aspectMode, brightness, stageSize.width, stageSize.height]);

  const activeQualityShortLabel =
    VIDEO_QUALITY_OPTIONS.find((q) => q.id === selectedQuality)?.shortLabel || 'Auto';
  const activeAspectShortLabel =
    ASPECT_RATIO_OPTIONS.find((a) => a.id === aspectMode)?.shortLabel || 'Fit';

  return (
    <div
      ref={containerRef}
      onMouseMove={() => revealControls()}
      style={{ touchAction: 'manipulation' }}
      className="relative aspect-video max-h-[72vh] w-full overflow-hidden bg-black sm:rounded-xl sm:border sm:border-white/10 select-none group touch-manipulation flex items-center justify-center"
    >
      <video
        ref={videoRef}
        controls={false}
        playsInline
        preload="auto"
        poster={proxiedImageUrl(playback.poster) || undefined}
        style={videoFrameStyle}
        className="cinebox-native-video bg-black transition-[filter] duration-75"
      />

      {/* Unified Gesture Overlay (Left swipe: Brightness, Right swipe: Volume, Horizontal swipe: Seek, Hold: 2x Fast-Forward, Tap/Double-tap) */}
      <div
        role="presentation"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={(e) => handleStagePointerEnd(e, false)}
        onPointerCancel={(e) => handleStagePointerEnd(e, true)}
        style={{ touchAction: 'none' }}
        className="absolute inset-0 z-[5] select-none"
      />

      {/* Touch-and-Hold 2x Fast-Forward Pill */}
      {isFastForwarding && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-2.5 sm:top-4 z-[24] -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/80 px-3 py-1 text-[11px] sm:text-xs font-semibold text-white shadow-md"
        >
          <FastForward className="h-3.5 w-3.5 text-[#E11D48] fill-current" />
          <span className="tabular-nums">2x Speed</span>
        </div>
      )}

      {/* Screen Lock Unlock Prompt */}
      {controlsLocked && lockPromptVisible && (
        <div className="absolute inset-x-0 top-4 z-[25] flex justify-center pointer-events-none">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setControlsLocked(false);
              setLockPromptVisible(false);
              revealControls();
            }}
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-white/25 bg-[#0F131D] px-4 py-2 text-xs font-semibold text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
          >
            <Unlock className="h-3.5 w-3.5 text-[#E11D48]" />
            <span>Gestures Locked · Tap to Unlock</span>
          </button>
        </div>
      )}

      {/* Active Swipe / Control HUD */}
      {gestureHud && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-1/2 z-[22] -translate-x-1/2 -translate-y-1/2"
        >
          {gestureHud.type === 'badge' ? (
            <div className="flex flex-col items-center gap-0.5 rounded-lg sm:rounded-xl border border-white/15 bg-[#0F131D] px-3 py-1.5 sm:px-5 sm:py-2.5 text-white shadow-lg">
              <span className="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {gestureHud.label}
              </span>
              <span className="text-xs sm:text-sm font-bold text-white">{gestureHud.value}</span>
            </div>
          ) : gestureHud.type === 'seek' ? (
            <div className="flex flex-col items-center gap-0.5 sm:gap-1 rounded-lg sm:rounded-xl border border-white/15 bg-[#0F131D] px-3.5 py-2 sm:px-5 sm:py-3 text-white shadow-lg">
              <div className="flex items-center gap-1.5 sm:gap-2 font-mono text-sm sm:text-base font-bold tracking-tight tabular-nums">
                {gestureHud.deltaSec < 0 ? (
                  <RotateCcw className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-rose-400" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-rose-400" />
                )}
                <span>{formatPlaybackTime(gestureHud.targetSec)}</span>
              </div>
              <span className="font-mono text-[10px] sm:text-xs font-semibold text-slate-300 tabular-nums">
                {gestureHud.deltaSec >= 0 ? `+${gestureHud.deltaSec}s` : `${gestureHud.deltaSec}s`}
              </span>
            </div>
          ) : (
            <div className="flex min-w-[136px] sm:min-w-[168px] flex-col items-center gap-1.5 sm:gap-2.5 rounded-lg sm:rounded-xl border border-white/15 bg-[#0F131D] px-3 py-2.5 sm:px-4 sm:py-3.5 text-white shadow-lg">
              <div className="flex w-full items-center justify-between gap-2 sm:gap-3">
                <span className="inline-flex items-center gap-1.5 sm:gap-2 text-[11px] sm:text-xs font-semibold text-slate-200">
                  {gestureHud.type === 'brightness' ? (
                    <Sun className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-amber-300" />
                  ) : gestureHud.muted || gestureHud.percent === 0 ? (
                    <VolumeX className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-rose-400" />
                  ) : gestureHud.percent < 50 ? (
                    <Volume1 className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-sky-300" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-sky-300" />
                  )}
                  <span>{gestureHud.type === 'brightness' ? 'Brightness' : 'Volume'}</span>
                </span>
                <span className="font-mono text-[11px] sm:text-xs font-bold tabular-nums text-white">
                  {gestureHud.percent}%
                </span>
              </div>
              <div className="h-1 sm:h-1.5 w-full overflow-hidden rounded-full bg-white/20">
                <div
                  className={`h-full rounded-full ${
                    gestureHud.type === 'brightness'
                      ? 'bg-amber-400'
                      : 'bg-[#E11D48]'
                  }`}
                  style={{
                    width: `${
                      gestureHud.type === 'brightness'
                        ? Math.round(((gestureHud.percent - 20) / 130) * 100)
                        : gestureHud.percent
                    }%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Double-Tap Seek Visual Feedback (Left -10s / Right +10s) */}
      {seekFeedback && (
        <div
          key={seekFeedback.nonce}
          className={`pointer-events-none absolute inset-y-0 z-[15] flex w-[42%] items-center justify-center bg-black/55 ${
            seekFeedback.side === 'left'
              ? 'left-0 rounded-r-full'
              : 'right-0 rounded-l-full'
          }`}
        >
          <div className="flex flex-col items-center gap-1 sm:gap-1.5 text-white">
            <div className="flex h-9 w-9 sm:h-12 sm:w-12 items-center justify-center rounded-full bg-black/70 border border-white/25">
              {seekFeedback.side === 'left' ? (
                <RotateCcw className="h-4 w-4 sm:h-6 sm:w-6" />
              ) : (
                <RotateCw className="h-4 w-4 sm:h-6 sm:w-6" />
              )}
            </div>
            <span className="font-mono text-xs sm:text-sm font-bold tracking-tight tabular-nums">
              {seekFeedback.side === 'left'
                ? `-${seekFeedback.totalSec}s`
                : `+${seekFeedback.totalSec}s`}
            </span>
          </div>
        </div>
      )}

      {/* Center Play Indicator When Paused */}
      {!isPlaying && !buffering && !hasError && !openMenu && !controlsLocked && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            togglePlayPause();
          }}
          aria-label="Resume playback"
          className="absolute left-1/2 top-1/2 z-[15] -translate-x-1/2 -translate-y-1/2 flex h-11 w-11 sm:h-16 sm:w-16 items-center justify-center rounded-full bg-[#E11D48] text-white shadow-lg ring-2 sm:ring-4 ring-white/20 transition-transform hover:scale-105 active:scale-95"
        >
          <Play className="ml-0.5 sm:ml-1 h-5 w-5 sm:h-7 sm:w-7 fill-current" />
        </button>
      )}

      {/* Embedded High-Visibility Subtitle Overlay */}
      {subtitlesEnabled && activeCueText && (
        <div className="pointer-events-none absolute inset-x-4 bottom-10 sm:bottom-16 z-20 flex justify-center text-center">
          <div
            className={`rounded-md bg-black/85 px-3.5 py-1.5 font-medium leading-relaxed shadow-md ${
              subtitleSize === 'small'
                ? 'text-xs sm:text-sm'
                : subtitleSize === 'large'
                  ? 'text-base sm:text-2xl'
                  : 'text-sm sm:text-lg'
            } ${
              subtitleColor === 'yellow'
                ? 'text-[#F5C518]'
                : subtitleColor === 'cyan'
                  ? 'text-cyan-300'
                  : 'text-white'
            }`}
            style={{
              textShadow: '0 2px 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)',
            }}
          >
            {activeCueText}
          </div>
        </div>
      )}

      {/* Buffering Indicator */}
      {buffering && !hasError && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/55">
          <LoadingSpinner
            size="lg"
            label={
              playback.isOffline
                ? 'Preparing offline video...'
                : preparingBuffer
                  ? `Pre-buffering ${activeQualityShortLabel} stream on server...`
                  : 'Buffering stream...'
            }
            sublabel={
              playback.isOffline
                ? 'Playing from local offline storage'
                : selectedQuality !== 'auto'
                  ? `Adaptive HLS stream (${activeQualityShortLabel})`
                  : 'Direct adaptive stream'
            }
          />
        </div>
      )}

      {/* Playback Error Overlay */}
      {hasError && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/85 px-6"
        >
          <div className="max-w-md text-center">
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-[#E11D48]" />
            <p className="font-display text-lg font-semibold text-white">
              Playback Error
            </p>
            <p className="mt-2 text-xs sm:text-sm text-slate-300 leading-relaxed">
              {playback.isOffline
                ? offlineErrorMsg || 'Offline video failed to play in this browser/WebView.'
                : 'Stream Not Available Right Now! We Are Working On It'}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-[#E11D48] px-5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[#BE123C]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>{playback.isOffline ? 'Retry Offline Video' : 'Retry Stream'}</span>
              </button>
              {!playback.isOffline && selectedQuality !== '360p' && (
                <button
                  type="button"
                  onClick={() => handleSelectQuality(selectedQuality === 'auto' ? '720p' : '360p')}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>
                    {selectedQuality === 'auto' ? 'Try 720p Buffered MP4' : 'Try 360p Low-Buffer'}
                  </span>
                </button>
              )}
              {!playback.isOffline && selectedQuality !== 'auto' && (
                <button
                  type="button"
                  onClick={() => handleSelectQuality('auto')}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>Direct Stream (Auto)</span>
                </button>
              )}
              {androidNative && !playback.isOffline && (
                <button
                  type="button"
                  onClick={() => handleLaunchAndroidPlayer('chooser')}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Open in External Player</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Top Overlay Header Bar */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-1.5 sm:gap-3 bg-gradient-to-b from-black/80 via-black/35 to-transparent px-2 sm:px-4 pt-1.5 sm:pt-3 pb-3.5 sm:pb-7 transition-opacity duration-200 ${
          !controlsLocked && (controlsVisible || openMenu)
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs text-slate-300">
            {isLiveStream && (
              <span className="inline-flex items-center gap-1 font-semibold text-[#E11D48]">
                <Radio className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                <span>Live</span>
              </span>
            )}
            {playback.isOffline && (
              <span className="font-semibold text-emerald-400">Offline Copy</span>
            )}
            {isCatchupStream && (
              <span className="font-semibold text-amber-300">Catch-up Replay</span>
            )}
            {playback.seasonNum !== undefined && playback.episodeNum !== undefined && (
              <span className="font-mono text-slate-300 tabular-nums">
                S{String(playback.seasonNum).padStart(2, '0')} · E
                {String(playback.episodeNum).padStart(2, '0')}
              </span>
            )}
            <p className="truncate font-medium text-white text-[11px] sm:text-sm">
              {playback.title}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {isCatchupStream && onReturnToLive && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReturnToLive();
              }}
              className="inline-flex h-7 sm:min-h-[36px] sm:h-auto items-center gap-1 sm:gap-1.5 rounded-md sm:rounded-lg bg-[#E11D48] px-2 sm:px-3 text-[10px] sm:text-xs font-semibold text-white hover:bg-[#BE123C] whitespace-nowrap"
            >
              <Radio className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              <span>Return to Live</span>
            </button>
          )}

          {/* Subtitles Button for Movies & Series */}
          {isVodStream && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu((m) => (m === 'subtitles' ? null : 'subtitles'));
              }}
              title="Subtitles"
              className={`inline-flex h-7 sm:min-h-[36px] sm:h-auto items-center gap-1 sm:gap-1.5 rounded-md sm:rounded-lg border px-2 sm:px-3 text-[10px] sm:text-xs font-medium transition-colors whitespace-nowrap ${
                openMenu === 'subtitles' || (subtitlesEnabled && activeSubtitle)
                  ? 'border-[#E11D48] bg-[#E11D48]/80 text-white'
                  : 'border-white/15 bg-black/65 text-slate-200 hover:bg-black/85'
              }`}
            >
              <Subtitles className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              <span className="hidden sm:inline">
                {subtitlesEnabled && activeSubtitle ? activeSubtitle.language : 'Subtitles'}
              </span>
            </button>
          )}

          {/* Languages Button for Audio / Catalog Editions */}
          {hasMultipleLanguages && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu((m) => (m === 'languages' ? null : 'languages'));
              }}
              className={`inline-flex h-7 sm:min-h-[36px] sm:h-auto items-center gap-1 sm:gap-1.5 rounded-md sm:rounded-lg border px-2 sm:px-3 text-[10px] sm:text-xs font-medium transition-colors whitespace-nowrap ${
                openMenu === 'languages'
                  ? 'border-[#E11D48] bg-[#E11D48] text-white'
                  : 'border-white/15 bg-black/65 text-slate-100 hover:bg-black/85'
              }`}
            >
              <Languages className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              {languageData?.activeLanguage && languageData.activeLanguage !== 'Original' ? (
                <span>{languageData.activeLanguage}</span>
              ) : (
                <>
                  <span className="sm:hidden">Audio</span>
                  <span className="hidden sm:inline">Audio / Languages</span>
                </>
              )}
            </button>
          )}

          {/* Android-Only Pure JS System Player Chooser Intent */}
          {androidNative && !playback.isOffline && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleLaunchAndroidPlayer('chooser');
              }}
              title="Open in External Player"
              aria-label="Open in External Player"
              className="inline-flex h-7 sm:min-h-[36px] sm:h-auto items-center gap-1 sm:gap-1.5 rounded-md sm:rounded-lg border border-white/15 bg-black/65 px-2 sm:px-3 text-[10px] sm:text-xs font-medium text-slate-100 hover:bg-black/85 transition-colors whitespace-nowrap"
            >
              <ExternalLink className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              <span className="hidden sm:inline">Open in External Player</span>
            </button>
          )}

          {/* Episodes Quick-Switch Drawer */}
          {playback.kind === 'episode' &&
            playback.seriesDetail &&
            seasonKeys.length > 0 &&
            onSelectEpisode && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu((m) => (m === 'episodes' ? null : 'episodes'));
                }}
                className={`inline-flex h-7 sm:min-h-[36px] sm:h-auto items-center gap-1 sm:gap-1.5 rounded-md sm:rounded-lg border px-2 sm:px-3 text-[10px] sm:text-xs font-medium transition-colors whitespace-nowrap ${
                  openMenu === 'episodes'
                    ? 'border-[#E11D48] bg-[#E11D48] text-white'
                    : 'border-white/15 bg-black/65 text-slate-100 hover:bg-black/85'
                }`}
              >
                <ListVideo className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                <span>Episodes</span>
              </button>
            )}
        </div>
      </div>

      {/* Subtitles Downloader & Sync Popover Menu (MovieBox-style) */}
      {openMenu === 'subtitles' && (
        <div
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-2 sm:right-3 top-9 sm:top-14 z-30 w-[20.5rem] sm:w-[24.5rem] max-w-[calc(100%-1rem)] max-h-[calc(100%-2.75rem)] flex flex-col overflow-hidden rounded-xl border border-white/15 bg-[#0F131D] shadow-lg"
        >
          {/* Sticky Header */}
          <div className="flex items-center justify-between border-b border-white/[0.08] px-3.5 py-2.5 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Subtitles className="h-4 w-4 text-[#E11D48] shrink-0" />
              <div className="min-w-0">
                <span className="text-xs font-semibold text-white block">
                  Subtitles &amp; Sync
                </span>
                <span className="text-[10px] text-slate-400 truncate block">
                  {subtitlesEnabled && activeSubtitle
                    ? `Active: ${activeSubtitle.language}`
                    : 'Subtitles Off'}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpenMenu(null)}
              className="min-h-[32px] px-2.5 rounded-lg text-[11px] font-medium text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
            >
              Close
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
            {/* Enable / Disable toggle */}
            <div className="flex items-center justify-between rounded-xl bg-white/[0.05] px-3 py-2 border border-white/10">
              <span className="text-xs font-medium text-slate-200">Display Subtitles</span>
              <button
                type="button"
                aria-label="Toggle subtitles display"
                onClick={() => setSubtitlesEnabled((v) => !v)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                  subtitlesEnabled ? 'bg-[#E11D48]' : 'bg-white/20'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                    subtitlesEnabled ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Timing Sync Adjustment & Appearance */}
            {subtitlesEnabled && activeSubtitle && subtitleCues.length > 0 && (
              <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.04] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-slate-300">
                    Subtitle Timing Sync
                  </span>
                  <span className="font-mono text-[11px] font-semibold text-rose-300 tabular-nums">
                    {subtitleOffsetSec === 0
                      ? '0.0s Synced'
                      : subtitleOffsetSec > 0
                        ? `+${subtitleOffsetSec.toFixed(1)}s Later`
                        : `${subtitleOffsetSec.toFixed(1)}s Earlier`}
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const next = Math.round((subtitleOffsetSec - 2) * 10) / 10;
                      setSubtitleOffsetSec(next);
                      updateDownloadedSubtitleOffset(subtitleStreamKey, activeSubtitle.id, next);
                    }}
                    className="h-8 rounded-lg bg-white/[0.07] text-[11px] font-mono font-semibold text-slate-200 hover:bg-white/15 tabular-nums"
                  >
                    -2.0s
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const next = Math.round((subtitleOffsetSec - 0.5) * 10) / 10;
                      setSubtitleOffsetSec(next);
                      updateDownloadedSubtitleOffset(subtitleStreamKey, activeSubtitle.id, next);
                    }}
                    className="inline-flex h-8 items-center justify-center gap-0.5 rounded-lg bg-white/[0.07] text-[11px] font-mono font-semibold text-slate-200 hover:bg-white/15 tabular-nums"
                  >
                    <Minus className="h-3 w-3" />
                    <span>0.5s</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSubtitleOffsetSec(0);
                      updateDownloadedSubtitleOffset(subtitleStreamKey, activeSubtitle.id, 0);
                    }}
                    className="h-8 rounded-lg border border-white/15 bg-white/[0.04] text-[11px] font-semibold text-slate-300 hover:bg-white/15"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const next = Math.round((subtitleOffsetSec + 0.5) * 10) / 10;
                      setSubtitleOffsetSec(next);
                      updateDownloadedSubtitleOffset(subtitleStreamKey, activeSubtitle.id, next);
                    }}
                    className="inline-flex h-8 items-center justify-center gap-0.5 rounded-lg bg-white/[0.07] text-[11px] font-mono font-semibold text-slate-200 hover:bg-white/15 tabular-nums"
                  >
                    <Plus className="h-3 w-3" />
                    <span>0.5s</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const next = Math.round((subtitleOffsetSec + 2) * 10) / 10;
                      setSubtitleOffsetSec(next);
                      updateDownloadedSubtitleOffset(subtitleStreamKey, activeSubtitle.id, next);
                    }}
                    className="h-8 rounded-lg bg-white/[0.07] text-[11px] font-mono font-semibold text-slate-200 hover:bg-white/15 tabular-nums"
                  >
                    +2.0s
                  </button>
                </div>
              </div>
            )}

            {subtitlesEnabled && (
              <div className="space-y-2 border-t border-white/[0.08] pt-2.5">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>Color</span>
                  <div className="flex items-center gap-1">
                    {(['white', 'yellow', 'cyan'] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setSubtitleColor(c)}
                        className={`h-7 px-2.5 rounded-md text-[10px] uppercase font-semibold transition-colors ${
                          subtitleColor === c
                            ? 'bg-white/25 text-white border border-white/40'
                            : 'bg-white/5 text-slate-400 hover:text-white'
                        }`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>Size</span>
                  <div className="flex items-center gap-1">
                    {(['small', 'normal', 'large'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSubtitleSize(s)}
                        className={`h-7 px-2.5 rounded-md text-[10px] capitalize font-semibold transition-colors ${
                          subtitleSize === s
                            ? 'bg-white/25 text-white border border-white/40'
                            : 'bg-white/5 text-slate-400 hover:text-white'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Downloaded Subtitles (Saved Locally for This Video) */}
            {!playback.isOffline && downloadedSubs.length > 0 && (
              <div className="space-y-1.5 border-t border-white/[0.08] pt-2.5">
                <p className="text-[11px] font-semibold text-slate-300">
                  Downloaded ({downloadedSubs.length})
                </p>
                <div className="space-y-1">
                  {downloadedSubs.map((rec) => {
                    const isCurrent = activeSubtitle?.id === rec.id && subtitlesEnabled;
                    return (
                      <div
                        key={rec.id}
                        className={`flex items-center justify-between gap-2 rounded-xl px-2.5 py-2 border transition-colors ${
                          isCurrent
                            ? 'bg-[#E11D48]/20 border-[#E11D48]/50 text-white'
                            : 'bg-white/[0.04] border-white/[0.08] text-slate-300 hover:bg-white/[0.08]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            const cues = parseVttCues(rec.vttText);
                            setActiveSubtitle({
                              id: rec.id,
                              language: rec.language,
                              languageCode: rec.languageCode,
                              label: rec.label,
                              format: rec.format,
                              fileName: rec.fileName,
                              source: rec.source,
                              downloadUrl: '',
                              vttUrl: `cached:${rec.id}`,
                            });
                            setSubtitleCues(cues);
                            setSubtitleOffsetSec(rec.offsetSec || 0);
                            setSubtitlesEnabled(true);
                            setPreferredActiveSubtitleId(subtitleStreamKey, rec.id);
                          }}
                          className="flex flex-1 min-w-0 items-center justify-between gap-2 text-left"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold truncate">{rec.language}</div>
                            <div className="text-[10px] text-slate-400 truncate">
                              {rec.fileName ||
                                (rec.source === 'custom' ? 'Local subtitle file' : 'Synced offline')}
                            </div>
                          </div>
                          {isCurrent ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-rose-300 shrink-0">
                              <Check className="h-3.5 w-3.5" />
                              <span>Active</span>
                            </span>
                          ) : (
                            <span className="text-[10px] font-medium text-slate-400 shrink-0">
                              Use
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${rec.language} downloaded subtitle`}
                          onClick={() => {
                            removeDownloadedSubtitle(subtitleStreamKey, rec.id);
                            setDownloadedSubs(getDownloadedSubtitlesForStream(subtitleStreamKey));
                            if (activeSubtitle?.id === rec.id) {
                              setActiveSubtitle(null);
                              setSubtitleCues([]);
                              setActiveCueText('');
                            }
                          }}
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Download Multi-Language Subtitles Online */}
            <div className="space-y-2 border-t border-white/[0.08] pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold text-slate-300">
                  Download Subtitles ({subtitles.length})
                </p>
                {!playback.isOffline && (
                  <>
                    <input
                      ref={subtitleFileInputRef}
                      type="file"
                      accept=".srt,.vtt,text/vtt,application/x-subrip"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        void file.text().then((rawText) => {
                          const vttText = convertClientSrtOrVttToVtt(rawText);
                          const cues = parseVttCues(vttText);
                          if (cues.length === 0) {
                            setSubtitleDownloadError(
                              'Selected file did not contain valid SRT/VTT cues.',
                            );
                            return;
                          }
                          const customId = `custom_${Date.now()}`;
                          const label = file.name.replace(/\.(srt|vtt)$/i, '') || 'Custom Subtitle';
                          saveDownloadedSubtitle({
                            id: customId,
                            streamKey: subtitleStreamKey,
                            language: 'Custom File',
                            languageCode: 'en',
                            label,
                            fileName: file.name,
                            format: 'vtt',
                            source: 'custom',
                            vttText,
                            offsetSec: 0,
                          });
                          setDownloadedSubs(getDownloadedSubtitlesForStream(subtitleStreamKey));
                          setActiveSubtitle({
                            id: customId,
                            language: 'Custom File',
                            languageCode: 'en',
                            label,
                            format: 'vtt',
                            fileName: file.name,
                            source: 'custom',
                            downloadUrl: '',
                            vttUrl: `cached:${customId}`,
                          });
                          setSubtitleCues(cues);
                          setSubtitleOffsetSec(0);
                          setSubtitlesEnabled(true);
                          setSubtitleDownloadError('');
                          showTemporaryGestureHud(
                            { type: 'badge', label: 'Subtitles Synced', value: file.name },
                            1400,
                          );
                        });
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => subtitleFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/[0.06] px-2 py-1 text-[10px] font-semibold text-slate-200 hover:bg-white/15"
                    >
                      <Upload className="h-3 w-3" />
                      <span>Load .SRT / .VTT</span>
                    </button>
                  </>
                )}
              </div>

              {/* Filter & Custom Title Search */}
              {!playback.isOffline && (
                <div className="space-y-1.5">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setSubtitleSearchQuery(subtitleSearchInput.trim());
                    }}
                    className="flex items-center gap-1.5"
                  >
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                      <input
                        type="search"
                        value={subtitleSearchInput}
                        onChange={(e) => setSubtitleSearchInput(e.target.value)}
                        placeholder="Search another title or release..."
                        className="h-8 w-full rounded-lg border border-white/10 bg-black/40 pl-7 pr-2.5 text-[11px] text-white placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      className="h-8 rounded-lg bg-white/10 px-2.5 text-[11px] font-semibold text-white hover:bg-[#E11D48] transition-colors shrink-0"
                    >
                      Search
                    </button>
                  </form>

                  {subtitles.length > 6 && (
                    <input
                      type="search"
                      value={subtitleLangFilter}
                      onChange={(e) => setSubtitleLangFilter(e.target.value)}
                      placeholder="Filter language (English, Hindi, Arabic, Spanish...)"
                      className="h-8 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 text-[11px] text-white placeholder:text-slate-500 focus:border-[#E11D48] focus:outline-none"
                    />
                  )}
                </div>
              )}

              {subtitleDownloadError && (
                <p className="rounded-lg border border-rose-500/35 bg-rose-950/50 px-2.5 py-1.5 text-[11px] text-rose-200">
                  {subtitleDownloadError}
                </p>
              )}

              {subtitlesLoading ? (
                <p className="py-3 text-center text-xs text-slate-400">
                  Searching multi-language subtitles...
                </p>
              ) : subtitles.length === 0 ? (
                <p className="py-3 text-center text-xs text-slate-400">
                  No online subtitles matched automatically. Try searching the movie/series title above or load a local .SRT/.VTT file.
                </p>
              ) : (
                <div className="max-h-52 overflow-y-auto space-y-1 pr-1">
                  {subtitles
                    .filter((sub) => {
                      const q = subtitleLangFilter.trim().toLowerCase();
                      if (!q) return true;
                      return (
                        sub.language.toLowerCase().includes(q) ||
                        sub.languageCode.toLowerCase().includes(q) ||
                        (sub.fileName || '').toLowerCase().includes(q)
                      );
                    })
                    .map((sub) => {
                      const isCurrent = activeSubtitle?.id === sub.id && subtitlesEnabled;
                      const isCached = downloadedSubs.some((d) => d.id === sub.id);
                      const isDownloading = downloadingSubId === sub.id;
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          disabled={isDownloading}
                          onClick={() => void downloadAndSyncSubtitle(sub)}
                          className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors ${
                            isCurrent
                              ? 'bg-[#E11D48]/25 text-white border border-[#E11D48]/50'
                              : 'bg-white/[0.03] border border-transparent text-slate-200 hover:bg-white/[0.08]'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-semibold truncate">
                                {sub.language}
                              </span>
                              {typeof sub.downloads === 'number' && sub.downloads > 0 && (
                                <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
                                  · {formatNumber(sub.downloads)} dl
                                </span>
                              )}
                            </div>
                            {sub.fileName && (
                              <div className="text-[10px] text-slate-400 truncate mt-0.5">
                                {sub.fileName}
                              </div>
                            )}
                          </div>

                          <span
                            className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-semibold ${
                              isCurrent
                                ? 'bg-[#E11D48] text-white'
                                : isCached
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                  : 'bg-white/10 text-slate-100'
                            }`}
                          >
                            {isDownloading ? (
                              <span>Syncing...</span>
                            ) : isCurrent ? (
                              <>
                                <Check className="h-3 w-3" />
                                <span>Active</span>
                              </>
                            ) : isCached ? (
                              <>
                                <Check className="h-3 w-3" />
                                <span>Saved</span>
                              </>
                            ) : (
                              <>
                                <Download className="h-3 w-3" />
                                <span>Download</span>
                              </>
                            )}
                          </span>
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Languages / Audio Selector Popover */}
      {openMenu === 'languages' && (
        <div
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-2 sm:right-3 top-9 sm:top-14 z-30 w-64 sm:w-72 max-h-[70%] overflow-y-auto rounded-xl border border-white/15 bg-[#0F131D] p-2.5 sm:p-3 shadow-lg space-y-2.5 sm:space-y-3"
        >
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
            <span className="text-xs font-semibold text-white">Audio & Languages</span>
            <button
              type="button"
              onClick={() => setOpenMenu(null)}
              className="text-[11px] text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>

          {languagesLoading ? (
            <p className="py-3 text-xs text-slate-400">Checking available languages...</p>
          ) : (
            <div className="space-y-3">
              {catalogVariants.length > 1 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium text-slate-400">Available Language Editions</p>
                  {catalogVariants.map((variant, idx) => (
                    <button
                      key={`${variant.kind}:${variant.id}`}
                      type="button"
                      onClick={() => handleSelectCatalogVariant(idx)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                        variant.isCurrent
                          ? 'bg-[#E11D48]/20 text-white border border-[#E11D48]/50'
                          : 'text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <span className="truncate">{variant.language}</span>
                      {variant.isCurrent && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-[#E11D48]" />
                      )}
                    </button>
                  ))}
                </div>
              )}

              {nativeAudioTracks.length > 1 && (
                <div className="space-y-1.5 border-t border-white/[0.08] pt-2.5">
                  <p className="text-[11px] font-medium text-slate-400">Stream Audio Tracks</p>
                  {nativeAudioTracks.map((track) => (
                    <button
                      key={track.index}
                      type="button"
                      onClick={() => handleSelectNativeAudioTrack(track.index)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                        track.enabled
                          ? 'bg-[#E11D48]/20 text-white border border-[#E11D48]/50'
                          : 'text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <span className="truncate">{track.label}</span>
                      {track.enabled && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-[#E11D48]" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Video Quality Selector Popover (Auto / 1080p / 720p / 480p / 360p) */}
      {openMenu === 'quality' && !playback.isOffline && (
        <div
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-2 sm:right-3 bottom-11 sm:bottom-16 z-30 w-60 sm:w-72 max-h-[72%] overflow-y-auto rounded-xl border border-white/15 bg-[#0F131D] p-2.5 sm:p-3.5 shadow-lg space-y-2 sm:space-y-2.5"
        >
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
            <div className="flex items-center gap-1.5">
              <Settings2 className="h-4 w-4 text-[#E11D48]" />
              <span className="text-xs font-semibold text-white">Video Quality</span>
            </div>
            <button
              type="button"
              onClick={() => setOpenMenu(null)}
              className="text-[11px] text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="space-y-1">
            {VIDEO_QUALITY_OPTIONS.map((opt) => {
              const isCurrent = selectedQuality === opt.id;
              const upstreamMatch = streamVariantsData?.variants?.find(
                (v) =>
                  v.source === 'upstream-hls' &&
                  v.quality.toLowerCase() === opt.id.toLowerCase(),
              );
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSelectQuality(opt.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 sm:px-2.5 sm:py-2 text-left transition-colors ${
                    isCurrent
                      ? 'bg-[#E11D48]/25 text-white border border-[#E11D48]/50'
                      : 'text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-[11px] sm:text-xs font-semibold">{opt.label}</div>
                    <div className="text-[10px] text-slate-400">
                      {upstreamMatch
                        ? `Native HLS variant${
                            upstreamMatch.width && upstreamMatch.height
                              ? ` (${upstreamMatch.width}x${upstreamMatch.height})`
                              : upstreamMatch.height
                                ? ` (${upstreamMatch.height}p)`
                                : ''
                          }`
                        : opt.desc}
                    </div>
                  </div>
                  {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-[#E11D48]" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Aspect Ratio Selector Popover */}
      {openMenu === 'aspect' && (
        <div
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-2 sm:right-3 bottom-11 sm:bottom-16 z-30 w-56 sm:w-64 max-h-[72%] overflow-y-auto rounded-xl border border-white/15 bg-[#0F131D] p-2.5 sm:p-3.5 shadow-lg space-y-2 sm:space-y-2.5"
        >
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
            <div className="flex items-center gap-1.5">
              <Ratio className="h-4 w-4 text-[#E11D48]" />
              <span className="text-xs font-semibold text-white">Aspect Ratio</span>
            </div>
            <button
              type="button"
              onClick={() => setOpenMenu(null)}
              className="text-[11px] text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="space-y-1">
            {ASPECT_RATIO_OPTIONS.map((opt) => {
              const isCurrent = aspectMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSelectAspectMode(opt.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 sm:px-2.5 sm:py-2 text-left transition-colors ${
                    isCurrent
                      ? 'bg-[#E11D48]/25 text-white border border-[#E11D48]/50'
                      : 'text-slate-300 hover:bg-white/10'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-[11px] sm:text-xs font-semibold">{opt.label}</div>
                    <div className="text-[10px] text-slate-400">{opt.desc}</div>
                  </div>
                  {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-[#E11D48]" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Episodes Quick-Switch Drawer */}
      {openMenu === 'episodes' && playback.seriesDetail && onSelectEpisode && (
        <div
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-2 sm:right-3 top-9 sm:top-14 z-30 w-72 sm:w-80 max-w-[calc(100%-1rem)] max-h-[75%] flex flex-col overflow-hidden rounded-xl border border-white/15 bg-[#0F131D] shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2.5">
            <select
              aria-label="Select season"
              value={episodeSeasonTab}
              onChange={(e) => setEpisodeSeasonTab(e.target.value)}
              className="rounded border border-white/10 bg-[#171D2B] px-2.5 py-1 text-xs font-medium text-white focus:outline-none"
            >
              {seasonKeys.map((sKey) => (
                <option key={sKey} value={sKey}>
                  Season {sKey}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setOpenMenu(null)}
              className="text-[11px] text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {activeDrawerEpisodes.map((ep) => {
              const active = ep.episodeId === playback.id;
              return (
                <button
                  key={ep.episodeId}
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    onSelectEpisode(ep);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                    active
                      ? 'bg-[#E11D48] text-white font-semibold'
                      : 'text-slate-300 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <span className="font-mono shrink-0 tabular-nums">
                    E{String(ep.episodeNum).padStart(2, '0')}
                  </span>
                  <span className="truncate flex-1">{ep.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom Transport Controls Bar */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-2 sm:px-4 pb-1.5 sm:pb-3 pt-4 sm:pt-8 transition-opacity duration-200 ${
          !controlsLocked && (controlsVisible || !isPlaying || openMenu)
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
      >
        {isVodStream && totalDisplayDur > 0 && (
          <div className="mb-1 sm:mb-2.5 flex items-center gap-2 sm:gap-3">
            <input
              type="range"
              aria-label="Seek timeline"
              min={0}
              max={totalDisplayDur}
              step={1}
              value={Math.min(currentTime, totalDisplayDur)}
              onChange={(e) => seekTo(Number(e.target.value))}
              className="h-1 sm:h-1.5 flex-1 cursor-pointer accent-[#E11D48]"
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-1 sm:gap-2">
          <div className="flex items-center gap-0.5 sm:gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                togglePlayPause();
              }}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="inline-flex h-7 w-7 sm:h-10 sm:w-10 items-center justify-center rounded-md sm:rounded-lg text-white hover:bg-white/15 active:scale-95 transition-all touch-manipulation"
            >
              {isPlaying ? (
                <Pause className="h-3.5 w-3.5 sm:h-5 sm:w-5 fill-current" />
              ) : (
                <Play className="h-3.5 w-3.5 sm:h-5 sm:w-5 fill-current ml-0.5" />
              )}
            </button>

            {isVodStream && isFullscreen && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    triggerSeekStep('left', -10);
                  }}
                  aria-label="Rewind 10 seconds"
                  className="inline-flex h-7 w-7 sm:h-9 sm:w-9 items-center justify-center rounded-md sm:rounded-lg text-slate-200 hover:bg-white/15 active:scale-95 transition-all touch-manipulation"
                >
                  <RotateCcw className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    triggerSeekStep('right', 10);
                  }}
                  aria-label="Forward 10 seconds"
                  className="inline-flex h-7 w-7 sm:h-9 sm:w-9 items-center justify-center rounded-md sm:rounded-lg text-slate-200 hover:bg-white/15 active:scale-95 transition-all touch-manipulation"
                >
                  <RotateCw className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                </button>
              </>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleMute();
              }}
              aria-label={isMuted ? 'Unmute' : 'Mute'}
              className="inline-flex h-7 w-7 sm:h-9 sm:w-9 items-center justify-center rounded-md sm:rounded-lg text-slate-200 hover:bg-white/10"
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              ) : (
                <Volume2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              )}
            </button>

            <input
              type="range"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              className="hidden lg:block h-1 w-16 cursor-pointer accent-slate-200"
            />

            {isVodStream ? (
              <span className="ml-0.5 sm:ml-1 font-mono text-[10px] sm:text-xs text-slate-300 tabular-nums">
                {formatPlaybackTime(currentTime)}
                {totalDisplayDur > 0 ? ` / ${formatPlaybackTime(totalDisplayDur)}` : ''}
              </span>
            ) : (
              <span className="ml-0.5 sm:ml-1 text-[10px] sm:text-xs font-medium text-slate-300">
                {isCatchupStream ? 'Archive Stream' : 'Live Broadcast'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5 sm:gap-1.5">
            {Math.round(brightness * 100) !== 100 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  applyGestureBrightness(1);
                  scheduleHideGestureHud(650);
                }}
                title="Reset brightness to 100%"
                aria-label="Reset brightness to 100%"
                className="inline-flex h-7 sm:h-9 items-center gap-1 rounded-md sm:rounded-lg border border-amber-300/30 bg-black/55 px-1.5 sm:px-2 font-mono text-[10px] sm:text-[11px] font-semibold text-amber-300 tabular-nums hover:bg-black/80"
              >
                <Sun className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                <span>{Math.round(brightness * 100)}%</span>
              </button>
            )}

            {/* Video Quality Selector (Auto / 1080p / 720p / 480p / 360p) */}
            {!playback.isOffline && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu((m) => (m === 'quality' ? null : 'quality'));
                }}
                title="Video Quality (360p - 1080p)"
                aria-label="Video Quality"
                className={`inline-flex h-7 sm:h-9 items-center gap-1 rounded-md sm:rounded-lg border px-1.5 sm:px-2 text-[10px] sm:text-[11px] font-semibold transition-colors whitespace-nowrap ${
                  openMenu === 'quality' || selectedQuality !== 'auto'
                    ? 'border-[#E11D48]/70 bg-[#E11D48]/25 text-white'
                    : 'border-white/15 bg-black/50 text-slate-200 hover:bg-white/15'
                }`}
              >
                <Settings2 className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                <span>{activeQualityShortLabel}</span>
              </button>
            )}

            {/* Aspect Ratio Selector */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu((m) => (m === 'aspect' ? null : 'aspect'));
              }}
              title="Aspect Ratio"
              aria-label="Aspect Ratio"
              className={`inline-flex h-7 sm:h-9 items-center gap-1 rounded-md sm:rounded-lg border px-1.5 sm:px-2 text-[10px] sm:text-[11px] font-semibold transition-colors whitespace-nowrap ${
                openMenu === 'aspect' || aspectMode !== 'fit'
                  ? 'border-[#E11D48]/70 bg-[#E11D48]/25 text-white'
                  : 'border-white/15 bg-black/50 text-slate-200 hover:bg-white/15'
              }`}
            >
              <Ratio className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              <span className="hidden xs:inline sm:inline">{activeAspectShortLabel}</span>
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu(null);
                setControlsLocked(true);
                flashLockPrompt();
              }}
              title="Lock player gestures"
              aria-label="Lock player gestures"
              className="inline-flex h-7 w-7 sm:h-9 sm:w-9 items-center justify-center rounded-md sm:rounded-lg text-slate-200 hover:bg-white/10"
            >
              <Lock className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </button>

            {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  togglePip();
                }}
                aria-label="Picture in Picture"
                className="inline-flex h-7 w-7 sm:h-9 sm:w-9 items-center justify-center rounded-md sm:rounded-lg text-slate-200 hover:bg-white/10"
              >
                <PictureInPicture2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              </button>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleFullscreen();
              }}
              aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
              className="inline-flex h-7 w-7 sm:h-9 sm:w-9 items-center justify-center rounded-md sm:rounded-lg text-slate-200 hover:bg-white/10"
            >
              {isFullscreen ? (
                <Minimize className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              ) : (
                <Maximize className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
