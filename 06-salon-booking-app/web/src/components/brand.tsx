// The "Lemon & Blush" brand layer: hand-built SVG illustrations (lemons, slices,
// leaves, blossoms, a polish bottle), line icons, script headings over a pink
// brush swatch, and the booking-page hero and footer. Styles live in brand.css.
//
// Everything decorative is aria-hidden, so it never changes an accessible name.
// Gradient ids come from useId(), so many copies can share one page.
import { forwardRef, useId, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

/* ------------------------------------------------------------------ helpers */

/** Deterministic pseudo-random numbers, so every render draws the same art. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const pt = (x: number, y: number) => `${r2(x)} ${r2(y)}`;
const rad = (deg: number) => (deg * Math.PI) / 180;
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** A url-safe id for SVG defs (useId returns ":r1:", which url(#…) dislikes). */
function useSvgId(prefix: string) {
  return prefix + useId().replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Gradient stop that can use a CSS variable (presentation attributes can't). */
function Stop({ o, c, a }: { o: number; c: string; a?: number }) {
  const style: CSSProperties = { stopColor: c };
  if (a !== undefined) style.stopOpacity = a;
  return <stop offset={o} style={style} />;
}

const hidden = { 'aria-hidden': true, focusable: false } as const;

/* ------------------------------------------------------------------ hearts */

const HEART_OUTLINE =
  'M12.2 20.4c-1.1-1-2.9-2.2-4.6-3.8C5.3 14.4 3.4 12 3.6 9.1c.2-2.7 2.3-4.6 4.7-4.4 1.8.1 3.1 1.4 3.8 3.1.8-1.9 2.4-3.3 4.4-3.2 2.6.1 4.3 2.3 4.1 4.9-.2 3-2.5 5.4-4.8 7.4-1.2 1-2.4 2-3.4 3.2l-.5.6';
const HEART_FILLED =
  'M12 20.6c-1.2-1.1-3-2.4-4.7-4C5.1 14.5 3.3 12.1 3.5 9.2c.2-2.7 2.3-4.6 4.7-4.4 1.8.1 3.1 1.4 3.8 3.1.8-1.9 2.4-3.3 4.4-3.2 2.6.1 4.3 2.3 4.1 4.9-.2 3-2.5 5.4-4.8 7.4-1.2 1-2.5 2.2-3.7 3.6Z';

/** A small hand-drawn heart in currentColor (outline by default). */
export function Heart({ size = 14, filled = false, className, style }: {
  size?: number; filled?: boolean; className?: string; style?: CSSProperties;
}) {
  return (
    <svg {...hidden} className={cx('heart', className)} style={style} width={size} height={size} viewBox="0 0 24 24">
      {filled
        ? <path d={HEART_FILLED} fill="currentColor" />
        : <path d={HEART_OUTLINE} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/* --------------------------------------------------------------- the leaf */
// Drawn pointing up from its stalk at (0,0); length 50. Two halves in different
// greens fold it along a gently curved midrib, like a painted citrus leaf.

const LEAF_A = 'M0 0C-11.5-9-14-30 2.6-50Q2.4-25 0 0Z'; // left half
const LEAF_B = 'M0 0Q2.4-25 2.6-50C15.5-33 12.5-10 0 0Z'; // right half
const LEAF_EDGE = 'M0 0C-11.5-9-14-30 2.6-50C15.5-33 12.5-10 0 0Z';
const LEAF_MID = 'M.1 1.5Q2.3-24 2.5-46.5';
const LEAF_VEINS =
  'M1.1-9Q-3.4-12.6-7.4-19M1.7-17Q-3.6-20.6-8.6-28M2.1-26Q-2.4-29.6-6.8-36.6M2.4-35Q-.6-38-3.4-43'
  + 'M1.2-6Q5.6-9.6 9-16.4M1.8-15Q6.6-18.6 10-26M2.2-24Q6.6-27.6 9.2-35.4M2.4-33.4Q5.6-36.4 7.2-42';
const LEAF_GLOSS = 'M-3.4-8C-6.6-17-6.4-28-1.6-39';

function LeafArt({ id, x, y, r, s, tone = 0, mirror = false }: {
  id: string; x: number; y: number; r: number; s: number; tone?: 0 | 1; mirror?: boolean;
}) {
  const light = `url(#${id}-lf1)`;
  const dark = `url(#${id}-lf2)`;
  return (
    <g transform={`translate(${pt(x, y)}) rotate(${r2(r)}) scale(${mirror ? -s : s} ${s})`}>
      <path d="M0 0L-.4 6.5" stroke="#4a7a32" strokeWidth={1.6} strokeLinecap="round" />
      <path d={LEAF_A} fill={tone ? dark : light} />
      <path d={LEAF_B} fill={tone ? light : dark} />
      <path d={LEAF_VEINS} fill="none" stroke="#e4f2d0" strokeOpacity={0.22} strokeWidth={0.5} strokeLinecap="round" />
      <path d={LEAF_MID} fill="none" stroke="#eef7df" strokeOpacity={0.78} strokeWidth={0.95} strokeLinecap="round" />
      <path d={LEAF_GLOSS} fill="none" stroke="#fff" strokeOpacity={0.2} strokeWidth={2.6} strokeLinecap="round" />
      <path d={LEAF_EDGE} fill="none" stroke="#1f4417" strokeOpacity={0.32} strokeWidth={0.6} />
    </g>
  );
}

/* ----------------------------------------------------------- the blossom */
// Five waxy petals, white with a blush base, around yellow stamens. Drawn at a
// petal length of 10 around (0,0), so one shared radial gradient fits them all.

const BLOSSOM_PETALS = (() => {
  const rand = rng(11);
  return [0, 1, 2, 3, 4].map((i) => ({ a: r2(i * 72 + (rand() - 0.5) * 12), l: r2(0.92 + rand() * 0.14) }));
})();
const PETAL = 'M0-1.1C2.4-2.2 3.9-5.3 3.3-8 2.9-9.7 1.3-10.7 0-11-1.3-10.7-2.9-9.7-3.3-8-3.9-5.3-2.4-2.2 0-1.1Z';
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

function BlossomArt({ id, x, y, s, r = 0 }: { id: string; x: number; y: number; s: number; r?: number }) {
  return (
    <g transform={`translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(s)})`}>
      <circle r={9.4} cx={0.5} cy={1.1} fill={`url(#${id}-bsh)`} />
      {BLOSSOM_PETALS.map((p, i) => (
        <g key={i} transform={`rotate(${p.a}) scale(${p.l})`}>
          <path d={PETAL} fill={`url(#${id}-pt)`} />
          <path d={PETAL_CUP} fill="#f3cfe0" fillOpacity={0.5} />
          <path d={PETAL_CREASE} fill="none" stroke="#efb7cd" strokeOpacity={0.8} strokeWidth={0.32} strokeLinecap="round" />
          <path d={PETAL} fill="none" stroke="#e59bb9" strokeOpacity={0.75} strokeWidth={0.32} />
        </g>
      ))}
      <circle r={2.6} fill="#fbe7a1" fillOpacity={0.55} />
      <path d={STAMENS.lines} stroke="#e2b23a" strokeWidth={0.3} strokeLinecap="round" />
      <circle r={1.25} fill={`url(#${id}-ctr)`} />
      <path d={STAMENS.dots} fill="#f3b21c" stroke="#c98510" strokeWidth={0.12} />
    </g>
  );
}

/** A closed bud, for scattering between blossoms. */
function BudArt({ x, y, s, r = 0 }: { x: number; y: number; s: number; r?: number }) {
  return (
    <g transform={`translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(s)})`}>
      <path d="M0 4.8L0 9" stroke="#5b8a3c" strokeWidth={0.9} strokeLinecap="round" />
      <path d="M0-5.2C3.2-3.6 3.6 1.8 0 4.6-3.6 1.8-3.2-3.6 0-5.2Z" fill="#fff6f9" stroke="#eaa9c2" strokeWidth={0.45} />
      <path d="M-.6-4.4C-1.8-2 -1.6 1.6 0 4.2" fill="none" stroke="#f3c3d4" strokeWidth={0.5} />
      <path d="M0 5.2C-1.9 4.8-2.6 3.3-2.2 2.2-1 3.2.2 3.4 0 5.2ZM0 5.2C1.9 4.8 2.6 3.3 2.2 2.2 1 3.2-.2 3.4 0 5.2Z" fill="#6c9a45" />
    </g>
  );
}

/* --------------------------------------------------------- the whole lemon */
// Length 100 along x, centred on (0,0), with a nub at each end. The highlight is
// placed in screen space (top-left) whatever the lemon's rotation.

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

function LemonArt({ id, x, y, r, s }: { id: string; x: number; y: number; r: number; s: number }) {
  // Screen-space light from the top left, turned into the lemon's own coordinates.
  const toLocal = (ox: number, oy: number) => {
    const a = rad(r);
    return [(ox * Math.cos(a) + oy * Math.sin(a)) / s, (-ox * Math.sin(a) + oy * Math.cos(a)) / s];
  };
  const [hx, hy] = toLocal(-13 * s, -12 * s);
  const [sx, sy] = toLocal(18 * s, 17 * s);
  const glintAngle = -r - 28;
  return (
    <g transform={`translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(s)})`}>
      <defs>
        <radialGradient id={`${id}-b`} gradientUnits="userSpaceOnUse" cx={r2(hx)} cy={r2(hy)} r={66} fx={r2(hx)} fy={r2(hy)}>
          <Stop o={0} c="#fffbe0" />
          <Stop o={0.16} c="var(--lemon-pale, #fff4c2)" />
          <Stop o={0.38} c="#fbe25a" />
          <Stop o={0.62} c="var(--lemon, #f6d23c)" />
          <Stop o={0.86} c="#efbd22" />
          <Stop o={1} c="var(--lemon-deep, #e9b51b)" />
        </radialGradient>
        <radialGradient id={`${id}-s`} gradientUnits="userSpaceOnUse" cx={r2(sx)} cy={r2(sy)} r={48}>
          <Stop o={0} c="#c27c00" a={0.4} />
          <Stop o={0.55} c="#d99a08" a={0.16} />
          <Stop o={1} c="#e9b51b" a={0} />
        </radialGradient>
        <radialGradient id={`${id}-h`}>
          <Stop o={0} c="#fff" a={0.95} />
          <Stop o={0.5} c="#fff" a={0.45} />
          <Stop o={1} c="#fff" a={0} />
        </radialGradient>
      </defs>
      <path d={LEMON_BODY} fill={`url(#${id}-b)`} />
      <path d={LEMON_BODY} fill={`url(#${id}-s)`} />
      <path d={LEMON_PORES.dark} fill="#c98a07" fillOpacity={0.22} />
      <path d={LEMON_PORES.light} fill="#fffbe0" fillOpacity={0.55} />
      <ellipse cx={r2(hx)} cy={r2(hy)} rx={13} ry={6.2} transform={`rotate(${r2(glintAngle)} ${pt(hx, hy)})`} fill={`url(#${id}-h)`} />
      <ellipse cx={r2(hx - 2)} cy={r2(hy - 1)} rx={3.4} ry={1.7} transform={`rotate(${r2(glintAngle)} ${pt(hx - 2, hy - 1)})`} fill="#fff" fillOpacity={0.9} />
      <path d={LEMON_BODY} fill="none" stroke="#b17a00" strokeOpacity={0.38} strokeWidth={0.8} />
      <path d="M47.6-1.6Q50.2 0 47.6 1.6" fill="none" stroke="#b17a00" strokeOpacity={0.35} strokeWidth={0.8} strokeLinecap="round" />
      <circle cx={-47.4} cy={0} r={2.1} fill="#7a9a33" />
      <path d="M-47.4 0l-2.2-2.4M-47.4 0l-2.6 1.6M-47.4 0l.4 2.8M-47.4 0l.6-2.8" stroke="#5f7f22" strokeWidth={0.9} strokeLinecap="round" />
    </g>
  );
}

/* --------------------------------------------------------- the lemon slice */
// Radius 50, centred on (0,0): zesty rind, white pith, ten juicy segments
// separated by even membranes, with juice sacs and a wet highlight.

const SLICE_SEGMENTS = (() => {
  const n = 10;
  const ro = 38.6;
  const g = 3.1;
  const c = 3.4;
  const tr = 1.4;
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
    const P = (u: number[], nn: number[], t: number) => [t * u[0] + (g / 2) * nn[0], t * u[1] + (g / 2) * nn[1]];
    const t = Math.sqrt(ro * ro - (g / 2) ** 2);
    const tipD = g / 2 / Math.sin(h);
    const tip = [tipD * Math.cos(th), tipD * Math.sin(th)];
    const tt = tipD * Math.cos(h);
    const c0 = P(u0, n0, t);
    const c1 = P(u1, n1, t);
    const e0 = P(u0, n0, t - c);
    const e1 = P(u1, n1, t - c);
    const s0 = P(u0, n0, tt + tr);
    const s1 = P(u1, n1, tt + tr);
    const off = Math.asin(g / 2 / ro) + c / ro;
    const q0 = [ro * Math.cos(a0 + off), ro * Math.sin(a0 + off)];
    const q1 = [ro * Math.cos(a1 - off), ro * Math.sin(a1 - off)];
    d += `M${pt(s0[0], s0[1])}L${pt(e0[0], e0[1])}Q${pt(c0[0], c0[1])} ${pt(q0[0], q0[1])}`
      + `A${ro} ${ro} 0 0 1 ${pt(q1[0], q1[1])}Q${pt(c1[0], c1[1])} ${pt(e1[0], e1[1])}`
      + `L${pt(s1[0], s1[1])}Q${pt(tip[0], tip[1])} ${pt(s0[0], s0[1])}Z`;
  }
  return d;
})();
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

function SliceArt({ id, x, y, s, r = 0, gloss = 0 }: { id: string; x: number; y: number; s: number; r?: number; gloss?: number }) {
  // The wet highlight stays at the top left whatever the slice's rotation.
  const g0 = 196 - r + gloss;
  const arc = (rr: number, from: number, to: number) => {
    const a = rad(from);
    const b = rad(to);
    return `M${pt(Math.cos(a) * rr, Math.sin(a) * rr)}A${rr} ${rr} 0 0 1 ${pt(Math.cos(b) * rr, Math.sin(b) * rr)}`;
  };
  return (
    <g transform={`translate(${pt(x, y)}) rotate(${r2(r)}) scale(${r2(s)})`}>
      <circle r={50} fill={`url(#${id}-rind)`} />
      <path d={arc(47.4, g0 - 10, g0 + 62)} fill="none" stroke="#fff6b0" strokeOpacity={0.9} strokeWidth={1.6} strokeLinecap="round" />
      <circle r={44.6} fill={`url(#${id}-pith)`} />
      <circle r={39.4} fill="#fff8dc" />
      <path d={SLICE_SEGMENTS} fill={`url(#${id}-seg)`} />
      <path d={SLICE_SACS.light} fill="#fffbe6" fillOpacity={0.7} />
      <path d={SLICE_SACS.deep} fill="#e6ab12" fillOpacity={0.4} />
      <path d={arc(33, g0 + 4, g0 + 46)} fill="none" stroke="#fff" strokeOpacity={0.62} strokeWidth={2.6} strokeLinecap="round" />
      <path d={arc(28.4, g0 + 12, g0 + 26)} fill="none" stroke="#fff" strokeOpacity={0.5} strokeWidth={1.6} strokeLinecap="round" />
      <circle r={2.6} fill="#fffbea" />
      <circle r={50} fill="none" stroke="#b17a00" strokeOpacity={0.36} strokeWidth={0.8} />
      <circle r={44.6} fill="none" stroke="#e8c650" strokeOpacity={0.45} strokeWidth={0.6} />
    </g>
  );
}

/** The gradients the leaves, blossoms and slices share inside one <svg>. */
function SharedDefs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-lf1`} x1="0" y1="1" x2="0.25" y2="0">
        <Stop o={0} c="#4c8636" />
        <Stop o={0.5} c="var(--leaf-light, #7db35a)" />
        <Stop o={1} c="#a9d184" />
      </linearGradient>
      <linearGradient id={`${id}-lf2`} x1="0" y1="1" x2="0.2" y2="0">
        <Stop o={0} c="#2c5b22" />
        <Stop o={0.55} c="var(--leaf, #4e8b3a)" />
        <Stop o={1} c="#64a046" />
      </linearGradient>
      <radialGradient id={`${id}-pt`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="11">
        <Stop o={0} c="#ec8fb3" />
        <Stop o={0.2} c="#f6c2d6" />
        <Stop o={0.42} c="#fff4f8" />
        <Stop o={0.78} c="#ffffff" />
        <Stop o={1} c="#fbd6e4" />
      </radialGradient>
      <radialGradient id={`${id}-ctr`} cx="0.4" cy="0.38" r="0.7">
        <Stop o={0} c="#f4ec8a" />
        <Stop o={0.6} c="#c9cf4a" />
        <Stop o={1} c="#8fa531" />
      </radialGradient>
      <radialGradient id={`${id}-bsh`}>
        <Stop o={0.55} c="#a8325f" a={0.16} />
        <Stop o={1} c="#a8325f" a={0} />
      </radialGradient>
      <radialGradient id={`${id}-rind`} cx="0.36" cy="0.32" r="0.72">
        <Stop o={0} c="#fff07a" />
        <Stop o={0.55} c="var(--lemon, #f6d23c)" />
        <Stop o={0.9} c="#ecb81c" />
        <Stop o={1} c="var(--lemon-deep, #e9b51b)" />
      </radialGradient>
      <radialGradient id={`${id}-pith`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="44.6">
        <Stop o={0.86} c="#fffdf2" />
        <Stop o={1} c="#fff1bd" />
      </radialGradient>
      <radialGradient id={`${id}-seg`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="39">
        <Stop o={0} c="#fffbe3" />
        <Stop o={0.3} c="#fff0a0" />
        <Stop o={0.7} c="#fbdc52" />
        <Stop o={1} c="var(--lemon, #f6d23c)" />
      </radialGradient>
      <radialGradient id={`${id}-shadow`}>
        <Stop o={0.6} c="#8a2a4f" a={0.2} />
        <Stop o={1} c="#8a2a4f" a={0} />
      </radialGradient>
    </defs>
  );
}

/* ---------------------------------------------------- standalone pictures */

type ArtProps = { size?: number; className?: string; style?: CSSProperties };

/** A whole lemon with two leaves and a blossom. `size` is the width. */
export function Lemon({ size = 48, className, style }: ArtProps) {
  const id = useSvgId('lm');
  return (
    <svg {...hidden} className={cx('brand-art', 'brand-lemon', className)} style={style}
      width={size} height={r2(size * 0.86)} viewBox="0 0 120 103">
      <SharedDefs id={id} />
      <LeafArt id={id} x={26} y={42} r={-28} s={0.82} tone={1} />
      <LeafArt id={id} x={28} y={40} r={38} s={0.9} />
      <LemonArt id={`${id}-l`} x={66} y={62} r={24} s={1} />
      <BlossomArt id={id} x={24} y={36} s={1.05} r={12} />
    </svg>
  );
}

/** A lemon slice: rind, pith and segments. `size` is the diameter. */
export function LemonSlice({ size = 48, className, style }: ArtProps) {
  const id = useSvgId('ls');
  return (
    <svg {...hidden} className={cx('brand-art', 'brand-slice', className)} style={style}
      width={size} height={size} viewBox="-52 -52 104 104">
      <SharedDefs id={id} />
      <SliceArt id={id} x={0} y={0} s={1} />
    </svg>
  );
}

/** A white five-petal blossom with a blush base and yellow stamens. */
export function Blossom({ size = 18, className, style }: ArtProps) {
  const id = useSvgId('bl');
  return (
    <svg {...hidden} className={cx('brand-art', 'brand-blossom', className)} style={style}
      width={size} height={size} viewBox="-11.5 -11.5 23 23">
      <SharedDefs id={id} />
      <BlossomArt id={id} x={0} y={0} s={1} />
    </svg>
  );
}

/* ------------------------------------------------------------ the sprigs */

export type Corner = 'tl' | 'tr' | 'bl' | 'br';
type Item =
  | { k: 'leaf'; x: number; y: number; r: number; s: number; t?: 0 | 1 }
  | { k: 'lemon'; x: number; y: number; r: number; s: number }
  | { k: 'slice'; x: number; y: number; r: number; s: number }
  | { k: 'blossom'; x: number; y: number; r: number; s: number }
  | { k: 'bud'; x: number; y: number; r: number; s: number };

// Composed for the top-left corner of a 200 × 200 box; (0,0) is the corner.
// Other corners mirror the positions but keep the light coming from the top left.
const SPRIG_FULL: Item[] = [
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
// A lighter cluster around a slice, for the footer's bottom corners. The slice runs
// off the side edge only, so it reads well wherever the footer ends.
const SPRIG_SLICE: Item[] = [
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

/**
 * A corner cluster of lemons, a slice, leaves and blossoms. The `sprig-<corner>`
 * class pins it absolutely to that corner of the nearest positioned ancestor;
 * the art runs off the corner's two edges, so put it flush with a clipping box.
 */
export function Sprig({ corner, size = 120, className, variant = 'full', style }: {
  corner: Corner; size?: number; className?: string; variant?: 'full' | 'slice'; style?: CSSProperties;
}) {
  const id = useSvgId('sp');
  const mx = corner === 'tr' || corner === 'br';
  const my = corner === 'bl' || corner === 'br';
  const mirror = mx !== my;
  const items = variant === 'slice' ? SPRIG_SLICE : SPRIG_FULL;
  const W = 200;
  return (
    <svg {...hidden} className={cx('sprig', `sprig-${corner}`, className)} style={style}
      width={size} height={size} viewBox={`0 0 ${W} ${W}`}>
      <SharedDefs id={id} />
      {items.map((it, i) => {
        const x = mx ? W - it.x : it.x;
        const y = my ? W - it.y : it.y;
        let r = it.r;
        if (mx) r = -r;
        if (my) r = 180 - r;
        switch (it.k) {
          case 'leaf': return <LeafArt key={i} id={id} x={x} y={y} r={r} s={it.s} tone={it.t} mirror={mirror} />;
          case 'lemon': return <LemonArt key={i} id={`${id}-l${i}`} x={x} y={y} r={r} s={it.s} />;
          case 'slice': return (
            <g key={i}>
              <circle cx={x + 2.5} cy={y + 4} r={50 * it.s + 5} fill={`url(#${id}-shadow)`} />
              <SliceArt id={id} x={x} y={y} r={it.r} s={it.s} />
            </g>
          );
          case 'blossom': return <BlossomArt key={i} id={id} x={x} y={y} s={it.s} r={it.r} />;
          case 'bud': return <BudArt key={i} x={x} y={y} s={it.s} r={r} />;
        }
      })}
    </svg>
  );
}

/* ------------------------------------------------------ the polish bottle */

/** A pink nail-polish bottle with a heart and a gold cap. `size` is the height. */
export function PolishBottle({ size = 72, className, style, tilt = 12 }: ArtProps & { tilt?: number }) {
  const id = useSvgId('pb');
  return (
    <svg {...hidden} className={cx('brand-art', 'brand-bottle', className)} style={style}
      width={r2(size * 0.8)} height={size} viewBox="0 0 120 150">
      <defs>
        <linearGradient id={`${id}-cap`} x1="0" y1="0" x2="1" y2="0">
          <Stop o={0} c="#8d5f1c" />
          <Stop o={0.14} c="#c99a45" />
          <Stop o={0.3} c="#fbe7a8" />
          <Stop o={0.42} c="#e3b65a" />
          <Stop o={0.68} c="#b88430" />
          <Stop o={0.84} c="#efcd7c" />
          <Stop o={1} c="#94631d" />
        </linearGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="1" y2="0">
          <Stop o={0} c="#ffffff" a={0.92} />
          <Stop o={0.5} c="#ffeef5" a={0.72} />
          <Stop o={1} c="#ffffff" a={0.9} />
        </linearGradient>
        <linearGradient id={`${id}-liq`} x1="0.1" y1="0" x2="0.9" y2="1">
          <Stop o={0} c="#ffc9e0" />
          <Stop o={0.32} c="#ff96c6" />
          <Stop o={0.72} c="#f364a8" />
          <Stop o={1} c="#e23c8e" />
        </linearGradient>
        <radialGradient id={`${id}-sh`}>
          <Stop o={0} c="#a8325f" a={0.28} />
          <Stop o={1} c="#a8325f" a={0} />
        </radialGradient>
      </defs>
      <ellipse cx={64} cy={141} rx={38} ry={6} fill={`url(#${id}-sh)`} />
      <g transform={`rotate(${r2(tilt)} 60 82)`}>
        <rect x={39} y={56} width={42} height={12} rx={3} fill="#f6b8d2" />
        <rect x={22} y={62} width={76} height={78} rx={15} fill={`url(#${id}-glass)`} stroke="#ef9cc0" strokeWidth={1.5} />
        <rect x={28} y={68} width={64} height={58} rx={10} fill={`url(#${id}-liq)`} />
        <path d="M30.5 74C30.5 70.4 32.6 68.8 36 68.8" fill="none" stroke="#fff" strokeOpacity={0.7} strokeWidth={2} strokeLinecap="round" />
        <path d="M60 106.2c-4.3-3.2-8.8-6.6-8.6-11 .1-2.9 2.3-4.8 4.8-4.6 1.7.1 3 1.2 3.8 2.8.8-1.7 2.2-2.9 4.1-2.9 2.6 0 4.6 2.1 4.4 4.8-.3 4.3-4.8 7.6-8.5 10.9Z"
          fill="#fff" fillOpacity={0.88} />
        <rect x={27} y={72} width={5} height={52} rx={2.5} fill="#fff" fillOpacity={0.5} />
        <rect x={88.5} y={76} width={2.4} height={40} rx={1.2} fill="#fff" fillOpacity={0.55} />
        <path d="M30 131.5h60" stroke="#f7c6da" strokeWidth={1.2} strokeLinecap="round" />
        <rect x={42} y={8} width={36} height={54} rx={6} fill={`url(#${id}-cap)`} />
        <rect x={42} y={8} width={36} height={54} rx={6} fill="none" stroke="#7a4f12" strokeOpacity={0.35} strokeWidth={1} />
        <rect x={40} y={54} width={40} height={9} rx={3} fill={`url(#${id}-cap)`} />
        <path d="M46 12.5h28" stroke="#fff5d6" strokeOpacity={0.8} strokeWidth={1.6} strokeLinecap="round" />
        <path d="M50 16v40" stroke="#fffbe8" strokeOpacity={0.55} strokeWidth={2.4} strokeLinecap="round" />
      </g>
    </svg>
  );
}

/* --------------------------------------------------------------- icons */

export type BrandIconName = 'shield-heart' | 'pin' | 'instagram' | 'tiktok' | 'facebook' | 'sparkle' | 'clock' | 'gift';

const ICONS: Record<BrandIconName, ReactNode> = {
  'shield-heart': (
    <>
      <path d="M12 2.9l7.4 2.8v5.5c0 4.6-3 8.3-7.4 10-4.4-1.7-7.4-5.4-7.4-10V5.7Z" />
      <path d="M12 15.7c-2-1.5-3.5-2.8-3.5-4.4 0-1.1.8-1.9 1.8-1.9.7 0 1.4.4 1.7 1.1.3-.7 1-1.1 1.7-1.1 1 0 1.8.8 1.8 1.9 0 1.6-1.5 2.9-3.5 4.4Z" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21.4s-6.6-6.2-6.6-11.5a6.6 6.6 0 0 1 13.2 0c0 5.3-6.6 11.5-6.6 11.5Z" />
      <circle cx="12" cy="9.8" r="2.4" />
    </>
  ),
  instagram: (
    <>
      <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="5" />
      <circle cx="12" cy="12" r="3.9" />
      <circle cx="16.9" cy="7.1" r=".6" fill="currentColor" />
    </>
  ),
  tiktok: (
    <>
      <path d="M13.6 3.6v11.6a3.7 3.7 0 1 1-3.7-3.7" />
      <path d="M13.6 3.6c.4 2.8 2.3 4.6 5 4.9" />
    </>
  ),
  facebook: (
    <>
      <path d="M10.6 20.6V8.4c0-2.5 1.4-4 3.9-4h1.9" />
      <path d="M7.8 11.4h7.2" />
    </>
  ),
  sparkle: (
    <>
      <path d="M11 3.4c.6 4.1 2.6 6.1 6.7 6.7-4.1.6-6.1 2.6-6.7 6.7-.6-4.1-2.6-6.1-6.7-6.7 4.1-.6 6.1-2.6 6.7-6.7Z" />
      <path d="M18.2 15.2c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.4V12l3.1 2" />
    </>
  ),
  gift: (
    <>
      <rect x="3.8" y="8.8" width="16.4" height="4.2" rx="1.2" />
      <path d="M5.4 13v6.4c0 .7.5 1.2 1.2 1.2h10.8c.7 0 1.2-.5 1.2-1.2V13M12 8.8v11.8" />
      <path d="M12 8.8C10.6 6 7.2 4.9 7.2 7.1c0 1.3 2 1.7 4.8 1.7Zm0 0c1.4-2.8 4.8-3.9 4.8-1.7 0 1.3-2 1.7-4.8 1.7Z" />
    </>
  ),
};

/** Pink line icons for badge circles and social links, in currentColor. */
export function BrandIcon({ name, size = 22, className, strokeWidth = 1.8 }: {
  name: BrandIconName; size?: number; className?: string; strokeWidth?: number;
}) {
  return (
    <svg {...hidden} className={cx('brand-icon', className)} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

/* ----------------------------------------------------- the brush swatch */
// An irregular pink paint stroke, dry-brushed at both ends. Three variants,
// picked from the heading text so neighbouring headings don't look stamped.

const BRUSHES = [1, 2, 3].map((seed) => {
  const rand = rng(seed * 97);
  const top: number[][] = [];
  const bottom: number[][] = [];
  const tilt = (x: number) => (x - 200) * -0.012;
  for (let x = 22; x <= 372; x += 14 + rand() * 10) {
    top.push([x, 12 + rand() * 5 + tilt(x)]);
    bottom.push([x, 69 - rand() * 5 + tilt(x)]);
  }
  // the right end tapers to a soft point; the left end is square-ish and rough
  const right = [[384, 20 + tilt(384)], [394, 33 + rand() * 4], [398, 45], [390, 58 + tilt(390)]];
  const left = [[12, 62], [5, 50 + rand() * 4], [9, 38], [3, 28 + rand() * 4], [10, 17]];
  const pts = [...top, ...right, ...bottom.reverse(), ...left];
  // Catmull-Rom through the points, as cubic Béziers
  let d = `M${pt(pts[0][0], pts[0][1])}`;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const p3 = pts[(i + 2) % pts.length];
    d += `C${pt(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)} ${pt(p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)} ${pt(p2[0], p2[1])}`;
  }
  d += 'Z';
  // bristle streaks that trail off each end
  let streaks = '';
  for (let k = 0; k < 7; k++) {
    const y = 16 + k * 7.5 + rand() * 3;
    const w = 1.4 + rand() * 2.2;
    const x0 = -4 + rand() * 12;
    const x1 = 30 + rand() * 40;
    streaks += `M${pt(x0, y)}L${pt(x1, y - w / 2)}L${pt(x1, y + w / 2)}Z`;
    const xr0 = 330 + rand() * 40;
    const xr1 = 392 + rand() * 8;
    const yr = 22 + k * 5.6 + rand() * 2 + tilt(xr1);
    streaks += `M${pt(xr0, yr - w / 2)}L${pt(xr1, yr)}L${pt(xr0, yr + w / 2)}Z`;
  }
  // lighter dry lines through the body
  let dry = '';
  for (let k = 0; k < 6; k++) {
    const y = 18 + rand() * 46;
    const x0 = 20 + rand() * 120;
    const x1 = x0 + 90 + rand() * 180;
    dry += `M${pt(x0, y)}L${pt(Math.min(x1, 376), y + tilt(x1) - tilt(x0))}`;
  }
  return { d, streaks, dry };
});

function hashText(node: ReactNode): number {
  const s = typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function Brush({ variant = 0, className }: { variant?: number; className?: string }) {
  const b = BRUSHES[variant % BRUSHES.length];
  return (
    <svg {...hidden} className={cx('brush', className)} viewBox="0 0 400 80" preserveAspectRatio="none">
      <path d={b.d} fill="currentColor" />
      <path d={b.streaks} fill="currentColor" fillOpacity={0.85} />
      <path className="brush-dry" d={b.dry} stroke="#fff" strokeOpacity={0.28} strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
}

/* ---------------------------------------------------- headings and type */

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'div' | 'span';

/**
 * A script heading over a pink brush swatch, with a small heart after it.
 * The accessible name is exactly `children`: the swatch and heart are hidden.
 * Forwards its ref (and tabIndex etc.) so pages can move focus to it.
 */
export const ScriptTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement> & {
  as?: HeadingTag; children: ReactNode; heart?: boolean; brush?: boolean;
}>(function ScriptTitle({ as: Tag = 'h2', children, heart = true, brush = true, className, ...rest }, ref) {
  return (
    <Tag ref={ref as never} className={cx('script-title', className)} {...rest}>
      <span className="script-title-inner">
        {brush && <Brush variant={hashText(children)} />}
        {children}
        {heart && <Heart className="script-title-heart" size={18} />}
      </span>
    </Tag>
  );
});

/** Splits a long name over two balanced lines; short names stay on one. */
function nameLines(name: string): string[] {
  const clean = name.trim().replace(/\s+/g, ' ');
  const words = clean.split(' ');
  if (clean.length <= 17 || words.length < 2) return [clean];
  let best: string[] = [clean];
  let bestMax = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const m = Math.max(a.length, b.length);
    if (m < bestMax) { bestMax = m; best = [a, b]; }
  }
  return best;
}

/**
 * The business name in script with a pink heart. The size scales down with the
 * name's length so it never overflows; names over 17 letters take two lines.
 */
export function Wordmark({ name, size = 'lg', as: Tag = 'span', className, heart = true }: {
  name: string; size?: 'lg' | 'md' | 'sm'; as?: HeadingTag; className?: string; heart?: boolean;
}) {
  const lines = nameLines(name);
  const longest = Math.max(...lines.map((l) => l.length), 6);
  const style = { '--wm-chars': longest } as CSSProperties;
  return (
    <Tag className={cx('wordmark', `wordmark-${size}`, lines.length > 1 && 'wordmark-2', className)} style={style}>
      {lines.map((l, i) => (
        <span key={i} className="wordmark-line">
          {i > 0 && ' '}{l}
          {heart && i === lines.length - 1 && <Heart className="wordmark-heart" size={20} />}
        </span>
      ))}
    </Tag>
  );
}

/** "Gel, BIAB, Nail art" → GEL ♥ BIAB ♥ NAIL ART in spaced capitals. */
export function Strapline({ text, className }: { text?: string | null; className?: string }) {
  const parts = (text ?? '').split(/[,·|/♡♥\n]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  return (
    <p className={cx('strapline', className)}>
      {parts.map((p, i) => (
        <span key={i} className="strapline-item">
          {i > 0 && <Heart className="strapline-heart" size={10} />}
          <span className="strapline-word">{p}{i < parts.length - 1 && <span className="brand-sr">, </span>}</span>
        </span>
      ))}
    </p>
  );
}

/* ------------------------------------------------------------- the hero */

/**
 * The booking-page header: sprigs in the top corners, the name in script, the
 * strapline, a handwritten pink tagline, then the intro and location. It bleeds
 * into the page gutter (set --brand-gutter if the page's side padding isn't 16px).
 */
export function BrandHero({
  name, tagline, strapline, intro, location, compact = false, children, className, nameAs = 'h1',
}: {
  name: string; tagline?: string | null; strapline?: string | null; intro?: ReactNode; location?: ReactNode;
  compact?: boolean; children?: ReactNode; className?: string; nameAs?: 'h1' | 'h2' | 'p';
}) {
  return (
    <header className={cx('brand-hero', compact && 'brand-hero--compact', className)}>
      <Sprig corner="tl" size={compact ? 96 : 150} className="brand-hero-sprig" />
      <Sprig corner="tr" size={compact ? 96 : 150} className="brand-hero-sprig" />
      <Heart className="brand-hero-dot brand-hero-dot--a" size={13} />
      <Heart className="brand-hero-dot brand-hero-dot--b" size={11} />
      <div className="brand-hero-body">
        <Wordmark name={name} as={nameAs} size={compact ? 'md' : 'lg'} className="brand-hero-name" />
        <Strapline text={strapline} />
        {tagline && (
          <p className="brand-hero-tagline">
            {tagline}<Heart className="brand-hero-tagline-heart" size={18} />
          </p>
        )}
        {intro && <p className="brand-hero-intro">{intro}</p>}
        {location && (
          <p className="brand-hero-location">
            <BrandIcon name="pin" size={18} className="brand-hero-pin" />
            <span>{location}</span>
          </p>
        )}
        {children}
      </div>
    </header>
  );
}

/* ---------------------------------------------------------- badge card */

/** A card with an icon in a pink ring, a script title and a short text. */
export function Badge({ icon, title, children, className, titleAs = 'h3' }: {
  icon: BrandIconName; title: ReactNode; children?: ReactNode; className?: string; titleAs?: HeadingTag;
}) {
  const T = titleAs;
  return (
    <div className={cx('brand-badge', className)}>
      <span className="brand-badge-ring"><BrandIcon name={icon} size={26} /></span>
      <div className="brand-badge-body">
        <T className="brand-badge-title">{title}</T>
        {children && <div className="brand-badge-text">{children}</div>}
      </div>
      <Heart className="brand-badge-heart" size={14} />
    </div>
  );
}

/* ------------------------------------------------------------- socials */

const SOCIAL = {
  instagram: { label: 'Instagram', url: (h: string) => `https://www.instagram.com/${h}/` },
  tiktok: { label: 'TikTok', url: (h: string) => `https://www.tiktok.com/@${h}` },
  facebook: { label: 'Facebook', url: (h: string) => `https://www.facebook.com/${h}` },
} as const;
type Handle = string | null | undefined;

/**
 * Pink circle links with the "@handle"; renders nothing when no handle is set.
 * When every network shares one handle it is written once, after the icons.
 */
export function Socials({ instagram, tiktok, facebook, className }: {
  instagram?: Handle; tiktok?: Handle; facebook?: Handle; className?: string;
}) {
  const clean = (h: Handle) => (h ?? '').trim().replace(/^@/, '');
  const links = (Object.keys(SOCIAL) as (keyof typeof SOCIAL)[])
    .map((k) => ({ k, h: clean({ instagram, tiktok, facebook }[k]) }))
    .filter((l) => l.h);
  if (!links.length) return null;
  const shared = links.every((l) => l.h.toLowerCase() === links[0].h.toLowerCase());
  return (
    <div className={cx('brand-socials', className)}>
      <ul className={cx('brand-socials-list', !shared && 'brand-socials-list--stacked')}>
        {links.map(({ k, h }) => (
          <li key={k}>
            <a className="brand-social" href={SOCIAL[k].url(encodeURIComponent(h))} target="_blank" rel="noopener noreferrer"
              aria-label={`${SOCIAL[k].label} @${h}`}>
              <span className="brand-social-icon"><BrandIcon name={k} size={22} strokeWidth={2} /></span>
              {!shared && <span className="brand-social-handle">@{h}</span>}
            </a>
          </li>
        ))}
      </ul>
      {shared && <span className="brand-social-handle brand-socials-shared" aria-hidden="true">@{links[0].h}</span>}
    </div>
  );
}

/* -------------------------------------------------------------- footer */

/** Socials, a handwritten thank-you, and lemon slices in the bottom corners. */
export function BrandFooter({
  instagram, tiktok, facebook, note = 'Thank you for supporting a small business', className, children,
}: {
  instagram?: Handle; tiktok?: Handle; facebook?: Handle; note?: ReactNode; className?: string; children?: ReactNode;
}) {
  return (
    <footer className={cx('brand-footer', className)}>
      <Sprig corner="bl" variant="slice" size={150} className="brand-footer-sprig" />
      <Sprig corner="br" variant="slice" size={150} className="brand-footer-sprig" />
      <div className="brand-footer-body">
        <Socials instagram={instagram} tiktok={tiktok} facebook={facebook} />
        {note && (
          <p className="brand-footer-note">
            {note}<Heart className="brand-footer-heart" size={18} />
          </p>
        )}
        <svg {...hidden} className="brand-footer-swash" viewBox="0 0 160 14" width="150" height="13">
          <path d="M4 10.5C40 3.5 92 2.2 156 6.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
        </svg>
        {children}
      </div>
    </footer>
  );
}
