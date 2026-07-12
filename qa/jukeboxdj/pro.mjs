/* Pro (SaaS) suite: free recording cap fires and saves the take, unlock lifts
   the cap + raises bitrate, Pro persists across reload, panel renders crypto
   wallets on web, #pro deep-link opens the panel, and the Android app UA gets
   Pro included with all payment UI hidden. */
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

/* ── web (free → unlock → pro) ── */
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/app.html");
await page.waitForSelector("body.booted", { timeout: 20000 });

ok("JBPro API present", await page.evaluate(() => !!window.JBPro));
ok("web starts on free tier", await page.evaluate(() => !window.JBPro.isPro()));
ok("free rec limit is 90s / 128kbps", await page.evaluate(() =>
  window.JBPro.recLimitSec() === 90 && window.JBPro.recBitsPerSecond() === 128000));
ok("GO PRO chip shown", (await page.locator("#btn-pro").textContent()).includes("GO PRO"));

// panel: chips for 4 chains, wallet address, unlock button
await page.click("#btn-pro");
await page.waitForSelector(".pro-card", { timeout: 5000 });
ok("panel shows 4 chain chips", await page.locator(".pro-chip").count() === 4);
const addr = await page.locator(".pro-addr").textContent();
ok("EVM wallet shown by default", addr.startsWith("0x75B30d"), addr.slice(0, 12));
await page.click(".pro-chip[data-k='btc']");
ok("BTC chip swaps the wallet", (await page.locator(".pro-addr").textContent()).startsWith("bc1q"));
ok("QR rendered", await page.locator(".pro-qr img, .pro-qr canvas").count() >= 1);

// free cap: shrink the limit via the same code path (recLimitSec) instead of
// waiting 90 real seconds — the cap logic in tick() reads it live.
await page.evaluate(() => { window.JBPro.recLimitSec = () => 3; });
await page.click(".pro-close");
await page.waitForFunction(() => window.__JB && window.__JB.library.length >= 2, null, { timeout: 40000 });
await page.click("#btn-autoload");
await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track; }, null, { timeout: 15000 });
await page.click("#deckA .btn-play");
await page.click("#btn-rec");
await page.waitForFunction(() => !document.querySelector("#rec-save").hidden, null, { timeout: 15000 });
const capState = await page.evaluate(() => ({
  recOff: !document.querySelector("#btn-rec").classList.contains("on"),
  toast: document.querySelector("#toast") && document.querySelector("#toast").textContent,
  panelOpen: !!document.querySelector(".pro-card")
}));
ok("free cap auto-stops the recording and saves it", capState.recOff);
ok("cap toast mentions Pro", /Pro/.test(capState.toast || ""), capState.toast);
ok("cap opens the Pro panel", capState.panelOpen);
const capBlob = await page.evaluate(async () => {
  const b = await fetch(document.querySelector("#rec-save").href).then((r) => r.blob());
  return b.size;
});
ok("capped take is still a real file", capBlob > 2000, capBlob + " bytes");

// unlock → cap gone, bitrate up, chip flips
await page.evaluate(() => { window.JBPro.unlock("qa"); window.JBPro.closePanel(); });
const proState = await page.evaluate(() => ({
  pro: window.JBPro.isPro(),
  limit: window.JBPro.recLimitSec(),   // note: was stubbed above — reload will restore the real fn
  bits: window.JBPro.recBitsPerSecond(),
  chip: document.querySelector("#btn-pro").textContent
}));
ok("unlock flips to Pro", proState.pro && proState.bits === 256000, JSON.stringify({ bits: proState.bits }));
ok("chip shows PRO", /★ PRO/.test(proState.chip), proState.chip);

// persistence: reload keeps Pro, real recLimit is Infinity, panel shows active state
await page.reload();
await page.waitForSelector("body.booted", { timeout: 20000 });
const persisted = await page.evaluate(() => ({ pro: window.JBPro.isPro(), limit: window.JBPro.recLimitSec() }));
ok("Pro persists across reload with unlimited recording", persisted.pro && persisted.limit === Infinity, JSON.stringify(persisted));
await page.click("#btn-pro");
ok("panel shows active state, no payment UI", await page.evaluate(() =>
  !!document.querySelector(".pro-active") && !document.querySelector(".pro-chip")));
ok("no page errors (web)", errors.length === 0, errors.slice(0, 3).join(" | "));
await page.close();

/* ── #pro deep link (fresh storage) ── */
const ctx2 = await browser.newContext();
const deep = await ctx2.newPage();
await deep.goto(base + "/app.html#pro");
await deep.waitForSelector(".pro-card", { timeout: 15000 });
ok("landing deep-link app.html#pro opens the panel", true);
await ctx2.close();

/* ── Android app UA: Pro included, payment UI hidden ── */
const appCtx = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 JukeboxDJApp" });
const app = await appCtx.newPage();
const appErrors = [];
app.on("pageerror", (e) => appErrors.push(String(e)));
await app.goto(base + "/app.html");
await app.waitForSelector("body.booted", { timeout: 20000 });
const appState = await app.evaluate(() => ({
  isApp: window.JBPro.isApp(),
  pro: window.JBPro.isPro(),
  limit: window.JBPro.recLimitSec(),
  chip: document.querySelector("#btn-pro").textContent
}));
ok("app UA detected", appState.isApp);
ok("Pro included in the app (no purchase needed)", appState.pro && appState.limit === Infinity);
ok("chip shows PRO in app", /★ PRO/.test(appState.chip));
await app.click("#btn-pro");
await app.waitForSelector(".pro-card", { timeout: 5000 });
const appPanel = await app.evaluate(() => ({
  active: !!document.querySelector(".pro-active"),
  activeText: (document.querySelector(".pro-active") || {}).textContent || "",
  crypto: !!document.querySelector(".pro-chip") || !!document.querySelector(".pro-addr") || !!document.querySelector(".pro-qr")
}));
ok("app panel says Pro is included", /included with the Android app/.test(appPanel.activeText));
ok("NO crypto/payment UI in the app (Play policy)", appPanel.crypto === false);
ok("no page errors (app UA)", appErrors.length === 0, appErrors.slice(0, 2).join(" | "));
await appCtx.close();

/* ── landing pricing ── */
const land = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await land.goto(base + "/");
ok("pricing section present", await land.locator("#pricing .plan").count() === 2);
ok("free plan lists the 90s cap", /90 seconds/.test(await land.locator(".plan:not(.pro)").textContent()));
ok("pro plan links to app.html#pro", await land.locator('.plan.pro a[href="app.html#pro"]').count() === 1);
ok("Android APK download button present", await land.locator('a[href="jukeboxdj.apk"]').count() === 1);
await land.close();

await browser.close();
srv.close();
console.log(failed ? `PRO: ${failed} FAILURES` : "PRO: all green");
process.exit(failed ? 1 : 0);
