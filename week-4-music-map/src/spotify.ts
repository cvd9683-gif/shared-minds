// Music Map - Spotify Web API (Authorization Code with PKCE, browser only)
// Imports the listener's saved tracks (with the date each was saved) and powers
// search. Spotify supplies track artists, album release dates and cover art; it
// does not supply samples, interpolations or detailed credits.

import { siteConfig } from './config';
import type { Dataset, PartialDate, Person, Playlist, Relationship, Track } from './types';

const CLIENT_ID_KEY = 'musicMap:spotifyClientId';
const TOKEN_KEY = 'musicMap:spotifyToken';
const VERIFIER_KEY = 'musicMap:spotifyVerifier';
// Read-only: saved tracks with their saved dates, and the playlists you made.
const SCOPES = ['user-library-read', 'playlist-read-private', 'playlist-read-collaborative'];
const API = 'https://api.spotify.com/v1';

interface Token {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  /** Permissions Spotify actually granted (space-separated). */
  scope?: string;
}

/** Permissions this app asks for that the current sign-in doesn't have (e.g. after an upgrade). */
export function missingScopes(): string[] {
  const t = readToken();
  if (!t) return SCOPES;
  const granted = new Set((t.scope ?? '').split(/\s+/));
  return SCOPES.filter((s) => !granted.has(s));
}

/** A visitor's own Spotify app comes first, then the developer's .env, then the site's shared app. */
export function spotifyClientId(): string | null {
  return localStorage.getItem(CLIENT_ID_KEY) || import.meta.env.VITE_SPOTIFY_CLIENT_ID || siteConfig().spotifyClientId || null;
}

/** True when connecting goes through the site owner's shared Spotify app. */
export function usingSharedApp(): boolean {
  return !localStorage.getItem(CLIENT_ID_KEY) && !import.meta.env.VITE_SPOTIFY_CLIENT_ID && !!siteConfig().spotifyClientId;
}

export function saveSpotifyClientId(id: string): void {
  if (id.trim()) localStorage.setItem(CLIENT_ID_KEY, id.trim());
  else localStorage.removeItem(CLIENT_ID_KEY);
}

export function redirectUri(): string {
  // ".../site/" and ".../site/index.html" are the same page; Spotify needs one exact URI.
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function readToken(): Token | null {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function storeToken(t: { access_token: string; refresh_token?: string; expires_in: number; scope?: string }): void {
  const prev = readToken();
  const token: Token = {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? prev?.refresh_token,
    expires_at: Date.now() + (t.expires_in - 60) * 1000,
    scope: t.scope ?? prev?.scope,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
}

export function isConnected(): boolean {
  return readToken() !== null;
}

export function disconnect(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
}

const NAME_KEY = 'musicMap:spotifyName';

export function profileName(): string | null {
  return localStorage.getItem(NAME_KEY);
}

/** Remembers the display name of the connected account, when Spotify still provides it. */
export async function loadProfileName(): Promise<void> {
  try {
    const me = await api<{ display_name?: string | null; id?: string }>('/me');
    const name = me.display_name || me.id;
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch {
    /* profile details are optional */
  }
}

// ---- PKCE -----------------------------------------------------------------

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sends you to Spotify to approve access. `chooseAccount` asks Spotify to show the account screen again. */
export async function beginLogin(chooseAccount = false): Promise<void> {
  const clientId = spotifyClientId();
  if (!clientId) throw new Error('Add a Spotify Client ID first.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  localStorage.setItem(VERIFIER_KEY, verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES.join(' '),
    ...(chooseAccount ? { show_dialog: 'true' } : {}),
  });
  location.assign(`https://accounts.spotify.com/authorize?${params}`);
}

/** Completes the login if Spotify redirected back here. */
export async function completeLoginFromUrl(): Promise<{ completed: boolean; error: string | null }> {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return { completed: false, error: null };
  url.searchParams.delete('code');
  url.searchParams.delete('error');
  url.searchParams.delete('state');
  history.replaceState(null, '', url.toString());
  if (error) {
    return { completed: false, error: error === 'access_denied' ? 'Spotify connection was cancelled.' : `Spotify: ${error}` };
  }

  const verifier = localStorage.getItem(VERIFIER_KEY);
  const clientId = spotifyClientId();
  if (!verifier || !clientId) return { completed: false, error: 'Spotify login could not be completed (missing verifier).' };
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  localStorage.removeItem(VERIFIER_KEY);
  if (!res.ok) return { completed: false, error: `Spotify login failed (${res.status}).` };
  storeToken(await res.json());
  return { completed: true, error: null };
}

async function refresh(): Promise<boolean> {
  const token = readToken();
  const clientId = spotifyClientId();
  if (!token?.refresh_token || !clientId) return false;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: clientId }),
  });
  if (!res.ok) {
    disconnect();
    return false;
  }
  storeToken(await res.json());
  return true;
}

export class SpotifyError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function api<T>(path: string, retried = false): Promise<T> {
  let token = readToken();
  if (!token) throw new SpotifyError('Not connected to Spotify.', 401);
  if (Date.now() > token.expires_at && (await refresh())) token = readToken()!;
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (res.status === 401 && !retried && (await refresh())) return api(path, true);
  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get('Retry-After') ?? '2');
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
    return api(path, true);
  }
  if (!res.ok) {
    const hint =
      res.status === 403
        ? ' Spotify only lets accounts the app owner has added (User Management) use this app. Ask for access, or connect with your own Spotify app.'
        : '';
    throw new SpotifyError(`Spotify request failed (${res.status}).${hint}`, res.status);
  }
  return res.json();
}

// ---- Mapping Spotify objects into the graph -------------------------------

interface SpImage { url: string; width: number | null }
interface SpArtist { id: string; name: string; external_urls: { spotify: string } }
interface SpAlbum {
  id: string;
  name: string;
  release_date: string;
  release_date_precision: 'year' | 'month' | 'day';
  images: SpImage[];
  artists: SpArtist[];
  external_urls: { spotify: string };
  album_type?: string;
  tracks?: { items: SpTrack[] };
}
interface SpTrack {
  id: string;
  name: string;
  uri: string;
  artists: SpArtist[];
  album?: SpAlbum;
  external_ids?: { isrc?: string };
  external_urls: { spotify: string };
}

export const trackId = (spId: string) => `sp:${spId}`;
export const artistId = (spId: string) => `spa:${spId}`;

function releaseOf(album?: SpAlbum): PartialDate | null {
  if (!album?.release_date || album.release_date.startsWith('0000')) return null;
  return { value: album.release_date, precision: album.release_date_precision ?? 'day' };
}

function pickImage(images: SpImage[] = []): string | undefined {
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= 250) ?? sorted[sorted.length - 1])?.url;
}

/** Converts a Spotify track (with its album) into graph entities. */
export function mapTrack(t: SpTrack, album = t.album): Partial<Dataset> {
  const img = pickImage(album?.images);
  const track: Track = {
    id: trackId(t.id),
    kind: 'track',
    title: t.name,
    artistCredit: t.artists.map((a) => a.name).join(', '),
    release: releaseOf(album),
    releaseNote:
      'Spotify reports the release date of the album this track appears on. A reissue, remaster or compilation can carry a later date than the original recording.',
    cover: img ? { kind: 'image', url: img } : { kind: 'generated', seed: album?.id ?? t.id },
    album: album ? { id: `spal:${album.id}`, name: album.name } : undefined,
    genres: [],
    origin: 'spotify',
    spotify: { id: t.id, url: t.external_urls.spotify, uri: t.uri, isrc: t.external_ids?.isrc },
  };
  const people: Person[] = t.artists.map((a) => ({
    id: artistId(a.id),
    kind: 'person',
    name: a.name,
    origin: 'spotify',
    spotify: { id: a.id, url: a.external_urls.spotify },
  }));
  const relationships: Relationship[] = t.artists.map((a, i) => ({
    id: `sp-credit:${t.id}:${a.id}`,
    type: 'credit',
    from: artistId(a.id),
    to: track.id,
    role: i === 0 ? 'credited artist (listed first)' : 'credited artist',
    evidence: {
      status: 'documented',
      fictional: false,
      sourceLabel: 'Spotify track metadata',
      sourceUrl: t.external_urls.spotify,
      explanation: `Spotify lists ${a.name} as an artist on this track. Spotify does not say what their specific role was.`,
    },
  }));
  return { tracks: [track], people, relationships };
}

function mergeParts(parts: Partial<Dataset>[]): Partial<Dataset> {
  return {
    tracks: parts.flatMap((p) => p.tracks ?? []),
    people: parts.flatMap((p) => p.people ?? []),
    relationships: parts.flatMap((p) => p.relationships ?? []),
    collection: parts.flatMap((p) => p.collection ?? []),
  };
}

/** Imports saved tracks with their saved dates. */
export async function importSavedTracks(
  max = 10000,
  onProgress?: (n: number, total: number) => void,
): Promise<Partial<Dataset>> {
  const parts: Partial<Dataset>[] = [];
  let url: string | null = `/me/tracks?limit=50`;
  let count = 0;
  while (url && count < max) {
    const page: { items: { added_at: string; track: SpTrack | null }[]; next: string | null; total: number } =
      await api(url);
    for (const entry of page.items) {
      // Saved-track entries may carry the song under `track` or (Feb 2026) `item`.
      const item = { added_at: entry.added_at, track: entry.track ?? (entry as { item?: SpTrack }).item ?? null };
      if (!item.track?.id) continue;
      const part = mapTrack(item.track);
      part.collection = [{ trackId: trackId(item.track.id), savedAt: item.added_at, source: 'spotify' }];
      parts.push(part);
      count++;
    }
    onProgress?.(count, Math.min(page.total, max));
    url = page.next;
  }
  return {
    meta: {
      name: 'Your Spotify saved tracks',
      fictional: false,
      description: 'Saved tracks and saved dates imported from your Spotify library.',
    },
    ...mergeParts(parts),
  };
}

/**
 * Playlists the listener created (not ones they follow), with their track ids.
 * Capped so a big library doesn't take minutes; missing access is reported, not hidden.
 */
export async function importPlaylists(
  onProgress?: (done: number, total: number) => void,
  maxPlaylists = 60,
): Promise<{ playlists: Playlist[]; note: string }> {
  if (missingScopes().some((sc) => sc.startsWith('playlist'))) {
    return { playlists: [], note: 'reconnect' };
  }
  try {
    const lists: { id: string; name: string; external_urls: { spotify: string } }[] = [];
    let url: string | null = '/me/playlists?limit=50';
    while (url && lists.length < maxPlaylists) {
      const page: { items: ({ id: string; name: string; external_urls: { spotify: string } } | null)[]; next: string | null } = await api(url);
      page.items.forEach((p) => p && lists.length < maxPlaylists && lists.push(p));
      url = page.next;
    }
    const playlists: Playlist[] = [];
    let refused = 0;
    let done = 0;
    for (const p of lists) {
      // Since Feb 2026 items live at /items (each entry's song under `item`), and only
      // playlists you own or collaborate on return them; others answer 403 and are skipped.
      try {
        const { ids, keys } = await playlistTrackIds(p.id);
        playlists.push({ id: `spp:${p.id}`, name: p.name, url: p.external_urls.spotify, trackIds: ids, keys });
      } catch {
        refused++;
      }
      onProgress?.(++done, lists.length);
    }
    const note = !lists.length
      ? 'Spotify returned no playlists for this account.'
      : refused
        ? `${refused} of ${lists.length} playlists couldn't be read (Spotify only shares playlists you made or collaborate on).`
        : '';
    return { playlists, note };
  } catch (err) {
    return { playlists: [], note: `Playlists couldn't be read: ${(err as Error).message}` };
  }
}

type PlaylistSong = { id: string | null; name?: string; artists?: { name: string }[] };
type PlaylistEntry = { item?: PlaylistSong | null; track?: PlaylistSong | null };

/** "Song Title (Remastered)" + "Artist" → a key that survives Spotify giving the same song a different id. */
export function songKey(title: string, artist: string): string {
  const norm = (x: string) => x.toLowerCase().replace(/\(.*?\)|\[.*?\]|- .*remaster.*$|feat\..*$/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm(title)}|${norm(artist)}`;
}

async function playlistTrackIds(playlistId: string): Promise<{ ids: string[]; keys: string[] }> {
  const ids: string[] = [];
  const keys: string[] = [];
  const read = async (path: string) => {
    let next: string | null = `/playlists/${playlistId}/${path}?limit=50`;
    while (next && ids.length < 1000) {
      const page: { items: PlaylistEntry[]; next: string | null } = await api(next);
      page.items.forEach((e) => {
        const song = e.item ?? e.track;
        if (!song?.id) return;
        ids.push(trackId(song.id));
        if (song.name && song.artists?.[0]) keys.push(songKey(song.name, song.artists[0].name));
      });
      next = page.next;
    }
  };
  try {
    await read('items');
  } catch (err) {
    // Older apps may still be served the pre-2026 path.
    if (err instanceof SpotifyError && err.status === 404) await read('tracks');
    else throw err;
  }
  return { ids, keys };
}

// ---- Search ---------------------------------------------------------------

export type SearchKind = 'all' | 'track' | 'artist' | 'album' | 'genre';

export interface SpotifySearchResults {
  tracks: Partial<Dataset>[];
  artists: { id: string; name: string; image?: string; url: string; genres: string[] }[];
  albums: { id: string; name: string; artist: string; image?: string; release: PartialDate | null }[];
}

export async function search(query: string, kind: SearchKind): Promise<SpotifySearchResults> {
  const q = kind === 'genre' ? `genre:"${query}"` : query;
  const types = kind === 'all' ? 'track,artist,album' : kind === 'genre' ? 'track,artist' : kind;
  const res = await api<{
    tracks?: { items: SpTrack[] };
    artists?: { items: (SpArtist & { images?: SpImage[]; genres?: string[] })[] };
    albums?: { items: SpAlbum[] };
  }>(`/search?${new URLSearchParams({ q, type: types, limit: '10' })}`);
  return {
    tracks: (res.tracks?.items ?? []).filter(Boolean).map((t) => mapTrack(t)),
    artists: (res.artists?.items ?? []).filter(Boolean).map((a) => ({
      id: a.id,
      name: a.name,
      image: pickImage(a.images),
      url: a.external_urls.spotify,
      genres: a.genres ?? [],
    })),
    albums: (res.albums?.items ?? []).filter(Boolean).map((al) => ({
      id: al.id,
      name: al.name,
      artist: al.artists.map((a) => a.name).join(', '),
      image: pickImage(al.images),
      release: releaseOf(al),
    })),
  };
}

// Album and artist-album endpoints were removed for Development Mode apps in
// Feb 2026, so drilling down from a search result is done with search itself.
async function searchTracks(q: string): Promise<Partial<Dataset>[]> {
  const res = await api<{ tracks?: { items: SpTrack[] } }>(`/search?${new URLSearchParams({ q, type: 'track', limit: '10' })}`);
  return (res.tracks?.items ?? []).filter(Boolean).map((t) => mapTrack(t));
}

export function artistTracks(artistName: string): Promise<Partial<Dataset>[]> {
  return searchTracks(`artist:"${artistName}"`);
}

export function albumTracks(albumName: string, artistName: string): Promise<Partial<Dataset>[]> {
  return searchTracks(`album:"${albumName}" artist:"${artistName}"`);
}
