import { newId, nowIso } from '@/core/ids';

/**
 * Unclean-shutdown detection (row 95). Each tab writes a session marker to localStorage (synchronous,
 * so it is reliable inside `pagehide`) and holds a Web Lock for its lifetime. On launch, markers that
 * are not marked clean and whose lock is no longer held belong to sessions that crashed, were
 * force-closed or lost power.
 */

const PREFIX = 'pat:session:';
const HEARTBEAT_MS = 5000;
const STALE_MS = 20000;

export interface SessionMarker {
  id: string;
  projectId: string | null;
  startedAt: string;
  beat: number;
  clean: boolean;
}

export interface CrashedSession {
  id: string;
  projectId: string;
  startedAt: string;
  lastBeat: number;
}

function read(key: string): SessionMarker | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as SessionMarker) : null;
  } catch {
    return null;
  }
}

function write(m: SessionMarker) {
  try {
    localStorage.setItem(PREFIX + m.id, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}

export class SessionTracker {
  readonly id = newId('ses');
  private marker: SessionMarker;
  private beatTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.marker = { id: this.id, projectId: null, startedAt: nowIso(), beat: Date.now(), clean: false };
  }

  /** Detects crashed sessions from previous runs, then registers this session. */
  async start(): Promise<CrashedSession[]> {
    const crashed = await findCrashedSessions(this.id);
    write(this.marker);
    if (typeof navigator !== 'undefined' && navigator.locks) {
      void navigator.locks.request(`pat-session-${this.id}`, () => new Promise<void>(() => {}));
    }
    this.beatTimer = setInterval(() => {
      this.marker.beat = Date.now();
      write(this.marker);
    }, HEARTBEAT_MS);
    window.addEventListener('pagehide', () => this.markClean());
    window.addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) {
        this.marker.clean = false;
        write(this.marker);
      }
    });
    return crashed;
  }

  setProject(projectId: string | null) {
    this.marker.projectId = projectId;
    this.marker.clean = false;
    write(this.marker);
  }

  markClean() {
    this.marker.clean = true;
    this.marker.beat = Date.now();
    write(this.marker);
  }

  stop() {
    if (this.beatTimer) clearInterval(this.beatTimer);
    try {
      localStorage.removeItem(PREFIX + this.id);
    } catch {
      /* ignore */
    }
  }
}

async function heldSessionLocks(): Promise<Set<string> | null> {
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
  let keys: string[] = [];
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX));
  } catch {
    return out;
  }
  const held = await heldSessionLocks();
  for (const key of keys) {
    const m = read(key);
    if (!m || m.id === ownId) continue;
    const alive = held ? held.has(`pat-session-${m.id}`) : Date.now() - m.beat < STALE_MS;
    if (alive) continue;
    if (!m.clean && m.projectId)
      out.push({ id: m.id, projectId: m.projectId, startedAt: m.startedAt, lastBeat: m.beat });
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  return out;
}
