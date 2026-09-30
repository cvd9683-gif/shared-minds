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

The top bar holds only **Personal Timeline ● Historical Timeline** and a search
box. Everything else (Spotify, your name, storage, journeys, data source) lives in
the **⋯** menu.

1. **Personal Timeline.** A horizontal axis with a tick per year, like the paper
   timeline. Each year's covers are packed into a collage column under the axis.
   Hover a year and a magnifier box above the axis shows it at a readable size,
   joined to its stretch of the axis by two lines. Scroll or drag sideways; the box
   follows the year in the middle.
2. **Pick a cover.** The magnifier pins: the cover grows, and beside it are
   **1 · your memories** (add, edit, delete), **2 · date added**, and
   **3 · playlists it's in** (playlists you made on Spotify). From there, *Step into
   the year* opens the full year view with its caption and thoughts.
3. **Historical Timeline.** The same canvas by release year. Older years are
   grouped by decade, with gaps and unknown dates marked. Picking a cover (or *See
   where it comes from*) puts the song on a release-date axis. Its samples,
   interpolations and people branch off it, and people branch on to a few of their
   other works. A **blurb** box explains the song using only its stored, sourced
   relationships.
4. **Read and follow connections.** Select a node and the blurb shows how it's
   linked, with its evidence. Select it again, or press *Follow*, to move there. The
   path bar keeps every step, with *Back* and *Return*. *Close* takes you back to
   the cover you started from.

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

**Spotify**

1. Create an app at <https://developer.spotify.com/dashboard> and choose Web API.
2. Add the Redirect URI `http://127.0.0.1:5173/` (and the deployed `…/week-4-music-map/site/` address). Spotify no longer
   accepts `localhost`, which is why the dev server binds to `127.0.0.1`.
3. Put the Client ID in `VITE_SPOTIFY_CLIENT_ID`, or paste it in the app (**⋯ → Set up Spotify**).
   The app asks only for read access: saved tracks (`user-library-read`) and your
   playlists (`playlist-read-private`, `playlist-read-collaborative`).
4. In Development Mode, add each classmate's Spotify account under *User
   Management*, or their requests will be refused (403).

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
