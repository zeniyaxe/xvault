/* Retained Inspector drafts remain reachable even when their post is absent. */
(() => {
  const prefix = 'xv-note-draft:';
  let dialog,
    keys = [],
    page = 0,
    generation = 0,
    saving = false,
    invoker;
  const parse = key => {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return typeof value?.value === 'string' && typeof value?.base === 'string' ? value : null;
    } catch {
      return null;
    }
  };
  const idFor = key => key.slice(prefix.length).split(':')[0];
  function mount() {
    dialog = document.createElement('dialog');
    dialog.className = 'xv-trash xv-drafts';
    dialog.id = 'xvDrafts';
    dialog.setAttribute('aria-labelledby', 'xvDraftsTitle');
    dialog.innerHTML =
      '<header><div><h2 id="xvDraftsTitle">Recover note drafts</h2><p>Unsaved Inspector versions on this browser. Every editor keeps its own evidence.</p></div><button id="xvDraftsClose" class="quiet" type="button">Close</button></header><div class="xv-trash-tools"><button id="xvDraftsReload" type="button">Reload drafts</button><span id="xvDraftsStatus" role="status" aria-live="polite"></span></div><div class="xv-trash-workbench"><div id="xvDraftsRows" class="xv-trash-rows" aria-label="Retained note drafts"></div><section id="xvDraftsDetail" class="xv-trash-detail" aria-label="Draft recovery details"><p>Select a retained draft.</p></section></div><footer><span id="xvDraftsCount"></span><div><button id="xvDraftsPrev" type="button">Previous page</button><button id="xvDraftsNext" type="button">Next page</button></div></footer>';
    document.body.append(dialog);
    dialog.querySelector('#xvDraftsClose').onclick = () => dialog.close();
    dialog.querySelector('#xvDraftsReload').onclick = reload;
    dialog.querySelector('#xvDraftsPrev').onclick = () => {
      page--;
      render();
    };
    dialog.querySelector('#xvDraftsNext').onclick = () => {
      page++;
      render();
    };
    dialog.addEventListener('cancel', event => {
      if (saving) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      generation++;
      (invoker?.isConnected && !invoker.closest('details:not([open])')
        ? invoker
        : document.querySelector('#libraryTools>summary')
      )?.focus();
    });
    window.addEventListener('storage', event => {
      if (dialog.open && event.key?.startsWith(prefix) && !saving)
        dialog.querySelector('#xvDraftsStatus').textContent =
          'Drafts changed in another window. Reload to review the latest versions.';
    });
  }
  function reload() {
    if (saving) return;
    keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    keys.sort();
    page = 0;
    render();
  }
  function render() {
    generation++;
    const list = dialog.querySelector('#xvDraftsRows');
    list.replaceChildren();
    for (const key of keys.slice(page * 100, page * 100 + 100)) {
      const draft = parse(key),
        button = document.createElement('button');
      button.type = 'button';
      button.className = 'xv-trash-record xv-draft-record';
      const title = document.createElement('b'),
        snippet = document.createElement('p'),
        time = document.createElement('small');
      title.textContent = `Post ${idFor(key)}`;
      snippet.textContent = draft?.value.slice(0, 160) || 'Unreadable or empty draft · export for inspection';
      time.textContent = draft?.at ? new Date(draft.at).toLocaleString() : 'Date not recorded';
      button.append(title, snippet, time);
      button.onclick = () => void inspect(key);
      list.append(button);
    }
    if (!keys.length)
      list.innerHTML =
        '<div class="empty"><h3>No retained drafts</h3><p>Failed or interrupted Inspector saves will appear here.</p></div>';
    dialog.querySelector('#xvDraftsCount').textContent = `${fmt(keys.length)} drafts · Page ${page + 1}`;
    dialog.querySelector('#xvDraftsPrev').disabled = page === 0;
    dialog.querySelector('#xvDraftsNext').disabled = (page + 1) * 100 >= keys.length;
    dialog.querySelector('#xvDraftsDetail').innerHTML =
      '<p>Select a retained draft to compare it with the saved note.</p>';
  }
  async function inspect(key) {
    const version = ++generation,
      id = idFor(key),
      draft = parse(key),
      target = dialog.querySelector('#xvDraftsDetail');
    target.innerHTML = '<p role="status">Reading saved note…</p>';
    try {
      const response = await call({ type: 'GET_LIBRARY_METADATA', ids: [id] });
      if (!response?.ok) throw Error(response?.error || 'Saved note could not be read');
      let current = response.rows?.[0],
        trashed = false;
      if (!current) {
        const result = await call({ type: 'GET_TRASH_RECORD', id });
        if (!result?.ok) throw Error(result?.error || 'Trash could not be read');
        current = result.row;
        trashed = !!current;
      }
      if (version !== generation || !dialog.open) return;
      target.innerHTML =
        '<h2></h2><p class="draft-location"></p><label>Retained draft<textarea id="xvDraftValue" readonly rows="7"></textarea></label><label>Current saved note<textarea id="xvDraftSaved" readonly rows="5"></textarea></label><div class="xv-trash-evidence"><button id="xvDraftExport" type="button">Export draft JSON</button><button id="xvDraftCopy" type="button">Copy draft text</button><button id="xvDraftSave" type="button" class="primary"></button></div><p id="xvDraftResult" role="status" aria-live="polite"></p>';
      target.querySelector('h2').textContent = `Post ${id}`;
      target.querySelector('.draft-location').textContent = trashed
        ? 'This post is in Trash. Recovery restores it before comparing and saving the draft.'
        : current
          ? 'Compare both versions. Saving replaces the displayed saved note only if it is still current.'
          : 'The post is absent from both Library and Trash. Export or copy this draft to preserve it.';
      target.querySelector('#xvDraftValue').value = draft?.value || localStorage.getItem(key) || '';
      target.querySelector('#xvDraftSaved').value = current?.userMeta?.note || '';
      target.querySelector('#xvDraftExport').onclick = () =>
        download(
          localStorage.getItem(key) || 'null',
          `xvault-note-draft-${id.replace(/[^a-z0-9_-]/gi, '_')}.json`,
          'application/json'
        );
      target.querySelector('#xvDraftCopy').onclick = async () => {
        try {
          await navigator.clipboard.writeText(target.querySelector('#xvDraftValue').value);
          toast('Draft copied');
        } catch {
          toast('Clipboard access failed');
        }
      };
      const button = target.querySelector('#xvDraftSave');
      button.textContent = trashed ? 'Restore post and save draft' : 'Save this draft to post';
      button.disabled = !current || !draft;
      button.onclick = async () => {
        if (saving) return;
        const latest = parse(key);
        if (!latest || latest.value !== draft.value || latest.base !== draft.base) {
          target.querySelector('#xvDraftResult').textContent = 'This draft changed. Reload before saving.';
          return;
        }
        saving = true;
        dialog.querySelectorAll('button').forEach(control => (control.disabled = true));
        button.setAttribute('aria-busy', 'true');
        try {
          if (trashed) {
            const restored = await call({ type: 'RESTORE_TWEETS_FROM_TRASH', ids: [id] });
            if (!restored?.ok || !restored.restored)
              throw Error(restored?.error || 'The post changed or a Library copy appeared. Reload the comparison.');
            await window.XVaultLibraryApplyRestore(restored.rows || []);
          }
          const result = await call({
            type: 'UPDATE_TWEET_META',
            id,
            patch: { note: draft.value },
            expectedNote: current.userMeta?.note || '',
          });
          if (!result?.ok) throw Error(result?.error || 'Note changed. Reload to compare again.');
          const retained = parse(key);
          if (retained?.value === draft.value && retained?.base === draft.base) localStorage.removeItem(key);
          const post = library.find(row => String(row.id) === id);
          if (post) Object.assign(post, result.row);
          window.XVaultLibraryRecordUpdated?.([id]);
          toast('Draft saved. Other editor drafts are preserved.');
          saving = false;
          reload();
        } catch (error) {
          target.querySelector('#xvDraftResult').textContent = `${error.message} Your draft is retained.`;
        } finally {
          saving = false;
          dialog.querySelectorAll('button').forEach(control => (control.disabled = false));
          button.removeAttribute('aria-busy');
          dialog.querySelector('#xvDraftsPrev').disabled = page === 0;
          dialog.querySelector('#xvDraftsNext').disabled = (page + 1) * 100 >= keys.length;
        }
      };
    } catch (error) {
      if (version === generation)
        target.textContent = `Could not compare this draft: ${error.message}. Reload to retry.`;
    }
  }
  function open() {
    if (!dialog) mount();
    if (dialog.open) return;
    invoker = document.activeElement;
    document.querySelector('#libraryTools').open = false;
    dialog.showModal();
    reload();
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#recoverNoteDrafts').onclick = open;
  });
  window.XVaultDraftRecovery = { open };
})();
