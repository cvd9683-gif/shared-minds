// Music Map - Personal Timeline canvas
// Each year's albums stack in columns centred on the axis, taking the room they
// need so none are hidden; an album's size grows with how many of its songs you
// saved. The canvas pans in every direction and zooms (buttons, pinch, ctrl+wheel).
// A magnifying lens follows the pointer in 2D: the album under the cursor stays
// under it and grows, and its neighbours spread just enough to make room, all on
// springs so it feels like moving through the collage by hand. The year panel sits
// at the top centre, joined to its year by two lines.

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
  /** Rest position and size (world units). */
  rx: number;
  ry: number;
  rs: number;
  /** Collage scatter direction and size bias. */
  sx: number;
  sy: number;
  scale: number;
  z: number;
  /** Current position/size and their velocities (springs). */
  x: number;
  y: number;
  s: number;
  vx: number;
  vy: number;
  vs: number;
  lastZ: number;
}

interface Section {
  data: CanvasSection;
  x: number;
  w: number;
  tiles: Tile[];
}

const LEFT = 60;
const PAD = 50;
const GAP_W = 80;

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
  private worldW = 0;
  private zoomKey: string | null = null;
  private pinned: { id: string; key: string } | null = null;
  private reducedMotion = false;
  private touch = matchMedia('(hover: none)').matches;
  private dragging = false;
  private accent: 'saved' | 'release' = 'saved';
  private lastData: CanvasSection[] = [];
  private cam = { k: 1, tx: 0, ty: 0 };
  private goal = { k: 1, tx: 0, ty: 0 };
  private ptr = { x: 0, y: 0, inside: false };
  private lens = { x: 0, y: 0, s: 0, ts: 0 };
  private raf: number | null = null;
  private idle = 0;
  private visible = true;

  constructor(root: HTMLElement, nav: HTMLElement, cb: CanvasCallbacks) {
    this.root = root;
    this.stage = root.parentElement!;
    this.cb = cb;
    nav.hidden = true; // the axis itself is the navigation
    this.world = document.createElement('div');
    this.world.className = 'mm-canvas__world';
    this.root.appendChild(this.world);
    // The magnifier and its lines live on the stage, docked on the right.
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
    this.visible = v;
    this.zoom.classList.toggle('is-away', !v);
    this.lines.classList.toggle('is-away', !v);
    if (v) this.kick();
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  resize(w: number, h: number): void {
    const changed = Math.abs(h - this.height) > 1 || Math.abs(w - this.width) > 1;
    this.width = w;
    this.height = h;
    if (changed && this.lastData.length) this.setSections(this.lastData, this.accent, true);
  }

  private get axisY(): number {
    return Math.round(this.height * 0.63);
  }

  /** Height of each year's column of albums, centred on the axis. */
  private get colH(): number {
    return Math.max(180, Math.min(this.height * 0.6, 560));
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
      // Albums settle into loose clumps around the axis, in saved order from left to
      // right: a wandering drift rather than a grid, but no cover ever hides another.
      const GAP = small ? 4 : 6;
      const half = this.colH / 2;
      const sizes = sec.items.map((it) => Math.min(small ? 84 : 124, Math.round((small ? 36 : 46) + (small ? 18 : 26) * (Math.sqrt(it.trackIds.length) - 1))));
      const area = sizes.reduce((a, sz) => a + (sz + GAP) * (sz + GAP), 0);
      // Roughly how wide the year needs to be at a loose packing density.
      const span = Math.max(sizes[0] ?? 60, area / (2 * half * 0.62));
      const start = x + PAD;
      const phase = seeded(sec.key)() * Math.PI * 2;
      const placed: { x: number; y: number; s: number }[] = [];
      const free = (cx: number, cy: number, sz: number) =>
        cx - sz / 2 >= start &&
        Math.abs(cy - y0) + sz / 2 <= half &&
        placed.every((p) => Math.abs(p.x - cx) * 2 >= p.s + sz + GAP * 2 || Math.abs(p.y - cy) * 2 >= p.s + sz + GAP * 2);
      let maxX = start;
      sec.items.forEach((item, i) => {
        const rs = sizes[i];
        const rand = seeded(item.id);
        const t = sec.items.length > 1 ? i / (sec.items.length - 1) : 0.5;
        // The drift: a slow wave through the year, so albums gather into clumps above and below the line.
        const ax = start + rs / 2 + t * Math.max(0, span - rs);
        const ay = y0 + Math.sin(phase + t * 5.2) * (half - rs / 2) * 0.55 + (rand() - 0.5) * half * 0.3;
        // Fallback if the spiral finds no room: start a new clump just to the right.
        let px = maxX + GAP + rs / 2;
        let py = y0 + (rand() - 0.5) * (half - rs / 2);
        for (let step = 0, ang = rand() * Math.PI * 2, r = 0; step < 4000; step++) {
          const cx = ax + Math.cos(ang) * r;
          const cy = ay + Math.sin(ang) * r * 0.8;
          if (free(cx, cy, rs)) {
            px = cx;
            py = cy;
            break;
          }
          ang += 0.62;
          r += 0.9;
        }
        placed.push({ x: px, y: py, s: rs });
        maxX = Math.max(maxX, px + rs / 2);
        const tile: Tile = {
          item,
          section,
          el: document.createElement('button'),
          rx: px,
          ry: py,
          rs,
          sx: 0,
          sy: 0,
          scale: 1,
          z: 10 + Math.round(rs / 10),
          x: px,
          y: py,
          s: rs,
          vx: 0,
          vy: 0,
          vs: 0,
          lastZ: -1,
        };
        const n = item.trackIds.length;
        const b = tile.el;
        b.type = 'button';
        b.className = `mm-cov${item.outside ? ' is-outside' : ''}`;
        b.dataset.id = item.id;
        b.setAttribute('aria-label', `${item.title} by ${item.artist}. ${item.dateText}.`);
        b.innerHTML = `<img alt="" src="${coverUrl(item.track.cover, item.title)}" loading="lazy" draggable="false" />${n > 1 ? `<span class="mm-cov__count">${n}</span>` : ''}`;
        this.bindTile(tile);
        this.world.appendChild(b);
        this.writeTile(tile);
        section.tiles.push(tile);
        this.tiles.push(tile);
      });
      const cursor = maxX + GAP;
      section.w = Math.max(small ? 140 : 180, cursor - x + PAD - GAP);

      const el = document.createElement('section');
      el.className = 'mm-sec';
      Object.assign(el.style, { left: `${x}px`, width: `${section.w}px`, height: `${this.height}px` });
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
        <div class="mm-sec__head" style="top:${Math.max(4, y0 - this.colH / 2 - 44)}px">
          <button type="button" class="mm-sec__year">${escapeHtml(sec.title)}</button>
          ${caption}
        </div>`;
      el.querySelector('.mm-sec__year')!.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      el.querySelector<HTMLButtonElement>('button.mm-sec__caption')?.addEventListener('click', () => this.cb.onCaption?.(sec.key));
      this.world.insertBefore(el, this.world.firstChild);
      this.sections.push(section);
      x += section.w;
    }
    this.worldW = x + LEFT;
    Object.assign(this.world.style, { width: `${this.worldW}px`, height: `${this.height}px` });
    Object.assign(axis.style, { top: `${y0}px`, left: '16px', width: `${this.worldW - 32}px` });

    if (!keepState || !this.userMoved) this.home();
    this.lens.s = this.lens.ts = this.touch ? 1 : 0;
    this.lens.x = (this.width / 2 - this.cam.tx) / this.cam.k;
    this.lens.y = this.axisY;

    const pin = keepPin && this.tileOf(keepPin.id) ? keepPin : null;
    this.zoomKey = null;
    if (pin) this.pin(pin.id, keepInfo);
    else this.showZoom(keepZoom && this.find(keepZoom) ? keepZoom : this.centerKey());
    this.kick();
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
      this.centerOn(tile.rx);
      if (!this.pinned) this.showZoom(section.data.key);
      this.lens.ts = 1;
      this.ptr = { x: this.width / 2, y: this.axisY * this.cam.k + this.cam.ty, inside: true };
      this.hot(item.id, true);
      this.cb.onHover(item.id, b);
      this.kick();
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

  private sectionAt(wx: number): Section | undefined {
    return this.sections.find((s) => wx >= s.x && wx < s.x + s.w);
  }

  private centerKey(): string | null {
    const mid = (this.width / 2 - this.goal.tx) / this.goal.k;
    let best: Section | undefined;
    let bestD = Infinity;
    for (const s of this.sections) {
      const d = mid < s.x ? s.x - mid : mid > s.x + s.w ? mid - s.x - s.w : 0;
      if (d < bestD) [best, bestD] = [s, d];
    }
    return best?.data.key ?? null;
  }

  /** Links a cover on the line and its copy in the magnifier. */
  private hot(id: string, on: boolean): void {
    this.tileOf(id)?.el.classList.toggle('is-hot', on);
    this.zoom.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('is-hot', on);
  }

  // ---- Camera -----------------------------------------------------------------------

  private userMoved = false;

  /** Opening view: the most recent years, ending near the right edge. */
  private home(): void {
    const last = this.sections[this.sections.length - 1];
    const end = last ? last.x + last.w : 0;
    this.goal = { k: 1, tx: this.width * 0.88 - end, ty: 0 };
    this.clampGoal();
    this.cam = { ...this.goal };
  }

  private clampGoal(): void {
    const g = this.goal;
    const half = this.width / 2;
    g.tx = Math.min(half, Math.max(half - this.worldW * g.k, g.tx));
    g.ty = Math.max(-this.height * 0.5, Math.min(this.height * 0.5, g.ty));
  }

  private panBy(dx: number, dy: number, direct = false): void {
    this.userMoved = true;
    this.goal.tx += dx;
    this.goal.ty += dy;
    this.clampGoal();
    if (direct) {
      this.cam.tx = this.goal.tx;
      this.cam.ty = this.goal.ty;
    }
    this.kick();
  }

  /** Zooms out to show every year at once. */
  fit(): void {
    const k = Math.max(0.15, Math.min(1, (this.width - 40) / this.worldW));
    this.goal = { k, tx: (this.width - this.worldW * k) / 2, ty: this.height * 0.62 - this.axisY * k };
    this.kick();
  }

  zoomBy(f: number, cx = this.width / 2, cy = this.height / 2): void {
    this.userMoved = true;
    const k = Math.max(0.15, Math.min(3, this.goal.k * f));
    const r = k / this.goal.k;
    this.goal = { k, tx: cx - (cx - this.goal.tx) * r, ty: cy - (cy - this.goal.ty) * r };
    this.clampGoal();
    this.kick();
  }

  /** Eases a world x to the middle of the screen (and the axis back to its home height). */
  private centerOn(wx: number): void {
    this.goal.tx = this.width / 2 - wx * this.goal.k;
    this.goal.ty += (0 - this.goal.ty) * 0.6;
    this.clampGoal();
    this.kick();
  }

  /** After you stop moving, the nearest year settles into the centre. */
  private settleSoon(): void {
    clearTimeout(this.idle);
    this.idle = window.setTimeout(() => {
      if (this.pinned || this.dragging) return;
      const key = this.centerKey();
      const sec = key ? this.find(key) : undefined;
      if (!sec) return;
      // Long years don't jump to their middle; they just come fully into view.
      if (sec.w * this.goal.k < this.width * 0.9) this.centerOn(sec.x + sec.w / 2);
      if (!this.ptr.inside || this.touch) this.showZoom(key);
    }, 260);
  }

  // ---- Frame: camera, lens, springs --------------------------------------------------

  private kick(): void {
    if (this.raf === null && this.visible) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = null;
    const c = this.cam;
    const g = this.goal;
    const snap = this.reducedMotion;
    const e = snap ? 1 : 0.12;
    c.k += (g.k - c.k) * e;
    c.tx += (g.tx - c.tx) * e;
    c.ty += (g.ty - c.ty) * e;
    let moving = Math.abs(g.k - c.k) > 0.0004 || Math.abs(g.tx - c.tx) > 0.2 || Math.abs(g.ty - c.ty) > 0.2;
    this.world.style.transform = `translate(${c.tx}px, ${c.ty}px) scale(${c.k})`;

    // Lens follows the pointer (or the middle of the screen on touch).
    const l = this.lens;
    const px = this.touch ? this.width / 2 : this.ptr.x;
    const py = this.touch ? this.axisY * c.k + c.ty : this.ptr.y;
    const lx = (px - c.tx) / c.k;
    const ly = (py - c.ty) / c.k;
    const le = snap ? 1 : 0.2;
    l.x += (lx - l.x) * le;
    l.y += (ly - l.y) * le;
    l.s += (l.ts - l.s) * (snap ? 1 : 0.1);
    moving ||= Math.abs(lx - l.x) > 0.3 || Math.abs(l.ts - l.s) > 0.003;

    const R = Math.max(90, Math.min(170, this.width * 0.11)) / c.k;
    const pinnedId = this.pinned?.id;
    const left = -c.tx / c.k - R * 3;
    const right = (this.width - c.tx) / c.k + R * 3;

    for (const t of this.tiles) {
      const onScreen = t.rx > left && t.rx < right;
      let tx = t.rx;
      let ty = t.ry;
      let ts = t.rs;
      let z = t.z;
      if (t.item.id === pinnedId) {
        ts = t.rs * 1.8;
        z = 400;
      } else if (onScreen && !pinnedId) {
        // 2D magnifier: positions scale out from the pointer and sizes grow with them,
        // so the album under the cursor stays under it and its neighbours make room.
        const dx = t.rx - l.x;
        const dy = t.ry - l.y;
        const f = Math.exp(-(dx * dx + dy * dy) / (2 * R * R)) * l.s;
        tx = l.x + dx * (1 + 0.95 * f);
        ty = l.y + dy * (1 + 0.95 * f);
        ts = t.rs * (1 + 1.05 * f);
        z = t.z + Math.round(f * 200);
      }
      if (!onScreen && Math.abs(t.x - tx) < 0.5 && Math.abs(t.s - ts) < 0.5) continue;
      if (snap || !onScreen) {
        t.x = tx;
        t.y = ty;
        t.s = ts;
        t.vx = t.vy = t.vs = 0;
      } else {
        // Springs with a touch of overshoot: the line breathes rather than snaps.
        t.vx = (t.vx + (tx - t.x) * 0.16) * 0.74;
        t.vy = (t.vy + (ty - t.y) * 0.16) * 0.74;
        t.vs = (t.vs + (ts - t.s) * 0.16) * 0.74;
        t.x += t.vx;
        t.y += t.vy;
        t.s += t.vs;
        if (Math.abs(t.vx) + Math.abs(t.vy) + Math.abs(t.vs) > 0.08 || Math.abs(tx - t.x) + Math.abs(ty - t.y) > 0.3) moving = true;
      }
      if (onScreen || snap) {
        this.writeTile(t, z);
        t.el.classList.toggle('is-bloomed', t.s > t.rs * 1.5);
      }
    }
    this.placeLines();
    if (moving) this.kick();
  }

  private writeTile(t: Tile, z = t.z): void {
    // Size is set once; growth is a GPU scale, so moving the lens never forces layout.
    if (!t.el.style.width) {
      t.el.style.width = `${t.rs}px`;
      t.el.style.height = `${t.rs}px`;
    }
    const k = t.s / t.rs;
    t.el.style.transform = `translate(${t.x - t.rs / 2}px, ${t.y - t.rs / 2}px) scale(${k.toFixed(4)})`;
    if (z !== t.lastZ) {
      t.el.style.zIndex = `${z}`;
      t.lastZ = z;
    }
  }

  // ---- Docked magnifier ----------------------------------------------------------

  private zoomBox() {
    const pinned = !!this.pinned;
    const narrow = this.width < 600;
    const width = narrow ? this.width - 24 : pinned ? Math.min(this.width - 32, 960) : Math.min(520, Math.max(320, this.width * 0.36));
    const height = narrow ? (pinned ? 280 : 140) : Math.max(140, Math.min(pinned ? 340 : 210, this.height * (pinned ? 0.42 : 0.22)));
    // Fixed in the middle of the screen; only its lines follow the year as the canvas moves.
    const left = narrow ? 12 : Math.round((this.width - width) / 2);
    return { top: 12, height, width, left };
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
    if (!force && key === this.zoomKey && !this.zoom.hidden) return;
    this.zoomKey = key;
    this.zoom.hidden = false;
    this.zoom.classList.remove('is-pinned');
    const box = this.zoomBox();
    const units = sec.data.items.reduce((a, it) => a + (it.trackIds.length > 1 ? 4 : 1), 0);
    const c = Math.max(26, Math.min(130, Math.floor(Math.sqrt(((box.width - 26) * (box.height - 48)) / (units * 1.25)))));
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
    Object.assign(this.zoom.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    this.placeLines();
  }

  /** Two lines from the magnifier's lower corners to its year's stretch of the axis. */
  private placeLines(): void {
    const sec = this.zoomKey ? this.find(this.zoomKey) : undefined;
    if (!sec || this.zoom.hidden) {
      this.lines.innerHTML = '';
      return;
    }
    const { k, tx, ty } = this.cam;
    const box = this.zoomBox();
    const b = box.top + box.height;
    const ay = (this.axisY - this.colH / 2 - 8) * k + ty;
    const clampX = (v: number) => Math.max(-60, Math.min(this.width + 60, v));
    this.lines.setAttribute('width', `${this.width}`);
    this.lines.setAttribute('height', `${this.height}`);
    this.lines.innerHTML = `
      <line x1="${box.left}" y1="${b}" x2="${clampX(sec.x * k + tx + 4)}" y2="${ay}" />
      <line x1="${box.left + box.width}" y1="${b}" x2="${clampX((sec.x + sec.w) * k + tx - 4)}" y2="${ay}" />`;
    if (this.lastLinked !== sec) {
      this.lastLinked = sec;
      this.sections.forEach((s) => s.tiles.forEach((t) => t.el.classList.toggle('is-zoomed', s === sec)));
    }
  }
  private lastLinked: Section | null = null;

  /** Pins the magnifier on one album: it grows on the line, with its details beside it. */
  private pin(id: string, html: string): void {
    const tile = this.tileOf(id);
    if (!tile) return;
    const sec = tile.section;
    this.pinned = { id, key: sec.data.key };
    this.zoomKey = sec.data.key;
    this.lastLinked = null;
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
    this.centerOn(tile.rx);
  }

  // ---- Public selection API (used by the app) ------------------------------------

  setSelected(id: string | null, html = '', label = ''): void {
    this.root.classList.toggle('has-picked', !!id);
    if (!id) {
      this.pinned = null;
      this.tiles.forEach((t) => t.el.classList.remove('is-selected'));
      this.showZoom(this.zoomKey, true);
      this.kick();
      return;
    }
    if (!this.tileOf(id)) return;
    this.zoom.setAttribute('aria-label', label);
    this.pin(id, html);
  }

  updateCallout(html: string): void {
    if (this.pinned) this.info.innerHTML = html;
  }

  get calloutEl(): HTMLElement {
    return this.info;
  }

  /** The year panel lives outside the canvas, so the app listens to it directly. */
  get panelEl(): HTMLElement {
    return this.zoom;
  }

  scrollToSection(key: string): void {
    const s = this.find(key);
    if (s) this.centerOn(s.x + Math.min(s.w, this.width * 0.8) / 2);
  }

  scrollToItem(id: string, highlight = false): void {
    const tile = this.tileOf(id);
    if (!tile) return;
    this.centerOn(tile.rx);
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

  // ---- Input --------------------------------------------------------------------

  private local(e: { clientX: number; clientY: number }) {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bind(): void {
    this.root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.local(e);
        if (e.ctrlKey) {
          this.zoomBy(Math.exp(-e.deltaY * 0.01), p.x, p.y);
        } else if (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40) {
          // A mouse wheel moves along the timeline…
          this.panBy(-e.deltaY * 1.2, 0);
        } else {
          // …a trackpad moves the canvas freely in both directions.
          this.panBy(-e.deltaX, -e.deltaY);
        }
        this.settleSoon();
      },
      { passive: false },
    );
    this.root.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const p = this.local(e);
      this.ptr = { ...p, inside: true };
      if (!this.pinned && !this.dragging) {
        this.lens.ts = 1;
        const sec = this.sectionAt((p.x - this.cam.tx) / this.cam.k);
        if (sec) this.showZoom(sec.data.key);
      }
      this.kick();
    });
    this.root.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      this.ptr.inside = false;
      if (!this.pinned) this.lens.ts = 0;
      this.settleSoon();
      this.kick();
    });
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (!t.isConnected || this.dragging || !this.pinned || t.closest('.mm-cov, .mm-sec__head')) return;
      this.cb.onBackground?.();
    });

    // Drag anywhere to move the canvas (with a glide); two fingers pinch to zoom.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let moved = 0;
    let vel = { x: 0, y: 0 };
    this.root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.mm-sec__head')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      vel = { x: 0, y: 0 };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    window.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = this.root.getBoundingClientRect();
        if (pinch) this.zoomBy(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        pinch = d;
        moved += 10;
        return;
      }
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 6 && !this.dragging) {
        this.dragging = true;
        this.root.classList.add('is-dragging');
        try {
          this.root.setPointerCapture(e.pointerId);
        } catch {
          /* pointer may already be released */
        }
      }
      if (this.dragging) {
        vel = { x: dx, y: dy };
        this.panBy(dx, dy, true);
      }
    });
    const end = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (this.dragging && !pointers.size) {
        if (!this.reducedMotion) this.panBy(vel.x * 10, vel.y * 10);
        this.root.classList.remove('is-dragging');
        setTimeout(() => (this.dragging = false), 0);
        this.settleSoon();
      }
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
