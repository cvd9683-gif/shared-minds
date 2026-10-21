// Build the atlas for Every Image: a few hundred AI-generated pictures, each with its prompt and seed,
// its average colour, and a place on a map of meaning.
//
//   cd week-6-every-image/tools
//   npm install
//   node build-atlas.mjs                        # 400 pictures from DiffusionDB, part 1
//   node build-atlas.mjs --parts 1,2 --limit 800
//   node build-atlas.mjs --from ~/Pictures/ai   # your own folder of images instead
//   node build-atlas.mjs --reexport             # only rewrite the image files of the current atlas
//   node build-atlas.mjs --remap                # only redo the map (regions, layout, neighbours) of the current atlas
//
// What it does:
//   1. Gets the pictures. DiffusionDB (poloclub/diffusiondb on Hugging Face) ships them in zip files of 1,000,
//      each with a JSON file of prompts and seeds. A part is several hundred MB; it's cached in tools/.cache.
//   2. Drops anything explicit or violent: first by prompt words, then by asking CLIP whether the picture
//      looks like it. Then look through atlas/images yourself, and list anything else in tools/exclude.txt.
//   3. CLIP (clip-vit-base-patch32) turns each picture into 512 numbers by what it shows.
//   4. Groups the pictures into regions by meaning (k-means on CLIP's numbers). Each region is named from
//      tools/region-names.json if it has names for this many regions, else by CLIP's best guess from a word
//      list. UMAP then flattens the numbers onto a 2D map, pulling each region together. Each picture also
//      gets its six closest in meaning and its three closest in colour.
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
const REMAP = args.includes('--remap');
const REGIONS = Number(opt('regions', 8));

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
  const words = async list => normalizeRows((await text(tokenizer(list, { padding: true, truncation: true }))).text_embeds.tolist());
  const labelVecs = await words(labels);
  return {
    words,
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


/* ---------- 4. the map: regions by meaning, a layout that keeps them apart, and two kinds of neighbour ---------- */

const REGION_WORDS = [
  'portraits of people', 'painted fantasy characters', 'dragons and creatures', 'cartoon monsters',
  'animals', 'abandoned buildings and ruins', 'cities and skylines', 'architecture', 'landscapes and nature',
  'gardens and temples', 'robots and machines', 'warriors in armour', 'rooms and interiors',
  'space and science fiction', 'ornate symmetrical designs', 'abstract art', 'gods and mythical figures',
  'anime characters', 'collage and pop art', 'dark gothic scenes',
]; 

function seeded(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

// k-means on CLIP's numbers (they're unit length, so closeness is the dot product)
function kmeans(vecs, k, random) {
  const centers = [vecs[Math.floor(random() * vecs.length)]];
  while (centers.length < k) {
    // k-means++: each new centre is likely to be far from the ones already chosen
    const far = vecs.map(v => 1 - Math.max(...centers.map(c => dot(v, c))));
    let r = random() * far.reduce((a, b) => a + b, 0), i = 0;
    while ((r -= far[i]) > 0 && i < vecs.length - 1) i++;
    centers.push(vecs[i]);
  }
  let assign = [];
  for (let iter = 0; iter < 40; iter++) {
    assign = vecs.map(v => centers.reduce((best, c, j) => dot(v, c) > dot(v, centers[best]) ? j : best, 0));
    for (let j = 0; j < k; j++) {
      const members = vecs.filter((_, i) => assign[i] === j);
      if (!members.length) continue;
      const mean = members[0].map((_, d) => members.reduce((a, m) => a + m[d], 0) / members.length);
      centers[j] = normalizeRows([mean])[0];
    }
  }
  return { assign, centers };
}

// where regions sit: their centres' two main directions of difference (PCA), so similar regions sit near
function regionCentres(centers) {
  const n = centers.length, d = centers[0].length;
  const mean = Array.from({ length: d }, (_, k) => centers.reduce((a, c) => a + c[k], 0) / n);
  const X = centers.map(c => c.map((v, k) => v - mean[k]));
  const axes = [];
  for (let a = 0; a < 2; a++) {
    let v = Array.from({ length: d }, (_, k) => Math.sin(k * (a + 1) * 1.3));
    for (let it = 0; it < 60; it++) {
      const next = new Array(d).fill(0);
      for (const x of X) { const p = dot(x, v); for (let k = 0; k < d; k++) next[k] += p * x[k]; }
      for (const prev of axes) { const p = dot(next, prev); for (let k = 0; k < d; k++) next[k] -= p * prev[k]; }
      v = normalizeRows([next])[0];
    }
    axes.push(v);
  }
  const pts = X.map(x => axes.map(ax => dot(x, ax)));
  const s = Math.max(...pts.flat().map(Math.abs)) || 1;
  return pts.map(p => [p[0] / s * .5, p[1] / s * .5]);
}

// push region circles apart until none overlap
function spreadApart(centre, radius) {
  for (let it = 0; it < 400; it++) {
    for (let a = 0; a < centre.length; a++) for (let b = a + 1; b < centre.length; b++) {
      const dx = centre[b][0] - centre[a][0], dy = centre[b][1] - centre[a][1], d = Math.hypot(dx, dy) || 1e-6;
      const need = radius[a] + radius[b] + .06;
      if (d < need) { const push = (need - d) / 2, ux = dx / d, uy = dy / d; centre[a][0] -= ux * push; centre[a][1] -= uy * push; centre[b][0] += ux * push; centre[b][1] += uy * push; }
    }
  }
}

async function mapAtlas(kept, clip) {
  const vecs = kept.map(k => k.vec), random = seeded(42);
  const { assign, centers } = kmeans(vecs, Math.min(REGIONS, kept.length), random);

  // name each region by vote: CLIP picks the best word for every picture, and each region takes the word
  // most of its pictures chose (no word used twice)
  const wordVecs = await clip.words(REGION_WORDS.map(w => `a picture of ${w}`));
  const votes = centers.map(() => REGION_WORDS.map(() => 0));
  vecs.forEach((v, i) => {
    const best = wordVecs.reduce((b, w, n) => dot(v, w) > dot(v, wordVecs[b]) ? n : b, 0);
    votes[assign[i]][best]++;
  });
  votes.forEach((row, j) => console.log(`  region ${j}: ` + row.map((c, n) => [c, REGION_WORDS[n]]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([c, w]) => `${w} ${c}`).join(', ')));
  // a word's claim on a region: how much more often the region's pictures chose it than pictures overall did
  const total = REGION_WORDS.map((_, n) => votes.reduce((a, row) => a + row[n], 0));
  const pairs = [];
  votes.forEach((row, j) => {
    const size = row.reduce((a, b) => a + b, 0);
    row.forEach((count, n) => { if (count >= 2) pairs.push([(count / size) * (count / total[n]), j, n]); });
  });
  pairs.sort((a, b) => b[0] - a[0]);
  const names = [], usedWord = new Set();
  for (const [, j, n] of pairs) if (names[j] == null && !usedWord.has(n)) { names[j] = REGION_WORDS[n]; usedWord.add(n); }
  for (let j = 0; j < centers.length; j++) if (names[j] == null) names[j] = REGION_WORDS[votes[j].indexOf(Math.max(...votes[j]))];

  // the layout, in two steps: where each region sits relative to the others (closer if they mean
  // more similar things), then UMAP inside each region to spread its pictures into an island
  const centre = regionCentres(centers);
  const sizes = centers.map((_, j) => assign.filter(a => a === j).length);
  const radius = sizes.map(n => .07 + .1 * Math.sqrt(n / 100));
  spreadApart(centre, radius);
  const xy = vecs.map(() => [0, 0]);
  centers.forEach((_, j) => {
    const members = assign.map((a, i) => a === j ? i : -1).filter(i => i >= 0);
    let local;
    if (members.length >= 6) local = new UMAP({ nComponents: 2, nNeighbors: Math.min(10, members.length - 1), minDist: .3, random: seeded(11 + j) }).fit(members.map(i => vecs[i]));
    else local = members.map((_, n) => [Math.cos(n * 2.4), Math.sin(n * 2.4)]);
    // fit the island into its circle
    const cx = local.reduce((a, p) => a + p[0], 0) / local.length, cy = local.reduce((a, p) => a + p[1], 0) / local.length;
    const far = Math.max(...local.map(p => Math.hypot(p[0] - cx, p[1] - cy))) || 1;
    members.forEach((i, n) => { xy[i] = [centre[j][0] + (local[n][0] - cx) / far * radius[j], centre[j][1] + (local[n][1] - cy) / far * radius[j]]; });
  });
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(maxX - minX, maxY - minY) || 1;

  const colourDist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const items = kept.map((k, i) => {
    // closest in meaning, by CLIP
    const nn = kept.map((o, j) => [j, dot(k.vec, o.vec)]).filter(([j]) => j !== i).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([j]) => kept[j].id);
    // closest in colour: the pictures that could hide in the same dot of static
    const cn = kept.map((o, j) => [j, colourDist(k.avg, o.avg)]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([j]) => kept[j].id);
    const { vec, ...rest } = k;
    return { ...rest, region: assign[i], map: [(xy[i][0] - minX) / span + (1 - (maxX - minX) / span) / 2, (xy[i][1] - minY) / span + (1 - (maxY - minY) / span) / 2], nn, cn };
  });
  // names written by hand after looking (tools/region-names.json) win over CLIP's guesses
  const handFile = path.join(HERE, 'region-names.json');
  if (fs.existsSync(handFile)) {
    const hand = JSON.parse(fs.readFileSync(handFile, 'utf8'));
    if (hand.regions === centers.length) hand.names.forEach((n, j) => { names[j] = n; });
  }
  const regions = names.map((name, j) => ({ name, size: assign.filter(a => a === j).length }));
  return { items, regions };
}


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

if (REMAP) {
  // same pictures, new map: read each picture again, ask CLIP for its numbers, redo regions and layout
  const atlas = JSON.parse(fs.readFileSync(path.join(OUT, 'atlas.json'), 'utf8'));
  const byName = new Map((FROM ? fromFolder(FROM) : await fromDiffusionDB()).map(c => [c.name, c]));
  const clip = await loadClip();
  const cacheFile = path.join(CACHE, 'clip-numbers.json');
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const kept = [];
  for (const it of atlas.items) {
    const c = byName.get(it.name);
    if (!c) throw new Error(`Can't find ${it.name} in the source any more.`);
    const { map, nn, cn, region, ...rest } = it;
    cache[it.name] ??= await clip.embed(c.read());
    kept.push({ ...rest, vec: cache[it.name] });
    if (kept.length % 50 === 0) console.log(`  ${kept.length} / ${atlas.items.length}`);
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const { items, regions } = await mapAtlas(kept, clip);
  fs.writeFileSync(path.join(OUT, 'atlas.json'), JSON.stringify({ ...atlas, built: new Date().toISOString(), regions, items }));
  console.log(`Remapped ${items.length} pictures into ${regions.length} regions: ${regions.map(r => `${r.name} (${r.size})`).join(', ')}.`);
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

const { items, regions } = await mapAtlas(kept, clip);

const sprite = await writeSprite();
fs.writeFileSync(path.join(OUT, 'atlas.json'), JSON.stringify({
  built: new Date().toISOString(),
  sprite,
  model: MODEL,
  source: FROM ? 'your folder' : `DiffusionDB 2M, parts ${PARTS.join(', ')}`,
  regions,
  items,
}));
console.log(`Wrote ${path.relative(process.cwd(), path.join(OUT, 'atlas.json'))} with ${items.length} pictures.`);
console.log('Now look through atlas/images. Add the original name of anything you don\'t want to tools/exclude.txt and run again.');
