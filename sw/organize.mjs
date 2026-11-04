// Boards and auto-tag rules (XVault 20). Boards are named, ordered collections stored in settings
// (definitions) with membership on each post's userMeta.boards. Rules use the Library search
// language ("from:nasa has:video") and apply organisation-only changes: tags, favourite, read later,
// boards and colour label — never archived content. Every application returns undo snapshots.
const ID = /^[a-z0-9-]{1,64}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const LABELS = new Set(['', 'none', 'red', 'amber', 'green', 'blue', 'violet']);
const clip = (value, length) => String(value ?? '').slice(0, length);
const tagList = value =>
  [
    ...new Set(
      (Array.isArray(value) ? value : String(value || '').split(','))
        .map(tag =>
          String(tag || '')
            .trim()
            .replace(/^#/, '')
            .trim()
            .slice(0, 40)
        )
        .filter(Boolean)
    ),
  ].slice(0, 20);

export function slugId(name, taken = new Set()) {
  const base =
    String(name || 'board')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'board';
  let id = base,
    counter = 2;
  while (taken.has(id)) id = `${base}-${counter++}`;
  return id;
}

export function sanitizeBoards(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(),
    out = [];
  for (const raw of value.slice(0, 200)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = clip(raw.name, 80).trim();
    if (!name) continue;
    const id = ID.test(String(raw.id || '')) && !seen.has(raw.id) ? String(raw.id) : slugId(name, seen);
    seen.add(id);
    out.push({
      id,
      name,
      description: clip(raw.description, 400),
      cover: /^\d{1,32}$/.test(String(raw.cover || '')) ? String(raw.cover) : '',
      color: COLOR.test(String(raw.color || '')) ? String(raw.color) : '',
      icon: clip(raw.icon, 8),
      pinned: !!raw.pinned,
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : out.length,
      createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : Date.now(),
    });
  }
  return out
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order)
    .map((board, order) => ({ ...board, order }));
}

export function sanitizeAutoTagRules(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(),
    out = [];
  for (const raw of value.slice(0, 100)) {
    if (!raw || typeof raw !== 'object') continue;
    const query = clip(raw.query, 500).trim();
    if (!query) continue;
    const id = ID.test(String(raw.id || '')) && !seen.has(raw.id) ? String(raw.id) : slugId(raw.name || query, seen);
    seen.add(id);
    const actions = raw.actions && typeof raw.actions === 'object' ? raw.actions : {};
    const clean = {
      addTags: tagList(actions.addTags),
      favorite: actions.favorite === true,
      readLater: actions.readLater === true,
      addBoards: (Array.isArray(actions.addBoards) ? actions.addBoards : [])
        .filter(board => ID.test(String(board)))
        .slice(0, 20),
      colorLabel: LABELS.has(String(actions.colorLabel || '')) ? String(actions.colorLabel || '') : '',
    };
    if (!clean.addTags.length && !clean.favorite && !clean.readLater && !clean.addBoards.length && !clean.colorLabel)
      continue;
    out.push({
      id,
      name: clip(raw.name, 80).trim() || query.slice(0, 80),
      query,
      enabled: raw.enabled !== false,
      onCapture: raw.onCapture !== false,
      actions: clean,
      createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : Date.now(),
      lastRunAt: Number(raw.lastRunAt) > 0 ? Number(raw.lastRunAt) : 0,
      lastMatched: Math.max(0, Math.floor(Number(raw.lastMatched) || 0)),
    });
  }
  return out;
}

/** The updateLibraryMetadata patch a rule applies. */
export function rulePatch(rule) {
  const patch = {};
  if (rule.actions.addTags.length) patch.addTags = rule.actions.addTags;
  if (rule.actions.favorite) patch.favorite = true;
  if (rule.actions.readLater) patch.readLater = true;
  if (rule.actions.addBoards.length) patch.addBoards = rule.actions.addBoards;
  if (rule.actions.colorLabel) patch.colorLabel = rule.actions.colorLabel;
  return patch;
}

/** True when applying the rule would change nothing on this post (keeps re-runs idempotent and counts honest). */
export function ruleIsSatisfied(rule, post) {
  const meta = post?.userMeta || {},
    tags = new Set(meta.tags || []),
    boards = new Set(meta.boards || []);
  return (
    rule.actions.addTags.every(tag => tags.has(tag)) &&
    (!rule.actions.favorite || !!meta.favorite) &&
    (!rule.actions.readLater || !!meta.readLater) &&
    rule.actions.addBoards.every(board => boards.has(board)) &&
    (!rule.actions.colorLabel || meta.colorLabel === rule.actions.colorLabel)
  );
}

/**
 * Groups posts by the rules that would change them. matches(post, rule) decides membership (the caller
 * projects posts with the shared search core). Returns [{ rule, ids }].
 */
export function planRules(posts, rules, matches) {
  const plan = rules.map(rule => ({ rule, ids: [] }));
  for (const post of posts)
    for (const entry of plan)
      if (!ruleIsSatisfied(entry.rule, post) && matches(post, entry.rule)) entry.ids.push(String(post.id));
  return plan.filter(entry => entry.ids.length);
}
