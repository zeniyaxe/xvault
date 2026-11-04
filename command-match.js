/* Small command-only matcher. It never scans archive content. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultCommandMatch = api;
})(globalThis, function () {
  function score(name, keywords, query) {
    const terms = String(query || '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!terms.length) return 0;
    const title = String(name).toLowerCase(),
      text = title + ' ' + String(keywords || '').toLowerCase();
    let result = 0;
    for (const term of terms) {
      if (title.startsWith(term)) {
        result += 100;
        continue;
      }
      if (title.includes(term)) {
        result += 70;
        continue;
      }
      if (text.includes(term)) {
        result += 40;
        continue;
      }
      let at = -1,
        gaps = 0;
      for (const char of term) {
        const next = text.indexOf(char, at + 1);
        if (next < 0) return null;
        gaps += next - at - 1;
        at = next;
      }
      result += Math.max(1, 25 - gaps);
    }
    return result;
  }
  return Object.freeze({ score });
});
