import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Info,
  Play,
  Radio,
  Star,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useHoverTrailerPreview } from '../hooks/useHoverTrailerPreview';
import { MediaImage } from './MediaImage';

export interface VodHeroSlide {
  kind: 'movie' | 'series';
  id: string;
  kicker: string;
  title: string;
  categoryName?: string;
  language?: string;
  rating?: number;
  year?: string | null;
  metaText?: string;
  genre?: string;
  plot?: string;
  poster: string;
  backdrop: string;
  youtubeTrailer?: string;
  primaryActionLabel: string;
  secondaryActionLabel: string;
  onPrimaryAction: () => void;
  onSecondaryAction: () => void;
}

export interface LiveHeroSlide {
  kind: 'live';
  id: string;
  kicker: string;
  title: string;
  channelNumber?: number;
  categoryName?: string;
  logo: string;
  hasArchive?: boolean;
  hasEpg?: boolean;
  nowPlayingTitle?: string;
  nowPlayingTime?: string;
  nowPlayingDescription?: string;
  nowPlayingProgress?: number;
  nextProgramTitle?: string;
  nextProgramTime?: string;
  primaryActionLabel: string;
  secondaryActionLabel?: string;
  onPrimaryAction: () => void;
  onSecondaryAction?: () => void;
}

export type HeroSlide = VodHeroSlide | LiveHeroSlide;

interface SpotlightHeroSliderProps {
  slides: HeroSlide[];
  ariaLabel: string;
  hoverPreviewEnabled?: boolean;
  compact?: boolean;
}

export function SpotlightHeroSlider({
  slides,
  ariaLabel,
  hoverPreviewEnabled = true,
  compact = false,
}: SpotlightHeroSliderProps) {
  const [heroIdx, setHeroIdx] = useState(0);
  const [heroPaused, setHeroPaused] = useState(false);

  const safeIdx = slides.length > 0 ? heroIdx % slides.length : 0;
  const activeSlide = slides[safeIdx] || slides[0];

  useEffect(() => {
    setHeroIdx(0);
  }, [slides.length, slides[0]?.id]);

  useEffect(() => {
    if (slides.length <= 1 || heroPaused) return;
    const timer = window.setInterval(() => {
      setHeroIdx((prev) => (prev + 1) % slides.length);
    }, 9000);
    return () => window.clearInterval(timer);
  }, [slides.length, heroPaused, safeIdx]);

  const vodSlide = activeSlide?.kind === 'live' ? null : activeSlide;
  const posterPreview = useHoverTrailerPreview({
    enabled: hoverPreviewEnabled && Boolean(vodSlide),
    kind: vodSlide?.kind === 'series' ? 'series' : 'movie',
    id: vodSlide?.id,
    initialTrailer: vodSlide?.youtubeTrailer,
  });

  if (!activeSlide) return null;

  const handlePrev = () => {
    if (slides.length <= 1) return;
    setHeroIdx((prev) => (prev - 1 + slides.length) % slides.length);
  };

  const handleNext = () => {
    if (slides.length <= 1) return;
    setHeroIdx((prev) => (prev + 1) % slides.length);
  };

  const minHeightClass = compact
    ? 'min-h-[340px] sm:min-h-[370px] lg:min-h-[395px]'
    : 'min-h-[420px] sm:min-h-[460px] lg:min-h-[500px]';

  return (
    <section
      aria-roledescription="carousel"
      aria-label={ariaLabel}
      onMouseEnter={() => setHeroPaused(true)}
      onMouseLeave={() => setHeroPaused(false)}
    >
      <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#0C0F17] shadow-[0_20px_50px_-24px_rgba(15,23,42,0.16)] dark:shadow-[0_24px_60px_-24px_rgba(0,0,0,0.8)] transition-colors duration-200">
        <div
          className={`relative ${minHeightClass} flex flex-col justify-end px-5 sm:px-9 lg:px-12 pt-8 sm:pt-10 pb-6 sm:pb-7`}
        >
          {/* Theme-Synced Background Layer */}
          {activeSlide.kind === 'live' ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
            >
              <div className="absolute inset-0 bg-[radial-gradient(640px_340px_at_84%_32%,rgba(225,29,72,0.09),rgba(14,165,233,0.08),transparent_72%)] dark:bg-[radial-gradient(680px_360px_at_84%_32%,rgba(225,29,72,0.18),rgba(14,165,233,0.12),transparent_74%)]" />
              <div className="absolute inset-0 bg-gradient-to-r from-white via-white/95 to-transparent dark:from-[#0C0F17] dark:via-[#0C0F17]/92 dark:to-transparent" />
            </div>
          ) : (
            <div className="absolute inset-0 z-0 overflow-hidden">
              {slides.map((item, idx) => {
                if (item.kind === 'live') return null;
                const isCurrent = idx === safeIdx;
                return (
                  <div
                    key={item.id}
                    aria-hidden={!isCurrent}
                    className={`absolute inset-0 transition-all duration-700 ease-out ${
                      isCurrent
                        ? 'opacity-100 scale-100'
                        : 'opacity-0 scale-105 pointer-events-none'
                    }`}
                  >
                    <MediaImage
                      src={item.backdrop || item.poster}
                      alt={item.title}
                      title={item.title}
                      year={item.year ?? null}
                      variant="backdrop"
                      loading={idx === 0 ? 'eager' : 'lazy'}
                      className="h-full w-full"
                      imgClassName="h-full w-full object-cover object-center sm:object-[68%_center] opacity-85 dark:opacity-70"
                    />
                  </div>
                );
              })}
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-r from-white via-white/94 to-white/30 dark:from-[#0C0F17] dark:via-[#0C0F17]/88 dark:to-[#0C0F17]/20"
              />
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-white via-white/45 to-white/15 sm:via-white/10 sm:to-transparent dark:from-[#0C0F17] dark:via-[#0C0F17]/40 dark:to-[#0C0F17]/20"
              />
            </div>
          )}

          {/* Foreground Split Layout */}
          {activeSlide.kind === 'live' ? (
            <div className="relative z-10 flex w-full items-end justify-between gap-8 lg:gap-12">
              <div key={activeSlide.id} className="max-w-2xl flex-1 min-w-0">
                <div className="flex items-start gap-3.5 sm:gap-4">
                  {/* Compact Mobile / Tablet Channel Logo Tile */}
                  <div className="lg:hidden h-14 w-20 shrink-0 overflow-hidden rounded-xl border border-slate-200 dark:border-white/15 bg-slate-100 dark:bg-[#131824] p-2">
                    <MediaImage
                      src={activeSlide.logo}
                      alt={activeSlide.title}
                      title={activeSlide.title}
                      category={activeSlide.categoryName}
                      variant="logo"
                      className="h-full w-full"
                      imgClassName="h-full w-full object-contain"
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold tracking-wide text-[#E11D48] dark:text-rose-400">
                      <span className="inline-flex items-center gap-1.5">
                        <Radio className="h-3.5 w-3.5 shrink-0" />
                        <span>{activeSlide.kicker}</span>
                      </span>
                      {activeSlide.categoryName && (
                        <>
                          <span aria-hidden="true" className="text-slate-300 dark:text-white/30">
                            ·
                          </span>
                          <span className="text-slate-600 dark:text-slate-300 font-medium">
                            {activeSlide.categoryName}
                          </span>
                        </>
                      )}
                      {activeSlide.channelNumber ? (
                        <>
                          <span aria-hidden="true" className="text-slate-300 dark:text-white/30">
                            ·
                          </span>
                          <span className="font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                            CH {activeSlide.channelNumber}
                          </span>
                        </>
                      ) : null}
                    </p>

                    <h1 className="mt-2 font-display text-2xl sm:text-4xl lg:text-[2.5rem] font-bold tracking-tight text-slate-950 dark:text-white text-balance leading-[1.08]">
                      {activeSlide.title}
                    </h1>
                  </div>
                </div>

                {/* Live EPG Now Playing & Progress */}
                {activeSlide.nowPlayingTitle ? (
                  <div className="mt-4 max-w-xl space-y-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm sm:text-base font-semibold text-slate-800 dark:text-slate-100 line-clamp-1">
                        {activeSlide.nowPlayingTitle}
                      </p>
                      {activeSlide.nowPlayingTime && (
                        <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                          <Clock className="h-3 w-3" />
                          <span>{activeSlide.nowPlayingTime}</span>
                        </span>
                      )}
                    </div>

                    {typeof activeSlide.nowPlayingProgress === 'number' && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/15">
                        <div
                          className="h-full rounded-full bg-[#E11D48] transition-all duration-300"
                          style={{
                            width: `${Math.max(4, Math.min(100, activeSlide.nowPlayingProgress))}%`,
                          }}
                        />
                      </div>
                    )}

                    {activeSlide.nowPlayingDescription && (
                      <p className="text-xs sm:text-sm leading-relaxed text-slate-600 dark:text-slate-300/95 line-clamp-2">
                        {activeSlide.nowPlayingDescription}
                      </p>
                    )}

                    {activeSlide.nextProgramTitle && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-1">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          Up Next:
                        </span>{' '}
                        {activeSlide.nextProgramTitle}
                        {activeSlide.nextProgramTime ? ` · ${activeSlide.nextProgramTime}` : ''}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-sm sm:text-[15px] leading-relaxed text-slate-600 dark:text-slate-300 max-w-xl">
                    Live broadcast stream
                    {activeSlide.categoryName ? ` in ${activeSlide.categoryName}` : ''}
                    {activeSlide.hasArchive ? ' · Catch-up replay available' : ''}
                    {activeSlide.hasEpg ? ' · Interactive EPG guide supported' : ''}.
                  </p>
                )}

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={activeSlide.onPrimaryAction}
                    className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#E11D48] hover:bg-[#BE123C] px-6 text-sm font-semibold text-white shadow-lg shadow-[#E11D48]/25 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    <span>{activeSlide.primaryActionLabel}</span>
                  </button>

                  {activeSlide.onSecondaryAction && activeSlide.secondaryActionLabel && (
                    <button
                      type="button"
                      onClick={activeSlide.onSecondaryAction}
                      className="inline-flex h-11 items-center gap-2 rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#171D2B] px-5 text-sm font-semibold text-slate-800 dark:text-white transition-colors hover:bg-slate-100 dark:hover:bg-[#1F2739] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                    >
                      <Info className="h-4 w-4" />
                      <span>{activeSlide.secondaryActionLabel}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Desktop Live Channel Logo Showcase */}
              <div className="hidden lg:flex flex-col items-end shrink-0">
                <button
                  type="button"
                  onClick={activeSlide.onPrimaryAction}
                  aria-label={`Watch ${activeSlide.title} live`}
                  className="group relative flex w-72 xl:w-80 flex-col overflow-hidden rounded-2xl border border-slate-200/90 dark:border-white/15 bg-slate-50/90 dark:bg-[#131824] shadow-[0_24px_48px_-16px_rgba(15,23,42,0.18)] dark:shadow-[0_24px_54px_-12px_rgba(0,0,0,0.85)] transition-transform duration-300 hover:-translate-y-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                >
                  <div className="relative flex aspect-[16/10] w-full items-center justify-center p-6">
                    <MediaImage
                      src={activeSlide.logo}
                      alt={activeSlide.title}
                      title={activeSlide.title}
                      category={activeSlide.categoryName}
                      variant="logo"
                      className="h-full w-full"
                      imgClassName="h-full w-full object-contain transition-transform duration-300 group-hover:scale-105"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-slate-200/80 dark:border-white/[0.08] bg-white/85 dark:bg-[#0D111B] px-4 py-2.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                    <span className="truncate">
                      {activeSlide.hasArchive
                        ? 'Live + Catch-up'
                        : activeSlide.hasEpg
                          ? 'Live + EPG'
                          : 'Live Stream'}
                    </span>
                    <span className="font-mono text-[#E11D48] dark:text-rose-400 font-semibold shrink-0">
                      Tune In
                    </span>
                  </div>
                </button>
              </div>
            </div>
          ) : (
            <div className="relative z-10 flex w-full items-end justify-between gap-8 lg:gap-12">
              <div key={activeSlide.id} className="max-w-2xl flex-1 min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold tracking-wide text-[#E11D48] dark:text-rose-400">
                  <span>{activeSlide.kicker}</span>
                  {activeSlide.categoryName && (
                    <>
                      <span aria-hidden="true" className="text-slate-300 dark:text-white/30">
                        ·
                      </span>
                      <span className="text-slate-600 dark:text-slate-300 font-medium">
                        {activeSlide.categoryName}
                      </span>
                    </>
                  )}
                  {activeSlide.language && (
                    <>
                      <span aria-hidden="true" className="text-slate-300 dark:text-white/30">
                        ·
                      </span>
                      <span className="text-indigo-600 dark:text-sky-300 font-medium">
                        {activeSlide.language}
                      </span>
                    </>
                  )}
                </p>

                <h1 className="mt-2.5 font-display text-3xl sm:text-4xl lg:text-[2.75rem] font-bold tracking-tight text-slate-950 dark:text-white text-balance leading-[1.08]">
                  {activeSlide.title}
                </h1>

                <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-slate-600 dark:text-slate-300 tabular-nums">
                  {typeof activeSlide.rating === 'number' && activeSlide.rating > 0 && (
                    <span className="inline-flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-300">
                      <Star className="h-3.5 w-3.5 fill-amber-500 text-amber-500 dark:fill-amber-400 dark:text-amber-400" />
                      <span>{activeSlide.rating.toFixed(1)}</span>
                    </span>
                  )}
                  {activeSlide.year && (
                    <>
                      {typeof activeSlide.rating === 'number' && activeSlide.rating > 0 && (
                        <span aria-hidden="true" className="text-slate-300 dark:text-white/30">
                          ·
                        </span>
                      )}
                      <span className="font-medium text-slate-700 dark:text-slate-200">
                        {activeSlide.year}
                      </span>
                    </>
                  )}
                  {activeSlide.metaText && (
                    <>
                      <span aria-hidden="true" className="text-slate-300 dark:text-white/30">
                        ·
                      </span>
                      <span>{activeSlide.metaText}</span>
                    </>
                  )}
                  {activeSlide.genre && (
                    <>
                      <span aria-hidden="true" className="text-slate-300 dark:text-white/30">
                        ·
                      </span>
                      <span className="text-slate-500 dark:text-slate-400 line-clamp-1">
                        {activeSlide.genre}
                      </span>
                    </>
                  )}
                </div>

                {activeSlide.plot && (
                  <p className="mt-3.5 text-sm sm:text-[15px] leading-relaxed text-slate-600 dark:text-slate-300/95 line-clamp-2 sm:line-clamp-3 max-w-xl">
                    {activeSlide.plot}
                  </p>
                )}

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={activeSlide.onPrimaryAction}
                    className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#E11D48] hover:bg-[#BE123C] px-6 text-sm font-semibold text-white shadow-lg shadow-[#E11D48]/25 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0C0F17]"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    <span>{activeSlide.primaryActionLabel}</span>
                  </button>

                  <button
                    type="button"
                    onClick={activeSlide.onSecondaryAction}
                    className="inline-flex h-11 items-center gap-2 rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#171D2B] px-5 text-sm font-semibold text-slate-800 dark:text-white transition-colors hover:bg-slate-100 dark:hover:bg-[#1F2739] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                  >
                    <Info className="h-4 w-4" />
                    <span>{activeSlide.secondaryActionLabel}</span>
                  </button>
                </div>
              </div>

              {/* Desktop Framed Poster Card Preview */}
              <div className="hidden lg:flex flex-col items-end shrink-0">
                <div
                  onPointerEnter={posterPreview.onPointerEnter}
                  onPointerLeave={posterPreview.onPointerLeave}
                  className="group/poster relative aspect-[2/3] w-44 xl:w-52 overflow-hidden rounded-2xl border border-slate-200/90 dark:border-white/15 bg-slate-100 dark:bg-[#131824] shadow-[0_24px_48px_-14px_rgba(15,23,42,0.28)] dark:shadow-[0_24px_54px_-12px_rgba(0,0,0,0.85)] transition-transform duration-300 hover:-translate-y-1"
                >
                  <button
                    type="button"
                    onClick={() => {
                      posterPreview.cancelPreview();
                      activeSlide.onSecondaryAction();
                    }}
                    aria-label={`Inspect ${activeSlide.title}`}
                    className="block h-full w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E11D48]"
                  >
                    <MediaImage
                      src={activeSlide.poster || activeSlide.backdrop}
                      alt={activeSlide.title}
                      title={activeSlide.title}
                      year={activeSlide.year ?? null}
                      variant="poster"
                      className="h-full w-full"
                      imgClassName="h-full w-full object-cover transition-transform duration-300 group-hover/poster:scale-105"
                    />
                    {posterPreview.stage === 'playing' && posterPreview.trailerId && (
                      <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden bg-black">
                        <iframe
                          ref={posterPreview.iframeRef}
                          title={`${activeSlide.title} trailer preview`}
                          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(
                            posterPreview.trailerId,
                          )}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&enablejsapi=1&loop=1&playlist=${encodeURIComponent(
                            posterPreview.trailerId,
                          )}`}
                          allow="autoplay; encrypted-media; picture-in-picture"
                          tabIndex={-1}
                          className="pointer-events-none absolute left-1/2 top-1/2 h-full aspect-video min-w-full -translate-x-1/2 -translate-y-1/2 border-0"
                        />
                      </div>
                    )}
                    {posterPreview.stage === 'arming' && (
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0.5 bg-white/25">
                        <div className="animate-trailer-arm h-full w-full bg-[#E11D48]" />
                      </div>
                    )}
                  </button>
                  {posterPreview.stage === 'playing' && posterPreview.trailerId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        posterPreview.toggleMute();
                      }}
                      aria-label={
                        posterPreview.muted
                          ? `Unmute ${activeSlide.title} trailer preview`
                          : `Mute ${activeSlide.title} trailer preview`
                      }
                      className="absolute bottom-2.5 right-2.5 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/25 bg-black/85 text-white shadow-sm transition-colors hover:border-[#E11D48] hover:bg-[#E11D48]"
                    >
                      {posterPreview.muted ? (
                        <VolumeX className="h-3.5 w-3.5" />
                      ) : (
                        <Volume2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Slide Progress & Navigation Footer */}
          {slides.length > 1 && (
            <div className="relative z-10 mt-6 flex items-center justify-between gap-4 border-t border-slate-900/[0.07] dark:border-white/[0.08] pt-4">
              <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {slides.map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setHeroIdx(idx)}
                    aria-label={`Show slide ${idx + 1}: ${item.title}`}
                    aria-current={idx === safeIdx ? 'true' : undefined}
                    className={`h-1.5 shrink-0 rounded-full transition-all duration-300 ${
                      idx === safeIdx
                        ? 'w-8 bg-[#E11D48]'
                        : 'w-2.5 bg-slate-300/90 dark:bg-white/25 hover:bg-slate-400 dark:hover:bg-white/55'
                    }`}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2.5 shrink-0">
                <span className="font-mono text-xs font-medium text-slate-500 dark:text-slate-400 tabular-nums">
                  {String(safeIdx + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handlePrev}
                    aria-label="Previous spotlight slide"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#171D2B] text-slate-700 dark:text-white transition-colors hover:border-[#E11D48]/40 hover:text-[#E11D48] dark:hover:border-white/30 dark:hover:bg-[#1F2739] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleNext}
                    aria-label="Next spotlight slide"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#171D2B] text-slate-700 dark:text-white transition-colors hover:border-[#E11D48]/40 hover:text-[#E11D48] dark:hover:border-white/30 dark:hover:bg-[#1F2739] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48]"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
