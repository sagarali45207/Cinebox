export type ConnectivityErrorReason = 'offline' | 'no-data';

export interface ConnectivityProbeResult {
  reachable: boolean;
  reason: ConnectivityErrorReason | 'ok';
}

const DEFAULT_SAFE_ERROR =
  'Unable to reach the streaming service right now. Please check your Wi-Fi or mobile data and try again.';

export function sanitizeUserErrorMessage(
  raw: string | undefined | null,
  fallback = DEFAULT_SAFE_ERROR,
): string {
  const msg = String(raw || '').trim();
  if (!msg) return fallback;

  const lower = msg.toLowerCase();
  if (
    lower.includes('failed to fetch') ||
    lower.includes('load failed') ||
    lower.includes('networkerror') ||
    lower.includes('network request failed') ||
    lower.includes('err_internet_disconnected') ||
    lower.includes('err_name_not_resolved') ||
    lower.includes('err_connection') ||
    lower.includes('unexpected token') ||
    lower.includes('the operation was aborted') ||
    lower.includes('signal timed out')
  ) {
    return fallback;
  }

  // Never surface URLs, domains, IP addresses, or WebView endpoints to end users
  if (
    /https?:\/\//i.test(msg) ||
    /\bwww\./i.test(msg) ||
    /\b[a-z0-9-]+\.(com|net|org|io|app|ch|tv|me|dev|xyz|info)\b/i.test(msg) ||
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(msg)
  ) {
    return fallback;
  }

  return msg;
}

export async function probeServerConnectivity(
  timeoutMs = 8000,
): Promise<ConnectivityProbeResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { reachable: false, reason: 'offline' };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`/api/health?_t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { reachable: false, reason: 'no-data' };
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!data || data.ok !== true) {
      return { reachable: false, reason: 'no-data' };
    }
    return { reachable: true, reason: 'ok' };
  } catch {
    const isOfflineNow = typeof navigator !== 'undefined' && navigator.onLine === false;
    return {
      reachable: false,
      reason: isOfflineNow ? 'offline' : 'no-data',
    };
  } finally {
    window.clearTimeout(timer);
  }
}
