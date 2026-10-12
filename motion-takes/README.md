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

Motion Takes opens on a small UX scene: a notification arriving in a messaging app, with
three objects (a list, a toast and a badge). Each object has its own takes.

1. Press **Space** to play the scene.
2. Select an object (click it, or its row in the timeline) and press **R**. After a
   three-beat count-in, perform its motion with your pointer while the other objects play;
   you don't need to hold the mouse button. The object moves relative to where it starts.
3. The new take replaces the old one in the scene, and the old one plays as a ghost to compare.
   Click a take in the object's list to use it instead.
4. Stagger objects by dragging their bars in the timeline sideways, or say “start the badge
   250 ms later”.
5. Edit any take without performing again: “longer pause”, “snappier entrance”, “make a calm
   version”, or drag the edges of its pieces in the timeline.

Drag an object on the stage to place it; drag on empty stage to rehearse the selected
object without recording. **Scene** has two more starting points (one circle; three cards
fanning out) and adds circles, squares, text, cards, buttons and badges.

**Examples** in the toolbar has four guided walkthroughs. Three run the real tool on example
takes, typing each command for you; your own scene is set aside and comes back when you
exit. The fourth explains the hands-free gestures; it doesn't simulate a camera.

| Key | Action |
| --- | --- |
| R | record / stop recording (cancels during the count-in) |
| Space | replay / pause the selected take |
| Esc | stop, back to live |
| / | type a command |
| M | microphone on / off |
| 1–9 | use take 1–9 of the selected object |
| Tab | select the next object |
| ← → | step one frame while paused (Shift: half a second) |
| Ctrl/⌘ Z | undo (Shift to redo) |

## What you can say

| | |
| --- | --- |
| Objects | “select toast”, “record the badge”, “start the badge 250 ms later”, “stagger by 80 ms”, “use take 2”, “play all” |
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

**The camera and microphone don't work on the claude.ai artifact link**: pages there aren't
allowed to use them, and the tool says so when you try. Run it on your own computer
(above), or from any https host, to use your hand and voice.

## How it works

- **Scenes.** Objects (layers) each have takes; one take per object is in use, and each
  take has a start offset in the scene. Recording an object plays the others from 0, so the
  new take is in time with them. Control is relative: the object moves by however far your
  pointer or hand moves from where the take began, so you can perform from anywhere and
  nothing jumps when tracking returns.
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
of pieces (pinch-and-pull on a pause), opacity, scale and rotation, parenting objects to each
other, and exporting to After Effects, Figma, Lottie or CSS.

Not tested yet: pinch detection and hand tracking with a real hand and camera. The model
loading and the no-hand state were tested with a simulated camera.
