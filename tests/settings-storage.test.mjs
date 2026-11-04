import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { compactSource, readSource, topLevelDeclaration } from './source-text.mjs';
const source = readSource('background.js');
const defaults = source.match(/const defaults\s*=\s*\{[\s\S]*?\n\};/)[0];
const bulk = topLevelDeclaration(source, 'const bulkSettingsDefaults');
const settingsLines = source.split(/\r?\n/);
const start = settingsLines.findIndex(line => line.startsWith('function normalizeSettings('));
const end = settingsLines.findIndex(
  (line, index) => index > start && line.startsWith('async function writeSettingsPatch(')
);
assert.ok(start >= 0 && end > start, 'settings helpers should have an identifiable source range');
const functions = `${settingsLines.slice(start, end).join('\n')}\n${topLevelDeclaration(source, 'async function writeSettingsPatch(')}`;
const wrappers = source
  .split('\n')
  .filter(line => /^const _(?:get|set)SettingsV\d+=/.test(line))
  .join('\n');
let data = {},
  writes = 0;
const chrome = {
  storage: {
    local: {
      get: async key => ({ [key]: structuredClone(data[key]) }),
      set: async patch => {
        writes++;
        Object.assign(data, structuredClone(patch));
      },
    },
  },
};
const context = vm.createContext({ chrome });
vm.runInContext(fs.readFileSync(new URL('../workspace-model.js', import.meta.url), 'utf8'), context);
vm.runInContext(`${defaults}\n${bulk}\n${functions}\n${wrappers}`, context);
data = {
  settings: {
    settingsVersion: 18,
    libraryPageSize: 300,
    motionLevel: 'rich',
    savedViews: [{ name: 'Unicode — 観察', query: 'tag:art' }],
  },
};
let settings = await context.getSettings();
assert.equal(settings.libraryPageSize, 300, 'an intentional v18 page size must survive reads');
const initialWrites = writes;
for (let index = 0; index < 5; index++) await context.getSettings();
assert.equal(writes, initialWrites, 'reads of normalized settings must not rewrite storage');
assert.equal(data.settings.settingsVersion, 18);
await context.setSettings({ libraryPageSize: 300, motionLevel: 'off' });
assert.equal(data.settings.settingsVersion, 18, 'writes must keep the current schema version');
assert.equal((await context.getSettings()).libraryPageSize, 300);
assert.equal(data.settingsHistory.length, 1);
assert.equal(data.settingsHistory[0].settings.motionLevel, 'rich');
assert.equal(data.settings.savedViews[0].name, 'Unicode — 観察');
await Promise.all([context.setSettings({ motionLevel: 'rich' }), context.setSettings({ theme: 'paper' })]);
assert.equal(data.settings.motionLevel, 'rich', 'concurrent unrelated patches must not overwrite each other');
assert.equal(data.settings.theme, 'paper');
assert.equal(data.settingsHistory.length, 3, 'each serialized change retains its prior settings');
data = { settings: { settingsVersion: 17, libraryPageSize: 300 } };
assert.equal((await context.getSettings()).libraryPageSize, 120, 'untouched pre-v18 default migrates once');
data = { settings: { settingsVersion: 15, libraryPageSize: 450, shiftCopiesOriginal: false, altOpensLink: false } };
settings = await context.getSettings();
assert.equal(settings.libraryPageSize, 450);
assert.equal(settings.copyShiftAction, 'copy-transformed');
assert.equal(settings.copyAltAction, 'copy-transformed');
await context.setSettings({ libraryPageSize: 5000, motionSpeed: 0 });
assert.equal(data.settings.libraryPageSize, 1500, 'writes normalize numeric ranges before saving');
console.log(
  'Settings storage: stable reads, current schema, intentional page sizes, legacy migration, history, and bounded writes passed'
);

assert.ok(
  !compactSource(source).includes('verifyDownloads:true'),
  'dead verification toggle is removed from defaults and migrations'
);
