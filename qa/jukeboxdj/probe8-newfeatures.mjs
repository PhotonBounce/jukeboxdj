/* Adversarial probe 8 — the v3 additions under abuse:
   · spam-toggle Playlist Auto-Mix on/off and hammer STOP ALL mid-transition
   · fire garbage / empty / adversarial DJ-prompt scripts, and stack a new set
     on top of a running one
   · seek the needle to the extremes and NaN-poke the position
   Pass = no page errors, audio graph alive, playheads finite, no stuck state. */
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
await page.waitForSelector("body.booted", { timeout: 20000 });
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => t.buffer).length >= 6, null, { timeout: 60000 });

/* ── 1 · Playlist Auto-Mix toggle spam + STOP ALL mid-flight ── */
for (let i = 0; i < 8; i++) {
  await page.click("#btn-playlist-auto");
  await page.waitForTimeout(120);
}
await page.evaluate(() => window.__JB.stopAll());
let st = await page.evaluate(() => ({ on: window.__JB.playlist.on, aPos: window.__JB.decks.A ? window.__JB.decks.A.pos : 0 }));
ok("playlist toggle spam + STOP ALL leaves it OFF", st.on === false, "on=" + st.on);
ok("playhead finite after toggle spam", Number.isFinite(st.aPos));

// start it, then yank STOP ALL while it's actively mixing near a track end
await page.click("#btn-playlist-auto");
await page.waitForFunction(() => window.__JB.playlist.on && window.__JB.decks.A && window.__JB.decks.A.track && window.__JB.decks.B && window.__JB.decks.B.track, null, { timeout: 15000 });
await page.evaluate(() => {
  const d = window.__JB.decks[window.__JB.playlist.live];
  d.seek(Math.floor(d.track.buffer.length - d.track.buffer.sampleRate * 2));
});
await page.waitForTimeout(500);
await page.evaluate(() => window.__JB.stopAll());
await page.waitForTimeout(600);
st = await page.evaluate(() => ({
  on: window.__JB.playlist.on,
  finite: Number.isFinite(window.__JB.decks.A.pos) && Number.isFinite(window.__JB.decks.B.pos),
  ctx: window.__JB.ctx().state
}));
ok("STOP ALL mid-transition halts playlist cleanly", st.on === false, "on=" + st.on);
ok("both playheads finite after abrupt stop", st.finite);
ok("audio context still alive", st.ctx === "running" || st.ctx === "suspended", st.ctx);

/* ── 2 · DJ-prompt abuse: garbage, empty, out-of-range, stacked runs ── */
const promptResults = await page.evaluate(async () => {
  const jb = window.__JB, out = [];
  const scripts = [
    "",                                             // empty
    "asdf qwerty no tracks here",                   // no track refs
    "mix track 999999 then play track -3",          // wild indices (wrap/guard)
    "track track track second second of of of",     // word salad
    "play first 999 seconds of track 1 at second -50" // nonsense numbers
  ];
  for (const s of scripts) {
    try { out.push({ s: s.slice(0, 20), n: jb.parseDjScript(s).length, ok: true }); }
    catch (e) { out.push({ s: s.slice(0, 20), err: String(e), ok: false }); }
  }
  return out;
});
ok("parser never throws on garbage prompts", promptResults.every((r) => r.ok), JSON.stringify(promptResults.map((r) => r.n)));

// stack a second set on top of a running one (should refuse, not corrupt)
const stacked = await page.evaluate(async () => {
  const jb = window.__JB;
  window.JBAutoMix = null;                          // fast fallback so it advances
  jb.runDjScript("play first 3 seconds of track 1 then start track 2 at second 5");
  await new Promise((r) => setTimeout(r, 400));
  const wasRunning = jb.djScript.running;
  jb.runDjScript("play track 4 fully");             // stack a second set immediately
  await new Promise((r) => setTimeout(r, 400));
  return { wasRunning, stillRunning: jb.djScript.running };
});
ok("second set does not crash a running set", stacked.wasRunning, JSON.stringify(stacked));
await page.evaluate(() => window.__JB.stopDjScript());
await page.waitForTimeout(300);
ok("stopDjScript clears the running flag", await page.evaluate(() => window.__JB.djScript.running === false));
await page.evaluate(() => window.__JB.stopAll());

/* ── 3 · needle / position extremes (NaN guard) ── */
const needle = await page.evaluate(async () => {
  const jb = window.__JB, d = jb.decks.A;
  if (!d.track) return { skip: true };
  d.seek(0); await new Promise((r) => setTimeout(r, 80));
  const l0 = document.querySelector("#deckA .needle").style.left;
  d.seek(d.track.buffer.length - 1); await new Promise((r) => setTimeout(r, 120));
  const l1 = document.querySelector("#deckA .needle").style.left;
  // poke a negative / overflow position, ensure the renderer clamps and survives
  d.seek(-5000); await new Promise((r) => setTimeout(r, 80));
  const finite = Number.isFinite(d.pos);
  return { l0, l1, finite };
});
ok("needle sits near the rim at the start", needle.skip || (parseFloat(needle.l0) < 20), "l0=" + needle.l0);
ok("needle reaches the spindle at the end", needle.skip || (parseFloat(needle.l1) > 80), "l1=" + needle.l1);
ok("position stays finite after a negative-seek poke", needle.skip || needle.finite);

ok("no page errors across the whole probe", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
srv.close();
console.log(failed ? `PROBE8: ${failed} FAILURES` : "PROBE8: new features hold");
process.exit(failed ? 1 : 0);
