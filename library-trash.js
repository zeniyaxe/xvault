/* Recovery workbench: bounded pages, explicit conflict evidence, no purging. */
(() => {
  let dialog,
    rows = [],
    selected = new Set(),
    cursor = null,
    next = null,
    history = [],
    busy = false,
    restoring = false,
    generation = 0,
    invoker;
  const date = value => (value ? new Date(value).toLocaleString() : 'Not recorded');
  function mount() {
    dialog = document.createElement('dialog');
    dialog.id = 'xvTrash';
    dialog.className = 'xv-trash';
    dialog.setAttribute('aria-labelledby', 'xvTrashTitle');
    dialog.innerHTML = `<header><div><h2 id="xvTrashTitle">Trash</h2><p>Recover archived posts. Downloaded files stay on disk.</p></div><button id="xvTrashClose" type="button" class="quiet" aria-label="Close Trash">Close</button></header><div class="xv-trash-tools"><label><input id="xvTrashSelectPage" type="checkbox"> Select page</label><button id="xvTrashRestore" type="button" class="primary" disabled>Restore selected</button><button id="xvTrashReload" type="button" class="quiet">Reload</button><span id="xvTrashStatus" role="status" aria-live="polite"></span></div><div class="xv-trash-workbench"><div id="xvTrashRows" class="xv-trash-rows" aria-label="Trashed posts"></div><section id="xvTrashDetail" class="xv-trash-detail" aria-label="Recovery details"><p>Select a post to inspect its text and notes.</p></section></div><footer><span id="xvTrashCount"></span><div><button id="xvTrashPrev" type="button">Previous page</button><button id="xvTrashNext" type="button">Next page</button></div></footer>`;
    const search = document.createElement('label');
    search.className = 'xv-trash-search';
    search.innerHTML =
      '<span>Search all Trash</span><input id="xvTrashSearch" type="search" placeholder="Text, author, tags, private notes or post ID" maxlength="1000" autocomplete="off">';
    dialog.querySelector('.xv-trash-tools').before(search);
    let searchTimer;
    search.querySelector('input').oninput = () => {
      generation++;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        cursor = null;
        history = [];
        void load();
      }, 160);
    };
    document.body.append(dialog);
    dialog.querySelector('#xvTrashClose').onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => {
      if (restoring) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      generation++;
      const target =
        invoker?.isConnected && !invoker.closest('details:not([open])') && invoker.getClientRects().length
          ? invoker
          : document.querySelector('#libraryTools>summary');
      target?.focus({ preventScroll: true });
    });
    dialog.querySelector('#xvTrashReload').onclick = () => {
      cursor = null;
      history = [];
      void load();
    };
    dialog.querySelector('#xvTrashPrev').onclick = () => {
      if (!busy && history.length) {
        cursor = history.pop();
        void load();
      }
    };
    dialog.querySelector('#xvTrashNext').onclick = () => {
      if (!busy && next != null) {
        history.push(cursor);
        cursor = next;
        void load();
      }
    };
    dialog.querySelector('#xvTrashSelectPage').onchange = event => {
      selected = event.target.checked
        ? new Set(rows.filter(row => !row.conflict).map(row => String(row.id)))
        : new Set();
      renderRows();
    };
    dialog.querySelector('#xvTrashRestore').onclick = restore;
    dialog.querySelector('#xvTrashRows').addEventListener('keydown', event => {
      if (busy || !event.target.matches('[data-trash-detail]')) return;
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const controls = [...dialog.querySelectorAll('[data-trash-detail]')],
        index = controls.indexOf(event.target);
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? controls.length - 1
            : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      controls[nextIndex]?.focus();
      controls[nextIndex]?.click();
    });
    document.addEventListener('xv:trash-updated', () => {
      if (dialog.open && !busy) {
        cursor = null;
        history = [];
        void load();
      }
    });
  }
  function setBusy(value) {
    busy = value;
    dialog.querySelectorAll('button,input').forEach(element => {
      element.disabled = value;
    });
    dialog.querySelector('#xvTrashSearch').disabled = restoring;
    dialog.querySelector('#xvTrashClose').disabled = restoring && value;
    dialog.querySelector('#xvTrashRows').setAttribute('aria-busy', String(value));
    if (!value) selectionState();
  }
  function selectionState() {
    const eligible = rows.filter(row => !row.conflict),
      check = dialog.querySelector('#xvTrashSelectPage');
    check.checked = eligible.length > 0 && selected.size === eligible.length;
    check.indeterminate = selected.size > 0 && selected.size < eligible.length;
    check.disabled = busy || !eligible.length;
    dialog.querySelectorAll('[data-trash-select]').forEach(control => {
      control.disabled = busy || !!rows[control.dataset.trashSelect]?.conflict;
    });
    const restore = dialog.querySelector('#xvTrashRestore');
    restore.disabled = busy || !selected.size;
    restore.textContent = selected.size
      ? `Restore ${fmt(selected.size)} ${selected.size === 1 ? 'post' : 'posts'}`
      : 'Restore selected';
    dialog.querySelector('#xvTrashPrev').disabled = busy || !history.length;
    dialog.querySelector('#xvTrashNext').disabled = busy || next == null;
  }
  function renderRows() {
    const list = dialog.querySelector('#xvTrashRows');
    list.innerHTML = rows.length
      ? rows
          .map(
            (row, index) =>
              `<article class="xv-trash-row ${row.conflict ? 'conflict' : ''}"><input type="checkbox" data-trash-select="${index}" aria-label="Select post ${esc(row.id)} for restoration" ${selected.has(String(row.id)) ? 'checked' : ''} ${row.conflict ? 'disabled' : ''}><button type="button" class="xv-trash-record" data-trash-detail="${index}"><b>@${esc(row.author?.handle || 'unknown')}</b><p>${esc(row.text || 'Media post')}</p><small>${row.conflict ? 'Already archived · compare versions' : 'Removed ' + esc(date(row.deletedAt))} · ${row.mediaCount} media</small></button></article>`
          )
          .join('')
      : dialog.querySelector('#xvTrashSearch').value
        ? '<div class="empty"><h3>No matching posts</h3><p>All Trash was searched. Try fewer words or a post ID.</p></div>'
        : '<div class="empty"><h3>Trash is empty</h3><p>Posts moved to Trash will appear here for recovery.</p></div>';
    list.querySelectorAll('[data-trash-select]').forEach(
      control =>
        (control.onchange = () => {
          const id = String(rows[control.dataset.trashSelect].id);
          if (control.checked) selected.add(id);
          else selected.delete(id);
          selectionState();
        })
    );
    list.querySelectorAll('[data-trash-detail]').forEach(
      control =>
        (control.onclick = () => {
          list.querySelectorAll('[aria-pressed]').forEach(button => button.removeAttribute('aria-pressed'));
          control.setAttribute('aria-pressed', 'true');
          detail(rows[control.dataset.trashDetail]);
        })
    );
    selectionState();
  }
  function detail(row) {
    const target = dialog.querySelector('#xvTrashDetail');
    const version = (item, label) =>
      `<section><h3>${label}</h3><p class="xv-trash-text">${esc(item.text || 'No post text recorded.')}</p><dl><dt>Post ID</dt><dd>${esc(item.id)}</dd><dt>Archived</dt><dd>${esc(date(item.archivedAt))}</dd><dt>Tags</dt><dd>${esc((item.userMeta?.tags || []).join(', ') || 'Untagged')}</dd></dl><h4>Private note</h4><p class="xv-trash-note">${esc(item.userMeta?.note || 'No note')}</p></section>`;
    target.innerHTML = `<header><h2>@${esc(row.author?.handle || 'unknown')}</h2>${row.conflict ? '<p class="xv-trash-warning">A copy already exists in the Library. Restoring cannot overwrite it; both copies are retained.</p>' : '<p>Select this post to restore it to the Library.</p>'}</header>${version(row, 'Copy in Trash')}${row.current ? version(row.current, 'Current Library copy') + `<section class="xv-trash-merge"><h3>Recover personal metadata</h3><p>Keep the current post and its metadata. Add tags from Trash, or append the older note with a recovery label. The copy in Trash stays available.</p><label>Note after recovery<textarea readonly id="xvTrashMergePreview"></textarea></label><button type="button" id="xvTrashMergeNote">Append older note and merge tags</button><button type="button" id="xvTrashMergeTags">Merge tags only</button><p id="xvTrashMergeStatus" role="status"></p></section>` : ''}<div class="xv-trash-evidence"><button type="button" id="xvTrashExport">Export this copy as JSON</button>${row.userMeta?.note ? '<button type="button" id="xvTrashCopyNote">Copy note from Trash</button>' : ''}</div>`;
    if (row.current) {
      const note = row.current.userMeta?.note || '',
        older = row.userMeta?.note || '';
      const suffix = `\n\n[Recovered from Trash]\n${older}`;
      target.querySelector('#xvTrashMergePreview').value =
        older && note !== older && !note.endsWith(suffix) ? (note ? note + suffix : older) : note;
      const merge = async mode => {
        if (busy) return;
        restoring = true;
        setBusy(true);
        try {
          const result = await call({
            type: 'MERGE_TRASH_METADATA',
            id: row.id,
            options: { mode, expectedNote: note, expectedTrashNote: older },
          });
          if (!result?.ok) throw Error(result?.error || 'Merge failed');
          const current = library.find(post => String(post.id) === String(row.id));
          if (current) {
            Object.assign(current, result.row);
            window.XVaultLibraryRecordUpdated?.([row.id]);
          }
          row.current = { ...result.row, mediaCount: result.row.media?.length || 0 };
          detail(row);
          target.querySelector('#xvTrashMergeStatus').textContent =
            'Metadata recovered. Both post copies are preserved.';
        } catch (error) {
          target.querySelector('#xvTrashMergeStatus').textContent = error.message;
        } finally {
          restoring = false;
          setBusy(false);
        }
      };
      target.querySelector('#xvTrashMergeNote').onclick = () => merge('append-note');
      target.querySelector('#xvTrashMergeTags').onclick = () => merge('tags');
    }
    target.querySelector('#xvTrashCopyNote')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(row.userMeta.note);
        toast('Note copied');
      } catch {
        toast('Clipboard access failed');
      }
    });
    target.querySelector('#xvTrashExport').onclick = async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await call({ type: 'GET_TRASH_RECORD', id: row.id });
        if (!result?.ok || !result.row) throw Error(result?.error || 'This copy is no longer in Trash');
        download(
          JSON.stringify(result.row, null, 2),
          `xvault-trash-${String(row.id).replace(/[^a-z0-9_-]/gi, '_')}.json`,
          'application/json'
        );
        toast('Trash copy exported');
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    };
  }
  async function load() {
    const request = ++generation;
    selected.clear();
    setBusy(true);
    dialog.querySelector('#xvTrashStatus').textContent = 'Reading Trash…';
    try {
      const query = dialog.querySelector('#xvTrashSearch').value;
      let afterKey = cursor,
        found = [],
        result;
      do {
        result = await call({ type: 'GET_TRASH_PAGE', afterKey, limit: 100 - found.length, query });
        if (request !== generation || !dialog.open) return;
        if (!result?.ok) throw Error(result?.error || 'Trash could not be read');
        found.push(...(result.rows || []));
        afterKey = result.nextKey;
        dialog.querySelector('#xvTrashStatus').textContent = `Searching all Trash… ${fmt(found.length)} matches found`;
      } while (!result.done && found.length < 100);
      result = { ...result, rows: found };
      if (request !== generation || !dialog.open) return;
      if (!result?.ok) throw Error(result?.error || 'Trash could not be read');
      rows = result.rows || [];
      next = result.done ? null : result.nextKey;
      dialog.querySelector('#xvTrashCount').textContent =
        `${fmt(result.total)} ${result.total === 1 ? 'post' : 'posts'} in Trash · Page ${history.length + 1} · Recently removed first`;
      dialog.querySelector('#xvTrashStatus').textContent = rows.some(row => row.conflict)
        ? 'Existing Library copies are protected.'
        : '';
      dialog.querySelector('#xvTrashDetail').innerHTML = '<p>Select a post to inspect its text and notes.</p>';
      renderRows();
    } catch (error) {
      if (request !== generation) return;
      rows = [];
      next = null;
      renderRows();
      dialog.querySelector('#xvTrashStatus').textContent = `Read failed: ${error.message}. Reload to retry.`;
    } finally {
      if (request === generation) setBusy(false);
    }
  }
  async function restore() {
    if (busy || !selected.size) return;
    const ids = [...selected];
    restoring = true;
    setBusy(true);
    dialog.querySelector('#xvTrashStatus').textContent = `Restoring ${fmt(ids.length)} posts…`;
    try {
      const result = await call({ type: 'RESTORE_TWEETS_FROM_TRASH', ids });
      if (!result?.ok) throw Error(result?.error || 'Restore failed');
      if (Array.isArray(result.rows)) await window.XVaultLibraryApplyRestore(result.rows);
      else await loadLib();
      toast(
        `${fmt(result.restored)} posts restored.${result.conflicts?.length ? ' Existing copies are protected; compare them in Trash.' : ''}`
      );
      cursor = null;
      history = [];
      busy = false;
      await load();
    } catch (error) {
      dialog.querySelector('#xvTrashStatus').textContent = `Restore failed: ${error.message}. Retry is safe.`;
    } finally {
      restoring = false;
      setBusy(false);
    }
  }
  function open() {
    if (!dialog) mount();
    if (dialog.open) return;
    invoker = document.activeElement;
    document.querySelector('#libraryTools').open = false;
    cursor = null;
    history = [];
    dialog.showModal();
    void load();
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#browseTrash').onclick = open;
  });
  window.XVaultTrash = { open };
})();
