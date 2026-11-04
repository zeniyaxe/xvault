/* Private per-editor drafts and serialized, conflict-aware note saves. */
(() => {
  const prefix = 'xv-note-draft:';
  let editor = crypto.randomUUID(),
    active = null;
  try {
    editor = sessionStorage.getItem('xv-note-editor') || editor;
    sessionStorage.setItem('xv-note-editor', editor);
  } catch {}
  function drafts(id) {
    const result = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key.startsWith(prefix + id + ':')) continue;
        try {
          const data = JSON.parse(localStorage.getItem(key));
          if (typeof data.value === 'string' && typeof data.base === 'string') result.push({ key, ...data });
        } catch {}
      }
    } catch {}
    return result.sort((a, b) => b.at - a.at);
  }
  function bind(post, body) {
    active?.dispose();
    const id = String(post.id),
      owner = prefix + id + ':' + editor + ':',
      key = owner + crypto.randomUUID();
    const recovered = drafts(id),
      draft = recovered.find(entry => entry.key.startsWith(owner)) || recovered[0];
    const note = body.querySelector('#dNote'),
      state = body.querySelector('#dNoteState'),
      save = body.querySelector('#dSaveNote');
    const panel = body.querySelector('#dNoteConflict'),
      theirs = body.querySelector('#dNoteCurrent');
    let base = draft?.base ?? post.userMeta?.note ?? '',
      timer = 0,
      busy = false,
      queued = false,
      conflict = null,
      disposed = false,
      durable = true;
    note.value = draft?.value ?? post.userMeta?.note ?? '';
    function persist() {
      try {
        localStorage.setItem(key, JSON.stringify({ value: note.value, base, at: Date.now() }));
        durable = true;
      } catch {
        durable = false;
      }
    }
    function clearSaved(value, original) {
      // A successful old request must never erase a newer edit or another
      // window's different draft. Remove only the version actually saved.
      for (const entry of drafts(id))
        if (entry.value === value && entry.base === original) {
          try {
            localStorage.removeItem(entry.key);
          } catch {}
        }
    }
    function status(text) {
      state.textContent = text;
      state.dataset.state = conflict ? 'conflict' : busy ? 'saving' : note.value !== base ? 'draft' : 'saved';
    }
    function showConflict(row) {
      conflict = row;
      panel.hidden = false;
      theirs.textContent = row.userMeta?.note || 'The saved note is empty.';
      status('Changed in another window. Your draft is retained.');
    }
    async function saveNote(quiet = true) {
      clearTimeout(timer);
      if (busy) {
        queued = true;
        return;
      }
      if (conflict) return;
      if (note.value === base) {
        clearSaved(note.value, base);
        status('Saved');
        return;
      }
      const value = note.value,
        original = base;
      persist();
      busy = true;
      save.disabled = true;
      status('Saving…');
      try {
        const result = await call({ type: 'UPDATE_TWEET_META', id, patch: { note: value }, expectedNote: original });
        if (result?.conflict) {
          showConflict(result.row);
          return;
        }
        if (!result?.ok) throw Error(result?.error || 'Post is unavailable');
        base = result.row.userMeta?.note || '';
        Object.assign(post, result.row);
        clearSaved(value, original);
        if (note.value !== value) {
          persist();
          queued = true;
          status('Newer draft waiting to save…');
        } else {
          try {
            localStorage.removeItem(key);
          } catch {}
          status('Saved');
          if (!quiet) toast('Note saved');
        }
      } catch (error) {
        status(
          durable ? 'Save failed. Draft retained — retry.' : 'Save failed. Keep this window open to retain your draft.'
        );
        save.title = error.message;
      } finally {
        busy = false;
        save.disabled = false;
        const again = queued;
        queued = false;
        if (again && !conflict && note.value !== base) void saveNote(true);
      }
    }
    note.oninput = () => {
      persist();
      status(
        conflict
          ? 'Conflict unresolved. Your draft is retained.'
          : durable
            ? 'Draft retained · saving shortly'
            : 'Draft is only in this window'
      );
      clearTimeout(timer);
      if (!conflict) timer = setTimeout(() => saveNote(true), 1200);
    };
    note.onblur = () => {
      if (!disposed) void saveNote(true);
    };
    note.onkeydown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void saveNote(false);
      }
    };
    save.onclick = () => saveNote(false);
    body.querySelector('#dNoteKeepMine').onclick = () => {
      if (!conflict || busy) return;
      base = conflict.userMeta?.note || '';
      conflict = null;
      panel.hidden = true;
      persist();
      void saveNote(false);
    };
    body.querySelector('#dNoteUseSaved').onclick = () => {
      if (!conflict || busy) return;
      const value = note.value,
        original = base;
      clearSaved(value, original);
      Object.assign(post, conflict);
      base = conflict.userMeta?.note || '';
      note.value = base;
      conflict = null;
      panel.hidden = true;
      status('Saved version loaded');
      note.focus();
      window.XVaultLibraryRecordUpdated?.([id]);
    };
    active = {
      dispose() {
        disposed = true;
        clearTimeout(timer);
        if (note.value !== base) {
          persist();
          if (!busy && !conflict) void saveNote(true);
        }
      },
    };
    if (note.value !== base) {
      persist();
      status('Recovered draft · not saved yet');
      if (durable && draft?.key.startsWith(owner)) {
        try {
          localStorage.removeItem(draft.key);
        } catch {}
      }
      if ((post.userMeta?.note || '') !== base) showConflict(post);
    }
  }
  window.XVaultNotes = { bind };
})();
