// Music Map - Sourced relationships from MusicBrainz (optional, on request)
// For a Spotify track with an ISRC, looks up the matching MusicBrainz recording and
// adds the relationships MusicBrainz documents: credited people with their roles,
// "samples material" links between recordings, and writers of the performed work.
// Nothing is inferred; every relationship links back to the MusicBrainz page.
// MusicBrainz asks for at most one request per second.

import type { Dataset, Person, Relationship, Track } from './types';

const MB = 'https://musicbrainz.org/ws/2';
let lastRequest = 0;

async function mb<T>(path: string): Promise<T> {
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(`${MB}${path}${path.includes('?') ? '&' : '?'}fmt=json`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MusicBrainz request failed (${res.status}).`);
  return res.json();
}

interface MbArtist { id: string; name: string; type?: string }
interface MbRelation {
  type: string;
  direction: 'forward' | 'backward';
  'target-type': string;
  attributes?: string[];
  artist?: MbArtist;
  recording?: { id: string; title: string; 'first-release-date'?: string; 'artist-credit'?: { name: string }[] };
  work?: { id: string; title: string };
}
interface MbRecording { id: string; title: string; relations?: MbRelation[] }

function partialDate(value?: string) {
  if (!value) return null;
  const precision = value.length === 4 ? 'year' : value.length === 7 ? 'month' : 'day';
  return { value, precision } as const;
}

export interface EnrichResult {
  data: Partial<Dataset>;
  recordingUrl: string | null;
  added: number;
  message: string;
}

export async function enrichFromMusicBrainz(track: Track, knownPeople: Person[]): Promise<EnrichResult> {
  // Spotify stopped sending ISRCs in Feb 2026; fall back to a strict title + artist search.
  const isrc = track.spotify?.isrc;
  let recId: string | undefined;
  if (isrc) {
    const lookup = await mb<{ recordings?: { id: string }[] }>(`/isrc/${encodeURIComponent(isrc)}`);
    recId = lookup.recordings?.[0]?.id;
  }
  if (!recId) {
    const artist = track.artistCredit.split(',')[0].trim();
    const q = `recording:"${track.title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
    const found = await mb<{ recordings?: { id: string; score?: number }[] }>(`/recording?query=${encodeURIComponent(q)}&limit=3`);
    recId = found.recordings?.find((r) => (r.score ?? 0) >= 90)?.id;
  }
  if (!recId) {
    return { data: {}, recordingUrl: null, added: 0, message: `MusicBrainz has no confident match for “${track.title}”.` };
  }
  const rec = await mb<MbRecording>(`/recording/${recId}?inc=artist-rels+recording-rels+work-rels`);
  const recUrl = `https://musicbrainz.org/recording/${rec.id}`;

  const people = new Map<string, Person>();
  const tracks: Track[] = [];
  const rels: Relationship[] = [];

  // Reuse a person already on this track when the name matches exactly.
  const personFor = (a: MbArtist): string => {
    const known = knownPeople.find((p) => p.name.toLowerCase() === a.name.toLowerCase());
    if (known) return known.id;
    const id = `mba:${a.id}`;
    people.set(id, {
      id,
      kind: a.type === 'Group' ? 'group' : 'person',
      name: a.name,
      origin: 'musicbrainz',
      musicbrainzId: a.id,
    });
    return id;
  };
  const evidence = (explanation: string, url = recUrl) => ({
    status: 'documented' as const,
    fictional: false,
    sourceLabel: 'MusicBrainz (community-maintained)',
    sourceUrl: url,
    explanation,
    caveat: 'MusicBrainz is edited by volunteers and may be incomplete.',
  });

  const works: { id: string; title: string }[] = [];

  for (const r of rec.relations ?? []) {
    const attrs = r.attributes?.length ? ` (${r.attributes.join(', ')})` : '';
    if (r['target-type'] === 'artist' && r.artist) {
      const pid = personFor(r.artist);
      const role = `${r.type}${attrs}`;
      rels.push({
        id: `mb:${rec.id}:${r.artist.id}:${role}`,
        type: 'credit',
        from: pid,
        to: track.id,
        role,
        evidence: evidence(`MusicBrainz credits ${r.artist.name} as “${role}” on this recording.`),
      });
    } else if (r['target-type'] === 'recording' && r.recording) {
      const other: Track = {
        id: `mbr:${r.recording.id}`,
        kind: 'track',
        title: r.recording.title,
        artistCredit: r.recording['artist-credit']?.map((c) => c.name).join(', ') || 'See MusicBrainz',
        release: partialDate(r.recording['first-release-date']),
        cover: { kind: 'generated', seed: r.recording.id },
        genres: [],
        origin: 'musicbrainz',
        musicbrainzId: r.recording.id,
      };
      tracks.push(other);
      const isSample = r.type === 'samples material';
      const [from, to] = r.direction === 'forward' ? [track.id, other.id] : [other.id, track.id];
      rels.push({
        id: `mb:${rec.id}:${r.recording.id}:${r.type}`,
        type: isSample ? 'samples' : 'documented',
        from,
        to,
        role: isSample ? undefined : r.type,
        evidence: evidence(
          isSample
            ? `MusicBrainz records that one of these recordings samples the other (“${r.type}”).`
            : `MusicBrainz lists the relationship “${r.type}” between these recordings.`,
        ),
      });
    } else if (r['target-type'] === 'work' && r.work && r.type === 'performance') {
      works.push(r.work);
    }
  }

  // Writers are credited on the work (composition), not the recording.
  for (const work of works.slice(0, 2)) {
    const w = await mb<{ relations?: MbRelation[] }>(`/work/${work.id}?inc=artist-rels`);
    for (const r of w.relations ?? []) {
      if (r['target-type'] !== 'artist' || !r.artist) continue;
      if (!['composer', 'lyricist', 'writer'].includes(r.type)) continue;
      const pid = personFor(r.artist);
      rels.push({
        id: `mbw:${work.id}:${r.artist.id}:${r.type}`,
        type: 'credit',
        from: pid,
        to: track.id,
        role: `${r.type} (of the work “${work.title}”)`,
        evidence: evidence(
          `MusicBrainz lists ${r.artist.name} as ${r.type} of the composition “${work.title}”, which this recording performs.`,
          `https://musicbrainz.org/work/${work.id}`,
        ),
      });
    }
  }

  return {
    data: { tracks, people: [...people.values()], relationships: rels },
    recordingUrl: recUrl,
    added: rels.length,
    message: rels.length
      ? `Added ${rels.length} relationship${rels.length === 1 ? '' : 's'} documented on MusicBrainz.`
      : 'MusicBrainz has this recording but documents no credits or samples for it yet.',
  };
}
