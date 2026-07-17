/* Captures real app screenshots for the landing-page gallery + og image. */
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { serve } from "./serve.mjs";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../projects/jukeboxdj/assets");
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const { srv, base } = await serve();

const page = await browser.newPage({ viewport: { width: 1360, height: 950 }, deviceScaleFactor: 2 });
await page.goto(base + "/app.html");
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });
await page.click("#btn-autoload");
await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track && d.B.track; });
await page.click("#deckA .btn-play");
await page.click("#deckB .btn-play");
await page.waitForTimeout(2600);

// 1 · full console mid-mix
await page.screenshot({ path: OUT + "/shots/console.png" });

// 2 · deck close-up while "scratching"
await page.evaluate(() => document.querySelector("#deckA").classList.add("scratching"));
const deckBox = await page.locator("#deckA").boundingBox();
await page.screenshot({ path: OUT + "/shots/deck.png", clip: deckBox });
await page.evaluate(() => document.querySelector("#deckA").classList.remove("scratching"));

// 3 · mixer close-up with echo/filter dialed in + recording live
await page.evaluate(() => {
  const set = (id, deg) => document.querySelector(id).style.setProperty("--rot", deg + "deg");
  set("#eq-hi-a", 40); set("#eq-mid-a", -20); set("#eq-lo-a", 70);
  set("#filter-b", -60); set("#echo-b", 55);
});
await page.click("#btn-rec");
await page.waitForTimeout(1200);
const mixBox = await page.locator("#mixer").boundingBox();
await page.screenshot({ path: OUT + "/shots/mixer.png", clip: { x: mixBox.x - 8, y: mixBox.y - 8, width: mixBox.width + 16, height: mixBox.height + 16 } });
await page.click("#btn-rec");

// 4 · the jukebox library
const libBox = await page.locator("#library").boundingBox();
await page.screenshot({ path: OUT + "/shots/jukebox.png", clip: libBox });

// 5 · og image 1200×630 — hero crop of the console
await page.setViewportSize({ width: 1200, height: 630 });
await page.waitForTimeout(700);
await page.screenshot({ path: OUT + "/og.png" });

// 6 · mobile
const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await mob.goto(base + "/app.html");
await mob.waitForFunction(() => window.__JB && window.__JB.library.length >= 2, null, { timeout: 60000 });
await mob.click("#btn-autoload");
await mob.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track; });
await mob.click("#deckA .btn-play");
await mob.waitForTimeout(1500);
await mob.screenshot({ path: OUT + "/shots/mobile.png" });

await browser.close();
srv.close();
console.log("shots written");
