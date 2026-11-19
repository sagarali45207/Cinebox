import { useEffect, useState } from 'react';
import { Clapperboard, Film, Radio } from 'lucide-react';
import { fetchChannelLogo, fetchImdbPoster } from '../services/api';
import { proxiedImageUrl } from '../utils/format';

interface MediaImageProps {
  src?: string;
  alt: string;
  title?: string;
  year?: string | null;
  category?: string;
  variant?: 'poster' | 'backdrop' | 'logo';
  className?: string;
  imgClassName?: string;
  loading?: 'lazy' | 'eager';
}

const imdbPosterCache = new Map<string, string>();
const channelLogoCache = new Map<string, string | null>();

const LOGO_BADGE_GRADIENTS = [
  'from-rose-500 via-pink-500 to-indigo-600',
  'from-sky-500 via-blue-500 to-indigo-600',
  'from-emerald-500 via-teal-500 to-cyan-600',
  'from-amber-500 via-orange-500 to-rose-600',
  'from-violet-500 via-purple-500 to-fuchsia-600',
  'from-cyan-500 via-sky-500 to-blue-600',
];

function getChannelMonogram(rawName: string): { initials: string; gradient: string } {
  const cleaned = rawName
    .replace(/^[A-Z]{2,4}\s*[:|-]\s*/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(4K|UHD|FHD|HD|SD|HEVC|VIP|LIVE|TV)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9\s]+/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);
  let initials = 'TV';
  if (words.length >= 2) {
    initials = `${words[0][0]}${words[1][0]}`.toUpperCase();
  } else if (words.length === 1) {
    initials = words[0].slice(0, 3).toUpperCase();
  }

  let hash = 0;
  for (let i = 0; i < rawName.length; i++) {
    hash = (hash * 31 + rawName.charCodeAt(i)) >>> 0;
  }
  const gradient = LOGO_BADGE_GRADIENTS[hash % LOGO_BADGE_GRADIENTS.length];
  return { initials, gradient };
}

export function MediaImage({
  src,
  alt,
  title,
  year,
  category,
  variant = 'poster',
  className = '',
  imgClassName = 'h-full w-full object-cover',
  loading = 'lazy',
}: MediaImageProps) {
  const [failedOriginal, setFailedOriginal] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [failedFallback, setFailedFallback] = useState(false);

  const proxiedOriginal = proxiedImageUrl(src);
  const queryTitle = (title || alt || '').trim();

  useEffect(() => {
    setFailedOriginal(false);
    setFailedFallback(false);
    setFallbackUrl(null);
  }, [src, queryTitle, category]);

  // If original source is missing or fails, fetch IMDb poster (for movies/series) or authentic channel logo (for logos)
  useEffect(() => {
    const needsFallback = (!proxiedOriginal || failedOriginal) && !failedFallback && !fallbackUrl;
    if (!needsFallback || queryTitle.length < 2) return;

    if (variant === 'logo') {
      const cacheKey = `${queryTitle.toLowerCase()}__${(category || '').toLowerCase()}`;
      if (channelLogoCache.has(cacheKey)) {
        const cached = channelLogoCache.get(cacheKey);
        if (cached) {
          setFallbackUrl(cached);
        } else {
          setFailedFallback(true);
        }
        return;
      }

      const controller = new AbortController();
      fetchChannelLogo(queryTitle, category, controller.signal)
        .then((res) => {
          channelLogoCache.set(cacheKey, res.logo || null);
          if (res.logo) {
            setFallbackUrl(res.logo);
          } else {
            setFailedFallback(true);
          }
        })
        .catch((err) => {
          if (err?.name === 'AbortError') return;
          setFailedFallback(true);
        });

      return () => controller.abort();
    }

    const cacheKey = `${queryTitle.toLowerCase()}_${year || ''}`;
    if (imdbPosterCache.has(cacheKey)) {
      const cached = imdbPosterCache.get(cacheKey);
      if (cached) {
        setFallbackUrl(cached);
        return;
      }
    }

    const controller = new AbortController();
    fetchImdbPoster(queryTitle, year, controller.signal)
      .then((res) => {
        if (res.poster) {
          imdbPosterCache.set(cacheKey, res.poster);
          setFallbackUrl(res.poster);
        } else {
          setFailedFallback(true);
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setFailedFallback(true);
      });

    return () => controller.abort();
  }, [proxiedOriginal, failedOriginal, variant, queryTitle, year, category, failedFallback, fallbackUrl]);

  const activeSrc =
    !failedOriginal && proxiedOriginal
      ? proxiedOriginal
      : fallbackUrl
        ? proxiedImageUrl(fallbackUrl)
        : null;

  const FallbackIcon = variant === 'backdrop' ? Clapperboard : Film;
  const monogram = variant === 'logo' ? getChannelMonogram(alt || queryTitle) : null;

  return (
    <div
      className={`relative overflow-hidden bg-gradient-to-br from-slate-100 via-slate-50 to-indigo-50/70 dark:from-[#141926] dark:via-[#0F131D] dark:to-[#090B10] ${className}`}
    >
      {activeSrc ? (
        <img
          src={activeSrc}
          alt={alt}
          loading={loading}
          referrerPolicy="no-referrer"
          onError={() => {
            if (!failedOriginal && proxiedOriginal) {
              setFailedOriginal(true);
            } else {
              setFailedFallback(true);
            }
          }}
          className={imgClassName}
        />
      ) : variant === 'logo' && monogram ? (
        <div className="flex h-full w-full flex-col items-center justify-center p-2.5 text-center select-none">
          <div
            className={`relative mb-1.5 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${monogram.gradient} text-white shadow-md shadow-slate-900/15 dark:shadow-black/50`}
          >
            <span className="font-display text-sm font-extrabold tracking-tight">
              {monogram.initials}
            </span>
            <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-white dark:bg-[#111520] shadow">
              <Radio className="h-2.5 w-2.5 text-[#E11D48]" />
            </span>
          </div>
          <span className="line-clamp-1 max-w-full text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            {alt}
          </span>
        </div>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center p-3 text-center select-none">
          <FallbackIcon
            className="mb-1.5 h-6 w-6 shrink-0 text-slate-400 dark:text-slate-600"
            strokeWidth={1.6}
          />
          <span className="line-clamp-2 text-[11px] font-medium leading-snug text-slate-500 dark:text-slate-400">
            {alt}
          </span>
        </div>
      )}
    </div>
  );
}
