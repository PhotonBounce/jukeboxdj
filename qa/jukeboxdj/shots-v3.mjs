/* Capture proof screenshots of the v3 UI: the exposed-vinyl decks with needle +
   time runner, the two auto-mix modes, and the prompt-controlled DJ chat. */
import { chromium } from "playwright";
import { serve } from "./serve.mjs";
import { promises as fs } from "fs";

const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.SHOT_DIR || "/tmp/jbdj-shots-v3";
await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const { srv, base } = await serve();

/* desktop */
const page = await browser.newPage({ viewport: { width: 1360, height: 1200 } });
await page.goto(base + "/app.html");
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => t.buffer).length >= 6, null, { timeout: 60000 });
await page.click("#btn-autoload");
await page.waitForFunction(() => window.__JB.decks.A && window.__JB.decks.A.track && window.__JB.decks.B && window.__JB.decks.B.track);
await page.click("#deckA .btn-play");
await page.click("#deckB .btn-play");
await page.waitForTimeout(2600);
await page.screenshot({ path: OUT + "/01-full-desktop.png", fullPage: true });
await page.locator("#decks-panel").screenshot({ path: OUT + "/02-decks-vinyl.png" });
await page.locator("#deckA").screenshot({ path: OUT + "/03-deckA-needle.png" });
await page.locator("#controls-panel").screenshot({ path: OUT + "/04-controls-modes-djchat.png" });

// prompt DJ in action
await page.fill("#djchat-input", "mix first 13 seconds of track 1 and start on 50th second of track 3, then play track 5 fully and at end gently mix in track 22 at second 33");
await page.waitForTimeout(300);
await page.locator("#djchat").screenshot({ path: OUT + "/05-djchat-typed.png" });

// playlist auto-mix engaged
await page.evaluate(() => window.__JB.stopAll());
await page.click("#btn-playlist-auto");
await page.waitForTimeout(1500);
await page.locator("#controls-panel").screenshot({ path: OUT + "/06-playlist-on.png" });
await page.evaluate(() => window.__JB.stopAll());
await page.close();

/* phone portrait */
const mob = await browser.newPage({ viewport: { width: 390, height: 940 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await mob.goto(base + "/app.html");
await mob.waitForFunction(() => window.__JB && window.__JB.library.length >= 2, null, { timeout: 60000 });
await mob.tap("#btn-autoload");
await mob.waitForFunction(() => window.__JB.decks.A && window.__JB.decks.A.track);
await mob.tap("#deckA .btn-play");
await mob.waitForTimeout(2200);
await mob.screenshot({ path: OUT + "/07-phone-full.png", fullPage: true });
await mob.locator("#decks-panel").screenshot({ path: OUT + "/08-phone-decks.png" });
await mob.close();

await browser.close();
srv.close();
console.log("shots →", OUT);
