/**
 * Generate Anchor Code "Ac" app icons (serif wordmark on charcoal).
 * Requires: npm i -D canvas  (or canvas available)
 * Windows: uses C:\\Windows\\Fonts\\GARA.TTF when present.
 *
 *   node scripts/generate-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createCanvas, registerFont } = require("canvas");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const candidates = [
  "C:/Windows/Fonts/GARA.TTF",
  "C:/Windows/Fonts/georgia.ttf",
  "/System/Library/Fonts/Supplemental/Georgia.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
];
const fontPath = candidates.find((p) => fs.existsSync(p));
if (fontPath) {
  registerFont(fontPath, { family: "AnchorGaramond" });
  console.log("font:", fontPath);
} else {
  console.warn("No Garamond/Georgia found; falling back to system serif name");
}

const BG = "#171718";
const FG = "#f2f2f2";

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const r = Math.round(size * 0.18);
  ctx.fillStyle = BG;
  roundRect(ctx, 0, 0, size, size, r);
  ctx.fill();

  const grad = ctx.createLinearGradient(0, 0, 0, size * 0.5);
  grad.addColorStop(0, "rgba(255,255,255,0.07)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, size, size * 0.55, r);
  ctx.fill();

  ctx.fillStyle = FG;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const fontSize = Math.round(size * 0.56);
  const family = fontPath ? "AnchorGaramond" : "serif";
  ctx.font = `400 ${fontSize}px ${family}`;
  ctx.fillText("Ac", size / 2 + size * 0.01, size * 0.69);
  return canvas;
}

function makeIco(items) {
  const count = items.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const entries = [];
  const images = [];
  for (const { size, buf } of items) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(entry);
    images.push(buf);
  }
  return Buffer.concat([header, ...entries, ...images]);
}

const outDir = path.join(root, "build", "icons");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.mkdirSync(path.join(root, "build"), { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngs = [];
for (const size of sizes) {
  const buf = drawIcon(size).toBuffer("image/png");
  fs.writeFileSync(path.join(outDir, `${size}x${size}.png`), buf);
  pngs.push({ size, buf });
}

const icon512 = pngs.find((p) => p.size === 512).buf;
fs.writeFileSync(path.join(outDir, "icon.png"), icon512);
fs.writeFileSync(path.join(root, "build", "icon.png"), icon512);

const ico = makeIco(
  [16, 24, 32, 48, 64, 128, 256].map((sz) => pngs.find((p) => p.size === sz)),
);
fs.writeFileSync(path.join(outDir, "icon.ico"), ico);
fs.writeFileSync(path.join(root, "build", "icon.ico"), ico);
fs.writeFileSync(path.join(root, "public", "favicon.ico"), ico);
fs.writeFileSync(path.join(root, "public", "icon-512.png"), icon512);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="Anchor Code">
  <rect width="512" height="512" rx="92" fill="#171718"/>
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="280" rx="92" fill="url(#sheen)"/>
  <text x="260" y="352" text-anchor="middle"
        font-family="Garamond, 'EB Garamond', 'Palatino Linotype', Georgia, serif"
        font-size="292" font-weight="400" fill="#f2f2f2">Ac</text>
</svg>
`;
fs.writeFileSync(path.join(outDir, "icon.svg"), svg);
fs.writeFileSync(path.join(root, "build", "icon.svg"), svg);
fs.writeFileSync(path.join(root, "public", "icon.svg"), svg);

console.log("Wrote icons to build/ and public/");
