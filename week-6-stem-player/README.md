# Stem Player

Shared Minds · Week 6. Open [`index.html`](index.html) in a browser; it needs no build step.
Serve the folder (for example `python3 -m http.server`) rather than opening the file
directly, because the scripts are modules.

A song held in your hand. After the Stem Player: a soft disc with four strips of light in a
cross, one for each layer of the song: vocals, drums, bass and everything else. Slide out
along a strip to bring that layer up, slide in to take it away. Or put your hand up to the
webcam and do the same in the air.

## How it works

- **Any song.** Drop an audio file anywhere, or use *Load a song*. At first the four layers
  are carved out of the mix with filters, instantly (see *True stems* below for the real thing). Bass is everything
  low, drums is everything high (cymbals, hats, the crack of a snare), and the middle band is
  split by where it sits in the stereo image: the centre, where a lead voice usually is, is
  vocals, and the edges are other. All four at full add back up to the song. It is honest
  about this: the status line says *carved from the mix*.
- **Real stems.** Drop four files at once whose names say *vocals*, *drums*, *bass* and
  *other* (the names Demucs gives them) and they play as true stems, started on the same
  tick of the audio clock so they never drift. The demo loop that plays first is four real
  stems, synthesised in the browser.
- **The lights.** Each strip's lights fill as you turn it up, and the lit ones pulse with
  what that layer is playing. A layer turned all the way down still breathes faintly, so you
  can see it is there before you bring it back.
- **Hands.** *Use hands* turns on the webcam. Hand tracking (MediaPipe) runs entirely in the
  browser; no video leaves the computer. Hover: hold your hand still over a strip and a ring
  closes in on it; after a moment the strip is yours. Slide along it, then move off to the
  side to let go. Hover over the middle to play or pause. A pinch takes hold instantly, for
  anyone who prefers it. Soft clicks mark taking hold and letting go, and a faint tick marks
  each light a level passes. Two hands can hold two strips at once.
- **The object.** The disc tilts a little toward whatever is touching it and dips when you
  press, and a ring round the middle button fills as the song plays.

## Controls, after the Stem Player

| On the disc | What it does | Key |
| --- | --- | --- |
| Slide a strip | That layer's volume | 1–4 mute and unmute |
| The ring at a strip's end | Solo that layer; solo several to hear only those | Shift + 1–4 |
| Tap the middle | Play or pause | Space |
| Hold the middle | Loop the next two seconds | L |
| LOOP | Loop the next two seconds, or let the loop go | L |
| FX | Effects mode: the strips become echo, gate, speed and feedback; press again to go back | F |
| The middle, in effects mode | Reset every effect and the loop | R |
| − and + | Volume | − and + |

Hands do all of it by hovering: hold still over a strip, a key or a strip's end.

## Files

- `js/engine.js`: the audio: four layers, their volumes and meters, carving a mix into layers.
- `js/disc.js`: the Three.js disc, its lights, and turning a screen point into a spot on it.
- `js/hands.js`: webcam hand tracking, pinch detection and smoothing.
- `js/demo.js`: the demo loop, synthesised as four parts.
- `js/main.js`: ties them together. Mouse, fingers and hands all become the same kind of touch.

## True stems

On the hosted site, an uploaded song gets a **Find true stems** button. It sends the song to
Demucs (`htdemucs`) on Replicate, which separates it by instrument in a minute or two, for a
few cents a song.
The song keeps playing carved meanwhile, and a slow wave of light runs along the strips;
when the stems arrive they take over at the same moment, at the same levels. Stems are kept,
so a song you have already split comes back straight away and free.

How it travels: the browser uploads the song straight to Vercel Blob (songs are too big to
pass through a function), [`api/stems.js`](../api/stems.js) hands its address to Replicate,
the browser checks back every few seconds, and the finished stems are copied into Blob under
`stems/<fingerprint>/`. The uploaded song is deleted once it has been split.

### Setting it up

1. **Replicate.** Sign up at replicate.com, add billing, and make a token at
   replicate.com/account/api-tokens.
2. **Vercel Blob.** In the Vercel project, open *Storage*, create a **Blob** store with public
   access, and connect it to the project for Production and Preview. That adds
   `BLOB_READ_WRITE_TOKEN` for you.
3. **The token.** In *Settings → Environment Variables*, add `REPLICATE_API_TOKEN` for
   Production and Preview.
4. **Redeploy**, so the new variables reach the function.

The button only appears when `/api/stems` answers that both are set, so the page still works
anywhere else, just without true stems. Anyone with the link can spend Replicate credit, so
keep a small balance or a spending limit on the account. `ALLOWED_ORIGIN` keeps other websites
from calling the helper.

- `js/separate.js`: the browser side of true stems.
- `js/vendor/blob-client.js`: Vercel Blob's upload code (`@vercel/blob` 2.8.0), bundled for the browser.
