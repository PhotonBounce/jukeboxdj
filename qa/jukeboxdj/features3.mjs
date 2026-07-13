/* Feature suite v3 — the vinyl redesign + dual auto-mix modes + prompt DJ:
   · big record, only the top third exposed, a needle head that rides it with a
     live current/remaining time runner
   · EQ sliders shrunk into a compact grid
   · two auto-mix modes: Song (the two decks) and Playlist (non-stop, pre-cued)
   · prompt-controlled DJ chat that parses a plain-English set and performs it */
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

/* ── 1. VINYL: big record, top-third window, needle + time runner ── */
const vinylBox = await page.locator("#deckA .deck-vinyl").boundingBox();
const platterBox = await page.locator("#deckA .platter").boundingBox();
ok("deck vinyl is a clipping window", await page.evaluate(() => getComputedStyle(document.querySelector("#deckA .deck-vinyl")).overflow === "hidden"));
ok("record is much larger than its window (only top third exposed)", platterBox.height > vinylBox.height * 1.9,
  "platter=" + Math.round(platterBox.height) + " window=" + Math.round(vinylBox.height));
ok("needle head present in the window", await page.locator("#deckA .needle").count() === 1);
ok("time runner present (current + remaining)", await page.locator("#deckA .vt-cur").count() === 1 && await page.locator("#deckA .vt-rem").count() === 1);

// play deck A and watch the needle ride + the runner advance
await page.click("#btn-autoload");
await page.waitForFunction(() => window.__JB.decks.A && window.__JB.decks.A.track && window.__JB.decks.B && window.__JB.decks.B.track);
const leftBefore = await page.evaluate(() => document.querySelector("#deckA .needle").style.left || "8%");
await page.click("#deckA .btn-play");
await page.waitForTimeout(2500);
const rideState = await page.evaluate(() => ({
  left: document.querySelector("#deckA .needle").style.left,
  cur: document.querySelector("#deckA .vt-cur").textContent,
  rem: document.querySelector("#deckA .vt-rem").textContent
}));
ok("needle moves inward as the track plays", rideState.left && rideState.left !== leftBefore, "left=" + rideState.left);
ok("current-time runner advances", /^\d+:\d\d$/.test(rideState.cur) && rideState.cur !== "0:00", "cur=" + rideState.cur);
ok("remaining-time runner shown as negative countdown", /^-\d+:\d\d$/.test(rideState.rem), "rem=" + rideState.rem);
// past mid-track the label flips to avoid running off the right edge
const flip = await page.evaluate(() => {
  const d = window.__JB.decks.A; d.seek(Math.floor(d.track.buffer.length * 0.8));
  return new Promise((r) => setTimeout(() => r(document.querySelector("#deckA .needle").classList.contains("flip")), 300));
});
ok("time-runner flips to the left past mid-track", flip);

/* ── 2. compact EQ sliders (~20% footprint) ── */
const eq = await page.evaluate(() => {
  const g = getComputedStyle(document.querySelector("#deckA .deck-eq"));
  const row = document.querySelector("#deckA .deck-eq .sl");
  return { display: g.display, rowH: row.getBoundingClientRect().height };
});
ok("EQ sliders laid out as a compact grid", eq.display === "grid", eq.display);
ok("slider rows are short (shrunken)", eq.rowH <= 22, "rowH=" + Math.round(eq.rowH));

/* ── 3. two auto-mix modes present ── */
ok("Song Auto-Mix button present", await page.locator("#btn-mix-song").count() === 1);
ok("Playlist Auto-Mix button present", await page.locator("#btn-playlist-auto").count() === 1);

/* ── 4. Playlist Auto-Mix engine: loads whole set, pre-cues silently, mixes ── */
await page.evaluate(() => window.__JB.stopDjScript && window.__JB.stopDjScript());
await page.click("#btn-playlist-auto");
await page.waitForFunction(() => window.__JB.playlist.on && window.__JB.decks.A && window.__JB.decks.A.track && window.__JB.decks.B && window.__JB.decks.B.track, null, { timeout: 15000 });
const pl = await page.evaluate(() => {
  const jb = window.__JB, live = jb.playlist.live, cue = jb.playlist.cue;
  return {
    on: jb.playlist.on, live, cue,
    livePlaying: jb.decks[live].playing,
    cueLoaded: !!jb.decks[cue].track,
    cuePlaying: jb.decks[cue].playing,
    status: document.querySelector("#automix-status").textContent
  };
});
ok("playlist mode is running", pl.on);
ok("live deck is playing audibly", pl.livePlaying, pl.live);
ok("next record is silently pre-cued (loaded, not yet playing)", pl.cueLoaded && !pl.cuePlaying, pl.cue);
ok("status shows the playlist set", /Playlist Auto-Mix/.test(pl.status));
ok("playlist button reads ON", (await page.locator("#btn-playlist-auto .pa-state").textContent()) === "ON");

// force a transition via the beat-matched fallback: near-end + no AutoMix module
const swapped = await page.evaluate(async () => {
  const jb = window.__JB;
  window.JBAutoMix = null;                       // exercise the internal crossfade fallback
  const before = jb.playlist.live;
  const d = jb.decks[before];
  d.seek(Math.floor(d.track.buffer.length - d.track.buffer.sampleRate * 3)); // 3s from the end
  const t0 = Date.now();
  while (Date.now() - t0 < 14000) { await new Promise((r) => setTimeout(r, 300)); if (jb.playlist.live !== before) return { before, after: jb.playlist.live, ok: true }; }
  return { before, after: jb.playlist.live, ok: false };
});
ok("live track near end auto-mixes and hands off to the cued deck", swapped.ok, swapped.before + "→" + swapped.after);
await page.click("#btn-playlist-auto");   // stop
ok("playlist mode stops cleanly", await page.evaluate(() => !window.__JB.playlist.on));
await page.evaluate(() => window.__JB.stopAll());

/* ── 5. prompt-controlled DJ: parse the exact example the user asked for ── */
const parsed = await page.evaluate(() => {
  const steps = window.__JB.parseDjScript(
    "mix first 13 seconds of track 1 and start on 50th second of track 3, then play track 5 fully and at end gently mix in track 22 at second 33"
  );
  return steps.map((s) => ({ n: s.trackNo, startAt: s.startAt, playFor: s.playFor, fully: s.fully, gentle: s.gentle, mix: s.mix }));
});
ok("parses all four steps from the example", parsed.length === 4, JSON.stringify(parsed.map((s) => s.n)));
ok("step 1 = track 1, first 13 seconds", parsed[0] && parsed[0].n === 1 && parsed[0].playFor === 13, JSON.stringify(parsed[0]));
ok("step 2 = track 3, start at 0:50", parsed[1] && parsed[1].n === 3 && parsed[1].startAt === 50, JSON.stringify(parsed[1]));
ok("step 3 = track 5, played fully", parsed[2] && parsed[2].n === 5 && parsed[2].fully === true, JSON.stringify(parsed[2]));
ok("step 4 = track 22, gently mixed in at second 33", parsed[3] && parsed[3].n === 22 && parsed[3].startAt === 33 && parsed[3].gentle && parsed[3].mix, JSON.stringify(parsed[3]));

/* run a short set and confirm it drives the real decks (load + seek + play) */
const ran = await page.evaluate(async () => {
  const jb = window.__JB;
  window.JBAutoMix = null;                       // fast fallback crossfade
  jb.runDjScript("play first 2 seconds of track 1 then start track 2 at second 4");
  const t0 = Date.now();
  let sawStart = false, seekOk = false;
  while (Date.now() - t0 < 16000) {
    await new Promise((r) => setTimeout(r, 250));
    const anyPlaying = jb.decks.A.playing || jb.decks.B.playing;
    if (anyPlaying) sawStart = true;
    // once the 2nd step loads track 2 somewhere, its start should be ~4s in
    ["A", "B"].forEach((id) => { const d = jb.decks[id]; if (d.track && d.posSec() >= 3.2 && d.posSec() < 30) seekOk = true; });
    if (!jb.djScript.running && sawStart) break;
  }
  return { sawStart, seekOk, running: jb.djScript.running };
});
ok("prompt set actually plays a deck", ran.sawStart);
ok("prompt set honours a 'start at second N' seek", ran.seekOk);
await page.evaluate(() => window.__JB.stopAll());

ok("no page errors across the whole suite", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
srv.close();
console.log(failed ? `FEATURES3: ${failed} FAILURES` : "FEATURES3: all green");
process.exit(failed ? 1 : 0);
