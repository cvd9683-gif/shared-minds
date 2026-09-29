// Music Map - Main application
// Orchestrates the two date systems (My timeline / Music history), the path a
// listener follows through relationships, journey recording, storage, Spotify and
// the detail panel.

import './style.css';
import demoData from './data/demo-collection.json';
import { coverUrl } from './covers';
import { DAY, TimelineField, TimelineRail, escapeHtml as h, type FieldItem } from './field';
import {
  MusicGraph,
  formatPartialDate,
  formatSaved,
  groupLabel,
  nameOf,
  neighborPhrase,
  precisionNote,
  relRank,
  relSentence,
  type Neighbor,
} from './graph';
import { JourneyRecorder, describeScene, pathAfter, type PathStep, type SaveStatus } from './journey';
import { enrichFromMusicBrainz } from './musicbrainz';
import { NetworkView, type Scene, type SceneEdge, type SceneNode } from './network';
import * as spotify from './spotify';
import {
  askExplorer,
  createStore,
  firebaseSettings,
  getExplorer,
  saveFirebaseSettings,
  type Store,
} from './store';
import type { Dataset, Journey, Node, Relationship, Track, ViewMode } from './types';

const DATASET_KEY = 'musicMap:dataset';
const LIBRARY_KEY = 'musicMap:spotifyLibrary';
const NEIGHBOR_LIMIT = 10;
const WIDER_LIMIT = 60;

type SearchState = {
  query: string;
  kind: spotify.SearchKind;
  loading: boolean;
  error?: string;
  spotify?: spotify.SpotifySearchResults;
  drill?: { title: string; loading: boolean; error?: string; albums?: spotify.SpotifySearchResults['albums']; tracks?: Partial<Dataset>[] };
};

class MusicMapApp {
  private graph = new MusicGraph();
  private store!: Store;
  private storeError?: string;
  private explorer: string | null = getExplorer();
  private notes: Record<string, string> = {};
  private hidden = new Set<string>();
  private recording = true;

  // Exploration state
  private view: ViewMode = 'timeline';
  private path: PathStep[] = [];
  private inspected: { id: string; relIds: string[] } | null = null;
  private expanded = new Set<string>();
  private wider = false;
  private reflecting = false;
  private showData = false;
  private search: SearchState | null = null;
  private journeys: Journey[] = [];
  private replay: { journey: Journey; index: number; timer: number } | null = null;
  private saveStatus: SaveStatus = { state: 'idle' };
  private mbStatus = new Map<string, string>();
  private importStatus = '';
  private flash = '';
  private playerLoaded = new Set<string>();

  // Environment
  private narrow = matchMedia('(max-width: 760px)');
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // Views
  private stage = document.getElementById('stage')!;
  private panel = document.getElementById('panel')!;
  private pathbar = document.getElementById('pathbar')!;
  private tooltip = document.getElementById('tooltip')!;
  private note = document.getElementById('stage-note')!;
  private announcer = document.getElementById('announcer')!;
  private field: TimelineField;
  private rail: TimelineRail;
  private network: NetworkView;
  private recorder: JourneyRecorder;

  constructor() {
    this.field = new TimelineField(document.getElementById('field')!, {
      onSelect: (id, rect) => this.selectOrigin(id, rect),
      onCursor: (ms) => this.rail.setCursor(ms),
      onHover: (id, el) => this.showTooltip(id, el),
    });
    this.rail = new TimelineRail(document.getElementById('rail')!, (ms) => this.field.setCursor(ms));
    this.network = new NetworkView(
      document.getElementById('nodes')!,
      document.getElementById('edges') as unknown as SVGSVGElement,
      document.getElementById('axis')!,
      this.graph,
      {
        onActivate: (id) => this.activateNode(id),
        onHover: (id, el) => this.showTooltip(id, el),
      },
    );
    this.recorder = new JourneyRecorder(this.graph, () => this.store, (s) => {
      this.saveStatus = s;
      this.renderSaveStatus();
    });
  }

  async init(): Promise<void> {
    const login = await spotify
      .completeLoginFromUrl()
      .catch((e: Error) => ({ completed: false, error: e.message }));

    const { store, error } = await createStore();
    this.store = store;
    this.storeError = error;
    if (this.explorer) await this.loadExplorerData();

    this.loadDataset();
    this.bindUi();
    this.applyEnvironment();
    this.store.watchJourneys((all) => {
      this.journeys = all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (!this.path.length || this.showData) this.renderPanel();
    });

    if (login.error) this.flash = login.error;
    this.renderChrome();
    this.render();
    // Returning from Spotify's consent screen: bring in saved tracks right away.
    if (login.completed) void this.importLibrary();
  }

  // ---- Data -------------------------------------------------------------------

  private get datasetKind(): 'demo' | 'spotify' {
    return localStorage.getItem(DATASET_KEY) === 'spotify' && localStorage.getItem(LIBRARY_KEY) ? 'spotify' : 'demo';
  }

  private loadDataset(): void {
    this.graph.clear();
    if (this.datasetKind === 'spotify') {
      try {
        this.graph.merge(JSON.parse(localStorage.getItem(LIBRARY_KEY)!));
      } catch {
        localStorage.removeItem(LIBRARY_KEY);
        this.graph.merge(demoData as Dataset);
      }
    } else {
      this.graph.merge(demoData as Dataset);
    }
    this.path = [];
    this.inspected = null;
    this.refreshField();
  }

  private refreshField(): void {
    const items: FieldItem[] = this.graph
      .savedTracks(this.hidden)
      .map(({ entry, track }) => ({ id: track.id, track, savedMs: Date.parse(entry.savedAt) }));
    this.field.setItems(items);
    this.rail.setData(this.field.range, items.map((i) => i.savedMs));
    this.rail.setCursor(this.field.cursorMs);
  }

  private async loadExplorerData(): Promise<void> {
    if (!this.explorer) return;
    try {
      const data = await this.store.loadExplorer(this.explorer);
      this.notes = data.notes;
      this.hidden = new Set(data.hidden);
    } catch (err) {
      console.error(err);
    }
  }

  private async importLibrary(): Promise<void> {
    this.showData = true;
    this.importStatus = 'Importing saved tracks from Spotify…';
    this.renderPanel();
    try {
      const data = await spotify.importSavedTracks(300, (n, total) => {
        this.importStatus = `Importing saved tracks from Spotify… ${n} of ${total}`;
        this.renderPanel();
      });
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(data));
      localStorage.setItem(DATASET_KEY, 'spotify');
      this.importStatus = `Imported ${data.collection?.length ?? 0} saved tracks with the dates you saved them.`;
      this.loadDataset();
      this.renderChrome();
      this.render();
    } catch (err) {
      this.importStatus = (err as Error).message;
      this.renderPanel();
    }
  }

  private useDataset(kind: 'demo' | 'spotify'): void {
    localStorage.setItem(DATASET_KEY, kind);
    this.recorder.flush();
    this.recorder.journey = null;
    this.loadDataset();
    this.renderChrome();
    this.render();
  }

  /** Merges data into the graph and, for a Spotify library, into the cached copy. */
  private addData(data: Partial<Dataset>): void {
    this.graph.merge(data);
    if (this.datasetKind !== 'spotify') return;
    try {
      const lib = JSON.parse(localStorage.getItem(LIBRARY_KEY)!) as Dataset;
      lib.tracks.push(...(data.tracks ?? []).filter((t) => !lib.tracks.some((x) => x.id === t.id)));
      lib.people.push(...(data.people ?? []).filter((p) => !lib.people.some((x) => x.id === p.id)));
      lib.relationships.push(...(data.relationships ?? []).filter((r) => !lib.relationships.some((x) => x.id === r.id)));
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
    } catch {
      /* cache is a convenience only */
    }
  }

  // ---- UI wiring ----------------------------------------------------------------

  private bindUi(): void {
    document.querySelectorAll<HTMLButtonElement>('.mm-view').forEach((b) =>
      b.addEventListener('click', () => this.setView(b.dataset.view as ViewMode)),
    );
    document.querySelector('.mm-views')!.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const next = this.view === 'timeline' ? 'history' : 'timeline';
        this.setView(next);
        document.getElementById(`view-${next}`)!.focus();
      }
    });

    this.stage.addEventListener(
      'wheel',
      (e) => {
        if (this.view !== 'timeline' || this.path.length || this.narrow.matches) return;
        e.preventDefault();
        this.field.nudge((e.deltaY + e.deltaX) * DAY * 0.35);
      },
      { passive: false },
    );

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea, select')) return;
      if (e.key === 'Escape') {
        if (this.inspected) this.inspect(null);
        else if (this.path.length > 1) this.back();
        else if (this.path.length) this.closeSelection();
      } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) {
        if (this.path.length > 1) {
          e.preventDefault();
          this.back();
        }
      } else if (!this.path.length && this.view === 'timeline' && !target.closest('.mm-panel, .mm-top, .mm-rail')) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const item = this.field.step(1);
          if (item) this.field.focusCover(item.id);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const item = this.field.step(-1);
          if (item) this.field.focusCover(item.id);
        }
      }
    });

    // Delegated actions for the panel and path bar.
    const onAction = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!el || el.tagName === 'TEXTAREA') return;
      this.handleAction(el.dataset.action!, el);
    };
    this.panel.addEventListener('click', onAction);
    this.pathbar.addEventListener('click', onAction);
    this.panel.addEventListener('input', (e) => this.handleInput(e.target as HTMLElement));
    this.panel.addEventListener('focusout', (e) => this.handleCommit(e.target as HTMLElement));

    document.getElementById('search-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = (document.getElementById('search-input') as HTMLInputElement).value.trim();
      const kind = (document.getElementById('search-kind') as HTMLSelectElement).value as spotify.SearchKind;
      this.runSearch(q, kind);
    });
    document.getElementById('search-input')!.addEventListener('input', (e) => {
      if (!(e.target as HTMLInputElement).value && this.search) {
        this.search = null;
        this.renderPanel();
      }
    });

    document.getElementById('wider-toggle')!.addEventListener('change', (e) => {
      this.wider = (e.target as HTMLInputElement).checked;
      this.render();
    });

    document.getElementById('explorer-btn')!.addEventListener('click', () => this.changeExplorer());
    document.getElementById('storage-btn')!.addEventListener('click', () => this.openSettings());
    document.getElementById('dataset-badge')!.addEventListener('click', () => {
      this.showData = true;
      this.renderPanel();
      this.panel.focus();
    });
    document.getElementById('spotify-btn')!.addEventListener('click', () => {
      if (!spotify.spotifyClientId()) return this.openSettings();
      if (!spotify.isConnected()) return void spotify.beginLogin().catch((e: Error) => this.say(e.message));
      this.showData = true;
      this.renderPanel();
      this.panel.focus();
    });
    this.bindSettings();

    new ResizeObserver(() => {
      const r = this.stage.getBoundingClientRect();
      this.field.resize(r.width, r.height);
      this.network.resize(r.width, r.height);
    }).observe(this.stage);
    this.narrow.addEventListener('change', () => this.applyEnvironment());
    this.reducedMotion.addEventListener('change', () => this.applyEnvironment());
    window.addEventListener('beforeunload', () => this.recorder.flush());
  }

  private applyEnvironment(): void {
    this.field.setReducedMotion(this.reducedMotion.matches);
    this.network.setReducedMotion(this.reducedMotion.matches);
    this.field.setFlat(this.narrow.matches);
    document.body.classList.toggle('is-narrow', this.narrow.matches);
  }

  private bindSettings(): void {
    const dialog = document.getElementById('settings-dialog') as HTMLDialogElement;
    const form = document.getElementById('settings-form') as HTMLFormElement;
    document.getElementById('settings-cancel')!.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      const err = document.getElementById('settings-error')!;
      try {
        spotify.saveSpotifyClientId((document.getElementById('spotify-client-id') as HTMLInputElement).value);
        saveFirebaseSettings((document.getElementById('firebase-config') as HTMLTextAreaElement).value);
        this.recorder.flush();
        location.reload();
      } catch (ex) {
        e.preventDefault();
        err.textContent = `Couldn't read the Firebase config: ${(ex as Error).message}`;
      }
    });
  }

  private openSettings(): void {
    const dialog = document.getElementById('settings-dialog') as HTMLDialogElement;
    (document.getElementById('spotify-client-id') as HTMLInputElement).value = spotify.spotifyClientId() ?? '';
    const fb = firebaseSettings();
    (document.getElementById('firebase-config') as HTMLTextAreaElement).value = fb ? JSON.stringify(fb, null, 2) : '';
    document.getElementById('redirect-uri')!.textContent = spotify.redirectUri();
    document.getElementById('settings-error')!.textContent = '';
    dialog.showModal();
  }

  private async changeExplorer(): Promise<void> {
    const name = askExplorer();
    if (!name || name === this.explorer) return;
    this.explorer = name;
    this.recording = true;
    this.recorder.setExplorer(name);
    await this.loadExplorerData();
    this.refreshField();
    this.renderChrome();
    this.render();
  }

  /** First selection asks for a name via prompt(); cancelling explores without recording. */
  private ensureExplorer(): void {
    if (this.explorer || !this.recording) return;
    const name = askExplorer(
      'Your route through the map is recorded as a journey and saved under this name.\nCancel to explore without saving.',
    );
    if (name) {
      this.explorer = name;
      void this.loadExplorerData().then(() => this.renderPanel());
    } else {
      this.recording = false;
    }
    this.renderChrome();
  }

  // ---- Navigation -------------------------------------------------------------

  private get currentId(): string | null {
    return this.path[this.path.length - 1]?.nodeId ?? null;
  }

  private get originId(): string | null {
    return this.path[0]?.nodeId ?? null;
  }

  private setView(view: ViewMode): void {
    if (view === this.view) return;
    this.view = view;
    this.record('view', this.currentId);
    this.say(view === 'timeline' ? 'My timeline: ordered by the date each track was saved.' : 'Music history: recordings ordered by release date.');
    this.render();
  }

  private selectOrigin(id: string, rect?: DOMRect): void {
    this.stopReplay();
    this.ensureExplorer();
    this.path = [{ nodeId: id }];
    this.inspected = null;
    this.expanded.clear();
    this.reflecting = false;
    this.search = null;
    this.showData = false;
    if (this.explorer && this.recording) this.recorder.start(this.explorer, id, this.view);
    else this.recorder.journey = null;
    this.say(`Selected ${nameOf(this.graph, id)}. ${this.neighborsOf(id).length} direct connections.`);
    this.render(rect ? { id, rect } : undefined);
    this.panel.scrollTop = 0;
    if (this.narrow.matches) this.stage.scrollIntoView({ block: 'start' });
  }

  private activateNode(id: string): void {
    if (!this.path.length) return this.selectOrigin(id, this.network.rectOf(id) ?? undefined);
    const i = this.path.findIndex((p) => p.nodeId === id);
    if (i === this.path.length - 1) return;
    if (i >= 0) return this.goBackTo(id);
    if (this.inspected?.id === id) return this.follow(id);
    const direct = this.relsBetween(this.currentId!, id);
    if (direct.length) return this.inspect(id);
    // A wider-web node: inspect the connection it hangs from instead.
    const bridge = this.neighborsOf(this.currentId!).find((n) => this.relsBetween(n.otherId, id).length);
    if (bridge) this.inspect(bridge.otherId);
  }

  private inspect(id: string | null): void {
    if (!id || !this.currentId) {
      this.inspected = null;
    } else {
      this.inspected = { id, relIds: this.relsBetween(this.currentId, id).map((r) => r.id) };
      this.say(`Connection: ${relSentence(this.graph, this.graph.rels.get(this.inspected.relIds[0])!, this.currentId)} Press Enter again or use Follow to move there.`);
    }
    this.render();
    if (id) this.panel.querySelector('.mm-card--connection')?.scrollIntoView({ block: 'nearest' });
  }

  private follow(id: string): void {
    const rels = this.relsBetween(this.currentId!, id);
    if (!rels.length) return;
    this.path.push({ nodeId: id, relId: rels[0].id });
    this.inspected = null;
    this.reflecting = false;
    this.record('follow', id, rels[0].id);
    this.say(`Moved to ${nameOf(this.graph, id)}. Path length ${this.path.length}.`);
    this.render();
    this.panel.scrollTop = 0;
    requestAnimationFrame(() => this.network.focusNode(id));
  }

  private back(): void {
    if (this.path.length < 2) return;
    this.goBackTo(this.path[this.path.length - 2].nodeId);
  }

  private goBackTo(id: string): void {
    const i = this.path.findIndex((p) => p.nodeId === id);
    if (i < 0) return;
    this.path = this.path.slice(0, i + 1);
    this.inspected = null;
    this.record(i === 0 ? 'return' : 'back', id);
    this.say(`Back at ${nameOf(this.graph, id)}.`);
    this.render();
  }

  private returnToOrigin(): void {
    if (!this.originId) return;
    const travelled = this.path.length > 1;
    this.path = this.path.slice(0, 1);
    this.inspected = null;
    this.reflecting = true;
    this.record('return', this.originId);
    this.say(`Returned to ${nameOf(this.graph, this.originId)}. ${travelled ? 'Listen again if you like.' : ''}`);
    this.render();
    requestAnimationFrame(() => this.panel.querySelector<HTMLElement>('#listen')?.scrollIntoView({ block: 'nearest', behavior: this.reducedMotion.matches ? 'auto' : 'smooth' }));
  }

  private closeSelection(): void {
    const origin = this.originId;
    this.recorder.flush();
    this.path = [];
    this.inspected = null;
    this.reflecting = false;
    this.render();
    if (origin && this.view === 'timeline') {
      this.field.highlightId = origin;
      this.field.bringForward(origin, true);
      this.field.focusCover(origin);
      setTimeout(() => {
        this.field.highlightId = null;
        this.field.render();
      }, 2400);
    }
  }

  private record(action: 'follow' | 'back' | 'return' | 'view' | 'listen' | 'reflect', nodeId: string | null, relId?: string, text?: string): void {
    if (!nodeId || this.replay) return;
    this.recorder.record({ action, nodeId, relId, view: this.view, text });
  }

  // ---- Neighbourhood ----------------------------------------------------------

  private visible(id: string): boolean {
    return !this.hidden.has(id) || this.path.some((p) => p.nodeId === id);
  }

  private relsBetween(a: string, b: string): Relationship[] {
    return this.graph
      .neighbors(a)
      .filter((n) => n.otherId === b)
      .map((n) => n.rel);
  }

  /** Distinct neighbouring nodes, most specific relationship first. */
  private neighborsOf(id: string): Neighbor[] {
    const seen = new Set<string>();
    return this.graph.neighbors(id).filter((n) => {
      if (seen.has(n.otherId) || !this.visible(n.otherId)) return false;
      seen.add(n.otherId);
      return true;
    });
  }

  private buildScene(): Scene {
    const current = this.currentId!;
    const nodes = new Map<string, SceneNode>();
    this.path.forEach((p, i) =>
      nodes.set(p.nodeId, { id: p.nodeId, role: i === 0 ? 'origin' : p.nodeId === current ? 'current' : 'path' }),
    );
    const all = this.neighborsOf(current);
    const shown = this.expanded.has(current) ? all : all.slice(0, NEIGHBOR_LIMIT);
    if (this.inspected && !shown.some((n) => n.otherId === this.inspected!.id)) {
      const extra = all.find((n) => n.otherId === this.inspected!.id);
      if (extra) shown.push(extra);
    }
    shown.forEach((n) => nodes.has(n.otherId) || nodes.set(n.otherId, { id: n.otherId, role: 'neighbor' }));

    if (this.wider) {
      let count = 0;
      for (const n of shown) {
        for (const m of this.neighborsOf(n.otherId)) {
          if (count >= WIDER_LIMIT) break;
          if (nodes.has(m.otherId)) continue;
          nodes.set(m.otherId, { id: m.otherId, role: 'wider' });
          count++;
        }
      }
    }

    // One edge per connected pair; several relationships share a combined label.
    const pathRels = new Set(this.path.map((p) => p.relId).filter(Boolean));
    const pairs = new Map<string, Relationship[]>();
    nodes.forEach((_, id) => {
      for (const n of this.graph.neighbors(id)) {
        if (!nodes.has(n.otherId)) continue;
        const key = [id, n.otherId].sort().join('|');
        const list = pairs.get(key) ?? [];
        if (!list.includes(n.rel)) list.push(n.rel);
        pairs.set(key, list);
      }
    });
    const edges: SceneEdge[] = [];
    pairs.forEach((rels) => {
      rels.sort((a, b) => relRank(a) - relRank(b));
      const rel = rels.find((r) => pathRels.has(r.id)) ?? rels[0];
      const ends = [rel.from, rel.to];
      const roles = ends.map((e) => nodes.get(e)!.role);
      const emphasis = pathRels.has(rel.id)
        ? 'path'
        : roles.includes('wider')
          ? 'wider'
          : ends.includes(current)
            ? 'focus'
            : 'faint';
      const labels = [...new Set(rels.map((r) => (r.type === 'credit' ? r.role : r.type === 'member_of' ? 'member of' : r.type === 'collaboration' ? r.role : r.type)))];
      edges.push({ rel, emphasis, label: labels.join(' · ') });
    });

    return {
      mode: this.view,
      nodes: [...nodes.values()],
      edges,
      path: this.path.map((p) => p.nodeId),
      inspectedId: this.inspected?.id ?? null,
      inspectedRelId: this.inspected?.relIds[0] ?? null,
    };
  }

  private overviewScene(): Scene {
    return {
      mode: 'history',
      nodes: this.graph.savedTracks(this.hidden).map(({ track }) => ({ id: track.id, role: 'overview' as const })),
      edges: [],
      path: [],
      inspectedId: null,
      inspectedRelId: null,
    };
  }

  // ---- Rendering --------------------------------------------------------------

  private render(spawn?: { id: string; rect: DOMRect }): void {
    const selected = this.path.length > 0;
    this.stage.dataset.view = this.view;
    this.stage.classList.toggle('has-selection', selected);
    document.querySelectorAll<HTMLButtonElement>('.mm-view').forEach((b) => {
      const on = b.dataset.view === this.view;
      b.setAttribute('aria-checked', `${on}`);
      b.tabIndex = on ? 0 : -1;
    });

    if (selected) {
      this.network.show(this.buildScene(), spawn);
    } else if (this.view === 'history') {
      this.network.show(this.overviewScene());
    } else {
      this.network.clear();
      this.field.render();
    }
    (document.getElementById('stage-tools') as HTMLElement).hidden = !selected;
    this.renderStageNote();
    this.renderPathbar();
    this.renderPanel();
    if (selected) this.recorder.update({ scene: describeScene(this.graph, this.path, this.view) });
  }

  private renderStageNote(): void {
    const cur = this.currentId;
    let text: string;
    if (!cur) {
      text =
        this.view === 'timeline'
          ? this.narrow.matches
            ? 'Your saved tracks, newest first. Select one to open its connections.'
            : 'Scroll, drag or use the arrow keys to move through the dates you saved tracks. Covers come closer as you reach the date they were saved. Select one to open its connections.'
          : 'Your saved tracks placed by release date: the same songs as My timeline, on a different clock. Select one to see its connections.';
    } else {
      const total = this.neighborsOf(cur).length;
      const shown = this.expanded.has(cur) ? total : Math.min(total, NEIGHBOR_LIMIT);
      text = `${shown} of ${total} direct connection${total === 1 ? '' : 's'} of ${nameOf(this.graph, cur)}. Select a node to read the connection, then select it again to follow.`;
      if (this.view === 'history') text += ' Recordings are placed by release date; people are not given dates.';
    }
    this.note.textContent = text;
  }

  private renderPathbar(): void {
    if (!this.path.length) {
      this.pathbar.hidden = true;
      return;
    }
    this.pathbar.hidden = false;
    const crumbs = this.path
      .map((p, i) => {
        const rel = p.relId ? this.graph.rels.get(p.relId) : undefined;
        const label = rel ? (rel.type === 'credit' ? rel.role : rel.type === 'member_of' ? 'member of' : rel.type) : '';
        const isCur = i === this.path.length - 1;
        return `<li>${label ? `<span class="mm-crumb__rel">${h(label ?? '')} →</span>` : ''}<button type="button" class="mm-crumb ${i === 0 ? 'is-origin' : ''}" data-action="goto" data-id="${h(p.nodeId)}" ${isCur ? 'aria-current="step"' : ''}>${h(nameOf(this.graph, p.nodeId))}</button></li>`;
      })
      .join('');
    const origin = this.originId!;
    this.pathbar.innerHTML = `
      <div class="mm-pathbar__actions">
        <button type="button" class="mm-btn mm-btn--small" data-action="back" ${this.path.length < 2 ? 'disabled' : ''} aria-label="Back one step">← Back</button>
        <button type="button" class="mm-btn mm-btn--small mm-btn--accent" data-action="return">Return to “${h(nameOf(this.graph, origin))}”${this.graph.tracks.has(origin) ? ' &amp; listen' : ''}</button>
        <button type="button" class="mm-btn mm-btn--small" data-action="close" aria-label="Close map and return to the timeline">✕ Close</button>
      </div>
      <ol class="mm-crumbs" aria-label="Path you followed">${crumbs}</ol>`;
  }

  private renderChrome(): void {
    const badge = document.getElementById('dataset-badge')!;
    const demo = this.datasetKind === 'demo';
    badge.textContent = demo ? 'Fictional demo data' : 'Your Spotify library';
    badge.classList.toggle('is-demo', demo);
    badge.title = demo ? 'Invented tracks, people and saved dates. Not your listening history.' : 'Saved tracks and dates imported from Spotify.';

    document.getElementById('explorer-btn')!.innerHTML = this.explorer
      ? `Exploring as <strong>${h(this.explorer)}</strong>`
      : this.recording
        ? 'Set your name'
        : 'Not recording · set name';
    const storage = document.getElementById('storage-btn')!;
    storage.innerHTML = this.storeError
      ? 'Firebase unavailable · saving in this browser'
      : `Saving to <strong>${h(this.store.label)}</strong>`;
    storage.classList.toggle('is-warning', !!this.storeError);
    const sp = document.getElementById('spotify-btn')!;
    sp.textContent = !spotify.spotifyClientId() ? 'Set up Spotify' : spotify.isConnected() ? 'Spotify connected' : 'Connect Spotify';
  }

  private renderSaveStatus(): void {
    const el = this.panel.querySelector('#save-status');
    if (el) el.innerHTML = this.saveStatusText();
  }

  private saveStatusText(): string {
    if (!this.explorer || !this.recording) return 'Not recording. Set a name to save this journey.';
    const s = this.saveStatus;
    const where = this.store.kind === 'firebase' ? 'Firebase' : 'this browser';
    if (s.state === 'saving') return `Saving to ${where}…`;
    if (s.state === 'saved') return `Saved to ${where} at ${s.at!.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    if (s.state === 'error') return `Couldn't save: ${h(s.message ?? 'unknown error')}`;
    return `Recording as ${h(this.explorer)}`;
  }

  // ---- Panel ------------------------------------------------------------------

  private renderPanel(): void {
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && this.panel.contains(active) ? active.dataset.focusKey : undefined;
    let html = '';
    if (this.flash) html += `<p class="mm-flash" role="status">${h(this.flash)} <button type="button" class="mm-link" data-action="dismiss-flash">Dismiss</button></p>`;
    if (this.replay) html += this.replayCard();
    if (this.search) html += this.searchSection();
    if (this.showData) html += this.dataSection();
    if (!this.path.length) {
      html += this.introSection();
    } else {
      html += this.anchorCard();
      if (this.inspected) html += this.connectionCard();
      html += this.originExtras();
      if (this.currentId !== this.originId) html += this.currentCard();
      html += this.connectionsList();
      html += this.journeyCard();
    }
    html += this.journeysSection();
    this.panel.innerHTML = html;
    if (focusKey) this.panel.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
  }

  private dateFields(t: Track, compact = false): string {
    const saved = this.graph.savedAt(t.id);
    const pn = precisionNote(t.release);
    return `
      <dl class="mm-fields ${compact ? 'mm-fields--compact' : ''}">
        <div><dt>Title</dt><dd>${h(t.title)}</dd></div>
        <div><dt>Artist</dt><dd>${h(t.artistCredit)}</dd></div>
        <div class="mm-field--release"><dt>Released</dt><dd>${formatPartialDate(t.release)}${pn ? ` <span class="mm-muted">(${h(pn)})</span>` : ''}</dd></div>
        <div class="mm-field--saved"><dt>Saved</dt><dd>${saved ? formatSaved(saved, true) : '<span class="mm-outside">Outside your collection</span>'}</dd></div>
      </dl>`;
  }

  private anchorCard(): string {
    const origin = this.graph.node(this.originId!)!;
    const isTrack = origin.kind === 'track';
    let body: string;
    if (isTrack) {
      body = `
        <div class="mm-anchor">
          <img class="mm-anchor__cover" src="${coverUrl(origin.cover, origin.title)}" alt="Cover of ${h(origin.title)}" />
          ${this.dateFields(origin)}
        </div>
        ${origin.releaseNote ? `<p class="mm-muted mm-small">${h(origin.releaseNote)}</p>` : ''}
        ${this.demoNotice(origin)}`;
    } else {
      body = this.personBody(origin);
    }
    return `<section class="mm-card mm-card--anchor" aria-labelledby="anchor-h">
      <h2 id="anchor-h" class="mm-eyebrow">Starting ${isTrack ? 'track' : 'point'}</h2>${body}</section>`;
  }

  /** Listening, notes and lookups for the starting track, below any open connection. */
  private originExtras(): string {
    const origin = this.graph.tracks.get(this.originId!);
    if (!origin) return '';
    const atOrigin = this.path.length === 1;
    return `<section class="mm-card" aria-label="Listen and note">
      ${atOrigin ? this.listenSection(origin) : `<button type="button" class="mm-btn mm-btn--accent" data-action="return">Return to “${h(origin.title)}” &amp; listen again</button>`}
      ${atOrigin ? this.noteSection(origin) : ''}
      ${atOrigin ? this.mbSection(origin) : ''}
      <button type="button" class="mm-link mm-small" data-action="hide" data-id="${h(origin.id)}">Hide this track from the map</button>
      <p class="mm-muted mm-small">Hiding only affects this map. It does not change your Spotify library.</p>
    </section>`;
  }

  private demoNotice(t: Track): string {
    if (t.origin !== 'demo') return '';
    return `<p class="mm-notice">Fictional demo track. Its saved date is invented and is not your history.</p>`;
  }

  private personBody(p: Node): string {
    if (p.kind === 'track') return '';
    const works = this.graph.neighbors(p.id).filter((n) => n.rel.type === 'credit').length;
    return `
      <div class="mm-person">
        <span class="mm-person__mark mm-person__mark--${p.kind}" aria-hidden="true">${h(p.name.replace(/^The\s+/i, '').slice(0, 1))}</span>
        <div>
          <p class="mm-person__name">${h(p.name)}</p>
          <p class="mm-muted">${p.kind === 'group' ? 'Group' : 'Person'}${p.description ? ` · ${h(p.description)}` : ''}</p>
          <p class="mm-muted mm-small">Credited on ${works} work${works === 1 ? '' : 's'} in this map. People are connected to credited works; they have no release date.</p>
          ${p.spotify ? `<a class="mm-link" href="${h(p.spotify.url)}" target="_blank" rel="noopener">Open on Spotify ↗</a>` : ''}
          ${p.musicbrainzId ? `<a class="mm-link" href="https://musicbrainz.org/artist/${h(p.musicbrainzId)}" target="_blank" rel="noopener">MusicBrainz ↗</a>` : ''}
        </div>
      </div>`;
  }

  private listenSection(t: Track): string {
    let player: string;
    if (t.spotify) {
      player = this.playerLoaded.has(t.id)
        ? `<iframe class="mm-player" title="Spotify player: ${h(t.title)}" src="https://open.spotify.com/embed/track/${h(t.spotify.id)}" height="152" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`
        : `<button type="button" class="mm-btn mm-btn--primary" data-action="load-player" data-id="${h(t.id)}">▶ Load Spotify player</button>
           <p class="mm-muted mm-small">Loads Spotify's embedded player. Full tracks play if you're logged in to Spotify in this browser; otherwise Spotify may offer a preview.</p>`;
      player += ` <a class="mm-link" href="${h(t.spotify.url)}" target="_blank" rel="noopener">Open in Spotify ↗</a>`;
    } else if (t.origin === 'demo') {
      player = `<p class="mm-muted">No audio: this is a fictional demo track, and nothing is played in its place.</p>`;
    } else {
      const q = encodeURIComponent(`${t.title} ${t.artistCredit}`);
      player = `<p class="mm-muted">No authorized audio is available here.</p>
        <a class="mm-link" href="https://open.spotify.com/search/${q}" target="_blank" rel="noopener">Look for it on Spotify ↗</a>
        ${t.musicbrainzId ? `<a class="mm-link" href="https://musicbrainz.org/recording/${h(t.musicbrainzId)}" target="_blank" rel="noopener">MusicBrainz ↗</a>` : ''}`;
    }
    const reflection = this.reflecting
      ? `<div class="mm-reflect">
          <label for="reflection">What do you notice now? <span class="mm-muted">(optional)</span></label>
          <textarea id="reflection" data-focus-key="reflection" data-input="reflection" rows="3" placeholder="Nothing has to have changed.">${h(this.recorder.journey?.reflection ?? '')}</textarea>
          <p class="mm-muted mm-small">Saved with this journey. It isn't scored or analysed.</p>
        </div>`
      : '';
    return `<div class="mm-listen" id="listen"><h3 class="mm-subhead">${this.reflecting ? 'Listen again' : 'Listen'}</h3>${player}${reflection}</div>`;
  }

  private noteSection(t: Track): string {
    if (!this.explorer) {
      return `<p class="mm-muted mm-small">Set a name to keep a personal note on this track. <button type="button" class="mm-link" data-action="explorer">Set name</button></p>`;
    }
    return `<div class="mm-note">
      <label for="note">What this track means to you now <span class="mm-muted">(optional, only you write this)</span></label>
      <textarea id="note" rows="2" data-focus-key="note" data-input="note" data-id="${h(t.id)}">${h(this.notes[t.id] ?? '')}</textarea>
    </div>`;
  }

  private mbSection(t: Track): string {
    if (!t.spotify) return '';
    const status = this.mbStatus.get(t.id);
    return `<div class="mm-mb">
      <button type="button" class="mm-btn mm-btn--small" data-action="musicbrainz" data-id="${h(t.id)}" ${status === 'loading' ? 'disabled' : ''}>
        ${status === 'loading' ? 'Looking up MusicBrainz…' : 'Find documented credits & samples (MusicBrainz)'}</button>
      ${status && status !== 'loading' ? `<p class="mm-muted mm-small" role="status">${h(status)}</p>` : '<p class="mm-muted mm-small">Spotify doesn\'t provide samples or detailed credits. MusicBrainz is a community-edited source; nothing is inferred.</p>'}
    </div>`;
  }

  private connectionCard(): string {
    const cur = this.currentId!;
    const other = this.graph.node(this.inspected!.id);
    if (!other) return '';
    const rels = this.inspected!.relIds.map((id) => this.graph.rels.get(id)!).filter(Boolean);
    const miniNode = (n: Node) =>
      n.kind === 'track'
        ? `<span class="mm-mini"><img src="${coverUrl(n.cover, n.title)}" alt="" /><span>${h(n.title)}</span></span>`
        : `<span class="mm-mini mm-mini--person"><span class="mm-mini__dot">${h(n.name.slice(0, 1))}</span><span>${h(n.name)}</span></span>`;
    const items = rels
      .map((r) => {
        const e = r.evidence;
        const status = e.status === 'documented' ? 'Documented' : e.status === 'disputed' ? 'Disputed' : 'Unconfirmed';
        return `<li class="mm-rel">
          <div class="mm-rel__diagram" aria-hidden="true">${miniNode(this.graph.node(r.from)!)}<span class="mm-rel__arrow mm-rel__arrow--${r.type}">${h(r.type === 'credit' ? r.role ?? '' : r.type.replace('_', ' '))} →</span>${miniNode(this.graph.node(r.to)!)}</div>
          <p class="mm-rel__sentence">${h(relSentence(this.graph, r, cur))}</p>
          <p>${h(e.explanation)}</p>
          <dl class="mm-evidence">
            <div><dt>Evidence</dt><dd><span class="mm-status mm-status--${e.status}">${status}</span></dd></div>
            <div><dt>Source</dt><dd>${e.sourceUrl ? `<a href="${h(e.sourceUrl)}" target="_blank" rel="noopener">${h(e.sourceLabel)} ↗</a>` : h(e.sourceLabel)}${e.fictional ? ' <span class="mm-muted">(fictional — not a real reference)</span>' : ''}</dd></div>
          </dl>
          ${e.caveat ? `<p class="mm-caveat">${h(e.caveat)}</p>` : ''}
        </li>`;
      })
      .join('');
    const name = other.kind === 'track' ? other.title : other.name;
    return `<section class="mm-card mm-card--connection" aria-labelledby="conn-h">
      <h2 id="conn-h" class="mm-eyebrow">Connection</h2>
      <ul class="mm-rels">${items}</ul>
      <div class="mm-actions">
        <button type="button" class="mm-btn mm-btn--primary" data-action="follow" data-id="${h(other.id)}" data-focus-key="follow">Follow to ${h(name)} →</button>
        <button type="button" class="mm-btn" data-action="uninspect">Close</button>
      </div>
    </section>`;
  }

  private currentCard(): string {
    const n = this.graph.node(this.currentId!)!;
    const via = this.path[this.path.length - 1].relId;
    const rel = via ? this.graph.rels.get(via) : undefined;
    const body =
      n.kind === 'track'
        ? `<div class="mm-anchor mm-anchor--small">
            <img class="mm-anchor__cover" src="${coverUrl(n.cover, n.title)}" alt="Cover of ${h(n.title)}" />
            ${this.dateFields(n, true)}
          </div>${n.releaseNote ? `<p class="mm-muted mm-small">${h(n.releaseNote)}</p>` : ''}${this.mbSection(n)}`
        : this.personBody(n);
    return `<section class="mm-card" aria-labelledby="cur-h">
      <h2 id="cur-h" class="mm-eyebrow">You are here</h2>
      ${rel ? `<p class="mm-muted mm-small">Reached via: ${h(relSentence(this.graph, rel))}</p>` : ''}
      ${body}
    </section>`;
  }

  private connectionsList(): string {
    const cur = this.currentId!;
    const node = this.graph.node(cur)!;
    const all = this.neighborsOf(cur);
    const shownIds = new Set((this.expanded.has(cur) ? all : all.slice(0, NEIGHBOR_LIMIT)).map((n) => n.otherId));
    const groups = new Map<string, string[]>();
    for (const n of this.graph.neighbors(cur)) {
      if (!this.visible(n.otherId)) continue;
      const label = groupLabel(n);
      const other = this.graph.node(n.otherId)!;
      const name = other.kind === 'track' ? other.title : other.name;
      const extra =
        other.kind === 'track'
          ? `${h(other.artistCredit)} · ${formatPartialDate(other.release)}${this.graph.inCollection(other.id) ? '' : ' · outside your collection'}`
          : other.kind;
      const flag = n.rel.evidence.status !== 'documented' ? ` <span class="mm-status mm-status--${n.rel.evidence.status}">${n.rel.evidence.status === 'disputed' ? 'disputed' : 'unconfirmed'}</span>` : '';
      const onMap = shownIds.has(n.otherId) || this.path.some((p) => p.nodeId === n.otherId);
      const item = `<li><button type="button" class="mm-listitem ${this.inspected?.id === n.otherId ? 'is-active' : ''}" data-action="inspect" data-id="${h(n.otherId)}" data-focus-key="n-${h(n.otherId)}-${h(n.rel.id)}">
        <span class="mm-listitem__phrase">${h(neighborPhrase(n))}</span>
        <span class="mm-listitem__name">${h(name)}${flag}</span>
        <span class="mm-listitem__meta">${extra}${onMap ? '' : ' · not drawn yet'}</span></button></li>`;
      groups.set(label, [...(groups.get(label) ?? []), item]);
    }
    const hiddenCount = all.length - shownIds.size;
    const undocumented =
      node.kind === 'track' && node.undocumented?.length
        ? `<p class="mm-caveat">Not documented in the source: ${node.undocumented.map(h).join(', ')}.</p>`
        : '';
    return `<section class="mm-card" aria-labelledby="list-h">
      <h2 id="list-h" class="mm-eyebrow">Connections of ${h(nameOf(this.graph, cur))}</h2>
      ${undocumented}
      ${groups.size ? [...groups].map(([label, items]) => `<h3 class="mm-subhead">${h(label)}</h3><ul class="mm-list">${items.join('')}</ul>`).join('') : '<p class="mm-muted">No documented connections in this dataset.</p>'}
      ${hiddenCount > 0 ? `<button type="button" class="mm-btn mm-btn--small" data-action="expand">Draw all ${all.length} connections</button>` : ''}
    </section>`;
  }

  private journeyCard(): string {
    const j = this.recorder.journey;
    return `<section class="mm-card" aria-labelledby="journey-h">
      <h2 id="journey-h" class="mm-eyebrow">This journey</h2>
      <p class="mm-save" id="save-status" role="status">${this.saveStatusText()}</p>
      <p class="mm-scene">${h(describeScene(this.graph, this.path, this.view))}</p>
      ${
        j
          ? `<label for="scene-desc">Describe this scene in your words <span class="mm-muted">(optional)</span></label>
             <textarea id="scene-desc" rows="2" data-focus-key="scene-desc" data-input="description">${h(j.description ?? '')}</textarea>
             <p class="mm-muted mm-small">${j.steps.length} step${j.steps.length === 1 ? '' : 's'} recorded.${this.store.shared ? ' Journeys in this shared database are visible to other explorers.' : ''}</p>`
          : ''
      }
    </section>`;
  }

  private introSection(): string {
    const demo = this.datasetKind === 'demo';
    return `<section class="mm-card mm-card--intro">
      <h2 class="mm-title">A song has a history before it becomes part of yours.</h2>
      <p>Move through the tracks ${demo ? 'in this demo collection' : 'you saved'} by the date each was saved, then open one to see the recordings, samples, interpolations and people connected to it. Your route is one way through a much larger web.</p>
      ${demo ? `<p class="mm-notice">You're looking at <strong>fictional demo data</strong>: invented tracks, people and saved dates. It isn't anyone's real listening history.</p>` : ''}
      <h3 class="mm-subhead">Two clocks</h3>
      <dl class="mm-legend">
        <div><dt><span class="mm-swatch mm-swatch--saved"></span>Saved</dt><dd>When a track was added to the collection. It doesn't tell us when it was first heard, how often, or why.</dd></div>
        <div><dt><span class="mm-swatch mm-swatch--release"></span>Released</dt><dd>When the recording came out. Unknown dates stay unknown, and year-only dates are marked.</dd></div>
      </dl>
      <h3 class="mm-subhead">Reading the map</h3>
      <ul class="mm-keylist">
        <li><span class="mm-key mm-key--track"></span>Square: a recording</li>
        <li><span class="mm-key mm-key--person"></span>Circle: a person</li>
        <li><span class="mm-key mm-key--group"></span>Double circle: a group</li>
        <li><span class="mm-key mm-key--outside"></span>Dashed frame: outside your collection</li>
        <li><span class="mm-line mm-line--samples"></span>Samples: uses the original recording</li>
        <li><span class="mm-line mm-line--interpolates"></span>Interpolates: re-performs the composition</li>
        <li><span class="mm-line mm-line--credit"></span>Credit: a person's role on a work</li>
        <li><span class="mm-line mm-line--member"></span>Membership or shared credits</li>
        <li><span class="mm-line mm-line--path"></span>Your path</li>
      </ul>
      <p class="mm-muted mm-small">Shared credits are shown only as shared credits. The map doesn't infer friendship, mentorship or influence.</p>
    </section>`;
  }

  private dataSection(): string {
    const hasLib = !!localStorage.getItem(LIBRARY_KEY);
    const connected = spotify.isConnected();
    return `<section class="mm-card" aria-labelledby="data-h">
      <div class="mm-card__head"><h2 id="data-h" class="mm-eyebrow">Data &amp; connections</h2><button type="button" class="mm-link" data-action="close-data">Close</button></div>
      <p>Showing: <strong>${this.datasetKind === 'demo' ? 'Fictional demo data' : 'Your Spotify saved tracks'}</strong></p>
      <div class="mm-actions">
        ${this.datasetKind === 'spotify' ? '<button type="button" class="mm-btn" data-action="use-demo">Use demo data</button>' : ''}
        ${hasLib && this.datasetKind === 'demo' ? '<button type="button" class="mm-btn" data-action="use-library">Use my Spotify library</button>' : ''}
        ${connected ? `<button type="button" class="mm-btn" data-action="import">${hasLib ? 'Re-import' : 'Import'} saved tracks</button>` : ''}
        ${spotify.spotifyClientId() && !connected ? '<button type="button" class="mm-btn mm-btn--primary" data-action="connect">Connect Spotify</button>' : ''}
        ${connected ? '<button type="button" class="mm-btn" data-action="disconnect">Disconnect Spotify</button>' : ''}
        <button type="button" class="mm-btn" data-action="settings">Keys &amp; database…</button>
      </div>
      ${this.importStatus ? `<p class="mm-muted" role="status">${h(this.importStatus)}</p>` : ''}
      <p class="mm-muted mm-small">Spotify supplies saved dates, album release dates, artists and cover art. It doesn't supply samples, interpolations or detailed credits, so imported tracks start with artist links only. Use the MusicBrainz lookup on a track for documented relationships.</p>
    </section>`;
  }

  private searchSection(): string {
    const s = this.search!;
    const q = s.query.toLowerCase();
    const match = (str: string) => str.toLowerCase().includes(q);
    const tracks = s.kind === 'all' || s.kind === 'track' || s.kind === 'album' ? [...this.graph.tracks.values()].filter((t) => match(t.title) || match(t.artistCredit)) : [];
    const people = s.kind === 'all' || s.kind === 'artist' ? [...this.graph.people.values()].filter((p) => match(p.name)) : [];
    const genreTracks = s.kind === 'all' || s.kind === 'genre' ? [...this.graph.tracks.values()].filter((t) => t.genres.some(match)) : [];
    const trackBtn = (t: Track) => `<li><button type="button" class="mm-result" data-action="select" data-id="${h(t.id)}">
        <img src="${coverUrl(t.cover, t.title)}" alt="" /><span><strong>${h(t.title)}</strong><span class="mm-muted">${h(t.artistCredit)} · ${formatPartialDate(t.release)}${this.graph.inCollection(t.id) ? ` · saved ${formatSaved(this.graph.savedAt(t.id))}` : ' · outside your collection'}</span></span></button></li>`;
    let local = '';
    if (tracks.length) local += `<h3 class="mm-subhead">Tracks</h3><ul class="mm-list">${tracks.slice(0, 12).map(trackBtn).join('')}</ul>`;
    if (people.length)
      local += `<h3 class="mm-subhead">People &amp; groups</h3><ul class="mm-list">${people
        .slice(0, 12)
        .map((p) => `<li><button type="button" class="mm-result" data-action="select" data-id="${h(p.id)}"><span class="mm-mini__dot">${h(p.name.slice(0, 1))}</span><span><strong>${h(p.name)}</strong><span class="mm-muted">${p.kind}</span></span></button></li>`)
        .join('')}</ul>`;
    if (genreTracks.length && s.kind !== 'track') {
      const genres = [...new Set(genreTracks.flatMap((t) => t.genres.filter(match)))];
      local += `<h3 class="mm-subhead">Genre: ${genres.map(h).join(', ')}</h3><ul class="mm-list">${genreTracks.slice(0, 12).map(trackBtn).join('')}</ul>`;
    }
    if (!local) local = `<p class="mm-muted">Nothing in this map matches “${h(s.query)}”.</p>`;

    let remote = '';
    if (!spotify.isConnected()) {
      remote = `<p class="mm-muted mm-small">Connect Spotify to also search its catalog.</p>`;
    } else if (s.loading) {
      remote = `<p class="mm-muted" role="status">Searching Spotify…</p>`;
    } else if (s.error) {
      remote = `<p class="mm-error">${h(s.error)}</p>`;
    } else if (s.drill) {
      const d = s.drill;
      remote = `<div class="mm-card__head"><h3 class="mm-subhead">${h(d.title)}</h3><button type="button" class="mm-link" data-action="drill-close">← Results</button></div>`;
      if (d.loading) remote += `<p class="mm-muted" role="status">Loading…</p>`;
      else if (d.error) remote += `<p class="mm-error">${h(d.error)}</p>`;
      else if (d.albums)
        remote += `<ul class="mm-list">${d.albums.map((a) => `<li><button type="button" class="mm-result" data-action="sp-album" data-id="${h(a.id)}" data-name="${h(a.name)}">${a.image ? `<img src="${h(a.image)}" alt="" />` : ''}<span><strong>${h(a.name)}</strong><span class="mm-muted">${formatPartialDate(a.release)}</span></span></button></li>`).join('')}</ul>`;
      else if (d.tracks)
        remote += `<ul class="mm-list">${d.tracks.map((p, i) => `<li><button type="button" class="mm-result" data-action="sp-track" data-index="${i}" data-src="drill"><span><strong>${h(p.tracks![0].title)}</strong><span class="mm-muted">${h(p.tracks![0].artistCredit)}</span></span></button></li>`).join('')}</ul>`;
    } else if (s.spotify) {
      const r = s.spotify;
      if (r.tracks.length)
        remote += `<h3 class="mm-subhead">Tracks</h3><ul class="mm-list">${r.tracks.map((p, i) => {
          const t = p.tracks![0];
          return `<li><button type="button" class="mm-result" data-action="sp-track" data-index="${i}"><img src="${coverUrl(t.cover, t.title)}" alt="" /><span><strong>${h(t.title)}</strong><span class="mm-muted">${h(t.artistCredit)} · ${formatPartialDate(t.release)}</span></span></button></li>`;
        }).join('')}</ul>`;
      if (r.artists.length)
        remote += `<h3 class="mm-subhead">Artists</h3><ul class="mm-list">${r.artists.map((a) => `<li><button type="button" class="mm-result" data-action="sp-artist" data-id="${h(a.id)}" data-name="${h(a.name)}">${a.image ? `<img class="is-round" src="${h(a.image)}" alt="" />` : '<span class="mm-mini__dot"></span>'}<span><strong>${h(a.name)}</strong><span class="mm-muted">${h(a.genres.slice(0, 3).join(', ') || 'Artist')}</span></span></button></li>`).join('')}</ul>`;
      if (r.albums.length)
        remote += `<h3 class="mm-subhead">Albums</h3><ul class="mm-list">${r.albums.map((a) => `<li><button type="button" class="mm-result" data-action="sp-album" data-id="${h(a.id)}" data-name="${h(a.name)}">${a.image ? `<img src="${h(a.image)}" alt="" />` : ''}<span><strong>${h(a.name)}</strong><span class="mm-muted">${h(a.artist)} · ${formatPartialDate(a.release)}</span></span></button></li>`).join('')}</ul>`;
      if (!remote) remote = `<p class="mm-muted">No Spotify results.</p>`;
    }

    return `<section class="mm-card" aria-labelledby="search-h">
      <div class="mm-card__head"><h2 id="search-h" class="mm-eyebrow">Search: “${h(s.query)}”</h2><button type="button" class="mm-link" data-action="clear-search">Clear</button></div>
      <h3 class="mm-subhead mm-subhead--group">In this map</h3>${local}
      <h3 class="mm-subhead mm-subhead--group">On Spotify</h3>${remote}
      <p class="mm-muted mm-small">Tracks you open from search appear as “Outside your collection” unless you saved them.</p>
    </section>`;
  }

  private journeysSection(): string {
    if (!this.journeys.length) {
      return `<section class="mm-card" aria-labelledby="journeys-h"><h2 id="journeys-h" class="mm-eyebrow">Journeys</h2>
        <p class="mm-muted">Each route you take is recorded as a sequence of steps${this.explorer ? '' : ' once you set a name'}. Saved journeys appear here${this.store.shared ? ', along with other explorers\'' : ''}.</p></section>`;
    }
    const mine = this.journeys.filter((j) => j.explorer === this.explorer);
    const others = this.journeys.filter((j) => j.explorer !== this.explorer);
    const item = (j: Journey) => {
      const { path } = pathAfter(j.steps);
      const names = path.map((p) => j.nodes[p.nodeId]?.name ?? '?');
      const originName = j.nodes[j.originId]?.name ?? 'Unknown';
      const playable = j.steps.every((s) => this.graph.node(s.nodeId));
      const current = this.recorder.journey?.id === j.id;
      return `<li class="mm-journey ${current ? 'is-current' : ''}">
        <p class="mm-journey__title"><strong>${h(originName)}</strong> <span class="mm-muted">· ${h(j.explorer)} · ${formatSaved(j.updatedAt, true)}</span></p>
        <p class="mm-journey__route">${j.steps.length} steps${names.length > 1 ? ` · ended at ${h(names.join(' → '))}` : ''}</p>
        ${j.description ? `<p class="mm-journey__quote">“${h(j.description)}”</p>` : ''}
        ${j.reflection ? `<p class="mm-journey__quote"><span class="mm-muted">Noticed:</span> “${h(j.reflection)}”</p>` : ''}
        <div class="mm-actions">
          ${playable ? `<button type="button" class="mm-btn mm-btn--small" data-action="replay" data-id="${h(j.id)}">Replay</button>` : `<span class="mm-muted mm-small">Uses tracks from another library; route shown as text only.</span>`}
          ${j.explorer === this.explorer && !current ? `<button type="button" class="mm-link mm-small" data-action="delete-journey" data-id="${h(j.id)}">Delete</button>` : ''}
        </div>
      </li>`;
    };
    return `<section class="mm-card" aria-labelledby="journeys-h">
      <h2 id="journeys-h" class="mm-eyebrow">Journeys</h2>
      ${mine.length ? `<h3 class="mm-subhead">Yours</h3><ul class="mm-journeys">${mine.slice(0, 8).map(item).join('')}</ul>` : ''}
      ${others.length ? `<details ${mine.length ? '' : 'open'}><summary class="mm-subhead">Other explorers (${others.length})</summary><ul class="mm-journeys">${others.slice(0, 20).map(item).join('')}</ul></details>` : ''}
    </section>`;
  }

  private replayCard(): string {
    const r = this.replay!;
    return `<section class="mm-card mm-card--replay" role="status">
      <p><strong>Replaying ${h(r.journey.explorer)}'s journey</strong> · step ${Math.min(r.index, r.journey.steps.length)} of ${r.journey.steps.length}</p>
      <button type="button" class="mm-btn mm-btn--small" data-action="stop-replay">Stop</button>
    </section>`;
  }

  // ---- Panel actions ----------------------------------------------------------

  private handleAction(action: string, el: HTMLElement): void {
    const id = el.dataset.id ?? '';
    switch (action) {
      case 'inspect':
        return this.activateNode(id);
      case 'uninspect':
        return this.inspect(null);
      case 'follow':
        return this.follow(id);
      case 'goto':
        return this.activateNode(id);
      case 'back':
        return this.back();
      case 'return':
        return this.returnToOrigin();
      case 'close':
        return this.closeSelection();
      case 'expand':
        this.expanded.add(this.currentId!);
        return this.render();
      case 'select':
        return this.selectOrigin(id);
      case 'load-player':
        this.playerLoaded.add(id);
        this.record('listen', id);
        return this.renderPanel();
      case 'hide':
        return this.hideTrack(id);
      case 'explorer':
        return void this.changeExplorer();
      case 'musicbrainz':
        return void this.lookupMusicBrainz(id);
      case 'dismiss-flash':
        this.flash = '';
        return this.renderPanel();
      case 'close-data':
        this.showData = false;
        return this.renderPanel();
      case 'use-demo':
        return this.useDataset('demo');
      case 'use-library':
        return this.useDataset('spotify');
      case 'import':
        return void this.importLibrary();
      case 'connect':
        return void spotify.beginLogin().catch((e: Error) => this.say(e.message));
      case 'disconnect':
        spotify.disconnect();
        this.renderChrome();
        return this.renderPanel();
      case 'settings':
        return this.openSettings();
      case 'clear-search':
        this.search = null;
        (document.getElementById('search-input') as HTMLInputElement).value = '';
        return this.renderPanel();
      case 'sp-track': {
        const list = el.dataset.src === 'drill' ? this.search?.drill?.tracks : this.search?.spotify?.tracks;
        const part = list?.[Number(el.dataset.index)];
        if (!part) return;
        this.addData(part);
        return this.selectOrigin(part.tracks![0].id);
      }
      case 'sp-artist':
        return void this.drill(`Albums by ${el.dataset.name}`, () => spotify.artistAlbums(id).then((albums) => ({ albums })));
      case 'sp-album':
        return void this.drill(el.dataset.name ?? 'Album', () => spotify.albumTracks(id).then((tracks) => ({ tracks })));
      case 'drill-close':
        if (this.search) this.search.drill = undefined;
        return this.renderPanel();
      case 'replay':
        return this.startReplay(id);
      case 'stop-replay':
        return this.stopReplay();
      case 'delete-journey':
        if (this.explorer && confirm('Delete this journey? This cannot be undone.')) void this.store.deleteJourney(this.explorer, id);
        return;
    }
  }

  private inputTimer: number | null = null;

  private handleInput(el: HTMLElement): void {
    const kind = el.dataset.input;
    if (!kind) return;
    const value = (el as HTMLTextAreaElement).value;
    if (kind === 'reflection') this.recorder.update({ reflection: value });
    if (kind === 'description') this.recorder.update({ description: value });
    if (kind === 'note') {
      if (this.inputTimer) clearTimeout(this.inputTimer);
      this.inputTimer = window.setTimeout(() => this.saveNote(el.dataset.id!, value), 600);
    }
  }

  private handleCommit(el: HTMLElement): void {
    if (el.dataset.input === 'reflection' && (el as HTMLTextAreaElement).value.trim()) {
      this.record('reflect', this.originId, undefined, (el as HTMLTextAreaElement).value.trim());
    }
  }

  private async saveNote(trackId: string, text: string): Promise<void> {
    if (!this.explorer) return;
    this.notes[trackId] = text;
    try {
      await this.store.saveNote(this.explorer, trackId, text.trim());
    } catch (err) {
      this.say(`Couldn't save note: ${(err as Error).message}`);
    }
  }

  private hideTrack(id: string): void {
    this.hidden.add(id);
    if (this.explorer) void this.store.saveHidden(this.explorer, [...this.hidden]);
    this.flash = `Hidden “${nameOf(this.graph, id)}” from this map. Your Spotify library is unchanged.`;
    this.closeSelection();
    this.refreshField();
    this.render();
  }

  private async lookupMusicBrainz(id: string): Promise<void> {
    const t = this.graph.tracks.get(id);
    if (!t) return;
    this.mbStatus.set(id, 'loading');
    this.renderPanel();
    try {
      const known = this.graph.neighbors(id).map((n) => this.graph.people.get(n.otherId)).filter((p) => !!p);
      const res = await enrichFromMusicBrainz(t, known);
      this.addData(res.data);
      this.mbStatus.set(id, res.message);
      this.render();
    } catch (err) {
      this.mbStatus.set(id, `${(err as Error).message} MusicBrainz may be unreachable from this network.`);
      this.renderPanel();
    }
  }

  // ---- Search -----------------------------------------------------------------

  private runSearch(query: string, kind: spotify.SearchKind): void {
    if (!query) {
      this.search = null;
      return this.renderPanel();
    }
    this.search = { query, kind, loading: spotify.isConnected() };
    this.showData = false;
    this.renderPanel();
    this.panel.scrollTop = 0;
    if (!spotify.isConnected()) return;
    const token = this.search;
    spotify
      .search(query, kind)
      .then((res) => (token.spotify = res))
      .catch((err: Error) => (token.error = err.message))
      .finally(() => {
        token.loading = false;
        if (this.search === token) this.renderPanel();
      });
  }

  private async drill(title: string, load: () => Promise<{ albums?: spotify.SpotifySearchResults['albums']; tracks?: Partial<Dataset>[] }>): Promise<void> {
    if (!this.search) return;
    const token = this.search;
    token.drill = { title, loading: true };
    this.renderPanel();
    try {
      Object.assign(token.drill, await load(), { loading: false });
    } catch (err) {
      Object.assign(token.drill!, { loading: false, error: (err as Error).message });
    }
    if (this.search === token) this.renderPanel();
  }

  // ---- Replay -----------------------------------------------------------------

  private startReplay(journeyId: string): void {
    const journey = this.journeys.find((j) => j.id === journeyId);
    if (!journey) return;
    this.stopReplay();
    this.recorder.flush();
    this.recorder.journey = null; // replays are watched, not recorded
    this.replay = { journey, index: 0, timer: 0 };
    this.panel.scrollTop = 0;
    const stepMs = this.reducedMotion.matches ? 600 : 1300;
    const advance = () => {
      const r = this.replay;
      if (!r) return;
      r.index++;
      const { path, view } = pathAfter(r.journey.steps, r.index);
      this.view = view;
      this.path = path;
      this.inspected = null;
      this.reflecting = r.journey.steps[r.index - 1]?.action === 'return';
      this.render();
      if (r.index < r.journey.steps.length) r.timer = window.setTimeout(advance, stepMs);
      else {
        this.say('Replay finished.');
        r.timer = window.setTimeout(() => this.stopReplay(), 1500);
      }
    };
    advance();
  }

  private stopReplay(): void {
    if (!this.replay) return;
    clearTimeout(this.replay.timer);
    this.replay = null;
    this.recorder.journey = null;
    this.renderPanel();
  }

  // ---- Tooltip & announcements ------------------------------------------------

  private showTooltip(id: string | null, el: HTMLElement | null): void {
    if (!id || !el) {
      this.tooltip.hidden = true;
      return;
    }
    const n = this.graph.node(id);
    if (!n) return;
    let html: string;
    if (n.kind === 'track') {
      const saved = this.graph.savedAt(id);
      html = `<strong>${h(n.title)}</strong><span>${h(n.artistCredit)}</span>
        <span class="mm-tt--release">Released ${formatPartialDate(n.release)}</span>
        <span class="${saved ? 'mm-tt--saved' : 'mm-tt--outside'}">${saved ? `Saved ${formatSaved(saved)}` : 'Outside your collection'}</span>`;
    } else {
      html = `<strong>${h(n.name)}</strong><span>${n.kind === 'group' ? 'Group' : 'Person'}</span>`;
    }
    const cur = this.currentId;
    if (cur && cur !== id) {
      const rel = this.relsBetween(cur, id)[0];
      if (rel) html += `<span class="mm-tt--rel">${h(relSentence(this.graph, rel, cur))}</span>`;
    }
    this.tooltip.innerHTML = html;
    this.tooltip.hidden = false;
    const s = this.stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    let x = r.right - s.left + 10;
    if (x + tw > s.width - 8) x = r.left - s.left - tw - 10;
    const y = Math.max(8, Math.min(s.height - th - 8, r.top - s.top));
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
  }

  private say(message: string): void {
    this.announcer.textContent = '';
    requestAnimationFrame(() => (this.announcer.textContent = message));
  }
}

new MusicMapApp().init().catch((err) => {
  console.error(err);
  document.getElementById('panel')!.innerHTML = `<p class="mm-error">Music Map failed to start: ${h((err as Error).message)}</p>`;
});
