import { BellRing, Radio, X } from 'lucide-react';
import type { DetailTarget, ProgramReminder } from '../types/media';
import { formatLocalTimeFromUnix, formatReminderCountdown } from '../utils/notifications';
import { MediaImage } from './MediaImage';

interface ReminderToastStackProps {
  alerts: ProgramReminder[];
  onDismiss: (id: string) => void;
  onTuneIn: (target: DetailTarget, reminderId: string) => void;
}

export function ReminderToastStack({
  alerts,
  onDismiss,
  onTuneIn,
}: ReminderToastStackProps) {
  if (alerts.length === 0) return null;

  return (
    <aside
      aria-live="assertive"
      aria-label="Upcoming Show Alerts"
      className="fixed bottom-20 md:bottom-6 right-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-3"
    >
      {alerts.map((alert) => {
        const countdown = formatReminderCountdown(alert.startTimestamp, alert.stopTimestamp);
        const localStart = formatLocalTimeFromUnix(alert.startTimestamp);

        return (
          <div
            key={alert.id}
            role="alert"
            className="rounded-xl border border-rose-300/70 dark:border-rose-500/40 bg-white dark:bg-[#111520] p-4 shadow-lg"
          >
            <div className="flex items-start justify-between gap-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-[#E11D48] dark:text-rose-400">
                <BellRing className="h-4 w-4 shrink-0" />
                <span>Show Reminder</span>
                <span aria-hidden="true" className="text-slate-400">
                  ·
                </span>
                <span className="tabular-nums">{countdown}</span>
              </div>

              <button
                type="button"
                onClick={() => onDismiss(alert.id)}
                aria-label={`Dismiss alert for ${alert.programTitle}`}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-2.5 flex items-center gap-3">
              <MediaImage
                src={alert.channelLogo}
                alt={alert.channelName}
                title={alert.channelName}
                category={alert.channelCategory}
                variant="logo"
                imgClassName="h-full w-full object-contain p-1"
                className="h-12 w-14 shrink-0 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-[#090B10]"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-900 dark:text-white">
                  {alert.programTitle}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-600 dark:text-slate-300">
                  {alert.channelName}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                  {alert.startLabel} – {alert.stopLabel} UTC
                  {localStart ? ` · ${localStart} local` : ''}
                </p>
              </div>
            </div>

            <div className="mt-3.5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => onDismiss(alert.id)}
                className="inline-flex h-9 items-center rounded-lg border border-slate-200 dark:border-white/10 px-3 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() =>
                  onTuneIn(
                    {
                      kind: 'live',
                      id: alert.streamId,
                      channel: alert.channelSnapshot,
                    },
                    alert.id,
                  )
                }
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 text-xs font-semibold text-white shadow-sm hover:bg-[#BE123C]"
              >
                <Radio className="h-3.5 w-3.5" />
                <span>Tune In</span>
              </button>
            </div>
          </div>
        );
      })}
    </aside>
  );
}
