import type { ProgramReminder } from '../types/media';

export type BrowserNotificationState = 'unsupported' | 'granted' | 'denied' | 'default';

export function getNotificationPermissionState(): BrowserNotificationState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return window.Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationState> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  if (window.Notification.permission === 'granted') {
    return 'granted';
  }
  if (window.Notification.permission === 'denied') {
    return 'denied';
  }
  try {
    const result = await window.Notification.requestPermission();
    return result;
  } catch {
    return window.Notification.permission;
  }
}

export function fireBrowserNotification(
  reminder: ProgramReminder,
  onClick?: () => void,
): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (window.Notification.permission !== 'granted') return;

  const nowSec = Math.floor(Date.now() / 1000);
  const minsLeft = Math.max(0, Math.round((reminder.startTimestamp - nowSec) / 60));
  const timingText =
    minsLeft <= 0
      ? 'Starting now'
      : minsLeft === 1
        ? 'Starts in 1 minute'
        : `Starts in ${minsLeft} minutes`;

  try {
    const notif = new window.Notification(`${reminder.programTitle} · ${reminder.channelName}`, {
      body: `${timingText} (${reminder.startLabel} – ${reminder.stopLabel} UTC). Click to tune in.`,
      tag: `cinebox-reminder-${reminder.id}`,
      requireInteraction: false,
    });
    notif.onclick = () => {
      try {
        window.focus();
      } catch {
        // Ignore focus restriction inside iframe
      }
      onClick?.();
      notif.close();
    };
  } catch {
    // Ignore browser environments that disallow Notification constructor
  }
}

export function playReminderChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const playTone = (freq: number, startOffset: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.0001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.08, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    playTone(587.33, 0, 0.18); // D5
    playTone(880, 0.14, 0.28); // A5

    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 700);
  } catch {
    // Ignore autoplay/AudioContext restrictions
  }
}

export function formatReminderCountdown(startTimestamp: number, stopTimestamp: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec >= stopTimestamp) return 'Ended';
  if (nowSec >= startTimestamp) return 'On Air Now';

  const diffSec = startTimestamp - nowSec;
  if (diffSec < 60) return 'Starts in <1m';
  const totalMins = Math.round(diffSec / 60);
  if (totalMins < 60) return `In ${totalMins}m`;
  const hrs = Math.floor(totalMins / 60);
  const remMins = totalMins % 60;
  return remMins > 0 ? `In ${hrs}h ${remMins}m` : `In ${hrs}h`;
}

export function formatLocalTimeFromUnix(tsSec: number): string {
  try {
    return new Date(tsSec * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
