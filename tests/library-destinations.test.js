const assert = require('node:assert/strict');
const model = require('../library-model.js');

assert.equal(model.destinationQuery('all'), '');
assert.equal(model.destinationQuery('favorites'), 'fav:true');
assert.equal(model.destinationQuery('animations'), 'type:gif');
assert.equal(model.destinationQuery('missing'), 'missing:true');
assert.equal(model.destinationQuery('inbox'), 'inbox:true');
assert.equal(model.destinationQuery('untagged'), 'untagged:true');
assert.equal(model.destinationQuery('unknown'), null, 'unknown locations cannot silently display all posts');

const post = {
  id: '10',
  media: [
    { id: 'image-a', url: 'https://pbs.twimg.com/a.jpg' },
    { id: 'image-b', url: 'https://pbs.twimg.com/b.jpg' },
  ],
};
const downloads = new Map([
  ['10', [{ state: 'complete', item: { mediaId: 'image-a' }, verification: { state: 'verified' } }]],
]);
assert.equal(model.hasMissingMedia(post, downloads), true, 'a partial post still has missing media');
downloads.get('10').push({ state: 'complete', item: { mediaId: 'image-b' }, verification: { state: 'verified' } });
assert.equal(model.hasMissingMedia(post, downloads), false);
assert.equal(model.hasMissingMedia({ id: '11', media: [] }, downloads), false, 'text-only posts are not missing media');

// Inbox: archived on/after the cut-off and not yet reviewed; no cut-off means the feature is idle.
assert.equal(model.isInbox({ archivedAt: 200, userMeta: {} }, 100), true);
assert.equal(model.isInbox({ archivedAt: 100, userMeta: {} }, 100), true, 'the cut-off itself is inside the Inbox');
assert.equal(
  model.isInbox({ archivedAt: 99, userMeta: {} }, 100),
  false,
  'posts archived before the cut-off were already seen'
);
assert.equal(
  model.isInbox({ archivedAt: 200, userMeta: { reviewedAt: 150 } }, 100),
  false,
  'reviewed posts leave the Inbox'
);
assert.equal(model.isInbox({ archivedAt: 200 }, 0), false);
assert.equal(model.isInbox({ archivedAt: 200 }, undefined), false);
assert.equal(
  model.isInbox({ archivedAt: 5, userMeta: {} }, 1),
  true,
  'a cut-off of 1 puts every unreviewed post back in the Inbox'
);
console.log('library destination filters passed');
