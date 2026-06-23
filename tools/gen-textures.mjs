// gen-textures.mjs — bakes character art to PNG image files for TUX SMASH ROYALE.
// Run: `node tools/gen-textures.mjs`.
//
// APPROACH: author the ORIGINAL 8-bit sprite shapes on a 32x36 grid (flat colours,
// symmetric — no gradients, no outlines), then UPSCALE every layer 2x with Scale2x
// (EPX) to a crisp 16-bit 64x72 image. Tintable parts are baked GRAYSCALE (white =
// full colour) and multiplied by the fighter's colour at runtime; fixed parts
// (eyes/hats/accessories) are baked in real colour. New styles (shirts/pants/shoes,
// gender, fat) are layered on the original body shape.

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'assets', 'tex');
const GW = 32, GH = 36;           // authoring grid (output is 2x = 64x72)

// ---------------------------------------------------------------- PNG encoder
const CRCT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRCT[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); }
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- draw buffer
class Buf {
  constructor(w = GW, h = GH) { this.w = w; this.h = h; this.d = Buffer.alloc(w * h * 4); }
  setC(x, y, r, g, b, a = 255) {
    x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    if (a >= 255) { this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = 255; return; }
    if (a <= 0) return;
    const A = a / 255, ia = 1 - A;
    this.d[i] = Math.round(r * A + this.d[i] * ia); this.d[i + 1] = Math.round(g * A + this.d[i + 1] * ia);
    this.d[i + 2] = Math.round(b * A + this.d[i + 2] * ia); this.d[i + 3] = Math.min(255, Math.round(a + this.d[i + 3] * ia));
  }
  set(x, y, v, a = 255) { this.setC(x, y, v, v, v, a); }
  clr(x, y) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; const i = (y * this.w + x) * 4; this.d[i] = this.d[i + 1] = this.d[i + 2] = this.d[i + 3] = 0; }
  rect(x, y, w, h, v, a = 255) { for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) this.set(x + k, y + j, v, a); }
  rectC(x, y, w, h, r, g, b, a = 255) { for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) this.setC(x + k, y + j, r, g, b, a); }
  row(x0, x1, y, v, a = 255) { for (let x = x0; x <= x1; x++) this.set(x, y, v, a); }
  ell(cx, cy, rx, ry, v, a = 255) { for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) this.set(cx + x, cy + y, v, a); }
  ellC(cx, cy, rx, ry, r, g, b, a = 255) { for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) this.setC(cx + x, cy + y, r, g, b, a); }
  // paint a list of [x,y,w,h] rects in grayscale value v
  rects(list, v, a = 255) { for (const r of list) this.rect(r[0], r[1], r[2], r[3] === undefined ? 1 : r[3], v, a); }
}

// ---- nearest-neighbour 2x: doubles the resolution while looking IDENTICAL (true
// 8-bit -> 16-bit upscale). Each source pixel becomes a 2x2 block; nothing is
// smoothed or re-shaped, and the finer 64x72 grid is editable for adding detail.
function nearest2x(src) {
  const out = new Buf(src.w * 2, src.h * 2);
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const i = (y * src.w + x) * 4, r = src.d[i], g = src.d[i + 1], b = src.d[i + 2], a = src.d[i + 3];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const j = ((y * 2 + dy) * out.w + (x * 2 + dx)) * 4;
      out.d[j] = r; out.d[j + 1] = g; out.d[j + 2] = b; out.d[j + 3] = a;
    }
  }
  return out;
}

// =============================================================================
// HUMANOID  (original proportions, flat, symmetric)
//   head x11..20 y4..12 | torso y14..22 | arms sides y15..21 | legs y24..30 | shoes y31..32
//   eyes y8, mouth ~y10.5 (drawn faint). gender + fat handled at runtime (warp).
// =============================================================================
function humanoidBody() {
  const b = new Buf();
  // torso + leg skin base (covered by clothes; two legs with a gap so no crotch skin)
  b.rect(11, 14, 10, 9, 230);
  b.rect(12, 24, 3, 8, 230); b.rect(17, 24, 3, 8, 230);
  // arms (skin) at the sides + hands
  b.rect(9, 15, 2, 6, 230); b.rect(21, 15, 2, 6, 230);
  b.rect(9, 20, 2, 2, 230); b.rect(21, 20, 2, 2, 230);
  // head (original shape)
  b.row(13, 18, 4, 230); b.row(12, 19, 5, 230); b.rect(11, 6, 10, 5, 230);
  b.row(12, 19, 11, 230); b.row(14, 17, 12, 230);
  b.rect(10, 8, 1, 2, 230); b.rect(21, 8, 1, 2, 230);   // ears
  b.rect(14, 13, 4, 1, 230);                            // neck
  return b;
}

// MOUTH — selectable expressions, composited ON TOP of the beard so the mouth shows
// through any (editable) beard. The "mouth gap" is this texture, not hardcoded logic.
function mouthStyle(kind) {
  const b = new Buf();
  const lr = 116, lg = 68, lb = 56, dr = 64, dg = 38, db = 36, wr = 240, wg = 240, wb = 245;
  if (kind === 'smile') { b.rectC(14, 11, 4, 1, lr, lg, lb); b.setC(13, 10, lr, lg, lb); b.setC(18, 10, lr, lg, lb); }
  else if (kind === 'grin') { b.rectC(14, 10, 4, 1, dr, dg, db); b.setC(13, 10, lr, lg, lb); b.setC(18, 10, lr, lg, lb); b.rectC(14, 11, 4, 1, wr, wg, wb); }
  else if (kind === 'frown') { b.rectC(14, 10, 4, 1, lr, lg, lb); b.setC(13, 11, lr, lg, lb); b.setC(18, 11, lr, lg, lb); }
  else if (kind === 'open') { b.rectC(14, 10, 4, 1, lr, lg, lb); b.rectC(15, 11, 2, 1, dr, dg, db); }
  else if (kind === 'serious') { b.rectC(14, 10, 3, 1, lr, lg, lb); }
  else { b.rectC(14, 10, 4, 1, lr, lg, lb); } // neutral
  return b;
}

// ---- SHIRTS (tint: belly) — built on the original torso block ----
function shirtBase(b) {
  b.rect(10, 14, 12, 2, 255);            // shoulders
  b.rect(11, 16, 10, 6, 255);            // chest..belly
  b.rect(12, 22, 8, 1, 255);             // waist
  b.rect(9, 15, 2, 5, 245); b.rect(21, 15, 2, 5, 245);  // sleeves
}
function shirtTee() { const b = new Buf(); shirtBase(b); return b; }
function shirtVneck() { const b = new Buf(); shirtBase(b); for (let i = 0; i < 3; i++) for (let x = 14 + i; x <= 17 - i; x++) b.clr(x, 14 + i); return b; }
function shirtHoodie() { const b = new Buf(); shirtBase(b); b.row(11, 20, 14, 220); b.row(12, 19, 15, 235); b.rect(13, 18, 6, 3, 210); b.set(14, 16, 255); b.set(17, 16, 255); return b; }
function shirtTank() { const b = new Buf(); b.rect(12, 14, 2, 2, 255); b.rect(18, 14, 2, 2, 255); b.rect(11, 16, 10, 6, 255); b.rect(12, 22, 8, 1, 255); return b; }
function shirtStripe() { const b = new Buf(); shirtBase(b); for (let y = 16; y <= 21; y += 2) b.row(10, 21, y, 175); return b; }
function shirtSuit() { const b = new Buf(); shirtBase(b); b.rect(15, 14, 2, 8, 255); b.set(15, 14, 110); b.set(16, 14, 110); for (let y = 15; y <= 20; y++) { b.set(15, y, 150); b.set(16, y, 150); } return b; }

// ---- PANTS (tint: pants) ----
function pantsJeans() { const b = new Buf(); b.rect(11, 23, 10, 1, 235); b.rect(12, 24, 3, 7, 255); b.rect(17, 24, 3, 7, 255); b.set(16, 24, 200); return b; }
function pantsTrouser() { const b = new Buf(); b.rect(11, 23, 10, 1, 235); b.rect(12, 24, 3, 7, 255); b.rect(17, 24, 3, 7, 255); for (let y = 25; y <= 30; y++) { b.set(13, y, 210); b.set(18, y, 210); } return b; }
function pantsCargo() { const b = new Buf(); b.rect(11, 23, 10, 1, 235); b.rect(12, 24, 3, 7, 255); b.rect(17, 24, 3, 7, 255); b.rect(12, 27, 2, 2, 200); b.rect(18, 27, 2, 2, 200); return b; }
function pantsShorts() { const b = new Buf(); b.rect(11, 23, 10, 1, 235); b.rect(12, 24, 3, 4, 255); b.rect(17, 24, 3, 4, 255); return b; }
function pantsSkirt() { const b = new Buf(); b.rect(11, 23, 10, 1, 240); for (let y = 24; y <= 30; y++) { const w = y - 23; b.row(12 - w, 19 + w, y, 255); } return b; }

// ---- SHOES (tint: feet) ----
function shoeSneaker() { const b = new Buf(); b.rect(11, 31, 5, 2, 255); b.rect(16, 31, 5, 2, 255); b.row(11, 15, 32, 210); b.row(16, 20, 32, 210); return b; }
function shoeBoot() { const b = new Buf(); b.rect(11, 30, 5, 3, 255); b.rect(16, 30, 5, 3, 255); return b; }
function shoeDress() { const b = new Buf(); b.rect(11, 31, 5, 2, 255); b.rect(16, 31, 5, 2, 255); b.set(11, 32, 200); b.set(16, 32, 200); return b; }
function shoeSandal() { const b = new Buf(); b.rect(11, 32, 5, 1, 255); b.rect(16, 32, 5, 1, 255); return b; }

// ---- HAIR (tint: hairColor) — ORIGINAL shapes; x<11 pieces read as BEHIND ----
function hairStyle(kind) {
  const front = new Buf(), back = new Buf();
  const V = 230, HI = 252, SH = 196;          // base / highlight / shadow (all tinted by hairColor)
  if (kind === 'bald') return { front, back };
  // subtle strand texture so the hair isn't a flat slab
  const tex = () => { front.set(13, 2, HI); front.set(15, 2, HI); front.set(14, 3, HI); front.set(12, 5, SH); front.set(18, 4, SH); front.set(19, 5, SH); front.set(16, 5, SH); };
  // solid cap fully covering the head crown down to a clean hairline (~y5/6)
  const cap = () => { front.row(13, 18, 2, V); front.row(12, 19, 3, V); front.rect(11, 4, 10, 2, V); front.set(11, 6, V); front.set(20, 6, V); tex(); };
  if (kind === 'mohawk') { front.rect(14, 3, 4, 3, V); front.rect(15, 0, 2, 3, V); front.set(15, 0, HI); front.set(14, 4, SH); return { front, back }; }
  if (kind === 'afro') { front.ell(16, 4, 7, 4, V); back.ell(16, 5, 8, 3, SH); front.set(12, 2, HI); front.set(14, 1, HI); front.set(20, 5, SH); front.set(11, 5, SH); return { front, back }; }
  cap();
  if (kind === 'long') { front.rect(11, 6, 1, 6, V); front.rect(20, 6, 1, 6, V); back.rect(10, 5, 2, 9, V); back.rect(20, 5, 2, 9, V); back.set(11, 13, SH); back.set(20, 13, SH); }
  else if (kind === 'ponytail') { back.rect(19, 4, 2, 2, V); back.rect(20, 6, 2, 5, V); back.set(21, 11, SH); }     // tail joined to the cap, down the back-right
  else if (kind === 'spiky') { front.set(13, 1, V); front.set(14, 1, V); front.set(15, 0, V); front.set(16, 0, V); front.set(17, 1, V); front.set(18, 1, V); front.set(15, 0, HI); } // spikes rising from the cap top
  else if (kind === 'bun') { front.rect(14, 0, 4, 2, V); front.set(16, 0, HI); }
  else if (kind === 'curly') { front.set(11, 5, V); front.set(20, 5, V); front.set(12, 6, V); front.set(15, 6, V); front.set(18, 6, V); front.set(13, 2, HI); front.set(17, 2, HI); }
  return { front, back };
}

// ---- BEARDS (tint: beardColor) — original-ish, mouth (y10) kept open ----
function beardStyle(kind) {
  const b = new Buf();
  if (kind === 'none') return b;
  if (kind === 'stubble') { [[12, 9], [12, 10], [13, 11], [15, 11], [17, 11], [19, 11], [19, 10], [19, 9], [14, 12], [17, 12]].forEach(p => b.set(p[0], p[1], 220, 140)); }
  else if (kind === 'goatee') { b.row(13, 18, 9, 230); b.rect(15, 11, 2, 2, 230); }
  else if (kind === 'full') { b.rect(11, 9, 2, 3, 230); b.rect(19, 9, 2, 3, 230); b.row(13, 18, 9, 230); b.row(12, 19, 11, 230); b.row(13, 18, 12, 230); }
  else if (kind === 'moustache') { b.row(13, 18, 9, 230); }
  else if (kind === 'clobi') { b.row(13, 18, 9, 230); b.set(12, 9, 230); b.set(19, 9, 230); b.row(12, 19, 11, 230); b.row(14, 17, 12, 230); }
  return b;
}

// ---- EYES (fixed colour) — original positions L=13,R=17,y=8 ----
// EYES = a face EXPRESSION: eyebrows (give emotion) + clean dark eyes with a glint.
function eyesStyle(kind) {
  const b = new Buf();
  const wr = 246, wg = 246, wb = 252, dr = 28, dg = 30, db = 44, cr = 127, cg = 249, cb = 224;
  const e1 = 62, e2 = 44, e3 = 34;                 // eyebrow dark-brown
  const browFlat = () => { b.rectC(12, 6, 3, 1, e1, e2, e3); b.rectC(17, 6, 3, 1, e1, e2, e3); };
  const browAngry = () => { b.setC(12, 6, e1, e2, e3); b.setC(13, 6, e1, e2, e3); b.setC(13, 7, e1, e2, e3); b.setC(14, 7, e1, e2, e3); b.setC(19, 6, e1, e2, e3); b.setC(18, 6, e1, e2, e3); b.setC(18, 7, e1, e2, e3); b.setC(17, 7, e1, e2, e3); };
  const browRaised = () => { b.rectC(12, 5, 3, 1, e1, e2, e3); b.rectC(17, 5, 3, 1, e1, e2, e3); };
  const eyeOpen = () => { b.rectC(13, 8, 2, 2, dr, dg, db); b.rectC(17, 8, 2, 2, dr, dg, db); b.setC(13, 8, wr, wg, wb); b.setC(17, 8, wr, wg, wb); };
  if (kind === 'angry') { browAngry(); b.rectC(13, 8, 2, 1, dr, dg, db); b.rectC(17, 8, 2, 1, dr, dg, db); b.setC(13, 8, wr, wg, wb); b.setC(17, 8, wr, wg, wb); }
  else if (kind === 'sleepy') { browFlat(); b.rectC(13, 9, 2, 1, dr, dg, db); b.rectC(17, 9, 2, 1, dr, dg, db); }
  else if (kind === 'shades') { browFlat(); b.rectC(12, 8, 7, 2, 18, 20, 30); b.setC(13, 8, cr, cg, cb); }
  else if (kind === 'sparkle') { browRaised(); eyeOpen(); b.setC(14, 9, 255, 255, 255); b.setC(18, 9, 255, 255, 255); }
  else { browFlat(); eyeOpen(); }
  return b;
}

// ---- HATS (fixed colour) — fit within y0..5 ----
function hatStyle(kind) {
  const b = new Buf();
  if (kind === 'cap') { b.rectC(11, 2, 11, 2, 27, 122, 58); b.rectC(12, 0, 9, 2, 31, 138, 66); b.rectC(10, 4, 14, 1, 18, 80, 40); b.rectC(15, 2, 2, 2, 207, 233, 255); }
  else if (kind === 'wizard') { b.setC(16, 0, 58, 29, 74); b.rectC(15, 1, 3, 1, 58, 29, 74); b.rectC(13, 2, 6, 1, 70, 40, 92); b.rectC(11, 3, 11, 1, 58, 29, 74); b.rectC(9, 4, 15, 1, 127, 249, 224); b.setC(16, 1, 255, 242, 127); }
  else if (kind === 'beanie') { b.rectC(11, 1, 10, 2, 255, 90, 60); b.rectC(11, 3, 10, 1, 253, 253, 253); b.setC(15, 0, 253, 253, 253); b.setC(16, 0, 253, 253, 253); }
  else if (kind === 'tophat') { b.rectC(9, 4, 14, 1, 22, 24, 34); b.rectC(12, 0, 8, 4, 22, 24, 34); b.rectC(12, 3, 8, 1, 200, 70, 70); }
  else if (kind === 'crown') { b.rectC(11, 3, 10, 1, 255, 207, 60); b.rectC(11, 1, 2, 2, 255, 207, 60); b.rectC(15, 1, 2, 2, 255, 207, 60); b.rectC(19, 1, 2, 2, 255, 207, 60); b.setC(13, 2, 255, 207, 60); b.setC(17, 2, 255, 207, 60); b.setC(16, 2, 255, 90, 60); }
  else if (kind === 'halo') { b.ellC(16, 1, 5, 1, 255, 242, 127); b.ellC(16, 1, 3, 1, 0, 0, 0, 0); b.setC(11, 1, 255, 242, 127); b.setC(21, 1, 255, 242, 127); }
  return b;
}

// ---- ACCESSORIES (fixed colour) ----
function accStyle(kind) {
  const b = new Buf();
  if (kind === 'bowtie') { b.rectC(15, 14, 2, 2, 255, 90, 60); b.rectC(13, 14, 2, 2, 255, 90, 60); b.rectC(17, 14, 2, 2, 255, 90, 60); }
  else if (kind === 'scarf') { b.rectC(11, 13, 10, 2, 255, 158, 44); b.rectC(13, 15, 2, 3, 255, 158, 44); }
  else if (kind === 'fish') { b.rectC(14, 16, 4, 3, 127, 249, 224); b.rectC(14, 16, 4, 1, 255, 255, 255); b.setC(15, 17, 17, 19, 28); }
  else if (kind === 'badge') { b.rectC(12, 16, 2, 2, 156, 255, 90); b.setC(12, 16, 230, 255, 200); }
  else if (kind === 'chain') { b.rectC(13, 14, 6, 1, 255, 207, 60); b.rectC(15, 15, 2, 2, 255, 207, 60); }
  return b;
}

// ---- CAPES (tint: capeColor) — flowing, behind the body (revamped) ----
function capeBody(spread, fn) {
  const b = new Buf();
  b.rect(10, 14, 12, 1, 235);
  for (let y = 15; y <= 30; y++) {
    const s = Math.round((y - 14) * spread), x0 = 11 - s, x1 = 20 + s;
    b.row(x0, x1, y, 240);
  }
  if (fn) fn(b);
  return b;
}
function capeStyle(kind) {
  if (kind === 'classic') return capeBody(0.45);
  if (kind === 'long') return capeBody(0.35, (b) => { for (let y = 31; y <= 33; y++) b.rect(13, y, 6, 1, 230); });
  if (kind === 'round') return capeBody(0.6);
  if (kind === 'royal') return capeBody(0.5, (b) => { b.rect(15, 15, 2, 15, 200); });
  if (kind === 'tattered') return capeBody(0.5, (b) => { for (let x = 7; x <= 25; x += 2) { b.clr(x, 30); b.clr(x, 29); } });
  return capeBody(0.45);
}

// =============================================================================
// TUX  (original penguin shapes)
// =============================================================================
function tuxBody() {
  const b = new Buf();
  [[12, 4, 8], [10, 6, 12], [8, 8, 16], [8, 10, 16], [6, 12, 20], [6, 14, 20], [6, 16, 20], [6, 18, 20], [6, 20, 20], [8, 22, 16], [8, 24, 16], [10, 26, 12]].forEach(r => b.rect(r[0], r[1], r[2], 2, 235));
  b.rect(4, 14, 2, 8, 235); b.rect(26, 14, 2, 8, 235);   // flippers
  return b;
}
function tuxBelly() {
  const b = new Buf();
  [[12, 12, 8], [10, 14, 12], [10, 16, 12], [10, 18, 12], [10, 20, 12], [12, 22, 8], [12, 24, 8]].forEach(r => b.rect(r[0], r[1], r[2], 2, 250));
  return b;
}
function tuxFeet() { const b = new Buf(); b.rect(8, 28, 6, 2, 250); b.rect(18, 28, 6, 2, 250); b.rect(8, 30, 8, 2, 250); b.rect(16, 30, 8, 2, 250); return b; }
function tuxBeak() { const b = new Buf(); b.rect(14, 10, 4, 2, 250); b.rect(14, 12, 4, 1, 230); return b; }

// =============================================================================
// BUILD — author at 32x36, Scale2x to 64x72, save PNG
// =============================================================================
function save(rel, buf) { const up = nearest2x(buf); const file = path.join(OUT, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, encodePNG(up.w, up.h, up.d)); return rel.replace(/\\/g, '/'); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const manifest = { grid: { w: GW * 2, h: GH * 2 }, base: {}, catalog: {} };
manifest.base.humanoidBody = save('base/humanoidBody.png', humanoidBody());
manifest.base.tuxBody = save('base/tuxBody.png', tuxBody());
manifest.base.tuxBelly = save('base/tuxBelly.png', tuxBelly());
manifest.base.tuxFeet = save('base/tuxFeet.png', tuxFeet());
manifest.base.tuxBeak = save('base/tuxBeak.png', tuxBeak());

manifest.catalog.shirt = [
  { id: 'tee', name: 'Tee', file: save('shirt/tee.png', shirtTee()) },
  { id: 'vneck', name: 'V-Neck', file: save('shirt/vneck.png', shirtVneck()) },
  { id: 'hoodie', name: 'Hoodie', file: save('shirt/hoodie.png', shirtHoodie()) },
  { id: 'tank', name: 'Tank', file: save('shirt/tank.png', shirtTank()) },
  { id: 'stripe', name: 'Striped', file: save('shirt/stripe.png', shirtStripe()) },
  { id: 'suit', name: 'Suit', file: save('shirt/suit.png', shirtSuit()) },
];
manifest.catalog.pants = [
  { id: 'jeans', name: 'Jeans', file: save('pants/jeans.png', pantsJeans()) },
  { id: 'trouser', name: 'Trousers', file: save('pants/trouser.png', pantsTrouser()) },
  { id: 'cargo', name: 'Cargo', file: save('pants/cargo.png', pantsCargo()) },
  { id: 'shorts', name: 'Shorts', file: save('pants/shorts.png', pantsShorts()) },
  { id: 'skirt', name: 'Skirt', file: save('pants/skirt.png', pantsSkirt()) },
];
manifest.catalog.shoes = [
  { id: 'sneaker', name: 'Sneakers', file: save('shoes/sneaker.png', shoeSneaker()) },
  { id: 'boot', name: 'Boots', file: save('shoes/boot.png', shoeBoot()) },
  { id: 'dress', name: 'Dress', file: save('shoes/dress.png', shoeDress()) },
  { id: 'sandal', name: 'Sandals', file: save('shoes/sandal.png', shoeSandal()) },
];
manifest.catalog.hair = ['bald', 'short', 'long', 'ponytail', 'spiky', 'bun', 'mohawk', 'afro', 'curly'].map(k => { const { front, back } = hairStyle(k); return { id: k, name: cap(k), front: save('hair/' + k + '_f.png', front), back: save('hair/' + k + '_b.png', back) }; });
manifest.catalog.beard = ['none', 'stubble', 'clobi', 'goatee', 'full', 'moustache'].map(k => ({ id: k, name: cap(k), file: k === 'none' ? null : save('beard/' + k + '.png', beardStyle(k)) }));
manifest.catalog.eyes = ['classic', 'angry', 'sleepy', 'shades', 'sparkle'].map(k => ({ id: k, name: cap(k), file: save('eyes/' + k + '.png', eyesStyle(k)) }));
manifest.catalog.mouth = ['neutral', 'smile', 'grin', 'frown', 'open', 'serious'].map(k => ({ id: k, name: cap(k), file: save('mouth/' + k + '.png', mouthStyle(k)) }));
manifest.catalog.hat = ['none', 'cap', 'wizard', 'beanie', 'tophat', 'crown', 'halo'].map(k => ({ id: k, name: k === 'cap' ? 'Vim Cap' : cap(k), file: k === 'none' ? null : save('hat/' + k + '.png', hatStyle(k)) }));
manifest.catalog.accessory = ['none', 'bowtie', 'scarf', 'fish', 'badge', 'chain'].map(k => ({ id: k, name: k === 'fish' ? "Fisherman's" : cap(k), file: k === 'none' ? null : save('acc/' + k + '.png', accStyle(k)) }));
manifest.catalog.cape = ['none', 'classic', 'long', 'round', 'royal', 'tattered'].map(k => ({ id: k, name: cap(k), file: k === 'none' ? null : save('cape/' + k + '.png', capeStyle(k)) }));

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
let count = 0; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.png')) count++; } })(OUT);
console.log('Baked ' + count + ' PNGs at ' + (GW * 2) + 'x' + (GH * 2) + ' (nearest 2x) + manifest.json');
