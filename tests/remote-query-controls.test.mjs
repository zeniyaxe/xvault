import assert from 'node:assert/strict';
import { beginRemoteQuery, releaseRemoteQuery, cancelRemoteQueries } from '../remote-query-controls.mjs';

const controls = new Map();
const firstTab = beginRemoteQuery(controls, 'device:tab-a', { query: 'cats', sort: 'new' });
const secondTab = beginRemoteQuery(controls, 'device:tab-b', { query: 'cats', sort: 'new' });
assert.notEqual(firstTab, secondTab, 'separate Remote tabs must never share cancellation state');
assert.equal(firstTab.cancelled, false);

const replaced = beginRemoteQuery(controls, 'device:tab-a', { query: 'dogs', sort: 'new' });
assert.equal(firstTab.cancelled, true, 'a new query in one tab should stop that tab’s prior scan');
assert.equal(secondTab.cancelled, false, 'a new query must not interrupt another tab');

const pageA = beginRemoteQuery(controls, 'device:tab-a', { query: 'dogs', sort: 'new', cursorPlanId: 'plan-a' });
const pageB = beginRemoteQuery(controls, 'device:tab-a', { query: 'dogs', sort: 'new', cursorPlanId: 'plan-a' });
assert.equal(pageA, pageB, 'overlapping pages from one query plan share a cancellation token');
assert.equal(pageA.requests, 2);
releaseRemoteQuery(controls, 'device:tab-a', pageA);
assert.equal(controls.get('device:tab-a'), pageA, 'one completed page must not unregister another in-flight page');
releaseRemoteQuery(controls, 'device:tab-a', pageB);
assert.equal(controls.has('device:tab-a'), false, 'idle controls should be released');

const wrongPlan = beginRemoteQuery(controls, 'device:tab-b', { query: 'cats', sort: 'new', cursorPlanId: 'expired-plan' });
assert.equal(secondTab.cancelled, true, 'a continuation cannot inherit another plan’s control');
assert.notEqual(wrongPlan, secondTab);
cancelRemoteQueries(controls);
assert.equal(wrongPlan.cancelled, true, 'a committed archive mutation must cancel every active Remote scan');
assert.equal(controls.size, 0);

console.log('Remote query controls: per-tab isolation, plan-bound overlap, cleanup, and archive invalidation passed');
