// Music Map - Data model
// Tracks, people, collection entries and relationships are kept as separate
// entities so each can be replaced independently (e.g. a Spotify import supplies
// collection entries; a credits source supplies relationships).

/** A date that may only be known to the year or month. */
export type DatePrecision = 'year' | 'month' | 'day';

export interface PartialDate {
  /** ISO prefix matching the precision: "1974", "1974-06" or "1974-06-03". */
  value: string;
  precision: DatePrecision;
}

export type Origin = 'demo' | 'spotify' | 'musicbrainz';

export type Cover =
  | { kind: 'generated'; seed: string }
  | { kind: 'image'; url: string };

export interface Track {
  id: string;
  kind: 'track';
  title: string;
  /** Display credit as printed, e.g. "June Okafor-Lind feat. Dashiell Rook". */
  artistCredit: string;
  /** Release date of this recording. null = unknown; never guessed. */
  release: PartialDate | null;
  releaseNote?: string;
  cover: Cover;
  genres: string[];
  origin: Origin;
  /** Credit roles the source says nothing about, shown as "Not documented". */
  undocumented?: string[];
  spotify?: { id: string; url: string; uri: string; isrc?: string };
  musicbrainzId?: string;
}

export interface Person {
  id: string;
  kind: 'person' | 'group';
  name: string;
  origin: Origin;
  description?: string;
  spotify?: { id: string; url: string };
  musicbrainzId?: string;
}

export type Node = Track | Person;

/** A track the listener saved. Holds the saved date — nothing about when they first heard it. */
export interface CollectionEntry {
  trackId: string;
  /** ISO datetime the save was recorded. */
  savedAt: string;
  source: 'demo' | 'spotify';
}

export type RelType =
  | 'samples' // recording → recording it samples
  | 'interpolates' // recording → recording whose composition it re-performs
  | 'credit' // person → track, with a role
  | 'member_of' // person → group
  | 'collaboration' // person ↔ person, repeated credited collaboration
  | 'documented'; // other relationship type named verbatim by a source

export type EvidenceStatus = 'documented' | 'disputed' | 'undocumented';

export interface Evidence {
  status: EvidenceStatus;
  /** True for the invented demo dataset: there is no real-world reference. */
  fictional: boolean;
  sourceLabel: string;
  sourceUrl?: string;
  /** One or two sentences explaining the connection. */
  explanation: string;
  /** What is uncertain, when status is not "documented". */
  caveat?: string;
}

export interface Relationship {
  id: string;
  type: RelType;
  from: string;
  to: string;
  /** Credit role ("producer"), membership years, or a source's own relationship name. */
  role?: string;
  evidence: Evidence;
}

export interface Dataset {
  meta: { name: string; fictional: boolean; description: string };
  tracks: Track[];
  people: Person[];
  collection: CollectionEntry[];
  relationships: Relationship[];
}

// ---- Views, journeys and user data -------------------------------------

export type ViewMode = 'timeline' | 'history';

/** One recorded moment in an exploration. */
export interface JourneyStep {
  at: string;
  action: 'select' | 'follow' | 'back' | 'return' | 'view' | 'listen' | 'reflect';
  nodeId: string;
  /** Relationship crossed to reach nodeId (for "follow"). */
  relId?: string;
  view: ViewMode;
  text?: string;
}

/** Just enough of a node to redraw a journey without the original library. */
export interface NodeSnapshot {
  id: string;
  kind: Node['kind'];
  name: string;
  artistCredit?: string;
  release?: PartialDate | null;
  savedAt?: string | null;
  cover?: Cover;
}

export interface Journey {
  id: string;
  explorer: string;
  startedAt: string;
  updatedAt: string;
  originId: string;
  steps: JourneyStep[];
  nodes: Record<string, NodeSnapshot>;
  relLabels: Record<string, string>;
  /** Generated, factual description of the scene when last saved. */
  scene: string;
  /** Optional words the explorer wrote about this route. */
  description?: string;
  /** Answer to "What do you notice now?" — optional, never scored. */
  reflection?: string;
  dataset: string;
}

export interface ExplorerData {
  notes: Record<string, string>;
  hidden: string[];
}
