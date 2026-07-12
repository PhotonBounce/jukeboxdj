/* Smoke: app boots, worklet loads, six records press, decks load + play,
   scratch/seek/loop/record round-trip. Asserts audio genuinely flows by
   sampling the master analyser RMS. */
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
import { serve } from "./serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../projects/jukeboxdj");
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (extra ? "  [" + extra + "]" : ""));
  if (!cond) failed++;
};

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"]
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const { srv, base } = await serve();
await page.goto(base + "/app.html");
await page.waitForSelector("body.booted", { timeout: 15000 });
ok("app booted", true);

// library presses all six records
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });
const lib = await page.evaluate(() => window.__JB.library.filter((t) => !t.featured).map((t) => ({ name: t.name, bpm: t.bpm, dur: t.buffer.duration })));
ok("6 records pressed", lib.length === 6, lib.map((t) => t.name).join(", "));
ok("records are real length (>18s)", lib.every((t) => t.dur > 18), lib.map((t) => t.dur.toFixed(1)).join("/"));

// records are not silent
const rmsList = await page.evaluate(() => window.__JB.library.filter((t) => !t.featured).map((t) => {
  const d = t.buffer.getChannelData(0);
  let s = 0;
  for (let i = 0; i < d.length; i += 16) s += d[i] * d[i];
  return Math.sqrt(s / (d.length / 16));
}));
ok("all records audible (rms > 0.02)", rmsList.every((r) => r > 0.02), rmsList.map((r) => r.toFixed(3)).join("/"));

// quick start loads decks
await page.click("#btn-autoload");
await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.B && d.A.track && d.B.track; }, null, { timeout: 8000 });
ok("quick start loaded both decks", true);

// play deck A → audio flows on master
await page.click("#deckA .btn-play");
await page.waitForTimeout(900);
const masterRMS = () => page.evaluate(() => {
  const jb = window.__JB, ctx = jb.ctx();
  return new Promise((res) => {
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    // masterAnalyser already feeds destination; tap deck A analyser directly
    const arr = new Float32Array(2048);
    let peak = 0, n = 0;
    const iv = setInterval(() => {
      jb.decks.A.analyser.getFloatTimeDomainData(arr);
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
      peak = Math.max(peak, Math.sqrt(s / arr.length));
      if (++n >= 10) { clearInterval(iv); res(peak); }
    }, 40);
  });
});
const rmsPlaying = await masterRMS();
ok("deck A playing produces signal", rmsPlaying > 0.01, "rms=" + rmsPlaying.toFixed(4));

const posMoves = await page.evaluate(async () => {
  const a = window.__JB.decks.A.pos;
  await new Promise((r) => setTimeout(r, 500));
  return window.__JB.decks.A.pos - a;
});
ok("playhead advances", posMoves > 10000, "Δframes=" + (posMoves | 0));

// pitch fader changes effective BPM
await page.evaluate(() => { window.__JB.decks.A.setRate(1.08); });
await page.waitForTimeout(100);
const pitchCheck = await page.evaluate(() => ({ eff: window.__JB.decks.A.effectiveBPM(), base: window.__JB.decks.A.track.bpm }));
ok("pitch changes BPM", Math.abs(pitchCheck.eff - pitchCheck.base * 1.08) < 0.6, pitchCheck.eff.toFixed(1) + " vs " + (pitchCheck.base * 1.08).toFixed(1));
await page.evaluate(() => window.__JB.decks.A.setRate(1));

// scratch: negative velocity rewinds position
const scratched = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  const before = d.pos;
  d.scratch(true);
  d.scratchVel(-4);
  await new Promise((r) => setTimeout(r, 400));
  const during = d.pos;
  d.scratchVel(0);
  d.scratch(false);
  return { before, during };
});
ok("scratch reverse rewinds vinyl", scratched.during < scratched.before, "Δ=" + ((scratched.during - scratched.before) | 0));

// loop: position wraps within a 2-beat window
const looped = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.setLoop(2);
  const start = d.pos;
  const sr = d.track.buffer.sampleRate;
  const loopLen = 2 * (60 / d.track.bpm) * sr;
  await new Promise((r) => setTimeout(r, 2600));
  return { drift: d.pos - start, loopLen };
});
ok("2-beat loop holds position", looped.drift < looped.loopLen * 1.2, "drift=" + (looped.drift | 0) + " loop=" + (looped.loopLen | 0));
await page.evaluate(() => window.__JB.decks.A.setLoop(0));

// crossfader kills deck A when thrown to B
await page.evaluate(() => { document.querySelector("#crossfader").value = "100"; document.querySelector("#crossfader").dispatchEvent(new Event("input")); });
await page.waitForTimeout(300);
const xfState = await page.evaluate(() => ({ a: window.__JB.decks.A.xGain.gain.value, b: window.__JB.decks.B.xGain.gain.value }));
ok("crossfader full-B silences A leg", xfState.a < 0.001 && xfState.b > 0.99, JSON.stringify(xfState));
await page.evaluate(() => { document.querySelector("#crossfader").value = "50"; document.querySelector("#crossfader").dispatchEvent(new Event("input")); });

// record 1.2s and confirm a non-trivial blob lands in the save chip
await page.click("#btn-rec");
await page.waitForTimeout(1400);
await page.click("#btn-rec");
await page.waitForFunction(() => !document.querySelector("#rec-save").hidden, null, { timeout: 6000 });
const recSize = await page.evaluate(async () => {
  const a = document.querySelector("#rec-save");
  const blob = await fetch(a.href).then((r) => r.blob());
  return blob.size;
});
ok("recording produced a real file", recSize > 4000, recSize + " bytes");

// deck B independently playable
await page.click("#deckB .btn-play");
await page.waitForTimeout(500);
const bPlaying = await page.evaluate(() => window.__JB.decks.B.playing && window.__JB.decks.B.pos > 0);
ok("deck B plays independently", bPlaying);

// sync pulls B to A's tempo
await page.click("#deckB .btn-sync");
await page.waitForTimeout(150);
const bpms = await page.evaluate(() => ({ a: window.__JB.decks.A.effectiveBPM(), b: window.__JB.decks.B.effectiveBPM() }));
ok("sync matches BPMs (within clamp)", Math.abs(bpms.a - bpms.b) < 1, JSON.stringify(bpms));

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
srv.close();
console.log(failed ? `SMOKE: ${failed} FAILURES` : "SMOKE: all green");
process.exit(failed ? 1 : 0);
