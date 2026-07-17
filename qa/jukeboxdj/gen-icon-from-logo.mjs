/* Swaps the user's real logo (projects/jukeboxdj/assets/logo-src.png) in as the
   app icon everywhere: web icon.png/192/512, Android launcher mipmaps (square +
   round), and the Play 512 icon. High-quality lanczos downscale via Chromium. */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../projects/jukeboxdj/assets");
const AND = path.resolve(HERE, "../../android/jukeboxdj/app/src/main/res");
const PLAY = path.resolve(HERE, "../../android/jukeboxdj/play-listing");
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const SRC = fs.readFileSync(path.join(APP, "logo-src.png")).toString("base64");
const dataUri = "data:image/png;base64," + SRC;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

async function render (px, out, round) {
  const p = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  const clip = round ? "border-radius:50%;" : "";
  await p.setContent(
    `<body style="margin:0"><div style="width:${px}px;height:${px}px;overflow:hidden;${clip}">` +
    `<img src="${dataUri}" style="width:${px}px;height:${px}px;display:block;image-rendering:auto"></div></body>`
  );
  await p.locator("div").screenshot({ path: out, omitBackground: true });
  await p.close();
}

// web app + landing favicon
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
console.log("logo swapped into app icon, Play icon, and all mipmaps");
