/* Usage-aware ranking for Library search suggestions. Pure functions shared by the dashboard
   (window.XVaultSearchRanking) and tests (CommonJS). Usage stays in this browser's localStorage. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XVaultSearchRanking = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAY = 86400000,
    HALF_LIFE_DAYS = 14,
    MAX_ENTRIES = 300;

  /** Splits a query into tokens, keeping "quoted phrases" (and key:"quoted values") together. */
  function tokens(query) {
    return String(query || '').match(/-?[^\s"]*"[^"]*"?|\S+/g) || [];
  }

  /** Normalised usage keys for one token: the operator (`from:`) and the full filter (`from:alice`). */
  function usageKeys(token) {
    const body = String(token || '')
      .replace(/^-/, '')
      .toLowerCase();
    if (!body) return [];
    const colon = body.indexOf(':');
    if (colon <= 0) return body.startsWith('#') || body.startsWith('@') ? [body] : [];
    const key = body.slice(0, colon + 1),
      value = body.slice(colon + 1).replace(/^"|"$/g, '');
    return value ? [key, `${key}${value}`] : [key];
  }

  function weight(entry, now = Date.now()) {
    if (!entry || !(entry.count > 0)) return 0;
    const ageDays = Math.max(0, (now - Number(entry.last || 0)) / DAY);
    return Math.log2(1 + entry.count) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  }

  /** Returns a new usage map with every filter in `query` counted once. */
  function recordUsage(usage, query, now = Date.now()) {
    const next = { ...(usage && typeof usage === 'object' ? usage : {}) };
    const seen = new Set(tokens(query).flatMap(usageKeys));
    for (const key of seen) {
      const entry = next[key];
      next[key] = { count: Math.min(10000, Number(entry?.count || 0) + 1), last: now };
    }
    const keys = Object.keys(next);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => weight(next[a], now) - weight(next[b], now))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach(key => delete next[key]);
    }
    return next;
  }

  function textScore(value, haystack, needle) {
    if (!needle) return 1;
    const lower = String(value).toLowerCase();
    if (lower === needle) return 3.5;
    if (lower.startsWith(needle)) return 3;
    const extra = String(haystack || lower).toLowerCase();
    if (extra.split(/[\s._-]+/).some(word => word.startsWith(needle))) return 2.5;
    return extra.includes(needle) ? 2 : 0;
  }

  /**
   * entries: [{ value, hint, haystack?, usageKey?, base? }]
   * Higher text match wins first; within a match tier, recent/frequent use and the entry's own
   * base score (e.g. archive counts) decide.
   */
  function rank(entries, { needle = '', usage = {}, now = Date.now(), limit = 8 } = {}) {
    const lowered = String(needle || '').toLowerCase();
    return (entries || [])
      .map((entry, index) => {
        const text = textScore(entry.value, entry.haystack, lowered);
        const used = weight(usage[String(entry.usageKey || entry.value).toLowerCase()], now);
        return { ...entry, used, score: text * 10 + Math.min(8, used * 3) + Number(entry.base || 0), index, text };
      })
      .filter(entry => entry.text > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit);
  }

  return Object.freeze({ tokens, usageKeys, recordUsage, weight, rank, textScore });
});
