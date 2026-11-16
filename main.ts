// Ember Phoenix — a deterministic procedural painting (Node 22, standard library only).
// A colossal phoenix of molten-gold and crimson feather filaments dives through an ember
// storm above a black volcanic coastline at dusk. Every pixel is computed in code from a
// fixed seed: value-noise fBm sky, SDF/bezier-ribbon feathers, lava-vein contours, bloom.
// Run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, constants } from 'node:zlib';

const W = 1024, H = 1024, N = W * H;

// ---------- deterministic PRNG + value noise ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xE9BE2026);

function hash2(ix, iy) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + 0x9E3779B9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, oct) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f, y * f);
    norm += amp; amp *= 0.52; f *= 2.03;
    const nx = x * 0.8 - y * 0.6, ny = x * 0.6 + y * 0.8; x = nx; y = ny;
  }
  return v / norm;
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- float RGB canvas ----------
const buf = new Float32Array(N * 3);
function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
}
function blendPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 3, ia = 1 - a;
  buf[i] = buf[i] * ia + r * a; buf[i + 1] = buf[i + 1] * ia + g * a; buf[i + 2] = buf[i + 2] * ia + b * a;
}
function addPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3; buf[i] += r; buf[i + 1] += g; buf[i + 2] += b;
}
function splat(cx, cy, rad, r, g, b, strength) {
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x - cx, dy = y - cy, d2 = (dx * dx + dy * dy) / (rad * rad);
    if (d2 > 1) continue;
    const f = Math.exp(-d2 * 3.2) * strength;
    addPx(x, y, r * f, g * f, b * f);
  }
}

// ---------- sky, halo, coastline (one full-screen pass) ----------
function coastRidge(x) {
  let r = 856 + 52 * (fbm(x * 0.004 + 13.7, 3.1, 3) - 0.5) * 2 + 18 * Math.sin(x * 0.011 + 1.7);
  r -= 74 * Math.exp(-Math.pow((x - 108) / 120, 2));       // lighthouse promontory
  r -= 30 * Math.exp(-Math.pow((x - 905) / 170, 2));       // eastern headland
  return r;
}
const glowCenters = [[268, 208, 210], [782, 150, 170], [620, 300, 130]];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const v = y / H;
    // plum -> burgundy gradient
    let r, g, b;
    if (v < 0.55) { const t = v / 0.55; r = lerp(0.068, 0.20, t); g = lerp(0.026, 0.055, t); b = lerp(0.135, 0.145, t); }
    else { const t = (v - 0.55) / 0.45; r = lerp(0.20, 0.335, t); g = lerp(0.055, 0.085, t); b = lerp(0.145, 0.115, t); }
    // storm clouds, domain warped
    const warp = fbm(x * 0.0016 + 4.2, y * 0.0016, 2);
    const cl = fbm(x * 0.0034 + warp * 4.5, y * 0.0052 + warp * 2.0, 4);
    const dens = sstep(0.36, 0.78, cl);
    const lit = sstep(0.45, 0.95, cl);
    r = lerp(r, 0.115 + lit * 0.30, dens * 0.88);
    g = lerp(g, 0.038 + lit * 0.115, dens * 0.88);
    b = lerp(b, 0.135 + lit * 0.10, dens * 0.88);
    // amber lightning-glow pockets inside the clouds
    const pocket = sstep(0.60, 0.86, fbm(x * 0.0021 + 9.7, y * 0.0021 + 3.1, 3));
    const pa = pocket * (0.25 + 0.75 * dens) * 0.55;
    r += 1.00 * pa; g += 0.46 * pa; b += 0.10 * pa;
    for (const [gx, gy, gr] of glowCenters) {
      const dx = x - gx, dy = y - gy, d = Math.sqrt(dx * dx + dy * dy) / gr;
      if (d < 1.6) { const f = Math.exp(-d * d * 2.4) * (0.35 + 0.65 * cl) * 0.5; r += 1.0 * f; g += 0.44 * f; b += 0.08 * f; }
    }
    // great halo behind the phoenix
    const hx = x - 512, hy = y - 452, hd = Math.sqrt(hx * hx + hy * hy);
    const halo = Math.exp(-Math.pow(hd / 380, 2)) * 0.30;
    r += 1.0 * halo; g += 0.47 * halo; b += 0.10 * halo;
    const core = Math.exp(-Math.pow(hd / 190, 2)) * 0.22;
    r += 1.0 * core; g += 0.60 * core; b += 0.18 * core;
    // horizon ember band
    const hb = Math.exp(-Math.pow((y - 838) / 60, 2)) * 0.10;
    r += hb; g += hb * 0.4;
    // coastline
    const ridge = coastRidge(x);
    if (y > ridge) {
      const depth = clamp((y - ridge) / 150, 0, 1);
      const tex = fbm(x * 0.012, y * 0.012, 3);
      r = 0.020 + tex * 0.030 * (1 - depth * 0.6);
      g = 0.014 + tex * 0.020 * (1 - depth * 0.6);
      b = 0.022 + tex * 0.026 * (1 - depth * 0.6);
      // rim of hot rock just under the skyline
      const rim = Math.exp(-(y - ridge) / 7) * 0.20;
      r += rim * 0.9; g += rim * 0.32; b += rim * 0.04;
      // lava veins: thin bright cracks on a noise contour
      const n = fbm(x * 0.0058 + 31.4, y * 0.0058 + 7.9, 4);
      const d = Math.abs(n - 0.52);
      const veinMask = (0.35 + 0.65 * sstep(120, 10, y - ridge)) * (0.55 + 0.45 * fbm(x * 0.02, y * 0.02, 2));
      const vein = sstep(0.016, 0.003, d) * veinMask;
      const vglow = sstep(0.07, 0.015, d) * veinMask * 0.22;
      r += (1.00 * vein * 1.5 + 0.95 * vglow); g += (0.33 * vein * 1.5 + 0.26 * vglow); b += (0.05 * vein + 0.03 * vglow);
    }
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  }
}

// ---------- polygon fill helper ----------
function fillPoly(pts, fn) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [px, py] of pts) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
  minX = Math.max(0, Math.floor(minX)); maxX = Math.min(W - 1, Math.ceil(maxX));
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    let inside = false;
    for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    if (inside) fn(x, y);
  }
}
const quadPt = (p0, p1, p2, t) => {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
};

// ---------- ribbons: feathers, streamers, crest ----------
function drawRibbon(p0, p1, p2, w0, opt) {
  const steps = Math.max(10, Math.floor(opt.len / 1.6));
  let prev = quadPt(p0, p1, p2, 0);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const pt = quadPt(p0, p1, p2, t);
    const dx = pt[0] - prev[0], dy = pt[1] - prev[1];
    const dl = Math.hypot(dx, dy) || 1;
    const nx = -dy / dl, ny = dx / dl;
    const hw = w0 * 0.5 * Math.pow(1 - t, opt.taper) * Math.min(1, t * 7 + 0.30) + 0.4;
    const along = t * opt.len;
    const breakup = opt.breakup ? (0.55 + 0.75 * fbm(along * 0.03 + opt.seed * 9.1, opt.seed * 3.7, 3)) : 1;
    for (let k = -Math.ceil(hw); k <= Math.ceil(hw); k++) {
      const u = clamp(k / hw, -1, 1);
      const core = 1 - Math.abs(u);
      const px = Math.round(pt[0] + nx * k), py = Math.round(pt[1] + ny * k);
      // barb streaks + length shading
      const barb = 0.93 + 0.07 * Math.sin(along * 0.8 + Math.abs(u) * 8 + opt.seed * 40);
      const tipFade = 1 - sstep(0.72, 1, t) * 0.45;
      let cr = lerp(opt.edge[0], opt.core[0], Math.pow(core, 1.4)) * barb * tipFade;
      let cg = lerp(opt.edge[1], opt.core[1], Math.pow(core, 1.4)) * barb * tipFade;
      let cb = lerp(opt.edge[2], opt.core[2], Math.pow(core, 1.4)) * barb * tipFade;
      if (opt.hot) { const h = Math.pow(core, 3) * (1 - t * 0.55); cr += 0.55 * h; cg += 0.42 * h; cb += 0.22 * h; }
      blendPx(px, py, cr, cg, cb, opt.alpha * breakup);
      blendPx(px, py + 1, cr, cg, cb, opt.alpha * breakup * 0.5);
    }
    prev = pt;
  }
  // glowing shaft down the centre
  if (opt.shaft) {
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, pt = quadPt(p0, p1, p2, t);
      addPx(Math.round(pt[0]), Math.round(pt[1]), 0.34 * (1 - t), 0.20 * (1 - t), 0.05 * (1 - t));
    }
  }
}
function strokeGlow(p0, p1, p2, r, g, b, strength, rad) {
  const steps = 90;
  for (let s = 0; s <= steps; s++) {
    const pt = quadPt(p0, p1, p2, s / steps);
    splat(pt[0], pt[1], rad, r, g, b, strength * 0.16);
  }
}

const GOLD = [1.05, 0.72, 0.22], HOT = [1.15, 0.88, 0.45];
const CRIM = [0.58, 0.07, 0.09], DEEP = [0.34, 0.045, 0.10];

// ---------- wings ----------
function drawWing(side) { // side: +1 right, -1 left (mirrored x)
  const mx = (x) => side > 0 ? x : W - x;
  // dark under-wing silhouette
  const lead = [], trail = [];
  for (let s = 0; s <= 14; s++) lead.push(quadPt([512, 432], [712, 318], [930, 600], s / 14));
  for (let s = 0; s <= 10; s++) trail.push(quadPt([930, 600], [760, 672], [520, 548], s / 10));
  const poly = [...lead, ...trail].map(([x, y]) => [mx(x), y]);
  fillPoly(poly, (x, y) => {
    const t = fbm(x * 0.01, y * 0.01, 3);
    blendPx(x, y, 0.145 + t * 0.05, 0.028, 0.045, 0.92);
  });
  // flight feathers: bases along a curve, fanning down-out
  const base0 = [502, 468], base1 = [728, 424], base2 = [944, 616];
  const NF = 17;
  for (let fi = NF - 1; fi >= 0; fi--) {
    const t = fi / (NF - 1);
    const bp = quadPt(base0, base1, base2, t);
    const ang = lerp(1.44, 0.46, t); // 82deg (down) near body -> 26deg at tip
    const len = 172 + 150 * t - 42 * t * t;
    const dirx = Math.cos(ang) * side, diry = Math.sin(ang);
    const ex = bp[0] + dirx * len, ey = bp[1] + diry * len;
    const cxp = bp[0] + dirx * len * 0.5 - side * len * 0.10, cyp = bp[1] + diry * len * 0.5 + len * 0.13;
    const jit = (hash2(fi * 7 + (side > 0 ? 3 : 131), 5) - 0.5) * 0.16;
    drawRibbon([mx(bp[0]), bp[1]], [mx(cxp), cyp], [mx(ex), ey], 30 - 5 * t, {
      len, taper: 0.38, alpha: 0.97, seed: fi * 1.37 + (side > 0 ? 0 : 50), shaft: true, hot: true,
      core: [GOLD[0] + jit, GOLD[1] + jit * 0.5, GOLD[2]], edge: t > 0.55 ? CRIM : DEEP,
    });
  }
  // covert rows: shorter, brighter shingles toward the leading edge
  for (let row = 0; row < 3; row++) {
    const off = row * 27;
    const NC = 11;
    for (let ci = NC - 1; ci >= 0; ci--) {
      const t = ci / (NC - 1) * 0.92;
      const bp = quadPt(base0, base1, base2, t);
      const ang = lerp(1.40, 0.52, t);
      const len = 100 - row * 24 + 26 * t;
      const dirx = Math.cos(ang) * side, diry = Math.sin(ang);
      const bx = bp[0], by = bp[1] - off - 6;
      const ex = bx + dirx * len, ey = by + diry * len;
      drawRibbon([mx(bx), by], [mx(bx + dirx * len * 0.5), by + diry * len * 0.5 + len * 0.10], [mx(ex), ey], 27 - row * 3, {
        len, taper: 0.5, alpha: 0.97, seed: 100 + row * 23 + ci * 1.71 + (side > 0 ? 0 : 77), shaft: false, hot: row === 2,
        core: [HOT[0], HOT[1] - row * 0.06, HOT[2]], edge: CRIM,
      });
    }
  }
  // molten rim light along the leading edge
  strokeGlow([mx(512), 432], [mx(712), 318], [mx(958), 618], 1.0, 0.55, 0.12, 0.85, 13);
}

// embers behind the bird
for (let i = 0; i < 260; i++) {
  const x = rng() * W, y = 120 + rng() * 800, r = 0.8 + rng() * 2.4, b = 0.3 + rng() * 0.9;
  splat(x, y, r * 3, 1.0 * b, 0.5 * b, 0.10 * b, 0.5);
}

drawWing(1); drawWing(-1);

// ---------- tail streamers ----------
for (let sIdx = 0; sIdx < 5; sIdx++) {
  const spread = (sIdx - 2) / 2; // -1..1
  const bx = 512 + spread * 22, by = 552;
  const len = 200 - Math.abs(spread) * 24 + (hash2(sIdx, 9) - 0.5) * 22;
  const ex = 512 + spread * 150, ey = by + len;
  const cxp = bx + spread * 55 + Math.sin(sIdx * 3.7) * 20, cyp = by + len * 0.52;
  // wide faint glow pass, then a solid textured core
  drawRibbon([bx, by], [cxp, cyp], [ex, ey], 60, { len, taper: 0.9, alpha: 0.22, seed: 300 + sIdx * 3.1, shaft: false, hot: false, core: GOLD, edge: CRIM, breakup: true });
  drawRibbon([bx, by], [cxp, cyp], [ex, ey], 32 - Math.abs(spread) * 5, { len, taper: 0.5, alpha: 0.92, seed: 300 + sIdx * 3.1, shaft: true, hot: true, core: HOT, edge: [0.72, 0.12, 0.05], breakup: true });
  splat(ex, ey, 17, 1.0, 0.52, 0.10, 0.16); // flame lick at the tip
}
// short flame tongues between the streamers
for (let sIdx = 0; sIdx < 3; sIdx++) {
  const spread = (sIdx - 1) * 0.55;
  const bx = 512 + spread * 20, by = 552;
  const len = 128 + (hash2(sIdx, 21) - 0.5) * 22;
  drawRibbon([bx, by], [bx + spread * 34, by + len * 0.5], [512 + spread * 74, by + len], 17, {
    len, taper: 0.55, alpha: 0.9, seed: 340 + sIdx * 2.9, shaft: true, hot: true, core: HOT, edge: [0.78, 0.14, 0.04], breakup: true,
  });
}

// ---------- body, neck, head (SDF composite) ----------
function bodySDF(x, y) {
  const ell = (cx, cy, rx, ry) => { const dx = (x - cx) / rx, dy = (y - cy) / ry; return Math.sqrt(dx * dx + dy * dy) - 1; };
  return Math.min(ell(512, 472, 60, 98), ell(512, 388, 33, 62), ell(512, 330, 31, 29));
}
for (let y = 268; y <= 586; y++) for (let x = 428; x <= 596; x++) {
  const d = bodySDF(x, y);
  if (d > 0.06) continue;
  const edge = sstep(0.02, -0.5, d);
  const tex = fbm(x * 0.03, y * 0.03, 3);
  const scallop = 0.86 + 0.20 * Math.sin(y * 0.42 + Math.sin(x * 0.11) * 2.2) * Math.sin(x * 0.16);
  let r = lerp(0.52, 1.08, edge) * scallop, g = lerp(0.07, 0.66, edge) * scallop, b = lerp(0.08, 0.20, edge) * scallop;
  r *= 0.9 + tex * 0.25; g *= 0.9 + tex * 0.25; b *= 0.9 + tex * 0.25;
  const a = sstep(0.06, -0.02, d);
  blendPx(x, y, r, g, b, a);
  if (d > -0.10 && d < 0.03) addPx(x, y, 0.30, 0.15, 0.02); // rim light
}
// chest shingles: small bright petals down the breast
for (let row = 0; row < 6; row++) {
  const cy = 428 + row * 24, half = 4 - Math.abs(row - 2.4) * 0.9;
  for (let k = -3; k <= 3; k++) {
    if (Math.abs(k) > half) continue;
    const bx = 512 + k * 15 + (row % 2) * 7;
    drawRibbon([bx, cy], [bx + 1, cy + 13], [bx + 2, cy + 27], 13, {
      len: 27, taper: 0.6, alpha: 0.9, seed: 500 + row * 13 + k, shaft: false, hot: true, core: HOT, edge: CRIM,
    });
  }
}
// crest: flame filaments sweeping back from the head
for (let ci = 0; ci < 7; ci++) {
  const a = -Math.PI / 2 + (ci - 3) * 0.30;
  const len = 118 - Math.abs(ci - 3) * 13;
  const bx = 512 + Math.cos(a) * 16, by = 322 + Math.sin(a) * 10;
  const ex = 512 + Math.cos(a) * len * 0.95 + (ci - 3) * 9, ey = 322 - len * 0.72 + Math.abs(ci - 3) * 10;
  drawRibbon([bx, by], [512 + Math.cos(a) * len * 0.55, 322 - len * 0.5], [ex, ey], 9.5 - Math.abs(ci - 3), {
    len, taper: 0.8, alpha: 0.95, seed: 700 + ci * 2.3, shaft: true, hot: true, core: HOT, edge: [0.80, 0.16, 0.04], breakup: true,
  });
}
// beak: sharp hooked wedge, horn-gold over a dark tip (diving)
fillPoly([[498, 346], [526, 346], [512, 376], [506, 362]], (x, y) => blendPx(x, y, 0.62, 0.33, 0.07, 0.98));
fillPoly([[506, 362], [512, 376], [509, 364]], (x, y) => blendPx(x, y, 0.14, 0.06, 0.03, 0.98));
// fierce eyes with angled angry brows
for (const ex of [495, 529]) {
  const inw = ex < 512 ? 1 : -1;
  for (let s = 0; s <= 12; s++) {
    const bx = ex - inw * 8 + inw * s, by = 314 + s * 0.55;
    for (let wdt = 0; wdt < 3; wdt++) blendPx(Math.round(bx), Math.round(by) + wdt, 0.13, 0.03, 0.03, 0.85);
  }
  splat(ex, 326, 10, 1.0, 0.60, 0.13, 0.9);
  setPx(ex, 326, 1.35, 1.18, 0.82); setPx(ex + 1, 326, 1.25, 1.02, 0.60); setPx(ex, 327, 1.25, 1.02, 0.60);
  setPx(ex, 325, 0.04, 0.02, 0.02);
}
// head glow
splat(512, 330, 60, 1.0, 0.55, 0.12, 0.20);

// ---------- lighthouse + pale beam (lower-left corner) ----------
{
  const lx = 108, topY = 706, baseY = 806;
  const beamPts = [[lx + 6, topY + 8], [lx + 330, topY - 66], [lx + 330, topY + 26]];
  fillPoly(beamPts, (x, y) => {
    const t = clamp((x - lx) / 330, 0, 1);
    const a = 0.085 * (1 - t) * (0.7 + 0.3 * fbm(x * 0.02, y * 0.02, 2));
    addPx(x, y, 0.95 * a * 3, 0.90 * a * 3, 0.78 * a * 3);
  });
  for (let y = topY; y <= baseY; y++) {
    const t = (y - topY) / (baseY - topY);
    const hw = lerp(8, 14, t);
    for (let x = Math.floor(lx - hw); x <= lx + hw; x++) {
      const stripe = Math.sin(y * 0.11) > 0.25;
      blendPx(x, y, stripe ? 0.30 : 0.05, stripe ? 0.24 : 0.035, stripe ? 0.20 : 0.045, 0.98);
    }
  }
  for (let y = topY - 12; y <= topY; y++) for (let x = lx - 10; x <= lx + 10; x++) blendPx(x, y, 0.06, 0.04, 0.05, 0.98);
  splat(lx, topY - 16, 26, 1.0, 0.93, 0.75, 0.85);
  splat(lx, topY - 16, 7, 1.2, 1.1, 0.9, 1.2);
}

// ---------- foreground embers with trails ----------
for (let i = 0; i < 520; i++) {
  const x = rng() * W, y = rng() * H;
  const nearBird = Math.exp(-Math.pow(Math.hypot(x - 512, y - 452) / 520, 2));
  if (rng() > 0.35 + nearBird * 0.65 && y < 700) continue;
  const r = 0.7 + Math.pow(rng(), 2) * 3.4, b = 0.35 + rng() * 1.15;
  if (rng() < 0.34) { // short rising trail
    const tl = 5 + rng() * 15, sl = (rng() - 0.5) * 6;
    for (let s = 0; s < tl; s++) {
      const f = (1 - s / tl) * 0.35 * b;
      addPx(Math.round(x + sl * (s / tl)), Math.round(y + s * 1.4), 1.0 * f, 0.48 * f, 0.08 * f);
    }
  }
  splat(x, y, r * 3.2, 1.0 * b, 0.52 * b, 0.10 * b, 0.75);
  if (r > 1.6) setPx(Math.round(x), Math.round(y), 1.25, 1.05, 0.62);
}
for (let i = 0; i < 16; i++) splat(rng() * W, 300 + rng() * 650, 10 + rng() * 15, 1.0, 0.45, 0.08, 0.05 + rng() * 0.05);

// ---------- bloom: threshold, downscale, blur, add back ----------
function downscale(src, sw, factor) {
  const dw = sw / factor, dh = sw / factor, out = new Float32Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const i = ((y * factor + dy) * sw + x * factor + dx) * 3;
      r += Math.max(0, src[i] - 0.52); g += Math.max(0, src[i + 1] - 0.52); b += Math.max(0, src[i + 2] - 0.52);
    }
    const o = (y * dw + x) * 3, s = 1 / (factor * factor);
    out[o] = r * s; out[o + 1] = g * s; out[o + 2] = b * s;
  }
  return [out, dw];
}
function blurPass(src, w, rad) {
  const out = new Float32Array(src.length), tmp = new Float32Array(src.length);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, cnt = 0;
    for (let k = -rad; k <= rad; k++) { const xx = clamp(x + k, 0, w - 1), i = (y * w + xx) * 3; r += src[i]; g += src[i + 1]; b += src[i + 2]; cnt++; }
    const o = (y * w + x) * 3; tmp[o] = r / cnt; tmp[o + 1] = g / cnt; tmp[o + 2] = b / cnt;
  }
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, cnt = 0;
    for (let k = -rad; k <= rad; k++) { const yy = clamp(y + k, 0, w - 1), i = (yy * w + x) * 3; r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; cnt++; }
    const o = (y * w + x) * 3; out[o] = r / cnt; out[o + 1] = g / cnt; out[o + 2] = b / cnt;
  }
  return out;
}
function addBloom(factor, rad, passes, strength) {
  let [small, dw] = downscale(buf, W, factor);
  for (let p = 0; p < passes; p++) small = blurPass(small, dw, rad);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = x / factor, fy = y / factor;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const x1 = Math.min(dw - 1, x0 + 1), y1 = Math.min(dw - 1, y0 + 1);
    const i = (y * W + x) * 3;
    for (let c = 0; c < 3; c++) {
      const v = lerp(
        lerp(small[(y0 * dw + x0) * 3 + c], small[(y0 * dw + x1) * 3 + c], tx),
        lerp(small[(y1 * dw + x0) * 3 + c], small[(y1 * dw + x1) * 3 + c], tx), ty);
      buf[i + c] += v * strength;
    }
  }
}
addBloom(4, 3, 2, 0.85);
addBloom(16, 3, 2, 0.65);

// ---------- tonemap, vignette, grain, dither ----------
const out8 = new Uint8Array(N * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 3;
  const dx = (x - 512) / 620, dy = (y - 500) / 620;
  const vig = 1 - 0.46 * sstep(0.45, 1.25, Math.sqrt(dx * dx + dy * dy)) * (0.94 + 0.10 * fbm(x * 0.008, y * 0.008, 2));
  const grain = (hash2(x * 3 + 11, y * 3 + 7) - 0.5) * 0.0007;
  for (let c = 0; c < 3; c++) {
    let v = buf[i + c];
    v = 1 - Math.exp(-v * 1.22);            // soft filmic shoulder
    v = Math.pow(v, 0.94);
    v *= vig;
    v += grain + (hash2(x + c * 977, y + c * 331) - 0.5) * (0.28 / 255); // whisper-light dither against banding
    out8[i + c] = Math.round(clamp(v, 0, 1) * 255);
  }
}

// ---------- PNG encoder (CRC32 + adaptive per-row filters) ----------
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const stride = W * 3;
const filtered = Buffer.alloc(H * (stride + 1));
for (let y = 0; y < H; y++) {
  const rowOff = y * stride, outOff = y * (stride + 1);
  let bestType = 0, bestScore = Infinity, bestRow = null;
  for (let type = 0; type <= 4; type++) {
    const cand = Buffer.alloc(stride);
    let score = 0;
    for (let j = 0; j < stride; j++) {
      const a = j >= 3 ? out8[rowOff + j - 3] : 0;
      const b = y > 0 ? out8[rowOff - stride + j] : 0;
      const c = j >= 3 && y > 0 ? out8[rowOff - stride + j - 3] : 0;
      let pred = 0;
      if (type === 1) pred = a; else if (type === 2) pred = b; else if (type === 3) pred = (a + b) >> 1;
      else if (type === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      const v = (out8[rowOff + j] - pred) & 0xFF;
      cand[j] = v; score += v < 128 ? v : 256 - v;
    }
    if (score < bestScore) { bestScore = score; bestType = type; bestRow = cand; }
  }
  filtered[outOff] = bestType;
  bestRow.copy(filtered, outOff + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(filtered, { level: 9, strategy: constants.Z_FILTERED })),
  chunk('IEND', Buffer.alloc(0)),
]);
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
console.log(`entry.png ${W}x${H} ${png.length} bytes`);
