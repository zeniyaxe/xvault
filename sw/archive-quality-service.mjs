// XVault 21: archive quality and change tracking service (router-mounted).
//   QUALITY_REPORT     — quality histogram, missing-field reasons, change/availability summary;
//   QUALITY_QUEUE      — start a repair / gaps / check visit queue (sw/status-visitor.mjs);
//   STORE_AVAILABILITY — content scripts report X tombstones ("This post was deleted", …);
//   REVISIONS_FOR      — a post's revision history for the Reader diff view;
//   AVAILABILITY_SET   — manual override from the Reader ("mark as still available").
import {
  qualityReport,
  repairCandidates,
  gapCandidates,
  threadGaps,
  checkCandidates,
  changeSummary,
} from './forge-candidates.mjs';
import '../x-post-extras.js';

export function createArchiveQualityService(deps) {
  const {
    forEachPost,
    archivedIds,
    patchSystemFields,
    readRevisions,
    getSettings,
    visitor,
    announce = () => {},
    now = () => Date.now(),
  } = deps;

  async function collect() {
    const posts = [];
    await forEachPost(post => posts.push(post));
    return posts;
  }

  async function report() {
    const posts = await collect(),
      ids = await archivedIds(),
      settings = await getSettings(),
      gaps = gapCandidates(posts, ids, { limit: 0 });
    return {
      ok: true,
      quality: qualityReport(posts),
      changes: changeSummary(posts),
      gaps: { parents: gaps.parents, quotes: gaps.quotes, threads: threadGaps(posts, ids, { limit: 30 }) },
      repairable: repairCandidates(posts, { now: now(), limit: 100000 }).length,
      checkable: checkCandidates(posts, {
        scope: settings.availabilityScope,
        recheckDays: settings.availabilityRecheckDays,
        now: now(),
        limit: 100000,
      }).length,
      checksEnabled: !!settings.availabilityChecks,
      caps: {
        repair: settings.repairDailyCap,
        gaps: settings.repairDailyCap,
        check: settings.availabilityDailyCap,
      },
      visitor: await visitor.status(),
    };
  }

  async function queue(message) {
    const kind = String(message.kind || ''),
      settings = await getSettings(),
      posts = await collect();
    if (kind === 'repair') {
      const list =
        Array.isArray(message.ids) && message.ids.length
          ? message.ids.map(String)
          : repairCandidates(posts, { now: now() }).map(entry => entry.id);
      return visitor.start('repair', list, { label: `Repair ${list.length} incomplete posts` });
    }
    if (kind === 'gaps') {
      const ids = await archivedIds();
      let list;
      if (message.conversationId) {
        const thread = threadGaps(posts, ids, { limit: 100000 }).find(
          entry => entry.conversationId === String(message.conversationId)
        );
        list = thread ? thread.missing : [];
      } else list = gapCandidates(posts, ids).list.map(entry => entry.id);
      return visitor.start('gaps', list, {
        label: message.conversationId
          ? `Fetch the rest of thread ${message.conversationId}`
          : `Fetch ${list.length} missing posts`,
        depth: settings.quoteChainDepth,
      });
    }
    if (kind === 'check') {
      if (!settings.availabilityChecks && !message.manual)
        return { ok: false, error: 'Turn on “Still on X?” checks in Settings › Capture first.' };
      const list =
        Array.isArray(message.ids) && message.ids.length
          ? message.ids.map(String)
          : checkCandidates(posts, {
              scope: settings.availabilityScope,
              recheckDays: settings.availabilityRecheckDays,
              now: now(),
            }).map(entry => entry.id);
      return visitor.start('check', list, { label: `Check ${list.length} posts are still on X` });
    }
    throw Error('Unknown quality queue');
  }

  async function storeAvailability(message) {
    const entries = (Array.isArray(message.entries) ? message.entries : [])
      .filter(entry => globalThis.XVaultPostExtras.validAvailability(entry))
      .slice(0, 500);
    if (!entries.length) return { ok: true, updated: 0 };
    const at = now();
    const result = await patchSystemFields(entries, (post, entry) => {
      const previous = post.availability?.state || '';
      if (previous === entry.state && Number(post.availability?.checkedAt || 0) > at - 3600000) return null;
      return {
        availability: {
          state: entry.state,
          checkedAt: at,
          reason: entry.reason || undefined,
          source: 'x',
          previous: previous || undefined,
          since: previous === entry.state ? post.availability?.since || at : at,
        },
      };
    });
    if (result.updated) announce(result.ids, 'availability');
    return { ok: true, updated: result.updated };
  }

  async function setAvailability(message) {
    const id = String(message.id || ''),
      state = String(message.state || '');
    if (!/^\d{1,32}$/.test(id)) throw Error('Invalid post ID');
    if (!['available', 'deleted', 'suspended', 'protected', 'withheld', 'unavailable', 'clear'].includes(state))
      throw Error('Invalid availability');
    const result = await patchSystemFields([{ id }], post => ({
      availability:
        state === 'clear'
          ? null
          : { state, checkedAt: now(), source: 'manual', previous: post.availability?.state || undefined },
    }));
    if (result.updated) announce(result.ids, 'availability');
    return { ok: true, updated: result.updated };
  }

  /** Called by the visitor after every visit: stamps repair attempts and check results. */
  async function markVisited(kind, id, outcome, startedAt) {
    const patch = post => {
      if (kind === 'repair') return { repairAttemptAt: now() };
      if (kind === 'check' && outcome === 'seen')
        return {
          availability: {
            state: 'available',
            checkedAt: now(),
            source: 'check',
            previous:
              post.availability?.state && post.availability.state !== 'available' ? post.availability.state : undefined,
          },
        };
      return null;
    };
    const result = await patchSystemFields([{ id }], patch);
    if (result.updated) announce(result.ids, 'availability');
    return startedAt;
  }

  const MESSAGES = {
    QUALITY_REPORT: () => report(),
    QUALITY_QUEUE: message => queue(message),
    AVAILABILITY_SET: message => setAvailability(message),
    REVISIONS_FOR: async message => ({ ok: true, revisions: await readRevisions(String(message.id || '')) }),
  };
  return {
    report,
    queue,
    storeAvailability,
    markVisited,
    types: Object.keys(MESSAGES),
    handle: message => MESSAGES[message.type](message),
  };
}
