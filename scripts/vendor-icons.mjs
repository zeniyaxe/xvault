// Vendors the Lucide subset XVault uses into committed files. Run when the icon list changes:
//   npm pack lucide-static && tar xzf lucide-static-*.tgz && node scripts/vendor-icons.mjs package
// Writes xv-icon-set.js (dashboard, side panel, popup) and the <symbol> sprite inside the phone remote's index.html,
// so every surface draws from one stroke family. Lucide is ISC licensed (see THIRD_PARTY_NOTICES.md).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || process.env.LUCIDE_DIR || 'node_modules/lucide-static');

// XVault name -> Lucide name. Names on the left are the stable API used by markup and scripts.
export const DASHBOARD_ICONS = {
  // primary navigation (data-page values)
  library: 'library-big',
  atlas: 'map',
  explorer: 'compass',
  explore: 'compass',
  home: 'radar',
  media: 'arrow-down-to-line',
  studio: 'wrench',
  health: 'activity',
  settings: 'settings',
  archive: 'archive',
  integrity: 'shield-check',
  sessions: 'history',
  activity: 'scroll-text',
  quality: 'badge-check',
  files: 'folder-open',
  vault: 'lock',
  reader: 'book-open',
  // actions
  search: 'search',
  close: 'x',
  previous: 'chevron-left',
  next: 'chevron-right',
  chevronDown: 'chevron-down',
  chevronUp: 'chevron-up',
  download: 'download',
  upload: 'upload',
  copy: 'copy',
  external: 'square-arrow-out-up-right',
  favorite: 'star',
  unfavorite: 'star-off',
  tag: 'tag',
  tags: 'tags',
  heart: 'heart',
  repost: 'repeat-2',
  reply: 'message-circle',
  replyArrow: 'corner-up-left',
  eye: 'eye',
  eyeOff: 'eye-off',
  bookmark: 'bookmark',
  bookmarkPlus: 'bookmark-plus',
  refresh: 'refresh-cw',
  undo: 'undo-2',
  trash: 'trash-2',
  layoutGrid: 'layout-grid',
  layoutMasonry: 'layout-dashboard',
  layoutTimeline: 'git-commit-vertical',
  layoutCompact: 'list',
  layoutTable: 'table-2',
  layoutCards: 'layout-list',
  board: 'kanban',
  imageSearch: 'scan-search',
  sparkle: 'sparkles',
  highlight: 'highlighter',
  later: 'clock',
  density: 'sliders-horizontal',
  keyboard: 'keyboard',
  inbox: 'inbox',
  note: 'notebook-pen',
  quicklook: 'scan-eye',
  more: 'ellipsis',
  play: 'play',
  pause: 'pause',
  check: 'circle-check',
  tick: 'check',
  plus: 'plus',
  minus: 'minus',
  inspector: 'panel-right',
  collapse: 'panel-left-close',
  expandNav: 'panel-left',
  missing: 'image-off',
  saved: 'bookmark',
  person: 'user-round',
  people: 'users',
  sensitive: 'shield-alert',
  image: 'image',
  images: 'images',
  video: 'film',
  gif: 'sticker',
  text: 'text',
  disk: 'hard-drive',
  shield: 'shield',
  export: 'share',
  share: 'share-2',
  link: 'link',
  repair: 'wrench',
  bell: 'bell',
  color: 'palette',
  thread: 'messages-square',
  quote: 'quote',
  duplicate: 'files',
  cleanup: 'eraser',
  remote: 'smartphone',
  perf: 'gauge',
  motion: 'wand-sparkles',
  tools: 'wrench',
  pip: 'picture-in-picture-2',
  calendar: 'calendar',
  calendarRange: 'calendar-range',
  file: 'file-text',
  shuffle: 'shuffle',
  filter: 'list-filter',
  filterClear: 'funnel-x',
  sort: 'arrow-up-down',
  spinner: 'loader-circle',
  alert: 'triangle-alert',
  error: 'circle-alert',
  info: 'info',
  command: 'command',
  at: 'at-sign',
  hash: 'hash',
  globe: 'globe',
  folder: 'folder',
  sun: 'sun',
  moon: 'moon',
  select: 'square-check',
  square: 'square',
  grip: 'grip-vertical',
  maximize: 'maximize-2',
  minimize: 'minimize-2',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  rotate: 'rotate-cw',
  volume: 'volume-2',
  mute: 'volume-x',
  wifi: 'wifi',
  wifiOff: 'wifi-off',
  qr: 'qr-code',
  stats: 'chart-column',
  database: 'database',
  cpu: 'cpu',
  zap: 'zap',
  layers: 'layers',
  pin: 'pin',
  arrowLeft: 'arrow-left',
  arrowRight: 'arrow-right',
  arrowUpRight: 'arrow-up-right',
  monitor: 'monitor',
  plug: 'plug',
  unplug: 'unplug',
  history: 'history',
  listChecks: 'list-checks',
  ban: 'ban',
  circleX: 'circle-x',
  languages: 'languages',
  scanText: 'scan-text',
  timer: 'timer',
  server: 'server',
  sliders: 'sliders-horizontal',
  newspaper: 'newspaper',
  stack: 'square-stack',
  telescope: 'telescope',
  brain: 'brain',
  type: 'type',
  textQuote: 'text-quote',
  menu: 'menu',
};

// The phone remote keeps its own sprite (served by the helper, no extension files). Same family, fewer icons.
export const REMOTE_ICONS = {
  grid: 'layout-grid',
  library: 'library-big',
  clock: 'clock',
  search: 'search',
  heart: 'heart',
  close: 'x',
  share: 'share',
  more: 'ellipsis',
  play: 'play',
  pause: 'pause',
  wifi: 'wifi',
  'wifi-off': 'wifi-off',
  bookmark: 'bookmark',
  download: 'download',
  'pc-save': 'monitor-down',
  check: 'check',
  photo: 'image',
  images: 'images',
  video: 'film',
  gif: 'sticker',
  text: 'text',
  reply: 'message-circle',
  repost: 'repeat-2',
  eye: 'eye',
  link: 'link',
  quote: 'quote',
  thread: 'messages-square',
  tag: 'tag',
  note: 'notebook-pen',
  star: 'star',
  chevron: 'chevron-right',
  back: 'chevron-left',
  down: 'chevron-down',
  filter: 'list-filter',
  sort: 'arrow-up-down',
  atlas: 'chart-column',
  calendar: 'calendar',
  user: 'user-round',
  device: 'smartphone',
  downloads: 'arrow-down-to-line',
  retry: 'rotate-ccw',
  alert: 'triangle-alert',
  external: 'square-arrow-out-up-right',
  copy: 'copy',
  plus: 'plus',
  zoom: 'zoom-in',
  disk: 'hard-drive',
  sparkle: 'sparkles',
  capture: 'radar',
  x: 'circle-x',
  sun: 'sun',
  moon: 'moon',
  lock: 'lock',
  info: 'info',
  verified: 'badge-check',
  feed: 'layout-list',
  globe: 'globe',
  users: 'users-round',
  hourglass: 'hourglass',
  'reply-to': 'message-circle-reply',
};

async function inner(name) {
  const file = path.join(source, 'icons', `${name}.svg`);
  const text = await readFile(file, 'utf8').catch(() => {
    throw new Error(`Lucide icon "${name}" not found in ${source}/icons`);
  });
  const body = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/\s*\/>/g, '/>')
    .replace(/\n\s*/g, '')
    .trim();
  if (!body) throw new Error(`Empty icon ${name}`);
  return body;
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const header = `lucide-static ${pkg.version} (ISC). Generated by scripts/vendor-icons.mjs; do not edit by hand.`;
  const dashboard = {};
  for (const [name, lucide] of Object.entries(DASHBOARD_ICONS)) dashboard[name] = await inner(lucide);
  const js = `/* XVault icon set — ${header} */\n(() => {\n  const set = ${JSON.stringify(dashboard, null, 2).replace(/\n/g, '\n  ')};\n  globalThis.XVaultIconSet = Object.freeze(set);\n})();\n`;
  await writeFile(path.join(root, 'xv-icon-set.js'), js);
  const symbols = [];
  for (const [name, lucide] of Object.entries(REMOTE_ICONS))
    symbols.push(`      <symbol id="i-${name}" viewBox="0 0 24 24">${await inner(lucide)}</symbol>`);
  const indexPath = path.join(root, 'FFmpeg_Helper/remote-ui/index.html');
  const index = await readFile(indexPath, 'utf8');
  const start = '<!-- xv-icons:start -->',
    end = '<!-- xv-icons:end -->';
  if (!index.includes(start) || !index.includes(end)) throw new Error('Remote index.html is missing xv-icons markers');
  const sprite = `${start}\n    <!-- ${header} -->\n    <svg class="icon-library" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n${symbols.join('\n')}\n    </svg>\n    ${end}`;
  await writeFile(indexPath, index.replace(new RegExp(`${start}[\\s\\S]*?${end}`), sprite));
  console.log(
    `Wrote ${Object.keys(dashboard).length} dashboard icons and ${symbols.length} remote symbols from lucide-static ${pkg.version}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
