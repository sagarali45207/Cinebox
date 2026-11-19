import zlib from 'node:zlib';

interface ImdbSuggestionItem {
  id: string; // e.g. tt1375666 or nm0000138
  l: string;  // title or person name
  q?: string; // e.g. 'feature', 'TV series'
  qid?: string;
  y?: number; // year
  s?: string; // stars or description
  i?: {
    imageUrl: string;
    height?: number;
    width?: number;
  };
}

export interface CastMember {
  name: string;
  photoUrl?: string;
  imdbId?: string;
  role?: string;
  character?: string;
  department?: 'cast' | 'crew';
}

export interface ImdbDetailResult {
  imdbId: string;
  title: string;
  year: number | null;
  poster: string;
  stars: string;
  cast: CastMember[];
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

const imdbCache = new Map<string, { value: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCached<T>(key: string): T | null {
  const item = imdbCache.get(key);
  if (item && item.expiresAt > Date.now()) {
    return item.value as T;
  }
  return null;
}

function setCached<T>(key: string, value: T, ttlMs = CACHE_TTL_MS): void {
  imdbCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

const PLACEHOLDER_CREDIT_NAMES = new Set([
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'unknown',
  'various',
  'cast',
  'actors',
  'actor',
  'actress',
  'director',
  'directors',
  'tba',
  'tbd',
  '-',
  '--',
  '...',
]);

const LANGUAGE_OR_EDITION_PAREN_RE =
  /\(\s*(?:(?:hindi|english|telugu|tamil|malayalam|kannada|punjabi|marathi|bengali|gujarati|urdu|arabic|turkish|spanish|french|german|italian|russian|korean|japanese|chinese|mandarin|cantonese|persian|farsi|pashto|sindhi|bhojpuri|odia|assamese|portuguese|polish|dutch|thai|indonesian|vietnamese|filipino|dual\s*audio|multi\s*audio|multi|dubbed|subbed|subtitles?|eng|hin|tel|tam|mal|kan|urd|ara|tur|orig|original|extended|unrated|uncut|repack|remastered|director'?s?\s*cut|theatrical|cam|hdcam|ts|hdts|4k|2160p|uhd|fhd|1080p|hd|720p|sd|web-?dl|webrip|bluray|dvdrip|hevc|x265|x264)(?:\s*[,/&|+-]\s*)?)+\s*\)/gi;

export function cleanSearchTitle(raw: string): string {
  if (!raw) return '';
  let clean = raw.trim();

  // Strip leading catalog/language prefixes like "EN - Title", "4K | Title", "HI: Title"
  for (let i = 0; i < 3; i++) {
    const stripped = clean
      .replace(
        /^(?:4K|2160P|UHD|FHD|1080P|HD|720P|SD|CAM|EN|ENG|ENGLISH|HI|HIN|HINDI|UR|URDU|TE|TEL|TELUGU|TA|TAM|TAMIL|ML|MAL|MALAYALAM|KN|KAN|KANNADA|PA|PUN|PUNJABI|MR|MARATHI|BN|BENGALI|AR|ARA|ARABIC|TR|TUR|TURKISH|FR|FRE|FRENCH|ES|SPA|SPANISH|DE|GER|GERMAN|PT|POR|PORTUGUESE|IT|ITA|ITALIAN|RU|RUS|RUSSIAN|KO|KOR|KOREAN|JA|JAP|JAPANESE|CN|CHI|CHINESE|PK|IND|IN|US|UK|MULTI|DUAL)\s*[-:|/]+\s*/i,
        '',
      )
      .trim();
    if (stripped === clean) break;
    clean = stripped;
  }

  clean = clean
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(LANGUAGE_OR_EDITION_PAREN_RE, ' ')
    .replace(/\(\s*(19\d{2}|20[0-3]\d)\s*\)/g, ' ')
    .replace(/\(\s*S\d{1,2}(?:\s*[-–]\s*S?\d{1,2})?\s*\)/gi, ' ')
    .replace(/\b(?:4K|2160P|UHD|FHD|1080P|HD|720P|CAM|HDCAM|TS|HDTS|HDR|HEVC|X265|X264|BLURAY|WEB-?DL|WEBRIP|DVDRIP|DUAL\s+AUDIO|MULTI\s+AUDIO|HINDI\s+DUBBED|DUBBED)\b/gi, ' ')
    .replace(/[-:|/]+\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return clean;
}

function normalizeTitleForCompare(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`".,:;!?()[\]{}_/\\+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingArticle(normTitle: string): string {
  return normTitle.replace(/^(?:the|a|an)\s+/i, '').trim();
}

function scoreTitleMatch(requestedTitle: string, candidateTitle: string): number {
  const reqNorm = normalizeTitleForCompare(requestedTitle);
  const candNorm = normalizeTitleForCompare(candidateTitle);
  if (!reqNorm || !candNorm) return 0;

  if (reqNorm === candNorm) return 100;

  const reqNoArt = stripLeadingArticle(reqNorm);
  const candNoArt = stripLeadingArticle(candNorm);
  if (reqNoArt && reqNoArt === candNoArt) return 96;

  const reqTokens = reqNoArt.split(' ').filter(Boolean);
  const candTokens = candNoArt.split(' ').filter(Boolean);
  if (reqTokens.length === 0 || candTokens.length === 0) return 0;

  const candSet = new Set(candTokens);
  let shared = 0;
  for (const t of reqTokens) {
    if (candSet.has(t)) shared++;
  }

  if (shared === 0) return 0;
  const f1 = (2 * shared) / (reqTokens.length + candTokens.length);
  if (f1 >= 0.85) {
    return Math.round(f1 * 95);
  }

  // Handle subtitle cases like "Dhoom 2" vs "Dhoom 2: Back in Action" only when the base matches tightly
  if (
    reqTokens.length >= 2 &&
    candTokens.length > reqTokens.length &&
    candTokens.slice(0, reqTokens.length).join(' ') === reqTokens.join(' ')
  ) {
    return 86;
  }

  return Math.round(f1 * 70);
}

function normalizePersonName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:jr|sr|ii|iii|iv)\.?\b/g, ' ')
    .replace(/[’'`".,:;!?()[\]{}_/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseCleanPersonList(raw?: string): string[] {
  if (!raw) return [];
  const results: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;/|\n]+/)) {
    const clean = part.trim().replace(/\s{2,}/g, ' ');
    const lower = clean.toLowerCase();
    if (
      !clean ||
      clean.length < 2 ||
      /^\d+$/.test(clean) ||
      PLACEHOLDER_CREDIT_NAMES.has(lower) ||
      /^n\/a$/i.test(clean) ||
      /^unknown$/i.test(clean)
    ) {
      continue;
    }
    const norm = normalizePersonName(clean);
    if (!norm || norm.length < 2 || seen.has(norm)) continue;
    seen.add(norm);
    results.push(clean);
  }
  return results;
}

function doPersonNamesMatch(a: string, b: string): boolean {
  const normA = normalizePersonName(a);
  const normB = normalizePersonName(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const tokensA = normA.split(' ').filter((t) => t.length >= 2);
  const tokensB = normB.split(' ').filter((t) => t.length >= 2);
  if (tokensA.length >= 2 && tokensB.length >= 2) {
    const setB = new Set(tokensB);
    let shared = 0;
    for (const t of tokensA) {
      if (setB.has(t)) shared++;
    }
    if (shared >= 2) return true;
  }
  return false;
}

function hasCastOverlap(knownNames: string[], candidateNamesOrCsv: string | string[]): boolean {
  if (knownNames.length === 0) return false;
  const candidateList = Array.isArray(candidateNamesOrCsv)
    ? candidateNamesOrCsv
    : parseCleanPersonList(candidateNamesOrCsv);
  if (candidateList.length === 0) return false;
  return knownNames.some((k) => candidateList.some((c) => doPersonNamesMatch(k, c)));
}

function isImdbItemCompatibleKind(item: ImdbSuggestionItem, kind?: string): boolean {
  const qid = (item.qid || '').toLowerCase();
  const q = (item.q || '').toLowerCase();

  // Always reject unrelated entertainment formats
  if (
    qid === 'videogame' ||
    qid === 'tvepisode' ||
    qid === 'podcastseries' ||
    qid === 'podcastepisode' ||
    qid === 'musicvideo' ||
    q.includes('video game') ||
    q.includes('tv episode') ||
    q.includes('podcast')
  ) {
    return false;
  }

  if (kind === 'series') {
    if (qid) {
      return qid === 'tvseries' || qid === 'tvminiseries';
    }
    if (q) {
      return q.includes('series');
    }
    return false;
  }

  if (kind === 'movie') {
    if (qid) {
      return qid === 'movie' || qid === 'tvmovie' || qid === 'short' || qid === 'video';
    }
    if (q) {
      return q === 'feature' || q.includes('movie') || q === 'short' || q === 'video';
    }
    return true;
  }

  return true;
}

/**
 * Searches IMDb suggestions for a movie or TV series with strict kind, title, year, and cast validation
 */
export async function searchImdbTitle(
  title: string,
  year?: string | null,
  kind?: string,
  knownCastNames?: string[],
): Promise<{ imdbId: string; title: string; year: number | null; poster: string; stars: string } | null> {
  const clean = cleanSearchTitle(title);
  if (!clean) return null;

  const normalizedCastKey = (knownCastNames || []).slice(0, 4).map(normalizePersonName).join(',');
  const cacheKey = `imdb_title_v2_${clean.toLowerCase()}_${year || ''}_${kind || ''}_${normalizedCastKey}`;
  const cached = getCached<{ imdbId: string; title: string; year: number | null; poster: string; stars: string } | null>(cacheKey);
  if (cached !== undefined && cached !== null) return cached;

  try {
    const firstChar = clean[0].toLowerCase();
    const url = `https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(firstChar)}/${encodeURIComponent(clean)}.json`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { d?: ImdbSuggestionItem[] };
    const items = data.d || [];

    const titles = items.filter((x) => x.id && x.id.startsWith('tt'));
    if (titles.length === 0) return null;

    const targetYearRaw = year ? Number(year) : null;
    const targetYear =
      targetYearRaw && Number.isFinite(targetYearRaw) && targetYearRaw >= 1900 && targetYearRaw <= 2035
        ? targetYearRaw
        : null;
    const castList = knownCastNames || [];

    let bestItem: ImdbSuggestionItem | null = null;
    let bestScore = -1;

    for (const item of titles) {
      if (!isImdbItemCompatibleKind(item, kind)) continue;

      const titleScore = scoreTitleMatch(clean, item.l || '');
      if (titleScore < 85) continue;

      // Enforce year tolerance whenever targetYear is known
      let yearScore = 0;
      if (targetYear !== null) {
        if (item.y) {
          const diff = Math.abs(item.y - targetYear);
          if (diff > 2) continue;
          yearScore = diff === 0 ? 30 : diff === 1 ? 20 : 10;
        } else if (titleScore < 96) {
          continue;
        }
      }

      // Enforce cast overlap when known cast from Xtream and IMDb stars are both populated
      let castScore = 0;
      const itemStars = item.s || '';
      if (castList.length >= 2 && itemStars.trim()) {
        const starNames = parseCleanPersonList(itemStars);
        if (starNames.length >= 2) {
          if (hasCastOverlap(castList, starNames)) {
            castScore = 50;
          } else {
            // Completely different actors when Xtream already provided real actors -> collision / remake
            if (targetYear === null || castList.length >= 3) {
              continue;
            }
          }
        }
      }

      // Require either cast confirmation or very high title certainty when year is unknown on a series
      if (targetYear === null && kind === 'series' && titleScore < 92 && castScore === 0) {
        continue;
      }

      const totalScore = titleScore + yearScore + castScore + (item.i?.imageUrl ? 3 : 0);
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestItem = item;
      }
    }

    if (!bestItem) {
      return null;
    }

    const result = {
      imdbId: bestItem.id,
      title: bestItem.l,
      year: bestItem.y || null,
      poster: bestItem.i?.imageUrl || '',
      stars: bestItem.s || '',
    };

    setCached(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`IMDb search failed for "${clean}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Searches IMDb for an actor/cast member to retrieve their picture (strict exact-name verification)
 */
export async function getCastMemberPicture(actorName: string): Promise<CastMember> {
  const name = actorName.trim();
  if (!name) return { name: '' };

  const cacheKey = `imdb_person_v2_${name.toLowerCase()}`;
  const cached = getCached<CastMember>(cacheKey);
  if (cached) return cached;

  try {
    const firstChar = name[0].toLowerCase();
    const url = `https://v2.sg.media-imdb.com/suggestion/${encodeURIComponent(firstChar)}/${encodeURIComponent(name)}.json`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) return { name };
    const data = (await res.json()) as { d?: ImdbSuggestionItem[] };
    const items = data.d || [];

    const reqNorm = normalizePersonName(name);
    const people = items.filter((x) => x.id && x.id.startsWith('nm'));
    const matched = people.find((p) => normalizePersonName(p.l || '') === reqNorm);

    if (!matched) {
      const result: CastMember = { name };
      setCached(cacheKey, result);
      return result;
    }

    const result: CastMember = {
      name,
      photoUrl: matched.i?.imageUrl || undefined,
      imdbId: matched.id || undefined,
      role: matched.s || undefined,
    };

    setCached(cacheKey, result);
    return result;
  } catch {
    return { name };
  }
}

function cleanProfessionFromImdbSummary(summary?: string): string {
  if (!summary) return '';
  const firstPart = summary.split(',')[0]?.trim() || '';
  if (/^(actor|actress|director|writer|producer|composer|cinematographer|editor|creator)$/i.test(firstPart)) {
    return firstPart.charAt(0).toUpperCase() + firstPart.slice(1).toLowerCase();
  }
  return '';
}

interface TitleEnrichmentResult {
  imdbId?: string;
  charactersByName: Map<string, { displayName: string; character?: string; photoUrl?: string }>;
  crew: Array<{ name: string; role: string; photoUrl?: string }>;
}

async function fetchTitleCrewAndCharacters(
  title: string,
  opts: {
    imdbId?: string;
    tmdbId?: string;
    year?: string | null;
    kind?: string;
    knownCastNames?: string[];
    knownDirectors?: string[];
  },
): Promise<TitleEnrichmentResult> {
  const clean = cleanSearchTitle(title);
  const imdbId = opts.imdbId && /^tt\d+$/i.test(opts.imdbId) ? opts.imdbId : undefined;
  const numericTmdbId = opts.tmdbId && /^\d+$/.test(opts.tmdbId) ? opts.tmdbId : undefined;
  const kind = opts.kind;
  const knownAll = [...(opts.knownCastNames || []), ...(opts.knownDirectors || [])];

  const cacheKey = `title_enrichment_v2_${imdbId || ''}_${numericTmdbId || ''}_${clean.toLowerCase()}_${opts.year || ''}_${kind || ''}`;
  const cached = getCached<TitleEnrichmentResult>(cacheKey);
  if (cached) return cached;

  const charactersByName = new Map<string, { displayName: string; character?: string; photoUrl?: string }>();
  const crewMap = new Map<string, { name: string; roles: Set<string>; photoUrl?: string }>();
  let resolvedImdbId: string | undefined = imdbId;

  const addCrew = (name: string, role: string, photoUrl?: string) => {
    const cleanName = name.trim();
    if (!cleanName || PLACEHOLDER_CREDIT_NAMES.has(cleanName.toLowerCase())) return;
    const key = normalizePersonName(cleanName);
    if (!key) return;
    const existing = crewMap.get(key);
    if (existing) {
      existing.roles.add(role);
      if (!existing.photoUrl && photoUrl) existing.photoUrl = photoUrl;
    } else {
      crewMap.set(key, { name: cleanName, roles: new Set([role]), photoUrl });
    }
  };

  const targetYearRaw = opts.year ? Number(opts.year) : null;
  const targetYear =
    targetYearRaw && Number.isFinite(targetYearRaw) && targetYearRaw >= 1900 && targetYearRaw <= 2035
      ? targetYearRaw
      : null;

  const tasks: Array<Promise<void>> = [];

  // 1. Strict TVmaze lookup ONLY for TV series (never use fuzzy singlesearch!)
  if (clean && kind === 'series') {
    tasks.push(
      fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(clean)}`, {
        signal: AbortSignal.timeout(3500),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const candidates = (await res.json()) as Array<{
            score?: number;
            show?: {
              id?: number;
              name?: string;
              premiered?: string;
              externals?: { imdb?: string | null };
            };
          }>;
          if (!Array.isArray(candidates) || candidates.length === 0) return;

          const matchedCandidate = candidates.find((c) => {
            const show = c.show;
            if (!show?.id || !show.name) return false;
            const tScore = scoreTitleMatch(clean, show.name);
            if (tScore < 94) return false;
            if (targetYear !== null && show.premiered) {
              const py = Number(show.premiered.slice(0, 4));
              if (Number.isFinite(py) && Math.abs(py - targetYear) > 2) return false;
            }
            if (imdbId && show.externals?.imdb && show.externals.imdb.toLowerCase() !== imdbId.toLowerCase()) {
              return false;
            }
            return true;
          });

          if (!matchedCandidate?.show?.id) return;

          const showRes = await fetch(
            `https://api.tvmaze.com/shows/${matchedCandidate.show.id}?embed[]=cast&embed[]=crew`,
            { signal: AbortSignal.timeout(3500) },
          );
          if (!showRes.ok) return;
          const data = (await showRes.json()) as {
            externals?: { imdb?: string | null };
            _embedded?: {
              cast?: Array<{
                person?: { name?: string; image?: { medium?: string; original?: string } };
                character?: { name?: string };
              }>;
              crew?: Array<{
                type?: string;
                person?: { name?: string; image?: { medium?: string; original?: string } };
              }>;
            };
          };

          const tvCast = data._embedded?.cast || [];
          const tvCastNames = tvCast
            .map((item) => item.person?.name?.trim() || '')
            .filter(Boolean);

          // If Xtream already provided real cast names, require overlap before merging TVmaze cast/crew
          if (knownAll.length >= 2 && tvCastNames.length >= 2 && !hasCastOverlap(knownAll, tvCastNames)) {
            return;
          }

          if (!resolvedImdbId && data.externals?.imdb && /^tt\d+$/i.test(data.externals.imdb)) {
            resolvedImdbId = data.externals.imdb;
          }

          for (const item of tvCast) {
            const pName = item.person?.name?.trim();
            if (!pName) continue;
            const key = normalizePersonName(pName);
            if (!key) continue;
            const charName = item.character?.name?.trim();
            const photoUrl = item.person?.image?.medium || item.person?.image?.original;
            charactersByName.set(key, { displayName: pName, character: charName, photoUrl });
          }
          for (const item of data._embedded?.crew || []) {
            const pName = item.person?.name?.trim();
            const roleType = item.type?.trim();
            if (!pName || !roleType) continue;
            const photoUrl = item.person?.image?.medium || item.person?.image?.original;
            addCrew(pName, roleType, photoUrl);
          }
        })
        .catch(() => {}),
    );
  }

  // 2. Wikidata lookup by exact IMDb ID or exact TMDB ID
  const wikidataWorkMatcher = imdbId
    ? `?work wdt:P345 "${imdbId}" .`
    : numericTmdbId
      ? kind === 'series'
        ? `?work wdt:P4983 "${numericTmdbId}" .`
        : `?work wdt:P4947 "${numericTmdbId}" .`
      : '';

  if (wikidataWorkMatcher) {
    const sparqlCast = `SELECT ?personLabel ?charLabel ?imdb WHERE {
      ${wikidataWorkMatcher}
      OPTIONAL { ?work wdt:P345 ?imdb . }
      ?work p:P161 ?stmt .
      ?stmt ps:P161 ?person .
      ?person rdfs:label ?personLabel . FILTER(LANG(?personLabel)="en")
      OPTIONAL { ?stmt pq:P453 ?char . ?char rdfs:label ?charLabel . FILTER(LANG(?charLabel)="en") }
    } LIMIT 24`;

    const sparqlCrew = `SELECT ?personLabel ?prop WHERE {
      ${wikidataWorkMatcher}
      VALUES ?prop { wdt:P57 wdt:P58 wdt:P86 }
      ?work ?prop ?person .
      ?person rdfs:label ?personLabel . FILTER(LANG(?personLabel)="en")
    } LIMIT 16`;

    tasks.push(
      fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparqlCast)}`, {
        headers: {
          'User-Agent': 'CineBoxApp/1.0',
          Accept: 'application/sparql-results+json',
        },
        signal: AbortSignal.timeout(3500),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const json = (await res.json()) as {
            results?: {
              bindings?: Array<{
                personLabel?: { value?: string };
                charLabel?: { value?: string };
                imdb?: { value?: string };
              }>;
            };
          };
          const bindings = json.results?.bindings || [];
          const wdNames = bindings.map((b) => b.personLabel?.value?.trim() || '').filter(Boolean);
          if (knownAll.length >= 2 && wdNames.length >= 2 && !hasCastOverlap(knownAll, wdNames)) {
            return;
          }

          for (const b of bindings) {
            if (!resolvedImdbId && b.imdb?.value && /^tt\d+$/i.test(b.imdb.value)) {
              resolvedImdbId = b.imdb.value;
            }
            const pName = b.personLabel?.value?.trim();
            const charName = b.charLabel?.value?.trim();
            if (!pName) continue;
            const key = normalizePersonName(pName);
            if (!key) continue;
            const prev = charactersByName.get(key);
            if (!prev || (!prev.character && charName)) {
              charactersByName.set(key, {
                displayName: prev?.displayName || pName,
                character: charName || prev?.character,
                photoUrl: prev?.photoUrl,
              });
            }
          }
        })
        .catch(() => {}),
    );

    tasks.push(
      fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparqlCrew)}`, {
        headers: {
          'User-Agent': 'CineBoxApp/1.0',
          Accept: 'application/sparql-results+json',
        },
        signal: AbortSignal.timeout(3500),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const json = (await res.json()) as {
            results?: { bindings?: Array<{ personLabel?: { value?: string }; prop?: { value?: string } }> };
          };
          for (const b of json.results?.bindings || []) {
            const pName = b.personLabel?.value?.trim();
            const prop = b.prop?.value || '';
            if (!pName) continue;
            const role = prop.endsWith('/P57')
              ? 'Director'
              : prop.endsWith('/P58')
                ? 'Writer'
                : prop.endsWith('/P86')
                  ? 'Composer'
                  : 'Crew';
            addCrew(pName, role);
          }
        })
        .catch(() => {}),
    );
  }

  await Promise.all(tasks);

  const crew = Array.from(crewMap.values()).map((entry) => ({
    name: entry.name,
    role: Array.from(entry.roles).slice(0, 2).join(' · '),
    photoUrl: entry.photoUrl,
  }));

  const result: TitleEnrichmentResult = {
    imdbId: resolvedImdbId,
    charactersByName,
    crew,
  };
  setCached(cacheKey, result, 12 * 60 * 60 * 1000);
  return result;
}

/**
 * Resolves full cast & crew with pictures, characters, and roles.
 * Returns an empty cast array when no verified credits exist so unavailable titles cleanly disable the section.
 */
export async function getFullCastWithPictures(
  title: string,
  year?: string | null,
  knownCastStr?: string,
  knownDirectorStr?: string,
  kind?: string,
  tmdbId?: string,
): Promise<{ imdbId?: string; poster?: string; cast: CastMember[] }> {
  const xtreamCast = parseCleanPersonList(knownCastStr);
  const xtreamDirectors = parseCleanPersonList(knownDirectorStr);
  const knownAll = [...xtreamCast, ...xtreamDirectors];

  const trimmedExternalId = (tmdbId || '').trim();
  const explicitImdbId = /^tt\d+$/i.test(trimmedExternalId) ? trimmedExternalId : undefined;
  const numericTmdbId = /^\d+$/.test(trimmedExternalId) ? trimmedExternalId : undefined;

  const imdbInfo = explicitImdbId
    ? { imdbId: explicitImdbId, title, year: year ? Number(year) || null : null, poster: '', stars: '' }
    : await searchImdbTitle(title, year, kind, knownAll);

  const enrichment = await fetchTitleCrewAndCharacters(title, {
    imdbId: imdbInfo?.imdbId,
    tmdbId: numericTmdbId,
    year,
    kind,
    knownCastNames: xtreamCast,
    knownDirectors: xtreamDirectors,
  });

  const finalImdbId = imdbInfo?.imdbId || enrichment.imdbId;

  // Build deduplicated cast names (verified Xtream cast + verified IMDb stars + verified Wikidata/TVmaze cast)
  const castNames: string[] = [];
  const castNormSet = new Set<string>();
  const pushCastName = (rawName: string) => {
    const clean = rawName.trim();
    const norm = normalizePersonName(clean);
    if (!clean || !norm || PLACEHOLDER_CREDIT_NAMES.has(clean.toLowerCase())) return;
    if (!castNormSet.has(norm)) {
      castNormSet.add(norm);
      castNames.push(clean);
    }
  };

  for (const name of xtreamCast) {
    pushCastName(name);
  }
  if (imdbInfo?.stars) {
    for (const name of parseCleanPersonList(imdbInfo.stars)) {
      pushCastName(name);
    }
  }
  for (const [, entry] of enrichment.charactersByName) {
    if (castNames.length >= 16) break;
    pushCastName(entry.displayName);
  }

  // Build deduplicated crew entries (verified Xtream directors + verified enriched crew)
  const crewMap = new Map<string, { name: string; role: string; photoUrl?: string }>();
  for (const dirName of xtreamDirectors) {
    const norm = normalizePersonName(dirName);
    if (!norm) continue;
    crewMap.set(norm, { name: dirName, role: 'Director' });
  }
  for (const item of enrichment.crew) {
    const norm = normalizePersonName(item.name);
    if (!norm) continue;
    const existing = crewMap.get(norm);
    if (existing) {
      if (!existing.role.toLowerCase().includes(item.role.toLowerCase())) {
        existing.role = `${existing.role} · ${item.role}`;
      }
      if (!existing.photoUrl && item.photoUrl) existing.photoUrl = item.photoUrl;
    } else {
      crewMap.set(norm, { ...item });
    }
  }

  const targetCast = castNames.slice(0, 14);
  const targetCrew = Array.from(crewMap.values()).slice(0, 8);

  if (targetCast.length === 0 && targetCrew.length === 0) {
    return {
      imdbId: finalImdbId,
      poster: imdbInfo?.poster || undefined,
      cast: [],
    };
  }

  // Fetch verified IMDb person pictures concurrently in batches of 4
  const resolvedCast: CastMember[] = [];
  for (let i = 0; i < targetCast.length; i += 4) {
    const chunk = targetCast.slice(i, i + 4);
    const chunkResults = await Promise.all(
      chunk.map(async (name) => {
        const person = await getCastMemberPicture(name);
        const charInfo = enrichment.charactersByName.get(normalizePersonName(name));
        const profession = cleanProfessionFromImdbSummary(person.role);
        const character = charInfo?.character;
        return {
          name: person.name,
          photoUrl: person.photoUrl || charInfo?.photoUrl,
          imdbId: person.imdbId,
          character,
          role: character ? `as ${character}` : profession || 'Cast',
          department: 'cast' as const,
        };
      }),
    );
    resolvedCast.push(...chunkResults);
  }

  const resolvedCrew: CastMember[] = [];
  for (let i = 0; i < targetCrew.length; i += 4) {
    const chunk = targetCrew.slice(i, i + 4);
    const chunkResults = await Promise.all(
      chunk.map(async (crewItem) => {
        const person = await getCastMemberPicture(crewItem.name);
        return {
          name: crewItem.name,
          photoUrl: person.photoUrl || crewItem.photoUrl,
          imdbId: person.imdbId,
          role: crewItem.role,
          department: 'crew' as const,
        };
      }),
    );
    resolvedCrew.push(...chunkResults);
  }

  return {
    imdbId: finalImdbId,
    poster: imdbInfo?.poster || undefined,
    cast: [...resolvedCast, ...resolvedCrew],
  };
}

/**
 * Queries Wikidata & TVmaze for a cast or crew member's known movies & TV shows
 */
export async function getPersonFilmographyTitles(
  name: string,
  imdbId?: string,
): Promise<string[]> {
  const cleanName = name.trim();
  if (!cleanName) return [];

  const cacheKey = `person_filmography_${cleanName.toLowerCase()}_${imdbId || ''}`;
  const cached = getCached<string[]>(cacheKey);
  if (cached) return cached;

  const titlesSet = new Set<string>();

  const wikidataTask = async () => {
    try {
      const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
        cleanName,
      )}&language=en&format=json&limit=5`;
      const searchRes = await fetch(searchUrl, {
        headers: { 'User-Agent': 'CineBoxApp/1.0' },
        signal: AbortSignal.timeout(4500),
      });
      if (!searchRes.ok) return;
      const searchData = (await searchRes.json()) as {
        search?: Array<{ id?: string; label?: string; description?: string }>;
      };
      const candidates = searchData.search || [];
      if (candidates.length === 0) return;

      const preferred =
        candidates.find((c) =>
          /\b(actor|actress|director|filmmaker|producer|writer|screenwriter|comedian|cinema|film|television)\b/i.test(
            c.description || '',
          ),
        ) || candidates[0];

      if (!preferred?.id) return;

      const sparql = `SELECT DISTINCT ?title WHERE {
        ?work wdt:P161|wdt:P57|wdt:P58|wdt:P162 wd:${preferred.id} .
        ?work rdfs:label ?title .
        FILTER(LANG(?title)="en")
      } LIMIT 120`;

      const sparqlRes = await fetch(
        `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
        {
          headers: {
            'User-Agent': 'CineBoxApp/1.0',
            Accept: 'application/sparql-results+json',
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!sparqlRes.ok) return;
      const sparqlData = (await sparqlRes.json()) as {
        results?: { bindings?: Array<{ title?: { value?: string } }> };
      };
      for (const row of sparqlData.results?.bindings || []) {
        const t = row.title?.value?.trim();
        if (t) titlesSet.add(t);
      }
    } catch {
      // Ignore upstream Wikidata errors
    }
  };

  const tvmazeTask = async () => {
    try {
      const pRes = await fetch(
        `https://api.tvmaze.com/search/people?q=${encodeURIComponent(cleanName)}`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (!pRes.ok) return;
      const pArr = (await pRes.json()) as Array<{ person?: { id?: number; name?: string } }>;
      const match =
        pArr.find((p) => p.person?.name?.toLowerCase() === cleanName.toLowerCase()) || pArr[0];
      const pid = match?.person?.id;
      if (!pid) return;

      const [castRes, crewRes] = await Promise.all([
        fetch(`https://api.tvmaze.com/people/${pid}/castcredits?embed=show`, {
          signal: AbortSignal.timeout(4000),
        })
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
        fetch(`https://api.tvmaze.com/people/${pid}/crewcredits?embed=show`, {
          signal: AbortSignal.timeout(4000),
        })
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ]);

      for (const item of [...(Array.isArray(castRes) ? castRes : []), ...(Array.isArray(crewRes) ? crewRes : [])]) {
        const showName = (item as { _embedded?: { show?: { name?: string } } })?._embedded?.show?.name?.trim();
        if (showName) titlesSet.add(showName);
      }
    } catch {
      // Ignore upstream TVmaze errors
    }
  };

  await Promise.all([wikidataTask(), tvmazeTask()]);

  const result = Array.from(titlesSet);
  setCached(cacheKey, result, 12 * 60 * 60 * 1000);
  return result;
}

const ISO_LANG_NAMES: Record<string, string> = {
  en: 'English',
  eng: 'English',
  es: 'Spanish',
  spa: 'Spanish',
  fr: 'French',
  fre: 'French',
  fra: 'French',
  de: 'German',
  ger: 'German',
  deu: 'German',
  it: 'Italian',
  ita: 'Italian',
  pt: 'Portuguese',
  por: 'Portuguese',
  pob: 'Portuguese (BR)',
  hi: 'Hindi',
  hin: 'Hindi',
  ur: 'Urdu',
  urd: 'Urdu',
  ar: 'Arabic',
  ara: 'Arabic',
  tr: 'Turkish',
  tur: 'Turkish',
  ru: 'Russian',
  rus: 'Russian',
  id: 'Indonesian',
  ind: 'Indonesian',
  ms: 'Malay',
  may: 'Malay',
  ko: 'Korean',
  kor: 'Korean',
  ja: 'Japanese',
  jpn: 'Japanese',
  zh: 'Chinese',
  chi: 'Chinese',
  zho: 'Chinese',
  nl: 'Dutch',
  dut: 'Dutch',
  nld: 'Dutch',
  pl: 'Polish',
  pol: 'Polish',
  sv: 'Swedish',
  swe: 'Swedish',
  no: 'Norwegian',
  nor: 'Norwegian',
  da: 'Danish',
  dan: 'Danish',
  fi: 'Finnish',
  fin: 'Finnish',
  el: 'Greek',
  gre: 'Greek',
  he: 'Hebrew',
  heb: 'Hebrew',
  fa: 'Persian',
  per: 'Persian',
  vi: 'Vietnamese',
  vie: 'Vietnamese',
  th: 'Thai',
  tha: 'Thai',
  ro: 'Romanian',
  rum: 'Romanian',
  ta: 'Tamil',
  tam: 'Tamil',
  te: 'Telugu',
  tel: 'Telugu',
  bn: 'Bengali',
  ben: 'Bengali',
  pa: 'Punjabi',
  pan: 'Punjabi',
};

const SUBTITLE_PRIORITY_LANGS = [
  'English',
  'Hindi',
  'Urdu',
  'Arabic',
  'Spanish',
  'French',
  'Portuguese',
  'German',
  'Turkish',
  'Indonesian',
];

function mapLanguageLabelFromCode(code?: string, fallbackName?: string): string {
  const cleanName = (fallbackName || '').trim();
  if (cleanName && cleanName.toLowerCase() !== 'unknown') return cleanName;
  const norm = (code || '').trim().toLowerCase();
  if (norm && ISO_LANG_NAMES[norm]) return ISO_LANG_NAMES[norm];
  return cleanName || (norm ? norm.toUpperCase() : 'Unknown');
}

function isAllowedSubtitleUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'dl.opensubtitles.org' ||
      host.endsWith('.opensubtitles.org') ||
      host === 'opensubtitles.org' ||
      host.endsWith('.strem.io')
    );
  } catch {
    return false;
  }
}

interface RawOpenSubItem {
  IDSubtitleFile?: string;
  LanguageName?: string;
  ISO639?: string;
  SubFormat?: string;
  SubFileName?: string;
  MovieReleaseName?: string;
  SubDownloadLink?: string;
  SubRating?: string;
  SubDownloadsCnt?: string;
}

function collectSubtitleTracks(
  rawTracks: SubtitleTrack[],
  maxPerLanguage = 3,
  maxTotal = 75,
): SubtitleTrack[] {
  const byLangBuckets = new Map<string, SubtitleTrack[]>();
  const seenUrls = new Set<string>();

  for (const track of rawTracks) {
    if (!track.downloadUrl || seenUrls.has(track.downloadUrl)) continue;
    seenUrls.add(track.downloadUrl);

    const bucket = byLangBuckets.get(track.language) || [];
    bucket.push(track);
    byLangBuckets.set(track.language, bucket);
  }

  const kept: SubtitleTrack[] = [];
  for (const [, list] of byLangBuckets.entries()) {
    list.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    kept.push(...list.slice(0, maxPerLanguage));
  }

  kept.sort((a, b) => {
    const idxA = SUBTITLE_PRIORITY_LANGS.indexOf(a.language);
    const idxB = SUBTITLE_PRIORITY_LANGS.indexOf(b.language);
    if (idxA !== -1 && idxB !== -1) {
      if (idxA !== idxB) return idxA - idxB;
      return (b.downloads || 0) - (a.downloads || 0);
    }
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    const cmp = a.language.localeCompare(b.language);
    if (cmp !== 0) return cmp;
    return (b.downloads || 0) - (a.downloads || 0);
  });

  return kept.slice(0, maxTotal);
}

async function fetchRestOpenSubtitles(url: string): Promise<SubtitleTrack[]> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'TemporaryUserAgent',
      },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return [];
    const items = (await res.json()) as RawOpenSubItem[];
    if (!Array.isArray(items)) return [];

    const parsed: SubtitleTrack[] = [];
    for (const item of items) {
      const dlLink = item.SubDownloadLink;
      if (!dlLink) continue;
      const langCode = (item.ISO639 || 'en').toLowerCase();
      const langName = mapLanguageLabelFromCode(langCode, item.LanguageName);
      const format = (item.SubFormat || 'srt').toLowerCase();
      const id = String(item.IDSubtitleFile || Math.random().toString(36).slice(2));
      const downloads = Number(item.SubDownloadsCnt || 0) || 0;
      const fileName = (item.SubFileName || item.MovieReleaseName || '').trim() || undefined;

      parsed.push({
        id,
        language: langName,
        languageCode: langCode,
        label: langName,
        format,
        fileName,
        source: 'opensubtitles',
        downloadUrl: dlLink,
        vttUrl: `/api/subtitles/vtt?url=${encodeURIComponent(dlLink)}`,
        rating: item.SubRating,
        downloads,
      });
    }
    return parsed;
  } catch {
    return [];
  }
}

async function fetchStremioOpenSubtitlesFallback(
  imdbId: string,
  season?: number,
  episode?: number,
): Promise<SubtitleTrack[]> {
  if (!imdbId) return [];
  const cleanImdb = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
  const isEp = typeof season === 'number' && typeof episode === 'number';
  const url = isEp
    ? `https://opensubtitles-v3.strem.io/subtitles/series/${encodeURIComponent(cleanImdb)}:${season}:${episode}.json`
    : `https://opensubtitles-v3.strem.io/subtitles/movie/${encodeURIComponent(cleanImdb)}.json`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      subtitles?: Array<{
        id?: string;
        url?: string;
        lang?: string;
        subtitleFileName?: string;
        movieReleaseName?: string;
      }>;
    };
    const items = data.subtitles;
    if (!Array.isArray(items)) return [];

    return items
      .filter((it) => Boolean(it.url))
      .map((it, idx) => {
        const langCode = (it.lang || 'en').toLowerCase();
        const langName = mapLanguageLabelFromCode(langCode);
        const dlUrl = String(it.url);
        return {
          id: String(it.id || `strem_${idx}_${langCode}`),
          language: langName,
          languageCode: langCode,
          label: langName,
          format: 'srt',
          fileName: (it.subtitleFileName || it.movieReleaseName || '').trim() || undefined,
          source: 'opensubtitles' as const,
          downloadUrl: dlUrl,
          vttUrl: `/api/subtitles/vtt?url=${encodeURIComponent(dlUrl)}`,
          downloads: Math.max(1, items.length - idx),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fetches available multi-language subtitles from OpenSubtitles (+ fallback mirror + custom text query)
 */
export async function getSubtitlesForStream(opts: {
  imdbId?: string;
  title?: string;
  year?: string | null;
  kind?: 'movie' | 'series';
  season?: number;
  episode?: number;
  query?: string;
}): Promise<{ imdbId: string; subtitles: SubtitleTrack[] }> {
  const customQuery = (opts.query || '').trim();
  const isEpisode = typeof opts.season === 'number' && typeof opts.episode === 'number';
  const lookupKind = opts.kind || (isEpisode ? 'series' : 'movie');

  let imdbId = customQuery ? '' : opts.imdbId || '';
  if (!imdbId && (customQuery || opts.title)) {
    const lookupTitle = customQuery || opts.title || '';
    const found = await searchImdbTitle(lookupTitle, customQuery ? null : opts.year, lookupKind);
    if (found) imdbId = found.imdbId;
  }

  const cacheKey = customQuery
    ? `subs_q_${customQuery.toLowerCase()}_s${opts.season ?? 0}_e${opts.episode ?? 0}`
    : `subs_v2_${(imdbId || opts.title || '').toLowerCase()}_s${opts.season ?? 0}_e${opts.episode ?? 0}`;
  const cached = getCached<{ imdbId: string; subtitles: SubtitleTrack[] }>(cacheKey);
  if (cached) return cached;

  const collected: SubtitleTrack[] = [];

  try {
    if (imdbId) {
      const cleanNum = imdbId.replace(/^tt/i, '');
      const restUrl = isEpisode
        ? `https://rest.opensubtitles.org/search/episode-${opts.episode}/imdbid-${cleanNum}/season-${opts.season}`
        : `https://rest.opensubtitles.org/search/imdbid-${cleanNum}`;
      const primary = await fetchRestOpenSubtitles(restUrl);
      collected.push(...primary);

      if (collected.length < 5) {
        const mirror = await fetchStremioOpenSubtitlesFallback(imdbId, opts.season, opts.episode);
        collected.push(...mirror);
      }
    }

    const searchPhrase = customQuery || (!imdbId ? cleanSearchTitle(opts.title || '') : '');
    if (searchPhrase && (customQuery || collected.length === 0)) {
      const encodedPhrase = encodeURIComponent(searchPhrase);
      const queryUrl = isEpisode
        ? `https://rest.opensubtitles.org/search/episode-${opts.episode}/query-${encodedPhrase}/season-${opts.season}`
        : `https://rest.opensubtitles.org/search/query-${encodedPhrase}`;
      const queryResults = await fetchRestOpenSubtitles(queryUrl);
      collected.push(...queryResults);
    }

    const subtitles = collectSubtitleTracks(collected, 3, 75);
    const result = { imdbId, subtitles };
    if (subtitles.length > 0) {
      setCached(cacheKey, result, 6 * 60 * 60 * 1000);
    }
    return result;
  } catch (err) {
    console.warn(`Subtitle fetch failed for ${imdbId || opts.title}:`, err instanceof Error ? err.message : err);
    return { imdbId, subtitles: [] };
  }
}

function decodeSubtitleBuffer(buffer: Buffer): string {
  // Handle UTF-16 BOM if present
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buffer);
    } catch {
      return buffer.toString('latin1');
    }
  }
}

/**
 * Downloads .gz or .srt/.vtt from OpenSubtitles, decompresses, and converts to WebVTT
 */
export async function downloadAndConvertToVtt(downloadUrl: string): Promise<string> {
  if (!isAllowedSubtitleUrl(downloadUrl)) {
    throw new Error('Unsupported subtitle host');
  }

  const cacheKey = `vtt_content_v2_${downloadUrl}`;
  const cached = getCached<string>(cacheKey);
  if (cached) return cached;

  const res = await fetch(downloadUrl, {
    headers: { 'User-Agent': 'TemporaryUserAgent' },
    signal: AbortSignal.timeout(14000),
  });

  if (!res.ok) {
    throw new Error(`Failed to download subtitle: HTTP ${res.status}`);
  }

  const arrayBuf = await res.arrayBuffer();
  const rawBuffer = Buffer.from(arrayBuf);

  let textBuffer = rawBuffer;
  if (rawBuffer.length > 2 && rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b) {
    textBuffer = zlib.gunzipSync(rawBuffer);
  }

  const rawText = decodeSubtitleBuffer(textBuffer);
  const vtt = convertSrtToVtt(rawText);
  setCached(cacheKey, vtt, 12 * 60 * 60 * 1000);
  return vtt;
}

export function convertSrtToVtt(srt: string): string {
  let clean = srt.replace(/^\uFEFF/, '').trim();
  clean = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // If already a WebVTT file, strip header cleanly to normalize once
  clean = clean.replace(/^WEBVTT[^\n]*\n+/i, '');

  // Convert SRT timestamp formats (both H:MM:SS,mmm and HH:MM:SS,mmm) -> WebVTT dots
  clean = clean.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})(\s*-->\s*)(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    (_m, s1: string, ms1: string, arrow: string, s2: string, ms2: string) => {
      const pad1 = s1.length === 7 ? `0${s1}` : s1;
      const pad2 = s2.length === 7 ? `0${s2}` : s2;
      return `${pad1}.${ms1}${arrow}${pad2}.${ms2}`;
    },
  );

  // Filter out spam advertising lines injected into free subtitles
  clean = clean
    .replace(/.*(?:OpenSubtitles\.org|Subdl|Downloaded From|api\.opensubtitles|Advertise your product or brand here).*\n?/gi, '')
    .trim();

  return `WEBVTT\n\n${clean}`;
}

export interface UpcomingReleaseItem {
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
}

const MONTH_INDEX_MAP: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

function decodeBasicHtmlEntities(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#91;[\s\S]*?&#93;/g, ' ')
    .replace(/\[[^\]]*\d+\]/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function formatUtcDateLabel(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function computeDaysUntilUtc(isoDate: string, todayMs: number): number | null {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const targetMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((targetMs - todayMs) / 86_400_000);
}

async function fetchUpcomingFilmsForYear(
  yearNum: number,
  targetMonths: Set<number>,
  todayIso: string,
  todayMs: number,
): Promise<UpcomingReleaseItem[]> {
  try {
    const secRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=parse&page=List_of_American_films_of_${yearNum}&prop=sections&format=json`,
      {
        headers: { 'User-Agent': 'CineBoxApp/1.0' },
        signal: AbortSignal.timeout(4500),
      },
    );
    if (!secRes.ok) return [];
    const secJson = (await secRes.json()) as {
      parse?: { sections?: Array<{ index?: string; line?: string }> };
    };
    const sections = secJson.parse?.sections || [];
    const quarterRanges: Array<{ index: string; months: number[] }> = [];

    for (const sec of sections) {
      const line = (sec.line || '').toLowerCase();
      if (!sec.index) continue;
      if (line.includes('january') && line.includes('march')) {
        quarterRanges.push({ index: sec.index, months: [0, 1, 2] });
      } else if (line.includes('april') && line.includes('june')) {
        quarterRanges.push({ index: sec.index, months: [3, 4, 5] });
      } else if (line.includes('july') && line.includes('september')) {
        quarterRanges.push({ index: sec.index, months: [6, 7, 8] });
      } else if (line.includes('october') && line.includes('december')) {
        quarterRanges.push({ index: sec.index, months: [9, 10, 11] });
      }
    }

    const relevantSections = quarterRanges.filter((q) =>
      q.months.some((m) => targetMonths.has(m)),
    );
    if (relevantSections.length === 0) return [];

    const out: UpcomingReleaseItem[] = [];
    for (const sec of relevantSections.slice(0, 2)) {
      const htmlRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=parse&page=List_of_American_films_of_${yearNum}&section=${encodeURIComponent(
          sec.index,
        )}&prop=text&format=json`,
        {
          headers: { 'User-Agent': 'CineBoxApp/1.0' },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!htmlRes.ok) continue;
      const htmlJson = (await htmlRes.json()) as { parse?: { text?: Record<string, string> } };
      const html = htmlJson.parse?.text?.['*'] || '';
      const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

      let currentMonth = -1;
      let currentDay = 1;

      for (const rowHtml of rowMatches) {
        if (/<th[^>]*>Opening<\/th>/i.test(rowHtml)) continue;
        const cells: Array<{ isHeader: boolean; text: string }> = [];
        const cellRegex = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
        let match: RegExpExecArray | null;
        while ((match = cellRegex.exec(rowHtml)) !== null) {
          cells.push({
            isHeader: match[1].toLowerCase() === 'th',
            text: decodeBasicHtmlEntities(match[2]),
          });
        }
        if (cells.length < 2) continue;

        let idx = 0;
        if (cells[idx]?.isHeader) {
          const maybeMonth = cells[idx].text.replace(/\s+/g, '').toLowerCase();
          if (MONTH_INDEX_MAP[maybeMonth] !== undefined) {
            currentMonth = MONTH_INDEX_MAP[maybeMonth];
          }
          idx += 1;
        }
        if (idx < cells.length && /^\d{1,2}$/.test(cells[idx].text)) {
          currentDay = Number(cells[idx].text);
          idx += 1;
        }

        const title = (cells[idx]?.text || '').trim();
        const studio = (cells[idx + 1]?.text || '').trim();
        const credits = (cells[idx + 2]?.text || '').trim();
        if (!title || currentMonth < 0 || currentDay < 1 || currentDay > 31) continue;

        const isoDate = `${yearNum}-${String(currentMonth + 1).padStart(2, '0')}-${String(
          currentDay,
        ).padStart(2, '0')}`;
        if (isoDate < todayIso) continue;

        const cleanCredits = credits
          .replace(/\([^)]*\);?\s*/g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 4)
          .join(', ');

        out.push({
          id: `upcoming-movie-${yearNum}-${isoDate}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          title,
          kind: 'movie',
          releaseDate: isoDate,
          releaseLabel: formatUtcDateLabel(isoDate),
          daysUntil: computeDaysUntilUtc(isoDate, todayMs),
          poster: '',
          year: String(yearNum),
          genre: 'Feature Film',
          overview: studio
            ? `Scheduled theatrical & streaming premiere from ${studio}.`
            : 'Scheduled upcoming feature film release.',
          stars: cleanCredits || undefined,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchUpcomingTvSeries(todayIso: string, todayMs: number): Promise<UpcomingReleaseItem[]> {
  const offsets = [4, 10, 18];
  const seenShowIds = new Set<number>();
  const collected: UpcomingReleaseItem[] = [];

  await Promise.all(
    offsets.map(async (daysAhead) => {
      const targetMs = todayMs + daysAhead * 86_400_000;
      const dateStr = new Date(targetMs).toISOString().slice(0, 10);
      try {
        const res = await fetch(
          `https://api.tvmaze.com/schedule?country=US&date=${encodeURIComponent(dateStr)}`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (!res.ok) return;
        const episodes = (await res.json()) as Array<{
          season?: number;
          number?: number | null;
          airdate?: string;
          show?: {
            id?: number;
            name?: string;
            type?: string;
            language?: string;
            genres?: string[];
            premiered?: string;
            summary?: string;
            image?: { medium?: string; original?: string };
            externals?: { imdb?: string | null };
          };
        }>;
        if (!Array.isArray(episodes)) return;

        for (const ep of episodes) {
          const show = ep.show;
          if (!show?.id || !show.name || seenShowIds.has(show.id)) continue;
          const showType = (show.type || '').toLowerCase();
          if (showType === 'news' || showType === 'sports' || showType === 'talk show' || showType === 'game show') {
            continue;
          }
          const genres = Array.isArray(show.genres) ? show.genres : [];
          if (genres.length === 0) continue;
          const poster = show.image?.original || show.image?.medium || '';
          if (!poster) continue;
          const airdate = ep.airdate || dateStr;
          if (airdate < todayIso) continue;

          seenShowIds.add(show.id);
          const cleanOverview = decodeBasicHtmlEntities(show.summary || '');
          const epTag =
            ep.season && ep.number
              ? `S${ep.season}E${ep.number}`
              : ep.season
                ? `Season ${ep.season}`
                : 'New Episode';

          collected.push({
            id: `upcoming-series-${show.id}-${airdate}`,
            title: show.name,
            kind: 'series',
            releaseDate: airdate,
            releaseLabel: formatUtcDateLabel(airdate),
            daysUntil: computeDaysUntilUtc(airdate, todayMs),
            poster,
            year: (show.premiered || airdate).slice(0, 4),
            genre: genres.slice(0, 2).join(' · '),
            overview: cleanOverview
              ? `${epTag} airs ${formatUtcDateLabel(airdate)}. ${cleanOverview}`
              : `Upcoming ${epTag} premiere airing ${formatUtcDateLabel(airdate)}.`,
            imdbId: show.externals?.imdb || undefined,
          });
        }
      } catch {
        // Ignore transient TVmaze failures
      }
    }),
  );

  return collected;
}

/**
 * Fetches upcoming theatrical movies and scripted series releases with verified posters
 */
export async function fetchUpcomingReleases(): Promise<UpcomingReleaseItem[]> {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cacheKey = `upcoming_releases_${todayIso}`;
  const cached = getCached<UpcomingReleaseItem[]>(cacheKey);
  if (cached) return cached;

  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth();
  const curTargetMonths = new Set<number>([curMonth, Math.min(11, curMonth + 1)]);
  const needsNextYear = curMonth >= 10;

  const [curYearMovies, nextYearMovies, upcomingSeries] = await Promise.all([
    fetchUpcomingFilmsForYear(curYear, curTargetMonths, todayIso, todayMs),
    needsNextYear
      ? fetchUpcomingFilmsForYear(curYear + 1, new Set([0, 1, 2]), todayIso, todayMs)
      : Promise.resolve([]),
    fetchUpcomingTvSeries(todayIso, todayMs),
  ]);

  const rawMovies = [...curYearMovies, ...nextYearMovies].slice(0, 16);

  // Enrich top upcoming movies with crisp official posters from IMDb suggestions
  const enrichedMovies: UpcomingReleaseItem[] = [];
  for (let i = 0; i < rawMovies.length; i += 4) {
    const chunk = rawMovies.slice(i, i + 4);
    const results = await Promise.all(
      chunk.map(async (item) => {
        const imdb = await searchImdbTitle(item.title, item.year, 'movie').catch(() => null);
        return {
          ...item,
          poster: imdb?.poster || item.poster,
          imdbId: imdb?.imdbId || item.imdbId,
          stars: item.stars || imdb?.stars || undefined,
        };
      }),
    );
    for (const r of results) {
      if (r.poster) enrichedMovies.push(r);
    }
  }

  const combined = [...enrichedMovies, ...upcomingSeries.slice(0, 10)].sort((a, b) =>
    a.releaseDate.localeCompare(b.releaseDate),
  );

  const deduped: UpcomingReleaseItem[] = [];
  const seenKeys = new Set<string>();
  for (const item of combined) {
    const key = `${item.kind}:${item.title.toLowerCase().trim()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(item);
  }

  const finalList = deduped.slice(0, 20);
  if (finalList.length > 0) {
    setCached(cacheKey, finalList, 6 * 60 * 60 * 1000);
  }
  return finalList;
}


