/* Adversarial probe 3 — lifecycle & resource abuse: same record on both decks
   (detached-buffer trap), context suspend/resume, rapid record swapping while
   playing, two app tabs at once, reload mid-recording, extreme viewports. */
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
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/app.html");
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });

// same record on BOTH decks — the per-load channel copies must not detach the source
const both = await page.evaluate(async () => {
  const jb = window.__JB;
  await jb.loadToDeck("A", jb.library[0]);
  await jb.loadToDeck("B", jb.library[0]);   // same buffer again
  jb.decks.A.togglePlay(); jb.decks.B.togglePlay();
  await new Promise((r) => setTimeout(r, 700));
  const rms = (id) => new Promise((res) => {
    const an = jb.decks[id].analyser, arr = new Float32Array(an.fftSize);
    let peak = 0, n = 0;
    const iv = setInterval(() => {
      an.getFloatTimeDomainData(arr);
      let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
      peak = Math.max(peak, Math.sqrt(s / arr.length));
      if (++n >= 6) { clearInterval(iv); res(peak); }
    }, 50);
  });
  const [a, b] = await Promise.all([rms("A"), rms("B")]);
  return { a, b };
});
ok("same record plays on both decks at once", both.a > 0.01 && both.b > 0.01, `A=${both.a.toFixed(3)} B=${both.b.toFixed(3)}`);
// …and a third load of the same track still works (source buffer not consumed)
const thirdLoad = await page.evaluate(async () => {
  await window.__JB.loadToDeck("B", window.__JB.library[0]);
  return window.__JB.decks.B.track.buffer.length > 0;
});
ok("source buffer survives repeated loads (no detach)", thirdLoad);

// context suspend/resume (tab backgrounding) mid-play
const susres = await page.evaluate(async () => {
  const jb = window.__JB, ctx = jb.ctx();
  await ctx.suspend();
  const stateSus = ctx.state;
  await new Promise((r) => setTimeout(r, 300));
  await ctx.resume();
  await new Promise((r) => setTimeout(r, 400));
  const p0 = jb.decks.A.pos;
  await new Promise((r) => setTimeout(r, 400));
  return { stateSus, state: ctx.state, advanced: jb.decks.A.pos - p0 };
});
ok("suspend→resume keeps the deck spinning", susres.stateSus === "suspended" && susres.state === "running" && susres.advanced > 5000, JSON.stringify(susres));

// rapid record swapping on a playing deck (10 swaps, no waiting)
const swapStorm = await page.evaluate(async () => {
  const jb = window.__JB;
  for (let i = 0; i < 10; i++) await jb.loadToDeck("A", jb.library[i % 6]);
  jb.decks.A.togglePlay();
  await new Promise((r) => setTimeout(r, 500));
  return { name: jb.decks.A.track.name, pos: jb.decks.A.pos, finite: Number.isFinite(jb.decks.A.pos), playing: jb.decks.A.playing };
});
ok("10 rapid record swaps land on the last record, playing", swapStorm.finite && swapStorm.playing && swapStorm.pos > 1000, JSON.stringify({ name: swapStorm.name, pos: swapStorm.pos | 0 }));

// second tab: independent console, both alive
const page2 = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors2 = [];
page2.on("pageerror", (e) => errors2.push(String(e)));
await page2.goto(base + "/app.html");
await page2.waitForFunction(() => window.__JB && window.__JB.library.length >= 1, null, { timeout: 60000 });
await page2.evaluate(async () => { await window.__JB.loadToDeck("A", window.__JB.library[0]); window.__JB.decks.A.togglePlay(); });
await page2.waitForTimeout(600);
const twoTabs = await Promise.all([
  page.evaluate(() => window.__JB.ctx().state),
  page2.evaluate(() => ({ state: window.__JB.ctx().state, pos: window.__JB.decks.A.pos }))
]);
ok("two tabs run two independent consoles", twoTabs[0] === "running" && twoTabs[1].state === "running" && twoTabs[1].pos > 0, JSON.stringify(twoTabs[1]));
ok("no errors in second tab", errors2.length === 0, errors2.slice(0, 2).join(" | "));
await page2.close();

// reload mid-recording: fresh boot, no stuck state
await page.click("#btn-rec");
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector("body.booted", { timeout: 20000 });
const fresh = await page.evaluate(() => ({
  recOn: document.querySelector("#btn-rec").classList.contains("on"),
  saveHidden: document.querySelector("#rec-save").hidden
}));
ok("reload mid-recording boots clean", !fresh.recOn && fresh.saveHidden, JSON.stringify(fresh));

// extreme viewports: 320 px and 2560 px — no horizontal overflow either way
for (const w of [320, 2560]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(400);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`no horizontal overflow at ${w}px`, over <= 1, "overflow=" + over + "px");
}

ok("no page errors through lifecycle probes", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
srv.close();
console.log(failed ? `PROBE3: ${failed} FAILURES` : "PROBE3: lifecycle holds");
process.exit(failed ? 1 : 0);
