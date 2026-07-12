/* Pro / monetization suite: a 1-day free trial gives full access, then a paywall
   with reveal-on-click payment methods (crypto / Cash App / bank / check). Unlock
   persists; the Android app auto-unlocks with no payment UI (Play policy). */
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

/* ── fresh visitor: inside the free day ── */
const ctx0 = await browser.newContext();
const page = await ctx0.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/app.html");
await page.waitForSelector("body.booted", { timeout: 20000 });

ok("JBPro API present", await page.evaluate(() => !!window.JBPro));
const fresh = await page.evaluate(() => ({ pro: window.JBPro.isPro(), trial: window.JBPro.trialActive(), access: window.JBPro.hasAccess(), limit: window.JBPro.recLimitSec() }));
ok("fresh visitor gets the free-day trial (not Pro)", !fresh.pro && fresh.trial && fresh.access, JSON.stringify(fresh));
ok("trial gives full access (unlimited recording)", fresh.limit === null || fresh.limit === Infinity || fresh.limit > 1e6, "limit=" + fresh.limit);
ok("GO PRO chip shown", (await page.locator("#btn-pro").textContent()).includes("GO PRO"));

/* panel: 4 payment methods, nothing sensitive shown until a method is tapped */
await page.click("#btn-pro");
await page.waitForSelector(".pro-card", { timeout: 5000 });
ok("panel shows 4 payment methods", await page.locator(".pay-methods .pro-chip").count() === 4);
ok("no wallet/cashtag shown until a method is tapped", await page.locator(".pro-addr").count() === 0);

await page.click(".pay-methods .pro-chip[data-k='crypto']");
await page.waitForSelector(".pro-addr", { timeout: 5000 });
ok("tapping Crypto reveals the EVM wallet", (await page.locator(".pro-addr").first().textContent()).startsWith("0x75B30d"));
await page.click(".pro-method-body .pro-chip[data-k='btc']");
await page.waitForTimeout(120);
ok("BTC sub-chip swaps the wallet", (await page.locator(".pro-addr").first().textContent()).startsWith("bc1q"));
ok("QR rendered", await page.locator(".pro-qr img, .pro-qr canvas").count() >= 1);

await page.click(".pay-methods .pro-chip[data-k='cashapp']");
await page.waitForTimeout(150);
ok("tapping Cash App reveals the cashtag", /photonbounce/.test(await page.locator(".pro-addr").first().textContent()));
await page.click(".pay-methods .pro-chip[data-k='wire']");
await page.waitForTimeout(120);
ok("bank wire reveals contact instructions (no fake bank numbers)", /photon-bounce\.com/.test(await page.evaluate(() => document.querySelector(".pro-method-body").textContent)));
await page.click(".pro-close");

/* ── simulate the free day expiring ── */
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("jbdj.pro.v2") || "{}");
  s.trialStart = Date.now() - 2 * 24 * 3600 * 1000;   // 2 days ago
  localStorage.setItem("jbdj.pro.v2", JSON.stringify(s));
});
await page.reload();
await page.waitForSelector("body.booted", { timeout: 20000 });
const expired = await page.evaluate(() => ({ trial: window.JBPro.trialActive(), access: window.JBPro.hasAccess(), limit: window.JBPro.recLimitSec() }));
ok("after the free day: trial over + recording capped to 90s", !expired.trial && !expired.access && expired.limit === 90, JSON.stringify(expired));
await page.waitForSelector(".pro-card .pro-trial.end", { timeout: 6000 });
ok("paywall auto-opens after the free day", true);

/* ── unlock ── */
await page.evaluate(() => window.JBPro.unlock("qa"));
const proState = await page.evaluate(() => ({ pro: window.JBPro.isPro(), limit: window.JBPro.recLimitSec(), bits: window.JBPro.recBitsPerSecond(), chip: document.querySelector("#btn-pro").textContent }));
ok("unlock flips to Pro (unlimited, 256k)", proState.pro && proState.limit === Infinity && proState.bits === 256000, JSON.stringify({ bits: proState.bits }));
ok("chip shows PRO", /★ PRO/.test(proState.chip), proState.chip);

await page.reload();
await page.waitForSelector("body.booted", { timeout: 20000 });
ok("Pro persists across reload with unlimited recording", await page.evaluate(() => window.JBPro.isPro() && window.JBPro.recLimitSec() === Infinity));
await page.click("#btn-pro");
await page.waitForSelector(".pro-card", { timeout: 5000 });
ok("panel shows active state, no payment UI", await page.evaluate(() => !!document.querySelector(".pro-active") && !document.querySelector(".pay-methods")));
ok("no page errors (web)", errors.length === 0, errors.slice(0, 3).join(" | "));
await ctx0.close();

/* ── #pro deep link (fresh storage) opens the panel ── */
const ctx2 = await browser.newContext();
const deep = await ctx2.newPage();
await deep.goto(base + "/app.html#pro");
await deep.waitForSelector(".pro-card", { timeout: 15000 });
ok("app.html#pro deep-link opens the panel", true);
await ctx2.close();

/* ── Android app UA: auto-Pro, NO payment UI ── */
const appCtx = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 JukeboxDJApp" });
const app = await appCtx.newPage();
const appErrors = [];
app.on("pageerror", (e) => appErrors.push(String(e)));
await app.goto(base + "/app.html");
await app.waitForSelector("body.booted", { timeout: 20000 });
const appState = await app.evaluate(() => ({ isApp: window.JBPro.isApp(), pro: window.JBPro.isPro(), limit: window.JBPro.recLimitSec(), chip: document.querySelector("#btn-pro").textContent }));
ok("app UA detected", appState.isApp);
ok("Pro included in the app (no purchase needed)", appState.pro && appState.limit === Infinity);
ok("chip shows PRO in app", /★ PRO/.test(appState.chip));
await app.click("#btn-pro");
await app.waitForSelector(".pro-card", { timeout: 5000 });
const appPanel = await app.evaluate(() => ({
  activeText: (document.querySelector(".pro-active") || {}).textContent || "",
  pay: !!document.querySelector(".pay-methods") || !!document.querySelector(".pro-addr") || !!document.querySelector(".pro-qr")
}));
ok("app panel says Pro is included", /included with the Android app/.test(appPanel.activeText));
ok("NO payment UI in the app (Play policy)", appPanel.pay === false);
ok("no page errors (app UA)", appErrors.length === 0, appErrors.slice(0, 2).join(" | "));
await appCtx.close();

/* ── landing pricing (trial model) ── */
const land = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await land.goto(base + "/");
ok("pricing section has 2 plans", await land.locator("#pricing .plan").count() === 2);
ok("free plan advertises the 1-day trial", /1 day|free day/i.test(await land.locator(".plan:not(.pro)").textContent()));
ok("pro plan shows the price + links to unlock", /\$6\.99/.test(await land.locator(".plan.pro").textContent()) && await land.locator('.plan.pro a[href="app.html#pro"]').count() === 1);
ok("pricing note lists Cash App / wire / check", /Cash App/.test(await land.locator(".pricing-note").textContent()));
ok("Android APK download button present", await land.locator('a[href="jukeboxdj.apk"]').count() >= 1);
await land.close();

await browser.close();
srv.close();
console.log(failed ? `PRO: ${failed} FAILURES` : "PRO: all green");
process.exit(failed ? 1 : 0);
