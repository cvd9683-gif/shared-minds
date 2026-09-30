// Music Map - Personal Timeline canvas
// Albums sit on the axis itself as an overlapping strip of covers, one stretch per
// year. A lens follows the pointer: covers near it swell and scatter above and
// below the line into a collage, then settle back as it moves on (the motion from
// the reference video). A magnifier docked in the top-right shows the year under
// the lens, joined to its stretch of the axis by two lines. Picking an album pins
// the magnifier: the cover grows, with its details beside it.
// The same canvas is used for any sectioned timeline (by year saved, or by release).

import { coverUrl, seeded } from './covers';
import type { Track } from './types';

/** One tile: an album (or single), holding every saved song from it in that section. */
export interface CanvasItem {
  id: string;
  /** Track whose cover and details stand for the album. */
  track: Track;
  trackIds: string[];
  title: string;
  artist: string;
  /** Shown in the tile's accessible name, e.g. "3 songs saved". */
  dateText: string;
  outside?: boolean;
}

export interface CanvasSection {
  key: string;
  title: string;
  /** Explorer-written caption ("senior year"), or a factual note when not editable. */
  caption?: string;
  editable: boolean;
  items: CanvasItem[];
  /** Label for an empty stretch of time before this section, e.g. "3 yrs not shown". */
  gapBefore?: string;
}

export interface CanvasCallbacks {
  onSelect(id: string, sectionKey: string, rect: DOMRect): void;
  onHover(id: string | null, el: HTMLElement | null): void;
  /** The year label or its caption was clicked. */
  onCaption?(sectionKey: string): void;
  /** A click on empty canvas while an album is pinned. */
  onBackground?(): void;
}

interface Tile {
  item: CanvasItem;
  section: Section;
  el: HTMLButtonElement;
  x: number;
  rest: number;
  restY: number;
  sx: number;
  sy: number;
  scale: number;
  z: number;
  active: boolean;
}

interface Section {
  data: CanvasSection;
  x: number;
  w: number;
  tiles: Tile[];
}

const LEFT = 60;
const PAD = 46;
const GAP_W = 70;

export class TimelineCanvas {
  private root: HTMLElement;
  private stage: HTMLElement;
  private cb: CanvasCallbacks;
  private world: HTMLDivElement;
  private zoom: HTMLDivElement;
  private lines: SVGSVGElement;
  private info: HTMLDivElement;
  private sections: Section[] = [];
  private tiles: Tile[] = [];
  private width = 800;
  private height = 600;
  private zoomKey: string | null = null;
  private pinned: { id: string; key: string } | null = null;
  private reducedMotion = false;
  private touch = matchMedia('(hover: none)').matches;
  private dragging = false;
  private accent: 'saved' | 'release' = 'saved';
  private lastData: CanvasSection[] = [];
  private lens = { x: 0, s: 0, tx: 0, ts: 0 };
  private lensRaf: number | null = null;
  private scrollTarget = 0;
  private scrollRaf: number | null = null;

  constructor(root: HTMLElement, nav: HTMLElement, cb: CanvasCallbacks) {
    this.root = root;
    this.stage = root.parentElement!;
    this.cb = cb;
    nav.hidden = true; // the axis itself is the navigation
    this.world = document.createElement('div');
    this.world.className = 'mm-canvas__world';
    this.root.appendChild(this.world);
    // The magnifier and its lines live on the stage, docked top-right, not in the scrolling world.
    this.zoom = document.createElement('div');
    this.zoom.className = 'mm-zoom';
    this.zoom.hidden = true;
    this.info = document.createElement('div');
    this.info.className = 'mm-zoom__info';
    this.lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.lines.setAttribute('class', 'mm-zoom__lines');
    this.lines.setAttribute('aria-hidden', 'true');
    this.stage.append(this.lines, this.zoom);
    this.bind();
  }

  /** Shows or hides the docked magnifier with the canvas (it lives outside it). */
  setVisible(v: boolean): void {
    this.zoom.classList.toggle('is-away', !v);
    this.lines.classList.toggle('is-away', !v);
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    this.root.classList.toggle('is-reduced', v);
  }

  resize(w: number, h: number): void {
    const changed = Math.abs(h - this.height) > 1 || Math.abs(w - this.width) > 1;
    this.width = w;
    this.height = h;
    if (changed && this.lastData.length) this.setSections(this.lastData, this.accent, true);
  }

  private get axisY(): number {
    return Math.round(this.height * (this.width < 600 ? 0.6 : 0.62));
  }

  // ---- Build ------------------------------------------------------------------

  setSections(data: CanvasSection[], accent: 'saved' | 'release', keepState = false): void {
    const keepZoom = keepState ? this.zoomKey : null;
    const keepPin = keepState ? this.pinned : null;
    const keepInfo = this.info.innerHTML;
    this.lastData = data;
    this.accent = accent;
    this.root.dataset.accent = accent;
    this.stage.dataset.accent = accent;
    this.world.innerHTML = '';
    this.sections = [];
    this.tiles = [];
    this.pinned = null;

    const y0 = this.axisY;
    const small = this.width < 600;
    let x = LEFT;
    const axis = document.createElement('div');
    axis.className = 'mm-canvas__axis';
    this.world.appendChild(axis);

    for (const sec of data) {
      if (sec.gapBefore) {
        const gap = document.createElement('div');
        gap.className = 'mm-canvas__gap';
        Object.assign(gap.style, { left: `${x}px`, width: `${GAP_W}px`, top: `${y0 - 10}px` });
        gap.innerHTML = `<span>${escapeHtml(sec.gapBefore)}</span>`;
        this.world.appendChild(gap);
        x += GAP_W;
      }
      const section: Section = { data: sec, x, w: 0, tiles: [] };
      // Albums line up along the axis, overlapping; more saved songs = a bigger cover.
      let cursor = x + PAD;
      let prevRest = 0;
      sec.items.forEach((item, i) => {
        const n = item.trackIds.length;
        const rest = Math.min(small ? 44 : 58, (small ? 24 : 30) + (n - 1) * 8);
        cursor += prevRest ? (prevRest + rest) * 0.3 : rest / 2;
        prevRest = rest;
        const rand = seeded(item.id);
        const tile: Tile = {
          item,
          section,
          el: document.createElement('button'),
          x: cursor,
          rest,
          restY: (i % 2 ? 1 : -1) * rest * (0.12 + rand() * 0.14),
          sy: (i % 2 ? 1 : -1) * (0.3 + rand() * 0.7),
          sx: rand() - 0.5,
          scale: (0.8 + rand() * 0.35) * (1 + Math.min(n - 1, 4) * 0.08),
          z: 1 + Math.floor(rand() * 30),
          active: true,
        };
        const b = tile.el;
        b.type = 'button';
        b.className = `mm-cov${item.outside ? ' is-outside' : ''}`;
        b.dataset.id = item.id;
        b.setAttribute('aria-label', `${item.title} by ${item.artist}. ${item.dateText}.`);
        b.innerHTML = `<img alt="" src="${coverUrl(item.track.cover, item.title)}" loading="lazy" draggable="false" />${n > 1 ? `<span class="mm-cov__count">${n}</span>` : ''}`;
        this.bindTile(tile);
        this.world.appendChild(b);
        section.tiles.push(tile);
        this.tiles.push(tile);
      });
      const width = Math.max(small ? 130 : 170, cursor + prevRest / 2 + PAD - x);
      section.w = width;

      const el = document.createElement('section');
      el.className = 'mm-sec';
      Object.assign(el.style, { left: `${x}px`, width: `${width}px` });
      const songs = sec.items.reduce((a, it) => a + it.trackIds.length, 0);
      el.setAttribute('aria-label', `${sec.title}, ${songs} song${songs === 1 ? '' : 's'}`);
      const caption = sec.editable
        ? `<button type="button" class="mm-sec__caption ${sec.caption ? '' : 'is-empty'}">${escapeHtml(sec.caption || '+ add a note')}</button>`
        : sec.caption
          ? `<span class="mm-sec__caption is-static">${escapeHtml(sec.caption)}</span>`
          : '';
      el.innerHTML = `
        <span class="mm-sec__tick" style="top:${y0}px"></span>
        <span class="mm-sec__divider"></span>
        <div class="mm-sec__head">
          <button type="button" class="mm-sec__year">${escapeHtml(sec.title)}</button>
          ${caption}
        </div>`;
      el.querySelector('.mm-sec__year')!.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      el.querySelector<HTMLButtonElement>('button.mm-sec__caption')?.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      this.world.insertBefore(el, this.world.firstChild);
      this.sections.push(section);
      x += width;
    }
    const worldW = x + LEFT;
    this.world.style.width = `${worldW}px`;
    this.world.style.height = `${this.height}px`;
    Object.assign(axis.style, { top: `${y0}px`, left: '16px', width: `${worldW - 32}px` });
    this.scrollTarget = this.root.scrollLeft;

    // Start with a gentle bloom mid-view, so the motion is visible before any hover.
    this.lens.x = this.lens.tx = this.root.scrollLeft + this.width / 2;
    this.lens.s = this.lens.ts = this.touch ? 1 : 0.45;
    this.paint(true);

    const pin = keepPin && this.tileOf(keepPin.id) ? keepPin : null;
    this.zoomKey = null;
    if (pin) this.pin(pin.id, keepInfo);
    else this.showZoom(keepZoom && this.find(keepZoom) ? keepZoom : this.centerKey());
  }

  private bindTile(tile: Tile): void {
    const { el: b, item, section } = tile;
    b.addEventListener('click', (e) => {
      if (this.dragging) return e.preventDefault();
      this.cb.onSelect(item.id, section.data.key, b.getBoundingClientRect());
    });
    b.addEventListener('pointerenter', () => {
      if (!this.pinned) this.showZoom(section.data.key);
      this.hot(item.id, true);
      this.cb.onHover(item.id, b);
    });
    b.addEventListener('pointerleave', () => {
      this.hot(item.id, false);
      this.cb.onHover(null, null);
    });
    b.addEventListener('focus', () => {
      this.scrollToX(tile.x, false);
      if (!this.pinned) this.showZoom(section.data.key);
      this.setLens(tile.x, 1);
      this.hot(item.id, true);
      this.cb.onHover(item.id, b);
    });
    b.addEventListener('blur', () => {
      this.hot(item.id, false);
      this.cb.onHover(null, null);
    });
    b.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      this.tiles[this.tiles.indexOf(tile) + dir]?.el.focus({ preventScroll: true });
    });
  }

  private find(key: string): Section | undefined {
    return this.sections.find((s) => s.data.key === key);
  }

  private tileOf(id: string): Tile | undefined {
    return this.tiles.find((t) => t.item.id === id);
  }

  private sectionAt(x: number): Section | undefined {
    return this.sections.find((s) => x >= s.x && x < s.x + s.w);
  }

  private centerKey(): string | null {
    const mid = this.root.scrollLeft + this.width / 2;
    return (this.sectionAt(mid) ?? this.sections[0])?.data.key ?? null;
  }

  /** Links a cover on the line and its copy in the magnifier. */
  private hot(id: string, on: boolean): void {
    this.tileOf(id)?.el.classList.toggle('is-hot', on);
    this.zoom.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('is-hot', on);
  }

  // ---- Lens / bloom -----------------------------------------------------------------

  private setLens(x: number, s: number): void {
    this.lens.tx = x;
    this.lens.ts = s;
    if (this.reducedMotion) {
      this.lens.x = x;
      this.lens.s = s;
      this.paint();
      return;
    }
    if (this.lensRaf === null) this.lensRaf = requestAnimationFrame(() => this.lensTick());
  }

  private lensTick(): void {
    const l = this.lens;
    l.x += (l.tx - l.x) * 0.14;
    l.s += (l.ts - l.s) * 0.1;
    const settled = Math.abs(l.tx - l.x) < 0.4 && Math.abs(l.ts - l.s) < 0.004;
    if (settled) {
      l.x = l.tx;
      l.s = l.ts;
    }
    this.paint();
    this.lensRaf = settled ? null : requestAnimationFrame(() => this.lensTick());
  }

  private paint(all = false): void {
    const y0 = this.axisY;
    const radius = Math.max(140, Math.min(260, this.width * 0.16));
    const big = Math.max(64, Math.min(160, this.height * 0.22, this.width * 0.28));
    const spread = this.height * (this.width < 600 ? 0.2 : 0.25);
    const left = this.root.scrollLeft - radius * 2;
    const right = this.root.scrollLeft + this.width + radius * 2;
    const pinnedId = this.pinned?.id;

    for (const t of this.tiles) {
      const inView = t.x > left && t.x < right;
      if (!inView && !t.active && !all) continue;
      const d = t.x - this.lens.x;
      const f = inView ? Math.exp(-(d * d) / (2 * radius * radius)) * this.lens.s : 0;
      t.active = f > 0.01;
      let size = t.rest + f * (big * t.scale - t.rest);
      let cx = t.x + d * f * 0.9 + t.sx * f * 56;
      let cy = y0 + t.restY * (1 - f) + t.sy * f * spread;
      let z = t.z + Math.round(f * 120);
      if (t.item.id === pinnedId) {
        size = Math.max(size, big * 1.25);
        cx = t.x;
        cy = y0;
        z = 400;
      }
      t.el.style.width = `${size}px`;
      t.el.style.height = `${size}px`;
      t.el.style.transform = `translate(${cx - size / 2}px, ${cy - size / 2}px)`;
      t.el.style.zIndex = `${z}`;
      t.el.classList.toggle('is-bloomed', f > 0.5);
    }
    this.placeLines();
  }

  // ---- Docked magnifier ----------------------------------------------------------

  private zoomBox() {
    const pinned = !!this.pinned;
    const narrow = this.width < 600;
    const width = narrow ? this.width - 24 : pinned ? Math.min(this.width - 32, 960) : Math.min(460, Math.max(320, this.width * 0.33));
    const height = narrow
      ? Math.min(pinned ? 300 : 200, this.axisY - this.height * 0.2 - 30)
      : Math.max(200, Math.min(pinned ? 380 : 330, this.axisY - this.height * 0.25 - 40));
    return { top: 12, height, width, left: this.width - width - (narrow ? 12 : 16) };
  }

  private zoomItem(it: CanvasItem, extra = '', delay = 0): string {
    const n = it.trackIds.length;
    return `<button type="button" class="mm-zoom__item${extra}${it.outside ? ' is-outside' : ''}" data-id="${escapeHtml(it.id)}" style="animation-delay:${delay}ms" title="${escapeHtml(it.title)} · ${escapeHtml(it.artist)}${n > 1 ? ` · ${n} songs` : ''}"><img alt="${escapeHtml(it.title)} by ${escapeHtml(it.artist)}" src="${coverUrl(it.track.cover, it.title)}" draggable="false" />${n > 1 ? `<span class="mm-cov__count">${n}</span>` : ''}</button>`;
  }

  private showZoom(key: string | null, force = false): void {
    const sec = key ? this.find(key) : undefined;
    if (!sec) {
      this.zoom.hidden = true;
      this.lines.innerHTML = '';
      return;
    }
    if (!force && key === this.zoomKey && !this.zoom.hidden) return this.placeLines();
    this.zoomKey = key;
    this.zoom.hidden = false;
    this.zoom.classList.remove('is-pinned');
    const box = this.zoomBox();
    const units = sec.data.items.reduce((a, it) => a + (it.trackIds.length > 1 ? 4 : 1), 0);
    const pw = box.width - 26;
    const ph = box.height - 48;
    const c = Math.max(26, Math.min(130, Math.floor(Math.sqrt((pw * ph) / (units * 1.25)))));
    const songs = sec.data.items.reduce((a, it) => a + it.trackIds.length, 0);
    const items = sec.data.items
      .map((it, i) => this.zoomItem(it, it.trackIds.length > 1 ? ' is-big' : '', this.reducedMotion ? 0 : Math.min(i * 10, 300)))
      .join('');
    this.zoom.innerHTML = `
      <p class="mm-zoom__head"><strong>${escapeHtml(sec.data.title)}</strong>${sec.data.caption ? ` <span>${escapeHtml(sec.data.caption)}</span>` : ''}<em>${songs} song${songs === 1 ? '' : 's'} · ${sec.data.items.length} album${sec.data.items.length === 1 ? '' : 's'}</em></p>
      <div class="mm-zoom__grid" style="--c:${c}px">${items}</div>`;
    this.bindZoomItems(sec.data.key);
    this.placeZoom();
  }

  private bindZoomItems(key: string): void {
    this.zoom.querySelectorAll<HTMLButtonElement>('.mm-zoom__item').forEach((b) => {
      const id = b.dataset.id!;
      b.addEventListener('click', () => this.cb.onSelect(id, key, b.getBoundingClientRect()));
      b.addEventListener('pointerenter', () => {
        this.hot(id, true);
        this.cb.onHover(id, b);
      });
      b.addEventListener('pointerleave', () => {
        this.hot(id, false);
        this.cb.onHover(null, null);
      });
    });
  }

  private placeZoom(): void {
    const box = this.zoomBox();
    Object.assign(this.zoom.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    this.placeLines();
  }

  /** Two lines from the magnifier's lower corners to its year's stretch of the axis. */
  private placeLines(): void {
    const sec = this.zoomKey ? this.find(this.zoomKey) : undefined;
    if (!sec || this.zoom.hidden) {
      this.lines.innerHTML = '';
      return;
    }
    const box = this.zoomBox();
    const b = box.top + box.height;
    const sx = this.root.scrollLeft;
    const x1 = Math.max(-40, Math.min(this.width + 40, sec.x - sx + 4));
    const x2 = Math.max(-40, Math.min(this.width + 40, sec.x + sec.w - sx - 4));
    this.lines.setAttribute('width', `${this.width}`);
    this.lines.setAttribute('height', `${this.height}`);
    this.lines.innerHTML = `
      <line x1="${box.left}" y1="${b}" x2="${x1}" y2="${this.axisY}" />
      <line x1="${box.left + box.width}" y1="${b}" x2="${x2}" y2="${this.axisY}" />`;
    this.sections.forEach((s) => s.tiles.forEach((t) => t.el.classList.toggle('is-zoomed', s === sec)));
  }

  /** Pins the magnifier on one album: it grows, with its details beside it. */
  private pin(id: string, html: string): void {
    const tile = this.tileOf(id);
    if (!tile) return;
    const sec = tile.section;
    this.pinned = { id, key: sec.data.key };
    this.zoomKey = sec.data.key;
    this.zoom.hidden = false;
    this.zoom.classList.add('is-pinned');
    this.info.innerHTML = html;
    const box = this.zoomBox();
    const pic = this.width < 600 ? 120 : Math.max(120, box.height - 32);
    const others = sec.data.items.map((it) => this.zoomItem(it, it.id === id ? ' is-current' : '')).join('');
    this.zoom.innerHTML = `
      <figure class="mm-zoom__picked" style="width:${pic}px;height:${pic}px"><img src="${coverUrl(tile.item.track.cover, tile.item.title)}" alt="Cover of ${escapeHtml(tile.item.title)}" /></figure>
      <div class="mm-zoom__side"></div>
      <div class="mm-zoom__rest"><p class="mm-zoom__head"><strong>${escapeHtml(sec.data.title)}</strong><em>${sec.data.items.length} albums</em></p><div class="mm-zoom__grid" style="--c:36px">${others}</div></div>`;
    this.zoom.querySelector('.mm-zoom__side')!.appendChild(this.info);
    this.bindZoomItems(sec.data.key);
    this.tiles.forEach((t) => t.el.classList.toggle('is-selected', t.item.id === id));
    this.placeZoom();
    this.setLens(tile.x, 1);
  }

  // ---- Public selection API (used by the app) ------------------------------------

  setSelected(id: string | null, html = '', label = ''): void {
    this.root.classList.toggle('has-picked', !!id);
    if (!id) {
      this.pinned = null;
      this.tiles.forEach((t) => t.el.classList.remove('is-selected'));
      this.showZoom(this.zoomKey, true);
      this.setLens(this.lens.tx, this.touch ? 1 : 0.45);
      return;
    }
    const tile = this.tileOf(id);
    if (!tile) return;
    this.zoom.setAttribute('aria-label', label);
    this.scrollToX(tile.x, true);
    this.pin(id, html);
  }

  updateCallout(html: string): void {
    if (this.pinned) this.info.innerHTML = html;
  }

  get calloutEl(): HTMLElement {
    return this.info;
  }

  scrollToSection(key: string): void {
    const s = this.find(key);
    if (s) this.smoothTo(s.x - 40);
  }

  scrollToItem(id: string, highlight = false): void {
    const tile = this.tileOf(id);
    if (!tile) return;
    this.scrollToX(tile.x, true);
    this.setLens(tile.x, 1);
    if (!this.pinned) this.showZoom(tile.section.data.key);
    if (highlight) {
      tile.el.classList.add('is-highlight');
      setTimeout(() => tile.el.classList.remove('is-highlight'), 2400);
    }
  }

  focusItem(id: string): void {
    this.tileOf(id)?.el.focus({ preventScroll: true });
  }

  rectOf(id: string): DOMRect | null {
    return this.tileOf(id)?.el.getBoundingClientRect() ?? null;
  }

  private scrollToX(x: number, center: boolean): void {
    const left = this.root.scrollLeft;
    if (!center && x > left + 120 && x < left + this.width - 120) return;
    this.smoothTo(x - this.width * (this.width < 600 ? 0.5 : 0.4));
  }

  // ---- Smooth scrolling -------------------------------------------------------------

  private smoothTo(left: number): void {
    const max = this.root.scrollWidth - this.width;
    this.scrollTarget = Math.max(0, Math.min(max, left));
    if (this.reducedMotion) {
      this.root.scrollLeft = this.scrollTarget;
      return;
    }
    if (this.scrollRaf === null) this.scrollRaf = requestAnimationFrame(() => this.scrollTick());
  }

  private scrollTick(): void {
    const cur = this.root.scrollLeft;
    const diff = this.scrollTarget - cur;
    if (Math.abs(diff) < 0.5) {
      this.root.scrollLeft = this.scrollTarget;
      this.scrollRaf = null;
      return;
    }
    this.root.scrollLeft = cur + diff * 0.12;
    this.scrollRaf = requestAnimationFrame(() => this.scrollTick());
  }

  // ---- Input --------------------------------------------------------------------

  private bind(): void {
    this.root.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          this.scrollTarget = this.root.scrollLeft + e.deltaX;
          return;
        }
        e.preventDefault();
        const base = this.scrollRaf === null ? this.root.scrollLeft : this.scrollTarget;
        this.smoothTo(base + e.deltaY * 1.1);
      },
      { passive: false },
    );
    // The lens follows the pointer along the line; its year fills the magnifier.
    this.root.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || this.dragging) return;
      const r = this.root.getBoundingClientRect();
      const x = this.root.scrollLeft + e.clientX - r.left;
      if (!this.pinned) {
        this.setLens(x, 1);
        const sec = this.sectionAt(x);
        if (sec) this.showZoom(sec.data.key);
      }
    });
    this.root.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && !this.pinned) this.setLens(this.lens.tx, 0.45);
    });
    let scrollTimer = 0;
    this.root.addEventListener('scroll', () => {
      if (this.scrollRaf === null) this.scrollTarget = this.root.scrollLeft;
      if (this.touch && !this.pinned) this.setLens(this.root.scrollLeft + this.width / 2, 1);
      else this.paint();
      clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        if (!this.pinned && (this.touch || !this.root.matches(':hover'))) this.showZoom(this.centerKey());
      }, 160);
    });
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (!t.isConnected || this.dragging || !this.pinned || t.closest('.mm-cov, .mm-sec__head')) return;
      this.cb.onBackground?.();
    });

    // Drag the background with a mouse to pan, with a little glide on release.
    let startX = 0;
    let startLeft = 0;
    let lastX = 0;
    let velocity = 0;
    let down = false;
    this.root.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('.mm-sec__head')) return;
      down = true;
      this.dragging = false;
      startX = lastX = e.clientX;
      startLeft = this.root.scrollLeft;
      velocity = 0;
      if (this.scrollRaf !== null) cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    });
    window.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 5 && !this.dragging) {
        this.dragging = true;
        this.root.classList.add('is-dragging');
      }
      if (this.dragging) {
        velocity = e.clientX - lastX;
        lastX = e.clientX;
        this.root.scrollLeft = startLeft - dx;
      }
    });
    window.addEventListener('pointerup', () => {
      if (down && this.dragging) this.smoothTo(this.root.scrollLeft - velocity * 12);
      down = false;
      this.root.classList.remove('is-dragging');
      setTimeout(() => (this.dragging = false), 0);
    });
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
