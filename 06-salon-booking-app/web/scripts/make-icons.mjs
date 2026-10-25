// Renders the home-screen icons from one SVG: a nail-polish bottle on blush.
//   npm run icons
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const svg = (pad) => Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#f7e3ea"/>
  <g transform="translate(256 ${256 + pad * 0}) scale(${1 - pad / 512}) translate(-256 -256)">
    <rect x="214" y="70" width="84" height="150" rx="18" fill="#2a2224"/>
    <rect x="196" y="200" width="120" height="40" rx="10" fill="#2a2224"/>
    <path d="M150 300c0-38 30-68 68-68h76c38 0 68 30 68 68v86c0 38-30 68-68 68h-76c-38 0-68-30-68-68z" fill="#a8325f"/>
    <path d="M186 300c0-18 14-32 32-32h20" stroke="#ffffff" stroke-opacity=".55" stroke-width="16" stroke-linecap="round" fill="none"/>
  </g>
</svg>`);

await mkdir('public/icons', { recursive: true });
const jobs = [
  ['public/icons/apple-touch-icon.png', 180, 0],
  ['public/icons/icon-192.png', 192, 0],
  ['public/icons/icon-512.png', 512, 0],
  ['public/icons/icon-maskable-512.png', 512, 90],
];
for (const [file, size, pad] of jobs) {
  await sharp(svg(pad)).resize(size, size).png().toFile(file);
  console.log('wrote', file);
}
