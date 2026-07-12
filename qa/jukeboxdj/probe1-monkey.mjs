/* Adversarial probe 1 — monkey chaos: 45 seconds of random UI mashing
   (buttons, sliders, platter grabs, library loads, record toggles) while both
   decks play. Pass = no page errors, audio graph alive, playheads finite. */
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
await page.click("#deckA .btn-play");
await page.click("#deckB .btn-play");

let rng = 1337;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const clickables = [
  "#deckA .btn-play", "#deckB .btn-play", "#deckA .btn-cue", "#deckB .btn-cue",
  "#deckA .btn-sync", "#deckB .btn-sync", "#btn-rec", "#btn-autoload", "#btn-stop-all",
  "#deckA .btn-rand", "#deckB .btn-rand", "#deckA .hc-pad", '#deckB .hc-pad[data-i="1"]',
  '#deckA .btn-loop[data-beats="2"]', '#deckB .btn-loop[data-beats="4"]',
  ".lib-row:nth-child(2) .to-a", ".lib-row:nth-child(5) .to-b", ".lib-row:nth-child(3) .to-a"
];
const sliders = ["#crossfader", "#master-gain", "#deckA .chan-fader", "#deckB .chan-fader",
  "#deckA .pitch", "#deckB .pitch",
  '#deckA .eq-slider[data-band="lo"]', '#deckA .eq-slider[data-band="hi"]',
  '#deckB .eq-slider[data-band="mid"]', '#deckA .eq-slider[data-band="filter"]'];
const keys = ["q", "p", "z", "x", "c"];

const t0 = Date.now();
let actions = 0;
while (Date.now() - t0 < 45000) {
  const roll = rand();
  try {
    if (roll < 0.42) {
      await page.click(clickables[(rand() * clickables.length) | 0], { timeout: 900, force: true });
    } else if (roll < 0.62) {
      const sel = sliders[(rand() * sliders.length) | 0];
      const el = page.locator(sel);
      const min = Number(await el.getAttribute("min")), max = Number(await el.getAttribute("max"));
      await el.fill(String(Math.round(min + rand() * (max - min))));
      await el.dispatchEvent("input");
    } else if (roll < 0.80) {
      // grab a platter and yank it randomly
      const deck = rand() < 0.5 ? "#deckA" : "#deckB";
      const b = await page.locator(deck + " .platter").boundingBox();
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2, r = b.width * (0.2 + rand() * 0.25);
      await page.mouse.move(cx + r, cy);
      await page.mouse.down();
      let a = 0;
      for (let i = 0; i < 6; i++) {
        a += (rand() - 0.45) * 1.4;
        await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
        await page.waitForTimeout(12);
      }
      await page.mouse.up();
    } else if (roll < 0.92) {
      await page.keyboard.press(keys[(rand() * keys.length) | 0]);
    } else {
      // drag a random knob
      const knobs = ['#deckA .eq-slider[data-band="hi"]', '#deckB .eq-slider[data-band="mid"]', '#deckA .eq-slider[data-band="lo"]', '#deckA .eq-slider[data-band="filter"]', '#deckB .eq-slider[data-band="filter"]', "#deckA .chan-fader", "#deckB .chan-fader"];
      const kb = await page.locator(knobs[(rand() * knobs.length) | 0]).boundingBox();
      await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
      await page.mouse.down();
      await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2 + (rand() - 0.5) * 140, { steps: 4 });
      await page.mouse.up();
    }
    actions++;
  } catch (e) { /* individual mis-clicks (covered elements etc.) are fine */ }
}
console.log("  … " + actions + " chaotic actions performed");

const state = await page.evaluate(() => {
  const jb = window.__JB, ctx = jb.ctx();
  return {
    ctxState: ctx.state,
    posA: jb.decks.A.pos, posB: jb.decks.B.pos,
    finite: Number.isFinite(jb.decks.A.pos) && Number.isFinite(jb.decks.B.pos)
      && Number.isFinite(jb.decks.A.xGain.gain.value) && Number.isFinite(window.__JB.decks.B.xGain.gain.value),
    lib: jb.library.length
  };
});
ok("audio context still running", state.ctxState === "running", state.ctxState);
ok("playheads and gains finite after chaos", state.finite, JSON.stringify({ a: state.posA | 0, b: state.posB | 0 }));
ok("library intact", state.lib >= 6, "n=" + state.lib);

// after chaos, the rig still works end-to-end: reset the WHOLE channel strip to
// neutral, play, hear signal. A monkey-thrown filter (extreme high-pass) or a
// killed 3-band EQ legitimately silences a deck — that's correct DJ behaviour —
// so a faithful "reset to neutral" must clear the filter + EQ too, not just the
// fader/crossfader/master. (Verified: extreme filter → ~0 rms, neutral → audible.)
await page.evaluate(() => {
  const jb = window.__JB;
  ["A", "B"].forEach((id) => {
    const d = jb.decks[id];
    if (d.playing) d.togglePlay();
    d.setLoop(0); d.setRate(1);
    d.filter.type = "allpass"; d.filter.frequency.value = 1000; d.filter.Q.value = 0.8;
    d.eqHi.gain.value = 0; d.eqMid.gain.value = 0; d.eqLo.gain.value = 0;
    d.chanGain.gain.value = 1; d.echoSend.gain.value = 0;
    d.seek(Math.floor(d.track.buffer.length * 0.15));  // land past any quiet intro
  });
  document.querySelector("#crossfader").value = "50"; document.querySelector("#crossfader").dispatchEvent(new Event("input"));
  document.querySelector("#master-gain").value = "80"; document.querySelector("#master-gain").dispatchEvent(new Event("input"));
  jb.decks.A.togglePlay();
});
await page.waitForTimeout(800);
const aliveRms = await page.evaluate(() => new Promise((res) => {
  const an = window.__JB.decks.A.analyser, arr = new Float32Array(an.fftSize);
  let peak = 0, n = 0;
  const iv = setInterval(() => {
    an.getFloatTimeDomainData(arr);
    let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    peak = Math.max(peak, Math.sqrt(s / arr.length));
    if (++n >= 8) { clearInterval(iv); res(peak); }
  }, 50);
}));
ok("deck still audible after chaos", aliveRms > 0.01, "rms=" + aliveRms.toFixed(4));
ok("no page errors during 45s monkey run", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
srv.close();
console.log(failed ? `PROBE1: ${failed} FAILURES` : "PROBE1: survived the monkey");
process.exit(failed ? 1 : 0);
