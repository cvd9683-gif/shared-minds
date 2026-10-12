// ------------------------------------------------
// Guided examples. Each one runs the real tool on the
// example takes: the "designer says" lines are typed into
// the same command bar you use and go through the same
// interpreter. Nothing here fakes an outcome.
//
// The hands-free example is a guide, not a simulation:
// camera tracking can't be shown without a camera, so it
// explains the gestures and offers to turn the camera on.
// ------------------------------------------------

const ICON = {
  voice: '<svg viewBox="0 0 20 20"><rect x="7" y="2.5" width="6" height="10" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/></svg>',
  pinch: '<svg viewBox="0 0 20 20"><path d="M6 15c-1.5-1.6-2-3.6-1.4-5.6L6 5.5"/><path d="M6 5.5c.4-1.2 1.8-1.5 2.6-.6l3.2 3.6"/><path d="M14.5 6.5c-1.4-.4-2.6.3-2.7 1.5"/><circle cx="12.6" cy="8.4" r="1.1"/><path d="M8 17h5c1.6 0 2.8-1.4 2.6-3l-.6-4"/></svg>',
  move: '<svg viewBox="0 0 20 20"><path d="M3 13c3-6 6-6 8-3s4 2 6-3"/><circle cx="17" cy="7" r="1.6"/></svg>',
  open: '<svg viewBox="0 0 20 20"><path d="M7 16V6M10 15V4M13 15V5M16 14V8"/><path d="M4 11l3 5h8"/></svg>',
  edit: '<svg viewBox="0 0 20 20"><path d="M3 10h4M13 10h4"/><rect x="7" y="7" width="6" height="6" rx="1"/><path d="M8 4l-2 3M12 4l2 3"/></svg>',
};

export const SCENARIOS = {
  retime: {
    title: 'Retime a hesitation',
    steps: [
      { text: 'A designer is sketching how a notification badge arrives. They performed it twice: take 1 rushes in and hesitates, take 2 glides. Take 2 plays as the faint ghost.', do: a => { a.selectIndex(0); a.compareIndexes([1]); a.play(); }, wait: 5200 },
      { text: 'Before editing, they ask what the tool sees in take 1. It splits the take into pieces: moves, and the holds between them.', say: 'describe take 1', wait: 6000 },
      { text: 'The hesitation feels too brief to read as doubt. They say what they want, and only that pause gets longer; the moves on either side stay as performed.', say: 'make the pause longer', wait: 6500 },
      { text: 'The arrival should feel more sudden. The entrance gets shorter and starts faster.', say: 'snappier entrance', wait: 5500 },
      { text: 'The same edits can be made by hand. The row above the takes shows the pieces; drag the right edge of a piece to stretch or squeeze it, or pick In or Out to change where its time goes.', do: a => a.flashPieces(), wait: 6000 },
      { text: 'Now they ask which take reads as more confident. The answer comes from the timing (pauses and speed), with its reasons, so they can disagree.', say: 'which feels more confident?', wait: 8000 },
      { text: 'Every change is undoable, and the performance underneath is never altered.', say: 'undo', wait: 4000 },
      { text: 'They can always return to exactly what they performed.', say: 'reset', wait: 4000 },
    ],
  },
  choreo: {
    title: 'Choreograph a notification',
    steps: [
      { text: 'A notification arriving in a messaging app. Three objects: the list makes room, the toast drops in, the badge lands. Each was performed on its own while the others played.', do: a => a.play(), wait: 5200 },
      { text: 'Each object keeps its own takes. The toast has two: a quick drop and a gentle drift.', say: 'select toast', wait: 3800 },
      { text: 'They try the gentle one in the scene.', say: 'use take 2', wait: 5200 },
      { text: 'And see both at once: the quick drop in use, the gentle drift as the ghost.', say: 'compare 1 and 2', wait: 5500 },
      { text: 'The badge lands before the toast has settled. They hold it back.', say: 'start the badge 300 ms later', wait: 5500 },
      { text: 'The same by hand: drag any object’s bar in the timeline sideways to change when it starts.', do: a => a.flashLayers(), wait: 5000 },
      { text: 'The toast’s drop could arrive sooner.', say: 'snappier entrance', wait: 5200 },
      { text: 'To try a new version of any object, select it and press R. The other objects play while you perform it, so the new take is in time with them.', do: a => a.play(), wait: 7000 },
    ],
  },
  feelings: {
    title: 'One movement, three feelings',
    steps: [
      { text: 'One performance of the badge arriving. The designer wants to see it with different intentions without performing it three more times.', do: a => { a.selectIndex(0); a.compareIndexes([]); a.play(); }, wait: 4800 },
      { text: 'A calm version: the same path, retimed. The original plays as the ghost.', say: 'make a calm version', wait: 6000 },
      { text: 'Back to the original, and a nervous version of it.', do: a => a.selectIndex(0), say: 'make a nervous version', wait: 6000 },
      { text: 'And a confident one.', do: a => a.selectIndex(0), say: 'make a confident version', wait: 6000 },
      { text: 'Now all of them together. The beads on each path are 50 ms apart, so bunched beads mean slow and spread beads mean fast.', do: a => a.selectIndex(0), say: 'compare all', wait: 6500 },
      { text: 'They ask which one reads as most nervous.', say: 'which feels more nervous?', wait: 8000 },
      { text: 'From here they would keep the version that feels right and keep developing it, or perform a new take with what they learned. These versions only change timing; the path is always the one they performed.', wait: 7000 },
    ],
  },
  hands: {
    title: 'Hands-free session',
    guide: true,
    text: 'How a session works without touching the keyboard or mouse. This is a guide; it does not pretend to track a hand. To try it, run Motion Takes on your own computer, switch input to Hand, turn the camera on and tick Pinch to grab.',
    steps: [
      { icon: 'voice', text: 'Turn on the microphone and say “record”. With Pinch to grab on, the tool waits for your hand instead of counting in.' },
      { icon: 'pinch', text: 'Pinch your thumb and index finger together to grab the object. Recording starts at the pinch.' },
      { icon: 'move', text: 'Perform. Pauses and changes of speed are kept exactly as you do them.' },
      { icon: 'open', text: 'Open your fingers to let go. Recording stops, and the take replays.' },
      { icon: 'edit', text: 'Say “longer pause”, “snappier entrance”, “make a calm version” or “compare 1 and 2”. Say “undo” to step back.' },
    ],
  },
};

export class Demo {
  constructor(els, api) {
    this.els = els;
    this.api = api;
    this.running = null;
    els.exit.addEventListener('click', () => this.exit());
    els.next.addEventListener('click', () => this.skip && this.skip());
    els.pause.addEventListener('click', () => {
      this.paused = !this.paused;
      els.pause.textContent = this.paused ? 'Continue' : 'Pause';
      if (!this.paused && this.resume) this.resume();
    });
    els.tryIt.addEventListener('click', () => { this.exit(); api.tryHands(); });
  }

  async start(key) {
    if (this.running) this.exit();
    const sc = SCENARIOS[key];
    const els = this.els;
    const token = {};
    this.running = token;
    this.paused = false;
    els.pause.textContent = 'Pause';
    els.card.hidden = false;
    els.title.textContent = sc.title;
    document.getElementById('demo-eyebrow').textContent = sc.guide ? 'Example · a guide, nothing simulated' : 'Example · runs the real tool';
    els.say.hidden = true;

    if (sc.guide) {
      els.step.textContent = 'Guide';
      els.text.textContent = sc.text;
      els.guide.hidden = false;
      els.guide.innerHTML = sc.steps.map(s => `<li><span class="g-ico">${ICON[s.icon]}</span><span></span></li>`).join('');
      sc.steps.forEach((s, i) => { els.guide.children[i].lastChild.textContent = s.text; });
      els.pause.hidden = true; els.next.hidden = true; els.tryIt.hidden = false;
      // light each gesture in turn so the order reads
      let i = 0;
      const tick = () => {
        if (this.running !== token) return;
        [...els.guide.children].forEach((li, j) => li.classList.toggle('is-now', j === i));
        i = (i + 1) % sc.steps.length;
        this.timer = setTimeout(tick, 2200);
      };
      tick();
      return;
    }

    els.guide.hidden = true;
    els.pause.hidden = false; els.next.hidden = false; els.tryIt.hidden = true;
    this.api.enterSandbox(key);
    for (let i = 0; i < sc.steps.length; i++) {
      if (this.running !== token) return;
      const step = sc.steps[i];
      els.step.textContent = `Step ${i + 1} of ${sc.steps.length}`;
      els.text.textContent = step.text;
      els.say.hidden = !step.say;
      if (step.say) els.say.textContent = `“${step.say}”`;
      if (step.do) step.do(this.api);
      if (step.say) await this.api.typeAndRun(step.say, () => this.running !== token);
      await this.wait(step.wait || 4000, token);
    }
    if (this.running !== token) return;
    els.step.textContent = 'Done';
    els.text.textContent = 'That was an example on example takes. Exit to get your own takes back, or keep playing with these: everything here is the real tool.';
    els.say.hidden = true;
    els.pause.hidden = true; els.next.hidden = true;
  }

  wait(ms, token) {
    return new Promise(resolve => {
      let left = ms, t0 = performance.now(), timer, check;
      const done = () => { clearTimeout(timer); clearInterval(check); this.skip = null; this.resume = null; resolve(); };
      const arm = () => { t0 = performance.now(); timer = setTimeout(done, left); };
      this.skip = done;
      this.resume = () => { if (this.running === token && !timer) arm(); };
      check = setInterval(() => {
        if (this.running !== token) { done(); return; }
        if (this.paused && timer) { clearTimeout(timer); timer = null; left = Math.max(0, left - (performance.now() - t0)); }
      }, 100);
      arm();
    });
  }

  exit() {
    if (!this.running) return;
    this.running = null;
    clearTimeout(this.timer);
    if (this.skip) this.skip();
    this.els.card.hidden = true;
    this.api.leaveSandbox();
  }
}
