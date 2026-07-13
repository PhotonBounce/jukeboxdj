/* JukeboxDJ — real twin-turntable DJ deck in the browser.
   Vinyl physics run in an AudioWorklet: position + velocity with inertia, so
   scratching, spinbacks and reverse are sample-accurate, not UI fakery. */
(() => {
"use strict";

/* ────────────────────────── vinyl AudioWorklet ────────────────────────── */
/* One turntable = one processor. The UI only ever sends intents (play, rate,
   scratch velocity, seek, loop); the processor integrates velocity per sample
   with motor inertia so start/stop/scratch all sound like a real platter. */

/* ────────────────────────── tiny DOM helpers ────────────────────────── */
const $  = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = (s) => { s = Math.max(0, s | 0); return ((s / 60) | 0) + ":" + String(s % 60).padStart(2, "0"); };

/* ────────────────────────── audio graph ────────────────────────── */
let ctx = null, master = null, masterAnalyser = null, recDest = null, limiter = null;
const decks = {};   // { A: Deck, B: Deck }
let crossPos = 0.5;

async function ensureAudio () {
  if (ctx) { if (ctx.state === "suspended") await ctx.resume(); return ctx; }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("vinyl-worklet.js");

  master = ctx.createGain(); master.gain.value = 0.9;
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 2; limiter.ratio.value = 12;
  limiter.attack.value = 0.002; limiter.release.value = 0.18;
  masterAnalyser = ctx.createAnalyser(); masterAnalyser.fftSize = 512;
  recDest = ctx.createMediaStreamDestination();

  master.connect(limiter);
  limiter.connect(masterAnalyser);
  masterAnalyser.connect(ctx.destination);
  masterAnalyser.connect(recDest);

  decks.A = new Deck("A");
  decks.B = new Deck("B");
  applyCrossfader();
  return ctx;
}

class Deck {
  constructor (id) {
    this.id = id;
    this.track = null;
    this.playing = false;
    this.pos = 0; this.vel = 0;       // mirrored from worklet
    this._seekId = 0;                 // monotonic seek id — see onmessage/seek()
    this.cue = 0;
    this.hotcues = [null, null, null, null];   // 4 recallable jump points
    this.rate = 1;
    this.loopBeats = 0;
    this.peaks = null;

    this.node = new AudioWorkletNode(ctx, "vinyl", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      // The worklet streams its position every ~9 ms. Right after a local seek,
      // an in-flight message still carries the PRE-seek position and would clobber
      // the value we just set — a CUE tap in that window would then capture the
      // stale spot. Only mirror the position once the worklet has acknowledged our
      // latest seek (echoed seekId matches); velocity is always safe to mirror.
      if (m.t === "pos") { if (m.seekId === this._seekId) this.pos = m.p; this.vel = m.v; }
      else if (m.t === "ended") { onDeckEnded(this.id); }
    };

    // EQ: low shelf / mid peak / high shelf, then a one-knob LP↔HP filter.
    this.eqLo = ctx.createBiquadFilter(); this.eqLo.type = "lowshelf";  this.eqLo.frequency.value = 220;
    this.eqMid = ctx.createBiquadFilter(); this.eqMid.type = "peaking"; this.eqMid.frequency.value = 1000; this.eqMid.Q.value = 0.9;
    this.eqHi = ctx.createBiquadFilter(); this.eqHi.type = "highshelf"; this.eqHi.frequency.value = 4200;
    this.filter = ctx.createBiquadFilter(); this.filter.type = "allpass"; this.filter.frequency.value = 1000;

    this.chanGain = ctx.createGain(); this.chanGain.gain.value = 1;   // channel fader
    this.xGain = ctx.createGain();                                     // crossfader leg
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 256;

    // echo FX (send)
    this.echoSend = ctx.createGain(); this.echoSend.gain.value = 0;
    this.delay = ctx.createDelay(2); this.delay.delayTime.value = 0.32;
    this.fb = ctx.createGain(); this.fb.gain.value = 0.5;
    this.echoTone = ctx.createBiquadFilter(); this.echoTone.type = "lowpass"; this.echoTone.frequency.value = 3200;

    this.node.connect(this.eqLo); this.eqLo.connect(this.eqMid); this.eqMid.connect(this.eqHi);
    this.eqHi.connect(this.filter);
    this.filter.connect(this.chanGain);
    this.filter.connect(this.echoSend);
    this.echoSend.connect(this.delay); this.delay.connect(this.echoTone);
    this.echoTone.connect(this.fb); this.fb.connect(this.delay);
    this.echoTone.connect(this.chanGain);
    this.chanGain.connect(this.xGain);
    this.xGain.connect(this.analyser);
    this.analyser.connect(master);
  }

  load (track) {
    this.track = track;
    const b = track.buffer;
    const l = b.getChannelData(0).slice();
    const r = (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice();
    this.node.port.postMessage({ t: "load", l, r, len: b.length, sr: b.sampleRate }, [l.buffer, r.buffer]);
    this.playing = false; this.pos = 0; this.vel = 0; this.cue = 0; this.loopBeats = 0;
    this.hotcues = [null, null, null, null];
    if (track.bpm) this.delay.delayTime.value = (60 / track.bpm) * 0.75;
    this.peaks = computePeaks(b, 640);
  }
  atEnd () { return this.track && this.pos >= this.track.buffer.length - 2; }
  togglePlay () {
    if (!this.track) return;
    const willPlay = !this.playing;
    // A deck that played to the very end sits at the last frame; pressing play
    // there would "play" silence forever and looked like CUE/play was disabled.
    // Restart from the cue point (or the top) so a finished track plays again.
    if (willPlay && this.atEnd()) this.seek(this.cue || 0);
    this.playing = willPlay;
    this.node.port.postMessage({ t: "play", on: this.playing });
  }
  stopAtCue () {
    this.playing = false;
    this.node.port.postMessage({ t: "play", on: false });
    this.seek(this.cue);
  }
  setHotcue (i) { if (this.track) this.hotcues[i] = this.pos; }
  jumpHotcue (i) {
    if (!this.track || this.hotcues[i] == null) return;
    this.seek(this.hotcues[i]);
    if (!this.playing) this.togglePlay();
  }
  clearHotcue (i) { this.hotcues[i] = null; }
  seek (frames) {
    this.pos = frames;
    this._seekId++;   // stamp this seek so stale worklet pos echoes are ignored
    this.node.port.postMessage({ t: "seek", p: frames, id: this._seekId });
  }
  setRate (r) { this.rate = r; this.node.port.postMessage({ t: "rate", v: r }); }
  scratch (on) { this.node.port.postMessage({ t: "scratch", on }); }
  scratchVel (v) { this.node.port.postMessage({ t: "svel", v }); }
  setLoop (beats) {
    if (!this.track) return;
    if (beats === this.loopBeats || !beats) {
      this.loopBeats = 0;
      this.node.port.postMessage({ t: "loop", a: -1, b: -1 });
      return;
    }
    this.loopBeats = beats;
    const sr = this.track.buffer.sampleRate;
    const beatSec = this.track.bpm ? 60 / this.track.bpm : 0.5;
    const a = this.pos, b = a + beats * beatSec * sr;
    this.node.port.postMessage({ t: "loop", a, b: Math.min(b, this.track.buffer.length - 1) });
  }
  effectiveBPM () { return this.track && this.track.bpm ? this.track.bpm * this.rate : 0; }
  posSec () { return this.track ? this.pos / this.track.buffer.sampleRate : 0; }
  durSec () { return this.track ? this.track.buffer.duration : 0; }
}

function applyCrossfader () {
  if (!decks.A) return;
  // equal-power
  decks.A.xGain.gain.value = Math.cos(crossPos * Math.PI / 2);
  decks.B.xGain.gain.value = Math.sin(crossPos * Math.PI / 2);
}

/* ── control surface for the AI Auto-Mixer (and QA) ──
   Everything the auto-mixer drives goes through here so the UI sliders stay in
   sync with what the AI is doing. crossPos is 0 = full A, 1 = full B. */
function setCrossfader (v, reflect) {
  crossPos = clamp(v, 0, 1);
  applyCrossfader();
  if (reflect !== false) { const el = $("#crossfader"); if (el) el.value = String(Math.round(crossPos * 100)); }
}
function setMasterGain (v) {
  if (master) master.gain.value = Math.pow(clamp(v, 0, 1), 1.3) * 1.2;
  const el = $("#master-gain"); if (el) el.value = String(Math.round(clamp(v, 0, 1) * 100));
}
function reflectPitch (id) {
  const el = deckEls(id);
  el.pitch.value = String(Math.round((decks[id].rate - 1) * 1000));
  updatePitchLabel(id);
}
/* Beat grid: seconds per beat, and the phase (0..1) of the playhead within the
   current beat — used to phase-align the two decks before an AI transition. */
function beatInfo (id) {
  const d = decks[id];
  if (!d || !d.track || !d.track.bpm) return null;
  const spb = 60 / d.effectiveBPM();          // seconds per beat at the current pitch
  const sr = d.track.buffer.sampleRate;
  const beatFrames = spb * sr;
  const phase = (d.pos % beatFrames) / beatFrames;
  return { spb, beatFrames, phase, sr };
}

function computePeaks (buffer, buckets) {
  const d = buffer.getChannelData(0), step = Math.max(1, (d.length / buckets) | 0), out = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let m = 0, s = i * step, e = Math.min(d.length, s + step);
    for (let j = s; j < e; j += 4) { const v = Math.abs(d[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}

/* ────────────────────────── procedural demo tracks ──────────────────────────
   The jukebox ships with real, danceable loops "pressed" locally with an
   OfflineAudioContext — zero downloads, always in sync with the BPM readout. */

const TRACK_DEFS = [
  { id: "neon",    name: "Neon Nights",     style: "House",     bpm: 124, color: "#7DD3FC", bars: 16 },
  { id: "bounce",  name: "Bounce Theory",   style: "Boom Bap",  bpm: 92,  color: "#F5C842", bars: 12 },
  { id: "trap",    name: "Photon Trap",     style: "Trap",      bpm: 140, color: "#FB7185", bars: 16 },
  { id: "circuit", name: "Circuit Breaker", style: "Techno",    bpm: 128, color: "#A78BFA", bars: 16 },
  { id: "funk",    name: "Funk Reactor",    style: "Breakbeat", bpm: 110, color: "#5EEAD4", bars: 12 },
  { id: "drive",   name: "Midnight Drive",  style: "Synthwave", bpm: 100, color: "#C4B5FD", bars: 12 }
];

const library = []; // { id, name, style, bpm, color, buffer, custom }

function noiseBuffer (octx, sec) {
  const b = octx.createBuffer(1, (sec * octx.sampleRate) | 0, octx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/* tiny synth voices */
function kick (o, t, opts) {
  opts = opts || {};
  const osc = o.createOscillator(), g = o.createGain();
  osc.frequency.setValueAtTime(opts.punch || 150, t);
  osc.frequency.exponentialRampToValueAtTime(opts.tail || 48, t + 0.11);
  g.gain.setValueAtTime(opts.vol || 1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + (opts.len || 0.34));
  osc.connect(g); g.connect(o._bus);
  osc.start(t); osc.stop(t + (opts.len || 0.34) + 0.02);
}
function snare (o, t, noise, opts) {
  opts = opts || {};
  const n = o.createBufferSource(); n.buffer = noise;
  const f = o.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = opts.tone || 1900; f.Q.value = 0.9;
  const g = o.createGain();
  g.gain.setValueAtTime(opts.vol || 0.7, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + (opts.len || 0.19));
  n.connect(f).connect(g); g.connect(o._bus);
  n.start(t, Math.random() * 0.4); n.stop(t + 0.3);
  const b = o.createOscillator(), bg = o.createGain();
  b.frequency.setValueAtTime(opts.body || 190, t);
  bg.gain.setValueAtTime((opts.vol || 0.7) * 0.5, t);
  bg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  b.connect(bg); bg.connect(o._bus);
  b.start(t); b.stop(t + 0.12);
}
function hat (o, t, noise, opts) {
  opts = opts || {};
  const n = o.createBufferSource(); n.buffer = noise;
  const f = o.createBiquadFilter(); f.type = "highpass"; f.frequency.value = opts.open ? 6500 : 8000;
  const g = o.createGain();
  g.gain.setValueAtTime(opts.vol || 0.28, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + (opts.open ? 0.32 : 0.05));
  n.connect(f).connect(g); g.connect(o._bus);
  n.start(t, Math.random() * 0.5); n.stop(t + 0.4);
}
function clap (o, t, noise, vol) {
  for (let i = 0; i < 3; i++) hatlikeClap(o, t + i * 0.011, noise, (vol || 0.5) * (1 - i * 0.22));
}
function hatlikeClap (o, t, noise, vol) {
  const n = o.createBufferSource(); n.buffer = noise;
  const f = o.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1400; f.Q.value = 1.4;
  const g = o.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  n.connect(f).connect(g); g.connect(o._bus);
  n.start(t, Math.random() * 0.3); n.stop(t + 0.2);
}
function bassNote (o, t, freq, len, opts) {
  opts = opts || {};
  const osc = o.createOscillator(); osc.type = opts.wave || "sawtooth"; osc.frequency.value = freq;
  const f = o.createBiquadFilter(); f.type = "lowpass"; f.Q.value = opts.q || 6;
  f.frequency.setValueAtTime(opts.fTop || 900, t);
  f.frequency.exponentialRampToValueAtTime(opts.fEnd || 180, t + len);
  const g = o.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(opts.vol || 0.34, t + 0.008);
  g.gain.setValueAtTime(opts.vol || 0.34, t + len * 0.7);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  osc.connect(f).connect(g); g.connect(o._bus);
  osc.start(t); osc.stop(t + len + 0.02);
}
function sub808 (o, t, freq, len, vol) {
  const osc = o.createOscillator(); osc.type = "sine";
  osc.frequency.setValueAtTime(freq * 2.2, t);
  osc.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
  const g = o.createGain();
  g.gain.setValueAtTime(vol || 0.55, t);
  g.gain.setValueAtTime(vol || 0.55, t + len * 0.6);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  const sh = o.createWaveShaper(); const c = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const x = i / 128 - 1; c[i] = Math.tanh(1.6 * x); }
  sh.curve = c;
  osc.connect(sh).connect(g); g.connect(o._bus);
  osc.start(t); osc.stop(t + len + 0.02);
}
function stab (o, t, freqs, len, opts) {
  opts = opts || {};
  freqs.forEach((fq) => {
    [0.996, 1.004].forEach((det) => {
      const osc = o.createOscillator(); osc.type = opts.wave || "sawtooth"; osc.frequency.value = fq * det;
      const f = o.createBiquadFilter(); f.type = "lowpass";
      f.frequency.setValueAtTime(opts.bright || 2600, t);
      f.frequency.exponentialRampToValueAtTime(500, t + len);
      const g = o.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime((opts.vol || 0.09), t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      osc.connect(f).connect(g); g.connect(o._bus);
      osc.start(t); osc.stop(t + len + 0.02);
    });
  });
}
function lead (o, t, freq, len, opts) {
  opts = opts || {};
  const osc = o.createOscillator(); osc.type = opts.wave || "square"; osc.frequency.value = freq;
  const f = o.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = opts.bright || 3400;
  const g = o.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(opts.vol || 0.055, t + 0.012);
  g.gain.setValueAtTime(opts.vol || 0.055, t + len * 0.8);
  g.gain.linearRampToValueAtTime(0, t + len);
  osc.connect(f).connect(g); g.connect(o._bus);
  osc.start(t); osc.stop(t + len + 0.02);
}

const N = { C2:65.41,D2:73.42,Eb2:77.78,E2:82.41,F2:87.31,G2:98,Ab2:103.83,A2:110,Bb2:116.54,B2:123.47,
  C3:130.81,D3:146.83,Eb3:155.56,E3:164.81,F3:174.61,G3:196,Ab3:207.65,A3:220,Bb3:233.08,
  C4:261.63,D4:293.66,Eb4:311.13,E4:329.63,F4:349.23,G4:392,Ab4:415.3,A4:440,Bb4:466.16,
  C5:523.25,D5:587.33,Eb5:622.25,E5:659.26,G5:783.99 };

async function renderTrack (def) {
  const bpm = def.bpm, spb = 60 / bpm, barSec = spb * 4;
  const sr = 44100, dur = def.bars * barSec + 0.5;
  const o = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const bus = o.createGain(); bus.gain.value = 0.9;
  const comp = o.createDynamicsCompressor();
  comp.threshold.value = -10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.16;
  bus.connect(comp).connect(o.destination);
  o._bus = bus;
  const noise = noiseBuffer(o, 1.5);
  const bt = (bar, beat) => bar * barSec + beat * spb;

  for (let bar = 0; bar < def.bars; bar++) {
    const t0 = bar * barSec;
    switch (def.id) {
      case "neon": { // four-on-the-floor house
        for (let b = 0; b < 4; b++) kick(o, bt(bar, b), { punch: 160, tail: 50, vol: 0.95 });
        for (let b = 0; b < 4; b++) hat(o, bt(bar, b + 0.5), noise, { open: true, vol: 0.2 });
        for (let s = 0; s < 16; s++) if (s % 2 === 0) hat(o, t0 + s * spb / 4, noise, { vol: 0.12 });
        clap(o, bt(bar, 1), noise, 0.5); clap(o, bt(bar, 3), noise, 0.5);
        const roots = [N.A2, N.A2, N.C3, N.G2][bar % 4];
        [0, 0.75, 1.5, 2.5, 3.25].forEach((b, i) => bassNote(o, bt(bar, b), i % 2 ? roots * 2 : roots, 0.22, { fTop: 750, vol: 0.3 }));
        if (bar >= 2) {
          const ch = [[N.A3, N.C4, N.E4], [N.A3, N.C4, N.E4], [N.C4, N.E4, N.G4], [N.G3, N.B2 * 2, N.D4]][bar % 4];
          stab(o, bt(bar, 0.5), ch, 0.28, { vol: 0.07 }); stab(o, bt(bar, 2.5), ch, 0.28, { vol: 0.06 });
        }
        break;
      }
      case "bounce": { // boom bap
        kick(o, bt(bar, 0), { punch: 130, tail: 45, vol: 1 });
        kick(o, bt(bar, 2.5), { punch: 130, tail: 45, vol: 0.85 });
        if (bar % 2 === 1) kick(o, bt(bar, 3.75), { vol: 0.6, punch: 120, tail: 44 });
        snare(o, bt(bar, 1), noise, { vol: 0.8, tone: 1700 }); snare(o, bt(bar, 3), noise, { vol: 0.8, tone: 1700 });
        for (let s = 0; s < 8; s++) hat(o, t0 + s * spb / 2, noise, { vol: s % 2 ? 0.14 : 0.2 });
        const seq = [[N.F2, 0, 1.2], [N.F2, 2.5, 0.6], [N.Ab2, 3.3, 0.6]];
        seq.forEach(([f, b, l]) => bassNote(o, bt(bar, b), f, l * spb, { wave: "triangle", fTop: 420, fEnd: 140, vol: 0.42, q: 1 }));
        if (bar % 4 < 2) stab(o, bt(bar, 0), [N.F3, N.Ab3, N.C4], 0.5, { wave: "triangle", vol: 0.12, bright: 1600 });
        else stab(o, bt(bar, 0), [N.Eb3, N.G3, N.Bb3], 0.5, { wave: "triangle", vol: 0.12, bright: 1600 });
        break;
      }
      case "trap": { // half-time trap
        kick(o, bt(bar, 0), { punch: 140, tail: 42, vol: 1 });
        kick(o, bt(bar, 1.75), { punch: 140, tail: 42, vol: 0.8 });
        if (bar % 2) kick(o, bt(bar, 3.5), { vol: 0.7, punch: 135, tail: 42 });
        snare(o, bt(bar, 2), noise, { vol: 0.85, tone: 2100 });
        const rolls = [4, 4, 4, 4, 4, 4, 8, 8, 4, 4, 3, 3, 3, 16, 16, 16][bar % 16] || 4;
        for (let s = 0; s < rolls * 4; s++) hat(o, t0 + s * barSec / (rolls * 4), noise, { vol: 0.16 });
        hat(o, bt(bar, 3.5), noise, { open: true, vol: 0.18 });
        const root = [N.C2, N.C2, N.Eb2, N.F2][bar % 4];
        sub808(o, bt(bar, 0), root, spb * 1.6, 0.6);
        sub808(o, bt(bar, 2.5), root * (bar % 2 ? 1.189 : 1), spb * 1.2, 0.5);
        if (bar >= 4) [0, 1, 2, 3].forEach((b) => lead(o, bt(bar, b + 0.5), [N.C5, N.Eb5, N.G5, N.Eb5][b] / 2, 0.16, { wave: "sine", vol: 0.05 }));
        break;
      }
      case "circuit": { // techno + acid line
        for (let b = 0; b < 4; b++) kick(o, bt(bar, b), { punch: 170, tail: 52, vol: 1 });
        for (let b = 0; b < 4; b++) hat(o, bt(bar, b + 0.5), noise, { open: b === 3, vol: 0.22 });
        if (bar % 2) clap(o, bt(bar, 1), noise, 0.35);
        snare(o, bt(bar, 3.75), noise, { vol: 0.2, tone: 2400, len: 0.08 });
        const steps = [0, 3, 7, 0, 10, 7, 3, 12, 0, 3, 7, 15, 10, 7, 3, 0];
        for (let s = 0; s < 16; s++) {
          const f = N.A2 * Math.pow(2, steps[(s + bar * 3) % 16] / 12);
          bassNote(o, t0 + s * spb / 4, f, spb / 4 * 0.9, { fTop: 500 + 2200 * Math.abs(Math.sin((bar * 16 + s) * 0.22)), fEnd: 220, vol: 0.2, q: 11 });
        }
        break;
      }
      case "funk": { // breakbeat
        kick(o, bt(bar, 0), { punch: 145, tail: 48, vol: 0.95 });
        kick(o, bt(bar, 1.5), { vol: 0.7, punch: 140, tail: 46 });
        kick(o, bt(bar, 2.25), { vol: 0.8, punch: 140, tail: 46 });
        snare(o, bt(bar, 1), noise, { vol: 0.75 }); snare(o, bt(bar, 3), noise, { vol: 0.8 });
        snare(o, bt(bar, 3.5), noise, { vol: 0.3, len: 0.1 });
        for (let s = 0; s < 8; s++) hat(o, t0 + s * spb / 2, noise, { vol: s % 2 ? 0.13 : 0.2, open: s === 7 });
        const line = [[N.E2, 0, 0.5], [N.E2, 0.5, 0.25], [N.G2, 1, 0.5], [N.A2, 1.75, 0.5], [N.E2, 2.5, 0.4], [N.D3, 3, 0.4], [N.B2, 3.5, 0.4]];
        line.forEach(([f, b, l]) => bassNote(o, bt(bar, b), f, l * spb, { fTop: 900, fEnd: 260, vol: 0.3, q: 3 }));
        if (bar % 2) stab(o, bt(bar, 2.75), [N.E3, N.G3, N.B2 * 2, N.D4], 0.22, { vol: 0.08, bright: 3200 });
        break;
      }
      case "drive": { // synthwave
        for (let b = 0; b < 4; b++) kick(o, bt(bar, b), { punch: 150, tail: 46, vol: 0.9 });
        snare(o, bt(bar, 1), noise, { vol: 0.55, tone: 1500, len: 0.26 }); snare(o, bt(bar, 3), noise, { vol: 0.55, tone: 1500, len: 0.26 });
        for (let s = 0; s < 16; s++) hat(o, t0 + s * spb / 4, noise, { vol: s % 4 === 2 ? 0.16 : 0.07 });
        const root = [N.A2, N.F2, N.C3, N.G2][bar % 4];
        for (let s = 0; s < 8; s++) bassNote(o, t0 + s * spb / 2, root, spb / 2 * 0.85, { wave: "square", fTop: 520, fEnd: 300, vol: 0.2, q: 1.5 });
        const pad = [[N.A3, N.C4, N.E4], [N.F3, N.A3, N.C4], [N.C4, N.E4, N.G4], [N.G3, N.B2 * 2, N.D4]][bar % 4];
        stab(o, t0, pad, barSec * 0.96, { vol: 0.045, bright: 1500 });
        const arp = [0, 1, 2, 1, 0, 2, 1, 2];
        for (let s = 0; s < 8; s++) lead(o, t0 + s * spb / 2, pad[arp[s]] * 2, spb / 2 * 0.7, { wave: "triangle", vol: 0.05 });
        break;
      }
    }
  }
  const buffer = await o.startRendering();
  return { id: def.id, name: def.name, style: def.style, bpm, color: def.color, buffer, custom: false };
}

/* rough BPM estimate for user-loaded files (energy-flux autocorrelation) */
function estimateBPM (buffer) {
  try {
    const sr = buffer.sampleRate, d = buffer.getChannelData(0);
    const hop = 512, frames = Math.min(((d.length / hop) | 0), (sr * 60 / hop) | 0);
    const env = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0, off = i * hop;
      for (let j = 0; j < hop; j += 4) s += Math.abs(d[off + j]);
      env[i] = s;
    }
    for (let i = frames - 1; i > 0; i--) env[i] = Math.max(0, env[i] - env[i - 1]); // onset flux
    const fps = sr / hop, lo = Math.round(fps * 60 / 180), hi = Math.round(fps * 60 / 70);
    let best = 0, bestLag = 0;
    for (let lag = lo; lag <= hi; lag++) {
      let s = 0;
      for (let i = 0; i < frames - lag; i++) s += env[i] * env[i + lag];
      if (s > best) { best = s; bestLag = lag; }
    }
    if (!bestLag) return 0;
    let bpm = 60 * fps / bestLag;
    while (bpm < 84) bpm *= 2;
    while (bpm > 168) bpm /= 2;
    return Math.round(bpm);
  } catch (e) { return 0; }
}

/* ────────────────────────── toasts ────────────────────────── */
let toastEl = null, toastTimer = 0;
window.JBToast = (msg) => {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3600);
};

/* ────────────────────────── recording ────────────────────────── */
let recorder = null, recChunks = [], recStart = 0;
function toggleRecord () {
  if (recorder) {
    recorder.stop();
    return;
  }
  recChunks = [];
  const bps = window.JBPro ? window.JBPro.recBitsPerSecond() : 128000;
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: bps } : { audioBitsPerSecond: bps });
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
    recorder = null;
    ui.recStopped(blob);
  };
  recorder.start(250);
  recStart = performance.now();
  ui.recStarted();
}

/* ────────────────────────── scratch FX pads ──────────────────────────
   Ten synthesized vinyl-scratch one-shots played straight to the master bus
   (so they're heard AND captured in a recording). Each is a tonal "record
   groove" (bandpassed saw) whose pitch is swept back-and-forth like a hand on
   the platter, layered with vinyl surface noise — no samples, all Web Audio. */
const SCRATCH_FX = [
  { id: "baby",      name: "Baby",      dur: 0.34, base: 240, curve: [1, 1.7, 0.5, 1.4, 1], q: 3 },
  { id: "chirp",     name: "Chirp",     dur: 0.20, base: 320, curve: [0.5, 2.2, 0.6], q: 5 },
  { id: "transform", name: "Transform", dur: 0.5,  base: 260, curve: [1, 1, 1, 1, 1, 1], q: 3, gate: 8 },
  { id: "drop",      name: "Drop",      dur: 0.5,  base: 420, curve: [1.8, 1.2, 0.5, 0.22], q: 2 },
  { id: "spinback",  name: "Spinback",  dur: 0.6,  base: 300, curve: [1.6, 1.1, 0.6, 0.28, 0.1], q: 2, noise: 0.5 },
  { id: "rewind",    name: "Rewind",    dur: 0.55, base: 180, curve: [0.2, 0.6, 1.3, 2.4], q: 2.5, noise: 0.5 },
  { id: "brake",     name: "Brake",     dur: 0.7,  base: 340, curve: [1, 0.85, 0.6, 0.35, 0.12, 0.03], q: 2 },
  { id: "stab",      name: "Stab",      dur: 0.28, base: 200, curve: [1, 1.01, 1], q: 1.4, chord: true },
  { id: "zip",       name: "Zip",       dur: 0.16, base: 260, curve: [0.6, 3.2], q: 6 },
  { id: "siren",     name: "Siren",     dur: 0.6,  base: 300, curve: [1, 2, 1, 2, 1, 2, 1], q: 4 }
];
let scratchNoiseBuf = null;
function scratchNoise () {
  if (scratchNoiseBuf) return scratchNoiseBuf;
  const n = (ctx.sampleRate * 1.2) | 0, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
  scratchNoiseBuf = b;
  return b;
}
async function playScratch (id) {
  await ensureAudio();
  const fx = SCRATCH_FX.find((f) => f.id === id);
  if (!fx || !master) return;
  const t = ctx.currentTime, out = ctx.createGain();
  out.gain.value = 0.95; out.connect(master);
  // pitch curve → frequency curve
  const freqs = new Float32Array(fx.curve.length);
  for (let i = 0; i < fx.curve.length; i++) freqs[i] = fx.base * fx.curve[i];

  const mk = (type, detune) => {
    const o = ctx.createOscillator(); o.type = type; if (detune) o.detune.value = detune;
    o.frequency.setValueCurveAtTime(freqs, t, fx.dur);
    return o;
  };
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = fx.q;
  const g = ctx.createGain();
  // amplitude envelope (gated for "transform")
  if (fx.gate) {
    const steps = fx.gate, seg = fx.dur / steps;
    for (let i = 0; i < steps; i++) { g.gain.setValueAtTime(i % 2 ? 0.0005 : 0.9, t + i * seg); }
  } else {
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + fx.dur);
  }
  const osc = mk("sawtooth", 0);
  osc.connect(bp); bp.connect(g); g.connect(out);
  osc.start(t); osc.stop(t + fx.dur + 0.02);
  if (fx.chord) { [4, 7].forEach((st) => { const o2 = mk("sawtooth", st * 100); o2.connect(bp); o2.start(t); o2.stop(t + fx.dur + 0.02); }); }

  // vinyl surface noise layer
  const nAmt = fx.noise != null ? fx.noise : 0.28;
  const ns = ctx.createBufferSource(); ns.buffer = scratchNoise();
  ns.playbackRate.setValueCurveAtTime(freqs.map ? Float32Array.from(fx.curve) : new Float32Array(fx.curve), t, fx.dur);
  const nf = ctx.createBiquadFilter(); nf.type = "bandpass"; nf.frequency.value = 1800; nf.Q.value = 1.2;
  const ng = ctx.createGain(); ng.gain.setValueAtTime(nAmt, t); ng.gain.exponentialRampToValueAtTime(0.0004, t + fx.dur);
  ns.connect(nf); nf.connect(ng); ng.connect(out);
  ns.start(t, 0, fx.dur + 0.05);
  if (window.JBToast && false) {} // (no toast — keep it snappy)
}

/* Musical notes that swim inside the color-changing "water" of a panel. */
function fillNotes (host, count) {
  if (!host) return;
  const glyphs = ["♪", "♫", "♬", "♩", "♭"];
  for (let i = 0; i < count; i++) {
    const n = document.createElement("span");
    n.className = "note";
    n.textContent = glyphs[i % glyphs.length];
    n.style.left = (4 + Math.random() * 90) + "%";
    n.style.fontSize = (12 + Math.random() * 15) + "px";
    n.style.animationDuration = (5 + Math.random() * 5).toFixed(2) + "s";
    n.style.animationDelay = (-Math.random() * 8).toFixed(2) + "s";
    host.appendChild(n);
  }
}
function setupMixNotes () {
  fillNotes($(".mix-notes"), 11);
  // the same swimming notes now fill each turntable deck's water too
  document.querySelectorAll(".deck-notes").forEach((h) => fillNotes(h, 7));
}

/* beat state — driven by the currently-playing deck's beat grid, published on
   :root so the decks, buttons and every panel pulse to the beat. */
let beatHue = 200, beatPulse = 0, lastBeatPhase = 0;
function driveMixerBeat () {
  const pd = decks.A && decks.A.playing ? "A" : (decks.B && decks.B.playing ? "B" : null);
  if (pd) {
    const bi = beatInfo(pd);
    if (bi) {
      if (bi.phase < lastBeatPhase - 0.3) { beatHue = (beatHue + 26) % 360; beatPulse = 1; } // new beat
      lastBeatPhase = bi.phase;
    }
  }
  beatPulse *= 0.90;
  const root = document.documentElement;
  root.style.setProperty("--beat-hue", beatHue.toFixed(1));
  root.style.setProperty("--beat-pulse", beatPulse.toFixed(3));
  document.body.classList.toggle("beating", !!pd);
}

/* ─────────── auto-restart · random load · FULL AUTO DJ · share ─────────── */
let lastMixBlob = null;   // most recent recording, kept for the Share button

function randomTrack (exclude, harmonicWith) {
  let pool = library.filter((t) => t && t.buffer && t !== exclude);
  if (!pool.length) return null;
  // harmonic mixing: when we know the live track's key, prefer records that are
  // in a compatible key (uses only already-computed keys so it never blocks).
  if (harmonicWith && harmonicWith.key) {
    const compat = pool.filter((t) => t.key && keysCompatible(harmonicWith.key.camelot, t.key.camelot));
    if (compat.length) pool = compat;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}
async function loadRandomToDeck (id, harmonicWith) {
  const other = decks[id === "A" ? "B" : "A"].track;
  const t = randomTrack(other, harmonicWith);
  if (t) await loadToDeck(id, t);
  return t;
}

/* When a record reaches the end it restarts (regular tracks loop). In FULL AUTO
   "song end" mode the end of the live track instead triggers the next blend. */
function onDeckEnded (id) {
  const d = decks[id];
  if (playlist.on && id === playlist.live && !playlist.mixing) { d.playing = false; ui.deckPlayChanged(id); playlistAdvance(); return; }
  if (fullAuto.on && fullAuto.intervalSec === 0) { d.playing = false; ui.deckPlayChanged(id); fullAutoTick(); return; }
  d.seek(0);
  d.playing = true;
  d.node.port.postMessage({ t: "play", on: true });
  ui.deckPlayChanged(id);
}

/* FULL AUTO — hands-free AI DJ: keeps bringing in fresh records and blending. */
const fullAuto = { on: false, intervalSec: 30, timer: null };
async function fullAutoTick () {
  if (!fullAuto.on) return;
  if (window.JBAutoMix && window.JBAutoMix.isRunning()) return;   // never overlap a running mix
  const inc = crossPos < 0.5 ? "B" : "A";                         // bring the new record in on the quiet deck
  const live = inc === "A" ? "B" : "A";
  await loadRandomToDeck(inc, decks[live].track);                 // prefer a harmonic (in-key) match
  if (decks[live].track && !decks[live].playing) { decks[live].togglePlay(); ui.deckPlayChanged(live); }
  if (window.JBAutoMix) await window.JBAutoMix.play(window.JBAutoMix.smartPick());
}
async function setFullAuto (on) {
  fullAuto.on = !!on;
  const btn = $("#btn-full-auto");
  if (btn) {
    btn.setAttribute("aria-pressed", fullAuto.on ? "true" : "false");
    btn.classList.toggle("on", fullAuto.on);
    const s = $(".fa-state", btn); if (s) s.textContent = fullAuto.on ? "ON" : "OFF";
  }
  document.body.classList.toggle("full-auto", fullAuto.on);
  clearInterval(fullAuto.timer); fullAuto.timer = null;
  if (!fullAuto.on) return;
  await ensureAudio();
  if (!decks.A.track) await loadRandomToDeck("A");
  if (!decks.B.track) await loadRandomToDeck("B");
  if (!decks.A.playing && !decks.B.playing) { decks.A.togglePlay(); ui.deckPlayChanged("A"); setCrossfader(0); }
  if (fullAuto.intervalSec > 0) fullAuto.timer = setInterval(fullAutoTick, fullAuto.intervalSec * 1000);
  // intervalSec === 0 ("song end") is driven by onDeckEnded
}
function setupFullAuto () {
  const btn = $("#btn-full-auto");
  if (btn) btn.addEventListener("click", () => setFullAuto(!fullAuto.on));
  const ints = Array.from(document.querySelectorAll(".fa-int"));
  const mark = () => ints.forEach((b) => b.classList.toggle("on", Number(b.dataset.sec) === fullAuto.intervalSec));
  ints.forEach((b) => b.addEventListener("click", () => {
    fullAuto.intervalSec = Number(b.dataset.sec);
    mark();
    if (fullAuto.on) setFullAuto(true);   // re-arm the timer at the new cadence
  }));
  mark();
}
/* ══════════════════════════ PLAYLIST AUTO-MIX ══════════════════════════════
   The SECOND auto-mix mode. Where "Song Auto-Mix" blends the two records you've
   loaded, Playlist Auto-Mix DJs your WHOLE library as one non-stop set: it plays
   the live deck, silently pre-cues the next record on the idle deck (rate-matched
   to the live tempo so the mix time & pitch are already measured), and when the
   live track nears its end it beat-matches and crossfades in — then frees the old
   deck and pre-cues the following record. It just keeps going. */
const playlist = { on: false, queue: [], idx: 0, live: "A", cue: "B", timer: null, mixing: false, windowSec: 16 };

function buildPlaylistQueue () {
  const pool = library.filter((t) => t && t.buffer);
  // light shuffle for variety without Math.random reliance quirks
  const q = pool.slice();
  for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = q[i]; q[i] = q[j]; q[j] = t; }
  return q;
}
function playlistNext () {
  if (!playlist.queue.length) return null;
  playlist.idx = (playlist.idx + 1) % playlist.queue.length;
  return playlist.queue[playlist.idx];
}
/* Silently ready a record on the idle deck: rate-match to the live tempo and park
   it at the start (in headphones, so to speak — inaudible until we mix). */
function preCue (cueId, liveId) {
  const dCue = decks[cueId], dLive = decks[liveId];
  if (!dCue || !dCue.track) return;
  if (dLive && dLive.track && dLive.track.bpm && dCue.track.bpm) {
    const r = clamp(dLive.effectiveBPM() / dCue.track.bpm, 0.7, 1.4);
    dCue.setRate(r); reflectPitch(cueId);
  }
  dCue.seek(0);
}
function updatePlaylistStatus (rem) {
  const el = $("#automix-status"); if (!el) return;
  const lt = decks[playlist.live].track, ct = decks[playlist.cue].track;
  el.textContent = "📻 Playlist Auto-Mix — ▶ " + (lt ? lt.name : "—") +
    (ct ? "  ·  next: " + ct.name : "") +
    (playlist.mixing ? "  · mixing…" : (rem != null ? "  · mix in " + Math.max(0, Math.round(rem - playlist.windowSec)) + "s" : ""));
}
async function playlistStart () {
  await ensureAudio();
  try { setFullAuto(false); } catch (e) {}
  playlist.queue = buildPlaylistQueue();
  if (playlist.queue.length < 2) { if (window.JBToast) window.JBToast("Add a couple more records for a playlist set."); return; }
  playlist.on = true; playlist.mixing = false; playlist.idx = 0;
  playlist.live = "A"; playlist.cue = "B";
  document.body.classList.add("playlist-auto");
  const btn = $("#btn-playlist-auto");
  if (btn) { btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); const s = $(".pa-state", btn); if (s) s.textContent = "ON"; }
  await loadToDeck("A", playlist.queue[0]);
  await loadToDeck("B", playlist.queue[1]);
  playlist.idx = 1;
  setCrossfader(0);
  if (!decks.A.playing) { decks.A.togglePlay(); ui.deckPlayChanged("A"); }
  preCue("B", "A");
  updatePlaylistStatus(decks.A.durSec() - decks.A.posSec());
  clearInterval(playlist.timer);
  playlist.timer = setInterval(playlistMonitor, 350);
  if (window.JBToast) window.JBToast("📻 Playlist Auto-Mix started — non-stop set from your library.");
}
function playlistStop () {
  playlist.on = false;
  clearInterval(playlist.timer); playlist.timer = null;
  document.body.classList.remove("playlist-auto");
  const btn = $("#btn-playlist-auto");
  if (btn) { btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); const s = $(".pa-state", btn); if (s) s.textContent = "OFF"; }
}
function playlistMonitor () {
  if (!playlist.on || playlist.mixing) return;
  if (window.JBAutoMix && window.JBAutoMix.isRunning()) return;
  const d = decks[playlist.live];
  if (!d || !d.track || !d.playing) return;
  const rem = d.durSec() - d.posSec();
  updatePlaylistStatus(rem);
  if (rem <= playlist.windowSec) playlistAdvance();
}
async function playlistAdvance () {
  if (!playlist.on || playlist.mixing) return;
  playlist.mixing = true;
  const live = playlist.live, cue = playlist.cue;
  try {
    if (!decks[cue].track) { const t = playlistNext(); if (t) await loadToDeck(cue, t); }
    preCue(cue, live);
    // run the real AI transition (beat-match + crossfade live → cue)
    if (window.JBAutoMix) { setCrossfader(live === "A" ? 0 : 1); await window.JBAutoMix.play(window.JBAutoMix.smartPick()); }
    else { if (!decks[cue].playing) { decks[cue].togglePlay(); ui.deckPlayChanged(cue); } await rampCross(live, cue, 6000); }
  } catch (e) { /* keep the set alive no matter what */ }
  if (!playlist.on) { playlist.mixing = false; return; }
  // swap roles: the deck we mixed into is now live
  playlist.live = cue; playlist.cue = live;
  const old = decks[live];
  if (old.playing) { old.togglePlay(); ui.deckPlayChanged(live); }
  const nt = playlistNext();
  if (nt) { await loadToDeck(live, nt); preCue(live, playlist.live); }
  playlist.mixing = false;
}
/* simple equal-power crossfade fallback if the AI mixer isn't present */
function rampCross (from, to, ms) {
  return new Promise((res) => {
    const start = performance.now(), a = from === "A" ? 0 : 1, b = to === "A" ? 0 : 1;
    (function step (now) {
      const k = Math.min(1, (now - start) / ms);
      setCrossfader(a + (b - a) * k);
      if (k < 1 && playlist.on) requestAnimationFrame(step); else res();
    })(start);
  });
}

/* ═══════════════════════ PROMPT-CONTROLLED DJ CHAT ═════════════════════════
   Type a plain-English set plan and the app performs it, e.g.
     "mix first 13 seconds of track 1 and start on 50th second of track 3,
      then play track 5 fully and at end gently mix in track 22 at second 33"
   It parses each clause into a timed step (load a track → seek → play → mix)
   and executes them in order on the two real decks. */
const djScript = { running: false, cancel: false };

// words → seconds ("13 seconds", "second 33", "fiftieth second", "1:20")
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, twentieth: 20, thirtieth: 30, fiftieth: 50 };
function wordNum (w) {
  if (w == null) return null;
  w = String(w).trim().toLowerCase();
  if (/^\d+(:\d+)?$/.test(w)) { if (w.indexOf(":") >= 0) { const p = w.split(":"); return (+p[0]) * 60 + (+p[1]); } return +w; }
  if (ORDINALS[w] != null) return ORDINALS[w];
  const m = w.match(/^(\d+)(st|nd|rd|th)$/); if (m) return +m[1];
  return null;
}
/* Parse the natural-language set into an ordered list of steps. */
function parseDjScript (text) {
  const steps = [];
  const lib = library.filter((t) => t && t.buffer);
  // wrap out-of-range track numbers so every referenced record resolves even on
  // a small demo library ("track 22" on a 9-record library → wraps around).
  const trackByNum = (n) => { if (!lib.length) return null; const i = (((n - 1) % lib.length) + lib.length) % lib.length; return lib[i]; };
  // split into one instruction per clause on then / , / ; / and / & / "and then".
  // (each sub-instruction targets a single "track N", so "track 1 and start
  //  track 3" must break into two steps.)
  const clauses = text.replace(/\band then\b/gi, " then ")
    .split(/\bthen\b|;|,|\band\b|&|\.(?=\s|$)/i)
    .map((s) => s.trim()).filter(Boolean);
  clauses.forEach((c) => {
    const low = c.toLowerCase();
    const tm = low.match(/track\s+(\d+)/);
    if (!tm) return;
    const trackNo = +tm[1];
    const track = trackByNum(trackNo);
    if (!track) return;
    const gentle = /\bgent|\bsmooth|\bslow|\bease/.test(low);
    const mix = /\bmix|\bblend|\bbring in|\btransition|\bcrossfade/.test(low);
    // start-at: "start on 50th second", "at second 33", "start at 1:20", "on the fiftieth second"
    let startAt = 0;
    let sm = low.match(/(?:start(?:ing)?\s+(?:on|at)|begin(?:ning)?\s+(?:on|at)|from)\s+(?:the\s+)?([\w:]+)(?:\s*(?:st|nd|rd|th)?\s*(?:second|sec|s)\b)?/);
    if (!sm) sm = low.match(/at\s+(?:the\s+)?(?:second\s+)?([\w:]+)(?:\s*(?:st|nd|rd|th)?\s*(?:second|sec|s)\b)?/);
    if (sm) { const v = wordNum(sm[1]); if (v != null) startAt = v; }
    // "at second 33" phrasing
    const secAt = low.match(/\bat\s+second\s+([\w:]+)/) || low.match(/\bon\s+(?:the\s+)?([\w:]+)\s+second\b/);
    if (secAt) { const v = wordNum(secAt[1]); if (v != null) startAt = v; }
    // duration: "first 13 seconds", "play ... fully", "for 20 seconds"
    let playFor = null, fully = /\bfull|\bwhole|\bentire|\bcomplete/.test(low);
    // duration only from explicit "first N sec" / "for N sec" — never from a
    // start phrase like "50th second of track 3" (that N is a position, not a length).
    let dm = low.match(/first\s+([\w:]+)\s*(?:seconds?|secs?|s)\b/) || low.match(/for\s+([\w:]+)\s*(?:seconds?|secs?|s)\b/);
    if (dm) { const v = wordNum(dm[1]); if (v != null) playFor = v; }
    steps.push({ trackNo, track, startAt, playFor, fully, gentle, mix, text: c.trim() });
  });
  return steps;
}
async function runDjScript (text) {
  if (djScript.running) { if (window.JBToast) window.JBToast("A set is already playing — stop it first."); return; }
  await ensureAudio();
  try { setFullAuto(false); } catch (e) {} playlistStop();
  const steps = parseDjScript(text);
  const out = $("#djchat-log");
  if (!steps.length) { if (out) out.textContent = "Couldn't find any \"track N\" steps in that. Try: “mix first 13s of track 1, then start track 3 at second 50”."; return; }
  djScript.running = true; djScript.cancel = false;
  document.body.classList.add("dj-script");
  const echo = (m) => { if (out) out.textContent = m; if (window.JBToast) window.JBToast(m); };
  echo("🎛 Running your set — " + steps.length + " step" + (steps.length > 1 ? "s" : "") + "…");
  let live = "A", first = true;
  for (let s = 0; s < steps.length; s++) {
    if (djScript.cancel) break;
    const st = steps[s];
    const cue = live === "A" ? "B" : "A";
    const target = first ? live : cue;
    await loadToDeck(target, st.track);
    const d = decks[target];
    const sr = d.track.buffer.sampleRate;
    d.seek(Math.min(st.startAt * sr, Math.max(0, d.track.buffer.length - sr)));
    if (first) {
      setCrossfader(target === "A" ? 0 : 1);
      if (!d.playing) { d.togglePlay(); ui.deckPlayChanged(target); }
      echo("▶ Track " + st.trackNo + " — “" + st.track.name + "”" + (st.startAt ? " from " + fmtTime(st.startAt) : ""));
      first = false;
    } else {
      // mix from the live deck into this one
      if (!d.playing) { d.togglePlay(); ui.deckPlayChanged(target); }
      echo((st.gentle ? "🎚 Gently mixing" : "⇢ Mixing") + " into track " + st.trackNo + " — “" + st.track.name + "”");
      if (window.JBAutoMix) { await window.JBAutoMix.play(window.JBAutoMix.smartPick()); }
      else { await rampCrossFree(live, target, st.gentle ? 8000 : 4000); }
      live = target;
    }
    // hold for the requested play window before advancing
    const holdSec = st.fully ? Math.max(0, d.durSec() - st.startAt) : (st.playFor != null ? st.playFor : 12);
    await djWait(holdSec * 1000, target);
  }
  if (!djScript.cancel) echo("✓ Set complete.");
  djScript.running = false;
  document.body.classList.remove("dj-script");
}
function rampCrossFree (from, to, ms) { return rampCross(from, to, ms); }
function djWait (ms, deckId) {
  return new Promise((res) => {
    const t0 = performance.now();
    (function step () {
      if (djScript.cancel) return res();
      const d = decks[deckId];
      const ended = d && d.track && d.atEnd && d.atEnd();
      if (performance.now() - t0 >= ms || ended) return res();
      setTimeout(step, 120);
    })();
  });
}
function stopDjScript () { djScript.cancel = true; djScript.running = false; document.body.classList.remove("dj-script"); }

function setupMixModes () {
  const song = $("#btn-mix-song"), pl = $("#btn-playlist-auto");
  if (song) song.addEventListener("click", async () => {
    await ensureAudio();
    playlistStop(); try { setFullAuto(false); } catch (e) {}
    if (!decks.A.track) await loadRandomToDeck("A");
    if (!decks.B.track) await loadRandomToDeck("B", decks.A.track);
    if (!decks.A.playing && !decks.B.playing) { decks.A.togglePlay(); ui.deckPlayChanged("A"); setCrossfader(0); }
    if (window.JBAutoMix) window.JBAutoMix.play(window.JBAutoMix.smartPick());
  });
  if (pl) pl.addEventListener("click", () => { if (playlist.on) playlistStop(); else playlistStart(); });
  // prompt chatbot
  const send = $("#djchat-send"), input = $("#djchat-input");
  const fire = () => { const v = input ? input.value.trim() : ""; if (v) runDjScript(v); };
  if (send) send.addEventListener("click", fire);
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fire(); } });
  document.querySelectorAll(".djchat-ex").forEach((b) => b.addEventListener("click", () => { if (input) { input.value = b.dataset.ex || b.textContent; input.focus(); } }));
}

function setupRandomLoad () {
  ["A", "B"].forEach((id) => {
    const btn = $(".btn-rand", deckEls(id).root);
    if (btn) btn.addEventListener("click", async () => { await ensureAudio(); await loadRandomToDeck(id); });
  });
}
function setupShare () {
  const btn = $("#btn-share");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!lastMixBlob) { if (window.JBToast) window.JBToast("Record a mix first, then share it."); return; }
    const file = new File([lastMixBlob], "jukeboxdj-mix.webm", { type: lastMixBlob.type || "audio/webm" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "My JukeboxDJ mix", text: "Mixed on JukeboxDJ 🎧 https://www.photon-bounce.com/jukeboxdj/" });
        return;
      }
    } catch (e) { /* user cancelled or unsupported — fall through to download */ }
    const a = $("#rec-save");
    if (a && a.href) a.click();
    else if (window.JBToast) window.JBToast("Sharing isn't supported here — use Save mix to download.");
  });
}

/* ─────────── hot cues ─────────── */
function refreshHotcues (id) {
  const el = deckEls(id), d = decks[id];
  if (!el.hcPads || !d) return;
  el.hcPads.forEach((pad, i) => pad.classList.toggle("set", d.hotcues[i] != null));
}
function setupHotcues () {
  ["A", "B"].forEach((id) => {
    const el = deckEls(id);
    el.hcPads.forEach((pad, i) => {
      pad.addEventListener("click", async () => {
        await ensureAudio();                 // creates the decks on first gesture
        const d = decks[id];
        if (!d) return;
        if (d.hotcues[i] == null) d.setHotcue(i); else d.jumpHotcue(i);   // empty=set, set=jump
        refreshHotcues(id); ui.deckPlayChanged(id);
      });
      pad.addEventListener("contextmenu", (e) => { e.preventDefault(); const d = decks[id]; if (d) { d.clearHotcue(i); refreshHotcues(id); } });
    });
  });
}

/* ─────────── musical-key detection (Krumhansl chroma) + Camelot wheel ─────────── */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CAMELOT_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];   // by pitch class C..B
const CAMELOT_MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
function camelotOf (root, mode) { return (mode === "minor" ? CAMELOT_MIN[root] + "A" : CAMELOT_MAJ[root] + "B"); }
function keysCompatible (a, b) {
  if (!a || !b) return false;
  const na = +a.slice(0, -1), la = a.slice(-1), nb = +b.slice(0, -1), lb = b.slice(-1);
  if (na === nb) return true;                          // same code, or relative major/minor
  const d = Math.abs(na - nb);
  return la === lb && (d === 1 || d === 11);           // one step around the wheel, same mode
}
function estimateKey (buffer) {
  const sr = buffer.sampleRate;
  const c0 = buffer.getChannelData(0);
  const c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : c0;
  const step = Math.max(1, Math.round(sr / 11025));
  const dsr = sr / step;
  const N = Math.min(Math.floor(c0.length / step), Math.floor(dsr * 45));   // cap ~45s
  const sig = new Float32Array(N);
  for (let j = 0, i = 0; j < N; j++, i += step) sig[j] = (c0[i] + c1[i]) * 0.5;
  const chroma = new Float64Array(12);
  for (let m = 36; m <= 84; m++) {                     // Goertzel at each semitone C2..C6
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const k = 2 * Math.cos(2 * Math.PI * f / dsr);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) { const s0 = sig[i] + k * s1 - s2; s2 = s1; s1 = s0; }
    chroma[m % 12] += s1 * s1 + s2 * s2 - k * s1 * s2;
  }
  let mx = 0; for (let i = 0; i < 12; i++) mx = Math.max(mx, chroma[i]);
  if (mx > 0) for (let i = 0; i < 12; i++) chroma[i] /= mx;
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  let best = { score: -1, root: 0, mode: "major" };
  for (let r = 0; r < 12; r++) {
    let sMaj = 0, sMin = 0;
    for (let i = 0; i < 12; i++) { const c = chroma[(i + r) % 12]; sMaj += c * MAJ[i]; sMin += c * MIN[i]; }
    if (sMaj > best.score) best = { score: sMaj, root: r, mode: "major" };
    if (sMin > best.score) best = { score: sMin, root: r, mode: "minor" };
  }
  return { key: NOTE_NAMES[best.root], mode: best.mode,
    label: NOTE_NAMES[best.root] + (best.mode === "minor" ? "m" : ""), camelot: camelotOf(best.root, best.mode) };
}
function trackKey (track) {
  if (!track) return null;
  if (!track.key && track.buffer) { try { track.key = estimateKey(track.buffer); } catch (e) { track.key = null; } }
  return track.key;
}
function updateRowKey (track) {
  if (track && track._row) { const s = $(".lib-key", track._row); if (s) s.textContent = track.key ? track.key.camelot : ""; }
}
function refreshDeckKey (id) {
  const el = deckEls(id), d = decks[id];
  if (!el.key) return;
  if (!d) { el.key.textContent = "—"; el.key.classList.remove("harmonic", "known"); return; }
  const k = d.track ? trackKey(d.track) : null;
  el.key.textContent = k ? (k.camelot + " · " + k.label) : "—";
  const other = decks[id === "A" ? "B" : "A"].track;
  const ok2 = other && k && other.key && keysCompatible(k.camelot, other.key.camelot);
  el.key.classList.toggle("harmonic", !!ok2);
  el.key.classList.toggle("known", !!k);
}
/* compute keys for the whole library in the background — display + harmonic
   Auto-Mix get them ready without blocking boot */
function precomputeKeys () {
  const queue = library.slice();
  const step = () => {
    const t = queue.shift();
    if (t) { trackKey(t); updateRowKey(t); }
    if (queue.length) setTimeout(step, 50);
    else { refreshDeckKey("A"); refreshDeckKey("B"); }
  };
  setTimeout(step, 900);
}

/* ─────────── offline library (IndexedDB) — your added tracks survive reload ─────────── */
function idbOpen () {
  return new Promise((res, rej) => {
    const rq = indexedDB.open("jukeboxdj", 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains("tracks")) rq.result.createObjectStore("tracks", { keyPath: "id" }); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbSaveTrack (rec) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction("tracks", "readwrite");
      tx.objectStore("tracks").put(rec);
      tx.oncomplete = () => res();
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  } catch (e) { /* no IDB / private mode / quota — the track still plays this session */ }
}
async function idbAllTracks () {
  try {
    const db = await idbOpen();
    return await new Promise((res) => { const rq = db.transaction("tracks").objectStore("tracks").getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); });
  } catch (e) { return []; }
}
async function loadSavedTracks () {
  let recs = [];
  try { recs = await idbAllTracks(); } catch (e) { return; }
  for (const rec of recs) {
    try {
      const audio = await decodeBundled(rec.bytes.slice(0));   // OfflineAudioContext — works before any gesture
      const track = { id: rec.id, name: rec.name, style: "Your music", bpm: estimateBPM(audio),
        color: USER_COLORS[userColorIx++ % USER_COLORS.length], buffer: audio, custom: true, saved: true };
      library.push(track);
      $("#lib-list").appendChild(libraryRow(track));
    } catch (e) { /* skip a corrupt record */ }
  }
  if (recs.length) $("#lib-status").textContent = recs.length + " saved track" + (recs.length > 1 ? "s" : "") + " restored — ready.";
}

function setupScratchPads () {
  const host = $("#fx-pads");
  if (!host) return;
  SCRATCH_FX.forEach((fx) => {
    const b = document.createElement("button");
    b.className = "fx-pad";
    b.textContent = fx.name;
    b.addEventListener("click", () => { playScratch(fx.id); b.classList.add("hit"); setTimeout(() => b.classList.remove("hit"), 160); });
    host.appendChild(b);
  });
  window.addEventListener("keydown", (e) => {
    if (e.repeat || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (/^[0-9]$/.test(e.key)) {
      const idx = e.key === "0" ? 9 : (Number(e.key) - 1);
      const fx = SCRATCH_FX[idx];
      if (fx) { playScratch(fx.id); const btn = host.children[idx]; if (btn) { btn.classList.add("hit"); setTimeout(() => btn.classList.remove("hit"), 160); } }
    }
  });
}

/* ────────────────────────── UI ────────────────────────── */
const ui = {};
const VINYL_SEC_PER_REV = 1.8; // 33⅓ RPM

function deckEls (id) {
  const root = $("#deck" + id);
  return {
    root,
    platter: $(".platter", root),
    disc: $(".disc", root),
    label: $(".disc-label", root),
    needle: $(".needle", root),
    vtCur: $(".vt-cur", root),
    vtRem: $(".vt-rem", root),
    play: $(".btn-play", root),
    cue: $(".btn-cue", root),
    sync: $(".btn-sync", root),
    pitch: $(".pitch", root),
    pitchVal: $(".pitch-val", root),
    bpm: $(".bpm-val", root),
    time: $(".time-val", root),
    title: $(".deck-track", root),
    wave: $(".wave", root),
    loops: $$(".btn-loop", root),
    vu: $(".vu", root),
    key: $(".deck-key", root),
    hcPads: $$(".hc-pad", root)
  };
}

function setupDeckUI (id) {
  const el = deckEls(id);

  el.play.addEventListener("click", async () => {
    await ensureAudio();
    const d = decks[id];
    if (!d.track) { flashLibrary(); return; }
    d.togglePlay();
    ui.deckPlayChanged(id);
  });

  // CUE: paused → set cue here (tap) / preview (hold); playing → back to cue & stop.
  let cueHold = 0;
  el.cue.addEventListener("pointerdown", async () => {
    await ensureAudio();
    const d = decks[id];
    if (!d.track) return;
    if (d.playing) { d.stopAtCue(); ui.deckPlayChanged(id); return; }
    // Finished at the end? CUE returns to the cue point (don't arm a cue at the
    // dead end — that's what made CUE feel "disabled" after a track stopped).
    if (d.atEnd()) { d.seek(d.cue || 0); return; }
    d.cue = d.pos;
    cueHold = setTimeout(() => { d.playing = true; d.node.port.postMessage({ t: "play", on: true }); ui.deckPlayChanged(id); cueHold = -1; }, 220);
  });
  const cueUp = () => {
    const d = decks[id];
    if (cueHold === -1) { d.stopAtCue(); ui.deckPlayChanged(id); }
    else clearTimeout(cueHold);
    cueHold = 0;
  };
  el.cue.addEventListener("pointerup", cueUp);
  el.cue.addEventListener("pointerleave", () => { if (cueHold) cueUp(); });

  el.sync.addEventListener("click", async () => {
    await ensureAudio();
    const d = decks[id], other = decks[id === "A" ? "B" : "A"];
    const target = other.effectiveBPM();
    if (!d.track || !d.track.bpm || !target) return;
    const r = clamp(target / d.track.bpm, 0.7, 1.4);
    d.setRate(r);
    el.pitch.value = String(Math.round((r - 1) * 1000)); // slider is ‰
    updatePitchLabel(id);
  });

  el.pitch.addEventListener("input", () => {
    const d = decks[id];
    const r = 1 + Number(el.pitch.value) / 1000;
    if (ctx) d.setRate(r); else pendingRates[id] = r;
    updatePitchLabel(id);
  });

  el.loops.forEach((b) => b.addEventListener("click", async () => {
    await ensureAudio();
    const beats = Number(b.dataset.beats);
    decks[id].setLoop(beats);
    el.loops.forEach((x) => x.classList.toggle("on", Number(x.dataset.beats) === decks[id].loopBeats));
  }));

  // waveform click/drag = needle drop
  const waveSeek = (ev) => {
    const d = decks[id];
    if (!d || !d.track) return;
    const r = el.wave.getBoundingClientRect();
    const frac = clamp((ev.clientX - r.left) / r.width, 0, 1);
    d.seek(frac * d.track.buffer.length);
  };
  el.wave.addEventListener("pointerdown", async (ev) => {
    await ensureAudio();
    waveSeek(ev);
    const mv = (e2) => waveSeek(e2);
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  });

  /* ── the turntable itself: grab the record ── */
  let dragging = false, lastAngle = 0, lastT = 0, lastSent = 0;
  const center = () => {
    const r = el.platter.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const angleOf = (ev) => {
    const c = center();
    return Math.atan2(ev.clientY - c.y, ev.clientX - c.x);
  };
  el.platter.addEventListener("pointerdown", async (ev) => {
    await ensureAudio();
    const d = decks[id];
    if (!d.track) { flashLibrary(); return; }
    dragging = true;
    try { el.platter.setPointerCapture(ev.pointerId); } catch (e) { /* stale/synthetic pointer — capture is best-effort */ }
    el.root.classList.add("scratching");
    lastAngle = angleOf(ev); lastT = performance.now(); lastSent = performance.now();
    d.scratch(true);
    ev.preventDefault();
  });
  el.platter.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const now = performance.now();
    let a = angleOf(ev), dA = a - lastAngle;
    if (dA > Math.PI) dA -= 2 * Math.PI;
    if (dA < -Math.PI) dA += 2 * Math.PI;
    const dt = Math.max(4, now - lastT) / 1000;
    // revolutions/sec × seconds-of-audio-per-revolution = playback rate
    const rate = (dA / (2 * Math.PI)) * VINYL_SEC_PER_REV / dt;
    decks[id].scratchVel(clamp(rate, -12, 12));
    lastAngle = a; lastT = now; lastSent = now;
  });
  const endScratch = (ev) => {
    if (!dragging) return;
    dragging = false;
    el.root.classList.remove("scratching");
    decks[id].scratchVel(0);
    decks[id].scratch(false);
  };
  el.platter.addEventListener("pointerup", endScratch);
  el.platter.addEventListener("pointercancel", endScratch);
  // hand friction decay: if the pointer holds still, the record stops under it
  setInterval(() => { if (dragging && performance.now() - lastSent > 90) decks[id] && decks[id].scratchVel(0); }, 45);
}

const pendingRates = { A: 1, B: 1 };

function updatePitchLabel (id) {
  const el = deckEls(id);
  if (!el.pitch) return;
  const v = Number(el.pitch.value) / 10;
  const lbl = (v > 0 ? "+" : "") + v.toFixed(1) + "%";
  if (el.pitchVal) el.pitchVal.textContent = lbl;
  // show the live pitch on the slider's label ("PITCH +4.0%")
  const span = el.pitch.closest(".sl") && el.pitch.closest(".sl").querySelector("span");
  if (span) span.textContent = "PITCH " + lbl;
}

ui.deckPlayChanged = (id) => {
  const el = deckEls(id), d = decks[id];
  el.play.classList.toggle("on", d.playing);
  el.play.innerHTML = d.playing ? "&#10074;&#10074;" : "&#9654;";
  el.play.setAttribute("aria-label", d.playing ? "Pause deck " + id : "Play deck " + id);
};

ui.recStarted = () => {
  $("#btn-rec").classList.add("on");
  $("#rec-label").textContent = "0:00";
  const rs = $("#btn-record-session");
  if (rs) { rs.classList.add("on"); $(".rs-label", rs).textContent = "Recording… 0:00"; }
};
ui.recStopped = (blob) => {
  $("#btn-rec").classList.remove("on");
  $("#rec-label").textContent = "REC";
  const rs = $("#btn-record-session");
  if (rs) { rs.classList.remove("on"); $(".rs-label", rs).textContent = "Record this Session"; }
  const url = URL.createObjectURL(blob);
  const a = $("#rec-save");
  a.href = url;
  a.download = "jukeboxdj-mix-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".webm";
  a.hidden = false;
  a.classList.add("pulse");
  setTimeout(() => a.classList.remove("pulse"), 3000);
  // keep the blob so the Share button can hand it to the OS share sheet
  lastMixBlob = blob;
  const sh = $("#btn-share");
  if (sh) { sh.hidden = false; sh.classList.add("pulse"); setTimeout(() => sh.classList.remove("pulse"), 3000); }
};

/* knobs: vertical-drag rotary controls */
function setupKnob (elm, { min, max, value, onChange }) {
  let v = value;
  const draw = () => {
    const frac = (v - min) / (max - min);
    elm.style.setProperty("--rot", (frac * 270 - 135) + "deg");
  };
  const set = (nv, fire) => { v = clamp(nv, min, max); draw(); if (fire !== false) onChange(v); };
  let sy = 0, sv = 0, drag = false;
  elm.addEventListener("pointerdown", async (ev) => {
    await ensureAudio();
    drag = true; sy = ev.clientY; sv = v;
    try { elm.setPointerCapture(ev.pointerId); } catch (e) { /* best-effort */ }
    ev.preventDefault();
  });
  elm.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    set(sv + (sy - ev.clientY) / 130 * (max - min));
  });
  elm.addEventListener("pointerup", () => { drag = false; });
  elm.addEventListener("dblclick", () => set(value));
  draw();
  return { set, get: () => v };
}

/* EQ / filter / volume are now big touch SLIDERS living inside each deck.
   filter maps a single -1..+1 slider onto low-pass ↔ high-pass. */
function applyBand (id, band, v) {
  const d = decks[id]; if (!d) return;
  if (band === "lo") d.eqLo.gain.value = v;
  else if (band === "mid") d.eqMid.gain.value = v;
  else if (band === "hi") d.eqHi.gain.value = v;
  else if (band === "filter") {
    const f = d.filter;
    if (Math.abs(v) < 0.06) { f.type = "allpass"; f.frequency.value = 1000; f.Q.value = 0.8; }
    else if (v < 0) { f.type = "lowpass"; f.Q.value = 6; f.frequency.value = 12000 * Math.pow(0.008, -v); }
    else { f.type = "highpass"; f.Q.value = 6; f.frequency.value = 30 * Math.pow(220, v); }
  } else if (band === "vol") d.chanGain.gain.value = Math.pow(v / 100, 1.4);
}
function setupMixer () {
  ["A", "B"].forEach((id) => {
    const root = deckEls(id).root;
    $$(".eq-slider, .chan-fader", root).forEach((sl) => {
      const band = sl.dataset.band;
      const apply = async () => { await ensureAudio(); applyBand(id, band, Number(sl.value)); };
      sl.addEventListener("input", apply);
      // double-tap a slider to recenter it (0 for EQ/filter, keep vol)
      sl.addEventListener("dblclick", () => { if (band !== "vol") { sl.value = "0"; apply(); } });
    });
  });
  const x = $("#crossfader");
  x.addEventListener("input", async () => { await ensureAudio(); crossPos = Number(x.value) / 100; applyCrossfader(); });
  const mg = $("#master-gain");
  mg.addEventListener("input", async () => { await ensureAudio(); master.gain.value = Math.pow(Number(mg.value) / 100, 1.3) * 1.2; });
  const rec = $("#btn-rec");
  if (rec) rec.addEventListener("click", async () => { await ensureAudio(); toggleRecord(); });
  const stop = $("#btn-stop-all");
  if (stop) stop.addEventListener("click", stopAll);
}

/* STOP ALL — silence everything: halt Auto-Mix + Full Auto, pause both decks. */
function stopAll () {
  try { if (window.JBAutoMix && window.JBAutoMix.isRunning && window.JBAutoMix.isRunning()) window.JBAutoMix.stop(); } catch (e) {}
  try { setFullAuto(false); } catch (e) {}
  try { playlistStop(); } catch (e) {}
  try { stopDjScript(); } catch (e) {}
  ["A", "B"].forEach((id) => { const d = decks[id]; if (d && d.playing) { d.togglePlay(); ui.deckPlayChanged(id); } });
  if (window.JBToast) window.JBToast("■ Stopped all decks.");
}

/* ────────────────────────── library / jukebox ────────────────────────── */
function flashLibrary () {
  const lib = $("#library");
  lib.classList.add("flash");
  setTimeout(() => lib.classList.remove("flash"), 900);
}

function libraryRow (track) {
  const row = document.createElement("div");
  row.className = "lib-row";
  row.dataset.tid = track.id;
  track._row = row;
  row.innerHTML =
    '<span class="lib-vinyl" style="--c:' + track.color + '"></span>' +
    '<span class="lib-onair"></span>' +
    '<span class="lib-meta"><b>' + escapeHTML(track.name) + "</b><i>" + escapeHTML(track.style) + "</i></span>" +
    '<span class="lib-key" title="Camelot key">' + (track.key ? track.key.camelot : "") + "</span>" +
    '<span class="lib-bpm">' + (track.bpm ? track.bpm + " BPM" : "— BPM") + "</span>" +
    '<span class="lib-dur">' + fmtTime(track.buffer.duration) + "</span>" +
    '<span class="lib-btns"><button class="to-a" title="Load on deck A">A</button><button class="to-b" title="Load on deck B">B</button></span>';
  $(".to-a", row).addEventListener("click", () => loadToDeck("A", track));
  $(".to-b", row).addEventListener("click", () => loadToDeck("B", track));
  return row;
}

/* Highlight the library rows whose track is loaded on a deck, and pulse the
   one that's actually playing — with an A/B badge showing which deck. */
function refreshLibraryNowPlaying () {
  $$(".lib-row").forEach((r) => {
    r.classList.remove("on-a", "on-b", "playing");
    const oa = $(".lib-onair", r);
    if (oa) oa.textContent = "";
  });
  ["A", "B"].forEach((id) => {
    const d = decks[id];
    if (!d || !d.track || !d.track._row) return;
    const r = d.track._row;
    r.classList.add(id === "A" ? "on-a" : "on-b");
    if (d.playing || Math.abs(d.vel) > 0.02) r.classList.add("playing");
    const oa = $(".lib-onair", r);
    if (oa) oa.textContent = id;
  });
}

function escapeHTML (s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadToDeck (id, track) {
  await ensureAudio();
  const d = decks[id];
  const wasDefaultRate = !d.track;
  d.load(track);
  d._lastCurSec = d._lastRemSec = -1;   // force the time runner to repaint for the new track
  d.setRate(1 + Number(deckEls(id).pitch.value) / 1000);
  const el = deckEls(id);
  el.title.textContent = track.name;
  el.label.style.setProperty("--c", track.color);
  $(".disc-label b", el.root).textContent = track.name;
  $(".disc-label i", el.root).textContent = track.bpm ? track.bpm + " BPM" : "";
  el.root.classList.add("loaded");
  el.loops.forEach((x) => x.classList.remove("on"));
  ui.deckPlayChanged(id);
  refreshHotcues(id);
  drawWave(id);
  // detect the musical key off the main thread's next tick so the load paints first
  setTimeout(() => { trackKey(track); updateRowKey(track); refreshDeckKey(id); refreshDeckKey(id === "A" ? "B" : "A"); }, 0);
}

/* Featured tracks: real songs bundled with the app (projects/jukeboxdj/audio/).
   Decoded up-front via an OfflineAudioContext so they appear in the jukebox
   before the first gesture, exactly like the pressed records. Any that fail to
   fetch/decode are simply skipped — the synth records always remain. */
async function decodeBundled (buf) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const octx = new OAC(2, 1, 44100);
  return octx.decodeAudioData(buf);
}
async function loadFeaturedTracks () {
  const status = $("#lib-status");
  let manifest = null;
  try {
    const r = await fetch("audio/tracks.json", { cache: "reload" });
    if (r.ok) manifest = await r.json();
  } catch (e) { manifest = null; }
  if (!manifest || !manifest.length) return;
  for (let i = 0; i < manifest.length; i++) {
    const m = manifest[i];
    status.textContent = "Loading featured tracks… " + m.name + " (" + (i + 1) + "/" + manifest.length + ")";
    try {
      const buf = await fetch("audio/" + m.file, { cache: "reload" }).then((x) => { if (!x.ok) throw 0; return x.arrayBuffer(); });
      const audio = await decodeBundled(buf);
      const track = {
        id: "feat-" + m.file, name: m.name, style: m.style || "Featured",
        bpm: estimateBPM(audio), color: m.color || "#7DD3FC", buffer: audio, custom: false, featured: true
      };
      library.push(track);
      $("#lib-list").appendChild(libraryRow(track));
    } catch (e) { /* skip a missing/undecodable featured track */ }
  }
}

async function buildLibrary () {
  const status = $("#lib-status");
  for (let i = 0; i < TRACK_DEFS.length; i++) {
    status.textContent = "Pressing vinyl… " + TRACK_DEFS[i].name + " (" + (i + 1) + "/" + TRACK_DEFS.length + ")";
    // OfflineAudioContext is independent of the live ctx: safe pre-gesture.
    const t = await renderTrack(TRACK_DEFS[i]);
    library.push(t);
    $("#lib-list").appendChild(libraryRow(t));
  }
  const feat = library.filter((t) => t.featured).length;
  status.textContent = (feat ? feat + " featured tracks + six pressed records" : "Six house-pressed records") + " loaded — or add your own MP3s.";
  $("#lib-list").classList.add("ready");
}

function setupFileLoading () {
  const input = $("#file-input");
  $("#btn-add-music").addEventListener("click", () => input.click());
  input.addEventListener("change", () => addFiles(input.files));
  const app = $("#app");
  app.addEventListener("dragover", (e) => { e.preventDefault(); app.classList.add("dropping"); });
  app.addEventListener("dragleave", () => app.classList.remove("dropping"));
  app.addEventListener("drop", (e) => {
    e.preventDefault();
    app.classList.remove("dropping");
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
}

const USER_COLORS = ["#F5C842", "#5EEAD4", "#FB7185", "#7DD3FC", "#A78BFA", "#C4B5FD"];
let userColorIx = 0;

async function addFiles (files) {
  await ensureAudio();
  const status = $("#lib-status");
  for (const f of Array.from(files)) {
    if (!/^audio\//.test(f.type) && !/\.(mp3|wav|ogg|m4a|flac|aac|webm)$/i.test(f.name)) continue;
    status.textContent = "Decoding " + f.name + "…";
    try {
      const raw = await f.arrayBuffer();
      const audio = await ctx.decodeAudioData(raw.slice(0));   // decode a copy; keep raw for storage
      const track = {
        id: "user-" + Date.now() + Math.random().toString(36).slice(2, 6),
        name: f.name.replace(/\.[^.]+$/, ""),
        style: "Your music",
        bpm: estimateBPM(audio),
        color: USER_COLORS[userColorIx++ % USER_COLORS.length],
        buffer: audio,
        custom: true,
        saved: true
      };
      library.push(track);
      $("#lib-list").appendChild(libraryRow(track));
      await idbSaveTrack({ id: track.id, name: track.name, bytes: raw, type: f.type });   // persist for next time
      setTimeout(() => { trackKey(track); updateRowKey(track); }, 0);
    } catch (err) {
      status.textContent = "Couldn't decode " + f.name;
      continue;
    }
  }
  status.textContent = "Ready.";
}

/* ────────────────────────── render loop ────────────────────────── */
function drawWave (id) {
  const el = deckEls(id), d = decks[id], cv = el.wave;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext("2d");
  g.clearRect(0, 0, w, h);
  if (!d || !d.track || !d.peaks) return;
  const n = d.peaks.length, bw = w / n, mid = h / 2;
  const playFrac = clamp(d.pos / d.track.buffer.length, 0, 1);
  const col = d.track.color;
  for (let i = 0; i < n; i++) {
    const v = d.peaks[i], bh = Math.max(1.5 * dpr, v * h * 0.94);
    const played = i / n <= playFrac;
    g.fillStyle = played ? col : "rgba(150,156,205,.34)";
    g.fillRect(i * bw, mid - bh / 2, Math.max(1, bw - 0.6 * dpr), bh);
  }
  // progress tint under the played portion so it reads as a scrubber
  g.fillStyle = "rgba(255,255,255,.06)";
  g.fillRect(0, 0, playFrac * w, h);

  // ── prominent playhead + large drag handle ──
  const px = playFrac * w;
  g.save();
  // glowing playhead line
  g.shadowColor = col; g.shadowBlur = 10 * dpr;
  g.fillStyle = "#fff";
  g.fillRect(px - 1.5 * dpr, 0, 3 * dpr, h);
  g.restore();
  // big round handle centred on the line
  const rHandle = Math.min(h * 0.42, 13 * dpr);
  g.beginPath();
  g.arc(px, mid, rHandle, 0, Math.PI * 2);
  g.fillStyle = "#fff";
  g.shadowColor = "rgba(0,0,0,.6)"; g.shadowBlur = 6 * dpr; g.shadowOffsetY = 1 * dpr;
  g.fill();
  g.shadowColor = "transparent";
  // coloured ring + inner dot so it pops against the wave
  g.lineWidth = 3 * dpr; g.strokeStyle = col; g.stroke();
  g.beginPath();
  g.arc(px, mid, rHandle * 0.42, 0, Math.PI * 2);
  g.fillStyle = col; g.fill();
  // grab grips
  g.strokeStyle = "rgba(11,11,30,.55)"; g.lineWidth = 1.4 * dpr;
  for (const dx of [-rHandle * 0.5, rHandle * 0.5]) {
    g.beginPath(); g.moveTo(px + dx, mid - rHandle * 0.34); g.lineTo(px + dx, mid + rHandle * 0.34); g.stroke();
  }
}

const vuData = {};
function drawVU (id) {
  const el = deckEls(id), d = decks[id], cv = el.vu;
  if (!cv || !d) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  let arr = vuData[id];
  if (!arr || arr.length !== d.analyser.fftSize) arr = vuData[id] = new Float32Array(d.analyser.fftSize);
  d.analyser.getFloatTimeDomainData(arr);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  const rms = Math.sqrt(sum / arr.length);
  const lvl = clamp(Math.pow(rms * 3.2, 0.7), 0, 1);
  const g = cv.getContext("2d");
  g.clearRect(0, 0, w, h);
  const segs = 14;
  for (let i = 0; i < segs; i++) {
    const on = i / segs < lvl;
    const y = h - (i + 1) * (h / segs);
    g.fillStyle = !on ? "rgba(255,255,255,.07)" : i > segs - 4 ? "#FB7185" : i > segs - 7 ? "#F5C842" : "#5EEAD4";
    g.fillRect(0, y + 1, w, h / segs - 2);
  }
}

function tick () {
  requestAnimationFrame(tick);
  if (!ctx) return;
  ["A", "B"].forEach((id) => {
    const d = decks[id], el = deckEls(id);
    if (!d) return;
    if (d.track) {
      // platter angle tracks the actual audio position — scratching moves it.
      const angle = (d.posSec() / VINYL_SEC_PER_REV) * 360;
      el.disc.style.transform = "rotate(" + (angle % 360) + "deg)";
      const frac = Math.max(0, Math.min(1, d.pos / d.track.buffer.length));
      // Needle rides from the outer rim (start) toward the spindle (end) across
      // the exposed top third of the record. left: 8%→92% tracks progress.
      if (el.needle) {
        el.needle.style.left = (8 + frac * 84).toFixed(2) + "%";
        el.needle.classList.toggle("flip", frac > 0.5);
      }
      // time runner: only rewrite the DOM when the whole-second value actually
      // changes (≈1×/s), not every animation frame — avoids needless per-frame
      // string allocation + layout churn.
      const cur = d.posSec(), dur = d.durSec(), rem = Math.max(0, dur - cur);
      const cs = cur | 0, rs = rem | 0;
      if (cs !== d._lastCurSec || rs !== d._lastRemSec) {
        d._lastCurSec = cs; d._lastRemSec = rs;
        if (el.vtCur) el.vtCur.textContent = fmtTime(cur);
        if (el.vtRem) el.vtRem.textContent = "-" + fmtTime(rem);
        el.time.textContent = fmtTime(cur) + " / " + fmtTime(dur);
      }
      const eb = d.effectiveBPM();
      el.bpm.textContent = eb ? eb.toFixed(1) : "—";
      drawWave(id);
    }
    drawVU(id);
    el.root.classList.toggle("spinning", d.playing || Math.abs(d.vel) > 0.01);
  });
  refreshLibraryNowPlaying();
  driveMixerBeat();
  if (recorder) {
    const elapsed = (performance.now() - recStart) / 1000;
    $("#rec-label").textContent = fmtTime(elapsed);
    const rs = $("#btn-record-session");
    if (rs) { const l = $(".rs-label", rs); if (l) l.textContent = "Recording… " + fmtTime(elapsed); }
    // free tier: each take caps out — the recording still saves, then Pro is offered
    const limit = window.JBPro ? window.JBPro.recLimitSec() : Infinity;
    if (elapsed >= limit) {
      toggleRecord();
      window.JBToast("Free recordings cap at " + limit + "s — your take was saved. Go Pro for unlimited takes.");
      if (window.JBPro) window.JBPro.openPanel();
    }
  }
}

/* keyboard: Q/W deck A play/cue · O/P deck B · Z/X/C crossfader */
function setupKeys () {
  window.addEventListener("keydown", async (e) => {
    if (e.repeat || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === "q") { await ensureAudio(); if (decks.A.track) { decks.A.togglePlay(); ui.deckPlayChanged("A"); } }
    if (k === "p") { await ensureAudio(); if (decks.B.track) { decks.B.togglePlay(); ui.deckPlayChanged("B"); } }
    if (k === "z" || k === "x" || k === "c") {
      await ensureAudio();
      crossPos = k === "z" ? 0 : k === "x" ? 0.5 : 1;
      $("#crossfader").value = String(crossPos * 100);
      applyCrossfader();
    }
  });
}

/* ────────────────────────── boot ────────────────────────── */
async function boot () {
  setupDeckUI("A"); setupDeckUI("B");
  setupMixer();
  setupFileLoading();
  setupKeys();
  updatePitchLabel("A"); updatePitchLabel("B");
  tick();
  // one-tap demo: load the first two records onto the decks so the floor is
  // never empty (featured songs sit at the top of the library when present).
  $("#btn-autoload").addEventListener("click", async () => {
    if (library.length >= 2) {
      await loadToDeck("A", library[0]);
      await loadToDeck("B", library[1]);
    }
  });
  // "Record this Session" — same master-bus recorder as the topbar REC chip.
  const rs = $("#btn-record-session");
  if (rs) rs.addEventListener("click", async () => { await ensureAudio(); toggleRecord(); });

  setupScratchPads();
  setupMixNotes();
  setupFullAuto();
  setupMixModes();
  setupRandomLoad();
  setupShare();
  setupHotcues();

  window.__JB = {
    ctx: () => ctx, decks, library, ensureAudio, loadToDeck, toggleRecord,
    // control surface for the AI Auto-Mixer + QA
    setCrossfader, getCrossfader: () => crossPos, setMasterGain, reflectPitch,
    beatInfo, applyCrossfader, deckEls, updatePitchLabel,
    isRecording: () => !!recorder,
    recording: () => !!recorder,
    playScratch, scratchFx: SCRATCH_FX,
    // FULL AUTO + random load + share (also handy for QA)
    setFullAuto, fullAuto, loadRandomToDeck, onDeckEnded,
    // playlist auto-mix + prompt-controlled DJ chat
    playlist, playlistStart, playlistStop, playlistAdvance,
    parseDjScript, runDjScript, stopDjScript, djScript,
    // hot cues + harmonic key detection
    estimateKey, trackKey, keysCompatible, refreshDeckKey, refreshHotcues,
    stopAll, applyBand
  };
  document.body.classList.add("booted");
  if (window.JBAutoMix) window.JBAutoMix.boot(window.__JB);
  try {
    await loadFeaturedTracks();   // real bundled songs first (top of the jukebox)
    await buildLibrary();         // then the pressed synth records
    await loadSavedTracks();      // then any tracks you saved on a previous visit
    precomputeKeys();             // detect every record's musical key in the background
  } catch (err) {
    $("#lib-status").textContent = "Track load failed — you can still add your own music.";
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
