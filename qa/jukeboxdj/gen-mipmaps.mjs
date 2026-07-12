/* Renders launcher mipmaps for android/jukeboxdj from the app icon SVG. */
import { chromium } from "playwright";
import fs from "fs";
const EXE = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const png512 = fs.readFileSync("../../projects/jukeboxdj/assets/icon-512.png").toString("base64");
const b = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
for (const [dpi, px] of Object.entries(SIZES)) {
  const p = await b.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  // square icon
  await p.setContent(`<body style="margin:0"><img src="data:image/png;base64,${png512}" style="width:${px}px;height:${px}px;display:block"></body>`);
  await p.locator("img").screenshot({ path: `../../android/jukeboxdj/app/src/main/res/mipmap-${dpi}/ic_launcher.png` });
  // round icon (circle mask)
  await p.setContent(`<body style="margin:0"><div style="width:${px}px;height:${px}px;border-radius:50%;overflow:hidden"><img src="data:image/png;base64,${png512}" style="width:${px}px;height:${px}px;display:block"></div></body>`);
  await p.locator("div").screenshot({ path: `../../android/jukeboxdj/app/src/main/res/mipmap-${dpi}/ic_launcher_round.png`, omitBackground: true });
  await p.close();
}
await b.close();
console.log("mipmaps written");
