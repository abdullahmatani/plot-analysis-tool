/** Storage persistence and quota monitoring (row 99). */

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean | null;
  available: boolean;
}

export const QUOTA_WARN_FRACTION = 0.8;

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
    // (Callers must not block on this: Firefox resolves only after the user answers a prompt.)
  } catch {
    return null;
  }
}

export async function storageInfo(): Promise<StorageInfo> {
  try {
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted, available: true };
  } catch {
    return { usage: 0, quota: 0, persisted: null, available: false };
  }
}

/** True when IndexedDB can be opened and written (false in some private-browsing modes). */
export async function probeIndexedDb(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open('pat-probe', 1);
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), 5000);
    req.onupgradeneeded = () => req.result.createObjectStore('p');
    req.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      try {
        const tx = req.result.transaction('p', 'readwrite');
        tx.objectStore('p').put(1, 'k');
        tx.oncomplete = () => {
          req.result.close();
          resolve(true);
        };
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    };
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
