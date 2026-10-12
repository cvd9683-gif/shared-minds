// ------------------------------------------------
// Voice: the browser's own speech recognition.
// Only Chrome and Edge (and Safari, partly) provide it,
// and Chrome sends the audio to Google to transcribe.
// The page never records or stores audio itself.
// ------------------------------------------------

export class Voice {
  constructor({ onFinal, onInterim, onState, hosted = false }) {
    this.hosted = hosted;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    this.SR = SR;
    this.on = false;
    this.onFinal = onFinal;
    this.onInterim = onInterim;
    this.onState = onState;
    this.error = '';
  }

  start() {
    if (!this.supported) {
      this.error = 'This browser has no speech recognition. Use Chrome or Edge, or type commands instead.';
      this.onState(this);
      return;
    }
    if (this.on) return;
    // pages on claude.ai can't use the microphone, so say so instead of listening to nothing
    if (this.hosted) {
      this.error = 'The microphone is blocked on this claude.ai link. To use voice, run Motion Takes on your own computer in Chrome or Edge. Typing commands works the same way here.';
      this.onState(this);
      return;
    }
    const r = new this.SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    r.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        this.heard = true;
        if (res.isFinal) this.onFinal(text); else this.onInterim(text);
      }
    };
    r.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.error = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? (this.hosted
          ? 'The microphone is blocked on this claude.ai link. To use voice, run Motion Takes on your own computer in Chrome or Edge. Typing commands works the same way here.'
          : 'Microphone access was blocked. Allow it for this page in the browser’s site settings, or type commands instead.')
        : e.error === 'network'
          ? 'Speech recognition needs a network connection in this browser.'
          : `Speech recognition stopped (${e.error}).`;
      this.stop();
    };
    // Chrome ends sessions after a silence; keep listening until turned off
    r.onend = () => { if (this.on) { try { r.start(); } catch { this.stop(); } } };
    this.rec = r;
    this.on = true;
    this.error = '';
    try { r.start(); } catch (err) { this.error = 'Speech recognition could not start.'; this.on = false; }
    this.heard = false;
    clearTimeout(this.watch);
    // if nothing at all comes through, the microphone is probably muted or not allowed
    this.watch = setTimeout(() => { if (this.on && !this.heard && this.onSilent) this.onSilent(); }, 9000);
    this.onState(this);
  }

  stop() {
    this.on = false;
    if (this.rec) { try { this.rec.abort(); } catch { /* already stopped */ } }
    this.rec = null;
    this.onState(this);
  }

  toggle() { this.on ? this.stop() : this.start(); }
}
