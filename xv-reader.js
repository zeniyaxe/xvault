/* XVault Reader — a quiet, full-screen reading view for archived threads.
   Opens from the Library (t on a focused post), Quick Look, the details drawer, Atlas and the command center.
   Everything shown comes from the local archive; nothing is fetched from X except the media URLs already stored. */
(() => {
  const SIZES = [16, 17, 18, 19, 20, 22, 24],
    SIZE_KEY = 'xv-reader-size',
    MODE_KEY = 'xv-reader-mode';
  const store = {
    get(key, fallback) {
      try {
        return localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
  };
  const savedSize = SIZES.indexOf(Number(store.get(SIZE_KEY, 19)));
  let size = savedSize >= 0 ? savedSize : 3,
    mode = store.get(MODE_KEY, 'spine') === 'all' ? 'all' : 'spine',
    dialog = null,
    thread = null,
    stack = [],
    token = 0,
    returnTarget = null,
    gifWatch = null,
    markdownModule = null,
    exportModule = null;

  const html = value => (typeof esc === 'function' ? esc(value) : String(value ?? ''));
  const number = value => (typeof fmt === 'function' ? fmt(value) : String(value ?? ''));
  const say = message => (typeof toast === 'function' ? toast(message) : undefined);
  const statusUrl = post => post?.url || `https://x.com/${post?.author?.handle || 'i'}/status/${post?.id}`;
  const linkify = text =>
    typeof linkifyText === 'function'
      ? linkifyText(text)
      : html(text).replace(
          /(https?:\/\/[^\s<]+)/g,
          url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
        );
  const when = (value, style = 'medium') => {
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) && date.getTime() > 0
      ? date.toLocaleString(undefined, { dateStyle: style, timeStyle: 'short' })
      : '';
  };
  const words = text => (String(text || '').match(/\S+/g) || []).length;
  const face = (author, className) =>
    author?.avatar
      ? `<img class="${className}" src="${html(author.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="${className} is-empty" aria-hidden="true">${html(
          String(author?.name || author?.handle || '?')
            .slice(0, 1)
            .toUpperCase()
        )}</span>`;

  function ensure() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'xvReader';
    dialog.className = 'xv-reader';
    dialog.setAttribute('aria-labelledby', 'xvReaderTitle');
    dialog.innerHTML = `<div class="xr-progress" aria-hidden="true"><i></i></div>
<header class="xr-bar">
  <button type="button" class="quiet xr-back" data-act="back" hidden>← Back</button>
  <div class="xr-heading"><small id="xvReaderKicker">Reader</small><h2 id="xvReaderTitle">Loading…</h2><span class="xr-position" id="xvReaderPosition" aria-live="polite"></span></div>
  <div class="seg xr-mode" role="radiogroup" aria-label="Posts shown">
    <button type="button" role="radio" data-mode="spine">Thread</button>
    <button type="button" role="radio" data-mode="all">With replies</button>
  </div>
  <div class="xr-tools">
    <button type="button" class="quiet" data-act="smaller" aria-label="Smaller text" title="Smaller text (−)">A−</button>
    <button type="button" class="quiet" data-act="larger" aria-label="Larger text" title="Larger text (+)">A+</button>
    <span class="xr-sep" aria-hidden="true"></span>
    <button type="button" class="quiet" data-act="copy" title="Copy the thread as Markdown">Copy Markdown</button>
    <button type="button" class="quiet" data-act="download" title="Save the thread as a Markdown file">Save .md</button>
    <button type="button" class="quiet" data-act="download-html" title="Save the thread as an offline HTML page">Save .html</button>
    <button type="button" class="quiet" data-act="later" aria-pressed="false" title="Keep this thread in Read later (l)">Read later</button>
    <button type="button" class="quiet" data-act="read" aria-pressed="false" title="Mark the thread read (m)">Mark read</button>
    <span class="xr-sep" aria-hidden="true"></span>
    <button type="button" class="quiet" data-act="library" title="Show this conversation in the Library">In Library</button>
    <button type="button" class="quiet" data-act="x" title="Open the focused post on X">Open on X</button>
    <button type="button" class="quiet xr-close" data-act="close" aria-label="Close reader" title="Close (Esc)">×</button>
  </div>
</header>
<div class="xr-scroll"><main class="xr-column" id="xvReaderBody" tabindex="-1"></main></div>
<div class="xr-mark-pop" role="toolbar" aria-label="Highlight selection" hidden><button type="button" data-act="highlight">Highlight</button><button type="button" data-act="highlight-note">Highlight + note</button></div>`;
    document.body.append(dialog);
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('keydown', onKey);
    dialog.addEventListener('close', onClose);
    dialog.addEventListener(
      'error',
      event => {
        if (event.target?.tagName === 'IMG') event.target.classList.add('is-broken');
      },
      true
    );
    dialog.querySelector('.xr-scroll').addEventListener('scroll', progress, { passive: true });
    dialog.addEventListener('pointerup', () => setTimeout(selectionPopover, 0));
    dialog.addEventListener('keyup', event => event.shiftKey && selectionPopover());
    paintChrome();
    return dialog;
  }

  function paintChrome() {
    if (!dialog) return;
    dialog.style.setProperty('--xr-size', `${SIZES[size]}px`);
    for (const button of dialog.querySelectorAll('.xr-mode [data-mode]'))
      button.setAttribute('aria-checked', String(button.dataset.mode === mode));
    dialog.querySelector('.xr-back').hidden = !stack.length;
    const root = rootPost();
    for (const [act, on, labels] of [
      ['later', !!root?.readLater && !root?.readAt, ['Read later', 'In Read later']],
      ['read', !!root?.readAt, ['Mark read', 'Read ✓']],
    ]) {
      const button = dialog.querySelector(`[data-act="${act}"]`);
      button.setAttribute('aria-pressed', String(on));
      button.textContent = labels[on ? 1 : 0];
      button.disabled = !thread;
    }
    const replies = (thread?.posts || []).filter(post => !post.spine).length;
    const modeGroup = dialog.querySelector('.xr-mode');
    modeGroup.hidden = !replies;
    modeGroup.querySelector('[data-mode="all"]').textContent = replies
      ? `With replies · ${number(replies)}`
      : 'With replies';
  }

  function progress() {
    const scroller = dialog?.querySelector('.xr-scroll');
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    dialog.style.setProperty('--xr-progress', max > 0 ? String(Math.min(1, scroller.scrollTop / max)) : '1');
    updatePosition();
    rememberProgress(max > 0 ? scroller.scrollTop / max : 1);
  }

  // ---- XVault 20: reading state (read later, progress, highlights) ----
  const rootPost = () =>
    thread?.posts.find(post => post.id === thread.rootId) || thread?.posts.find(post => post.spine) || thread?.posts[0];
  async function patchPost(post, patch) {
    const result = await call({ type: 'UPDATE_TWEET_META', id: post.id, patch }).catch(error => ({
      ok: false,
      error: error?.message,
    }));
    if (!result?.ok) {
      say(result?.error || 'The change could not be saved');
      return false;
    }
    window.XVaultLibraryRecordUpdated?.([post.id]);
    return true;
  }
  let progressTimer = 0,
    finishedTicket = -1;
  function rememberProgress(fraction) {
    clearTimeout(progressTimer);
    if (!thread || thread.posts.length < 2) return;
    const ticket = token;
    progressTimer = setTimeout(async () => {
      if (ticket !== token || !dialog.open) return;
      const root = rootPost(),
        posts = [...dialog.querySelectorAll('.xr-post')],
        edge = dialog.querySelector('.xr-scroll').getBoundingClientRect().top + 90;
      let index = posts.findIndex(post => post.getBoundingClientRect().bottom > edge);
      if (index < 0) index = posts.length - 1;
      if (!root || (root.readProgress?.index === index && root.readProgress?.total === posts.length)) return;
      if (!root.readProgress && index === 0 && fraction < 0.98) return; // nothing worth remembering yet
      root.readProgress = { index, total: posts.length, postId: posts[index]?.dataset.id };
      await patchPost(root, { readProgress: root.readProgress });
      // Finishing a thread that was saved for later marks it read.
      if (fraction >= 0.98 && root.readLater && !root.readAt && finishedTicket !== ticket) {
        finishedTicket = ticket;
        root.readAt = Date.now();
        if (await patchPost(root, { readAt: root.readAt })) say('Finished · marked read');
        paintChrome();
      }
    }, 1200);
  }
  async function toggleLater() {
    const root = rootPost();
    if (!root) return;
    const on = !(root.readLater && !root.readAt);
    const patch = on ? { readLater: Date.now(), readAt: null } : { readLater: null };
    if (await patchPost(root, patch)) {
      root.readLater = on ? patch.readLater : 0;
      if (on) root.readAt = 0;
      say(on ? 'Saved to Read later' : 'Removed from Read later');
      paintChrome();
    }
  }
  async function toggleRead() {
    const root = rootPost();
    if (!root) return;
    const on = !root.readAt;
    if (await patchPost(root, { readAt: on ? Date.now() : null })) {
      root.readAt = on ? Date.now() : 0;
      say(on ? 'Marked read' : 'Marked unread');
      paintChrome();
    }
  }
  function selectedHighlight() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0),
      container = range.commonAncestorContainer,
      textRoot = (container.nodeType === 1 ? container : container.parentElement)?.closest('.xr-text');
    if (!textRoot || !dialog.contains(textRoot)) return null;
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return null;
    const before = document.createRange();
    before.selectNodeContents(textRoot);
    before.setEnd(range.startContainer, range.startOffset);
    return { article: textRoot.closest('.xr-post'), text: text.slice(0, 4000), start: before.toString().length, range };
  }
  function selectionPopover() {
    const pop = dialog?.querySelector('.xr-mark-pop');
    if (!pop) return;
    const found = selectedHighlight();
    if (!found) return void (pop.hidden = true);
    const box = found.range.getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - 220, box.left + box.width / 2 - 100))}px`;
    pop.style.top = `${Math.max(8, box.top - 46)}px`;
  }
  async function addHighlight(withNote) {
    const found = selectedHighlight(),
      pop = dialog.querySelector('.xr-mark-pop');
    pop.hidden = true;
    if (!found?.article) return say('Select text in a post to highlight it');
    const post = thread.posts.find(item => item.id === found.article.dataset.id);
    if (!post) return;
    let note = '';
    if (withNote) {
      note = prompt('Note for this highlight', '') ?? null;
      if (note === null) return;
    }
    const highlight = {
      id: `h${Date.now().toString(36)}`,
      text: found.text,
      start: found.start,
      at: Date.now(),
      ...(note ? { note } : {}),
    };
    const next = [...(post.highlights || []), highlight];
    if (await patchPost(post, { highlights: next })) {
      post.highlights = next;
      getSelection()?.removeAllRanges();
      say('Highlighted');
      render({ keepScroll: true });
    }
  }
  async function removeHighlight(element) {
    const article = element.closest('.xr-post'),
      post = thread.posts.find(item => item.id === article?.dataset.id);
    if (!post) return;
    const previous = post.highlights || [],
      next = previous.filter(item => item.id !== element.dataset.highlight);
    if (await patchPost(post, { highlights: next.length ? next : null })) {
      post.highlights = next;
      render({ keepScroll: true });
      window.XVaultUndo?.push({
        label: 'Highlight removed',
        undo: async () => {
          await call({ type: 'UPDATE_TWEET_META', id: post.id, patch: { highlights: previous } });
          post.highlights = previous;
          if (dialog.open && thread?.posts.includes(post)) render({ keepScroll: true });
        },
      });
    }
  }
  // Wraps highlighted ranges (by character offset, falling back to text search) in <mark>, across links.
  function paintHighlights(root) {
    for (const article of root.querySelectorAll('.xr-post')) {
      const post = thread.posts.find(item => item.id === article.dataset.id),
        textRoot = article.querySelector('.xr-text');
      if (!post?.highlights?.length || !textRoot) continue;
      for (const highlight of post.highlights) {
        const full = textRoot.textContent,
          normalized = full.replace(/\s+/g, ' ');
        let start =
          Number.isInteger(highlight.start) &&
          normalized.slice(highlight.start, highlight.start + highlight.text.length) === highlight.text
            ? highlight.start
            : normalized.indexOf(highlight.text);
        if (start < 0) continue;
        // Map offsets in the whitespace-collapsed string back to raw text offsets.
        const map = [];
        for (let index = 0, collapsed = 0; index < full.length; index++) {
          if (/\s/.test(full[index]) && index > 0 && /\s/.test(full[index - 1])) continue;
          map[collapsed++] = index;
        }
        const rawStart = map[start],
          rawEnd = (map[start + highlight.text.length - 1] ?? full.length - 1) + 1;
        const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT),
          pieces = [];
        let offset = 0,
          node;
        while ((node = walker.nextNode())) {
          const length = node.nodeValue.length,
            from = Math.max(rawStart, offset),
            to = Math.min(rawEnd, offset + length);
          if (from < to) pieces.push([node, from - offset, to - offset]);
          offset += length;
        }
        for (const [textNode, from, to] of pieces) {
          const range = document.createRange();
          range.setStart(textNode, from);
          range.setEnd(textNode, to);
          const mark = document.createElement('mark');
          mark.className = 'xr-hl';
          mark.dataset.highlightId = highlight.id;
          if (highlight.note) mark.title = highlight.note;
          range.surroundContents(mark);
        }
      }
    }
  }
  function highlightsMarkup(post) {
    if (!post.highlights?.length) return '';
    return `<aside class="xr-highlights" aria-label="Your highlights"><b>Highlights · ${number(post.highlights.length)}</b><ul>${post.highlights
      .map(
        item =>
          `<li><q>${html(item.text)}</q>${item.note ? `<span>${html(item.note)}</span>` : ''}<button type="button" class="quiet" data-act="unhighlight" data-highlight="${html(item.id)}" aria-label="Remove highlight">Remove</button></li>`
      )
      .join('')}</ul></aside>`;
  }
  async function related() {
    const slot = dialog.querySelector('#xvReaderRelated');
    if (!slot || !thread) return;
    const ticket = token,
      result = await call({ type: 'SEMANTIC_SIMILAR', id: thread.focusId, limit: 8 }).catch(() => null);
    const ids = (result?.results || []).map(hit => hit.id).filter(id => !thread.posts.some(post => post.id === id));
    if (ticket !== token || !ids.length) return void (slot.hidden = true);
    const records = await call({ type: 'GET_LIBRARY_RECORDS', ids: ids.slice(0, 6) }).catch(() => null);
    if (ticket !== token || !records?.rows?.length) return void (slot.hidden = true);
    slot.hidden = false;
    slot.innerHTML = `<h3>Related in your vault</h3><div class="xr-related-list">${records.rows
      .map(
        post =>
          `<button type="button" class="xr-related" data-act="post" data-post="${html(post.id)}"><b>@${html(post.author?.handle || 'unknown')}</b><span>${html(String(post.text || 'Media post').slice(0, 160))}</span></button>`
      )
      .join(
        ''
      )}</div><button type="button" class="quiet" data-act="similar-library">See all similar posts in Library</button>`;
  }
  async function suggestTags(element) {
    const article = element.closest('.xr-post'),
      post = thread?.posts.find(item => item.id === article?.dataset.id);
    if (!post) return;
    element.disabled = true;
    element.textContent = 'Thinking…';
    const result = await call({ type: 'SEMANTIC_SUGGEST_TAGS', id: post.id }).catch(error => ({
      ok: false,
      error: error?.message,
    }));
    const list = result?.suggestions || [];
    const slot = document.createElement('div');
    slot.className = 'xr-suggest';
    slot.innerHTML = list.length
      ? `<span>Suggested tags</span>${list.map(item => `<button type="button" class="chip" data-act="add-tag" data-tag="${html(item.tag)}" title="${Math.round(item.confidence * 100)}% from similar posts">#${html(item.tag)}</button>`).join('')}`
      : `<span>${html(result?.ok === false ? result.error || 'Suggestions are unavailable' : 'No suggestions yet — tag a few similar posts first.')}</span>`;
    element.replaceWith(slot);
  }
  async function addTag(element) {
    const article = element.closest('.xr-post'),
      post = thread?.posts.find(item => item.id === article?.dataset.id),
      tag = element.dataset.tag;
    if (!post || !tag) return;
    const result = await call({ type: 'BULK_UPDATE_TWEET_META', ids: [post.id], patch: { addTags: [tag] } }).catch(
      () => null
    );
    if (!result?.ok) return say('The tag could not be added');
    post.tags = [...new Set([...(post.tags || []), tag])];
    element.disabled = true;
    element.textContent = `#${tag} ✓`;
    window.XVaultLibraryRecordUpdated?.([post.id]);
    window.XVaultUndo?.push({ label: `Tagged #${tag}`, entries: result.previous || [] });
  }

  function mediaMarkup(item, index) {
    const poster = html(item.preview || '');
    if (item.type === 'video')
      return `<figure class="xr-media is-video"><video controls preload="none" playsinline${poster ? ` poster="${poster}"` : ''} src="${html(item.playbackUrl || item.url)}"></video></figure>`;
    if (item.type === 'gif')
      return `<figure class="xr-media is-gif"><video class="xr-gif" muted loop playsinline preload="none"${poster ? ` poster="${poster}"` : ''} src="${html(item.playbackUrl || item.url)}"></video><figcaption>GIF</figcaption></figure>`;
    const ratio = item.width && item.height ? ` style="aspect-ratio:${item.width}/${item.height}"` : '';
    const alt = item.altText ? html(item.altText) : '';
    return `<figure class="xr-media is-photo"><button type="button" class="xr-zoom" data-act="zoom" aria-label="Enlarge image ${index + 1}"><img src="${html(item.preview || item.url)}" data-full="${html(item.url)}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer"${ratio}></button>${alt ? `<figcaption class="xr-alt"><details><summary>ALT</summary><p>${alt}</p></details></figcaption>` : ''}</figure>`;
  }

  /* XVault 21: polls, link cards, Spaces, Community Notes, availability and change history. */
  const ago = stamp => (stamp ? new Date(stamp).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
  const AVAILABILITY = {
    deleted: 'Deleted on X',
    suspended: 'Author suspended on X',
    protected: 'Now protected on X',
    withheld: 'Withheld on X',
    unavailable: 'No longer available on X',
  };
  function extrasMarkup(post) {
    const parts = [];
    const poll = post.poll;
    if (poll?.choices?.length) {
      const total = Math.max(
        1,
        Number(poll.totalVotes) || poll.choices.reduce((sum, choice) => sum + (choice.count || 0), 0)
      );
      const top = Math.max(...poll.choices.map(choice => choice.count || 0));
      parts.push(
        `<section class="xr-poll" aria-label="Poll"><ol>${poll.choices
          .map(choice => {
            const share = Math.round(((choice.count || 0) / total) * 1000) / 10;
            return `<li class="${choice.count === top && top ? 'is-top' : ''}"><span class="xr-poll-bar" style="width:${share}%"></span><b>${html(choice.label)}</b><span>${share}%</span></li>`;
          })
          .join(
            ''
          )}</ol><small>${number(poll.totalVotes || 0)} votes · ${poll.final ? 'final results' : poll.endsAt ? `ends ${html(ago(poll.endsAt))}` : 'results when archived'}</small></section>`
      );
    }
    const card = post.card;
    if (card && (card.url || card.title))
      parts.push(
        `<a class="xr-card" href="${html(card.url || statusUrl(post))}" target="_blank" rel="noopener noreferrer">${card.image?.url ? `<img src="${html(card.image.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span><small>${html(card.domain || '')}</small><b>${html(card.title || card.url || '')}</b>${card.description ? `<em>${html(String(card.description).slice(0, 240))}</em>` : ''}</span></a>`
      );
    if (post.space?.url)
      parts.push(
        `<a class="xr-card is-space" href="${html(post.space.url)}" target="_blank" rel="noopener noreferrer"><span><small>X Space</small><b>Listen on X ↗</b></span></a>`
      );
    if (post.communityNote?.text)
      parts.push(
        `<aside class="xr-cnote"><b>${html(post.communityNote.title || 'Readers added context')}</b><p>${html(post.communityNote.text)}</p>${post.communityNote.url ? `<a href="${html(post.communityNote.url)}" target="_blank" rel="noopener noreferrer">Community note ↗</a>` : ''}</aside>`
      );
    const state = post.availability?.state;
    if ((state && state !== 'available') || post.archiveDeletedAt)
      parts.push(
        `<p class="xr-gone" role="note"><b>${html(AVAILABILITY[state] || 'Deleted by you on X')}</b> · ${post.availability?.checkedAt ? `noticed ${html(ago(post.availability.checkedAt))}` : `deleted ${html(ago(post.archiveDeletedAt))}`} · your archived copy is kept${state ? ' <button type="button" class="quiet" data-act="availability-clear">It is back on X</button>' : ''}</p>`
      );
    const versions = Number(post.revisionCount) || 0,
      edited = post.edit?.edited || Number(post.textRevisionCount) > 0;
    const links = (post.links || []).length;
    const tools = [
      versions || edited
        ? `<button type="button" class="quiet" data-act="history" aria-expanded="false">${edited ? 'Edited · ' : ''}History${versions ? ` (${number(versions)} change${versions === 1 ? '' : 's'})` : ''}</button>`
        : '',
      links
        ? `<button type="button" class="quiet" data-act="snapshot" aria-expanded="false">Saved page${links > 1 ? 's' : ''}</button>`
        : '',
    ].filter(Boolean);
    if (tools.length)
      parts.push(`<div class="xr-forge-tools">${tools.join('')}</div><div class="xr-forge-panel" hidden></div>`);
    return parts.join('');
  }

  function historyMarkup(result, post) {
    const Diff = window.XVaultRevisionDiff;
    if (!Diff) return '<p>History view unavailable.</p>';
    const { steps } = Diff.timeline(result.revisions || [], null);
    if (!steps.length)
      return `<p class="xr-forge-empty">${post.edit?.edited ? 'X marks this post as edited, but XVault only kept one version. Earlier versions appear here when XVault sees the post change.' : 'No changes recorded yet.'}</p>`;
    return `<ol class="xr-history">${steps
      .slice()
      .reverse()
      .map(step => {
        const stats = step.textOps ? Diff.diffStats(step.textOps) : null;
        const text = step.textOps
          ? `<p class="xr-diff">${step.textOps
              .map(op =>
                op.type === 'same'
                  ? html(op.text)
                  : `<${op.type === 'add' ? 'ins' : 'del'}>${html(op.text)}</${op.type === 'add' ? 'ins' : 'del'}>`
              )
              .join('')}</p>`
          : '';
        const fields = step.fields
          .filter(field => field.key !== 'text')
          .map(field =>
            field.key === 'metrics'
              ? `<li>Engagement: ${field.deltas.map(delta => `${html(delta.key)} ${number(delta.from)} → ${number(delta.to)}`).join(', ')}</li>`
              : `<li>${html(field.label)} changed</li>`
          )
          .join('');
        return `<li><header><time>${html(new Date(step.at).toLocaleString())}</time>${stats ? `<span>+${number(stats.added)} / −${number(stats.removed)} words</span>` : ''}</header>${text}${fields ? `<ul>${fields}</ul>` : ''}</li>`;
      })
      .join('')}</ol>`;
  }

  function snapshotMarkup(result) {
    const rows = result.snapshots || [];
    if (!rows.length)
      return `<p class="xr-forge-empty">No copy of the linked page yet.</p><button type="button" data-act="snapshot-now">Save a readable copy now</button>`;
    return (
      rows
        .slice(0, 4)
        .map(row =>
          row.status === 'ok'
            ? `<article class="xr-snapshot"><header><b>${html(row.title || row.finalUrl || row.url)}</b><small>${html(row.siteName || new URL(row.finalUrl || row.url).hostname)} · saved ${html(ago(row.fetchedAt))}${row.truncated ? ' · trimmed' : ''}</small></header>${row.description ? `<p><em>${html(row.description)}</em></p>` : ''}<div class="xr-snapshot-text" dir="auto">${html(String(row.text || '').slice(0, 6000))}${String(row.text || '').length > 6000 ? '…' : ''}</div><a href="${html(row.finalUrl || row.url)}" target="_blank" rel="noopener noreferrer">Open the live page ↗</a></article>`
            : `<p class="xr-forge-empty">${html(row.url)} could not be saved: ${html(row.error || 'unknown error')}</p>`
        )
        .join('') + '<button type="button" class="quiet" data-act="snapshot-now">Save again</button>'
    );
  }

  async function forgePanel(name, element, { refresh = false } = {}) {
    const article = element.closest('.xr-post'),
      panel = article?.querySelector('.xr-forge-panel'),
      id = article?.dataset.id,
      post = thread?.posts.find(entry => entry.id === id);
    if (!panel || !post) return;
    if (name === 'availability-clear') {
      const result = await call({ type: 'AVAILABILITY_SET', id, state: 'clear' }).catch(() => null);
      if (result?.ok) {
        post.availability = null;
        element.closest('.xr-gone')?.remove();
        say('Marked as available');
      }
      return;
    }
    if (name === 'snapshot-now') {
      const granted = await chrome.permissions
        ?.request?.({ origins: ['https://*/*', 'http://*/*'] })
        .catch(() => false);
      if (!granted) return say('XVault needs permission to read linked websites');
      const result = await call({ type: 'SNAPSHOT_LINKS', ids: [id], force: true }).catch(() => null);
      if (!result?.ok) return say(result?.error || 'Could not save the page');
      say(result.queued ? 'Saving a readable copy…' : 'Already saved');
      setTimeout(
        () => forgePanel('snapshot', article.querySelector('[data-act="snapshot"]'), { refresh: true }).catch(() => {}),
        2500
      );
      return;
    }
    const button = article.querySelector(`[data-act="${name}"]`);
    const open = !refresh && panel.dataset.kind === name && !panel.hidden && element === button;
    article
      .querySelectorAll('.xr-forge-tools [aria-expanded]')
      .forEach(other => other.setAttribute('aria-expanded', 'false'));
    if (open) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    panel.dataset.kind = name;
    panel.innerHTML = '<p class="xr-forge-empty">Loading…</p>';
    button?.setAttribute('aria-expanded', 'true');
    const result =
      name === 'history'
        ? await call({ type: 'REVISIONS_FOR', id }).catch(() => null)
        : await call({ type: 'SNAPSHOT_FOR_POST', id }).catch(() => null);
    if (!result?.ok) {
      panel.innerHTML = `<p class="xr-forge-empty">${html(result?.error || 'Could not load')}</p>`;
      return;
    }
    panel.innerHTML = name === 'history' ? historyMarkup(result, post) : snapshotMarkup(result);
  }

  function quoteMarkup(quoted, missingId) {
    if (quoted)
      return `<button type="button" class="xr-quote" data-act="post" data-post="${html(quoted.id)}" aria-label="Read the quoted post by @${html(quoted.author.handle)}"><span class="xr-quote-by"><b>${html(quoted.author.name || quoted.author.handle)}</b> @${html(quoted.author.handle)}${quoted.createdAt ? ` · ${html(when(quoted.createdAt))}` : ''}</span><span class="xr-quote-text">${html(quoted.text.slice(0, 420))}${quoted.text.length > 420 ? '…' : ''}</span>${quoted.media[0]?.preview ? `<img src="${html(quoted.media[0].preview)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</button>`;
    if (missingId)
      return `<a class="xr-quote is-missing" href="https://x.com/i/status/${html(missingId)}" target="_blank" rel="noopener noreferrer">Quoted post not archived · Open on X ↗</a>`;
    return '';
  }

  function postMarkup(post, index, spineIndex, spineTotal) {
    const focus = post.id === thread.focusId,
      reply = !post.spine;
    const author = reply
      ? `<header class="xr-by">${face(post.author, 'xr-avatar')}<b>${html(post.author.name || post.author.handle)}</b><span>@${html(post.author.handle)}</span>${post.author.verified ? '<i class="xr-verified" title="Verified">✓</i>' : ''}</header>`
      : '';
    const metrics = [
      post.metrics?.likes ? `${number(post.metrics.likes)} likes` : '',
      post.metrics?.reposts ? `${number(post.metrics.reposts)} reposts` : '',
      post.metrics?.views ? `${number(post.metrics.views)} views` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<article class="xr-post${reply ? ' is-reply' : ''}${focus ? ' is-focus' : ''}" data-id="${html(post.id)}" tabindex="-1" aria-label="${reply ? `Reply by @${html(post.author.handle)}` : `Post ${spineIndex} of ${spineTotal}`}">
${reply ? '' : `<span class="xr-index" aria-hidden="true">${spineIndex}</span>`}${author}
<div class="xr-text" dir="auto"${post.language ? ` lang="${html(post.language)}"` : ''}>${linkify(post.text)}</div>
${post.media.length ? `<div class="xr-gallery" data-count="${post.media.length}">${post.media.map(mediaMarkup).join('')}</div>` : ''}
${quoteMarkup(post.quoted, post.quotedPostId && !post.quoted ? post.quotedPostId : '')}
${extrasMarkup(post)}
${post.note ? `<aside class="xr-note"><b>Your note</b><span class="xr-note-text">${html(post.note)}</span><button type="button" class="quiet xr-note-edit" data-act="note" aria-label="Edit your note on this post">Edit</button></aside>` : ''}
${highlightsMarkup(post)}
<footer class="xr-meta"><time datetime="${html(post.createdAt || '')}">${html(when(post.createdAt))}</time>${metrics ? `<span>${metrics}</span>` : ''}${post.favorite ? '<span class="xr-fav">★ Favorite</span>' : ''}${
      post.tags?.length
        ? `<span class="xr-tags">${post.tags
            .slice(0, 6)
            .map(tag => `#${html(tag)}`)
            .join(' ')}</span>`
        : ''
    }${post.note ? '' : '<button type="button" class="quiet xr-note-add" data-act="note" aria-label="Add a note to this post">Add note</button>'}${focus ? '<button type="button" class="quiet" data-act="suggest-tags" title="Suggest tags from similar posts in your vault">Suggest tags</button>' : ''}<a href="${html(statusUrl(post))}" target="_blank" rel="noopener noreferrer">Open post ↗</a></footer>
</article>`;
  }

  function render({ keepScroll = false } = {}) {
    const body = dialog.querySelector('#xvReaderBody'),
      scroller = dialog.querySelector('.xr-scroll');
    const all = thread.posts,
      spine = all.filter(post => post.spine),
      shown = mode === 'all' ? all : spine.length ? spine : all,
      root = spine[0] || all[0];
    const focusHidden = !shown.some(post => post.id === thread.focusId);
    const visible = focusHidden ? [...shown, all.find(post => post.id === thread.focusId)].filter(Boolean) : shown;
    visible.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const minutes = Math.max(1, Math.round(visible.reduce((sum, post) => sum + words(post.text), 0) / 230));
    const first = root?.createdAt ? when(root.createdAt, 'long') : '';
    dialog.querySelector('#xvReaderKicker').textContent = spine.length > 1 ? 'Thread' : 'Post';
    dialog.querySelector('#xvReaderTitle').textContent =
      `@${root?.author.handle || 'unknown'} · ${number(spine.length || 1)} ${spine.length > 1 ? 'posts' : 'post'}`;
    let spineIndex = 0;
    body.innerHTML = `<header class="xr-mast">
${face(root?.author, 'xr-mast-avatar')}
<div><h1>${html(root?.author.name || root?.author.handle || 'Unknown author')}${root?.author.verified ? ' <i class="xr-verified" title="Verified">✓</i>' : ''}</h1>
<p>@${html(root?.author.handle || 'unknown')}${first ? ` · ${html(first)}` : ''} · ${minutes} min read</p></div>
</header>
${!keepScroll && rootPost()?.readProgress?.index > 0 && rootPost().readProgress.index < visible.length - 1 ? `<p class="xr-resume"><button type="button" class="quiet" data-act="resume" data-resume="${html(rootPost().readProgress.postId || '')}">Resume where you left off · post ${number(rootPost().readProgress.index + 1)} of ${number(rootPost().readProgress.total)}</button></p>` : ''}
${thread.missingParent ? `<p class="xr-gap">This conversation continues above a post that isn't archived. <button type="button" class="quiet" data-act="fetch-parent" title="Opens the post in a background x.com tab so XVault can capture it">Fetch it from X</button> <a href="https://x.com/i/status/${html(thread.missingParent)}" target="_blank" rel="noopener noreferrer">Read it on X ↗</a></p>` : ''}
${visible.map((post, index) => postMarkup(post, index, post.spine ? ++spineIndex : 0, spine.length)).join('')}
<footer class="xr-end"><span>End of what's archived</span>${thread.posts.length > visible.length ? `<button type="button" class="quiet" data-mode-switch="all">Show ${number(thread.posts.length - visible.length)} more replies</button>` : ''}</footer>
<section class="xr-related-wrap" id="xvReaderRelated" hidden aria-label="Related posts"></section>`;
    paintChrome();
    paintHighlights(body);
    watchGifs(body);
    void related();
    if (!keepScroll) {
      const target = body.querySelector('.xr-post.is-focus');
      scroller.scrollTop = 0;
      if (target && target !== body.querySelector('.xr-post')) target.scrollIntoView({ block: 'start' });
      target?.focus({ preventScroll: true });
    }
    progress();
    window.XVaultMotion?.stagger(body.querySelectorAll('.xr-mast,.xr-post'), 'rise', { step: 28, max: 8 });
  }

  function watchGifs(root) {
    gifWatch?.disconnect();
    const gifs = root.querySelectorAll('video.xr-gif');
    if (!gifs.length || typeof IntersectionObserver !== 'function') return;
    gifWatch = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) entry.target.play().catch(() => {});
          else entry.target.pause();
        }
      },
      { root: dialog.querySelector('.xr-scroll'), threshold: 0.35 }
    );
    gifs.forEach(video => gifWatch.observe(video));
  }

  function skeleton() {
    dialog.querySelector('#xvReaderKicker').textContent = 'Reader';
    dialog.querySelector('#xvReaderTitle').textContent = 'Loading…';
    dialog.querySelector('#xvReaderBody').innerHTML =
      `<div class="xr-loading" aria-busy="true">${'<i class="xv-skeleton"></i>'.repeat(6)}</div>`;
  }

  function failure(message, id) {
    thread = null;
    dialog.querySelector('#xvReaderKicker').textContent = 'Reader';
    dialog.querySelector('#xvReaderTitle').textContent = 'Not available';
    dialog.querySelector('#xvReaderBody').innerHTML =
      `<div class="empty xr-empty"><p>${html(message)}</p>${id ? `<a href="https://x.com/i/status/${html(id)}" target="_blank" rel="noopener noreferrer">Open on X ↗</a>` : ''}</div>`;
    paintChrome();
  }

  async function load(id, { push = false } = {}) {
    const ticket = ++token;
    if (push && thread) stack.push({ id: thread.focusId, scroll: dialog.querySelector('.xr-scroll').scrollTop });
    skeleton();
    paintChrome();
    let result;
    try {
      result = await call({ type: 'GET_THREAD', id: String(id) });
    } catch (error) {
      result = { ok: false, error: error?.message };
    }
    if (ticket !== token || !dialog.open) return;
    if (!result?.ok || !result.posts?.length) return failure(result?.error || 'This post is not in the archive.', id);
    thread = result;
    render();
  }

  async function open(id, options = {}) {
    if (!/^\d{1,32}$/.test(String(id || ''))) return say('Choose an archived post to read');
    ensure();
    if (!dialog.open) {
      returnTarget = options.returnTo || document.activeElement;
      stack = [];
      thread = null;
      dialog.showModal();
      window.XVaultMotion?.enter(dialog, 'fade', { duration: 220 });
    }
    await load(id, { push: !!options.push });
  }

  function close() {
    if (dialog?.open) dialog.close();
  }

  function onClose() {
    token++;
    gifWatch?.disconnect();
    dialog.querySelectorAll('video').forEach(video => video.pause());
    const target = returnTarget;
    returnTarget = null;
    if (target?.isConnected) target.focus?.({ preventScroll: true });
  }

  async function markdown() {
    if (!thread) return '';
    markdownModule ||= await import('./vault-insights.mjs');
    return markdownModule.threadMarkdown(thread, { includeReplies: mode === 'all' });
  }

  function step(direction) {
    const posts = [...dialog.querySelectorAll('.xr-post')];
    if (!posts.length) return;
    const scroller = dialog.querySelector('.xr-scroll'),
      edge = scroller.getBoundingClientRect().top + 72;
    let index = posts.findIndex(post => post.getBoundingClientRect().top > edge + 4);
    if (index < 0) index = posts.length;
    const current = direction > 0 ? index : index - 2;
    const target = posts[Math.max(0, Math.min(posts.length - 1, current))];
    target.scrollIntoView({ block: 'start', behavior: window.XVaultMotion?.calm?.() ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
  }

  function focusedPost() {
    const active = document.activeElement?.closest?.('.xr-post');
    return thread?.posts.find(post => post.id === (active?.dataset.id || thread.focusId)) || thread?.posts[0];
  }

  async function act(name, element) {
    if (name === 'close') return close();
    if (name === 'back') {
      const previous = stack.pop();
      if (previous) await load(previous.id);
      return;
    }
    if (name === 'smaller' || name === 'larger') {
      size = Math.max(0, Math.min(SIZES.length - 1, size + (name === 'larger' ? 1 : -1)));
      store.set(SIZE_KEY, String(SIZES[size]));
      return paintChrome();
    }
    if (name === 'zoom') {
      const figure = element.closest('.xr-media'),
        image = figure?.querySelector('img');
      if (!figure || !image) return;
      const wide = figure.classList.toggle('is-wide');
      if (wide && image.dataset.full && image.src !== image.dataset.full) image.src = image.dataset.full;
      element.setAttribute('aria-label', wide ? 'Shrink image' : 'Enlarge image');
      return;
    }
    if (name === 'post') return element.dataset.post && load(element.dataset.post, { push: true });
    if (!thread) return;
    if (name === 'x') return window.open(statusUrl(focusedPost()), '_blank', 'noopener');
    if (name === 'library') {
      const query = `thread:${thread.conversationId || thread.rootId}`;
      close();
      return window.XVaultOpenLibrarySearch?.(query);
    }
    if (['history', 'snapshot', 'snapshot-now', 'availability-clear'].includes(name)) return forgePanel(name, element);
    if (name === 'note') return editNote(element.closest('.xr-post'));
    if (name === 'later') return toggleLater();
    if (name === 'read') return toggleRead();
    if (name === 'highlight' || name === 'highlight-note') return addHighlight(name === 'highlight-note');
    if (name === 'unhighlight') return removeHighlight(element);
    if (name === 'suggest-tags') return suggestTags(element);
    if (name === 'add-tag') return addTag(element);
    if (name === 'similar-library') {
      const id = thread.focusId;
      close();
      page('library');
      return window.XVaultLibraryRunQuery
        ? window.XVaultLibraryRunQuery(`similar:${id}`, 'relevance')
        : window.XVaultOpenLibrarySearch?.(`similar:${id}`);
    }
    if (name === 'resume') {
      const target = dialog.querySelector(`.xr-post[data-id="${CSS.escape(element.dataset.resume || '')}"]`);
      element.closest('.xr-resume')?.remove();
      target?.scrollIntoView({ block: 'start', behavior: window.XVaultMotion?.calm?.() ? 'auto' : 'smooth' });
      target?.focus({ preventScroll: true });
      return;
    }
    if (name === 'fetch-parent') {
      const missing = thread.missingParent;
      element.disabled = true;
      element.textContent = 'Fetching…';
      const result = await call({ type: 'FETCH_MISSING_POST', id: missing }).catch(error => ({
        ok: false,
        error: error?.message,
      }));
      if (result?.found) {
        say('Parent post archived');
        return load(thread.focusId);
      }
      element.disabled = false;
      element.textContent = 'Fetch it from X';
      return say(result?.error || 'The post could not be fetched');
    }
    if (name === 'download-html') {
      exportModule ||= await import('./library-exporters.mjs');
      const posts = mode === 'all' ? thread.posts : thread.posts.filter(post => post.spine);
      const view = { ...thread, posts: posts.length ? posts : thread.posts };
      view.participants = [...new Set(view.posts.map(post => post.author.handle))];
      view.start = Date.parse(view.posts[0]?.createdAt || '') || 0;
      const text =
        exportModule.htmlThreadHead(`Thread by @${thread.rootHandle || 'unknown'}`) +
        exportModule.htmlThread(view) +
        exportModule.htmlThreadFoot();
      const url = URL.createObjectURL(new Blob([text], { type: 'text/html' })),
        link = document.createElement('a');
      link.href = url;
      link.download = `xvault-thread-${thread.rootHandle || 'post'}-${thread.rootId}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return say('HTML saved');
    }
    if (name === 'copy' || name === 'download') {
      const text = await markdown();
      if (!text) return say('Nothing to export');
      if (name === 'copy') {
        await navigator.clipboard.writeText(text).then(
          () => say('Thread copied as Markdown'),
          () => say('Clipboard is unavailable')
        );
        return;
      }
      const blob = new Blob([text], { type: 'text/markdown' }),
        url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `xvault-thread-${thread.rootHandle || 'post'}-${thread.rootId}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      say('Markdown saved');
    }
  }

  // Inline note editor. Saves through UPDATE_TWEET_META with the original note as a conflict guard,
  // so an edit made elsewhere (Library inspector, phone) is never silently overwritten.
  function editNote(article) {
    if (!article || article.querySelector('.xr-note-form')) return;
    const post = thread?.posts.find(item => item.id === article.dataset.id);
    if (!post) return;
    const original = post.note || '';
    const form = document.createElement('form');
    form.className = 'xr-note-form';
    form.innerHTML = `<label class="xr-note-label" for="xrNote${html(post.id)}">Your note</label><textarea id="xrNote${html(post.id)}" rows="3" maxlength="4000"></textarea><div class="xr-note-actions"><button type="submit" class="primary">Save note</button><button type="button" class="quiet" data-note-cancel>Cancel</button><small>Ctrl+Enter saves · Esc cancels</small></div>`;
    const area = form.querySelector('textarea');
    area.value = original;
    const existing = article.querySelector('.xr-note');
    (existing || article.querySelector('.xr-meta')).before(form);
    if (existing) existing.hidden = true;
    area.focus();
    const finish = () => {
      form.remove();
      if (existing) existing.hidden = false;
      article.focus({ preventScroll: true });
    };
    form.querySelector('[data-note-cancel]').onclick = finish;
    area.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.onsubmit = async event => {
      event.preventDefault();
      const value = area.value.trim();
      const result = await call({
        type: 'UPDATE_TWEET_META',
        id: post.id,
        patch: { note: value },
        expectedNote: original,
      }).catch(error => ({ ok: false, error: error?.message }));
      if (!result?.ok) return say(result?.error || 'The note could not be saved');
      post.note = value;
      say(value ? 'Note saved' : 'Note removed');
      render({ keepScroll: true });
      dialog.querySelector(`.xr-post[data-id="${CSS.escape(post.id)}"]`)?.focus({ preventScroll: true });
    };
  }

  function updatePosition() {
    const label = dialog?.querySelector('#xvReaderPosition');
    if (!label) return;
    const posts = [...dialog.querySelectorAll('.xr-post')];
    if (posts.length < 2) return (label.textContent = '');
    const edge = dialog.querySelector('.xr-scroll').getBoundingClientRect().top + 90;
    let index = posts.findIndex(post => post.getBoundingClientRect().bottom > edge);
    if (index < 0) index = posts.length - 1;
    label.textContent = `${index + 1} / ${posts.length}`;
  }

  function jump(where) {
    const posts = [...dialog.querySelectorAll('.xr-post')];
    const target =
      where === 'first' ? posts[0] : where === 'last' ? posts.at(-1) : dialog.querySelector('.xr-post.is-focus');
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: window.XVaultMotion?.calm?.() ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
  }

  function setMode(next) {
    if (next === mode || !thread) return;
    mode = next;
    store.set(MODE_KEY, mode);
    const run = () => render({ keepScroll: true });
    if (window.XVaultMotion?.transition) window.XVaultMotion.transition(run);
    else run();
  }

  function onClick(event) {
    const modeButton = event.target.closest('[data-mode]');
    if (modeButton && dialog.contains(modeButton)) return setMode(modeButton.dataset.mode);
    const switcher = event.target.closest('[data-mode-switch]');
    if (switcher) return setMode(switcher.dataset.modeSwitch);
    const control = event.target.closest('[data-act]');
    if (control) {
      event.preventDefault();
      act(control.dataset.act, control);
    }
  }

  function onKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest('input,textarea,select,[contenteditable]')) return;
    const key = event.key;
    if (key === 'Escape') {
      const wide = dialog.querySelector('.xr-media.is-wide');
      if (wide) {
        event.preventDefault();
        wide.classList.remove('is-wide');
        return;
      }
      return;
    }
    const handled = {
      j: () => step(1),
      k: () => step(-1),
      '+': () => act('larger'),
      '=': () => act('larger'),
      '-': () => act('smaller'),
      r: () => setMode(mode === 'all' ? 'spine' : 'all'),
      o: () => act('x'),
      n: () => editNote(document.activeElement?.closest?.('.xr-post') || dialog.querySelector('.xr-post.is-focus')),
      l: () => toggleLater(),
      m: () => toggleRead(),
      h: () => addHighlight(false),
      f: () => jump('focus'),
      Home: () => jump('first'),
      End: () => jump('last'),
      g: () => jump('first'),
      G: () => jump('last'),
      Backspace: () => stack.length && act('back'),
    }[key];
    if (!handled || (event.target.closest('video') && key !== 'j' && key !== 'k')) return;
    event.preventDefault();
    event.stopPropagation();
    handled();
  }

  // Library helper shared with Atlas: show results for a query on the Library page.
  window.XVaultOpenLibrarySearch ||= query => {
    page('library');
    const input = document.querySelector('#search');
    if (!input) return;
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
  };

  function libraryTarget() {
    const quick = document.querySelector('#xvQuickLook');
    if (quick?.open) return { id: window.XVaultQuickLookPostId?.(), quick: true };
    const card = document.activeElement?.closest?.('#list .tweet');
    return card ? { id: card.dataset.id, card } : null;
  }

  // `g` then `t` is the shell's Studio chord; only a bare `t` opens the reader.
  let chordStarted = 0;
  document.addEventListener('keydown', event => {
    if (event.key === 'g') chordStarted = Date.now();
    if (event.key !== 't' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (Date.now() - chordStarted < 1100) return;
    if (event.target.closest('input,textarea,select,[contenteditable]') || dialog?.open) return;
    if (!document.querySelector('#lightbox')?.classList.contains('hidden')) return;
    const target = libraryTarget();
    if (!target?.id) return;
    event.preventDefault();
    if (target.quick) {
      const back = window.XVaultQuickLookReturnTarget?.();
      window.XVaultCloseQuickLook?.();
      open(target.id, { returnTo: back });
    } else open(target.id, { returnTo: target.card });
  });

  // A Read button in the details drawer for every post.
  function decorateDrawer() {
    const drawer = document.querySelector('#detailsDrawer'),
      actions = drawer?.querySelector('.drawerActions');
    if (!actions || actions.querySelector('[data-xv-reader]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.xvReader = '';
    button.title = 'Read the thread (t)';
    button.innerHTML = `${window.XVaultIcons?.svg('reader') || ''}<span class="lbl">Read thread</span>`;
    button.addEventListener('click', () => open(drawer.dataset.postId, { returnTo: button }));
    actions.prepend(button);
  }
  function mount() {
    const body = document.querySelector('#drawerBody');
    if (body) new MutationObserver(decorateDrawer).observe(body, { childList: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  // Settings → Accessibility → Reader text size picks the nearest step; the in-Reader A−/A+ buttons still work.
  function setSize(px) {
    const wanted = Number(px);
    if (!Number.isFinite(wanted)) return;
    size = SIZES.reduce(
      (best, value, index) => (Math.abs(value - wanted) < Math.abs(SIZES[best] - wanted) ? index : best),
      0
    );
    store.set(SIZE_KEY, String(SIZES[size]));
    paintChrome();
  }
  window.XVaultReader = { open, close, setSize, isOpen: () => !!dialog?.open };
})();
