import { chromium } from "playwright";
import { serve } from "./serve.mjs";
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let fail=0; const ok=(n,c,x)=>{console.log((c?"  ✓ ":"  ✗ ")+n+(x?"  ["+x+"]":""));if(!c)fail++;};
// build a tiny valid WAV (1.2s stereo sine) for the IndexedDB round-trip
function makeWav(){const sr=44100,ch=2,n=Math.floor(sr*1.2);const bytes=44+n*ch*2;const b=Buffer.alloc(bytes);
  b.write("RIFF",0);b.writeUInt32LE(bytes-8,4);b.write("WAVE",8);b.write("fmt ",12);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(ch,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*ch*2,28);b.writeUInt16LE(ch*2,32);
  b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(n*ch*2,40);let o=44;
  for(let i=0;i<n;i++){const s=Math.sin(i*0.05)*0.4*32767;for(let c=0;c<ch;c++){b.writeInt16LE(s|0,o);o+=2;}}return b;}
const browser = await chromium.launch({ executablePath:EXE, args:["--autoplay-policy=no-user-gesture-required","--no-sandbox"] });
const ctx = await browser.newContext({ viewport:{width:1360,height:1050} });
const page = await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e)));
const { srv, base } = await serve();
await page.goto(base+"/app.html");
await page.waitForFunction(()=>document.body.classList.contains("booted"),null,{timeout:60000});
await page.waitForFunction(()=>window.__JB && window.__JB.library.filter(t=>!t.featured).length===6,null,{timeout:60000});
await page.click("#btn-autoload");
await page.waitForFunction(()=>{const d=window.__JB.decks;return d.A&&d.A.track&&d.B.track;});

// ── hot cues (deterministic, method-level) ──
ok("4 hot-cue pads per deck", (await page.$$eval("#deckA .hc-pad",b=>b.length))===4);
const hc = await page.evaluate(()=>{ const d=window.__JB.decks.A; if(d.playing)d.togglePlay();
  const t=Math.floor(d.track.buffer.length*0.4); d.seek(t); d.setHotcue(0); const stored=d.hotcues[0];
  d.seek(Math.floor(d.track.buffer.length*0.85)); d.jumpHotcue(0); return {t,stored,after:d.pos}; });
ok("hot cue stores + recalls a position", Math.abs(hc.stored-hc.t)<200 && Math.abs(hc.after-hc.stored)<200, JSON.stringify({stored:hc.stored|0,after:hc.after|0}));
// pad click wires to the method
await page.evaluate(()=>{const d=window.__JB.decks.A;if(d.playing)d.togglePlay();d.hotcues=[null,null,null,null];d.seek(54321);});
await page.click('#deckA .hc-pad[data-i="1"]');
await page.waitForTimeout(120);
const padSet = await page.evaluate(()=>({v:window.__JB.decks.A.hotcues[1], cls:document.querySelector('#deckA .hc-pad[data-i="1"]').classList.contains("set")}));
ok("pad click sets hot cue + shows state", padSet.v!=null && padSet.cls, JSON.stringify({v:padSet.v|0}));

// ── musical key + Camelot ──
const key = await page.evaluate(()=>window.__JB.trackKey(window.__JB.decks.A.track));
ok("musical key detected (Camelot + label)", key && /^[0-9]{1,2}[AB]$/.test(key.camelot) && !!key.label, key?key.camelot+" "+key.label:"none");
const badge = await page.$eval("#deckA .deck-key",e=>e.textContent);
ok("deck key badge populated", /[0-9]+[AB]/.test(badge), badge);
const comp = await page.evaluate(()=>[window.__JB.keysCompatible("8A","8B"),window.__JB.keysCompatible("8A","9A"),window.__JB.keysCompatible("8A","3B")]);
ok("Camelot compatibility logic", comp[0]&&comp[1]&&!comp[2], JSON.stringify(comp));

// ── IndexedDB round-trip via the real file input ──
await page.setInputFiles("#file-input", { name:"persistprobe.wav", mimeType:"audio/wav", buffer: makeWav() });
await page.waitForFunction(()=>window.__JB.library.some(t=>t.name==="persistprobe"),null,{timeout:15000});
 await page.waitForTimeout(700);
ok("added track appears in library", true);
await page.reload();
await page.waitForFunction(()=>document.body.classList.contains("booted"),null,{timeout:60000});
try{ await page.waitForFunction(()=>window.__JB && window.__JB.library.some(t=>t.name==="persistprobe"),null,{timeout:40000}); }catch(e){ console.log("  (restore wait timed out)"); }
const restored = await page.evaluate(()=>window.__JB.library.some(t=>t.name==="persistprobe"));
ok("saved track restored from IndexedDB after reload", restored);

ok("no page errors", errs.length===0, errs.slice(0,3).join(" | "));
await browser.close(); srv.close();
console.log(fail?`BATCH3: ${fail} FAIL`:"BATCH3: all green");
process.exit(fail?1:0);
