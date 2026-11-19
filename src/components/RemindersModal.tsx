import { useEffect, useState } from 'react';
import {
  Bell,
  BellOff,
  BellRing,
  CheckCircle2,
  Clock,
  Radio,
  Trash2,
  X,
} from 'lucide-react';
import type {
  DetailTarget,
  ProgramReminder,
  ReminderLeadMinutes,
} from '../types/media';
import {
  formatLocalTimeFromUnix,
  formatReminderCountdown,
  getNotificationPermissionState,
  requestBrowserNotificationPermission,
  type BrowserNotificationState,
} from '../utils/notifications';
import { MediaImage } from './MediaImage';

interface RemindersModalProps {
  reminders: ProgramReminder[];
  onClose: () => void;
  onOpenDetail: (target: DetailTarget) => void;
  onUpdateLeadTime: (id: string, leadMinutes: ReminderLeadMinutes) => void;
  onRemoveReminder: (id: string) => void;
  onClearReminders: () => void;
  onSendTestAlert: () => void;
}

const LEAD_OPTIONS: Array<{ value: ReminderLeadMinutes; label: string }> = [
  { value: 0, label: 'At start' },
  { value: 5, label: '5m' },
  { value: 10, label: '10m' },
  { value: 15, label: '15m' },
];

export function RemindersModal({
  reminders,
  onClose,
  onOpenDetail,
  onUpdateLeadTime,
  onRemoveReminder,
  onClearReminders,
  onSendTestAlert,
}: RemindersModalProps) {
  const [permState, setPermState] = useState<BrowserNotificationState>(() =>
    getNotificationPermissionState(),
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleEnableBrowserAlerts = async () => {
    const res = await requestBrowserNotificationPermission();
    setPermState(res);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scheduled Show Reminders"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/70 px-4 pt-10 sm:pt-4 pb-8"
    >
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-[#0E121C] shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 dark:border-white/[0.08] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#E11D48]/12 text-[#E11D48] dark:text-rose-400">
              <BellRing className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Show Reminders ({reminders.length})
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Alerts fire automatically before your scheduled TV events begin
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close reminders"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Browser Push Status Strip */}
        <div className="border-b border-slate-200/80 dark:border-white/[0.06] bg-slate-50/80 dark:bg-[#111520]/80 px-5 py-3 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 text-xs">
            {permState === 'granted' ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  Browser &amp; in-app alerts enabled
                </span>
              </>
            ) : permState === 'denied' ? (
              <>
                <BellOff className="h-4 w-4 text-amber-500 shrink-0" />
                <span className="text-slate-600 dark:text-slate-300">
                  Browser popups blocked — in-app toast &amp; chime alerts active
                </span>
              </>
            ) : (
              <>
                <Bell className="h-4 w-4 text-indigo-500 shrink-0" />
                <span className="text-slate-600 dark:text-slate-300">
                  In-app alerts active · Enable browser alerts for background tabs
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {permState === 'default' && (
              <button
                type="button"
                onClick={handleEnableBrowserAlerts}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors"
              >
                Enable Browser Alerts
              </button>
            )}
            <button
              type="button"
              onClick={onSendTestAlert}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 px-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10"
            >
              Test Alert
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {reminders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 bg-slate-50/70 dark:bg-[#111520]/60 p-10 text-center">
              <Bell className="mx-auto h-7 w-7 text-slate-400 dark:text-slate-500 mb-2" />
              <p className="font-display text-base font-semibold text-slate-900 dark:text-white">
                No Reminders Scheduled
              </p>
              <p className="mt-1 text-xs sm:text-sm text-slate-600 dark:text-slate-400">
                Open any upcoming program in the TV Guide or Live Channel schedule and click
                &ldquo;Remind Me&rdquo; to receive an alert before it airs.
              </p>
            </div>
          ) : (
            reminders.map((rem) => {
              const countdown = formatReminderCountdown(rem.startTimestamp, rem.stopTimestamp);
              const localTime = formatLocalTimeFromUnix(rem.startTimestamp);
              const isEnded = countdown === 'Ended';
              return (
                <article
                  key={rem.id}
                  className="rounded-xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#111520] p-3.5 shadow-sm shadow-slate-900/5 dark:shadow-none space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <MediaImage
                        src={rem.channelLogo}
                        alt={rem.channelName}
                        title={rem.channelName}
                        category={rem.channelCategory}
                        variant="logo"
                        imgClassName="h-full w-full object-contain p-1"
                        className="h-11 w-14 shrink-0 rounded-lg border border-slate-200/80 dark:border-white/10 bg-slate-100 dark:bg-[#090B10]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
                          <span
                            className={`font-semibold ${
                              countdown === 'On Air Now'
                                ? 'text-[#E11D48]'
                                : isEnded
                                  ? 'text-slate-400'
                                  : 'text-indigo-600 dark:text-indigo-400'
                            }`}
                          >
                            {countdown}
                          </span>
                          <span aria-hidden="true" className="text-slate-400">
                            ·
                          </span>
                          <span className="font-mono text-slate-500 dark:text-slate-400">
                            {rem.startLabel}–{rem.stopLabel} UTC
                            {localTime ? ` (${localTime})` : ''}
                          </span>
                        </div>
                        <h3 className="mt-0.5 truncate text-sm font-semibold text-slate-900 dark:text-white">
                          {rem.programTitle}
                        </h3>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {rem.channelName}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenDetail({
                            kind: 'live',
                            id: rem.streamId,
                            channel: rem.channelSnapshot,
                          });
                        }}
                        title={`Watch ${rem.channelName}`}
                        aria-label={`Watch ${rem.channelName}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-700 dark:text-slate-200 hover:border-rose-300 hover:text-[#E11D48] dark:hover:border-white/25"
                      >
                        <Radio className="h-3.5 w-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => onRemoveReminder(rem.id)}
                        title="Remove reminder"
                        aria-label={`Remove reminder for ${rem.programTitle}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-500 dark:text-slate-400 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {!isEnded && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 dark:border-white/[0.06] pt-2.5">
                      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                        <Clock className="h-3 w-3" />
                        <span>Alert timing:</span>
                      </span>
                      <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-[#0B0E16] p-0.5">
                        {LEAD_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => onUpdateLeadTime(rem.id, opt.value)}
                            className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                              rem.leadMinutes === opt.value
                                ? 'bg-white dark:bg-[#1A2132] text-[#E11D48] dark:text-rose-400 shadow-sm'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>

        {/* Footer */}
        {reminders.length > 0 && (
          <div className="flex items-center justify-between border-t border-slate-200 dark:border-white/[0.08] px-5 py-3">
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {reminders.filter((r) => !r.notified).length} pending alert(s)
            </span>
            <button
              type="button"
              onClick={onClearReminders}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-white/10 px-3 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Clear All</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
