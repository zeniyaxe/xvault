/* Library 3.0 (XVault 20) — organisation tools layered on the Library through public hooks:
   undo center, bulk editor, select-by, boards, context menu, search by image, meaning search and
   auto-tag rules. Every change goes through the service worker, and every bulk change can be undone
   (Ctrl+Z or the Undo button) from userMeta snapshots taken before the write. */
(() => {
  const $ = selector => document.querySelector(selector),
    $$ = selector => [...document.querySelectorAll(selector)];
  const html = value => esc(value);
  const count = (n, word, many = `${word}s`) => `${fmt(n)} ${n === 1 ? word : many}`;
  const ask = message => call(message).catch(error => ({ ok: false, error: error?.message || String(error) }));
  const boards = () => (Array.isArray(settings.boards) ? settings.boards : []);
  const rules = () => (Array.isArray(settings.autoTagRules) ? settings.autoTagRules : []);
  const selection = () => window.XVaultLibrarySelection?.() || [];
  const loadedRows = () => window.XVaultLibraryResultRows?.() || window.XVaultLibraryRows?.() || [];
  const refreshLibrary = () => {
    window.XVaultInvalidateLibraryCache?.();
    if ($('#page-library')?.classList.contains('show')) renderLib();
  };
  const LABELS = [
    ['none', 'No color'],
    ['red', 'Red'],
    ['amber', 'Amber'],
    ['green', 'Green'],
    ['blue', 'Blue'],
    ['violet', 'Violet'],
  ];
  const splitTags = value =>
    [
      ...new Set(
        String(value || '')
          .split(/[,\n]/)
          .map(tag => tag.trim().replace(/^#/, '').trim())
          .filter(Boolean)
      ),
    ].slice(0, 50);
  function dialogShell(id, title, { wide = false } = {}) {
    let dialog = document.getElementById(id);
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = id;
    dialog.className = `xv-sheet xv-l3-dialog${wide ? ' is-wide' : ''}`;
    dialog.setAttribute('aria-labelledby', `${id}Title`);
    dialog.innerHTML = `<header><h2 id="${id}Title">${html(title)}</h2><button type="button" class="quiet" data-close aria-label="Close">✕</button></header><div class="xv-l3-body"></div>`;
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-close]') || event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
    return dialog;
  }
  const openDialog = dialog => {
    if (!dialog.open) dialog.showModal();
    window.XVaultMotion?.enter?.(dialog, 'rise', { duration: 200 });
  };

  // ───────────────────────── Undo center ─────────────────────────
  const undoStack = [];
  function undoToast(entry) {
    let node = $('#xvUndoToast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'xvUndoToast';
      node.className = 'xv-undo-toast';
      node.setAttribute('role', 'status');
      document.body.append(node);
    }
    node.innerHTML = `<span>${html(entry.label)}</span><button type="button" data-undo>Undo</button><kbd>Ctrl Z</kbd>`;
    node.querySelector('[data-undo]').onclick = () => undo();
    node.classList.remove('show');
    void node.offsetWidth;
    node.classList.add('show');
    clearTimeout(node._timer);
    node._timer = setTimeout(() => node.classList.remove('show'), 7000);
  }
  async function restoreEntries(entries) {
    for (let start = 0; start < entries.length; start += 1000) {
      const result = await call({ type: 'RESTORE_TWEET_META', entries: entries.slice(start, start + 1000) });
      if (!result?.ok) throw Error(result?.error || 'Undo failed');
    }
  }
  async function undo() {
    const entry = undoStack.pop();
    $('#xvUndoToast')?.classList.remove('show');
    if (!entry) return toast('Nothing to undo');
    try {
      if (entry.entries?.length) await restoreEntries(entry.entries);
      if (entry.undo) await entry.undo();
      refreshLibrary();
      renderBoards();
      toast(`Undone · ${entry.label}`);
    } catch (error) {
      undoStack.push(entry);
      toast(`Undo failed: ${error.message}`);
    }
  }
  window.XVaultUndo = {
    push(entry) {
      if (!entry || (!entry.entries?.length && typeof entry.undo !== 'function')) return;
      undoStack.push({ ...entry, at: Date.now() });
      if (undoStack.length > 40) undoStack.shift();
      undoToast(entry);
    },
    undo,
    size: () => undoStack.length,
    list: () => undoStack.map(({ label, at }) => ({ label, at })).reverse(),
  };
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return;
    if (event.target.closest?.('input,textarea,select,[contenteditable]')) return;
    if (undoStack.length) {
      event.preventDefault();
      undo();
    } else {
      const trashUndo = $('#libraryUndoTrash');
      if (trashUndo && !trashUndo.hidden && !trashUndo.disabled) {
        event.preventDefault();
        trashUndo.click();
      }
    }
  });

  // ───────────────────────── Bulk editor ─────────────────────────
  function tagUniverse() {
    const tags = new Map();
    for (const post of window.XVaultLibraryRows?.() || [])
      for (const tag of post.userMeta?.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
    return [...tags].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  }
  function tri(name, legend, options) {
    return `<fieldset class="xv-field"><legend>${legend}</legend><div class="xv-tri">${options
      .map(
        ([value, label], index) =>
          `<label><input type="radio" name="${name}" value="${value}" ${index === 0 ? 'checked' : ''}><span>${label}</span></label>`
      )
      .join('')}</div></fieldset>`;
  }
  function boardChecks(name) {
    const list = boards();
    if (!list.length) return '<p class="xv-l3-hint">No boards yet — create one from the Boards section.</p>';
    return `<div class="xv-board-checks">${list
      .map(
        board =>
          `<label><input type="checkbox" name="${name}" value="${html(board.id)}"><i style="--board:${html(board.color || 'var(--accent)')}"></i>${html(board.name)}</label>`
      )
      .join('')}</div>`;
  }
  function openBulkEditor(ids = selection()) {
    if (!ids.length) return toast('Select posts first — press x on a post or Shift-click a range');
    const dialog = dialogShell('xvBulkEditor', 'Edit posts', { wide: true });
    dialog.dataset.ids = JSON.stringify(ids.slice(0, 5000));
    dialog.querySelector('h2').textContent = `Edit ${count(ids.length, 'post')}`;
    const tagOptions = tagUniverse()
      .slice(0, 300)
      .map(tag => `<option value="${html(tag)}"></option>`)
      .join('');
    dialog.querySelector('.xv-l3-body').innerHTML = `<form class="xv-bulk-form" novalidate>
<datalist id="xvBulkTags">${tagOptions}</datalist>
<div class="xv-l3-grid">
  <label class="xv-field"><span>Add tags</span><input name="addTags" list="xvBulkTags" placeholder="travel, inspo" autocomplete="off"></label>
  <label class="xv-field"><span>Remove tags</span><input name="removeTags" list="xvBulkTags" placeholder="old-tag" autocomplete="off"></label>
  ${tri('favorite', 'Favorite', [
    ['', 'Keep'],
    ['on', 'Add'],
    ['off', 'Remove'],
  ])}
  ${tri('later', 'Read later', [
    ['', 'Keep'],
    ['on', 'Add'],
    ['off', 'Remove'],
  ])}
  ${tri('read', 'Read state', [
    ['', 'Keep'],
    ['on', 'Read'],
    ['off', 'Unread'],
  ])}
  <label class="xv-field"><span>Color label</span><select name="color"><option value="">Keep</option>${LABELS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
  <div class="xv-field is-wide"><span>Add to boards</span>${boardChecks('addBoards')}</div>
  <div class="xv-field is-wide"><span>Remove from boards</span>${boardChecks('removeBoards')}</div>
  <label class="xv-field is-wide"><span>Append to note</span><textarea name="noteAppend" rows="2" maxlength="20000" placeholder="Added below any existing note"></textarea></label>
</div>
<p class="xv-l3-summary" aria-live="polite"></p>
<footer><button type="button" class="quiet" data-close>Cancel</button><button type="submit" class="primary">Apply</button></footer>
</form>`;
    const form = dialog.querySelector('form');
    const summarize = () => {
      const patch = bulkPatch(form),
        changes = Object.keys(patch).length;
      form.querySelector('.xv-l3-summary').textContent = changes
        ? `${count(changes, 'change')} · ${count(ids.length, 'post')} · Undo stays available`
        : 'Choose what to change';
      form.querySelector('[type=submit]').disabled = !changes;
      form.querySelector('[type=submit]').textContent = `Apply to ${count(ids.length, 'post')}`;
    };
    form.addEventListener('input', summarize);
    form.addEventListener('change', summarize);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const patch = bulkPatch(form);
      if (!Object.keys(patch).length) return;
      dialog.close();
      await window.XVaultLibraryBulkMeta(patch, 'Edited', ids);
      renderBoards();
    });
    summarize();
    openDialog(dialog);
    form.querySelector('[name=addTags]').focus();
  }
  function bulkPatch(form) {
    const data = new FormData(form),
      patch = {};
    const addTags = splitTags(data.get('addTags')),
      removeTags = splitTags(data.get('removeTags'));
    if (addTags.length) patch.addTags = addTags;
    if (removeTags.length) patch.removeTags = removeTags;
    for (const [field, key] of [
      ['favorite', 'favorite'],
      ['later', 'readLater'],
      ['read', 'read'],
    ])
      if (data.get(field)) patch[key] = data.get(field) === 'on';
    if (data.get('color')) patch.colorLabel = data.get('color');
    const addBoards = data.getAll('addBoards').map(String),
      removeBoards = data.getAll('removeBoards').map(String);
    if (addBoards.length) patch.addBoards = addBoards;
    if (removeBoards.length) patch.removeBoards = removeBoards;
    const note = String(data.get('noteAppend') || '').trim();
    if (note) patch.noteAppend = note;
    return patch;
  }

  // ───────────────────────── Select by ─────────────────────────
  const dayOf = value => {
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) ? date.toDateString() : '';
  };
  const SELECTORS = {
    author: { label: 'Same authors as the selection', test: (post, seed) => seed.authors.has(handleOf(post)) },
    day: { label: 'Posted on the same days', test: (post, seed) => seed.days.has(dayOf(post.createdAt)) },
    media: { label: 'Posts with media', test: post => (post.media || []).length > 0 },
    video: { label: 'Posts with video', test: post => (post.media || []).some(item => item.type === 'video') },
    text: { label: 'Text-only posts', test: post => !(post.media || []).length },
    untagged: { label: 'Untagged posts', test: post => !(post.userMeta?.tags || []).length },
    favorite: { label: 'Favorites', test: post => !!post.userMeta?.favorite },
    later: { label: 'In Read later', test: post => !!post.userMeta?.readLater && !post.userMeta?.readAt },
  };
  const handleOf = post =>
    String(post.author?.handle || '')
      .replace(/^@/, '')
      .toLowerCase();
  function selectBy(kind, { add = false } = {}) {
    const rows = loadedRows(),
      chosen = new Set(selection()),
      rule = SELECTORS[kind];
    if (!rule || !rows.length) return toast('Load some results first');
    const picked = rows.filter(post => chosen.has(String(post.id)));
    const seed = { authors: new Set(picked.map(handleOf)), days: new Set(picked.map(post => dayOf(post.createdAt))) };
    if ((kind === 'author' || kind === 'day') && !picked.length)
      return toast('Select at least one post to match against');
    const matches = rows.filter(post => rule.test(post, seed)).map(post => String(post.id));
    const next = add ? [...new Set([...chosen, ...matches])] : matches;
    const size = window.XVaultLibrarySetSelection?.(next) || 0;
    toast(`${count(size, 'post')} selected · ${rule.label.toLowerCase()}`);
  }
  function decorateBulkBar() {
    const bar = $('#libraryBulk');
    if (!bar || bar.querySelector('[data-l3]')) return;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.dataset.l3 = 'edit';
    edit.id = 'libraryBulkEdit';
    edit.title = 'Edit tags, boards, read later and more for the selection (e)';
    edit.textContent = 'Edit…';
    edit.onclick = () => openBulkEditor();
    const board = document.createElement('button');
    board.type = 'button';
    board.dataset.l3 = 'board';
    board.id = 'libraryBulkBoard';
    board.title = 'Add the selection to a board (b)';
    board.textContent = 'Board…';
    board.onclick = () => openBoardPicker(selection(), board);
    const later = document.createElement('button');
    later.type = 'button';
    later.dataset.l3 = 'later';
    later.id = 'libraryBulkLater';
    later.title = 'Save the selection for later';
    later.textContent = 'Read later';
    later.onclick = () => window.XVaultLibraryBulkMeta({ readLater: true, read: false }, 'Saved for later');
    bar.querySelector('#libraryBulkFav')?.before(edit);
    bar.querySelector('#libraryBulkTag')?.closest('.bar-field')?.after(board, later);
    const menu = bar.querySelector('.bar-more .menu-pop');
    if (menu) {
      const group = document.createElement('div');
      group.className = 'xv-select-by';
      group.innerHTML = `<hr><b>Select by</b>${Object.entries(SELECTORS)
        .map(([kind, rule]) => `<button type="button" data-select-by="${kind}">${html(rule.label)}</button>`)
        .join('')}`;
      group.addEventListener('click', event => {
        const button = event.target.closest('[data-select-by]');
        if (!button) return;
        selectBy(button.dataset.selectBy, { add: event.shiftKey });
        button.closest('details')?.removeAttribute('open');
      });
      menu.append(group);
    }
  }

  // ───────────────────────── Boards ─────────────────────────
  let boardStats = { counts: {}, covers: {}, later: 0, highlighted: 0 },
    statsTimer = 0;
  async function loadBoardStats() {
    const result = await ask({ type: 'BOARD_COUNTS' });
    if (result?.ok) boardStats = result;
    paintBoards();
  }
  function renderBoards() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(loadBoardStats, 250);
    paintBoards();
  }
  function ensureBoardSection() {
    const root = $('#libraryDestinations');
    if (!root) return null;
    let section = root.querySelector('.xv-boards');
    if (!section) {
      section = document.createElement('section');
      section.className = 'facet xv-boards';
      section.setAttribute('aria-labelledby', 'facetBoardsTitle');
      section.innerHTML = `<header class="facet-heading"><h3 id="facetBoardsTitle">Boards</h3><div><button type="button" class="quiet" data-board-new title="Create a board">New</button><button type="button" class="quiet" data-board-manage title="Rename, reorder, pin or delete boards">Manage</button></div></header><div id="facetBoards" role="list"></div>`;
      const anchor = root.querySelector('[aria-labelledby="facetAuthorsTitle"]');
      if (anchor) anchor.before(section);
      else root.append(section);
      section.addEventListener('click', event => {
        if (event.target.closest('[data-board-new]')) return createBoardFlow();
        if (event.target.closest('[data-board-manage]')) return openBoardManager();
        const open = event.target.closest('[data-board-open]');
        if (open) window.XVaultLibraryRunQuery?.(`board:${open.dataset.boardOpen}`);
      });
      section.addEventListener('dragover', event => {
        const target = event.target.closest('[data-board-open]');
        if (!target || !event.dataTransfer.types.includes('application/x-xvault-posts')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        target.classList.add('is-drop');
      });
      section.addEventListener('dragleave', event =>
        event.target.closest('[data-board-open]')?.classList.remove('is-drop')
      );
      section.addEventListener('drop', async event => {
        const target = event.target.closest('[data-board-open]');
        if (!target) return;
        event.preventDefault();
        target.classList.remove('is-drop');
        let ids = [];
        try {
          ids = JSON.parse(event.dataTransfer.getData('application/x-xvault-posts') || '[]');
        } catch {}
        if (!ids.length) return;
        const board = boards().find(item => item.id === target.dataset.boardOpen);
        await window.XVaultLibraryBulkMeta(
          { addBoards: [target.dataset.boardOpen] },
          `Added to ${board?.name || 'board'}`,
          ids
        );
        renderBoards();
      });
    }
    return section;
  }
  function paintBoards() {
    const section = ensureBoardSection();
    if (!section) return;
    const list = section.querySelector('#facetBoards'),
      query = ($('#search')?.value || '').trim();
    if (!boards().length) {
      // A hint is not a list item: drop the list role while the section is empty.
      list.removeAttribute('role');
      list.innerHTML =
        '<p class="facet-hint">Group posts into boards — drag posts here or use Board… on a selection.</p>';
      return;
    }
    list.setAttribute('role', 'list');
    list.innerHTML = boards()
      .map(board => {
        const active = query === `board:${board.id}`;
        return `<button type="button" role="listitem" class="facet-item xv-board-item${active ? ' active' : ''}" data-board-open="${html(board.id)}" ${active ? 'aria-current="page"' : ''} title="${html(board.description || `Open ${board.name}`)}"><i class="xv-board-dot" style="--board:${html(board.color || 'var(--accent)')}">${html(board.icon || '')}</i><span>${html(board.name)}${board.pinned ? ' <small aria-label="pinned">•</small>' : ''}</span><em class="count">${boardStats.counts[board.id] ? fmt(boardStats.counts[board.id]) : ''}</em></button>`;
      })
      .join('');
  }
  function newBoardId(name) {
    const taken = new Set(boards().map(board => board.id));
    let base =
        String(name)
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'board',
      id = base,
      n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }
  async function createBoard(name, extra = {}) {
    const clean = String(name || '')
      .trim()
      .slice(0, 80);
    if (!clean) return null;
    const board = { id: newBoardId(clean), name: clean, order: boards().length, createdAt: Date.now(), ...extra };
    await save({ boards: [...boards(), board] }, false);
    paintBoards();
    return board;
  }
  async function createBoardFlow() {
    const name = prompt('Name the new board', '');
    if (!name?.trim()) return;
    const board = await createBoard(name);
    if (!board) return;
    const ids = selection();
    if (ids.length && confirm(`Add the ${count(ids.length, 'selected post')} to “${board.name}”?`))
      await window.XVaultLibraryBulkMeta({ addBoards: [board.id] }, `Added to ${board.name}`, ids);
    toast(`Board “${board.name}” created`);
    renderBoards();
  }
  function openBoardPicker(ids, anchor) {
    if (!ids.length) return toast('Select posts first');
    const dialog = dialogShell('xvBoardPicker', 'Add to board');
    dialog.classList.add('is-compact');
    const rows = new Map(loadedRows().map(post => [String(post.id), post]));
    const state = id => {
      const members = ids.filter(postId => (rows.get(postId)?.userMeta?.boards || []).includes(id)).length;
      return members === 0 ? 'false' : members === ids.length ? 'true' : 'mixed';
    };
    dialog.querySelector('h2').textContent = `Boards for ${count(ids.length, 'post')}`;
    dialog.querySelector('.xv-l3-body').innerHTML = `<div class="xv-picker-list" role="group" aria-label="Boards">${
      boards()
        .map(
          board =>
            `<button type="button" role="checkbox" aria-checked="${state(board.id)}" data-pick-board="${html(board.id)}"><i class="xv-board-dot" style="--board:${html(board.color || 'var(--accent)')}"></i><span>${html(board.name)}</span><em>${boardStats.counts[board.id] ? fmt(boardStats.counts[board.id]) : ''}</em></button>`
        )
        .join('') || '<p class="xv-l3-hint">No boards yet.</p>'
    }</div><form class="xv-picker-new"><input name="name" maxlength="80" placeholder="New board name" aria-label="New board name"><button type="submit">Create &amp; add</button></form>`;
    dialog.querySelector('.xv-picker-list').onclick = async event => {
      const button = event.target.closest('[data-pick-board]');
      if (!button) return;
      const id = button.dataset.pickBoard,
        board = boards().find(item => item.id === id),
        adding = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', adding ? 'true' : 'false');
      await window.XVaultLibraryBulkMeta(
        adding ? { addBoards: [id] } : { removeBoards: [id] },
        `${adding ? 'Added to' : 'Removed from'} ${board?.name || 'board'}`,
        ids
      );
      renderBoards();
    };
    dialog.querySelector('.xv-picker-new').onsubmit = async event => {
      event.preventDefault();
      const board = await createBoard(new FormData(event.target).get('name'));
      if (!board) return;
      dialog.close();
      await window.XVaultLibraryBulkMeta({ addBoards: [board.id] }, `Added to ${board.name}`, ids);
      renderBoards();
    };
    openDialog(dialog);
    (dialog.querySelector('[data-pick-board]') || dialog.querySelector('input'))?.focus();
    dialog.addEventListener('close', () => anchor?.isConnected && anchor.focus(), { once: true });
  }
  function openBoardManager() {
    const dialog = dialogShell('xvBoards', 'Boards', { wide: true });
    let draft = boards().map(board => ({ ...board }));
    const paint = () => {
      dialog.querySelector('.xv-l3-body').innerHTML =
        `<p class="xv-l3-hint">Drag rows (or use ↑ ↓) to reorder. Pinned boards stay on top. Board membership lives on each post, so exports and backups keep it.</p>
<ol class="xv-board-rows">${
          draft
            .map(
              (
                board,
                index
              ) => `<li draggable="true" data-row="${index}"><span class="xv-grip" aria-hidden="true">⠿</span>
<input class="xv-board-name" data-field="name" value="${html(board.name)}" maxlength="80" aria-label="Board name">
<input data-field="description" value="${html(board.description || '')}" maxlength="400" placeholder="Description" aria-label="Description for ${html(board.name)}">
<input type="color" data-field="color" value="${html(board.color || '#7c8cff')}" aria-label="Color for ${html(board.name)}">
<label class="xv-pin"><input type="checkbox" data-field="pinned" ${board.pinned ? 'checked' : ''}> Pin</label>
<button type="button" class="quiet" data-move="-1" aria-label="Move ${html(board.name)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
<button type="button" class="quiet" data-move="1" aria-label="Move ${html(board.name)} down" ${index === draft.length - 1 ? 'disabled' : ''}>↓</button>
<button type="button" class="quiet" data-cover title="Use the first selected post as the cover">Cover</button>
<button type="button" class="quiet danger" data-delete aria-label="Delete ${html(board.name)}">Delete</button>
<em>${boardStats.counts[board.id] ? count(boardStats.counts[board.id], 'post') : 'empty'}</em></li>`
            )
            .join('') || '<li class="xv-l3-hint">No boards yet.</li>'
        }</ol>
<form class="xv-picker-new" data-new-board><input name="name" maxlength="80" placeholder="New board name" aria-label="New board name"><button type="submit">Add board</button></form>
<footer><button type="button" class="quiet" data-close>Close</button><button type="button" class="primary" data-save-boards>Save changes</button></footer>`;
    };
    paint();
    const body = dialog.querySelector('.xv-l3-body');
    body.oninput = event => {
      const row = event.target.closest('[data-row]'),
        field = event.target.dataset.field;
      if (!row || !field) return;
      draft[Number(row.dataset.row)][field] =
        event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    };
    body.onclick = async event => {
      const row = event.target.closest('[data-row]'),
        index = Number(row?.dataset.row);
      if (event.target.closest('[data-move]') && row) {
        const to = index + Number(event.target.closest('[data-move]').dataset.move);
        [draft[index], draft[to]] = [draft[to], draft[index]];
        paint();
        body
          .querySelector(`[data-row="${to}"] [data-move="${event.target.closest('[data-move]').dataset.move}"]`)
          ?.focus();
        return;
      }
      if (event.target.closest('[data-cover]') && row) {
        const first = selection()[0];
        if (!first) return toast('Select a post in the Library to use as the cover');
        draft[index].cover = first;
        return toast('Cover set — save to keep it');
      }
      if (event.target.closest('[data-delete]') && row) {
        const board = draft[index];
        if (!confirm(`Delete “${board.name}”? Posts stay in the archive; only the board is removed.`)) return;
        const result = await ask({ type: 'BOARD_DELETE', id: board.id });
        if (!result?.ok) return toast(result?.error || 'The board could not be deleted');
        draft.splice(index, 1);
        paint();
        window.XVaultUndo.push({
          label: `Deleted board ${board.name}`,
          entries: result.previous || [],
          undo: async () => save({ boards: [...boards(), result.board || board] }, false),
        });
        renderBoards();
        if (($('#search')?.value || '').trim() === `board:${board.id}`) window.XVaultLibraryRunQuery?.('');
        return;
      }
      if (event.target.closest('[data-save-boards]')) {
        await save({ boards: draft.map((board, order) => ({ ...board, order })) }, false);
        toast('Boards saved');
        dialog.close();
        renderBoards();
      }
    };
    body.addEventListener('submit', async event => {
      if (!event.target.matches('[data-new-board]')) return;
      event.preventDefault();
      const name = String(new FormData(event.target).get('name') || '').trim();
      if (!name) return;
      const taken = new Set(draft.map(board => board.id));
      let id = newBoardId(name);
      while (taken.has(id)) id += '-x';
      draft.push({ id, name, order: draft.length, createdAt: Date.now() });
      paint();
      body.querySelector('[data-new-board] input')?.focus();
    });
    let dragging = -1;
    body.addEventListener('dragstart', event => {
      const row = event.target.closest('[data-row]');
      if (!row) return;
      dragging = Number(row.dataset.row);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(dragging));
      row.classList.add('is-dragging');
    });
    body.addEventListener('dragover', event => {
      if (dragging < 0 || !event.target.closest('[data-row]')) return;
      event.preventDefault();
    });
    body.addEventListener('drop', event => {
      const row = event.target.closest('[data-row]');
      if (dragging < 0 || !row) return;
      event.preventDefault();
      const to = Number(row.dataset.row),
        [moved] = draft.splice(dragging, 1);
      draft.splice(to, 0, moved);
      dragging = -1;
      paint();
    });
    body.addEventListener('dragend', () => (dragging = -1));
    openDialog(dialog);
    loadBoardStats();
  }
  // Banner above results when a board is open: cover, description, count and board actions.
  function paintBoardBanner() {
    const query = ($('#search')?.value || '').trim(),
      match = query.match(/^board:([a-z0-9-]{1,64})$/i),
      board = match && boards().find(item => item.id === match[1]);
    let banner = $('#xvBoardBanner');
    if (!board) return banner?.remove();
    if (!banner) {
      banner = document.createElement('section');
      banner.id = 'xvBoardBanner';
      banner.className = 'xv-board-banner';
      $('#list')?.before(banner);
      banner.addEventListener('click', event => {
        const act = event.target.closest('[data-banner]')?.dataset.banner;
        if (act === 'manage') openBoardManager();
        if (act === 'export') window.XVaultOpenLinkExport?.('all');
        if (act === 'remove') {
          const ids = selection();
          if (!ids.length) return toast('Select posts to remove from this board');
          window
            .XVaultLibraryBulkMeta({ removeBoards: [banner.dataset.board] }, 'Removed from board', ids)
            .then(renderBoards);
        }
      });
    }
    banner.dataset.board = board.id;
    const coverId = board.cover || boardStats.covers[board.id],
      coverPost =
        loadedRows().find(post => String(post.id) === String(coverId)) || loadedRows().find(post => post.media?.length),
      cover = coverPost?.media?.[0]?.preview || (coverPost?.media?.[0]?.type === 'photo' ? coverPost.media[0].url : '');
    banner.style.setProperty('--board', board.color || 'var(--accent)');
    banner.innerHTML = `<div class="xv-board-cover">${cover ? `<img src="${html(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span aria-hidden="true">${html(board.icon || board.name.slice(0, 1).toUpperCase())}</span>`}</div><div class="xv-board-copy"><small>Board</small><h2>${html(board.name)}</h2>${board.description ? `<p>${html(board.description)}</p>` : ''}<span>${boardStats.counts[board.id] != null ? count(boardStats.counts[board.id] || 0, 'post') : ''}</span></div><div class="xv-board-actions"><button type="button" class="quiet" data-banner="remove" title="Remove selected posts from this board">Remove selected</button><button type="button" class="quiet" data-banner="export">Export</button><button type="button" data-banner="manage">Edit board</button></div>`;
  }

  // ───────────────────────── Cards: drag, badges, context menu ─────────────────────────
  function decorateCards() {
    for (const card of $$('#list .tweet')) {
      const handle = card.querySelector('.who, .xv-record-thumb, .xv-td-thumb');
      if (handle && !handle.draggable) {
        handle.draggable = true;
        handle.title ||= 'Drag onto a board';
      }
    }
  }
  document.addEventListener('dragstart', event => {
    const card = event.target.closest?.('#list .tweet');
    if (!card || !event.target.closest('.who, .xv-record-thumb, .xv-td-thumb')) return;
    const chosen = selection(),
      ids = chosen.includes(card.dataset.id) ? chosen : [card.dataset.id];
    event.dataTransfer.setData('application/x-xvault-posts', JSON.stringify(ids));
    event.dataTransfer.setData('text/plain', ids.map(id => `https://x.com/i/status/${id}`).join('\n'));
    event.dataTransfer.effectAllowed = 'copy';
    const ghost = document.createElement('div');
    ghost.className = 'xv-drag-ghost';
    ghost.textContent = ids.length === 1 ? '1 post' : `${fmt(ids.length)} posts`;
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
    for (const id of ids) cardFor(id)?.classList.add('is-dragging-source');
    $('#libraryDestinations')?.classList.add('is-dropping');
  });
  document.addEventListener('dragend', () => {
    $('#libraryDestinations')?.classList.remove('is-dropping');
    $$('#list .is-dragging-source').forEach(card => card.classList.remove('is-dragging-source'));
  });

  let menu = null,
    menuReturn = null;
  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (menuReturn?.isConnected) menuReturn.focus({ preventScroll: true });
    menuReturn = null;
  }
  function openMenu(card, x, y) {
    const id = card.dataset.id,
      post =
        loadedRows().find(row => String(row.id) === id) ||
        (window.XVaultLibraryRows?.() || []).find(row => String(row.id) === id);
    const meta = post?.userMeta || {},
      selected = selection().includes(id),
      hasMedia = !!post?.media?.length;
    menu ||= (() => {
      const node = document.createElement('div');
      node.id = 'xvContextMenu';
      node.className = 'xv-context-menu';
      node.setAttribute('role', 'menu');
      node.hidden = true;
      document.body.append(node);
      node.addEventListener('click', event => {
        const item = event.target.closest('[data-menu]');
        if (!item) return;
        const target = node.dataset.post;
        closeMenu();
        runMenu(item.dataset.menu, target);
      });
      node.addEventListener('keydown', event => {
        const items = [...node.querySelectorAll('[role=menuitem]')],
          at = items.indexOf(document.activeElement);
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          closeMenu();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
        }
      });
      document.addEventListener('pointerdown', event => !node.contains(event.target) && closeMenu(), true);
      addEventListener('blur', closeMenu);
      addEventListener('resize', closeMenu);
      return node;
    })();
    const item = (act, label, hint = '') =>
      `<button type="button" role="menuitem" tabindex="-1" data-menu="${act}"><span>${label}</span>${hint ? `<kbd>${hint}</kbd>` : ''}</button>`;
    menu.dataset.post = id;
    menu.innerHTML = [
      item('reader', 'Read thread', 't'),
      item('quicklook', 'Quick Look', 'Space'),
      item('details', 'Details'),
      '<hr>',
      item('favorite', meta.favorite ? 'Remove favorite' : 'Favorite', 'f'),
      item('later', meta.readLater && !meta.readAt ? 'Remove from Read later' : 'Read later', 'l'),
      item('board', 'Add to board…', 'b'),
      item('edit', 'Edit tags & more…', 'e'),
      '<hr>',
      item('similar', 'Find similar posts'),
      item('suggest', 'Suggest tags'),
      hasMedia ? item('image', 'Find look-alike images') : '',
      '<hr>',
      item('copy', 'Copy link'),
      item('x', 'Open on X'),
      item('select', selected ? 'Deselect' : 'Select', 'x'),
      item('trash', 'Move to Trash', 'Del'),
    ].join('');
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - box.width - 8, x))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - box.height - 8, y))}px`;
    menuReturn = card;
    menu.querySelector('[role=menuitem]')?.focus({ preventScroll: true });
  }
  function cardFor(id) {
    return $(`#list .tweet[data-id="${CSS.escape(String(id))}"]`);
  }
  async function toggleLater(ids) {
    const rows = new Map(loadedRows().map(post => [String(post.id), post])),
      on = ids.some(id => !(rows.get(id)?.userMeta?.readLater && !rows.get(id)?.userMeta?.readAt));
    await window.XVaultLibraryBulkMeta(
      on ? { readLater: true, read: false } : { readLater: false },
      on ? 'Saved for later' : 'Removed from Read later',
      ids
    );
  }
  async function runMenu(act, id) {
    const card = cardFor(id);
    if (act === 'reader') return window.XVaultReader?.open(id, { returnTo: card });
    if (act === 'quicklook') return window.XVaultOpenQuickLookById?.(id);
    if (act === 'details') return window.openDetails?.(id);
    if (act === 'favorite')
      return (
        card?.querySelector('[data-fav]')?.click() ??
        window.XVaultLibraryBulkMeta({ favorite: true }, 'Favorited', [id])
      );
    if (act === 'later') return toggleLater([id]);
    if (act === 'board') return openBoardPicker(selection().includes(id) ? selection() : [id], card);
    if (act === 'edit') return openBulkEditor(selection().includes(id) ? selection() : [id]);
    if (act === 'similar') return window.XVaultLibraryRunQuery?.(`similar:${id}`, 'relevance');
    if (act === 'suggest') return suggestFor(id);
    if (act === 'image') return imageSearch({ postId: id });
    if (act === 'copy') {
      const post = loadedRows().find(row => String(row.id) === id);
      return navigator.clipboard.writeText(post?.url || `https://x.com/i/status/${id}`).then(
        () => toast('Link copied'),
        () => toast('Clipboard unavailable')
      );
    }
    if (act === 'x') {
      const post = loadedRows().find(row => String(row.id) === id);
      return window.open(post?.url || `https://x.com/i/status/${id}`, '_blank', 'noopener');
    }
    if (act === 'select') return card?.querySelector('.xv-card-select input')?.click();
    if (act === 'trash') return window.XVaultLibraryTrash?.(selection().includes(id) ? selection() : [id]);
  }
  document.addEventListener('contextmenu', event => {
    const card = event.target.closest?.('#list .tweet');
    if (!card || event.shiftKey || event.target.closest('a,video,input,textarea')) return;
    event.preventDefault();
    openMenu(card, event.clientX, event.clientY);
  });
  document.addEventListener('keydown', event => {
    const card = event.target.closest?.('#list .tweet');
    if (
      !card ||
      event.target.closest('input,textarea,select,[contenteditable]') ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const box = card.getBoundingClientRect();
      openMenu(card, box.left + 24, box.top + 24);
      return;
    }
    const key = event.key.toLowerCase(),
      ids = selection().includes(card.dataset.id) ? selection() : [card.dataset.id];
    if (key === 'e') {
      event.preventDefault();
      openBulkEditor(ids);
    } else if (key === 'b') {
      event.preventDefault();
      openBoardPicker(ids, card);
    } else if (key === 'l') {
      event.preventDefault();
      toggleLater(ids);
    }
  });

  async function suggestFor(id) {
    const result = await ask({ type: 'SEMANTIC_SUGGEST_TAGS', id });
    const list = result?.suggestions || [];
    const dialog = dialogShell('xvSuggest', 'Suggested tags');
    dialog.classList.add('is-compact');
    dialog.querySelector('.xv-l3-body').innerHTML = list.length
      ? `<p class="xv-l3-hint">From the tags on the most similar posts in your vault.</p><div class="xv-chip-row">${list
          .map(
            item =>
              `<button type="button" class="chip" data-suggest="${html(item.tag)}">#${html(item.tag)} <small>${Math.round(item.confidence * 100)}%</small></button>`
          )
          .join('')}</div>`
      : `<p class="xv-l3-hint">${html(result?.ok === false ? result.error : 'No suggestions yet. Tag a few similar posts and XVault learns from them.')}</p>`;
    dialog.querySelector('.xv-l3-body').onclick = async event => {
      const chip = event.target.closest('[data-suggest]');
      if (!chip) return;
      chip.disabled = true;
      await window.XVaultLibraryBulkMeta({ addTags: [chip.dataset.suggest] }, `Tagged #${chip.dataset.suggest}`, [id]);
    };
    openDialog(dialog);
  }

  // ───────────────────────── Search by image ─────────────────────────
  let hashModule = null;
  async function imageSearch({ file = null, postId = null } = {}) {
    const dialog = dialogShell('xvImageResults', 'Search by image', { wide: true }),
      body = dialog.querySelector('.xv-l3-body');
    openDialog(dialog);
    body.innerHTML =
      '<div class="xv-l3-loading" aria-busy="true"><i class="xv-skeleton"></i><i class="xv-skeleton"></i><i class="xv-skeleton"></i></div>';
    let message;
    try {
      if (file) {
        hashModule ||= await import('./sw/image-hash.mjs');
        const prints = await hashModule.fingerprintBlob(file);
        message = { type: 'SEARCH_BY_IMAGE', ...prints, limit: 80 };
      } else {
        const post = loadedRows().find(row => String(row.id) === String(postId));
        const media = post?.media?.[0];
        message = { type: 'SEARCH_BY_IMAGE', key: `${postId}:${media?.id || 0}`, limit: 80 };
      }
    } catch (error) {
      body.innerHTML = `<p class="xv-l3-hint">That file could not be read as an image (${html(error.message)}).</p>`;
      return;
    }
    const result = await ask(message);
    if (!result?.ok) {
      body.innerHTML = `<p class="xv-l3-hint">${html(result?.error || 'Image search failed')}</p>`;
      return;
    }
    if (!result.fingerprinted) {
      body.innerHTML = `<p class="xv-l3-hint">Image search compares against look-alike fingerprints, and none exist yet.</p><button type="button" class="primary" data-start-phash>Fingerprint archived images</button>`;
      body.querySelector('[data-start-phash]').onclick = async () => {
        await ask({ type: 'DERIVED_JOB_START', kind: 'phash' });
        toast('Fingerprinting started — it runs in the background');
        dialog.close();
      };
      return;
    }
    const hits = (result.hits || []).filter(hit => !postId || hit.postId !== String(postId));
    const label = distance => (distance <= 2 ? 'Same image' : distance <= 7 ? 'Very close' : 'Similar');
    body.innerHTML = hits.length
      ? `<p class="xv-l3-hint">${count(hits.length, 'match', 'matches')} among ${count(result.fingerprinted, 'fingerprinted image')}. Fingerprints are local; nothing was uploaded.</p><div class="xv-image-hits">${hits
          .map(
            hit =>
              `<button type="button" data-hit="${html(hit.postId)}"><img src="${html(hit.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span>${label(hit.distance)}</span></button>`
          )
          .join(
            ''
          )}</div><footer><button type="button" class="primary" data-hits-library>Show in Library</button></footer>`
      : `<p class="xv-l3-hint">No look-alikes among ${count(result.fingerprinted, 'fingerprinted image')}.</p>`;
    body.onclick = event => {
      const hit = event.target.closest('[data-hit]');
      if (hit) return window.XVaultReader?.open(hit.dataset.hit, { returnTo: hit });
      if (event.target.closest('[data-hits-library]')) {
        const ids = [...new Set(hits.map(item => item.postId))].slice(0, 40);
        dialog.close();
        page('library');
        window.XVaultLibraryRunQuery?.(`id:${ids.join('|')}`);
      }
    };
  }
  function decorateSearch() {
    const clear = $('#clearSearch');
    if (!clear || $('#xvImageSearch')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'xvImageSearch';
    button.className = 'quiet';
    button.title = 'Search by image — choose, paste or drop a picture';
    button.setAttribute('aria-label', 'Search by image');
    button.innerHTML = window.XVaultIcons?.svg('imageSearch') || '⌕';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    input.id = 'xvImageSearchFile';
    button.onclick = () => input.click();
    input.onchange = () => input.files?.[0] && imageSearch({ file: input.files[0] }).finally(() => (input.value = ''));
    clear.after(button, input);
    const search = $('#search');
    search?.addEventListener('paste', event => {
      const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/'));
      if (!file) return;
      event.preventDefault();
      imageSearch({ file });
    });
    const box = search?.closest('.search, .lib-search, label, div');
    box?.addEventListener('dragover', event => {
      if ([...(event.dataTransfer?.items || [])].some(item => item.type.startsWith('image/'))) {
        event.preventDefault();
        box.classList.add('is-drop');
      }
    });
    box?.addEventListener('dragleave', () => box.classList.remove('is-drop'));
    box?.addEventListener('drop', event => {
      const file = [...(event.dataTransfer?.files || [])].find(item => item.type.startsWith('image/'));
      box.classList.remove('is-drop');
      if (!file) return;
      event.preventDefault();
      imageSearch({ file });
    });
  }

  // ───────────────────────── Auto-tag rules ─────────────────────────
  const actionSummary = rule =>
    [
      ...(rule.actions?.addTags || []).map(tag => `#${tag}`),
      rule.actions?.favorite ? '★ favorite' : '',
      rule.actions?.readLater ? 'read later' : '',
      ...(rule.actions?.addBoards || []).map(id => `▦ ${boards().find(board => board.id === id)?.name || id}`),
      rule.actions?.colorLabel && rule.actions.colorLabel !== 'none' ? `${rule.actions.colorLabel} label` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  function ruleFromForm(form) {
    const data = new FormData(form);
    return {
      id: form.dataset.ruleId || undefined,
      name: String(data.get('name') || '').trim(),
      query: String(data.get('query') || '').trim(),
      enabled: true,
      onCapture: data.get('onCapture') === 'on',
      actions: {
        addTags: splitTags(data.get('tags')),
        favorite: data.get('favorite') === 'on',
        readLater: data.get('later') === 'on',
        addBoards: data.getAll('boards').map(String),
        colorLabel: String(data.get('color') || ''),
      },
    };
  }
  function openRules(prefill = null) {
    const dialog = dialogShell('xvRules', 'Auto-tag rules', { wide: true }),
      body = dialog.querySelector('.xv-l3-body');
    const paint = (editing = prefill) => {
      body.innerHTML = `<p class="xv-l3-hint">Rules use Library search (<code>from:nasa has:video</code>, <code>about:cooking</code>) and only organise: tags, favorite, read later, boards and labels. New captures run through rules marked “on capture”; “Run now” applies a rule to the archive with Undo.</p>
<ul class="xv-rule-list">${
        rules()
          .map(
            rule =>
              `<li data-rule="${html(rule.id)}"><label class="xv-switch"><input type="checkbox" data-rule-toggle ${rule.enabled ? 'checked' : ''} aria-label="Enable ${html(rule.name)}"><span></span></label><div><b>${html(rule.name)}</b><code>${html(rule.query)}</code><small>${html(actionSummary(rule))}${rule.onCapture ? ' · on capture' : ''}${rule.lastRunAt ? ` · last run ${new Date(rule.lastRunAt).toLocaleDateString()} (${fmt(rule.lastMatched)} changed)` : ''}</small></div><div class="xv-rule-actions"><button type="button" class="quiet" data-rule-preview>Preview</button><button type="button" data-rule-run>Run now</button><button type="button" class="quiet" data-rule-edit>Edit</button><button type="button" class="quiet danger" data-rule-delete aria-label="Delete rule ${html(rule.name)}">Delete</button></div><output class="xv-rule-output" aria-live="polite"></output></li>`
          )
          .join('') || '<li class="xv-l3-hint">No rules yet.</li>'
      }</ul>
<form class="xv-rule-form" ${editing?.id ? `data-rule-id="${html(editing.id)}"` : ''}>
<h3>${editing?.id ? 'Edit rule' : 'New rule'}</h3>
<div class="xv-l3-grid">
<label class="xv-field"><span>Name</span><input name="name" maxlength="80" value="${html(editing?.name || '')}" placeholder="Space videos"></label>
<label class="xv-field is-wide"><span>When posts match</span><span class="xv-inline"><input name="query" maxlength="500" required value="${html(editing?.query || '')}" placeholder="from:nasa has:video"><button type="button" class="quiet" data-use-search>Use current search</button></span></label>
<label class="xv-field"><span>Add tags</span><input name="tags" value="${html((editing?.actions?.addTags || []).join(', '))}" placeholder="space, launches"></label>
<label class="xv-field"><span>Color label</span><select name="color"><option value="">None</option>${LABELS.slice(1)
        .map(
          ([value, label]) =>
            `<option value="${value}" ${editing?.actions?.colorLabel === value ? 'selected' : ''}>${label}</option>`
        )
        .join('')}</select></label>
<label class="xv-check"><input type="checkbox" name="favorite" ${editing?.actions?.favorite ? 'checked' : ''}> Favorite</label>
<label class="xv-check"><input type="checkbox" name="later" ${editing?.actions?.readLater ? 'checked' : ''}> Read later</label>
<label class="xv-check"><input type="checkbox" name="onCapture" ${editing ? (editing.onCapture !== false ? 'checked' : '') : 'checked'}> Run on new captures</label>
<div class="xv-field is-wide"><span>Add to boards</span>${
        boards().length
          ? `<div class="xv-board-checks">${boards()
              .map(
                board =>
                  `<label><input type="checkbox" name="boards" value="${html(board.id)}" ${(editing?.actions?.addBoards || []).includes(board.id) ? 'checked' : ''}><i style="--board:${html(board.color || 'var(--accent)')}"></i>${html(board.name)}</label>`
              )
              .join('')}</div>`
          : '<p class="xv-l3-hint">No boards yet.</p>'
      }</div>
</div>
<output class="xv-rule-output" aria-live="polite"></output>
<footer><button type="button" class="quiet" data-rule-test>Preview matches</button><button type="submit" class="primary">${editing?.id ? 'Save rule' : 'Add rule'}</button></footer>
</form>`;
    };
    paint();
    body.onclick = async event => {
      const row = event.target.closest('[data-rule]'),
        id = row?.dataset.rule,
        rule = rules().find(item => item.id === id),
        output = row?.querySelector('.xv-rule-output') || body.querySelector('.xv-rule-form .xv-rule-output');
      if (event.target.closest('[data-use-search]')) {
        body.querySelector('[name=query]').value = ($('#search')?.value || '').trim();
        return;
      }
      if (event.target.closest('[data-rule-test]')) {
        const draft = ruleFromForm(body.querySelector('.xv-rule-form'));
        output.textContent = 'Checking the archive…';
        const result = await ask({ type: 'RULES_PREVIEW', rule: draft });
        output.textContent = result?.ok
          ? `${count(result.changes, 'post')} would change (of ${fmt(result.scanned)} scanned)`
          : result?.error || 'Preview failed';
        return;
      }
      if (!rule) return;
      if (event.target.closest('[data-rule-preview]')) {
        output.textContent = 'Checking the archive…';
        const result = await ask({ type: 'RULES_PREVIEW', rule });
        output.textContent = result?.ok
          ? `${count(result.changes, 'post')} would change`
          : result?.error || 'Preview failed';
      } else if (event.target.closest('[data-rule-run]')) {
        output.textContent = 'Applying…';
        const result = await ask({ type: 'RULES_APPLY', ruleId: rule.id });
        if (!result?.ok) return (output.textContent = result?.error || 'The rule could not run');
        await loadSettingsQuietly();
        paint();
        window.XVaultUndo.push({
          label: `Rule “${rule.name}” · ${count(result.changed, 'post')}`,
          entries: result.previous || [],
        });
        refreshLibrary();
        renderBoards();
      } else if (event.target.closest('[data-rule-edit]')) paint(rule);
      else if (event.target.closest('[data-rule-delete]')) {
        if (!confirm(`Delete the rule “${rule.name}”? Posts it already organised keep their tags.`)) return;
        const before = rules();
        await save({ autoTagRules: before.filter(item => item.id !== rule.id) }, false);
        paint();
        window.XVaultUndo.push({
          label: `Deleted rule ${rule.name}`,
          undo: () => save({ autoTagRules: before }, false),
        });
      }
    };
    body.onchange = async event => {
      const toggle = event.target.closest('[data-rule-toggle]');
      if (!toggle) return;
      const id = toggle.closest('[data-rule]').dataset.rule;
      await save(
        { autoTagRules: rules().map(rule => (rule.id === id ? { ...rule, enabled: toggle.checked } : rule)) },
        false
      );
    };
    body.onsubmit = async event => {
      event.preventDefault();
      const draft = ruleFromForm(event.target);
      if (!draft.query) return toast('A rule needs a search');
      const list = rules().filter(rule => rule.id !== draft.id);
      const next = draft.id
        ? rules().map(rule => (rule.id === draft.id ? { ...rule, ...draft } : rule))
        : [...list, draft];
      const saved = await save({ autoTagRules: next }, false);
      if ((saved.autoTagRules || []).length < next.length)
        return toast('A rule needs a search and at least one action');
      toast(draft.id ? 'Rule saved' : 'Rule added');
      prefill = null;
      paint(null);
    };
    openDialog(dialog);
  }
  async function loadSettingsQuietly() {
    const result = await ask({ type: 'GET_SETTINGS' });
    if (result?.settings) Object.assign(settings, result.settings);
  }

  // ───────────────────────── Mount ─────────────────────────
  function decorateTools() {
    const body = $('#libraryToolsBody');
    if (!body || body.querySelector('[data-l3-tools]')) return;
    const group = document.createElement('div');
    group.dataset.l3Tools = '';
    group.innerHTML = `<hr><button type="button" data-l3-open="boards">Boards…</button><button type="button" data-l3-open="rules">Auto-tag rules…</button><button type="button" data-l3-open="image">Search by image…</button><button type="button" data-l3-open="meaning">Rebuild meaning index</button>`;
    body.querySelector('#surpriseMe')?.after(group);
    group.addEventListener('click', async event => {
      const act = event.target.closest('[data-l3-open]')?.dataset.l3Open;
      event.target.closest('details')?.removeAttribute('open');
      if (act === 'boards') openBoardManager();
      if (act === 'rules') openRules();
      if (act === 'image') $('#xvImageSearchFile')?.click();
      if (act === 'meaning') {
        toast('Rebuilding the meaning index…');
        const result = await ask({ type: 'SEMANTIC_REBUILD' });
        toast(
          result?.ok
            ? `Meaning index ready · ${count(result.index?.documents || 0, 'post')}`
            : result?.error || 'Rebuild failed'
        );
      }
    });
  }
  function mount() {
    decorateSearch();
    decorateTools();
    decorateBulkBar();
    ensureBoardSection();
    renderBoards();
    new MutationObserver(() => decorateBulkBar()).observe(document.body, { childList: true });
  }
  window.XVaultDashboard.after('renderLib', () => {
    decorateBulkBar();
    decorateCards();
    paintBoards();
    paintBoardBanner();
  });
  window.XVaultDashboard.after('apply', () => paintBoards());
  window.XVaultDashboard.commands(() => [
    { name: 'Undo last change', hint: window.XVaultUndo.list()[0]?.label || 'nothing to undo yet', run: () => undo() },
    { name: 'Edit selected posts', hint: 'tags, boards, read later, notes', run: () => openBulkEditor() },
    { name: 'Boards', hint: 'create, reorder and pin boards', run: () => (page('library'), openBoardManager()) },
    { name: 'Auto-tag rules', hint: 'organise new captures automatically', run: () => (page('library'), openRules()) },
    {
      name: 'Search by image',
      hint: 'find look-alikes of a picture',
      run: () => (page('library'), $('#xvImageSearchFile')?.click()),
    },
    {
      name: 'Read later',
      hint: 'posts saved for later',
      run: () => (page('library'), window.XVaultLibraryRunQuery?.('is:later is:unread')),
    },
    {
      name: 'Highlights',
      hint: 'posts with highlighted passages',
      run: () => (page('library'), window.XVaultLibraryRunQuery?.('has:highlight')),
    },
    ...Object.entries(SELECTORS).map(([kind, rule]) => ({
      name: `Select: ${rule.label}`,
      hint: 'among loaded results',
      run: () => selectBy(kind),
    })),
    ...boards().map(board => ({
      name: `Board: ${board.name}`,
      hint: board.description || 'open board',
      run: () => (page('library'), window.XVaultLibraryRunQuery?.(`board:${board.id}`)),
    })),
  ]);
  window.XVaultLibrary3 = {
    createBoard,
    openBulkEditor,
    openBoardManager,
    openBoardPicker,
    openRules,
    imageSearch,
    selectBy,
    undo,
    renderBoards,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
