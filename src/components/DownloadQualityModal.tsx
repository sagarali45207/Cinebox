import { useEffect, useState } from 'react';
import { Check, Download, HardDrive, Loader2, X } from 'lucide-react';
import { fetchDownloadSizes } from '../services/api';
import type {
  DownloadQuality,
  DownloadSizesResponse,
  QualitySizeEstimate,
  StreamVariantInfo,
} from '../types/media';
import { parseDurationHintToSeconds } from '../utils/format';
import { formatBytes } from '../utils/offlineDb';

export interface ResolvedDownloadSize extends QualitySizeEstimate {
  durationSec?: number;
}

interface DownloadQualityModalProps {
  open: boolean;
  kind?: 'movie' | 'episode' | 'series' | 'vod';
  mediaId?: string;
  extension?: string;
  title: string;
  subtitle?: string;
  itemCount?: number;
  durationHint?: string;
  initialQuality?: DownloadQuality;
  availableVariants?: StreamVariantInfo[];
  onClose: () => void;
  onConfirm: (quality: DownloadQuality, resolvedSize?: ResolvedDownloadSize) => void;
}

const QUALITY_OPTIONS: Array<{
  id: DownloadQuality;
  label: string;
  tier: string;
  description: string;
  bytesPerSec: number;
  fallbackPerHour: string;
}> = [
  {
    id: '360p',
    label: '360p · Data Saver',
    tier: 'SD',
    description: 'Compact storage and fastest download on mobile data',
    bytesPerSec: 90_000,
    fallbackPerHour: '~320 MB / hr',
  },
  {
    id: '480p',
    label: '480p · Standard',
    tier: 'SD+',
    description: 'Clear mobile viewing with moderate storage usage',
    bytesPerSec: 150_000,
    fallbackPerHour: '~540 MB / hr',
  },
  {
    id: '720p',
    label: '720p · High Definition',
    tier: 'HD',
    description: 'Sharp picture with balanced offline storage size',
    bytesPerSec: 220_000,
    fallbackPerHour: '~790 MB / hr',
  },
  {
    id: '1080p',
    label: '1080p · Full HD',
    tier: 'FHD',
    description: 'Maximum clarity for larger screens and tablets',
    bytesPerSec: 460_000,
    fallbackPerHour: '~1.6 GB / hr',
  },
];

export function DownloadQualityModal({
  open,
  kind,
  mediaId,
  extension,
  title,
  subtitle,
  itemCount = 1,
  durationHint,
  initialQuality = '720p',
  availableVariants,
  onClose,
  onConfirm,
}: DownloadQualityModalProps) {
  const [selected, setSelected] = useState<DownloadQuality>(initialQuality);
  const [probedSizes, setProbedSizes] = useState<DownloadSizesResponse | null>(null);
  const [probingSizes, setProbingSizes] = useState(false);

  const hintDurationSec = parseDurationHintToSeconds(durationHint);

  useEffect(() => {
    if (open) {
      setSelected(initialQuality);
    }
  }, [open, initialQuality]);

  useEffect(() => {
    if (!open || !kind || !mediaId) {
      setProbedSizes(null);
      setProbingSizes(false);
      return;
    }

    const controller = new AbortController();
    setProbingSizes(true);

    fetchDownloadSizes(
      {
        kind,
        id: mediaId,
        ext: extension,
        durationSec: hintDurationSec > 0 ? hintDurationSec : undefined,
      },
      controller.signal,
    )
      .then((res) => {
        setProbedSizes(res);
        setProbingSizes(false);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setProbingSizes(false);
      });

    return () => controller.abort();
  }, [open, kind, mediaId, extension, hintDurationSec]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const effectiveDurationSec =
    probedSizes?.durationSec && probedSizes.durationSec > 0
      ? probedSizes.durationSec
      : hintDurationSec;

  const effectiveOptions = (() => {
    if (!availableVariants || availableVariants.length === 0) return QUALITY_OPTIONS;
    const byId = new Map(QUALITY_OPTIONS.map((o) => [o.id.toLowerCase(), o]));
    const merged: typeof QUALITY_OPTIONS = [];
    for (const v of availableVariants) {
      const key = String(v.quality).toLowerCase();
      const preset = byId.get(key);
      const resLabel =
        v.width && v.height ? `${v.width}x${v.height}` : v.height ? `${v.height}p` : '';
      const bandwidth = v.bandwidth ?? 0;
      if (preset) {
        merged.push({
          ...preset,
          bytesPerSec: bandwidth > 0 ? Math.round(bandwidth / 8) : preset.bytesPerSec,
          description: resLabel
            ? `Stream variant (${resLabel}) · Direct source quality`
            : preset.description,
        });
      } else {
        const bps = bandwidth > 0 ? Math.round(bandwidth / 8) : 200_000;
        merged.push({
          id: v.quality,
          label: v.label || v.quality,
          tier: resLabel || 'HLS',
          description: 'Upstream source variant',
          bytesPerSec: bps,
          fallbackPerHour: `~${formatBytes(bps * 3600)} / hr`,
        });
      }
    }
    return merged.length > 0 ? merged : QUALITY_OPTIONS;
  })();

  const resolveOptionSize = (
    opt: (typeof QUALITY_OPTIONS)[number],
  ): ResolvedDownloadSize | undefined => {
    const serverSize =
      probedSizes?.sizes?.[opt.id as '360p' | '480p' | '720p' | '1080p'];
    if (serverSize && serverSize.bytes > 0) {
      return {
        ...serverSize,
        durationSec: effectiveDurationSec > 0 ? effectiveDurationSec : undefined,
      };
    }
    if (effectiveDurationSec > 0) {
      return {
        bytes: Math.round(effectiveDurationSec * opt.bytesPerSec),
        exact: false,
        mode: 'transcode',
        durationSec: effectiveDurationSec,
      };
    }
    return undefined;
  };

  const selectedOption =
    effectiveOptions.find((o) => o.id === selected) || effectiveOptions[0];
  const selectedSizeInfo = selectedOption
    ? resolveOptionSize(selectedOption)
    : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="download-quality-heading"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111520] shadow-lg overflow-hidden">
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-slate-300 dark:bg-white/20 sm:hidden" />

        <div className="flex items-start justify-between gap-4 border-b border-slate-200/80 dark:border-white/[0.08] px-5 py-4">
          <div className="min-w-0">
            <h2
              id="download-quality-heading"
              className="font-display text-lg font-bold text-slate-900 dark:text-white"
            >
              Choose Download Quality
            </h2>
            <p className="mt-0.5 truncate text-xs text-slate-600 dark:text-slate-400">
              {title}
              {subtitle ? ` · ${subtitle}` : ''}
              {itemCount > 1 ? ` · ${itemCount} episodes` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close quality selector"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-2.5">
          {probingSizes && (
            <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E11D48]" />
              <span>Checking exact file sizes...</span>
            </div>
          )}

          {effectiveOptions.map((opt) => {
            const active = selected === opt.id;
            const resolved = resolveOptionSize(opt);
            const totalForCount = resolved
              ? resolved.bytes * Math.max(1, itemCount)
              : 0;
            const isExactSingle = Boolean(resolved?.exact && itemCount <= 1);
            const estText =
              totalForCount > 0
                ? isExactSingle
                  ? formatBytes(totalForCount)
                  : `~${formatBytes(totalForCount)}`
                : itemCount > 1
                  ? `${opt.fallbackPerHour} × ${itemCount}`
                  : opt.fallbackPerHour;
            const badgeText =
              resolved?.mode === 'direct' && itemCount <= 1
                ? `${opt.tier} · Original`
                : isExactSingle
                  ? `${opt.tier} · Exact`
                  : opt.tier;

            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSelected(opt.id)}
                className={`w-full min-h-[64px] flex items-center justify-between gap-3 rounded-xl border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E11D48] ${
                  active
                    ? 'border-[#E11D48] bg-rose-50/70 dark:bg-[#E11D48]/12'
                    : 'border-slate-200 dark:border-white/10 bg-slate-50/60 dark:bg-[#0B0E15] hover:border-slate-300 dark:hover:border-white/25'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <span
                    className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                      active
                        ? 'border-[#E11D48] bg-[#E11D48] text-white'
                        : 'border-slate-300 dark:border-white/25 bg-white dark:bg-transparent'
                    }`}
                  >
                    {active && <Check className="h-3 w-3 stroke-[3]" />}
                  </span>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-sm font-bold text-slate-900 dark:text-white">
                        {opt.label}
                      </span>
                      {opt.id === '720p' && (
                        <span className="text-[11px] font-semibold text-[#E11D48] dark:text-rose-400">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                      {opt.description}
                    </p>
                  </div>
                </div>

                <div className="shrink-0 text-right tabular-nums">
                  <p className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-200">
                    {estText}
                  </p>
                  <p className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                    {badgeText}
                  </p>
                </div>
              </button>
            );
          })}

          <p className="pt-1 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <HardDrive className="h-3.5 w-3.5 shrink-0" />
            <span>Saved locally on your device for playback even when offline or out of data.</span>
          </p>
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-slate-200/80 dark:border-white/[0.08] bg-slate-50 dark:bg-[#0B0E15] px-5 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] sm:pb-3.5">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] sm:min-h-[40px] rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 px-4 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected, selectedSizeInfo)}
            className="inline-flex min-h-[44px] sm:min-h-[40px] items-center gap-2 rounded-lg bg-[#E11D48] px-5 text-sm font-semibold text-white hover:bg-[#be123c] transition-colors whitespace-nowrap"
          >
            <Download className="h-4 w-4" />
            <span>
              Download {selected}
              {itemCount > 1 ? ` (${itemCount})` : ''}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

