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
    <button type="button" class="quiet" data-act="library" title="Show this conversation in the Library">In Library</button>
    <button type="button" class="quiet" data-act="x" title="Open the focused post on X">Open on X</button>
    <button type="button" class="quiet xr-close" data-act="close" aria-label="Close reader" title="Close (Esc)">×</button>
  </div>
</header>
<div class="xr-scroll"><main class="xr-column" id="xvReaderBody" tabindex="-1"></main></div>`;
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
    paintChrome();
    return dialog;
  }

  function paintChrome() {
    if (!dialog) return;
    dialog.style.setProperty('--xr-size', `${SIZES[size]}px`);
    for (const button of dialog.querySelectorAll('.xr-mode [data-mode]'))
      button.setAttribute('aria-checked', String(button.dataset.mode === mode));
    dialog.querySelector('.xr-back').hidden = !stack.length;
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
  }

  function mediaMarkup(item, index) {
    const poster = html(item.preview || '');
    if (item.type === 'video')
      return `<figure class="xr-media is-video"><video controls preload="none" playsinline${poster ? ` poster="${poster}"` : ''} src="${html(item.playbackUrl || item.url)}"></video></figure>`;
    if (item.type === 'gif')
      return `<figure class="xr-media is-gif"><video class="xr-gif" muted loop playsinline preload="none"${poster ? ` poster="${poster}"` : ''} src="${html(item.playbackUrl || item.url)}"></video><figcaption>GIF</figcaption></figure>`;
    const ratio = item.width && item.height ? ` style="aspect-ratio:${item.width}/${item.height}"` : '';
    return `<figure class="xr-media is-photo"><button type="button" class="xr-zoom" data-act="zoom" aria-label="Enlarge image ${index + 1}"><img src="${html(item.preview || item.url)}" data-full="${html(item.url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"${ratio}></button></figure>`;
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
${post.note ? `<aside class="xr-note"><b>Your note</b><span class="xr-note-text">${html(post.note)}</span><button type="button" class="quiet xr-note-edit" data-act="note" aria-label="Edit your note on this post">Edit</button></aside>` : ''}
<footer class="xr-meta"><time datetime="${html(post.createdAt || '')}">${html(when(post.createdAt))}</time>${metrics ? `<span>${metrics}</span>` : ''}${post.favorite ? '<span class="xr-fav">★ Favorite</span>' : ''}${post.note ? '' : '<button type="button" class="quiet xr-note-add" data-act="note" aria-label="Add a note to this post">Add note</button>'}<a href="${html(statusUrl(post))}" target="_blank" rel="noopener noreferrer">Open post ↗</a></footer>
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
${thread.missingParent ? `<p class="xr-gap">This conversation continues above a post that isn't archived. <button type="button" class="quiet" data-act="fetch-parent" title="Opens the post in a background x.com tab so XVault can capture it">Fetch it from X</button> <a href="https://x.com/i/status/${html(thread.missingParent)}" target="_blank" rel="noopener noreferrer">Read it on X ↗</a></p>` : ''}
${visible.map((post, index) => postMarkup(post, index, post.spine ? ++spineIndex : 0, spine.length)).join('')}
<footer class="xr-end"><span>End of what's archived</span>${thread.posts.length > visible.length ? `<button type="button" class="quiet" data-mode-switch="all">Show ${number(thread.posts.length - visible.length)} more replies</button>` : ''}</footer>`;
    paintChrome();
    watchGifs(body);
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
    if (name === 'note') return editNote(element.closest('.xr-post'));
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

  window.XVaultReader = { open, close, isOpen: () => !!dialog?.open };
})();
