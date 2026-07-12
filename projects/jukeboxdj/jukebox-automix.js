/* ═══════════════════════════════════════════════════════════════════════════
   JukeboxDJ · AI Auto-Mix
   Give it two loaded decks and it DJs the transition for you: it beat-matches
   the tempos, phase-aligns the beats so the kicks line up, then runs one of ten
   mix routines — EQ bass-swaps, filter sweeps, echo throws, beat-loop rolls,
   spinbacks, double-drops, tape-stops — automating the crossfader, EQ, filter,
   echo and pitch on a beat grid. It reads the same control surface the UI uses,
   so every fader and knob visibly moves while the AI works.

   It never fabricates audio — it only drives the real decks/mixer already built.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.JBAutoMix) return;

  var JB = null;         // control surface from jukebox.js (window.__JB)
  var running = false;
  var cancelFlag = false;
  var current = null;    // { name }

  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function toast (m) { if (window.JBToast) window.JBToast(m); }
  function deck (id) { return JB.decks[id]; }
  function bpm (id) { var d = deck(id); return d && d.track ? d.effectiveBPM() : 0; }
  function loaded (id) { var d = deck(id); return !!(d && d.track); }

  /* Which deck is currently the "outgoing" (audible) one and which is the
     "incoming" one we're bringing in. If only one plays, the other is incoming. */
  function roles () {
    var A = deck("A"), B = deck("B");
    var aOut = A.playing, bOut = B.playing;
    if (aOut && !bOut) return { out: "A", inc: "B" };
    if (bOut && !aOut) return { out: "B", inc: "A" };
    // both or neither playing → decide by crossfader position
    var x = JB.getCrossfader();
    return x <= 0.5 ? { out: "A", inc: "B" } : { out: "B", inc: "A" };
  }

  /* Beat-match: set the incoming deck's pitch so its tempo equals the outgoing
     deck's, then phase-align so the next downbeats coincide. */
  function beatmatch (out, inc) {
    var dOut = deck(out), dInc = deck(inc);
    if (!dOut.track || !dInc.track || !dOut.track.bpm || !dInc.track.bpm) return false;
    var target = dOut.effectiveBPM();
    var r = clamp(target / dInc.track.bpm, 0.7, 1.4);
    dInc.setRate(r);
    JB.reflectPitch(inc);
    phaseAlign(out, inc);
    return true;
  }

  /* Seek the incoming deck so it sits at the same beat-phase as the outgoing one
     (kick-on-kick). Approximate but musical — good enough for a clean blend. */
  function phaseAlign (out, inc) {
    var bOut = JB.beatInfo(out), bInc = JB.beatInfo(inc);
    if (!bOut || !bInc) return;
    var dInc = deck(inc);
    var curBeat = Math.floor(dInc.pos / bInc.beatFrames);
    var aligned = (curBeat + bOut.phase) * bInc.beatFrames;   // same fractional phase as A
    aligned = clamp(aligned, 0, dInc.track.buffer.length - 2);
    dInc.seek(aligned);
  }

  function ensurePlaying (id) {
    var d = deck(id);
    if (!d.playing) { d.togglePlay(); if (JB.deckEls) JB.updatePitchLabel(id); }
    if (window.__JB && window.__JB.decks) { /* deckPlayChanged handled by togglePlay path? */ }
  }

  /* smooth parameter automation over `ms`, calling set(v) each frame */
  async function ramp (from, to, ms, set) {
    var steps = Math.max(1, Math.round(ms / 33));
    for (var i = 1; i <= steps; i++) {
      if (cancelFlag) return;
      set(from + (to - from) * (i / steps));
      await sleep(ms / steps);
    }
    set(to);
  }

  // per-deck node helpers
  function chan (id) { return deck(id).chanGain.gain; }
  function eqLo (id) { return deck(id).eqLo.gain; }
  function eqHi (id) { return deck(id).eqHi.gain; }
  function eqMid (id) { return deck(id).eqMid.gain; }
  function echo (id, v) { deck(id).echoSend.gain.value = v; }
  function filt (id, type, freq, q) { var f = deck(id).filter; f.type = type; f.frequency.value = freq; f.Q.value = q || 6; }
  function resetFilter (id) { var f = deck(id).filter; f.type = "allpass"; f.frequency.value = 1000; f.Q.value = 0.8; }

  function beatMs (id) { var b = JB.beatInfo(id); return b ? b.spb * 1000 : 500; }

  /* ── the ten routines ── each gets {out, inc, bt} where bt = one beat in ms
     (of the outgoing deck). They assume beatmatch() + both decks primed. ── */
  var ROUTINES = [
    {
      id: "smooth", name: "Smooth Blend", bars: 8,
      desc: "Long beat-matched crossfade with a bass swap on the way through.",
      run: async function (o, i, bt) {
        eqLo(i).value = -26;                    // incoming bass out of the way
        await JB.setCrossfader(o === "A" ? 0 : 1);
        ensurePlaying(i);
        await ramp(o === "A" ? 0 : 1, 0.5, bt * 16, function (v) { JB.setCrossfader(v); });
        await ramp(-26, 0, bt * 4, function (v) { eqLo(i).value = v; });   // bring incoming bass in
        await ramp(0, -26, bt * 4, function (v) { eqLo(o).value = v; });   // pull outgoing bass
        await ramp(0.5, o === "A" ? 1 : 0, bt * 16, function (v) { JB.setCrossfader(v); });
      }
    },
    {
      id: "bassswap", name: "Bass Swap Cut", bars: 4,
      desc: "Snap the crossfader over on the 1 and trade the low end between decks.",
      run: async function (o, i, bt) {
        eqLo(i).value = -30; eqHi(i).value = 2;
        ensurePlaying(i);
        await sleep(bt * 2);
        JB.setCrossfader(0.5);                  // both up, incoming has no bass
        await sleep(bt * 2);
        eqLo(o).value = -30; eqLo(i).value = 0; // swap the lows on the beat
        await sleep(bt * 2);
        await ramp(0.5, o === "A" ? 1 : 0, bt * 2, function (v) { JB.setCrossfader(v); });
        eqLo(o).value = 0;
      }
    },
    {
      id: "echofade", name: "Echo Throw", bars: 4,
      desc: "Drench the outgoing track in tempo-synced echo and pull it out of the mix.",
      run: async function (o, i, bt) {
        ensurePlaying(i);
        JB.setCrossfader(0.5);
        await ramp(0, 0.8, bt * 2, function (v) { echo(o, v); });
        await ramp(0.5, o === "A" ? 1 : 0, bt * 3, function (v) { JB.setCrossfader(v); });
        await ramp(0.8, 0, bt * 3, function (v) { echo(o, v); });
      }
    },
    {
      id: "filtersweep", name: "Filter Sweep", bars: 6,
      desc: "High-pass the outgoing up and away while the incoming low-pass opens up.",
      run: async function (o, i, bt) {
        filt(i, "lowpass", 300, 6); ensurePlaying(i);
        JB.setCrossfader(0.5);
        await ramp(300, 16000, bt * 8, function (v) { deck(i).filter.frequency.value = v; });
        filt(o, "highpass", 30, 6);
        await Promise.all([
          ramp(30, 6000, bt * 8, function (v) { deck(o).filter.frequency.value = v; }),
          ramp(0.5, o === "A" ? 1 : 0, bt * 8, function (v) { JB.setCrossfader(v); })
        ]);
        resetFilter(i); resetFilter(o);
      }
    },
    {
      id: "looproll", name: "Loop Roll Cut", bars: 4,
      desc: "Roll the outgoing on a shrinking beat-loop, then cut to the incoming.",
      run: async function (o, i, bt) {
        deck(o).setLoop(4); await sleep(bt * 4);
        deck(o).setLoop(0); deck(o).setLoop(2); await sleep(bt * 2);
        deck(o).setLoop(0); deck(o).setLoop(1); await sleep(bt * 2);
        ensurePlaying(i);
        JB.setCrossfader(o === "A" ? 1 : 0);    // hard cut
        deck(o).setLoop(0);
      }
    },
    {
      id: "spinback", name: "Spinback Slam", bars: 2,
      desc: "Spin the outgoing record backwards and slam the incoming in on the 1.",
      run: async function (o, i, bt) {
        ensurePlaying(i);
        var dOut = deck(o);
        dOut.scratch(true);
        await ramp(0, -9, bt * 0.5, function (v) { dOut.scratchVel(v); });
        JB.setCrossfader(o === "A" ? 1 : 0);    // incoming slams in
        await sleep(bt * 0.5);
        dOut.scratchVel(0); dOut.scratch(false);
        if (dOut.playing) dOut.togglePlay();
      }
    },
    {
      id: "doubledrop", name: "Double Drop", bars: 4,
      desc: "Line both tracks up and play them together, then favour the incoming.",
      run: async function (o, i, bt) {
        ensurePlaying(i);
        JB.setCrossfader(0.5);                  // both at once
        eqMid(o).value = -6; eqMid(i).value = -6; // carve mids so it isn't mud
        await sleep(bt * 8);
        eqMid(o).value = 0; eqMid(i).value = 0;
        await ramp(0.5, o === "A" ? 1 : 0, bt * 4, function (v) { JB.setCrossfader(v); });
      }
    },
    {
      id: "chop", name: "Cut Chop", bars: 4,
      desc: "Rhythmically chop the crossfader between the two decks on the beat.",
      run: async function (o, i, bt) {
        ensurePlaying(i);
        var oPos = o === "A" ? 0 : 1, iPos = o === "A" ? 1 : 0;
        var pat = [oPos, iPos, oPos, iPos, iPos, oPos, iPos, iPos, oPos, iPos, iPos, iPos, iPos, iPos, iPos, iPos];
        for (var k = 0; k < pat.length; k++) {
          if (cancelFlag) break;
          JB.setCrossfader(pat[k]);
          await sleep(bt * 0.5);
        }
        JB.setCrossfader(iPos);
      }
    },
    {
      id: "tapestop", name: "Tape Stop", bars: 2,
      desc: "Power down the outgoing like a tape stop, then bring the incoming up.",
      run: async function (o, i, bt) {
        ensurePlaying(i);
        var dOut = deck(o), r0 = dOut.rate;
        await ramp(r0, 0.02, bt * 1.5, function (v) { dOut.setRate(v); JB.reflectPitch(o); });
        JB.setCrossfader(o === "A" ? 1 : 0);
        if (dOut.playing) dOut.togglePlay();
        dOut.setRate(r0); JB.reflectPitch(o);   // restore pitch for next time
      }
    },
    {
      id: "journey", name: "Long Journey", bars: 16,
      desc: "An extended 16-bar blend with rolling EQ automation and a mid loop.",
      run: async function (o, i, bt) {
        eqLo(i).value = -24; ensurePlaying(i);
        JB.setCrossfader(o === "A" ? 0 : 1);
        await ramp(o === "A" ? 0 : 1, 0.35, bt * 16, function (v) { JB.setCrossfader(v); });
        deck(i).setLoop(4); await sleep(bt * 4); deck(i).setLoop(0);
        await ramp(-24, 0, bt * 8, function (v) { eqLo(i).value = v; });
        await ramp(0, -24, bt * 8, function (v) { eqLo(o).value = v; });
        await ramp(0.35, 0.65, bt * 12, function (v) { JB.setCrossfader(v); });
        await ramp(0.65, o === "A" ? 1 : 0, bt * 16, function (v) { JB.setCrossfader(v); });
        eqLo(o).value = 0;
      }
    }
  ];

  /* restore mixer to neutral after a routine (or a cancel) */
  function neutralize (o, i) {
    ["A", "B"].forEach(function (id) {
      eqLo(id).value = 0; eqMid(id).value = 0; eqHi(id).value = 0;
      echo(id, 0); resetFilter(id);
      var d = deck(id); d.scratchVel(0); d.scratch(false);
    });
  }

  async function play (routine) {
    if (running) { toast("Auto-Mix already running — hold on."); return false; }
    if (!JB) return false;
    if (!loaded("A") || !loaded("B")) { toast("Load a track on BOTH decks first (A and B)."); return false; }
    running = true; cancelFlag = false; current = routine;
    setBusyUI(true, routine.name);

    var r = roles();
    // make sure the outgoing deck is actually playing
    if (!deck(r.out).playing) deck(r.out).togglePlay();
    var matched = beatmatch(r.out, r.inc);
    if (!matched) toast("Couldn't detect a beat — mixing without sync.");
    var bt = beatMs(r.out);

    try {
      toast("🤖 Auto-Mix: " + routine.name + " — " + r.out + " → " + r.inc);
      await routine.run(r.out, r.inc, bt);
    } catch (e) {
      // never let a routine wedge the decks
    }
    neutralize(r.out, r.inc);
    // settle the crossfader fully onto the incoming deck
    JB.setCrossfader(r.inc === "A" ? 0 : 1);
    running = false; current = null;
    setBusyUI(false);
    if (!cancelFlag) toast("✓ Mixed into " + r.inc + " — deck " + r.inc + " is now live.");
    return true;
  }

  function stop () {
    if (!running) return;
    cancelFlag = true;
    toast("Auto-Mix stopped.");
  }

  /* auto-pick a routine that suits the tempo gap between the decks */
  function smartPick () {
    var a = bpm("A"), b = bpm("B");
    var gap = Math.abs(a - b);
    if (gap > 24) return byId("tapestop");      // big gap → a hard, characterful cut
    if (gap > 12) return byId("echofade");
    if (gap < 3) return byId("doubledrop");     // near-identical → double drop is safe
    var pool = ["smooth", "filtersweep", "bassswap", "looproll", "journey", "chop"];
    // vary by minute so repeated taps aren't identical (no Math.random dependency)
    var pick = pool[(new Date().getSeconds()) % pool.length];
    return byId(pick);
  }
  function byId (id) {
    var all = ROUTINES.concat(AI_MODES);
    for (var k = 0; k < all.length; k++) if (all[k].id === id) return all[k];
    return ROUTINES[0];
  }

  /* ═══════════════ autonomous "AI DJ" modes ═══════════════
     These don't run a fixed script — the AI composes the transition live from a
     palette of primitive moves, weighted by the mode's personality and varied by
     a per-run seed, so each mix is different. Still only drives the real decks. */

  // seeded PRNG (avoids Math.random so runs are reproducible within a press)
  function makeRng (seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  // primitive moves — each takes (o, i, bt, rnd) and lasts a bar or two
  var MOVES = {
    bassSwap: async function (o, i, bt) { eqLo(i).value = -28; await sleep(bt * 2); eqLo(o).value = -28; eqLo(i).value = 0; await sleep(bt * 2); eqLo(o).value = 0; },
    echoBurst: async function (o, i, bt) { echo(o, 0.7); await sleep(bt * 2); await ramp(0.7, 0, bt * 2, function (v) { echo(o, v); }); },
    filterOpen: async function (o, i, bt) { filt(i, "lowpass", 300, 6); await ramp(300, 16000, bt * 4, function (v) { deck(i).filter.frequency.value = v; }); resetFilter(i); },
    filterClose: async function (o, i, bt) { filt(o, "highpass", 30, 6); await ramp(30, 6000, bt * 4, function (v) { deck(o).filter.frequency.value = v; }); resetFilter(o); },
    loopRoll: async function (o, i, bt) { deck(o).setLoop(2); await sleep(bt * 2); deck(o).setLoop(0); deck(o).setLoop(1); await sleep(bt * 2); deck(o).setLoop(0); },
    chop: async function (o, i, bt) { var oP = o === "A" ? 0 : 1, iP = 1 - oP; for (var k = 0; k < 8; k++) { if (cancelFlag) break; JB.setCrossfader(k % 2 ? iP : oP); await sleep(bt * 0.5); } },
    midScoop: async function (o, i, bt) { eqMid(o).value = -8; eqMid(i).value = -8; await sleep(bt * 3); eqMid(o).value = 0; eqMid(i).value = 0; },
    spinbackHit: async function (o, i, bt) { var d = deck(o); d.scratch(true); await ramp(0, -8, bt * 0.5, function (v) { d.scratchVel(v); }); d.scratchVel(0); d.scratch(false); },
    nudgeIn: async function (o, i, bt) { var half = (o === "A" ? 0 : 1) * 0.5 + 0.25; await ramp(JB.getCrossfader(), half, bt * 2, function (v) { JB.setCrossfader(v); }); },
    riser: async function (o, i, bt) { echo(i, 0.5); filt(i, "highpass", 30, 8); await ramp(30, 4000, bt * 4, function (v) { deck(i).filter.frequency.value = v; }); resetFilter(i); echo(i, 0); }
  };

  /* Compose a full transition live from the move palette. */
  async function compose (o, i, bt, opts) {
    var rnd = makeRng(opts.seed);
    var moves = opts.moves;
    ensurePlaying(i);
    // start where the outgoing deck holds the floor
    JB.setCrossfader(o === "A" ? 0 : 1);
    eqLo(i).value = opts.duckBass ? -22 : 0;

    var bars = opts.bars || 12;
    var steps = Math.max(2, opts.steps || 4);
    var xFrom = o === "A" ? 0 : 1, xTo = 0.5;
    // ramp the incoming in over the whole compose, punctuated by moves
    for (var s = 0; s < steps; s++) {
      if (cancelFlag) break;
      // advance the crossfader a notch toward the middle/incoming
      var frac = (s + 1) / steps;
      var target = xFrom + (( (o === "A" ? 1 : 0) ) - xFrom) * (0.45 * frac);
      await ramp(JB.getCrossfader(), target, bt * (bars / steps), function (v) { JB.setCrossfader(v); });
      // fire a personality-weighted move
      var m = moves[(rnd() * moves.length) | 0];
      if (MOVES[m]) { try { await MOVES[m](o, i, bt); } catch (e) {} }
      if (opts.duckBass && s === 0) await ramp(-22, 0, bt * 2, function (v) { eqLo(i).value = v; });
    }
    // resolve fully onto the incoming deck
    if (opts.duckBass) { await ramp(0, -22, bt * 2, function (v) { eqLo(o).value = v; }); }
    await ramp(JB.getCrossfader(), o === "A" ? 1 : 0, bt * 4, function (v) { JB.setCrossfader(v); });
    eqLo(o).value = 0;
  }

  var AI_MODES = [
    { id: "ai-freestyle",   name: "Freestyle",    desc: "The AI improvises a fresh blend every time.",         ai: true, bars: 12, steps: 4, duckBass: true,  moves: ["bassSwap", "echoBurst", "filterOpen", "loopRoll", "chop", "riser"] },
    { id: "ai-peaktime",    name: "Peak Time",    desc: "High-energy: drops, chops and bass swaps.",           ai: true, bars: 8,  steps: 4, duckBass: false, moves: ["chop", "bassSwap", "spinbackHit", "echoBurst"] },
    { id: "ai-warmup",      name: "Warm-Up",      desc: "Gentle, patient EQ blend for early sets.",            ai: true, bars: 16, steps: 4, duckBass: true,  moves: ["filterOpen", "midScoop", "nudgeIn", "bassSwap"] },
    { id: "ai-party",       name: "Party",        desc: "Loud & fun — echo throws and loop rolls.",            ai: true, bars: 10, steps: 5, duckBass: true,  moves: ["echoBurst", "loopRoll", "chop", "bassSwap"] },
    { id: "ai-minimal",     name: "Minimal",      desc: "Subtle filter work, long and hypnotic.",              ai: true, bars: 16, steps: 3, duckBass: true,  moves: ["filterOpen", "filterClose", "midScoop", "nudgeIn"] },
    { id: "ai-aggressive",  name: "Aggressive",   desc: "Hard cuts, spinbacks, no mercy.",                     ai: true, bars: 6,  steps: 4, duckBass: false, moves: ["spinbackHit", "chop", "echoBurst", "loopRoll"] },
    { id: "ai-radio",       name: "Radio",        desc: "Clean and quick, like a radio segue.",                ai: true, bars: 6,  steps: 3, duckBass: true,  moves: ["bassSwap", "filterClose", "nudgeIn"] },
    { id: "ai-festival",    name: "Festival",     desc: "Big builds and a huge blend.",                        ai: true, bars: 14, steps: 5, duckBass: true,  moves: ["riser", "loopRoll", "echoBurst", "bassSwap", "chop"] },
    { id: "ai-experiment",  name: "Experimental", desc: "Unpredictable — the AI gets weird.",                  ai: true, bars: 12, steps: 5, duckBass: false, moves: ["spinbackHit", "filterOpen", "echoBurst", "midScoop", "loopRoll", "chop", "riser"] },
    { id: "ai-autopilot",   name: "Auto-Pilot",   desc: "The AI reads the two tracks and does what fits.",     ai: true, bars: 12, steps: 4, duckBass: true,  moves: ["bassSwap", "filterOpen", "nudgeIn", "echoBurst"] }
  ];
  // give each AI mode a compose-driven run(); seed varies per press for freshness
  AI_MODES.forEach(function (mode) {
    mode.run = function (o, i, bt) {
      var seed = (new Date().getSeconds() * 2654435761) ^ (mode.id.length * 40503) ^ ((bpm("A") | 0) * 97 + (bpm("B") | 0));
      var opts = { seed: seed, bars: mode.bars, steps: mode.steps, duckBass: mode.duckBass, moves: mode.moves };
      // Auto-Pilot leans on the tempo gap to bias its energy
      if (mode.id === "ai-autopilot") { opts.bars = Math.abs(bpm("A") - bpm("B")) > 12 ? 8 : 14; }
      return compose(o, i, bt, opts);
    };
  });

  /* ── UI ── */
  function setBusyUI (busy, name) {
    var bar = document.getElementById("automix");
    if (bar) bar.classList.toggle("mixing", busy);
    var auto = document.getElementById("btn-automix");
    if (auto) { auto.classList.toggle("on", busy); auto.textContent = busy ? "◼ Stop mix" : "🤖 Auto-Mix"; }
    var status = document.getElementById("automix-status");
    if (status && name) status.textContent = "Mixing — " + name + "…";
    if (status && !busy) status.textContent = "";
  }

  // small labelled buttons: 10 technique routines + 10 autonomous AI modes
  function buildButtons () {
    var grid = document.getElementById("automix-grid");
    if (!grid) return;
    grid.innerHTML = "";
    function addGroup (label, list, cls) {
      var wrap = document.createElement("div");
      wrap.className = "am-group";
      var h = document.createElement("span");
      h.className = "am-group-label";
      h.textContent = label;
      wrap.appendChild(h);
      var row = document.createElement("div");
      row.className = "am-btns-row";
      list.forEach(function (rt) {
        var b = document.createElement("button");
        b.className = "am-mix-btn " + cls;
        b.textContent = rt.name;
        b.title = rt.desc;
        b.addEventListener("click", function () { maybeArmRecord(); play(rt); });
        row.appendChild(b);
      });
      wrap.appendChild(row);
      grid.appendChild(wrap);
    }
    addGroup("Techniques", ROUTINES, "tech");
    addGroup("🤖 AI DJ — the AI decides", AI_MODES, "ai");
  }

  /* If "record the mix" is checked, arm the session recorder before mixing. */
  function maybeArmRecord () {
    var chk = document.getElementById("automix-rec");
    if (chk && chk.checked && JB && !JB.recording()) JB.toggleRecord();
  }

  function boot (api) {
    JB = api;
    buildButtons();
    var auto = document.getElementById("btn-automix");
    if (auto) auto.addEventListener("click", function () {
      if (running) { stop(); return; }
      maybeArmRecord();
      play(smartPick());
    });
    // keyboard: M = smart auto-mix
    window.addEventListener("keydown", function (e) {
      if (e.repeat || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key.toLowerCase() === "m") { if (running) stop(); else { maybeArmRecord(); play(smartPick()); } }
    });
  }

  window.JBAutoMix = {
    boot: boot,
    play: play, stop: stop, smartPick: smartPick,
    routines: ROUTINES,
    aiModes: AI_MODES,
    isRunning: function () { return running; },
    beatmatch: beatmatch,
    _byId: byId
  };
})();
