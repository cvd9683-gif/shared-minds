// The object: a soft, palm-sized disc with four touch strips in a cross and a button in the
// middle, after the Stem Player. Each strip has a row of lights that shows how loud its
// layer is turned up, and pulses with what that layer is playing right now.
//
// The disc lies flat in the XZ plane and the camera looks down on it, so on screen
// "up" is −z. All touch maths happens in disc coordinates (x, z), radius 1.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const ARM_ANGLES = [90, 0, 270, 180];   // vocals up, drums right, bass down, other left
export const COLORS = ['#ffd3a1', '#ff9478', '#8eaeff', '#a4ecbf'];
const BODY = '#b89c84';
const BACKGROUND = '#15120f';

const R = 1;            // disc radius
const H = 0.13;         // height of the top face at the edge of its flat part
const FLAT = 0.8;       // the top is a gentle dome out to here, then rolls over the edge
const DOME = 0.035;
const BASE = 0.09;      // depth below the waist
const R0 = 0.27;        // each strip runs from R0 …
const R1 = 0.84;        // … to R1
const LEDS = 6;
const BUTTON = 0.15;

const dirs = ARM_ANGLES.map(a => {
  const t = THREE.MathUtils.degToRad(a);
  return { x: Math.cos(t), z: -Math.sin(t) };
});

function surfaceY(r) {
  if (r <= FLAT) return H + DOME * (1 - (r / FLAT) ** 2);
  const d = (r - FLAT) / (R - FLAT);
  return H * Math.sqrt(Math.max(0, 1 - d * d));
}

// What is under a point on the disc: the button, a strip (and the level that spot means), or nothing.
export function touchAt(x, z) {
  const r = Math.hypot(x, z);
  if (r < BUTTON + 0.04) return { kind: 'button' };
  for (let i = 0; i < 4; i++) {
    const along = x * dirs[i].x + z * dirs[i].z;
    const across = Math.abs(x * dirs[i].z - z * dirs[i].x);
    if (along > R0 - 0.1 && along < R1 + 0.12 && across < 0.1) {
      return { kind: 'arm', arm: i, level: levelOnArm(i, x, z) };
    }
  }
  return null;
}

// How far along a strip a point is, and how far off to the side of it.
export function armDistance(i, x, z) {
  return { along: x * dirs[i].x + z * dirs[i].z, across: Math.abs(x * dirs[i].z - z * dirs[i].x) };
}

// Once a strip is held, sliding anywhere keeps controlling it: only distance along it counts.
export function levelOnArm(i, x, z) {
  const along = x * dirs[i].x + z * dirs[i].z;
  return THREE.MathUtils.clamp((along - R0) / (R1 - R0), 0, 1);
}

export function createDisc(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.95;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.42;

  const key = new THREE.DirectionalLight('#fff1e2', 1.35);
  key.position.set(-2.6, 3.2, -0.8);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

  const disc = new THREE.Group();
  scene.add(disc);

  // Body: a lathe around the vertical axis, from the centre of the base round to the centre of the top.
  const profile = [];
  const edge = 24;
  profile.push(new THREE.Vector2(0, -BASE), new THREE.Vector2(FLAT, -BASE));
  for (let k = 1; k <= edge; k++) {
    const t = (k / edge) * Math.PI / 2;
    profile.push(new THREE.Vector2(FLAT + (R - FLAT) * Math.sin(t), -BASE * Math.cos(t)));
  }
  for (let k = 1; k <= edge; k++) {
    const t = (k / edge) * Math.PI / 2;
    profile.push(new THREE.Vector2(FLAT + (R - FLAT) * Math.cos(t), H * Math.sin(t)));
  }
  for (let k = 1; k <= 16; k++) {
    const r = FLAT * (1 - k / 16);
    profile.push(new THREE.Vector2(r, surfaceY(r)));
  }
  const bodyGeo = new THREE.LatheGeometry(profile, 128);
  // Map the top face straight down onto a square texture, so the grooves can be painted on.
  const pos = bodyGeo.attributes.position;
  const uv = bodyGeo.attributes.uv;
  for (let k = 0; k < pos.count; k++) {
    uv.setXY(k, (pos.getX(k) / R + 1) / 2, 1 - (pos.getZ(k) / R + 1) / 2);
  }
  const { color, bump } = paintGrooves();
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: BODY, map: color, bumpMap: bump, bumpScale: 3,
    roughness: 0.62, sheen: 0.7, sheenColor: '#fff0e4', sheenRoughness: 0.6,
    clearcoat: 0.12, clearcoatRoughness: 0.55,
  });
  disc.add(new THREE.Mesh(bodyGeo, bodyMat));

  // The button: a dome in the middle, raised enough to catch the light and read as pressable.
  const buttonGeo = new THREE.LatheGeometry([
    new THREE.Vector2(BUTTON, -0.01), new THREE.Vector2(BUTTON, 0.01),
    new THREE.Vector2(BUTTON * 0.95, 0.028), new THREE.Vector2(BUTTON * 0.82, 0.042),
    new THREE.Vector2(BUTTON * 0.55, 0.052), new THREE.Vector2(0, 0.056),
  ], 64);
  const buttonMat = new THREE.MeshPhysicalMaterial({
    color: BODY, roughness: 0.5, sheen: 0.7, sheenColor: '#fff0e4', clearcoat: 0.2,
  });
  const button = new THREE.Mesh(buttonGeo, buttonMat);
  button.position.y = surfaceY(0) - 0.006;
  disc.add(button);

  // A play or pause mark on the button, so the middle says what pressing it will do.
  const glyphMat = new THREE.MeshBasicMaterial({ color: '#fff1e2', transparent: true, depthWrite: false });
  const triangle = new THREE.Shape();
  triangle.moveTo(-0.026, 0.034); triangle.lineTo(0.036, 0); triangle.lineTo(-0.026, -0.034); triangle.closePath();
  const bars = [-0.017, 0.017].map(x => {
    const s = new THREE.Shape();
    s.moveTo(x - 0.009, 0.032); s.lineTo(x + 0.009, 0.032); s.lineTo(x + 0.009, -0.032); s.lineTo(x - 0.009, -0.032); s.closePath();
    return s;
  });
  const glyphY = button.position.y + 0.058;
  const playGlyph = new THREE.Mesh(new THREE.ShapeGeometry(triangle).rotateX(-Math.PI / 2), glyphMat);
  const pauseGlyph = new THREE.Mesh(new THREE.ShapeGeometry(bars).rotateX(-Math.PI / 2), glyphMat);
  playGlyph.position.y = pauseGlyph.position.y = glyphY;
  disc.add(playGlyph, pauseGlyph);

  // A ring of light round the button that fills clockwise as the song plays.
  const ringGeo = new THREE.RingGeometry(BUTTON + 0.016, BUTTON + 0.026, 96, 1, Math.PI / 2, Math.PI * 2);
  ringGeo.rotateX(-Math.PI / 2);
  ringGeo.scale(-1, 1, 1);
  const ringMat = new THREE.MeshBasicMaterial({ color: '#fff4e8', transparent: true, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = surfaceY(BUTTON + 0.02) + 0.0015;
  disc.add(ring);

  // Lights: LEDS per strip, sunk slightly into the surface.
  const ledGeo = new THREE.CylinderGeometry(0.022, 0.024, 0.012, 24);
  const leds = dirs.map((d, i) => Array.from({ length: LEDS }, (_, k) => {
    const r = THREE.MathUtils.lerp(R0 + 0.035, R1 - 0.035, k / (LEDS - 1));
    const mat = new THREE.MeshBasicMaterial({ color: COLORS[i] });
    const led = new THREE.Mesh(ledGeo, mat);
    led.position.set(d.x * r, surfaceY(r) - 0.0045, d.z * r);
    disc.add(led);
    return { mesh: led, mat, base: new THREE.Color(COLORS[i]), shown: 0 };
  }));

  // Where a finger or a hand is: a ring that closes as the fingers close, and a patch of light
  // when it touches. So you can see a hand being found, getting ready, and taking hold.
  const glowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
  const ringShape = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
  const cursors = [0, 1, 2].map(() => {
    const mat = new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3).rotateX(-Math.PI / 2), mat);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#fff4e8', transparent: true, depthWrite: false, opacity: 0 });
    const ring = new THREE.Mesh(ringShape, ringMat);
    mesh.renderOrder = ring.renderOrder = 2;
    disc.add(mesh, ring);
    return { mesh, mat, ring, ringMat, x: 0, z: 0, opacity: 0, ringOpacity: 0, size: 0.12 };
  });

  // A soft shadow underneath, so the disc rests on something.
  const shadowTex = radialTexture([[0, 'rgba(0,0,0,0.75)'], [0.55, 'rgba(0,0,0,0.35)'], [1, 'rgba(0,0,0,0)']]);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
  );
  shadow.position.set(0.08, -BASE - 0.02, 0.14);
  scene.add(shadow);

  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.5, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    // Keep the whole disc in view, and comfortably large, whatever the window's shape.
    const fit = w / h < 1 ? 1 / (w / h) : 1;
    // Low enough to see the disc's edge and the button standing up from it, so it reads as an object.
    const dist = 4.7 * Math.max(1, fit * 0.9);
    camera.position.set(0, dist * 0.68, dist * 0.73);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // Screen point → disc coordinates, on the plane of the top face (tilt included).
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const hit = new THREE.Vector3();
  function toDisc(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    disc.updateMatrixWorld();
    plane.setFromNormalAndCoplanarPoint(
      new THREE.Vector3(0, 1, 0).transformDirection(disc.matrixWorld),
      new THREE.Vector3(0, H + DOME / 2, 0).applyMatrix4(disc.matrixWorld),
    );
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    const local = disc.worldToLocal(hit.clone());
    return { x: local.x, z: local.z };
  }

  // Disc coordinates → screen pixels (for the HTML labels).
  const v = new THREE.Vector3();
  function toScreen(x, z, y = 0) {
    v.set(x, y, z).applyMatrix4(disc.matrixWorld).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height };
  }
  const labelAt = i => toScreen(dirs[i].x * 1.2, dirs[i].z * 1.2, -0.02);

  const lean = { x: 0, z: 0, press: 0 };
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let last = performance.now();

  // state: { levels[4], meters[4], progress 0..1, playing, loaded, focus (arm or -1),
  //          touches: [{ x, z, pressed }], lean: { x, z, pressed } | null }
  function render(state) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const ease = k => 1 - Math.exp(-dt * k);

    // Lights. Each LED fills as the level passes it; lit ones pulse with the music;
    // unlit ones keep a faint breath of their layer so you can tell it is still there.
    leds.forEach((row, i) => {
      const level = state.levels[i];
      const meter = state.loaded ? state.meters[i] : 0.5 + 0.5 * Math.sin(now / 900 + i * 1.3);
      row.forEach((led, k) => {
        const lit = THREE.MathUtils.clamp(level * LEDS - k, 0, 1);
        const pulse = state.playing ? 0.8 + 0.6 * meter : 0.9;
        const ghost = state.loaded ? 0.05 + 0.12 * meter * (state.playing ? 1 : 0) : 0.05 + 0.05 * meter;
        let want = lit * pulse * 1.25 + (1 - lit) * ghost;
        if (state.focus === i) want += 0.12;
        // While true stems are being found, a slow wave of light runs out along every strip.
        if (state.separating) want += 0.45 * Math.max(0, Math.sin(now / 420 - k * 0.7 - i * 0.9)) ** 6;
        led.shown += (want - led.shown) * ease(state.playing ? 30 : 10);
        led.mat.color.copy(led.base).multiplyScalar(led.shown);
      });
    });

    const progress = state.loaded ? state.progress : 0;
    ringGeo.setDrawRange(0, Math.floor(progress * 96) * 6);
    ringMat.opacity = state.playing ? 0.95 : 0.4;
    buttonMat.emissive.set(state.playing ? '#2a1d12' : '#000000');
    playGlyph.visible = !state.playing;
    pauseGlyph.visible = state.playing;
    // Paused, the play mark breathes, asking to be pressed; playing, the pause mark sits quietly.
    const glyphWant = !state.loaded ? 0.25
      : state.playing ? (state.buttonFocus ? 0.85 : 0.4)
      : (state.buttonFocus ? 1 : 0.6 + 0.3 * Math.sin(now / 600));
    glyphMat.opacity += (glyphWant - glyphMat.opacity) * ease(10);

    // Lean toward whatever is touching it, a little more while pressing.
    const want = state.lean || { x: 0, z: 0, pressed: false };
    lean.x += (want.x - lean.x) * ease(8);
    lean.z += (want.z - lean.z) * ease(8);
    lean.press += ((want.pressed ? 1 : 0) - lean.press) * ease(12);
    const tilt = 0.035 + 0.035 * lean.press;
    // And, left alone, it sways a little, like something resting in a hand.
    const sway = calm ? 0 : 1;
    disc.rotation.x = lean.z * tilt + sway * 0.03 * Math.sin(now / 2600);
    disc.rotation.z = -lean.x * tilt + sway * 0.025 * Math.sin(now / 3400 + 1);
    disc.position.y = -0.012 * lean.press;

    cursors.forEach((c, k) => {
      const t = state.touches[k];
      const wantOpacity = t ? (t.pressed ? 0.55 : 0.12) : 0;
      // The ring: wide and faint when a hand is just found, tighter as the pinch closes, gone into
      // a bright point on touch. A mouse gets a fainter ring, since the pointer already shows.
      const closing = t ? (t.pressed ? 1 : t.closeness ?? 0) : 0;
      const wantRing = t ? (t.pressed ? 0.95 : (t.hand ? 0.55 + 0.4 * closing : 0.3)) : 0;
      c.ringOpacity += (wantRing - c.ringOpacity) * ease(14);
      c.size += (THREE.MathUtils.lerp(0.13, 0.045, closing) - c.size) * ease(20);
      if (t) {
        if (c.opacity < 0.01) { c.x = t.x; c.z = t.z; }
        c.x += (t.x - c.x) * ease(30);
        c.z += (t.z - c.z) * ease(30);
      }
      c.opacity += (wantOpacity - c.opacity) * ease(14);
      const r = Math.hypot(c.x, c.z);
      c.mesh.position.set(c.x, (r < R ? surfaceY(r) : 0) + 0.004, c.z);
      c.mat.opacity = c.opacity;
      c.mesh.visible = c.opacity > 0.005;
      c.ring.position.copy(c.mesh.position);
      c.ring.position.y += 0.001;
      c.ring.scale.setScalar(c.size);
      c.ringMat.opacity = c.ringOpacity;
      c.ring.visible = c.ringOpacity > 0.005;
    });

    composer.render();
  }

  return { render, toDisc, labelAt, canvas: renderer.domElement };
}

// The grooves the strips sit in, painted onto the top face: a colour map (slightly darker
// in the grooves) and a bump map (lower in the grooves) so they read as soft insets.
function paintGrooves() {
  const S = 1024;
  const px = w => w * S / 2;
  const at = (x, z) => [(x / R + 1) / 2 * S, (z / R + 1) / 2 * S];
  const make = (base, groove, blur) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const g = canvas.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, S, S);
    g.strokeStyle = groove;
    g.shadowColor = groove;
    g.shadowBlur = blur;
    g.lineCap = 'round';
    g.lineWidth = px(0.1);
    for (const d of dirs) {
      g.beginPath();
      g.moveTo(...at(d.x * (R0 - 0.02), d.z * (R0 - 0.02)));
      g.lineTo(...at(d.x * (R1 + 0.02), d.z * (R1 + 0.02)));
      g.stroke();
    }
    g.lineWidth = px(0.012);
    g.beginPath();
    g.arc(...at(0, 0), px(BUTTON + 0.021), 0, Math.PI * 2);
    g.stroke();
    return canvas;
  };
  const color = new THREE.CanvasTexture(make('#ffffff', '#e2d6cb', 10));
  color.colorSpace = THREE.SRGBColorSpace;
  color.anisotropy = 4;
  const bump = new THREE.CanvasTexture(make('#ffffff', '#000000', 22));
  return { color, bump };
}

function radialTexture(stops) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [at, c] of stops) grad.addColorStop(at, c);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
