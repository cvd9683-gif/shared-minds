# Music Map — prototype

A personal music timeline that opens into a map of music history. It explores
the gap between **when you saved a song** and **the recordings, samples,
interpolations and people connected to it**, and invites you to hear a familiar
track again after following one route through its history.

Shared Minds · Week 4. The built app lives in [`site/`](site/) and needs no build step
to open. To work on it:

```bash
cd week-4-music-map
npm install
npm run dev        # → http://127.0.0.1:5173/
npm run build      # regenerates site/
```

It works straight away on a **fictional demo dataset**: invented tracks, people,
saved dates and relationships. None of it is real music, and none of it is anyone's
listening history.

## The journey

The top bar holds **Personal Timeline ● Historical Timeline**, a green **Connect
Spotify** button, search, **?** (how to explore) and **⋯** (name, storage, journeys).

1. **Personal Timeline.** Albums sit on the axis itself, overlapping, one stretch
   per year. Songs saved from the same album are one cover with a count (matched by
   Spotify album, or by identical cover art for older imports). A lens follows the
   pointer: nearby covers bloom into a collage above and below the line, then
   settle back. The magnifier docked top-right shows the year under the lens,
   joined to it by two lines.
2. **Pick an album.** It grows on the line and pins the magnifier. Beside it you
   get the songs you saved from it, then **1 · your memories**, **2 · date added**
   and **3 · playlists it's in**. Your name is only asked for when you first save a
   memory.
3. **Historical Timeline starts as a web.** Every album in the map is fanned around
   its artist. Artists who share credits or sampled songs are pulled together, and
   sample and interpolation links arc across. Scroll or pinch to zoom from the whole
   library down to single covers, drag to move. Hover an artist or album to light
   up its connections.
4. **Open a song.** Clicking an album or artist opens its focused web: samples,
   interpolations, covers, remixes, credited people and their other work. A blurb
   explains it from sourced relationships. Select a node to read the link, select
   again to follow; *Close* returns to the whole web.

## Where song history comes from

- **Spotify**: saved songs and dates, albums, cover art, playlists you made.
- **Genius** (optional, recommended): what a song samples and is sampled in,
  interpolations, covers, remixes, live versions, and producer/writer credits. Paste
  a free *Client Access Token* from <https://genius.com/api-clients> into the
  Spotify dialog. Songs are looked up automatically the first time you open them.
- **MusicBrainz**: credits and documented samples, looked up by title and artist.
- There's no public API for WhoSampled; Genius covers most of the same links.

Spotify's February 2026 changes affect this app: playlist items moved to
`/playlists/{id}/items`, with each song under `item`. Only playlists you own or
collaborate on return their songs. ISRCs and the album/artist lookup endpoints are
gone for Development Mode apps, and Development Mode requires Premium.

## Assignment mapping (Shared Minds)

| Requirement | Where |
| --- | --- |
| Organize data in JSON | `src/data/demo-collection.json` holds tracks, people, collection entries and relationships as separate lists. Journeys are JSON too (`types.ts → Journey`). |
| Save to localStorage | `store.ts → LocalStore`, the default. |
| Replace it with Firebase | `store.ts → createFirebaseStore` uses the Realtime Database once a config is present. The same interface, so nothing else changes. |
| Record your own thoughts | Year captions and thoughts (`types.ts → YearData`) save under `musicMap/explorers/<name>/years/<year>`. |
| Record and recall a description of the scene | Every journey stores a generated, factual `scene` description plus your own optional `description`. Both are shown in the panel and in the journey list. |
| `prompt()` for names | `store.ts → askExplorer()`. It asks on your first selection, and again from the "Exploring as" chip. Data is stored under `musicMap/explorers/<name>/…`. |
| Record a sequence of things | `journey.ts` records each select, follow, back, return, view change, listen and reflection as a step. *Replay* plays a sequence back on the map. |
| Spotify data and playback | `spotify.ts` imports saved tracks with their saved dates (PKCE, `user-library-read` only), searches, and loads Spotify's embedded player. |
| Search artists, albums and genres | Header search. It searches the local map, plus the Spotify catalog when connected (`genre:"…"` for genres). Artists open their albums, and albums open their tracks. |

### Firebase layout

```
musicMap/explorers/<name-key>/
  name: "Ada"
  journeys/<id>: { explorer, originId, steps[], nodes{}, relLabels{}, scene, description?, reflection?, … }
  notes/<trackId>: { trackId, text, updatedAt }
  years/<year>: { label?, thoughts: [{ id, text, at, trackId? }] }
  hidden: [trackId, …]
```

Everyone using the same database can read everyone's journeys. The *Other
explorers* list in the panel shows them. Start with test-mode rules for class,
and tighten them when Firebase Auth replaces `prompt()`.

## Setup (optional)

Copy `.env.example` to `.env.local`, or paste the values into **Saving to… →
Connections** in the app (they're stored in this browser).

**Making it work for everyone (hosted site)**

The hosted site reads `site/config.json` (source: `public/config.json`), which you can
edit on GitHub without rebuilding:

- `spotifyClientId`: your Spotify app's Client ID. Visitors then just press *Connect*.
- `geniusProxy`: the URL of the Genius proxy (see `genius-proxy/README.md`), so every
  visitor gets samples and credits without a token.
- `liveUrl`: the hosted address. Previews (such as a claude.ai artifact) run the app
  inside a frame, where Spotify's sign-in refuses to load, so the app links here instead.

Spotify limits who can use a Development Mode app: only accounts you add under
*User Management* can sign in through it, and Spotify grants wider access only to
registered organisations. Anyone else can connect with their own free Spotify app.
The Connect dialog walks them through it and shows the exact Redirect URI.

**Spotify**

1. Create an app at <https://developer.spotify.com/dashboard> and choose Web API.
2. Add the Redirect URIs `http://127.0.0.1:5173/` and
   `https://cvd9683-gif.github.io/shared-minds/week-4-music-map/site/`. Spotify no longer
   accepts `localhost`, which is why the dev server binds to `127.0.0.1`.
3. Put the Client ID in `config.json` (everyone), `VITE_SPOTIFY_CLIENT_ID` (local dev), or
   paste it in the app. The app asks only for read access: saved tracks
   (`user-library-read`) and your playlists (`playlist-read-private`, `playlist-read-collaborative`).
4. Add each classmate's Spotify account under *User Management*, or Spotify refuses
   their requests (403).

**Genius**

Locally, put `GENIUS_TOKEN=…` in `.env.local`; the dev server adds it to Genius requests
and it never ends up in the built site. For the hosted site, deploy `genius-proxy/`.

**Firebase**

1. Create a project, add a Web app, and create a **Realtime Database**.
2. Paste the `firebaseConfig` object into the app, or fill the `VITE_FIREBASE_*`
   variables. It must include `databaseURL`.

## Honesty rules the code follows

- "Saved", never "First heard". A save date says nothing about when you first
  heard a track or what it meant.
- Samples (the recording itself) and interpolations (the composition re-performed)
  are separate relationship types with separate line styles.
- Every relationship stores its source, a short explanation and a status. Demo
  relationships are labelled *fictional — not a real reference*. Disputed and
  unconfirmed links are flagged on the map and in the panel.
- Shared credits are shown only as shared credits. The map infers no friendship,
  mentorship or influence.
- No real-artist links are invented. Real relationships come only from Spotify
  (track artists) or, on request, MusicBrainz (credits, "samples material", and
  writers of the performed work). Both link back to the source.
- Unknown dates stay unknown. Year-only and month-only dates show their precision.
- No fake player and no substitute audio. Fictional tracks say they have no audio.
- Personal notes are written only by you. Nothing is generated from listening data.
  Hiding a track affects only this map.

## Files

```
index.html                    page shell
site/                         built app (committed)
src/
  main.ts                     app state, navigation, panel, search, replay
  canvas.ts                   timeline canvas: year columns, magnifier box, pinned cover
  network.ts                  local network, both layouts, history axis
  graph.ts                    graph index, relationship sentences, date formatting
  journey.ts                  sequence recording and scene descriptions
  store.ts                    localStorage / Firebase storage, prompt() name
  spotify.ts                  PKCE auth, library import, search
  musicbrainz.ts              optional sourced credits and samples
  covers.ts                   generated sleeves for fictional tracks
  data/demo-collection.json   fictional dataset
```
