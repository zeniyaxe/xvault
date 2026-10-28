/* Serializes query-definition mutations with the other dashboard settings writes. */
export function createSmartCollectionService({ readSettings, writeSettings, enqueue, collectionApi }) {
  if (typeof readSettings !== 'function' || typeof writeSettings !== 'function' || typeof enqueue !== 'function' || typeof collectionApi?.applyChange !== 'function') {
    throw new TypeError('Smart Collection service needs settings, queue, and collection operations');
  }
  return change => enqueue(async () => {
    const current = await readSettings();
    const mutation = collectionApi.applyChange(current.savedViews, change);
    if (!mutation.changed) return { ok: true, settings: current, ...mutation };
    const settings = await writeSettings({ savedViews: mutation.savedViews });
    return { ok: true, settings, ...mutation };
  });
}
