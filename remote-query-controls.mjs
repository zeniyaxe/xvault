// Keep Remote query cancellation scoped to one paired browser tab. Archive
// mutations deliberately invalidate all controls; ordinary navigation only
// supersedes work issued by the same tab.
export function beginRemoteQuery(controls, key, { query, sort, cursorPlanId = null } = {}) {
  const previous = controls.get(key);
  const canShare =
    !!cursorPlanId &&
    !!previous &&
    !previous.cancelled &&
    previous.query === query &&
    previous.sort === sort &&
    previous.planId === cursorPlanId;
  if (canShare) {
    previous.requests++;
    return previous;
  }
  if (previous) previous.cancelled = true;
  const control = { cancelled: false, query, sort, planId: cursorPlanId, requests: 1 };
  controls.set(key, control);
  return control;
}

export function releaseRemoteQuery(controls, key, control) {
  control.requests = Math.max(0, control.requests - 1);
  if (!control.requests && controls.get(key) === control) controls.delete(key);
}

export function cancelRemoteQueries(controls) {
  for (const control of controls.values()) control.cancelled = true;
  controls.clear();
}
