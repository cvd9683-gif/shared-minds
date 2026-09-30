// Music Map - Main application
// Orchestrates the two date systems (Personal Timeline / Historical Timeline), the path a
// listener follows through relationships, journey recording, storage, Spotify and
// the detail panel.

import './style.css';
import demoData from './data/demo-collection.json';
import { coverUrl } from './covers';
import { TimelineCanvas, escapeHtml as h, type CanvasItem, type CanvasSection } from './canvas';
import { LibraryWeb, type WebAlbum, type WebLink, type WebPerson } from './web';
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
import { enrichFromGenius, geniusToken, saveGeniusToken } from './genius';
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
import type { Dataset, Journey, Node, Relationship, Thought, Track, ViewMode, YearData } from './types';

const DATASET_KEY = 'musicMap:dataset';
const LIBRARY_KEY = 'musicMap:spotifyLibrary';
const HOWTO_KEY = 'musicMap:howtoSeen';
const IMPORTED_KEY = 'musicMap:importedAt';
const ENRICHED_KEY = 'musicMap:enriched';
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
  private years: Record<string, YearData> = {};
  private recording = true;

  // Exploration state
  private view: ViewMode = 'timeline';
  private path: PathStep[] = [];
  private inspected: { id: string; relIds: string[] } | null = null;
  private expanded = new Set<string>();
  /** The historical web shows second-degree connections by default ("zoom out" of the web). */
  private wider = true;
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
  /** The year experience opened from Personal Timeline. */
  private yearOpen: { year: string; featuredId: string | null } | null = null;
  /** Where "Close" on the history network should return to, if opened from a year. */
  private returnYear: { year: string; featuredId: string | null } | null = null;
  private editingThought: string | null = null;
  /** Album tile picked on Personal Timeline, and which of its saved songs is shown. */
  private picked: string | null = null;
  private pickedTrack: string | null = null;
  private returnPick: { group: string; track: string } | null = null;
  /** Album tiles on the current canvas: tile id → the saved songs it holds. */
  private groups = new Map<string, { trackIds: string[] }>();
  private panelPinned = false;
  private canvasKey = '';

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
  private yearEl = document.getElementById('year-view')!;
  private canvas: TimelineCanvas;
  private web: LibraryWeb;
  private webKey = '';
  /** Web album id → its songs. */
  private webAlbums = new Map<string, string[]>();
  private network: NetworkView;
  private recorder: JourneyRecorder;

  constructor() {
    this.canvas = new TimelineCanvas(document.getElementById('canvas')!, document.getElementById('yearnav')!, {
      // Personal Timeline grows the cover in place; the Historical timeline opens what it's connected to.
      onSelect: (id, _key, rect) => {
        if (this.view === 'timeline') return this.pickTile(id);
        const first = this.groups.get(id)?.trackIds[0];
        if (first) this.selectOrigin(first, rect);
      },
      onHover: (id, el) => this.showTooltip(id, el),
      onCaption: (key) => this.openYear(key, null),
      onBackground: () => this.unpick(),
    });
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
    this.network.bindCamera(this.stage);
    this.web = new LibraryWeb(document.getElementById('web') as HTMLCanvasElement, {
      onSelect: (kind, id, rect) => {
        const target = kind === 'album' ? this.webAlbums.get(id)?.[0] : id;
        if (target) this.selectOrigin(target, rect);
      },
      onHover: (info) => this.showWebTooltip(info),
    });
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
    if (login.completed) {
      void spotify.loadProfileName().then(() => this.renderChrome());
      void this.importLibrary();
    } else if (!localStorage.getItem(HOWTO_KEY)) {
      this.showHowto(true);
    }
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
    this.yearOpen = null;
    this.refreshCanvas(true);
  }

  /** Rebuilds the canvas when the view or its data changed. */
  private refreshCanvas(force = false): void {
    const labels = Object.entries(this.years).map(([k, v]) => `${k}:${v.label ?? ''}`).join('|');
    const key = `${this.view}|${this.graph.tracks.size}|${this.graph.collection.size}|${[...this.hidden].join()}|${labels}`;
    if (this.view === 'history' || (!force && key === this.canvasKey)) return;
    this.canvasKey = key;
    this.canvas.setSections(this.savedSections(), 'saved');
    // Rebuilding clears the picked cover; put it back if it's still on this timeline.
    if (this.picked && this.groups.has(this.picked)) {
      this.canvas.setSelected(this.picked, this.calloutHtml(), this.pickedLabel());
    } else {
      this.picked = null;
    }
  }

  /** Songs from the same album in a section become one tile. */
  private groupItems(secKey: string, entries: { track: Track; dateText: string; outside: boolean }[]): CanvasItem[] {
    const byAlbum = new Map<string, typeof entries>();
    for (const e of entries) {
      const k = this.albumKey(e.track);
      byAlbum.set(k, [...(byAlbum.get(k) ?? []), e]);
    }
    return [...byAlbum].map(([albumKey, list]) => {
      const id = `${secKey}|${albumKey}`;
      const t = list[0].track;
      this.groups.set(id, { trackIds: list.map((e) => e.track.id) });
      return {
        id,
        track: t,
        trackIds: list.map((e) => e.track.id),
        title: t.album?.name ?? t.title,
        artist: t.artistCredit,
        dateText: list.length > 1 ? `${list.length} songs saved from this album` : list[0].dateText,
        outside: list.every((e) => e.outside),
      };
    });
  }

  /** Personal Timeline: one section per year saved, captioned by the explorer. */
  private savedSections(): CanvasSection[] {
    this.groups.clear();
    const byYear = new Map<string, { track: Track; dateText: string; outside: boolean }[]>();
    for (const { entry, track } of this.graph.savedTracks(this.hidden)) {
      const year = `${new Date(entry.savedAt).getFullYear()}`;
      byYear.set(year, [...(byYear.get(year) ?? []), { track, dateText: `Saved ${formatSaved(entry.savedAt)}`, outside: false }]);
    }
    return [...byYear].map(([year, entries]) => ({
      key: year,
      title: year,
      caption: this.years[year]?.label,
      editable: true,
      items: this.groupItems(year, entries),
    }));
  }

  /** Songs group by album; without album info, the same cover art means the same album. */
  private albumKey(t: Track): string {
    return t.album?.id ?? (t.cover.kind === 'image' ? `img:${t.cover.url}` : t.id);
  }

  /** Historical Timeline: every album in the map as one web, fanned around its artists. */
  private refreshWeb(force = false): void {
    const key = `${this.graph.tracks.size}|${this.graph.rels.size}|${this.graph.collection.size}|${[...this.hidden].join()}`;
    if (!force && key === this.webKey) return;
    this.webKey = key;
    const albums = new Map<string, WebAlbum>();
    const people = new Map<string, WebPerson>();
    this.webAlbums.clear();
    const PRIMARY = /^(primary artist|credited artist)/;
    for (const t of this.graph.tracks.values()) {
      if (this.hidden.has(t.id)) continue;
      const k = this.albumKey(t);
      let a = albums.get(k);
      if (!a) {
        const title = t.album?.name ?? t.title;
        a = { id: k, trackIds: [], title, artist: t.artistCredit, cover: coverUrl(t.cover, title), outside: true, artistIds: [], creditIds: [] };
        albums.set(k, a);
      }
      a.trackIds.push(t.id);
      if (this.graph.inCollection(t.id)) a.outside = false;
      for (const n of this.graph.neighbors(t.id)) {
        if (n.rel.type !== 'credit' || n.outgoing) continue;
        const person = this.graph.people.get(n.otherId);
        if (!person) continue;
        people.set(person.id, { id: person.id, name: person.name });
        const list = PRIMARY.test(n.rel.role ?? '') ? a.artistIds : a.creditIds;
        if (!list.includes(person.id)) list.push(person.id);
      }
    }
    for (const a of albums.values()) {
      a.creditIds = a.creditIds.filter((id) => !a.artistIds.includes(id));
      this.webAlbums.set(a.id, a.trackIds);
    }
    const links: WebLink[] = [];
    for (const r of this.graph.rels.values()) {
      if (r.type !== 'samples' && r.type !== 'interpolates' && r.type !== 'documented') continue;
      const ta = this.graph.tracks.get(r.from);
      const tb = this.graph.tracks.get(r.to);
      if (!ta || !tb) continue;
      links.push({
        a: this.albumKey(ta),
        b: this.albumKey(tb),
        kind: r.type === 'documented' ? 'other' : r.type,
        uncertain: r.evidence.status !== 'documented',
      });
    }
    this.web.setData([...albums.values()], [...people.values()], links);
  }

  private showWebTooltip(info: { title: string; sub: string; x: number; y: number } | null): void {
    if (!info) {
      this.tooltip.hidden = true;
      return;
    }
    this.tooltip.innerHTML = `<strong>${h(info.title)}</strong><span>${h(info.sub)}</span>`;
    this.tooltip.hidden = false;
    const tw = this.tooltip.offsetWidth;
    const x = info.x + 16 + tw > this.stage.clientWidth ? info.x - tw - 16 : info.x + 16;
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, info.y - 10)}px)`;
  }

  /** The album tile on the current canvas that holds this song. */
  private groupOf(trackId: string): string | null {
    for (const [id, g] of this.groups) if (g.trackIds.includes(trackId)) return id;
    return null;
  }

  private async loadExplorerData(): Promise<void> {
    if (!this.explorer) return;
    try {
      const data = await this.store.loadExplorer(this.explorer);
      this.notes = data.notes;
      this.hidden = new Set(data.hidden);
      // Keep anything written before the name was known (e.g. the first thought).
      for (const [year, local] of Object.entries(this.years)) {
        const saved = (data.years[year] ??= { thoughts: [] });
        saved.label = local.label ?? saved.label;
        local.thoughts.forEach((t) => saved.thoughts.some((x) => x.id === t.id) || saved.thoughts.push(t));
      }
      this.years = data.years;
    } catch (err) {
      console.error(err);
    }
  }

  private async importLibrary(): Promise<void> {
    this.showData = true;
    this.importStatus = 'Importing saved tracks from Spotify…';
    this.renderPanel();
    try {
      const data = await spotify.importSavedTracks(1000, (n, total) => {
        this.importStatus = `Importing saved tracks from Spotify… ${n} of ${total}`;
        this.renderPanel();
      });
      const { playlists, note } = await spotify.importPlaylists((n, total) => {
        this.importStatus = `Reading your playlists… ${n} of ${total}`;
        this.renderPanel();
      });
      data.playlists = playlists;
      data.playlistsNote = note;
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(data));
      localStorage.setItem(DATASET_KEY, 'spotify');
      localStorage.setItem(IMPORTED_KEY, new Date().toISOString());
      this.importStatus = `Imported ${data.collection?.length ?? 0} saved tracks with the dates you saved them, and ${playlists.length} of your playlists.${note ? ` ${note}` : ''}`;
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

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('input, textarea, select')) return;
      if (e.key === 'Escape') {
        if (this.inspected) this.inspect(null);
        else if (this.yearOpen && !this.path.length) this.closeYear();
        else if (this.picked && !this.path.length) this.unpick();
        else if (this.path.length > 1) this.back();
        else if (this.path.length) this.closeSelection();
      } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) {
        if (this.path.length > 1) {
          e.preventDefault();
          this.back();
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
    document.getElementById('blurb')!.addEventListener('click', onAction);
    // The year view and the picked-cover callout share actions and forms.
    for (const host of [this.yearEl, document.getElementById('canvas')!]) {
      host.addEventListener('click', onAction);
      host.addEventListener('focusout', (e) => this.handleCommit(e.target as HTMLElement));
      host.addEventListener('keydown', (e) => {
        const t = e.target as HTMLElement;
        if (e.key === 'Enter' && t.id === 'year-label') t.blur();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && t.matches('textarea')) {
          e.preventDefault();
          t.closest('form')?.requestSubmit();
        }
      });
      host.addEventListener('submit', (e) => {
        e.preventDefault();
        const form = e.target as HTMLFormElement;
        if (form.dataset.form === 'thought') void this.addThought(form);
        if (form.dataset.form === 'edit-thought') void this.saveThoughtEdit(form);
      });
    }
    document.getElementById('panel-btn')!.addEventListener('click', () => {
      this.panelPinned = !this.panelPinned;
      this.render();
      if (this.panelPinned) this.panel.focus();
    });

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

    document.getElementById('zoomctl')!.addEventListener('click', (e) => {
      const z = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
      // With a song open the buttons zoom its web; otherwise the whole-library web.
      const target = this.path.length ? this.network : this.web;
      if (z === 'in') target.zoomBy(1.3);
      if (z === 'out') target.zoomBy(1 / 1.3);
      if (z === 'fit') target.fit();
    });
    (document.getElementById('wider-toggle') as HTMLInputElement).checked = this.wider;
    document.getElementById('wider-toggle')!.addEventListener('change', (e) => {
      this.wider = (e.target as HTMLInputElement).checked;
      this.render();
    });

    // One quiet menu holds everything that isn't the timeline or search.
    const menuBtn = document.getElementById('menu-btn')!;
    const menu = document.getElementById('menu')!;
    const setMenu = (open: boolean) => {
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', `${open}`);
      if (open) menu.querySelector<HTMLElement>('button')?.focus();
    };
    menuBtn.addEventListener('click', () => setMenu(menu.hidden));
    menu.addEventListener('click', (e) => (e.target as HTMLElement).closest('button') && setMenu(false));
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !(e.target as HTMLElement).closest('.mm-menu')) setMenu(false);
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setMenu(false);
        menuBtn.focus();
      }
    });
    document.getElementById('demo-tag')!.addEventListener('click', () => {
      this.showData = true;
      this.renderPanel();
      this.panel.focus();
    });
    document.getElementById('explorer-btn')!.addEventListener('click', () => this.changeExplorer());
    document.getElementById('storage-btn')!.addEventListener('click', () => this.openSettings());
    document.getElementById('dataset-badge')!.addEventListener('click', () => {
      this.showData = true;
      this.renderPanel();
      this.panel.focus();
    });
    document.getElementById('spotify-btn')!.addEventListener('click', () => this.openSpotifyDialog());
    document.getElementById('connect-btn')!.addEventListener('click', () => this.openSpotifyDialog());
    document.getElementById('help-btn')!.addEventListener('click', () => this.showHowto(document.getElementById('howto')!.hidden));
    document.getElementById('howto')!.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-howto]')?.dataset.howto;
      if (act) this.showHowto(false);
      if (act === 'connect') this.openSpotifyDialog();
    });
    const spDialog = document.getElementById('spotify-dialog') as HTMLDialogElement;
    spDialog.addEventListener('click', (e) => {
      if (e.target === spDialog) return spDialog.close(); // click on the backdrop
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-sp]');
      if (el) void this.handleSpotifyAction(el.dataset.sp!);
    });
    spDialog.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.handleSpotifyAction('save-connect');
    });
    this.bindSettings();

    new ResizeObserver(() => {
      const r = this.stage.getBoundingClientRect();
      this.canvas.resize(r.width, r.height);
      this.network.resize(r.width, r.height);
      this.web.resize(r.width, r.height);
    }).observe(this.stage);
    this.narrow.addEventListener('change', () => this.applyEnvironment());
    this.reducedMotion.addEventListener('change', () => this.applyEnvironment());
    window.addEventListener('beforeunload', () => this.recorder.flush());
  }

  private applyEnvironment(): void {
    this.canvas.setReducedMotion(this.reducedMotion.matches);
    this.network.setReducedMotion(this.reducedMotion.matches);
    this.web.setReducedMotion(this.reducedMotion.matches);
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
    this.years = {};
    await this.loadExplorerData();
    this.refreshCanvas();
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
    this.yearOpen = null;
    this.picked = null;
    this.record('view', this.currentId);
    this.say(view === 'timeline' ? 'Personal Timeline: ordered by the date each track was saved.' : 'Historical Timeline: recordings ordered by release date.');
    this.render();
  }

  private selectOrigin(id: string, rect?: DOMRect): void {
    this.stopReplay();
    this.path = [{ nodeId: id }];
    this.inspected = null;
    this.expanded.clear();
    this.reflecting = false;
    this.search = null;
    this.showData = false;
    this.yearOpen = null;
    if (this.explorer && this.recording) this.recorder.start(this.explorer, id, this.view);
    else this.recorder.journey = null;
    this.say(`Selected ${nameOf(this.graph, id)}. ${this.neighborsOf(id).length} direct connections.`);
    void this.autoEnrich(id);
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
    void this.autoEnrich(id);
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
    // Opened from a year? Go back into that year, in Personal Timeline.
    if (this.returnYear) {
      this.view = 'timeline';
      this.yearOpen = this.returnYear;
      this.returnYear = null;
      this.render();
      return;
    }
    if (this.returnPick) {
      const { group, track } = this.returnPick;
      this.returnPick = null;
      this.view = 'timeline';
      this.render();
      this.pickTile(group, track);
      return;
    }
    this.render();
    const tile = origin ? this.groupOf(origin) : null;
    if (tile) {
      this.canvas.scrollToItem(tile, true);
      this.canvas.focusItem(tile);
    }
  }

  // ---- Year experience ----------------------------------------------------------

  private yearData(year: string): YearData {
    return (this.years[year] ??= { thoughts: [] });
  }

  private yearTracks(year: string): { track: Track; savedAt: string }[] {
    return this.graph
      .savedTracks(this.hidden)
      .filter(({ entry }) => `${new Date(entry.savedAt).getFullYear()}` === year)
      .map(({ entry, track }) => ({ track, savedAt: entry.savedAt }));
  }

  /** Opens a year from Personal Timeline. The clicked cover flies into place as the featured track. */
  private openYear(year: string, featuredId: string | null, from?: DOMRect): void {
    const tracks = this.yearTracks(year);
    if (!tracks.length) return;
    this.yearOpen = { year, featuredId: featuredId ?? tracks[tracks.length - 1].track.id };
    this.editingThought = null;
    if (this.recorder.journey && featuredId) this.record('year', featuredId, undefined, year);
    this.say(`${year}: ${tracks.length} tracks saved.${featuredId ? ` Showing ${nameOf(this.graph, featuredId)}.` : ''}`);
    this.render();
    this.yearEl.scrollTop = 0;
    const target = this.yearEl.querySelector<HTMLImageElement>('#year-feature-img');
    if (from && target && !this.reducedMotion.matches) this.flyCover(from, target);
    if (featuredId) this.yearEl.querySelector<HTMLElement>('#year-feature-title')?.focus({ preventScroll: true });
    else this.yearEl.querySelector<HTMLElement>('#year-label')?.focus({ preventScroll: true });
  }

  private closeYear(): void {
    const id = this.yearOpen?.featuredId;
    this.yearOpen = null;
    this.editingThought = null;
    this.render();
    const tile = id ? this.groupOf(id) : null;
    if (tile) {
      this.canvas.scrollToItem(tile, true);
      this.canvas.focusItem(tile);
    }
  }

  /** Animates a copy of the cover from where it was clicked to its place in the year view. */
  private flyCover(from: DOMRect, target: HTMLImageElement): void {
    const to = target.getBoundingClientRect();
    const ghost = target.cloneNode() as HTMLImageElement;
    ghost.removeAttribute('id');
    ghost.className = 'mm-ghost';
    Object.assign(ghost.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    document.body.appendChild(ghost);
    target.style.visibility = 'hidden';
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const k = from.width / to.width;
    ghost
      .animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${k})`, transformOrigin: '0 0' },
          { transform: 'translate(0, 0) scale(1)', transformOrigin: '0 0' },
        ],
        { duration: 620, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      )
      .finished.finally(() => {
        target.style.visibility = '';
        ghost.remove();
      });
  }

  private async saveYear(year: string): Promise<boolean> {
    if (!this.explorer) {
      this.recording = true;
      this.ensureExplorer();
      if (!this.explorer) {
        this.flash = 'Set a name to save what you write.';
        this.renderPanel();
        return false;
      }
      // Merge with anything already saved under this name before writing over it.
      await this.loadExplorerData();
    }
    try {
      await this.store.saveYear(this.explorer, year, this.yearData(year));
      return true;
    } catch (err) {
      this.say(`Couldn't save: ${(err as Error).message}`);
      return false;
    }
  }

  /** Thoughts live under the year a track was saved in; the callout and the year view share them. */
  private async addThought(form: HTMLFormElement): Promise<void> {
    const year = form.dataset.year;
    const text = (form.querySelector('textarea') as HTMLTextAreaElement).value.trim();
    if (!year || !text) return;
    const about = form.querySelector<HTMLInputElement>('input[name="about"]');
    const trackId = form.dataset.track ?? (about?.checked ? this.yearOpen?.featuredId ?? undefined : undefined);
    const thought: Thought = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      text,
      at: new Date().toISOString(),
      ...(trackId ? { trackId } : {}),
    };
    this.yearData(year).thoughts.push(thought);
    if (await this.saveYear(year)) this.say('Memory saved.');
    this.refreshThoughtViews();
    document.querySelector<HTMLTextAreaElement>('#thought-text')?.focus();
  }

  private async saveThoughtEdit(form: HTMLFormElement): Promise<void> {
    const year = form.dataset.year;
    if (!year || !this.editingThought) return;
    const t = this.yearData(year).thoughts.find((x) => x.id === this.editingThought);
    const text = (form.querySelector('textarea') as HTMLTextAreaElement).value.trim();
    if (t && text) t.text = text;
    this.editingThought = null;
    await this.saveYear(year);
    this.refreshThoughtViews();
  }

  private async deleteThought(id: string, year?: string): Promise<void> {
    if (!year || !confirm('Delete this?')) return;
    const data = this.yearData(year);
    data.thoughts = data.thoughts.filter((t) => t.id !== id);
    await this.saveYear(year);
    this.refreshThoughtViews();
  }

  private refreshThoughtViews(): void {
    this.renderYear();
    if (this.picked) this.canvas.updateCallout(this.calloutHtml());
  }

  // ---- Picked cover (Personal Timeline) -----------------------------------------------

  /** Picks an album on the Personal Timeline: it grows in the magnifier with its details. */
  private pickTile(groupId: string, trackId?: string): void {
    const g = this.groups.get(groupId);
    if (!g) return;
    this.picked = groupId;
    // Show the most recently saved song from the album unless one was asked for.
    this.pickedTrack = trackId && g.trackIds.includes(trackId)
      ? trackId
      : [...g.trackIds].sort((a, b) => (this.graph.savedAt(b) ?? '').localeCompare(this.graph.savedAt(a) ?? ''))[0];
    this.editingThought = null;
    if (this.recorder.journey) this.record('year', this.pickedTrack, undefined, this.savedYear(this.pickedTrack) ?? undefined);
    this.canvas.setSelected(groupId, this.calloutHtml(), this.pickedLabel());
    const t = this.graph.tracks.get(this.pickedTrack)!;
    this.say(`${t.album?.name ?? t.title}. ${g.trackIds.length > 1 ? `${g.trackIds.length} songs saved.` : `Saved ${formatSaved(this.graph.savedAt(t.id))}.`}`);
    requestAnimationFrame(() => this.canvas.calloutEl.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true }));
  }

  private pickedLabel(): string {
    const t = this.pickedTrack ? this.graph.tracks.get(this.pickedTrack) : undefined;
    return t ? `${t.album?.name ?? t.title} by ${t.artistCredit}` : '';
  }

  private unpick(): void {
    const id = this.picked;
    this.picked = null;
    this.pickedTrack = null;
    this.editingThought = null;
    this.canvas.setSelected(null);
    if (id) this.canvas.focusItem(id);
  }

  private savedYear(id: string): string | null {
    const saved = this.graph.savedAt(id);
    return saved ? `${new Date(saved).getFullYear()}` : null;
  }

  private thoughtList(year: string, items: Thought[], showTag: boolean): string {
    return items
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((th) => {
        if (this.editingThought === th.id) {
          return `<li class="mm-thought is-editing"><form data-form="edit-thought" data-year="${h(year)}">
            <label class="sr-only" for="edit-thought-text">Edit</label>
            <textarea id="edit-thought-text" rows="3">${h(th.text)}</textarea>
            <div class="mm-actions"><button type="submit" class="mm-btn mm-btn--primary mm-btn--small">Save</button><button type="button" class="mm-btn mm-btn--small" data-action="cancel-edit">Cancel</button></div>
          </form></li>`;
        }
        const about = showTag && th.trackId ? this.graph.tracks.get(th.trackId) : undefined;
        const tag = !showTag
          ? ''
          : about
            ? `<button type="button" class="mm-thought__about" data-action="feature" data-id="${h(about.id)}"><img src="${coverUrl(about.cover, about.title)}" alt="" />${h(about.title)}</button>`
            : `<span class="mm-thought__about is-year">About ${h(year)}</span>`;
        return `<li class="mm-thought ${showTag && th.trackId === this.yearOpen?.featuredId ? 'is-about-featured' : ''}">
          <p class="mm-thought__text">${h(th.text)}</p>
          <p class="mm-thought__meta">${tag}<span>${formatSaved(th.at, true)}</span>
            <button type="button" class="mm-link mm-small" data-action="edit-thought" data-id="${h(th.id)}">Edit</button>
            <button type="button" class="mm-link mm-small" data-action="delete-thought" data-id="${h(th.id)}" data-year="${h(year)}">Delete</button></p>
        </li>`;
      })
      .join('');
  }

  /** The callout from the sketch: 1 your memories, 2 date added, 3 playlists it's in. */
  private calloutHtml(): string {
    const id = this.pickedTrack!;
    const t = this.graph.tracks.get(id)!;
    const group = this.picked ? this.groups.get(this.picked) : undefined;
    const albumSongs =
      group && group.trackIds.length > 1
        ? `<ul class="mm-album-songs" aria-label="Songs saved from this album">${group.trackIds
            .map((tid) => {
              const tt = this.graph.tracks.get(tid)!;
              return `<li><button type="button" class="mm-album-song ${tid === id ? 'is-current' : ''}" data-action="pick-track" data-id="${h(tid)}" aria-pressed="${tid === id}"><span>${h(tt.title)}</span><em>${formatSaved(this.graph.savedAt(tid))}</em></button></li>`;
            })
            .join('')}</ul>`
        : '';
    const saved = this.graph.savedAt(id);
    const year = this.savedYear(id) ?? '';
    const memories = (this.years[year]?.thoughts ?? []).filter((th) => th.trackId === id);
    const playlists = this.graph.playlistsFor(id);
    const demo = t.origin === 'demo';
    let playlistHtml: string;
    if (playlists.length) {
      playlistHtml = `<ul class="mm-chips">${playlists
        .map((p) => (p.url ? `<li><a href="${h(p.url)}" target="_blank" rel="noopener">${h(p.name)}</a></li>` : `<li><span>${h(p.name)}</span></li>`))
        .join('')}</ul>${demo ? '<p class="mm-muted mm-small">Fictional demo playlists.</p>' : ''}`;
    } else if (this.datasetKind === 'spotify' && this.graph.playlistsNote) {
      playlistHtml = `<p class="mm-muted mm-small">${h(this.graph.playlistsNote)}</p>`;
    } else if (this.datasetKind === 'spotify' || demo) {
      playlistHtml = '<p class="mm-muted mm-small">Not in any playlist you made.</p>';
    } else {
      playlistHtml = '<p class="mm-muted mm-small">Connect Spotify to see your playlists.</p>';
    }
    return `
      <div class="mm-callout__head">
        <div>
          <h3 tabindex="-1">${h(albumSongs ? t.album?.name ?? t.title : t.title)}</h3>
          <p class="mm-muted">${h(t.artistCredit)}${albumSongs ? ` · ${group!.trackIds.length} songs saved` : t.album && t.album.name !== t.title ? ` · from ${h(t.album.name)}` : ''}</p>
        </div>
        <button type="button" class="mm-callout__close" data-action="unpick" aria-label="Close">×</button>
      </div>
      ${albumSongs}
      <ol class="mm-callout__list">
        <li>
          <h4><span>1</span>Your memories</h4>
          ${memories.length ? `<ul class="mm-thoughts mm-thoughts--compact">${this.thoughtList(year, memories, false)}</ul>` : ''}
          <form class="mm-thought-form" data-form="thought" data-year="${h(year)}" data-track="${h(id)}">
            <label class="sr-only" for="thought-text">Add a memory</label>
            <textarea id="thought-text" rows="2" placeholder="What does this song bring back?"></textarea>
            <div class="mm-actions"><button type="submit" class="mm-btn mm-btn--primary mm-btn--small">Add memory</button></div>
          </form>
        </li>
        <li>
          <h4><span>2</span>Date added</h4>
          <p class="mm-callout__saved">${saved ? formatSaved(saved, true) : 'Outside your collection'}</p>
          <p class="mm-muted mm-small">Released ${formatPartialDate(t.release)}${demo ? ' · fictional demo track' : ''}</p>
        </li>
        <li>
          <h4><span>3</span>Playlists it's in</h4>
          ${playlistHtml}
        </li>
      </ol>
      <div class="mm-callout__actions">
        ${year ? `<button type="button" class="mm-btn mm-btn--small" data-action="year-nav" data-year="${h(year)}">Step into ${h(year)} →</button>` : ''}
        <button type="button" class="mm-btn mm-btn--small mm-btn--history" data-action="pick-history" data-id="${h(id)}">See where it comes from →</button>
        ${t.spotify ? `<a class="mm-link mm-small" href="${h(t.spotify.url)}" target="_blank" rel="noopener">Play on Spotify ↗</a>` : ''}
      </div>`;
  }

  private renderYear(): void {
    const open = this.yearOpen && !this.path.length;
    this.yearEl.hidden = !open;
    if (!open) {
      this.yearEl.innerHTML = '';
      return;
    }
    const { year } = this.yearOpen!;
    const tracks = this.yearTracks(year);
    const featured = tracks.find((t) => t.track.id === this.yearOpen!.featuredId) ?? tracks[tracks.length - 1];
    const t = featured.track;
    const data = this.years[year] ?? { thoughts: [] };
    const allYears = [...new Set(this.graph.savedTracks(this.hidden).map(({ entry }) => `${new Date(entry.savedAt).getFullYear()}`))];
    const i = allYears.indexOf(year);
    const prev = allYears[i - 1];
    const next = allYears[i + 1];

    // A loose collage: a few covers take up more room, the featured one is ringed.
    const collage = tracks
      .map(({ track, savedAt }, n) => {
        const big = (n * 7 + track.id.length) % 5 === 0;
        const on = track.id === t.id;
        return `<button type="button" class="mm-collage__item ${big ? 'is-big' : ''} ${on ? 'is-featured' : ''}" data-action="feature" data-id="${h(track.id)}" aria-pressed="${on}" title="${h(track.title)} · Saved ${formatSaved(savedAt)}">
          <img src="${coverUrl(track.cover, track.title)}" alt="${h(track.title)} by ${h(track.artistCredit)}, saved ${formatSaved(savedAt)}" loading="lazy" /></button>`;
      })
      .join('');

    const thoughtItems = this.thoughtList(year, [...data.thoughts], true);

    const listen = t.spotify
      ? `<a class="mm-link" href="${h(t.spotify.url)}" target="_blank" rel="noopener">Listen on Spotify ↗</a>`
      : t.origin === 'demo'
        ? '<p class="mm-muted mm-small">Fictional demo track: no audio.</p>'
        : '';

    this.yearEl.innerHTML = `
      <div class="mm-year" role="region" aria-label="${h(year)}">
        <div class="mm-year__bar">
          <button type="button" class="mm-btn mm-btn--small" data-action="close-year">← Back to timeline</button>
          <div class="mm-year__nav">
            ${prev ? `<button type="button" class="mm-btn mm-btn--small" data-action="year-nav" data-year="${prev}">‹ ${prev}</button>` : ''}
            ${next ? `<button type="button" class="mm-btn mm-btn--small" data-action="year-nav" data-year="${next}">${next} ›</button>` : ''}
          </div>
        </div>
        <div class="mm-year__grid">
          <section class="mm-year__feature" aria-labelledby="year-feature-title">
            <img id="year-feature-img" class="mm-year__cover" src="${coverUrl(t.cover, t.title)}" alt="Cover of ${h(t.title)}" />
            <h3 id="year-feature-title" class="mm-year__track" tabindex="-1">${h(t.title)}</h3>
            ${this.dateFields(t)}
            ${this.demoNotice(t)}
            <button type="button" class="mm-btn mm-btn--history" data-action="year-history" data-id="${h(t.id)}">See where this song comes from →</button>
            <p class="mm-muted mm-small">Opens the Historical timeline: the recordings, samples and people connected to it.</p>
            ${listen}
          </section>
          <section class="mm-year__main">
            <h2 class="mm-year__title">${h(year)}</h2>
            <label class="sr-only" for="year-label">What was going on in ${h(year)}?</label>
            <input id="year-label" class="mm-year__label" data-input="year-label" value="${h(data.label ?? '')}" placeholder="What was going on in ${h(year)}? e.g. senior year, a move, a new job" maxlength="80" autocomplete="off" />
            <p class="mm-muted mm-small">${tracks.length} track${tracks.length === 1 ? '' : 's'} saved this year. Only you write the words here; nothing is guessed from your listening.</p>
            <div class="mm-collage">${collage}</div>
            <h3 class="mm-subhead">Thoughts</h3>
            <form class="mm-thought-form" data-form="thought" data-year="${h(year)}">
              <label class="sr-only" for="thought-text">Add a thought</label>
              <textarea id="thought-text" rows="3" placeholder="What do you remember, or notice now?"></textarea>
              <div class="mm-actions">
                <label class="mm-check"><input type="checkbox" name="about" checked /> About “${h(t.title)}”</label>
                <button type="submit" class="mm-btn mm-btn--primary mm-btn--small">Add thought</button>
              </div>
            </form>
            ${thoughtItems ? `<ul class="mm-thoughts">${thoughtItems}</ul>` : `<p class="mm-muted">No thoughts for ${h(year)} yet.</p>`}
            ${this.explorer ? '' : '<p class="mm-muted mm-small">You\'ll be asked for a name the first time you save, so your words are kept under it.</p>'}
          </section>
        </div>
      </div>`;
  }

  private record(action: 'follow' | 'back' | 'return' | 'view' | 'listen' | 'reflect' | 'year', nodeId: string | null, relId?: string, text?: string): void {
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

    // Historical view (sketch): people branch on to a few of their other works.
    if (this.view === 'history') {
      let count = 0;
      for (const n of shown) {
        if (!this.graph.people.has(n.otherId)) continue;
        const works = this.neighborsOf(n.otherId).filter((m) => this.graph.tracks.has(m.otherId) && !nodes.has(m.otherId)).slice(0, 3);
        for (const m of works) {
          if (count++ >= 15) break;
          nodes.set(m.otherId, { id: m.otherId, role: 'wider' });
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

    const year = !selected && !!this.yearOpen;
    this.stage.classList.toggle('has-year', year);
    const history = this.view === 'history';
    if (selected) {
      this.network.show(this.buildScene(), spawn);
    } else {
      this.network.clear();
      if (history) this.refreshWeb();
      else this.refreshCanvas();
    }
    this.canvas.setVisible(!selected && !history && !year);
    this.web.setVisible(!selected && history);
    this.renderYear();
    this.renderBlurb();
    (document.getElementById('stage-tools') as HTMLElement).hidden = !selected;
    (document.getElementById('zoomctl') as HTMLElement).hidden = this.view !== 'history';
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
          ? matchMedia('(hover: none)').matches
            ? 'Swipe sideways through the years you saved tracks. Covers open up as they pass the middle; tap one to step into that year.'
            : 'Scroll sideways or drag through the years you saved tracks. Hover to open up a stretch of covers; click one to step into that year.'
          : 'Every album in the map as a web, fanned around its artists. Scroll or pinch to zoom, drag to move, click an album to see what it is connected to.';
    } else {
      const total = this.neighborsOf(cur).length;
      const shown = this.expanded.has(cur) ? total : Math.min(total, NEIGHBOR_LIMIT);
      text = `${shown} of ${total} direct connection${total === 1 ? '' : 's'} of ${nameOf(this.graph, cur)}. Select a node to read the connection, then select it again to follow.`;
      if (this.view === 'history') text += ' Recordings are placed by release date; people are not given dates.';
    }
    this.note.textContent = text;
  }

  /**
   * The blurb box from the sketch: a plain account of the selected song built only
   * from its stored relationships and their sources. When a connection is being
   * read, it shows that connection instead, with a way to follow it.
   */
  private renderBlurb(): void {
    const el = document.getElementById('blurb')!;
    const cur = this.currentId;
    if (!cur) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    if (this.inspected) {
      el.innerHTML = this.connectionCard();
      return;
    }
    const node = this.graph.node(cur)!;
    const nbrs = this.graph.neighbors(cur).filter((n) => this.visible(n.otherId));
    const name = (id: string) => h(nameOf(this.graph, id));
    const flag = (n: Neighbor) => (n.rel.evidence.status === 'disputed' ? ' <em class="mm-flag">disputed</em>' : n.rel.evidence.status === 'undocumented' ? ' <em class="mm-flag">unconfirmed</em>' : '');
    const lines: string[] = [];
    let title: string;
    let meta: string;
    if (node.kind === 'track') {
      title = h(node.title);
      const saved = this.graph.savedAt(cur);
      meta = `${h(node.artistCredit)} · <span class="mm-blurb__rel">Released ${formatPartialDate(node.release)}</span>${saved ? ` · <span class="mm-blurb__saved">Saved ${formatSaved(saved)}</span>` : ' · outside your collection'}`;
      for (const n of nbrs.filter((x) => x.rel.type === 'samples' || x.rel.type === 'interpolates')) {
        const other = this.graph.tracks.get(n.otherId);
        const when = other?.release ? ` (${formatPartialDate(other.release)})` : '';
        const verb = n.rel.type === 'samples' ? (n.outgoing ? 'Samples' : 'Sampled on') : n.outgoing ? 'Interpolates' : 'Interpolated on';
        lines.push(`<p><strong>${verb}</strong> “${name(n.otherId)}”${when}${flag(n)}. ${h(n.rel.evidence.explanation)}</p>`);
      }
      const roles = new Map<string, string[]>();
      for (const n of nbrs.filter((x) => x.rel.type === 'credit' && !x.outgoing)) {
        const role = n.rel.role ?? 'credited';
        roles.set(role, [...(roles.get(role) ?? []), nameOf(this.graph, n.otherId)]);
      }
      if (roles.size) lines.push(`<p><strong>Credits</strong> ${[...roles].map(([r, ps]) => `${h(r)}: ${ps.map(h).join(', ')}`).join(' · ')}.</p>`);
      if (node.undocumented?.length) lines.push(`<p class="mm-muted">Not documented: ${node.undocumented.map(h).join(', ')}.</p>`);
      if (!lines.length) lines.push('<p class="mm-muted">No samples, interpolations or detailed credits are recorded for this track yet.</p>');
    } else {
      title = h(node.name);
      meta = node.kind === 'group' ? 'Group' : 'Person';
      const works = nbrs.filter((n) => n.rel.type === 'credit' && n.outgoing);
      if (works.length) lines.push(`<p><strong>Credited on</strong> ${works.slice(0, 8).map((n) => `“${name(n.otherId)}” (${h(n.rel.role ?? 'credit')})`).join(', ')}${works.length > 8 ? `, and ${works.length - 8} more` : ''}.</p>`);
      const groups = nbrs.filter((n) => n.rel.type === 'member_of');
      if (groups.length) lines.push(`<p><strong>${node.kind === 'group' ? 'Members' : 'Member of'}</strong> ${groups.map((n) => name(n.otherId)).join(', ')}.</p>`);
      lines.push('<p class="mm-muted">People are linked to the works they are credited on. Shared credits don\'t imply friendship or influence.</p>');
    }
    const sources = [...new Set(nbrs.map((n) => n.rel.evidence.sourceLabel + (n.rel.evidence.fictional ? ' (fictional)' : '')))];
    const t = node.kind === 'track' ? node : null;
    el.innerHTML = `
      <p class="mm-blurb__eyebrow">${this.path.length > 1 ? 'You are here' : 'Blurb'}</p>
      <h2 class="mm-blurb__title">${title}</h2>
      <p class="mm-blurb__meta">${meta}</p>
      <div class="mm-blurb__body">${lines.join('')}</div>
      ${sources.length ? `<p class="mm-blurb__src">Sources: ${sources.map(h).join(' · ')}</p>` : ''}
      <div class="mm-blurb__actions">
        ${t?.spotify ? `<a class="mm-link" href="${h(t.spotify.url)}" target="_blank" rel="noopener">Play on Spotify ↗</a>` : ''}
        ${t?.spotify ? `<button type="button" class="mm-link" data-action="mb-lookup" data-id="${h(t.id)}">${this.mbStatus.get(t.id) === 'loading' ? 'Looking up…' : 'Find samples &amp; credits (MusicBrainz)'}</button>` : ''}
        <button type="button" class="mm-link" data-action="toggle-panel">${this.panelPinned ? 'Hide' : 'All'} connections &amp; journey</button>
      </div>
      ${t && this.mbStatus.get(t.id) && this.mbStatus.get(t.id) !== 'loading' ? `<p class="mm-muted mm-small">${h(this.mbStatus.get(t.id)!)}</p>` : ''}
      <p class="mm-blurb__hint">Select a connected cover or person to read how it's linked.</p>`;
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
    badge.textContent = demo ? 'Data: fictional demo collection' : 'Data: your Spotify library';
    badge.classList.toggle('is-warning', demo);
    document.getElementById('demo-tag')!.hidden = !demo;
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
    sp.textContent = spotify.isConnected() ? 'Spotify & sources…' : 'Connect Spotify…';
    this.renderConnect();
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
    // On the canvas the panel steps aside; it opens for the map, search, data, replays, or on request.
    const panelOpen = this.panelPinned || !!this.search || this.showData || !!this.replay;
    document.body.classList.toggle('panel-open', panelOpen);
    document.getElementById('panel-btn')!.setAttribute('aria-expanded', `${panelOpen}`);
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
      <h2 class="mm-title">A song has a history before it becomes yours.</h2>
      <p class="mm-muted">Your saves on one timeline; where the songs came from on the other.</p>
      ${demo ? `<p class="mm-notice">Showing fictional demo data. <button type="button" class="mm-link" data-action="open-spotify">Connect Spotify</button></p>` : ''}
      <ul class="mm-keylist mm-keylist--compact">
        <li><span class="mm-swatch mm-swatch--saved"></span>Saved</li>
        <li><span class="mm-swatch mm-swatch--release"></span>Released</li>
        <li><span class="mm-key mm-key--track"></span>Song</li>
        <li><span class="mm-key mm-key--person"></span>Person</li>
        <li><span class="mm-line mm-line--samples"></span>Samples</li>
        <li><span class="mm-line mm-line--interpolates"></span>Interpolates</li>
        <li><span class="mm-line mm-line--credit"></span>Credit</li>
        <li><span class="mm-line mm-line--path"></span>Your path</li>
      </ul>
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
        remote += `<h3 class="mm-subhead">Albums</h3><ul class="mm-list">${r.albums.map((a) => `<li><button type="button" class="mm-result" data-action="sp-album" data-id="${h(a.id)}" data-name="${h(a.name)}" data-artist="${h(a.artist)}">${a.image ? `<img src="${h(a.image)}" alt="" />` : ''}<span><strong>${h(a.name)}</strong><span class="mm-muted">${h(a.artist)} · ${formatPartialDate(a.release)}</span></span></button></li>`).join('')}</ul>`;
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
        return void this.lookupSources(id);
      case 'dismiss-flash':
        this.flash = '';
        return this.renderPanel();
      case 'open-spotify':
        return this.openSpotifyDialog();
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
        return void this.drill(`Songs by ${el.dataset.name}`, () => spotify.artistTracks(el.dataset.name ?? '').then((tracks) => ({ tracks })));
      case 'sp-album':
        return void this.drill(el.dataset.name ?? 'Album', () => spotify.albumTracks(el.dataset.name ?? '', el.dataset.artist ?? '').then((tracks) => ({ tracks })));
      case 'drill-close':
        if (this.search) this.search.drill = undefined;
        return this.renderPanel();
      case 'replay':
        return this.startReplay(id);
      case 'stop-replay':
        return this.stopReplay();
      case 'close-year':
        return this.closeYear();
      case 'year-nav':
        if (this.picked && this.pickedTrack) {
          const featured = this.pickedTrack;
          const rect = this.canvas.rectOf(this.picked) ?? undefined;
          this.unpick();
          return this.openYear(el.dataset.year!, featured, rect);
        }
        return this.openYear(el.dataset.year!, null);
      case 'feature':
        if (this.yearOpen) this.yearOpen.featuredId = id;
        this.renderYear();
        this.yearEl.querySelector<HTMLElement>('#year-feature-title')?.focus();
        return;
      case 'year-history':
        // Step from the personal year into the song's connected history.
        this.returnYear = this.yearOpen;
        this.view = 'history';
        return this.selectOrigin(id, this.yearEl.querySelector('#year-feature-img')?.getBoundingClientRect());
      case 'edit-thought':
        this.editingThought = id;
        this.refreshThoughtViews();
        document.querySelector<HTMLTextAreaElement>('#edit-thought-text')?.focus();
        return;
      case 'cancel-edit':
        this.editingThought = null;
        return this.refreshThoughtViews();
      case 'delete-thought':
        return void this.deleteThought(id, el.dataset.year);
      case 'unpick':
        return this.unpick();
      case 'pick-track':
        if (this.picked) this.pickTile(this.picked, id);
        return;
      case 'pick-history': {
        const rect = this.picked ? this.canvas.rectOf(this.picked) ?? undefined : undefined;
        if (this.picked) this.returnPick = { group: this.picked, track: id };
        this.picked = null;
        this.canvas.setSelected(null);
        this.view = 'history';
        return this.selectOrigin(id, rect);
      }
      case 'mb-lookup':
        return void this.lookupSources(id);
      case 'toggle-panel':
        this.panelPinned = !this.panelPinned;
        return this.render();
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
    if (el.dataset.input === 'year-label' && this.yearOpen) {
      const label = (el as HTMLInputElement).value.trim();
      const data = this.yearData(this.yearOpen.year);
      if ((data.label ?? '') === label) return;
      data.label = label || undefined;
      void this.saveYear(this.yearOpen.year);
      this.refreshCanvas();
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
    this.refreshCanvas();
    this.render();
  }

  /** Asks Genius (when a token is set) and MusicBrainz what they document about a song. */
  private async lookupSources(id: string, quiet = false): Promise<void> {
    const t = this.graph.tracks.get(id);
    if (!t || t.origin === 'demo') return;
    this.mbStatus.set(id, 'loading');
    if (!quiet) this.renderBlurb();
    const known = () => ({
      tracks: [...this.graph.tracks.values()],
      people: this.graph.neighbors(id).map((n) => this.graph.people.get(n.otherId)).filter((p) => !!p),
    });
    const notes: string[] = [];
    if (geniusToken()) {
      try {
        const res = await enrichFromGenius(t, known());
        this.addData(res.data);
        notes.push(res.message);
      } catch (err) {
        notes.push(`Genius: ${(err as Error).message}`);
      }
    }
    try {
      const res = await enrichFromMusicBrainz(t, known().people);
      this.addData(res.data);
      notes.push(`MusicBrainz: ${res.message}`);
    } catch (err) {
      notes.push(`MusicBrainz unreachable (${(err as Error).message})`);
    }
    if (!geniusToken()) notes.push('Add a Genius token (Spotify & sources) for samples, covers and remixes.');
    this.mbStatus.set(id, notes.join(' '));
    const done = new Set<string>(JSON.parse(localStorage.getItem(ENRICHED_KEY) ?? '[]'));
    done.add(id);
    localStorage.setItem(ENRICHED_KEY, JSON.stringify([...done]));
    if (this.path.length) this.render();
  }

  /** Looks up a real song's history automatically the first time it's opened. */
  private async autoEnrich(id: string): Promise<void> {
    const t = this.graph.tracks.get(id);
    if (!t || t.origin === 'demo' || this.mbStatus.get(id) === 'loading') return;
    const done = new Set<string>(JSON.parse(localStorage.getItem(ENRICHED_KEY) ?? '[]'));
    if (done.has(id)) return;
    await this.lookupSources(id, true);
  }

  // ---- Spotify & sources dialog ------------------------------------------------------

  private showHowto(show: boolean): void {
    document.getElementById('howto')!.hidden = !show;
    if (!show) localStorage.setItem(HOWTO_KEY, '1');
  }

  private renderConnect(): void {
    const btn = document.getElementById('connect-btn')!;
    const connected = spotify.isConnected();
    btn.classList.toggle('is-connected', connected);
    btn.innerHTML = connected
      ? `<span class="mm-connect__dot" aria-hidden="true"></span>${h(spotify.profileName() ?? 'Spotify')}`
      : 'Connect Spotify';
    btn.setAttribute('aria-label', connected ? 'Spotify connected: manage' : 'Connect Spotify');
  }

  private openSpotifyDialog(): void {
    const dialog = document.getElementById('spotify-dialog') as HTMLDialogElement;
    this.renderSpotifyDialog();
    if (!dialog.open) dialog.showModal();
  }

  private renderSpotifyDialog(editId = false): void {
    const body = document.getElementById('spotify-dialog-body')!;
    const clientId = spotify.spotifyClientId();
    const connected = spotify.isConnected();
    const hasLib = !!localStorage.getItem(LIBRARY_KEY);
    const imported = localStorage.getItem(IMPORTED_KEY);
    const redirect = spotify.redirectUri();
    let main: string;
    if (!clientId || editId) {
      main = `
        <ol class="mm-steps">
          <li>
            <p><strong>Create a Spotify app</strong> at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> and tick <em>Web API</em>.</p>
          </li>
          <li>
            <p><strong>Add this Redirect URI</strong> to the app:</p>
            <div class="mm-copy"><code>${h(redirect)}</code><button type="button" class="mm-btn mm-btn--small" data-sp="copy">Copy</button></div>
          </li>
          <li>
            <p><strong>Paste the app's Client ID</strong></p>
            <form class="mm-inline-form"><label class="sr-only" for="sp-client">Client ID</label>
              <input id="sp-client" autocomplete="off" spellcheck="false" value="${h(clientId ?? '')}" placeholder="Client ID" />
              <button type="submit" class="mm-btn mm-btn--spotify">Save &amp; connect</button></form>
          </li>
        </ol>
        <p class="mm-muted mm-small">Spotify asks for Premium on development apps, and each listener has to be added under the app's <em>User Management</em>.</p>`;
    } else if (!connected) {
      main = `
        <p>Ready to connect. Spotify will ask you to approve read-only access to your saved songs and the playlists you made.</p>
        <div class="mm-dialog__actions mm-dialog__actions--left">
          <button type="button" class="mm-btn mm-btn--spotify" data-sp="connect">Connect Spotify</button>
          <button type="button" class="mm-link" data-sp="edit-id">Change Client ID</button>
        </div>`;
    } else {
      main = `
        <p class="mm-connected"><span class="mm-connect__dot"></span>Connected${spotify.profileName() ? ` as <strong>${h(spotify.profileName()!)}</strong>` : ''}</p>
        <p class="mm-muted mm-small">${hasLib ? `Library imported${imported ? ` ${formatSaved(imported, true)}` : ''}: ${this.graph.collection.size} saved songs, ${this.graph.playlists.size} playlists.` : 'Library not imported yet.'}${this.graph.playlistsNote ? ` ${h(this.graph.playlistsNote)}` : ''}</p>
        ${this.importStatus ? `<p class="mm-small" role="status">${h(this.importStatus)}</p>` : ''}
        <div class="mm-dialog__actions mm-dialog__actions--left">
          <button type="button" class="mm-btn mm-btn--spotify" data-sp="import">${hasLib ? 'Re-import library' : 'Import library'}</button>
          ${hasLib ? `<button type="button" class="mm-btn" data-sp="${this.datasetKind === 'spotify' ? 'use-demo' : 'use-library'}">${this.datasetKind === 'spotify' ? 'Show demo data' : 'Show my library'}</button>` : ''}
        </div>
        <div class="mm-dialog__actions mm-dialog__actions--left">
          <button type="button" class="mm-link" data-sp="switch">Use a different Spotify account</button>
          <button type="button" class="mm-link" data-sp="disconnect">Disconnect</button>
          <button type="button" class="mm-link" data-sp="edit-id">Change Client ID</button>
        </div>`;
    }
    const token = geniusToken();
    body.innerHTML = `
      <div class="mm-dialog__head"><h2 id="spotify-title">Spotify</h2><button type="button" class="mm-callout__close" data-sp="close" aria-label="Close">×</button></div>
      ${main}
      <hr />
      <h3 class="mm-dialog__sub">Song history sources</h3>
      <p class="mm-muted mm-small"><strong>Genius</strong> adds what songs sample, what sampled them, interpolations, covers, remixes and producer/writer credits. Get a free <em>Client Access Token</em> at <a href="https://genius.com/api-clients" target="_blank" rel="noopener">genius.com/api-clients</a>. It stays in this browser. <strong>MusicBrainz</strong> is used automatically.</p>
      <div class="mm-inline-form"><label class="sr-only" for="genius-token">Genius access token</label>
        <input id="genius-token" type="password" autocomplete="off" spellcheck="false" value="${h(token ?? '')}" placeholder="Genius Client Access Token" />
        <button type="button" class="mm-btn" data-sp="save-genius">${token ? 'Update' : 'Save'}</button></div>`;
  }

  private async handleSpotifyAction(action: string): Promise<void> {
    const dialog = document.getElementById('spotify-dialog') as HTMLDialogElement;
    switch (action) {
      case 'close':
        return dialog.close();
      case 'copy':
        await navigator.clipboard?.writeText(spotify.redirectUri()).catch(() => {});
        this.say('Redirect URI copied.');
        return;
      case 'save-connect': {
        const id = (document.getElementById('sp-client') as HTMLInputElement | null)?.value.trim();
        if (!id) return;
        spotify.saveSpotifyClientId(id);
        spotify.disconnect();
        return spotify.beginLogin().catch((e: Error) => this.say(e.message));
      }
      case 'connect':
        return spotify.beginLogin().catch((e: Error) => this.say(e.message));
      case 'switch':
        spotify.disconnect();
        return spotify.beginLogin(true).catch((e: Error) => this.say(e.message));
      case 'disconnect':
        spotify.disconnect();
        this.useDataset('demo');
        this.renderSpotifyDialog();
        return;
      case 'edit-id':
        return this.renderSpotifyDialog(true);
      case 'import':
        await this.importLibrary();
        return this.renderSpotifyDialog();
      case 'use-demo':
        this.useDataset('demo');
        return this.renderSpotifyDialog();
      case 'use-library':
        this.useDataset('spotify');
        return this.renderSpotifyDialog();
      case 'save-genius':
        saveGeniusToken((document.getElementById('genius-token') as HTMLInputElement).value);
        localStorage.removeItem(ENRICHED_KEY);
        this.say('Genius token saved.');
        return this.renderSpotifyDialog();
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
