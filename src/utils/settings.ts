import { useCallback, useEffect, useState } from 'react';
import type { AspectRatioMode, DownloadProfileMode, VideoQualityOption } from '../types/media';

export type SubtitleLanguagePref =
  | 'auto'
  | 'off'
  | 'English'
  | 'Hindi'
  | 'Spanish'
  | 'Arabic'
  | 'Urdu';

export interface ParentalSettings {
  enabled: boolean;
  pinHash: string;
  blockAdult: boolean;
  kidsMode: boolean;
  blockedKeywords: string[];
}

export interface AppSettings {
  defaultQuality: VideoQualityOption;
  defaultAspectRatio: AspectRatioMode;
  preferredSubtitleLang: SubtitleLanguagePref;
  autoPlayOnOpen: boolean;
  keepScreenAwake: boolean;
  saveSearchHistory: boolean;
  downloadProfile: DownloadProfileMode;
  parental: ParentalSettings;
}

export const SETTINGS_STORAGE_KEY = 'cinebox_settings_v1';
export const RECENT_SEARCHES_KEY = 'cinebox_recent_searches_v1';
export const MAX_RECENT_SEARCHES = 10;

const SETTINGS_EVENT = 'cinebox-settings-changed';
const RECENT_SEARCHES_EVENT = 'cinebox-recent-searches-changed';
const PARENTAL_SESSION_EVENT = 'cinebox-parental-session-changed';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultQuality: 'auto',
  defaultAspectRatio: 'fit',
  preferredSubtitleLang: 'auto',
  autoPlayOnOpen: true,
  keepScreenAwake: true,
  saveSearchHistory: true,
  downloadProfile: 'free',
  parental: {
    enabled: false,
    pinHash: '',
    blockAdult: true,
    kidsMode: false,
    blockedKeywords: [],
  },
};

// Session-only unlock flag (intentionally kept out of localStorage so every app restart re-locks)
let parentalSessionUnlocked = false;

export function isParentalSessionUnlocked(): boolean {
  return parentalSessionUnlocked;
}

export function setParentalSessionUnlocked(unlocked: boolean): void {
  if (parentalSessionUnlocked === unlocked) return;
  parentalSessionUnlocked = unlocked;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PARENTAL_SESSION_EVENT));
  }
}

export function hashParentalPin(pin: string): string {
  const normalized = pin.trim();
  if (!normalized) return '';
  const salted = `cinebox-pin-v1:${normalized}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < salted.length; i += 1) {
    const c = salted.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export function verifyParentalPin(pin: string, settings: AppSettings): boolean {
  if (!settings.parental.pinHash) return false;
  return hashParentalPin(pin) === settings.parental.pinHash;
}

function normalizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_APP_SETTINGS;
  const obj = raw as Partial<AppSettings>;
  const parentalRaw = (obj.parental && typeof obj.parental === 'object'
    ? obj.parental
    : {}) as Partial<ParentalSettings>;

  const validQualities: VideoQualityOption[] = ['auto', '1080p', '720p', '480p', '360p'];
  const validAspects: AspectRatioMode[] = ['fit', 'fill', 'stretch', '16:9', '4:3', '21:9'];
  const validSubs: SubtitleLanguagePref[] = [
    'auto',
    'off',
    'English',
    'Hindi',
    'Spanish',
    'Arabic',
    'Urdu',
  ];

  const blockedKeywords = Array.isArray(parentalRaw.blockedKeywords)
    ? Array.from(
        new Set(
          parentalRaw.blockedKeywords
            .filter((k): k is string => typeof k === 'string')
            .map((k) => k.trim().toLowerCase())
            .filter((k) => k.length >= 2),
        ),
      ).slice(0, 30)
    : [];

  return {
    defaultQuality: validQualities.includes(obj.defaultQuality as VideoQualityOption)
      ? (obj.defaultQuality as VideoQualityOption)
      : DEFAULT_APP_SETTINGS.defaultQuality,
    defaultAspectRatio: validAspects.includes(obj.defaultAspectRatio as AspectRatioMode)
      ? (obj.defaultAspectRatio as AspectRatioMode)
      : DEFAULT_APP_SETTINGS.defaultAspectRatio,
    preferredSubtitleLang: validSubs.includes(obj.preferredSubtitleLang as SubtitleLanguagePref)
      ? (obj.preferredSubtitleLang as SubtitleLanguagePref)
      : DEFAULT_APP_SETTINGS.preferredSubtitleLang,
    autoPlayOnOpen:
      typeof obj.autoPlayOnOpen === 'boolean'
        ? obj.autoPlayOnOpen
        : DEFAULT_APP_SETTINGS.autoPlayOnOpen,
    keepScreenAwake:
      typeof obj.keepScreenAwake === 'boolean'
        ? obj.keepScreenAwake
        : DEFAULT_APP_SETTINGS.keepScreenAwake,
    saveSearchHistory:
      typeof obj.saveSearchHistory === 'boolean'
        ? obj.saveSearchHistory
        : DEFAULT_APP_SETTINGS.saveSearchHistory,
    downloadProfile:
      obj.downloadProfile === 'premium' || obj.downloadProfile === 'free'
        ? obj.downloadProfile
        : DEFAULT_APP_SETTINGS.downloadProfile,
    parental: {
      enabled:
        typeof parentalRaw.enabled === 'boolean' && Boolean(parentalRaw.pinHash)
          ? parentalRaw.enabled
          : false,
      pinHash: typeof parentalRaw.pinHash === 'string' ? parentalRaw.pinHash : '',
      blockAdult:
        typeof parentalRaw.blockAdult === 'boolean'
          ? parentalRaw.blockAdult
          : DEFAULT_APP_SETTINGS.parental.blockAdult,
      kidsMode:
        typeof parentalRaw.kidsMode === 'boolean'
          ? parentalRaw.kidsMode
          : DEFAULT_APP_SETTINGS.parental.kidsMode,
      blockedKeywords,
    },
  };
}

export function loadAppSettings(): AppSettings {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return DEFAULT_APP_SETTINGS;
    }
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_APP_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function saveAppSettings(next: AppSettings): AppSettings {
  const normalized = normalizeSettings(next);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
      window.dispatchEvent(new Event(SETTINGS_EVENT));
    }
  } catch {
    // Ignore storage restrictions
  }
  return normalized;
}

export function resetPlaybackAndSearchSettings(): AppSettings {
  const current = loadAppSettings();
  return saveAppSettings({
    ...DEFAULT_APP_SETTINGS,
    parental: current.parental,
  });
}

export function loadRecentSearches(): string[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed.length < 2) continue;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      clean.push(trimmed);
      if (clean.length >= MAX_RECENT_SEARCHES) break;
    }
    return clean;
  } catch {
    return [];
  }
}

export function saveRecentSearches(items: string[]): string[] {
  const clean = items.slice(0, MAX_RECENT_SEARCHES);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (clean.length === 0) {
        window.localStorage.removeItem(RECENT_SEARCHES_KEY);
      } else {
        window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(clean));
      }
      window.dispatchEvent(new Event(RECENT_SEARCHES_EVENT));
    }
  } catch {
    // Ignore storage errors
  }
  return clean;
}

export function clearRecentSearchesStorage(): void {
  saveRecentSearches([]);
}

// Excludes "Adult Swim" TV network false positives while matching explicit adult/18+ categories and titles
const ADULT_CONTENT_RX =
  /\b(for\s+adults?|adults?\s+only|adult\s+channels?|adult\s+movies?|xxx|18\+|erotic|porn|porno|nsfw|uncensored|playboy|brazzers|hustler|penthouse|softcore|hardcore)\b/i;

const KIDS_SAFE_BLOCK_RX =
  /\b(for\s+adults?|adults?\s+only|adult\s+channels?|adult\s+movies?|xxx|18\+|erotic|porn|porno|nsfw|uncensored|horror|slasher|gore|crime|thriller|violence|mature|r-rated|rated\s*r|nc-17)\b/i;

function sanitizeAdultFalsePositives(text: string): string {
  return text.replace(/\badult\s*swim\b/gi, ' ');
}

export function isParentalActiveAndLocked(
  settings: AppSettings,
  sessionUnlocked = isParentalSessionUnlocked(),
): boolean {
  return Boolean(settings.parental.enabled && settings.parental.pinHash && !sessionUnlocked);
}

export function isRestrictedCategory(
  categoryName: string | undefined,
  settings: AppSettings,
  sessionUnlocked = isParentalSessionUnlocked(),
): boolean {
  if (!isParentalActiveAndLocked(settings, sessionUnlocked)) return false;
  const raw = (categoryName || '').trim();
  if (!raw) return false;
  const cleaned = sanitizeAdultFalsePositives(raw);

  if (settings.parental.blockAdult && ADULT_CONTENT_RX.test(cleaned)) {
    return true;
  }
  if (settings.parental.kidsMode && KIDS_SAFE_BLOCK_RX.test(cleaned)) {
    return true;
  }
  if (settings.parental.blockedKeywords.length > 0) {
    const lower = raw.toLowerCase();
    for (const kw of settings.parental.blockedKeywords) {
      if (kw && lower.includes(kw)) return true;
    }
  }
  return false;
}

export function isRestrictedContent(
  info: {
    title?: string;
    categoryName?: string;
    genre?: string;
  },
  settings: AppSettings,
  sessionUnlocked = isParentalSessionUnlocked(),
): boolean {
  if (!isParentalActiveAndLocked(settings, sessionUnlocked)) return false;
  const combinedRaw = [info.title || '', info.categoryName || '', info.genre || '']
    .filter(Boolean)
    .join(' ');
  if (!combinedRaw) return false;

  const cleaned = sanitizeAdultFalsePositives(combinedRaw);
  if (settings.parental.blockAdult && ADULT_CONTENT_RX.test(cleaned)) {
    return true;
  }
  if (settings.parental.kidsMode && KIDS_SAFE_BLOCK_RX.test(cleaned)) {
    return true;
  }
  if (settings.parental.blockedKeywords.length > 0) {
    const lower = combinedRaw.toLowerCase();
    for (const kw of settings.parental.blockedKeywords) {
      if (kw && lower.includes(kw)) return true;
    }
  }
  return false;
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings());
  const [parentalUnlocked, setParentalUnlocked] = useState<boolean>(() =>
    isParentalSessionUnlocked(),
  );

  useEffect(() => {
    const onSettingsChange = () => {
      setSettings(loadAppSettings());
    };
    const onSessionChange = () => {
      setParentalUnlocked(isParentalSessionUnlocked());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_STORAGE_KEY) {
        setSettings(loadAppSettings());
      }
    };
    window.addEventListener(SETTINGS_EVENT, onSettingsChange);
    window.addEventListener(PARENTAL_SESSION_EVENT, onSessionChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onSettingsChange);
      window.removeEventListener(PARENTAL_SESSION_EVENT, onSessionChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const updateSettings = useCallback(
    (updater: Partial<AppSettings> | ((prev: AppSettings) => AppSettings)) => {
      const current = loadAppSettings();
      const next =
        typeof updater === 'function' ? updater(current) : { ...current, ...updater };
      const saved = saveAppSettings(next);
      setSettings(saved);
      return saved;
    },
    [],
  );

  return {
    settings,
    updateSettings,
    parentalUnlocked,
    unlockParentalSession: () => setParentalSessionUnlocked(true),
    lockParentalSession: () => setParentalSessionUnlocked(false),
    isParentalLocked: isParentalActiveAndLocked(settings, parentalUnlocked),
  };
}

export function useRecentSearchesCount(): number {
  const [count, setCount] = useState<number>(() => loadRecentSearches().length);

  useEffect(() => {
    const sync = () => setCount(loadRecentSearches().length);
    window.addEventListener(RECENT_SEARCHES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(RECENT_SEARCHES_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return count;
}
