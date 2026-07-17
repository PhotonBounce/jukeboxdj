/* Generates the Google Play listing graphics for android/jukeboxdj/play-listing:
   feature graphic (1024×500), phone screenshots (1080×2160), 7" tablet
   (1920×1200 landscape), 10" tablet (2560×1600 landscape), and the 512 icon.
   Screenshots are captured from the REAL app driven in Chromium. */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { serve } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../android/jukeboxdj/play-listing");
const APP = path.resolve(HERE, "../../projects/jukeboxdj");
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const { srv, base } = await serve();
// Capture screenshots as the REAL Android app (JukeboxDJApp UA): Pro is included,
// so NO payment / crypto UI ever appears — required for a Play-safe listing.
const APP_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 JukeboxDJApp";

/* boot the app on a page, load both decks, start playing */
async function bootConsole (page) {
  await page.goto(base + "/app.html");
  await page.waitForSelector("body.booted", { timeout: 20000 });
  // wait for ALL six records to finish pressing so the jukebox status reads clean
  await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });
  await page.click("#btn-autoload");
  await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track && d.B.track; }, null, { timeout: 15000 });
  await page.click("#deckA .btn-play");
  await page.click("#deckB .btn-play");
  // turn a couple of knobs so the decks look "worked" for the shot
  await page.evaluate(() => {
    const bump = (deck, band, val) => {
      const inp = document.querySelector(`#deck${deck} .knob input[data-band="${band}"]`);
      if (inp) { inp.value = String(val); inp.dispatchEvent(new Event("input", { bubbles: true })); }
    };
    bump("A", "lo", 8); bump("A", "hi", -6); bump("B", "filter", 0.4); bump("B", "mid", 5);
  });
  await page.waitForTimeout(2200);
}

/* ── 1 · feature graphic 1024×500 ── */
{
  const p = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
  await p.goto("file://" + path.join(OUT, "feature-graphic.html"));
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(OUT, "feature-graphic.png") });
  await p.close();
  console.log("feature-graphic.png (1024×500)");
}

/* ── 2 · play icon 512 (copy the app's 512 into the listing folder) ── */
fs.copyFileSync(path.join(APP, "assets/icon-512.png"), path.join(OUT, "play-icon-512.png"));
console.log("play-icon-512.png");

/* ── 3 · phone screenshots 1080×2160 (portrait, DSF 2 → render 540×1080) ── */
{
  const phoneCtx = await browser.newContext({ userAgent: APP_UA, viewport: { width: 540, height: 1080 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  await bootConsole(phone);
  const shelfTab = (p, name) => p.evaluate((n) => { const t = [...document.querySelectorAll(".shelf-tab")].find((x) => x.dataset.panel === n); if (t) t.click(); }, name);
  // 1 · the whole rig — 3D tilted decks + knobs, Jukebox shelf
  await shelfTab(phone, "library");
  await phone.screenshot({ path: path.join(OUT, "phone-1-decks.png") });
  // 2 · a deck mid-scratch (flag scratching on the tilted record)
  await phone.evaluate(() => document.querySelector("#deckA").classList.add("scratching"));
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: path.join(OUT, "phone-2-scratch.png") });
  await phone.evaluate(() => document.querySelector("#deckA").classList.remove("scratching"));
  // 3 · the jukebox library (Styles tab shows the AI-DJ mixing styles)
  await shelfTab(phone, "automix-grid");
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: path.join(OUT, "phone-3-styles.png") });
  // 4 · DJ-by-prompt — type a plain-English set
  await shelfTab(phone, "djchat");
  await phone.evaluate(() => {
    const inp = document.querySelector("#djchat-input");
    if (inp) inp.value = "mix first 15s of track 1, then start track 3 at second 50, then gently mix in track 6";
  });
  await phone.waitForTimeout(500);
  await phone.screenshot({ path: path.join(OUT, "phone-4-prompt.png") });
  await phoneCtx.close();
  console.log("phone-1-decks / phone-2-scratch / phone-3-styles / phone-4-prompt (1080×2160)");
}

/* ── 4 · 7" tablet 1920×1200 landscape (DSF 1) ── */
{
  const t7ctx = await browser.newContext({ userAgent: APP_UA, viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const t7 = await t7ctx.newPage();
  await bootConsole(t7);
  await t7.screenshot({ path: path.join(OUT, "tablet7-1-console.png") });
  await t7.evaluate(() => document.querySelector("#library").scrollIntoView());
  await t7.waitForTimeout(400);
  await t7.screenshot({ path: path.join(OUT, "tablet7-2-jukebox.png") });
  await t7ctx.close();
  console.log("tablet7-1-console / tablet7-2-jukebox (1920×1200)");
}

/* ── 5 · 10" tablet 2560×1600 landscape (render 1280×800 @ DSF 2) ── */
{
  const t10ctx = await browser.newContext({ userAgent: APP_UA, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const t10 = await t10ctx.newPage();
  await bootConsole(t10);
  await t10.screenshot({ path: path.join(OUT, "tablet10-1-console.png") });
  // mixer close-up with the recorder running
  await t10.click("#btn-rec");
  await t10.waitForTimeout(900);
  await t10.screenshot({ path: path.join(OUT, "tablet10-2-mixer.png") });
  await t10.click("#btn-rec");
  await t10ctx.close();
  console.log("tablet10-1-console / tablet10-2-mixer (2560×1600)");
}

await browser.close();
srv.close();
console.log("Play assets written to", OUT);
