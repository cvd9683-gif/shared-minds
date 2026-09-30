// Music Map - Local network around a track, in either date system
// "My timeline": relationship layout. The original track holds a fixed spot, the
//   path you followed runs to its right, and the current node's connections gather
//   around it.
// "Music history": recordings sit on a release-date axis. People have their own
//   lane below it and are never given a date.

import { coverUrl, seeded } from './covers';
import { escapeHtml } from './canvas';
import {
  edgeLabel,
  formatPartialDate,
  formatSaved,
  isDirected,
  partialDateSpan,
  type MusicGraph,
} from './graph';
import type { Node, Relationship, ViewMode } from './types';

export type NodeRole = 'origin' | 'current' | 'path' | 'neighbor' | 'wider' | 'overview';
export type EdgeEmphasis = 'path' | 'focus' | 'faint' | 'wider';

export interface SceneNode {
  id: string;
  role: NodeRole;
}
export interface SceneEdge {
  rel: Relationship;
  emphasis: EdgeEmphasis;
  /** Combined label when several relationships join the same pair. */
  label?: string;
}
export interface Scene {
  mode: ViewMode;
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Ordered path, origin first. */
  path: string[];
  inspectedId: string | null;
  inspectedRelId: string | null;
}

export interface NetworkCallbacks {
  onActivate(id: string): void;
  onHover(id: string | null, el: HTMLElement | null): void;
}

interface Pt {
  x: number;
  y: number;
}

interface SimNode extends Pt {
  id: string;
  vx: number;
  vy: number;
  r: number;
  fixed?: boolean;
  fixX?: boolean;
  tx?: number;
  ty?: number;
  kx?: number;
  ky?: number;
}

interface Drawn {
  el: HTMLButtonElement;
  role: NodeRole;
  size: number;
}

const EASE = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class NetworkView {
  private drawn = new Map<string, Drawn>();
  private shown = new Map<string, Pt>();
  private from = new Map<string, Pt>();
  private to = new Map<string, Pt>();
  private scene: Scene | null = null;
  private width = 800;
  private height = 600;
  private anim: number | null = null;
  private hoverId: string | null = null;
  private reducedMotion = false;
  private labelsEl: HTMLDivElement;
  /** Camera for the web: every layer is drawn in world space, then zoomed and panned. */
  private view = { k: 1, tx: 0, ty: 0 };
  private userMoved = false;
  /** Nodes you've dragged stay where you put them. */
  private manual = new Map<string, Pt>();
  private dragMoved = false;

  private nodesEl: HTMLElement;
  private svg: SVGSVGElement;
  private axisEl: HTMLElement;
  private graph: MusicGraph;
  private cb: NetworkCallbacks;

  constructor(nodesEl: HTMLElement, svg: SVGSVGElement, axisEl: HTMLElement, graph: MusicGraph, cb: NetworkCallbacks) {
    this.nodesEl = nodesEl;
    this.svg = svg;
    this.axisEl = axisEl;
    this.graph = graph;
    this.cb = cb;
    this.labelsEl = document.createElement('div');
    this.labelsEl.className = 'mm-edge-labels';
    this.labelsEl.setAttribute('aria-hidden', 'true');
    nodesEl.before(this.labelsEl);
    svg.innerHTML = `<defs>${['ink', 'path', 'faint'].map(
      (k) => `<marker id="mm-arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" class="mm-arrow mm-arrow--${k}"/></marker>`,
    ).join('')}</defs><g class="mm-edges__g"></g>`;
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (this.scene) this.show(this.scene, undefined, true);
  }

  /** Screen rect of a drawn node's image, for handing the anchor back to the field. */
  rectOf(id: string): DOMRect | null {
    const d = this.drawn.get(id);
    return d ? (d.el.querySelector('.mm-node__art') ?? d.el).getBoundingClientRect() : null;
  }

  focusNode(id: string): void {
    this.drawn.get(id)?.el.focus({ preventScroll: true });
  }

  clear(): void {
    this.scene = null;
    this.manual.clear();
    this.setView(1, 0, 0, false);
    this.userMoved = false;
    this.drawn.forEach((d) => d.el.remove());
    this.drawn.clear();
    this.shown.clear();
    this.svg.querySelector('.mm-edges__g')!.innerHTML = '';
    this.labelsEl.innerHTML = '';
    this.axisEl.innerHTML = '';
    this.axisEl.hidden = true;
  }

  /**
   * Draws a scene. `spawn` lets a node grow out of a screen rect (e.g. the cover
   * that was clicked in the timeline field) so the selection stays traceable.
   */
  show(scene: Scene, spawn?: { id: string; rect: DOMRect }, instant = false): void {
    this.scene = scene;
    const stageRect = this.nodesEl.getBoundingClientRect();
    const web = scene.mode === 'history';
    const newNodes = scene.nodes.some((n) => !this.drawn.has(n.id));
    const targets = web ? this.layoutWeb(scene) : this.layoutRelations(scene);

    // Create, update and remove node elements.
    const keep = new Set(scene.nodes.map((n) => n.id));
    this.drawn.forEach((d, id) => {
      if (!keep.has(id)) {
        d.el.remove();
        this.drawn.delete(id);
        this.shown.delete(id);
      }
    });
    const currentId = scene.path[scene.path.length - 1];
    for (const sn of scene.nodes) {
      const node = this.graph.node(sn.id);
      if (!node) continue;
      let d = this.drawn.get(sn.id);
      if (!d) {
        const el = document.createElement('button');
        el.type = 'button';
        el.dataset.id = sn.id;
        el.addEventListener('click', (ev) => {
          if (this.dragMoved) return ev.preventDefault();
          this.cb.onActivate(sn.id);
        });
        this.bindDrag(el, sn.id);
        el.addEventListener('pointerenter', () => this.setHover(sn.id, el));
        el.addEventListener('pointerleave', () => this.setHover(null, null));
        el.addEventListener('focus', () => this.setHover(sn.id, el));
        el.addEventListener('blur', () => this.setHover(null, null));
        this.nodesEl.appendChild(el);
        d = { el, role: sn.role, size: 0 };
        this.drawn.set(sn.id, d);
        // New nodes grow out of the spawn rect, the current node, or their target.
        const start =
          spawn?.id === sn.id
            ? this.toWorld(spawn.rect.left - stageRect.left + spawn.rect.width / 2, spawn.rect.top - stageRect.top + spawn.rect.height / 2)
            : (this.shown.get(currentId) ?? targets.get(currentId) ?? targets.get(sn.id)!);
        this.shown.set(sn.id, { ...start });
        if (spawn?.id === sn.id) d.el.style.setProperty('--spawn', `${spawn.rect.width}px`);
      }
      d.role = sn.role;
      d.size = nodeSize(node, sn.role, scene.mode === 'history');
      this.renderNode(d, node, sn, scene);
    }

    // The historical view is a web now: no date axis; the camera frames the whole web.
    this.renderAxis({ ...scene, mode: 'timeline' });
    if (web && (newNodes || !this.userMoved)) {
      this.userMoved = false;
      this.fit(targets, !(instant || this.reducedMotion));
    } else if (!web) {
      this.setView(1, 0, 0, !(instant || this.reducedMotion));
    }

    // Animate from where things are to where they should be.
    this.from = new Map([...this.shown].map(([k, v]) => [k, { ...v }]));
    this.to = targets;
    if (this.anim) cancelAnimationFrame(this.anim);
    const duration = instant || this.reducedMotion ? 0 : 720;
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = duration ? Math.min(1, (now - t0) / duration) : 1;
      const e = EASE(t);
      this.to.forEach((p, id) => {
        const a = this.from.get(id) ?? p;
        this.shown.set(id, { x: a.x + (p.x - a.x) * e, y: a.y + (p.y - a.y) * e });
      });
      this.paint();
      if (t < 1) this.anim = requestAnimationFrame(frame);
      else {
        this.anim = null;
        this.drawn.forEach((d) => d.el.style.removeProperty('--spawn'));
      }
    };
    this.anim = requestAnimationFrame(frame);
  }

  // ---- Dragging nodes -------------------------------------------------------------

  /** In the web, any node can be picked up and moved; its lines follow. */
  private bindDrag(el: HTMLElement, id: string): void {
    let start: { x: number; y: number; px: number; py: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (this.scene?.mode !== 'history' || e.button !== 0) return;
      const p = this.shown.get(id);
      if (!p) return;
      start = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
      this.dragMoved = false;
      el.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = (e.clientX - start.x) / this.view.k;
      const dy = (e.clientY - start.y) / this.view.k;
      if (!this.dragMoved && Math.hypot(dx, dy) * this.view.k < 5) return;
      this.dragMoved = true;
      el.classList.add('is-dragging');
      const p = { x: start.px + dx, y: start.py + dy };
      this.shown.set(id, p);
      this.to.set(id, p);
      this.manual.set(id, p);
      if (this.anim) {
        cancelAnimationFrame(this.anim);
        this.anim = null;
      }
      this.paint();
    });
    const end = () => {
      if (!start) return;
      start = null;
      el.classList.remove('is-dragging');
      setTimeout(() => (this.dragMoved = false), 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---- Camera (zoom and pan) --------------------------------------------------------

  /** Wheel or pinch to zoom, drag the background to pan (historical web only). */
  bindCamera(stage: HTMLElement): void {
    const active = () => this.scene?.mode === 'history';
    const isBackground = (t: EventTarget | null) =>
      !(t as HTMLElement).closest('.mm-node, .mm-blurb, .mm-pathbar, .mm-zoomctl, .mm-stage-tools, .mm-howto, button, a, input, textarea');
    stage.addEventListener(
      'wheel',
      (e) => {
        if (!active() || (e.target as HTMLElement).closest('.mm-blurb, .mm-panel')) return;
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        // Pinch on a trackpad arrives as a ctrl+wheel; scroll pans.
        if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) {
          this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), e.clientX - r.left, e.clientY - r.top, false);
        } else {
          this.panBy(-e.deltaX, -e.deltaY);
        }
      },
      { passive: false },
    );
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    stage.addEventListener('pointerdown', (e) => {
      if (!active() || !isBackground(e.target)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('is-panning');
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    stage.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = stage.getBoundingClientRect();
        if (pinch) this.zoomBy(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, false);
        pinch = d;
      } else {
        this.panBy(e.clientX - prev.x, e.clientY - prev.y);
      }
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (!pointers.size) stage.classList.remove('is-panning');
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  private toWorld(x: number, y: number): Pt {
    return { x: (x - this.view.tx) / this.view.k, y: (y - this.view.ty) / this.view.k };
  }

  private setView(k: number, tx: number, ty: number, animate: boolean): void {
    this.view = { k, tx, ty };
    const t = `translate(${tx}px, ${ty}px) scale(${k})`;
    for (const el of [this.nodesEl, this.svg as unknown as HTMLElement, this.labelsEl]) {
      el.style.transformOrigin = '0 0';
      el.style.transition = animate ? 'transform 0.7s cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
      el.style.transform = t;
    }
    this.nodesEl.parentElement?.style.setProperty('--zoom', `${k}`);
  }

  /** Zooms by a factor around a point in stage coordinates. */
  zoomBy(factor: number, cx = this.width / 2, cy = this.height / 2, animate = true): void {
    const k = Math.max(0.25, Math.min(2.6, this.view.k * factor));
    const f = k / this.view.k;
    this.userMoved = true;
    this.setView(k, cx - (cx - this.view.tx) * f, cy - (cy - this.view.ty) * f, animate);
  }

  panBy(dx: number, dy: number): void {
    this.userMoved = true;
    this.setView(this.view.k, this.view.tx + dx, this.view.ty + dy, false);
  }

  /** Frames every node, leaving room for the path bar and labels. */
  fit(targets: Map<string, Pt> = this.to, animate = true): void {
    if (!targets.size) return;
    // Frame the song and its direct connections; the outer ring is a zoom-out away.
    const core = this.scene?.nodes.filter((n) => n.role !== 'wider').map((n) => n.id) ?? [];
    if (core.length >= 4) targets = new Map([...targets].filter(([id]) => core.includes(id)));
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    targets.forEach((p, id) => {
      const r = (this.drawn.get(id)?.size ?? 40) / 2;
      x0 = Math.min(x0, p.x - r - 60);
      x1 = Math.max(x1, p.x + r + 60);
      y0 = Math.min(y0, p.y - r - 10);
      y1 = Math.max(y1, p.y + r + 46);
    });
    // Leave room for the blurb on the left on wide screens.
    const left = this.width < 700 ? 12 : this.width > 1000 ? 420 : 40;
    const top = 64;
    const aw = this.width - left - 70;
    const ah = this.height - top - 24;
    const k = Math.max(0.25, Math.min(1.25, aw / (x1 - x0), ah / (y1 - y0)));
    const tx = left + (aw - (x1 - x0) * k) / 2 - x0 * k;
    const ty = top + (ah - (y1 - y0) * k) / 2 - y0 * k;
    this.userMoved = false;
    this.setView(k, tx, ty, animate);
  }

  private setHover(id: string | null, el: HTMLElement | null): void {
    this.hoverId = id;
    this.cb.onHover(id, el);
    // Light up what the hovered node is connected to; fade the rest.
    const related = new Set<string>();
    if (id && this.scene) {
      related.add(id);
      for (const e of this.scene.edges) {
        if (e.rel.from === id) related.add(e.rel.to);
        if (e.rel.to === id) related.add(e.rel.from);
      }
    }
    this.nodesEl.parentElement?.classList.toggle('has-hover', !!id);
    this.drawn.forEach((d, nid) => d.el.classList.toggle('is-related', related.has(nid)));
    this.paintEdges();
  }

  // ---- Node rendering -------------------------------------------------------

  private renderNode(d: Drawn, node: Node, sn: SceneNode, scene: Scene): void {
    const el = d.el;
    const isTrack = node.kind === 'track';
    const history = scene.mode === 'history';
    el.className = [
      'mm-node',
      `mm-node--${node.kind}`,
      `is-${sn.role}`,
      scene.inspectedId === sn.id ? 'is-inspected' : '',
      isTrack && !this.graph.inCollection(node.id) ? 'is-outside' : '',
      scene.path.includes(sn.id) ? 'on-path' : '',
    ].join(' ');
    el.style.setProperty('--s', `${d.size}px`);
    el.tabIndex = sn.role === 'wider' ? -1 : 0;

    if (sn.role === 'wider') {
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = isTrack
        ? `<span class="mm-node__art"><img alt="" src="${coverUrl(node.cover, node.title)}" draggable="false" /></span><span class="mm-node__label mm-node__label--small"><span class="mm-node__name">${escapeHtml(node.title)}</span></span>`
        : history
          ? `<span class="mm-node__art"><span class="mm-node__initials">${escapeHtml(initials(node.name))}</span></span><span class="mm-node__label mm-node__label--person"><span class="mm-node__name">${escapeHtml(node.name)}</span></span>`
          : `<span class="mm-node__art"></span>`;
      return;
    }
    el.removeAttribute('aria-hidden');

    const name = isTrack ? node.title : node.name;
    let meta = '';
    let span = '';
    if (isTrack) {
      const saved = this.graph.savedAt(node.id);
      const savedTxt = saved ? `<span class="mm-meta--saved">Saved ${formatSaved(saved)}</span>` : `<span class="mm-meta--outside">Outside your collection</span>`;
      const relTxt = `<span class="mm-meta--release">${node.release ? `Released ${formatPartialDate(node.release)}` : 'Release date unknown'}</span>`;
      meta = history
        ? // One short line: when it came out, and whether you saved it.
          `<span class="mm-meta--release">${node.release ? node.release.value.slice(0, 4) : 'Date unknown'}${saved ? '' : ' · not saved'}</span>`
        : `<span>${escapeHtml(node.artistCredit)}</span>${sn.role === 'overview' ? '' : savedTxt}`;
      void relTxt;
      if (history && this.axis && node.release && node.release.precision !== 'day') {
        const [a, b] = partialDateSpan(node.release);
        const w = Math.max(4, this.scaleX(b) - this.scaleX(a));
        span = `<span class="mm-node__span" style="width:${w}px" title="${node.release.precision === 'year' ? 'Only the year is known' : 'Only the month is known'}"></span>`;
      }
    } else if (history) {
      // What this person did on the song you're looking at, written on the person.
      const cur = scene.path[scene.path.length - 1];
      const roles = [
        ...new Set(
          this.graph
            .neighbors(node.id)
            .filter((n) => n.otherId === cur && n.rel.type === 'credit')
            .map((n) => shortRole(n.rel.role)),
        ),
      ];
      meta = `<span class="mm-meta--role">${escapeHtml(roles.length ? roles.slice(0, 3).join(' · ') : node.kind === 'group' ? 'Group' : 'Person')}</span>`;
    } else {
      meta = `<span>${node.kind === 'group' ? 'Group' : 'Person'}</span>`;
    }
    const art = isTrack
      ? `<img alt="" src="${coverUrl(node.cover, node.title)}" draggable="false" />`
      : `<span class="mm-node__initials">${escapeHtml(initials(name))}</span>`;
    const badge = sn.role === 'origin' ? '<span class="mm-node__badge">Start</span>' : '';
    el.innerHTML = `
      <span class="mm-node__art">${art}${badge}</span>${span}
      <span class="mm-node__label"><span class="mm-node__name">${escapeHtml(name)}</span>${sn.role === 'overview' ? '' : `<span class="mm-node__meta">${meta}</span>`}</span>`;
    el.setAttribute(
      'aria-label',
      isTrack
        ? `${name} by ${node.artistCredit}. ${node.release ? `Released ${formatPartialDate(node.release)}` : 'Release date unknown'}. ${this.graph.savedAt(node.id) ? `Saved ${formatSaved(this.graph.savedAt(node.id))}` : 'Outside your collection'}.${sn.role === 'origin' ? ' Your starting track.' : ''}`
        : `${name}, ${node.kind}.`,
    );
  }

  // ---- Painting -------------------------------------------------------------

  private paint(): void {
    this.drawn.forEach((d, id) => {
      const p = this.shown.get(id);
      if (!p) return;
      d.el.style.transform = `translate(${p.x - d.size / 2}px, ${p.y - d.size / 2}px)`;
    });
    this.paintEdges();
  }

  private paintEdges(): void {
    if (!this.scene) return;
    const g = this.svg.querySelector('.mm-edges__g')!;
    let svg = '';
    let labels = '';
    for (const e of this.scene.edges) {
      const a = this.shown.get(e.rel.from);
      const b = this.shown.get(e.rel.to);
      const da = this.drawn.get(e.rel.from);
      const db = this.drawn.get(e.rel.to);
      if (!a || !b || !da || !db) continue;
      const hovered = this.hoverId !== null && (e.rel.from === this.hoverId || e.rel.to === this.hoverId);
      const inspected = this.scene.inspectedRelId === e.rel.id;
      const geo = curve(a, b, da.size / 2 + 6, db.size / 2 + 8, e.rel.id);
      if (!geo) continue;
      const st = e.rel.evidence.status;
      const cls = [
        'mm-edge',
        `mm-edge--${e.rel.type}`,
        `is-${e.emphasis}`,
        hovered ? 'is-hover' : '',
        inspected ? 'is-inspected' : '',
        st !== 'documented' ? `is-${st}` : '',
      ].join(' ');
      const marker = isDirected(e.rel)
        ? `marker-end="url(#mm-arrow-${e.emphasis === 'path' || inspected ? 'path' : e.emphasis === 'focus' || hovered ? 'ink' : 'faint'})"`
        : '';
      svg += `<path class="${cls}" d="${geo.d}" ${marker}/>`;
      // Roles are written on the people, so credit lines stay unlabelled unless hovered.
      const showLabel = hovered || inspected || e.emphasis === 'path' || (e.emphasis === 'focus' && e.rel.type !== 'credit');
      if (showLabel && e.emphasis !== 'wider') {
        const flag = st === 'disputed' ? ' · disputed' : st === 'undocumented' ? ' · unconfirmed' : '';
        labels += `<span class="mm-edge-label ${cls}" style="transform:translate(${geo.mid.x}px, ${geo.mid.y}px) translate(-50%, -50%)">${escapeHtml(shortRole(e.label ?? edgeLabel(e.rel)))}${flag ? `<em>${flag}</em>` : ''}</span>`;
      }
    }
    g.innerHTML = svg;
    this.labelsEl.innerHTML = labels;
  }

  // ---- Layouts ----------------------------------------------------------------

  /**
   * Historical view as a web: the current song at the centre, its connections in a
   * ring, and their own connections (other works, samples of samples) further out.
   */
  private layoutWeb(scene: Scene): Map<string, Pt> {
    const W = this.width;
    const H = this.height;
    const currentId = scene.path[scene.path.length - 1];
    const center = this.toWorld(W < 700 ? W / 2 : W * 0.58, H * 0.52);
    const ring = scene.nodes.filter((n) => n.role !== 'wider' && n.id !== currentId);
    // Each outer node hangs from a node it's linked to.
    const bridge = new Map<string, string>();
    for (const e of scene.edges) {
      const a = scene.nodes.find((n) => n.id === e.rel.from);
      const b = scene.nodes.find((n) => n.id === e.rel.to);
      if (a?.role === 'wider' && b && b.role !== 'wider') bridge.set(a.id, b.id);
      if (b?.role === 'wider' && a && a.role !== 'wider') bridge.set(b.id, a.id);
    }
    const ringPos = new Map<string, Pt>();
    ring.forEach((n, i) => {
      const ang = -Math.PI / 2 + ((i + 0.5) / Math.max(1, ring.length)) * Math.PI * 2;
      ringPos.set(n.id, { x: center.x + Math.cos(ang) * 360, y: center.y + Math.sin(ang) * 290 });
    });
    // Outer nodes get a target beyond whatever they hang from; collaborators of those
    // songs hang one step further out again.
    const anchor = new Map<string, Pt>(ringPos);
    anchor.set(currentId, center);
    const widerTarget = new Map<string, Pt>();
    const adj = new Map<string, string[]>();
    for (const e of scene.edges) {
      adj.set(e.rel.from, [...(adj.get(e.rel.from) ?? []), e.rel.to]);
      adj.set(e.rel.to, [...(adj.get(e.rel.to) ?? []), e.rel.from]);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const sn of scene.nodes) {
        if (sn.role !== 'wider' || widerTarget.has(sn.id)) continue;
        const from = bridge.get(sn.id) ?? (adj.get(sn.id) ?? []).find((o) => anchor.has(o) && o !== currentId);
        if (!from || !anchor.has(from)) continue;
        const base = anchor.get(from)!;
        const rand = seeded(sn.id);
        const out = Math.atan2(base.y - center.y, base.x - center.x) + (rand() - 0.5) * 1.3;
        const dist = bridge.has(sn.id) ? 210 : 140;
        const t = { x: base.x + Math.cos(out) * dist, y: base.y + Math.sin(out) * dist };
        widerTarget.set(sn.id, t);
        anchor.set(sn.id, t);
      }
    }
    const sims: SimNode[] = scene.nodes.map((sn) => {
      const node = this.graph.node(sn.id)!;
      const r = nodeRadius(node, sn.role, true);
      if (sn.id === currentId) return { id: sn.id, ...(this.manual.get(sn.id) ?? center), vx: 0, vy: 0, r, fixed: true };
      const placed = this.manual.get(sn.id);
      if (placed) return { id: sn.id, ...placed, vx: 0, vy: 0, r, fixed: true };
      const prev = this.shown.get(sn.id);
      const rand = seeded(sn.id);
      let start = prev ?? ringPos.get(sn.id);
      const b = bridge.get(sn.id);
      const target = widerTarget.get(sn.id);
      if (sn.role === 'wider' && target) {
        // Outer nodes sit beyond the node they hang from, fanned outward, so it's
        // clear they belong to that person or song, not to the centre.
        start ??= { x: (target.x + center.x) / 2, y: (target.y + center.y) / 2 };
        return { id: sn.id, ...start, vx: 0, vy: 0, r, tx: target.x, ty: target.y, kx: 0.05, ky: 0.05 };
      }
      if (!start) {
        const base = (b && (this.shown.get(b) ?? ringPos.get(b))) || center;
        const out = Math.atan2(base.y - center.y, base.x - center.x) + (rand() - 0.5) * 1.6;
        start = { x: base.x + Math.cos(out) * 150, y: base.y + Math.sin(out) * 150 };
      }
      // A gentle pull to the centre keeps the web together without a box around it.
      return { id: sn.id, ...start, vx: 0, vy: 0, r, tx: center.x, ty: center.y, kx: 0.006, ky: 0.008 };
    });
    const big = 1e5;
    this.simulate(sims, scene, { top: -big, bottom: big, left: -big, right: big }, (n) => (n.r < 50 ? 180 : 380));
    return new Map(sims.map((s) => [s.id, { x: s.x, y: s.y }]));
  }

  private layoutRelations(scene: Scene): Map<string, Pt> {
    const W = this.width;
    const H = this.height;
    const cy = H * 0.5;
    const k = scene.path.length - 1;
    const x0 = W < 700 ? W * 0.22 : W * 0.3;
    const spacing = k ? Math.min(W * 0.2, (W * 0.36) / k) : 0;
    const pos = new Map<string, Pt>();
    scene.path.forEach((id, i) => pos.set(id, { x: x0 + i * spacing, y: cy + (i % 2 ? -18 : 0) }));
    const current = pos.get(scene.path[k])!;

    const rest = Math.min(300, Math.max(180, W * 0.24));
    const ringSize = Math.max(1, scene.nodes.filter((n) => n.role === 'neighbor').length);
    let ring = 0;
    const sims: SimNode[] = [];
    for (const sn of scene.nodes) {
      const fixed = pos.get(sn.id);
      const node = this.graph.node(sn.id)!;
      const prev = this.shown.get(sn.id);
      const r = sn.role === 'wider' ? 10 : nodeRadius(node, sn.role);
      if (fixed) {
        sims.push({ id: sn.id, ...fixed, vx: 0, vy: 0, r, fixed: true });
        continue;
      }
      const rand = seeded(sn.id);
      // New neighbours start evenly on a ring (right side first); existing ones stay put.
      const ang = -Math.PI / 2 + ((ring++ + 0.5) / ringSize) * Math.PI * 2;
      const start = prev ?? {
        x: current.x + Math.cos(ang) * rest,
        y: current.y + Math.sin(ang) * rest * 0.8,
      };
      const sim: SimNode = { id: sn.id, ...start, vx: 0, vy: 0, r };
      if (sn.role === 'neighbor') {
        // Lean the neighbourhood away from the path, which runs to the left.
        sim.tx = Math.min(W - 120, current.x + W * 0.16);
        sim.kx = 0.006;
        if (node.kind !== 'track') {
          sim.ty = cy + (rand() > 0.5 ? -1 : 1) * H * 0.28;
          sim.ky = 0.01;
        }
      }
      sims.push(sim);
    }
    this.simulate(sims, scene, { top: 90, bottom: H - 80, left: 70, right: W - 80 }, (n) => (n.r < 20 ? 70 : rest));
    return new Map(sims.map((s) => [s.id, { x: s.x, y: s.y }]));
  }

  private axis: { x: (v: number) => number; ticks: { label: string; x: number }[]; breaks: { x: number; label: string }[]; unknown: [number, number] | null; y: number; peopleY: number } | null = null;

  private scaleX(v: number): number {
    return this.axis ? this.axis.x(v) : 0;
  }

  private simulate(
    nodes: SimNode[],
    scene: Scene,
    bounds: { top: number; bottom: number; left: number; right: number },
    restLength: (n: SimNode) => number,
    yBounds?: (n: SimNode) => { top: number; bottom: number },
  ): void {
    const index = new Map(nodes.map((n) => [n.id, n]));
    const springs = scene.edges
      .map((e) => [index.get(e.rel.from), index.get(e.rel.to)] as const)
      .filter((p): p is readonly [SimNode, SimNode] => !!p[0] && !!p[1]);
    const iterations = 260;
    for (let it = 0; it < iterations; it++) {
      const alpha = 1 - it / iterations;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d = 0.5;
          }
          const min = a.r + b.r + 10;
          // Long-range repulsion keeps the neighbourhood airy…
          const charge = (6000 * alpha) / (d * d);
          push(a, (-dx / d) * charge, (-dy / d) * charge);
          push(b, (dx / d) * charge, (dy / d) * charge);
          // …and overlap is resolved directly so labels do not collide.
          if (d < min) {
            const o = ((min - d) / d) * 0.5;
            nudge(a, -dx * o, -dy * o);
            nudge(b, dx * o, dy * o);
          }
        }
      }
      for (const [a, b] of springs) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const rest = Math.max(restLength(a.r < b.r ? a : b), a.r + b.r + 20);
        const f = ((d - rest) / d) * 0.04 * alpha;
        push(a, dx * f, dy * f);
        push(b, -dx * f, -dy * f);
      }
      for (const n of nodes) {
        if (n.tx !== undefined) n.vx += (n.tx - n.x) * (n.kx ?? 0.02);
        if (n.ty !== undefined) n.vy += (n.ty - n.y) * (n.ky ?? 0.02);
        if (n.fixed) {
          n.vx = n.vy = 0;
          continue;
        }
        n.vx *= 0.55;
        n.vy *= 0.55;
        // Cap each step so overlapping starts can't fling a node across the map.
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > 24) {
          n.vx = (n.vx / sp) * 24;
          n.vy = (n.vy / sp) * 24;
        }
        if (!n.fixX) n.x += n.vx;
        n.y += n.vy;
        const yb = yBounds?.(n) ?? bounds;
        n.x = Math.max(bounds.left + n.r * 0.5, Math.min(bounds.right - n.r * 0.5, n.x));
        n.y = Math.max(yb.top, Math.min(yb.bottom, n.y));
      }
    }

    function push(n: SimNode, fx: number, fy: number) {
      if (n.fixed) return;
      n.vx += fx;
      n.vy += fy;
    }
    function nudge(n: SimNode, dx: number, dy: number) {
      if (n.fixed) return;
      if (!n.fixX) n.x += dx;
      n.y += dy;
    }
  }

  // ---- Axis -------------------------------------------------------------------

  private renderAxis(scene: Scene): void {
    if (scene.mode !== 'history' || !this.axis) {
      this.axisEl.hidden = true;
      this.axisEl.innerHTML = '';
      return;
    }
    const a = this.axis;
    const hasPeople = scene.nodes.some((n) => this.graph.people.has(n.id) && n.role !== 'wider');
    this.axisEl.hidden = false;
    this.axisEl.innerHTML = `
      <div class="mm-axis__line" style="top:${a.y}px"></div>
      <div class="mm-axis__title" style="top:${a.y + 26}px">Release date of each recording →</div>
      ${a.ticks.map((t) => `<span class="mm-axis__tick" style="left:${t.x}px;top:${a.y}px">${t.label}</span>`).join('')}
      ${a.breaks.map((b) => `<span class="mm-axis__break" style="left:${b.x}px;top:${a.y}px" title="Axis compressed">${b.label}</span>`).join('')}
      ${a.unknown ? `<div class="mm-axis__unknown" style="left:${a.unknown[0]}px;width:${a.unknown[1] - a.unknown[0]}px;top:70px;height:${a.y - 60}px"><span>Release date unknown</span></div>` : ''}
      ${hasPeople ? `<div class="mm-axis__people" style="top:${a.peopleY - 44}px"><span>People &amp; groups · not placed by date</span></div>` : ''}`;
  }
}

// ---- Helpers ------------------------------------------------------------------

function initials(name: string): string {
  const words = name.replace(/^The\s+/i, '').split(/\s+/).filter(Boolean);
  return (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '');
}

function nodeSize(node: Node, role: NodeRole, web = false): number {
  if (web) {
    // The historical web shows covers big enough to recognise.
    if (role === 'wider') return node.kind === 'track' ? 58 : 36;
    if (node.kind === 'track') return role === 'origin' ? 150 : role === 'current' ? 136 : role === 'path' ? 104 : 96;
    return role === 'current' ? 84 : 62;
  }
  if (role === 'wider') return node.kind === 'track' ? 30 : 8;
  if (node.kind === 'track') {
    if (role === 'origin') return 104;
    if (role === 'current') return 92;
    if (role === 'overview') return 46;
    return role === 'path' ? 66 : 60;
  }
  return role === 'current' ? 62 : 42;
}

function nodeRadius(node: Node, role: NodeRole, history = false): number {
  const s = nodeSize(node, role, history);
  if (history) return s / 2 + (role === 'wider' ? 12 : 40);
  // Labels sit under nodes, so reserve a little extra room.
  return node.kind === 'track' ? s / 2 + (history ? 22 : 36) : s / 2 + (history ? 50 : 30);
}

/** A gently bowed curve between two node centres, trimmed to their edges. */
function curve(a: Pt, b: Pt, trimA: number, trimB: number, seed: string) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < trimA + trimB + 4) return null;
  const bow = (seeded(seed)() > 0.5 ? 1 : -1) * Math.min(40, len * 0.12);
  const nx = -dy / len;
  const ny = dx / len;
  const c = { x: (a.x + b.x) / 2 + nx * bow, y: (a.y + b.y) / 2 + ny * bow };
  const trim = (p: Pt, toward: Pt, t: number) => {
    const ddx = toward.x - p.x;
    const ddy = toward.y - p.y;
    const l = Math.hypot(ddx, ddy) || 1;
    return { x: p.x + (ddx / l) * t, y: p.y + (ddy / l) * t };
  };
  const s = trim(a, c, trimA);
  const e = trim(b, c, trimB);
  const mid = { x: 0.25 * s.x + 0.5 * c.x + 0.25 * e.x, y: 0.25 * s.y + 0.5 * c.y + 0.25 * e.y };
  return { d: `M${s.x.toFixed(1)},${s.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${e.x.toFixed(1)},${e.y.toFixed(1)}`, mid };
}

/** "writer (of the work “X”)" → "writer"; "credited artist (listed first)" → "credited artist". */
function shortRole(role?: string): string {
  return (role ?? 'credited').replace(/\s*\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
}
