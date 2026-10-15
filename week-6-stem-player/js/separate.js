// True stems: send a song to /api/stems, which splits it with Demucs on Replicate.
// The song goes straight from the browser to Vercel Blob storage (songs are too big to pass
// through the function), then the function hands its address to Replicate and we wait.
// Songs are known by a fingerprint of their bytes, so one already split comes straight back.

const API = '/api/stems';
const POLL = 3000;
const GIVE_UP = 15 * 60 * 1000;

// Is the helper there, and set up? → { found, ready, missing: [setting names] }
// Not found when the page is served without it (locally, or on a plain static host).
export async function available() {
  try {
    const r = await fetch(API);
    if (r.status === 404) return { found: false, ready: false, missing: [] };
    const body = await r.json().catch(() => ({ error: `it answered ${r.status}` }));
    return { found: true, ready: body.ready === true, missing: body.missing || [], environment: body.environment, error: body.error };
  } catch {
    return { found: false, ready: false, missing: [] };
  }
}

// onStep(phase, fraction?): 'checking' | 'uploading' (0..1) | 'separating' | 'saving'
// Resolves to { vocals, drums, bass, other } — the address of each stem.
export async function separate(file, onStep) {
  onStep('checking');
  const song = await fingerprint(file);
  let r = await call(`${API}?song=${song}`);
  if (r.stems) return r.stems;

  onStep('uploading', 0);
  const { upload } = await import('./vendor/blob-client.js');
  const ext = (file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp3';
  const blob = await upload(`uploads/${song}.${ext}`, file, {
    access: 'public',
    handleUploadUrl: API,
    contentType: file.type.startsWith('audio/') ? file.type : 'audio/mpeg',
    onUploadProgress: e => onStep('uploading', e.percentage / 100),
  });

  r = await call(API, { method: 'POST', body: JSON.stringify({ song, upload: blob.url }) });
  if (r.stems) return r.stems;

  onStep('separating');
  const started = Date.now();
  const url = `${API}?id=${encodeURIComponent(r.id)}&song=${song}&upload=${encodeURIComponent(blob.url)}`;
  while (Date.now() - started < GIVE_UP) {
    await new Promise(resolve => setTimeout(resolve, POLL));
    r = await call(url);
    if (r.status === 'succeeded') return r.stems;
    if (r.status === 'failed') throw new Error(r.error);
    if (r.status === 'processing') onStep('separating');
  }
  throw new Error('Separation is taking too long. Try again in a minute.');
}

async function call(url, init) {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `The stem helper answered ${r.status}`);
  return body;
}

async function fingerprint(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
