// Music Map - Recording a sequence of exploration
// Every selection, followed relationship, step back and return is recorded as a
// step. Journeys carry small snapshots of the nodes they visit so they can be read
// (and replayed, when the data is present) by other explorers later.

import { formatPartialDate, formatSaved, nameOf, relSentence, type MusicGraph } from './graph';
import type { Store } from './store';
import type { Journey, JourneyStep, NodeSnapshot, ViewMode } from './types';

export interface PathStep {
  nodeId: string;
  /** Relationship crossed to reach this node (absent for the origin). */
  relId?: string;
}

export type SaveStatus = { state: 'idle' | 'saving' | 'saved' | 'error'; at?: Date; message?: string };

export class JourneyRecorder {
  journey: Journey | null = null;
  private timer: number | null = null;

  private graph: MusicGraph;
  private store: () => Store;
  private onStatus: (s: SaveStatus) => void;

  constructor(graph: MusicGraph, store: () => Store, onStatus: (s: SaveStatus) => void) {
    this.graph = graph;
    this.store = store;
    this.onStatus = onStatus;
  }

  start(explorer: string, originId: string, view: ViewMode): void {
    this.flush();
    const now = new Date().toISOString();
    this.journey = {
      id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      explorer,
      startedAt: now,
      updatedAt: now,
      originId,
      steps: [],
      nodes: {},
      relLabels: {},
      scene: '',
      dataset: this.graph.datasetName,
    };
    this.record({ action: 'select', nodeId: originId, view });
  }

  /** Adopt an explorer name chosen after the journey started. */
  setExplorer(name: string): void {
    if (this.journey) this.journey.explorer = name;
  }

  record(step: Omit<JourneyStep, 'at'>): void {
    const j = this.journey;
    if (!j) return;
    j.steps.push({ ...step, at: new Date().toISOString() });
    j.nodes[step.nodeId] ??= this.snapshot(step.nodeId);
    if (step.relId) {
      const rel = this.graph.rels.get(step.relId);
      if (rel) {
        j.relLabels[step.relId] = relSentence(this.graph, rel);
        j.nodes[rel.from] ??= this.snapshot(rel.from);
        j.nodes[rel.to] ??= this.snapshot(rel.to);
      }
    }
    this.schedule();
  }

  update(fields: Partial<Pick<Journey, 'reflection' | 'description' | 'scene'>>): void {
    if (!this.journey) return;
    Object.assign(this.journey, fields);
    this.schedule();
  }

  private snapshot(id: string): NodeSnapshot {
    const n = this.graph.node(id);
    if (!n) return { id, kind: 'track', name: 'Unknown' };
    if (n.kind === 'track') {
      return {
        id,
        kind: 'track',
        name: n.title,
        artistCredit: n.artistCredit,
        release: n.release,
        savedAt: this.graph.savedAt(id),
        cover: n.cover.kind === 'image' ? n.cover : { kind: 'generated', seed: n.cover.seed },
      };
    }
    return { id, kind: n.kind, name: n.name };
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), 700);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const j = this.journey;
    if (!j || !j.steps.length) return;
    j.updatedAt = new Date().toISOString();
    this.onStatus({ state: 'saving' });
    this.store()
      .saveJourney(j)
      .then(() => this.onStatus({ state: 'saved', at: new Date() }))
      .catch((err: Error) => this.onStatus({ state: 'error', message: err.message }));
  }
}

/** A plain, factual description of what is on screen — no interpretation. */
export function describeScene(graph: MusicGraph, path: PathStep[], view: ViewMode): string {
  if (!path.length) return 'Browsing the timeline; nothing selected.';
  const origin = graph.node(path[0].nodeId);
  const parts: string[] = [];
  parts.push(view === 'timeline' ? 'View: My timeline (dates saved).' : 'View: Music history (release dates).');
  if (origin?.kind === 'track') {
    const saved = graph.savedAt(origin.id);
    parts.push(
      `Started from “${origin.title}” by ${origin.artistCredit} — ${saved ? `saved ${formatSaved(saved)}` : 'outside the collection'}, released ${formatPartialDate(origin.release)}.`,
    );
  } else if (origin) {
    parts.push(`Started from ${origin.name}.`);
  }
  if (path.length > 1) {
    const route = path
      .map((p, i) => {
        const name = nameOf(graph, p.nodeId);
        if (!i || !p.relId) return name;
        const rel = graph.rels.get(p.relId);
        const label = rel ? (rel.type === 'credit' ? rel.role : rel.type.replace('_', ' ')) : 'related';
        return `(${label}) ${name}`;
      })
      .join(' → ');
    parts.push(`Route: ${route}.`);
  }
  return parts.join(' ');
}

/** Rebuilds the path a journey ended on by replaying its steps. */
export function pathAfter(steps: JourneyStep[], upto = steps.length): { path: PathStep[]; view: ViewMode } {
  let path: PathStep[] = [];
  let view: ViewMode = 'timeline';
  for (const s of steps.slice(0, upto)) {
    view = s.view;
    if (s.action === 'select') path = [{ nodeId: s.nodeId }];
    else if (s.action === 'follow') path.push({ nodeId: s.nodeId, relId: s.relId });
    else if (s.action === 'back' || s.action === 'return') {
      const i = path.findIndex((p) => p.nodeId === s.nodeId);
      if (i >= 0) path = path.slice(0, i + 1);
    }
  }
  return { path, view };
}
