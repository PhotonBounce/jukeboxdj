/* JukeboxDJ vinyl engine — AudioWorklet turntable physics (position + velocity + inertia). */
class VinylProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this.L = null; this.R = null; this.len = 0; this.srcRate = 44100;
    this.pos = 0;            // playhead, in source frames (float)
    this.vel = 0;            // current velocity, source frames per output frame
    this.rate = 1;           // pitch fader rate
    this.playing = false;
    this.scratching = false;
    this.scratchVel = 0;     // desired rate while scratching (can be negative)
    this.loopA = -1; this.loopB = -1;
    this.tick = 0;
    this.seekId = 0;         // echoed back in pos messages so JS can drop stale echoes
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === "load") { this.L = m.l; this.R = m.r; this.len = m.len; this.srcRate = m.sr; this.pos = 0; this.vel = 0; this.playing = false; this.loopA = this.loopB = -1; }
      else if (m.t === "play") this.playing = !!m.on;
      else if (m.t === "rate") { if (Number.isFinite(m.v)) this.rate = m.v; }
      else if (m.t === "seek") { if (Number.isFinite(m.p)) this.pos = Math.max(0, Math.min(this.len ? this.len - 1 : 0, m.p)); if (m.id !== undefined) this.seekId = m.id; }
      else if (m.t === "scratch") { this.scratching = !!m.on; if (m.on) this.scratchVel = 0; }
      else if (m.t === "svel") { if (Number.isFinite(m.v)) this.scratchVel = m.v; }
      else if (m.t === "loop") { this.loopA = m.a; this.loopB = m.b; }
      else if (m.t === "unload") { this.L = this.R = null; this.len = 0; this.pos = 0; this.vel = 0; this.playing = false; }
    };
  }
  process (inputs, outputs) {
    const out = outputs[0], o0 = out[0], o1 = out[1] || out[0], n = o0.length;
    if (!this.L || !this.len) { this.postPos(); return true; }
    const ratio = this.srcRate / sampleRate;
    const base = this.playing ? this.rate * ratio : 0;
    /* inertia: platter reaches the target fast when scratched (hand on vinyl),
       slower when the motor spins it up/down (~250 ms). */
    const kMotor = 1 - Math.exp(-1 / (0.11 * sampleRate));
    const kHand  = 1 - Math.exp(-1 / (0.006 * sampleRate));
    for (let i = 0; i < n; i++) {
      const tgt = this.scratching ? this.scratchVel * ratio : base;
      this.vel += (tgt - this.vel) * (this.scratching ? kHand : kMotor);
      let p = this.pos + this.vel;
      if (this.loopB > 0 && this.vel > 0 && p >= this.loopB) p = this.loopA + (p - this.loopB);
      if (p <= 0) { p = 0; if (!this.scratching) this.vel = 0; }
      if (p >= this.len - 1) {
        p = this.len - 1;
        if (!this.scratching && this.playing) { this.playing = false; this.port.postMessage({ t: "ended" }); }
        this.vel = 0;
      }
      this.pos = p;
      const i0 = p | 0, fr = p - i0, i1 = Math.min(i0 + 1, this.len - 1);
      o0[i] = this.L[i0] + (this.L[i1] - this.L[i0]) * fr;
      o1[i] = this.R[i0] + (this.R[i1] - this.R[i0]) * fr;
    }
    this.postPos();
    return true;
  }
  postPos () {
    if (++this.tick >= 3) { // every ~9 ms at 128-frame quanta
      this.tick = 0;
      this.port.postMessage({ t: "pos", p: this.pos, v: this.vel, seekId: this.seekId });
    }
  }
}
registerProcessor("vinyl", VinylProcessor);
