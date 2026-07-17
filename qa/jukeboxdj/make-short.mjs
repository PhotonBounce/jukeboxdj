/* Records a ~40s YouTube Short (9:16, with sound) of the app being played:
   loads two of the user's featured tracks, plays, scratches, then lets the AI
   Auto-Mix blend them — capturing Playwright video (visuals) and the app's own
   master recorder (audio) in parallel, then muxes them with ffmpeg to MP4. */
import { chromium } from "playwright";
import { serve } from "./serve.mjs";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = process.env.SHORT_OUT || path.join(HERE, "short-out");
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FFMPEG = "/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux";
fs.mkdirSync(OUTDIR, { recursive: true });
const VID = path.join(OUTDIR, "video");
fs.mkdirSync(VID, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { srv, base } = await serve();
const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });

const tCtx = Date.now();
const context = await browser.newContext({
  viewport: { width: 540, height: 960 }, isMobile: true, hasTouch: true,
  // record at the viewport size (no gray padding); ffmpeg upscales 2× to 1080×1920
  recordVideo: { dir: VID, size: { width: 540, height: 960 } }
});
const page = await context.newPage();
await page.goto(base + "/app.html");
await page.waitForSelector("body.booted", { timeout: 20000 });
// wait for the featured tracks to be decoded and on top of the library
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => t.featured).length >= 2, null, { timeout: 90000 });

// drop the first two featured songs on the decks
await page.evaluate(async () => {
  const jb = window.__JB;
  const feat = jb.library.filter((t) => t.featured);
  await jb.loadToDeck("A", feat[0]);
  await jb.loadToDeck("B", feat[1]);
});
await wait(400);

// ── start audio capture (the app's master recorder) — this is t0 of the show ──
const tAudio = Date.now();
await page.evaluate(() => { if (!window.__JB.isRecording()) window.__JB.toggleRecord(); });

// 1 · play deck A and let the featured track breathe
await page.evaluate(() => { const d = window.__JB.decks.A; if (!d.playing) d.togglePlay(); });
await wait(3800);

// 2 · a couple of scratches on deck A (the disc visibly spins with the audio)
for (const seq of [[-6, 5], [-8, 6]]) {
  await page.evaluate((v) => { const d = window.__JB.decks.A; d.scratch(true); d.scratchVel(v[0]); }, seq);
  await wait(240);
  await page.evaluate((v) => { window.__JB.decks.A.scratchVel(v[1]); }, seq);
  await wait(240);
  await page.evaluate(() => { const d = window.__JB.decks.A; d.scratchVel(0); d.scratch(false); });
  await wait(700);
}
await wait(1500);

// 3 · bring deck B in and let the AI Auto-Mix (filter sweep) blend the two
await page.evaluate(() => { const d = window.__JB.decks.B; if (!d.playing) d.togglePlay(); });
await page.evaluate(() => window.JBAutoMix.play(window.JBAutoMix._byId("filtersweep")));
await page.waitForFunction(() => !window.JBAutoMix.isRunning(), null, { timeout: 20000 });
await wait(2500);

// 4 · load a third featured track to A and chop-mix back to it
await page.evaluate(async () => {
  const jb = window.__JB;
  const feat = jb.library.filter((t) => t.featured);
  if (feat[2]) await jb.loadToDeck("A", feat[2]);
});
await wait(600);
await page.evaluate(() => { const d = window.__JB.decks.A; if (!d.playing) d.togglePlay(); });
await page.evaluate(() => window.JBAutoMix.play(window.JBAutoMix._byId("chop")));
await page.waitForFunction(() => !window.JBAutoMix.isRunning(), null, { timeout: 20000 });
await wait(2500);

// ── stop audio capture and pull the recorded blob out as base64 ──
await page.evaluate(() => { if (window.__JB.isRecording()) window.__JB.toggleRecord(); });
await page.waitForFunction(() => !document.querySelector("#rec-save").hidden, null, { timeout: 8000 });
const audioB64 = await page.evaluate(async () => {
  const blob = await fetch(document.querySelector("#rec-save").href).then((r) => r.blob());
  const buf = await blob.arrayBuffer();
  let bin = ""; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
});
fs.writeFileSync(path.join(OUTDIR, "audio.webm"), Buffer.from(audioB64, "base64"));

// finalize video
await page.close();
await context.close();     // flushes the video file
await browser.close();
srv.close();

const vids = fs.readdirSync(VID).filter((f) => f.endsWith(".webm"));
if (!vids.length) { console.error("no video captured"); process.exit(1); }
const videoPath = path.join(VID, vids[0]);
const delay = Math.max(0, (tAudio - tCtx) / 1000);   // trim video pre-roll so A/V line up
const out = path.join(OUTDIR, "jukeboxdj-short.webm");

// This ffmpeg build only encodes VP8 — and the Playwright video is already
// 1080×1920 VP8 while the app's recording is Opus, so we re-encode the video
// (frame-accurate trim) and stream-copy the Opus audio into a WebM (which
// YouTube Shorts accepts). No h264/aac encoder needed.
execFileSync(FFMPEG, [
  "-y",
  "-ss", delay.toFixed(2), "-i", videoPath,
  "-i", path.join(OUTDIR, "audio.webm"),
  "-map", "0:v:0", "-map", "1:a:0",
  "-vf", "scale=1080:1920:flags=lanczos",
  "-c:v", "libvpx", "-b:v", "6M", "-deadline", "realtime", "-cpu-used", "5",
  "-c:a", "copy", "-shortest",
  out
], { stdio: "inherit" });

const sz = fs.statSync(out).size;
console.log("SHORT: " + out + " (" + Math.round(sz / 1024) + " KB, pre-roll trim " + delay.toFixed(1) + "s)");
