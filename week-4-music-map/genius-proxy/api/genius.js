// Music Map - Genius proxy (Vercel serverless function)
// Keeps the Genius token on the server and lets the browser read Genius, which it
// can't do directly (no CORS). Only the two read-only lookups the app uses are passed on.
//   GET /api/genius?path=/search?q=...   GET /api/genius?path=/songs/123?text_format=plain
// Environment variables: GENIUS_TOKEN (required), ALLOWED_ORIGIN (optional, e.g.
// https://cvd9683-gif.github.io; defaults to any origin).

const ALLOWED = /^\/(search\?q=[^&]*|songs\/\d+(\?text_format=plain)?)$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const path = String(req.query.path || '');
  if (!ALLOWED.test(path)) return res.status(400).json({ error: 'Unsupported Genius path' });
  if (!process.env.GENIUS_TOKEN) return res.status(500).json({ error: 'GENIUS_TOKEN is not set' });

  const sep = path.includes('?') ? '&' : '?';
  const upstream = await fetch(`https://api.genius.com${path}${sep}access_token=${encodeURIComponent(process.env.GENIUS_TOKEN)}`);
  const body = await upstream.text();
  res.setHeader('Content-Type', 'application/json');
  // Song pages change rarely; let the CDN keep answers for a day.
  if (upstream.ok) res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  return res.status(upstream.status).send(body);
}
