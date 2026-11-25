// wrangler dev refuses to start if the assets directory is missing, so create a placeholder until the PWA is built.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "dist");
if (!existsSync(join(dist, "index.html"))) {
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Wiki Reels API</title>
<p>The API is running, but the web app isn't built yet. Open <a href="http://localhost:5173">http://localhost:5173</a>
after <code>npm run dev:web</code>, or run <code>npm run build</code> to serve it from here.</p>`,
  );
  console.log("Created placeholder apps/web/dist (run `npm run build` to serve the real PWA here).");
}
