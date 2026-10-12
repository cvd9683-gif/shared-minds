// Music Map - The imported Spotify library, kept in this browser.
// A full library (up to Spotify's 10,000 saved songs) is several megabytes, more than
// localStorage holds, so it lives in IndexedDB. The app works from an in-memory copy
// loaded once at startup; writes go to IndexedDB in the background.

import type { Dataset } from './types';

const DB = 'musicMap';
const STORE = 'library';
const OLD_KEY = 'musicMap:spotifyLibrary';
let current: Dataset | null = null;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function write(value: Dataset | null): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (value) tx.objectStore(STORE).put(value, 'spotify');
    else tx.objectStore(STORE).delete('spotify');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Loads the saved library into memory (moving an older localStorage copy across). */
export async function loadLibrary(): Promise<void> {
  try {
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      current = JSON.parse(old);
      await write(current);
      localStorage.removeItem(OLD_KEY);
      return;
    }
    const db = await open();
    current = await new Promise<Dataset | null>((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get('spotify');
      req.onsuccess = () => resolve((req.result as Dataset) ?? null);
      req.onerror = () => resolve(null);
    });
    db.close();
  } catch {
    current = null;
  }
}

export function getLibrary(): Dataset | null {
  return current;
}

export function hasLibrary(): boolean {
  return !!current;
}

export function saveLibrary(data: Dataset | null): void {
  current = data;
  void write(data).catch(() => {
    /* storage refused: the library still works until the page is closed */
  });
}

/** Adds newly found songs, people and links to the saved library. */
export function extendLibrary(data: Partial<Dataset>): void {
  if (!current) return;
  const lib = current;
  const add = <T extends { id: string }>(list: T[], extra: T[] | undefined) => {
    const ids = new Set(list.map((x) => x.id));
    for (const x of extra ?? []) if (!ids.has(x.id)) list.push(x);
  };
  add(lib.tracks, data.tracks);
  add(lib.people, data.people);
  add(lib.relationships, data.relationships);
  saveLibrary(lib);
}
