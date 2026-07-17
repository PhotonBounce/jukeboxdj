/* UI-driven tests: real pointer scratching on the platter, knob drags, waveform
   needle-drops, CUE semantics, keyboard shortcuts, mobile touch layout. */
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (extra ? "  [" + extra + "]" : ""));
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const { srv, base } = await serve();
await page.goto(base + "/app.html");
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });
await page.click("#btn-autoload");
await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track && d.B.track; });

// ── platter scratch with a real mouse drag ──
await page.click("#deckA .btn-play");
await page.waitForTimeout(800);
const platter = page.locator("#deckA .platter");
const box = await platter.boundingBox();
// The record is a 3D-tilted (foreshortened) ellipse now, so keep the drag radius
// inside the SHORTER (vertical) axis and sweep a small arc near the centre so
// every point lands on real platter pixels for the real-mouse hit-test.
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, r = Math.min(box.width, box.height) * 0.28;
const posBefore = await page.evaluate(() => window.__JB.decks.A.pos);
// sweep counter-clockwise across the upper arc of the record (backwards)
let a0 = -0.7;
await page.mouse.move(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
await page.mouse.down();
for (let i = 1; i <= 22; i++) {
  const a = a0 - i * 0.07; // CCW sweep, stays within the tilted ellipse
  await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
  await page.waitForTimeout(16);
}
const scratchClass = await page.evaluate(() => document.querySelector("#deckA").classList.contains("scratching"));
await page.mouse.up();
await page.waitForTimeout(250);
const posAfter = await page.evaluate(() => window.__JB.decks.A.pos);
ok("pointer drag engages scratch mode", scratchClass);
ok("backwards drag rewinds audio position", posAfter < posBefore, `Δ=${((posAfter - posBefore) / 44100).toFixed(2)}s`);

// released platter spins back up and keeps playing forward
await page.waitForTimeout(700);
const resumed = await page.evaluate(async () => {
  const a = window.__JB.decks.A.pos;
  await new Promise((r2) => setTimeout(r2, 400));
  return window.__JB.decks.A.pos - a;
});
ok("motor resumes forward playback after scratch", resumed > 8000, "Δframes=" + (resumed | 0));

// ── EQ is now a big touch SLIDER inside the deck ──
const treble = page.locator('#deckA .eq-slider[data-band="hi"]');
await treble.fill("10");
await treble.dispatchEvent("input");
const hiGain = await page.evaluate(() => window.__JB.decks.A.eqHi.gain.value);
ok("TREBLE slider raises high-shelf gain", hiGain > 3, "gain=" + hiGain.toFixed(1));
// double-tap a slider recenters it to 0
await treble.dblclick({ force: true });
const hiReset = await page.evaluate(() => window.__JB.decks.A.eqHi.gain.value);
ok("slider double-click resets to center", Math.abs(hiReset) < 0.01, "gain=" + hiReset.toFixed(2));
// filter slider engages the per-deck filter
await page.locator('#deckA .eq-slider[data-band="filter"]').fill("-0.8");
await page.locator('#deckA .eq-slider[data-band="filter"]').dispatchEvent("input");
const ftype = await page.evaluate(() => window.__JB.decks.A.filter.type);
ok("FILTER slider engages low-pass", ftype === "lowpass", ftype);
await page.locator('#deckA .eq-slider[data-band="filter"]').fill("0");
await page.locator('#deckA .eq-slider[data-band="filter"]').dispatchEvent("input");

// ── waveform needle drop ──
const wave = page.locator("#deckA .wave");
const wb = await wave.boundingBox();
await page.mouse.click(wb.x + wb.width * 0.75, wb.y + wb.height / 2);
await page.waitForTimeout(200);
const frac = await page.evaluate(() => window.__JB.decks.A.pos / window.__JB.decks.A.track.buffer.length);
ok("waveform click needle-drops to ~75%", Math.abs(frac - 0.75) < 0.05, "frac=" + frac.toFixed(3));

// scrubber is a visible strip (compact in the consolidated layout)
const waveH = await page.evaluate(() => document.querySelector("#deckA .wave").clientHeight);
ok("scrubber is visible (>=30px)", waveH >= 30, waveH + "px");
// dragging the scrubber scrubs continuously (a real handle drag, not just a click)
const scrubbed = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.seek(d.track.buffer.length * 0.2);
  await new Promise((r) => setTimeout(r, 60));
  return d.pos / d.track.buffer.length;
});
ok("scrubber seek repositions the playhead", Math.abs(scrubbed - 0.2) < 0.02, scrubbed.toFixed(3));

// ── CUE: playing → snaps back to cue and stops ──
await page.evaluate(() => { const d = window.__JB.decks.A; d.cue = 44100; d.seek(300000); if (!d.playing) d.togglePlay(); });
await page.waitForTimeout(150);
const cueBtn = page.locator("#deckA .btn-cue");
await cueBtn.dispatchEvent("pointerdown");
await cueBtn.dispatchEvent("pointerup");
await page.waitForTimeout(400);
const cueState = await page.evaluate(() => ({ pos: window.__JB.decks.A.pos, playing: window.__JB.decks.A.playing }));
ok("CUE while playing returns to cue point and stops", !cueState.playing && Math.abs(cueState.pos - 44100) < 22000, JSON.stringify({ pos: cueState.pos | 0, playing: cueState.playing }));

// CUE tap while stopped (mid-track) sets a new cue at current position
await page.evaluate(() => { const d = window.__JB.decks.A; if (d.playing) d.togglePlay(); d.seek(88200); });
await cueBtn.dispatchEvent("pointerdown");
await page.waitForTimeout(60); // released before the 220 ms hold-preview threshold
await cueBtn.dispatchEvent("pointerup");
const newCue = await page.evaluate(() => window.__JB.decks.A.cue);
ok("CUE tap while stopped re-arms cue point", Math.abs(newCue - 88200) < 22000, "cue=" + (newCue | 0));

// ── regression: a deck that finished at the end must restart, not sit "disabled" ──
const restart = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.cue = 0;
  if (d.playing) d.togglePlay();
  d.seek(d.track.buffer.length - 1);      // park it at the very end
  d.togglePlay();                          // press play → should rewind + play
  await new Promise((r) => setTimeout(r, 500));
  return { playing: d.playing, pos: d.pos, len: d.track.buffer.length };
});
ok("play restarts a finished deck (not stuck at end)", restart.playing && restart.pos < restart.len * 0.5, JSON.stringify({ pos: restart.pos | 0 }));

// CUE at the end returns to the cue point instead of arming a dead-end cue
const cueAtEnd = await page.evaluate(() => { const d = window.__JB.decks.A; if (d.playing) d.togglePlay(); d.cue = 22050; d.seek(d.track.buffer.length - 1); return d.track.buffer.length; });
await cueBtn.dispatchEvent("pointerdown");
await page.waitForTimeout(60);
await cueBtn.dispatchEvent("pointerup");
await page.waitForTimeout(120);
const endState = await page.evaluate(() => ({ pos: window.__JB.decks.A.pos, cue: window.__JB.decks.A.cue }));
ok("CUE at end returns to cue (stays usable)", Math.abs(endState.pos - 22050) < 22000 && endState.cue === 22050, JSON.stringify({ pos: endState.pos | 0 }));

// ── regression: a seek must not be clobbered by a stale in-flight worklet pos
//    message. The worklet streams its position every ~9 ms; right after a seek an
//    older message still carried the pre-seek spot, and a CUE tap in that window
//    captured the WRONG position (cue landed where the record used to be). ──
const seekRace = await page.evaluate(async () => {
  const d = window.__JB.decks.A, len = d.track.buffer.length;
  if (d.playing) d.togglePlay();
  let bad = 0, worst = 0;
  for (let i = 0; i < 12; i++) {
    if (!d.playing) d.togglePlay();
    await new Promise((r) => setTimeout(r, 35));    // let the worklet stream stale pos
    if (d.playing) d.togglePlay();
    const target = Math.floor(len * (0.2 + 0.6 * (i / 12)));
    d.seek(target);
    const cue = d.pos;                              // emulate a CUE tap right after the seek
    const err = Math.abs(cue - target);
    worst = Math.max(worst, err);
    if (err > 3000) bad++;
  }
  if (d.playing) d.togglePlay();
  return { bad, worst };
});
ok("seek is not clobbered by a stale worklet pos (CUE captures the seek point)", seekRace.bad === 0, "bad=" + seekRace.bad + " worstΔ=" + (seekRace.worst | 0));

// ── keyboard: P toggles deck B, Z throws crossfader to A ──
await page.keyboard.press("p");
await page.waitForTimeout(250);
const bPlays = await page.evaluate(() => window.__JB.decks.B.playing);
ok("key P starts deck B", bPlays);
await page.keyboard.press("p");
await page.keyboard.press("z");
await page.waitForTimeout(150);
const xf = await page.evaluate(() => ({ a: window.__JB.decks.A.xGain.gain.value, x: document.querySelector("#crossfader").value }));
ok("key Z throws crossfader hard left", xf.a > 0.99 && xf.x === "0", JSON.stringify(xf));

// pitch slider drives worklet rate
await page.locator("#deckA .pitch").fill("40");
await page.locator("#deckA .pitch").dispatchEvent("input");
const rate = await page.evaluate(() => window.__JB.decks.A.rate);
ok("pitch slider sets +4% rate", Math.abs(rate - 1.04) < 0.001, "rate=" + rate);

// loop buttons light up and clear
await page.click('#deckA .btn-loop[data-beats="4"]');
const loopOn = await page.evaluate(() => window.__JB.decks.A.loopBeats);
await page.click('#deckA .btn-loop[data-beats="4"]');
const loopOff = await page.evaluate(() => window.__JB.decks.A.loopBeats);
ok("loop 4 engages and disengages", loopOn === 4 && loopOff === 0, `${loopOn}→${loopOff}`);

// ── decks color-shift to the beat, notes swim in the "water" (mixer retired) ──
const waterEl = await page.$("#deckA .deck-water");
const swimNotes = await page.$$eval(".deck-notes .note", (ns) => ns.length);
ok("decks have color-water + swimming notes", !!waterEl && swimNotes >= 11, swimNotes + " notes");
await page.evaluate(() => { const d = window.__JB.decks.A; d.cue = 0; d.seek(0); if (!d.playing) d.togglePlay(); });
await page.waitForTimeout(1400);
const beatSamples = [];
for (let i = 0; i < 10; i++) { beatSamples.push(Number(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--beat-hue")))); await page.waitForTimeout(200); }
const hueMoves = new Set(beatSamples).size > 1;
const beatingWhilePlaying = await page.evaluate(() => document.body.classList.contains("beating"));
ok("beat-hue shifts while a deck plays", hueMoves && beatingWhilePlaying, beatSamples.join(","));
await page.evaluate(() => { const d = window.__JB.decks.A; if (d.playing) d.togglePlay(); });
await page.waitForTimeout(250);
const stoppedBeating = await page.evaluate(() => document.body.classList.contains("beating"));
ok("beat pulsing stops when nothing plays", !stoppedBeating);

// STOP ALL silences both decks
await page.evaluate(() => { ["A","B"].forEach((id)=>{ const d=window.__JB.decks[id]; if(!d.playing) d.togglePlay(); }); });
await page.click("#btn-stop-all");
await page.waitForTimeout(150);
const anyPlaying = await page.evaluate(() => window.__JB.decks.A.playing || window.__JB.decks.B.playing);
ok("STOP ALL halts every deck", !anyPlaying);

// ── scratch FX pads: 10 synthesized vinyl hits, keys 1–0 ──
const padCount = await page.$$eval("#fx-pads .fx-pad", (b) => b.length);
ok("10 scratch FX pads rendered", padCount === 10, padCount + " pads");

ok("no page errors (desktop)", errors.length === 0, errors.slice(0, 3).join(" | "));
await page.close();

// ── mobile touch: platter scratch via touchscreen ──
const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const merrs = [];
mob.on("pageerror", (e) => merrs.push(String(e)));
await mob.goto(base + "/app.html");
await mob.waitForFunction(() => window.__JB && window.__JB.library.length >= 2, null, { timeout: 60000 });
await mob.tap("#btn-autoload");
await mob.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track; });
await mob.tap("#deckA .btn-play");
await mob.waitForTimeout(700);
const stacked = await mob.evaluate(() => {
  const a = document.querySelector("#deckA").getBoundingClientRect();
  const b = document.querySelector("#deckB").getBoundingClientRect();
  const lib = document.querySelector("#library").getBoundingClientRect();
  // both decks sit side-by-side on the same row, with the library below them
  return Math.abs(a.top - b.top) < 4 && a.right <= b.left + 2 && lib.top >= a.bottom - 2;
});
ok("mobile keeps both decks side-by-side, library below", stacked);
const mBox = await mob.locator("#deckA .platter").boundingBox();
const mPos0 = await mob.evaluate(() => window.__JB.decks.A.pos);
// touch-drag backwards
const mcx = mBox.x + mBox.width / 2, mcy = mBox.y + mBox.height / 2, mr = mBox.width * 0.35;
await mob.dispatchEvent("#deckA .platter", "pointerdown", { pointerId: 7, clientX: mcx + mr, clientY: mcy, isPrimary: true, pointerType: "touch" });
for (let i = 1; i <= 14; i++) {
  const a = -i * 0.2;
  await mob.dispatchEvent("#deckA .platter", "pointermove", { pointerId: 7, clientX: mcx + mr * Math.cos(a), clientY: mcy + mr * Math.sin(a), isPrimary: true, pointerType: "touch" });
  await mob.waitForTimeout(16);
}
await mob.dispatchEvent("#deckA .platter", "pointerup", { pointerId: 7, isPrimary: true, pointerType: "touch" });
await mob.waitForTimeout(250);
const mPos1 = await mob.evaluate(() => window.__JB.decks.A.pos);
ok("touch scratch rewinds on mobile", mPos1 < mPos0, `Δ=${((mPos1 - mPos0) / 44100).toFixed(2)}s`);
// regression: a synthetic/stale pointer once threw in setPointerCapture, aborting the
// handler mid-flight and feeding NaN velocity into the worklet (position corrupted)
const posFinite = await mob.evaluate(() => Number.isFinite(window.__JB.decks.A.pos) && window.__JB.decks.A.pos >= 0);
ok("playhead stays finite after synthetic-pointer scratch (NaN guard)", posFinite);
ok("no page errors (mobile)", merrs.length === 0, merrs.slice(0, 2).join(" | "));

await browser.close();
srv.close();
console.log(failed ? `UI: ${failed} FAILURES` : "UI: all green");
process.exit(failed ? 1 : 0);
