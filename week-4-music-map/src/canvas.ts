// Music Map - Timeline canvas (after the paper timeline in Figma)
// A horizontal axis with a tick per year. Under each year, its albums overlap in a
// loose collage; hovering spreads the nearby covers apart and lifts the one under
// the pointer, like the reference video. Above the axis, a magnifier box shows the
// hovered year at a readable size, joined to its stretch of the axis by two lines.
// Picking an album pins the box: the cover grows, with its details beside it.
// The same canvas shows the Personal Timeline (by year saved) and the Historical
// Timeline (by release year, older years grouped by decade, gaps marked).

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
  el: HTMLButtonElement;
  cx: number;
  cy: number;
  size: number;
}

interface Section {
  data: CanvasSection;
  x: number;
  w: number;
  tiles: Tile[];
}

const LEFT = 56;
const GAP_W = 64;

export class TimelineCanvas {
  private root: HTMLElement;
  private cb: CanvasCallbacks;
  private world: HTMLDivElement;
  private zoom: HTMLDivElement;
  private lines: SVGSVGElement;
  private info: HTMLDivElement;
  private sections: Section[] = [];
  private width = 800;
  private height = 600;
  private zoomKey: string | null = null;
  private pinned: { id: string; key: string } | null = null;
  private reducedMotion = false;
  private dragging = false;
  private accent: 'saved' | 'release' = 'saved';
  private lastData: CanvasSection[] = [];
  private bloomed: Section | null = null;
  // Smooth scrolling: wheel input moves a target; each frame eases toward it.
  private scrollTarget = 0;
  private scrollRaf: number | null = null;

  constructor(root: HTMLElement, nav: HTMLElement, cb: CanvasCallbacks) {
    this.root = root;
    this.cb = cb;
    nav.hidden = true; // the axis itself is the navigation now
    this.world = document.createElement('div');
    this.world.className = 'mm-canvas__world';
    this.zoom = document.createElement('div');
    this.zoom.className = 'mm-zoom';
    this.info = document.createElement('div');
    this.info.className = 'mm-zoom__info';
    this.lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.lines.setAttribute('class', 'mm-zoom__lines');
    this.lines.setAttribute('aria-hidden', 'true');
    this.root.appendChild(this.world);
    this.bind();
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
    return Math.round(Math.max(250, Math.min(this.height - 170, this.height * 0.58)));
  }

  /** Grid step for the collage; tiles are drawn larger than a step so they overlap. */
  private get step(): number {
    return this.width < 600 ? 22 : 27;
  }

  // ---- Build ------------------------------------------------------------------

  setSections(data: CanvasSection[], accent: 'saved' | 'release', keepState = false): void {
    const keepZoom = keepState ? this.zoomKey : null;
    const keepPin = keepState ? this.pinned : null;
    const keepInfo = this.info.innerHTML;
    this.lastData = data;
    this.accent = accent;
    this.root.dataset.accent = accent;
    this.world.innerHTML = '';
    this.sections = [];
    this.pinned = null;
    this.bloomed = null;

    const y0 = this.axisY;
    const step = this.step;
    const colTop = y0 + 82;
    const rows = Math.max(3, Math.floor((this.height - 22 - colTop) / step));
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
      // Albums with more saved songs take more room (1, 2 or 3 steps square).
      const spans = sec.items.map((it) => (it.trackIds.length >= 4 ? 3 : it.trackIds.length >= 2 ? 2 : 1));
      const area = spans.reduce((a, s) => a + s * s, 0);
      const cols = Math.max(4, Math.ceil((area * 1.1) / rows));
      const grid: boolean[][] = [];
      const free = (r: number, q: number, s: number) => {
        for (let dr = 0; dr < s; dr++) for (let dq = 0; dq < s; dq++) if (r + dr >= rows || grid[r + dr]?.[q + dq]) return false;
        return true;
      };
      const spots = spans.map((s0) => {
        for (let s = s0; s >= 1; s--) {
          for (let q = 0; q < cols + 60; q++) {
            if (s > 1 && q + s > cols) break;
            for (let r = 0; r < rows; r++) {
              if (free(r, q, s)) {
                for (let dr = 0; dr < s; dr++) for (let dq = 0; dq < s; dq++) (grid[r + dr] ??= [])[q + dq] = true;
                return { r, q, s };
              }
            }
          }
        }
        return { r: 0, q: cols, s: 1 };
      });
      const usedCols = Math.max(cols, ...spots.map((s) => s.q + s.s));
      const width = Math.max(170, usedCols * step + 40);

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
        <span class="mm-sec__divider" style="top:${y0 + 14}px"></span>
        <div class="mm-sec__head" style="top:${y0 + 16}px">
          <button type="button" class="mm-sec__year">${escapeHtml(sec.title)}</button>
          ${caption}
        </div>`;
      el.querySelector('.mm-sec__year')!.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      el.querySelector<HTMLButtonElement>('button.mm-sec__caption')?.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      this.world.appendChild(el);

      const section: Section = { data: sec, x, w: width, tiles: [] };
      sec.items.forEach((item, i) => {
        const spot = spots[i];
        const rand = seeded(item.id);
        // Drawn bigger than its grid spot, with a little jitter, so neighbours overlap.
        const size = spot.s * step + 12;
        const cx = x + 20 + spot.q * step + (spot.s * step) / 2 + (rand() - 0.5) * 6;
        const cy = colTop + spot.r * step + (spot.s * step) / 2 + (rand() - 0.5) * 6;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `mm-cov${item.outside ? ' is-outside' : ''}`;
        b.dataset.id = item.id;
        Object.assign(b.style, {
          left: `${cx - size / 2}px`,
          top: `${cy - size / 2}px`,
          width: `${size}px`,
          height: `${size}px`,
          zIndex: `${1 + Math.floor(rand() * 20)}`,
        });
        const n = item.trackIds.length;
        b.setAttribute('aria-label', `${item.title} by ${item.artist}. ${item.dateText}.`);
        b.innerHTML = `<img alt="" src="${coverUrl(item.track.cover, item.title)}" loading="lazy" draggable="false" />${n > 1 ? `<span class="mm-cov__count">${n}</span>` : ''}`;
        const tile: Tile = { item, el: b, cx, cy, size };
        this.bindTile(tile, section);
        this.world.appendChild(b);
        section.tiles.push(tile);
      });

      this.sections.push(section);
      x += width;
    }
    const worldW = x + LEFT;
    this.world.style.width = `${worldW}px`;
    this.world.style.height = `${this.height}px`;
    Object.assign(axis.style, { top: `${y0}px`, left: '16px', width: `${worldW - 32}px` });
    this.world.append(this.lines, this.zoom);
    this.scrollTarget = this.root.scrollLeft;

    const pin = keepPin && this.tileOf(keepPin.id) ? keepPin : null;
    this.zoomKey = null;
    if (pin) this.pin(pin.id, keepInfo);
    else this.showZoom(keepZoom && this.find(keepZoom) ? keepZoom : this.centerKey());
  }

  private bindTile(tile: Tile, sec: Section): void {
    const { el: b, item } = tile;
    b.addEventListener('click', (e) => {
      if (this.dragging) return e.preventDefault();
      this.cb.onSelect(item.id, sec.data.key, b.getBoundingClientRect());
    });
    b.addEventListener('pointerenter', () => {
      if (!this.pinned) this.showZoom(sec.data.key);
      this.hot(item.id, true);
      this.cb.onHover(item.id, b);
    });
    b.addEventListener('pointerleave', () => {
      this.hot(item.id, false);
      this.cb.onHover(null, null);
    });
    b.addEventListener('focus', () => {
      this.scrollIntoView(sec.data.key, false);
      if (!this.pinned) this.showZoom(sec.data.key);
      this.bloom(sec, tile.cx, tile.cy);
      this.hot(item.id, true);
      this.cb.onHover(item.id, b);
    });
    b.addEventListener('blur', () => {
      this.hot(item.id, false);
      this.cb.onHover(null, null);
    });
    b.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const all = this.sections.flatMap((s) => s.tiles.map((t) => t.el));
      all[all.indexOf(b) + dir]?.focus({ preventScroll: true });
    });
  }

  private find(key: string): Section | undefined {
    return this.sections.find((s) => s.data.key === key);
  }

  private tileOf(id: string): { tile: Tile; sec: Section } | undefined {
    for (const sec of this.sections) {
      const tile = sec.tiles.find((t) => t.item.id === id);
      if (tile) return { tile, sec };
    }
    return undefined;
  }

  private centerKey(): string | null {
    const mid = this.root.scrollLeft + this.width / 2;
    let best: Section | undefined;
    let bestD = Infinity;
    for (const s of this.sections) {
      const d = Math.abs(s.x + s.w / 2 - mid);
      if (d < bestD) [best, bestD] = [s, d];
    }
    return best?.data.key ?? null;
  }

  /** Links a tile in the collage and its copy in the magnifier. */
  private hot(id: string, on: boolean): void {
    this.tileOf(id)?.tile.el.classList.toggle('is-hot', on);
    this.zoom.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('is-hot', on);
  }

  // ---- Bloom (the reference video's motion) ---------------------------------------

  /** Pushes covers near the pointer outward and lifts the closest ones. */
  private bloom(sec: Section, px: number, py: number): void {
    if (this.bloomed && this.bloomed !== sec) this.settle(this.bloomed);
    this.bloomed = sec;
    const radius = this.step * 3.4;
    for (const t of sec.tiles) {
      const dx = t.cx - px;
      const dy = t.cy - py;
      const dist = Math.hypot(dx, dy) || 1;
      const f = Math.exp(-(dist * dist) / (2 * radius * radius));
      const push = f * this.step * 1.1;
      const scale = 1 + f * 0.75;
      t.el.style.transform = `translate(${(dx / dist) * push}px, ${(dy / dist) * push}px) scale(${scale.toFixed(3)})`;
      t.el.style.setProperty('--lift', `${Math.round(f * 100)}`);
      t.el.classList.toggle('is-lifted', f > 0.35);
    }
  }

  private settle(sec: Section): void {
    for (const t of sec.tiles) {
      t.el.style.transform = '';
      t.el.style.removeProperty('--lift');
      t.el.classList.remove('is-lifted');
    }
    if (this.bloomed === sec) this.bloomed = null;
  }

  // ---- Magnifier ----------------------------------------------------------------

  private zoomBox(sec: Section) {
    const top = 14;
    const height = this.axisY - 58 - top;
    const width = this.pinned
      ? Math.min(this.width - 32, 1040)
      : Math.min(this.width - 32, 920, Math.max(420, sec.w * 2.4));
    const minL = this.root.scrollLeft + 16;
    const maxL = this.root.scrollLeft + this.width - 16 - width;
    const left = Math.max(minL, Math.min(maxL, sec.x + sec.w / 2 - width / 2));
    return { top, height, width, left };
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
    if (!force && key === this.zoomKey && !this.zoom.hidden) return this.placeZoom();
    this.zoomKey = key;
    this.zoom.hidden = false;
    this.zoom.classList.remove('is-pinned');
    const box = this.zoomBox(sec);
    const units = sec.data.items.reduce((a, it) => a + (it.trackIds.length > 1 ? 4 : 1), 0);
    const pw = box.width - 28;
    const ph = box.height - 50;
    const c = Math.max(30, Math.min(150, Math.floor(Math.sqrt((pw * ph) / (units * 1.2)))));
    const songs = sec.data.items.reduce((a, it) => a + it.trackIds.length, 0);
    const items = sec.data.items
      .map((it, i) => this.zoomItem(it, it.trackIds.length > 1 ? ' is-big' : '', this.reducedMotion ? 0 : Math.min(i * 12, 360)))
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
    const sec = this.zoomKey ? this.find(this.zoomKey) : undefined;
    if (!sec || this.zoom.hidden) return;
    const box = this.zoomBox(sec);
    Object.assign(this.zoom.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    // Two lines from the box's lower corners to the year's stretch of the axis.
    const y0 = this.axisY;
    const b = box.top + box.height;
    this.lines.setAttribute('width', this.world.style.width.replace('px', ''));
    this.lines.setAttribute('height', `${this.height}`);
    this.lines.innerHTML = `
      <line x1="${box.left}" y1="${b}" x2="${sec.x + 4}" y2="${y0}" />
      <line x1="${box.left + box.width}" y1="${b}" x2="${sec.x + sec.w - 4}" y2="${y0}" />`;
    this.sections.forEach((s) => s.tiles.forEach((t) => t.el.classList.toggle('is-zoomed', s === sec)));
  }

  /** Pins the magnifier on one album: it grows, with its details beside it. */
  private pin(id: string, html: string): void {
    const found = this.tileOf(id);
    if (!found) return;
    const { tile, sec } = found;
    this.pinned = { id, key: sec.data.key };
    this.zoomKey = sec.data.key;
    this.zoom.hidden = false;
    this.zoom.classList.add('is-pinned');
    this.info.innerHTML = html;
    const pic = this.width < 600 ? 140 : Math.max(120, this.zoomBox(sec).height - 34);
    const others = sec.data.items.map((it) => this.zoomItem(it, it.id === id ? ' is-current' : '')).join('');
    this.zoom.innerHTML = `
      <figure class="mm-zoom__picked" style="width:${pic}px;height:${pic}px"><img src="${coverUrl(tile.item.track.cover, tile.item.title)}" alt="Cover of ${escapeHtml(tile.item.title)}" /></figure>
      <div class="mm-zoom__side"></div>
      <div class="mm-zoom__rest"><p class="mm-zoom__head"><strong>${escapeHtml(sec.data.title)}</strong><em>${sec.data.items.length} albums</em></p><div class="mm-zoom__grid" style="--c:38px">${others}</div></div>`;
    this.zoom.querySelector('.mm-zoom__side')!.appendChild(this.info);
    this.bindZoomItems(sec.data.key);
    this.sections.forEach((s) => s.tiles.forEach((t) => t.el.classList.toggle('is-selected', t.item.id === id)));
    this.placeZoom();
  }

  // ---- Public selection API (used by the app) ------------------------------------

  setSelected(id: string | null, html = '', label = ''): void {
    this.root.classList.toggle('has-picked', !!id);
    if (this.bloomed) this.settle(this.bloomed);
    if (!id) {
      this.pinned = null;
      this.sections.forEach((s) => s.tiles.forEach((t) => t.el.classList.remove('is-selected')));
      this.showZoom(this.zoomKey, true);
      return;
    }
    const found = this.tileOf(id);
    if (!found) return;
    this.zoom.setAttribute('aria-label', label);
    this.scrollIntoView(found.sec.data.key, true);
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
    const found = this.tileOf(id);
    if (!found) return;
    this.scrollIntoView(found.sec.data.key, true);
    if (!this.pinned) this.showZoom(found.sec.data.key);
    if (highlight) {
      const el = found.tile.el;
      el.classList.add('is-highlight');
      setTimeout(() => el.classList.remove('is-highlight'), 2400);
    }
  }

  focusItem(id: string): void {
    this.tileOf(id)?.tile.el.focus({ preventScroll: true });
  }

  rectOf(id: string): DOMRect | null {
    return this.tileOf(id)?.tile.el.getBoundingClientRect() ?? null;
  }

  private scrollIntoView(key: string, center: boolean): void {
    const s = this.find(key);
    if (!s) return;
    const left = this.root.scrollLeft;
    if (!center && s.x > left + 40 && s.x + s.w < left + this.width - 40) return;
    this.smoothTo(s.x + s.w / 2 - this.width / 2);
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
    this.root.scrollLeft = cur + diff * 0.14;
    this.scrollRaf = requestAnimationFrame(() => this.scrollTick());
  }

  // ---- Input --------------------------------------------------------------------

  private bind(): void {
    this.root.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as HTMLElement).closest('.mm-zoom')) return;
        // Trackpads send their own smooth horizontal motion; let it through.
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          this.scrollTarget = this.root.scrollLeft + e.deltaX;
          return;
        }
        e.preventDefault();
        const base = this.scrollRaf === null ? this.root.scrollLeft : this.scrollTarget;
        this.smoothTo(base + e.deltaY * 1.2);
      },
      { passive: false },
    );
    // Hover: the year under the pointer goes into the magnifier, and its albums spread.
    this.root.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || this.dragging) return;
      if ((e.target as HTMLElement).closest('.mm-zoom')) return;
      const r = this.root.getBoundingClientRect();
      const y = e.clientY - r.top;
      const x = this.root.scrollLeft + e.clientX - r.left;
      const sec = this.sections.find((s) => x >= s.x && x < s.x + s.w);
      if (y < this.axisY - 24 || !sec) {
        if (this.bloomed) this.settle(this.bloomed);
        return;
      }
      if (!this.pinned) this.showZoom(sec.data.key);
      if (y > this.axisY + 60) this.bloom(sec, x, y);
      else if (this.bloomed) this.settle(this.bloomed);
    });
    this.root.addEventListener('pointerleave', () => this.bloomed && this.settle(this.bloomed));
    let scrollTimer = 0;
    this.root.addEventListener('scroll', () => {
      this.placeZoom();
      if (this.scrollRaf === null) this.scrollTarget = this.root.scrollLeft;
      clearTimeout(scrollTimer);
      // After scrolling settles, the magnifier follows the year in the middle.
      scrollTimer = window.setTimeout(() => {
        if (!this.pinned) this.showZoom(this.centerKey());
      }, 180);
    });
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      // A click that re-drew the magnifier leaves its target detached; that isn't a background click.
      if (!t.isConnected || this.dragging || !this.pinned || t.closest('.mm-cov, .mm-zoom, .mm-sec__head')) return;
      this.cb.onBackground?.();
    });

    // Drag the background with a mouse to pan, with a little glide on release.
    let startX = 0;
    let startLeft = 0;
    let lastX = 0;
    let velocity = 0;
    let down = false;
    this.root.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('.mm-zoom, .mm-sec__head')) return;
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
        if (this.bloomed) this.settle(this.bloomed);
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
