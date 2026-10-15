// Hands: the webcam watches up to two hands (MediaPipe, entirely in the browser – no video
// leaves the computer). The point between your thumb and index finger is your fingertip on
// the disc, and pinching them together is touching it. So a hand works exactly like a finger:
// pinch on a strip, then slide out along it to bring that layer up, in toward the middle to
// take it down.

import { FilesetResolver, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Pinch is measured against the size of the hand, so it works near or far from the camera.
// It closes below PINCH_ON and has to open past PINCH_OFF to let go: no flicker in between.
const PINCH_ON = 0.3;
const PINCH_OFF = 0.45;
// The middle of the camera frame maps onto the disc, so you never have to reach for the edges.
const REACH = 0.34;

// Each hand has its own tint, the same in the camera panel and on the disc.
export const HAND_TINTS = { left: '#bcd8ff', right: '#ffe0bd' };

const CONNECTIONS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

export async function startHands(video, preview, onHands) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' }, audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
    // A little more forgiving than the defaults, so a hand at an angle is not lost.
    minHandDetectionConfidence: 0.4,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });

  const g = preview.getContext('2d');
  // Each hand keeps its own identity from frame to frame by staying nearest to where it was,
  // not by MediaPipe's left/right guess, which can flip, or name both hands the same.
  let tracked = [];          // { id, x, y, fx, fz, pinched }
  let nextId = 0;
  let running = true;
  let lastTime = -1;

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    if (video.readyState < 2 || video.currentTime === lastTime) return;
    lastTime = video.currentTime;
    const now = performance.now();
    const result = landmarker.detectForVideo(video, now);

    const hands = [];
    const wrists = result.landmarks.map(points => ({ x: 1 - points[0].x, y: points[0].y }));
    const claimed = new Set();
    const matched = wrists.map(wr => {
      let best = null, bestD = 0.3;
      for (const s of tracked) {
        const dd = Math.hypot(s.x - wr.x, s.y - wr.y);
        if (!claimed.has(s) && dd < bestD) { best = s; bestD = dd; }
      }
      const s = best || { id: nextId++, fx: oneEuro(), fz: oneEuro(), pinched: false };
      claimed.add(s);
      return Object.assign(s, wr);
    });
    tracked = matched;
    // Which is your left and which your right, as you see them in the mirror: with two hands,
    // simply the one further left; with one, which half of the frame it is in.
    const sides = matched.length === 2
      ? (matched[0].x < matched[1].x ? ['left', 'right'] : ['right', 'left'])
      : matched.map(s => (s.x < 0.5 ? 'left' : 'right'));

    result.landmarks.forEach((points, k) => {
      const s = matched[k];
      const id = s.id;

      const w = video.videoWidth, h = video.videoHeight;
      const d = (a, b) => Math.hypot((points[a].x - points[b].x) * w, (points[a].y - points[b].y) * h);
      const size = d(0, 9) || 1;
      const pinch = d(4, 8) / size;
      s.pinched = s.pinched ? pinch < PINCH_OFF : pinch < PINCH_ON;

      // Mirror x so moving your hand right moves right on screen.
      const mx = 1 - (points[4].x + points[8].x) / 2;
      const my = (points[4].y + points[8].y) / 2;
      hands.push({
        id,
        side: sides[k],
        tint: HAND_TINTS[sides[k]],
        // 0 with fingers apart … 1 at the moment they count as touching.
        closeness: Math.min(1, Math.max(0, (PINCH_OFF * 2 - pinch) / (PINCH_OFF * 2 - PINCH_ON))),
        x: s.fx((mx - 0.5) / REACH, now),
        z: s.fz((my - 0.5) / REACH, now),
        pressed: s.pinched,
      });
    });

    drawPreview(g, preview, video, result.landmarks, hands);
    onHands(hands);
  }
  requestAnimationFrame(frame);

  return function stop() {
    running = false;
    landmarker.close();
    stream.getTracks().forEach(t => t.stop());
    g.clearRect(0, 0, preview.width, preview.height);
    onHands([]);
  };
}

function drawPreview(g, canvas, video, landmarks, hands) {
  const { width: W, height: H } = canvas;
  // You, faintly and mirrored, so you can see where your hand is in the frame.
  g.save();
  g.globalAlpha = 0.35;
  g.scale(-1, 1);
  g.drawImage(video, -W, 0, W, H);
  g.restore();
  landmarks.forEach((points, k) => {
    const p = i => [(1 - points[i].x) * W, points[i].y * H];
    const tint = HAND_TINTS[hands[k]?.side] || '#ffffff';
    g.strokeStyle = hands[k]?.pressed ? '#ffd3a1' : tint;
    g.globalAlpha = hands[k]?.pressed ? 0.95 : 0.7;
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [a, b] of CONNECTIONS) { g.moveTo(...p(a)); g.lineTo(...p(b)); }
    g.stroke();
    const [x4, y4] = p(4), [x8, y8] = p(8);
    g.fillStyle = hands[k]?.pressed ? '#ffd3a1' : tint;
    g.beginPath();
    g.arc((x4 + x8) / 2, (y4 + y8) / 2, hands[k]?.pressed ? 5 : 3, 0, Math.PI * 2);
    g.fill();
    // Name each hand at its wrist, so the panel and the disc can be matched up.
    const [wx, wy] = p(0);
    g.globalAlpha = 0.9;
    g.font = '600 13px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(hands[k]?.side === 'left' ? 'L' : 'R', wx, Math.min(H - 6, wy + 18));
    g.globalAlpha = 1;
  });
}

// One Euro filter: smooths heavily when the hand is still (no jitter) and lightly when it
// moves fast (no lag). Casiez, Roussel & Vogel, CHI 2012.
function oneEuro(minCutoff = 1.2, beta = 0.02, dCutoff = 1) {
  let x = null, dx = 0, t = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return (value, now) => {
    if (x === null) { x = value; t = now; return value; }
    const dt = Math.max(1e-3, (now - t) / 1000);
    t = now;
    dx += alpha(dCutoff, dt) * ((value - x) / dt - dx);
    x += alpha(minCutoff + beta * Math.abs(dx), dt) * (value - x);
    return x;
  };
}
