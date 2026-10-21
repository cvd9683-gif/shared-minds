// Build the atlas for Every Image: a few hundred AI-generated pictures, each with its prompt and seed,
// its average colour, and a place on a map of meaning.
//
//   cd week-6-every-image/tools
//   npm install
//   node build-atlas.mjs                        # 400 pictures from DiffusionDB, part 1
//   node build-atlas.mjs --parts 1,2 --limit 800
//   node build-atlas.mjs --from ~/Pictures/ai   # your own folder of images instead
//   node build-atlas.mjs --reexport             # only rewrite the image files of the current atlas
//
// What it does:
//   1. Gets the pictures. DiffusionDB (poloclub/diffusiondb on Hugging Face) ships them in zip files of 1,000,
//      each with a JSON file of prompts and seeds. A part is several hundred MB; it's cached in tools/.cache.
//   2. Drops anything explicit or violent: first by prompt words, then by asking CLIP whether the picture
//      looks like it. Then look through atlas/images yourself, and list anything else in tools/exclude.txt.
//   3. CLIP (clip-vit-base-patch32) turns each picture into 512 numbers by what it shows.
//   4. UMAP flattens those numbers onto a 2D map, so pictures that mean similar things sit together.
//   5. Writes atlas/atlas.json, each picture at 512 × 512 to atlas/images/, and all of them at 96 × 96
//      in one sprite sheet, atlas/thumbs.jpg, for the mosaic and the map.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { UMAP } from 'umap-js';
import {
  AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage,
} from '@huggingface/transformers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'atlas');
const CACHE = path.join(HERE, '.cache');
const MODEL = 'Xenova/clip-vit-base-patch32';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const LIMIT = Number(opt('limit', 400));
const PARTS = opt('parts', '1').split(',').map(Number);
const FROM = opt('from', null);
const REEXPORT = args.includes('--reexport');

const BLOCKED_WORDS = /\b(nude|naked|nsfw|nympho\w*|fetish|bdsm|lust\w*|cleavage|busty|pin ?up|succubus|hentai|ecchi|schoolgirl|lolita|loli|teen|seductive|temptress|nipple|breast|boob|sexy|sex|erotic|porn|lingerie|bikini|topless|gore|gory|blood|bloody|corpse|dead body|decapitat|murder|torture|suicide|swastika|nazi)\b/i;
const exclude = new Set(fs.existsSync(path.join(HERE, 'exclude.txt'))
  ? fs.readFileSync(path.join(HERE, 'exclude.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : []);


/* ---------- 1. the pictures ---------- */

async function download(url, file) {
  if (fs.existsSync(file)) return file;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file + '.part');
  let got = 0, last = 0;
  for await (const chunk of res.body) {
    out.write(chunk); got += chunk.length;
    if (total && got - last > total / 20) { last = got; process.stdout.write(`  ${Math.round(got / total * 100)}%\r`); }
  }
  await new Promise(r => out.end(r));
  fs.renameSync(file + '.part', file);
  return file;
}

async function fromDiffusionDB() {
  fs.mkdirSync(CACHE, { recursive: true });
  const items = [];
  for (const part of PARTS) {
    const name = `part-${String(part).padStart(6, '0')}`;
    const zipFile = await download(
      `https://huggingface.co/datasets/poloclub/diffusiondb/resolve/main/images/${name}.zip`,
      path.join(CACHE, `${name}.zip`));
    const zip = new AdmZip(zipFile);
    const meta = JSON.parse(zip.readAsText(`${name}.json`));
    for (const [file, m] of Object.entries(meta)) {
      items.push({
        name: file, prompt: m.p, seed: m.se, cfg: m.c, steps: m.st, sampler: m.sa,
        source: `DiffusionDB ${name}`, read: () => zip.readFile(file),
      });
    }
  }
  return items;
}

function fromFolder(dir) {
  return fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).map(f => ({
    name: f, prompt: path.parse(f).name.replace(/[-_]+/g, ' '), seed: null,
    source: 'your folder', read: () => fs.readFileSync(path.join(dir, f)),
  }));
}


/* ---------- 2–3. CLIP: what each picture shows, and whether it's safe to show ---------- */

const SAFE = ['a painting', 'a photograph', 'an illustration', 'a landscape', 'a portrait', 'a building', 'an animal', 'food', 'a fantasy scene', 'a character'];
const UNSAFE = ['nudity', 'a sexually explicit image', 'gore and blood', 'a dead body', 'graphic violence'];

async function loadClip() {
  console.log('Loading CLIP (downloads about 350 MB the first time)…');
  const [processor, vision, tokenizer, text] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL),
    CLIPVisionModelWithProjection.from_pretrained(MODEL),
    AutoTokenizer.from_pretrained(MODEL),
    CLIPTextModelWithProjection.from_pretrained(MODEL),
  ]);
  const labels = [...SAFE, ...UNSAFE];
  const { text_embeds } = await text(tokenizer(labels, { padding: true, truncation: true }));
  const labelVecs = normalizeRows(text_embeds.tolist());
  return {
    async embed(buf) {
      const png = await sharp(buf).resize(224, 224, { fit: 'cover' }).png().toBuffer();
      const image = await RawImage.fromBlob(new Blob([png]));
      const { image_embeds } = await vision(await processor(image));
      return normalizeRows(image_embeds.tolist())[0];
    },
    unsafe(vec) {
      // CLIP's zero-shot guess: how much of the picture's resemblance goes to the unsafe labels
      const logits = labelVecs.map(l => 100 * dot(vec, l));
      const max = Math.max(...logits), exps = logits.map(x => Math.exp(x - max)), sum = exps.reduce((a, b) => a + b, 0);
      return exps.slice(SAFE.length).reduce((a, b) => a + b, 0) / sum;
    },
  };
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function normalizeRows(rows) { return rows.map(r => { const n = Math.hypot(...r) || 1; return r.map(x => x / n); }); }


/* ---------- writing pictures: 512 × 512 to look at, 96 × 96 in one sprite sheet for the mosaic and the map ---------- */

const THUMB = 96, COLS = 20;
const thumbs = [];
async function writePicture(buf, id) {
  await sharp(buf).resize(512, 512, { fit: 'cover' }).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT, 'images', `${id}.jpg`));
  thumbs.push(await sharp(buf).resize(THUMB, THUMB, { fit: 'cover' }).removeAlpha().png().toBuffer());
}
async function writeSprite() {
  const rows = Math.ceil(thumbs.length / COLS);
  await sharp({ create: { width: COLS * THUMB, height: rows * THUMB, channels: 3, background: '#000' } })
    .composite(thumbs.map((input, i) => ({ input, left: (i % COLS) * THUMB, top: Math.floor(i / COLS) * THUMB })))
    .jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(OUT, 'thumbs.jpg'));
  return { file: 'thumbs.jpg', size: THUMB, cols: COLS };
}
function freshFolders() {
  fs.rmSync(path.join(OUT, 'images'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'thumbs'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'images'), { recursive: true });
}


/* ---------- run ---------- */

if (REEXPORT) {
  // same pictures, same map, new image files: find each picture again by its original name
  const atlas = JSON.parse(fs.readFileSync(path.join(OUT, 'atlas.json'), 'utf8'));
  const byName = new Map((FROM ? fromFolder(FROM) : await fromDiffusionDB()).map(c => [c.name, c]));
  freshFolders();
  for (const it of atlas.items) {
    const c = byName.get(it.name);
    if (!c) throw new Error(`Can't find ${it.name} in the source any more.`);
    await writePicture(c.read(), it.id);
    it.file = `images/${it.id}.jpg`; delete it.thumb;
  }
  atlas.sprite = await writeSprite();
  fs.writeFileSync(path.join(OUT, 'atlas.json'), JSON.stringify(atlas));
  console.log(`Rewrote ${atlas.items.length} pictures.`);
  process.exit(0);
}

const candidates = (FROM ? fromFolder(FROM) : await fromDiffusionDB())
  .filter(c => !exclude.has(c.name) && !BLOCKED_WORDS.test(c.prompt || ''));
console.log(`${candidates.length} candidates after the prompt filter.`);

const clip = await loadClip();
freshFolders();

const kept = [];
let dropped = 0;
for (const c of candidates) {
  if (kept.length >= LIMIT) break;
  let buf;
  try { buf = c.read(); } catch { continue; }
  const vec = await clip.embed(buf);
  if (clip.unsafe(vec) > 0.25) { dropped++; continue; }
  const id = String(kept.length).padStart(4, '0');
  await writePicture(buf, id);
  const avg = [...await sharp(buf).resize(1, 1, { fit: 'cover' }).removeAlpha().raw().toBuffer()];
  kept.push({ id, file: `images/${id}.jpg`, name: c.name, prompt: c.prompt, seed: c.seed, cfg: c.cfg, steps: c.steps, sampler: c.sampler, source: c.source, avg, vec });
  if (kept.length % 25 === 0) console.log(`  ${kept.length} / ${LIMIT}`);
}
console.log(`Kept ${kept.length}; CLIP flagged and dropped ${dropped}.`);

// 4. UMAP: from 512 numbers down to 2, keeping neighbours near. Seeded so the map is the same every run.
let s = 42;
const random = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
const xy = new UMAP({ nComponents: 2, nNeighbors: Math.min(15, kept.length - 1), minDist: 0.12, random }).fit(kept.map(k => k.vec));
const [minX, maxX, minY, maxY] = [Math.min(...xy.map(p => p[0])), Math.max(...xy.map(p => p[0])), Math.min(...xy.map(p => p[1])), Math.max(...xy.map(p => p[1]))];

// nearest neighbours by meaning, so the page can offer "close to this" without shipping all the numbers
const items = kept.map((k, i) => {
  const nn = kept.map((o, j) => [j, dot(k.vec, o.vec)]).filter(([j]) => j !== i).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([j]) => kept[j].id);
  const { vec, ...rest } = k;
  return { ...rest, map: [(xy[i][0] - minX) / (maxX - minX || 1), (xy[i][1] - minY) / (maxY - minY || 1)], nn };
});

const sprite = await writeSprite();
fs.writeFileSync(path.join(OUT, 'atlas.json'), JSON.stringify({
  built: new Date().toISOString(),
  sprite,
  model: MODEL,
  source: FROM ? 'your folder' : `DiffusionDB 2M, parts ${PARTS.join(', ')}`,
  items,
}));
console.log(`Wrote ${path.relative(process.cwd(), path.join(OUT, 'atlas.json'))} with ${items.length} pictures.`);
console.log('Now look through atlas/images. Add the original name of anything you don\'t want to tools/exclude.txt and run again.');
