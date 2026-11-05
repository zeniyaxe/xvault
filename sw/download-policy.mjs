// XVault 21: download policy and insights.
//   pickVariant / applyVideoQuality — choose the video rendition for the "Video quality" setting;
//   holdReason                     — schedule window and Save-Data holds for the queue pump;
//   createBandwidthGovernor        — duty-cycles active downloads to respect a MB/s cap;
//   hostHealth / duplicateReport   — per-host reliability and reclaimable duplicate files;
//   integrityDue                   — scheduled re-verification of completed downloads.
import { insideWindow, msUntilWindow } from './forge-settings.mjs';

const QUALITY_LIMITS = { highest: Infinity, 1080: 1080, 720: 720, 480: 480 };

/** Shorter side of a rendition, from X's /<w>x<h>/ URL segment (0 when unknown). */
export function variantHeight(variant) {
  const match = /\/(\d{2,5})x(\d{2,5})\//.exec(String(variant?.url || ''));
  if (match) return Math.min(Number(match[1]), Number(match[2]));
  return Number(variant?.height) || 0;
}

/** Best MP4/WebM rendition whose shorter side fits the quality limit; falls back to the smallest one. */
export function pickVariant(variants, quality = 'highest') {
  const limit = QUALITY_LIMITS[String(quality)] ?? Infinity;
  const usable = (Array.isArray(variants) ? variants : []).filter(
    variant =>
      variant?.url && /video\/(mp4|webm)/i.test(variant.contentType || 'video/mp4') && !/\.m3u8/i.test(variant.url)
  );
  if (!usable.length) return null;
  const ranked = usable
    .map(variant => ({ variant, height: variantHeight(variant), bitrate: Number(variant.bitrate) || 0 }))
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
  if (limit === Infinity) return ranked[0].variant;
  const fitting = ranked.filter(entry => entry.height && entry.height <= limit);
  return (fitting[0] || ranked[ranked.length - 1]).variant;
}

/**
 * Rewrites video download items to the chosen rendition. `mediaFor(item)` returns the archived media
 * record (with variants) for an item, or null. Items keep their identity fields; only url/mime change.
 */
export function applyVideoQuality(items, mediaFor, quality = 'highest') {
  if (!quality || quality === 'highest') return items;
  return items.map(item => {
    const type = String(item?.sourceMediaType || item?.mediaType || '');
    if (type !== 'video' || item.quality === 'original') return item;
    const media = mediaFor(item);
    const chosen = pickVariant(media?.variants, item.quality || quality);
    if (!chosen || chosen.url === item.url) return item;
    return {
      ...item,
      url: chosen.url,
      mime: chosen.contentType || item.mime,
      videoQuality: item.quality || quality,
      variantHeight: variantHeight(chosen),
    };
  });
}

/** Why the queue should not start new downloads right now (null when it may). */
export function holdReason(settings, now = Date.now(), connection = globalThis.navigator?.connection) {
  if (settings.downloadWindowEnabled && !insideWindow(now, settings.downloadWindowStart, settings.downloadWindowEnd))
    return {
      code: 'window',
      message: `Downloads run between ${settings.downloadWindowStart} and ${settings.downloadWindowEnd}`,
      retryInMs: msUntilWindow(now, settings.downloadWindowStart, settings.downloadWindowEnd),
    };
  if (settings.downloadRespectSaveData && connection?.saveData)
    return { code: 'save-data', message: 'Data Saver is on — downloads wait until it is off', retryInMs: 60000 };
  // Desktop Chrome does not say whether it is on Wi-Fi; where the browser does (ChromeOS, Android,
  // some Linux builds) a cellular link holds the queue, as does a 2G-class connection.
  if (settings.downloadRespectSaveData && connection?.type === 'cellular')
    return {
      code: 'cellular',
      message: 'On a mobile connection — downloads wait for Wi-Fi or Ethernet',
      retryInMs: 60000,
    };
  if (settings.downloadRespectSaveData && /^(slow-2g|2g)$/.test(String(connection?.effectiveType || '')))
    return {
      code: 'slow',
      message: 'The connection is very slow — downloads wait until it improves',
      retryInMs: 60000,
    };
  return null;
}

/**
 * Keeps the average transfer rate under `capMBps` by pausing active Chrome downloads for short
 * periods (chrome.downloads cannot throttle a transfer directly). `sample()` is called on a timer.
 */
export function createBandwidthGovernor({ chromeApi = globalThis.chrome, activeIds, getCap, now = () => Date.now() }) {
  let last = null,
    pausedUntil = 0,
    paused = new Set(),
    measured = 0;
  async function readBytes(ids) {
    let total = 0;
    for (const id of ids) {
      const [item] = await chromeApi.downloads.search({ id }).catch(() => []);
      total += Number(item?.bytesReceived) || 0;
    }
    return total;
  }
  async function resumeAll() {
    for (const id of paused) await chromeApi.downloads.resume(id).catch(() => {});
    paused = new Set();
    pausedUntil = 0;
  }
  async function sample() {
    const cap = Number(await getCap()) || 0,
      ids = [...activeIds()].filter(id => Number.isFinite(id) && id > 0);
    if (!cap || !ids.length) {
      if (paused.size) await resumeAll();
      last = null;
      return { capped: false, rate: 0 };
    }
    const at = now();
    if (paused.size) {
      if (at < pausedUntil) return { capped: true, rate: measured };
      await resumeAll();
      last = { at, bytes: await readBytes(ids) };
      return { capped: false, rate: measured };
    }
    const bytes = await readBytes(ids);
    if (last && at > last.at) {
      const rate = Math.max(0, bytes - last.bytes) / ((at - last.at) / 1000) / 1048576;
      measured = rate;
      if (rate > cap) {
        // Pause long enough that the average over (window + pause) meets the cap.
        const pauseMs = Math.min(15000, Math.round((at - last.at) * (rate / cap - 1)));
        if (pauseMs >= 250) {
          for (const id of ids) {
            const ok = await chromeApi.downloads
              .pause(id)
              .then(() => true)
              .catch(() => false);
            if (ok) paused.add(id);
          }
          pausedUntil = at + pauseMs;
          last = null;
          return { capped: true, rate, pauseMs };
        }
      }
    }
    last = { at, bytes };
    return { capped: false, rate: measured };
  }
  return {
    sample,
    resumeAll,
    status: () => ({
      pausedFor: Math.max(0, pausedUntil - now()),
      paused: paused.size,
      rateMBps: Math.round(measured * 100) / 100,
    }),
    isPausedByCap: id => paused.has(id),
  };
}

const hostOf = url => {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return 'unknown';
  }
};
const durationOf = row => {
  const history = Array.isArray(row.history) ? row.history : [];
  const started = history.filter(entry => entry.to === 'downloading').at(-1)?.at;
  const finished = history.filter(entry => entry.to === 'complete' || entry.to === 'verifying').at(-1)?.at;
  return started && finished && finished > started ? finished - started : 0;
};

/** Per-host download reliability from download rows. */
export function hostHealth(rows, { now = Date.now(), recentDays = 14 } = {}) {
  const hosts = new Map(),
    since = now - recentDays * 86400000;
  for (const row of rows) {
    const host = hostOf(row.item?.url);
    const entry = hosts.get(host) || {
      host,
      total: 0,
      complete: 0,
      failed: 0,
      queued: 0,
      retries: 0,
      bytes: 0,
      durationMs: 0,
      timed: 0,
      recentFailures: 0,
      reasons: {},
    };
    entry.total++;
    if (row.state === 'complete') {
      entry.complete++;
      entry.bytes += Number(row.totalBytes) || 0;
      const ms = durationOf(row);
      if (ms) ((entry.durationMs += ms), entry.timed++);
    } else if (row.state === 'failed') {
      entry.failed++;
      const reason = String(row.failureReason || row.error || 'unknown').slice(0, 60);
      entry.reasons[reason] = (entry.reasons[reason] || 0) + 1;
      if (Number(row.updatedAt || 0) >= since) entry.recentFailures++;
    } else if (['queued', 'downloading', 'retry-wait', 'paused', 'verifying', 'converting'].includes(row.state))
      entry.queued++;
    entry.retries += Math.max(0, (Number(row.attempts) || 0) - 1);
    hosts.set(host, entry);
  }
  return [...hosts.values()]
    .map(entry => {
      const finished = entry.complete + entry.failed;
      const successRate = finished ? entry.complete / finished : 1;
      const avgMBps = entry.durationMs ? entry.bytes / 1048576 / (entry.durationMs / 1000) : 0;
      return {
        ...entry,
        successRate: Math.round(successRate * 1000) / 10,
        avgFileMB: entry.complete ? Math.round((entry.bytes / entry.complete / 1048576) * 100) / 100 : 0,
        avgMBps: Math.round(avgMBps * 100) / 100,
        topReasons: Object.entries(entry.reasons)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([reason, count]) => ({ reason, count })),
        status: successRate < 0.7 ? 'poor' : successRate < 0.92 || entry.recentFailures > 10 ? 'fair' : 'good',
      };
    })
    .sort((a, b) => b.total - a.total);
}

/**
 * Completed downloads that hold the same bytes (same SHA-256, or same media asset and size).
 * A verified copy is preferred, then the oldest one; the others are reclaimable. Already reclaimed
 * rows are ignored. Each group lists Chrome download ids.
 */
export function duplicateReport(rows, { assetOf = () => '' } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (row.state !== 'complete' || !(Number(row.downloadId) > 0) || row.reclaimedAt || row.linkedAt) continue;
    if (['missing', 'corrupt', 'mismatch'].includes(row.verification?.state)) continue;
    const size = Number(row.totalBytes) || 0;
    const key = row.sha256 ? `sha:${row.sha256}` : assetOf(row) && size ? `asset:${assetOf(row)}:${size}` : '';
    if (!key) continue;
    (groups.get(key) || groups.set(key, []).get(key)).push(row);
  }
  const out = [];
  let reclaimable = 0,
    files = 0;
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) =>
        (b.verification?.state === 'verified') - (a.verification?.state === 'verified') ||
        Number(a.updatedAt || 0) - Number(b.updatedAt || 0)
    );
    const [keep, ...extra] = sorted;
    const bytes = extra.reduce((sum, row) => sum + (Number(row.totalBytes) || 0), 0);
    reclaimable += bytes;
    files += extra.length;
    out.push({
      key,
      confidence: key.startsWith('sha:') ? 'identical bytes' : 'same media and size',
      keep: {
        key: keep.key,
        downloadId: keep.downloadId,
        file: keep.target?.filename || keep.filename || '',
        tweetId: keep.item?.tweetId || '',
      },
      remove: extra.map(row => ({
        key: row.key,
        downloadId: row.downloadId,
        file: row.target?.filename || row.filename || '',
        tweetId: row.item?.tweetId || '',
        bytes: Number(row.totalBytes) || 0,
      })),
      bytes,
    });
  }
  return { groups: out.sort((a, b) => b.bytes - a.bytes), reclaimable, files };
}

/** True when a scheduled integrity re-verification is due. */
export function integrityDue(settings, lastRunAt, now = Date.now()) {
  const days = Number(settings.integrityScheduleDays) || 0;
  return days > 0 && now - (Number(lastRunAt) || 0) >= days * 86400000;
}
