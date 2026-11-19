import type {
  LiveChannelSummary,
  MediaReview,
  ProgramReminder,
  WatchHistoryEntry,
  WatchlistEntry,
} from '../types/media';

const CONTINUE_KEY = 'cinebox_continue_v1';
const WATCHLIST_KEY = 'cinebox_watchlist_v1';
const FAVORITE_CHANNELS_KEY = 'cinebox_fav_channels_v1';
const RECENT_CHANNELS_KEY = 'cinebox_recent_channels_v1';
const REMINDERS_KEY = 'cinebox_epg_reminders_v1';
const REVIEWS_KEY = 'cinebox_reviews_v1';
const REVIEW_AUTHOR_KEY = 'cinebox_review_author_v1';
const FAVORITE_GENRES_KEY = 'cinebox_fav_genres_v1';

export const CANONICAL_FAVORITE_GENRES: Array<{ id: string; label: string }> = [
  { id: 'action-adventure', label: 'Action & Adventure' },
  { id: 'drama', label: 'Drama' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'crime-thriller', label: 'Crime & Thriller' },
  { id: 'horror', label: 'Horror' },
  { id: 'sci-fi-fantasy', label: 'Sci-Fi & Fantasy' },
  { id: 'romance', label: 'Romance' },
  { id: 'kids-family', label: 'Kids & Family' },
  { id: 'animation', label: 'Animation' },
  { id: 'documentary', label: 'Documentary' },
  { id: 'sports', label: 'Sports' },
];

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

export function getContinueWatching(): WatchHistoryEntry[] {
  const list = readJson<WatchHistoryEntry[]>(CONTINUE_KEY, []);
  if (!Array.isArray(list)) return [];
  return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function saveWatchProgress(entry: WatchHistoryEntry): WatchHistoryEntry[] {
  const existing = getContinueWatching().filter((item) => item.key !== entry.key);
  const next = [entry, ...existing].slice(0, 30);
  writeJson(CONTINUE_KEY, next);
  return next;
}

export function removeWatchProgress(key: string | string[]): WatchHistoryEntry[] {
  const keysToRemove = new Set(Array.isArray(key) ? key : [key]);
  const next = getContinueWatching().filter((item) => !keysToRemove.has(item.key));
  writeJson(CONTINUE_KEY, next);
  return next;
}

export function clearWatchProgress(): WatchHistoryEntry[] {
  writeJson(CONTINUE_KEY, []);
  return [];
}

export function getWatchlist(): WatchlistEntry[] {
  const list = readJson<WatchlistEntry[]>(WATCHLIST_KEY, []);
  if (!Array.isArray(list)) return [];
  return [...list].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export function toggleWatchlist(payload: {
  kind: 'movie' | 'series';
  id: string;
  title: string;
  poster: string;
  year: string | null;
  rating: number;
  categoryName: string;
}): { saved: boolean; list: WatchlistEntry[] } {
  const key = `${payload.kind}:${payload.id}`;
  const existing = getWatchlist();
  const alreadySaved = existing.some((item) => item.key === key);

  const next = alreadySaved
    ? existing.filter((item) => item.key !== key)
    : [{ ...payload, key, addedAt: Date.now() }, ...existing].slice(0, 120);

  writeJson(WATCHLIST_KEY, next);
  return { saved: !alreadySaved, list: next };
}

export function getFavoriteChannels(): LiveChannelSummary[] {
  const raw = readJson<unknown[]>(FAVORITE_CHANNELS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is LiveChannelSummary =>
      Boolean(item && typeof item === 'object' && 'streamId' in item && 'name' in item),
  );
}

export function toggleFavoriteChannel(channel: LiveChannelSummary): {
  pinned: boolean;
  list: LiveChannelSummary[];
} {
  const existing = getFavoriteChannels();
  const alreadyPinned = existing.some((item) => item.streamId === channel.streamId);
  const next = alreadyPinned
    ? existing.filter((item) => item.streamId !== channel.streamId)
    : [channel, ...existing].slice(0, 100);

  writeJson(FAVORITE_CHANNELS_KEY, next);
  return { pinned: !alreadyPinned, list: next };
}

export function getRecentChannels(): LiveChannelSummary[] {
  const list = readJson<LiveChannelSummary[]>(RECENT_CHANNELS_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter((item) => Boolean(item && item.streamId && item.name));
}

export function pushRecentChannel(channel: LiveChannelSummary): LiveChannelSummary[] {
  const existing = getRecentChannels().filter((item) => item.streamId !== channel.streamId);
  const next = [channel, ...existing].slice(0, 24);
  writeJson(RECENT_CHANNELS_KEY, next);
  return next;
}

export function removeRecentChannel(streamId: string): LiveChannelSummary[] {
  const next = getRecentChannels().filter((item) => item.streamId !== streamId);
  writeJson(RECENT_CHANNELS_KEY, next);
  return next;
}

export function clearRecentChannels(): LiveChannelSummary[] {
  writeJson(RECENT_CHANNELS_KEY, []);
  return [];
}

export function buildReminderId(streamId: string, startTimestamp: number, programId: string): string {
  return `${streamId}:${startTimestamp}:${programId || 'prog'}`;
}

export function getProgramReminders(): ProgramReminder[] {
  const raw = readJson<ProgramReminder[]>(REMINDERS_KEY, []);
  if (!Array.isArray(raw)) return [];
  const cutoffSec = Math.floor(Date.now() / 1000) - 43200; // keep up to 12h after end
  const filtered = raw
    .filter(
      (item) =>
        Boolean(item && item.id && item.streamId && item.programTitle) &&
        (item.stopTimestamp || 0) >= cutoffSec,
    )
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
  return filtered;
}

export function saveProgramReminder(reminder: ProgramReminder): ProgramReminder[] {
  const existing = getProgramReminders().filter((item) => item.id !== reminder.id);
  const next = [...existing, reminder]
    .sort((a, b) => a.startTimestamp - b.startTimestamp)
    .slice(0, 100);
  writeJson(REMINDERS_KEY, next);
  return next;
}

export function removeProgramReminder(id: string): ProgramReminder[] {
  const next = getProgramReminders().filter((item) => item.id !== id);
  writeJson(REMINDERS_KEY, next);
  return next;
}

export function markReminderNotified(id: string): ProgramReminder[] {
  const next = getProgramReminders().map((item) =>
    item.id === id ? { ...item, notified: true } : item,
  );
  writeJson(REMINDERS_KEY, next);
  return next;
}

export function clearProgramReminders(): ProgramReminder[] {
  writeJson(REMINDERS_KEY, []);
  return [];
}

function readAllReviews(): MediaReview[] {
  const raw = readJson<MediaReview[]>(REVIEWS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item) =>
      Boolean(item && item.id && item.mediaKey) &&
      typeof item.rating === 'number' &&
      item.rating >= 1 &&
      item.rating <= 5,
  );
}

export function getMediaReviews(mediaKey: string): MediaReview[] {
  return readAllReviews()
    .filter((item) => item.mediaKey === mediaKey)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

export function saveMediaReview(input: {
  id?: string;
  mediaKey: string;
  kind: 'movie' | 'series';
  mediaId: string;
  mediaTitle: string;
  author: string;
  rating: number;
  comment: string;
}): MediaReview[] {
  const all = readAllReviews();
  const clampedRating = Math.min(5, Math.max(1, Math.round(input.rating)));
  const cleanAuthor = input.author.trim() || 'Viewer';
  const cleanComment = input.comment.trim();
  const now = Date.now();

  let nextAll: MediaReview[];
  const existingIdx = input.id ? all.findIndex((r) => r.id === input.id) : -1;

  if (existingIdx >= 0) {
    nextAll = all.map((r, idx) =>
      idx === existingIdx
        ? {
            ...r,
            author: cleanAuthor,
            rating: clampedRating,
            comment: cleanComment,
            updatedAt: now,
          }
        : r,
    );
  } else {
    const created: MediaReview = {
      id: `rev_${now}_${Math.random().toString(36).slice(2, 8)}`,
      mediaKey: input.mediaKey,
      kind: input.kind,
      mediaId: input.mediaId,
      mediaTitle: input.mediaTitle,
      author: cleanAuthor,
      rating: clampedRating,
      comment: cleanComment,
      createdAt: now,
    };
    nextAll = [created, ...all].slice(0, 300);
  }

  writeJson(REVIEWS_KEY, nextAll);
  return nextAll
    .filter((item) => item.mediaKey === input.mediaKey)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

export function deleteMediaReview(mediaKey: string, reviewId: string): MediaReview[] {
  const nextAll = readAllReviews().filter((item) => item.id !== reviewId);
  writeJson(REVIEWS_KEY, nextAll);
  return nextAll
    .filter((item) => item.mediaKey === mediaKey)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

export function getSavedReviewerName(): string {
  try {
    return window.localStorage.getItem(REVIEW_AUTHOR_KEY) || '';
  } catch {
    return '';
  }
}

export function saveReviewerName(name: string): void {
  try {
    const clean = name.trim();
    if (clean) {
      window.localStorage.setItem(REVIEW_AUTHOR_KEY, clean);
    }
  } catch {
    // Ignore storage errors
  }
}

export function getFavoriteGenres(): string[] {
  const raw = readJson<unknown[]>(FAVORITE_GENRES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim().toLowerCase()),
    ),
  );
}

export function setFavoriteGenres(genres: string[]): string[] {
  const clean = Array.from(
    new Set(genres.map((g) => g.trim().toLowerCase()).filter(Boolean)),
  ).slice(0, 12);
  writeJson(FAVORITE_GENRES_KEY, clean);
  return clean;
}

export function toggleFavoriteGenre(genreId: string): string[] {
  const cleanId = genreId.trim().toLowerCase();
  if (!cleanId) return getFavoriteGenres();
  const current = getFavoriteGenres();
  const exists = current.includes(cleanId);
  const next = exists ? current.filter((id) => id !== cleanId) : [...current, cleanId];
  return setFavoriteGenres(next);
}

export function getPositiveReviewedMedia(): Array<{
  kind: 'movie' | 'series';
  id: string;
  rating: number;
}> {
  return readAllReviews()
    .filter((r) => r.rating >= 4)
    .map((r) => ({
      kind: r.kind,
      id: r.mediaId,
      rating: r.rating,
    }));
}
