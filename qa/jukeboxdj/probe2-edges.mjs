/* Adversarial probe 2 — hostile edges: sub-second tracks, scratching past both
   ends, loops butting the end-of-record, seeks mid-scratch, recording silence,
   corrupt file uploads, extreme rates, and swapping records mid-scratch. */
import { chromium } from "playwright";
import { serve } from "./serve.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (extra ? "  [" + extra + "]" : ""));
  if (!cond) failed++;
};

const corrupt = path.join(HERE, "fixture-corrupt.mp3");
fs.writeFileSync(corrupt, Buffer.from("this is not audio at all — just bytes wearing an .mp3 name"));

const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const { srv, base } = await serve();
await page.goto(base + "/app.html");
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });

// tiny 0.4 s record straight into the deck
await page.evaluate(async () => {
  const jb = window.__JB;
  await jb.ensureAudio();
  const ctx = jb.ctx();
  const buf = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * 0.05) * 0.4; }
  window.__tiny = { id: "tiny", name: "Tiny", style: "probe", bpm: 120, color: "#fff", buffer: buf, custom: true };
  await jb.loadToDeck("A", window.__tiny);
});
const tinyEnds = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.togglePlay();
  await new Promise((r) => setTimeout(r, 900)); // longer than the record
  return { playing: d.playing, pos: d.pos, len: d.track.buffer.length, finite: Number.isFinite(d.pos) };
});
ok("0.4s record loops (auto-restarts) at the end", tinyEnds.playing && tinyEnds.finite && tinyEnds.pos < tinyEnds.len, JSON.stringify({ pos: tinyEnds.pos | 0, len: tinyEnds.len }));

// scratch violently past both ends of the tiny record
const ends = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.scratch(true); d.scratchVel(30);          // way past the end
  await new Promise((r) => setTimeout(r, 350));
  const atEnd = d.pos;
  d.scratchVel(-30);                          // way past the start
  await new Promise((r) => setTimeout(r, 500));
  const atStart = d.pos;
  d.scratchVel(0); d.scratch(false);
  const len = d.track.buffer.length;
  return { atEnd, atStart, len, ok: atEnd <= len - 1 && atStart >= 0 && Number.isFinite(atEnd) && Number.isFinite(atStart) };
});
ok("violent scratching clamps at both ends", ends.ok, JSON.stringify({ end: ends.atEnd | 0, start: ends.atStart | 0, len: ends.len }));

// loop window butting the end of the record
const endLoop = await page.evaluate(async () => {
  const jb = window.__JB;
  await jb.loadToDeck("A", jb.library[0]);
  const d = jb.decks.A;
  const len = d.track.buffer.length;
  d.seek(len - 2000);          // 45 ms before the end
  d.setLoop(4);                // loop extends past EOF — must clamp
  d.togglePlay();
  await new Promise((r) => setTimeout(r, 900));
  const st = { playing: d.playing, pos: d.pos, len, finite: Number.isFinite(d.pos) };
  d.setLoop(0); if (d.playing) d.togglePlay();
  return st;
});
ok("loop clamped at EOF keeps position sane", endLoop.finite && endLoop.pos <= endLoop.len - 1, JSON.stringify({ pos: endLoop.pos | 0, len: endLoop.len }));

// seek while scratching — no corruption
const seekScratch = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.scratch(true); d.scratchVel(2);
  await new Promise((r) => setTimeout(r, 150));
  d.seek(d.track.buffer.length * 0.5);
  await new Promise((r) => setTimeout(r, 150));
  d.scratchVel(0); d.scratch(false);
  return Number.isFinite(d.pos) && d.pos >= 0 && d.pos <= d.track.buffer.length - 1;
});
ok("seek during a scratch stays consistent", seekScratch);

// swap the record mid-scratch — load whatever record sits at index 2 and assert
// the deck actually adopted THAT record (comparing to its own name, not a
// hardcoded title — featured tracks reindex the library, so index 2 is not
// fixed) and reset the playhead cleanly.
const swap = await page.evaluate(async () => {
  const jb = window.__JB, d = jb.decks.A;
  const target = jb.library[2];               // capture the record we intend to load
  d.togglePlay(); d.scratch(true); d.scratchVel(-5);
  await new Promise((r) => setTimeout(r, 120));
  await jb.loadToDeck("A", target);           // load while hand is "on the platter"
  await new Promise((r) => setTimeout(r, 250));
  const st = { name: d.track.name, want: target.name, pos: d.pos, finite: Number.isFinite(d.pos) };
  d.scratchVel(0); d.scratch(false);
  return st;
});
ok("swapping records mid-scratch resets cleanly", swap.finite && swap.name === swap.want && swap.pos < 44100 * 3, JSON.stringify(swap));

// record pure silence — still yields a decodable (quiet) file
await page.click("#btn-rec");
await page.waitForTimeout(900);
await page.click("#btn-rec");
await page.waitForFunction(() => !document.querySelector("#rec-save").hidden, null, { timeout: 6000 });
const silent = await page.evaluate(async () => {
  const a = document.querySelector("#rec-save");
  const buf = await fetch(a.href).then((r) => r.arrayBuffer());
  try { const au = await window.__JB.ctx().decodeAudioData(buf.slice(0)); return { ok: true, dur: au.duration }; }
  catch (e) { return { ok: false }; }
});
ok("recording silence still produces a valid file", silent.ok && silent.dur > 0.5, "dur=" + (silent.dur || 0).toFixed(2));

// corrupt "mp3": rejected gracefully, library unchanged, app alive
const libBefore = await page.evaluate(() => window.__JB.library.length);
await page.locator("#file-input").setInputFiles(corrupt);
await page.waitForTimeout(1500);
const afterCorrupt = await page.evaluate(() => ({
  lib: window.__JB.library.length,
  status: document.querySelector("#lib-status").textContent
}));
ok("corrupt file rejected without crashing", afterCorrupt.lib === libBefore, afterCorrupt.status);

// extreme + non-finite rates via internals — engine must ignore/clamp
const extremes = await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.setRate(Infinity); d.setRate(NaN); d.setRate(-3);
  d.node.port.postMessage({ t: "svel", v: NaN });
  d.node.port.postMessage({ t: "seek", p: Infinity });
  d.togglePlay();
  await new Promise((r) => setTimeout(r, 400));
  const st = { pos: d.pos, finite: Number.isFinite(d.pos) };
  if (d.playing) d.togglePlay(); d.setRate(1);
  return st;
});
ok("Infinity/NaN rate+seek cannot corrupt the playhead", extremes.finite, "pos=" + (extremes.pos | 0));

// rapid record toggle spam
for (let i = 0; i < 6; i++) { await page.click("#btn-rec"); await page.waitForTimeout(90); }
await page.waitForTimeout(600);
const recState = await page.evaluate(() => document.querySelector("#btn-rec").classList.contains("on"));
ok("record button survives toggle spam (even count → off)", recState === false, "on=" + recState);

ok("no page errors through all edge probes", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
srv.close();
console.log(failed ? `PROBE2: ${failed} FAILURES` : "PROBE2: edges hold");
process.exit(failed ? 1 : 0);
