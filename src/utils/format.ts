export function formatNumber(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (val: number) => String(val).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function formatRelativeTime(timestampMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function proxiedImageUrl(rawUrl?: string): string {
  if (!rawUrl || !rawUrl.trim()) return '';
  const clean = rawUrl.trim();
  if (clean.startsWith('/api/') || clean.startsWith('blob:') || clean.startsWith('data:')) {
    return clean;
  }
  if (/^https?:\/\//i.test(clean)) {
    return `/api/proxy/image?url=${encodeURIComponent(clean)}`;
  }
  return '';
}

export function extractYouTubeId(raw?: string): string | null {
  if (!raw) return null;
  const clean = raw.trim();
  if (!clean) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
  try {
    const parsed = new URL(clean);
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.replace(/^\//, '').split('/')[0] || null;
    }
    if (parsed.hostname.includes('youtube.com')) {
      const v = parsed.searchParams.get('v');
      if (v) return v;
      const segs = parsed.pathname.split('/').filter(Boolean);
      const embedIdx = segs.indexOf('embed');
      if (embedIdx >= 0 && segs[embedIdx + 1]) return segs[embedIdx + 1];
    }
  } catch {
    return null;
  }
  return null;
}

const CARD_LANG_CODES: Record<string, string> = {
  en: 'English',
  eng: 'English',
  english: 'English',
  hi: 'Hindi',
  hin: 'Hindi',
  hindi: 'Hindi',
  ur: 'Urdu',
  urd: 'Urdu',
  urdu: 'Urdu',
  pa: 'Punjabi',
  pan: 'Punjabi',
  pun: 'Punjabi',
  punjabi: 'Punjabi',
  ta: 'Tamil',
  tam: 'Tamil',
  tamil: 'Tamil',
  te: 'Telugu',
  tel: 'Telugu',
  telugu: 'Telugu',
  ml: 'Malayalam',
  mal: 'Malayalam',
  malayalam: 'Malayalam',
  kn: 'Kannada',
  kan: 'Kannada',
  kannada: 'Kannada',
  bn: 'Bangla',
  ben: 'Bangla',
  bangla: 'Bangla',
  bengali: 'Bangla',
  mr: 'Marathi',
  marathi: 'Marathi',
  gu: 'Gujarati',
  gujarati: 'Gujarati',
  ar: 'Arabic',
  ara: 'Arabic',
  arabic: 'Arabic',
  tr: 'Turkish',
  tur: 'Turkish',
  turkish: 'Turkish',
  es: 'Spanish',
  spa: 'Spanish',
  spanish: 'Spanish',
  latino: 'Spanish',
  fr: 'French',
  fre: 'French',
  fra: 'French',
  french: 'French',
  de: 'German',
  ger: 'German',
  deu: 'German',
  german: 'German',
  it: 'Italian',
  ita: 'Italian',
  italian: 'Italian',
  pt: 'Portuguese',
  por: 'Portuguese',
  portuguese: 'Portuguese',
  ko: 'Korean',
  kor: 'Korean',
  korean: 'Korean',
  ja: 'Japanese',
  jpn: 'Japanese',
  japanese: 'Japanese',
  zh: 'Chinese',
  chi: 'Chinese',
  chinese: 'Chinese',
  ru: 'Russian',
  rus: 'Russian',
  russian: 'Russian',
  dual: 'Dual Audio',
  multi: 'Multi Audio',
};

export function extractCardLanguage(rawTitle?: string, categoryName?: string): string {
  const title = (rawTitle || '').trim();
  const category = (categoryName || '').trim();

  if (title) {
    if (/\bdual[\s-]+audio\b/i.test(title)) return 'Dual Audio';
    if (/\bmulti[\s-]+audio\b/i.test(title)) return 'Multi Audio';

    // Leading prefix like "EN | Title", "HI - Title", "UR: Title"
    const prefixMatch = title.match(/^([A-Za-z]{2,10})\s*[|:\-–]\s+/);
    if (prefixMatch) {
      const code = prefixMatch[1].toLowerCase();
      if (CARD_LANG_CODES[code]) return CARD_LANG_CODES[code];
    }

    // Parenthetical or bracketed language markers like "(Hindi)", "[English]", "(Hindi Dubbed)"
    const bracketMatches = title.matchAll(/[(\[]\s*([^()[\]]+?)\s*[)\]]/g);
    for (const m of bracketMatches) {
      const inner = m[1].toLowerCase().replace(/\b(dub|dubbed|audio|sub|subs|subbed)\b/g, ' ').trim();
      const firstToken = inner.split(/[\s,/|+&-]+/)[0];
      if (firstToken && CARD_LANG_CODES[firstToken]) {
        return CARD_LANG_CODES[firstToken];
      }
    }

    const dubbedMatch = title.match(
      /\b(hindi|tamil|telugu|malayalam|kannada|punjabi|bangla|bengali|urdu|marathi|gujarati|turkish|spanish|french|german|arabic|english)\s*(?:dub|dubbed)\b/i,
    );
    if (dubbedMatch) {
      return CARD_LANG_CODES[dubbedMatch[1].toLowerCase()] || dubbedMatch[1];
    }
  }

  if (category) {
    if (/\bdual[\s-]+audio\b/i.test(category)) return 'Dual Audio';
    if (/\bmulti[\s-]+(?:audio|lang|language)\b/i.test(category)) return 'Multi Audio';

    const catWordMatch = category.match(
      /\b(english|hindi|urdu|punjabi|tamil|telugu|malayalam|kannada|bangla|bengali|marathi|gujarati|arabic|turkish|spanish|french|german|italian|portuguese|korean|japanese|chinese|russian)\b/i,
    );
    if (catWordMatch) {
      return CARD_LANG_CODES[catWordMatch[1].toLowerCase()] || catWordMatch[1];
    }

    const lowerCat = category.toLowerCase();
    if (lowerCat.includes('bollywood')) return 'Hindi';
    if (lowerCat.includes('hollywood')) return 'English';
    if (lowerCat.includes('pakistan') || lowerCat.includes('lollywood')) return 'Urdu';
    if (lowerCat.includes('tollywood')) return 'Telugu';
    if (lowerCat.includes('kollywood')) return 'Tamil';
    if (lowerCat.includes('anime')) return 'Japanese';
    if (lowerCat.includes('k-drama') || lowerCat.includes('kdrama')) return 'Korean';
  }

  return '';
}

export function parseDurationHintToSeconds(raw?: string | number | null): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw <= 240 ? Math.round(raw * 60) : Math.round(raw);
  }
  const str = String(raw ?? '').trim();
  if (!str) return 0;

  // HH:MM:SS or MM:SS
  const colonMatch = str.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colonMatch) {
    const a = Number(colonMatch[1]);
    const b = Number(colonMatch[2]);
    const c = colonMatch[3] !== undefined ? Number(colonMatch[3]) : null;
    if (c !== null) {
      return a * 3600 + b * 60 + c;
    }
    // Interpret MM:SS unless first field is unusually large? Standard episode runtime like 45:30 is MM:SS
    return a * 60 + b;
  }

  // "1h 42m" / "2h"
  const hmMatch = str.match(/(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)[\s,]*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)?/i);
  if (hmMatch && (hmMatch[1] || hmMatch[2])) {
    const hrs = hmMatch[1] ? Number(hmMatch[1]) : 0;
    const mins = hmMatch[2] ? Number(hmMatch[2]) : 0;
    if (Number.isFinite(hrs) && Number.isFinite(mins)) {
      return Math.round(hrs * 3600 + mins * 60);
    }
  }

  // "102 min" or "45m"
  const minMatch = str.match(/^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (minMatch) {
    const mins = Number(minMatch[1]);
    return Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60) : 0;
  }

  // "2700s" / "2700 sec"
  const secMatch = str.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i);
  if (secMatch) {
    const secs = Number(secMatch[1]);
    return Number.isFinite(secs) && secs > 0 ? Math.round(secs) : 0;
  }

  // Bare number: Xtream episodeRunTime & movie duration fields are typically minutes if <= 360, otherwise seconds
  const num = Number(str);
  if (Number.isFinite(num) && num > 0) {
    return num <= 360 ? Math.round(num * 60) : Math.round(num);
  }
  return 0;
}

export function isReleasedWithinDays(
  input: {
    added?: number | null;
    lastModified?: number | null;
    releaseDate?: string | null;
  },
  days = 7,
): boolean {
  const windowSec = Math.max(1, days) * 86_400;
  const nowSec = Math.floor(Date.now() / 1000);

  const checkEpoch = (raw?: number | null): boolean => {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return false;
    const tsSec = raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
    const ageSec = nowSec - tsSec;
    return ageSec >= -86_400 && ageSec <= windowSec;
  };

  const rawRelease = input.releaseDate?.trim();
  if (rawRelease && !/^\d{4}$/.test(rawRelease)) {
    const parsedMs = Date.parse(rawRelease);
    if (Number.isFinite(parsedMs)) {
      return checkEpoch(Math.floor(parsedMs / 1000));
    }
  }

  return checkEpoch(input.added) || checkEpoch(input.lastModified);
}
