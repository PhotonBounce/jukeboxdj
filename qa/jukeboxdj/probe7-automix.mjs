/* Adversarial probe 7 — Auto-Mix abuse: back-to-back routines, auto-mix while
   the user is scratching, start/stop spam, auto-mix with a decks swap mid-run,
   and running every one of the 10 routines once. Audio graph must stay alive
   and playheads finite throughout. */
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

const reset = () => page.evaluate(async () => {
  const jb = window.__JB;
  await jb.ensureAudio();
  await jb.loadToDeck("A", jb.library[0]); await jb.loadToDeck("B", jb.library[3]);
  if (!jb.decks.A.playing) jb.decks.A.togglePlay();
  if (jb.decks.B.playing) jb.decks.B.togglePlay();
  jb.setCrossfader(0);
});

// start/stop spam
await reset();
await page.evaluate(async () => {
  for (let i = 0; i < 15; i++) {
    window.JBAutoMix.play(window.JBAutoMix._byId("journey"));
    window.JBAutoMix.stop();
  }
});
await page.waitForFunction(() => !window.JBAutoMix.isRunning(), null, { timeout: 12000 });
ok("start/stop spam settles (not running)", !(await page.evaluate(() => window.JBAutoMix.isRunning())));

// auto-mix while scratching deck A
await reset();
const scratchMix = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.scratch(true); d.scratchVel(-3);
  const p = window.JBAutoMix.play(window.JBAutoMix._byId("bassswap"));
  await new Promise((r) => setTimeout(r, 300));
  d.scratchVel(0); d.scratch(false);
  await p;
  return { finite: Number.isFinite(d.pos), x: window.__JB.getCrossfader() };
});
ok("auto-mix survives a concurrent scratch", scratchMix.finite && scratchMix.x > 0.9, JSON.stringify({ x: scratchMix.x.toFixed(2) }));

// swap the incoming record mid-mix
await reset();
const swapMid = await page.evaluate(async () => {
  const jb = window.__JB;
  const p = window.JBAutoMix.play(window.JBAutoMix._byId("smooth"));
  await new Promise((r) => setTimeout(r, 400));
  jb.loadToDeck("B", jb.library[4]);   // change B while it's being mixed in
  await new Promise((r) => setTimeout(r, 400));
  window.JBAutoMix.stop();
  await p;
  return { finite: Number.isFinite(jb.decks.B.pos), running: window.JBAutoMix.isRunning() };
});
ok("swapping the incoming record mid-mix stays sane", swapMid.finite && !swapMid.running);

// run every routine once, back to back (short/long alike), bounded per routine
const ids = await page.evaluate(() => window.JBAutoMix.routines.map((r) => r.id));
let allFinite = true;
for (const id of ids) {
  await reset();
  const st = await page.evaluate(async (rid) => {
    // cap runtime: kick it, let it run briefly, then stop so long routines don't stall the probe
    const p = window.JBAutoMix.play(window.JBAutoMix._byId(rid));
    await new Promise((r) => setTimeout(r, 1500));
    window.JBAutoMix.stop();
    await p;
    return { finite: Number.isFinite(window.__JB.decks.A.pos) && Number.isFinite(window.__JB.decks.B.pos), ctx: window.__JB.ctx().state };
  }, id);
  if (!st.finite || st.ctx !== "running") { allFinite = false; console.log("    ✗ routine " + id + " → " + JSON.stringify(st)); }
}
ok("all 10 routines run without corrupting state", allFinite);

// context still alive + audible
await reset();
await page.waitForTimeout(600);
const alive = await page.evaluate(() => new Promise((res) => {
  const an = window.__JB.decks.A.analyser, arr = new Float32Array(an.fftSize);
  let peak = 0, n = 0;
  const iv = setInterval(() => {
    an.getFloatTimeDomainData(arr);
    let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    peak = Math.max(peak, Math.sqrt(s / arr.length));
    if (++n >= 8) { clearInterval(iv); res({ rms: peak, ctx: window.__JB.ctx().state }); }
  }, 50);
}));
ok("audio alive after the whole probe", alive.rms > 0.01 && alive.ctx === "running", "rms=" + alive.rms.toFixed(3));
ok("no page errors during auto-mix abuse", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
srv.close();
console.log(failed ? `PROBE7: ${failed} FAILURES` : "PROBE7: auto-mix holds");
process.exit(failed ? 1 : 0);
