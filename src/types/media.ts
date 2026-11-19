export type StreamFormat = 'ts' | 'm3u8';

export type NavTab = 'discover' | 'movies' | 'series' | 'live' | 'epg' | 'downloads' | 'library';

export type DownloadQuality = '360p' | '480p' | '720p' | '1080p' | string;

export type DownloadProfileMode = 'free' | 'premium';

export type TransferStatus =
  | 'not_exported'
  | 'transferring'
  | 'exported'
  | 'transfer_failed';

export type AspectRatioMode = 'fit' | 'fill' | 'stretch' | '16:9' | '4:3' | '21:9';

export type VideoQualityOption = 'auto' | '1080p' | '720p' | '480p' | '360p' | string;

export interface StreamVariantInfo {
  id: string;
  label: string;
  quality: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  codecs?: string;
  url?: string;
  source: 'upstream-hls' | 'transcode' | 'original';
}

export interface StreamVariantsResponse {
  isMasterPlaylist: boolean;
  isHls: boolean;
  mimeType: string;
  acceptRanges: boolean;
  contentLength: number;
  variants: StreamVariantInfo[];
}

export interface AccountSummary {
  status: string;
  username: string;
  message: string;
  expDate: number | null;
  createdAt: number | null;
  activeCons: number;
  maxConnections: number;
  allowedOutputFormats: string[];
  preferredFormat: StreamFormat;
  hostDomain: string;
  serverTimezone: string;
  serverTimestamp: number;
  serverTimeNow: string;
  isDefault: boolean;
}

export interface CategoryItem {
  categoryId: string;
  categoryName: string;
  count: number;
}

export interface GenreItem {
  id: string;
  label: string;
  count: number;
  group?: 'genre' | 'cinema';
}

export interface MovieSummary {
  streamId: string;
  name: string;
  cleanTitle: string;
  year: string | null;
  qualityTag: string | null;
  poster: string;
  rating: number;
  added: number;
  categoryId: string;
  categoryName: string;
  extension: string;
}

export interface MovieDetail extends MovieSummary {
  backdrop: string;
  plot: string;
  cast: string;
  director: string;
  genre: string;
  releaseDate: string;
  duration: string;
  youtubeTrailer: string;
  tmdbId: string;
  playUrl: string;
  related?: MovieSummary[];
}

export interface SeriesSummary {
  seriesId: string;
  name: string;
  cleanTitle: string;
  year: string | null;
  poster: string;
  backdrop: string;
  plot: string;
  genre: string;
  releaseDate: string;
  rating: number;
  lastModified: number;
  categoryId: string;
  categoryName: string;
}

export interface EpisodeSummary {
  episodeId: string;
  episodeNum: number;
  seasonNum: number;
  title: string;
  plot: string;
  duration: string;
  durationSec: number;
  thumbnail: string;
  rating: number;
  extension: string;
  playUrl: string;
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  cover: string;
  airDate: string;
}

export interface SeriesDetail extends SeriesSummary {
  cast: string;
  director: string;
  youtubeTrailer: string;
  episodeRunTime: string;
  tmdbId?: string;
  seasons: SeasonSummary[];
  episodesBySeason: Record<string, EpisodeSummary[]>;
  related?: SeriesSummary[];
}

export interface EpgProgram {
  id: string;
  title: string;
  description: string;
  startTimestamp: number;
  stopTimestamp: number;
  startLabel: string;
  stopLabel: string;
  isNowPlaying: boolean;
  hasArchive: boolean;
  archiveDurationMin: number;
}

export type ReminderLeadMinutes = 0 | 5 | 10 | 15;

export interface ProgramReminder {
  id: string;
  streamId: string;
  channelName: string;
  channelLogo: string;
  channelCategory: string;
  programId: string;
  programTitle: string;
  programDescription?: string;
  startTimestamp: number;
  stopTimestamp: number;
  startLabel: string;
  stopLabel: string;
  leadMinutes: ReminderLeadMinutes;
  createdAt: number;
  notified?: boolean;
  channelSnapshot?: LiveChannelSummary;
}

export interface LiveChannelSummary {
  streamId: string;
  num: number;
  name: string;
  logo: string;
  categoryId: string;
  categoryName: string;
  epgChannelId: string;
  hasArchive: boolean;
  archiveDurationDays: number;
  playUrl: string;
  nowPlaying?: EpgProgram | null;
  nextProgram?: EpgProgram | null;
}

export interface LiveChannelDetailResponse {
  channel: LiveChannelSummary;
  programs: EpgProgram[];
  related?: LiveChannelSummary[];
  serverTimestamp: number;
}

export interface EpgChannelGuide {
  channel: LiveChannelSummary;
  programs: EpgProgram[];
}

export interface EpgGuideResponse {
  channels: EpgChannelGuide[];
  totalEpgChannels: number;
  totalMatchingChannels: number;
  page: number;
  totalPages: number;
  serverTimestamp: number;
  windowStart: number;
  windowEnd: number;
}

export interface CatalogStats {
  movieCount: number;
  seriesCount: number;
  liveCount: number;
  epgChannelCount: number;
  catchupCount: number;
}

export interface ComingSoonItem {
  id: string;
  title: string;
  kind: 'movie' | 'series';
  releaseDate: string;
  releaseLabel: string;
  daysUntil: number | null;
  poster: string;
  backdrop?: string;
  year: string | null;
  genre: string;
  overview: string;
  stars?: string;
  imdbId?: string;
  matchedCatalogId?: string;
  matchedCatalogKind?: 'movie' | 'series';
}

export interface HomePayload {
  heroItems: MovieDetail[];
  trendingMovies: MovieSummary[];
  popularSeries: SeriesSummary[];
  featuredLive: LiveChannelSummary[];
  stats: CatalogStats;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  totalPages: number;
  genres?: GenreItem[];
}

export interface AudioTrackInfo {
  index: number;
  languageCode: string;
  languageLabel: string;
  title: string;
  codec: string;
  channels: number;
  channelLayout: string;
  isDefault: boolean;
}

export interface CatalogLanguageVariant {
  kind: 'movie' | 'episode';
  id: string;
  seriesId?: string;
  seasonNum?: number;
  episodeNum?: number;
  language: string;
  fullTitle: string;
  cleanTitle: string;
  categoryName: string;
  extension: string;
  playUrl: string;
  poster: string;
  isCurrent: boolean;
}

export interface SubtitleTrackInfo {
  id: string;
  index: number;
  languageCode: string;
  languageLabel: string;
  title: string;
  codec: string;
  format: 'vtt' | 'srt' | 'ass' | 'ssa' | 'mov_text' | 'bitmap' | 'unknown';
  source: 'embedded' | 'external';
  isDefault: boolean;
  vttUrl?: string;
}

export interface MediaLanguagesResponse {
  activeLanguage: string;
  catalogVariants: CatalogLanguageVariant[];
  audioTracks: AudioTrackInfo[];
  subtitleTracks?: SubtitleTrackInfo[];
}

export interface CastMember {
  name: string;
  photoUrl?: string;
  imdbId?: string;
  role?: string;
  character?: string;
  department?: 'cast' | 'crew';
}

export interface ImdbCastResponse {
  imdbId?: string;
  poster?: string;
  cast: CastMember[];
}

export interface PersonCreditsResponse {
  personName: string;
  movies: MovieSummary[];
  series: SeriesSummary[];
  live: LiveChannelSummary[];
  matchedTitlesCount: number;
}

export interface SubtitleTrack {
  id: string;
  language: string;
  languageCode: string;
  label: string;
  format: string;
  fileName?: string;
  source?: 'opensubtitles' | 'embedded' | 'custom';
  downloadUrl: string;
  vttUrl: string;
  rating?: string;
  downloads?: number;
}

export interface SubtitlesResponse {
  imdbId: string;
  subtitles: SubtitleTrack[];
}

export type DetailTarget =
  | {
      kind: 'movie';
      id: string;
      autoplay?: boolean;
      preferOffline?: boolean;
      resumeSec?: number;
      initialMovie?: {
        title: string;
        subtitle?: string;
        poster?: string;
        playUrl: string;
        extension?: string;
      };
    }
  | {
      kind: 'series';
      id: string;
      episodeId?: string;
      seasonNum?: number;
      episodeNum?: number;
      autoplay?: boolean;
      preferOffline?: boolean;
      resumeSec?: number;
      openDownloadModal?: boolean;
      initialSeason?: string;
    }
  | {
      kind: 'live';
      id: string;
      channel?: LiveChannelSummary;
      initialCatchupProgram?: EpgProgram;
    };

export interface OfflineSubtitleCache {
  id: string;
  language: string;
  vttText: string;
}

export interface OfflineDownloadEntry {
  key: string; // "movie:<id>" | "episode:<episodeId>"
  kind: 'movie' | 'episode';
  id: string;
  seriesId?: string;
  seriesTitle?: string;
  seasonNum?: number;
  episodeNum?: number;
  title: string;
  subtitle?: string;
  categoryName: string;
  year: string | null;
  rating: number;
  duration?: string;
  durationSec?: number;
  plot?: string;
  poster: string;
  posterBlob?: Blob;
  extension: string;
  mimeType: string;
  quality?: DownloadQuality;
  sizeBytes: number;
  chunkCount: number;
  chunkSizes?: number[];
  downloadedAt: number;
  subtitles?: OfflineSubtitleCache[];
  storageBackend?: 'indexeddb' | 'capacitor-native' | 'capacitor-filesystem';
  localFileUri?: string;
  privateFilePath?: string;
  hlsManifestPath?: string;
  isVerifiedPlayable?: boolean;
  transferStatus?: TransferStatus;
  transferProgress?: number;
  transferError?: string;
  exportedUri?: string;
  exportedPath?: string;
  exportedAt?: number;
  downloadProfile?: DownloadProfileMode;
}

export interface DownloadSpeedComparison {
  standardBytesPerSec: number;
  turboBytesPerSec: number;
  increaseBytesPerSec: number;
  increasePercent: number;
  multiplier: number;
}

export interface OfflineDownloadTaskState {
  key: string;
  id?: string;
  title: string;
  subtitle?: string;
  kind: 'movie' | 'episode';
  seriesId?: string;
  seriesTitle?: string;
  seasonNum?: number;
  episodeNum?: number;
  categoryName?: string;
  year?: string | null;
  poster?: string;
  quality: DownloadQuality;
  status: 'queued' | 'downloading' | 'paused' | 'saving' | 'error';
  receivedBytes: number;
  totalBytes: number;
  isEstimatedTotal?: boolean;
  speedBytesPerSec: number;
  etaSeconds?: number;
  percent: number;
  retryCount?: number;
  lastCheckpoint?: string;
  waitingForNetwork?: boolean;
  error?: string;
  storageBackend?: 'indexeddb' | 'capacitor-native' | 'capacitor-filesystem';
  downloadProfile?: DownloadProfileMode;
}

export interface ActivePlayback {
  kind: 'movie' | 'episode' | 'live' | 'catchup';
  id: string;
  seriesId?: string;
  title: string;
  subtitle?: string;
  poster?: string;
  playUrl: string;
  extension?: string;
  resumeSec?: number;
  seriesDetail?: SeriesDetail;
  seasonNum?: number;
  episodeNum?: number;
  liveChannel?: LiveChannelSummary;
  nowPlaying?: EpgProgram | null;
  nextProgram?: EpgProgram | null;
  rating?: number;
  language?: string;
  year?: string | null;
  imdbId?: string;
  isOffline?: boolean;
  localFilePath?: string;
  offlineMimeType?: string;
  offlineDurationSec?: number;
  offlineSubtitles?: OfflineSubtitleCache[];
}

export interface WatchHistoryEntry {
  key: string;
  kind: 'movie' | 'episode';
  id: string;
  seriesId?: string;
  seriesTitle?: string;
  seasonNum?: number;
  episodeNum?: number;
  title: string;
  poster: string;
  playUrl: string;
  extension: string;
  progressSec: number;
  durationSec: number;
  updatedAt: number;
  categoryName?: string;
  rating?: number;
  language?: string;
}

export interface WatchlistEntry {
  key: string;
  kind: 'movie' | 'series';
  id: string;
  title: string;
  poster: string;
  year: string | null;
  rating: number;
  categoryName: string;
  addedAt: number;
}

export interface MediaReview {
  id: string;
  mediaKey: string;
  kind: 'movie' | 'series';
  mediaId: string;
  mediaTitle: string;
  author: string;
  rating: number;
  comment: string;
  createdAt: number;
  updatedAt?: number;
}

export interface RecommendationRequest {
  favoriteGenres: string[];
  watchedMovieIds: string[];
  watchedSeriesIds: string[];
  watchlistMovieIds: string[];
  watchlistSeriesIds: string[];
  watchedCategories: string[];
  watchedLanguages: string[];
  likedTitles?: Array<{ kind: 'movie' | 'series'; id: string; rating: number }>;
  limit?: number;
}

export type RecommendationEntry =
  | {
      kind: 'movie';
      item: MovieSummary;
      score: number;
      reason: string;
      matchedGenres: string[];
    }
  | {
      kind: 'series';
      item: SeriesSummary;
      score: number;
      reason: string;
      matchedGenres: string[];
    };

export interface RecommendationsResponse {
  items: RecommendationEntry[];
  inferredGenres: Array<{ id: string; label: string }>;
  favoriteGenres: string[];
  personalized: boolean;
}

export interface QualitySizeEstimate {
  bytes: number;
  exact: boolean;
  mode: 'direct' | 'transcode';
}

export interface DownloadSizesResponse {
  kind: 'movie' | 'series';
  id: string;
  ext: string;
  contentLength: number;
  durationSec: number;
  browserSafeDirect: boolean;
  isHls: boolean;
  sizes: Record<'360p' | '480p' | '720p' | '1080p', QualitySizeEstimate>;
  expiresAt: number;
}
