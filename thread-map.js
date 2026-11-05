/* XVault 22 thread map: a compact reply/quote tree of a Reader conversation.
   layout(posts) is pure (unit-tested): replies hang under the post they answer, the author's own thread
   (the spine) stays in the first lane, and quotes inside the conversation become dashed links.
   svg(layout, options) renders it as an SVG string; the Reader owns events and scrolling. */
(root => {
  const MAX_NODES = 400,
    MAX_DEPTH = 6,
    ROW = 20,
    LANE = 14,
    PAD = 10;

  function layout(posts = []) {
    const list = posts.slice(0, MAX_NODES).filter(post => post && post.id != null);
    const byId = new Map(list.map(post => [String(post.id), post]));
    const children = new Map(),
      roots = [];
    for (const post of list) {
      const parent = post.replyToId != null && byId.has(String(post.replyToId)) ? String(post.replyToId) : null;
      if (parent && parent !== String(post.id)) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(post);
      } else roots.push(post);
    }
    // Spine children first, so the author's own thread reads straight down the first lane.
    const order = items => items.slice().sort((a, b) => Number(!!b.spine) - Number(!!a.spine));
    const nodes = [],
      seen = new Set();
    const visit = (post, depth, parentId) => {
      const id = String(post.id);
      if (seen.has(id)) return;
      seen.add(id);
      const lane = post.spine ? 0 : Math.min(MAX_DEPTH, Math.max(1, depth));
      nodes.push({
        id,
        parentId,
        depth,
        lane,
        row: nodes.length,
        spine: !!post.spine,
        handle: String(post.author?.handle || ''),
        text: String(post.text || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 90),
      });
      for (const child of order(children.get(id) || [])) visit(child, child.spine ? depth : depth + 1, id);
    };
    for (const post of order(roots)) visit(post, post.spine ? 0 : 1, null);
    // Posts whose parents form a cycle (bad data) are never reached from a root: show them as roots.
    for (const post of list) if (!seen.has(String(post.id))) visit(post, post.spine ? 0 : 1, null);
    const index = new Map(nodes.map(node => [node.id, node]));
    const edges = [];
    for (const node of nodes) if (node.parentId) edges.push({ from: node.parentId, to: node.id, kind: 'reply' });
    for (const post of list) {
      const quoted = post.quotedPostId != null ? String(post.quotedPostId) : '';
      if (quoted && index.has(quoted) && quoted !== String(post.id))
        edges.push({ from: String(post.id), to: quoted, kind: 'quote' });
    }
    const lanes = nodes.reduce((max, node) => Math.max(max, node.lane), 0);
    return {
      nodes,
      edges,
      lanes: lanes + 1,
      truncated: posts.length > list.length,
      width: PAD * 2 + lanes * LANE + 8,
      height: PAD * 2 + Math.max(0, nodes.length - 1) * ROW + 8,
    };
  }

  const escape = value =>
    String(value).replace(
      /[&<>"']/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
  const point = node => ({ x: PAD + 4 + node.lane * LANE, y: PAD + 4 + node.row * ROW });

  const QUOTE_BEND = 14,
    LABEL_WIDTH = 92;

  function svg(map, { focusId = '', visible = null } = {}) {
    const index = new Map(map.nodes.map(node => [node.id, node]));
    const hasQuotes = map.edges.some(edge => edge.kind === 'quote');
    // Handles sit in one column right of the deepest lane (and of any quote curve).
    const labelX = PAD + 4 + (map.lanes - 1) * LANE + (hasQuotes ? 8 + QUOTE_BEND : 0) + 10,
      width = labelX + LABEL_WIDTH;
    const paths = map.edges
      .map(edge => {
        const a = index.get(edge.from),
          b = index.get(edge.to);
        if (!a || !b) return '';
        const p = point(a),
          q = point(b);
        if (edge.kind === 'quote') {
          const bend = Math.max(p.x, q.x) + 8 + Math.min(QUOTE_BEND, Math.abs(q.y - p.y) / 8);
          return `<path class="tm-quote" d="M${p.x},${p.y} C${bend},${p.y} ${bend},${q.y} ${q.x},${q.y}"><title>@${escape(a.handle)} quotes @${escape(b.handle)}</title></path>`;
        }
        // Elbow: down the parent's lane, then across to the reply.
        return `<path class="tm-reply${a.spine && b.spine ? ' is-spine' : ''}" d="M${p.x},${p.y} V${q.y - 5} Q${p.x},${q.y} ${p.x + 5 * Math.sign(q.x - p.x || 1)},${q.y} H${q.x}"></path>`;
      })
      .join('');
    const dots = map.nodes
      .map((node, order) => {
        const { x, y } = point(node),
          classes = ['tm-node', node.spine ? 'is-spine' : 'is-reply'];
        if (node.id === focusId) classes.push('is-focus');
        if (visible && !visible.has(node.id)) classes.push('is-hidden');
        const label = `${node.spine ? 'Thread post' : 'Reply'} by @${node.handle}${node.text ? `: ${node.text}` : ''}`;
        const handle = node.handle.length > 13 ? `${node.handle.slice(0, 12)}…` : node.handle;
        return `<g class="${classes.join(' ')}" data-map-id="${escape(node.id)}" style="--i:${Math.min(order, 60)}" role="listitem" tabindex="-1" aria-label="${escape(label)}"><rect class="tm-hit" x="0" y="${y - ROW / 2}" width="${width}" height="${ROW}" rx="4"></rect><circle cx="${x}" cy="${y}" r="${node.spine ? 4.5 : 3.5}"></circle><text class="tm-label" x="${labelX}" y="${y + 3.5}">@${escape(handle)}</text><title>${escape(label)}</title></g>`;
      })
      .join('');
    return `<svg class="tm-svg" viewBox="0 0 ${width} ${map.height}" width="${width}" height="${map.height}" role="list" aria-label="Thread map, ${map.nodes.length} posts">${paths}${dots}</svg>`;
  }

  const api = { layout, svg, ROW, PAD };
  root.XVaultThreadMap = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
