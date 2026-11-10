// Renders the home-screen icons from one SVG: a pink polish bottle with a heart and a
// gold cap, in front of a lemon slice and leaves, on the app's plum night background. The art matches
// the illustrations in src/components/brand.tsx (drawn bold so it reads at 60px). Then the booking
// link's preview card, public/og/booking-card.jpg (see the end of this file).
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

/* ------------------------------------------------------------ the preview card */
// public/og/booking-card.jpg, 1200 × 630: the picture WhatsApp, Instagram, Facebook and iMessage show
// when someone shares the booking link (og:image in src/lib/head.ts). The booking page's own art from
// src/components/brand.tsx, in full detail at this size: the hero's sprigs in the top corners, the
// footer's lemon-slice sprigs below, little hearts, and the icon's polish bottle in front of a lemon
// slice in the middle, so a square crop still shows it. No words, and never a business name: the
// card is the same for everyone, and the name comes from the page's title.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rad = (deg) => (deg * Math.PI) / 180;

const LEAF_EDGE = 'M0 0C-11.5-9-14-30 2.6-50C15.5-33 12.5-10 0 0Z';
const LEAF_MID = 'M.1 1.5Q2.3-24 2.5-46.5';
const LEAF_VEINS =
  'M1.1-9Q-3.4-12.6-7.4-19M1.7-17Q-3.6-20.6-8.6-28M2.1-26Q-2.4-29.6-6.8-36.6M2.4-35Q-.6-38-3.4-43'
  + 'M1.2-6Q5.6-9.6 9-16.4M1.8-15Q6.6-18.6 10-26M2.2-24Q6.6-27.6 9.2-35.4M2.4-33.4Q5.6-36.4 7.2-42';
const LEAF_GLOSS = 'M-3.4-8C-6.6-17-6.4-28-1.6-39';
const leafArt = (x, y, r, s, tone = 0, mirror = false) => `
  <g transform="translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(mirror ? -s : s)} ${r2(s)})">
    <path d="M0 0L-.4 6.5" stroke="#4a7a32" stroke-width="1.6" stroke-linecap="round"/>
    <path d="${LEAF_A}" fill="url(#${tone ? 'lf2' : 'lf1'})"/>
    <path d="${LEAF_B}" fill="url(#${tone ? 'lf1' : 'lf2'})"/>
    <path d="${LEAF_VEINS}" fill="none" stroke="#e4f2d0" stroke-opacity=".22" stroke-width=".5" stroke-linecap="round"/>
    <path d="${LEAF_MID}" fill="none" stroke="#eef7df" stroke-opacity=".78" stroke-width=".95" stroke-linecap="round"/>
    <path d="${LEAF_GLOSS}" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="2.6" stroke-linecap="round"/>
    <path d="${LEAF_EDGE}" fill="none" stroke="#1f4417" stroke-opacity=".32" stroke-width=".6"/>
  </g>`;

const BLOSSOM_PETALS = (() => {
  const rand = rng(11);
  return [0, 1, 2, 3, 4].map((i) => ({ a: r2(i * 72 + (rand() - 0.5) * 12), l: r2(0.92 + rand() * 0.14) }));
})();
const PETAL_CUP = 'M0-1.1C2.4-2.2 3.9-5.3 3.3-8 2.9-9.7 1.3-10.7 0-11Q.9-6 0-1.1Z';
const PETAL_CREASE = 'M0-2.6Q.35-6.2.15-9.2';
const STAMENS = (() => {
  const rand = rng(5);
  let lines = '';
  let dots = '';
  for (let i = 0; i < 16; i++) {
    const a = rad(i * (360 / 16) + (rand() - 0.5) * 18);
    const len = 1.9 + rand() * 1.6;
    const x = Math.cos(a) * len;
    const y = Math.sin(a) * len;
    const rr = 0.36 + rand() * 0.16;
    lines += `M${pt(Math.cos(a) * 0.9, Math.sin(a) * 0.9)}L${pt(x, y)}`;
    dots += `M${pt(x - rr, y)}a${r2(rr)} ${r2(rr)} 0 1 0 ${r2(rr * 2)} 0a${r2(rr)} ${r2(rr)} 0 1 0-${r2(rr * 2)} 0`;
  }
  return { lines, dots };
})();
const blossomArt = (x, y, s, r = 0) => `
  <g transform="translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(s)})">
    <circle r="9.4" cx=".5" cy="1.1" fill="url(#bsh)"/>
    ${BLOSSOM_PETALS.map((p) => `<g transform="rotate(${p.a}) scale(${p.l})">
      <path d="${PETAL}" fill="url(#pt)"/>
      <path d="${PETAL_CUP}" fill="#f3cfe0" fill-opacity=".5"/>
      <path d="${PETAL_CREASE}" fill="none" stroke="#efb7cd" stroke-opacity=".8" stroke-width=".32" stroke-linecap="round"/>
      <path d="${PETAL}" fill="none" stroke="#e59bb9" stroke-opacity=".75" stroke-width=".32"/>
    </g>`).join('')}
    <circle r="2.6" fill="#fbe7a1" fill-opacity=".55"/>
    <path d="${STAMENS.lines}" stroke="#e2b23a" stroke-width=".3" stroke-linecap="round"/>
    <circle r="1.25" fill="url(#ctr)"/>
    <path d="${STAMENS.dots}" fill="#f3b21c" stroke="#c98510" stroke-width=".12"/>
  </g>`;

const budArt = (x, y, s, r = 0) => `
  <g transform="translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(s)})">
    <path d="M0 4.8L0 9" stroke="#5b8a3c" stroke-width=".9" stroke-linecap="round"/>
    <path d="M0-5.2C3.2-3.6 3.6 1.8 0 4.6-3.6 1.8-3.2-3.6 0-5.2Z" fill="#fff6f9" stroke="#eaa9c2" stroke-width=".45"/>
    <path d="M-.6-4.4C-1.8-2 -1.6 1.6 0 4.2" fill="none" stroke="#f3c3d4" stroke-width=".5"/>
    <path d="M0 5.2C-1.9 4.8-2.6 3.3-2.2 2.2-1 3.2.2 3.4 0 5.2ZM0 5.2C1.9 4.8 2.6 3.3 2.2 2.2 1 3.2-.2 3.4 0 5.2Z" fill="#6c9a45"/>
  </g>`;

const LEMON_BODY =
  'M38-14C40-10 42-5.6 45.2-5C48.4-4.6 51.2-2.6 51.2 0S48.4 4.6 45.2 5C42 5.6 40 10 38 14'
  + 'C28 34-22 36-36 15C-38.5 11-41 6-43.6 4.6C-46.6 4-48.6 2.4-48.6 0S-46.6-4-43.6-4.6'
  + 'C-41-6-38.5-11-36-15C-22-36 28-34 38-14Z';
const LEMON_PORES = (() => {
  const rand = rng(23);
  let dark = '';
  let light = '';
  let n = 0;
  while (n < 70) {
    const x = (rand() * 2 - 1) * 42;
    const y = (rand() * 2 - 1) * 27;
    if ((x / 42) ** 2 + (y / 27) ** 2 > 0.9) continue;
    const rr = 0.34 + rand() * 0.44;
    const d = `M${pt(x - rr, y)}a${r2(rr)} ${r2(rr)} 0 1 0 ${r2(rr * 2)} 0a${r2(rr)} ${r2(rr)} 0 1 0-${r2(rr * 2)} 0`;
    if (n % 4 === 0) light += d; else dark += d;
    n++;
  }
  return { dark, light };
})();
let lemons = 0;
function lemonArt(x, y, r, s) {
  const id = `lm${lemons++}`;
  // Light from the top left of the picture, turned into the lemon's own coordinates.
  const toLocal = (ox, oy) => [(ox * Math.cos(rad(r)) + oy * Math.sin(rad(r))) / s, (-ox * Math.sin(rad(r)) + oy * Math.cos(rad(r))) / s];
  const [hx, hy] = toLocal(-13 * s, -12 * s);
  const [sx, sy] = toLocal(18 * s, 17 * s);
  const glint = r2(-r - 28);
  return `
  <g transform="translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(s)})">
    <defs>
      <radialGradient id="${id}-b" gradientUnits="userSpaceOnUse" cx="${r2(hx)}" cy="${r2(hy)}" r="66" fx="${r2(hx)}" fy="${r2(hy)}">
        <stop offset="0" stop-color="#fffbe0"/><stop offset=".16" stop-color="#fff4c2"/><stop offset=".38" stop-color="#fbe25a"/>
        <stop offset=".62" stop-color="#f6d23c"/><stop offset=".86" stop-color="#efbd22"/><stop offset="1" stop-color="#e9b51b"/>
      </radialGradient>
      <radialGradient id="${id}-s" gradientUnits="userSpaceOnUse" cx="${r2(sx)}" cy="${r2(sy)}" r="48">
        <stop offset="0" stop-color="#c27c00" stop-opacity=".4"/><stop offset=".55" stop-color="#d99a08" stop-opacity=".16"/>
        <stop offset="1" stop-color="#e9b51b" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path d="${LEMON_BODY}" fill="url(#${id}-b)"/>
    <path d="${LEMON_BODY}" fill="url(#${id}-s)"/>
    <path d="${LEMON_PORES.dark}" fill="#c98a07" fill-opacity=".22"/>
    <path d="${LEMON_PORES.light}" fill="#fffbe0" fill-opacity=".55"/>
    <ellipse cx="${r2(hx)}" cy="${r2(hy)}" rx="13" ry="6.2" transform="rotate(${glint} ${pt(hx, hy)})" fill="url(#glint)"/>
    <ellipse cx="${r2(hx - 2)}" cy="${r2(hy - 1)}" rx="3.4" ry="1.7" transform="rotate(${glint} ${pt(hx - 2, hy - 1)})" fill="#fff" fill-opacity=".9"/>
    <path d="${LEMON_BODY}" fill="none" stroke="#b17a00" stroke-opacity=".38" stroke-width=".8"/>
    <path d="M47.6-1.6Q50.2 0 47.6 1.6" fill="none" stroke="#b17a00" stroke-opacity=".35" stroke-width=".8" stroke-linecap="round"/>
    <circle cx="-47.4" cy="0" r="2.1" fill="#7a9a33"/>
    <path d="M-47.4 0l-2.2-2.4M-47.4 0l-2.6 1.6M-47.4 0l.4 2.8M-47.4 0l.6-2.8" stroke="#5f7f22" stroke-width=".9" stroke-linecap="round"/>
  </g>`;
}

const SLICE_SEGMENTS = segments(10, 38.6, 3.1);
const SLICE_SACS = (() => {
  const rand = rng(3);
  const h = Math.PI / 10;
  let light = '';
  let deep = '';
  for (let i = 0; i < 10; i++) {
    const th = (i * 36 - 90) * (Math.PI / 180);
    for (let k = 0; k < 13; k++) {
      const r1 = 8 + rand() * 25;
      const len = 3 + rand() * 4;
      const rr = Math.min(r1 + len, 35.6);
      const room = Math.max(0, Math.atan((r1 * Math.tan(h) - 2.6) / r1));
      const a = th + (rand() * 2 - 1) * room;
      const w = 0.55 + rand() * 0.45;
      const m = (r1 + rr) / 2;
      const [ux, uy, px, py] = [Math.cos(a), Math.sin(a), -Math.sin(a) * w, Math.cos(a) * w];
      const seg = `M${pt(ux * r1, uy * r1)}Q${pt(ux * m + px, uy * m + py)} ${pt(ux * rr, uy * rr)}`
        + `Q${pt(ux * m - px, uy * m - py)} ${pt(ux * r1, uy * r1)}Z`;
      if (k % 3 === 0) deep += seg; else light += seg;
    }
  }
  return { light, deep };
})();
const arc = (rr, from, to) =>
  `M${pt(Math.cos(rad(from)) * rr, Math.sin(rad(from)) * rr)}A${rr} ${rr} 0 0 1 ${pt(Math.cos(rad(to)) * rr, Math.sin(rad(to)) * rr)}`;
function sliceArt(x, y, s, r = 0) {
  const g0 = 196 - r; // the wet highlight stays at the top left whatever the rotation
  return `
  <g transform="translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(s)})">
    <circle r="50" fill="url(#rind)"/>
    <path d="${arc(47.4, g0 - 10, g0 + 62)}" fill="none" stroke="#fff6b0" stroke-opacity=".9" stroke-width="1.6" stroke-linecap="round"/>
    <circle r="44.6" fill="url(#pith)"/>
    <circle r="39.4" fill="#fff8dc"/>
    <path d="${SLICE_SEGMENTS}" fill="url(#seg)"/>
    <path d="${SLICE_SACS.light}" fill="#fffbe6" fill-opacity=".7"/>
    <path d="${SLICE_SACS.deep}" fill="#e6ab12" fill-opacity=".4"/>
    <path d="${arc(33, g0 + 4, g0 + 46)}" fill="none" stroke="#fff" stroke-opacity=".62" stroke-width="2.6" stroke-linecap="round"/>
    <path d="${arc(28.4, g0 + 12, g0 + 26)}" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>
    <circle r="2.6" fill="#fffbea"/>
    <circle r="50" fill="none" stroke="#b17a00" stroke-opacity=".36" stroke-width=".8"/>
    <circle r="44.6" fill="none" stroke="#e8c650" stroke-opacity=".45" stroke-width=".6"/>
  </g>`;
}

// The hero's and the footer's corner sprigs (brand.tsx), composed for the top-left corner of a
// 200 × 200 box. Other corners mirror the positions but keep the light coming from the top left.
const SPRIG_FULL = [
  { k: 'leaf', x: 104, y: 26, r: 82, s: 1.12, t: 1 },
  { k: 'leaf', x: 100, y: 34, r: 108, s: 1.0 },
  { k: 'leaf', x: 64, y: 50, r: 100, s: 1.26 },
  { k: 'leaf', x: 58, y: 56, r: 128, s: 1.16, t: 1 },
  { k: 'leaf', x: 42, y: 66, r: 154, s: 1.2 },
  { k: 'leaf', x: 26, y: 74, r: 178, s: 1.22, t: 1 },
  { k: 'leaf', x: 8, y: 94, r: 204, s: 1.0 },
  { k: 'leaf', x: 40, y: 18, r: -36, s: 0.86 },
  { k: 'lemon', x: 72, y: 28, r: 16, s: 0.9 },
  { k: 'slice', x: 20, y: 80, r: 10, s: 0.66 },
  { k: 'leaf', x: 34, y: 108, r: 146, s: 0.72, t: 1 },
  { k: 'blossom', x: 112, y: 54, r: 8, s: 1.36 },
  { k: 'blossom', x: 64, y: 100, r: 36, s: 1.12 },
  { k: 'blossom', x: 18, y: 22, r: -10, s: 1.2 },
  { k: 'bud', x: 138, y: 64, r: 112, s: 1.0 },
  { k: 'bud', x: 158, y: 30, r: 70, s: 0.9 },
  { k: 'bud', x: 42, y: 132, r: 170, s: 0.9 },
];
const SPRIG_SLICE = [
  { k: 'leaf', x: 40, y: 52, r: 64, s: 0.98, t: 1 },
  { k: 'leaf', x: 44, y: 66, r: 92, s: 1.16 },
  { k: 'leaf', x: 40, y: 76, r: 122, s: 1.1, t: 1 },
  { k: 'leaf', x: 22, y: 92, r: 158, s: 1.16 },
  { k: 'leaf', x: 6, y: 100, r: 186, s: 0.9, t: 1 },
  { k: 'slice', x: 14, y: 68, r: 6, s: 0.7 },
  { k: 'blossom', x: 66, y: 86, r: 20, s: 1.26 },
  { k: 'blossom', x: 50, y: 30, r: -14, s: 0.92 },
  { k: 'bud', x: 104, y: 50, r: 84, s: 0.95 },
  { k: 'bud', x: 46, y: 140, r: 168, s: 0.9 },
];
const CARD_W = 1200;
const CARD_H = 630;
function sprig(corner, size, items) {
  const W = 200;
  const mx = corner === 'tr' || corner === 'br';
  const my = corner === 'bl' || corner === 'br';
  const mirror = mx !== my;
  const parts = items.map((it) => {
    const x = mx ? W - it.x : it.x;
    const y = my ? W - it.y : it.y;
    let r = it.r;
    if (mx) r = -r;
    if (my) r = 180 - r;
    switch (it.k) {
      case 'leaf': return leafArt(x, y, r, it.s, it.t, mirror);
      case 'lemon': return lemonArt(x, y, r, it.s);
      case 'slice': return `<circle cx="${r2(x + 2.5)}" cy="${r2(y + 4)}" r="${r2(50 * it.s + 5)}" fill="url(#shadow)"/>${sliceArt(x, y, it.s, it.r)}`;
      case 'blossom': return blossomArt(x, y, it.s, it.r);
      case 'bud': return budArt(x, y, it.s, r);
      default: throw new Error(`unknown sprig item ${it.k}`);
    }
  });
  return `<g filter="url(#drop)"><g transform="translate(${mx ? CARD_W - size : 0} ${my ? CARD_H - size : 0}) scale(${r2(size / W)})">${parts.join('')}</g></g>`;
}

const HEART_OUTLINE =
  'M12.2 20.4c-1.1-1-2.9-2.2-4.6-3.8C5.3 14.4 3.4 12 3.6 9.1c.2-2.7 2.3-4.6 4.7-4.4 1.8.1 3.1 1.4 3.8 3.1.8-1.9 2.4-3.3 4.4-3.2 2.6.1 4.3 2.3 4.1 4.9-.2 3-2.5 5.4-4.8 7.4-1.2 1-2.4 2-3.4 3.2l-.5.6';
const HEART_FILLED =
  'M12 20.6c-1.2-1.1-3-2.4-4.7-4C5.1 14.5 3.3 12.1 3.5 9.2c.2-2.7 2.3-4.6 4.7-4.4 1.8.1 3.1 1.4 3.8 3.1.8-1.9 2.4-3.3 4.4-3.2 2.6.1 4.3 2.3 4.1 4.9-.2 3-2.5 5.4-4.8 7.4-1.2 1-2.5 2.2-3.7 3.6Z';
// Little hand-drawn hearts in the page's pink (--pink on plum night), like the hero's.
const heart = (x, y, size, rot, filled = false, opacity = 0.8) => `
  <g transform="translate(${x} ${y}) rotate(${rot}) scale(${r2(size / 24)}) translate(-12 -12)" opacity="${opacity}">
    ${filled
      ? `<path d="${HEART_FILLED}" fill="#ff6fb0"/>`
      : `<path d="${HEART_OUTLINE}" fill="none" stroke="#ff6fb0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`}
  </g>`;

// The polish bottle (brand.tsx's PolishBottle), with the icon's bolder glass and polish so it holds
// its own on the dark background.
const BOTTLE = `
  <ellipse cx="64" cy="141" rx="40" ry="6.5" fill="url(#shadow2)"/>
  <rect x="39" y="56" width="42" height="12" rx="3" fill="#f6b8d2"/>
  <rect x="22" y="62" width="76" height="78" rx="15" fill="url(#glass)" stroke="#e98ab4" stroke-width="1.6"/>
  <rect x="28" y="68" width="64" height="58" rx="10" fill="url(#liq)"/>
  <path d="M30.5 74C30.5 70.4 32.6 68.8 36 68.8" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="2" stroke-linecap="round"/>
  <path d="M60 106.2c-4.3-3.2-8.8-6.6-8.6-11 .1-2.9 2.3-4.8 4.8-4.6 1.7.1 3 1.2 3.8 2.8.8-1.7 2.2-2.9 4.1-2.9 2.6 0 4.6 2.1 4.4 4.8-.3 4.3-4.8 7.6-8.5 10.9Z" fill="#fff" fill-opacity=".92"/>
  <rect x="27" y="72" width="5" height="52" rx="2.5" fill="#fff" fill-opacity=".5"/>
  <rect x="88.5" y="76" width="2.4" height="40" rx="1.2" fill="#fff" fill-opacity=".55"/>
  <path d="M30 131.5h60" stroke="#f7c6da" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="42" y="8" width="36" height="54" rx="6" fill="url(#cap)"/>
  <rect x="42" y="8" width="36" height="54" rx="6" fill="none" stroke="#7a4f12" stroke-opacity=".35" stroke-width="1"/>
  <rect x="40" y="54" width="40" height="9" rx="3" fill="url(#cap)"/>
  <path d="M46 12.5h28" stroke="#fff5d6" stroke-opacity=".8" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M50 16v40" stroke="#fffbe8" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round"/>`;

// The middle: the app icon's picture, laid out in its 512 × 512 space, with a leaf and a bud more.
const CENTRE = `
  ${leafArt(390, 248, 30, 2.5)}
  ${leafArt(428, 294, 72, 2.3, 1, true)}
  ${leafArt(214, 414, 226, 2.1, 1)}
  ${leafArt(420, 404, 136, 1.9)}
  <circle cx="340" cy="342" r="126" fill="url(#shadow)"/>
  ${sliceArt(332, 334, 2.36, 8)}
  ${blossomArt(442, 228, 3.1, 8)}
  ${budArt(492, 262, 2.6, 64)}
  <g transform="translate(78 64) scale(2.62) rotate(-9 60 82)">${BOTTLE}</g>`;

const card = () => Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <radialGradient id="bg" gradientUnits="userSpaceOnUse" cx="560" cy="250" r="760">
      <stop offset="0" stop-color="#4a2a4f"/><stop offset="0.5" stop-color="#2c1a31"/><stop offset="1" stop-color="#1a1020"/>
    </radialGradient>
    <radialGradient id="wash-pink"><stop offset="0" stop-color="#d6156f" stop-opacity=".3"/><stop offset="1" stop-color="#d6156f" stop-opacity="0"/></radialGradient>
    <radialGradient id="wash-lilac"><stop offset="0" stop-color="#8c64c8" stop-opacity=".22"/><stop offset="1" stop-color="#8c64c8" stop-opacity="0"/></radialGradient>
    <radialGradient id="wash-lemon"><stop offset="0" stop-color="#f6d23c" stop-opacity=".09"/><stop offset="1" stop-color="#f6d23c" stop-opacity="0"/></radialGradient>
    <linearGradient id="lf1" x1="0" y1="1" x2=".25" y2="0"><stop offset="0" stop-color="#4c8636"/><stop offset=".5" stop-color="#7db35a"/><stop offset="1" stop-color="#a9d184"/></linearGradient>
    <linearGradient id="lf2" x1="0" y1="1" x2=".2" y2="0"><stop offset="0" stop-color="#2c5b22"/><stop offset=".55" stop-color="#4e8b3a"/><stop offset="1" stop-color="#64a046"/></linearGradient>
    <radialGradient id="pt" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="11">
      <stop offset="0" stop-color="#ec8fb3"/><stop offset=".2" stop-color="#f6c2d6"/><stop offset=".42" stop-color="#fff4f8"/>
      <stop offset=".78" stop-color="#ffffff"/><stop offset="1" stop-color="#fbd6e4"/>
    </radialGradient>
    <radialGradient id="ctr" cx=".4" cy=".38" r=".7"><stop offset="0" stop-color="#f4ec8a"/><stop offset=".6" stop-color="#c9cf4a"/><stop offset="1" stop-color="#8fa531"/></radialGradient>
    <radialGradient id="bsh"><stop offset=".55" stop-color="#a8325f" stop-opacity=".16"/><stop offset="1" stop-color="#a8325f" stop-opacity="0"/></radialGradient>
    <radialGradient id="rind" cx=".36" cy=".32" r=".72">
      <stop offset="0" stop-color="#fff07a"/><stop offset=".55" stop-color="#f6d23c"/><stop offset=".9" stop-color="#ecb81c"/><stop offset="1" stop-color="#e9b51b"/>
    </radialGradient>
    <radialGradient id="pith" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="44.6"><stop offset=".86" stop-color="#fffdf2"/><stop offset="1" stop-color="#fff1bd"/></radialGradient>
    <radialGradient id="seg" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="39">
      <stop offset="0" stop-color="#fffbe3"/><stop offset=".3" stop-color="#fff0a0"/><stop offset=".7" stop-color="#fbdc52"/><stop offset="1" stop-color="#f6d23c"/>
    </radialGradient>
    <radialGradient id="glint"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".5" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <radialGradient id="shadow"><stop offset=".8" stop-color="#a8325f" stop-opacity=".2"/><stop offset="1" stop-color="#a8325f" stop-opacity="0"/></radialGradient>
    <radialGradient id="shadow2"><stop offset="0" stop-color="#a8325f" stop-opacity=".32"/><stop offset="1" stop-color="#a8325f" stop-opacity="0"/></radialGradient>
    <linearGradient id="cap" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8d5f1c"/><stop offset=".14" stop-color="#c99a45"/><stop offset=".3" stop-color="#fbe7a8"/><stop offset=".42" stop-color="#e3b65a"/>
      <stop offset=".68" stop-color="#b88430"/><stop offset=".84" stop-color="#efcd7c"/><stop offset="1" stop-color="#94631d"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#fff0f6"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
    <linearGradient id="liq" x1=".1" y1="0" x2=".9" y2="1">
      <stop offset="0" stop-color="#ffb6d6"/><stop offset=".35" stop-color="#ff7fb8"/><stop offset=".75" stop-color="#ef4c9b"/><stop offset="1" stop-color="#d6156f"/>
    </linearGradient>
    <filter id="drop" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="4"/><feOffset dy="3" result="blur"/>
      <feFlood flood-color="#000" flood-opacity=".35"/><feComposite in2="blur" operator="in"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  <circle cx="60" cy="0" r="460" fill="url(#wash-pink)"/>
  <circle cx="1210" cy="10" r="400" fill="url(#wash-lemon)"/>
  <circle cx="1060" cy="640" r="470" fill="url(#wash-pink)"/>
  <circle cx="20" cy="640" r="440" fill="url(#wash-lilac)"/>
  ${sprig('tl', 330, SPRIG_FULL)}
  ${sprig('tr', 330, SPRIG_FULL)}
  ${sprig('bl', 320, SPRIG_SLICE)}
  ${sprig('br', 320, SPRIG_SLICE)}
  ${heart(338, 236, 30, -14, true, 0.75)}
  ${heart(262, 400, 22, 10, false, 0.7)}
  ${heart(902, 140, 24, 12, false, 0.7)}
  ${heart(968, 372, 32, 12, true, 0.75)}
  ${heart(846, 560, 22, -8, false, 0.65)}
  ${heart(420, 584, 20, -16, true, 0.6)}
  <g filter="url(#drop)"><g transform="translate(600 322) scale(1.24) translate(-300 -282)">${CENTRE}</g></g>
</svg>`);

await mkdir('public/og', { recursive: true });
// Drawn at twice the size and scaled down for smooth edges; quality 82 keeps it well under 200 KB.
await sharp(card(), { density: 144 }).resize(CARD_W, CARD_H).jpeg({ quality: 82, mozjpeg: true }).toFile('public/og/booking-card.jpg');
console.log('wrote', 'public/og/booking-card.jpg');
