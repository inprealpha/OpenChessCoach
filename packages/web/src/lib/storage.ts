// The offline store (ADR 0003): IndexedDB holds the pairing token, the cached game list, an
// Engine Game in progress and the queue of Engine Games finished while the desktop was away.
const DB_NAME = 'ai-chess-coach';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB error'));
  });
}

export const store = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return (await run('readonly', (s) => s.get(key))) as T | undefined;
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      await run('readwrite', (s) => s.put(structuredClone(value), key));
    } catch {
      // Private browsing can refuse IndexedDB; the app still works for this session.
    }
  },
  async del(key: string): Promise<void> {
    try {
      await run('readwrite', (s) => s.delete(key));
    } catch {
      // ignore
    }
  },
};

const TOKEN_KEY = 'chess-coach.token';

/** The device token lives in IndexedDB, mirrored in localStorage so it survives either being cleared. */
export async function loadToken(): Promise<string | null> {
  const fromLocal = safeLocal(() => localStorage.getItem(TOKEN_KEY));
  if (fromLocal) return fromLocal;
  return (await store.get<string>('token')) ?? null;
}

export async function saveToken(token: string | null): Promise<void> {
  safeLocal(() => (token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY)));
  if (token) await store.set('token', token);
  else await store.del('token');
}

function safeLocal<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
