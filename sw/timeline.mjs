// Library timeline (XVault 22): counts matching posts per day / week / month / year so the Library can draw
// a histogram over the WHOLE result set (not just the loaded page) and turn a brushed range into
// after:/before: filters. Buckets follow the same calendar zone as those filters ('utc' or 'local').
const DAY = 86_400_000;

function parts(stamp, zone) {
  const date = new Date(stamp);
  return zone === 'local'
    ? { y: date.getFullYear(), m: date.getMonth(), d: date.getDate(), w: date.getDay() }
    : { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate(), w: date.getUTCDay() };
}
const make = (zone, y, m, d) => (zone === 'local' ? new Date(y, m, d).getTime() : Date.UTC(y, m, d));

/** Start of the bucket containing `stamp`. Weeks start on Monday. */
export function bucketStart(stamp, unit, zone = 'utc') {
  const { y, m, d, w } = parts(stamp, zone);
  if (unit === 'year') return make(zone, y, 0, 1);
  if (unit === 'month') return make(zone, y, m, 1);
  if (unit === 'week') return make(zone, y, m, d - ((w + 6) % 7));
  return make(zone, y, m, d);
}
export function nextBucket(start, unit, zone = 'utc') {
  const { y, m, d } = parts(start, zone);
  if (unit === 'year') return make(zone, y + 1, 0, 1);
  if (unit === 'month') return make(zone, y, m + 1, 1);
  if (unit === 'week') return make(zone, y, m, d + 7);
  return make(zone, y, m, d + 1);
}
/** YYYY-MM-DD of a bucket boundary in the filter's calendar zone. */
export function dayOf(stamp, zone = 'utc') {
  const { y, m, d } = parts(stamp, zone);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function chooseUnit(min, max) {
  const span = Math.max(0, max - min);
  if (span <= 92 * DAY) return 'day';
  if (span <= 2 * 366 * DAY) return 'week';
  if (span <= 10 * 366 * DAY) return 'month';
  return 'year';
}

/**
 * stamps: millisecond timestamps (invalid ones are ignored). Returns { unit, zone, buckets: [{ start, end,
 * from, to, count }] } with empty buckets filled in, `from` = first day and `to` = the exclusive end day,
 * ready for `after:${from} before:${to}`.
 */
export function timelineBuckets(stamps, { zone = 'utc', unit = '' } = {}) {
  let min = Infinity,
    max = -Infinity,
    valid = 0;
  for (const stamp of stamps) {
    if (!(Number.isFinite(stamp) && stamp > 0)) continue;
    valid++;
    if (stamp < min) min = stamp;
    if (stamp > max) max = stamp;
  }
  if (!valid) return { unit: null, zone, buckets: [], undated: stamps.length };
  const chosen = unit || chooseUnit(min, max);
  const counts = new Map();
  for (const stamp of stamps) {
    if (!(Number.isFinite(stamp) && stamp > 0)) continue;
    const start = bucketStart(stamp, chosen, zone);
    counts.set(start, (counts.get(start) || 0) + 1);
  }
  const buckets = [];
  for (let start = bucketStart(min, chosen, zone); start <= max && buckets.length < 2000;) {
    const end = nextBucket(start, chosen, zone);
    buckets.push({ start, end, from: dayOf(start, zone), to: dayOf(end, zone), count: counts.get(start) || 0 });
    start = end;
  }
  return { unit: chosen, zone, buckets, undated: stamps.length - valid };
}
