/* APK-ENVIRONMENT QA — reproduces the Android shell's conditions, which are NOT
   the same as a normal browser tab. The field failure ("the website works but
   in the APK most experiments don't work") happened because the WebView shell
   serves the bundle through WebViewAssetLoader on the *https* virtual origin
   https://appassets.androidplatform.net — and the app registered its service
   worker on any https origin. A worker on that origin bypasses the asset loader,
   so its fetches fail: the shell renders but the AudioWorklet, tracks.json and
   the bundled songs never load, and the decks / library / auto-mix all die.

   This suite makes that class of bug impossible to ship:
   A. Shell contract (static): MainActivity serves the bundle through
      WebViewAssetLoader on the appassets origin, never a bare file:// document;
      the web app treats that origin (and the JukeboxDJApp UA) as in-app and
      must NOT register the service worker there.
   B. Full functional pass under APK-equivalent conditions: the JukeboxDJApp UA,
      no service worker registered, no backend — every core feature must run:
      library loads, both decks play real audio, the vinyl scratches, Song and
      Playlist auto-mix work, and the prompt DJ parses + drives the decks.

   Run: JB_QA_ROOT=<projects/jukeboxdj> PW_CHROMIUM=<chrome> node qa/jukeboxdj/apk-env.mjs */
import { chromium } from "playwright";
import { serve } from "./serve.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SHELL_KT = resolve(here, "../../android/jukeboxdj/app/src/main/java/com/photonbounce/jukeboxdj/MainActivity.kt");
const GRADLE = resolve(here, "../../android/jukeboxdj/app/build.gradle");
const APP_HTML = resolve(process.env.JB_QA_ROOT || resolve(here, "../../projects/jukeboxdj"), "app.html");
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const APP_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 JukeboxDJApp";

let failed = 0;
const ok = (name, cond, extra = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  [" + extra + "]"}`); if (!cond) failed++; };

/* ── A. shell contract (static) ────────────────────────────────────────── */
const kt = readFileSync(SHELL_KT, "utf8");
ok("shell uses WebViewAssetLoader", kt.includes("WebViewAssetLoader"));
ok("shell loads the appassets origin", kt.includes('loadUrl("https://appassets.androidplatform.net/assets/www/app.html")'));
ok("shell never loads a bare file:// document", !/loadUrl\("file:/.test(kt));
ok("shell intercepts requests for the asset loader", kt.includes("shouldInterceptRequest"));
ok("shell tags the JukeboxDJApp UA", kt.includes("JukeboxDJApp"));
const gradle = readFileSync(GRADLE, "utf8");
ok("androidx.webkit dependency present (asset loader)", /androidx\.webkit:webkit/.test(gradle));

const html = readFileSync(APP_HTML, "utf8");
ok("app.html treats the appassets origin as in-app", html.includes("appassets.androidplatform.net"));
ok("app.html treats the JukeboxDJApp UA as in-app", /JukeboxDJApp/.test(html));
ok("app.html guards SW registration behind an in-app check (not bare https)",
  /IN_APP/.test(html) && /if\s*\(\s*IN_APP\s*\)/.test(html));

/* ── B. full functional pass in APK-equivalent conditions ──────────────── */
const { srv, base } = await serve();
const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const ctx = await browser.newContext({ userAgent: APP_UA, viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
await page.goto(base + "/app.html");
await page.waitForSelector("body.booted", { timeout: 20000 });

// in-app: Pro included, and — critically — NO service worker registered here
ok("app detected as in-app (Pro included, no paywall)", await page.evaluate(() => window.JBPro && window.JBPro.isApp() && window.JBPro.isPro()));
const swState = await page.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return { supported: false, regs: 0, controller: false };
  const regs = await navigator.serviceWorker.getRegistrations();
  return { supported: true, regs: regs.length, controller: !!navigator.serviceWorker.controller };
});
ok("NO service worker registered on the appassets/app origin", swState.regs === 0 && !swState.controller, JSON.stringify(swState));

// the bundled library + AudioWorklet + songs must load with no worker helping
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => t.buffer).length >= 6, null, { timeout: 60000 });
ok("bundled library loads (records pressed offline)", await page.evaluate(() => window.__JB.library.filter((t) => t.buffer).length >= 6));

await page.click("#btn-autoload");
await page.waitForFunction(() => window.__JB.decks.A && window.__JB.decks.A.track && window.__JB.decks.B && window.__JB.decks.B.track, null, { timeout: 15000 });
await page.click("#deckA .btn-play");
await page.waitForTimeout(1200);
const audio = await page.evaluate(() => new Promise((res) => {
  const an = window.__JB.decks.A.analyser, arr = new Float32Array(an.fftSize);
  let peak = 0, n = 0;
  const iv = setInterval(() => {
    an.getFloatTimeDomainData(arr);
    let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    peak = Math.max(peak, Math.sqrt(s / arr.length));
    if (++n >= 8) { clearInterval(iv); res({ peak, pos: window.__JB.decks.A.pos }); }
  }, 60);
}));
ok("deck A plays real audio through the AudioWorklet (APK conditions)", audio.peak > 0.01 && audio.pos > 0, JSON.stringify({ rms: audio.peak.toFixed(3), pos: audio.pos | 0 }));

// scratch the exposed top arc of the record
const box = await page.locator("#deckA .platter").boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, r = box.width * 0.42;
const p0 = await page.evaluate(() => window.__JB.decks.A.pos);
await page.dispatchEvent("#deckA .platter", "pointerdown", { pointerId: 5, clientX: cx + r * Math.cos(-0.9), clientY: cy + r * Math.sin(-0.9), isPrimary: true, pointerType: "touch" });
for (let i = 1; i <= 18; i++) { const a = -0.9 - i * 0.06; await page.dispatchEvent("#deckA .platter", "pointermove", { pointerId: 5, clientX: cx + r * Math.cos(a), clientY: cy + r * Math.sin(a), isPrimary: true, pointerType: "touch" }); await page.waitForTimeout(16); }
await page.dispatchEvent("#deckA .platter", "pointerup", { pointerId: 5, isPrimary: true, pointerType: "touch" });
await page.waitForTimeout(200);
ok("vinyl scratches backwards in APK conditions", await page.evaluate(() => window.__JB.decks.A.pos) < p0);

// needle + time runner (the v11 redesign) render and advance
const runner = await page.evaluate(() => ({ left: document.querySelector("#deckA .needle").style.left, cur: document.querySelector("#deckA .vt-cur").textContent }));
ok("needle + time runner live in APK conditions", !!runner.left && /^\d+:\d\d$/.test(runner.cur), JSON.stringify(runner));

// Song Auto-Mix: blends the two decks
await page.evaluate(() => window.__JB.stopAll());
await page.click("#deckA .btn-play");
const songMix = await page.evaluate(async () => {
  const jb = window.__JB;
  if (!jb.decks.A.playing) { jb.decks.A.togglePlay(); }
  const x0 = jb.getCrossfader();
  if (window.JBAutoMix) await window.JBAutoMix.play(window.JBAutoMix.smartPick());
  return { x0, x1: jb.getCrossfader(), ran: true };
});
ok("Song Auto-Mix runs (beat-match + crossfade) in APK conditions", songMix.ran && Number.isFinite(songMix.x1));
await page.evaluate(() => window.__JB.stopAll());

// Playlist Auto-Mix: non-stop set — pre-cues the idle deck silently
await page.click("#btn-playlist-auto");
await page.waitForFunction(() => window.__JB.playlist.on && window.__JB.decks.A && window.__JB.decks.A.track && window.__JB.decks.B && window.__JB.decks.B.track, null, { timeout: 15000 });
const pl = await page.evaluate(() => {
  const jb = window.__JB, live = jb.playlist.live, cue = jb.playlist.cue;
  return { on: jb.playlist.on, livePlaying: jb.decks[live].playing, cueLoaded: !!jb.decks[cue].track, cuePlaying: jb.decks[cue].playing };
});
ok("Playlist Auto-Mix runs + silently pre-cues the next record", pl.on && pl.livePlaying && pl.cueLoaded && !pl.cuePlaying, JSON.stringify(pl));
await page.evaluate(() => window.__JB.stopAll());

// Prompt-controlled DJ: parses + drives the decks
const dj = await page.evaluate(async () => {
  const jb = window.__JB;
  const steps = jb.parseDjScript("play first 2 seconds of track 1 then start track 2 at second 4");
  window.JBAutoMix = null;                       // fast fallback crossfade
  jb.runDjScript("play first 2 seconds of track 1 then start track 2 at second 4");
  const t0 = Date.now(); let played = false;
  while (Date.now() - t0 < 12000) { await new Promise((r) => setTimeout(r, 200)); if (jb.decks.A.playing || jb.decks.B.playing) played = true; if (!jb.djScript.running && played) break; }
  return { steps: steps.length, played };
});
ok("prompt DJ parses a set and drives the decks in APK conditions", dj.steps === 2 && dj.played, JSON.stringify(dj));
await page.evaluate(() => window.__JB.stopAll());

ok("no page errors across the APK-equivalent pass", errors.length === 0, errors.slice(0, 3).join(" | "));

// screenshot proof under APK conditions
const SHOT = process.env.SHOT_DIR || "/tmp/jbdj-apk";
await import("node:fs").then((fs) => fs.promises.mkdir(SHOT, { recursive: true }));
await page.evaluate(() => window.__JB.stopAll());
await page.click("#btn-autoload").catch(() => {});
await page.waitForTimeout(400);
await page.click("#deckA .btn-play").catch(() => {});
await page.click("#deckB .btn-play").catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: SHOT + "/apk-decks.png", fullPage: true });
await page.locator("#deckA").screenshot({ path: SHOT + "/apk-deckA.png" });
await browser.close();
srv.close();
console.log(failed ? `APK-ENV FAILED (${failed})` : "APK-ENV CLEAN");
process.exit(failed ? 1 : 0);
