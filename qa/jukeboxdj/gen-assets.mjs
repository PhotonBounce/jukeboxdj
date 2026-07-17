/* Generates icon.png / icon-192 / icon-512 for JukeboxDJ from inline SVG. */
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../projects/jukeboxdj/assets");
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="32%" r="85%">
      <stop offset="0%" stop-color="#241E4B"/><stop offset="55%" stop-color="#120F2A"/><stop offset="100%" stop-color="#07050F"/>
    </radialGradient>
    <linearGradient id="lbl" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FFDE6B"/><stop offset="100%" stop-color="#F5A623"/>
    </linearGradient>
    <linearGradient id="arm" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#C4B5FD"/><stop offset="100%" stop-color="#7DD3FC"/>
    </linearGradient>
    <radialGradient id="sheen" cx="30%" cy="25%" r="80%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".18"/><stop offset="45%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <!-- vinyl -->
  <circle cx="256" cy="262" r="176" fill="#0E0D18"/>
  <g stroke="#211E36" stroke-width="3" fill="none">
    <circle cx="256" cy="262" r="164"/><circle cx="256" cy="262" r="148"/><circle cx="256" cy="262" r="132"/>
    <circle cx="256" cy="262" r="116"/><circle cx="256" cy="262" r="100"/><circle cx="256" cy="262" r="84"/>
  </g>
  <circle cx="256" cy="262" r="176" fill="url(#sheen)"/>
  <circle cx="256" cy="262" r="62" fill="url(#lbl)"/>
  <circle cx="256" cy="262" r="9" fill="#100E1E"/>
  <!-- musical note on label -->
  <g fill="#3A2B05">
    <rect x="268" y="230" width="7" height="46" rx="3"/>
    <ellipse cx="258" cy="279" rx="14" ry="10"/>
    <path d="M268 230 q 22 4 24 20 l -7 2 q -3 -13 -17 -15 z"/>
  </g>
  <!-- tonearm -->
  <circle cx="424" cy="96" r="34" fill="#1C1936" stroke="#3A3763" stroke-width="4"/>
  <rect x="404" y="108" width="18" height="182" rx="9" transform="rotate(24 413 117)" fill="url(#arm)"/>
  <rect x="330" y="266" width="34" height="44" rx="8" transform="rotate(24 347 288)" fill="url(#arm)"/>
  <!-- eq spark -->
  <g fill="#5EEAD4">
    <rect x="96" y="404" width="18" height="42" rx="6"/>
    <rect x="126" y="384" width="18" height="62" rx="6" fill="#7DD3FC"/>
    <rect x="156" y="416" width="18" height="30" rx="6" fill="#A78BFA"/>
  </g>
</svg>`;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
const el = page.locator("svg");
await el.screenshot({ path: OUT + "/icon-512.png", omitBackground: true });
await page.setViewportSize({ width: 192, height: 192 });
await page.setContent(`<body style="margin:0"><div style="width:192px;height:192px">${svg.replace('width="512" height="512"', 'width="192" height="192"')}</div></body>`);
await page.locator("svg").screenshot({ path: OUT + "/icon-192.png", omitBackground: true });
await page.setViewportSize({ width: 128, height: 128 });
await page.setContent(`<body style="margin:0"><div style="width:128px;height:128px">${svg.replace('width="512" height="512"', 'width="128" height="128"')}</div></body>`);
await page.locator("svg").screenshot({ path: OUT + "/icon.png", omitBackground: true });
await browser.close();
console.log("icons written");
