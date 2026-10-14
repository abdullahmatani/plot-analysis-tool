import { newId, nowIso } from '@/core/ids';

import { getDb, type SessionRecord } from './db';

/**
 * Unclean-shutdown detection (row 95). Each tab records a session marker in IndexedDB (written with
 * strict durability, so it survives a killed browser or power loss) and holds a Web Lock for its
 * lifetime. On a normal close, `pagehide` sets a synchronous localStorage "clean" flag (and also
 * updates the marker). On launch, markers whose lock is no longer held and that are not marked clean
 * belong to sessions that crashed, were force-closed or lost power.
 */

const CLEAN_PREFIX = 'pat:clean:';

export interface CrashedSession {
  id: string;
  projectId: string;
  startedAt: string;
}

function cleanFlag(id: string): boolean {
  try {
    return localStorage.getItem(CLEAN_PREFIX + id) === '1';
  } catch {
    return false;
  }
}

function clearCleanFlag(id: string) {
  try {
    localStorage.removeItem(CLEAN_PREFIX + id);
  } catch {
    /* ignore */
  }
}

export class SessionTracker {
  readonly id = newId('ses');
  private marker: SessionRecord;
  private write = Promise.resolve();

  constructor() {
    this.marker = { id: this.id, projectId: null, startedAt: nowIso(), clean: false };
  }

  private persist() {
    const rec = { ...this.marker };
    this.write = this.write
      .then(() =>
        getDb()
          .sessions.put(rec)
          .then(() => undefined),
      )
      .catch(() => undefined);
  }

  /** Detects crashed sessions from previous runs, then registers this session. */
  async start(): Promise<CrashedSession[]> {
    const crashed = await findCrashedSessions(this.id);
    if (typeof navigator !== 'undefined' && navigator.locks) {
      void navigator.locks.request(`pat-session-${this.id}`, () => new Promise<void>(() => {}));
    }
    this.persist();
    window.addEventListener('pagehide', () => this.markClean());
    window.addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) {
        clearCleanFlag(this.id);
        this.marker.clean = false;
        this.persist();
      }
    });
    return crashed;
  }

  setProject(projectId: string | null) {
    this.marker.projectId = projectId;
    this.marker.clean = false;
    this.persist();
  }

  markClean() {
    try {
      localStorage.setItem(CLEAN_PREFIX + this.id, '1');
    } catch {
      /* ignore */
    }
    this.marker.clean = true;
    this.persist();
  }
}

async function heldLocks(): Promise<Set<string> | null> {
  try {
    if (!navigator.locks?.query) return null;
    const snap = await navigator.locks.query();
    return new Set((snap.held ?? []).map((l) => l.name ?? ''));
  } catch {
    return null;
  }
}

export async function findCrashedSessions(ownId: string): Promise<CrashedSession[]> {
  const out: CrashedSession[] = [];
  let markers: SessionRecord[];
  try {
    markers = await getDb().sessions.toArray();
  } catch {
    return out;
  }
  const held = await heldLocks();
  for (const m of markers) {
    if (m.id === ownId) continue;
    // Without Web Locks we cannot tell a live tab from a dead one; treat only clearly old markers as dead.
    const alive = held ? held.has(`pat-session-${m.id}`) : Date.now() - Date.parse(m.startedAt) < 12 * 3600e3;
    if (alive) continue;
    const clean = m.clean || cleanFlag(m.id);
    if (!clean && m.projectId) out.push({ id: m.id, projectId: m.projectId, startedAt: m.startedAt });
    try {
      await getDb().sessions.delete(m.id);
    } catch {
      /* ignore */
    }
    clearCleanFlag(m.id);
  }
  return out;
}
