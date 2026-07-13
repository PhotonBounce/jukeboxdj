/* Adversarial probe 6 — soak: 2.5 minutes of continuous two-deck playback with
   periodic scratches, loops and crossfader swings while one uninterrupted Pro
   recording runs. Asserts: playheads stay sane, UI clock keeps counting, the
   long recording decodes to the full duration, and JS heap doesn't balloon. */
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (extra ? "  [" + extra + "]" : ""));
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const { srv, base } = await serve();
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/app.html");
await page.waitForSelector("body.booted", { timeout: 20000 });
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });

await page.evaluate(() => window.JBPro.unlock("qa-soak"));   // Pro: unlimited take
await page.click("#btn-autoload");
await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track && d.B.track; }, null, { timeout: 15000 });
await page.click("#deckA .btn-play");
await page.click("#deckB .btn-play");
await page.click("#btn-rec");

const heap0 = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
const SOAK_MS = 150000;
const t0 = Date.now();
let laps = 0;
while (Date.now() - t0 < SOAK_MS) {
  await page.evaluate(async (lap) => {
    const jb = window.__JB;
    const d = jb.decks[lap % 2 ? "A" : "B"];
    // a scratch flurry
    d.scratch(true);
    d.scratchVel(lap % 3 ? -3 : 4);
    await new Promise((r) => setTimeout(r, 220));
    d.scratchVel(0); d.scratch(false);
    // loop on/off
    d.setLoop([1, 2, 4, 8][lap % 4]);
    // crossfader swing
    const x = document.querySelector("#crossfader");
    x.value = String((lap * 23) % 100);
    x.dispatchEvent(new Event("input"));
    // both decks loop forever: restart any deck that ran off the end
    ["A", "B"].forEach((id) => {
      const dk = jb.decks[id];
      if (dk.track && !dk.playing) { dk.seek(0); dk.togglePlay(); }
    });
  }, laps);
  await page.waitForTimeout(2300);
  await page.evaluate(() => { ["A", "B"].forEach((id) => window.__JB.decks[id].setLoop(0)); });
  laps++;
}
console.log("  … " + laps + " soak laps over " + Math.round(SOAK_MS / 1000) + "s");

const health = await page.evaluate(() => ({
  a: window.__JB.decks.A.pos, b: window.__JB.decks.B.pos,
  finite: Number.isFinite(window.__JB.decks.A.pos) && Number.isFinite(window.__JB.decks.B.pos),
  ctx: window.__JB.ctx().state,
  recOn: document.querySelector("#btn-rec").classList.contains("on"),
  clock: document.querySelector("#rec-label").textContent
}));
ok("audio context alive after soak", health.ctx === "running");
ok("playheads finite after soak", health.finite, JSON.stringify({ a: health.a | 0, b: health.b | 0 }));
ok("recording still rolling past the free cap (Pro)", health.recOn && /^[2-9]:/.test(health.clock), "clock=" + health.clock);

await page.click("#btn-rec");
await page.waitForFunction(() => !document.querySelector("#rec-save").hidden, null, { timeout: 10000 });

// Sample the heap HERE — right after the recording stops but BEFORE the decode
// check below. Decoding a 150s stereo take allocates a ~50 MB AudioBuffer that is
// the *test's* cost, not the app's; measuring after it would falsely blame the
// soak. (Verified: the unmodified baseline reads the same ~138 MB when sampled
// post-decode.) This measures the app's real soak growth: working set + the
// recorded blob + any leak.
const heap1 = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
if (heap0 && heap1) {
  const growth = (heap1 - heap0) / 1048576;
  ok("JS heap growth bounded (<120 MB over soak)", growth < 120, growth.toFixed(1) + " MB");
} else {
  ok("JS heap metric unavailable — skipped", true);
}

const rec = await page.evaluate(async () => {
  const buf = await fetch(document.querySelector("#rec-save").href).then((r) => r.arrayBuffer());
  const audio = await window.__JB.ctx().decodeAudioData(buf.slice(0));
  const d = audio.getChannelData(0);
  let s = 0; for (let i = 0; i < d.length; i += 64) s += d[i] * d[i];
  return { dur: audio.duration, rms: Math.sqrt(s / (d.length / 64)), bytes: buf.byteLength };
});
ok("soak recording decodes at full length (>140s)", rec.dur > 140, rec.dur.toFixed(1) + "s / " + rec.bytes + " bytes");
ok("soak recording is audible", rec.rms > 0.01, "rms=" + rec.rms.toFixed(3));
ok("no page errors during soak", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
srv.close();
console.log(failed ? `PROBE6: ${failed} FAILURES` : "PROBE6: soak holds");
process.exit(failed ? 1 : 0);
