// XVault 26: a per-host circuit breaker for media downloads. The adaptive governor (adaptive-concurrency.mjs)
// lowers parallelism for the whole queue; this stops hammering ONE host that keeps refusing — several throttle or
// server failures in a row from video.twimg.com park that host's queued files for a cooldown (30 s, doubling to
// 5 min) while other hosts keep downloading. When the cooldown ends the next file is a probe: success closes the
// breaker, another failure re-opens it at the next level. Pure and clock-injected so the rules are unit-tested.
const TRIP = /SERVER_|NETWORK_|429|5\d\d|TIMED_OUT|throttl|rate|too many|reset|unavailable/i;

export function createHostBreaker({
  now = () => Date.now(),
  threshold = 4,
  windowMs = 60000,
  baseMs = 30000,
  maxMs = 5 * 60000,
} = {}) {
  const hosts = new Map();
  const entry = host => {
    if (!hosts.has(host)) hosts.set(host, { host, strikes: 0, firstAt: 0, until: 0, level: 0, trips: 0, reason: '' });
    return hosts.get(host);
  };
  return {
    /** True while `host` is cooling down; queued files for it wait. */
    isOpen(host) {
      const item = hosts.get(String(host || ''));
      return !!item && item.until > now();
    },
    /**
     * A failed download from `host`. Returns { opened, until } when this failure trips the breaker. Failures that
     * are not about the host pushing back (a missing file, a full disk) do not count.
     */
    failure(host, reason = '') {
      host = String(host || '');
      if (!host || !TRIP.test(String(reason))) return { opened: false, until: 0 };
      const item = entry(host),
        at = now();
      if (item.until > at) return { opened: false, until: item.until };
      // A failure right after a cooldown (the probe) re-opens at once; otherwise count a streak inside the window.
      const probe = item.level > 0 && item.strikes >= threshold;
      if (!probe && at - item.firstAt > windowMs) {
        item.strikes = 0;
        item.firstAt = at;
      }
      item.strikes++;
      item.reason = String(reason).slice(0, 80);
      if (!probe && item.strikes < threshold) return { opened: false, until: 0 };
      item.level = Math.min(item.level + 1, 12);
      item.trips++;
      item.until = at + Math.min(maxMs, baseMs * 2 ** (item.level - 1));
      item.strikes = threshold;
      return { opened: true, until: item.until };
    },
    /** A completed download closes the breaker and forgets the streak. */
    success(host) {
      const item = hosts.get(String(host || ''));
      if (!item) return;
      hosts.delete(item.host);
    },
    /** Clears every breaker (the user chose "Retry now"). */
    reset(host = '') {
      if (host) hosts.delete(String(host));
      else hosts.clear();
    },
    /** The earliest time a cooling host opens again, or 0. */
    nextChange() {
      const at = now();
      let next = 0;
      for (const item of hosts.values()) if (item.until > at && (!next || item.until < next)) next = item.until;
      return next;
    },
    /** For the Downloads page and diagnostics: hosts cooling now. */
    snapshot() {
      const at = now();
      return [...hosts.values()]
        .filter(item => item.until > at)
        .map(({ host, until, level, trips, reason }) => ({ host, until, level, trips, reason }));
    },
  };
}
