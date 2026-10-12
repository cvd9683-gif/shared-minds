# Motion Takes

ITP midterm · Cathy Doss. A browser-based tool for early motion exploration: perform a
movement, see it replay, try another interpretation, and decide what to develop.

Run it from this folder with any static server; ES modules and the camera both need
`http://localhost` or https, so opening the file directly won't work:

```
python3 -m http.server
# open http://localhost:8000
```

## Using it

1. Move your cursor (or, in **Hand** mode, your index fingertip) over the frame.
2. Press **R** or say “record”. After a three-beat count-in you have five seconds.
3. Perform. Press **R** or **Esc**, or say “stop”, to finish early. The take replays straight away.
4. Edit it without performing again: say or type what you want (“longer pause”, “snappier
   entrance”, “make a calm version”), or drag the edges of its pieces in the timeline.
5. Compare: “compare 1 and 2”, or click a take's circle to overlay it as a ghost.

**Examples** in the toolbar has three guided walkthroughs. Two of them run the real tool on
example takes, typing each command for you; your own takes are set aside and come back when
you exit. The third explains the hands-free gestures; it doesn't simulate a camera.

| Key | Action |
| --- | --- |
| R | record / stop recording (cancels during the count-in) |
| Space | replay / pause the selected take |
| Esc | stop, back to live |
| / | type a command |
| M | microphone on / off |
| 1–9 | select a take |
| ← → | step one frame while paused (Shift: half a second) |
| Ctrl/⌘ Z | undo (Shift to redo) |

## What you can say

| | |
| --- | --- |
| Perform | “record”, “stop”, “replay”, “pause”, “go live” |
| Compare | “compare 1 and 2”, “compare all”, “solo”, “take 3”, “next take” |
| Read | “describe”, “what's different?”, “which feels more confident?” |
| Edit pieces | “longer pause”, “cut the second pause”, “snappier entrance”, “ease out the end” |
| Edit by feeling | “make it calmer”, “more nervous”, “make a confident version” |
| Whole take | “half speed”, “smoother”, “reset”, “call it shy hello”, “undo” |

Typing and speaking go through the same interpreter. These phrases are matched in the page
itself, the same way every time. When the page is hosted where Claude is available (the
shared artifact link), a phrase it doesn't know is sent to Claude together with the take's
list of pieces; Claude can only retime pieces, and its edits are labelled and undoable. Run
locally, unknown phrases get a suggestion instead.

Voice uses the browser's speech recognition (Chrome or Edge). Chrome sends the audio to
Google to transcribe; the page itself never records audio.

## How it works

- **Recording.** Each animation frame stores `[elapsed ms, x, y, tracked]` of the raw input,
  in frame units (0–1 of the 16:9 frame). Playback looks up positions by elapsed time and
  interpolates between samples, so pauses and speed changes survive at any frame rate.
- **Pieces.** Each take is split into moves and the holds between them, using its speed
  profile. A hold in the middle is a pause; at the start or end it is a wait or a rest. Each
  piece has a duration multiplier and an ease (start slow, as performed, or start fast and
  settle). The path is never changed, only when the object gets where. Feeling words map to
  sets of these changes; for example, “nervous” makes moves quicker and pauses longer.
- **“Which feels more…”** answers from timing alone (pauses mid-motion, peak speed, small
  drifts) and gives its reasons. It's a reading, not a judgement.
- **Pinch to grab** (Hand mode). The object follows only while thumb and index finger touch.
  With it on, “record” waits for the pinch, and letting go ends the take.
- **Mapping.** Input → Smoothing → Object position. Smoothing is time-based exponential
  smoothing; the slider changes the lag of live movement, and the small chart in the node
  plots input x against object x over the last two seconds.
- **Edits** (pieces, speed, smoothing) sit beside the take. Changing smoothing re-runs the
  same filter over the recorded raw input; the performed samples are never edited. Every
  edit can be undone, and **Reset** returns the take to how it was performed.
- **Timing marks.** On the stage, a bead every 50 ms shows spacing: beads bunch up where the
  motion is slow and spread out where it is fast. Holds of 220 ms or more get a ring and a duration. In the
  timeline, each lane plots speed over time on a shared scale.
- **Hand input** uses MediaPipe Hand Landmarker (`@mediapipe/tasks-vision` 0.10.14, loaded
  from jsdelivr; model from Google's storage). One hand, landmark 8 (index fingertip). The preview is
  mirrored, and the dashed box in it is the area that maps onto the frame. When the hand is lost, the
  object holds still; when it comes back, the object eases in instead of jumping. Video
  stays on the device and is never saved; takes store fingertip positions only.
- **Saving.** The project is saved to `localStorage`. **Project → Download project data** writes a
  JSON file of the takes' positions and timing. It is not a Lottie file.
- **Sound.** Count-in beats and record cues, so you can perform without looking at a button.
  An optional speed tone makes pauses audible as silence.

The two takes marked **Example** are generated by code to show a quick entrance with a
hesitation and a calmer arc. You can delete them, or add them again from the Project menu.

## Later, maybe

Not built yet: editing the path's shape, combining parts of different takes, gesture editing
of pieces (pinch-and-pull on a pause), multiple layers, scale and rotation, and exporting to
After Effects, Figma, Lottie or CSS.

Not tested yet: pinch detection and hand tracking with a real hand and camera. The model
loading and the no-hand state were tested with a simulated camera.
