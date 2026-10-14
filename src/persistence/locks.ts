import type { JournalRecord } from './db';

/**
 * Multi-tab write protection (row 100). A Web Lock per project gives exactly one tab write access;
 * other tabs open the project read-only, receive the writer's journal records over a
 * BroadcastChannel, and can ask to take over editing (the writer flushes and releases first).
 */

export type ProjectChannelMessage =
  | { type: 'ops'; from: string; records: JournalRecord[] }
  | { type: 'takeover-request'; from: string }
  | { type: 'released'; from: string }
  | { type: 'writer'; from: string };

export const lockName = (projectId: string) => `pat-project-${projectId}`;

export class ProjectLock {
  private release: (() => void) | null = null;
  private channel: BroadcastChannel | null = null;
  private handlers = new Set<(m: ProjectChannelMessage) => void>();
  private lostHandlers = new Set<() => void>();
  readonly supported = typeof navigator !== 'undefined' && !!navigator.locks;

  constructor(
    readonly projectId: string,
    readonly tabId: string,
  ) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(lockName(projectId));
      this.channel.onmessage = (e: MessageEvent<ProjectChannelMessage>) => {
        if (e.data?.from === tabId) return;
        for (const h of this.handlers) h(e.data);
      };
    }
  }

  get held() {
    return this.release !== null;
  }

  /** Tries to become the writer. Resolves true when the lock was granted. */
  acquire(opts: { wait?: boolean; steal?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
    if (!this.supported) {
      this.release = () => {};
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const controller = opts.wait && !opts.steal && opts.timeoutMs ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
      const options: LockOptions = opts.steal
        ? { steal: true }
        : opts.wait
          ? { signal: controller?.signal }
          : { ifAvailable: true };
      navigator.locks
        .request(lockName(this.projectId), options, (lock) => {
          if (timer) clearTimeout(timer);
          if (!lock) {
            settled = true;
            resolve(false);
            return undefined;
          }
          settled = true;
          resolve(true);
          return new Promise<void>((rel) => {
            this.release = rel;
          });
        })
        .then(() => {
          this.release = null;
        })
        .catch(() => {
          // Lock stolen by another tab, or acquisition aborted by timeout.
          const hadLock = this.release !== null;
          this.release = null;
          if (!settled) resolve(false);
          if (hadLock) for (const h of this.lostHandlers) h();
        });
    });
  }

  releaseLock() {
    const r = this.release;
    this.release = null;
    r?.();
  }

  post(msg: ProjectChannelMessage) {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* channel closed */
    }
  }

  onMessage(fn: (m: ProjectChannelMessage) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  onLost(fn: () => void): () => void {
    this.lostHandlers.add(fn);
    return () => this.lostHandlers.delete(fn);
  }

  dispose() {
    this.releaseLock();
    this.channel?.close();
    this.channel = null;
    this.handlers.clear();
    this.lostHandlers.clear();
  }
}
