// Music Map - Historical Timeline as a web of the whole library
// Items (albums or songs) gather around hubs (artists, genres), or float in one
// open field when mapped by album. Changing what the map is organised by morphs
// every cover from where it was to where it belongs. Covers are sized by how much
// of them you saved. Drawn on a 2D canvas so a large library stays smooth: scroll
// or pinch to zoom, drag to move (with a glide), and a soft lens under the cursor
// parts and enlarges the covers you pass over.

export interface WebItem {
  id: string;
  title: string;
  sub: string;
  cover: string;
  /** Songs you saved from it (0 = outside your collection). Drives the cover size. */
  saved: number;
  outside: boolean;
  /** The hub this item gathers around ('' = none). */
  hubId: string;
  /** Other hubs it's linked to (producers, writers…), drawn as lines across the web. */
  linkHubIds: string[];
  /** Lowercase text used by the filter. */
  search: string;
  /** Item to morph from when this id didn't exist in the previous form (e.g. song ← album). */
  morphFrom?: string;
}
export interface WebHub {
  id: string;
  name: string;
}
export interface WebLink {
  a: string;
  b: string;
  kind: 'samples' | 'interpolates' | 'other';
  uncertain: boolean;
}

export interface WebCallbacks {
  onSelect(kind: 'item' | 'hub', id: string, rect: DOMRect): void;
  onHover(info: { title: string; sub: string; x: number; y: number } | null): void;
}

interface INode {
  item: WebItem;
  hub: HNode;
  x: number;
  y: number;
  fx: number;
  fy: number;
  s: number;
  /** Eased lens amount (0…1) and the last drawn screen box, for hit-testing. */
  f: number;
  sx: number;
  sy: number;
  ss: number;
}
interface HNode {
  hub: WebHub;
  x: number;
  y: number;
  r: number;
  items: INode[];
  bare: boolean;
}

const EASE = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class LibraryWeb {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: WebCallbacks;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private w = 800;
  private h = 600;
  private items: INode[] = [];
  private hubs: HNode[] = [];
  private byId = new Map<string, INode>();
  private hubById = new Map<string, HNode>();
  private links: { a: INode; b: INode; kind: WebLink['kind']; uncertain: boolean }[] = [];
  private credits: { hub: HNode; item: INode }[] = [];
  private images = new Map<string, HTMLImageElement>();
  /** Small pre-drawn copies of each cover: drawing these is far cheaper than the originals. */
  private thumbs = new Map<string, HTMLCanvasElement>();
  private thumbQueue: string[] = [];
  /** Each cover's average colour, for covers too small on screen to be worth drawing as images. */
  private tones = new Map<string, string>();
  private bigThumbs = new Map<string, HTMLCanvasElement>();
  private bigBudget = 0;
  private cam = { k: 1, tx: 0, ty: 0 };
  private goal = { k: 1, tx: 0, ty: 0 };
  private morph = 1;
  private morphStart = 0;
  private hoverItem: INode | null = null;
  private hoverHub: HNode | null = null;
  private mouse = { x: 0, y: 0, in: false };
  private match: Set<INode> | null = null;
  private raf: number | null = null;
  private reducedMotion = false;
  private visible = false;
  private fitted = false;
  private bare = false;

  constructor(canvas: HTMLCanvasElement, cb: WebCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.cb = cb;
    this.bind();
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.canvas.hidden = !v;
    if (v) {
      if (!this.fitted) this.fit(false);
      this.kick();
    }
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.kick();
  }

  // ---- Layout -----------------------------------------------------------------------

  /** Lays out a new form. Covers move from their previous positions to the new ones. */
  setData(items: WebItem[], hubs: WebHub[], links: WebLink[], opts: { bare?: boolean } = {}): void {
    const prev = new Map(this.items.map((n) => [n.item.id, { x: this.curX(n), y: this.curY(n) }]));
    const first = this.items.length === 0;
    this.bare = !!opts.bare;
    const hubMap = new Map<string, HNode>();
    const hubInfo = new Map(hubs.map((h) => [h.id, h]));
    const none: WebHub = { id: '_none', name: '' };
    this.items = [];
    for (const item of items) {
      const hub = (item.hubId && hubInfo.get(item.hubId)) || none;
      let h = hubMap.get(hub.id);
      if (!h) hubMap.set(hub.id, (h = { hub, x: 0, y: 0, r: 0, items: [], bare: this.bare || hub === none }));
      const s = item.saved > 0 ? 34 + 22 * Math.sqrt(item.saved) : 30;
      const n: INode = { item, hub: h, x: 0, y: 0, fx: 0, fy: 0, s, f: 0, sx: 0, sy: 0, ss: 0 };
      h.items.push(n);
      this.items.push(n);
    }
    // Hubs that are only linked to (e.g. a producer with no albums of their own).
    if (!this.bare)
      for (const item of items)
        for (const id of item.linkHubIds) {
          const hub = hubInfo.get(id);
          if (hub && !hubMap.has(id)) hubMap.set(id, { hub, x: 0, y: 0, r: 10, items: [], bare: false });
        }
    this.hubs = [...hubMap.values()];
    // Each hub's covers form a tight sunflower, biggest in the middle, barely overlapping.
    for (const h of this.hubs) {
      h.items.sort((a, b) => b.s - a.s);
      const mean = h.items.reduce((t, n) => t + n.s, 0) / Math.max(1, h.items.length);
      h.items.forEach((n, i) => {
        const r = h.items.length === 1 ? 0 : mean * 0.62 * Math.sqrt(i + (h.bare ? 0.2 : 0.8));
        const a = i * 2.39996;
        n.x = Math.cos(a) * r;
        n.y = Math.sin(a) * r;
      });
      const far = h.items.reduce((m, n) => Math.max(m, Math.hypot(n.x, n.y) + n.s * 0.7), 0);
      h.r = h.items.length ? far + (h.bare ? 0 : 16) : 10;
    }
    this.packHubs(links);
    for (const h of this.hubs)
      for (const n of h.items) {
        n.x += h.x;
        n.y += h.y;
      }
    this.byId = new Map(this.items.map((n) => [n.item.id, n]));
    this.hubById = new Map(this.hubs.map((h) => [h.hub.id, h]));
    this.links = links
      .map((l) => ({ a: this.byId.get(l.a)!, b: this.byId.get(l.b)!, kind: l.kind, uncertain: l.uncertain }))
      .filter((l) => l.a && l.b && l.a !== l.b);
    this.credits = [];
    if (!this.bare)
      for (const n of this.items)
        for (const id of n.item.linkHubIds.slice(0, 6)) {
          const h = this.hubById.get(id);
          if (h && h !== n.hub) this.credits.push({ hub: h, item: n });
        }
    // Morph: start each cover where it (or what it came from) was.
    for (const n of this.items) {
      const from = prev.get(n.item.id) ?? (n.item.morphFrom ? prev.get(n.item.morphFrom) : undefined);
      if (from) {
        n.fx = from.x;
        n.fy = from.y;
      } else {
        n.fx = first ? n.hub.x * 0.2 : n.x;
        n.fy = first ? n.hub.y * 0.2 : n.y;
      }
      this.loadImage(n.item.cover);
    }
    this.morph = this.reducedMotion ? 1 : 0;
    this.morphStart = performance.now();
    this.match = null;
    this.fitted = false;
    if (this.visible) this.fit(!first);
    this.kick();
  }

  /** Fades everything that doesn't match, and frames what does. */
  setFilter(q: string): number {
    const t = q.trim().toLowerCase();
    if (!t) {
      this.match = null;
      this.fit();
      return this.items.length;
    }
    this.match = new Set(this.items.filter((n) => n.item.search.includes(t)));
    if (this.match.size) this.fit(true, [...this.match]);
    this.kick();
    return this.match.size;
  }

  private packHubs(links: WebLink[]): void {
    const hubs = [...this.hubs].sort((a, b) => b.r - a.r);
    const meanR = hubs.reduce((t, h) => t + h.r, 0) / Math.max(1, hubs.length);
    hubs.forEach((h, i) => {
      const a = i * 2.39996;
      const rad = Math.sqrt(i) * meanR * 1.5;
      h.x = Math.cos(a) * rad;
      h.y = Math.sin(a) * rad * 0.8;
    });
    if (hubs.length < 2) return;
    const hubOf = new Map<string, HNode>();
    for (const h of this.hubs) for (const n of h.items) hubOf.set(n.item.id, h);
    const springs: [HNode, HNode][] = [];
    for (const h of this.hubs)
      for (const n of h.items)
        for (const id of n.item.linkHubIds) {
          const o = this.hubs.find((x) => x.hub.id === id);
          if (o && o !== h) springs.push([h, o]);
        }
    for (const l of links) {
      const a = hubOf.get(l.a);
      const b = hubOf.get(l.b);
      if (a && b && a !== b) springs.push([a, b]);
    }
    const iterations = hubs.length > 400 ? 70 : 150;
    for (let it = 0; it < iterations; it++) {
      const cool = 1 - it / iterations;
      for (const h of hubs) {
        h.x -= h.x * 0.03 * cool;
        h.y -= h.y * 0.035 * cool;
      }
      for (const [a, b] of springs) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d - (a.r + b.r)) / d) * 0.03 * cool;
        a.x += dx * f;
        a.y += dy * f;
        b.x -= dx * f;
        b.y -= dy * f;
      }
      for (let i = 0; i < hubs.length; i++)
        for (let j = i + 1; j < hubs.length; j++) {
          const a = hubs[i];
          const b = hubs[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const min = a.r + b.r + 2;
          if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d >= min) continue;
          const o = ((min - d) / d) * 0.5;
          a.x -= dx * o;
          a.y -= dy * o;
          b.x += dx * o;
          b.y += dy * o;
        }
    }
  }

  private loadImage(src: string): void {
    if (!src || this.images.has(src)) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.thumbQueue.push(src);
      this.kick();
    };
    img.src = src;
    this.images.set(src, img);
  }

  /** A sharper copy for covers drawn large; made a couple per frame, on demand. */
  private bigThumb(src: string): HTMLCanvasElement | undefined {
    const have = this.bigThumbs.get(src);
    if (have || this.bigBudget <= 0) return have;
    const img = this.images.get(src);
    if (!img?.complete || !img.naturalWidth) return undefined;
    this.bigBudget--;
    const c = document.createElement('canvas');
    c.width = c.height = 320;
    try {
      c.getContext('2d')!.drawImage(img, 0, 0, 320, 320);
      this.bigThumbs.set(src, c);
      return c;
    } catch {
      return undefined;
    }
  }

  /** Turns a few loaded covers into thumbnails per frame, so a big library never blocks. */
  private makeThumbs(): boolean {
    const start = performance.now();
    while (this.thumbQueue.length && performance.now() - start < 6) {
      const src = this.thumbQueue.shift()!;
      const img = this.images.get(src);
      if (!img?.naturalWidth && !img?.complete) continue;
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      try {
        const g = c.getContext('2d', { willReadFrequently: false })!;
        g.drawImage(img, 0, 0, 96, 96);
        this.thumbs.set(src, c);
        const px = document.createElement('canvas');
        px.width = px.height = 1;
        const pg = px.getContext('2d', { willReadFrequently: true })!;
        pg.drawImage(c, 0, 0, 1, 1);
        const [r, gr, b] = pg.getImageData(0, 0, 1, 1).data;
        this.tones.set(src, `rgb(${r},${gr},${b})`);
      } catch {
        /* cross-origin or broken image: fall back to the original */
      }
    }
    return this.thumbQueue.length > 0;
  }

  private curX(n: INode): number {
    return n.fx + (n.x - n.fx) * EASE(this.morph);
  }
  private curY(n: INode): number {
    return n.fy + (n.y - n.fy) * EASE(this.morph);
  }

  // ---- Camera ---------------------------------------------------------------------

  fit(animate = true, only?: INode[]): void {
    const list = only ?? this.items;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const n of list) {
      x0 = Math.min(x0, n.x - n.s);
      x1 = Math.max(x1, n.x + n.s);
      y0 = Math.min(y0, n.y - n.s);
      y1 = Math.max(y1, n.y + n.s);
    }
    if (!isFinite(x0)) [x0, y0, x1, y1] = [-100, -100, 100, 100];
    const top = 110;
    // Leave room for the guide panel on the right on wide screens.
    const right = this.w > 1000 ? 400 : 20;
    const aw = this.w - 60 - right;
    const k = Math.max(0.04, Math.min(2.2, aw / (x1 - x0), (this.h - top - 40) / (y1 - y0)));
    this.goal = { k, tx: 40 + aw / 2 - ((x0 + x1) / 2) * k, ty: top + (this.h - top - 40) / 2 - ((y0 + y1) / 2) * k };
    if (!animate || this.reducedMotion) this.cam = { ...this.goal };
    this.fitted = true;
    this.kick();
  }

  zoomBy(f: number, cx = this.w / 2, cy = this.h / 2): void {
    const k = Math.max(0.04, Math.min(6, this.goal.k * f));
    const r = k / this.goal.k;
    this.goal = { k, tx: cx - (cx - this.goal.tx) * r, ty: cy - (cy - this.goal.ty) * r };
    this.kick();
  }

  private panBy(dx: number, dy: number): void {
    this.goal.tx += dx;
    this.goal.ty += dy;
    this.cam.tx += dx;
    this.cam.ty += dy;
    this.kick();
  }

  // ---- Drawing --------------------------------------------------------------------

  private kick(): void {
    if (this.raf === null && this.visible) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = null;
    const c = this.cam;
    const g = this.goal;
    const e = this.reducedMotion ? 1 : 0.14;
    c.k += (g.k - c.k) * e;
    c.tx += (g.tx - c.tx) * e;
    c.ty += (g.ty - c.ty) * e;
    if (this.morph < 1) this.morph = Math.min(1, (performance.now() - this.morphStart) / 1100);
    let lensMoving = false;
    for (const n of this.items) {
      let target = 0;
      if (this.mouse.in) {
        const dx = this.curX(n) * c.k + c.tx - this.mouse.x;
        const dy = this.curY(n) * c.k + c.ty - this.mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 300 * 300) target = Math.exp(-d2 / (2 * 110 * 110));
      }
      if (Math.abs(target - n.f) > 0.003) {
        n.f += (target - n.f) * (this.reducedMotion ? 1 : 0.18);
        lensMoving = true;
      } else n.f = target;
    }
    const pending = this.makeThumbs();
    this.bigBudget = 2;
    this.draw();
    const moving = pending || lensMoving || this.morph < 1 || Math.abs(g.k - c.k) > 0.0005 || Math.abs(g.tx - c.tx) > 0.3 || Math.abs(g.ty - c.ty) > 0.3;
    if (moving) this.kick();
  }

  private draw(): void {
    const { ctx, cam } = this;
    const accent = getComputedStyle(this.canvas).getPropertyValue('--release').trim() || '#b0148c';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const m = EASE(this.morph);
    const hubPos = (h: HNode) => ({ x: h.x * cam.k + cam.tx, y: h.y * cam.k + cam.ty });
    // Screen positions, with the lens parting covers around the cursor.
    for (const n of this.items) {
      const bx = this.curX(n) * cam.k + cam.tx;
      const by = this.curY(n) * cam.k + cam.ty;
      const f = n.f;
      n.sx = this.mouse.in ? this.mouse.x + (bx - this.mouse.x) * (1 + 0.5 * f) : bx;
      n.sy = this.mouse.in ? this.mouse.y + (by - this.mouse.y) * (1 + 0.5 * f) : by;
      n.ss = n.s * cam.k * (1 + 0.85 * f) * (n === this.hoverItem ? 1.25 : 1);
    }
    const focusHub = this.hoverHub ?? this.hoverItem?.hub ?? null;
    const related = new Set<INode>();
    if (this.hoverItem) {
      related.add(this.hoverItem);
      this.links.forEach((l) => (l.a === this.hoverItem ? related.add(l.b) : l.b === this.hoverItem && related.add(l.a)));
    }
    if (this.hoverHub && !this.hoverHub.bare) {
      this.hoverHub.items.forEach((n) => related.add(n));
      this.credits.forEach((cr) => cr.hub === this.hoverHub && related.add(cr.item));
    }
    const faded = (n: INode) => (this.match && !this.match.has(n)) || (related.size > 0 && !related.has(n));
    const margin = 120;
    const onScreen = (x: number, y: number) => x > -margin && x < this.w + margin && y > -margin && y < this.h + margin;

    // Hub circles (who owns what) and fans
    for (const h of this.hubs) {
      if (h.bare || !h.items.length) continue;
      const hp = hubPos(h);
      const r = (h.r - 6) * cam.k * m;
      if (hp.x + r < 0 || hp.x - r > this.w || hp.y + r < 0 || hp.y - r > this.h) continue;
      const hot = focusHub === h;
      const dimHub = (this.match && !h.items.some((n) => this.match!.has(n))) || (related.size > 0 && !hot);
      ctx.globalAlpha = hot ? 0.12 : dimHub ? 0.015 : 0.05;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = hot ? 0.55 : dimHub ? 0.05 : 0.16;
      ctx.strokeStyle = accent;
      ctx.lineWidth = hot ? 1.4 : 0.8;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Credits across the web
    for (const cr of this.credits) {
      const hot = focusHub === cr.hub || related.has(cr.item);
      if (related.size && !hot) continue;
      if (this.match && !this.match.has(cr.item)) continue;
      const a = hubPos(cr.hub);
      ctx.strokeStyle = hot ? accent : 'rgba(26, 29, 51, 0.07)';
      ctx.lineWidth = hot ? 1.2 : 0.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(cr.item.sx, cr.item.sy);
      ctx.stroke();
    }
    // Samples and interpolations, arrowed into the song they borrow from
    for (const l of this.links) {
      const a = { x: l.a.sx, y: l.a.sy };
      const b = { x: l.b.sx, y: l.b.sy };
      const hot = related.has(l.a) && related.has(l.b);
      ctx.globalAlpha = faded(l.a) && faded(l.b) ? 0.12 : 1;
      ctx.strokeStyle = l.kind === 'other' ? 'rgba(26, 29, 51, 0.5)' : accent;
      ctx.lineWidth = hot ? 2.4 : l.kind === 'samples' ? 1.5 : 1.2;
      ctx.setLineDash(l.kind === 'interpolates' || l.uncertain ? [5, 4] : []);
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.18;
      const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.18;
      const ang = Math.atan2(b.y - my, b.x - mx);
      const inset = l.b.ss / 2 + 3;
      const ex = b.x - Math.cos(ang) * inset;
      const ey = b.y - Math.sin(ang) * inset;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      const ah = hot ? 9 : 7;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(ang - 0.45) * ah, ey - Math.sin(ang - 0.45) * ah);
      ctx.lineTo(ex - Math.cos(ang + 0.45) * ah, ey - Math.sin(ang + 0.45) * ah);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Covers, lens-enlarged ones on top
    const order = [...this.items].sort((a, b) => a.ss - b.ss);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const n of order) {
      if (!onScreen(n.sx, n.sy)) continue;
      const s = n.ss;
      // A filter fades non-matches strongly (you asked for them to step back); hovering only
      // softens the rest, so the whole library stays readable while one album is in focus.
      const fade = this.match && !this.match.has(n) ? 0.12 : related.size > 0 && !related.has(n) ? 0.5 : 1;
      ctx.globalAlpha = fade * (n.item.outside ? 0.85 : 1);
      if (n === this.hoverItem) {
        ctx.shadowColor = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetY = 4;
      }
      // Small covers draw from the thumbnail; only big ones use the full image.
      const thumb = s > 110 ? (this.bigThumb(n.item.cover) ?? this.thumbs.get(n.item.cover)) : this.thumbs.get(n.item.cover);
      if (s < 12) {
        // Tiny on screen: a square of the cover's own colour reads the same and draws far faster.
        ctx.fillStyle = this.tones.get(n.item.cover) ?? '#d6d6d6';
        ctx.fillRect(n.sx - s / 2, n.sy - s / 2, s, s);
      } else if (thumb) ctx.drawImage(thumb, n.sx - s / 2, n.sy - s / 2, s, s);
      else {
        ctx.fillStyle = '#e6e6e6';
        ctx.fillRect(n.sx - s / 2, n.sy - s / 2, s, s);
      }
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      if (n.item.outside && s > 14) {
        ctx.strokeStyle = 'rgba(26,29,51,0.5)';
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1;
        ctx.strokeRect(n.sx - s / 2 - 2, n.sy - s / 2 - 2, s + 4, s + 4);
        ctx.setLineDash([]);
      }
      if (s > 84 && !faded(n)) {
        ctx.font = '500 11px "Helvetica Neue", Helvetica, Arial, sans-serif';
        const t = n.item.title.length > 28 ? `${n.item.title.slice(0, 27)}…` : n.item.title;
        const tw = ctx.measureText(t).width;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(n.sx - tw / 2 - 3, n.sy + s / 2 + 3, tw + 6, 15);
        ctx.fillStyle = '#1a1d33';
        ctx.fillText(t, n.sx, n.sy + s / 2 + 5);
      }
    }
    // Hub names on the rim of their circle
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'middle';
    const biggest = new Set([...this.hubs].sort((a, b) => b.items.length - a.items.length).slice(0, 14));
    for (const h of this.hubs) {
      if (h.bare) continue;
      const hp = hubPos(h);
      if (!onScreen(hp.x, hp.y)) continue;
      const hot = focusHub === h;
      const screenR = h.r * cam.k;
      const matched = !this.match || h.items.some((n) => this.match!.has(n));
      if (!hot && (!matched || !(screenR > 46 || (biggest.has(h) && screenR > 22)))) continue;
      ctx.globalAlpha = related.size && !hot ? 0.4 : 1;
      ctx.font = `${hot ? 600 : 500} ${hot ? 13 : 12}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      const label = h.hub.name;
      const tw = ctx.measureText(label).width;
      const ly = h.items.length ? hp.y - (h.r - 6) * cam.k * m : hp.y - 14;
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fillRect(hp.x - tw / 2 - 6, ly - 10, tw + 12, 20);
      ctx.fillStyle = hot ? accent : '#1a1d33';
      ctx.fillText(label, hp.x, ly);
      if (!h.items.length) {
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- Input --------------------------------------------------------------------

  private hit(clientX: number, clientY: number): { item?: INode; hub?: HNode } {
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    let best: INode | undefined;
    for (const n of this.items) {
      if (this.match && !this.match.has(n)) continue;
      const half = n.ss / 2 + 2;
      if (Math.abs(x - n.sx) <= half && Math.abs(y - n.sy) <= half && (!best || n.ss > best.ss)) best = n;
    }
    if (best) return { item: best };
    for (const h of this.hubs) {
      if (h.bare) continue;
      const hp = { x: h.x * this.cam.k + this.cam.tx, y: h.y * this.cam.k + this.cam.ty };
      const ly = h.items.length ? hp.y - (h.r - 6) * this.cam.k : hp.y - 14;
      if (Math.abs(x - hp.x) < 60 && Math.abs(y - ly) < 11) return { hub: h };
      if (!h.items.length && Math.hypot(x - hp.x, y - hp.y) < 8) return { hub: h };
    }
    return {};
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        if (e.ctrlKey || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40)) {
          this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
        } else this.panBy(-e.deltaX, -e.deltaY);
      },
      { passive: false },
    );
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let moved = 0;
    let velocity = { x: 0, y: 0 };
    c.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      moved = 0;
      velocity = { x: 0, y: 0 };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top, in: e.pointerType !== 'touch' };
        const { item, hub } = this.hit(e.clientX, e.clientY);
        if (item !== (this.hoverItem ?? undefined) || hub !== (this.hoverHub ?? undefined)) {
          this.hoverItem = item ?? null;
          this.hoverHub = hub ?? null;
          c.style.cursor = item || hub ? 'pointer' : 'grab';
        }
        if (item) this.cb.onHover({ title: item.item.title, sub: item.item.sub, x: this.mouse.x, y: this.mouse.y });
        else if (hub) this.cb.onHover({ title: hub.hub.name, sub: `${hub.items.length} here`, x: this.mouse.x, y: this.mouse.y });
        else this.cb.onHover(null);
        this.kick();
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.zoomBy(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        pinch = d;
        moved += 10;
        return;
      }
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      velocity = { x: dx, y: dy };
      if (moved > 4) {
        c.style.cursor = 'grabbing';
        this.mouse.in = false;
        this.panBy(dx, dy);
      }
    });
    const end = (e: PointerEvent) => {
      const was = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (!was) return;
      if (moved <= 4) {
        const { item, hub } = this.hit(e.clientX, e.clientY);
        const r = c.getBoundingClientRect();
        if (item) this.cb.onSelect('item', item.item.id, new DOMRect(r.left + item.sx - item.ss / 2, r.top + item.sy - item.ss / 2, item.ss, item.ss));
        else if (hub) this.cb.onSelect('hub', hub.hub.id, r);
      } else if (!this.reducedMotion) {
        this.goal.tx += velocity.x * 10;
        this.goal.ty += velocity.y * 10;
        this.kick();
      }
      c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.mouse.in = false;
      this.hoverItem = this.hoverHub = null;
      this.cb.onHover(null);
      this.kick();
    });
  }
}
