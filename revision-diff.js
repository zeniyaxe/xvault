/* XVault 21 — word-level diffs for the Reader's revision history (window.XVaultRevisionDiff, CommonJS for tests).
   diffWords(before, after) → [{ type: 'same' | 'add' | 'del', text }]; changedFields(before, after) lists
   the non-text fields that differ between two archived views of a post. Pure functions, no DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XVaultRevisionDiff = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TOKEN = /\s+|[^\s\p{L}\p{N}]|[\p{L}\p{N}_'’-]+/gu;
  const MAX_CELLS = 4000000;

  function tokens(text) {
    return String(text || '').match(TOKEN) || [];
  }

  function push(out, type, text) {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  }

  /** Longest-common-subsequence diff over word/space/punctuation tokens, with common prefix/suffix trimmed. */
  function diffWords(before, after) {
    const a = tokens(before),
      b = tokens(after),
      out = [];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length,
      endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
    push(out, 'same', a.slice(0, start).join(''));
    const midA = a.slice(start, endA),
      midB = b.slice(start, endB);
    if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
      push(out, 'del', midA.join(''));
      push(out, 'add', midB.join(''));
    } else {
      const rows = midA.length,
        cols = midB.length,
        table = new Uint32Array((rows + 1) * (cols + 1));
      for (let i = rows - 1; i >= 0; i--)
        for (let j = cols - 1; j >= 0; j--)
          table[i * (cols + 1) + j] =
            midA[i] === midB[j]
              ? table[(i + 1) * (cols + 1) + j + 1] + 1
              : Math.max(table[(i + 1) * (cols + 1) + j], table[i * (cols + 1) + j + 1]);
      let i = 0,
        j = 0;
      while (i < rows && j < cols) {
        if (midA[i] === midB[j]) {
          push(out, 'same', midA[i]);
          i++;
          j++;
        } else if (table[(i + 1) * (cols + 1) + j] >= table[i * (cols + 1) + j + 1]) push(out, 'del', midA[i++]);
        else push(out, 'add', midB[j++]);
      }
      while (i < rows) push(out, 'del', midA[i++]);
      while (j < cols) push(out, 'add', midB[j++]);
    }
    push(out, 'same', a.slice(endA).join(''));
    return out;
  }

  /** Summary counts for a diff: words added/removed. */
  function diffStats(ops) {
    const words = text => (String(text).match(/[\p{L}\p{N}_'’-]+/gu) || []).length;
    return ops.reduce(
      (stats, op) => {
        if (op.type === 'add') stats.added += words(op.text);
        if (op.type === 'del') stats.removed += words(op.text);
        return stats;
      },
      { added: 0, removed: 0 }
    );
  }

  const FIELDS = [
    ['text', 'Text', view => view?.text || ''],
    ['author', 'Author', view => `${view?.author?.name || ''} @${view?.author?.handle || ''}`.trim()],
    ['media', 'Media', view => (Array.isArray(view?.media) ? view.media.length : 0)],
    ['links', 'Links', view => (Array.isArray(view?.links) ? view.links.join(' ') : '')],
    ['poll', 'Poll', view => (view?.poll ? JSON.stringify(view.poll.choices || []) : '')],
    ['card', 'Link card', view => (view?.card ? `${view.card.title || ''} ${view.card.url || ''}` : '')],
    ['communityNote', 'Community note', view => view?.communityNote?.text || ''],
    ['sensitive', 'Sensitive', view => !!view?.sensitive],
  ];
  function changedFields(before, after) {
    const out = [];
    for (const [key, label, read] of FIELDS) {
      const from = read(before),
        to = read(after);
      if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ key, label, from, to });
    }
    const metrics = ['likes', 'reposts', 'replies', 'quotes', 'bookmarks', 'views'];
    const deltas = metrics
      .map(key => ({ key, from: Number(before?.metrics?.[key]) || 0, to: Number(after?.metrics?.[key]) || 0 }))
      .filter(entry => entry.from !== entry.to);
    if (deltas.length) out.push({ key: 'metrics', label: 'Engagement', deltas });
    return out;
  }

  /** Orders revisions oldest → newest and pairs each with the view it replaced. */
  function timeline(revisions, current) {
    const rows = (Array.isArray(revisions) ? revisions : [])
      .filter(row => row && row.before && row.after)
      .sort((a, b) => (Number(a.observedAt) || 0) - (Number(b.observedAt) || 0));
    const steps = rows.map(row => ({
      at: Number(row.observedAt) || 0,
      runId: row.runId || null,
      before: row.before,
      after: row.after,
      fields: changedFields(row.before, row.after),
      textOps: (row.before.text || '') !== (row.after.text || '') ? diffWords(row.before.text, row.after.text) : null,
    }));
    return { steps, first: rows[0]?.before || current || null, latest: current || rows.at(-1)?.after || null };
  }

  return Object.freeze({ tokens, diffWords, diffStats, changedFields, timeline });
});
