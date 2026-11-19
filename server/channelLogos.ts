interface IptvOrgChannel {
  id?: string;
  name?: string;
  alt_names?: string[];
  country?: string;
}

interface IptvOrgLogo {
  channel?: string;
  in_use?: boolean;
  format?: string;
  url?: string;
}

interface LogoIndex {
  byCountryAndName: Map<string, string>;
  byName: Map<string, string>;
  byCompact: Map<string, string>;
  expiresAt: number;
}

const INDEX_TTL_MS = 12 * 60 * 60 * 1000;

let cachedIndex: LogoIndex | null = null;
let inFlightLoad: Promise<LogoIndex | null> | null = null;
const channelLookupCache = new Map<string, string | null>();

const PREFIX_COUNTRY_MAP: Record<string, string> = {
  BG: 'BG',
  UK: 'GB',
  GB: 'GB',
  US: 'US',
  USA: 'US',
  CA: 'CA',
  AU: 'AU',
  NZ: 'NZ',
  IN: 'IN',
  IND: 'IN',
  PK: 'PK',
  PAK: 'PK',
  BD: 'BD',
  TR: 'TR',
  DE: 'DE',
  FR: 'FR',
  ES: 'ES',
  IT: 'IT',
  PT: 'PT',
  NL: 'NL',
  BE: 'BE',
  CH: 'CH',
  AT: 'AT',
  SE: 'SE',
  NO: 'NO',
  DK: 'DK',
  FI: 'FI',
  PL: 'PL',
  RO: 'RO',
  GR: 'GR',
  RU: 'RU',
  UA: 'UA',
  AR: 'AE',
  AE: 'AE',
  UAE: 'AE',
  SA: 'SA',
  KSA: 'SA',
  EG: 'EG',
  MA: 'MA',
  BR: 'BR',
  MX: 'MX',
  JP: 'JP',
  KR: 'KR',
  ZA: 'ZA',
};

function normalizeChannelName(raw: string): string {
  return raw
    .replace(/^[A-Z]{2,4}\s*[:|-]\s*/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(
      /\b(4k|2160p|uhd|fhd|hd|sd|hevc|h\.?265|h\.?264|raw|vip|backup|bk|50fps|60fps|live|24\/7|24x7|1080p|720p)\b/gi,
      ' ',
    )
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function inferCountryCode(rawName: string, categoryName = ''): string | null {
  const prefixMatch = rawName.trim().match(/^([A-Z]{2,3})\s*[:|-]/i);
  if (prefixMatch) {
    const mapped = PREFIX_COUNTRY_MAP[prefixMatch[1].toUpperCase()];
    if (mapped) return mapped;
  }

  const cat = categoryName.toUpperCase();
  if (/\bBULGARIA\b/.test(cat)) return 'BG';
  if (/\b(INDIA|HINDI|TAMIL|TELUGU|MALAYALAM|KANNADA|MARATHI|GUJARATI|PUNJABI|BENGALI)\b/.test(cat)) return 'IN';
  if (/\bPAKISTAN\b/.test(cat)) return 'PK';
  if (/\bBANGLA(DESH)?\b/.test(cat)) return 'BD';
  if (/\b(UK|UNITED KINGDOM|SKY UK)\b/.test(cat)) return 'GB';
  if (/\b(USA|UNITED STATES|NFL|MLB|NBA|ESPN)\b/.test(cat)) return 'US';
  if (/\bCANADA\b/.test(cat)) return 'CA';
  if (/\bAUSTRALIA\b/.test(cat)) return 'AU';
  if (/\bTURK(EY|ISH)\b/.test(cat)) return 'TR';
  if (/\bGERMANY\b/.test(cat)) return 'DE';
  if (/\bFRANCE\b/.test(cat)) return 'FR';
  if (/\bSPAIN\b/.test(cat)) return 'ES';
  if (/\bITALY\b/.test(cat)) return 'IT';
  if (/\bPORTUGAL\b/.test(cat)) return 'PT';
  if (/\bNETHERLANDS\b/.test(cat)) return 'NL';
  if (/\bROMANIA\b/.test(cat)) return 'RO';
  if (/\bPOLAND\b/.test(cat)) return 'PL';
  if (/\bGREECE\b/.test(cat)) return 'GR';
  return null;
}

async function loadLogoIndex(): Promise<LogoIndex | null> {
  const now = Date.now();
  if (cachedIndex && cachedIndex.expiresAt > now) {
    return cachedIndex;
  }
  if (inFlightLoad) {
    return inFlightLoad;
  }

  inFlightLoad = (async () => {
    try {
      const [channelsRes, logosRes] = await Promise.all([
        fetch('https://iptv-org.github.io/api/channels.json', {
          signal: AbortSignal.timeout(10000),
        }),
        fetch('https://iptv-org.github.io/api/logos.json', {
          signal: AbortSignal.timeout(10000),
        }),
      ]);

      if (!channelsRes.ok || !logosRes.ok) {
        return null;
      }

      const channels = (await channelsRes.json()) as IptvOrgChannel[];
      const logos = (await logosRes.json()) as IptvOrgLogo[];

      const bestLogoByChannel = new Map<string, { url: string; score: number }>();
      for (const l of logos) {
        if (!l.url || !l.channel || !/^https?:\/\//i.test(l.url)) continue;
        const fmt = (l.format || '').toUpperCase();
        const score =
          (l.in_use ? 10 : 0) +
          (fmt === 'PNG' ? 5 : fmt === 'SVG' ? 4 : fmt === 'WEBP' ? 3 : 1);
        const prev = bestLogoByChannel.get(l.channel);
        if (!prev || score > prev.score) {
          bestLogoByChannel.set(l.channel, { url: l.url, score });
        }
      }

      const byCountryAndName = new Map<string, string>();
      const byName = new Map<string, string>();
      const byCompact = new Map<string, string>();

      for (const ch of channels) {
        if (!ch.id) continue;
        const logoUrl = bestLogoByChannel.get(ch.id)?.url;
        if (!logoUrl) continue;

        const country = (ch.country || '').toUpperCase();
        const names = [ch.name, ...(ch.alt_names || [])].filter(
          (n): n is string => typeof n === 'string' && n.trim().length > 0,
        );

        for (const raw of names) {
          const norm = normalizeChannelName(raw);
          if (!norm) continue;
          if (country && !byCountryAndName.has(`${country}:${norm}`)) {
            byCountryAndName.set(`${country}:${norm}`, logoUrl);
          }
          if (!byName.has(norm)) {
            byName.set(norm, logoUrl);
          }
          const compact = norm.replace(/\s+/g, '');
          if (compact.length >= 3 && !byCompact.has(compact)) {
            byCompact.set(compact, logoUrl);
          }
        }
      }

      const nextIndex: LogoIndex = {
        byCountryAndName,
        byName,
        byCompact,
        expiresAt: Date.now() + INDEX_TTL_MS,
      };
      cachedIndex = nextIndex;
      return nextIndex;
    } catch (err) {
      console.warn(
        'Channel logo index fetch failed:',
        err instanceof Error ? err.message : err,
      );
      return null;
    } finally {
      inFlightLoad = null;
    }
  })();

  return inFlightLoad;
}

function findInIndex(
  index: LogoIndex,
  channelName: string,
  categoryName = '',
): string | null {
  const norm = normalizeChannelName(channelName);
  if (!norm || norm.length < 2) return null;

  const country = inferCountryCode(channelName, categoryName);
  const candidates = [norm];
  // Also try stripping trailing "tv" or "channel" if exact lookup misses
  const withoutTv = norm.replace(/\b(tv|channel|network)\b/g, '').replace(/\s+/g, ' ').trim();
  if (withoutTv && withoutTv !== norm && withoutTv.length >= 2) {
    candidates.push(withoutTv);
  }

  for (const cand of candidates) {
    if (country) {
      const hit = index.byCountryAndName.get(`${country}:${cand}`);
      if (hit) return hit;
    }
    const directHit = index.byName.get(cand);
    if (directHit) return directHit;

    const compact = cand.replace(/\s+/g, '');
    if (compact.length >= 3) {
      const compactHit = index.byCompact.get(compact);
      if (compactHit) return compactHit;
    }
  }

  return null;
}

export function warmChannelLogoIndex(): void {
  void loadLogoIndex();
}

export function lookupChannelLogoSync(
  channelName: string,
  categoryName = '',
): string | null {
  if (!cachedIndex || cachedIndex.expiresAt <= Date.now()) {
    return null;
  }
  const cacheKey = `${channelName.toLowerCase()}__${categoryName.toLowerCase()}`;
  if (channelLookupCache.has(cacheKey)) {
    return channelLookupCache.get(cacheKey) ?? null;
  }
  const found = findInIndex(cachedIndex, channelName, categoryName);
  if (channelLookupCache.size > 15_000) {
    channelLookupCache.clear();
  }
  channelLookupCache.set(cacheKey, found);
  return found;
}

export async function lookupChannelLogo(
  channelName: string,
  categoryName = '',
): Promise<string | null> {
  const cacheKey = `${channelName.toLowerCase()}__${categoryName.toLowerCase()}`;
  if (channelLookupCache.has(cacheKey)) {
    return channelLookupCache.get(cacheKey) ?? null;
  }

  const index = await loadLogoIndex();
  if (!index) return null;

  const found = findInIndex(index, channelName, categoryName);
  if (channelLookupCache.size > 15_000) {
    channelLookupCache.clear();
  }
  channelLookupCache.set(cacheKey, found);
  return found;
}
