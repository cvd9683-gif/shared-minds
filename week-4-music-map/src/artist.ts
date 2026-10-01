// Music Map - An artist's own history, beyond the songs in the map
// Who they are, where and when they started, the groups they belong to, their
// records over time, and a short biography. Facts come from MusicBrainz; the
// biography from the Wikipedia article MusicBrainz links to (so it is the same
// artist, not a namesake), or else from the artist's Genius page. Every piece
// carries its source. Profiles are kept in this browser for a month.

import { genius, geniusSource } from './genius';
import { mb } from './musicbrainz';

export interface ArtistLink {
  name: string;
  mbid: string;
  begin?: string;
  end?: string;
}

export interface ArtistRecord {
  title: string;
  date?: string;
  type: string;
}

export interface ArtistProfile {
  name: string;
  fetchedAt: number;
  found: boolean;
  mbid?: string;
  mbUrl?: string;
  type?: string;
  disambiguation?: string;
  area?: string;
  beginArea?: string;
  begin?: string;
  end?: string;
  genres: string[];
  members: ArtistLink[];
  memberOf: ArtistLink[];
  records: ArtistRecord[];
  bio?: { text: string; source: string; url: string };
  image?: string;
  links: { label: string; url: string }[];
}

const CACHE_KEY = 'musicMap:artistProfiles';
const MONTH = 30 * 24 * 3600 * 1000;
const pending = new Map<string, Promise<ArtistProfile>>();
// Also kept in memory, so a full localStorage never causes repeated lookups.
const memory = new Map<string, ArtistProfile>();

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function readCache(): Record<string, ArtistProfile> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function cachedProfile(name: string): ArtistProfile | null {
  const p = memory.get(norm(name)) ?? readCache()[norm(name)];
  return p && Date.now() - p.fetchedAt < MONTH ? p : null;
}

function store(p: ArtistProfile): void {
  memory.set(norm(p.name), p);
  const all = readCache();
  all[norm(p.name)] = p;
  // Keep the newest 150 so the cache never grows without bound.
  const keep = Object.entries(all)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, 150);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    /* storage full: profiles are a convenience */
  }
}

/** Looks the artist up once and caches the result. `hints` narrow the match when the app already knows the ids. */
export function loadProfile(name: string, hints: { mbid?: string; geniusId?: string } = {}): Promise<ArtistProfile> {
  const hit = cachedProfile(name);
  if (hit) return Promise.resolve(hit);
  const key = norm(name);
  if (!pending.has(key)) {
    pending.set(
      key,
      fetchProfile(name, hints)
        .then((p) => {
          // A lookup that found nothing (or couldn't reach anything) is retried after a day.
          if (!p.found) p.fetchedAt = Date.now() - MONTH + 24 * 3600 * 1000;
          store(p);
          return p;
        })
        .finally(() => pending.delete(key)),
    );
  }
  return pending.get(key)!;
}

interface MbArtistFull {
  id: string;
  name: string;
  type?: string;
  disambiguation?: string;
  area?: { name: string };
  'begin-area'?: { name: string };
  'life-span'?: { begin?: string; end?: string; ended?: boolean };
  genres?: { name: string; count: number }[];
  tags?: { name: string; count: number }[];
  relations?: {
    type: string;
    direction: 'forward' | 'backward';
    begin?: string | null;
    end?: string | null;
    artist?: { id: string; name: string };
    url?: { resource: string };
  }[];
}

async function fetchProfile(name: string, hints: { mbid?: string; geniusId?: string }): Promise<ArtistProfile> {
  const profile: ArtistProfile = { name, fetchedAt: Date.now(), found: false, genres: [], members: [], memberOf: [], records: [], links: [] };

  // 1. MusicBrainz: the artist, matched by id or by an exact-name search.
  let mbid = hints.mbid;
  if (!mbid) {
    try {
      const res = await mb<{ artists?: { id: string; name: string; score?: number }[] }>(
        `/artist?query=${encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`)}&limit=5`,
      );
      mbid = res.artists?.find((a) => (a.score ?? 0) >= 90 && norm(a.name) === norm(name))?.id;
    } catch {
      /* MusicBrainz unreachable: try Genius below */
    }
  }
  if (mbid) {
    try {
      const a = await mb<MbArtistFull>(`/artist/${mbid}?inc=url-rels+artist-rels+genres+tags`);
      profile.found = true;
      profile.mbid = a.id;
      profile.mbUrl = `https://musicbrainz.org/artist/${a.id}`;
      profile.type = a.type;
      profile.disambiguation = a.disambiguation || undefined;
      profile.area = a.area?.name;
      profile.beginArea = a['begin-area']?.name;
      profile.begin = a['life-span']?.begin;
      profile.end = a['life-span']?.end;
      const tags = (a.genres?.length ? a.genres : a.tags ?? []).filter((t) => t.count > 0);
      profile.genres = tags.sort((x, y) => y.count - x.count).slice(0, 5).map((t) => t.name);
      for (const r of a.relations ?? []) {
        if (r.type === 'member of band' && r.artist) {
          const link = { name: r.artist.name, mbid: r.artist.id, begin: r.begin ?? undefined, end: r.end ?? undefined };
          // forward: this artist is a member of the other; backward: the other is a member of this group.
          if (r.direction === 'forward') profile.memberOf.push(link);
          else profile.members.push(link);
        }
        const url = r.url?.resource;
        if (url && r.type === 'official homepage') profile.links.push({ label: 'Official site', url });
        if (url && r.type === 'wikidata') profile.links.push({ label: 'Wikidata', url });
        if (url && r.type === 'wikipedia') profile.links.push({ label: 'Wikipedia', url });
      }
      const dedupe = (l: ArtistLink[]) => [...new Map(l.map((x) => [x.mbid, x])).values()];
      profile.members = dedupe(profile.members);
      profile.memberOf = dedupe(profile.memberOf);

      const rg = await mb<{ 'release-groups'?: { title: string; 'first-release-date'?: string; 'primary-type'?: string; 'secondary-types'?: string[] }[] }>(
        `/release-group?artist=${a.id}&type=album|ep&limit=100`,
      );
      profile.records = (rg['release-groups'] ?? [])
        .filter((g) => !(g['secondary-types'] ?? []).some((t) => ['Compilation', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo'].includes(t)))
        .map((g) => ({
          title: g.title,
          date: g['first-release-date'] || undefined,
          type: [g['primary-type'], ...(g['secondary-types'] ?? [])].filter(Boolean).join(' · ') || 'Release',
        }))
        .sort((x, y) => (x.date ?? '9999').localeCompare(y.date ?? '9999'));
    } catch {
      /* keep what we have */
    }
  }

  // 2. Biography: the Wikipedia article MusicBrainz links to.
  try {
    const title = await wikipediaTitle(profile.links);
    if (title) {
      const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
      if (res.ok) {
        const w = await res.json();
        if (w.extract) profile.bio = { text: w.extract, source: 'Wikipedia', url: w.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}` };
        if (w.thumbnail?.source) profile.image = w.thumbnail.source;
      }
    }
  } catch {
    /* no biography */
  }

  // 3. Genius: its artist page, for a biography or picture when Wikipedia has none.
  if ((!profile.bio || !profile.image) && geniusSource()) {
    try {
      let gid = hints.geniusId;
      if (!gid) {
        const found = await genius<{ hits: { result: { primary_artist: { id: number; name: string } } }[] }>(`/search?q=${encodeURIComponent(name)}`);
        gid = found.hits.map((h) => h.result.primary_artist).find((a) => norm(a.name) === norm(name))?.id.toString();
      }
      if (gid) {
        const { artist } = await genius<{ artist: { name: string; url: string; image_url?: string; description?: { plain?: string } } }>(`/artists/${gid}?text_format=plain`);
        const text = artist.description?.plain?.trim();
        if (!profile.bio && text && text !== '?') profile.bio = { text: text.length > 900 ? `${text.slice(0, 900).replace(/\s+\S*$/, '')}…` : text, source: 'Genius', url: artist.url };
        if (!profile.image && artist.image_url && !/default_avatar/.test(artist.image_url)) profile.image = artist.image_url;
        profile.links.push({ label: 'Genius', url: artist.url });
        profile.found = true;
      }
    } catch {
      /* Genius is optional */
    }
  }
  return profile;
}

/** The English Wikipedia title for a MusicBrainz artist, through its Wikidata or Wikipedia link. */
async function wikipediaTitle(links: { label: string; url: string }[]): Promise<string | null> {
  const wiki = links.find((l) => l.label === 'Wikipedia' && /en\.wikipedia\.org\/wiki\//.test(l.url));
  if (wiki) return decodeURIComponent(wiki.url.split('/wiki/')[1]);
  const qid = links.find((l) => l.label === 'Wikidata')?.url.match(/Q\d+/)?.[0];
  if (!qid) return null;
  const res = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.entities?.[qid]?.sitelinks?.enwiki?.title ?? null;
}

/** "Formed 1991 in Queens" / "Born 1973 · Brooklyn" style lines, without inventing anything missing. */
export function lifeLine(p: ArtistProfile): string[] {
  const group = p.type === 'Group' || p.type === 'Orchestra' || p.type === 'Choir';
  const out: string[] = [];
  const where = p.beginArea || p.area;
  if (p.begin) out.push(`${group ? 'Formed' : p.type === 'Person' ? 'Born' : 'Began'} ${p.begin.slice(0, 4)}${where ? ` in ${where}` : ''}`);
  else if (where) out.push(`From ${where}`);
  if (p.end) out.push(`${group ? 'Disbanded' : p.type === 'Person' ? 'Died' : 'Ended'} ${p.end.slice(0, 4)}`);
  return out;
}
