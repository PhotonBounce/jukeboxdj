/* Tiny static server for QA — serves projects/jukeboxdj like the live host. */
import http from "http";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.JB_QA_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../projects/jukeboxdj");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon", ".json": "application/json"
};

export function serve () {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (p.endsWith("/")) p += "index.html";
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        const data = await fs.readFile(file);
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      } catch (e) {
        res.writeHead(404); res.end("not found");
      }
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: "http://127.0.0.1:" + srv.address().port }));
  });
}
