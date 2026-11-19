import { useMemo } from 'react';
import { Bookmark, Download, Languages, Loader2, Play, Star, Trash2, Volume2, VolumeX } from 'lucide-react';
import { useHoverTrailerPreview } from '../hooks/useHoverTrailerPreview';
import { isReleasedWithinDays } from '../utils/format';
import { MediaImage } from './MediaImage';

interface MediaCardProps {
  title: string;
  poster: string;
  saved?: boolean;
  rating?: number;
  language?: string;
  year?: string | null;
  qualityTag?: string | null;
  categoryName?: string;
  mediaType?: 'Movie' | 'Series' | 'Episode';
  metaParts?: string[];
  progressRatio?: number;
  hoverPreviewEnabled?: boolean;
  previewKind?: 'movie' | 'series';
  previewId?: string;
  initialTrailer?: string;
  onOpen: () => void;
  onQuickPlay?: () => void;
  onDownload?: () => void;
  downloadLabel?: string;
  onToggleSave?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  compactMobile?: boolean;
  isNew?: boolean;
  addedAt?: number;
  releaseDate?: string;
}

export function MediaCard({
  title,
  poster,
  saved = false,
  rating,
  language,
  year,
  qualityTag,
  categoryName,
  mediaType,
  metaParts = [],
  progressRatio,
  hoverPreviewEnabled = false,
  previewKind,
  previewId,
  initialTrailer,
  onOpen,
  onQuickPlay,
  onDownload,
  downloadLabel,
  onToggleSave,
  onRemove,
  removeLabel,
  compactMobile = false,
  isNew,
  addedAt,
  releaseDate,
}: MediaCardProps) {
  const {
    stage,
    trailerId,
    muted,
    iframeRef,
    toggleMute,
    onPointerEnter,
    onPointerLeave,
    cancelPreview,
  } = useHoverTrailerPreview({
    enabled: hoverPreviewEnabled,
    kind: previewKind,
    id: previewId,
    initialTrailer,
  });

  const cleanLanguage = (language || '').trim();
  const cleanCategory = (categoryName || '').trim();
  const cleanYear = (year || '').trim();
  const cleanQuality = (qualityTag || '').trim().toUpperCase();
  const hasRating = typeof rating === 'number' && Number.isFinite(rating) && rating > 0;
  const isPlayingTrailer = stage === 'playing' && Boolean(trailerId);

  // Deduplicate metadata parts and omit rating strings when rating ribbon is already shown
  const cleanMeta = metaParts
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      if (hasRating && part.startsWith('★')) return false;
      if (cleanYear && part === cleanYear) return false;
      return true;
    });

  const primaryLineParts = [cleanYear, ...cleanMeta].filter(Boolean);
  const pct =
    progressRatio !== undefined && progressRatio > 0
      ? Math.min(100, Math.max(4, Math.round(progressRatio * 100)))
      : 0;

  const showNewBadge = useMemo(() => {
    if (typeof isNew === 'boolean') return isNew;
    return isReleasedWithinDays({ added: addedAt, releaseDate });
  }, [isNew, addedAt, releaseDate]);

  return (
    <article
      className={`cinebox-card-elevated group relative flex h-full flex-col overflow-hidden border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] shadow-sm shadow-slate-900/5 dark:shadow-none ${
        compactMobile ? 'rounded-lg sm:rounded-xl' : 'rounded-xl'
      }`}
    >
      {/* Poster Container with Top-Corner Ribbons & Optional 1.5s Hover Trailer Preview */}
      <div
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        className="relative aspect-[2/3] w-full overflow-hidden bg-slate-100 dark:bg-[#0B0E17]"
      >
        <button
          type="button"
          onClick={() => {
            cancelPreview();
            (onQuickPlay || onOpen)();
          }}
          aria-label={`Open ${title}`}
          className="block h-full w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E11D48]"
        >
          <MediaImage
            src={poster}
            alt={title}
            title={title}
            year={year}
            variant="poster"
            className="h-full w-full"
            imgClassName="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
          />

          {/* Auto-Playing Short Muted Trailer Preview */}
          {isPlayingTrailer && trailerId && (
            <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden bg-black">
              <iframe
                ref={iframeRef}
                title={`${title} trailer preview`}
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(
                  trailerId,
                )}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&enablejsapi=1&loop=1&playlist=${encodeURIComponent(
                  trailerId,
                )}`}
                allow="autoplay; encrypted-media; picture-in-picture"
                tabIndex={-1}
                className="pointer-events-none absolute left-1/2 top-1/2 h-full aspect-video min-w-full -translate-x-1/2 -translate-y-1/2 border-0"
              />
            </div>
          )}

          {/* Contrast Scrims for Corner Ribbons & Bottom Edge */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-[6] h-16 bg-gradient-to-b from-black/55 via-black/20 to-transparent" />
          <div
            className={`pointer-events-none absolute inset-0 z-[6] bg-gradient-to-t from-black/80 via-black/15 to-transparent transition-opacity duration-200 ${
              isPlayingTrailer ? 'opacity-45' : 'opacity-55 group-hover:opacity-90'
            }`}
          />

          {/* Top-Left Corner Ribbon: Rating */}
          {hasRating && (
            <div
              className={`pointer-events-none absolute left-0 z-10 flex items-center rounded-r-md border-y border-r border-amber-400/45 bg-slate-950/90 font-bold text-amber-300 shadow-sm tabular-nums ${
                compactMobile
                  ? 'top-1.5 sm:top-2.5 gap-0.5 sm:gap-1 pl-1 sm:pl-2 pr-1.5 sm:pr-2.5 py-0.5 sm:py-1 text-[9px] sm:text-[11px]'
                  : 'top-2.5 gap-1 pl-2 pr-2.5 py-1 text-[11px]'
              }`}
            >
              <Star
                className={`fill-amber-400 text-amber-400 shrink-0 ${
                  compactMobile ? 'h-2.5 w-2.5 sm:h-3 sm:w-3' : 'h-3 w-3'
                }`}
              />
              <span>{rating.toFixed(1)}</span>
            </div>
          )}

          {/* Top-Right Corner Ribbon: Language */}
          {cleanLanguage && (
            <div
              className={`pointer-events-none absolute right-0 z-10 flex items-center gap-1 rounded-l-md border-y border-l border-white/20 bg-slate-950/90 font-semibold tracking-wide text-slate-100 shadow-sm ${
                compactMobile
                  ? 'top-1.5 sm:top-2.5 max-w-[58%] sm:max-w-[68%] pl-1.5 sm:pl-2.5 pr-1 sm:pr-2 py-0.5 sm:py-1 text-[9px] sm:text-[10px]'
                  : 'top-2.5 max-w-[68%] pl-2.5 pr-2 py-1 text-[10px]'
              }`}
            >
              <Languages
                className={`text-rose-400 shrink-0 ${
                  compactMobile ? 'hidden sm:block h-3 w-3' : 'h-3 w-3'
                }`}
              />
              <span className="truncate">{cleanLanguage}</span>
            </div>
          )}

          {/* Center Hover Play Affordance (Hidden when trailer is actively playing) */}
          {!isPlayingTrailer && (
            <div className="pointer-events-none absolute inset-0 z-[7] flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              <span
                className={`flex items-center justify-center rounded-full bg-[#E11D48] text-white shadow-md transform transition-transform duration-200 group-hover:scale-105 ${
                  compactMobile ? 'h-9 w-9 sm:h-12 sm:w-12' : 'h-12 w-12'
                }`}
              >
                <Play
                  className={`ml-0.5 fill-current ${
                    compactMobile ? 'h-4 w-4 sm:h-5 sm:w-5' : 'h-5 w-5'
                  }`}
                />
              </span>
            </div>
          )}

          {/* Hover Trailer Status Indicators */}
          {stage === 'loading' && (
            <div
              className={`pointer-events-none absolute right-2 z-10 flex items-center gap-1 rounded-md border border-white/15 bg-black/85 px-2 py-0.5 text-[10px] font-semibold text-slate-100 ${
                pct > 0 ? 'bottom-3' : 'bottom-2'
              }`}
            >
              <Loader2 className="h-3 w-3 animate-spin text-rose-400" />
              <span>Trailer</span>
            </div>
          )}

          {isPlayingTrailer && (
            <div
              className={`pointer-events-none absolute left-2 z-10 flex items-center gap-1.5 rounded-md border border-white/20 bg-black/85 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white ${
                pct > 0 ? 'bottom-3' : 'bottom-2'
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
              <span>Preview</span>
            </div>
          )}

          {stage === 'ended' && (
            <div
              className={`pointer-events-none absolute right-2 z-10 rounded-md border border-white/15 bg-black/85 px-2 py-0.5 text-[10px] font-medium text-slate-200 ${
                pct > 0 ? 'bottom-3' : 'bottom-2'
              }`}
            >
              Preview ended
            </div>
          )}

          {stage === 'unavailable' && (
            <div
              className={`pointer-events-none absolute right-2 z-10 rounded-md border border-white/15 bg-black/85 px-2 py-0.5 text-[10px] font-medium text-slate-300 ${
                pct > 0 ? 'bottom-3' : 'bottom-2'
              }`}
            >
              No trailer
            </div>
          )}

          {/* Bottom-Left Quality Mark (when present and trailer isn't occupying that slot) */}
          {cleanQuality && !isPlayingTrailer && (
            <div
              className={`pointer-events-none absolute z-10 rounded border border-white/20 bg-black/85 font-bold tracking-wider text-white ${
                compactMobile
                  ? 'left-1.5 sm:left-2 px-1 sm:px-1.5 py-0.5 text-[8px] sm:text-[10px]'
                  : 'left-2 px-1.5 py-0.5 text-[10px]'
              } ${pct > 0 ? 'bottom-3' : 'bottom-2'}`}
            >
              {cleanQuality}
            </div>
          )}

          {/* Subtle Bottom-Right New Badge (released or added within last 7 days) */}
          {showNewBadge && stage === 'idle' && (
            <div
              title="Recently added or released within the last 7 days"
              className={`pointer-events-none absolute z-10 rounded border border-emerald-400/35 bg-slate-950/85 font-semibold uppercase tracking-wider text-emerald-300 ${
                compactMobile
                  ? 'right-1.5 sm:right-2 px-1 sm:px-1.5 py-0.5 text-[8px] sm:text-[9px]'
                  : 'right-2 px-1.5 py-0.5 text-[9px]'
              } ${pct > 0 ? 'bottom-3' : 'bottom-2'}`}
            >
              New
            </div>
          )}

          {/* Subtle 1.5s Hover Countdown Progress Sweep */}
          {stage === 'arming' && (
            <div
              className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-white/20 ${
                pct > 0 ? 'bottom-1.5' : 'bottom-0'
              }`}
            >
              <div className="animate-trailer-arm h-full w-full bg-[#E11D48]" />
            </div>
          )}

          {/* Resume Progress Bar */}
          {pct > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1.5 bg-black/60">
              <div
                className="h-full bg-[#E11D48]"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </button>

        {/* Independent Mute / Unmute Toggle during Hover Preview */}
        {isPlayingTrailer && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleMute();
            }}
            aria-label={muted ? `Unmute ${title} trailer preview` : `Mute ${title} trailer preview`}
            title={muted ? 'Unmute preview' : 'Mute preview'}
            className={`absolute right-2 z-20 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-black/85 text-white shadow-sm transition-colors hover:border-rose-400 hover:bg-[#E11D48] ${
              pct > 0 ? 'bottom-3' : 'bottom-2'
            }`}
          >
            {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* Detailed Card Footer */}
      <div
        className={`flex flex-1 flex-col justify-between ${
          compactMobile ? 'gap-1.5 sm:gap-2 p-2 sm:p-3' : 'gap-2 p-3'
        }`}
      >
        <div
          className={`flex items-start justify-between ${
            compactMobile ? 'gap-1 sm:gap-2' : 'gap-2'
          }`}
        >
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] rounded"
          >
            <h3
              className={`font-semibold text-slate-900 dark:text-slate-100 line-clamp-1 group-hover:text-[#E11D48] dark:group-hover:text-rose-400 transition-colors ${
                compactMobile
                  ? 'text-[11px] sm:text-sm leading-tight sm:leading-snug'
                  : 'text-sm leading-snug'
              }`}
            >
              {title}
            </h3>
            {cleanCategory && (
              <p
                className={`mt-0.5 font-medium text-slate-500 dark:text-slate-400 truncate ${
                  compactMobile ? 'text-[10px] sm:text-[11px]' : 'text-[11px]'
                }`}
              >
                {cleanCategory}
              </p>
            )}
          </button>

          <div className="flex shrink-0 items-center gap-1">
            {onDownload && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelPreview();
                  onDownload();
                }}
                aria-label={downloadLabel || `Download episodes of ${title}`}
                title={downloadLabel || 'Download episodes'}
                className={`inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-600 dark:text-slate-300 transition-colors hover:border-[#E11D48]/50 hover:bg-rose-50 hover:text-[#E11D48] dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 ${
                  compactMobile ? 'h-6 w-6 sm:h-7 sm:w-7' : 'h-7 w-7'
                }`}
              >
                <Download className={compactMobile ? 'h-3 w-3 sm:h-3.5 sm:w-3.5' : 'h-3.5 w-3.5'} />
              </button>
            )}

            {onToggleSave && (
              <button
                type="button"
                onClick={onToggleSave}
                aria-label={saved ? `Remove ${title} from Watchlist` : `Add ${title} to Watchlist`}
                title={saved ? 'Remove from Watchlist' : 'Save to Watchlist'}
                className={`inline-flex items-center justify-center rounded-lg border transition-colors ${
                  compactMobile ? 'h-6 w-6 sm:h-7 sm:w-7' : 'h-7 w-7'
                } ${
                  saved
                    ? 'border-[#E11D48]/40 bg-[#E11D48]/12 text-[#E11D48] dark:border-rose-500/40 dark:bg-rose-500/20 dark:text-rose-300'
                    : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25 dark:hover:text-white'
                }`}
              >
                <Bookmark
                  className={`${compactMobile ? 'h-3 w-3 sm:h-3.5 sm:w-3.5' : 'h-3.5 w-3.5'} ${
                    saved ? 'fill-current' : ''
                  }`}
                />
              </button>
            )}

            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                aria-label={removeLabel || `Remove ${title}`}
                title={removeLabel || `Remove ${title}`}
                className={`inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-500 dark:text-slate-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 ${
                  compactMobile ? 'h-6 w-6 sm:h-7 sm:w-7' : 'h-7 w-7'
                }`}
              >
                <Trash2 className={compactMobile ? 'h-3 w-3 sm:h-3.5 sm:w-3.5' : 'h-3.5 w-3.5'} />
              </button>
            )}
          </div>
        </div>

        {(primaryLineParts.length > 0 || mediaType) && (
          <div
            className={`flex items-center justify-between border-t border-slate-100 dark:border-white/[0.06] text-slate-500 dark:text-slate-400 tabular-nums ${
              compactMobile
                ? 'gap-1 sm:gap-2 pt-1.5 sm:pt-2 text-[9px] sm:text-[11px]'
                : 'gap-2 pt-2 text-[11px]'
            }`}
          >
            <span className="truncate">
              {primaryLineParts.length > 0 ? primaryLineParts.join(' · ') : 'Stream'}
            </span>
            {mediaType && (
              <span className="shrink-0 font-semibold text-slate-600 dark:text-slate-300">
                {mediaType}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
