/* Rebuilds the JukeboxDJ app icon from the user's controller artwork, as a
   crisp vector: a black twin-turntable DJ controller with two blue-label
   vinyls. Writes projects/jukeboxdj/assets/icon{,-192,-512}.png, the Android
   launcher mipmaps, and the Play 512 icon. */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../projects/jukeboxdj/assets");
const AND = path.resolve(HERE, "../../android/jukeboxdj/app/src/main/res");
const PLAY = path.resolve(HERE, "../../android/jukeboxdj/play-listing");
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/* One reusable turntable at unit scale, positioned by <use> */
const deck = (cx, cy, r) => `
  <g>
    <circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="#1c1c1f"/>
    <circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="none" stroke="#c9ccd6" stroke-width="3" opacity=".85"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#0b0b0d"/>
    <g stroke="#232327" stroke-width="2.4" fill="none" opacity=".9">
      ${[0.9, 0.78, 0.66, 0.54].map((f) => `<circle cx="${cx}" cy="${cy}" r="${r * f}"/>`).join("")}
    </g>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#sheen)"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.42}" fill="url(#label)"/>
    <path d="M ${cx - r * 0.42} ${cy} A ${r * 0.42} ${r * 0.42} 0 0 1 ${cx} ${cy - r * 0.42} L ${cx} ${cy} Z" fill="#ffffff" opacity=".28"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.08}" fill="#e9ebf2"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.03}" fill="#2a2a30"/>
  </g>`;

const knob = (cx, cy, r) => `
  <g>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#steel)" stroke="#3a3d47" stroke-width="1.5"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.5}" fill="#26272c"/>
  </g>`;

const jog = (cx, cy, r) => `
  <g>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#141416" stroke="#2E9BD6" stroke-width="4"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.5}" fill="url(#steel)"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.16}" fill="#1a1a1e"/>
  </g>`;

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#141416"/><stop offset="100%" stop-color="#040405"/>
    </linearGradient>
    <radialGradient id="label" cx="50%" cy="38%" r="70%">
      <stop offset="0%" stop-color="#7FD8FF"/><stop offset="45%" stop-color="#29B6F6"/><stop offset="100%" stop-color="#1E9AE0"/>
    </radialGradient>
    <radialGradient id="steel" cx="38%" cy="32%" r="80%">
      <stop offset="0%" stop-color="#EDEFF4"/><stop offset="45%" stop-color="#B9BCC6"/><stop offset="100%" stop-color="#6E717C"/>
    </radialGradient>
    <radialGradient id="sheen" cx="32%" cy="24%" r="80%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".16"/><stop offset="45%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="8" y="8" width="496" height="496" rx="104" fill="url(#body)" stroke="#26262b" stroke-width="3"/>
  <!-- top jog wheels + centre knob cluster -->
  ${jog(96, 96, 44)}
  ${jog(416, 96, 44)}
  ${knob(224, 78, 20)} ${knob(288, 78, 20)}
  ${knob(224, 128, 20)} ${knob(288, 128, 20)}
  <!-- the two turntables (hero) -->
  ${deck(150, 286, 118)}
  ${deck(362, 286, 118)}
  <!-- crossfader hint + cue buttons -->
  <rect x="240" y="212" width="32" height="150" rx="8" fill="#0d0d10" stroke="#26262b" stroke-width="2"/>
  <rect x="248" y="300" width="16" height="20" rx="4" fill="url(#steel)"/>
  <g>
    <rect x="150" y="430" width="34" height="20" rx="5" fill="#57C77A"/>
    <rect x="196" y="430" width="34" height="20" rx="5" fill="#E7E9EE"/>
    <rect x="282" y="430" width="34" height="20" rx="5" fill="#F5C842"/>
    <rect x="328" y="430" width="34" height="20" rx="5" fill="#57C77A"/>
  </g>
</svg>`;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

async function render (px, out, round) {
  const p = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  const clip = round ? `border-radius:50%;` : "";
  await p.setContent(`<body style="margin:0"><div style="width:${px}px;height:${px}px;overflow:hidden;${clip}">${SVG.replace('width="512" height="512"', `width="${px}" height="${px}"`)}</div></body>`);
  await p.locator("div").screenshot({ path: out, omitBackground: true });
  await p.close();
}

// web app + landing
await render(512, path.join(APP, "icon-512.png"));
await render(192, path.join(APP, "icon-192.png"));
await render(128, path.join(APP, "icon.png"));
// Play icon
fs.mkdirSync(PLAY, { recursive: true });
await render(512, path.join(PLAY, "play-icon-512.png"));
// Android launcher mipmaps (square + round)
const DPI = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [dpi, px] of Object.entries(DPI)) {
  await render(px, path.join(AND, `mipmap-${dpi}/ic_launcher.png`));
  await render(px, path.join(AND, `mipmap-${dpi}/ic_launcher_round.png`), true);
}

await browser.close();
console.log("icon rebuilt from controller artwork → app, Play, and all mipmaps");
