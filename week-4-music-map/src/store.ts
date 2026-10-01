// Music Map - Persistence
// Journeys, notes and hidden items are plain JSON. They save to this browser's
// localStorage until a Firebase Realtime Database is configured, then to Firebase
// under the explorer's name (entered with prompt(); Firebase Auth can come later).

import type { ExplorerData, Journey, YearData } from './types';

export interface Store {
  readonly kind: 'local' | 'firebase';
  /** Short, user-facing description of where things are saved. */
  readonly label: string;
  /** True when other explorers can read what is saved. */
  readonly shared: boolean;
  saveJourney(journey: Journey): Promise<void>;
  deleteJourney(explorer: string, id: string): Promise<void>;
  /** Calls back with every journey visible to this store, now and on change. */
  watchJourneys(cb: (journeys: Journey[]) => void): () => void;
  loadExplorer(explorer: string): Promise<ExplorerData>;
  saveNote(explorer: string, trackId: string, text: string): Promise<void>;
  saveHidden(explorer: string, ids: string[]): Promise<void>;
  saveYear(explorer: string, year: string, data: YearData): Promise<void>;
}

const ROOT = 'musicMap';
const EXPLORER_KEY = 'musicMap:explorer';
const FIREBASE_CONFIG_KEY = 'musicMap:firebaseConfig';

// ---- Explorer name --------------------------------------------------------

export function getExplorer(): string | null {
  return localStorage.getItem(EXPLORER_KEY);
}

/** Uses prompt() to ask who is exploring. Returns the stored name, or null if cancelled. */
export function askExplorer(reason = 'Journeys you record will be saved under this name.'): string | null {
  const current = getExplorer() ?? '';
  const answer = window.prompt(`Who's exploring?\n${reason}`, current);
  if (answer === null) return getExplorer();
  const name = answer.trim().slice(0, 40);
  if (!name) return getExplorer();
  localStorage.setItem(EXPLORER_KEY, name);
  return name;
}

/** Firebase keys cannot contain . # $ [ ] or /. */
export function safeKey(s: string): string {
  return s.trim().toLowerCase().replace(/[.#$[\]/\s]+/g, '_') || 'anonymous';
}

/** Case-preserving key for ids (Spotify ids are case-sensitive). */
function idKey(s: string): string {
  return s.replace(/[.#$[\]/]/g, '_');
}

/** Firebase drops undefined and rejects it inside set(); round-trip through JSON. */
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Firebase drops empty arrays, so thoughts may come back missing. */
function normalizeYears(raw?: Record<string, Partial<YearData>>): Record<string, YearData> {
  const out: Record<string, YearData> = {};
  Object.entries(raw ?? {}).forEach(([k, v]) => (out[k] = { label: v.label, thoughts: v.thoughts ?? [] }));
  return out;
}

function normalizeJourney(j: Journey): Journey {
  return { ...j, steps: j.steps ?? [], nodes: j.nodes ?? {}, relLabels: j.relLabels ?? {} };
}

// ---- localStorage ---------------------------------------------------------

interface LocalShape {
  explorers: Record<
    string,
    { name: string; journeys?: Record<string, Journey>; notes?: Record<string, string>; hidden?: string[]; years?: Record<string, YearData> }
  >;
}

class LocalStore implements Store {
  readonly kind = 'local' as const;
  readonly label = 'This browser';
  readonly shared = false;
  private listeners = new Set<(j: Journey[]) => void>();

  private read(): LocalShape {
    try {
      const raw = localStorage.getItem(ROOT);
      if (raw) return JSON.parse(raw);
    } catch {
      /* fall through to empty */
    }
    return { explorers: {} };
  }

  private write(data: LocalShape): void {
    localStorage.setItem(ROOT, JSON.stringify(data));
  }

  private explorer(data: LocalShape, name: string) {
    const key = safeKey(name);
    return (data.explorers[key] ??= { name });
  }

  private all(): Journey[] {
    return Object.values(this.read().explorers).flatMap((e) =>
      Object.values(e.journeys ?? {}).map(normalizeJourney),
    );
  }

  private emit(): void {
    const all = this.all();
    this.listeners.forEach((cb) => cb(all));
  }

  async saveJourney(journey: Journey): Promise<void> {
    const data = this.read();
    const ex = this.explorer(data, journey.explorer);
    (ex.journeys ??= {})[journey.id] = clean(journey);
    this.write(data);
    this.emit();
  }

  async deleteJourney(explorer: string, id: string): Promise<void> {
    const data = this.read();
    delete this.explorer(data, explorer).journeys?.[id];
    this.write(data);
    this.emit();
  }

  watchJourneys(cb: (journeys: Journey[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.all());
    return () => this.listeners.delete(cb);
  }

  async loadExplorer(explorer: string): Promise<ExplorerData> {
    const ex = this.read().explorers[safeKey(explorer)];
    return { notes: ex?.notes ?? {}, hidden: ex?.hidden ?? [], years: normalizeYears(ex?.years) };
  }

  async saveNote(explorer: string, trackId: string, text: string): Promise<void> {
    const data = this.read();
    const ex = this.explorer(data, explorer);
    ex.notes ??= {};
    if (text) ex.notes[trackId] = text;
    else delete ex.notes[trackId];
    this.write(data);
  }

  async saveHidden(explorer: string, ids: string[]): Promise<void> {
    const data = this.read();
    this.explorer(data, explorer).hidden = ids;
    this.write(data);
  }

  async saveYear(explorer: string, year: string, yearData: YearData): Promise<void> {
    const data = this.read();
    const ex = this.explorer(data, explorer);
    (ex.years ??= {})[year] = clean(yearData);
    this.write(data);
  }
}

// ---- Firebase Realtime Database ------------------------------------------

export interface FirebaseSettings {
  apiKey: string;
  authDomain?: string;
  databaseURL: string;
  projectId?: string;
  appId?: string;
}

export function firebaseSettings(): FirebaseSettings | null {
  const env = import.meta.env;
  if (env.VITE_FIREBASE_DATABASE_URL && env.VITE_FIREBASE_API_KEY) {
    return {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      databaseURL: env.VITE_FIREBASE_DATABASE_URL,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    };
  }
  try {
    const raw = localStorage.getItem(FIREBASE_CONFIG_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.databaseURL && parsed?.apiKey) return parsed;
  } catch {
    /* ignore malformed config */
  }
  return null;
}

/** Accepts the JSON object, or the `const firebaseConfig = {...}` snippet Firebase shows. */
export function saveFirebaseSettings(text: string): FirebaseSettings | null {
  if (!text.trim()) {
    localStorage.removeItem(FIREBASE_CONFIG_KEY);
    return null;
  }
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  // Quote bare keys and swap single quotes so the console snippet parses as JSON.
  const json = body
    .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,\s*}/g, '}');
  const parsed = JSON.parse(json) as FirebaseSettings;
  if (!parsed.apiKey || !parsed.databaseURL) {
    throw new Error('The config needs at least apiKey and databaseURL (create a Realtime Database first).');
  }
  localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(parsed));
  return parsed;
}

async function createFirebaseStore(settings: FirebaseSettings): Promise<Store> {
  const { initializeApp } = await import('firebase/app');
  const db = await import('firebase/database');
  const app = initializeApp(settings);
  const database = db.getDatabase(app);
  const path = (...parts: string[]) => db.ref(database, [ROOT, 'explorers', ...parts].join('/'));

  return {
    kind: 'firebase',
    label: 'Firebase (shared)',
    shared: true,

    async saveJourney(journey) {
      const key = safeKey(journey.explorer);
      await db.update(path(key), { name: journey.explorer });
      await db.set(path(key, 'journeys', journey.id), clean(journey));
    },

    async deleteJourney(explorer, id) {
      await db.remove(path(safeKey(explorer), 'journeys', id));
    },

    watchJourneys(cb) {
      return db.onValue(path(), (snap) => {
        const explorers = (snap.val() ?? {}) as Record<string, { journeys?: Record<string, Journey> }>;
        cb(Object.values(explorers).flatMap((e) => Object.values(e.journeys ?? {}).map(normalizeJourney)));
      });
    },

    async loadExplorer(explorer) {
      const snap = await db.get(path(safeKey(explorer)));
      const val = snap.val() ?? {};
      const notes: Record<string, string> = {};
      Object.entries((val.notes ?? {}) as Record<string, { trackId: string; text: string }>).forEach(
        ([, n]) => (notes[n.trackId] = n.text),
      );
      return { notes, hidden: val.hidden ?? [], years: normalizeYears(val.years) };
    },

    async saveNote(explorer, trackId, text) {
      const ref = path(safeKey(explorer), 'notes', idKey(trackId));
      if (text) await db.set(ref, { trackId, text, updatedAt: new Date().toISOString() });
      else await db.remove(ref);
    },

    async saveHidden(explorer, ids) {
      await db.set(path(safeKey(explorer), 'hidden'), ids);
    },

    async saveYear(explorer, year, yearData) {
      await db.set(path(safeKey(explorer), 'years', idKey(year)), clean(yearData));
    },
  };
}

/** Firebase when configured and reachable; otherwise this browser. */
export async function createStore(): Promise<{ store: Store; error?: string }> {
  const settings = firebaseSettings();
  if (!settings) return { store: new LocalStore() };
  try {
    return { store: await createFirebaseStore(settings) };
  } catch (err) {
    console.error('Firebase unavailable, saving locally instead', err);
    return { store: new LocalStore(), error: (err as Error).message };
  }
}
