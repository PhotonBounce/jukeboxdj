/* AI Auto-Mix suite: 10 routines exist, beatmatch + phase-align work, several
   full routines complete leaving the crossfader on the incoming deck and the
   mixer neutralized, the "record the mix" toggle arms the recorder, stop()
   cancels a long routine, and it refuses to mix without both decks loaded. */
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

const routines = await page.evaluate(() => window.JBAutoMix.routines.map((r) => ({ id: r.id, name: r.name })));
ok("exactly 10 mix routines", routines.length === 10, routines.map((r) => r.name).join(", "));
ok("routine ids unique", new Set(routines.map((r) => r.id)).size === 10);

// refuse to mix with only one deck loaded
await page.evaluate(() => window.__JB.loadToDeck("A", window.__JB.library[0]));
const refused = await page.evaluate(() => window.JBAutoMix.play(window.JBAutoMix.routines[0]));
ok("refuses to mix without both decks", refused === false);

// load two DIFFERENT-tempo tracks and beat-match
await page.evaluate(() => { window.__JB.loadToDeck("A", window.__JB.library[0]); window.__JB.loadToDeck("B", window.__JB.library[2]); }); // 124 vs 140
await page.evaluate(() => window.__JB.decks.A.togglePlay());
const bm = await page.evaluate(() => {
  window.JBAutoMix.beatmatch("A", "B");
  return { a: window.__JB.decks.A.effectiveBPM(), b: window.__JB.decks.B.effectiveBPM() };
});
ok("beatmatch pulls incoming to outgoing tempo", Math.abs(bm.a - bm.b) < 1.0, JSON.stringify({ a: bm.a.toFixed(1), b: bm.b.toFixed(1) }));

// helper: run a routine to completion (bounded wait), report end state
async function runRoutine (id, timeout) {
  await page.evaluate(() => { // reset onto A, playing, cross at 0
    const jb = window.__JB;
    jb.loadToDeck("A", jb.library[0]); jb.loadToDeck("B", jb.library[3]);
    if (!jb.decks.A.playing) jb.decks.A.togglePlay();
    if (jb.decks.B.playing) jb.decks.B.togglePlay();
    jb.setCrossfader(0);
  });
  await page.waitForTimeout(150);
  const done = await page.evaluate((rid) => window.JBAutoMix.play(window.JBAutoMix._byId(rid)), id);
  return page.evaluate(() => ({
    x: window.__JB.getCrossfader(),
    bPlaying: window.__JB.decks.B.playing,
    finiteA: Number.isFinite(window.__JB.decks.A.pos),
    finiteB: Number.isFinite(window.__JB.decks.B.pos),
    eqNeutral: ["A", "B"].every((id2) => {
      const d = window.__JB.decks[id2];
      return Math.abs(d.eqLo.gain.value) < 0.01 && Math.abs(d.eqMid.gain.value) < 0.01 && Math.abs(d.eqHi.gain.value) < 0.01 && d.echoSend.gain.value < 0.01;
    })
  }));
}

// three representative SHORT routines run fully (spinback ~2 bars, bassswap/chop ~4 bars)
for (const id of ["spinback", "bassswap", "chop"]) {
  const s = await runRoutine(id, 20000);
  ok(`routine "${id}" ends on incoming deck B`, s.x > 0.98 && s.bPlaying, JSON.stringify({ x: s.x.toFixed(2), b: s.bPlaying }));
  ok(`routine "${id}" leaves playheads finite`, s.finiteA && s.finiteB);
  ok(`routine "${id}" neutralizes the mixer`, s.eqNeutral);
}

// "record the mix" checkbox arms the session recorder when Auto-Mix starts
await page.evaluate(() => {
  const jb = window.__JB;
  jb.loadToDeck("A", jb.library[0]); jb.loadToDeck("B", jb.library[3]);
  if (!jb.decks.A.playing) jb.decks.A.togglePlay();
  document.querySelector("#automix-rec").checked = true;
});
await page.click("#btn-automix");        // smart pick + should arm recorder
await page.waitForTimeout(600);
const recArmed = await page.evaluate(() => window.__JB.isRecording());
ok("'Record the mix' arms the recorder on Auto-Mix", recArmed);
await page.evaluate(() => { window.JBAutoMix.stop(); });
await page.waitForFunction(() => !window.JBAutoMix.isRunning(), null, { timeout: 8000 });
if (await page.evaluate(() => window.__JB.isRecording())) await page.click("#btn-rec"); // stop rec
await page.evaluate(() => { document.querySelector("#automix-rec").checked = false; });

// stop() cancels a long routine and neutralizes
await page.evaluate(() => {
  const jb = window.__JB;
  jb.loadToDeck("A", jb.library[0]); jb.loadToDeck("B", jb.library[3]);
  if (!jb.decks.A.playing) jb.decks.A.togglePlay();
  if (jb.decks.B.playing) jb.decks.B.togglePlay();
  window.JBAutoMix.play(window.JBAutoMix._byId("journey"));
});
await page.waitForTimeout(1200);
const runningMid = await page.evaluate(() => window.JBAutoMix.isRunning());
await page.evaluate(() => window.JBAutoMix.stop());
await page.waitForFunction(() => !window.JBAutoMix.isRunning(), null, { timeout: 12000 });
const afterStop = await page.evaluate(() => ({
  running: window.JBAutoMix.isRunning(),
  neutral: ["A", "B"].every((id) => { const d = window.__JB.decks[id]; return Math.abs(d.eqLo.gain.value) < 0.01 && d.echoSend.gain.value < 0.01; })
}));
ok("long routine was running then stop() cancels it", runningMid && !afterStop.running);
ok("stop() neutralizes the mixer", afterStop.neutral);

// smartPick returns a real routine
ok("smartPick returns a routine", await page.evaluate(() => { const r = window.JBAutoMix.smartPick(); return !!(r && r.id && r.run); }));

ok("no page errors during auto-mix", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
srv.close();
console.log(failed ? `AUTOMIX: ${failed} FAILURES` : "AUTOMIX: all green");
process.exit(failed ? 1 : 0);
