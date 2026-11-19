export type StreamFormat = 'ts' | 'm3u8';

export interface XtreamConfig {
  host: string;
  username: string;
  password: string;
  format: StreamFormat;
  isDefault: boolean;
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

export interface HomePayload {
  heroItems: MovieDetail[];
  trendingMovies: MovieSummary[];
  popularSeries: SeriesSummary[];
  featuredLive: LiveChannelSummary[];
  stats: CatalogStats;
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
  subtitleTracks: SubtitleTrackInfo[];
}

export interface LiveChannelDetailResponse {
  channel: LiveChannelSummary;
  programs: EpgProgram[];
  related: LiveChannelSummary[];
  serverTimestamp: number;
}

export interface RecommendationRequest {
  favoriteGenres?: string[];
  watchedMovieIds?: string[];
  watchedSeriesIds?: string[];
  watchlistMovieIds?: string[];
  watchlistSeriesIds?: string[];
  watchedCategories?: string[];
  watchedLanguages?: string[];
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

