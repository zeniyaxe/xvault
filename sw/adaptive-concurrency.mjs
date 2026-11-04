// Adaptive download concurrency (XVault 20). Additive-increase / multiplicative-decrease, like TCP:
// X's media CDN answers bursts with server errors and resets, so on trouble the queue halves its
// parallelism and then earns slots back one at a time after a streak of clean completions. The
// user's "parallel downloads" setting is always the ceiling.
const THROTTLE = /SERVER_|NETWORK_|429|503|TIMED_OUT|throttl|rate/i;

export function createConcurrencyGovernor({ now = () => Date.now(), streak = 6, floor = 1, cooldownMs = 20000 } = {}) {
  let current = null,
    clean = 0,
    lastCut = -Infinity;
  const events = [];
  function record(kind, detail = '') {
    events.push({ at: now(), kind, limit: current, detail: String(detail).slice(0, 80) });
    if (events.length > 30) events.shift();
  }
  return {
    /** Effective limit for this pump, never above the user's ceiling. */
    limit(ceiling, enabled = true) {
      const max = Math.max(1, Math.min(8, Math.floor(Number(ceiling) || 4)));
      if (!enabled) return max;
      if (current == null || current > max) current = max;
      return current;
    },
    success() {
      if (current == null) return;
      clean += 1;
      if (clean >= streak) {
        clean = 0;
        current += 1; // capped by limit() on the next pump
        record('raise');
      }
    },
    failure(reason = '') {
      clean = 0;
      if (current == null || !THROTTLE.test(String(reason))) return false;
      if (now() - lastCut < cooldownMs) return false; // one cut per burst of failures
      lastCut = now();
      const next = Math.max(floor, Math.floor(current / 2));
      const cut = next < current;
      current = next;
      if (cut) record('cut', reason);
      return cut;
    },
    status: () => ({ limit: current, streak: clean, events: events.slice().reverse() }),
    reset() {
      current = null;
      clean = 0;
      lastCut = -Infinity;
    },
  };
}
