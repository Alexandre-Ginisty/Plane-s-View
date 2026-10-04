// Renders public/favicon.svg to the PNG sizes the browsers and phones ask for.
//   node tools/brand/build-icons.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../public/', import.meta.url));
const svg = readFileSync(`${root}favicon.svg`);

const sizes = {
  'favicon-32.png': 32,
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
};
for (const [name, size] of Object.entries(sizes)) {
  await sharp(svg, { density: Math.max(72, (size / 64) * 72 * 2) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(`${root}${name}`);
  console.log('wrote', name);
}

// The social card: the mark and the name, 1200 x 630.
const mark = await sharp(svg, { density: 600 }).resize(300, 300).png().toBuffer();
const card = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
     <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d2038"/><stop offset="1" stop-color="#03060c"/></linearGradient></defs>
     <rect width="1200" height="630" fill="url(#g)"/>
     <text x="480" y="300" font-family="Helvetica, Arial, sans-serif" font-size="96" font-weight="700" fill="#7fdfff">Planes<tspan fill="#f2f8ff" font-weight="400">View</tspan></text>
     <text x="484" y="372" font-family="Helvetica, Arial, sans-serif" font-size="38" fill="#8ea0b7">Live aircraft, from the cockpit</text>
   </svg>`,
);
await sharp(card).composite([{ input: mark, left: 140, top: 165 }]).png({ compressionLevel: 9 }).toFile(`${root}og-image.png`);
console.log('wrote og-image.png');
