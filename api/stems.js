// Stem Player - true stems helper (Vercel serverless function, served at /api/stems)
// Splits an uploaded song into vocals, drums, bass and other with Demucs on Replicate.
// Keeps the Replicate token on the server. Songs are too big to send through a function
// (Vercel caps a request at 4.5 MB), so the browser uploads straight to Vercel Blob and
// only the song's address passes through here.
//
//   GET  /api/stems                      → { ready, missing }  is everything configured?
//   GET  /api/stems?song=<hash>          → { stems|null }  stems already made for this song
//   POST /api/stems  (from upload())     →                 lets the browser upload to Blob
//   POST /api/stems  { song, upload }    → { id }          start separating
//   GET  /api/stems?id=…&song=…&upload=… → { status, stems?, error? }  poll until done
//
// Finished stems are copied into Blob under stems/<hash>/, so they outlive Replicate's
// one-hour links and the same song never has to be paid for twice.
//
// Vercel environment variables:
//   REPLICATE_API_TOKEN     (required) from replicate.com/account/api-tokens
//   BLOB_READ_WRITE_TOKEN   (required) added for you when you connect a Blob store
//   REPLICATE_MODEL         (optional) defaults to ryan5453/demucs
//   DEMUCS_MODEL            (optional) defaults to htdemucs_ft; htdemucs is ~4× faster, a little rougher
//   ALLOWED_ORIGIN          (optional) limits which other sites may call it

import { put, list, del } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';

export const config = { maxDuration: 60 };

const MODEL = process.env.REPLICATE_MODEL || 'ryan5453/demucs';
// The fine-tuned Demucs: the cleanest separation it offers, at about four times the time and cost.
const DEMUCS = process.env.DEMUCS_MODEL || 'htdemucs_ft';
const STEMS = ['vocals', 'drums', 'bass', 'other'];
const HASH = /^[0-9a-f]{64}$/;
const MAX_BYTES = 60 * 1024 * 1024;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const missing = [];
  if (!replicateToken()) missing.push('REPLICATE_API_TOKEN');
  if (!process.env.BLOB_READ_WRITE_TOKEN) missing.push('BLOB_READ_WRITE_TOKEN');
  const ready = missing.length === 0;
  try {
    if (req.method === 'GET') {
      const { song, id, upload } = req.query;
      if (!song && !id) return res.status(200).json({ ready, missing, environment: process.env.VERCEL_ENV || null });
      if (!ready) return res.status(500).json({ error: 'Stem separation is not set up' });
      if (!HASH.test(String(song))) return res.status(400).json({ error: 'Bad song id' });
      if (!id) return res.status(200).json({ stems: await savedStems(song) });
      return res.status(200).json(await poll(String(id), song, upload && String(upload)));
    }

    if (req.method === 'POST') {
      if (!ready) return res.status(500).json({ error: 'Stem separation is not set up' });
      const body = req.body || {};
      if (String(body.type || '').startsWith('blob.')) return res.status(200).json(await allowUpload(req, body));
      const { song, upload } = body;
      if (!HASH.test(String(song)) || !isOurBlob(upload)) return res.status(400).json({ error: 'Bad request' });
      const saved = await savedStems(song);
      if (saved) return res.status(200).json({ stems: saved });
      return res.status(200).json({ id: await separate(upload) });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: err.message || 'Something went wrong' });
  }
}

// The browser may upload one audio file, under uploads/<hash>.<ext>, up to MAX_BYTES.
function allowUpload(req, body) {
  return handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async pathname => {
      if (!/^uploads\/[0-9a-f]{64}\.[a-z0-9]{1,5}$/.test(pathname)) throw new Error('Bad upload name');
      return {
        allowedContentTypes: ['audio/*'],
        maximumSizeInBytes: MAX_BYTES,
        allowOverwrite: true,
      };
    },
  });
}

async function savedStems(song) {
  const { blobs } = await list({ prefix: `stems/${song}/` });
  const stems = {};
  for (const b of blobs) {
    const name = b.pathname.split('/').pop().replace(/\.[^.]+$/, '');
    if (STEMS.includes(name)) stems[name] = b.url;
  }
  return STEMS.every(n => stems[n]) ? stems : null;
}

async function separate(audio) {
  const prediction = await replicate('/predictions', {
    method: 'POST',
    body: JSON.stringify({ version: await latestVersion(), input: { audio, model: DEMUCS, output_format: 'mp3', mp3_bitrate: 320 } }),
  });
  return prediction.id;
}

async function poll(id, song, upload) {
  if (!/^[a-z0-9]+$/i.test(id)) throw new Error('Bad prediction id');
  const p = await replicate(`/predictions/${id}`);
  if (p.status === 'succeeded') {
    const found = findStems(p.output);
    if (!found) return finish(upload, { status: 'failed', error: 'The model returned no stems' });
    const stems = {};
    await Promise.all(STEMS.map(async name => {
      const audio = await fetch(found[name]);
      if (!audio.ok) throw new Error(`Couldn’t fetch the ${name} stem`);
      const blob = await put(`stems/${song}/${name}.mp3`, audio.body, {
        access: 'public', contentType: 'audio/mpeg', allowOverwrite: true,
      });
      stems[name] = blob.url;
    }));
    return finish(upload, { status: 'succeeded', stems });
  }
  if (p.status === 'failed' || p.status === 'canceled') {
    return finish(upload, { status: 'failed', error: p.error || 'Separation failed' });
  }
  return { status: p.status };   // starting | processing
}

// The uploaded song is only needed until its stems exist.
async function finish(upload, result) {
  if (isOurBlob(upload)) await del(upload).catch(() => {});
  return result;
}

// Demucs on Replicate has answered in a few shapes over its versions:
// { stems: [{ name, audio }] }, { vocals: url, … }, or a list of file urls.
function findStems(output) {
  const out = {};
  if (Array.isArray(output?.stems)) for (const s of output.stems) out[s.name] = s.audio;
  else if (Array.isArray(output)) for (const url of output) {
    const name = STEMS.find(n => String(url).split('/').pop().includes(n));
    if (name) out[name] = url;
  } else if (output && typeof output === 'object') Object.assign(out, output);
  return STEMS.every(n => typeof out[n] === 'string') ? out : null;
}

let version = null;
async function latestVersion() {
  if (!version) version = (await replicate(`/models/${MODEL}`)).latest_version.id;
  return version;
}

async function replicate(path, init = {}) {
  const r = await fetch(`https://api.replicate.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${replicateToken()}`, 'Content-Type': 'application/json' },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Replicate: ${body.detail || body.title || r.status}`);
  return body;
}

// The Replicate key, forgiving of how it was saved: under a near-miss name, or with stray
// spaces or quotes around it. Replicate keys start with r8_, so one saved under any name is found.
function replicateToken() {
  const named = ['REPLICATE_API_TOKEN', 'REPLICATE_API_KEY', 'REPLICATE_TOKEN', 'REPLICATE_KEY']
    .map(name => process.env[name]).find(Boolean);
  const value = named || Object.values(process.env).find(v => typeof v === 'string' && /^\s*["']?r8_/.test(v)) || '';
  return value.trim().replace(/^["']|["']$/g, '');
}

function isOurBlob(url) {
  try { return new URL(url).hostname.endsWith('.blob.vercel-storage.com'); } catch { return false; }
}
