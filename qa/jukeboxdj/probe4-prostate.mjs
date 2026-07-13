/* Adversarial probe 4 — Pro-state abuse: garbage/tampered localStorage, type
   confusion, unlock spam, record-cap racing a scratch, panel open/close spam,
   and the cap firing exactly while the save chip is already showing. */
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

// tampered/garbage pro state must degrade to FREE, never crash, never grant pro
for (const [label, value] of [
  ["raw garbage", "not json at all {{{"],
  ["wrong type", '"pro"'],
  ["truthy string pro", '{"pro":"yes"}'],
  ["number pro", '{"pro":1}'],
  ["huge blob", JSON.stringify({ pro: false, junk: "x".repeat(200000) })]
]) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(base + "/app.html");
  await p.evaluate((v) => { localStorage.setItem("jbdj.pro.v2", v); }, value);
  await p.reload();
  await p.waitForSelector("body.booted", { timeout: 20000 });
  const st = await p.evaluate(() => ({ pro: window.JBPro.isPro(), limit: window.JBPro.recLimitSec() }));
  // trial model: garbage state must never grant Pro and must never crash; it may
  // fall back to a fresh trial (unlimited) or the post-trial 90s cap — both fine.
  ok(`tamper[${label}] → not Pro, no crash`, st.pro === false && errs.length === 0,
    JSON.stringify(st) + (errs.length ? " ERR:" + errs[0] : ""));
  await ctx.close();
}

// main abuse page
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/app.html");
await page.waitForSelector("body.booted", { timeout: 20000 });

// unlock/relock spam via internals + panel open/close spam
await page.evaluate(() => {
  for (let i = 0; i < 30; i++) {
    window.JBPro.unlock("spam");
    localStorage.removeItem("jbdj.pro.v2");
    window.JBPro.openPanel();
    window.JBPro.closePanel();
  }
});
const overlays = await page.locator(".pro-overlay").count();
ok("30x unlock+panel spam leaves at most 0 overlays", overlays === 0, overlays + " overlays");

// cap firing mid-scratch: shrink cap, start recording, keep a scratch running
await page.evaluate(() => { window.JBPro.recLimitSec = () => 2; });
await page.waitForFunction(() => window.__JB && window.__JB.library.length >= 2, null, { timeout: 40000 });
await page.click("#btn-autoload");
await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track; }, null, { timeout: 15000 });
await page.click("#deckA .btn-play");
await page.click("#btn-rec");
await page.evaluate(() => { const d = window.__JB.decks.A; d.scratch(true); d.scratchVel(-2); });
await page.waitForFunction(() => !document.querySelector("#rec-save").hidden, null, { timeout: 12000 });
await page.evaluate(() => { const d = window.__JB.decks.A; d.scratchVel(0); d.scratch(false); });
const midScratch = await page.evaluate(() => ({
  recOff: !document.querySelector("#btn-rec").classList.contains("on"),
  posFinite: Number.isFinite(window.__JB.decks.A.pos)
}));
ok("cap fires cleanly mid-scratch", midScratch.recOff && midScratch.posFinite, JSON.stringify(midScratch));
await page.evaluate(() => window.JBPro.closePanel());

// immediately re-record after a capped stop (recorder state machine reuse)
const second = await page.evaluate(async () => {
  const btn = document.querySelector("#btn-rec");
  btn.click();                                   // start again
  await new Promise((r) => setTimeout(r, 800));
  const during = btn.classList.contains("on");
  btn.click();                                   // manual stop before cap
  await new Promise((r) => setTimeout(r, 800));
  return { during, after: btn.classList.contains("on") };
});
ok("recorder restarts cleanly after a capped take", second.during && !second.after, JSON.stringify(second));
await page.evaluate(() => window.JBPro.closePanel());

// pro unlock while a recording is running lifts the cap live
await page.evaluate(() => {
  delete window.JBPro.recLimitSec; // restore prototype-less stub → re-stub real behavior
});
const liveUnlock = await page.evaluate(async () => {
  // stub a 2s cap that reads pro state live, mirroring the real implementation
  window.JBPro.recLimitSec = () => (window.JBPro.isPro() ? Infinity : 2);
  document.querySelector("#btn-rec").click();
  await new Promise((r) => setTimeout(r, 900));
  window.JBPro.unlock("qa-live");                // unlock mid-take
  await new Promise((r) => setTimeout(r, 2600)); // sail past the old cap
  const stillOn = document.querySelector("#btn-rec").classList.contains("on");
  document.querySelector("#btn-rec").click();
  return stillOn;
});
ok("unlocking mid-take lifts the cap without stopping the recording", liveUnlock === true);

ok("no page errors through pro-state abuse", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
srv.close();
console.log(failed ? `PROBE4: ${failed} FAILURES` : "PROBE4: pro-state holds");
process.exit(failed ? 1 : 0);
