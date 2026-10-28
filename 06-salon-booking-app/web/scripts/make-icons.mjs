// Renders the home-screen icons from one SVG: a pink polish bottle with a heart and a
// gold cap, in front of a lemon slice and leaves, on the app's plum night background. The art matches
// the illustrations in src/components/brand.tsx (drawn bold so it reads at 60px).
//   npm run icons
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const r2 = (v) => Math.round(v * 100) / 100;
const pt = (x, y) => `${r2(x)} ${r2(y)}`;

// Ten lemon segments with even membranes, radius 50 around (0,0) (as in brand.tsx).
function segments(n = 10, ro = 38.6, g = 3.4, c = 3.4, tr = 1.4) {
  const h = Math.PI / n;
  let d = '';
  for (let i = 0; i < n; i++) {
    const th = (i * 2 * Math.PI) / n - Math.PI / 2;
    const a0 = th - h;
    const a1 = th + h;
    const u0 = [Math.cos(a0), Math.sin(a0)];
    const u1 = [Math.cos(a1), Math.sin(a1)];
    const n0 = [-Math.sin(a0), Math.cos(a0)];
    const n1 = [Math.sin(a1), -Math.cos(a1)];
    const P = (u, nn, t) => [t * u[0] + (g / 2) * nn[0], t * u[1] + (g / 2) * nn[1]];
    const t = Math.sqrt(ro * ro - (g / 2) ** 2);
    const tipD = g / 2 / Math.sin(h);
    const tip = [tipD * Math.cos(th), tipD * Math.sin(th)];
    const tt = tipD * Math.cos(h);
    const [c0, c1] = [P(u0, n0, t), P(u1, n1, t)];
    const [e0, e1] = [P(u0, n0, t - c), P(u1, n1, t - c)];
    const [s0, s1] = [P(u0, n0, tt + tr), P(u1, n1, tt + tr)];
    const off = Math.asin(g / 2 / ro) + c / ro;
    const q0 = [ro * Math.cos(a0 + off), ro * Math.sin(a0 + off)];
    const q1 = [ro * Math.cos(a1 - off), ro * Math.sin(a1 - off)];
    d += `M${pt(...s0)}L${pt(...e0)}Q${pt(...c0)} ${pt(...q0)}A${ro} ${ro} 0 0 1 ${pt(...q1)}`
      + `Q${pt(...c1)} ${pt(...e1)}L${pt(...s1)}Q${pt(...tip)} ${pt(...s0)}Z`;
  }
  return d;
}

const LEAF_A = 'M0 0C-11.5-9-14-30 2.6-50Q2.4-25 0 0Z';
const LEAF_B = 'M0 0Q2.4-25 2.6-50C15.5-33 12.5-10 0 0Z';
const leaf = (x, y, r, s, flip = false) => `
  <g transform="translate(${x} ${y}) rotate(${r}) scale(${flip ? -s : s} ${s})">
    <path d="${LEAF_A}" fill="url(#lf1)"/>
    <path d="${LEAF_B}" fill="url(#lf2)"/>
    <path d="M.1 1.5Q2.3-24 2.5-46.5" fill="none" stroke="#eef7df" stroke-opacity=".8" stroke-width="1.6" stroke-linecap="round"/>
  </g>`;

const PETAL = 'M0-1.1C2.4-2.2 3.9-5.3 3.3-8 2.9-9.7 1.3-10.7 0-11-1.3-10.7-2.9-9.7-3.3-8-3.9-5.3-2.4-2.2 0-1.1Z';
const blossom = (x, y, s) => `
  <g transform="translate(${x} ${y}) scale(${s})">
    ${[0, 72, 144, 216, 288].map((a) => `<path d="${PETAL}" transform="rotate(${a + 8})" fill="url(#pt)" stroke="#e59bb9" stroke-width=".4"/>`).join('')}
    <circle r="2.4" fill="#f3b21c"/><circle r="1.2" fill="#a9bb3c"/>
  </g>`;

const art = `
  <g transform="translate(332 334)">
    ${leaf(58, -86, 30, 2.5)}
    ${leaf(96, -40, 72, 2.3, true)}
    ${leaf(-118, 80, 226, 2.1)}
  </g>
  <circle cx="340" cy="342" r="124" fill="url(#shadow)"/>
  <g transform="translate(332 334) rotate(8) scale(2.36)">
    <circle r="50" fill="url(#rind)" stroke="#b17a00" stroke-opacity=".35" stroke-width=".8"/>
    <circle r="44.6" fill="#fffcef"/>
    <circle r="39.4" fill="#fff6d2"/>
    <path d="${segments()}" fill="url(#seg)"/>
    <path d="M-31.6-13.4A34.3 34.3 0 0 1-12.6-31.9" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="3" stroke-linecap="round"/>
    <circle r="2.8" fill="#fffbea"/>
  </g>
  ${blossom(442, 228, 3.1)}
  <ellipse cx="226" cy="448" rx="96" ry="14" fill="url(#shadow2)"/>
  <g transform="translate(78 64) scale(2.62) rotate(-9 60 82)">
    <rect x="39" y="56" width="42" height="12" rx="3" fill="#f6b8d2"/>
    <rect x="22" y="62" width="76" height="78" rx="15" fill="url(#glass)" stroke="#e98ab4" stroke-width="1.8"/>
    <rect x="28" y="68" width="64" height="58" rx="10" fill="url(#liq)"/>
    <path d="M60 110.5c-5.6-4.2-11.5-8.6-11.2-14.3.1-3.8 3-6.2 6.2-6 2.2.1 3.9 1.6 5 3.6 1-2.2 2.9-3.8 5.3-3.8 3.4 0 6 2.7 5.7 6.2-.4 5.6-6.2 9.9-11 14.3Z" fill="#fff"/>
    <rect x="26.6" y="72" width="5.4" height="50" rx="2.7" fill="#fff" fill-opacity=".55"/>
    <rect x="42" y="6" width="36" height="56" rx="6" fill="url(#cap)" stroke="#7a4f12" stroke-opacity=".35"/>
    <rect x="40" y="54" width="40" height="9" rx="3" fill="url(#cap)"/>
    <path d="M50 14v40" stroke="#fffbe8" stroke-opacity=".6" stroke-width="3" stroke-linecap="round"/>
  </g>`;

const svg = (pad) => Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="0.3" cy="0.22" r="0.95">
      <stop offset="0" stop-color="#4a2a4f"/><stop offset="0.55" stop-color="#2c1a31"/><stop offset="1" stop-color="#1a1020"/>
    </radialGradient>
    <radialGradient id="wash" cx="0.82" cy="0.86" r="0.5">
      <stop offset="0" stop-color="#d6156f" stop-opacity=".35"/><stop offset="1" stop-color="#d6156f" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="lf1" x1="0" y1="1" x2=".25" y2="0"><stop offset="0" stop-color="#4c8636"/><stop offset=".5" stop-color="#7db35a"/><stop offset="1" stop-color="#a9d184"/></linearGradient>
    <linearGradient id="lf2" x1="0" y1="1" x2=".2" y2="0"><stop offset="0" stop-color="#2c5b22"/><stop offset=".55" stop-color="#4e8b3a"/><stop offset="1" stop-color="#64a046"/></linearGradient>
    <radialGradient id="pt" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="11">
      <stop offset="0" stop-color="#ec8fb3"/><stop offset=".25" stop-color="#f6c2d6"/><stop offset=".5" stop-color="#fff6f9"/><stop offset="1" stop-color="#ffffff"/>
    </radialGradient>
    <radialGradient id="rind" cx=".36" cy=".32" r=".72"><stop offset="0" stop-color="#fff07a"/><stop offset=".55" stop-color="#f6d23c"/><stop offset="1" stop-color="#e9b51b"/></radialGradient>
    <radialGradient id="seg" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="39"><stop offset="0" stop-color="#fffbe3"/><stop offset=".3" stop-color="#fff0a0"/><stop offset=".7" stop-color="#fbdc52"/><stop offset="1" stop-color="#f6d23c"/></radialGradient>
    <radialGradient id="shadow"><stop offset=".8" stop-color="#a8325f" stop-opacity=".2"/><stop offset="1" stop-color="#a8325f" stop-opacity="0"/></radialGradient>
    <radialGradient id="shadow2"><stop offset="0" stop-color="#a8325f" stop-opacity=".3"/><stop offset="1" stop-color="#a8325f" stop-opacity="0"/></radialGradient>
    <linearGradient id="cap" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8d5f1c"/><stop offset=".14" stop-color="#c99a45"/><stop offset=".3" stop-color="#fbe7a8"/><stop offset=".42" stop-color="#e3b65a"/>
      <stop offset=".68" stop-color="#b88430"/><stop offset=".84" stop-color="#efcd7c"/><stop offset="1" stop-color="#94631d"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#fff0f6"/><stop offset="1" stop-color="#ffffff"/>
    </linearGradient>
    <linearGradient id="liq" x1=".1" y1="0" x2=".9" y2="1">
      <stop offset="0" stop-color="#ffb6d6"/><stop offset=".35" stop-color="#ff7fb8"/><stop offset=".75" stop-color="#ef4c9b"/><stop offset="1" stop-color="#d6156f"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#wash)"/>
  <g transform="translate(256 256) scale(${1 - pad / 512}) translate(-270 -262)">${art}</g>
</svg>`);

await mkdir('public/icons', { recursive: true });
const jobs = [
  ['public/icons/apple-touch-icon.png', 180, 0],
  ['public/icons/icon-192.png', 192, 0],
  ['public/icons/icon-512.png', 512, 0],
  // maskable: everything important inside the central 80% circle
  ['public/icons/icon-maskable-512.png', 512, 104],
];
for (const [file, size, pad] of jobs) {
  await sharp(svg(pad)).resize(size, size).png().toFile(file);
  console.log('wrote', file);
}
