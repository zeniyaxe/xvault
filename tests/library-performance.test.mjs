import fs from 'node:fs';
import assert from 'node:assert/strict';
import { collapseSource, compactSource, readSource } from './source-text.mjs';

const workspaceText = readSource('library-workspace.js');
const workspace = collapseSource(workspaceText);
const background = compactSource(readSource('background.js'));
const remoteControls = fs.readFileSync(new URL('../remote-query-controls.mjs', import.meta.url), 'utf8');
const storage = collapseSource(readSource('library-storage.mjs'));
const dashboard = compactSource(readSource('dashboard.js'));
const bulkUi = fs.readFileSync(new URL('../bulk-download-ui.js', import.meta.url), 'utf8');
const css = compactSource(readSource('xv-library.css'));
const exporter = fs.readFileSync(new URL('../library-export-worker.js', import.meta.url), 'utf8');
const dashboardMock = fs.readFileSync(new URL('./chrome-mock.js', import.meta.url), 'utf8');

assert.doesNotMatch(
  workspace,
  /searchIndexRows|sendSearchDataset|new Worker\(['"]library-search-worker\.js/,
  'the dashboard must not build or retain a second whole-archive search projection'
);
assert.doesNotMatch(
  workspace,
  /GET_ALL|GET_LIBRARY_ROWS|GET_LIBRARY_CHUNK/,
  'normal Library queries must use the bounded page endpoint'
);
const settingsSync = dashboard.slice(dashboard.indexOf('function builtinSync()'), dashboard.indexOf('function apply('));
assert.match(
  settingsSync,
  /if\(!librarySearchInitialized\)\{librarySearchInitialized=true;/,
  'delayed settings responses must never restore an old remembered query over the live search field'
);
assert.match(
  workspace,
  /queryPersistTimer = 0, queryRenderTimer = 0/,
  'search rendering and persistence must not cancel each other through one shared debounce timer'
);
assert.match(
  workspace,
  /type: 'QUERY_LIBRARY_PAGE', queryId, query: q, sort, limit:/,
  'Library startup and paging should request query pages'
);
assert.match(storage, /tweets\.index\('archivedAt'\)/, 'date sorts should use the archive timestamp index');
assert.match(
  storage,
  /cursor\.continuePrimaryKey\(phaseBoundary\.key, phaseBoundary\.id\)/,
  'equal timestamps should page on the composite index and primary key'
);
assert.doesNotMatch(storage, /tweets\.count\(\)/, 'the first page should not synchronously count the entire archive');
assert.match(
  background,
  /readLibraryRecords\(database,selected\.map\(row=>row\.id\)\)/,
  'ranked query results should retrieve only selected full records by primary key'
);
assert.match(
  background,
  /recordsRead:\(planned\.cached\?0:plan\.scanned\)\+selected\.length,materialized:\(planned\.cached\?0:plan\.scanned\)\+rows\.length/,
  'rank scans and selected primary-key reads should both be measured accurately'
);
assert.match(
  background,
  /new LibraryRankPlanCache\(\{maxPlans:3,maxRanks:MAX_LIBRARY_RANKS\}\)/,
  'rank plans should be kept in a bounded cache'
);
assert.match(
  background,
  /GET_LIBRARY_QUERY_PROGRESS/,
  'long non-index scans should expose cancellable progress to the dashboard'
);
assert.match(background, /rankedLibraryPlanCache\.clear\(\)/, 'mutations should release stale rank tuples promptly');
assert.match(background, /VER=16/);
assert.match(
  background,
  /createIndex\('conversationId','conversationId'\)/,
  'schema 16 indexes conversations so the Reader assembles threads without a full scan'
);
assert.match(
  background,
  /createObjectStore\('mediaAssociations'/,
  'schema adds an indexed shared-file association store without rewriting archive records'
);
assert.match(
  background,
  /createIndex\('downloadId','downloadId'\)/,
  'download events resolve through a bounded browser-ID index'
);
assert.match(
  background,
  /createIndex\('usableAssetKey','usableAssetKey'/,
  'cross-post Save Once resolves through a direct sparse asset index'
);
assert.match(background, /emptyDownloadStateCounts\(\)/, 'fresh and migrated archives initialize exact state counters');
assert.match(
  background,
  /backfillDownloadAssetIndexPage\(database,\{limit:512\}\)/,
  'legacy asset keys and queue totals are backfilled through bounded resumable pages'
);
assert.match(background, /MAX_QUEUED_BUFFER=96/, 'persisted queued rows feed a bounded worker buffer');
assert.doesNotMatch(
  background.slice(background.indexOf('async function retryFailed'), background.indexOf('async function clearState')),
  /all\('downloads'\)/,
  'retry and target rebuilding must walk state-index pages'
);
const enqueueCore = background.slice(
  background.indexOf('async function enqueueCore'),
  background.indexOf('let enqueueTail', background.indexOf('async function enqueueCore'))
);
assert.doesNotMatch(
  enqueueCore,
  /all\('downloads'\)|getAll\(/,
  'normal enqueue decisions must not clone download history'
);
assert.match(
  enqueueCore,
  /readDownloadRowsByKeys\(database,keys\)/,
  'same-post download identity must use bounded primary-key reads'
);
assert.match(
  enqueueCore,
  /readExistingDownloadRowsByAssets\(database,assets,\{scanLimit:5000\}\)/,
  'the optional Save Once check must use indexed matches and a small legacy fallback budget'
);
assert.match(
  enqueueCore,
  /findCompletedDownloadByHash\(hashDatabase,sha256,\{scanLimit:50000\}\)/,
  'opt-in hash deduplication must stream the completed-state index with an explicit read budget'
);
assert.match(storage, /export function readDownloadRowsByKeys\(database, keys = \[\]\)/);
assert.match(storage, /export function readExistingDownloadRowsByAssets\(database, assets = \[\], options = \{\}\)/);
assert.match(storage, /export function backfillDownloadAssetIndexPage\(database, \{ limit = 256 \} = \{\}\)/);
assert.match(storage, /export function withDownloadAssetLookup\(row\)/);
assert.match(storage, /export function findCompletedDownloadByHash\(database, hash, options = \{\}\)/);
assert.match(
  background,
  /queuePumpFailure=\{at:Date\.now\(\),reason:String\(error\?\.message\|\|error\)\}/,
  'unexpected queue pump failures must be retained and reported instead of becoming an unhandled rejection'
);
assert.doesNotMatch(
  background.slice(
    background.indexOf('async function restoreQueueOnce'),
    background.indexOf('async function updateBadge')
  ),
  /all\('downloads'\)/,
  'worker restoration must not clone the complete download ledger'
);
assert.match(
  background,
  /createIndex\('importKindKey',\['importId','kind','id'\]\)/,
  'large recovery ledgers should seek conflict/file evidence pages by import, kind, and key'
);
assert.match(
  background,
  /createObjectStore\('libraryPlans',\{keyPath:'id'\}\)/,
  'compact ranked plans should survive MV3 worker suspension in an isolated cache store'
);
assert.doesNotMatch(
  background.match(/const DB='xvault-db',[^;]+;/)?.[0] || '',
  /'libraryPlans'/,
  'query plans must not leak into archive exports or ordinary store statistics'
);
assert.doesNotMatch(
  dashboard,
  /async function exportJSON|async function exportCSV|type:'GET_ALL'/,
  'archive export actions must not materialize every store in dashboard memory'
);
assert.doesNotMatch(
  dashboard,
  /portableExport|Library page HTML/,
  'the misleading current-page-only HTML export was removed in favor of complete recovery files'
);
assert.match(background, /loadPlan:id=>readStoredLibraryPlan\(database,id\)/);
assert.match(background, /savePlan:\(id,identity,plan\)=>writeStoredLibraryPlan\(database,id,identity,plan,3\)/);
assert.match(
  background,
  /compiled\.length\?globalThis\.XVaultLibrarySearch\.projectPost[\s\S]*?:globalThis\.XVaultLibrarySearch\.projectRankPost/,
  'unfiltered ranking should avoid transient full search projections'
);
assert.match(
  storage,
  /'manifests',\s*'libraryPlans',?\s*\]/,
  'Library reset should remove stale disposable query plans'
);
assert.match(
  background,
  /function announceMetadata\(ids\)\{if\(ids\?\.length\)\{remoteQueryPlans\.clear\(\);/,
  'Remote metadata writes should immediately release revision-stale cached query plans'
);
const remoteQuery = background.slice(
  background.indexOf('async function buildRemoteRankPlan'),
  background.indexOf('async function remoteSetMeta')
);
assert.match(
  remoteQuery,
  /sort==='new'\|\|sort==='old'.*buildRemoteCursorPlan/s,
  'Remote chronological pages should use revision-bound IndexedDB cursors'
);
assert.match(remoteQuery, /readRemoteCursorPage\(database/);
assert.match(
  remoteQuery,
  /searchKey=\`\$\{deviceId\}:\$\{sessionId\}\`/,
  'Remote query cancellation should be scoped to the browser tab session'
);
assert.match(remoteQuery, /beginRemoteQuery\(activeRemoteSearches,searchKey/);
assert.match(
  remoteQuery,
  /cancelled:\(\)=>control\.cancelled/,
  'metadata invalidation should stop cursor work while it is scanning'
);
assert.match(remoteQuery, /releaseRemoteQuery\(activeRemoteSearches,searchKey,control\)/);
assert.match(
  remoteControls,
  /previous\.planId\s*===\s*cursorPlanId/,
  'overlapping Remote pages must share only their own query-plan control'
);
assert.match(
  remoteQuery,
  /readLibraryPage\(database,afterKey,128\)/,
  'ranked Remote sorts should scan bounded IndexedDB pages'
);
assert.doesNotMatch(
  remoteQuery,
  /remoteDownloadLookup|store\.openCursor\(\)/,
  'Remote ranked sorts must not clone full download or post stores into a single query plan'
);
assert.doesNotMatch(
  remoteQuery,
  /downloadedIds=new Set\(\)|missingIds=new Set\(\)|knownBytesById=new Map\(\)/,
  'download-filter ranking must keep summary state bounded to the current post batch'
);
assert.match(
  background,
  /REMOTE_QUERY_CANDIDATE_LIMIT=5000/,
  'non-index Remote sorts need a bounded retained rank window'
);
assert.match(
  storage,
  /const scanLimit = 10000/,
  'legacy download lookups without a tweet index need a hard cursor-read ceiling'
);
assert.doesNotMatch(
  dashboardMock,
  /rows\s*=\s*rows\.map/,
  'synthetic bulk metadata messages must not clone the entire fixture once per batch'
);
assert.match(
  dashboardMock,
  /rowById\.get\(id\)/,
  'the UI harness should model post-keyed mutations instead of repeated whole-array scans'
);
assert.match(
  dashboardMock,
  /indexedSource = demoInbox \? null : rows/,
  'the standard newest-first UI fixture should model an already-maintained IndexedDB index'
);
const queueStats = background.slice(
  background.indexOf('async function queueStats()'),
  background.indexOf('async function pump()', background.indexOf('async function queueStats()'))
);
assert.doesNotMatch(queueStats, /store\.count\(\)/, 'queue totals should not trigger a full download-store count');
assert.match(queueStats, /checkpointReadRequests:1/, 'queue totals should read one transactional state checkpoint');
assert.match(
  queueStats,
  /indexCountRequests:0/,
  'queue refreshes should not walk an IndexedDB state index for every status count'
);
assert.doesNotMatch(queueStats, /\.count\(/, 'normal queue telemetry must not scan any history index');
assert.match(
  background,
  /readDownloadHistoryPage\(database,m\.limit\|\|60\)/,
  'the download dashboard should request an index-backed history window'
);
assert.match(
  storage,
  /export function deleteLibraryDownloadsByState\(database, states = \[\], \{ onDelete \} = \{\}\)/,
  'queue/history clearing should use a purpose-built state-index cursor operation'
);
assert.match(
  storage,
  /store\.index\('state'\)\.openCursor\(IDBKeyRange\.only\(state\)\)/,
  'clearing a download state must scan only the matching IndexedDB index range'
);
assert.match(
  storage,
  /export function deleteCompletedDownloadIfEligible\(database, key\)/,
  'auto-clear must validate the latest download row in its delete transaction'
);
assert.match(
  storage,
  /if \(row\.conversionExpected\) \{ reason = 'conversion-pending'; counter\.finish\(\); return; \}/,
  'auto-clear must preserve a row claimed by derivative generation while sealing its count transaction'
);
const clearDownloadState = background.slice(
  background.indexOf('async function clearState('),
  background.indexOf('async function setDownloadStateById(')
);
assert.match(
  clearDownloadState,
  /deleteLibraryDownloadsByState\(database,states/,
  'download cleanup must avoid cloning the complete download store'
);
assert.doesNotMatch(
  clearDownloadState,
  /all\('downloads'\)|getAll\(/,
  'download cleanup must not hide a whole-store read'
);
const verifiedFinalize = background.slice(
  background.indexOf('async function finalizeVerifiedDownload('),
  background.indexOf('chrome\.downloads\.onChanged', background.indexOf('async function finalizeVerifiedDownload('))
);
assert.match(
  verifiedFinalize,
  /deleteCompletedDownloadIfEligible\(database,row\.key\)/,
  'verified download cleanup should perform a conditional transactional delete'
);
assert.match(
  verifiedFinalize,
  /conversionScheduleFailed=false[\s\S]*?conversionScheduleFailed=true[\s\S]*?clearCompletedOnSuccess&&!conversionScheduleFailed/,
  'a failed derivative journal write must keep its verified original instead of clearing the source row'
);
assert.doesNotMatch(
  verifiedFinalize,
  /store\('downloads','readwrite',[\s\S]*?os\.delete\(row\.key\)/,
  'verified cleanup must not delete from a stale read'
);
const conversionSchedule = background.slice(
  background.indexOf('async function markConversionExpected('),
  background.indexOf('async function finalizeVerifiedDownload(')
);
assert.match(
  conversionSchedule,
  /connection\.transaction\(\['downloads','conversions'\],'readwrite'\)/,
  'derivative scheduling should commit source state and job state together'
);
assert.match(
  conversionSchedule,
  /downloads\.get\(String\(row\.key\)\),conversionRequest=conversions\.get\(String\(row\.key\)\)/,
  'derivative scheduling should decide from both current rows in its commit transaction'
);
assert.match(
  conversionSchedule,
  /source=\{\.\.\.current,item:\{\.\.\.current\.item\}\}/,
  'derivative scheduling should merge its fields into the latest download row'
);
const queryHandler = background.slice(
  background.indexOf('async function executeLibraryPage'),
  background.indexOf('async function storeProfileSnapshots')
);
assert.match(
  queryHandler,
  /const committedRevision=await readLibraryRevision\(database\)/,
  'cursor and ranked pages must revalidate the archive revision after selected records and download state are fetched'
);
assert.match(
  queryHandler,
  /if\(committedRevision!==page\.revision\)/,
  'a record removed or edited during page decoration must invalidate the page'
);
const graphSampler = dashboard.slice(dashboard.indexOf('async function sampleGraphs('));
assert.doesNotMatch(
  graphSampler,
  /DOWNLOAD_QUEUE_STATS|type:'STATS'/,
  'graph sampling should use cached summaries, not duplicate storage reads'
);
assert.match(
  dashboard,
  /queueStats\.n=\(queueStats\.n\|\|0\)\+1/,
  'history refresh cadence should advance from a defined counter'
);
assert.match(
  graphSampler,
  /!\$\('#page-home'\).*classList\.contains\('show'\)/,
  'off-screen Home graphs should not sample or draw during Library work'
);
assert.match(workspace, /librarySearchDebounce/);
assert.match(workspace, /IntersectionObserver/);
assert.match(workspace, /contentVisibility/);
const selectionRenderer = workspaceText.match(/function renderSelection\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';
assert.match(selectionRenderer, /resultRows\(\)/, 'selection decoration should resolve only the current result page');
assert.match(
  selectionRenderer,
  /matching\.slice\(0, exportPageSize\(\)\)/,
  'selection decoration should stay bounded by the configured page size'
);
assert.doesNotMatch(
  selectionRenderer,
  /new Map\(library\.map/,
  'selection changes should not rematerialize an ID map for the whole archive'
);
assert.match(
  workspace,
  /model\.applySelectionRange/,
  'shift-range selection should use the allocation-bounded model helper'
);
assert.doesNotMatch(
  workspace,
  /const ids = matching\.map\(post => String\(post\.id\)\)/,
  'shift-range selection should not allocate an ID array for the full result set'
);
assert.match(background, /libraryPerformanceMode:'balanced'/);
assert.match(background, /libraryLazyMedia:true/);
assert.match(background, /libraryPauseOffscreenVideo:true/);
assert.match(background, /settingsVersion:18/);
assert.match(background, /libraryPageSize:120/);
assert.match(bulkUi, /Performance on large archives/);
assert.match(bulkUi, /xvLibraryPerfReset/);
assert.match(workspace, /containIntrinsicSize/);
assert.match(css, /grid-auto-rows:max-content/, 'grid rows must size to their tiles, not share the scroller height');
assert.match(css, /overflow:clip/, 'posts must not be scroll containers inside the grid');
assert.match(workspace, /libraryExportOpen/);
assert.match(workspace, /resultRows\(\)/);
assert.match(workspace, /libraryExportScope/);
assert.match(exporter, /importScripts\('link-utils\.js', 'link-export\.js'\)/);
assert.match(exporter, /type: 'progress'/);

console.log(
  'library performance: cursor-backed startup, page-only memory, selection bounds, settings, and containment checks passed'
);
