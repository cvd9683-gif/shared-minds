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

1. **My timeline.** Covers float through depth by the date they were saved. Scroll,
   drag, use the arrow keys or drag the rail. The dashed frame shows the period
   you're viewing, and year frames pass you as you move forward.
2. **Select a cover.** It becomes the starting track: it keeps a vermilion ring on
   the map and a fixed card at the top of the panel. Title, artist, release date
   and saved date are separate fields.
3. **Read a connection.** Select a node, or pick it from the panel list. The panel
   gives the relationship in plain words, its direction, a short explanation, and
   its evidence: source, and whether it is documented, disputed or unconfirmed.
4. **Follow it.** Select it again or press *Follow*. The path bar keeps every
   step, with *Back*, a clickable breadcrumb for each step, and *Return*.
5. **Return and listen.** When authorized playback exists (Spotify's embedded
   player), you can load it. An optional *What do you notice now?* box is saved
   with the journey. Nothing is scored.
6. **Music history.** Switch the date system at any time without losing your
   selection or path. Recordings move onto a release-date axis. Empty decades are
   compressed and marked. Unknown dates go in their own box. People sit in a
   separate lane and are never given a date.

## Assignment mapping (Shared Minds)

| Requirement | Where |
| --- | --- |
| Organize data in JSON | `src/data/demo-collection.json` holds tracks, people, collection entries and relationships as separate lists. Journeys are JSON too (`types.ts → Journey`). |
| Save to localStorage | `store.ts → LocalStore`, the default. |
| Replace it with Firebase | `store.ts → createFirebaseStore` uses the Realtime Database once a config is present. The same interface, so nothing else changes. |
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
3. Put the Client ID in `VITE_SPOTIFY_CLIENT_ID`, or paste it in the app.
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
  field.ts                    3D "My timeline" field + rail (flat list on narrow screens)
  network.ts                  local network, both layouts, history axis
  graph.ts                    graph index, relationship sentences, date formatting
  journey.ts                  sequence recording and scene descriptions
  store.ts                    localStorage / Firebase storage, prompt() name
  spotify.ts                  PKCE auth, library import, search
  musicbrainz.ts              optional sourced credits and samples
  covers.ts                   generated sleeves for fictional tracks
  data/demo-collection.json   fictional dataset
```
