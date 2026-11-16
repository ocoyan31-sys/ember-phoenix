// Ember Phoenix — cinematic rewrite.
// A colossal phoenix of molten gold over a black volcanic coastline at dusk,
// rendered to read as a dramatic photographic still rather than an illustration.
//
// Pipeline (all new):
//   1. Paint at 2048x2048 into a Float32 buffer, box-downscale to 1024x1024
//      (2x supersampling -> anti-aliased edges everywhere).
//   2. One light logic: the phoenix is the key light. A precomputed cloud
//      density grid (domain-warped fBm, 6 octaves) is lit by a density->light
//      approximation: thin cloud toward the bird glows amber, thick cores fall
//      to dark plum, density-gradient rims catch warm light. The same key
//      light shades a rock heightfield (lava lives only in crevices) and
//      drives distance-attenuated embers and haze.
//   3. Feathers are soft ribbons: smoothstep cross-section falloff (no hard
//      edge anywhere), anisotropic barb-streak noise sampled in feather-local
//      coordinates so the grain runs along each feather.
//   4. Finish: two-scale bloom, ACES filmic tonemap, gentle vignette, a whisper
//      of film grain and ordered Bayer 8x8 dithering to kill banding.
// Deterministic: fixed seed, byte-identical output. Node 22 stdlib only.
// Run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, constants } from 'node:zlib';

const SS = 2048;            // supersampled paint size
const W = 1024, H = 1024;   // final size
const K = SS / W;           // scale factor (2)

// ---------------------------------------------------------------- utilities
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

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

// value noise on an integer lattice (hash-based, allocation-free)
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

// ------------------------------------------------- coarse field grids
// Big smooth fields (cloud density, rock height) are precomputed once into
// typed arrays and bilinearly sampled per pixel: full fBm quality at a
// fraction of the per-pixel cost, and gradients come almost free.
function makeGrid(gw, gh, fn) {
  const g = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) g[y * gw + x] = fn(x / (gw - 1), y / (gh - 1));
  return { g, gw, gh };
}
function sampleGrid(gr, u, v) {
  const x = clamp(u, 0, 1) * (gr.gw - 1), y = clamp(v, 0, 1) * (gr.gh - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(gr.gw - 1, x0 + 1), y1 = Math.min(gr.gh - 1, y0 + 1);
  const tx = x - x0, ty = y - y0, g = gr.g, gw = gr.gw;
  return lerp(lerp(g[y0 * gw + x0], g[y0 * gw + x1], tx), lerp(g[y1 * gw + x0], g[y1 * gw + x1], tx), ty);
}

// Cloud density: domain-warped fBm. Two warp fields + 6-octave density.
const cloudGrid = makeGrid(384, 384, (u, v) => {
  const wx = fbm(u * 2.6 + 4.2, v * 2.6 + 1.3, 3);
  const wy = fbm(u * 2.6 + 9.4, v * 2.6 + 7.7, 3);
  const d = fbm(u * 4.0 + wx * 1.3, v * 5.4 + wy * 0.9, 6);
  return sstep(0.38, 0.90, d);
});
// Rock heightfield for the coastline strip (v=0 at ridge top of strip).
const rockGrid = makeGrid(512, 160, (u, v) => fbm(u * 9.0 + 31.4, v * 5.0 + 7.9, 5));

// ------------------------------------------------- supersampled canvas
const buf = new Float32Array(SS * SS * 3);
function blendSS(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SS || y >= SS || a <= 0) return;
  const i = (y * SS + x) * 3, ia = 1 - a;
  buf[i] = buf[i] * ia + r * a; buf[i + 1] = buf[i + 1] * ia + g * a; buf[i + 2] = buf[i + 2] * ia + b * a;
}
function addSS(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= SS || y >= SS) return;
  const i = (y * SS + x) * 3; buf[i] += r; buf[i + 1] += g; buf[i + 2] += b;
}
function splatSS(cx, cy, rad, r, g, b, strength) {
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(SS - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(SS - 1, Math.ceil(cy + rad));
  const inv = 1 / (rad * rad);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x - cx, dy = y - cy, d2 = (dx * dx + dy * dy) * inv;
    if (d2 > 1) continue;
    const f = Math.exp(-d2 * 3.0) * strength;
    addSS(x, y, r * f, g * f, b * f);
  }
}

// The phoenix is the key light. Design-space centre of the bird:
const KEY = [512, 446];
function keyLight(x, y) { // design coords in, scalar intensity out
  const dx = x - KEY[0], dy = y - KEY[1];
  const d2 = dx * dx + dy * dy;
  return 1.9 / (1 + d2 / (430 * 430)) + 0.55 / (1 + d2 / (150 * 150));
}

// ------------------------------------------------- sky + clouds + coast
function coastRidge(x) { // design coords
  let r = 852 + 104 * (fbm(x * 0.004 + 13.7, 3.1, 3) - 0.5) + 16 * Math.sin(x * 0.011 + 1.7);
  r -= 76 * Math.exp(-Math.pow((x - 108) / 120, 2));
  r -= 30 * Math.exp(-Math.pow((x - 905) / 170, 2));
  return r;
}
const ridgeSS = new Float32Array(SS);
for (let x = 0; x < SS; x++) ridgeSS[x] = coastRidge(x / K) * K;

for (let sy = 0; sy < SS; sy++) {
  const y = sy / K, v = y / H;
  for (let sx = 0; sx < SS; sx++) {
    const x = sx / K, u = x / W;
    const i = (sy * SS + sx) * 3;
    const key = keyLight(x, y);
    let r, g, b;

    if (sy < ridgeSS[sx]) {
      // --- sky gradient: deep plum zenith -> burgundy horizon, wide blends
      const t1 = sstep(0, 0.62, v), t2 = sstep(0.5, 1.0, v);
      r = lerp(lerp(0.040, 0.115, t1), 0.235, t2);
      g = lerp(lerp(0.015, 0.037, t1), 0.068, t2);
      b = lerp(lerp(0.078, 0.102, t1), 0.085, t2);
      // key-light halo in the clear sky itself
      r += 0.52 * key * 0.24; g += 0.235 * key * 0.24; b += 0.05 * key * 0.24;

      // --- clouds: density grid + one fine detail octave per pixel
      const rho0 = sampleGrid(cloudGrid, u, v);
      const det = vnoise(x * 0.045 + 40, y * 0.045) - 0.5;
      const rho = clamp(rho0 + det * 0.05 * rho0, 0, 1);
      if (rho > 0.003) {
        // density gradient -> rim toward the key light (cheap volumetric cue)
        const e = 0.006;
        const gx = sampleGrid(cloudGrid, u + e, v) - sampleGrid(cloudGrid, u - e, v);
        const gy = sampleGrid(cloudGrid, u, v + e) - sampleGrid(cloudGrid, u, v - e);
        let lx = KEY[0] - x, ly = KEY[1] - y;
        const ll = Math.hypot(lx, ly) || 1; lx /= ll; ly /= ll;
        const rim = clamp(-(gx * lx + gy * ly) * 5, 0, 1);
        const thin = 1 - rho;
        // shadowed core (dark plum) -> lit body -> glowing thin edge
        let cr = lerp(0.068, 0.165, rho) + 1.00 * key * thin * thin * 0.26 + 0.85 * rim * key * 0.20;
        let cg = lerp(0.026, 0.058, rho) + 0.44 * key * thin * thin * 0.26 + 0.36 * rim * key * 0.20;
        let cb = lerp(0.082, 0.098, rho) + 0.10 * key * thin * thin * 0.26 + 0.09 * rim * key * 0.20;
        // faint cool ambient on the thickest cores (distant storm tops)
        const amb = sstep(0.75, 1.0, rho) * 0.025;
        cr += amb * 0.7; cg += amb * 0.6; cb += amb;
        const a = sstep(0.03, 0.42, rho);
        r = lerp(r, cr, a); g = lerp(g, cg, a); b = lerp(b, cb, a);
      }
      // ember-lit haze hugging the bird: warm, slightly desaturated to plum
      const haze = Math.exp(-Math.pow(Math.hypot(x - KEY[0], y - KEY[1]) / 330, 2)) * 0.16;
      r += 0.95 * haze; g += 0.42 * haze; b += 0.10 * haze;
    } else {
      // --- volcanic coast: heightfield shading, lava only in crevices
      const depth = clamp((y - ridgeSS[sx] / K) / 170, 0, 1);
      const rv = clamp((y - 838) / 186, 0, 1); // strip coordinate for rock grid
      const hgt = sampleGrid(rockGrid, u, rv);
      const e = 0.004;
      const hx = sampleGrid(rockGrid, u + e, rv) - sampleGrid(rockGrid, u - e, rv);
      const hy = sampleGrid(rockGrid, u, rv + e * 3) - sampleGrid(rockGrid, u, rv - e * 3);
      // light direction from the bird, in heightfield space
      let lx = KEY[0] - x, ly = KEY[1] - y;
      const ll = Math.hypot(lx, ly) || 1; lx /= ll; ly /= ll;
      const shade = clamp(0.55 - (hx * lx + hy * ly) * 6.5, 0.15, 1.25);
      const fine = vnoise(x * 0.11, y * 0.11) * 0.6 + vnoise(x * 0.34 + 9, y * 0.34) * 0.4;
      const base = (0.016 + hgt * 0.045 + fine * 0.012) * shade * (1 - depth * 0.55);
      r = base * 1.15 + key * 0.012; g = base * 0.82 + key * 0.004; b = base * 1.05 + key * 0.002;
      // warm rim where the skyline catches the bird's light
      const rim = Math.exp(-(y - ridgeSS[sx] / K) / 5) * (0.10 + key * 0.10);
      r += rim * 0.95; g += rim * 0.36; b += rim * 0.05;
      // lava: only where the heightfield dips into crevices / contour cracks
      const crack = Math.abs(fbm(x * 0.0058 + 31.4, y * 0.0058 + 7.9, 3) - 0.52);
      const crev = sstep(0.40, 0.30, hgt);
      const veinCore = sstep(0.010, 0.0025, crack) * (0.25 + 0.75 * crev);
      const veinGlow = sstep(0.05, 0.010, crack) * (0.20 + 0.80 * crev);
      const fade = 0.30 + 0.70 * sstep(100, 8, y - ridgeSS[sx] / K);
      r += (1.45 * veinCore + 0.34 * veinGlow) * fade;
      g += (0.44 * veinCore + 0.10 * veinGlow) * fade;
      b += (0.06 * veinCore + 0.02 * veinGlow) * fade;
      // wet-rock shimmer: sparse specular flecks lit by the bird
      const shim = Math.pow(vnoise(x * 0.55 + 3, y * 0.55), 14) * key * sstep(60, 4, y - ridgeSS[sx] / K);
      r += shim * 0.5; g += shim * 0.30; b += shim * 0.10;
    }
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  }
}

// ------------------------------------------------- geometry helpers (design coords)
const quadPt = (p0, p1, p2, t) => {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
};
function fillPolySS(pts, fn) {
  const P = pts.map(([x, y]) => [x * K, y * K]);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [px, py] of P) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
  minX = Math.max(0, Math.floor(minX)); maxX = Math.min(SS - 1, Math.ceil(maxX));
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(SS - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    let inside = false;
    for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
      const [ax, ay] = P[a], [bx, by] = P[b];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    if (inside) fn(x, y);
  }
}

// ------------------------------------------------- soft ribbons (feathers)
// Cross-section: smoothstep falloff to zero at |u|=1.25 -> no hard silhouette.
// Colour: edge -> core by (1-|u|)^1.6, modulated by anisotropic barb streaks
// (noise stretched along the feather) and a soft molten shaft.
function drawRibbon(p0, p1, p2, w0, opt) {
  const steps = Math.max(12, Math.floor(opt.len * K / 1.35));
  let prev = quadPt(p0, p1, p2, 0);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const pt = quadPt(p0, p1, p2, t);
    const dx = (pt[0] - prev[0]) * K, dy = (pt[1] - prev[1]) * K;
    const dl = Math.hypot(dx, dy) || 1;
    const nx = -dy / dl, ny = dx / dl;
    // width profile: full body, gentle taper to a soft point (no pinched base)
    const prof = (0.62 + 0.38 * Math.sin(Math.PI * clamp(0.10 + 0.90 * t, 0, 1) * 0.5 + 0.05)) * Math.pow(1 - t, opt.taper * 0.38);
    const hw = Math.max(0.8, w0 * K * 0.5 * prof);
    const along = t * opt.len;
    const reach = Math.ceil(hw * 1.18);
    const cx = pt[0] * K, cy = pt[1] * K;
    const baseShade = 0.78 + 0.22 * sstep(0, 0.30, t);          // occluded root
    const tipFade = 1 - sstep(0.78, 1, t) * 0.30;
    for (let k = -reach; k <= reach; k++) {
      const u = k / hw;
      const au = Math.abs(u);
      if (au > 1.18) continue;
      const fall = sstep(1.18, 0.82, au);
      if (fall <= 0.004) continue;
      // barb streaks: stretched noise in feather-local space
      const streak = vnoise(along * 0.038 + opt.seed * 61.7, u * 2.6 + opt.seed * 17.3);
      const barb = 0.962 + 0.052 * streak + 0.010 * Math.sin(along * 1.5 + au * 9 + opt.seed * 40);
      const coreW = Math.pow(1 - Math.min(au, 1), 1.6);
      let cr = lerp(opt.edge[0], opt.core[0], coreW) * barb * baseShade * tipFade;
      let cg = lerp(opt.edge[1], opt.core[1], coreW) * barb * baseShade * tipFade;
      let cb = lerp(opt.edge[2], opt.core[2], coreW) * barb * baseShade * tipFade;
      if (opt.hot) { const h = Math.pow(1 - Math.min(au, 1), 3) * (1 - t * 0.5); cr += 0.26 * h; cg += 0.18 * h; cb += 0.08 * h; }
      const a = opt.alpha * fall * (opt.breakup ? (0.62 + 0.55 * fbm(along * 0.03 + opt.seed * 9.1, opt.seed * 3.7, 2)) : 1);
      blendSS(Math.round(cx + nx * k), Math.round(cy + ny * k), cr, cg, cb, clamp(a, 0, 1));
    }
    prev = pt;
  }
  if (opt.shaft) { // soft molten shaft, fading to the tip
    const ssteps = Math.floor(opt.len * K / 2);
    for (let s = 0; s <= ssteps; s++) {
      const t = s / ssteps, pt = quadPt(p0, p1, p2, t);
      splatSS(pt[0] * K, pt[1] * K, 2.2, 0.30 * (1 - t), 0.17 * (1 - t), 0.04 * (1 - t), 0.35);
    }
  }
}
function strokeGlow(p0, p1, p2, r, g, b, strength, rad) {
  const steps = 110;
  for (let s = 0; s <= steps; s++) {
    const pt = quadPt(p0, p1, p2, s / steps);
    splatSS(pt[0] * K, pt[1] * K, rad * K, r, g, b, strength * 0.10);
  }
}

const GOLD = [1.02, 0.68, 0.20], HOT = [1.06, 0.76, 0.34];
const CRIM = [0.60, 0.10, 0.09], DEEP = [0.42, 0.07, 0.10];

// ------------------------------------------------- wings
function drawWing(side) {
  const mx = (x) => side > 0 ? x : W - x;
  // soft dark under-wing: solid core + feathered alpha fringe via noise
  const lead = [], trail = [];
  for (let s = 0; s <= 14; s++) lead.push(quadPt([512, 432], [712, 318], [930, 600], s / 14));
  for (let s = 0; s <= 10; s++) trail.push(quadPt([930, 600], [760, 672], [520, 548], s / 10));
  // shrink the silhouette slightly so feather overhang softens every edge
  const poly = [...lead, ...trail].map(([x, y]) => [mx(512 + (x - 512) * 0.965), 500 + (y - 500) * 0.965]);
  fillPolySS(poly, (x, y) => {
    const t = fbm(x * 0.005, y * 0.005, 3);
    const a = 0.88 * sstep(0.0, 0.10, 1); // base alpha; fringe handled by feathers overhang
    blendSS(x, y, 0.115 + t * 0.05, 0.024 + t * 0.012, 0.040 + t * 0.012, a * (0.85 + 0.15 * t));
  });
  const base0 = [502, 468], base1 = [728, 424], base2 = [944, 616];
  const NF = 17;
  for (let fi = NF - 1; fi >= 0; fi--) {
    const t = fi / (NF - 1);
    const bp = quadPt(base0, base1, base2, t);
    const ang = lerp(1.44, 0.46, t);
    const len = 172 + 150 * t - 42 * t * t;
    const dirx = Math.cos(ang) * side, diry = Math.sin(ang);
    const ex = bp[0] + dirx * len, ey = bp[1] + diry * len;
    const cxp = bp[0] + dirx * len * 0.5 - side * len * 0.10, cyp = bp[1] + diry * len * 0.5 + len * 0.13;
    const jit = (hash2(fi * 7 + (side > 0 ? 3 : 131), 5) - 0.5) * 0.13;
    drawRibbon([mx(bp[0]), bp[1]], [mx(cxp), cyp], [mx(ex), ey], 42 - 6 * t, {
      len, taper: 0.42, alpha: 0.96, seed: fi * 1.37 + (side > 0 ? 0 : 50), shaft: true, hot: true,
      core: [GOLD[0] + jit, GOLD[1] + jit * 0.5, GOLD[2]], edge: t > 0.55 ? CRIM : DEEP,
    });
  }
  for (let row = 0; row < 3; row++) {
    const off = row * 27, NC = 11;
    for (let ci = NC - 1; ci >= 0; ci--) {
      const t = ci / (NC - 1) * 0.92;
      const bp = quadPt(base0, base1, base2, t);
      const ang = lerp(1.40, 0.52, t);
      const len = 122 - row * 26 + 28 * t;
      const dirx = Math.cos(ang) * side, diry = Math.sin(ang);
      const bx = bp[0], by = bp[1] - off - 6;
      const ex = bx + dirx * len, ey = by + diry * len;
      drawRibbon([mx(bx), by], [mx(bx + dirx * len * 0.5), by + diry * len * 0.5 + len * 0.10], [mx(ex), ey], 36 - row * 3, {
        len, taper: 0.55, alpha: 0.96, seed: 100 + row * 23 + ci * 1.71 + (side > 0 ? 0 : 77), shaft: false, hot: row === 2,
        core: [HOT[0], HOT[1] - row * 0.06, HOT[2]], edge: CRIM,
      });
    }
  }
  strokeGlow([mx(512), 432], [mx(712), 318], [mx(958), 618], 1.0, 0.52, 0.11, 0.8, 12);
}

// distant embers behind the bird (small, dim: depth-attenuated)
for (let i = 0; i < 240; i++) {
  const x = rng() * W, y = 90 + rng() * 830, z = 0.25 + rng() * 0.75; // z = apparent depth
  const r = (0.7 + rng() * 1.8) * z, b = (0.25 + rng() * 0.7) * z * z;
  splatSS(x * K, y * K, r * 3 * K, 1.0 * b, 0.48 * b, 0.09 * b, 0.5);
}

drawWing(1); drawWing(-1);

// ------------------------------------------------- tail streamers
for (let sIdx = 0; sIdx < 5; sIdx++) {
  const spread = (sIdx - 2) / 2;
  const bx = 512 + spread * 22, by = 552;
  const len = 200 - Math.abs(spread) * 24 + (hash2(sIdx, 9) - 0.5) * 22;
  const ex = 512 + spread * 150, ey = by + len;
  const cxp = bx + spread * 55 + Math.sin(sIdx * 3.7) * 20, cyp = by + len * 0.52;
  drawRibbon([bx, by], [cxp, cyp], [ex, ey], 72, { len, taper: 0.9, alpha: 0.20, seed: 300 + sIdx * 3.1, shaft: false, hot: false, core: GOLD, edge: CRIM, breakup: true });
  drawRibbon([bx, by], [cxp, cyp], [ex, ey], 42 - Math.abs(spread) * 5, { len, taper: 0.55, alpha: 0.92, seed: 300 + sIdx * 3.1, shaft: true, hot: true, core: HOT, edge: [0.66, 0.11, 0.05], breakup: true });
  splatSS(ex * K, ey * K, 15 * K, 1.0, 0.50, 0.09, 0.14);
}
for (let sIdx = 0; sIdx < 3; sIdx++) {
  const spread = (sIdx - 1) * 0.55;
  const bx = 512 + spread * 20, by = 552;
  const len = 128 + (hash2(sIdx, 21) - 0.5) * 22;
  drawRibbon([bx, by], [bx + spread * 34, by + len * 0.5], [512 + spread * 74, by + len], 18, {
    len, taper: 0.6, alpha: 0.9, seed: 340 + sIdx * 2.9, shaft: true, hot: true, core: HOT, edge: [0.72, 0.13, 0.04], breakup: true,
  });
}

// ------------------------------------------------- body, neck, head (soft SDF)
function bodySDF(x, y) {
  const ell = (cx, cy, rx, ry) => { const dx = (x - cx) / rx, dy = (y - cy) / ry; return Math.sqrt(dx * dx + dy * dy) - 1; };
  return Math.min(ell(512, 472, 60, 98), ell(512, 388, 33, 62), ell(512, 330, 31, 29));
}
for (let sy = 268 * K; sy <= 586 * K; sy++) for (let sx = 428 * K; sx <= 596 * K; sx++) {
  const x = sx / K, y = sy / K;
  const d = bodySDF(x, y);
  if (d > 0.10) continue;
  const edge = sstep(0.04, -0.55, d);
  const tex = fbm(x * 0.03, y * 0.03, 3);
  // overlapping scale shading: soft scallops lit from the chest core
  const scallop = 0.90 + 0.11 * Math.sin(y * 0.40 + Math.sin(x * 0.11) * 2.2) * Math.sin(x * 0.15);
  const streak = 0.93 + 0.11 * vnoise(x * 0.22, y * 0.04); // vertical feather grain
  let r = lerp(0.38, 0.94, edge) * scallop * streak;
  let g = lerp(0.05, 0.54, edge) * scallop * streak;
  let b = lerp(0.06, 0.16, edge) * scallop * streak;
  r *= 0.9 + tex * 0.25; g *= 0.9 + tex * 0.25; b *= 0.9 + tex * 0.25;
  const a = sstep(0.10, 0.0, d);
  blendSS(sx, sy, r, g, b, a);
  if (d > -0.12 && d < 0.05) addSS(sx, sy, 0.20, 0.09, 0.01); // soft rim
}
// chest shingles
for (let row = 0; row < 6; row++) {
  const cy = 424 + row * 22, half = 4 - Math.abs(row - 2.4) * 0.9;
  for (let k = -3; k <= 3; k++) {
    if (Math.abs(k) > half) continue;
    const bx = 512 + k * 14 + (row % 2) * 6 + (hash2(row * 31, k * 7) - 0.5) * 3;
    drawRibbon([bx, cy], [bx + 1, cy + 14], [bx + 2, cy + 30], 19, {
      len: 30, taper: 0.65, alpha: 0.80, seed: 500 + row * 13 + k, shaft: false, hot: false, core: [0.97, 0.66, 0.24], edge: CRIM,
    });
  }
}
// crest filaments
for (let ci = 0; ci < 7; ci++) {
  const a = -Math.PI / 2 + (ci - 3) * 0.30;
  const len = 118 - Math.abs(ci - 3) * 13;
  const bx = 512 + Math.cos(a) * 16, by = 322 + Math.sin(a) * 10;
  const ex = 512 + Math.cos(a) * len * 0.95 + (ci - 3) * 9, ey = 322 - len * 0.72 + Math.abs(ci - 3) * 10;
  drawRibbon([bx, by], [512 + Math.cos(a) * len * 0.55, 322 - len * 0.5], [ex, ey], 10 - Math.abs(ci - 3), {
    len, taper: 0.85, alpha: 0.94, seed: 700 + ci * 2.3, shaft: true, hot: true, core: HOT, edge: [0.74, 0.15, 0.04], breakup: true,
  });
}
// beak (soft-edged wedge via SDF-ish distance fade) + eyes
fillPolySS([[498, 346], [526, 346], [512, 376], [506, 362]], (x, y) => blendSS(x, y, 0.60, 0.31, 0.07, 0.92));
fillPolySS([[506, 362], [512, 376], [509, 364]], (x, y) => blendSS(x, y, 0.13, 0.05, 0.03, 0.92));
for (const ex of [495, 529]) {
  const inw = ex < 512 ? 1 : -1;
  for (let s = 0; s <= 24; s++) {
    const bx = (ex - inw * 8 + inw * s * 0.5) * K, by = (314 + s * 0.28) * K;
    splatSS(bx, by, 2.6, 0.10, 0.02, 0.02, 0.30);
  }
  splatSS(ex * K, 326 * K, 9 * K, 1.0, 0.58, 0.12, 0.55);
  splatSS(ex * K, 326 * K, 2.4 * K, 1.30, 1.10, 0.70, 0.9);
}
splatSS(512 * K, 330 * K, 58 * K, 1.0, 0.53, 0.11, 0.16);

// ------------------------------------------------- lighthouse + beam
{
  const lx = 108, topY = 706, baseY = 806;
  fillPolySS([[lx + 6, topY + 8], [lx + 330, topY - 66], [lx + 330, topY + 26]], (x, y) => {
    const dx = x / K, dy = y / K;
    const t = clamp((dx - lx) / 330, 0, 1);
    const edgeDist = Math.min(Math.abs(dy - (topY + 8 - (dx - lx) * 0.224)), Math.abs(dy - (topY + 8 + (dx - lx) * 0.055)));
    const soft = sstep(2, 16, edgeDist);
    const a = 0.16 * (1 - t) * soft * (0.7 + 0.3 * fbm(dx * 0.02, dy * 0.02, 2));
    addSS(x, y, 0.92 * a, 0.87 * a, 0.74 * a);
  });
  for (let sy = topY * K; sy <= baseY * K; sy++) {
    const y = sy / K, t = (y - topY) / (baseY - topY);
    const hw = lerp(8, 14, t) * K;
    for (let sx = Math.floor(lx * K - hw); sx <= lx * K + hw; sx++) {
      const u = Math.abs(sx - lx * K) / hw;
      const a = sstep(1.06, 0.92, u) * 0.97;
      const stripe = Math.sin(y * 0.11) > 0.25;
      const shade = 0.75 + 0.25 * (1 - u); // cylindrical shading
      blendSS(sx, sy, (stripe ? 0.28 : 0.05) * shade + keyLight(lx, y) * 0.02, (stripe ? 0.22 : 0.035) * shade, (stripe ? 0.18 : 0.045) * shade, a);
    }
  }
  splatSS(lx * K, (topY - 14) * K, 24 * K, 1.0, 0.92, 0.72, 0.55);
  splatSS(lx * K, (topY - 14) * K, 6 * K, 1.2, 1.08, 0.88, 0.9);
}

// ------------------------------------------------- foreground embers (depth-attenuated)
for (let i = 0; i < 350; i++) {
  const x = rng() * W, y = rng() * H;
  const nearBird = Math.exp(-Math.pow(Math.hypot(x - 512, y - 452) / 520, 2));
  if (rng() > 0.35 + nearBird * 0.65 && y < 700) continue;
  const z = 0.3 + rng() * 0.7;                       // apparent depth
  const r = (0.6 + Math.pow(rng(), 2) * 3.0) * z;
  const b = (0.30 + rng() * 1.0) * z * z;            // far embers dimmer (1/z^2-ish)
  if (rng() < 0.30) { // a few carry short motion trails
    const tl = 5 + rng() * 13, sl = (rng() - 0.5) * 5;
    for (let s = 0; s < tl; s++) {
      const f = (1 - s / tl) * 0.30 * b;
      splatSS((x + sl * (s / tl)) * K, (y + s * 1.3) * K, 1.6 * K, 1.0 * f, 0.46 * f, 0.07 * f, 0.5);
    }
  }
  splatSS(x * K, y * K, r * 2.6 * K, 1.0 * b, 0.50 * b, 0.09 * b, 0.7);
  if (r > 1.7) splatSS(x * K, y * K, 1.8 * K, 1.2, 1.0, 0.58, 0.8);
}

// ------------------------------------------------- downscale 2048 -> 1024 (box)
const img = new Float32Array(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const o = (y * W + x) * 3;
  const s0 = ((y * 2) * SS + x * 2) * 3, s1 = s0 + SS * 3;
  for (let c = 0; c < 3; c++) img[o + c] = (buf[s0 + c] + buf[s0 + 3 + c] + buf[s1 + c] + buf[s1 + 3 + c]) * 0.25;
}

// ------------------------------------------------- bloom (at final res)
function downscale(src, sw, factor) {
  const dw = sw / factor, out = new Float32Array(dw * dw * 3);
  for (let y = 0; y < dw; y++) for (let x = 0; x < dw; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const i = ((y * factor + dy) * sw + x * factor + dx) * 3;
      r += Math.max(0, src[i] - 0.55); g += Math.max(0, src[i + 1] - 0.55); b += Math.max(0, src[i + 2] - 0.55);
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
  let [small, dw] = downscale(img, W, factor);
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
      img[i + c] += v * strength;
    }
  }
}
addBloom(4, 3, 2, 0.80);
addBloom(16, 3, 2, 0.60);

// ------------------------------------------------- ACES tonemap, vignette, grain, Bayer dither
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];
const aces = (v) => { v = Math.max(0, v); return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0, 1); };
const out8 = new Uint8Array(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 3;
  const dx = (x - 512) / 640, dy = (y - 500) / 640;
  const vig = 1 - 0.42 * sstep(0.45, 1.25, Math.sqrt(dx * dx + dy * dy));
  const grain = (hash2(x * 3 + 11, y * 3 + 7) - 0.5) * 0.0006;      // whisper of film grain
  const dith = (BAYER[(y & 7) * 8 + (x & 7)] / 64 - 0.5) * (1.0 / 255); // ordered dither vs banding
  for (let c = 0; c < 3; c++) {
    let v = aces(img[i + c] * 1.15);
    v *= vig;
    v += grain * (0.4 + 0.6 * (1 - v)) + dith;
    out8[i + c] = Math.round(clamp(v, 0, 1) * 255);
  }
}

// ------------------------------------------------- PNG encoder (CRC32 + adaptive filters)
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
ihdr[8] = 8; ihdr[9] = 2;
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
