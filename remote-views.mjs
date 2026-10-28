// Only dynamic query definitions cross the Remote boundary. Visual workspaces,
// paths, credentials and archive records never belong in this projection.
const SORTS = new Set(['new', 'old', 'likes', 'views', 'media', 'author']);
export function projectRemoteViews(settings = {}) {
  const rows = [], seen = new Set();
  for (const view of (Array.isArray(settings.savedViews) ? settings.savedViews : []).slice(0, 100)) {
    if (!view || typeof view !== 'object') continue;
    const id = String(view.id || '').slice(0, 128), query = String(view.query || '');
    if (!id || seen.has(id) || query.length > 1000) continue;
    seen.add(id);
    rows.push({ id, name: String(view.name || 'Saved view').slice(0, 120), query, sort: SORTS.has(view.sort) ? view.sort : 'new' });
  }
  return { rows };
}
