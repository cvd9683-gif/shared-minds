// ------------------------------------------------
// Voice: the browser's own speech recognition.
// Only Chrome and Edge (and Safari, partly) provide it,
// and Chrome sends the audio to Google to transcribe.
// The page never records or stores audio itself.
// ------------------------------------------------

export class Voice {
  constructor({ onFinal, onInterim, onState }) {
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
      this.error = 'This browser has no speech recognition. Use Chrome or Edge, or type instead.';
      this.onState(this);
      return;
    }
    if (this.on) return;
    const r = new this.SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    r.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) this.onFinal(text); else this.onInterim(text);
      }
    };
    r.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.error = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Microphone access was blocked, by you, the browser, or the page hosting this prototype. Typing works the same way.'
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
