// Renders public/icon.svg into the PNG sizes the web app manifest and iOS need.
// Run with: node scripts/generate-icons.mjs
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../public/icon.svg", import.meta.url));

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
];

for (const { file, size } of targets) {
  await sharp(svg).resize(size, size).png().toFile(`public/${file}`);
}

// Maskable icon: Android crops to a circle/squircle, so keep the shield inside the
// central 80% safe zone by shrinking it onto a full-bleed background.
const inner = await sharp(svg).resize(400, 400).png().toBuffer();
await sharp({
  create: { width: 512, height: 512, channels: 4, background: "#0b3a6e" },
})
  .composite([{ input: inner, gravity: "center" }])
  .png()
  .toFile("public/icon-maskable-512.png");

console.log("Icons written to public/");
