/* Landing microsite: renders, every image loads, CTAs point at the app,
   privacy/terms exist, meta/OG present, no console errors, mobile reflows. */
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (extra ? "  [" + extra + "]" : ""));
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const { srv, base } = await serve();

const resp = await page.goto(base + "/");
ok("landing serves 200", resp.status() === 200);
ok("title mentions turntables", (await page.title()).includes("Turntables"));

// scroll to force lazy images, then verify every one decoded
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
});
await page.waitForTimeout(800);
const imgs = await page.evaluate(() => Array.from(document.images).map((i) => ({ src: i.src.split("/").pop(), ok: i.complete && i.naturalWidth > 0 })));
ok("all " + imgs.length + " images load", imgs.every((i) => i.ok), imgs.filter((i) => !i.ok).map((i) => i.src).join(","));
ok("gallery includes 5 app screenshots", imgs.filter((i) => /console|deck|mixer|jukebox|mobile/.test(i.src)).length === 5);

const og = await page.evaluate(() => ({
  img: document.querySelector('meta[property="og:image"]')?.content || "",
  desc: document.querySelector('meta[name="description"]')?.content || ""
}));
ok("og:image points at /jukeboxdj/", og.img.includes("/jukeboxdj/assets/og.png"));
ok("meta description sells the decks", og.desc.length > 80 && /scratch/i.test(og.desc));

const ctas = await page.evaluate(() => Array.from(document.querySelectorAll('a[href="app.html"]')).length);
ok("at least 3 CTAs open the app", ctas >= 3, ctas + " CTAs");

// the app link actually works from the landing
await page.click(".cta-row a.btn-primary");
await page.waitForSelector("body.booted", { timeout: 20000 });
ok("hero CTA lands on a booting console", true);
await page.goBack();

for (const p of ["privacy.html", "terms.html"]) {
  const r = await page.request.get(base + "/" + p);
  ok(p + " serves 200", r.status() === 200);
}
const sw = await page.request.get(base + "/sw.js");
ok("sw.js served and versioned", sw.status() === 200 && /jukeboxdj-v\d+/.test(await sw.text()));
const man = await page.request.get(base + "/manifest.webmanifest");
ok("manifest valid JSON with icons", man.status() === 200 && (JSON.parse(await man.text()).icons || []).length === 2);

// mobile reflow: no horizontal scroll
const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
await mob.goto(base + "/");
await mob.waitForTimeout(600);
const hScroll = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("no horizontal overflow at 390px", hScroll <= 1, "overflow=" + hScroll + "px");

ok("no console/page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
srv.close();
console.log(failed ? `LANDING: ${failed} FAILURES` : "LANDING: all green");
process.exit(failed ? 1 : 0);
