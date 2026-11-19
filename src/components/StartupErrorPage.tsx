import { Clapperboard, HardDriveDownload, RefreshCw, WifiOff } from 'lucide-react';
import type { ConnectivityErrorReason } from '../utils/networkError';

interface StartupErrorPageProps {
  reason: ConnectivityErrorReason;
  retrying: boolean;
  offlineDownloadsCount: number;
  onRetry: () => void;
  onOpenOfflineDownloads: () => void;
}

export function StartupErrorPage({
  reason,
  retrying,
  offlineDownloadsCount,
  onRetry,
  onOpenOfflineDownloads,
}: StartupErrorPageProps) {
  const isOffline = reason === 'offline';

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="min-h-screen flex flex-col items-center justify-center bg-[#F6F8FC] dark:bg-[#090B10] px-4 py-10 text-slate-900 dark:text-slate-100"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#111623] p-7 sm:p-8 text-center shadow-lg">
        <div className="mb-6 inline-flex items-center gap-2.5 text-sm font-bold tracking-tight text-slate-900 dark:text-white">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#E11D48] text-white shadow-sm shadow-rose-500/30">
            <Clapperboard className="h-3.5 w-3.5" />
          </span>
          <span className="font-display text-base">CineBox</span>
        </div>

        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-500/10 dark:bg-rose-500/15 text-[#E11D48] ring-1 ring-rose-500/20">
          <WifiOff className="h-8 w-8" />
        </div>

        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          {isOffline ? 'No Internet Connection' : 'Connection Unavailable'}
        </h1>

        <p className="mt-2.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {isOffline
            ? "CineBox can't connect right now because your device is offline. Turn on Wi-Fi or mobile data and try again."
            : 'Unable to connect right now. Your device may be offline, out of mobile data, or experiencing an unstable network.'}
        </p>

        <div className="mt-5 rounded-xl border border-slate-200/80 dark:border-white/[0.08] bg-slate-50/80 dark:bg-white/[0.03] px-4 py-3 text-left text-xs leading-relaxed text-slate-600 dark:text-slate-400 space-y-1">
          <p>&bull; Check that Wi-Fi or mobile data is switched on.</p>
          <p>&bull; Verify your mobile data plan has available data.</p>
          <p>&bull; Move to an area with a stronger signal and retry.</p>
        </div>

        <div className="mt-6 flex flex-col gap-2.5">
          <button
            type="button"
            disabled={retrying}
            onClick={onRetry}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#E11D48] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#BE123C] disabled:opacity-70 disabled:cursor-wait transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
            <span>{retrying ? 'Checking Connection...' : 'Retry Connection'}</span>
          </button>

          {offlineDownloadsCount > 0 && (
            <button
              type="button"
              onClick={onOpenOfflineDownloads}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-white/[0.04] px-5 py-3 text-sm font-semibold text-slate-800 dark:text-slate-100 hover:border-emerald-400 dark:hover:border-emerald-500/50 hover:bg-emerald-50/40 dark:hover:bg-emerald-500/10 transition-colors"
            >
              <HardDriveDownload className="h-4 w-4 text-emerald-500" />
              <span>
                Watch Offline Downloads ({offlineDownloadsCount})
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
