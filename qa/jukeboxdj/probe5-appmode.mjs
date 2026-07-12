/* Adversarial probe 5 — hostile environments: the Android-app UA on a small
   touch screen end-to-end (boot → press → play → scratch → record, Pro
   included), localStorage DENIED entirely (private-mode-like), and a
   double-load of the pro script (idempotence). */
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

/* ── 1 · full session in app mode on a phone-sized touch screen ── */
const appCtx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 JukeboxDJApp",
  viewport: { width: 384, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6
});
const app = await appCtx.newPage();
const appErrs = [];
app.on("pageerror", (e) => appErrs.push(String(e)));
await app.goto(base + "/app.html");
await app.waitForSelector("body.booted", { timeout: 20000 });
await app.waitForFunction(() => window.__JB && window.__JB.library.length >= 2, null, { timeout: 60000 });
await app.tap("#btn-autoload");
await app.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track; }, null, { timeout: 15000 });
await app.tap("#deckA .btn-play");
await app.waitForTimeout(900);
const appPlay = await app.evaluate(() => ({ pos: window.__JB.decks.A.pos, pro: window.JBPro.isPro() }));
ok("app-mode phone: deck plays", appPlay.pos > 1000, "pos=" + (appPlay.pos | 0));
ok("app-mode phone: Pro included", appPlay.pro);

// touch scratch via synthetic pointer events (regression path from v1)
const b = await app.locator("#deckA .platter").boundingBox();
const cx = b.x + b.width / 2, cy = b.y + b.height / 2, r = b.width * 0.35;
const before = await app.evaluate(() => window.__JB.decks.A.pos);
await app.dispatchEvent("#deckA .platter", "pointerdown", { pointerId: 9, clientX: cx + r, clientY: cy, isPrimary: true, pointerType: "touch" });
for (let i = 1; i <= 12; i++) {
  const a = -i * 0.22;
  await app.dispatchEvent("#deckA .platter", "pointermove", { pointerId: 9, clientX: cx + r * Math.cos(a), clientY: cy + r * Math.sin(a), isPrimary: true, pointerType: "touch" });
  await app.waitForTimeout(16);
}
await app.dispatchEvent("#deckA .platter", "pointerup", { pointerId: 9, isPrimary: true, pointerType: "touch" });
await app.waitForTimeout(250);
const after = await app.evaluate(() => window.__JB.decks.A.pos);
ok("app-mode phone: touch scratch rewinds", after < before, "Δ=" + ((after - before) / 44100).toFixed(2) + "s");

// record + save works with Pro included (no cap)
await app.tap("#btn-rec");
await app.waitForTimeout(1300);
await app.tap("#btn-rec");
await app.waitForFunction(() => !document.querySelector("#rec-save").hidden, null, { timeout: 8000 });
ok("app-mode phone: recording saves", true);
ok("no page errors (app mode)", appErrs.length === 0, appErrs.slice(0, 2).join(" | "));
await appCtx.close();

/* ── 2 · localStorage completely denied ── */
const denyCtx = await browser.newContext();
const deny = await denyCtx.newPage();
const denyErrs = [];
deny.on("pageerror", (e) => denyErrs.push(String(e)));
await deny.addInitScript(() => {
  const boom = () => { throw new DOMException("denied", "SecurityError"); };
  Object.defineProperty(window, "localStorage", { get: boom });
});
await deny.goto(base + "/app.html");
await deny.waitForSelector("body.booted", { timeout: 20000 });
const denyState = await deny.evaluate(() => ({
  jb: !!window.__JB, pro: window.JBPro.isPro(), limit: window.JBPro.recLimitSec()
}));
ok("localStorage denied: app boots on free tier", denyState.jb && denyState.pro === false && denyState.limit === 90, JSON.stringify(denyState));
const denyUnlock = await deny.evaluate(() => {
  window.JBPro.unlock("qa");          // save will fail silently…
  return window.JBPro.isPro();        // …but the session unlock still applies
});
ok("localStorage denied: unlock still works for the session", denyUnlock === true);
ok("no page errors (storage denied)", denyErrs.length === 0, denyErrs.slice(0, 2).join(" | "));
await denyCtx.close();

/* ── 3 · pro script loaded twice (bad cache / double include) ── */
const twiceCtx = await browser.newContext();
const twice = await twiceCtx.newPage();
const twiceErrs = [];
twice.on("pageerror", (e) => twiceErrs.push(String(e)));
await twice.goto(base + "/app.html");
await twice.waitForSelector("body.booted", { timeout: 20000 });
await twice.evaluate(async () => {
  const s = document.createElement("script");
  s.src = "jukebox-pro.js";
  document.body.appendChild(s);
  await new Promise((r) => { s.onload = r; s.onerror = r; });
});
await twice.click("#btn-pro");
await twice.waitForSelector(".pro-card", { timeout: 5000 });
const cards = await twice.locator(".pro-card").count();
ok("double-loaded pro script: still exactly one panel", cards === 1, cards + " cards");
ok("no page errors (double load)", twiceErrs.length === 0, twiceErrs.slice(0, 2).join(" | "));
await twiceCtx.close();

await browser.close();
srv.close();
console.log(failed ? `PROBE5: ${failed} FAILURES` : "PROBE5: hostile environments hold");
process.exit(failed ? 1 : 0);
