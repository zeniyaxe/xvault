/* XVault 22 "Keystone" — Library timeline.
   A histogram of every post the current search matches (whole archive, not just the loaded page), by the
   day it was posted or archived. Click a bar, or drag across several, to narrow the search with
   after:/before: (archived-after:/archived-before:); "All dates" removes them again. Counts come from
   LIBRARY_TIMELINE in the service worker and are cached per search and archive revision. */
(() => {
  const $ = selector => document.querySelector(selector);
  const OPEN_KEY = 'xv-timeline-open',
    FIELD_KEY = 'xv-timeline-field';
  const n = value => (typeof fmt === 'function' ? fmt(Number(value) || 0) : String(Number(value) || 0));
  const html = value =>
    typeof esc === 'function' ? esc(value) : String(value ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
  const hooks = window.XVaultDashboard;
  const read = (key, fallback) => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  };
  const state = {
    open: read(OPEN_KEY, '1') === '1',
    field: read(FIELD_KEY, 'posted'),
    data: null,
    query: null,
    at: 0,
  };
  let timer = 0,
    serial = 0;

  const TOKENS = {
    posted: /(?:^|\s)-?(?:after|before):\S+/g,
    archived: /(?:^|\s)-?archived-(?:after|before):\S+/g,
  };
  /** The query without this field's date filters, plus the new range (from inclusive, to exclusive). */
  function withRange(query, field, from, to) {
    const stripped = String(query || '')
      .replace(TOKENS[field], ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!from) return stripped;
    const prefix = field === 'archived' ? 'archived-' : '';
    return `${stripped} ${prefix}after:${from} ${prefix}before:${to}`.trim();
  }
  const hasRange = (query, field) => new RegExp(TOKENS[field].source).test(String(query || ''));

  function label(bucket, unit) {
    const date = new Date(`${bucket.from}T12:00:00`);
    if (unit === 'year') return String(date.getFullYear());
    if (unit === 'month') return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    if (unit === 'week') return `Week of ${date.toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
    return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  function mount() {
    const filters = $('#page-library .lib-filters');
    if (!filters) return null;
    let box = $('#xkTimeline');
    if (box) return box;
    box = document.createElement('section');
    box.id = 'xkTimeline';
    box.className = 'xk-timeline';
    box.setAttribute('aria-label', 'Timeline of matching posts');
    box.innerHTML = `<header><button type="button" class="quiet xk-toggle" data-xk="toggle" aria-expanded="false" aria-controls="xkBars">Timeline</button><span class="xk-summary" aria-live="polite"></span><span class="xk-tools"><label class="xk-field"><span class="xv-sr-only">Date</span><select data-xk="field" aria-label="Timeline date"><option value="posted">Posted</option><option value="archived">Archived</option></select></label><button type="button" class="quiet" data-xk="clear" hidden>All dates</button></span></header><div class="xk-bars" id="xkBars" role="group" aria-label="Posts per period — drag across bars to choose a range"></div>`;
    filters.after(box);
    box.addEventListener('click', onClick);
    box.querySelector('[data-xk="field"]').addEventListener('change', event => {
      state.field = event.target.value === 'archived' ? 'archived' : 'posted';
      write(FIELD_KEY, state.field);
      refresh(true);
    });
    const bars = box.querySelector('.xk-bars');
    bars.addEventListener('pointerdown', onPointerDown);
    bars.addEventListener('keydown', onKey);
    return box;
  }

  function paint() {
    const box = mount();
    if (!box) return;
    const toggle = box.querySelector('[data-xk="toggle"]');
    toggle.setAttribute('aria-expanded', String(state.open));
    box.classList.toggle('is-open', state.open);
    box.querySelector('[data-xk="field"]').value = state.field;
    const query = $('#search')?.value || '';
    box.querySelector('[data-xk="clear"]').hidden = !hasRange(query, state.field);
    const bars = box.querySelector('.xk-bars'),
      summary = box.querySelector('.xk-summary'),
      data = state.data;
    bars.hidden = !state.open;
    if (!state.open) {
      summary.textContent = '';
      return;
    }
    if (!data) {
      summary.textContent = 'Counting…';
      bars.innerHTML = '';
      return;
    }
    if (data.unsupported || data.invalid || !data.buckets?.length) {
      summary.textContent = data.unsupported || (data.invalid ? '' : 'No dated posts match');
      bars.innerHTML = '';
      return;
    }
    const peak = Math.max(1, ...data.buckets.map(bucket => bucket.count));
    const first = data.buckets[0],
      last = data.buckets.at(-1);
    summary.textContent = `${n(data.matched)} posts · ${label(first, data.unit)} – ${label(last, data.unit)}${data.truncated ? ' · first 400,000 scanned' : ''}`;
    bars.innerHTML = data.buckets
      .map(
        (bucket, index) =>
          `<button type="button" class="xk-bar${bucket.count ? '' : ' is-empty'}" data-index="${index}" style="--h:${bucket.count ? Math.max(6, Math.round((bucket.count / peak) * 100)) : 2}%" aria-label="${html(label(bucket, data.unit))}: ${n(bucket.count)} posts" title="${html(label(bucket, data.unit))}: ${n(bucket.count)} posts"${index ? ' tabindex="-1"' : ''}><i></i></button>`
      )
      .join('');
  }

  async function refresh(force = false) {
    const query = $('#search')?.value || '';
    // renderLib fires often; repaint only for a new search, a forced refresh, or stale (30 s) counts —
    // the service worker caches per archive revision, so a stale re-ask is cheap.
    if (!force && query === state.query && state.data && Date.now() - state.at < 30000) return;
    state.query = query;
    state.at = Date.now();
    if (!state.open) return paint();
    const mine = ++serial;
    state.data = null;
    paint();
    const data = await call({ type: 'LIBRARY_TIMELINE', query, field: state.field }).catch(error => ({
      ok: false,
      unsupported: error?.message || String(error),
    }));
    if (mine !== serial) return;
    state.data = data?.ok === false ? { unsupported: data.error || data.unsupported || 'Timeline unavailable' } : data;
    paint();
  }
  let pending = null;
  const schedule = () => {
    const query = $('#search')?.value || '';
    if (pending === query) return; // already waiting for this search; do not keep pushing it back
    pending = query;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = null;
      refresh();
    }, 350);
  };

  function apply(fromIndex, toIndex) {
    const buckets = state.data?.buckets || [];
    const low = Math.min(fromIndex, toIndex),
      high = Math.max(fromIndex, toIndex);
    if (!buckets[low] || !buckets[high]) return;
    const query = withRange($('#search')?.value || '', state.field, buckets[low].from, buckets[high].to);
    window.XVaultLibraryRunQuery?.(query);
  }
  function onClick(event) {
    const button = event.target.closest('[data-xk]');
    if (!button) return;
    if (button.dataset.xk === 'toggle') {
      state.open = !state.open;
      write(OPEN_KEY, state.open ? '1' : '0');
      return state.open ? refresh(true) : paint();
    }
    if (button.dataset.xk === 'clear')
      window.XVaultLibraryRunQuery?.(withRange($('#search')?.value || '', state.field));
  }
  // Brush: press on a bar, drag across others, release to search that range. A plain click is a 1-bar range.
  function onPointerDown(event) {
    const start = event.target.closest('.xk-bar');
    if (!start || event.button !== 0) return;
    event.preventDefault();
    const bars = [...document.querySelectorAll('#xkBars .xk-bar')],
      from = Number(start.dataset.index);
    let to = from;
    const mark = () =>
      bars.forEach((bar, index) =>
        bar.classList.toggle('is-brushed', index >= Math.min(from, to) && index <= Math.max(from, to))
      );
    mark();
    const move = moveEvent => {
      const over = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.('#xkBars .xk-bar');
      if (over) {
        to = Number(over.dataset.index);
        mark();
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      apply(from, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }
  // Keyboard: arrows move between bars (roving tabindex), Enter/Space searches that bar.
  function onKey(event) {
    const bar = event.target.closest('.xk-bar');
    if (!bar) return;
    const bars = [...document.querySelectorAll('#xkBars .xk-bar')],
      index = Number(bar.dataset.index);
    const go = next => {
      const target = bars[Math.max(0, Math.min(bars.length - 1, next))];
      if (!target) return;
      bars.forEach(item => item.setAttribute('tabindex', '-1'));
      target.setAttribute('tabindex', '0');
      target.focus();
    };
    if (event.key === 'ArrowRight') return (event.preventDefault(), go(index + 1));
    if (event.key === 'ArrowLeft') return (event.preventDefault(), go(index - 1));
    if (event.key === 'Home') return (event.preventDefault(), go(0));
    if (event.key === 'End') return (event.preventDefault(), go(bars.length - 1));
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      apply(index, index);
    }
  }

  // Results events fire only for non-empty searches with hits; renderLib covers "all posts" and no results.
  window.addEventListener('xvault:results', schedule);
  window.addEventListener('xvault:no-results', schedule);
  hooks?.after('renderLib', schedule);
  hooks?.after('page', (result, name) => {
    if (name !== 'library') return;
    mount();
    schedule();
  });
  hooks?.commands(() => [
    {
      name: 'Library timeline',
      hint: 'posts per month for the current search; drag to filter by date',
      run: () => {
        if (typeof page === 'function') page('library');
        state.open = true;
        write(OPEN_KEY, '1');
        refresh(true).then(() => $('#xkBars .xk-bar')?.focus());
      },
    },
  ]);
  window.XVaultTimeline = { withRange, refresh };
})();
