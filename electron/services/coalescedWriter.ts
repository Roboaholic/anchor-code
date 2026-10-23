/** Serializes writes while replacing queued snapshots with the newest one. */
export function createCoalescedWriter<T>(write: (value: T) => Promise<void>, delayMs = 25) {
  type Pending = { value: T; resolve: Array<() => void>; reject: Array<(error: unknown) => void> };
  let pending: Pending | null = null;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError: unknown;

  const schedule = () => {
    if (timer || active || !pending) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, delayMs);
  };
  const drain = (): Promise<void> => {
    if (active) return active;
    const batch = pending;
    if (!batch) return Promise.resolve();
    pending = null;
    active = Promise.resolve().then(() => write(batch.value)).then(
      () => { lastError = undefined; batch.resolve.forEach((resolve) => resolve()); },
      (error: unknown) => { lastError = error; batch.reject.forEach((reject) => reject(error)); },
    ).finally(() => { active = null; schedule(); });
    return active;
  };

  return {
    enqueue(value: T): Promise<void> {
      return new Promise((resolve, reject) => {
        if (pending) {
          pending.value = value;
          pending.resolve.push(resolve);
          pending.reject.push(reject);
        } else pending = { value, resolve: [resolve], reject: [reject] };
        schedule();
      });
    },
    async flush(): Promise<void> {
      while (pending || active) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        await drain();
      }
      if (lastError !== undefined) throw lastError;
    },
  };
}
