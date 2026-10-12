// ------------------------------------------------
// Webcam hand input: MediaPipe Hand Landmarker.
// One hand, one mapping: the index fingertip (landmark 8)
// gives the object's x/y. Frames are processed in the
// browser and never stored or sent anywhere.
// ------------------------------------------------

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const FRAME_ASPECT = 16 / 9;
const REGION_W = 0.72; // share of the camera width that maps onto the full frame

export class HandInput {
  constructor(video) {
    this.video = video;
    this.state = 'off';        // off | starting | loading | ready | error
    this.error = '';
    this.stream = null;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.tracked = false;
    this.everTracked = false;
    this.landmarks = null;     // last detected hand, mirrored for display
    this.pos = null;           // mapped to frame units
    this.pinched = false;      // thumb tip touching index tip
    this.pinchRatio = 1;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { this.listeners.forEach(fn => fn(this)); }
  set(state, error = '') { this.state = state; this.error = error; this.emit(); }

  // The part of the mirrored camera image that maps onto the 16:9 frame.
  region() {
    const vw = this.video.videoWidth || 640, vh = this.video.videoHeight || 480;
    const w = REGION_W;
    const h = Math.min(0.95, w * (vw / vh) / FRAME_ASPECT);
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  async enable() {
    if (this.state === 'starting' || this.state === 'loading' || this.state === 'ready') return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.set('error', 'This page can’t reach a camera here. Run it locally (see the README) to use your hand. Cursor input still works.');
      return;
    }
    this.set('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      const msg = err && err.name === 'NotAllowedError'
        ? 'Camera access was blocked, either by you, the browser, or the page hosting this prototype. To use your hand, run it locally (see the README) and allow the camera. Cursor input still works.'
        : err && err.name === 'NotFoundError'
          ? 'No camera was found. Cursor input still works.'
          : `The camera could not start (${(err && err.name) || 'unknown error'}). Cursor input still works.`;
      this.stream = null;
      this.set('error', msg);
      return;
    }
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch { /* autoplay with muted video normally succeeds */ }

    this.set('loading');
    try {
      const vision = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const opts = delegate => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      // some machines hang on the GPU path instead of failing, so give it a deadline
      const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), ms))]);
      try {
        this.landmarker = await within(vision.HandLandmarker.createFromOptions(files, opts('GPU')), 15000);
      } catch (gpuErr) {
        console.warn('GPU hand tracking unavailable, using CPU', gpuErr);
        this.landmarker = await within(vision.HandLandmarker.createFromOptions(files, opts('CPU')), 30000);
      }
    } catch (err) {
      console.warn('Hand Landmarker failed to load', err);
      this.disable();
      const detail = err && err.message ? ` (${String(err.message).slice(0, 120)})` : '';
      this.set('error', `The hand-tracking model could not load${detail}. It needs network access to cdn.jsdelivr.net and storage.googleapis.com. The camera has been turned off; cursor input still works.`);
      return;
    }
    if (!this.stream) return; // turned off while loading
    this.tracked = false;
    this.set('ready');
  }

  disable() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    if (this.landmarker) { try { this.landmarker.close(); } catch { /* already closed */ } }
    this.landmarker = null;
    this.tracked = false;
    this.landmarks = null;
    this.pos = null;
    this.lastVideoTime = -1;
    if (this.state !== 'error') this.set('off');
  }

  // Run detection when the camera has a new frame. Cheap to call every animation frame.
  update(now) {
    if (this.state !== 'ready' || !this.landmarker) return;
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    let res;
    try { res = this.landmarker.detectForVideo(v, now); } catch (err) { console.warn(err); return; }
    const hand = res && res.landmarks && res.landmarks[0];
    if (!hand) { this.tracked = false; this.pinched = false; return; }
    // Mirror x so moving your hand right moves the object right.
    this.landmarks = hand.map(p => ({ x: 1 - p.x, y: p.y }));
    const tip = this.landmarks[8];
    const r = this.region();
    const clamp = v => Math.max(-0.05, Math.min(1.05, v));
    this.pos = { x: clamp((tip.x - r.x) / r.w), y: clamp((tip.y - r.y) / r.h) };
    // pinch: thumb tip (4) to index tip (8), relative to hand size (wrist 0 to middle knuckle 9).
    // Two thresholds so it doesn't flicker at the edge.
    const L = this.landmarks;
    const size = Math.hypot(L[9].x - L[0].x, L[9].y - L[0].y) || 0.1;
    this.pinchRatio = Math.hypot(L[4].x - L[8].x, L[4].y - L[8].y) / size;
    if (this.pinched && this.pinchRatio > 0.5) this.pinched = false;
    else if (!this.pinched && this.pinchRatio < 0.32) this.pinched = true;
    // while grabbing, the point between thumb and index is steadier than the fingertip
    const mx = (L[4].x + L[8].x) / 2, my = (L[4].y + L[8].y) / 2;
    this.grabPos = { x: clamp((mx - r.x) / r.w), y: clamp((my - r.y) / r.h) };
    this.tracked = true;
    this.everTracked = true;
  }
}
