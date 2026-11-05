import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketStart, chooseUnit, nextBucket, timelineBuckets } from '../sw/timeline.mjs';

const at = text => Date.parse(text);

test('unit follows the span', () => {
  assert.equal(chooseUnit(at('2024-01-01'), at('2024-02-15')), 'day');
  assert.equal(chooseUnit(at('2024-01-01'), at('2025-06-01')), 'week');
  assert.equal(chooseUnit(at('2016-01-01'), at('2024-06-01')), 'month');
  assert.equal(chooseUnit(at('2008-01-01'), at('2024-06-01')), 'year');
});

test('weeks start on Monday; months and years roll over', () => {
  assert.equal(bucketStart(at('2024-05-15T10:00:00Z'), 'week'), at('2024-05-13')); // Wednesday → Monday
  assert.equal(bucketStart(at('2024-05-13T00:00:00Z'), 'week'), at('2024-05-13'));
  assert.equal(bucketStart(at('2024-05-19T23:59:59Z'), 'week'), at('2024-05-13')); // Sunday
  assert.equal(nextBucket(at('2024-12-01'), 'month'), at('2025-01-01'));
  assert.equal(nextBucket(at('2024-01-01'), 'year'), at('2025-01-01'));
});

test('buckets are contiguous, filled, and give after:/before: days', () => {
  const stamps = ['2024-01-03', '2024-01-03', '2024-03-20', 'bad', '2024-03-01'].map(at);
  const result = timelineBuckets([...stamps, 0, NaN], { unit: 'month' });
  assert.equal(result.unit, 'month');
  assert.deepEqual(
    result.buckets.map(bucket => [bucket.from, bucket.to, bucket.count]),
    [
      ['2024-01-01', '2024-02-01', 2],
      ['2024-02-01', '2024-03-01', 0],
      ['2024-03-01', '2024-04-01', 2],
    ]
  );
  assert.equal(result.undated, 3);
  const total = result.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  assert.equal(total, 4, 'every dated post is counted once');
  assert.deepEqual(timelineBuckets([]).buckets, []);
});

test('local zone buckets use local midnights', () => {
  const stamp = new Date(2024, 4, 15, 23, 30).getTime();
  const result = timelineBuckets([stamp], { zone: 'local', unit: 'day' });
  assert.equal(result.buckets[0].start, new Date(2024, 4, 15).getTime());
  assert.equal(result.buckets[0].from, '2024-05-15');
  assert.equal(result.buckets[0].to, '2024-05-16');
});
