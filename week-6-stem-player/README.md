# Stem Player

Shared Minds · Week 6. Open [`index.html`](index.html) in a browser; it needs no build step.
Serve the folder (for example `python3 -m http.server`) rather than opening the file
directly, because the scripts are modules.

A song held in your hand. After the Stem Player: a soft disc with four strips of light in a
cross, one for each layer of the song: vocals, drums, bass and everything else. Slide out
along a strip to bring that layer up, slide in to take it away. Or put your hand up to the
webcam and do the same in the air.

## How it works

- **Any song.** Drop an audio file anywhere, or use *Load a song*. The four layers are
  carved out of the mix with filters, not separated by an AI model yet. Bass is everything
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
  browser; no video leaves the computer. The point between your thumb and index finger is
  your fingertip, and pinching is touching: pinch on a strip and slide. Pinch the middle to
  play or pause. Two hands can hold two strips at once.
- **The object.** The disc tilts a little toward whatever is touching it and dips when you
  press, and a ring round the middle button fills as the song plays.

Keys: Space plays and pauses, 1–4 mute and unmute a layer.

## Files

- `js/engine.js`: the audio: four layers, their volumes and meters, carving a mix into layers.
- `js/disc.js`: the Three.js disc, its lights, and turning a screen point into a spot on it.
- `js/hands.js`: webcam hand tracking, pinch detection and smoothing.
- `js/demo.js`: the demo loop, synthesised as four parts.
- `js/main.js`: ties them together. Mouse, fingers and hands all become the same kind of touch.

## Next

True stems for any song, by sending the upload to a hosted Demucs model (on Replicate,
a few cents a song) through a small Vercel function like `api/genius.js`.
