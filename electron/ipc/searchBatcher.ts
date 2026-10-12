/**
 * Coalesce streamed hits into IPC batches (every ~30ms or 200 hits) so a
 * fast rg does not flood the renderer with one message per stdout chunk.
 */
export function createSearchHitBatcher<T>(
  send: (batch: T[]) => void,
  opts: { intervalMs?: number; maxBatch?: number } = {},
): { push: (items: T[]) => void; flush: () => void; dispose: () => void } {
  const intervalMs = opts.intervalMs ?? 30;
  const maxBatch = opts.maxBatch ?? 200;
  let buf: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let first = true;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf.length === 0) return;
    const batch = buf;
    buf = [];
    send(batch);
  };
  return {
    push: (items) => {
      if (items.length === 0) return;
      buf.push(...items);
      // First hits go out immediately — time-to-first-result matters most.
      if (first || buf.length >= maxBatch) {
        first = false;
        flush();
        return;
      }
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      buf = [];
    },
  };
}
