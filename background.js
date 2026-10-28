import {
  canTransition,
  canTransitionArchive,
  classifyRetryReason,
  classifyVerification,
  expectedKind,
  matchRecoveryDownload,
} from './reliability.mjs';
import {
  readLibraryPage,
  readLibraryRecords,
  readLibraryMetadata,
  readDownloadRows,
  readDownloadHistoryPage,
  readDownloadRowsByStatePage,
  readDownloadRowsByKeys,
  readExistingDownloadRowsByAssets,
  findCompletedDownloadByHash,
  readDownloadRowByBrowserId,
  patchLibraryDownloadRowsIfCurrent,
  readLibraryQueryPage,
  readLibraryRevision,
  readLibraryDownloadRevision,
  clearLibraryData,
  updateLibraryMetadata,
  updateLibraryRecord,
  updateLibraryMediaMetadata,
  previewLibraryMediaSidecar,
  importLibraryMediaSidecar,
  writeLibraryDownloads,
  deleteLibraryDownloadsByState,
  deleteCompletedDownloadIfEligible,
  mergeLibraryCapture,
  readTrashPage,
  readTrashUndo,
  mergeTrashMetadata,
  moveLibraryToTrash,
  restoreLibraryFromTrash,
  readLibraryBackupPage,
  previewArchiveImportBatch,
  beginArchiveImport,
  commitArchiveImportBatch,
  completeArchiveImport,
  getArchiveImportJob,
  findArchiveImportJob,
  readArchiveImportConflicts,
  readArchiveAssetReferences,
  readDownloadAssetIndexStatus,
  backfillDownloadAssetIndexPage,
  withDownloadAssetLookup,
  emptyDownloadStateCounts,
  DOWNLOAD_ASSET_INDEX_CHECKPOINT,
} from './library-storage.mjs';
import { mergeCapturedRecord } from './library-capture.mjs';
import { mediaIdentity, assetIdentity, decideEnqueue } from './download-identity.mjs';
import { browserDownloadQuery, chooseBrowserDownload } from './download-preflight.mjs';
import { projectRemoteViews } from './remote-views.mjs';
import { planRemoteDownload, remoteMediaVersion } from './remote-download.mjs';
import { linkSharedFile } from './media-associations.mjs';
import './workspace-model.js';
import { createWorkspaceService } from './workspace-service.mjs';
import { replaceCompletedDownloadWithHistory, reserveLibraryDownload } from './library-storage.mjs';
import { authorizeMessage } from './message-boundary.mjs';
import { buildArchiveIndicators } from './archive-indicators.mjs';
import './library-collections.js';
import { createSmartCollectionService } from './smart-collection-service.mjs';
import { readResponsePrefix, readResponseBytesBounded, verifyDerivativeResponse } from './media-verification.mjs';
const metadataChannel = new BroadcastChannel('xvault-library-metadata');
const remoteQueryPlans = new Map();
const activeRemoteSearches = new Map();
const rankedLibraryPlanCache = new LibraryRankPlanCache({ maxPlans: 3, maxRanks: MAX_LIBRARY_RANKS });
function cancelActiveRemoteSearches() {
  cancelRemoteQueries(activeRemoteSearches);
}
function announceMetadata(ids) {
  if (ids?.length) {
    remoteQueryPlans.clear();
    cancelActiveRemoteSearches();
    invalidateActiveLibraryQueries();
    metadataChannel.postMessage({ ids: ids.map(String) });
  }
}
const libraryChangesChannel = new BroadcastChannel('xvault-library-changes');
function announceLibraryChanges(ids, kind = 'metadata', forceTruncated = false) {
  const unique = ids?.length ? [...new Set(ids.map(String))] : [],
    truncated = forceTruncated || unique.length > 1000;
  remoteQueryPlans?.clear?.();
  cancelActiveRemoteSearches();
  invalidateActiveLibraryQueries();
  libraryChangesChannel.postMessage({
    ...(unique.length ? { ids: unique.slice(0, 1000) } : {}),
    ...(truncated ? { truncated: true } : {}),
    kind,
    at: Date.now(),
  });
}
const privateStorageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
// Explicit capture/UI preferences; helper credentials, saved views and local paths stay private.
const contentSettingKeys = [
  'safeMode',
  'reducedMotion',
  'animations',
  'captureWhileBrowsing',
  'checkpointResume',
  'completionNotifications',
  'completionVerification',
  'copiedTextLimit',
  'copyAltAction',
  'copyButtonPosition',
  'copyButtonVisibility',
  'copyFormat',
  'copyPreserveQuery',
  'copyStripTracking',
  'copyMiddleAction',
  'copyShiftAction',
  'copySuccessDuration',
  'copyToast',
  'cornerBottom',
  'cornerDraggable',
  'cornerOpacity',
  'cornerRight',
  'cornerScale',
  'cornerSnap',
  'customLinkHost',
  'directPageDelay',
  'directPageJitter',
  'firstPageTimeout',
  'floatingAutoHide',
  'floatingHoverPanel',
  'floatingMode',
  'fullMirrorMode',
  'includeTweetTextOnCopy',
  'incrementalSync',
  'inlineDownloadButton',
  'instantCopyButton',
  'linkProvider',
  'maxPages',
  'mirrorMode',
  'motionLevel',
  'motionSpeed',
  'pageSize',
  'preventSleepDuringTasks',
  'scrollDelay',
  'scrollIdleRounds',
  'scrollStep',
  'showFloatingButton',
  'showQueueBadge',
  'showSideDock',
  'showStaleContextNotice',
  'sideDockCollapsed',
  'smartFallback',
  'suppressDiscordEmbed',
  'verificationPasses',
  'xArchiveButtonEnabled',
  'xCleanupEnabled',
  'xCompactPosts',
  'xCopyLinkEnabled',
  'xHideGrok',
  'xHidePremium',
  'xHidePromoted',
  'xHideTrends',
  'xHideWhoToFollow',
  'xIntegrationEnabled',
  'xModifierActions',
  'xPowerMenuEnabled',
];
let templateWriteTail = Promise.resolve();
// Session-bound credentials must never be written to disk with GraphQL templates. The page hook
// re-reads the live CSRF token from the ct0 cookie when it replays a template.
const TEMPLATE_SECRET_HEADERS = /^(cookie|content-length|host|x-csrf-token)$/i;
function sanitizeTemplate(template) {
  const headers = {};
  for (const [name, value] of Object.entries(template?.headers || {}))
    if (name && !TEMPLATE_SECRET_HEADERS.test(name)) headers[name] = String(value ?? '');
  return { ...template, headers };
}
async function scrubStoredTemplates() {
  const stored = (await chrome.storage.local.get('graphqlTemplates')).graphqlTemplates || {};
  const dirty = Object.values(stored).some(t =>
    Object.keys(t?.headers || {}).some(h => TEMPLATE_SECRET_HEADERS.test(h))
  );
  if (!dirty) return;
  const next = Object.fromEntries(Object.entries(stored).map(([k, t]) => [k, sanitizeTemplate(t)]));
  await chrome.storage.local.set({ graphqlTemplates: next });
}
scrubStoredTemplates().catch(() => {});
function storeCaptureTemplates(incoming) {
  const task = templateWriteTail.then(async () => {
    const previous = (await chrome.storage.local.get('graphqlTemplates')).graphqlTemplates || {},
      next = { ...previous };
    for (const template of incoming) next[template.operation] = sanitizeTemplate(template);
    await chrome.storage.local.set({ graphqlTemplates: next });
    return { ok: true };
  });
  templateWriteTail = task.catch(() => {});
  return task;
}
function contentSettings(value) {
  return Object.fromEntries(contentSettingKeys.filter(key => key in value).map(key => [key, value[key]]));
}

import {
  createRemotePlanner,
  pageRemotePlan,
  remotePlanIsCurrent,
  encodeRemotePageCursor,
  decodeRemotePageCursor,
  remotePageCursorId,
} from './remote-library.mjs';
import { readRemoteCursorPage } from './remote-cursor-query.mjs';
import { beginRemoteQuery, releaseRemoteQuery, cancelRemoteQueries } from './remote-query-controls.mjs';
import {
  LibraryRankPlanCache,
  buildLibraryRankPlan,
  pageLibraryRankPlan,
  MAX_LIBRARY_RANKS,
} from './library-ranked-query.mjs';
import { readStoredLibraryPlan, writeStoredLibraryPlan, deleteStoredLibraryPlan } from './library-plan-storage.mjs';
import './link-utils.js';
import './bulk-download-model.js';
import './library-search-core.js';
const DB = 'xvault-db',
  VER = 15,
  STORES = [
    'tweets',
    'users',
    'captures',
    'jobs',
    'downloads',
    'actions',
    'checkpoints',
    'sessions',
    'trash',
    'snapshots',
    'integrity',
    'manifests',
    'collections',
    'conversions',
    'revisions',
    'archiveRuns',
    'mediaAssociations',
  ];
const defaults = {
  settingsVersion: 18,
  startupWorkspaceId: '',
  railWidth: 'normal',
  facetWidth: 'normal',
  inspectorWidth: 'normal',
  startPage: 'last',
  uiFont: 'hanken',
  readFont: 'newsreader',
  accentCustom: '',
  inboxSince: 0,
  libraryTileSize: 260,
  navMode: 'wide',
  theme: 'graphite',
  accentStyle: 'mono',
  animations: true,
  reducedMotion: false,
  uiDensity: 'comfortable',
  dashboardScale: 1,
  highContrastText: true,
  textSharpness: true,
  libraryStableMotion: true,
  archiveDiffs: true,
  archiveRevisionHistory: true,
  timeMachineDefaultWindow: 'all',
  mediaMapLimit: 900,
  motionLevel: 'normal',
  motionPreset: 'smooth',
  motionSpeed: 1,
  motionSpring: 1,
  motionHover: 1,
  motionBackground: false,
  safeMode: false,
  captureWhileBrowsing: true,
  inlineDownloadButton: true,
  instantCopyButton: true,
  instantArchiveButton: true,
  quickActionMenu: true,
  showFloatingButton: true,
  cornerDraggable: true,
  cornerSnap: true,
  cornerRight: 18,
  cornerBottom: 18,
  cornerScale: 1,
  cornerOpacity: 1,
  floatingAutoHide: true,
  floatingAutoHideDelay: 3500,
  floatingMode: 'orb',
  floatingHoverPanel: true,
  showQueueBadge: true,
  showArchiveProgressOnButton: true,
  showSideDock: false,
  sideDockCollapsed: true,
  rememberLastDashboardPage: true,
  lastDashboardPage: 'library',
  rememberArchiveSource: true,
  lastArchiveSource: 'bookmarks',
  smartStart: true,
  autoPrimeHistory: true,
  autoRefreshTemplates: true,
  historyRouteAware: true,
  smartFallback: true,
  firstPageTimeout: 12000,
  directPageDelay: 1100,
  directPageJitter: 450,
  maxPages: 0,
  pageSize: 100,
  scrollDelay: 500,
  scrollIdleRounds: 9,
  scrollStep: 0.82,
  completionVerification: true,
  verificationPasses: 1,
  checkpointResume: true,
  incrementalSync: true,
  incrementalKnownThreshold: 24,
  showCrawlerDiagnostics: true,
  fullMirrorMode: false,
  mirrorMode: 'metadata',
  downloadOriginalImages: true,
  bestVideoQuality: true,
  preferNativeGifWebP: true,
  detectAnimatedWebP: true,
  imageRule: 'always',
  gifRule: 'always',
  videoRule: 'always',
  maxVideoMB: 0,
  minImageWidth: 0,
  minImageHeight: 0,
  skipProfilePictures: true,
  mediaFolder: 'XVault',
  imageFolder: 'Images',
  videoFolder: 'Videos',
  gifFolder: 'GIFs',
  otherFolder: 'Other',
  organizeByType: true,
  organizeByAuthor: false,
  organizeByDate: false,
  organizeByArchiveSource: false,
  forceProfileSubfolder: true,
  profileFolderLayout: 'profile-first',
  fileNaming: 'random',
  randomNameLength: 7,
  customFilenameTemplate: '{author}_{tweetId}_{index}',
  maxConcurrentDownloads: 4,
  downloadRetries: 4,
  retryDelay: 1500,
  skipDuplicateDownloads: true,
  crossPostDuplicates: 'keep',
  hashDedupe: false,
  hashDedupeMaxMB: 24,
  autoRepairQueue: true,
  rebuildTargetOnStart: true,
  retryResetsAttempts: true,
  showDownloadNotifications: true,
  completionNotifications: true,
  preventSleepDuringTasks: false,
  clearCompletedOnSuccess: false,
  showStaleContextNotice: true,
  confirmClearArchive: true,
  confirmCancelQueue: true,
  undoWindowMs: 8000,
  linkProvider: 'fixvx',
  customLinkHost: '',
  copyToast: true,
  copyFormat: 'url',
  copiedTextLimit: 160,
  suppressDiscordEmbed: false,
  shiftCopiesOriginal: true,
  altOpensLink: true,
  xIntegrationEnabled: true,
  xCopyLinkEnabled: true,
  xPowerMenuEnabled: false,
  xArchiveButtonEnabled: false,
  xActivityIslandEnabled: false,
  xModifierActions: true,
  copyStripTracking: true,
  copyPreserveQuery: false,
  copySuccessDuration: 900,
  copyButtonPosition: 'before-share',
  copyButtonVisibility: 'always',
  copyMiddleAction: 'copy-original',
  copyShiftAction: 'copy-original',
  copyAltAction: 'open-transformed',
  xCleanupEnabled: false,
  xHidePromoted: false,
  xHideGrok: false,
  xHideTrends: false,
  xHideWhoToFollow: false,
  xHidePremium: false,
  xCompactPosts: false,
  recentActionsLimit: 220,
  healthCheckOnStartup: true,
  settingsSearchEnabled: true,
  commandPalette: true,
  onboardingComplete: false,
  uiMode: 'basic',
  archiveMap: true,
  liveCharts: true,
  notificationCenter: true,
  globalUndo: true,
  dashboardActivityIsland: true,
  dashboardIslandPosition: 'right',
  libraryView: 'timeline',
  librarySort: 'new',
  librarySensitiveFilter: 'all',
  libraryLazyMedia: true,
  libraryHoverVideo: true,
  libraryTimelineGroups: true,
  libraryBooruSearch: true,
  libraryTags: true,
  libraryFavorites: true,
  libraryNotes: true,
  libraryLightbox: true,
  libraryExportBlock: 5,
  clickAction: 'dashboard',
  preferredAnimationFormat: 'both',
  convertAnimatedMp4: true,
  convertAnimationGif: true,
  convertAnimationWebP: true,
  keepConversionSource: true,
  conversionFps: 20,
  conversionMaxWidth: 1280,
  conversionWebPQuality: 90,
  animationOriginalFolder: 'Originals',
  animationGifFolder: 'GIF',
  animatedWebPFolder: 'WebP',
  nativeGifFolder: 'GIF',
  preferLocalConvertedAnimationPreviews: true,
  libraryAnimationMode: 'native',
  requestBrain: true,
  rateLimitHealth: true,
  networkAutoPause: true,
  archiveConfidence: true,
  archiveSessions: true,
  sourceSeparation: true,
  profileRootFolder: 'Profiles',
  folderTemplate: '{source}/{author}/{mediaType}',
  rememberLibraryQuery: true,
  lastLibraryQuery: '',
  showRecommendedBadges: true,
  advancedTooltips: true,
  showWhyButtons: true,
  recentProfiles: [],
  pinnedProfiles: [],
  savedViews: [],
  quietCompletionOnly: false,
  dashboardSounds: true,
  soundVolume: 0.14,
  customCursor: true,
  cursorStyle: 'dot',
  buttonRipple: true,
  hoverTilt: false,
  glassBlur: 8,
  cornerRadius: 20,
  accentHue: 0,
  cursorClickSprite: true,
  libraryAutoplayAnimated: true,
  libraryVideoControls: true,
  libraryVideoMuted: false,
  rememberLibraryVolume: true,
  libraryVolume: 0.72,
  libraryVideoHoverReset: false,
  libraryPreloadMedia: 'metadata',
  libraryShowAvatars: true,
  libraryShowNames: true,
  libraryShowMetrics: true,
  libraryMediaSize: 'comfortable',
  libraryPageSize: 120,
  libraryOpenOnClick: true,
  libraryFitImages: true,
  libraryLightboxZoom: 100,
  libraryZoomMax: 1200,
  libraryZoomStep: 20,
  libraryArrowNavigation: true,
  libraryWheelPan: true,
  libraryWheelZoom: false,
  libraryClickZoom: 175,
  libraryShowFormat: true,
  libraryShowDimensions: true,
  animatedMediaFolderMode: 'gifs',
  preserveNativeAnimatedFormat: true,
  preferNativeAnimatedSource: true,
  probeMediaBytes: 524288,
  downloadPriorityDefault: 'normal',
  quietMode: false,
  downloadWatchdogSeconds: 90,
  verificationMismatchPolicy: 'retry',
  verificationMissingPolicy: 'retry',
  verifyConversions: true,
  smartRetry: true,
  helperPort: 17843,
  helperAutoDetect: true,
  helperPreferHttpPreview: true,
  profileCollections: [],
  profileArchiveMode: 'complete',
  archiveEverythingIncludesMedia: false,
  integrityAutoScan: false,
  trashRetentionDays: 30,
  autoSnapshots: true,
  sidecarMetadata: false,
  archiveLockProtection: true,
  portableExportMediaLinks: true,
  remoteEnabled: false,
  remotePort: 18765,
};
const queue = [],
  queuedKeys = new Set(),
  active = new Map(),
  verifyingDownloads = new Set();
const MAX_QUEUED_BUFFER = 96,
  DOWNLOAD_ASSET_INDEX_ALARM = 'xvault-download-asset-index';
let pumping = false,
  keepAwake = false,
  helperConnectionState = null,
  queueFillKey = null,
  queueEpoch = 0,
  queuePumpScheduled = false,
  queuePumpRetryTimer = 0,
  queuePumpFailure = null,
  downloadAssetIndexFailure = null,
  downloadAssetIndexTask = null,
  lastQueueRecovery = { pages: 0, recordsRead: 0, maxPage: 0 };
const retryTimers = new Map(),
  runFinalizeTimers = new Map(),
  downloadEventTails = new Map();
function queueRow(row) {
  const key = String(row?.key || '');
  if (!key || active.has(key) || queuedKeys.has(key)) return false;
  if (queue.length >= MAX_QUEUED_BUFFER) return false;
  queue.push(row);
  queuedKeys.add(key);
  return true;
}
function takeQueuedRow() {
  const row = queue.shift();
  if (row?.key != null) queuedKeys.delete(String(row.key));
  return row || null;
}
function clearQueueBuffer() {
  queue.length = 0;
  queuedKeys.clear();
  queueFillKey = null;
  queueEpoch++;
}
function scheduleQueuePump() {
  if (queuePumpScheduled) return;
  queuePumpScheduled = true;
  setTimeout(() => {
    queuePumpScheduled = false;
    void pump();
  }, 0);
}
async function fillQueueBuffer() {
  if (queue.length >= MAX_QUEUED_BUFFER) return { more: true, recordsRead: 0 };
  const epoch = queueEpoch;
  let recordsRead = 0,
    more = false,
    rounds = 0;
  while (queue.length < MAX_QUEUED_BUFFER && rounds < 4 && recordsRead < 256) {
    rounds++;
    const before = queue.length,
      after = queueFillKey,
      database = await db();
    let page;
    try {
      page = await readDownloadRowsByStatePage(database, 'queued', {
        limit: Math.min(64, MAX_QUEUED_BUFFER - queue.length, 256 - recordsRead),
        afterKey: after,
      });
    } finally {
      database.close();
    }
    if (epoch !== queueEpoch) return { more: false, recordsRead };
    recordsRead += page.recordsRead;
    for (const row of page.rows) queueRow(row);
    if (queue.length > before) {
      queueFillKey = page.hasMore ? page.nextKey : null;
      more = page.hasMore;
      break;
    }
    if (page.hasMore) {
      queueFillKey = page.nextKey;
      more = true;
      continue;
    }
    more = false;
    if (after != null) {
      queueFillKey = null;
      continue;
    }
    break;
  }
  return { more, recordsRead };
}
async function forEachDownloadStatePage(state, visit, limit = 32) {
  let afterKey = null,
    hasMore = true,
    pages = 0,
    recordsRead = 0,
    cursorOperations = 0,
    maxPage = 0;
  while (hasMore) {
    const page = await downloadStatePage(state, afterKey, limit);
    pages++;
    recordsRead += page.recordsRead;
    cursorOperations += page.cursorOperations;
    maxPage = Math.max(maxPage, page.rows.length);
    if (!page.rows.length) break;
    for (const row of page.rows) await visit(row);
    afterKey = page.nextKey;
    hasMore = page.hasMore;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { pages, recordsRead, cursorOperations, maxPage };
}
const retryAlarmName = key => `xvault-retry-${encodeURIComponent(String(key))}`;
async function clearRetrySchedule(key) {
  const name = retryAlarmName(key);
  const timer = retryTimers.get(name);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(name);
  }
  try {
    await chrome.alarms.clear(name);
  } catch {}
}
async function scheduleRetry(row, delay) {
  const when = Date.now() + Math.max(250, delay),
    name = retryAlarmName(row.key);
  row.nextAttemptAt = when;
  await putMany('downloads', [row]);
  await clearRetrySchedule(row.key);
  try {
    await chrome.alarms.create(name, { when });
  } catch {
    const timer = setTimeout(
      async () => {
        retryTimers.delete(name);
        const fresh = await store('downloads', 'readonly', os => req(os.get(row.key))).catch(() => null);
        if (!fresh || fresh.state !== 'retry-wait') return;
        fresh.nextAttemptAt = null;
        transitionDownload(fresh, 'queued');
        await putMany('downloads', [fresh]);
        queueRow(fresh);
        pump();
      },
      Math.max(250, delay)
    );
    retryTimers.set(name, timer);
  }
}
function transitionDownload(row, next, patch = {}) {
  if (!row) return false;
  if (!canTransition(row.state, next)) {
    row.transitionWarning = { from: row.state, to: next, at: Date.now() };
    (row.history ||= []).push({ at: Date.now(), from: row.state, to: next, refused: true });
    if (row.history.length > 16) row.history.splice(0, row.history.length - 16);
    return false;
  }
  (row.history ||= []).push({ at: Date.now(), from: row.state, to: next, attempt: row.attempts || 0 });
  if (row.history.length > 16) row.history.splice(0, row.history.length - 16);
  Object.assign(row, patch, { state: next, stateRevision: Number(row.stateRevision || 0) + 1, updatedAt: Date.now() });
  return true;
}

const databaseOpenTelemetry = new WeakMap();
const db = () =>
  new Promise((ok, no) => {
    const openStarted = performance.now();
    let schemaStarted = 0,
      settled = false;
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = event => {
      schemaStarted = performance.now();
      const d = r.result;
      if (!d.objectStoreNames.contains('tweets')) {
        const s = d.createObjectStore('tweets', { keyPath: 'id' });
        s.createIndex('archivedAt', 'archivedAt');
        s.createIndex('handle', 'author.handle');
      }
      if (!d.objectStoreNames.contains('users')) d.createObjectStore('users', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('captures')) d.createObjectStore('captures', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('downloads')) {
        const s = d.createObjectStore('downloads', { keyPath: 'key' });
        s.createIndex('state', 'state');
        s.createIndex('createdAt', 'createdAt');
      }
      const downloads = r.transaction.objectStore('downloads');
      if (!downloads.indexNames.contains('tweetId')) downloads.createIndex('tweetId', 'item.tweetId');
      if (!downloads.indexNames.contains('stateKey')) downloads.createIndex('stateKey', ['state', 'key']);
      if (!downloads.indexNames.contains('downloadId')) downloads.createIndex('downloadId', 'downloadId');
      if (!downloads.indexNames.contains('usableAssetKey')) downloads.createIndex('usableAssetKey', 'usableAssetKey');
      if (!d.objectStoreNames.contains('mediaAssociations')) {
        const links = d.createObjectStore('mediaAssociations', { keyPath: 'id' });
        links.createIndex('tweetId', 'tweetId');
        links.createIndex('downloadKey', 'downloadKey');
      }
      if (!d.objectStoreNames.contains('actions')) {
        const s = d.createObjectStore('actions', { keyPath: 'id' });
        s.createIndex('at', 'at');
      }
      if (!d.objectStoreNames.contains('checkpoints')) d.createObjectStore('checkpoints', { keyPath: 'key' });
      const checkpoints = r.transaction.objectStore('checkpoints'),
        assetIndexState = checkpoints.get(DOWNLOAD_ASSET_INDEX_CHECKPOINT);
      assetIndexState.onsuccess = () => {
        const fresh = event.oldVersion === 0;
        checkpoints.put({
          ...assetIndexState.result,
          key: DOWNLOAD_ASSET_INDEX_CHECKPOINT,
          complete: fresh,
          countsComplete: fresh,
          afterKey: null,
          processed: 0,
          stateCounts: emptyDownloadStateCounts(),
          stateCounterVersion: 1,
          updatedAt: Date.now(),
        });
      };
      if (!d.objectStoreNames.contains('sessions')) {
        const s = d.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
      }
      if (!d.objectStoreNames.contains('trash')) {
        const s = d.createObjectStore('trash', { keyPath: 'id' });
        s.createIndex('deletedAt', 'deletedAt');
      }
      if (!d.objectStoreNames.contains('snapshots')) {
        const s = d.createObjectStore('snapshots', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains('integrity')) d.createObjectStore('integrity', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('manifests')) {
        const s = d.createObjectStore('manifests', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains('collections')) d.createObjectStore('collections', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('conversions')) {
        const s = d.createObjectStore('conversions', { keyPath: 'id' });
        s.createIndex('state', 'state');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains('revisions')) {
        const s = d.createObjectStore('revisions', { keyPath: 'key' });
        s.createIndex('tweetId', 'tweetId');
        s.createIndex('observedAt', 'observedAt');
      }
      if (!d.objectStoreNames.contains('archiveRuns')) {
        const s = d.createObjectStore('archiveRuns', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
        s.createIndex('state', 'state');
      }
      if (!d.objectStoreNames.contains('libraryPlans')) {
        const s = d.createObjectStore('libraryPlans', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      const archiveImports = d.objectStoreNames.contains('archiveImports')
        ? r.transaction.objectStore('archiveImports')
        : d.createObjectStore('archiveImports', { keyPath: 'id' });
      if (!archiveImports.indexNames.contains('importId')) archiveImports.createIndex('importId', 'importId');
      if (!archiveImports.indexNames.contains('importFingerprint'))
        archiveImports.createIndex('importFingerprint', ['importId', 'fingerprint']);
      if (!archiveImports.indexNames.contains('importKindKey'))
        archiveImports.createIndex('importKindKey', ['importId', 'kind', 'id']);
      if (!archiveImports.indexNames.contains('at')) archiveImports.createIndex('at', 'at');
    };
    r.onblocked = () => {
      if (settled) return;
      settled = true;
      no(
        new Error(
          'XVault storage is waiting for another open XVault tab. Close the other tab or window, then retry the Library.'
        )
      );
    };
    r.onsuccess = () => {
      const database = r.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      databaseOpenTelemetry.set(database, {
        databaseOpenMs: performance.now() - openStarted,
        schemaPreparationMs: schemaStarted ? performance.now() - schemaStarted : 0,
        schemaUpgraded: !!schemaStarted,
      });
      ok(database);
    };
    r.onerror = () => {
      if (settled) return;
      settled = true;
      no(r.error || new Error('Could not open XVault storage'));
    };
  });
const req = r =>
  new Promise((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
async function store(name, mode, fn) {
  const d = await db();
  return new Promise((ok, no) => {
    let t,
      settled = false,
      val;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      d.close();
      error ? no(error) : ok(result);
    };
    try {
      t = d.transaction(name, mode);
      const s = t.objectStore(name);
      t.oncomplete = () => finish(null, val);
      t.onerror = () => finish(t.error || new Error('Database transaction failed'));
      t.onabort = () => finish(t.error || new Error('Database transaction aborted'));
      let operation;
      try {
        operation = fn(s);
      } catch (error) {
        try {
          t.abort();
        } catch {}
        finish(error);
        return;
      }
      Promise.resolve(operation).then(
        result => {
          val = result;
        },
        error => {
          try {
            t.abort();
          } catch {}
          finish(error);
        }
      );
    } catch (error) {
      finish(error);
    }
  });
}
const putMany = (n, a) =>
  !a?.length
    ? 0
    : n === 'downloads'
      ? db().then(async database => {
          try {
            const result = await writeLibraryDownloads(database, a);
            if (result.changedIds.length || result.truncated)
              announceLibraryChanges(result.changedIds, 'download', result.truncated);
            return result.written;
          } finally {
            database.close();
          }
        })
      : store(n, 'readwrite', s => {
          for (const x of a) s.put(x);
          return a.length;
        });
async function scheduleDownloadAssetIndexBackfill() {
  try {
    await chrome.alarms.create(DOWNLOAD_ASSET_INDEX_ALARM, { when: Date.now() + 30_000 });
  } catch {}
}
async function runDownloadAssetIndexBackfill() {
  if (downloadAssetIndexTask) return downloadAssetIndexTask;
  downloadAssetIndexTask = (async () => {
    let status;
    const initial = await db();
    try {
      status = await readDownloadAssetIndexStatus(initial);
    } finally {
      initial.close();
    }
    if (status.complete && status.countsComplete) {
      downloadAssetIndexFailure = null;
      try {
        await chrome.alarms.clear(DOWNLOAD_ASSET_INDEX_ALARM);
      } catch {}
      return status;
    }
    await scheduleDownloadAssetIndexBackfill();
    for (let page = 0; page < 16; page++) {
      const database = await db();
      try {
        status = await backfillDownloadAssetIndexPage(database, { limit: 512 });
      } finally {
        database.close();
      }
      if (status.complete) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (status?.complete && status?.countsComplete) {
      downloadAssetIndexFailure = null;
      try {
        await chrome.alarms.clear(DOWNLOAD_ASSET_INDEX_ALARM);
      } catch {}
    } else await scheduleDownloadAssetIndexBackfill();
    return status || { complete: false, processed: 0 };
  })()
    .catch(async error => {
      downloadAssetIndexFailure = { at: Date.now(), reason: String(error?.message || error) };
      await action('recovery', 'Save Once lookup index backfill needs attention', {
        reason: downloadAssetIndexFailure.reason,
      }).catch(() => {});
      await scheduleDownloadAssetIndexBackfill();
      return { complete: false, error: downloadAssetIndexFailure.reason };
    })
    .finally(() => {
      downloadAssetIndexTask = null;
    });
  return downloadAssetIndexTask;
}
const all = n => store(n, 'readonly', s => req(s.getAll()));
const count = n => store(n, 'readonly', s => req(s.count()));
function normalizeSettings(raw = {}) {
  const legacyVersion = Number(raw.settingsVersion || 0);
  let migrated =
    legacyVersion < 11
      ? {
          ...raw,
          hoverTilt: false,
          glassBlur: Math.min(8, Number(raw.glassBlur) || 8),
          highContrastText: true,
          textSharpness: true,
          libraryStableMotion: true,
          libraryFitImages: true,
        }
      : raw;
  if (legacyVersion < 13) {
    migrated = {
      ...migrated,
      animationOriginalFolder:
        !raw.animationOriginalFolder || raw.animationOriginalFolder === 'MP4'
          ? 'Originals'
          : raw.animationOriginalFolder,
      animationGifFolder:
        !raw.animationGifFolder || raw.animationConvertedFolder === 'Converted'
          ? 'GIF'
          : raw.animationGifFolder || raw.animationConvertedFolder,
      animatedWebPFolder:
        !raw.animatedWebPFolder || raw.animatedWebPFolder === 'WebPs' ? 'WebP' : raw.animatedWebPFolder,
      nativeGifFolder: !raw.nativeGifFolder || raw.nativeGifFolder === 'Native' ? 'GIF' : raw.nativeGifFolder,
      convertAnimationGif: true,
      convertAnimationWebP: true,
      preferredAnimationFormat: 'both',
      libraryAnimationMode: raw.libraryAnimationMode || 'native',
      rememberLibraryVolume: raw.rememberLibraryVolume !== false,
      libraryVideoHoverReset: false,
    };
  }
  if (legacyVersion < 14) {
    migrated = {
      ...migrated,
      smartRetry: true,
      downloadWatchdogSeconds: 90,
      helperPort: 17843,
      helperAutoDetect: true,
      helperPreferHttpPreview: true,
      libraryZoomMax: 1200,
    };
  }
  if (legacyVersion < 15) {
    migrated = {
      ...migrated,
      archiveDiffs: true,
      archiveRevisionHistory: true,
      timeMachineDefaultWindow: 'all',
      mediaMapLimit: 900,
    };
  }
  if (legacyVersion < 16) {
    migrated = {
      ...migrated,
      linkProvider: raw.linkProvider === 'fixupx' ? 'fixvx' : raw.linkProvider || 'fixvx',
      xIntegrationEnabled: true,
      xCopyLinkEnabled: raw.instantCopyButton !== false,
      xPowerMenuEnabled: false,
      xArchiveButtonEnabled: false,
      xActivityIslandEnabled: false,
      xModifierActions: true,
      copyStripTracking: true,
      copyPreserveQuery: false,
      copySuccessDuration: 900,
      copyButtonPosition: 'before-share',
      copyButtonVisibility: 'always',
      motionLevel: raw.reducedMotion ? 'reduced' : 'normal',
      motionPreset: 'smooth',
      motionSpeed: 1,
      motionSpring: 1,
      motionHover: 1,
      motionBackground: false,
      safeMode: false,
    };
  }
  if (legacyVersion < 16)
    migrated = {
      ...migrated,
      copyMiddleAction: 'copy-original',
      copyShiftAction: raw.shiftCopiesOriginal === false ? 'copy-transformed' : 'copy-original',
      copyAltAction: raw.altOpensLink === false ? 'copy-transformed' : 'open-transformed',
    };
  const out = { ...defaults, ...bulkSettingsDefaults, ...migrated, settingsVersion: 18 };
  delete out.verifyDownloads;
  if (legacyVersion < 18 && Number(raw.libraryPageSize || 0) === 300) out.libraryPageSize = 120;
  for (const [k, d] of Object.entries(defaults)) {
    const v = out[k];
    if (typeof d === 'number' && (v === '' || v == null || !Number.isFinite(Number(v)))) out[k] = d;
    if (typeof d === 'boolean' && typeof v !== 'boolean') out[k] = d;
    if (typeof d === 'string' && v == null) out[k] = d;
    if (Array.isArray(d) && !Array.isArray(v)) out[k] = d;
  }
  const ranges = {
    motionSpeed: [0.35, 2],
    motionSpring: [0, 2],
    motionHover: [0, 2],
    maxConcurrentDownloads: [1, 8],
    downloadRetries: [0, 10],
    retryDelay: [250, 30000],
    randomNameLength: [4, 40],
    directPageDelay: [400, 30000],
    directPageJitter: [0, 10000],
    maxPages: [0, 100000],
    pageSize: [20, 100],
    scrollDelay: [150, 10000],
    scrollIdleRounds: [2, 60],
    scrollStep: [0.25, 2],
    cornerScale: [0.65, 1.8],
    cornerOpacity: [0.2, 1],
    dashboardScale: [0.6, 1.8],
    firstPageTimeout: [4000, 60000],
    verificationPasses: [0, 3],
    incrementalKnownThreshold: [5, 100],
    floatingAutoHideDelay: [500, 30000],
    maxVideoMB: [0, 5000],
    minImageWidth: [0, 10000],
    minImageHeight: [0, 10000],
    hashDedupeMaxMB: [1, 200],
    soundVolume: [0, 1],
    glassBlur: [0, 60],
    cornerRadius: [8, 36],
    accentHue: [0, 360],
    libraryPageSize: [50, 1500],
    librarySearchDebounce: [0, 1000],
    libraryZoomMax: [100, 1200],
    libraryZoomStep: [5, 100],
    libraryClickZoom: [100, 500],
    probeMediaBytes: [65536, 1048576],
    downloadWatchdogSeconds: [20, 600],
    helperPort: [1024, 65535],
    remotePort: [1024, 65535],
  };
  for (const [k, [lo, hi]] of Object.entries(ranges)) {
    let v = Number(out[k]);
    if (!Number.isFinite(v)) v = defaults[k];
    out[k] = Math.min(hi, Math.max(lo, v));
  }
  out.workspaces = globalThis.XVaultWorkspaces.normalizeList(out.workspaces);
  out.toolbarActions = globalThis.XVaultWorkspaces.toolbar(out.toolbarActions);
  out.inspectorPixels = Number(out.inspectorPixels) > 0 ? Math.min(600, Math.max(320, Number(out.inspectorPixels))) : 0;
  if (!['off', 'reduced', 'subtle', 'normal', 'rich', 'extreme'].includes(out.motionLevel)) out.motionLevel = 'normal';
  if (!(Number(out.inboxSince) > 0)) out.inboxSince = Date.now();
  out.libraryTileSize = Math.min(440, Math.max(150, Number(out.libraryTileSize) || 260));
  return out;
}
async function getSettings() {
  const stored = await chrome.storage.local.get('settings'),
    raw =
      stored.settings && typeof stored.settings === 'object' && !Array.isArray(stored.settings) ? stored.settings : {},
    out = normalizeSettings(raw);
  if (JSON.stringify(raw) !== JSON.stringify(out)) await chrome.storage.local.set({ settings: out });
  return out;
}
let settingsWriteTail = Promise.resolve();
function setSettings(p) {
  const patch = { ...p },
    task = settingsWriteTail.then(() => writeSettingsPatch(patch));
  settingsWriteTail = task.catch(() => {});
  return task;
}
async function writeSettingsPatch(p) {
  const cur = await getSettings(),
    next = normalizeSettings({ ...cur, ...p, settingsVersion: 18 });
  const h = (await chrome.storage.local.get('settingsHistory')).settingsHistory || [];
  h.unshift({ at: Date.now(), settings: cur });
  await chrome.storage.local.set({ settings: next, settingsHistory: h.slice(0, 12) });
  if (next.crossPostDuplicates === 'skip') void runDownloadAssetIndexBackfill();
  return next;
}
const updateSmartCollections = createSmartCollectionService({
  readSettings: getSettings,
  writeSettings: writeSettingsPatch,
  collectionApi: globalThis.XVaultCollections,
  enqueue: operation => {
    const task = settingsWriteTail.then(operation);
    settingsWriteTail = task.catch(() => {});
    return task;
  },
});
const updateWorkspace = createWorkspaceService({
  readSettings: getSettings,
  writeSettings: writeSettingsPatch,
  api: globalThis.XVaultWorkspaces,
  enqueue: operation => {
    const task = settingsWriteTail.then(operation);
    settingsWriteTail = task.catch(() => {});
    return task;
  },
});
async function mergeTweetRows(rows = []) {
  let n = 0;
  const changed = [];
  for (const row of rows) {
    if (!row?.id) continue;
    const captureDb = await db();
    try {
      const result = await mergeLibraryCapture(captureDb, row, (current, incoming) =>
        mergeCapturedRecord(current, incoming)
      );
      if (result.stored) {
        n++;
        changed.push(String(row.id));
        if (result.revision)
          void action('revision', `Post ${row.id} changed; prior revision retained`, {
            tweetId: String(row.id),
            runId: row.observedRunId || null,
          }).catch(() => {});
      }
    } finally {
      captureDb.close();
    }
  }
  if (changed.length) announceLibraryChanges(changed, 'capture');
  return n;
}
const activeLibraryQueries = new Map();
const activeLibraryQueryProgress = new Map();
function invalidateActiveLibraryQueries() {
  rankedLibraryPlanCache.clear();
  for (const control of activeLibraryQueries.values()) control.cancelled = true;
}
function stableRandomOrder(id, seed) {
  let value = 2166136261;
  for (const character of `${seed}:${id}`) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
function compareLibraryRank(a, b, sort) {
  const compared = globalThis.XVaultLibrarySearch.compareRows(a, b, sort);
  return compared || String(a.id).localeCompare(String(b.id));
}
async function scanSortedLibraryPage(database, message, settings, control) {
  const sort = String(message.sort || 'new'),
    offset = Math.max(0, Math.floor(Number(message.offset) || 0)),
    limit = Math.max(1, Math.min(1500, Math.floor(Number(message.limit) || 120)));
  const query = String(message.query || '').slice(0, 1000),
    compiled = globalThis.XVaultLibrarySearch.compileQuery(query),
    needsDownloads = globalThis.XVaultLibrarySearch.usesRuleKind(compiled, ['downloaded', 'missing', 'size']);
  const revision = await readLibraryRevision(database),
    downloadRevision = needsDownloads ? await readLibraryDownloadRevision(database) : null;
  if (
    (message.expectedRevision != null && Number(message.expectedRevision) !== revision) ||
    (needsDownloads &&
      message.expectedDownloadRevision != null &&
      Number(message.expectedDownloadRevision) !== downloadRevision)
  )
    return { ok: true, stale: true, revision, downloadRevision, rows: [] };
  const queryId = String(message.queryId || ''),
    planId = String(message.rankPlanId || queryId),
    randomSeed = Number(message.randomSeed) || 1,
    inboxSince = Number(settings.inboxSince) || 0;
  const identityKey = JSON.stringify([query, sort, randomSeed, revision, downloadRevision, inboxSince]);
  let downloadsByTweet = new Map(),
    cursorOperations = 0,
    downloadRowsRead = 0,
    downloadLookupMs = 0;
  const planned = await buildLibraryRankPlan({
    cache: rankedLibraryPlanCache,
    planId,
    identityKey,
    maxRanks: MAX_LIBRARY_RANKS,
    readPage: async (key, batchSize) => {
      const chunk = await readLibraryPage(database, key, batchSize);
      cursorOperations += Number(chunk.cursorOperations || 0);
      downloadsByTweet = new Map();
      if (needsDownloads && chunk.rows.length) {
        const lookupStarted = performance.now(),
          history = await readDownloadRows(
            database,
            chunk.rows.map(row => row.id),
            { perPostLimit: 128, totalLimit: 5000 }
          );
        downloadLookupMs += performance.now() - lookupStarted;
        if (history.truncated)
          throw Error(
            'This archive has unusually large per-post download history. The search stopped before returning incomplete results.'
          );
        for (const row of history) {
          const id = String(row.item?.tweetId || '');
          if (!downloadsByTweet.has(id)) downloadsByTweet.set(id, []);
          downloadsByTweet.get(id).push(row);
        }
        downloadRowsRead += history.length;
      }
      return chunk;
    },
    project: (post, index) =>
      compiled.length
        ? globalThis.XVaultLibrarySearch.projectPost(post, index, {
            downloads: downloadsByTweet.get(String(post.id)) || [],
            inboxSince,
            randomOrder: stableRandomOrder(String(post.id), randomSeed),
          })
        : globalThis.XVaultLibrarySearch.projectRankPost(post, index, {
            randomOrder: stableRandomOrder(String(post.id), randomSeed),
          }),
    matches: projection =>
      !compiled.length || globalThis.XVaultLibrarySearch.matchesCompiledQuery(projection, compiled),
    toRank: (projection, post, index) => ({
      index,
      id: post.id,
      metrics: Object.fromEntries(
        ['likes', 'views', 'bookmarks', 'reposts', 'replies'].map(key => [key, Number(projection.metrics?.[key] || 0)])
      ),
      archivedAt: projection.archivedAt,
      mediaCount: projection.mediaCount,
      handle: projection.handle,
      randomOrder: projection.randomOrder,
    }),
    compare: (a, b) => compareLibraryRank(a, b, sort),
    cancelled: () => control.cancelled,
    onProgress: progress => {
      if (!control.cancelled)
        activeLibraryQueryProgress.set(queryId, { phase: 'scan', ...progress, updatedAt: Date.now() });
    },
    loadPlan: id => readStoredLibraryPlan(database, id),
    savePlan: (id, identity, plan) => writeStoredLibraryPlan(database, id, identity, plan, 3),
    deletePlan: id => deleteStoredLibraryPlan(database, id),
    onCacheError: error => console.warn('Library ranked-plan cache unavailable; the query remains correct.', error),
    isCurrent: async () => {
      const [latest, latestDownloads, currentSettings] = await Promise.all([
        readLibraryRevision(database),
        needsDownloads ? readLibraryDownloadRevision(database) : Promise.resolve(null),
        getSettings(),
      ]);
      return (
        latest === revision &&
        latestDownloads === downloadRevision &&
        (Number(currentSettings.inboxSince) || 0) === inboxSince
      );
    },
  });
  if (planned.cancelled || control.cancelled)
    return { ok: true, cancelled: true, revision, rows: [], scanned: planned.plan?.scanned || 0 };
  if (planned.stale) {
    const latest = await readLibraryRevision(database),
      latestDownloadRevision = needsDownloads ? await readLibraryDownloadRevision(database) : null;
    return { ok: true, stale: true, revision: latest, downloadRevision: latestDownloadRevision, rows: [] };
  }
  const plan = planned.plan,
    rankPage = pageLibraryRankPlan(plan, offset, limit),
    selected = rankPage.ranks;
  activeLibraryQueryProgress.set(queryId, {
    phase: 'materialize',
    scanned: plan.scanned,
    matched: plan.matched,
    rankLimit: plan.rankLimit,
    updatedAt: Date.now(),
  });
  const records = await readLibraryRecords(
      database,
      selected.map(row => row.id)
    ),
    recordsById = new Map(records.map(row => [String(row.id), row])),
    rows = selected.map(rank => recordsById.get(String(rank.id))).filter(Boolean);
  const detailsStarted = performance.now(),
    downloads = await readDownloadRows(
      database,
      rows.map(row => row.id),
      { perPostLimit: 64, totalLimit: 5000 }
    );
  downloadLookupMs += performance.now() - detailsStarted;
  downloadRowsRead += downloads.length;
  const committedRevision = await readLibraryRevision(database),
    committedDownloadRevision = needsDownloads ? await readLibraryDownloadRevision(database) : null;
  if (control.cancelled) return { ok: true, cancelled: true, revision, rows: [], scanned: plan.scanned };
  if (committedRevision !== revision || (needsDownloads && committedDownloadRevision !== downloadRevision)) {
    rankedLibraryPlanCache.delete(planId);
    return {
      ok: true,
      stale: true,
      revision: committedRevision,
      downloadRevision: committedDownloadRevision,
      rows: [],
      scanned: plan.scanned,
    };
  }
  if (rows.length !== selected.length)
    throw Error(
      'A ranked Library result disappeared without a revision change. Restart the query to protect its ordering.'
    );
  return {
    ok: true,
    rows,
    downloads,
    downloadsTruncated: !!downloads.truncated,
    revision,
    downloadRevision,
    totalRecords: plan.scanned,
    matched: plan.matched,
    retained: plan.ranks.length,
    truncated: plan.truncated,
    rankCacheHit: planned.cached,
    done: !rankPage.hasMore,
    hasMore: rankPage.hasMore,
    scanned: planned.cached ? 0 : plan.scanned,
    recordsRead: (planned.cached ? 0 : plan.scanned) + selected.length,
    materialized: (planned.cached ? 0 : plan.scanned) + rows.length,
    cursorOperations,
    downloadRowsRead,
    downloadLookupMs,
    searchProjectionRows: planned.cached ? 0 : plan.scanned,
    returned: rows.length,
    bytesEstimate: JSON.stringify(rows).length * 2,
    index: 'ranked-stream-cache',
    plan: planned.cached
      ? 'revision-matched rank cache · selected records by primary key'
      : 'bounded top-5,000 scan in 128-record IndexedDB pages',
  };
}
async function queryLibraryPage(message = {}) {
  const queryId = String(message.queryId || crypto.randomUUID()),
    control = { cancelled: false };
  activeLibraryQueries.set(queryId, control);
  activeLibraryQueryProgress.set(queryId, { phase: 'starting', scanned: 0, matched: 0, updatedAt: Date.now() });
  try {
    return await executeLibraryPage(message, control);
  } finally {
    if (activeLibraryQueries.get(queryId) === control) activeLibraryQueries.delete(queryId);
    activeLibraryQueryProgress.delete(queryId);
  }
}
async function executeLibraryPage(message = {}, control = { cancelled: false }) {
  const openedAt = performance.now(),
    settingsStarted = performance.now(),
    settings = await getSettings(),
    settingsMs = performance.now() - settingsStarted,
    dbStarted = performance.now(),
    database = await db(),
    databaseOpen = databaseOpenTelemetry.get(database) || {},
    databaseOpenMs = Number(databaseOpen.databaseOpenMs) || performance.now() - dbStarted,
    schemaPreparationMs = Number(databaseOpen.schemaPreparationMs) || 0,
    openMs = settingsMs + databaseOpenMs,
    queryStarted = performance.now();
  const sort = String(message.sort || 'new'),
    query = String(message.query || '').slice(0, 1000),
    limit = Math.max(1, Math.min(1500, Number(message.limit) || 120));
  try {
    const planStarted = performance.now(),
      queryIssues = globalThis.XVaultLibrarySearch.queryIssues(query);
    if (queryIssues.length) {
      const queryPlanningMs = performance.now() - planStarted,
        revision = await readLibraryRevision(database);
      return {
        ok: true,
        rows: [],
        downloads: [],
        revision,
        totalRecords: null,
        matched: 0,
        done: true,
        hasMore: false,
        scanned: 0,
        recordsRead: 0,
        materialized: 0,
        searchProjectionRows: 0,
        returned: 0,
        bytesEstimate: 0,
        index: 'query-validation',
        plan: 'invalid query rejected before scanning',
        issues: queryIssues,
        metrics: {
          openMs,
          settingsMs,
          databaseOpenMs,
          schemaPreparationMs,
          queryPlanningMs,
          queryMs: performance.now() - queryStarted,
          pageReadMs: 0,
          downloadLookupMs: 0,
          totalMs: performance.now() - openedAt,
        },
      };
    }
    if (control.cancelled) return { ok: true, cancelled: true, rows: [] };
    const compiled = globalThis.XVaultLibrarySearch.compileQuery(query),
      needsDownloads = globalThis.XVaultLibrarySearch.usesRuleKind(compiled, ['downloaded', 'missing', 'size']),
      queryPlanningMs = performance.now() - planStarted;
    if (!['new', 'old'].includes(sort)) {
      const pageReadStarted = performance.now(),
        ranked = await scanSortedLibraryPage(database, message, settings, control);
      return {
        ...ranked,
        metrics: {
          openMs,
          settingsMs,
          databaseOpenMs,
          schemaPreparationMs,
          queryPlanningMs,
          pageReadMs: performance.now() - pageReadStarted,
          downloadLookupMs: Number(ranked.downloadLookupMs || 0),
          queryMs: performance.now() - queryStarted,
          totalMs: performance.now() - openedAt,
          plan: ranked.plan,
        },
      };
    }
    const pageReadStarted = performance.now();
    const page = await readLibraryQueryPage(database, {
      sort,
      limit,
      after: message.after || null,
      expectedRevision: message.expectedRevision,
      expectedDownloadRevision: message.expectedDownloadRevision,
      scanLimit: Math.min(10000, Math.max(limit, Number(message.scanLimit) || 2500)),
      downloads: needsDownloads,
      cancelled: () => control.cancelled,
      match: (post, download) => {
        if (!query) return true;
        const projection = globalThis.XVaultLibrarySearch.projectPost(post, 0, { inboxSince: settings.inboxSince });
        if (download) {
          projection.downloaded = download.downloaded;
          projection.missing = download.missing;
          projection.knownBytes = download.bytes;
        }
        return globalThis.XVaultLibrarySearch.matchesCompiledQuery(projection, compiled);
      },
    });
    const pageReadMs = performance.now() - pageReadStarted;
    if (page.stale)
      return {
        ok: true,
        ...page,
        downloads: [],
        metrics: {
          openMs,
          settingsMs,
          databaseOpenMs,
          schemaPreparationMs,
          queryPlanningMs,
          pageReadMs,
          downloadLookupMs: Number(page.downloadLookupMs) || 0,
          queryMs: performance.now() - queryStarted,
        },
      };
    const includeDownloads = message.includeDownloads !== false,
      lookupAt = performance.now(),
      downloadRows = includeDownloads
        ? await readDownloadRows(
            database,
            page.rows.map(row => row.id),
            { perPostLimit: 64, totalLimit: 5000 }
          )
        : [],
      downloadLookupMs = (Number(page.downloadLookupMs) || 0) + performance.now() - lookupAt;
    const committedRevision = await readLibraryRevision(database);
    if (committedRevision !== page.revision) {
      return {
        ok: true,
        stale: true,
        revision: committedRevision,
        downloadRevision: page.downloadRevision,
        rows: [],
        downloads: [],
        downloadRowsRead: (Number(page.downloadRowsRead) || 0) + downloadRows.length,
        downloadCursorOperations: Number(page.downloadCursorOperations) || 0,
        searchProjectionRows: query ? Number(page.scanned) || 0 : 0,
        metrics: {
          openMs,
          settingsMs,
          databaseOpenMs,
          schemaPreparationMs,
          queryPlanningMs,
          pageReadMs,
          queryMs: performance.now() - queryStarted,
          downloadLookupMs,
          totalMs: performance.now() - openedAt,
        },
      };
    }
    if (needsDownloads && (await readLibraryDownloadRevision(database)) !== page.downloadRevision) {
      const downloadRevision = await readLibraryDownloadRevision(database);
      return {
        ok: true,
        stale: true,
        revision: page.revision,
        downloadRevision,
        rows: [],
        downloads: [],
        downloadRowsRead: (Number(page.downloadRowsRead) || 0) + downloadRows.length,
        downloadCursorOperations: Number(page.downloadCursorOperations) || 0,
        searchProjectionRows: query ? Number(page.scanned) || 0 : 0,
        metrics: {
          openMs,
          settingsMs,
          databaseOpenMs,
          schemaPreparationMs,
          queryPlanningMs,
          pageReadMs,
          queryMs: performance.now() - queryStarted,
          downloadLookupMs,
          totalMs: performance.now() - openedAt,
        },
      };
    }
    return {
      ok: true,
      ...page,
      downloads: downloadRows,
      downloadRowsRead: (Number(page.downloadRowsRead) || 0) + downloadRows.length,
      downloadCursorOperations: Number(page.downloadCursorOperations) || 0,
      searchProjectionRows: query ? Number(page.scanned) || 0 : 0,
      downloadsTruncated: !!downloadRows.truncated,
      metrics: {
        openMs,
        settingsMs,
        databaseOpenMs,
        schemaPreparationMs,
        queryPlanningMs,
        pageReadMs,
        queryMs: performance.now() - queryStarted,
        downloadLookupMs,
        totalMs: performance.now() - openedAt,
        plan: sort === 'new' ? 'archivedAt index, descending' : 'archivedAt index, ascending',
      },
    };
  } finally {
    database.close();
  }
}
async function storeProfileSnapshots(users = [], context = {}) {
  const day = new Date().toISOString().slice(0, 10),
    rows = [];
  for (const u of users || []) {
    if (!u?.id || !u?.handle) continue;
    rows.push({
      id: `profile:${String(u.id)}:${day}`,
      type: 'profile',
      profileId: String(u.id),
      handle: u.handle,
      name: u.name || '',
      avatar: u.avatar || '',
      banner: u.banner || '',
      bio: u.bio || '',
      followers: u.followers ?? null,
      following: u.following ?? null,
      posts: u.posts ?? null,
      verified: !!u.verified,
      capturedAt: Date.now(),
      source: context.scope || context.source || 'capture',
      runId: context.runId || null,
    });
  }
  if (rows.length) await putMany('snapshots', rows);
  return rows.length;
}
async function action(type, text, meta = {}) {
  const s = await getSettings(),
    row = { id: crypto.randomUUID(), at: Date.now(), type, text, meta };
  await putMany('actions', [row]);
  const rows = await all('actions');
  if (rows.length > (s.recentActionsLimit || 120)) {
    rows.sort((a, b) => a.at - b.at);
    await store('actions', 'readwrite', os => {
      for (const r of rows.slice(0, rows.length - s.recentActionsLimit)) os.delete(r.id);
    });
  }
  return row;
}
function belongsToRunScope(t, ctx = {}) {
  const scope = ctx.scope || 'timeline',
    sources = [...(t.archiveSources || []), ...(t.sourceFlags || [])].map(x => String(x).toLowerCase());
  if (scope === 'profile') {
    const wanted = String(ctx.profileHandle || '')
      .replace(/^@/, '')
      .toLowerCase();
    return (
      !!wanted &&
      String(t.archiveProfile || '')
        .replace(/^@/, '')
        .toLowerCase() === wanted
    );
  }
  return sources.includes(String(scope).toLowerCase());
}
async function beginArchiveRun(job) {
  if (!job?.id || !job.context) return;
  const existing = await store('archiveRuns', 'readonly', os => req(os.get(job.id))).catch(() => null);
  if (existing) {
    if (existing.state === 'capturing' && job.state === 'running')
      await putMany('archiveRuns', [{ ...existing, state: 'running', updatedAt: Date.now() }]);
    return;
  }
  const baseline = (await all('tweets')).filter(t => belongsToRunScope(t, job.context)).map(t => String(t.id));
  await putMany('archiveRuns', [
    {
      id: job.id,
      source: job.context.scope || 'timeline',
      profileHandle: job.context.profileHandle || null,
      startedAt: Date.now(),
      state: 'capturing',
      baselineIds: baseline,
      baselineCount: baseline.length,
      diff: null,
    },
  ]);
  await action('archive-run', `Archive baseline saved (${baseline.length} posts)`, {
    runId: job.id,
    source: job.context.scope,
  });
}
async function markArchiveSettling(job) {
  if (!job?.id) return null;
  const run = await store('archiveRuns', 'readonly', os => req(os.get(job.id))).catch(() => null);
  if (!run || !canTransitionArchive(run.state || 'capturing', 'finalizing')) return run;
  const finalizing = {
    ...run,
    state: 'finalizing',
    finalizingAt: Date.now(),
    finalState: job.state === 'error' ? 'error' : 'complete',
    updatedAt: Date.now(),
  };
  await putMany('archiveRuns', [finalizing]);
  const next = {
    ...finalizing,
    state: 'settling',
    settlingStartedAt: run.settlingStartedAt || Date.now(),
    settlingPasses: Number(run.settlingPasses || 0) + 1,
    updatedAt: Date.now(),
  };
  await putMany('archiveRuns', [next]);
  return next;
}
async function finalizeArchiveRun(job, force = false) {
  if (!job?.id || !job.context) return null;
  const run = await store('archiveRuns', 'readonly', os => req(os.get(job.id))).catch(() => null);
  if (!run || (run.diff && !force)) return run;
  const [tweets, revisions] = await Promise.all([all('tweets'), all('revisions')]),
    scopeRows = tweets.filter(t => belongsToRunScope(t, job.context)),
    seen = scopeRows.filter(t => t.lastSeenRun === job.id),
    base = new Set(run.baselineIds || []),
    added = seen.filter(t => !base.has(String(t.id))),
    changed = revisions.filter(r => r.runId === job.id),
    notObserved = (run.baselineIds || []).filter(id => !seen.some(t => String(t.id) === String(id)));
  const diff = {
    added: added.map(t => String(t.id)),
    changed: [...new Set(changed.map(r => String(r.tweetId)))],
    notObserved,
    summary: {
      postsObserved: seen.length,
      postsAdded: added.length,
      postsChanged: changed.length,
      notObserved: notObserved.length,
      baseline: base.size,
    },
    note: '“Not observed” means this run did not encounter a formerly archived post. It is intentionally not labelled deleted: X pagination, access, and partial runs cannot prove deletion.',
  };
  const next = {
    ...run,
    state: run.finalState || job.state || 'complete',
    finishedAt: Date.now(),
    settledAt: Date.now(),
    diff,
  };
  await putMany('archiveRuns', [next]);
  if (!force)
    await action(
      'archive-diff',
      `Archive diff: +${added.length} posts · ${changed.length} revised · ${notObserved.length} not observed`,
      { runId: job.id, ...diff.summary }
    );
  return next;
}
function scheduleRunReconciliation(runId, context) {
  if (!runId || !context) return;
  clearTimeout(runFinalizeTimers.get(runId));
  runFinalizeTimers.set(
    runId,
    setTimeout(async () => {
      runFinalizeTimers.delete(runId);
      const job = { id: runId, context, state: context.state || 'complete' };
      await finalizeArchiveRun(job, true).catch(() => {});
    }, 700)
  );
}
async function explorerData() {
  const [tweets, runs, revisions, snapshots] = await Promise.all([
    all('tweets'),
    all('archiveRuns'),
    all('revisions'),
    all('snapshots'),
  ]);
  return {
    tweets: tweets.map(t => ({
      id: t.id,
      text: t.text,
      createdAt: t.createdAt,
      archivedAt: t.archivedAt,
      firstSeenAt: t.firstSeenAt,
      lastSeenAt: t.lastSeenAt,
      url: t.url,
      author: t.author,
      metrics: t.metrics,
      media: t.media,
      sensitive: t.sensitive,
      userMeta: t.userMeta,
      archiveSources: t.archiveSources,
      archiveProfile: t.archiveProfile,
      provenance: t.provenance,
    })),
    runs: runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 100),
    profiles: snapshots
      .filter(s => s.type === 'profile')
      .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))
      .slice(0, 500),
    revisionCount: revisions.length,
  };
}
async function openDashboard(page = '') {
  const url = chrome.runtime.getURL(`dashboard.html${page ? `#${encodeURIComponent(page)}` : ''}`),
    base = chrome.runtime.getURL('dashboard.html'),
    tabs = await chrome.tabs.query({}).catch(() => []),
    old = tabs.find(t => (t.url || '').startsWith(base));
  if (old?.id) {
    await chrome.tabs.update(old.id, { active: true, url });
    return { ok: true, tabId: old.id, reused: true };
  }
  const t = await chrome.tabs.create({ url });
  return { ok: true, tabId: t.id };
}
async function notify(title, message) {
  const s = await getSettings();
  if (s.completionNotifications === false) return;
  try {
    await chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 0 });
  } catch {}
}
function wake(on) {
  try {
    if (on && !keepAwake) {
      chrome.power.requestKeepAwake('system');
      keepAwake = true;
    } else if (!on && keepAwake) {
      chrome.power.releaseKeepAwake();
      keepAwake = false;
    }
  } catch {}
}
async function activeXTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.twitter.com/*'],
  });
  return tabs.find(t => t.active) || tabs[0] || null;
}
async function sendToX(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (e) {
    return {
      ok: false,
      error: 'XVault is not attached to this X tab. Reload the tab once.',
      detail: e?.message || String(e),
    };
  }
}

let remoteNativePort = null,
  remoteNativeDisconnectError = '',
  remoteCommandSequence = 0,
  remoteNativeIdleTimer = 0,
  remoteNativeActivity = 0,
  remoteNativeListening = false;
const remoteCommandPending = new Map();
const REMOTE_QUERY_PLAN_TTL = 8 * 60 * 1000,
  REMOTE_QUERY_PLAN_LIMIT = 4,
  REMOTE_QUERY_CANDIDATE_LIMIT = 5000;
function retireRemoteNative(port, error) {
  if (remoteNativePort === port) {
    clearTimeout(remoteNativeIdleTimer);
    remoteNativeIdleTimer = 0;
    remoteNativePort = null;
    remoteNativeListening = false;
  }
  for (const [id, pending] of remoteCommandPending) {
    if (pending.port !== port) continue;
    clearTimeout(pending.timer);
    remoteCommandPending.delete(id);
    pending.reject(Error(error));
  }
}
function disconnectRemoteNative(port = remoteNativePort) {
  if (!port) return;
  // disconnect() does not dispatch onDisconnect on the calling side of a Chrome Port.
  retireRemoteNative(port, 'XVault Companion connection closed');
  try {
    port.disconnect();
  } catch {}
}
function remoteNativeConnect() {
  if (remoteNativePort) return remoteNativePort;
  if (!chrome.runtime.connectNative) throw Error('Chrome Native Messaging is unavailable');
  const port = chrome.runtime.connectNative('com.xvault.remote');
  remoteNativePort = port;
  remoteNativeDisconnectError = '';
  port.onMessage.addListener(message => {
    if (remoteNativePort !== port) return;
    if (message?.type === 'ping') {
      try {
        port.postMessage({ type: 'pong', at: Date.now() });
      } catch {}
      return;
    }
    if (message?.type === 'bridge_request') {
      const send = value => {
        if (remoteNativePort === port)
          try {
            port.postMessage(value);
          } catch {}
      };
      handleRemoteBridgeRequest(message).then(
        result => send({ type: 'bridge_response', id: message.id, result }),
        error => send({ type: 'bridge_response', id: message.id, error: String(error?.message || error).slice(0, 160) })
      );
      return;
    }
    if (message?.type !== 'response') return;
    const id = String(message.id || ''),
      pending = remoteCommandPending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    remoteCommandPending.delete(id);
    if (!message.error && typeof message.result?.listening === 'boolean')
      remoteNativeListening = message.result.listening;
    if (message.error) pending.reject(Error(String(message.error).slice(0, 180)));
    else pending.resolve(message.result || {});
  });
  port.onDisconnect.addListener(() => {
    remoteNativeDisconnectError = chrome.runtime.lastError?.message || 'XVault Companion disconnected';
    retireRemoteNative(port, remoteNativeDisconnectError);
  });
  return port;
}
function remoteHostCommand(name, payload = {}) {
  clearTimeout(remoteNativeIdleTimer);
  remoteNativeIdleTimer = 0;
  const activity = ++remoteNativeActivity,
    port = remoteNativeConnect(),
    id = `xv-remote-${++remoteCommandSequence}-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      remoteCommandPending.delete(id);
      reject(Error('The Companion did not respond in time'));
    }, 30000);
    remoteCommandPending.set(id, { resolve, reject, timer, port });
    try {
      port.postMessage({ type: 'command', id, name, payload });
    } catch (error) {
      clearTimeout(timer);
      remoteCommandPending.delete(id);
      disconnectRemoteNative(port);
      reject(error);
    }
  }).then(async result => {
    const idle =
      name === 'remote.stop' ||
      (['remote.status', 'devices.list', 'device.permissions', 'device.revoke'].includes(name) &&
        !(await getSettings()).remoteEnabled);
    if (idle && remoteNativePort === port && activity === remoteNativeActivity && !remoteNativeListening) {
      remoteNativeIdleTimer = setTimeout(() => {
        remoteNativeIdleTimer = 0;
        if (
          remoteNativePort === port &&
          activity === remoteNativeActivity &&
          !remoteNativeListening &&
          ![...remoteCommandPending.values()].some(pending => pending.port === port)
        )
          disconnectRemoteNative(port);
      }, 50);
    }
    return result;
  });
}
function validRemoteId(value) {
  return /^\d{1,32}$/.test(String(value || ''));
}
function remoteVerifiedDownload(row) {
  return (
    row?.state === 'complete' &&
    !['mismatch', 'corrupt', 'missing'].includes(row.verification?.state || row.verificationState)
  );
}
function remoteMediaUrls(media) {
  const variants = Array.isArray(media?.variants) ? media.variants : [];
  return [media?.url, media?.playbackUrl, ...variants.map(variant => variant?.url)].filter(
    value => typeof value === 'string' && value
  );
}
function remoteDownloadMatches(media, entry) {
  if (media?.id && entry?.mediaId && String(media.id) === String(entry.mediaId)) return true;
  if (!entry?.sourceUrl) return false;
  return remoteMediaUrls(media).some(
    url => url === entry.sourceUrl || globalThis.XVaultMediaAsset?.sameAsset(url, entry.sourceUrl)
  );
}
async function archiveIndicators(ids = []) {
  const unique = [...new Set(ids.map(String))].slice(0, 50);
  if (!unique.length) return { ok: true, rows: [] };
  const database = await db();
  try {
    const [posts, history] = await Promise.all([
      readLibraryRecords(database, unique),
      readDownloadRows(database, unique, { perPostLimit: 64, totalLimit: 3200 }),
    ]);
    const rows = buildArchiveIndicators(unique, posts, history, {
      truncated: history.truncated,
      verified: remoteVerifiedDownload,
      matches: (media, row) => remoteDownloadMatches(media, { mediaId: row.item?.mediaId, sourceUrl: row.item?.url }),
    });
    return { ok: true, rows };
  } finally {
    database.close();
  }
}
async function remotePostsById(database, ids) {
  const wanted = [...new Set((ids || []).map(String).filter(validRemoteId))];
  if (!wanted.length) return [];
  return new Promise((resolve, reject) => {
    const tx = database.transaction('tweets', 'readonly'),
      store = tx.objectStore('tweets'),
      rows = new Map();
    for (const id of wanted) {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) rows.set(id, request.result);
      };
      request.onerror = () => reject(request.error);
    }
    tx.oncomplete = () => resolve(wanted.map(id => rows.get(id)).filter(Boolean));
    tx.onabort = () => reject(tx.error || new Error('Post lookup aborted'));
    tx.onerror = () => reject(tx.error || new Error('Post lookup failed'));
  });
}
function purgeRemoteQueryPlans(now = Date.now()) {
  for (const [id, entry] of remoteQueryPlans)
    if (now - entry.usedAt > REMOTE_QUERY_PLAN_TTL) remoteQueryPlans.delete(id);
  while (remoteQueryPlans.size > REMOTE_QUERY_PLAN_LIMIT) remoteQueryPlans.delete(remoteQueryPlans.keys().next().value);
}
function remotePlanCursor(cursor) {
  if (String(cursor || '').startsWith('xvr3:'))
    return { id: remotePageCursorId(cursor), mode: 'cursor', token: String(cursor) };
  const match = String(cursor || '').match(/^xvr2:([0-9a-f-]{36}):(\d{1,9})$/i);
  if (!match) throw Error('Search cursor is invalid or expired');
  return { id: match[1], offset: Number(match[2]), mode: 'ranked' };
}
async function buildRemoteCursorPlan(database, query, sort, deviceId, settings) {
  const needsDownload = globalThis.XVaultLibrarySearch.usesRuleKind(
    globalThis.XVaultLibrarySearch.compileQuery(query),
    ['downloaded', 'missing', 'size']
  );
  const revision = await readLibraryRevision(database),
    downloadRevision = needsDownload ? await readLibraryDownloadRevision(database) : null;
  return {
    id: crypto.randomUUID(),
    entry: {
      mode: 'cursor',
      query,
      sort,
      deviceId,
      usedAt: Date.now(),
      revision,
      downloadRevision,
      inboxSince: Number(settings.inboxSince) || 0,
      secret: crypto.getRandomValues(new Uint8Array(32)),
    },
  };
}
async function buildRemoteRankPlan(database, query, sort, deviceId, settings, control) {
  const needsDownload = globalThis.XVaultLibrarySearch.usesRuleKind(
    globalThis.XVaultLibrarySearch.compileQuery(query),
    ['downloaded', 'missing', 'size']
  );
  const revision = await readLibraryRevision(database),
    downloadRevision = needsDownload ? await readLibraryDownloadRevision(database) : null;
  const planner = createRemotePlanner({
    query,
    sort,
    inboxSince: Number(settings.inboxSince) || 0,
    maxCandidates: REMOTE_QUERY_CANDIDATE_LIMIT,
  });
  let afterKey = null,
    scanned = 0;
  for (;;) {
    if (control?.cancelled) return { cancelled: true };
    const chunk = await readLibraryPage(database, afterKey, 128);
    afterKey = chunk.nextKey;
    scanned += chunk.rows.length;
    if (control?.cancelled) return { cancelled: true };
    if (needsDownload && chunk.rows.length) {
      const histories = await readDownloadRows(
        database,
        chunk.rows.map(row => row.id),
        { perPostLimit: 128, totalLimit: 5000 }
      );
      if (histories.truncated)
        throw Error(
          'This archive has unusually large per-post download history. The search stopped safely instead of returning incomplete results.'
        );
      const byPost = new Map();
      for (const row of histories) {
        if (row.state !== 'complete') continue;
        const id = String(row.item?.tweetId || '');
        if (!id) continue;
        let rows = byPost.get(id);
        if (!rows) {
          rows = [];
          byPost.set(id, rows);
        }
        rows.push({
          mediaId: String(row.item?.mediaId || ''),
          sourceUrl: String(row.item?.url || ''),
          totalBytes: Math.max(0, Number(row.totalBytes) || 0),
          complete: true,
          eligible: remoteVerifiedDownload(row),
        });
      }
      for (const post of chunk.rows) {
        const entries = byPost.get(String(post.id)) || [],
          eligible = entries.filter(entry => entry.eligible),
          media = Array.isArray(post.media) ? post.media : [],
          missing =
            media.length > 0 &&
            media.some(sourceMedia => !eligible.some(entry => remoteDownloadMatches(sourceMedia, entry)));
        planner.visit(post, {
          downloaded: eligible.length > 0,
          missing,
          knownBytes: entries.reduce((total, entry) => total + (entry.complete ? entry.totalBytes : 0), 0),
        });
      }
    } else for (const post of chunk.rows) planner.visit(post);
    if (chunk.done) break;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (control?.cancelled) return { cancelled: true };
  const plan = planner.finish(),
    currentRevision = await readLibraryRevision(database),
    currentDownloadRevision = needsDownload ? await readLibraryDownloadRevision(database) : null,
    entry = {
      mode: 'ranked',
      plan,
      deviceId,
      usedAt: Date.now(),
      revision,
      downloadRevision,
      inboxSince: Number(settings.inboxSince) || 0,
      scanned,
    };
  if (!remotePlanIsCurrent(entry, currentRevision, currentDownloadRevision))
    throw Error(
      'Search results expired; the Library changed while this search was being prepared. Run the search again'
    );
  const latestSettings = await getSettings();
  if (control?.cancelled) return { cancelled: true };
  if ((Number(latestSettings.inboxSince) || 0) !== entry.inboxSince)
    throw Error(
      'Search results expired; Library settings changed while this search was being prepared. Run the search again'
    );
  const id = crypto.randomUUID();
  purgeRemoteQueryPlans();
  if (control?.cancelled) return { cancelled: true };
  if (plan.rows.length) remoteQueryPlans.set(id, entry);
  return { id, plan, entry };
}
async function remoteLibraryQuery(options = {}) {
  const query = String(options.query || '').trim(),
    sort = String(options.sort || 'new'),
    limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 40))),
    cursor = options.cursor == null ? null : String(options.cursor),
    deviceId = String(options.deviceId || ''),
    sessionId = String(options.sessionId || '').toLowerCase();
  if (
    query.length > 1000 ||
    (cursor && cursor.length > 4096) ||
    !['new', 'old', 'likes', 'views', 'bookmarks', 'reposts', 'replies', 'media', 'author'].includes(sort) ||
    !/^[-0-9a-f]{36}$/i.test(deviceId) ||
    !/^[-0-9a-f]{36}$/.test(sessionId)
  )
    throw Error('Search options are invalid');
  const searchKey = `${deviceId}:${sessionId}`,
    requestedPlanId = cursor ? remotePlanCursor(cursor).id : null,
    control = beginRemoteQuery(activeRemoteSearches, searchKey, { query, sort, cursorPlanId: requestedPlanId });
  let database = null;
  try {
    if (control.cancelled)
      return { ok: true, cancelled: true, rows: [], matched: 0, matchedExact: false, hasMore: false };
    const settings = await getSettings();
    if (control.cancelled)
      return { ok: true, cancelled: true, rows: [], matched: 0, matchedExact: false, hasMore: false };
    database = await db();
    if (control.cancelled)
      return { ok: true, cancelled: true, rows: [], matched: 0, matchedExact: false, hasMore: false };
    let id,
      entry,
      parsed = null,
      posts = [],
      rankedResult = null,
      cursorPage = null;
    if (cursor) {
      parsed = remotePlanCursor(cursor);
      entry = remoteQueryPlans.get(parsed.id);
      if (
        !entry ||
        entry.deviceId !== deviceId ||
        (entry.mode === 'cursor' ? entry.query : entry.plan?.query) !== query ||
        (entry.mode === 'cursor' ? entry.sort : entry.plan?.sort) !== sort ||
        entry.inboxSince !== (Number(settings.inboxSince) || 0)
      )
        throw Error('Search results expired; run the search again');
      id = parsed.id;
      entry.usedAt = Date.now();
    } else if (sort === 'new' || sort === 'old')
      ({ id, entry } = await buildRemoteCursorPlan(database, query, sort, deviceId, settings));
    else {
      const ranked = await buildRemoteRankPlan(database, query, sort, deviceId, settings, control);
      if (ranked.cancelled || control.cancelled)
        return { ok: true, cancelled: true, rows: [], matched: 0, matchedExact: false, hasMore: false };
      ({ id, entry } = ranked);
      control.planId = id;
    }
    if (!control.planId) control.planId = id;
    purgeRemoteQueryPlans();
    let matched = 0,
      matchedExact = true,
      hasMore = false,
      nextCursor = null,
      truncated = false,
      scanned = 0;
    if (entry.mode === 'cursor') {
      const decoded = parsed ? await decodeRemotePageCursor(parsed.token, entry.secret) : null;
      if (
        parsed &&
        (!decoded ||
          decoded.id !== id ||
          decoded.after.sort !== sort ||
          decoded.after.revision !== entry.revision ||
          (entry.downloadRevision != null && decoded.after.downloadRevision !== entry.downloadRevision))
      )
        throw Error('Search results expired; run the search again');
      cursorPage = await readRemoteCursorPage(database, {
        query,
        sort,
        limit,
        after: decoded?.after || null,
        expectedRevision: entry.revision,
        expectedDownloadRevision: entry.downloadRevision,
        inboxSince: entry.inboxSince,
        scanLimit: 2500,
        cancelled: () => control.cancelled,
      });
      if (control.cancelled || cursorPage.cancelled) {
        remoteQueryPlans.delete(id);
        return { ok: true, cancelled: true, rows: [], matched: 0, matchedExact: false, hasMore: false };
      }
      if (cursorPage.stale) {
        remoteQueryPlans.delete(id);
        throw Error('Search results expired; run the search again');
      }
      posts = cursorPage.rows;
      matched = (decoded?.matched || 0) + cursorPage.matched;
      scanned = (decoded?.scanned || 0) + cursorPage.scannedThisPage;
      matchedExact = cursorPage.done;
      hasMore = cursorPage.hasMore;
      if (hasMore) nextCursor = await encodeRemotePageCursor(id, cursorPage.nextKey, matched, scanned, entry.secret);
      const latestSettings = await getSettings();
      if ((Number(latestSettings.inboxSince) || 0) !== entry.inboxSince) {
        remoteQueryPlans.delete(id);
        throw Error('Search results expired; Library settings changed while the search was open');
      }
      remoteQueryPlans.set(id, entry);
    } else {
      const offset = parsed?.offset || 0;
      rankedResult = pageRemotePlan(entry.plan, offset, limit);
      const postIds = rankedResult.rows.map(row => row.id);
      posts = await remotePostsById(database, postIds);
      matched = rankedResult.matched;
      matchedExact = true;
      hasMore = rankedResult.hasMore;
      truncated = rankedResult.truncated;
      if (hasMore) nextCursor = `xvr2:${id}:${rankedResult.nextOffset}`;
    }
    const postIds = posts.map(row => String(row.id)),
      postMap = new Map(posts.map(post => [String(post.id), post]));
    const downloadRows = await readDownloadRows(database, postIds),
      downloadMap = new Map();
    for (const row of downloadRows) {
      const postId = String(row.item?.tweetId || '');
      if (!remoteVerifiedDownload(row) || !postId) continue;
      let list = downloadMap.get(postId);
      if (!list) {
        list = [];
        downloadMap.set(postId, list);
      }
      list.push(row);
    }
    const rows = postIds
      .map(postId => {
        const post = postMap.get(String(postId));
        if (!post) return null;
        const row = {
          id: String(post.id),
          handle: String(post.author?.handle || '')
            .replace(/^@/, '')
            .toLowerCase(),
          name: String(post.author?.name || post.author?.handle || '').slice(0, 80),
          text: String(post.text || '').slice(0, 900),
          createdAt: post.createdAt || null,
          archivedAt: Number(post.archivedAt || 0),
          metrics: Object.fromEntries(
            ['likes', 'views', 'bookmarks', 'reposts', 'replies'].map(key => [key, Number(post.metrics?.[key] || 0)])
          ),
          sensitive: !!post.sensitive,
          favorite: !!post.userMeta?.favorite,
          tags: (Array.isArray(post.userMeta?.tags) ? post.userMeta.tags : []).map(String).slice(0, 30),
          mediaCount: Array.isArray(post.media) ? post.media.length : 0,
          mediaTypes: (Array.isArray(post.media) ? post.media : [])
            .map(item => String(item?.type || '').toLowerCase())
            .filter(Boolean)
            .slice(0, 12),
        };
        let statusUrl = String(post.url || '');
        if (!statusUrl && /^[A-Za-z0-9_]{1,15}$/.test(row.handle))
          statusUrl = `https://x.com/${row.handle}/status/${row.id}`;
        try {
          row.link = globalThis.XVaultLinks?.transform(statusUrl, settings) || null;
        } catch {
          row.link = null;
        }
        const localMedia = [];
        for (const media of Array.isArray(post.media) ? post.media : []) {
          const record = (downloadMap.get(row.id) || []).find(download =>
            remoteDownloadMatches(media, { mediaId: download.item?.mediaId, sourceUrl: download.item?.url })
          );
          const filename = String(record?.filename || record?.target?.filename || '');
          if (!record || !filename || localMedia.length >= 32) continue;
          localMedia.push({
            filename,
            mediaId: String(media.id || record.item?.mediaId || ''),
            type: String(media.type || record.item?.mediaType || 'other'),
            mime: String(record.target?.mime || record.item?.mime || ''),
            width: Number(media.width || 0),
            height: Number(media.height || 0),
            shared: record.association?.kind === 'shared',
            ownerPostId: record.association?.ownerPostId || null,
          });
        }
        row.localMedia = localMedia;
        return row;
      })
      .filter(Boolean);
    if (control.cancelled)
      return { ok: true, cancelled: true, rows: [], matched: 0, matchedExact: false, hasMore: false };
    const currentRevision = await readLibraryRevision(database),
      currentDownloadRevision = entry.downloadRevision == null ? null : await readLibraryDownloadRevision(database);
    if (control.cancelled)
      return { ok: true, cancelled: true, rows: [], matched: 0, matchedExact: false, hasMore: false };
    if (!remotePlanIsCurrent(entry, currentRevision, currentDownloadRevision)) {
      remoteQueryPlans.delete(id);
      throw Error('Search results expired; the Library changed while these results were open. Run the search again');
    }
    return {
      ok: true,
      rows,
      matched,
      matchedExact,
      nextCursor,
      hasMore,
      truncated,
      scanned: cursorPage ? scanned : entry.scanned || 0,
      sort,
      provider: globalThis.XVaultLinks?.label(settings.linkProvider || 'fixvx') || 'FixVX',
    };
  } finally {
    if (database) database.close();
    releaseRemoteQuery(activeRemoteSearches, searchKey, control);
  }
}
async function remoteSetMeta(method, payload = {}) {
  const id = String(payload.id || '');
  if (!validRemoteId(id)) throw Error('Post identity is invalid');
  if (method === 'library.note' && (typeof payload.note !== 'string' || typeof payload.expectedNote !== 'string'))
    throw Error('A note and saved baseline are required');
  const database = await db();
  let userMeta;
  try {
    if (method === 'library.tag') {
      const tag = String(payload.tag || '')
        .trim()
        .replace(/^#/, '')
        .slice(0, 40);
      if (!tag) throw Error('Tag is empty');
      const result = await updateLibraryMetadata(database, [id], { addTag: tag });
      if (!result.updated) throw Error('Post not found');
      userMeta = result.rows[0].userMeta;
    } else if (method === 'library.favorite' || method === 'library.note') {
      const patch = method === 'library.favorite' ? { favorite: payload.favorite === true } : { note: payload.note };
      const result = await updateLibraryRecord(database, id, patch, payload.expectedNote);
      if (!result.ok) {
        if (result.conflict)
          return { ok: false, conflict: true, note: result.row.userMeta?.note || '', error: result.error };
        return result;
      }
      userMeta = result.row.userMeta;
    } else throw Error('Unsupported Library action');
  } finally {
    database.close();
  }
  announceMetadata([id]);
  await action(
    'remote-library',
    method === 'library.favorite'
      ? userMeta.favorite
        ? 'Favorite added from Remote'
        : 'Favorite removed from Remote'
      : 'Library metadata updated from Remote',
    { tweetId: id }
  );
  return { ok: true, id, favorite: !!userMeta.favorite, tags: userMeta.tags || [], note: userMeta.note || '' };
}
async function remoteMediaPage(payload = {}) {
  const id = String(payload.id || ''),
    offset = Number(payload.offset),
    limit = Math.max(1, Math.min(16, Math.floor(Number(payload.limit) || 16)));
  if (
    !validRemoteId(id) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    typeof payload.mediaVersion !== 'string' ||
    payload.mediaVersion.length > 128
  )
    throw Error('Media page options are invalid');
  const database = await db();
  try {
    const posts = await remotePostsById(database, [id]),
      post = posts[0];
    if (!post) throw Error('Post not found');
    const allMedia = Array.isArray(post.media) ? post.media : [],
      mediaVersion = await remoteMediaVersion(allMedia);
    if (payload.mediaVersion && payload.mediaVersion !== mediaVersion)
      return { ok: false, stale: true, error: 'Post media changed; reopen the viewer' };
    const history = await readDownloadRows(database, [id], { perPostLimit: 128, totalLimit: 256 });
    if (history.truncated) throw Error('This post has too much download history to resolve safely');
    const verified = history.filter(remoteVerifiedDownload),
      media = allMedia.slice(offset, offset + limit).map((item, index) => {
        const record = verified.find(row =>
            remoteDownloadMatches(item, { mediaId: row.item?.mediaId, sourceUrl: row.item?.url })
          ),
          filename = String(record?.filename || record?.target?.filename || '');
        return {
          index: offset + index,
          mediaId: String(item?.id || record?.item?.mediaId || ''),
          type: String(item?.type || record?.item?.mediaType || 'other').slice(0, 24),
          mime: String(record?.target?.mime || record?.item?.mime || '').slice(0, 80),
          width: Number(item?.width || 0),
          height: Number(item?.height || 0),
          shared: record?.association?.kind === 'shared',
          ownerPostId: record?.association?.ownerPostId || null,
          filename: filename || null,
        };
      });
    return {
      ok: true,
      id,
      offset,
      mediaCount: allMedia.length,
      mediaVersion,
      media,
      nextOffset: offset + media.length < allMedia.length ? offset + media.length : null,
    };
  } finally {
    database.close();
  }
}
async function handleRemoteBridgeRequest(message) {
  const method = String(message.method || ''),
    payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  if (method === 'library.query') return remoteLibraryQuery(payload);
  if (method === 'library.views') return projectRemoteViews(await getSettings());
  if (method === 'library.download') {
    const id = String(payload.id || '');
    if (!validRemoteId(id)) throw Error('Invalid post ID');
    const database = await db();
    let plan;
    try {
      const [post] = await remotePostsById(database, [id]);
      if (!post) return { ok: false, missing: true };
      plan = await planRemoteDownload(post, payload, bulkItemForPost);
    } finally {
      database.close();
    }
    if (plan.stale) return { ok: false, stale: true };
    const result = plan.items.length
      ? await enqueue(plan.items, false, { source: 'remote', existingPolicy: 'skip' })
      : { ok: true, added: 0, skipped: 0, filtered: 0 };
    return {
      ok: result.ok !== false,
      added: result.added || 0,
      skipped: result.skipped || 0,
      filtered: result.filtered || 0,
      unavailable: plan.unavailable,
      blocked: !!result.blocked,
      mediaCount: plan.mediaCount,
      nextOffset: plan.nextOffset,
      mediaVersion: plan.mediaVersion,
    };
  }
  if (method === 'library.media.page') return remoteMediaPage(payload);
  if (method === 'ui.preferences') {
    const s = await getSettings(),
      database = await db();
    try {
      return {
        motion:
          s.safeMode || s.animations === false || s.motionLevel === 'off'
            ? 'off'
            : s.reducedMotion || s.motionLevel === 'reduced'
              ? 'reduced'
              : 'normal',
        libraryRevision: await readLibraryRevision(database),
      };
    } finally {
      database.close();
    }
  }
  if (method === 'library.note.read') {
    const id = String(payload.id || '');
    if (!validRemoteId(id)) throw Error('Invalid post ID');
    const row = await store('tweets', 'readonly', os => req(os.get(id)));
    return row ? { ok: true, id, note: row.userMeta?.note || '' } : { ok: false, error: 'Post not found' };
  }
  if (method === 'library.favorite' || method === 'library.tag' || method === 'library.note')
    return remoteSetMeta(method, payload);
  if (method === 'activity.latest') {
    const rows = (await all('actions'))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, Math.max(1, Math.min(40, Number(payload.limit) || 40)));
    return {
      rows: rows.map(row => ({
        at: Number(row.at) || 0,
        type: String(row.type || 'activity').slice(0, 32),
        text: String(row.text || '').slice(0, 180),
      })),
    };
  }
  throw Error('This Remote operation is not available');
}
chrome.runtime.onConnectNative.addListener(port => {
  if (port.name !== 'com.xvault.remote') port.disconnect();
});
async function restoreRemoteCompanion() {
  const settings = await getSettings();
  if (!settings.remoteEnabled) return;
  try {
    await remoteHostCommand('remote.start', { port: settings.remotePort || 18765 });
  } catch {
    remoteNativeDisconnectError = 'XVault Companion could not be reached';
  }
}

// Redundant GraphQL discovery: learn live query IDs + request headers even if the MAIN-world hook misses a request.
const pendingGraphql = new Map();
function graphMeta(url) {
  try {
    const u = new URL(url),
      m = u.pathname.match(/\/i\/api\/graphql\/([^/]+)\/([^/?]+)/);
    if (!m) return null;
    const j = k => {
      try {
        return JSON.parse(u.searchParams.get(k) || 'null');
      } catch {
        return null;
      }
    };
    return {
      queryId: m[1],
      operation: decodeURIComponent(m[2]),
      url: u.href,
      variables: j('variables'),
      features: j('features'),
      fieldToggles: j('fieldToggles'),
    };
  } catch {
    return null;
  }
}
try {
  chrome.webRequest.onBeforeRequest.addListener(
    d => {
      const x = graphMeta(d.url);
      if (x) pendingGraphql.set(d.requestId, { ...x, method: d.method, capturedAt: Date.now(), tabId: d.tabId });
    },
    { urls: ['https://x.com/i/api/graphql/*', 'https://twitter.com/i/api/graphql/*'] }
  );
  chrome.webRequest.onBeforeSendHeaders.addListener(
    async d => {
      const x = pendingGraphql.get(d.requestId) || graphMeta(d.url);
      if (!x) return;
      const headers = {};
      for (const h of d.requestHeaders || [])
        if (h.name && !TEMPLATE_SECRET_HEADERS.test(h.name)) headers[h.name] = h.value || '';
      let pageHref = '',
        pagePath = '';
      try {
        const t = await chrome.tabs.get(d.tabId);
        pageHref = t.url || '';
        pagePath = new URL(pageHref).pathname;
      } catch {}
      await storeCaptureTemplates([
        { ...x, headers, pageHref, pagePath, capturedAt: Date.now(), capturedBy: 'webRequest' },
      ]).catch(() => {});
      pendingGraphql.delete(d.requestId);
    },
    { urls: ['https://x.com/i/api/graphql/*', 'https://twitter.com/i/api/graphql/*'] },
    ['requestHeaders']
  );
} catch {}

chrome.action.onClicked.addListener(() => openDashboard().catch(() => {}));
chrome.runtime.onInstalled.addListener(async () => {
  await getSettings().catch(() => {});
  restoreRemoteCompanion().catch(() => {});
  try {
    chrome.contextMenus.removeAll(() => {
      const c = ['page', 'link'],
        p = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.twitter.com/*'];
      [
        ['xv-copy-default', 'XVault: Copy post link'],
        ['xv-copy-original', 'Copy original x.com link'],
        ['xv-copy-fixvx', 'Copy as FixVX'],
        ['xv-copy-fixupx', 'Copy as FixupX'],
        ['xv-copy-fxtwitter', 'Copy as FxTwitter'],
        ['xv-copy-vxtwitter', 'Copy as VXTwitter'],
        ['xv-archive', 'Archive this post locally'],
        ['xv-download', 'Download media from this post'],
        ['xv-dashboard', 'Open XVault dashboard'],
      ].forEach(([id, title]) => chrome.contextMenus.create({ id, title, contexts: c, documentUrlPatterns: p }));
    });
    if (chrome.sidePanel?.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {}
});

async function integrityScan() {
  const [tweets, downloads, conversions, manifests, s] = await Promise.all([
    all('tweets'),
    all('downloads'),
    all('conversions'),
    all('manifests'),
    getSettings(),
  ]);
  const byTweet = new Map(),
    tweetIds = new Set(tweets.map(t => String(t.id))),
    hashes = new Map(),
    paths = new Map();
  for (const d of downloads) {
    const id = String(d.item?.tweetId || '');
    if (id) {
      if (!byTweet.has(id)) byTweet.set(id, []);
      byTweet.get(id).push(d);
    }
  }
  const missing = [],
    zeroByte = [],
    wrongFormat = [],
    orphaned = [],
    duplicates = [],
    fileWithoutRecord = [],
    missingSidecars = [],
    derivativeIssues = [],
    staleManifest = [],
    conflictingPaths = [];
  for (const t of tweets) {
    const ds = byTweet.get(String(t.id)) || [];
    for (const md of t.media || []) {
      const ok = ds.some(
        d =>
          d.state === 'complete' &&
          (d.item?.mediaId && md.id
            ? String(d.item.mediaId) === String(md.id)
            : String(d.item?.url || '') === String(md.playbackUrl || md.url || ''))
      );
      if (!ok)
        missing.push({
          confidence: 'detected',
          tweetId: t.id,
          mediaId: md.id || null,
          type: md.type || 'unknown',
          url: md.playbackUrl || md.url || null,
        });
    }
  }
  for (const d of downloads) {
    const file = d.target?.filename || d.filename || null,
      ext = String(d.target?.ext || file || '').toLowerCase(),
      logical = String(d.item?.mediaType || d.item?.sourceMediaType || '').toLowerCase();
    if (d.state === 'complete' && Number(d.totalBytes || 0) === 0)
      zeroByte.push({ confidence: 'detected', key: d.key, tweetId: d.item?.tweetId || null, file });
    if (!d.item?.tweetId || !tweetIds.has(String(d.item.tweetId)))
      fileWithoutRecord.push({
        confidence: d.item?.tweetId ? 'detected' : 'unknown',
        key: d.key,
        tweetId: d.item?.tweetId || null,
        file,
      });
    if (d.item?.tweetId && !tweetIds.has(String(d.item.tweetId)))
      orphaned.push({ confidence: 'detected', key: d.key, tweetId: d.item.tweetId, file });
    if (d.state === 'complete' && ['photo', 'image'].includes(logical) && /\.(mp4|webm|mov)$/.test(ext))
      wrongFormat.push({ confidence: 'detected', key: d.key, file, expected: 'image' });
    if (d.sha256) {
      if (hashes.has(d.sha256))
        duplicates.push({ confidence: 'detected', hash: d.sha256, a: hashes.get(d.sha256), b: file || d.key });
      else hashes.set(d.sha256, file || d.key);
    }
    const prior = paths.get(d.key);
    if (prior && prior !== file) conflictingPaths.push({ confidence: 'detected', key: d.key, paths: [prior, file] });
    paths.set(d.key, file);
  }
  for (const c of conversions) {
    const source = downloads.find(
      d => d.key === c.downloadKey || d.filename === c.input || d.target?.filename === c.input
    );
    if (!source)
      derivativeIssues.push({
        confidence: 'detected',
        jobId: c.jobId || null,
        key: c.id,
        reason: 'Conversion source record is missing',
      });
    else if (
      ['failed', 'cancelled'].includes(c.state) ||
      ['mismatch', 'corrupt', 'missing'].includes(c.verification?.state)
    )
      derivativeIssues.push({
        confidence: 'detected',
        jobId: c.jobId || null,
        key: c.id,
        reason: c.verification?.reason || `Derivative ${c.state}`,
      });
  }
  if (s.sidecarMetadata) {
    for (const d of downloads.filter(x => x.state === 'complete'))
      if (!d.sidecarPath)
        missingSidecars.push({
          confidence: 'unknown',
          key: d.key,
          file: d.target?.filename || null,
          reason: 'Sidecar metadata is enabled but no sidecar path is recorded',
        });
  }
  const completeFiles = new Set(
    downloads.filter(d => d.state === 'complete').map(d => String(d.target?.filename || d.filename || ''))
  );
  for (const m of manifests) {
    for (const row of m.rows || [])
      for (const f of row.files || [])
        if (f.filename && !completeFiles.has(String(f.filename)))
          staleManifest.push({ confidence: 'detected', manifestId: m.id, filename: f.filename, tweetId: row.tweetId });
  }
  const summary = {
    missing: missing.length,
    zeroByte: zeroByte.length,
    wrongFormat: wrongFormat.length,
    orphaned: orphaned.length,
    fileWithoutRecord: fileWithoutRecord.length,
    duplicates: duplicates.length,
    missingSidecars: missingSidecars.length,
    derivativeIssues: derivativeIssues.length,
    staleManifest: staleManifest.length,
    conflictingPaths: conflictingPaths.length,
    posts: tweets.length,
    downloads: downloads.length,
  };
  const report = {
    id: 'latest',
    createdAt: Date.now(),
    summary,
    missing,
    zeroByte,
    wrongFormat,
    orphaned,
    fileWithoutRecord,
    duplicates,
    missingSidecars,
    derivativeIssues,
    staleManifest,
    conflictingPaths,
  };
  await putMany('integrity', [report]);
  await action(
    'integrity',
    `Integrity scan: ${missing.length} missing · ${zeroByte.length} zero-byte · ${derivativeIssues.length} derivative issues`,
    summary
  );
  return report;
}
async function integrityRepairPreview() {
  const report =
      (await store('integrity', 'readonly', os => req(os.get('latest'))).catch(() => null)) || (await integrityScan()),
    suggestions = [];
  for (const x of report.zeroByte || [])
    suggestions.push({
      id: `zero:${x.key}`,
      problem: 'Suspicious zero-byte download',
      evidence: x,
      action: 're-download',
      destructive: false,
    });
  for (const x of report.missing || [])
    suggestions.push({
      id: `missing:${x.tweetId}:${x.mediaId || x.url || ''}`,
      problem: 'Media record has no verified local download',
      evidence: x,
      action: 're-download',
      destructive: false,
    });
  for (const x of report.derivativeIssues || [])
    suggestions.push({
      id: `derivative:${x.key}`,
      problem: 'Derivative is missing or invalid',
      evidence: x,
      action: 'regenerate derivative',
      destructive: false,
    });
  for (const x of report.duplicates || [])
    suggestions.push({
      id: `duplicate:${x.hash}`,
      problem: 'Verified duplicate content',
      evidence: x,
      action: 'consolidate metadata (preview only)',
      destructive: true,
    });
  for (const x of report.orphaned || [])
    suggestions.push({
      id: `orphan:${x.key}`,
      problem: 'Download has no matching post record',
      evidence: x,
      action: 'ignore or inspect',
      destructive: true,
    });
  return { ok: true, report, suggestions };
}
async function integrityRepairApply(ids = [], confirm = false) {
  if (!confirm) return { ok: false, error: 'Explicit repair confirmation is required' };
  const wanted = [...new Set(ids.map(value => String(value).replace(/^zero:/, '')))].slice(0, 1000),
    changed = [];
  for (const key of wanted) {
    const row = await store('downloads', 'readonly', s => req(s.get(key))).catch(() => null);
    if (!row || (row.state === 'complete' && Number(row.totalBytes || 0) > 0) || !row.item?.url) continue;
    if (!transitionDownload(row, 'queued')) continue;
    row.error = null;
    row.failureReason = 'integrity-repair';
    row.downloadId = null;
    row.nextAttemptAt = null;
    row.updatedAt = Date.now();
    await putMany('downloads', [row]);
    queueRow(row);
    changed.push(row.key);
  }
  if (changed.length) {
    pump();
    await action(
      'integrity-repair',
      `Queued ${changed.length} safe integrity repair download${changed.length === 1 ? '' : 's'}`,
      { keys: changed }
    );
  }
  return { ok: true, repaired: changed.length, ignored: Math.max(0, ids.length - changed.length) };
}
async function makeManifest(scope = 'all') {
  const [tweets, downloads] = await Promise.all([all('tweets'), all('downloads')]),
    byTweet = new Map();
  for (const d of downloads) {
    const id = String(d.item?.tweetId || '');
    if (!byTweet.has(id)) byTweet.set(id, []);
    byTweet.get(id).push(d);
  }
  const rows = tweets.map(t => ({
    tweetId: t.id,
    url: t.url,
    author: t.author?.handle || null,
    displayName: t.author?.name || null,
    createdAt: t.createdAt,
    archivedAt: t.archivedAt,
    metrics: t.metrics || {},
    tags: t.userMeta?.tags || [],
    favorite: !!t.userMeta?.favorite,
    files: (byTweet.get(String(t.id)) || [])
      .filter(d => d.state === 'complete')
      .map(d => ({
        filename: d.target?.filename || d.filename || null,
        sha256: d.sha256 || null,
        mime: d.target?.mime || d.item?.mime || null,
        logicalType: d.item?.logicalType || d.item?.mediaType || null,
        sourceUrl: d.item?.url || null,
        size: d.totalBytes || 0,
      })),
  }));
  const manifest = { id: crypto.randomUUID(), createdAt: Date.now(), scope, version: 1, rows };
  await putMany('manifests', [manifest]);
  return manifest;
}
async function createSnapshot(source = 'all') {
  const tweets = await all('tweets'),
    rows = tweets
      .filter(
        t =>
          source === 'all' ||
          [...(t.sourceFlags || []), ...(t.archiveSources || [])].some(x =>
            String(x).toLowerCase().includes(String(source).toLowerCase())
          )
      )
      .map(t => ({ id: t.id, metrics: t.metrics || {}, archivedAt: t.archivedAt, mediaCount: (t.media || []).length }));
  const snap = { id: crypto.randomUUID(), source, createdAt: Date.now(), count: rows.length, rows };
  await putMany('snapshots', [snap]);
  return snap;
}
async function librarySummary() {
  const [tweets, downloads] = await Promise.all([all('tweets'), all('downloads')]);
  const authors = new Map();
  let images = 0,
    gifs = 0,
    videos = 0,
    sensitive = 0;
  for (const t of tweets) {
    if (t.sensitive) sensitive++;
    const h = t.author?.handle || 'unknown',
      a = authors.get(h) || {
        handle: h,
        name: t.author?.name || h,
        posts: 0,
        images: 0,
        gifs: 0,
        videos: 0,
        likes: 0,
        views: 0,
      };
    a.posts++;
    a.likes += Number(t.metrics?.likes || 0);
    a.views += Number(t.metrics?.views || 0);
    for (const m of t.media || []) {
      if (m.type === 'photo') {
        images++;
        a.images++;
      } else if (m.type === 'animated_gif') {
        gifs++;
        a.gifs++;
      } else if (m.type === 'video') {
        videos++;
        a.videos++;
      }
    }
    authors.set(h, a);
  }
  return {
    posts: tweets.length,
    images,
    gifs,
    videos,
    sensitive,
    authors: [...authors.values()].sort((a, b) => b.posts - a.posts),
    downloaded: downloads.filter(x => x.state === 'complete').length,
    bytes: downloads.filter(x => x.state === 'complete').reduce((n, x) => n + Number(x.totalBytes || 0), 0),
  };
}
chrome.runtime.onMessage.addListener((m, s, reply) => {
  (async () => {
    const messageCapability = authorizeMessage(m, s, chrome.runtime.id);
    await privateStorageReady;
    if (m.type === 'REMOTE_COMMAND') {
      const allowed = new Set([
        'remote.start',
        'remote.stop',
        'remote.status',
        'pairing.start',
        'pairing.regenerate',
        'pairing.pending',
        'pairing.approve',
        'pairing.deny',
        'devices.list',
        'device.permissions',
        'device.revoke',
      ]);
      const name = String(m.name || '');
      if (!allowed.has(name)) throw Error('Unsupported Remote command');
      const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
      const result = await remoteHostCommand(name, payload);
      return result;
    }
    if (m.type === 'INJECT_HOOK') {
      if (!s.tab?.id) throw Error('No tab');
      await chrome.scripting.executeScript({ target: { tabId: s.tab.id }, files: ['page-hook.js'], world: 'MAIN' });
      return { ok: true };
    }
    if (m.type === 'STORE_RECORDS') {
      const incoming = m.tweets || [],
        tweets = await mergeTweetRows(incoming),
        users = m.users || [];
      await putMany('users', users);
      await storeProfileSnapshots(users, m.context || {});
      for (const id of [...new Set(incoming.map(t => t?.observedRunId).filter(Boolean))]) {
        const run = await store('archiveRuns', 'readonly', os => req(os.get(id))).catch(() => null);
        if (run?.diff || run?.state === 'settling')
          scheduleRunReconciliation(id, {
            scope: run.source || 'timeline',
            profileHandle: run.profileHandle || null,
            state: run.finalState || run.state,
          });
      }
      return { ok: true, tweets };
    }
    if (m.type === 'HAS_TWEETS') {
      const ids = m.ids || [];
      const found = [];
      await store('tweets', 'readonly', async os => {
        for (const id of ids) if (await req(os.get(String(id)))) found.push(String(id));
      });
      return { ok: true, found };
    }
    if (m.type === 'GET_ARCHIVE_INDICATORS') {
      if (messageCapability !== 'content') throw Error('Archive status is available only to X widgets');
      return await archiveIndicators(m.ids);
    }
    if (m.type === 'GET_TWEET_IDS') {
      const rows = await all('tweets');
      return { ok: true, ids: rows.map(x => String(x.id)) };
    }
    if (m.type === 'STORE_CAPTURE') {
      await putMany('captures', [{ ...m.capture, key: m.capture.key || crypto.randomUUID() }]);
      return { ok: true };
    }
    if (m.type === 'STORE_JOB') {
      await putMany('jobs', [m.job]);
      if (m.job?.id && m.job?.context) {
        if (['initializing', 'running'].includes(m.job.state)) await beginArchiveRun(m.job);
        const prev = await store('sessions', 'readonly', os => req(os.get(m.job.id))).catch(() => null);
        await putMany('sessions', [
          {
            ...(prev || {}),
            id: m.job.id,
            source: m.job.context.scope || 'timeline',
            profileHandle: m.job.context.profileHandle || null,
            startedAt: prev?.startedAt || Date.now(),
            updatedAt: Date.now(),
            state: m.job.state,
            phase: m.job.phase,
            page: m.job.page || 0,
            posts: m.job.posts || prev?.posts || 0,
            error: m.job.error || null,
          },
        ]);
        if (['complete', 'error'].includes(m.job.state)) {
          await markArchiveSettling(m.job);
          scheduleRunReconciliation(m.job.id, {
            scope: m.job.context.scope || 'timeline',
            profileHandle: m.job.context.profileHandle || null,
            state: m.job.state,
          });
        }
      }
      await updateBadge();
      return { ok: true };
    }
    if (m.type === 'STORE_ACTION') {
      return { ok: true, row: await action(m.actionType || 'info', m.text || '', m.meta || {}) };
    }
    if (m.type === 'STORE_CHECKPOINT') {
      await putMany('checkpoints', [m.checkpoint]);
      return { ok: true };
    }
    if (m.type === 'GET_CHECKPOINT')
      return { ok: true, checkpoint: await store('checkpoints', 'readonly', os => req(os.get(m.key))) };
    if (m.type === 'CLEAR_CHECKPOINT') {
      await store('checkpoints', 'readwrite', os => req(os.delete(m.key)));
      return { ok: true };
    }
    if (m.type === 'GET_SETTINGS') {
      const value = await getSettings();
      return messageCapability === 'content'
        ? { ok: true, settings: contentSettings(value) }
        : { ok: true, settings: value, defaults: structuredClone(defaults) };
    }
    if (m.type === 'UPDATE_SMART_COLLECTIONS') return await updateSmartCollections(m.change);
    if (m.type === 'UPDATE_WORKSPACE') return await updateWorkspace(m.change);
    if (m.type === 'GET_CAPTURE_TEMPLATES')
      return { ok: true, templates: (await chrome.storage.local.get('graphqlTemplates')).graphqlTemplates || {} };
    if (m.type === 'STORE_CAPTURE_TEMPLATES') return await storeCaptureTemplates(m.templates);
    if (m.type === 'SET_SETTINGS') {
      const value = await setSettings(m.settings || {});
      return { ok: true, settings: messageCapability === 'content' ? contentSettings(value) : value };
    }
    if (m.type === 'RESET_SETTINGS') {
      await chrome.storage.local.set({ settings: { ...defaults } });
      return { ok: true, settings: await getSettings() };
    }
    if (m.type === 'RESTORE_PREVIOUS_SETTINGS') {
      const h = (await chrome.storage.local.get('settingsHistory')).settingsHistory || [];
      const prev = h.shift();
      if (!prev) return { ok: false, error: 'No settings history' };
      await chrome.storage.local.set({ settings: prev.settings, settingsHistory: h });
      return { ok: true, settings: await getSettings() };
    }
    if (m.type === 'RESET_FLOATING_POSITION') {
      const value = await setSettings({ cornerRight: 18, cornerBottom: 18, cornerScale: 1, cornerOpacity: 1 });
      return { ok: true, settings: messageCapability === 'content' ? contentSettings(value) : value };
    }
    if (m.type === 'RESET_SECTION') {
      const keys = m.keys || [];
      const patch = {};
      for (const k of keys) if (k in defaults) patch[k] = defaults[k];
      return { ok: true, settings: await setSettings(patch) };
    }
    if (m.type === 'ACTIVE_X_TAB') {
      const t = await activeXTab();
      return { ok: true, tab: t ? { id: t.id, url: t.url, title: t.title, status: t.status } : null };
    }
    if (m.type === 'NAVIGATE_X') {
      let t = await activeXTab();
      if (t?.id) {
        await chrome.tabs.update(t.id, { url: m.url, active: true });
        return { ok: true, tabId: t.id };
      }
      t = await chrome.tabs.create({ url: m.url, active: true });
      return { ok: true, tabId: t.id };
    }
    if (m.type === 'SEND_TO_TAB') {
      const t = messageCapability === 'content' ? s.tab : await activeXTab();
      if (!t) throw Error('Open x.com first');
      return { ok: true, reply: await sendToX(t.id, m.payload), tabId: t.id };
    }
    if (m.type === 'OPEN_DASHBOARD') return await openDashboard(m.page || '');
    if (m.type === 'OPEN_SIDE_PANEL') {
      const tabId = s.tab?.id || m.tabId || (await activeXTab())?.id;
      if (!tabId || !chrome.sidePanel?.open) throw Error('Side panel unavailable');
      await chrome.sidePanel.open({ tabId });
      return { ok: true };
    }
    if (m.type === 'STATS') {
      const vals = await Promise.all(STORES.map(count)),
        m = Object.fromEntries(STORES.map((k, i) => [k, vals[i]]));
      const stored = await navigator.storage?.estimate?.().catch(() => null);
      return { ok: true, ...m, stored, downloadQueue: await queueStats() };
    }
    if (m.type === 'GET_JOB') {
      const id = String(m.id || '');
      if (!id || id.length > 128) throw Error('Invalid archive job ID');
      return { ok: true, job: (await store('jobs', 'readonly', os => req(os.get(id)))) || null };
    }
    if (m.type === 'GET_ALL') {
      const vals = await Promise.all(STORES.map(all));
      return { ok: true, data: Object.fromEntries(STORES.map((k, i) => [k, vals[i]])) };
    }
    if (m.type === 'READ_RECOVERY_BACKUP_PAGE') {
      const database = await db();
      try {
        return {
          ok: true,
          ...(await readLibraryBackupPage(database, m.store, m.afterKey ?? null, m.limit, m.expectedRevision)),
        };
      } finally {
        database.close();
      }
    }
    if (m.type === 'PREVIEW_RECOVERY_BATCH') {
      const database = await db();
      try {
        return {
          ok: true,
          ...(await previewArchiveImportBatch(
            database,
            m.records,
            m.expectedRevision,
            m.expectedDownloadRevision,
            m.importId
          )),
        };
      } finally {
        database.close();
      }
    }
    if (m.type === 'BEGIN_RECOVERY_IMPORT') {
      const database = await db();
      try {
        return await beginArchiveImport(database, m.options || {});
      } finally {
        database.close();
      }
    }
    if (m.type === 'COMMIT_RECOVERY_BATCH') {
      const database = await db();
      try {
        const result = await commitArchiveImportBatch(database, m.batch || {});
        if (result.changedIds?.length) announceLibraryChanges(result.changedIds, 'restore');
        return result;
      } finally {
        database.close();
      }
    }
    if (m.type === 'COMPLETE_RECOVERY_IMPORT') {
      const database = await db();
      try {
        return await completeArchiveImport(
          database,
          m.jobId,
          m.fingerprint,
          m.expectedRevision,
          m.expectedDownloadRevision,
          m.footer
        );
      } finally {
        database.close();
      }
    }
    if (m.type === 'GET_RECOVERY_IMPORT_JOB') {
      const database = await db();
      try {
        return { ok: true, job: await getArchiveImportJob(database, m.jobId) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'FIND_RECOVERY_IMPORT_JOB') {
      const database = await db();
      try {
        return { ok: true, job: await findArchiveImportJob(database, m.importId, m.fingerprint) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'READ_RECOVERY_IMPORT_CONFLICTS') {
      const database = await db();
      try {
        return { ok: true, ...(await readArchiveImportConflicts(database, m.importId, m.afterKey ?? null, m.limit)) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'READ_RECOVERY_ASSET_REFERENCES') {
      const database = await db();
      try {
        return { ok: true, ...(await readArchiveAssetReferences(database, m.importId, m.afterKey ?? null, m.limit)) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'GET_LIBRARY_ROWS') return { ok: true, rows: await all('tweets') };
    if (m.type === 'GET_LIBRARY_RECORDS') {
      const ids = m.ids || [];
      if (!Array.isArray(ids) || ids.length > 1000) throw Error('Library record reads require at most 1,000 post IDs');
      const database = await db();
      try {
        return { ok: true, rows: await readLibraryRecords(database, ids) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'GET_LIBRARY_CHUNK') {
      const database = await db();
      try {
        return {
          ok: true,
          ...(await readLibraryPage(database, m.afterKey, Math.min(1000, Math.max(1, Number(m.limit) || 500)))),
        };
      } finally {
        database.close();
      }
    }
    if (m.type === 'QUERY_LIBRARY_PAGE') return await queryLibraryPage(m);
    if (m.type === 'GET_LIBRARY_QUERY_PROGRESS') {
      const queryId = String(m.queryId || '');
      return { ok: true, progress: activeLibraryQueryProgress.get(queryId) || null };
    }
    if (m.type === 'CANCEL_LIBRARY_QUERY') {
      const query = activeLibraryQueries.get(String(m.queryId || ''));
      if (query) query.cancelled = true;
      return { ok: true, cancelled: !!query };
    }
    if (m.type === 'CANCEL_LIBRARY_PLAN') {
      const signal = libraryPlanSignals.get(String(m.requestId || ''));
      if (signal) signal.aborted = true;
      return { ok: true };
    }
    if (m.type === 'PLAN_LIBRARY_DOWNLOAD') {
      const id = String(m.requestId || crypto.randomUUID());
      if (id.length > 80) throw Error('Invalid plan identity');
      const previous = libraryPlanSignals.get(id);
      if (previous) previous.aborted = true;
      const signal = { aborted: false };
      libraryPlanSignals.set(id, signal);
      try {
        return await libraryBulkPlan(m.options || {}, null, signal);
      } finally {
        if (libraryPlanSignals.get(id) === signal) libraryPlanSignals.delete(id);
      }
    }
    if (m.type === 'START_LIBRARY_BULK_DOWNLOAD') return await startLibraryBulk(m.options || {});
    if (m.type === 'GET_RECENT_ACTIONS') {
      const rows = await all('actions');
      rows.sort((a, b) => b.at - a.at);
      return { ok: true, rows: rows.slice(0, m.limit || 100) };
    }
    if (m.type === 'CLEAR_LIBRARY') {
      const database = await db();
      let result;
      try {
        result = await clearLibraryData(database);
      } finally {
        database.close();
      }
      announceLibraryChanges([], 'clear');
      await action('clear', 'Local library and its historical metadata cleared').catch(() => {});
      return result;
    }
    if (m.type === 'CLEAR_ALL') {
      clearQueueBuffer();
      const database = await db();
      let result;
      try {
        result = await clearLibraryData(database, [...STORES, 'libraryPlans']);
      } finally {
        database.close();
      }
      active.clear();
      announceLibraryChanges([], 'clear');
      return result;
    }
    if (m.type === 'QUEUE_DOWNLOADS' || m.type === 'DOWNLOAD_URLS')
      return await enqueue(m.items || [], !!m.force, {
        source: messageCapability === 'content' ? 'x.com' : 'dashboard',
        tabId: messageCapability === 'content' ? s.tab?.id : null,
      });
    if (m.type === 'GET_DOWNLOAD_DECISIONS') {
      await decisionsReady;
      return { ok: true, rows: downloadDecisions.slice(-Number(m.limit || 200)).reverse() };
    }
    if (m.type === 'DOWNLOAD_QUEUE_STATS') return { ok: true, ...(await queueStats()) };
    if (m.type === 'GET_DOWNLOAD_HISTORY') {
      const database = await db();
      try {
        return { ok: true, ...(await readDownloadHistoryPage(database, m.limit || 60)) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'GET_DOWNLOADS_FOR_TWEETS') {
      const database = await db();
      try {
        const rows = await readDownloadRows(database, m.ids || [], {
          perPostLimit: m.perPostLimit || 64,
          totalLimit: m.totalLimit || 5000,
        });
        return { ok: true, rows, truncated: !!rows.truncated };
      } finally {
        database.close();
      }
    }
    if (m.type === 'RETRY_FAILED') return await retryFailed();
    if (m.type === 'REBUILD_QUEUED_TARGETS') return await rebuildTargets();
    if (m.type === 'CLEAR_COMPLETED_DOWNLOADS') return await clearState('complete');
    if (m.type === 'CLEAR_FAILED_DOWNLOADS') return await clearState('failed');
    if (m.type === 'CANCEL_QUEUED_DOWNLOADS') return await clearState('queued');
    if (m.type === 'PAUSE_DOWNLOAD') {
      try {
        await chrome.downloads.pause(m.downloadId);
        await setDownloadStateById(m.downloadId, 'paused');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    if (m.type === 'RESUME_DOWNLOAD') {
      try {
        await chrome.downloads.resume(m.downloadId);
        await setDownloadStateById(m.downloadId, 'downloading');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    if (m.type === 'CANCEL_DOWNLOAD') {
      try {
        await chrome.downloads.cancel(m.downloadId);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    if (m.type === 'PAUSE_ALL_DOWNLOADS') {
      let n = 0;
      for (const r of active.values())
        if (r.downloadId)
          try {
            await chrome.downloads.pause(r.downloadId);
            await setDownloadStateById(r.downloadId, 'paused');
            n++;
          } catch {}
      return { ok: true, paused: n };
    }
    if (m.type === 'RESUME_ALL_DOWNLOADS') {
      let n = 0;
      for (const r of active.values())
        if (r.downloadId)
          try {
            await chrome.downloads.resume(r.downloadId);
            await setDownloadStateById(r.downloadId, 'downloading');
            n++;
          } catch {}
      return { ok: true, resumed: n };
    }
    if (m.type === 'OPEN_DOWNLOAD_SOURCE') {
      const url = String(m.url || '');
      if (!/^https:\/\/(x\.com|twitter\.com)\//i.test(url))
        return { ok: false, error: 'Only X source posts can be opened' };
      await chrome.tabs.create({ url, active: true });
      return { ok: true };
    }
    if (m.type === 'OPEN_DOWNLOADS') {
      await chrome.tabs.create({ url: 'chrome://downloads' });
      return { ok: true };
    }
    if (m.type === 'SHOW_DOWNLOAD') {
      try {
        await chrome.downloads.show(Number(m.downloadId));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    if (m.type === 'OPEN_DOWNLOAD_FILE') {
      try {
        await chrome.downloads.open(Number(m.downloadId));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    if (m.type === 'FORCE_REDOWNLOAD') {
      const row = await store('downloads', 'readonly', os => req(os.get(m.key))).catch(() => null);
      if (!row?.item) return { ok: false, error: 'Download record not found' };
      return await enqueue([row.item], true, { source: 'redownload' });
    }
    if (m.type === 'TEST_DOWNLOAD') return await testDownload();
    if (m.type === 'HELPER_STATUS') return await helperStatus();
    if (m.type === 'GET_CONVERSION_STATUS') return await conversionStatus(m.key || '');
    if (m.type === 'REMOVE_CONVERSION_OUTPUT') {
      const format = String(m.format || '').toLowerCase();
      if (!['gif', 'webp'].includes(format)) return { ok: false, error: 'Only GIF or WebP derivatives can be removed' };
      const row = await store('conversions', 'readonly', os => req(os.get(String(m.key || '')))).catch(() => null);
      if (!row?.jobId) return { ok: false, error: 'Conversion job not found' };
      const removed = await helperPost('/conversions/remove-output', { jobId: row.jobId, format });
      if (!removed.ok) return removed;
      const helperRow = row.helper || {},
        descriptor = helperRow[format] || {};
      const nextHelper = {
        ...helperRow,
        [format]: {
          ...descriptor,
          state: removed.state || 'removed',
          ...(Number(removed.size) > 0 ? { size: Number(removed.size) } : {}),
        },
      };
      const oldVerification = row.verification || row.conversionVerification || {},
        oldOutputs = Array.isArray(oldVerification.outputs) ? oldVerification.outputs : [];
      const outputs = [
        ...oldOutputs.filter(item => item.label !== format),
        {
          label: format,
          state: removed.state || 'removed',
          size: Number(removed.size) || Number(descriptor.size) || null,
        },
      ];
      const verification = { ...oldVerification, state: 'verified-with-warning', outputs, at: Date.now() };
      const next = { ...row, helper: nextHelper, verification, updatedAt: Date.now() };
      await putMany('conversions', [next]);
      const download = await store('downloads', 'readonly', os => req(os.get(row.downloadKey || row.id))).catch(
        () => null
      );
      if (download)
        await putMany('downloads', [
          {
            ...download,
            conversionState: next.state,
            conversionVerification: verification,
            conversionUpdatedAt: Date.now(),
          },
        ]);
      await action(
        'conversion',
        removed.state === 'removed'
          ? `${format.toUpperCase()} derivative removed; original preserved`
          : `${format.toUpperCase()} derivative is already missing`,
        { jobId: row.jobId, format, originalPreserved: true }
      );
      return { ...removed, ok: true, key: String(m.key), conversion: next };
    }
    if (m.type === 'CANCEL_CONVERSION') {
      const row = await store('conversions', 'readonly', os => req(os.get(m.key))).catch(() => null);
      if (!row?.jobId) return { ok: false, error: 'Conversion job not found' };
      const out = await helperPost('/conversions/cancel', { jobId: row.jobId });
      if (out.ok) {
        await putMany('conversions', [
          { ...row, state: 'cancel-requested', cancelRequestedAt: Date.now(), updatedAt: Date.now() },
        ]);
        const dl = await store('downloads', 'readonly', os => req(os.get(row.downloadKey || row.id))).catch(() => null);
        if (dl)
          await putMany('downloads', [{ ...dl, conversionState: 'cancel-requested', conversionUpdatedAt: Date.now() }]);
      }
      return out;
    }
    if (m.type === 'RETRY_CONVERSION') {
      const row = await store('conversions', 'readonly', os => req(os.get(m.key))).catch(() => null);
      if (!row) return { ok: false, error: 'Conversion job not found' };
      const next = { ...row, state: 'queued', retryAt: Date.now(), error: null, updatedAt: Date.now() };
      await putMany('conversions', [next]);
      const dl = await store('downloads', 'readonly', os => req(os.get(row.downloadKey || row.id))).catch(() => null);
      if (dl)
        await putMany('downloads', [
          { ...dl, conversionState: 'queued', conversionVerification: null, conversionUpdatedAt: Date.now() },
        ]);
      try {
        await chrome.alarms.create('xvault-helper-poll', { periodInMinutes: 0.25 });
      } catch {}
      await action('conversion', 'Derivative regeneration queued', { jobId: row.jobId });
      return { ok: true, state: 'queued' };
    }
    if (m.type === 'ROTATE_HELPER_TOKEN') {
      const out = await helperPost('/auth/rotate', {});
      if (out.ok && out.token) await chrome.storage.local.set({ helperAuthToken: out.token });
      return out;
    }
    if (m.type === 'REPAIR_DOWNLOADS') return await repairDownloads();

    if (m.type === 'UPDATE_TWEET_META') {
      const database = await db();
      try {
        const result = await updateLibraryRecord(database, m.id, m.patch || {}, m.expectedNote);
        if (result.ok) {
          announceMetadata([m.id]);
          announceLibraryChanges([m.id], 'metadata');
        }
        return result;
      } finally {
        database.close();
      }
    }
    if (m.type === 'UPDATE_MEDIA_METADATA') {
      const database = await db();
      try {
        const result = await updateLibraryMediaMetadata(database, m.id, m.mediaKey, m.change || {});
        if (result.ok && !result.unchanged) {
          announceMetadata([m.id]);
          announceLibraryChanges([m.id], 'metadata');
        }
        return result;
      } finally {
        database.close();
      }
    }
    if (m.type === 'PREVIEW_MEDIA_SIDECAR') {
      const database = await db();
      try {
        return { ok: true, ...(await previewLibraryMediaSidecar(database, m.sidecar)) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'IMPORT_MEDIA_SIDECAR') {
      const database = await db();
      try {
        const result = await importLibraryMediaSidecar(
          database,
          m.sidecar,
          Date.now(),
          m.expectedRevision,
          m.expectedPlanId
        );
        if (result.ok && result.action !== 'already-imported') {
          const id = String(result.row?.id || m.sidecar?.post?.id || '');
          announceMetadata([id]);
          announceLibraryChanges([id], result.action === 'reconstructed' ? 'insert' : 'metadata');
        }
        return result;
      } finally {
        database.close();
      }
    }
    if (m.type === 'BULK_UPDATE_TWEET_META') {
      const database = await db();
      try {
        const result = await updateLibraryMetadata(database, m.ids, m.patch || {});
        announceMetadata(result.rows.map(row => row.id));
        announceLibraryChanges(
          result.rows.map(row => row.id),
          'metadata'
        );
        await action('library', `Updated ${result.updated} selected posts`, { count: result.updated });
        return { ok: true, ...result };
      } finally {
        database.close();
      }
    }
    if (m.type === 'MOVE_TWEETS_TO_TRASH') {
      const database = await db();
      try {
        const result = await moveLibraryToTrash(database, m.ids);
        announceLibraryChanges(result.ids, 'remove');
        return { ok: true, ...result };
      } finally {
        database.close();
      }
    }
    if (m.type === 'RESTORE_TWEETS_FROM_TRASH') {
      const database = await db();
      try {
        const result = await restoreLibraryFromTrash(database, m.ids);
        announceLibraryChanges(result.ids, 'restore');
        return { ok: true, ...result };
      } finally {
        database.close();
      }
    }
    if (m.type === 'RESTORE_TRASH') {
      const database = await db();
      try {
        let restored = 0,
          conflicts = [],
          cursor = null;
        const restoredIds = [];
        for (;;) {
          const page = await readTrashPage(database, cursor, 100);
          const result = await restoreLibraryFromTrash(
            database,
            page.rows.map(row => String(row.id))
          );
          restored += result.restored;
          restoredIds.push(...result.ids);
          conflicts.push(...result.conflicts);
          if (page.done) break;
          cursor = page.nextKey;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        announceLibraryChanges(restoredIds, 'restore');
        return { ok: true, restored, restoredIds, conflicts };
      } finally {
        database.close();
      }
    }
    if (m.type === 'GET_TRASH') {
      return { ok: true, rows: await all('trash') };
    }
    if (m.type === 'GET_LIBRARY_METADATA') {
      const database = await db();
      try {
        return { ok: true, rows: await readLibraryMetadata(database, m.ids) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'GET_TRASH_PAGE') {
      const database = await db();
      try {
        return { ok: true, ...(await readTrashPage(database, m.afterKey, m.limit, m.query)) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'MERGE_TRASH_METADATA') {
      const database = await db();
      try {
        const result = await mergeTrashMetadata(database, m.id, m.options);
        if (result.ok) {
          announceMetadata([m.id]);
          announceLibraryChanges([m.id], 'metadata');
        }
        return result;
      } finally {
        database.close();
      }
    }
    if (m.type === 'GET_TRASH_UNDO') {
      const database = await db();
      try {
        return { ok: true, ...(await readTrashUndo(database)) };
      } finally {
        database.close();
      }
    }
    if (m.type === 'GET_TRASH_RECORD') {
      const id = String(m.id || '');
      if (!id || id.length > 128) throw Error('Invalid post ID');
      return { ok: true, row: await store('trash', 'readonly', os => req(os.get(id))) };
    }
    if (m.type === 'GET_SESSIONS') {
      const rows = await all('jobs');
      rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { ok: true, rows: rows.slice(0, m.limit || 40) };
    }
    if (m.type === 'GET_EXPLORER_DATA') return { ok: true, data: await explorerData() };
    if (m.type === 'GET_ARCHIVE_RUNS') {
      const rows = await all('archiveRuns');
      rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      return { ok: true, rows: rows.slice(0, m.limit || 100) };
    }
    if (m.type === 'GET_REVISIONS') {
      const rows = (await all('revisions')).filter(r => !m.tweetId || String(r.tweetId) === String(m.tweetId));
      rows.sort((a, b) => (b.observedAt || 0) - (a.observedAt || 0));
      return { ok: true, rows: rows.slice(0, m.limit || 100) };
    }
    if (m.type === 'OPEN_URL') {
      await chrome.tabs.create({ url: m.url });
      return { ok: true };
    }

    if (m.type === 'INTEGRITY_SCAN') return { ok: true, report: await integrityScan() };
    if (m.type === 'INTEGRITY_REPAIR_PREVIEW') return await integrityRepairPreview();
    if (m.type === 'INTEGRITY_REPAIR_APPLY') return await integrityRepairApply(m.ids || [], m.confirm === true);
    if (m.type === 'GET_INTEGRITY')
      return { ok: true, report: await store('integrity', 'readonly', os => req(os.get('latest'))).catch(() => null) };
    if (m.type === 'GENERATE_MANIFEST') return { ok: true, manifest: await makeManifest(m.scope || 'all') };
    if (m.type === 'CREATE_SNAPSHOT') return { ok: true, snapshot: await createSnapshot(m.source || 'all') };
    if (m.type === 'GET_SNAPSHOTS') {
      const rows = await all('snapshots');
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, rows: rows.slice(0, m.limit || 50) };
    }
    if (m.type === 'LIBRARY_SUMMARY') return { ok: true, summary: await librarySummary() };
    if (m.type === 'GET_MANIFESTS') {
      const rows = await all('manifests');
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, rows: rows.slice(0, m.limit || 20) };
    }
    if (m.type === 'HEALTH_CHECK') return await healthCheck();
    if (m.type === 'NOTIFY') {
      await notify(m.title || 'XVault', m.message || '');
      return { ok: true };
    }
    if (m.type === 'WAKE') {
      wake(!!m.on);
      return { ok: true };
    }
    return { ok: false, error: 'Unknown message' };
  })()
    .then(reply)
    .catch(e => reply({ ok: false, error: e?.message || String(e) }));
  return true;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'xv-dashboard') return openDashboard();
  const map = {
    'xv-copy-original': 'x',
    'xv-copy-fixvx': 'fixvx',
    'xv-copy-fixupx': 'fixupx',
    'xv-copy-fxtwitter': 'fxtwitter',
    'xv-copy-vxtwitter': 'vxtwitter',
  };
  if (map[info.menuItemId])
    return sendToX(tab.id, { type: 'XV_INSTANT_COPY', url: info.linkUrl, provider: map[info.menuItemId] });
  if (info.menuItemId === 'xv-copy-default') return sendToX(tab.id, { type: 'XV_INSTANT_COPY', url: info.linkUrl });
  if (info.menuItemId === 'xv-archive') return sendToX(tab.id, { type: 'XV_INSTANT_ARCHIVE', url: info.linkUrl });
  if (info.menuItemId === 'xv-download') return sendToX(tab.id, { type: 'XV_INSTANT_DOWNLOAD', url: info.linkUrl });
});
chrome.commands.onCommand.addListener(async c => {
  if (c === 'open-dashboard') return openDashboard();
  const t = await activeXTab();
  if (!t?.id) return;
  const type =
    c === 'copy-centered'
      ? 'XV_COPY_CENTERED'
      : c === 'download-centered'
        ? 'XV_DOWNLOAD_CENTERED'
        : c === 'archive-centered'
          ? 'XV_ARCHIVE_CENTERED'
          : null;
  if (type) sendToX(t.id, { type });
});

function cleanSegment(s, f = 'Other') {
  return (
    String(s || f)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .trim() || f
  );
}
function cleanPath(s, f = 'XVault') {
  return (
    String(s || f)
      .split(/[\\/]+/)
      .filter(Boolean)
      .map(x => cleanSegment(x))
      .join('/') || f
  );
}
function urlExt(u) {
  try {
    const x = new URL(u),
      m = x.pathname.match(/\.([a-z0-9]{2,6})$/i),
      f = x.searchParams.get('format');
    return String(f || m?.[1] || '')
      .toLowerCase()
      .replace('jpeg', 'jpg');
  } catch {
    return '';
  }
}
function rnd(n) {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map(x => a[x % a.length]).join('');
}
function dateFolder(ts) {
  const d = ts ? new Date(ts) : new Date();
  return Number.isFinite(+d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'Unknown-date';
}
function baseName(x, i, s, ext) {
  const h = cleanSegment((x.author || 'x').replace(/^@/, ''), 'x'),
    id = String(x.tweetId || Date.now()),
    n = String(x.index || i).padStart(2, '0'),
    d = x.createdAt ? new Date(x.createdAt) : new Date(),
    date = Number.isFinite(+d) ? d.toISOString().slice(0, 10) : 'date';
  let b;
  if (s.fileNaming === 'random') b = rnd(s.randomNameLength || 7);
  else if (s.fileNaming === 'id') b = `${id}-${n}`;
  else if (s.fileNaming === 'author-id') b = `${h}-${id}`;
  else if (s.fileNaming === 'custom') {
    b = (s.customFilenameTemplate || '{author}_{tweetId}_{index}')
      .replaceAll('{author}', h)
      .replaceAll('{tweetId}', id)
      .replaceAll('{index}', n)
      .replaceAll('{date}', date);
    b = cleanSegment(b, 'media');
  } else b = `${h}-${id}-${n}`;
  return `${b}.${ext || 'bin'}`;
}
function keyFor(x) {
  return mediaIdentity(x);
}
function mimeExt(m = '') {
  m = String(m).toLowerCase();
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('avif')) return 'avif';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  return '';
}
function magic(bytes) {
  if (!bytes?.length) return {};
  const b = bytes,
    txt = new TextDecoder('latin1').decode(b.slice(0, Math.min(b.length, 262144))),
    trim = txt
      .replace(/^\uFEFF/, '')
      .trimStart()
      .toLowerCase();
  if (/^<!doctype\s+html|^<html[\s>]/i.test(trim)) return { ext: 'html', kind: 'html' };
  if (/^[\[{]/.test(trim)) return { ext: 'json', kind: 'json' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', kind: 'image' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', kind: 'image' };
  if (txt.startsWith('GIF87a') || txt.startsWith('GIF89a')) return { ext: 'gif', kind: 'gif' };
  if (txt.slice(0, 4) === 'RIFF' && txt.slice(8, 12) === 'WEBP')
    return {
      ext: 'webp',
      kind: txt.includes('ANIM') || txt.includes('ANMF') ? 'gif' : 'image',
      animatedWebP: txt.includes('ANIM') || txt.includes('ANMF'),
    };
  if (txt.slice(4, 8) === 'ftyp')
    return {
      ext: /avif|avis/.test(txt.slice(8, 32)) ? 'avif' : 'mp4',
      kind: /avif|avis/.test(txt.slice(8, 32)) ? 'image' : 'video',
    };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm', kind: 'video' };
  return {};
}
async function responseHeaderBytes(response, maxBytes = 262144) {
  return readResponsePrefix(response, maxBytes);
}
async function probe(item, s) {
  if (item.knownSize != null) {
    const hint = String(item.mediaType || item.sourceMediaType || '').toLowerCase(),
      ext = urlExt(item.url) || (/animated|gif/.test(hint) ? 'mp4' : /video/.test(hint) ? 'mp4' : 'jpg'),
      kind = /animated|gif/.test(hint)
        ? 'gif'
        : /video/.test(hint)
          ? 'video'
          : /image|photo/.test(hint)
            ? 'image'
            : 'other';
    return { kind, ext, mime: '', size: Number(item.knownSize || 0), animatedWebP: /animated.*webp/.test(hint) };
  }
  let ext = item.ext || urlExt(item.url),
    mime = item.mime || '',
    size = 0,
    mg = {};
  const probeBytes = Math.max(65536, Math.min(1048576, Number(s.probeMediaBytes) || 524288));
  if (/^https?:/i.test(item.url || '')) {
    try {
      const r = await fetch(item.url, {
        headers: { Range: `bytes=0-${probeBytes - 1}` },
        cache: 'no-store',
        credentials: 'omit',
      });
      mime = mime || r.headers.get('content-type') || '';
      const cr = r.headers.get('content-range'),
        cl = r.headers.get('content-length');
      size = Number(cr?.match(/\/(\d+)$/)?.[1] || cl || 0);
      mg = magic(await responseHeaderBytes(r, probeBytes));
    } catch {}
  }
  ext = mg.ext || ext || mimeExt(mime);
  const hint = String(item.mediaType || item.type || item.sourceMediaType || '').toLowerCase(),
    animatedHint = /animated_gif|animated[-_ ]?webp|\bgif\b/.test(hint);
  let kind = animatedHint ? 'gif' : mg.kind || '';
  if (!kind && /photo|image/.test(hint)) kind = 'image';
  if (!kind && /video/.test(hint)) kind = 'video';
  if (!kind) {
    if (ext === 'gif') kind = 'gif';
    else if (ext === 'webp') kind = mg.animatedWebP ? 'gif' : 'image';
    else if (/jpg|jpeg|png|avif|bmp/.test(ext) || mime.startsWith('image/')) kind = 'image';
    else if (/mp4|webm|mov/.test(ext) || mime.startsWith('video/')) kind = 'video';
    else kind = 'other';
  }
  if (!ext) ext = kind === 'video' ? 'mp4' : kind === 'gif' ? 'gif' : 'bin';
  return { kind, ext, mime, size, animatedWebP: !!mg.animatedWebP, animatedHint, nativeKind: mg.kind || null };
}
async function shouldQueue(item, c, s) {
  if (c.kind === 'image') {
    if (s.imageRule === 'never') return false;
    if ((s.minImageWidth || 0) > 0 && (item.width || 0) < s.minImageWidth) return false;
    if ((s.minImageHeight || 0) > 0 && (item.height || 0) < s.minImageHeight) return false;
  }
  if (c.kind === 'gif' && s.gifRule === 'never') return false;
  if (c.kind === 'video') {
    if (s.videoRule === 'never') return false;
    if ((s.maxVideoMB || 0) > 0 && c.size > s.maxVideoMB * 1024 * 1024) return false;
  }
  if (s.skipProfilePictures && /profile_images|profile_banners/i.test(item.url || '')) return false;
  return true;
}
async function targetFor(item, index, s, c = null) {
  c = c || (await probe(item, s));
  const root = cleanPath(s.mediaFolder),
    parts = [root],
    profile = cleanSegment(item.profileHandle || item.archiveProfile || '', '');
  if (
    s.forceProfileSubfolder &&
    item.archiveScope === 'profile' &&
    profile &&
    s.profileFolderLayout === 'profile-first'
  ) {
    parts.push(cleanSegment(s.profileRootFolder || 'Profiles'));
    parts.push('@' + profile);
  }
  if ((s.sourceSeparation || s.organizeByArchiveSource) && item.archiveScope && item.archiveScope !== 'profile')
    parts.push(cleanSegment(String(item.archiveScope).replace(/^./, x => x.toUpperCase())));
  if (item.archiveScope === 'profile' && profile) {
    parts.push(cleanSegment(item.profileRelation === 'retweets' ? 'Retweets' : 'Media'));
  }
  if (s.organizeByType) {
    if (c.kind === 'gif') {
      parts.push(cleanSegment(s.gifFolder));
      if (c.ext === 'mp4' || c.ext === 'webm') parts.push(cleanSegment(s.animationOriginalFolder || 'Originals'));
      else if (c.ext === 'webp') parts.push(cleanSegment(s.animatedWebPFolder || 'WebP'));
      else if (c.ext === 'gif') parts.push(cleanSegment(s.nativeGifFolder || s.animationGifFolder || 'GIF'));
    } else
      parts.push(cleanSegment(c.kind === 'image' ? s.imageFolder : c.kind === 'video' ? s.videoFolder : s.otherFolder));
  }
  if (
    s.forceProfileSubfolder &&
    item.archiveScope === 'profile' &&
    profile &&
    s.profileFolderLayout !== 'profile-first'
  ) {
    parts.push(cleanSegment(s.profileRootFolder || 'Profiles'));
    parts.push('@' + profile);
  }
  if (s.organizeByAuthor) {
    const a = cleanSegment((item.author || 'unknown').replace(/^@/, ''));
    if (!profile || a.toLowerCase() !== profile.toLowerCase()) parts.push(a);
  }
  if (s.organizeByDate) parts.push(dateFolder(item.createdAt));
  parts.push(baseName(item, index, s, c.ext));
  return { filename: parts.join('/'), ...c };
}
async function maybeHash(item, c, s) {
  const maxBytes = Math.min(64 * 1024 * 1024, Math.floor(Number(s.hashDedupeMaxMB) || 0) * 1024 * 1024);
  if (!s.hashDedupe || !c.size || maxBytes < 1 || c.size > maxBytes) return null;
  try {
    const r = await fetch(item.url, { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) return null;
    const contentLength = Number(r.headers.get('content-length') || 0);
    if (contentLength > maxBytes) return null;
    const buf = await readResponseBytesBounded(r, maxBytes);
    if (!buf || buf.length !== c.size) return null;
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
// Bounded, secret-free record of every enqueue decision (URL query strings, which carry signatures, are never kept).
const downloadDecisions = [];
const decisionsReady = (async () => {
  try {
    const saved = (await chrome.storage.session?.get?.('xvDownloadDecisions'))?.xvDownloadDecisions;
    if (Array.isArray(saved)) downloadDecisions.unshift(...saved.slice(-300).map(sanitizeDownloadDecision));
  } catch {}
})();
function redactMediaUrl(value) {
  try {
    const u = new URL(String(value));
    return u.origin + u.pathname;
  } catch {
    return String(value || '')
      .split(/[?#]/)[0]
      .slice(0, 120);
  }
}
function sanitizeDownloadDecision(entry) {
  const asset = value =>
    /^https?:\/\//i.test(String(value || ''))
      ? redactMediaUrl(value)
      : String(value || '')
          .split(/[?#]/)[0]
          .slice(0, 180);
  const identity = value => {
    if (value == null) return null;
    const text = String(value),
      at = text.indexOf('|');
    return at < 0 ? asset(text) : `${text.slice(0, at)}|${asset(text.slice(at + 1))}`;
  };
  return {
    ...entry,
    url: redactMediaUrl(entry.url),
    asset: asset(entry.asset),
    identity: identity(entry.identity),
    matchKey: identity(entry.matchKey),
  };
}
async function recordDecision(entry) {
  await decisionsReady;
  downloadDecisions.push(
    sanitizeDownloadDecision({
      at: Date.now(),
      installationId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      browserPresence: 'not-checked',
      ...entry,
    })
  );
  if (downloadDecisions.length > 400) downloadDecisions.splice(0, downloadDecisions.length - 400);
  chrome.storage.session?.set?.({ xvDownloadDecisions: downloadDecisions.slice(-200) }).catch?.(() => {});
}
async function enqueueCore(items, force = false, context = {}) {
  if (!Array.isArray(items)) return { ok: false, error: 'Download requests must be a list' };
  if (items.length > 2000) return { ok: false, error: 'Queue downloads in batches of 2,000 files or fewer' };
  const s = await getSettings(),
    seen = new Set(),
    source = context.source || 'unknown';
  const installation = await installationProbe(context.tabId ? { id: context.tabId } : await activeXTab());
  if (installation.ids?.length > 1) {
    const error =
      'Multiple XVault copies are active on X. Choose one copy before downloading, then reload the X tab. Neither archive was changed.';
    for (const item of items.slice(0, 200))
      await recordDecision({
        source,
        tweetId: String(item?.tweetId || ''),
        identity: item?.url ? mediaIdentity(item) : null,
        asset: item?.url ? assetIdentity(item.url).asset : '',
        url: item?.url || '',
        code: 'multiple-installations',
        outcome: 'blocked',
        reason: error,
        installations: installation.ids,
      });
    return {
      ok: false,
      blocked: true,
      code: 'multiple-installations',
      error,
      added: 0,
      skipped: 0,
      installationIds: installation.ids,
    };
  }
  const requested = items.filter(raw => raw?.url),
    keys = requested.map(item => keyFor(item)),
    assets = [...new Set(requested.map(item => assetIdentity(item.url).asset).filter(Boolean))];
  const lookupStarted = performance.now(),
    database = await db();
  let primary, assetMatches;
  try {
    primary = await readDownloadRowsByKeys(database, keys);
    assetMatches =
      s.crossPostDuplicates === 'skip'
        ? await readExistingDownloadRowsByAssets(database, assets, { scanLimit: 5000 })
        : {
            rows: new Map(),
            recordsRead: 0,
            cursorOperations: 0,
            recordsMaterialized: 0,
            statesScanned: 0,
            scanLimit: 0,
            truncated: false,
            cancelled: false,
            index: 'none',
          };
  } finally {
    database.close();
  }
  const existingByIdentity = primary.rows,
    byAsset = assetMatches.rows;
  let hashScanRecords = 0,
    hashScanCursorOperations = 0;
  if (assetMatches.incompleteIndex) void runDownloadAssetIndexBackfill();
  const lookup = {
    identityRequests: primary.indexOperations,
    identityRowsRead: primary.recordsRead,
    identityRowsMaterialized: primary.recordsMaterialized,
    assetScanRecords: assetMatches.recordsRead,
    assetScanRetained: assetMatches.recordsMaterialized,
    assetScanCursorOperations: assetMatches.cursorOperations,
    assetScanStates: assetMatches.statesScanned,
    assetScanLimit: assetMatches.scanLimit || 0,
    assetScanIndex: assetMatches.index || 'none',
    assetIndexIncomplete: !!assetMatches.incompleteIndex,
    assetScanTruncated: !!assetMatches.truncated,
    hashScanRecords: 0,
    hashScanCursorOperations: 0,
    hashScanLimit: 50000,
    elapsedMs: Math.round(performance.now() - lookupStarted),
  };
  let added = 0,
    skipped = 0,
    filtered = 0,
    conversionOnly = 0,
    lookupBlocked = 0;
  for (const raw of items) {
    if (!raw?.url) continue;
    const item = { ...raw, url: String(raw.url) },
      key = keyFor(item),
      existing = existingByIdentity.get(key) || null;
    const asset = assetIdentity(item.url).asset,
      sibling = existing ? null : byAsset.get(asset) || null,
      decision = decideEnqueue({
        key,
        seenInRequest: seen.has(key),
        existing,
        force,
        skipCompletedDuplicates: context.existingPolicy === 'skip' || !!s.skipDuplicateDownloads,
        sibling,
        crossPostPolicy: s.crossPostDuplicates === 'skip' ? 'skip' : 'keep',
      });
    seen.add(key);
    const log = extra =>
      recordDecision({
        source,
        identity: key,
        asset: assetIdentity(item.url).asset,
        url: redactMediaUrl(item.url),
        tweetId: String(item.tweetId || ''),
        code: decision.code,
        reason: decision.reason,
        matchKey: decision.matchKey,
        matchState: decision.matchState,
        ...extra,
      });
    if ((assetMatches.truncated || assetMatches.cancelled) && !existing && !sibling) {
      skipped++;
      lookupBlocked++;
      const indexBuilding = !!assetMatches.incompleteIndex,
        code = indexBuilding ? 'asset-index-building' : 'asset-check-limit',
        reason = indexBuilding
          ? 'The local Save Once index is still being built from older downloads. No file was queued for this asset; try again after the index finishes.'
          : `Save Once could not finish checking ${assetMatches.scanLimit.toLocaleString()} existing download records. No file was queued for this asset.`;
      await recordDecision({
        source,
        identity: key,
        asset,
        url: redactMediaUrl(item.url),
        tweetId: String(item.tweetId || ''),
        code,
        outcome: 'blocked',
        reason,
      });
      continue;
    }
    if (!decision.accept) {
      if (decision.code === 'same-asset-other-post') {
        const database = await db();
        let linked;
        try {
          linked = await linkSharedFile(database, item, decision.matchKey);
        } finally {
          database.close();
        }
        if (linked.linked) announceLibraryChanges([String(item.tweetId)], 'download');
        else if (linked.conflict) {
          log({
            outcome: 'blocked',
            code: 'shared-link-conflict',
            reason: 'A different physical source is already associated. Its evidence was retained.',
          });
          skipped++;
          continue;
        }
      }
      if (
        decision.code === 'already-downloaded' &&
        (item.conversionGif || item.conversionWebP) &&
        ['verified', 'verified-with-warning', 'verification-unavailable'].includes(
          existing?.verification?.state || existing?.verificationState
        )
      ) {
        const scheduled = await markConversionExpected({ ...existing, item: { ...existing.item, ...item } }).catch(
          () => false
        );
        if (scheduled) {
          conversionOnly++;
          log({
            outcome: 'queued',
            code: 'derivatives-only',
            reason: 'Using the saved original for requested derivatives',
          });
          continue;
        }
      }
      skipped++;
      log({ outcome: 'skipped' });
      continue;
    }
    const c = await probe(item, s);
    if (!(await shouldQueue(item, c, s))) {
      filtered++;
      log({ outcome: 'filtered', reason: 'Filtered by your download rules' });
      continue;
    }
    const sha256 = await maybeHash(item, c, s);
    if (!force && decision.code !== 'keep-both' && sha256) {
      const hashDatabase = await db();
      let hashMatch;
      try {
        hashMatch = await findCompletedDownloadByHash(hashDatabase, sha256, { scanLimit: 50000 });
      } finally {
        hashDatabase.close();
      }
      hashScanRecords += hashMatch.recordsRead;
      hashScanCursorOperations += hashMatch.cursorOperations;
      if (hashMatch.found) {
        skipped++;
        log({ outcome: 'skipped', code: 'same-bytes', reason: 'Identical file content already downloaded' });
        continue;
      }
      if (hashMatch.truncated || hashMatch.cancelled) {
        skipped++;
        lookupBlocked++;
        log({
          outcome: 'blocked',
          code: 'hash-check-limit',
          reason: `Hash deduplication could not finish checking ${hashMatch.scanLimit.toLocaleString()} completed downloads. No file was queued for this asset.`,
        });
        continue;
      }
    }
    const target = await targetFor(item, added + 1, s, c),
      row = {
        key,
        item,
        target,
        sha256,
        requestedIntent: decision.code,
        sourceGeneration: crypto.randomUUID(),
        state: 'queued',
        stateRevision: 0,
        verificationState: 'verification-pending',
        attempts: 0,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
        bytesReceived: 0,
        totalBytes: c.size || 0,
        error: null,
        downloadId: null,
        speedBps: 0,
        lastBytes: 0,
        lastSampleAt: Date.now(),
        requestedBy: source,
      };
    // Preserve the previous completed file before reusing its canonical queue key.
    // Both rows commit together; a quota/abort cannot erase the earlier evidence.
    if (existing?.state === 'complete' && existing.key === key) {
      const database = await db();
      let replaced;
      try {
        replaced = await replaceCompletedDownloadWithHistory(database, row, {
          reason: decision.code,
          expectedDownloadId: existing.downloadId,
        });
      } finally {
        database.close();
      }
      if (!replaced.queued) {
        skipped++;
        log({
          outcome: 'skipped',
          code: 'state-changed',
          reason: 'The saved download changed while this request was prepared. Request it again.',
        });
        continue;
      }
      announceLibraryChanges(replaced.changedIds, 'download');
    } else {
      const database = await db();
      let reservation;
      try {
        reservation = await reserveLibraryDownload(database, row);
      } finally {
        database.close();
      }
      if (!reservation.queued) {
        skipped++;
        log({
          outcome: 'skipped',
          code: 'state-changed',
          reason: 'The canonical download became active or complete during preparation',
        });
        continue;
      }
    }
    existingByIdentity.set(key, row);
    byAsset.set(asset, row);
    queueRow(row);
    added++;
    log({ outcome: 'queued' });
  }
  lookup.hashScanRecords = hashScanRecords;
  lookup.hashScanCursorOperations = hashScanCursorOperations;
  lookup.lookupBlocked = lookupBlocked;
  lookup.elapsedMs = Math.round(performance.now() - lookupStarted);
  const blocked = lookupBlocked > 0,
    error = blocked
      ? `${lookupBlocked} file${lookupBlocked === 1 ? ' was' : 's were'} skipped because XVault could not safely finish a duplicate check; no uncertain file was queued.`
      : undefined;
  await action('queue', `Queued ${added} media file${added === 1 ? '' : 's'}`, {
    added,
    skipped,
    filtered,
    conversionOnly,
    lookupBlocked,
    source,
    lookup,
  });
  if (added) pump();
  updateBadge();
  return {
    ok: true,
    added: added + conversionOnly,
    skipped,
    filtered,
    conversionOnly,
    blocked,
    error,
    lookup,
    ...(await queueStats()),
  };
}
let enqueueTail = Promise.resolve();
function enqueue(items, force = false, context = {}) {
  const run = enqueueTail.then(() => enqueueCore(items, force, context));
  enqueueTail = run.catch(() => {});
  return run;
}
const bulkMediaKind = globalThis.XVaultBulkModel.mediaKind;
const bulkIsAnimation = globalThis.XVaultBulkModel.isAnimation;
const bulkMode = globalThis.XVaultBulkModel.outputMode;
function bulkQueryMatch(t, q = '', downloads = [], compiled = null) {
  return globalThis.XVaultLibrarySearch.matchesCompiledQuery(
    globalThis.XVaultLibrarySearch.projectPost(t, 0, { downloads }),
    compiled || globalThis.XVaultLibrarySearch.compileQuery(q)
  );
}
const bulkRequestedOutputs = globalThis.XVaultBulkModel.requestedOutputs;
function bulkItemForPost(post, m, index, options = {}) {
  const kind = bulkMediaKind(m),
    src =
      kind === 'gif' ? m.playbackUrl || m.url || m.variants?.[0]?.url : m.url || m.playbackUrl || m.variants?.[0]?.url;
  if (!src) return null;
  const out = bulkRequestedOutputs(m, options.animationMode || 'all');
  if (kind === 'gif' && !out.keepMp4 && !out.gif && !out.webp) return null;
  return {
    url: src,
    tweetId: String(post.id),
    sourcePostUrl: post.url || null,
    mediaId: m.id || `${post.id}-${index}`,
    index: index + 1,
    author: post.author?.handle || 'unknown',
    createdAt: post.createdAt || null,
    mediaType: m.type || kind,
    sourceMediaType: m.type || kind,
    width: m.width || 0,
    height: m.height || 0,
    archiveScope: post.archiveScope || post.archiveSources?.[0] || post.sourceFlags?.[0] || 'library',
    profileHandle: post.archiveProfile || post.profileHandle || post.author?.handle || '',
    profileRelation: post.profileRelation || 'media',
    conversionMode: options.animationMode || 'all',
    conversionKeepSource: out.keepMp4,
    conversionGif: out.gif,
    conversionWebP: out.webp,
    knownSize: Number(m.size || m.bytes || m.contentLength || 0) || 0,
  };
}
function bulkScopePost(t, options = {}, downloads = [], compiled = null) {
  const scope = options.scope || 'all',
    id = String(t.id || '');
  if (scope === 'selected' && !(options.selectedSet || new Set((options.selectedIds || []).map(String))).has(id))
    return false;
  if (scope === 'favorites' && !t.userMeta?.favorite) return false;
  if (
    scope === 'author' &&
    String(t.author?.handle || '')
      .replace(/^@/, '')
      .toLowerCase() !==
      String(options.author || '')
        .replace(/^@/, '')
        .toLowerCase()
  )
    return false;
  if (
    scope === 'tag' &&
    !(t.userMeta?.tags || []).some(
      x =>
        String(x).toLowerCase() ===
        String(options.tag || '')
          .replace(/^#/, '')
          .toLowerCase()
    )
  )
    return false;
  const date = t.createdAt || t.archivedAt || 0,
    at = typeof date === 'number' ? date : Number(date) || Date.parse(date) || 0;
  if (options.dateFrom && at < Number(options.dateFrom)) return false;
  if (options.dateTo && at > Number(options.dateTo)) return false;
  return bulkQueryMatch(t, options.query || '', downloads, compiled);
}
const libraryPlanSignals = new Map();
async function libraryBulkPlan(options = {}, consume = null, signal = null) {
  const database = await db();
  let afterKey = null,
    planned = 0,
    selectionOffset = 0;
  options = { ...options, selectedSet: new Set((options.selectedIds || []).map(String)) };
  const selectedIds = [...options.selectedSet];
  const totals = {
    postsScanned: 0,
    postsMatched: 0,
    media: 0,
    images: 0,
    videos: 0,
    animations: 0,
    animatedWebP: 0,
    estimatedBytes: 0,
    knownBytes: 0,
    alreadyLocal: 0,
    missing: 0,
    failed: 0,
    conversionRequired: 0,
    gifConversions: 0,
    webpConversions: 0,
  };
  const items = [];
  const mode = options.animationMode || 'all';
  const compiledQuery = globalThis.XVaultLibrarySearch.compileQuery(options.query || '');
  try {
    for (;;) {
      if (signal?.aborted) return { ok: false, cancelled: true, error: 'Planning cancelled' };
      const page =
          options.scope === 'selected'
            ? {
                rows: await readLibraryRecords(database, selectedIds.slice(selectionOffset, (selectionOffset += 128))),
                done: selectionOffset >= selectedIds.length,
              }
            : await readLibraryPage(database, afterKey, 128),
        tweets = page.rows;
      const downloads = await readDownloadRows(
          database,
          tweets.map(row => row.id)
        ),
        byKey = new Map(),
        byTweet = new Map(),
        batchItems = [];
      for (const row of downloads) {
        const k = `${row.item?.tweetId || ''}|${assetIdentity(row.item?.url).asset}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(row);
        if (row.item?.mediaId) {
          const mediaKey = `${row.item.tweetId}|media:${row.item.mediaId}`;
          if (!byKey.has(mediaKey)) byKey.set(mediaKey, []);
          byKey.get(mediaKey).push(row);
        }
        const id = String(row.item?.tweetId || '');
        if (id) {
          if (!byTweet.has(id)) byTweet.set(id, []);
          byTweet.get(id).push(row);
        }
      }
      for (const post of tweets) {
        totals.postsScanned++;
        if (!bulkScopePost(post, options, byTweet.get(String(post.id)) || [], compiledQuery)) continue;
        totals.postsMatched++;
        for (const [mIndex, m] of (post.media || []).entries()) {
          const kind = bulkMediaKind(m),
            animation = bulkIsAnimation(m);
          const allowed = globalThis.XVaultBulkModel.typeAllowed(m, options.mediaFilter || 'all');
          if (!allowed) continue;
          const key = `${post.id}|${assetIdentity(m.playbackUrl || m.url || m.variants?.[0]?.url).asset}`,
            rows = byKey.get(key) || byKey.get(`${post.id}|media:${m.id}`) || [],
            complete = rows.some(
              r =>
                r.state === 'complete' &&
                !['mismatch', 'corrupt', 'missing'].includes(r.verification?.state || r.verificationState)
            ),
            failed = rows.some(
              r =>
                r.state === 'failed' ||
                ['mismatch', 'corrupt', 'missing'].includes(r.verification?.state || r.verificationState)
            );
          if (options.onlyMissing && complete) continue;
          if (options.onlyFailed && !failed) continue;
          const out = bulkRequestedOutputs(m, mode);
          totals.media++;
          if (kind === 'image' && !animation) totals.images++;
          else if (kind === 'video' && !animation) totals.videos++;
          else if (animation) totals.animations++;
          if (animation && /webp/i.test(m.type || m.mediaType || '')) totals.animatedWebP++;
          const size = Number(m.size || m.bytes || m.contentLength || 0);
          totals.estimatedBytes += size;
          if (size) totals.knownBytes += size;
          if (complete) totals.alreadyLocal++;
          else if (failed) totals.failed++;
          else totals.missing++;
          if (out.gif || out.webp) {
            totals.conversionRequired++;
            if (out.gif) totals.gifConversions++;
            if (out.webp) totals.webpConversions++;
          }
          if (complete && (options.existingPolicy || 'skip') === 'skip') continue;
          const item = bulkItemForPost(post, m, mIndex, options);
          if (item) {
            planned++;
            if (consume) batchItems.push(item);
            else if (items.length < 100) items.push(item);
          }
        }
      }
      if (consume && batchItems.length) await consume(batchItems);
      if (page.done) break;
      afterKey = page.nextKey;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    database.close();
  }
  totals.needDownload = Math.max(0, totals.media - totals.alreadyLocal);
  return { ok: true, totals, items, sampleLimited: planned > items.length };
}
async function startLibraryBulk(options = {}) {
  const batch = Math.max(10, Math.min(200, Number((await getSettings()).bulkPlanBatchSize) || 80));
  let added = 0,
    skipped = 0,
    filtered = 0,
    lookupBlocked = 0;
  const plan = await libraryBulkPlan(options, async items => {
    for (let i = 0; i < items.length; i += batch) {
      const slice = items.slice(i, i + batch);
      const r = await enqueue(slice, options.existingPolicy === 'redownload', { source: 'bulk' });
      if (!r.ok) throw Error(r.error || 'Bulk queue is blocked');
      added += r.added || 0;
      skipped += r.skipped || 0;
      filtered += r.filtered || 0;
      lookupBlocked += r.lookup?.lookupBlocked || 0;
    }
  });
  const blocked = lookupBlocked > 0,
    error = blocked
      ? `${lookupBlocked} file${lookupBlocked === 1 ? ' was' : 's were'} skipped because XVault could not safely finish a duplicate check; no uncertain file was queued.`
      : undefined;
  const job = {
    id: `bulk:${crypto.randomUUID()}`,
    type: 'bulk-download',
    state: 'queued',
    startedAt: Date.now(),
    scope: options,
    totals: plan.totals,
    added,
    skipped,
    filtered,
    lookupBlocked,
  };
  await putMany('jobs', [job]);
  await action('bulk-download', `Bulk plan queued ${added} media`, {
    jobId: job.id,
    scope: options.scope || 'all',
    preset: options.preset || null,
    added,
    skipped,
    filtered,
    lookupBlocked,
  });
  return {
    ok: true,
    jobId: job.id,
    added,
    skipped,
    filtered,
    lookupBlocked,
    blocked,
    error,
    totals: plan.totals,
    ...(await queueStats()),
  };
}
async function queueStats() {
  const database = await db();
  let counts;
  try {
    counts = await new Promise((resolve, reject) => {
      const values = {
        total: null,
        countsReady: false,
        assetIndex: { complete: false, countsComplete: false, processed: 0 },
      };
      if (!database.objectStoreNames.contains('checkpoints')) {
        resolve(values);
        return;
      }
      const tx = database.transaction('checkpoints', 'readonly'),
        request = tx.objectStore('checkpoints').get(DOWNLOAD_ASSET_INDEX_CHECKPOINT);
      request.onsuccess = () => {
        const checkpoint = request.result || {},
          ready = checkpoint.countsComplete === true && checkpoint.stateCounterVersion === 1;
        values.countsReady = ready;
        values.assetIndex = {
          complete: checkpoint.complete === true,
          countsComplete: ready,
          processed: Math.max(0, Number(checkpoint.processed) || 0),
          error: downloadAssetIndexFailure?.reason || null,
        };
        if (ready) {
          const states = [
              'queued',
              'retry-wait',
              'downloading',
              'paused',
              'verifying',
              'converting',
              'complete',
              'failed',
              'cancelled',
            ],
            source = checkpoint.stateCounts || {};
          for (const state of states) values[state] = Math.max(0, Number(source[state]) || 0);
          values.total = states.reduce((sum, state) => sum + values[state], 0);
        }
      };
      request.onerror = () => reject(request.error || new Error('Queue state checkpoint read failed'));
      tx.oncomplete = () => resolve(values);
      tx.onerror = () => reject(tx.error || new Error('Queue checkpoint read failed'));
      tx.onabort = () => reject(tx.error || new Error('Queue checkpoint read aborted'));
    });
  } finally {
    database.close();
  }
  let bytesReceived = 0,
    totalBytes = 0,
    speedBps = 0;
  for (const row of active.values())
    if (row.state === 'downloading') {
      bytesReceived += Number(row.bytesReceived) || 0;
      totalBytes += Number(row.totalBytes) || 0;
      speedBps += Number(row.speedBps) || 0;
    }
  const ready = counts.countsReady,
    queued = ready ? counts.queued : null,
    retryWait = ready ? counts['retry-wait'] : null,
    downloading = ready ? counts.downloading : active.size,
    paused = ready ? counts.paused : null,
    verifying = ready ? counts.verifying : null,
    converting = ready ? counts.converting : null,
    complete = ready ? counts.complete : null,
    failed = ready ? counts.failed : null;
  const remaining = Math.max(0, totalBytes - bytesReceived),
    etaSeconds = speedBps > 1 ? remaining / speedBps : null;
  return {
    countsReady: ready,
    queued,
    retryWait,
    downloading,
    paused,
    verifying,
    converting,
    complete,
    failed,
    active: active.size,
    total: counts.total,
    bytesReceived,
    totalBytes,
    completedBytes: null,
    speedBps,
    etaSeconds,
    verificationFailures: null,
    verificationWarnings: null,
    verificationUnavailable: null,
    bookkeeping: {
      plan: 'transactional checkpoint totals; lazy stateKey pages feed a bounded queue buffer',
      recordsMaterialized: 0,
      checkpointReadRequests: 1,
      indexCountRequests: 0,
      fullStoreCountRequests: 0,
      queuedRowsBuffered: queue.length,
      queueBufferLimit: MAX_QUEUED_BUFFER,
      queueIndex: 'stateKey',
      assetLookupIndex: counts.assetIndex,
      pumpFailure: queuePumpFailure ? { ...queuePumpFailure } : null,
      lastRecovery: { ...lastQueueRecovery },
    },
  };
}
async function pump() {
  if (pumping) return;
  pumping = true;
  let s,
    moreQueued = false;
  try {
    s = await getSettings();
    const max = Math.min(8, Math.max(1, s.maxConcurrentDownloads || 4));
    while (active.size < max) {
      if (!queue.length) {
        const filled = await fillQueueBuffer();
        moreQueued = filled.more;
        if (!queue.length) {
          if (moreQueued) scheduleQueuePump();
          break;
        }
      }
      const r = takeQueuedRow();
      if (!r || active.has(r.key)) continue;
      startOne(r, s).catch(error => {
        console.error('XVault download start failed', error);
        void action('error', 'A queued download could not start', { key: r.key, reason: String(error) }).catch(
          () => {}
        );
      });
    }
    queuePumpFailure = null;
    if (s.preventSleepDuringTasks) wake(queue.length > 0 || active.size > 0 || moreQueued);
  } catch (error) {
    queuePumpFailure = { at: Date.now(), reason: String(error?.message || error) };
    console.error('XVault queue pump failed', error);
    if (!queuePumpRetryTimer)
      queuePumpRetryTimer = setTimeout(() => {
        queuePumpRetryTimer = 0;
        void pump();
      }, 5000);
  } finally {
    pumping = false;
    if (s?.preventSleepDuringTasks && !queue.length && !active.size && !moreQueued) wake(false);
    updateBadge();
  }
}
// A retry must not leave the previous attempt's debris behind, and must never delete a good file.
// The old Chrome id is detached from the row FIRST: events Chrome still delivers for it (an interrupt, the
// cancellation that erasing causes) would otherwise be read as a failure of the NEW attempt and trigger yet another download.
async function discardPreviousAttempt(row) {
  const id = Number(row.lastDownloadId || row.downloadId);
  row.downloadId = null;
  row.lastDownloadId = null;
  if (!Number.isFinite(id) || id <= 0) return;
  (row.retiredDownloadIds ||= []).push(id);
  if (row.retiredDownloadIds.length > 8) row.retiredDownloadIds.shift();
  try {
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.state === 'in_progress') return;
    const knownBad = ['corrupt', 'mismatch', 'missing'].includes(row.verification?.state);
    if (item.state === 'complete' && !knownBad) return;
    if (item.state === 'complete') {
      (row.retainedAttemptFiles ||= []).push({
        downloadId: id,
        filename: item.filename,
        sourceGeneration: row.sourceGeneration,
        verification: row.verification,
        at: Date.now(),
      });
      row.retainedAttemptFiles = row.retainedAttemptFiles.slice(-8);
    }
  } catch {}
}
async function preflightDownload(row) {
  const escaped = String(row.target?.filename || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const results = await Promise.all([
    chrome.downloads.search(browserDownloadQuery(row.item)),
    chrome.downloads.search({ filenameRegex: escaped, limit: 25, orderBy: ['-startTime'] }),
  ]).catch(() => null);
  if (!results) return { action: 'block', code: 'preflight-unavailable', presence: 'unconfirmed' };
  return chooseBrowserDownload(
    row,
    [...new Map(results.flat().map(item => [item.id, item])).values()],
    chrome.runtime.id
  );
}
async function startOne(row, s) {
  if (!transitionDownload(row, 'downloading')) return;
  active.set(row.key, row);
  const copies = await installationProbe(await activeXTab());
  if (copies.ids?.length > 1) {
    active.delete(row.key);
    transitionDownload(row, 'failed');
    row.failureReason = 'multiple-installations';
    row.error = 'Multiple XVault copies are active on X. Choose one before resuming.';
    await putMany('downloads', [row]);
    await recordDecision({
      source: row.requestedBy || 'queue',
      code: 'multiple-installations',
      outcome: 'blocked',
      reason: row.error,
      identity: row.key,
      asset: assetIdentity(row.item?.url).asset,
      url: row.item?.url,
      installations: copies.ids,
    });
    pump();
    return;
  }
  if (row.attempts > 0) {
    await discardPreviousAttempt(row);
    if (row.verifyRetried) row.sourceGeneration = crypto.randomUUID();
  }
  row.attempts = (row.attempts || 0) + 1;
  row.nextAttemptAt = null;
  if (s.rebuildTargetOnStart !== false) row.target = await targetFor(row.item, row.item?.index || 1, s);
  if (['explicit-redownload', 'keep-both'].includes(row.requestedIntent) || row.verifyRetried) {
    const generation = String(row.sourceGeneration || row.key)
      .replace(/[^a-z0-9]/gi, '')
      .slice(-8);
    row.target.filename = row.target.filename.replace(/(\.[^./]+)$/, '-copy-' + generation + '$1');
  }
  row.downloadAttemptStartedAt = Date.now();
  await putMany('downloads', [row]);
  try {
    const preflight = await preflightDownload(row);
    await recordDecision({
      source: row.requestedBy || 'queue',
      identity: row.key,
      asset: assetIdentity(row.item.url).asset,
      url: row.item.url,
      tweetId: String(row.item.tweetId || ''),
      code: preflight.code,
      outcome: preflight.action === 'block' ? 'blocked' : preflight.action === 'reuse' ? 'skipped' : 'started',
      reason:
        preflight.action === 'block'
          ? 'A matching browser file or target needs review before downloading'
          : preflight.action === 'reuse'
            ? 'Reusing the retained Chrome download instead of fetching again'
            : 'No matching browser file is recorded',
      browserPresence: preflight.presence,
      ownerInstallation: preflight.owner || null,
    });
    if (preflight.action === 'block') {
      active.delete(row.key);
      row.error = preflight.code;
      row.failureReason = preflight.code;
      transitionDownload(row, 'failed');
      await putMany('downloads', [row]);
      return;
    }
    if (preflight.action === 'reuse') {
      row.downloadId = preflight.item.id;
      row.lastDownloadId = preflight.item.id;
      row.browserRecovered = true;
      await putMany('downloads', [row]);
      if (preflight.item.state === 'complete')
        await reconcileDownloadChange({ id: row.downloadId, state: { current: 'complete' } }, row);
      return;
    }
    const id = await chrome.downloads.download({
      url: row.item.url,
      filename: row.target.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    if (id == null) throw Error('Downloads API returned no id');
    row.downloadId = id;
    row.lastDownloadId = id;
    row.error = null;
    row.lastSampleAt = Date.now();
    await putMany('downloads', [row]);
    if (row.downloadId === id && ['downloading', 'paused', 'verifying', 'converting'].includes(row.state))
      active.set(row.key, row);
    else if (active.get(row.key) === row) active.delete(row.key);
    // Chrome may publish onChanged before downloads.download() resolves and before
    // this row has an ID. Re-read the browser's authoritative state after binding
    // the ID so a terminal event cannot be lost and retried as a second file.
    const [snapshot] = await chrome.downloads.search({ id }).catch(() => []);
    if (snapshot?.state === 'complete') await reconcileDownloadChange({ id, state: { current: 'complete' } }, row);
    else if (snapshot?.state === 'interrupted')
      await reconcileDownloadChange(
        { id, state: { current: 'interrupted' }, error: { current: snapshot.error || 'interrupted' } },
        row
      );
  } catch (e) {
    if (row.downloadId != null) {
      active.set(row.key, row);
      await action(
        'recovery',
        'Browser download started but queue state could not be saved; automatic retry suppressed to prevent duplicate files',
        { key: row.key, downloadId: row.downloadId, reason: String(e) }
      ).catch(() => {});
    } else await failOrRetry(row, e?.message || String(e), s);
  } finally {
    pump();
  }
}
function classifyDownloadError(error = '') {
  return classifyRetryReason(error);
}
async function refreshExpiredUrl(row) {
  const tab = await activeXTab();
  if (!tab?.id || !row?.item?.tweetId) return null;
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [String(row.item.tweetId), String(row.item.mediaId || ''), String(row.item.url || '')],
      func: (tweetId, mediaId, sourceUrl) => {
        const article = [...document.querySelectorAll('article')].find(node =>
          [...node.querySelectorAll('a[href*="/status/"]')].some(link => {
            try {
              return new URL(link.href).pathname.endsWith(`/status/${tweetId}`);
            } catch {
              return false;
            }
          })
        );
        if (!article) return null;
        const urls = [
          ...new Set(
            [...article.querySelectorAll('img[src],video[src],source[src],img[data-src],video[data-src]')]
              .map(node => node.currentSrc || node.src || node.dataset.src || '')
              .filter(value => {
                try {
                  const url = new URL(value);
                  return url.protocol === 'https:' && ['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname);
                } catch {
                  return false;
                }
              })
          ),
        ];
        let sourcePath = '';
        try {
          sourcePath = new URL(sourceUrl).pathname;
        } catch {}
        const matches = urls.filter(value => {
          const path = new URL(value).pathname;
          return (mediaId && path.includes(mediaId)) || (sourcePath && path === sourcePath);
        });
        if (matches.length === 1) return matches[0];
        return urls.length === 1 ? urls[0] : null;
      },
    });
    return out?.result && out.result !== row.item.url ? out.result : null;
  } catch {
    return null;
  }
}
async function failOrRetry(row, error, s) {
  if (['retry-wait', 'failed', 'cancelled'].includes(row.state)) return;
  active.delete(row.key);
  if (row.downloadId != null) {
    row.lastDownloadId = row.downloadId;
    row.downloadId = null;
  }
  row.error = error;
  row.failureReason = classifyDownloadError(error);
  row.updatedAt = Date.now();
  if (['expired-url', 'missing', 'wrong-content'].includes(row.failureReason) && (row.urlRefreshAttempts || 0) < 1) {
    row.urlRefreshAttempts = (row.urlRefreshAttempts || 0) + 1;
    const fresh = await refreshExpiredUrl(row);
    if (fresh) {
      row.item = { ...row.item, url: fresh, originalUrl: row.item.url };
      row.error = 'Media URL refreshed from the active X tab';
      row.failureReason = 'url-refreshed';
      row.downloadId = null;
      transitionDownload(row, 'retry-wait');
      await scheduleRetry(row, 350);
      updateBadge();
      return;
    }
  }
  const max = 1 + Math.max(0, s.downloadRetries || 0);
  let delay = Math.max(300, (s.retryDelay || 1500) * Math.max(1, row.attempts));
  if (row.failureReason === 'rate-limit') delay = Math.max(delay, 15000 * Math.max(1, row.attempts));
  if (row.attempts < max && row.failureReason !== 'missing') {
    transitionDownload(row, 'retry-wait');
    await scheduleRetry(row, delay);
  } else {
    await clearRetrySchedule(row.key);
    row.nextAttemptAt = null;
    transitionDownload(row, 'failed');
    await putMany('downloads', [row]);
    await action('error', 'Download failed', { file: row.target?.filename, error, reason: row.failureReason });
    if (s.showDownloadNotifications)
      notify('XVault download failed', (row.target?.filename || 'Media') + ' — ' + (row.failureReason || 'unknown'));
  }
  updateBadge();
}
const _failOrRetryReliability = failOrRetry;
failOrRetry = async function (row, error, s) {
  await _failOrRetryReliability(row, error, s);
  if (row && ['expired-url', 'missing', 'wrong-content'].includes(row.failureReason) && row.state === 'failed') {
    row.recoveryAction = 'open-source-post';
    row.sourcePostUrl = row.item?.sourcePostUrl || null;
    await putMany('downloads', [row]);
    await action('recovery', 'Media URL recovery needs the source post', {
      key: row.key,
      sourcePostUrl: row.sourcePostUrl || null,
      reason: row.failureReason,
    });
  }
  return row;
};
async function downloadStatePage(state, afterKey = null, limit = 32) {
  const database = await db();
  try {
    return await readDownloadRowsByStatePage(database, state, { afterKey, limit });
  } finally {
    database.close();
  }
}
async function retryFailed() {
  const s = await getSettings();
  let afterKey = null,
    added = 0,
    scanned = 0,
    cursorOperations = 0,
    staleSkipped = 0,
    hasMore = true;
  while (hasMore) {
    const page = await downloadStatePage('failed', afterKey, 32);
    scanned += page.recordsRead;
    cursorOperations += page.cursorOperations;
    if (!page.rows.length) break;
    afterKey = page.nextKey;
    hasMore = page.hasMore;
    const entries = [];
    for (const row of page.rows) {
      if (!row.item?.url) continue;
      const next = { ...row };
      transitionDownload(next, 'queued');
      next.error = null;
      next.failureReason = null;
      next.recoveryAction = null;
      next.nextAttemptAt = null;
      next.downloadId = null;
      next.bytesReceived = 0;
      next.speedBps = 0;
      if (s.retryResetsAttempts !== false) next.attempts = 0;
      if (!next.target?.filename)
        next.target = await targetFor(next.item, next.item?.index || added + entries.length + 1, s);
      entries.push({
        key: row.key,
        expected: {
          state: row.state,
          stateRevision: row.stateRevision ?? null,
          updatedAt: row.updatedAt ?? null,
          downloadId: row.downloadId ?? null,
        },
        patch: {
          state: next.state,
          stateRevision: next.stateRevision,
          history: next.history,
          updatedAt: next.updatedAt,
          error: null,
          failureReason: null,
          recoveryAction: null,
          nextAttemptAt: null,
          downloadId: null,
          bytesReceived: 0,
          speedBps: 0,
          attempts: next.attempts,
          target: next.target,
        },
      });
    }
    if (entries.length) {
      const database = await db();
      let result;
      try {
        result = await patchLibraryDownloadRowsIfCurrent(database, entries);
      } finally {
        database.close();
      }
      added += result.updated;
      staleSkipped += result.skipped;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (added) pump();
  await action('retry', `Retrying ${added} failed download${added === 1 ? '' : 's'}`, { added, scanned, staleSkipped });
  return {
    ok: true,
    added,
    scanned,
    staleSkipped,
    cursorOperations,
    index: 'stateKey',
    bufferLimit: MAX_QUEUED_BUFFER,
    ...(await queueStats()),
  };
}
async function rebuildTargets() {
  const s = await getSettings();
  let rebuilt = 0,
    scanned = 0,
    cursorOperations = 0,
    staleSkipped = 0;
  for (const state of ['queued', 'failed']) {
    let afterKey = null,
      hasMore = true;
    while (hasMore) {
      const page = await downloadStatePage(state, afterKey, 32);
      scanned += page.recordsRead;
      cursorOperations += page.cursorOperations;
      if (!page.rows.length) break;
      afterKey = page.nextKey;
      hasMore = page.hasMore;
      const entries = [];
      for (const row of page.rows) {
        if (!row.item?.url) continue;
        const target = await targetFor(row.item, row.item?.index || rebuilt + entries.length + 1, s);
        entries.push({
          key: row.key,
          expected: {
            state: row.state,
            stateRevision: row.stateRevision ?? null,
            updatedAt: row.updatedAt ?? null,
            downloadId: row.downloadId ?? null,
          },
          patch: { target, updatedAt: Date.now() },
        });
      }
      if (entries.length) {
        const database = await db();
        let result;
        try {
          result = await patchLibraryDownloadRowsIfCurrent(database, entries);
        } finally {
          database.close();
        }
        rebuilt += result.updated;
        staleSkipped += result.skipped;
        for (const entry of entries) {
          const queued = queue.find(row => String(row.key) === entry.key);
          if (queued && entry.patch.target) queued.target = entry.patch.target;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return { ok: true, rebuilt, scanned, staleSkipped, cursorOperations, index: 'stateKey' };
}
async function clearState(state) {
  const states = state === 'queued' ? ['queued', 'retry-wait'] : [state];
  if (state === 'queued') clearQueueBuffer();
  const database = await db();
  let result;
  try {
    result = await deleteLibraryDownloadsByState(database, states, {
      onDelete: row => {
        if (row.state === 'queued' || row.state === 'retry-wait') void clearRetrySchedule(row.key);
      },
    });
  } finally {
    database.close();
  }
  if (result.deleted) announceLibraryChanges(result.changedIds, 'download', result.truncatedIds);
  updateBadge();
  return {
    ok: true,
    cleared: result.deleted,
    recordsScanned: result.recordsScanned,
    cursorOperations: result.cursorOperations,
    changedIdsTruncated: result.truncatedIds,
  };
}
async function readDownloadByBrowserId(downloadId) {
  const database = await db();
  try {
    return (await readDownloadRowByBrowserId(database, downloadId)).row;
  } finally {
    database.close();
  }
}
async function setDownloadStateById(downloadId, next) {
  const row = await readDownloadByBrowserId(downloadId).catch(() => null);
  if (!row) return null;
  if (transitionDownload(row, next)) {
    await putMany('downloads', [row]);
    return row;
  }
  return row;
}
function pathToFileUrl(p) {
  try {
    return (
      'file:///' +
      String(p || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .split('/')
        .map((x, i) => (i === 0 ? x : encodeURIComponent(x)))
        .join('/')
    );
  } catch {
    return null;
  }
}
function stableConversionId(input = '') {
  let h = 2166136261,
    s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `xvconv-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
function convertedPathsFor(row, s) {
  const p = String(row?.filename || '');
  if (!p || !row?.item) return null;
  const hint = String(row.item.mediaType || row.item.sourceMediaType || '').toLowerCase();
  const ext = (row.target?.ext || urlExt(p)).toLowerCase();
  if (!/animated_gif|animation|gif/.test(hint) || !['mp4', 'webm'].includes(ext)) return null;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]+/);
  const ix = parts.findIndex(x => x.toLowerCase() === String(s.gifFolder || 'GIFs').toLowerCase());
  if (ix < 0) return null;
  const orig = String(s.animationOriginalFolder || 'Originals').toLowerCase();
  if (parts[ix + 1]?.toLowerCase() === orig) parts.splice(ix + 1, 1);
  const base = parts[parts.length - 1].replace(/\.(mp4|webm)$/i, '');
  const gif = [...parts];
  gif.splice(ix + 1, 0, s.animationGifFolder || 'GIF');
  gif[gif.length - 1] = base + '.gif';
  const webp = [...parts];
  webp.splice(ix + 1, 0, s.animatedWebPFolder || 'WebP');
  webp[webp.length - 1] = base + '.webp';
  return { gif: gif.join(sep), webp: webp.join(sep) };
}
async function markConversionExpected(row) {
  const settings = await getSettings(),
    connection = await db();
  let scheduled = null;
  try {
    scheduled = await new Promise((resolve, reject) => {
      const tx = connection.transaction(['downloads', 'conversions'], 'readwrite'),
        downloads = tx.objectStore('downloads'),
        conversions = tx.objectStore('conversions');
      let current = null,
        existing = null,
        reads = 0,
        committed = false;
      const maybeCommit = () => {
        if (++reads < 2) return;
        if (
          existing ||
          !current ||
          current.state !== 'complete' ||
          !['verified', 'verified-with-warning', 'verification-unavailable'].includes(
            current.verification?.state || current.verificationState || ''
          )
        )
          return;
        const requestedItem = row?.item || {},
          source = { ...current, item: { ...current.item } };
        for (const key of ['conversionMode', 'conversionGif', 'conversionWebP', 'conversionKeepSource'])
          if (requestedItem[key] !== undefined) source.item[key] = requestedItem[key];
        const mode = source.item?.conversionMode,
          requested = mode
            ? bulkMode(mode)
            : {
                keepMp4: true,
                gif: settings.convertAnimationGif !== false,
                webp: settings.convertAnimationWebP !== false,
              };
        if (typeof source.item?.conversionGif === 'boolean') requested.gif = source.item.conversionGif;
        if (typeof source.item?.conversionWebP === 'boolean') requested.webp = source.item.conversionWebP;
        if (typeof source.item?.conversionKeepSource === 'boolean')
          requested.keepMp4 = source.item.conversionKeepSource;
        if (!settings.convertAnimatedMp4 || (!requested.gif && !requested.webp)) return;
        const filename = current.filename || current.target?.filename || '',
          pathSource = { ...current, filename },
          outputs = convertedPathsFor(pathSource, settings);
        if (!outputs) return;
        const jobId = stableConversionId(filename || current.key),
          now = Date.now(),
          downloadRow = {
            ...source,
            conversionExpected: true,
            conversionKeepSource: requested.keepMp4,
            conversionRequestedGif: requested.gif,
            conversionRequestedWebP: requested.webp,
            convertedGifPath: requested.gif ? outputs.gif : null,
            convertedGifFileUrl: requested.gif ? pathToFileUrl(outputs.gif) : null,
            convertedWebPPath: requested.webp ? outputs.webp : null,
            convertedWebPFileUrl: requested.webp ? pathToFileUrl(outputs.webp) : null,
            convertedPath: requested.webp && !requested.gif ? outputs.webp : outputs.gif,
            conversionState: 'queued',
            conversionJobId: jobId,
          };
        downloadRow.convertedFileUrl = pathToFileUrl(downloadRow.convertedPath);
        const conversionRow = {
          id: current.key,
          jobId,
          sourceGeneration: current.sourceGeneration || null,
          downloadKey: current.key,
          tweetId: current.item?.tweetId || null,
          input: filename,
          gifOutput: requested.gif ? outputs.gif : null,
          webpOutput: requested.webp ? outputs.webp : null,
          requestedGif: requested.gif,
          requestedWebP: requested.webp,
          keepSource: requested.keepMp4,
          state: 'queued',
          createdAt: now,
          updatedAt: now,
        };
        downloads.put(withDownloadAssetLookup(downloadRow));
        conversions.put(conversionRow);
        committed = true;
        scheduled = {
          jobId,
          filename,
          outputs,
          requested,
          tweetId: current.item?.tweetId == null ? null : String(current.item.tweetId),
        };
      };
      tx.oncomplete = () => resolve(committed ? scheduled : null);
      tx.onerror = () => reject(tx.error || new Error('Derivative scheduling failed'));
      tx.onabort = () => reject(tx.error || new Error('Derivative scheduling aborted'));
      const downloadRequest = downloads.get(String(row.key)),
        conversionRequest = conversions.get(String(row.key));
      downloadRequest.onsuccess = () => {
        current = downloadRequest.result || null;
        maybeCommit();
      };
      downloadRequest.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
      conversionRequest.onsuccess = () => {
        existing = conversionRequest.result || null;
        maybeCommit();
      };
      conversionRequest.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
    });
  } finally {
    connection.close();
  }
  if (!scheduled) return false;
  if (scheduled.tweetId) announceLibraryChanges([scheduled.tweetId], 'download');
  try {
    await chrome.alarms.create('xvault-helper-poll', { periodInMinutes: 0.25 });
  } catch {}
  helperPost('/conversions/queue', {
    path: scheduled.filename,
    requestedGif: scheduled.requested.gif,
    requestedWebP: scheduled.requested.webp,
    keepSource: scheduled.requested.keepMp4,
    fps: settings.conversionGifFps || settings.conversionFps,
    maxWidth: settings.conversionGifMaxWidth || settings.conversionMaxWidth,
    webpQuality: settings.conversionWebPQuality,
  }).catch(() => {});
  await action('conversion', 'Animation conversion queued for helper', {
    jobId: scheduled.jobId,
    input: scheduled.filename,
    gif: scheduled.outputs.gif,
    webp: scheduled.outputs.webp,
  });
  return true;
}
async function finalizeVerifiedDownload(row, downloadId) {
  const result = await verifyCompletedDownload(downloadId);
  let conversionScheduleFailed = false;
  if (
    result?.ok &&
    ['verified', 'verified-with-warning', 'verification-unavailable'].includes(result.verification?.state)
  )
    try {
      await markConversionExpected(row);
    } catch (error) {
      conversionScheduleFailed = true;
      await action('recovery', 'Verified original kept because derivative scheduling could not be recorded', {
        key: row.key,
        reason: String(error),
      }).catch(() => {});
    }
  const settings = await getSettings();
  if (
    settings.clearCompletedOnSuccess &&
    !conversionScheduleFailed &&
    result?.ok &&
    ['verified', 'verified-with-warning'].includes(result.verification?.state)
  ) {
    const database = await db();
    let removed;
    try {
      removed = await deleteCompletedDownloadIfEligible(database, row.key);
    } finally {
      database.close();
    }
    if (removed.deleted) announceLibraryChanges(removed.changedIds, 'download');
  }
  return result;
}
async function reconcileDownloadChange(d, rowOverride = null) {
  if (!d?.id) return;
  if (verifyingDownloads.has(d.id)) return;
  let row = rowOverride || [...active.values()].find(x => Number(x.downloadId) === Number(d.id));
  if (!row) row = await readDownloadByBrowserId(d.id).catch(() => null);
  if (!row || ['complete', 'failed', 'cancelled', 'retry-wait', 'queued'].includes(row.state)) return;
  if (
    row.retiredDownloadIds?.includes(Number(d.id)) ||
    (row.downloadId != null && Number(row.downloadId) !== Number(d.id))
  )
    return;
  try {
    const [item] = await chrome.downloads.search({ id: d.id });
    if (item) {
      const now = Date.now(),
        delta = (item.bytesReceived || 0) - (row.lastBytes || 0),
        dt = (now - (row.lastSampleAt || now)) / 1000;
      if (dt > 0.2 && delta >= 0) row.speedBps = 0.7 * (row.speedBps || 0) + 0.3 * (delta / dt);
      row.lastBytes = item.bytesReceived || 0;
      row.lastSampleAt = now;
      row.bytesReceived = item.bytesReceived || 0;
      row.totalBytes = item.totalBytes > 0 ? item.totalBytes : row.totalBytes;
      row.filename = item.filename || row.filename;
      if (item.paused === true && row.state === 'downloading') transitionDownload(row, 'paused');
      else if (item.paused === false && row.state === 'paused') transitionDownload(row, 'downloading');
    }
  } catch {}
  if (d.state?.current === 'complete') {
    verifyingDownloads.add(d.id);
    try {
      active.delete(row.key);
      if (row.state !== 'verifying' && !transitionDownload(row, 'verifying')) return;
      row.completedAt = Date.now();
      row.error = null;
      await putMany('downloads', [row]);
      await action('download', 'Download complete; verifying', { file: row.target?.filename, key: row.key });
      await finalizeVerifiedDownload(row, d.id);
      pump();
    } catch (error) {
      await action('error', 'Download completion could not be finalized', {
        key: row.key,
        reason: String(error),
      }).catch(() => {});
    } finally {
      verifyingDownloads.delete(d.id);
    }
  } else if (d.state?.current === 'interrupted' || d.error?.current) {
    await failOrRetry(row, d.error?.current || 'interrupted', await getSettings());
  } else {
    row.updatedAt = Date.now();
    await putMany('downloads', [row]);
  }
  updateBadge();
}
chrome.downloads.onChanged.addListener(d => {
  const id = Number(d?.id);
  if (!Number.isSafeInteger(id) || id < 0) return;
  const previous = downloadEventTails.get(id) || Promise.resolve(),
    task = previous.catch(() => {}).then(() => reconcileDownloadChange(d));
  let tracked;
  tracked = task
    .catch(error =>
      action('error', 'Download state could not be reconciled', { downloadId: id, reason: String(error) }).catch(
        () => {}
      )
    )
    .finally(() => {
      if (downloadEventTails.get(id) === tracked) downloadEventTails.delete(id);
    });
  downloadEventTails.set(id, tracked);
});
async function verifyCompletedDownload(downloadId) {
  const row = await readDownloadByBrowserId(downloadId).catch(() => null);
  if (!row || !['verifying', 'complete'].includes(row.state)) return { ok: false, reason: 'not-verifying' };
  let item;
  try {
    [item] = await chrome.downloads.search({ id: Number(downloadId) });
  } catch {}
  const received = Number(item?.bytesReceived ?? row.bytesReceived ?? row.totalBytes ?? 0);
  const expectedSize = Number(row.target?.size || row.totalBytes || 0),
    knownContentLength = Number(item?.totalBytes) > 0 ? Number(item.totalBytes) : 0;
  const expected = expectedKind(row.target || {}, row.item || {}),
    expectedExt = String(row.target?.ext || '').toLowerCase();
  row.bytesReceived = received || row.bytesReceived;
  row.totalBytes = knownContentLength || row.totalBytes || expectedSize;
  row.verifiedAt = Date.now();
  const local = pathToFileUrl(item?.filename || row.filename);
  // Chrome search() returns cached exists values before its asynchronous disk check.
  // Verify local evidence before treating a completed file as missing or retrying it.
  let exists = true,
    actual = '',
    actualExt = '',
    fileAccess = null;
  if (local) {
    try {
      const response = await fetch(local, { cache: 'no-store' });
      if (response.ok) {
        const found = magic(await responseHeaderBytes(response));
        actual = found.kind || '';
        actualExt = found.ext || '';
        fileAccess = true;
      } else if (response.status === 404) {
        exists = false;
        fileAccess = true;
      } else fileAccess = false;
    } catch {
      fileAccess = false;
    }
  }
  const outcome = classifyVerification({
    received,
    expectedSize,
    knownContentLength,
    expected,
    actual,
    ext: actualExt || expectedExt,
    expectedExt,
    actualExt,
    fileAccess,
    exists,
  });
  if (item?.exists === false && fileAccess !== true)
    outcome.reason =
      'Chrome reports this file missing; local access is unavailable to confirm it. The completed download is retained.';
  row.verification = {
    ...outcome,
    chromeExists: item?.exists ?? null,
    presence:
      exists === false
        ? 'confirmed-missing'
        : fileAccess === true
          ? 'confirmed-present'
          : item?.exists === false
            ? 'unconfirmed-missing'
            : 'unconfirmed',
    received,
    expectedSize: expectedSize || null,
    knownContentLength: knownContentLength || null,
    expected,
    expectedExt: expectedExt || null,
    actual: actual || null,
    actualExt: actualExt || null,
    fileAccess,
    at: Date.now(),
  };
  row.verificationState = outcome.state;
  row.actualFormat = actualExt || null;
  if (['corrupt', 'mismatch', 'missing'].includes(outcome.state)) {
    const settings = await getSettings(),
      policy = outcome.state === 'missing' ? settings.verificationMissingPolicy : settings.verificationMismatchPolicy;
    if (policy === 'retry' && !row.verifyRetried) {
      row.verifyRetried = true;
      await failOrRetry(row, outcome.reason, settings);
      return { ok: false, verification: row.verification };
    }
    if (policy === 'fail' || policy === 'retry') {
      row.error = outcome.reason;
      row.failureReason = classifyDownloadError(outcome.reason);
      transitionDownload(row, 'failed');
      await putMany('downloads', [row]);
      await action('verification', `Download verification ${outcome.state}`, { key: row.key, reason: outcome.reason });
      return { ok: false, verification: row.verification };
    }
  }
  if (row.state === 'verifying') transitionDownload(row, 'complete');
  await putMany('downloads', [row]);
  return { ok: true, verification: row.verification };
}
// Completion verification is awaited by the primary download-state listener so cleanup cannot
// remove a file before its metadata/magic-byte result is persisted.
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm?.name === DOWNLOAD_ASSET_INDEX_ALARM) {
    await runDownloadAssetIndexBackfill();
    return;
  }
  if (alarm?.name === 'xvault-helper-poll') {
    const rows = await all('conversions').catch(() => []),
      activeRows = rows.filter(x => ['queued', 'running', 'cancel-requested', 'interrupted'].includes(x.state));
    if (activeRows.length) await conversionStatus().catch(() => {});
    else
      try {
        await chrome.alarms.clear('xvault-helper-poll');
      } catch {}
    return;
  }
  if (!alarm?.name?.startsWith('xvault-retry-')) return;
  let key = '';
  try {
    key = decodeURIComponent(alarm.name.slice('xvault-retry-'.length));
  } catch {}
  if (!key) return;
  const row = await store('downloads', 'readonly', os => req(os.get(key))).catch(() => null);
  if (!row || !['retry-wait', 'queued'].includes(row.state)) return;
  if (Number(row.nextAttemptAt || 0) > Date.now() + 250) return;
  row.nextAttemptAt = null;
  transitionDownload(row, 'queued');
  await putMany('downloads', [row]);
  queueRow(row);
  pump();
  updateBadge();
});
let restorePromise = null;
async function restoreQueue() {
  if (restorePromise) return restorePromise;
  restorePromise = restoreQueueOnce();
  try {
    return await restorePromise;
  } finally {
    restorePromise = null;
  }
}
async function restoreQueueOnce() {
  const settings = await getSettings(),
    telemetry = { pages: 0, recordsRead: 0, cursorOperations: 0, maxPage: 0 },
    account = stats => {
      telemetry.pages += stats.pages;
      telemetry.recordsRead += stats.recordsRead;
      telemetry.cursorOperations += stats.cursorOperations;
      telemetry.maxPage = Math.max(telemetry.maxPage, stats.maxPage);
    };
  // Schema 15 also builds exact queue totals. This is a bounded resumable
  // upgrade on old archives and a no-op on a fresh/fully indexed database.
  void runDownloadAssetIndexBackfill();
  // Queued rows are deliberately left in IndexedDB and loaded by pump() in
  // small windows. They are already durable and need no startup rewrite.
  account(
    await forEachDownloadStatePage('retry-wait', async row => {
      if (!row.item?.url) return;
      const remaining = Number(row.nextAttemptAt || 0) - Date.now();
      if (remaining > 250) await scheduleRetry(row, remaining);
      else {
        const next = { ...row };
        next.nextAttemptAt = null;
        transitionDownload(next, 'queued');
        await putMany('downloads', [next]);
        queueRow(next);
      }
    })
  );
  // Completed originals are inspected in bounded pages so a large archive
  // cannot become one duplicate in-memory download ledger at worker startup.
  if (settings.convertAnimatedMp4 !== false)
    account(
      await forEachDownloadStatePage('complete', async row => {
        const hint = String(row.item?.mediaType || row.item?.sourceMediaType || '').toLowerCase();
        if (
          /animated_gif|animation|gif/.test(hint) &&
          ['verified', 'verified-with-warning', 'verification-unavailable'].includes(
            row.verification?.state || row.verificationState
          )
        )
          await markConversionExpected(row).catch(() => {});
      })
    );
  for (const state of ['downloading', 'paused', 'verifying'])
    account(
      await forEachDownloadStatePage(state, async row => {
        let item = null;
        if (row.state === 'downloading' && !row.downloadId) {
          let candidates = [];
          try {
            candidates = await chrome.downloads.search({ limit: 100, orderBy: ['-startTime'] });
          } catch {}
          const recovered = matchRecoveryDownload(row, candidates);
          if (recovered.state === 'matched') {
            item = recovered.item;
            row.downloadId = item.id;
            await putMany('downloads', [row]);
            await action('recovery', 'Recovered browser download identity after restart', {
              key: row.key,
              downloadId: item.id,
            });
          } else {
            row.error = `Browser download identity is ${recovered.state}; retry manually to avoid a duplicate file`;
            row.failureReason = 'restart-identity-unknown';
            transitionDownload(row, 'failed');
            await putMany('downloads', [row]);
            await action('recovery', 'Download attempt needs manual review after restart', {
              key: row.key,
              reason: recovered.reason,
            });
            return;
          }
        }
        if (!item)
          try {
            [item] = await chrome.downloads.search({ id: row.downloadId });
          } catch {}
        if (item?.state === 'complete') {
          if (row.state !== 'verifying') transitionDownload(row, 'verifying');
          await putMany('downloads', [row]);
          await finalizeVerifiedDownload(row, row.downloadId).catch(async error =>
            action('recovery', 'Completed download needs verification retry', {
              key: row.key,
              reason: String(error),
            }).catch(() => {})
          );
          return;
        }
        if (row.state === 'paused') {
          if (item?.state === 'in_progress' && !item.paused) {
            transitionDownload(row, 'downloading');
            active.set(row.key, row);
            await putMany('downloads', [row]);
          } else await action('recovery', 'Paused download preserved after restart', { key: row.key });
          return;
        }
        if (item?.state === 'in_progress' && !item.paused && row.state === 'downloading') {
          active.set(row.key, row);
          return;
        }
        if (item?.state === 'in_progress' && item.paused) {
          transitionDownload(row, 'paused');
          await putMany('downloads', [row]);
          return;
        }
        const previousState = row.state;
        row.error = row.error || 'Recovered after browser/extension restart';
        row.recoveredFrom = previousState;
        row.downloadId = null;
        row.nextAttemptAt = null;
        if (settings.autoRepairQueue === false) {
          transitionDownload(row, 'failed');
          await putMany('downloads', [row]);
          await action('recovery', 'Stale download failed explicitly after restart', { key: row.key, previousState });
        } else {
          transitionDownload(row, 'retry-wait');
          transitionDownload(row, 'queued');
          await putMany('downloads', [row]);
          queueRow(row);
          await action('recovery', 'Download job recovered after restart', { key: row.key, previousState });
        }
      })
    );
  lastQueueRecovery = telemetry;
  pump();
}
async function updateBadge() {
  try {
    const q = await queueStats(),
      n = q.countsReady ? q.downloading + q.queued + q.retryWait : active.size + queue.length,
      txt = !q.countsReady && queueFillKey !== null ? '•' : n ? String(Math.min(999, n)) : '';
    await chrome.action.setBadgeText({ text: txt });
    await chrome.action.setBadgeBackgroundColor({
      color:
        q.verificationFailures || q.failed
          ? '#e5484d'
          : q.retryWait
            ? '#f2b94b'
            : q.downloading
              ? '#7aa2ff'
              : '#60646c',
    });
  } catch {}
}
async function testDownload() {
  try {
    const id = await chrome.downloads.download({
      url: 'data:text/plain;charset=utf-8,XVault%20download%20test',
      filename: `${cleanPath((await getSettings()).mediaFolder)}/Other/XVault-test.txt`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return { ok: true, downloadId: id, message: 'Test file queued successfully' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
async function helperToken() {
  return (await chrome.storage.local.get('helperAuthToken')).helperAuthToken || '';
}
async function helperFetch(path, options = {}) {
  const s = await getSettings(),
    port = Number(s.helperPort) || 17843,
    url = `http://127.0.0.1:${port}${path}`;
  let token = await helperToken(),
    headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let r = await fetch(url, {
    ...options,
    headers,
    cache: 'no-store',
    signal: options.signal || AbortSignal.timeout(1500),
  });
  if (r.status === 401) {
    const boot = await fetch(`http://127.0.0.1:${port}/bootstrap`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1200),
    }).catch(() => null);
    if (boot?.ok) {
      const data = await boot.json().catch(() => null);
      if (data?.token) {
        token = data.token;
        await chrome.storage.local.set({ helperAuthToken: token });
        headers.Authorization = `Bearer ${token}`;
        r = await fetch(url, {
          ...options,
          headers,
          cache: 'no-store',
          signal: options.signal || AbortSignal.timeout(1500),
        });
      }
    }
  }
  return r;
}
async function helperPost(path, body) {
  const headers = { 'Content-Type': 'application/json' },
    r = await helperFetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...data };
}

async function helperStatus() {
  try {
    const r = await helperFetch('/status');
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    return { ok: true, connected: true, ...(await r.json()) };
  } catch (e) {
    return { ok: true, connected: false, error: String(e) };
  }
}
async function conversionStatus(key = '') {
  const known = key ? await store('conversions', 'readonly', os => req(os.get(key))).catch(() => null) : null;
  const helperKey = known?.input || '';
  const dbRows = key ? (known ? [known] : []) : await all('conversions').catch(() => []);
  try {
    const response = await helperFetch(`/conversions${helperKey ? '?key=' + encodeURIComponent(helperKey) : ''}`);
    if (!response.ok) throw Error(`Helper returned HTTP ${response.status}`);
    const data = await response.json();
    if (data.ffmpeg === false) {
      for (const row of dbRows.filter(x => ['queued', 'running', 'interrupted'].includes(x.state))) {
        const reason = 'FFmpeg is unavailable in the local helper';
        await putMany('conversions', [
          {
            ...row,
            state: 'failed',
            error: reason,
            verification: { state: 'verification-unavailable', reason },
            updatedAt: Date.now(),
          },
        ]);
        const dl = await store('downloads', 'readonly', os => req(os.get(row.downloadKey || row.id))).catch(() => null);
        if (dl)
          await putMany('downloads', [
            {
              ...dl,
              conversionState: 'failed',
              conversionVerification: { state: 'verification-unavailable', reason },
              conversionUpdatedAt: Date.now(),
            },
          ]);
        await action('conversion', reason, { jobId: row.jobId });
      }
      return { ok: true, ...data };
    }
    for (const helperRow of data.rows || []) {
      const match =
        dbRows.find(x => x.input === helperRow.key || x.input === helperRow.input || x.jobId === helperRow.jobId) ||
        known;
      if (!match || (match.state === 'cancelled' && helperRow.state !== 'cancelled')) continue;
      const allowed = ['queued', 'running', 'completed', 'failed', 'cancelled', 'cancel-requested', 'interrupted'];
      const helperState = allowed.includes(helperRow.state) ? helperRow.state : 'interrupted';
      const verification =
        helperState === 'completed'
          ? await verifyConversionOutputs(match, helperRow)
          : helperState === 'failed'
            ? { state: 'failed', reason: helperRow.error || 'Conversion failed' }
            : null;
      const state =
        verification && ['mismatch', 'corrupt', 'missing'].includes(verification.state) ? 'failed' : helperState;
      const progress = Number(helperRow.progress || 0);
      if (
        match.state === state &&
        match.conversionProgress === progress &&
        match.verification?.state === verification?.state
      )
        continue;
      await putMany('conversions', [
        {
          ...match,
          state,
          helper: helperRow,
          error: state === 'failed' ? verification?.reason || helperRow.error || 'Invalid derivative' : null,
          verification,
          conversionProgress: progress,
          updatedAt: Date.now(),
        },
      ]);
      const dl = await store('downloads', 'readonly', os => req(os.get(match.downloadKey || match.id))).catch(
        () => null
      );
      if (dl)
        await putMany('downloads', [
          {
            ...dl,
            conversionState: state,
            conversionJobId: match.jobId,
            conversionVerification: verification,
            conversionProgress: progress,
            conversionUpdatedAt: Date.now(),
          },
        ]);
      if (state === 'failed' && match.state !== 'failed')
        await action('conversion', 'Derivative conversion failed verification', {
          jobId: match.jobId,
          reason: verification?.reason || helperRow.error || null,
        });
    }
    return { ok: true, ...data };
  } catch (error) {
    for (const row of dbRows.filter(x => ['running', 'cancel-requested'].includes(x.state))) {
      const reason = 'Helper disconnected; conversion status will be checked when it returns';
      await putMany('conversions', [{ ...row, state: 'interrupted', error: reason, updatedAt: Date.now() }]);
      const dl = await store('downloads', 'readonly', os => req(os.get(row.downloadKey || row.id))).catch(() => null);
      if (dl) await putMany('downloads', [{ ...dl, conversionState: 'interrupted', conversionUpdatedAt: Date.now() }]);
      await action('helper', reason, { jobId: row.jobId });
    }
    return { ok: false, error: String(error) };
  }
}
const _helperStatusReliability = helperStatus;
helperStatus = async function () {
  const out = await _helperStatusReliability();
  const connected = !!out.connected;
  if (helperConnectionState !== null && helperConnectionState !== connected)
    await action('helper', connected ? 'Helper bridge reconnected' : 'Helper bridge disconnected', { connected });
  helperConnectionState = connected;
  return out;
};
async function repairDownloads() {
  let afterKey = null,
    hasMore = true,
    repaired = 0,
    unavailable = 0,
    scanned = 0,
    cursorOperations = 0;
  while (hasMore) {
    const page = await downloadStatePage('failed', afterKey, 32);
    scanned += page.recordsRead;
    cursorOperations += page.cursorOperations;
    if (!page.rows.length) break;
    afterKey = page.nextKey;
    hasMore = page.hasMore;
    const entries = [];
    for (const row of page.rows) {
      if (!row.item?.url) continue;
      const reason = classifyDownloadError(row.error || '');
      if (reason === 'missing') {
        unavailable++;
        continue;
      }
      const next = { ...row };
      transitionDownload(next, 'queued');
      next.error = null;
      next.downloadId = null;
      next.bytesReceived = 0;
      next.speedBps = 0;
      next.failureReason = reason;
      entries.push({
        key: row.key,
        expected: {
          state: row.state,
          stateRevision: row.stateRevision ?? null,
          updatedAt: row.updatedAt ?? null,
          downloadId: row.downloadId ?? null,
        },
        patch: {
          state: next.state,
          stateRevision: next.stateRevision,
          history: next.history,
          updatedAt: next.updatedAt,
          error: null,
          downloadId: null,
          bytesReceived: 0,
          speedBps: 0,
          failureReason: reason,
        },
      });
    }
    if (entries.length) {
      const database = await db();
      let result;
      try {
        result = await patchLibraryDownloadRowsIfCurrent(database, entries);
      } finally {
        database.close();
      }
      repaired += result.updated;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (repaired) pump();
  return {
    ok: true,
    repaired,
    unavailable,
    scanned,
    cursorOperations,
    index: 'stateKey',
    bufferLimit: MAX_QUEUED_BUFFER,
  };
}
async function installationProbe(tab) {
  if (!tab?.id) return { checked: false, ids: [] };
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [chrome.runtime.id],
      func: self => {
        const buttons = [...document.querySelectorAll('.xvault-download')],
          ids = [
            ...new Set(
              [
                ...(document.documentElement.dataset.xvInstances || '').split(','),
                ...buttons.map(button => button.dataset.xvOwner),
              ].filter(id => /^[a-p]{32}$/.test(id || ''))
            ),
          ].slice(0, 8);
        return {
          ids,
          foreign: buttons.filter(button => button.dataset.xvOwner && button.dataset.xvOwner !== self).length,
        };
      },
    });
    const r = out?.result || { ids: [], foreign: 0 };
    return { checked: true, ids: r.ids, foreignButtons: r.foreign, self: chrome.runtime.id };
  } catch {
    return { checked: false, ids: [] };
  }
}
async function healthCheck() {
  const t = await activeXTab(),
    install = await installationProbe(t),
    s = await getSettings(),
    templates = (await chrome.storage.local.get('graphqlTemplates')).graphqlTemplates || {},
    q = await queueStats(),
    dbOk = await count('tweets')
      .then(() => true)
      .catch(() => false),
    perms = await chrome.permissions.getAll().catch(() => ({ permissions: [] })),
    helper = await helperStatus();
  return {
    ok: true,
    checks: {
      xTab: !!t,
      db: dbOk,
      downloads: perms.permissions?.includes('downloads'),
      notifications: perms.permissions?.includes('notifications'),
      power: perms.permissions?.includes('power'),
      bookmarksTemplate: Object.values(templates).some(
        x => /bookmark/i.test(x.operation || '') || x.pagePath === '/i/history'
      ),
      likesTemplate: Object.values(templates).some(
        x => /like|favorite/i.test(x.operation || '') || x.pagePath === '/i/history/likes'
      ),
      queueErrors: q.failed,
      queue: q,
      templates: Object.keys(templates).length,
      helper: !!helper.connected,
      ffmpeg: !!helper.ffmpeg,
      helperDetail: helper,
      install: {
        ...install,
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        database: DB,
      },
    },
    settings: s,
  };
}
const _verifyCompletedDownloadReliability = verifyCompletedDownload;
verifyCompletedDownload = async function (downloadId) {
  const out = await _verifyCompletedDownloadReliability(downloadId);
  if (out?.verification?.state && out.verification.state !== 'verified') {
    await action('verification', `Download verification ${out.verification.state}`, {
      downloadId,
      reason: out.verification.reason || null,
    });
  }
  return out;
};
// Conversion-only bulk items reuse an already verified MP4 instead of creating a
// second physical download when the user asks for GIF/WebP derivatives later.
// v17 download-planner settings are layered here so older local settings remain
// migration-safe without rewriting archive records or bumping the IndexedDB schema.
const bulkSettingsDefaults = {
  settingsVersion: 18,
  bulkDownloadPresets: [],
  bulkDefaultPreset: 'everything',
  bulkExistingPolicy: 'skip',
  bulkDerivativePolicy: 'verify',
  bulkPlanBatchSize: 80,
  conversionMaxHeight: 0,
  conversionGifFps: 20,
  conversionGifMaxWidth: 1280,
  conversionGifMaxHeight: 0,
  conversionGifDither: 'sierra2_4a',
  conversionGifLoop: 0,
  conversionGifOptimization: 2,
  conversionWebPFps: 20,
  conversionWebPMaxWidth: 1280,
  conversionWebPMaxHeight: 0,
  conversionWebPLossless: false,
  conversionWebPCompression: 4,
  conversionConcurrency: 1,
  conversionWhileDownloading: true,
  conversionTimeout: 900,
  conversionRetries: 2,
  downloadBandwidthLimit: 0,
  bulkScheduleEnabled: false,
  bulkScheduleAt: null,
  librarySearchDebounce: 120,
  libraryPerformanceMode: 'balanced',
  libraryLazyMedia: true,
  libraryContentVisibility: true,
  libraryPauseOffscreenVideo: true,
  libraryPrefetchPages: 0,
};
chrome.runtime.onStartup?.addListener(() => restoreQueue().catch(() => {}));
chrome.runtime.onStartup?.addListener(() => restoreRemoteCompanion().catch(() => {}));
restoreQueue().catch(() => {});
// Final declaration overrides the initial compact helper for an explicit bad-output result.
async function verifyConversionOutputs(row, helper) {
  const requested = [
    ['gif', helper?.gif || helper?.gifOutput, row.gifOutput, helper?.requestedGif !== false],
    ['webp', helper?.webp || helper?.webpOutput, row.webpOutput, helper?.requestedWebP !== false],
  ].filter(([, entry, fallback, wanted]) => wanted && (entry || fallback));
  if (!requested.length)
    return {
      state: 'verification-unavailable',
      reason: 'Helper did not report requested derivative outputs.',
      outputs: [],
      at: Date.now(),
    };
  const results = [];
  for (const [label, entry, fallback] of requested) {
    if (entry?.state === 'removed') {
      results.push({ label, state: 'removed', size: Number(entry.size) || null });
      continue;
    }
    const path = entry?.path || entry || fallback,
      local = pathToFileUrl(path);
    if (!local) {
      results.push({ label, state: 'verification-unavailable', reason: 'No local output path' });
      continue;
    }
    try {
      const response = await fetch(local, { cache: 'no-store' });
      const verified = await verifyDerivativeResponse(response, label, entry && typeof entry === 'object' ? entry : {});
      results.push({ label, ...verified });
    } catch {
      results.push({ label, state: 'verification-unavailable', reason: 'Browser file access is unavailable' });
    }
  }
  const bad = results.find(x => ['missing', 'corrupt', 'mismatch'].includes(x.state));
  const state =
    bad?.state ||
    (!results.some(x => x.state === 'verification-unavailable') && results.every(x => x.state === 'verified')
      ? 'verified'
      : results.every(x => x.state === 'verification-unavailable')
        ? 'verification-unavailable'
        : 'verified-with-warning');
  return { state, reason: bad?.reason || null, outputs: results, at: Date.now() };
}

// Content scripts receive only capture/UI preferences, never private storage changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings?.newValue) return;
  const settings = contentSettings(changes.settings.newValue);
  chrome.tabs
    .query({ url: ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.twitter.com/*'] })
    .then(tabs =>
      Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'XV_SETTINGS_CHANGED', settings })))
    )
    .catch(() => {});
});
