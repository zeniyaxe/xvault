/* XVault 21 — structured post extras read from X's GraphQL tweet objects: polls, link cards, Spaces,
   Community Notes, edit history, alt text, video duration and unavailable-post tombstones.
   Shared by content.js (capture) and message-boundary.mjs (validation); pure and testable. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultPostExtras = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ID = /^\d{1,32}$/;
  const HTTPS = /^https:\/\/[^\s]{1,2040}$/i;
  const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };
  const time = value => {
    const stamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
    return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
  };

  // binding_values arrives either as [{ key, value: { string_value | image_value | boolean_value } }]
  // or (newer payloads) as an object keyed by name.
  function bindings(card) {
    const legacy = card?.legacy || card || {};
    const raw = legacy.binding_values;
    const out = new Map();
    const read = value =>
      value?.string_value ?? value?.image_value ?? value?.boolean_value ?? value?.user_value ?? value?.scribe_key;
    if (Array.isArray(raw)) for (const entry of raw) out.set(String(entry?.key || ''), read(entry?.value));
    else if (raw && typeof raw === 'object') for (const [key, value] of Object.entries(raw)) out.set(key, read(value));
    return { name: String(legacy.name || card?.name || ''), values: out, url: String(legacy.url || '') };
  }

  function parsePoll(card) {
    const { name, values } = bindings(card);
    if (!/^poll\dchoice/.test(name)) return null;
    const choices = [];
    for (let index = 1; index <= 4; index++) {
      const label = values.get(`choice${index}_label`);
      if (typeof label !== 'string') continue;
      choices.push({ label: clip(label, 200), count: num(values.get(`choice${index}_count`)) ?? 0 });
    }
    if (choices.length < 2) return null;
    return {
      choices,
      totalVotes: choices.reduce((sum, choice) => sum + choice.count, 0),
      endsAt: time(values.get('end_datetime_utc')),
      final: values.get('counts_are_final') === true,
      durationMinutes: num(values.get('duration_minutes')),
      updatedAt: time(values.get('last_updated_datetime_utc')),
    };
  }

  function imageOf(values) {
    for (const key of [
      'photo_image_full_size_original',
      'summary_photo_image_original',
      'thumbnail_image_original',
      'thumbnail_image_large',
      'thumbnail_image',
      'player_image_original',
    ]) {
      const image = values.get(key);
      if (image && typeof image === 'object' && HTTPS.test(String(image.url || '')))
        return { url: String(image.url), width: num(image.width), height: num(image.height) };
    }
    return null;
  }

  function parseSpace(card) {
    const { name, values } = bindings(card);
    if (!/audiospace$/.test(name)) return null;
    const id = String(values.get('id') || '');
    return /^[A-Za-z0-9]{6,40}$/.test(id) ? { id, url: `https://x.com/i/spaces/${id}` } : null;
  }

  function parseCard(card) {
    const { name, values, url } = bindings(card);
    if (!name || /^poll\dchoice/.test(name) || /audiospace$/.test(name)) return null;
    let title = values.get('title'),
      description = values.get('description'),
      target = values.get('card_url') || url,
      domain = values.get('vanity_url') || values.get('domain');
    if (name === 'unified_card' && typeof values.get('unified_card') === 'string') {
      try {
        const unified = JSON.parse(values.get('unified_card'));
        const details = Object.values(unified.component_objects || {}).find(item => item?.type === 'details');
        title = title || details?.data?.title?.content;
        const destination = Object.values(unified.destination_objects || {})[0]?.data;
        target = destination?.url_data?.url || target;
        domain = domain || destination?.url_data?.vanity;
      } catch {
        // A malformed unified card keeps only the plain bindings.
      }
    }
    const out = {
      name: clip(name, 80),
      url: HTTPS.test(String(target || '')) ? String(target) : null,
      title: clip(title, 300) || null,
      description: clip(description, 1000) || null,
      domain: clip(domain, 200).toLowerCase() || null,
      image: imageOf(values),
    };
    return out.url || out.title ? out : null;
  }

  function parseCommunityNote(pivot) {
    if (!pivot || typeof pivot !== 'object') return null;
    const text = clip(pivot.subtitle?.text || pivot.note?.summary?.text || '', 4000);
    if (!text) return null;
    const url = String(pivot.destinationUrl || '');
    const id = /\/birdwatch\/n\/(\d{1,32})/.exec(url)?.[1] || String(pivot.note?.rest_id || '');
    return {
      id: ID.test(id) ? id : null,
      title: clip(pivot.title || pivot.shorttitle || '', 300) || null,
      text,
      url: HTTPS.test(url) ? url.replace(/^https:\/\/twitter\.com\//, 'https://x.com/') : null,
    };
  }

  function parseEdit(control) {
    if (!control || typeof control !== 'object') return null;
    const base = control.edit_control_initial || control;
    const ids = (Array.isArray(base.edit_tweet_ids) ? base.edit_tweet_ids : []).map(String).filter(id => ID.test(id));
    const initialId = String(control.initial_tweet_id || ids[0] || '');
    if (!ids.length && !ID.test(initialId)) return null;
    return {
      ids: ids.slice(0, 10),
      initialId: ID.test(initialId) ? initialId : null,
      latestId: ids.at(-1) || null,
      editableUntil: time(Number(base.editable_until_msecs)),
      remaining: num(base.edits_remaining),
      edited: ids.length > 1,
    };
  }

  function parseMediaExtras(media) {
    const out = {};
    const alt = clip(media?.ext_alt_text, 4000).trim();
    if (alt) out.altText = alt;
    const duration = num(media?.video_info?.duration_millis);
    if (duration) out.durationMs = duration;
    const ratio = media?.video_info?.aspect_ratio;
    if (Array.isArray(ratio) && ratio.length === 2 && ratio.every(value => num(value)))
      out.aspectRatio = [num(ratio[0]), num(ratio[1])];
    return out;
  }

  // TweetDetail / timelines represent removed posts as tombstones under an entry "tweet-<id>".
  function tombstoneOf(node) {
    const entryId = String(node?.entryId || '');
    const id = /^(?:tweet|conversationthread-\d+-tweet)-(\d{1,32})$/.exec(entryId)?.[1];
    if (!id) return null;
    const result = node?.content?.itemContent?.tweet_results?.result;
    const kind = result?.__typename;
    if (kind !== 'TweetTombstone' && kind !== 'TweetUnavailable') return null;
    const text = clip(result?.tombstone?.text?.text || result?.reason || '', 300);
    const lower = text.toLowerCase();
    const state = /deleted/.test(lower)
      ? 'deleted'
      : /suspend/.test(lower)
        ? 'suspended'
        : /protect|authori[sz]ed/.test(lower)
          ? 'protected'
          : /withheld/.test(lower)
            ? 'withheld'
            : 'unavailable';
    return { id, state, reason: text || null };
  }

  // The focal post of a status page (TweetDetail / TweetResultByRestId) that X refused to return.
  // Only explicit signals count: a "No status found" style error, or an empty/tombstoned result.
  function focalUnavailable(root, meta = {}) {
    const variables = meta?.variables && typeof meta.variables === 'object' ? meta.variables : {};
    const id = String(variables.focalTweetId || variables.tweetId || '');
    if (
      !ID.test(id) ||
      !/^(TweetDetail|TweetResultByRestId|TweetResultsByRestIds)$/.test(String(meta?.operation || ''))
    )
      return null;
    const errors = Array.isArray(root?.errors) ? root.errors : [];
    const message = errors
      .map(error => String(error?.message || ''))
      .join(' ')
      .toLowerCase();
    const state = (text, fallback) =>
      /no status found|deleted|does not exist|not found/.test(text)
        ? 'deleted'
        : /suspend/.test(text)
          ? 'suspended'
          : /protect|not authori[sz]ed|authoriz/.test(text)
            ? 'protected'
            : /withheld/.test(text)
              ? 'withheld'
              : fallback;
    if (message)
      return { id, state: state(message, 'unavailable'), reason: clip(errors[0]?.message || '', 300) || null };
    const result = root?.data?.tweetResult?.result;
    if (root?.data && 'tweetResult' in root.data && !result)
      return { id, state: 'unavailable', reason: 'X returned an empty result for this post' };
    if (result?.__typename === 'TweetTombstone' || result?.__typename === 'TweetUnavailable') {
      const text = clip(result?.tombstone?.text?.text || result?.reason || '', 300);
      return { id, state: state(text.toLowerCase(), 'unavailable'), reason: text || null };
    }
    return null;
  }

  function parseTweetExtras(tweet) {
    const out = {};
    const card = tweet?.card;
    if (card) {
      const poll = parsePoll(card),
        space = parseSpace(card),
        link = parseCard(card);
      if (poll) out.poll = poll;
      if (space) out.space = space;
      if (link) out.card = link;
    }
    const note = parseCommunityNote(tweet?.birdwatch_pivot);
    if (note) out.communityNote = note;
    const edit = parseEdit(tweet?.edit_control);
    if (edit) out.edit = edit;
    return out;
  }

  // ---- validation at the message boundary (content scripts are untrusted) ----
  const AVAILABILITY = new Set(['available', 'deleted', 'suspended', 'protected', 'withheld', 'unavailable']);
  function validExtras(row) {
    const fail = message => {
      throw Error(`Invalid post ${message}`);
    };
    const plain = value => value && typeof value === 'object' && !Array.isArray(value);
    if (row.poll != null) {
      const poll = row.poll;
      if (
        !plain(poll) ||
        !Array.isArray(poll.choices) ||
        poll.choices.length < 2 ||
        poll.choices.length > 4 ||
        poll.choices.some(
          choice =>
            !plain(choice) ||
            typeof choice.label !== 'string' ||
            choice.label.length > 200 ||
            !Number.isFinite(choice.count)
        )
      )
        fail('poll');
    }
    if (row.card != null) {
      const card = row.card;
      if (
        !plain(card) ||
        (card.url != null && !HTTPS.test(String(card.url))) ||
        (card.image != null && (!plain(card.image) || !HTTPS.test(String(card.image.url || '')))) ||
        String(card.title || '').length > 300 ||
        String(card.description || '').length > 1000
      )
        fail('card');
    }
    if (row.space != null && (!plain(row.space) || !/^[A-Za-z0-9]{6,40}$/.test(String(row.space.id || ''))))
      fail('Space');
    if (
      row.communityNote != null &&
      (!plain(row.communityNote) ||
        typeof row.communityNote.text !== 'string' ||
        row.communityNote.text.length > 4000 ||
        (row.communityNote.url != null && !HTTPS.test(String(row.communityNote.url))))
    )
      fail('Community Note');
    if (
      row.edit != null &&
      (!plain(row.edit) ||
        !Array.isArray(row.edit.ids) ||
        row.edit.ids.length > 10 ||
        row.edit.ids.some(id => !ID.test(String(id))))
    )
      fail('edit history');
    for (const media of row.media || []) {
      if (media.altText != null && (typeof media.altText !== 'string' || media.altText.length > 4000)) fail('alt text');
      if (media.durationMs != null && !(Number(media.durationMs) >= 0)) fail('media duration');
    }
    return true;
  }
  function validAvailability(entry) {
    return (
      !!entry &&
      typeof entry === 'object' &&
      ID.test(String(entry.id || '')) &&
      AVAILABILITY.has(String(entry.state || '')) &&
      (entry.reason == null || (typeof entry.reason === 'string' && entry.reason.length <= 300))
    );
  }

  return Object.freeze({
    bindings,
    parsePoll,
    parseCard,
    parseSpace,
    parseCommunityNote,
    parseEdit,
    parseMediaExtras,
    parseTweetExtras,
    tombstoneOf,
    focalUnavailable,
    validExtras,
    validAvailability,
    AVAILABILITY: [...AVAILABILITY],
  });
});
