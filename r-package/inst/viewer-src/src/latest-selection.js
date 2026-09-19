// One query in flight per subscriber, retaining only the latest request.
// Query inputs must be snapshots (e.g. a WHERE string), not mutable selections.
export function createLatestSelectionScheduler({ query, apply, onError = () => {} }) {
  let revision = 0;
  let disposed = false;
  let active = false;
  let pending = null;

  async function drain() {
    if (disposed || active || !pending) return;
    const request = pending;
    pending = null;
    active = true;
    try {
      const value = await query(request.input);
      if (!disposed && request.revision === revision) apply(value);
    } catch (error) {
      if (!disposed) onError(error);
    } finally {
      active = false;
      drain();
    }
  }

  return {
    request(input) {
      if (disposed) return;
      ++revision;
      if (input === null) {
        pending = null;
        apply(null);
        return;
      }
      pending = { input, revision };
      drain();
    },
    dispose() {
      disposed = true;
      ++revision;
      pending = null;
    },
  };
}
