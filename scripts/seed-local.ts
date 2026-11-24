/**
 * Seeds local (Miniflare) R2 with a small synthetic library so the app runs without the generator:
 * reel JSON + placeholder SVG infographics under reels/, then a catalog built from them.
 *
 *   node scripts/seed-local.ts [--per-field 12]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { mulberry32, normalize } from "../packages/reco/src/index.ts";
import { FIELDS } from "../packages/shared/src/index.ts";
import { API_DIR, buildCatalog, type ReelJson, upload, writeCatalog } from "./catalog-lib.ts";

const { values } = parseArgs({ options: { "per-field": { type: "string", default: "12" } } });
const perField = Number(values["per-field"]);

const TOPICS: Record<string, string[]> = {
  people: ["Ada Lovelace", "Leonardo da Vinci", "Marie Curie", "Nelson Mandela", "Confucius", "Frida Kahlo"],
  history: ["Roman Empire", "Silk Road", "Industrial Revolution", "Ming dynasty", "Cold War", "Bronze Age"],
  geography: ["Amazon River", "Himalayas", "Sahara", "Mariana Trench", "Iceland", "Great Barrier Reef"],
  arts: ["Impressionism", "Jazz", "Haiku", "Baroque architecture", "Cinema", "Opera"],
  philosophy_religion: ["Stoicism", "Buddhism", "Existentialism", "Norse mythology", "Ethics", "Taoism"],
  everyday_life: ["Coffee", "Football", "Chess", "Bread", "Tea ceremony", "Olympic Games"],
  society: ["Democracy", "Inflation", "Human rights", "Linguistics", "Urbanization", "Game theory"],
  biology_health: ["Octopus", "Photosynthesis", "Vaccine", "Tardigrade", "Circadian rhythm", "DNA"],
  physical_sciences: ["Black hole", "Plate tectonics", "Periodic table", "Quantum entanglement", "Aurora", "Volcano"],
  technology: ["Transistor", "Printing press", "Internet", "Steam engine", "Bicycle", "Lighthouse"],
  mathematics: ["Prime number", "Fibonacci sequence", "Topology", "Pi", "Fractal", "Graph theory"],
};
const SECTIONS = ["Overview", "Origins", "How it works", "Key facts", "Legacy", "In culture", "Today", "Trivia"];
const DIM = 64;

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
function svg(title: string, section: string, page: number, total: number, hue: number, emoji: string): string {
  const bars = Array.from({ length: 4 }, (_, i) => {
    const w = 180 + ((page * 97 + i * 53) % 420);
    return `<rect x="90" y="${980 + i * 110}" width="${w}" height="60" rx="30" fill="hsl(${hue} 70% ${70 - i * 8}%)"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 60% 10%)"/></linearGradient></defs>
<rect width="1080" height="1920" fill="url(#g)"/>
<text x="90" y="260" font-family="system-ui,sans-serif" font-size="44" fill="hsl(${hue} 80% 80%)">${page} / ${total} · ${esc(section.toUpperCase())}</text>
<text x="90" y="400" font-family="system-ui,sans-serif" font-size="84" font-weight="700" fill="#fff">${esc(title)}</text>
<text x="540" y="780" text-anchor="middle" font-size="260">${emoji}</text>
${bars}
<text x="90" y="1600" font-family="system-ui,sans-serif" font-size="40" fill="#ddd">Placeholder infographic (seed data)</text>
</svg>`;
}

const rng = mulberry32(7);
const randn = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
const unit = () => normalize(Float32Array.from({ length: DIM }, randn));

const out = join(API_DIR, ".wrangler", "seed");
rmSync(out, { recursive: true, force: true });
const reels: ReelJson[] = [];
const files: { key: string; file: string }[] = [];
let pageid = 100000;
FIELDS.forEach((field, fi) => {
  const center = unit();
  const topics = TOPICS[field.id];
  const subCenters = topics.map(() => normalize(center.map((x, j) => x + 0.7 * unit()[j])));
  for (let i = 0; i < perField; i++) {
    const t = i % topics.length;
    const title = i < topics.length ? topics[t] : `${topics[t]} (part ${Math.floor(i / topics.length) + 1})`;
    const id = pageid++;
    const nPages = 3 + Math.floor(rng() * 4);
    const infographics = Array.from({ length: nPages }, (_, k) => {
      const key = `reels/${id}/infographics/${String(k + 1).padStart(3, "0")}.svg`;
      const file = join(out, key);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, svg(title, SECTIONS[k], k + 1, nPages, (fi * 33) % 360, field.emoji));
      files.push({ key, file });
      return { page: k + 1, section: SECTIONS[k], r2_key: key };
    });
    const v = normalize(subCenters[t].map((x, j) => x + 0.4 * unit()[j]));
    const reel: ReelJson = {
      pageid: id,
      title,
      canonical_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(topics[t].replace(/ /g, "_"))}`,
      revision_id: null,
      vital_level: 3 + (i % 3),
      vital_field: field.id,
      vital_subfield: null,
      summary: `${title} is a placeholder reel in ${field.label}. Real reels come from wiki-reels-generator; this text stands in for the article's lead.`,
      categories: [],
      embedding: { model: "seed", dim: DIM, vector: Array.from(v) },
      infographics,
    };
    const jsonFile = join(out, `reels/${id}.json`);
    writeFileSync(jsonFile, JSON.stringify(reel));
    files.push({ key: `reels/${id}.json`, file: jsonFile });
    reels.push(reel);
  }
});

const result = buildCatalog(reels, `seed-${Date.now()}`);
const catalogFiles = writeCatalog(out, result);
console.log(`seeding ${reels.length} reels (${files.length} objects) into local R2…`);
upload([...files, ...catalogFiles], false);
console.log(`done: catalog ${result.meta.version}`);
