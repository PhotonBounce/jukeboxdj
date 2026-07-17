/* Live QA against https://www.photon-bounce.com/jukeboxdj/ — freshness curls
   (deployed files match the repo) + full Playwright E2E on the real host,
   with screenshot proof written to qa/jukeboxdj/live-shots/. */
import { chromium } from "playwright";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../projects/jukeboxdj");
const BASE = (process.env.LIVE_BASE || "https://www.photon-bounce.com/jukeboxdj").replace(/\/$/, "");
const EXE = process.env.PW_CHROMIUM; // set locally; unset on CI runners (Playwright default)
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (extra ? "  [" + extra + "]" : ""));
  if (!cond) failed++;
};

const curl = (url) => execFileSync("curl", ["-s", "--max-time", "25", "-H", "User-Agent: " + UA, "-H", "Cache-Control: no-cache", url], { encoding: "utf8" });

/* ── freshness: live files carry the repo's own markers ── */
const liveJs = curl(BASE + "/jukebox.js");
ok("live jukebox.js is the current build (NaN-guard fix present)", liveJs.includes("stale/synthetic pointer"), liveJs.length + " bytes");
const liveWorklet = curl(BASE + "/vinyl-worklet.js");
ok("live vinyl-worklet.js has finite-input guards", liveWorklet.includes("Number.isFinite(m.v)"));
const liveSw = curl(BASE + "/sw.js");
const swVer = (liveSw.match(/jukeboxdj-v(\d+)/) || [])[1];
const repoVer = (fs.readFileSync(path.join(ROOT, "sw.js"), "utf8").match(/jukeboxdj-v(\d+)/) || [])[1];
ok("live SW version matches repo (v" + repoVer + ")", swVer === repoVer, "live=v" + swVer);
const liveHtml = curl(BASE + "/");
ok("live landing is the microsite", liveHtml.includes("Two Real Turntables In Your Browser"));
const liveApp = curl(BASE + "/app.html");
ok("live app.html present", liveApp.includes("JukeboxDJ — Live Decks"));
for (const shot of ["console", "deck", "mixer", "jukebox", "mobile"]) {
  const code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "25", "-H", "User-Agent: " + UA, BASE + "/assets/shots/" + shot + ".png"], { encoding: "utf8" });
  ok("shot " + shot + ".png serves 200", code === "200", code);
}

/* ── E2E on the real host ── */
const SHOTS = process.env.SHOTS_DIR || path.join(HERE, "live-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: EXE || undefined,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  proxy: proxy ? { server: proxy } : undefined
});
const page = await browser.newPage({ viewport: { width: 1360, height: 950 }, ignoreHTTPSErrors: true, userAgent: UA });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE + "/", { timeout: 45000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(SHOTS, "live-landing.png") });
ok("live landing renders", await page.locator("h1").count() === 1);

await page.click(".cta-row a.btn-primary");
await page.waitForSelector("body.booted", { timeout: 30000 });
ok("live app boots", true);
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });
ok("live app presses all 6 records", true);
await page.click("#btn-autoload");
await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track && d.B.track; }, null, { timeout: 10000 });
await page.click("#deckA .btn-play");
await page.waitForTimeout(1500);
const live = await page.evaluate(() => new Promise((res) => {
  const jb = window.__JB, an = jb.decks.A.analyser, arr = new Float32Array(an.fftSize);
  let peak = 0, n = 0;
  const iv = setInterval(() => {
    an.getFloatTimeDomainData(arr);
    let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    peak = Math.max(peak, Math.sqrt(s / arr.length));
    if (++n >= 10) { clearInterval(iv); res({ rms: peak, pos: jb.decks.A.pos, sw: !!navigator.serviceWorker }); }
  }, 40);
}));
ok("live deck plays audio", live.rms > 0.01 && live.pos > 0, "rms=" + live.rms.toFixed(4));

// scratch on the live site — the record is a 3D-tilted (foreshortened) ellipse,
// so keep the drag radius inside the shorter axis and sweep a small upper arc.
const box = await page.locator("#deckA .platter").boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, r = Math.min(box.width, box.height) * 0.28;
const p0 = await page.evaluate(() => window.__JB.decks.A.pos);
let a0 = -0.7;
await page.mouse.move(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
await page.mouse.down();
for (let i = 1; i <= 22; i++) {
  const a = a0 - i * 0.07;   // CCW sweep within the tilted ellipse (backwards)
  await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
  await page.waitForTimeout(16);
}
await page.screenshot({ path: path.join(SHOTS, "live-scratch.png") });
await page.mouse.up();
await page.waitForTimeout(250);
const p1 = await page.evaluate(() => window.__JB.decks.A.pos);
ok("live vinyl scratches backwards", p1 < p0, "Δ=" + ((p1 - p0) / 44100).toFixed(2) + "s");

// SW registered on the live origin (https)
const swState = await page.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? "registered" : "none";
});
ok("service worker registered on live origin", swState === "registered", swState);

await page.screenshot({ path: path.join(SHOTS, "live-console.png") });
ok("no page errors on live run", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(failed ? `LIVE: ${failed} FAILURES` : "LIVE: all green");
process.exit(failed ? 1 : 0);
