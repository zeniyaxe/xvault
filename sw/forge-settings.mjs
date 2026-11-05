// XVault 21 "Forge" settings: defaults and normalisation, kept out of background.js so the
// service worker's monolithic settings block does not keep growing.
export const VIDEO_QUALITIES = ['highest', '1080', '720', '480'];
export const FORGE_DEFAULTS = {
  // Search
  searchFoldDiacritics: true,
  searchSynonyms: '',
  searchHybridWeight: 0.35,
  searchDidYouMean: true,
  searchHistoryEnabled: true,
  searchHistoryLimit: 80,
  // Downloads
  videoQuality: 'highest',
  // One rule per line, "search => quality" (first match wins), e.g. "source:likes => 720".
  videoQualityRules: '',
  downloadWindowEnabled: false,
  downloadWindowStart: '01:00',
  downloadWindowEnd: '07:00',
  downloadRespectSaveData: true,
  downloadMaxMBps: 0,
  integrityScheduleDays: 0,
  integrityAutoRedownload: true,
  // Capture and archiving
  availabilityChecks: false,
  availabilityScope: 'favorites',
  availabilityDailyCap: 30,
  availabilityRecheckDays: 30,
  repairDailyCap: 40,
  watchLists: [],
  watchDailyCap: 8,
  linkSnapshots: false,
  linkSnapshotMaxKB: 512,
  quoteChainDepth: 2,
  xBadgeEdits: true,
  xBadgeMissingMedia: true,
  importSkipDirectMessages: true,
  importMediaFromZip: true,
  captureHistoryLimit: 60,
  capturePresets: [],
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const clamp = (value, low, high, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
};

const QUALITY_WORDS = {
  highest: 'highest',
  best: 'highest',
  max: 'highest',
  original: 'highest',
  '4k': 'highest',
  2160: 'highest',
  1440: 'highest',
  1080: '1080',
  '1080p': '1080',
  720: '720',
  '720p': '720',
  480: '480',
  '480p': '480',
  low: '480',
  small: '480',
};
/**
 * Per-rule video quality: one "search => quality" rule per line, first match wins. Lines starting
 * with # are comments. Returns { rules: [{ query, quality, line }], issues: [{ line, message }] }.
 */
export function parseVideoQualityRules(text) {
  const rules = [],
    issues = [];
  String(text || '')
    .split(/\r?\n/)
    .slice(0, 60)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const match = /^(.*?)\s*(?:=>|→|->)\s*([a-z0-9]+)\s*$/i.exec(line);
      if (!match || !match[1].trim())
        return issues.push({ line: index + 1, message: 'Use "search => quality", e.g. "from:nasa => highest"' });
      const quality = QUALITY_WORDS[match[2].toLowerCase()];
      if (!quality)
        return issues.push({
          line: index + 1,
          message: `Unknown quality "${match[2]}" (use highest, 1080, 720 or 480)`,
        });
      if (rules.length < 30) rules.push({ query: match[1].trim().slice(0, 300), quality, line: index + 1 });
    });
  return { rules, issues };
}

export function sanitizeWatchLists(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(),
    out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = entry.kind === 'search' ? 'search' : 'author';
    let value = String(entry.value || '')
      .trim()
      .slice(0, kind === 'search' ? 200 : 32);
    if (kind === 'author') value = value.replace(/^@/, '').toLowerCase();
    if (!value || (kind === 'author' && !/^[a-z0-9_]{1,15}$/.test(value))) continue;
    const id = /^[a-z0-9-]{1,40}$/i.test(String(entry.id || ''))
      ? String(entry.id)
      : `w-${kind}-${out.length}-${value.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind,
      value,
      name: String(entry.name || '').slice(0, 80) || (kind === 'author' ? `@${value}` : value),
      everyHours: Math.round(clamp(entry.everyHours, 1, 168, 24)),
      maxPages: Math.round(clamp(entry.maxPages, 1, 10, 2)),
      enabled: entry.enabled !== false,
    });
    if (out.length >= 40) break;
  }
  return out;
}
/** Saved "New archive" setups: source, optional profile handle and run options. */
export function sanitizeCapturePresets(list) {
  if (!Array.isArray(list)) return [];
  const out = [],
    seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const source = ['bookmarks', 'likes', 'profile', 'timeline'].includes(entry.source) ? entry.source : '';
    if (!source) continue;
    const handle = String(entry.handle || '')
      .replace(/^@/, '')
      .trim()
      .toLowerCase();
    if (source === 'profile' && !/^[a-z0-9_]{1,15}$/.test(handle)) continue;
    const name =
      String(entry.name || '')
        .trim()
        .slice(0, 60) || (source === 'profile' ? `@${handle}` : source);
    const id = /^[a-z0-9-]{1,40}$/i.test(String(entry.id || '')) ? String(entry.id) : `p-${out.length}-${source}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      source,
      handle: source === 'profile' ? handle : '',
      mirror: !!entry.mirror,
      resume: entry.resume !== false,
    });
    if (out.length >= 24) break;
  }
  return out;
}
export function normalizeForgeSettings(out) {
  out.capturePresets = sanitizeCapturePresets(out.capturePresets);
  out.searchHybridWeight = clamp(out.searchHybridWeight, 0, 1, FORGE_DEFAULTS.searchHybridWeight);
  out.searchSynonyms = String(out.searchSynonyms ?? '').slice(0, 8000);
  out.searchHistoryLimit = Math.round(clamp(out.searchHistoryLimit, 10, 500, 80));
  if (!VIDEO_QUALITIES.includes(String(out.videoQuality))) out.videoQuality = 'highest';
  else out.videoQuality = String(out.videoQuality);
  out.videoQualityRules = String(out.videoQualityRules ?? '').slice(0, 4000);
  for (const key of ['downloadWindowStart', 'downloadWindowEnd'])
    if (!TIME.test(String(out[key] || ''))) out[key] = FORGE_DEFAULTS[key];
  out.downloadMaxMBps = clamp(out.downloadMaxMBps, 0, 500, 0);
  out.integrityScheduleDays = Math.round(clamp(out.integrityScheduleDays, 0, 90, 0));
  if (!['favorites', 'favorites-labeled', 'all'].includes(out.availabilityScope)) out.availabilityScope = 'favorites';
  out.availabilityDailyCap = Math.round(clamp(out.availabilityDailyCap, 1, 300, 30));
  out.availabilityRecheckDays = Math.round(clamp(out.availabilityRecheckDays, 1, 365, 30));
  out.repairDailyCap = Math.round(clamp(out.repairDailyCap, 1, 500, 40));
  out.watchLists = sanitizeWatchLists(out.watchLists);
  out.watchDailyCap = Math.round(clamp(out.watchDailyCap, 1, 50, 8));
  out.linkSnapshotMaxKB = Math.round(clamp(out.linkSnapshotMaxKB, 32, 4096, 512));
  out.quoteChainDepth = Math.round(clamp(out.quoteChainDepth, 0, 5, 2));
  out.captureHistoryLimit = Math.round(clamp(out.captureHistoryLimit, 10, 400, 60));
  return out;
}

/** Minutes since local midnight for "HH:MM". */
export function minutesOf(value) {
  const match = TIME.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}
/** True when `now` falls inside the [start, end) window; windows may wrap past midnight. */
export function insideWindow(now, start, end) {
  const date = new Date(now),
    minute = date.getHours() * 60 + date.getMinutes(),
    from = minutesOf(start),
    to = minutesOf(end);
  if (from === to) return true;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}
/** Milliseconds until the window next opens (0 when already open). */
export function msUntilWindow(now, start, end) {
  if (insideWindow(now, start, end)) return 0;
  const date = new Date(now),
    minute = date.getHours() * 60 + date.getMinutes(),
    from = minutesOf(start);
  const wait = (from - minute + 1440) % 1440 || 1440;
  return wait * 60000 - date.getSeconds() * 1000 - date.getMilliseconds();
}
