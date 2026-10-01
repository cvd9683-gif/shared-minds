// Music Map - Procedural covers for the fictional demo data
// Each demo track gets a deterministic SVG "sleeve" from its id, so the demo needs
// no external images and never borrows real artwork.

import type { Cover } from './types';

const PALETTES: string[][] = [
  ['#1d2b53', '#e4572e', '#f3efe6', '#f2a541'],
  ['#0f3d3e', '#e2dcc8', '#100f0f', '#c9a227'],
  ['#2b2d42', '#8d99ae', '#edf2f4', '#ef233c'],
  ['#3a0ca3', '#f72585', '#fefae0', '#4cc9f0'],
  ['#283618', '#dda15e', '#fefae0', '#bc6c25'],
  ['#161616', '#f4f1de', '#e07a5f', '#3d405b'],
  ['#264653', '#e9c46a', '#f4a261', '#e76f51'],
  ['#5f0f40', '#fb8b24', '#e36414', '#fdf0d5'],
  ['#d8e2dc', '#1b263b', '#9d8189', '#ffcad4'],
  ['#0b132b', '#5bc0be', '#fffffc', '#3a506b'],
];

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
export function seeded(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function generateSvg(seed: string, title: string): string {
  const rand = seeded(seed);
  const pal = PALETTES[Math.floor(rand() * PALETTES.length)];
  const [bg, a, b, c] = rand() > 0.5 ? pal : [pal[2], pal[0], pal[3], pal[1]];
  const style = Math.floor(rand() * 7);
  let body = '';

  switch (style) {
    case 0: {
      // concentric rings
      const cx = 60 + rand() * 80;
      const cy = 60 + rand() * 80;
      for (let r = 140; r > 8; r -= 10 + rand() * 14) {
        body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${rand() > 0.3 ? a : c}" stroke-width="${2 + rand() * 5}"/>`;
      }
      break;
    }
    case 1: {
      // horizontal bands
      let y = 0;
      while (y < 200) {
        const h = 6 + rand() * 34;
        body += `<rect x="0" y="${y}" width="200" height="${h}" fill="${[a, b, c, bg][Math.floor(rand() * 4)]}"/>`;
        y += h;
      }
      break;
    }
    case 2: {
      // grid of dots
      const n = 5 + Math.floor(rand() * 5);
      const step = 200 / n;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          body += `<circle cx="${step * (i + 0.5)}" cy="${step * (j + 0.5)}" r="${step * (0.15 + rand() * 0.3)}" fill="${rand() > 0.85 ? c : a}"/>`;
      break;
    }
    case 3: {
      // sun over horizon
      const hz = 110 + rand() * 50;
      body += `<circle cx="${60 + rand() * 80}" cy="${hz - 10}" r="${30 + rand() * 30}" fill="${c}"/>`;
      body += `<rect x="0" y="${hz}" width="200" height="${200 - hz}" fill="${a}"/>`;
      for (let y = hz + 8; y < 200; y += 10) body += `<rect x="0" y="${y}" width="200" height="2" fill="${bg}" opacity=".5"/>`;
      break;
    }
    case 4: {
      // stacked blocks
      for (let i = 0; i < 7; i++) {
        const w = 30 + rand() * 110;
        const h = 20 + rand() * 80;
        body += `<rect x="${rand() * (200 - w)}" y="${rand() * (200 - h)}" width="${w}" height="${h}" fill="${[a, b, c][i % 3]}" opacity="${0.75 + rand() * 0.25}"/>`;
      }
      break;
    }
    case 5: {
      // waves
      for (let k = 0; k < 9; k++) {
        const y0 = 20 + k * 20;
        const amp = 6 + rand() * 14;
        body += `<path d="M0 ${y0} C 50 ${y0 - amp}, 100 ${y0 + amp}, 200 ${y0}" stroke="${k % 3 === 0 ? c : a}" stroke-width="${3 + rand() * 4}" fill="none"/>`;
      }
      break;
    }
    default: {
      // single diagonal cut
      body += `<polygon points="0,200 200,${rand() * 120} 200,200" fill="${a}"/>`;
      body += `<circle cx="${40 + rand() * 60}" cy="${40 + rand() * 50}" r="${10 + rand() * 18}" fill="${c}"/>`;
    }
  }

  // Small typographic label, as on a record sleeve
  const label = escapeXml(title.toUpperCase().slice(0, 22));
  const ty = rand() > 0.5 ? 20 : 190;
  const text = `<text x="10" y="${ty}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="9" font-weight="600" letter-spacing="1.2" fill="${b}">${label}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${bg}"/>${body}${text}</svg>`;
}

const cache = new Map<string, string>();

/** Returns an image URL for a cover (data URI for generated covers). */
export function coverUrl(cover: Cover | undefined, title = ''): string {
  if (!cover) return '';
  if (cover.kind === 'image') return cover.url;
  const key = cover.seed + title;
  let url = cache.get(key);
  if (!url) {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(generateSvg(cover.seed, title))}`;
    cache.set(key, url);
  }
  return url;
}
