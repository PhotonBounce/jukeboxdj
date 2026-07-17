/* Audio-path assertions: EQ kills change the spectrum, filter sweeps bite,
   echo leaves a tail, user files decode + get a BPM, recording captures both decks. */
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

/* Make a 4s 130 BPM click-train WAV (spike every beat + 220 Hz tone bed) so
   file loading AND the BPM estimator can be validated against ground truth. */
function makeWav () {
  const sr = 44100, sec = 8, n = sr * sec, bpm = 130, beat = (60 / bpm) * sr;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0.12 * Math.sin(2 * Math.PI * 220 * i / sr);
    const ph = i % Math.round(beat);
    if (ph < 900) v += 0.85 * Math.exp(-ph / 160) * Math.sin(2 * Math.PI * 90 * ph / sr);
    pcm[i] = Math.max(-32768, Math.min(32767, v * 32767));
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  const p = path.join(HERE, "fixture-130bpm.wav");
  fs.writeFileSync(p, buf);
  return p;
}

const wavPath = makeWav();
const browser = await chromium.launch({ executablePath: EXE, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const { srv, base } = await serve();
await page.goto(base + "/app.html");
await page.waitForFunction(() => window.__JB && window.__JB.library.filter((t) => !t.featured).length === 6, null, { timeout: 60000 });
await page.click("#btn-autoload");
await page.waitForFunction(() => { const d = window.__JB.decks; return d.A && d.A.track && d.B.track; });
await page.click("#deckA .btn-play");
await page.waitForTimeout(700);

/* helper: average band energy from deck A's analyser */
/* smoothing 0 + 40 Hz floor: the default 0.8 smoothing and the DC bin once
   made a genuine -38 dB kill read as only -4 dB (probe artifact, verified
   against getFrequencyResponse ground truth). */
const bandEnergy = () => page.evaluate(() => new Promise((res) => {
  const an = window.__JB.decks.A.analyser;
  an.fftSize = 2048; an.smoothingTimeConstant = 0;
  const bins = new Float32Array(an.frequencyBinCount);
  const acc = { lo: 0, hi: 0 }; let n = 0;
  const iv = setInterval(() => {
    an.getFloatFrequencyData(bins);
    const sr = window.__JB.ctx().sampleRate, hz = sr / 2 / bins.length;
    let lo = 0, hi = 0, nl = 0, nh = 0;
    for (let i = 1; i < bins.length; i++) {
      const f = i * hz, v = Math.pow(10, bins[i] / 20);
      if (f >= 40 && f < 150) { lo += v; nl++; } else if (f > 5000 && f < 12000) { hi += v; nh++; }
    }
    acc.lo += lo / nl; acc.hi += hi / nh;
    if (++n >= 16) { clearInterval(iv); res({ lo: acc.lo / n, hi: acc.hi / n }); }
  }, 60);
}));

const flat = await bandEnergy();
await page.evaluate(() => { window.__JB.decks.A.eqLo.gain.value = -40; });
await page.waitForTimeout(900);
const loKilled = await bandEnergy();
ok("LOW kill guts the bass band", loKilled.lo < flat.lo * 0.25, `lo ${flat.lo.toExponential(2)} → ${loKilled.lo.toExponential(2)}`);
ok("LOW kill leaves highs intact", loKilled.hi > flat.hi * 0.4, `hi ${flat.hi.toExponential(2)} → ${loKilled.hi.toExponential(2)}`);
await page.evaluate(() => { window.__JB.decks.A.eqLo.gain.value = 0; });

// filter LP: highs collapse
await page.evaluate(() => { const f = window.__JB.decks.A.filter; f.type = "lowpass"; f.frequency.value = 300; f.Q.value = 6; });
await page.waitForTimeout(300);
const lp = await bandEnergy();
ok("low-pass filter crushes highs", lp.hi < flat.hi * 0.2, `hi ${flat.hi.toExponential(2)} → ${lp.hi.toExponential(2)}`);
await page.evaluate(() => { const f = window.__JB.decks.A.filter; f.type = "allpass"; f.frequency.value = 1000; f.Q.value = 0.8; });

// echo: pause the deck with echo up → tail rings on the channel
const tail = await page.evaluate(() => new Promise((res) => {
  const jb = window.__JB, d = jb.decks.A;
  d.echoSend.gain.value = 0.85;
  setTimeout(() => {
    d.togglePlay(); // pause; only echo tail remains
    setTimeout(() => {
      const an = d.analyser, arr = new Float32Array(an.fftSize);
      let peak = 0, n = 0;
      const iv = setInterval(() => {
        an.getFloatTimeDomainData(arr);
        let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
        peak = Math.max(peak, Math.sqrt(s / arr.length));
        if (++n >= 8) { clearInterval(iv); d.echoSend.gain.value = 0; d.togglePlay(); res(peak); }
      }, 60);
    }, 120);
  }, 600);
}));
ok("echo tail rings after pause", tail > 0.004, "tailRMS=" + tail.toFixed(4));

// user file: upload through the real input, decode, BPM estimate ≈ 130
await page.locator("#file-input").setInputFiles(wavPath);
await page.waitForFunction(() => window.__JB.library.some((t) => t.custom), null, { timeout: 20000 });
const user = await page.evaluate(() => {
  const t = window.__JB.library[window.__JB.library.length - 1];
  return { name: t.name, bpm: t.bpm, dur: t.buffer.duration, custom: t.custom };
});
ok("user WAV decoded into the jukebox", user.custom && Math.abs(user.dur - 8) < 0.2, JSON.stringify(user));
ok("BPM estimator lands on 130 (±3 or half/double)", [65, 130, 260].some((m) => Math.abs(user.bpm - m) <= 3), "est=" + user.bpm);

// load user track to deck B and play — signal flows
await page.evaluate(() => window.__JB.loadToDeck("B", window.__JB.library.find((t) => t.custom)));
await page.waitForTimeout(200);
await page.click("#deckB .btn-play");
await page.waitForTimeout(600);
const bRms = await page.evaluate(() => new Promise((res) => {
  const an = window.__JB.decks.B.analyser, arr = new Float32Array(an.fftSize);
  let peak = 0, n = 0;
  const iv = setInterval(() => {
    an.getFloatTimeDomainData(arr);
    let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    peak = Math.max(peak, Math.sqrt(s / arr.length));
    if (++n >= 8) { clearInterval(iv); res(peak); }
  }, 50);
}));
ok("user track audible on deck B", bRms > 0.01, "rms=" + bRms.toFixed(4));

// record both decks + a scratch, then decode the webm and check it's not silence
await page.click("#btn-rec");
await page.evaluate(async () => {
  const d = window.__JB.decks.A;
  d.scratch(true); d.scratchVel(-3);
  await new Promise((r) => setTimeout(r, 350));
  d.scratchVel(2.5);
  await new Promise((r) => setTimeout(r, 350));
  d.scratchVel(0); d.scratch(false);
});
await page.waitForTimeout(900);
await page.click("#btn-rec");
await page.waitForFunction(() => !document.querySelector("#rec-save").hidden, null, { timeout: 6000 });
const recRms = await page.evaluate(async () => {
  const a = document.querySelector("#rec-save");
  const buf = await fetch(a.href).then((r) => r.arrayBuffer());
  const audio = await window.__JB.ctx().decodeAudioData(buf.slice(0));
  const d = audio.getChannelData(0);
  let s = 0; for (let i = 0; i < d.length; i += 8) s += d[i] * d[i];
  return { rms: Math.sqrt(s / (d.length / 8)), dur: audio.duration };
});
ok("recorded mix decodes and is audible", recRms.rms > 0.01 && recRms.dur > 1, JSON.stringify({ rms: recRms.rms.toFixed(3), dur: recRms.dur.toFixed(2) }));

ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
srv.close();
console.log(failed ? `AUDIO: ${failed} FAILURES` : "AUDIO: all green");
process.exit(failed ? 1 : 0);
