// Music Map - Graph index and relationship language
// Merges datasets (demo, Spotify import, MusicBrainz lookups) into one index and
// turns relationships into readable, direction-aware sentences.

import type {
  CollectionEntry,
  Dataset,
  Node,
  PartialDate,
  Person,
  Playlist,
  Relationship,
  Track,
} from './types';
import { songKey } from './spotify';

export interface Neighbor {
  rel: Relationship;
  otherId: string;
  /** True when the relationship points away from the node we asked about. */
  outgoing: boolean;
}

export class MusicGraph {
  readonly tracks = new Map<string, Track>();
  readonly people = new Map<string, Person>();
  readonly rels = new Map<string, Relationship>();
  readonly collection = new Map<string, CollectionEntry>();
  readonly playlists = new Map<string, Playlist>();
  playlistsNote = '';
  private adjacency = new Map<string, Set<string>>();
  datasetName = '';
  fictional = true;

  merge(data: Partial<Dataset>): void {
    if (data.meta) {
      this.datasetName = data.meta.name;
      this.fictional = data.meta.fictional;
    }
    data.tracks?.forEach((t) => this.tracks.set(t.id, t));
    data.people?.forEach((p) => this.people.set(p.id, p));
    data.collection?.forEach((c) => this.collection.set(c.trackId, c));
    data.playlists?.forEach((p) => this.playlists.set(p.id, p));
    if (data.playlistsNote !== undefined) this.playlistsNote = data.playlistsNote;
    data.relationships?.forEach((r) => {
      if (this.rels.has(r.id)) return;
      this.rels.set(r.id, r);
      this.link(r.from, r.id);
      this.link(r.to, r.id);
    });
  }

  clear(): void {
    this.tracks.clear();
    this.people.clear();
    this.rels.clear();
    this.collection.clear();
    this.playlists.clear();
    this.playlistsNote = '';
    this.adjacency.clear();
  }

  private link(nodeId: string, relId: string): void {
    let set = this.adjacency.get(nodeId);
    if (!set) this.adjacency.set(nodeId, (set = new Set()));
    set.add(relId);
  }

  node(id: string): Node | undefined {
    return this.tracks.get(id) ?? this.people.get(id);
  }

  savedAt(trackId: string): string | null {
    return this.collection.get(trackId)?.savedAt ?? null;
  }

  /** Playlists (created by the listener) that contain this track. */
  playlistsFor(trackId: string): Playlist[] {
    const t = this.tracks.get(trackId);
    const key = t ? songKey(t.title, t.artistCredit.split(',')[0].trim()) : '';
    return [...this.playlists.values()].filter((p) => p.trackIds.includes(trackId) || (!!key && !!p.keys?.includes(key)));
  }

  inCollection(trackId: string): boolean {
    return this.collection.has(trackId);
  }

  neighbors(id: string): Neighbor[] {
    const out: Neighbor[] = [];
    this.adjacency.get(id)?.forEach((relId) => {
      const rel = this.rels.get(relId);
      if (!rel) return;
      const outgoing = rel.from === id;
      const otherId = outgoing ? rel.to : rel.from;
      if (this.node(otherId)) out.push({ rel, otherId, outgoing });
    });
    return out.sort((a, b) => relRank(a.rel) - relRank(b.rel) || nameOf(this, a.otherId).localeCompare(nameOf(this, b.otherId)));
  }

  /** Relationship between two nodes, preferring the most specific kind. */
  relBetween(a: string, b: string): Relationship | undefined {
    return this.neighbors(a).find((n) => n.otherId === b)?.rel;
  }

  /** Collection entries (newest last) joined with their tracks. */
  savedTracks(hidden: Set<string> = new Set()): { entry: CollectionEntry; track: Track }[] {
    return [...this.collection.values()]
      .filter((e) => !hidden.has(e.trackId) && this.tracks.has(e.trackId))
      .map((entry) => ({ entry, track: this.tracks.get(entry.trackId)! }))
      .sort((a, b) => a.entry.savedAt.localeCompare(b.entry.savedAt));
  }
}

/** Lower = shown first when a neighbourhood has to be trimmed. */
export function relRank(rel: Relationship): number {
  switch (rel.type) {
    case 'samples':
    case 'interpolates':
      return 0;
    case 'credit':
      if (rel.role === 'primary artist' || rel.role?.startsWith('credited artist')) return 1;
      if (rel.role?.includes('interpolated')) return 1;
      if (rel.role === 'featured artist') return 2;
      if (rel.role === 'producer') return 3;
      if (rel.role?.startsWith('writer') || rel.role?.startsWith('composer')) return 4;
      return 5;
    case 'member_of':
      return 2;
    case 'collaboration':
      return 3;
    default:
      return 6;
  }
}

export function nameOf(graph: MusicGraph, id: string): string {
  const n = graph.node(id);
  if (!n) return 'Unknown';
  return n.kind === 'track' ? n.title : n.name;
}

// ---- Relationship language ----------------------------------------------

/** Short edge label, read in the stored direction (from → to). */
export function edgeLabel(rel: Relationship): string {
  switch (rel.type) {
    case 'samples':
      return 'samples';
    case 'interpolates':
      return 'interpolates';
    case 'credit':
      return rel.role ?? 'credited';
    case 'member_of':
      return 'member of';
    case 'collaboration':
      return rel.role ?? 'shared credits';
    default:
      return rel.role ?? 'related';
  }
}

export function isDirected(rel: Relationship): boolean {
  return rel.type !== 'collaboration';
}

const q = (s: string) => `“${s}”`;

/** A full sentence describing the relationship, starting from `fromId` when possible. */
export function relSentence(graph: MusicGraph, rel: Relationship, fromId?: string): string {
  const a = nameOf(graph, rel.from);
  const b = nameOf(graph, rel.to);
  const reversed = fromId === rel.to;
  switch (rel.type) {
    case 'samples':
      return reversed
        ? `The recording ${q(b)} is sampled on ${q(a)}.`
        : `${q(a)} samples the recording ${q(b)}.`;
    case 'interpolates':
      return reversed
        ? `The composition of ${q(b)} is interpolated (re-performed) on ${q(a)}.`
        : `${q(a)} interpolates the composition of ${q(b)} — it is re-performed, not sampled.`;
    case 'credit':
      return reversed
        ? `${q(b)} credits ${a} as ${rel.role ?? 'a contributor'}.`
        : `${a} is credited as ${rel.role ?? 'a contributor'} on ${q(b)}.`;
    case 'member_of':
      return `${a} is listed as a member of ${b}${rel.role ? ` (${rel.role})` : ''}.`;
    case 'collaboration':
      return `${a} and ${b} have ${rel.role ?? 'shared credits'}.`;
    default:
      return `${a} → ${rel.role ?? 'related to'} → ${b}.`;
  }
}

/** Label for a neighbour, phrased from the current node's point of view. */
export function neighborPhrase(n: Neighbor): string {
  const r = n.rel;
  switch (r.type) {
    case 'samples':
      return n.outgoing ? 'Samples' : 'Sampled on';
    case 'interpolates':
      return n.outgoing ? 'Interpolates the composition of' : 'Composition interpolated on';
    case 'credit':
      return n.outgoing ? `Credited as ${r.role} on` : capitalize(r.role ?? 'credited');
    case 'member_of':
      return n.outgoing ? 'Member of' : 'Member';
    case 'collaboration':
      return `Shared credits with (${r.role ?? ''})`.replace(' ()', '');
    default:
      return capitalize(r.role ?? 'related');
  }
}

export function groupLabel(n: Neighbor): string {
  switch (n.rel.type) {
    case 'samples':
      return n.outgoing ? 'Samples' : 'Sampled on';
    case 'interpolates':
      return n.outgoing ? 'Interpolates' : 'Interpolated on';
    case 'credit':
      return n.outgoing ? 'Credited on' : 'Credits';
    case 'member_of':
      return n.outgoing ? 'Groups' : 'Members';
    case 'collaboration':
      return 'Repeated collaborators';
    default:
      return 'Other documented relationships';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- Dates ----------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatPartialDate(d: PartialDate | null | undefined): string {
  if (!d) return 'Unknown';
  const [y, m, day] = d.value.split('-').map(Number);
  if (d.precision === 'year' || !m) return `${y}`;
  if (d.precision === 'month' || !day) return `${MONTHS[m - 1]} ${y}`;
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

export function precisionNote(d: PartialDate | null | undefined): string {
  if (!d) return 'No release date in the source';
  if (d.precision === 'year') return 'Year only';
  if (d.precision === 'month') return 'Month only';
  return '';
}

export function formatSaved(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  const base = `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
  return withTime
    ? `${base}, ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : base;
}

export function formatMonth(ms: number): string {
  const dt = new Date(ms);
  return `${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** Start and end of the period a partial date covers, as fractional years. */
export function partialDateSpan(d: PartialDate): [number, number] {
  const [y, m, day] = d.value.split('-').map(Number);
  if (d.precision === 'year' || !m) return [y, y + 1];
  if (d.precision === 'month' || !day) return [y + (m - 1) / 12, y + m / 12];
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  const f = (Date.UTC(y, m - 1, day) - start) / (end - start);
  return [y + f, y + f + 1 / 365];
}
