// Music Map - Sourced relationships from Genius (optional; needs a client access token)
// Genius documents what a song samples, what samples it, interpolations, covers,
// remixes and live versions, plus producer, writer and other credits. Nothing is
// inferred: each relationship links back to the Genius page it came from.
// Requests go, in order of preference, through: a token saved in this browser
// (direct, or via the dev server's /genius-api when CORS blocks it); the dev server,
// when GENIUS_TOKEN is set in .env.local; or the site's Genius helper from config.json
// (/api/genius on Vercel), so every visitor gets Genius without a token.

import { siteConfig } from './config';
import type { Dataset, PartialDate, Person, Relationship, Track } from './types';

const TOKEN_KEY = 'musicMap:geniusToken';

export function geniusToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) || import.meta.env.VITE_GENIUS_TOKEN || null;
}

/** Where Genius comes from right now, or null when it isn't available. */
export function geniusSource(): 'token' | 'site' | 'dev' | null {
  if (geniusToken()) return 'token';
  if (import.meta.env.DEV && __GENIUS_DEV__) return 'dev';
  // A same-site address like /api/genius only exists on the hosted site, not the dev server.
  const proxy = siteConfig().geniusProxy;
  if (proxy && !(import.meta.env.DEV && proxy.startsWith('/'))) return 'site';
  return null;
}

export function saveGeniusToken(token: string): void {
  if (token.trim()) localStorage.setItem(TOKEN_KEY, token.trim());
  else localStorage.removeItem(TOKEN_KEY);
}

async function genius<T>(path: string): Promise<T> {
  const source = geniusSource();
  const token = geniusToken();
  let res: Response;
  if (source === 'token' && token) {
    const sep = path.includes('?') ? '&' : '?';
    // A token in the query (not a header) keeps this a simple request with no CORS preflight.
    const url = `${path}${sep}access_token=${encodeURIComponent(token)}`;
    try {
      res = await fetch(`https://api.genius.com${url}`);
    } catch {
      if (!import.meta.env.DEV && siteConfig().geniusProxy) res = await fetch(`${siteConfig().geniusProxy}?path=${encodeURIComponent(path)}`);
      else res = await fetch(`/genius-api${url}`);
    }
  } else if (source === 'site') {
    res = await fetch(`${siteConfig().geniusProxy}?path=${encodeURIComponent(path)}`);
  } else if (source === 'dev') {
    res = await fetch(`/genius-api${path}`);
  } else {
    throw new Error('Genius isn’t set up.');
  }
  if (!res.ok) throw new Error(`Genius request failed (${res.status}).`);
  return (await res.json()).response as T;
}

interface GArtist { id: number; name: string; url: string }
interface GSongRef {
  id: number;
  title: string;
  url: string;
  primary_artist: GArtist;
  song_art_image_thumbnail_url?: string;
  release_date_components?: { year?: number; month?: number; day?: number } | null;
}
interface GSong extends GSongRef {
  featured_artists?: GArtist[];
  producer_artists?: GArtist[];
  writer_artists?: GArtist[];
  custom_performances?: { label: string; artists: GArtist[] }[];
  song_relationships?: { relationship_type: string; songs: GSongRef[] }[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]|feat\..*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function dateOf(c?: GSongRef['release_date_components']): PartialDate | null {
  if (!c?.year) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (c.month && c.day) return { value: `${c.year}-${pad(c.month)}-${pad(c.day)}`, precision: 'day' };
  if (c.month) return { value: `${c.year}-${pad(c.month)}`, precision: 'month' };
  return { value: `${c.year}`, precision: 'year' };
}

// How each Genius relationship type maps onto the map's relationship types.
// `flip` means the listed song is the source (e.g. "sampled_in": the other song samples this one).
const TYPES: Record<string, { type: Relationship['type']; flip: boolean; role?: string }> = {
  samples: { type: 'samples', flip: false },
  sampled_in: { type: 'samples', flip: true },
  interpolates: { type: 'interpolates', flip: false },
  interpolated_by: { type: 'interpolates', flip: true },
  cover_of: { type: 'documented', flip: false, role: 'cover of' },
  covered_by: { type: 'documented', flip: true, role: 'cover of' },
  remix_of: { type: 'documented', flip: false, role: 'remix of' },
  remixed_by: { type: 'documented', flip: true, role: 'remix of' },
  live_version_of: { type: 'documented', flip: false, role: 'live version of' },
  performed_live_as: { type: 'documented', flip: true, role: 'live version of' },
};

export interface GeniusResult {
  data: Partial<Dataset>;
  added: number;
  message: string;
}

/**
 * Finds the track on Genius (title + first artist must match) and returns the
 * relationships and credits Genius documents for it.
 */
export async function enrichFromGenius(track: Track, known: { tracks: Track[]; people: Person[] }): Promise<GeniusResult> {
  const artist = track.artistCredit.split(',')[0].trim();
  const found = await genius<{ hits: { result: GSongRef }[] }>(`/search?q=${encodeURIComponent(`${track.title} ${artist}`)}`);
  const hit = found.hits
    .map((h) => h.result)
    .find((r) => norm(r.title) === norm(track.title) && norm(r.primary_artist.name).includes(norm(artist).split(' ')[0]));
  if (!hit) return { data: {}, added: 0, message: `Genius has no confident match for “${track.title}”.` };

  const { song } = await genius<{ song: GSong }>(`/songs/${hit.id}?text_format=plain`);
  const tracks: Track[] = [];
  const people = new Map<string, Person>();
  const rels: Relationship[] = [];
  const evidence = (explanation: string) => ({
    status: 'documented' as const,
    fictional: false,
    sourceLabel: 'Genius (community-edited)',
    sourceUrl: song.url,
    explanation,
    caveat: 'Genius credits and song relationships are edited by its community and may be incomplete.',
  });

  // Reuse songs and people already in the map when title/artist or name match.
  const trackFor = (ref: GSongRef): string => {
    const match = known.tracks.find(
      (t) => norm(t.title) === norm(ref.title) && norm(t.artistCredit).includes(norm(ref.primary_artist.name)),
    );
    if (match) return match.id;
    const id = `gen:${ref.id}`;
    if (!tracks.some((t) => t.id === id)) {
      tracks.push({
        id,
        kind: 'track',
        title: ref.title,
        artistCredit: ref.primary_artist.name,
        release: dateOf(ref.release_date_components),
        cover: ref.song_art_image_thumbnail_url ? { kind: 'image', url: ref.song_art_image_thumbnail_url } : { kind: 'generated', seed: id },
        genres: [],
        origin: 'spotify',
        externalUrl: ref.url,
      });
    }
    return id;
  };
  const personFor = (a: GArtist): string => {
    const match = known.people.find((p) => norm(p.name) === norm(a.name));
    if (match) return match.id;
    const id = `gena:${a.id}`;
    people.set(id, { id, kind: 'person', name: a.name, origin: 'spotify' });
    return id;
  };

  for (const group of song.song_relationships ?? []) {
    const map = TYPES[group.relationship_type];
    if (!map) continue;
    for (const ref of group.songs.slice(0, 12)) {
      const other = trackFor(ref);
      const [from, to] = map.flip ? [other, track.id] : [track.id, other];
      const label = group.relationship_type.replace(/_/g, ' ');
      rels.push({
        id: `gen:${song.id}:${group.relationship_type}:${ref.id}`,
        type: map.type,
        from,
        to,
        role: map.role,
        evidence: evidence(`Genius lists “${ref.title}” by ${ref.primary_artist.name} under “${label}” for this song.`),
      });
    }
  }

  const credit = (a: GArtist, role: string) =>
    rels.push({
      id: `genc:${song.id}:${a.id}:${role}`,
      type: 'credit',
      from: personFor(a),
      to: track.id,
      role,
      evidence: evidence(`Genius credits ${a.name} as ${role} on this song.`),
    });
  song.featured_artists?.forEach((a) => credit(a, 'featured artist'));
  song.producer_artists?.forEach((a) => credit(a, 'producer'));
  song.writer_artists?.forEach((a) => credit(a, 'writer'));
  song.custom_performances?.slice(0, 8).forEach((p) => p.artists.slice(0, 4).forEach((a) => credit(a, p.label.toLowerCase())));

  const links = rels.filter((r) => r.type !== 'credit').length;
  return {
    data: { tracks, people: [...people.values()], relationships: rels },
    added: rels.length,
    message: rels.length
      ? `Genius: ${links} song link${links === 1 ? '' : 's'} and ${rels.length - links} credit${rels.length - links === 1 ? '' : 's'}.`
      : 'Genius has this song but lists no samples or credits for it yet.',
  };
}
