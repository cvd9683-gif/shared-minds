// Music Map - Local network around a track, in either date system
// "My timeline": relationship layout. The original track holds a fixed spot, the
//   path you followed runs to its right, and the current node's connections gather
//   around it.
// "Music history": recordings sit on a release-date axis. People have their own
//   lane below it and are never given a date.

import { coverUrl, seeded } from './covers';
import { escapeHtml } from './field';
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
    const targets = scene.mode === 'history' ? this.layoutHistory(scene) : this.layoutRelations(scene);

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
        el.addEventListener('click', () => this.cb.onActivate(sn.id));
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
            ? { x: spawn.rect.left - stageRect.left + spawn.rect.width / 2, y: spawn.rect.top - stageRect.top + spawn.rect.height / 2 }
            : (this.shown.get(currentId) ?? targets.get(currentId) ?? targets.get(sn.id)!);
        this.shown.set(sn.id, { ...start });
        if (spawn?.id === sn.id) d.el.style.setProperty('--spawn', `${spawn.rect.width}px`);
      }
      d.role = sn.role;
      d.size = nodeSize(node, sn.role);
      this.renderNode(d, node, sn, scene);
    }

    this.renderAxis(scene);

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

  private setHover(id: string | null, el: HTMLElement | null): void {
    this.hoverId = id;
    this.cb.onHover(id, el);
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
      el.innerHTML = `<span class="mm-node__art"></span>`;
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
      meta = history ? `${relTxt}${sn.role === 'overview' ? '' : savedTxt}` : `<span>${escapeHtml(node.artistCredit)}</span>${sn.role === 'overview' ? '' : savedTxt}`;
      if (history && node.release && node.release.precision !== 'day') {
        const [a, b] = partialDateSpan(node.release);
        const w = Math.max(4, this.scaleX(b) - this.scaleX(a));
        span = `<span class="mm-node__span" style="width:${w}px" title="${node.release.precision === 'year' ? 'Only the year is known' : 'Only the month is known'}"></span>`;
      }
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
      const showLabel = e.emphasis === 'path' || e.emphasis === 'focus' || hovered || inspected;
      if (showLabel && e.emphasis !== 'wider') {
        const flag = st === 'disputed' ? ' · disputed' : st === 'undocumented' ? ' · unconfirmed' : '';
        labels += `<span class="mm-edge-label ${cls}" style="transform:translate(${geo.mid.x}px, ${geo.mid.y}px) translate(-50%, -50%)">${escapeHtml(e.label ?? edgeLabel(e.rel))}${flag ? `<em>${flag}</em>` : ''}</span>`;
      }
    }
    g.innerHTML = svg;
    this.labelsEl.innerHTML = labels;
  }

  // ---- Layouts ----------------------------------------------------------------

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

  private layoutHistory(scene: Scene): Map<string, Pt> {
    const W = this.width;
    const H = this.height;
    const hasPeople = scene.nodes.some((n) => this.graph.people.has(n.id) && n.role !== 'wider');
    const axisY = hasPeople ? H - 150 : H - 70;
    const peopleY = H - 80;
    const tracks = scene.nodes.map((n) => this.graph.tracks.get(n.id)).filter((t) => !!t);
    const values = tracks.filter((t) => t.release).flatMap((t) => partialDateSpan(t.release!));
    const hasUnknown = tracks.some((t) => !t.release);
    this.axis = { ...buildScale(values, hasUnknown, 70, W - 50), y: axisY, peopleY };
    const axis = this.axis;
    const band = { top: 80, bottom: axisY - 70 };
    const midY = (band.top + band.bottom) / 2;
    const currentId = scene.path[scene.path.length - 1];

    const sims: SimNode[] = [];
    let unknownIndex = 0;
    for (const sn of scene.nodes) {
      const node = this.graph.node(sn.id)!;
      const prev = this.shown.get(sn.id);
      const rand = seeded(sn.id);
      const r = sn.role === 'wider' ? 10 : nodeRadius(node, sn.role, true);
      if (node.kind === 'track') {
        let x: number;
        if (node.release) {
          const [a, b] = partialDateSpan(node.release);
          x = axis.x((a + b) / 2);
        } else {
          const [ux0, ux1] = axis.unknown!;
          x = ux0 + ((unknownIndex++ * 37) % Math.max(1, ux1 - ux0 - 20)) + 10;
        }
        // The current and starting recordings stay on the centre line so they are easy to find.
        const important = sn.id === currentId || sn.role === 'origin';
        sims.push({
          id: sn.id,
          x,
          y: prev?.y ?? band.top + rand() * (band.bottom - band.top),
          vx: 0,
          vy: 0,
          r,
          fixX: true,
          ty: midY,
          ky: important ? 0.2 : 0.004,
        });
      } else {
        // People have no release date: they live in their own lane, near their work.
        sims.push({
          id: sn.id,
          x: prev?.x ?? W / 2 + (rand() - 0.5) * W * 0.5,
          y: peopleY,
          vx: 0,
          vy: 0,
          r,
          ty: peopleY,
          ky: 0.5,
        });
      }
    }
    this.simulate(
      sims,
      scene,
      { top: band.top, bottom: peopleY + 10, left: 50, right: W - 40 },
      () => 120,
      (n) => (this.graph.people.has(n.id) ? { top: peopleY - 6, bottom: peopleY + 6 } : { top: band.top, bottom: band.bottom }),
    );
    return new Map(sims.map((s) => [s.id, { x: s.x, y: s.y }]));
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

function nodeSize(node: Node, role: NodeRole): number {
  if (role === 'wider') return 8;
  if (node.kind === 'track') {
    if (role === 'origin') return 104;
    if (role === 'current') return 92;
    if (role === 'overview') return 46;
    return role === 'path' ? 66 : 60;
  }
  return role === 'current' ? 62 : 42;
}

function nodeRadius(node: Node, role: NodeRole, history = false): number {
  const s = nodeSize(node, role);
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

/**
 * Piecewise-linear time scale over fractional years. Long empty stretches are
 * compressed and marked with a visible break, so decades apart stay readable
 * without pretending the axis is uniform.
 */
function buildScale(values: number[], hasUnknown: boolean, x0: number, x1: number) {
  const now = new Date().getFullYear();
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const lo = Math.floor(sorted[0] ?? now - 5) - 1;
  const hi = Math.floor(sorted[sorted.length - 1] ?? now) + 1;
  const pts = [lo, ...sorted, hi];
  const MAX_GAP = 6;
  const anchors: { v: number; u: number }[] = [{ v: lo, u: 0 }];
  const breaks: { v: number; u: number; gap: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i] - pts[i - 1];
    const du = gap > MAX_GAP ? 2.5 : gap;
    const prev = anchors[anchors.length - 1];
    if (gap > MAX_GAP) breaks.push({ v: (pts[i] + pts[i - 1]) / 2, u: prev.u + du / 2, gap });
    anchors.push({ v: pts[i], u: prev.u + du });
  }
  const total = anchors[anchors.length - 1].u || 1;
  const right = hasUnknown ? x1 - 150 : x1;
  const x = (v: number) => {
    let i = anchors.findIndex((a) => a.v >= v);
    if (i === -1) i = anchors.length - 1;
    else if (i === 0) i = 1;
    const a = anchors[i - 1];
    const b = anchors[i];
    const f = b.v === a.v ? 0 : (v - a.v) / (b.v - a.v);
    return x0 + ((a.u + f * (b.u - a.u)) / total) * (right - x0);
  };
  const inBreak = (y: number) => breaks.some((b) => Math.abs(y - b.v) < b.gap / 2 - 1);
  const pxPerYear = (right - x0) / total;
  const step = [1, 2, 5, 10, 20].find((s) => s * pxPerYear >= 46) ?? 25;
  const ticks: { label: string; x: number }[] = [];
  const breakMarks = breaks.map((b) => ({ x: x0 + (b.u / total) * (right - x0), label: `≈ ${Math.round(b.gap)} yrs` }));
  for (let y = Math.ceil(lo / step) * step; y <= hi; y += step) {
    const tx = x(y);
    const crowded =
      ticks.some((t) => Math.abs(t.x - tx) < 34) || breakMarks.some((b) => Math.abs(b.x - tx) < 44);
    if (!inBreak(y) && !crowded) ticks.push({ label: `${y}`, x: tx });
  }
  return {
    x,
    ticks,
    breaks: breakMarks,
    unknown: hasUnknown ? ([x1 - 120, x1] as [number, number]) : null,
  };
}
