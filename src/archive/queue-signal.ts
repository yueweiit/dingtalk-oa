// Only a latency optimization. The database queue and polling survive crashes
// and cover writers running in another process.
const listeners = new Set<() => void>();

export function subscribeAttachmentQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyAttachmentQueue(): void {
  for (const listener of listeners) {
    try { listener(); } catch {
      // A wake-up failure must never turn a committed approval into a failed event.
      console.error('[Archive] ATTACHMENT_QUEUE_WAKE_FAILED');
    }
  }
}
