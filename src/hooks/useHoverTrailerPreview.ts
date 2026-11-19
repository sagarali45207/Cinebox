import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { fetchTrailerPreview } from '../services/api';
import { extractYouTubeId } from '../utils/format';

export type HoverTrailerStage =
  | 'idle'
  | 'arming'
  | 'loading'
  | 'playing'
  | 'ended'
  | 'unavailable';

const HOVER_DELAY_MS = 1550;
const PREVIEW_DURATION_MS = 20000;

const resolvedTrailerCache = new Map<string, string | null>();

interface UseHoverTrailerOptions {
  enabled?: boolean;
  kind?: 'movie' | 'series';
  id?: string;
  initialTrailer?: string;
}

interface UseHoverTrailerResult {
  stage: HoverTrailerStage;
  trailerId: string | null;
  muted: boolean;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  toggleMute: () => void;
  onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  cancelPreview: () => void;
}

export function useHoverTrailerPreview({
  enabled = false,
  kind,
  id,
  initialTrailer,
}: UseHoverTrailerOptions): UseHoverTrailerResult {
  const [stage, setStage] = useState<HoverTrailerStage>('idle');
  const [trailerId, setTrailerId] = useState<string | null>(() =>
    extractYouTubeId(initialTrailer),
  );
  const [muted, setMuted] = useState(true);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeHoverRef = useRef(false);

  const clearTimersAndRequests = useCallback(() => {
    if (armTimerRef.current !== null) {
      window.clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    if (durationTimerRef.current !== null) {
      window.clearTimeout(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const cancelPreview = useCallback(() => {
    activeHoverRef.current = false;
    clearTimersAndRequests();
    setStage('idle');
    setMuted(true);
  }, [clearTimersAndRequests]);

  // Reset cleanly if disabled or target changes
  useEffect(() => {
    if (!enabled) {
      cancelPreview();
    }
  }, [enabled, cancelPreview]);

  useEffect(() => {
    cancelPreview();
    setTrailerId(extractYouTubeId(initialTrailer));
    return () => {
      clearTimersAndRequests();
    };
  }, [kind, id, initialTrailer, cancelPreview, clearTimersAndRequests]);

  const startShortPlaybackTimer = useCallback(() => {
    if (durationTimerRef.current !== null) {
      window.clearTimeout(durationTimerRef.current);
    }
    durationTimerRef.current = window.setTimeout(() => {
      if (activeHoverRef.current) {
        setStage('ended');
      }
    }, PREVIEW_DURATION_MS);
  }, []);

  const resolveAndPlay = useCallback(async () => {
    if (!activeHoverRef.current || !kind || !id) return;

    const initialId = extractYouTubeId(initialTrailer);
    if (initialId) {
      setTrailerId(initialId);
      setStage('playing');
      startShortPlaybackTimer();
      return;
    }

    const cacheKey = `${kind}:${id}`;
    if (resolvedTrailerCache.has(cacheKey)) {
      const cached = resolvedTrailerCache.get(cacheKey) ?? null;
      if (cached) {
        setTrailerId(cached);
        setStage('playing');
        startShortPlaybackTimer();
      } else {
        setTrailerId(null);
        setStage('unavailable');
      }
      return;
    }

    setStage('loading');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetchTrailerPreview(kind, id, controller.signal);
      if (!activeHoverRef.current || controller.signal.aborted) return;

      const ytId = extractYouTubeId(res.youtubeTrailer);
      resolvedTrailerCache.set(cacheKey, ytId);

      if (ytId) {
        setTrailerId(ytId);
        setStage('playing');
        startShortPlaybackTimer();
      } else {
        setTrailerId(null);
        setStage('unavailable');
      }
    } catch {
      if (!activeHoverRef.current || controller.signal.aborted) return;
      setStage('unavailable');
    }
  }, [id, initialTrailer, kind, startShortPlaybackTimer]);

  const onPointerEnter = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !kind || !id) return;
      if (e.pointerType === 'touch') return;

      clearTimersAndRequests();
      activeHoverRef.current = true;
      setMuted(true);
      setStage('arming');

      armTimerRef.current = window.setTimeout(() => {
        armTimerRef.current = null;
        void resolveAndPlay();
      }, HOVER_DELAY_MS);
    },
    [enabled, kind, id, clearTimersAndRequests, resolveAndPlay],
  );

  const onPointerLeave = useCallback(() => {
    cancelPreview();
  }, [cancelPreview]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const nextMuted = !prev;
      const win = iframeRef.current?.contentWindow;
      if (win) {
        try {
          win.postMessage(
            JSON.stringify({
              event: 'command',
              func: nextMuted ? 'mute' : 'unMute',
              args: [],
            }),
            '*',
          );
        } catch {
          // Ignore cross-origin postMessage restrictions
        }
      }
      return nextMuted;
    });
  }, []);

  return {
    stage,
    trailerId,
    muted,
    iframeRef,
    toggleMute,
    onPointerEnter,
    onPointerLeave,
    cancelPreview,
  };
}
