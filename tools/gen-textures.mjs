// gen-textures.mjs — bakes the character art into PNG image files for
// TUX SMASH ROYALE. Run: `node tools/gen-textures.mjs`.
//
// The art used to be procedural fillRect code; this generator is now the single
// source of truth and emits real, referenced image files under web/assets/tex/
// plus a manifest.json the runtime + editor read.
//
//   - TINTABLE parts are baked GRAYSCALE (value = shading; 255 = full colour).
//     The runtime multiplies them by the fighter's chosen colour.
//   - FIXED parts (eyes, hats, accessories) are baked in real colour.
//
// LAYOUT v2 (32x36 grid, cx=16):
//   head y3..11 | neck y11..12 | torso/shirt y12..23 | hips y23..24 |
//   legs y24..31 | shoes y31..33.  eyes y7, mouth y10 (beards frame it).

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'assets', 'tex');
const GW = 32, GH = 36;

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
    x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4, A = a / 255, ia = 1 - A;
    this.d[i] = Math.round(r * A + this.d[i] * ia); this.d[i + 1] = Math.round(g * A + this.d[i + 1] * ia);
    this.d[i + 2] = Math.round(b * A + this.d[i + 2] * ia); this.d[i + 3] = Math.min(255, Math.round(a + this.d[i + 3] * ia));
  }
  set(x, y, v, a = 255) { this.setC(x, y, v, v, v, a); }
  clr(x, y) { const i = (y * this.w + x) * 4; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; this.d[i] = this.d[i + 1] = this.d[i + 2] = this.d[i + 3] = 0; }
  rect(x, y, w, h, v, a = 255) { for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) this.set(x + k, y + j, v, a); }
  rectC(x, y, w, h, r, g, b, a = 255) { for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) this.setC(x + k, y + j, r, g, b, a); }
  row(x0, x1, y, v, a = 255) { for (let x = x0; x <= x1; x++) this.set(x, y, v, a); }
  ell(cx, cy, rx, ry, v, a = 255) { for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) this.set(cx + x, cy + y, v, a); }
  ellC(cx, cy, rx, ry, r, g, b, a = 255) { for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) this.setC(cx + x, cy + y, r, g, b, a); }
  // outlines intentionally disabled — keep the original flat 8-bit style (just
  // cleaner shapes at the real resolution). Left as a no-op so callers are happy.
  outline() { /* no-op */ }
}
// left-lit horizontal span (lighter left, slightly darker right)
function vSpan(b, x0, x1, y, base, drop = 26, a = 255) { const n = Math.max(1, x1 - x0); for (let x = x0; x <= x1; x++) b.set(x, y, Math.max(0, base - Math.round(((x - x0) / n) * drop)), a); }

// =============================================================================
// HUMANOID  (canonical; gender/fat handled at runtime via warp)
// =============================================================================
const SKIN = 232, SKIN_SH = 196;

function humanoidBody() {
  const b = new Buf();
  b.rect(13, 24, 3, 7, 206); b.rect(16, 24, 3, 7, 206);   // legs (under pants)
  b.rect(11, 13, 10, 11, 212);                            // torso (under shirt)
  b.rect(8, 14, 2, 7, 210); b.rect(22, 14, 2, 7, 210);    // arms
  b.rect(8, 21, 2, 2, 222); b.rect(22, 21, 2, 2, 222);    // hands
  b.ell(16, 7, 4, 4, SKIN);                               // head x12..20 y3..11
  for (let y = 4; y <= 10; y++) vSpan(b, 12, 20, y, SKIN, 22);
  for (let y = 4; y <= 10; y++) { b.set(19, y, SKIN_SH); b.set(20, y, SKIN_SH - 14, 150); }
  b.rect(11, 7, 1, 2, SKIN_SH); b.rect(20, 7, 1, 2, SKIN_SH);  // ears
  b.rect(14, 11, 4, 1, SKIN_SH);                          // neck
  b.set(16, 9, SKIN_SH - 18);                             // nose
  b.set(15, 10, 150, 200); b.set(16, 10, 150, 200); b.set(17, 10, 150, 220); // mouth (open)
  b.outline(70);
  return b;
}

// ---- SHIRTS (tint: belly) ----
function shirtBase(b) {
  for (let y = 12; y <= 23; y++) { const x0 = y <= 13 ? 10 : 11, x1 = y <= 13 ? 21 : 20; vSpan(b, x0, x1, y, 236, 24); }
  b.rect(8, 13, 2, 5, 224); b.rect(22, 13, 2, 5, 224);    // sleeve caps
}
function shirtTee() { const b = new Buf(); shirtBase(b); b.row(13, 18, 12, 250); b.outline(70); return b; }
function shirtVneck() { const b = new Buf(); shirtBase(b); for (let i = 0; i < 4; i++) for (let x = 14 + i; x <= 18 - i; x++) b.clr(x, 12 + i); b.outline(70); return b; }
function shirtHoodie() { const b = new Buf(); shirtBase(b); b.row(11, 20, 12, 208); b.row(12, 19, 13, 220); b.rect(13, 18, 6, 3, 204); b.set(14, 14, 248); b.set(17, 14, 248); b.outline(70); return b; }
function shirtTank() { const b = new Buf(); for (let y = 14; y <= 23; y++) vSpan(b, 12, 19, y, 236, 22); b.rect(12, 12, 2, 2, 236); b.rect(18, 12, 2, 2, 236); b.outline(70); return b; }
function shirtStripe() { const b = new Buf(); shirtBase(b); for (let y = 14; y <= 22; y += 2) b.row(11, 20, y, 170); b.outline(70); return b; }
function shirtSuit() { const b = new Buf(); shirtBase(b); b.rect(15, 12, 2, 11, 250); b.rect(15, 14, 2, 6, 150); b.set(15, 13, 110); b.set(16, 13, 110); b.outline(70); return b; }

// ---- PANTS (tint: pants) ----
function pantsJeans() { const b = new Buf(); b.rect(11, 23, 10, 2, 220); b.rect(12, 25, 3, 7, 230); b.rect(17, 25, 3, 7, 230); b.set(16, 24, 200); b.set(13, 28, 250); b.set(18, 28, 250); b.outline(70); return b; }
function pantsShorts() { const b = new Buf(); b.rect(11, 23, 10, 2, 220); b.rect(12, 25, 3, 4, 232); b.rect(17, 25, 3, 4, 232); b.outline(70); return b; }
function pantsCargo() { const b = new Buf(); b.rect(11, 23, 10, 2, 218); b.rect(12, 25, 3, 7, 228); b.rect(17, 25, 3, 7, 228); b.rect(12, 27, 2, 2, 196); b.rect(18, 27, 2, 2, 196); b.outline(70); return b; }
function pantsSkirt() { const b = new Buf(); b.rect(11, 23, 10, 2, 222); for (let y = 25; y <= 30; y++) { const w = y - 24; vSpan(b, 12 - w, 19 + w, y, 232, 22); } b.outline(70); return b; }
function pantsTrouser() { const b = new Buf(); b.rect(11, 23, 10, 2, 222); b.rect(12, 25, 3, 7, 232); b.rect(17, 25, 3, 7, 232); for (let y = 25; y <= 31; y++) { b.set(13, y, 250); b.set(18, y, 250); } b.outline(70); return b; }

// ---- SHOES (tint: feet) ----
function shoeSneaker() { const b = new Buf(); b.rect(11, 31, 5, 2, 235); b.rect(16, 31, 5, 2, 235); b.row(11, 15, 32, 255); b.row(16, 20, 32, 255); b.outline(70); return b; }
function shoeBoot() { const b = new Buf(); b.rect(11, 30, 5, 3, 225); b.rect(16, 30, 5, 3, 225); b.outline(70); return b; }
function shoeSandal() { const b = new Buf(); b.rect(11, 32, 5, 1, 235); b.rect(16, 32, 5, 1, 235); b.set(13, 31, 220); b.set(18, 31, 220); b.outline(70); return b; }
function shoeDress() { const b = new Buf(); b.rect(11, 31, 5, 2, 226); b.rect(16, 31, 5, 2, 226); b.set(11, 32, 255); b.set(16, 32, 255); b.outline(70); return b; }

// ---- HAIR (tint: hairColor): front (over head) + back (behind body) ----
function hairStyle(kind) {
  const front = new Buf(), back = new Buf(); const v = 230, sh = 196;
  if (kind === 'bald') return { front, back };
  if (kind !== 'mohawk') { front.ell(16, 4, 5, 3, v); front.rect(11, 3, 10, 2, v); }   // cap y1..7
  if (kind === 'short') front.row(11, 20, 6, sh);
  if (kind === 'spiky') { for (let x = 12; x <= 20; x += 2) { front.set(x, 0, v); front.set(x, 1, v); front.set(x, 2, v); } front.row(11, 20, 3, v); }
  if (kind === 'mohawk') { for (let y = -1; y <= 6; y++) { front.set(15, y, v); front.set(16, y, v); front.set(17, y, v); } }
  if (kind === 'long') { back.rect(10, 4, 2, 13, v); back.rect(20, 4, 2, 13, v); back.rect(10, 16, 12, 2, sh); }
  if (kind === 'ponytail') { back.rect(8, 5, 2, 7, v); back.set(7, 7, sh); back.set(7, 8, sh); }
  if (kind === 'bun') front.ell(16, 1, 2, 2, v);
  if (kind === 'afro') { front.ell(16, 3, 7, 4, v); back.ell(16, 4, 8, 4, sh); }
  if (kind === 'curly') { front.ell(16, 4, 6, 3, v); for (let x = 11; x <= 21; x += 2) front.set(x, 7, v); }
  front.outline(60); back.outline(60); return { front, back };
}

// ---- BEARDS (tint: beardColor) — ALWAYS leave the mouth (y10) open ----
function beardStyle(kind) {
  const b = new Buf(); const v = 220, sh = 185;
  if (kind === 'none') return b;
  if (kind === 'stubble') { [[12, 9], [13, 11], [15, 11], [17, 11], [19, 11], [19, 9], [14, 12], [17, 12]].forEach(p => b.set(p[0], p[1], sh, 160)); b.row(13, 18, 12, v, 150); }
  else if (kind === 'goatee') { b.row(14, 17, 11, v); b.rect(15, 12, 2, 2, v); b.set(13, 9, sh, 200); b.set(18, 9, sh, 200); }
  else if (kind === 'full') { b.rect(11, 7, 2, 5, v); b.rect(19, 7, 2, 5, v); b.row(13, 18, 9, v); b.row(12, 19, 11, v); b.row(13, 18, 12, v); b.row(14, 17, 13, v); }
  else if (kind === 'moustache') { b.row(13, 18, 9, v); b.set(13, 10, sh, 150); b.set(18, 10, sh, 150); }
  else if (kind === 'clobi') { b.row(13, 18, 9, v); b.set(12, 8, sh); b.set(19, 8, sh); b.rect(12, 11, 8, 1, v); b.row(14, 17, 12, v); }
  b.outline(60); return b;
}

// ---- EYES (fixed colour) ----
function eyesStyle(kind) {
  const b = new Buf(); const W = [245, 245, 250], D = [20, 22, 34], C = [127, 249, 224];
  const L = 13, R = 18, y = 7;
  const white = (x) => { b.setC(x, y, ...W); b.setC(x + 1, y, ...W); b.setC(x, y + 1, ...W); b.setC(x + 1, y + 1, ...W); };
  const pupil = (x, c = D) => { b.setC(x + 1, y, ...c); b.setC(x + 1, y + 1, ...c); };
  if (kind === 'classic') { white(L); white(R); pupil(L); pupil(R); }
  else if (kind === 'angry') { white(L); white(R); pupil(L); pupil(R); b.setC(L - 1, y - 1, ...D); b.setC(L, y - 1, ...D); b.setC(R + 1, y - 1, ...D); b.setC(R, y - 1, ...D); }
  else if (kind === 'sleepy') { b.setC(L, y, ...D); b.setC(L + 1, y, ...D); b.setC(R, y, ...D); b.setC(R + 1, y, ...D); b.setC(L, y + 1, ...W); b.setC(R + 1, y + 1, ...W); }
  else if (kind === 'shades') { b.rectC(L - 1, y - 1, 8, 3, 18, 20, 30); b.setC(L, y, ...C); b.setC(R + 1, y + 1, 120, 200, 180); }
  else if (kind === 'sparkle') { white(L); white(R); pupil(L, C); pupil(R, C); b.setC(L, y, 255, 255, 255); b.setC(R, y, 255, 255, 255); }
  else { white(L); white(R); pupil(L); pupil(R); }
  return b;
}

// ---- HATS (fixed colour) — sit on the head top ----
function hatStyle(kind) {
  const b = new Buf();
  if (kind === 'cap') { b.rectC(11, 2, 11, 2, 27, 122, 58); b.rectC(12, 0, 9, 2, 31, 138, 66); b.rectC(10, 4, 14, 1, 18, 80, 40); b.rectC(15, 2, 2, 2, 207, 233, 255); }
  else if (kind === 'wizard') { b.rectC(15, -4, 2, 3, 58, 29, 74); b.rectC(14, -1, 4, 2, 58, 29, 74); b.rectC(13, 1, 6, 2, 70, 40, 92); b.rectC(10, 3, 12, 1, 127, 249, 224); b.setC(16, -2, 255, 242, 127); }
  else if (kind === 'beanie') { b.rectC(11, 1, 10, 3, 255, 90, 60); b.rectC(11, 4, 10, 1, 253, 253, 253); b.rectC(15, -1, 2, 2, 253, 253, 253); }
  else if (kind === 'tophat') { b.rectC(10, 4, 12, 1, 17, 19, 28); b.rectC(12, -4, 8, 8, 17, 19, 28); b.rectC(12, 1, 8, 1, 127, 249, 224); }
  else if (kind === 'crown') { b.rectC(11, 2, 10, 2, 255, 207, 60); b.setC(11, 0, 255, 207, 60); b.setC(11, 1, 255, 207, 60); b.setC(16, 0, 255, 207, 60); b.setC(16, 1, 255, 207, 60); b.setC(20, 0, 255, 207, 60); b.setC(20, 1, 255, 207, 60); b.setC(15, 2, 255, 90, 60); }
  else if (kind === 'halo') { b.ellC(16, -1, 4, 1, 255, 242, 127); b.ellC(16, -1, 3, 1, 0, 0, 0, 0); }
  return b;
}

// ---- ACCESSORIES (fixed colour) — on the chest ----
function accStyle(kind) {
  const b = new Buf();
  if (kind === 'bowtie') { b.rectC(15, 12, 2, 2, 255, 90, 60); b.rectC(13, 12, 2, 2, 255, 90, 60); b.rectC(17, 12, 2, 2, 255, 90, 60); }
  else if (kind === 'scarf') { b.rectC(11, 11, 10, 2, 255, 158, 44); b.rectC(13, 13, 2, 3, 255, 158, 44); }
  else if (kind === 'fish') { b.rectC(14, 15, 4, 3, 127, 249, 224); b.rectC(14, 15, 4, 1, 255, 255, 255); b.setC(15, 16, 17, 19, 28); }
  else if (kind === 'badge') { b.rectC(12, 15, 2, 2, 156, 255, 90); b.setC(12, 15, 230, 255, 200); }
  else if (kind === 'chain') { b.rectC(13, 13, 6, 1, 255, 207, 60); b.rectC(15, 14, 2, 2, 255, 207, 60); }
  return b;
}

// ---- CAPES (tint: capeColor) — flow behind the body; styles differ by SHAPE ----
function capeBody(spread, fn) {
  const b = new Buf(); const v = 230, sh = 175, dk = 140;
  b.rect(10, 12, 12, 2, v);
  for (let y = 14; y <= 30; y++) {
    const s = Math.round((y - 13) * spread), x0 = 11 - s, x1 = 20 + s;
    for (let x = x0; x <= x1; x++) { const fold = ((x + (y & 1)) % 4 === 0); b.set(x, y, fold ? dk : (x < 16 ? v : sh)); }
  }
  if (fn) fn(b, v, sh, dk);
  b.outline(55); return b;
}
function capeStyle(kind) {
  if (kind === 'classic') return capeBody(0.45);
  if (kind === 'long') return capeBody(0.35, (b) => { for (let y = 31; y <= 33; y++) b.rect(13, y, 6, 1, 175); });
  if (kind === 'round') return capeBody(0.6);
  if (kind === 'royal') return capeBody(0.5, (b) => { b.rect(15, 14, 2, 16, 250); });
  if (kind === 'tattered') return capeBody(0.5, (b) => { for (let x = 7; x <= 25; x += 2) { b.clr(x, 30); b.clr(x, 29); } });
  return capeBody(0.45);
}

// =============================================================================
// TUX  (the penguin) — looks good already; eyes/hat/acc shifted down at runtime
// =============================================================================
function tuxBody() { const b = new Buf(); b.ell(16, 18, 9, 12, 235); b.ell(7, 18, 2, 5, 220); b.ell(25, 18, 2, 5, 220); for (let y = 8; y <= 28; y++) b.set(23, y, 195, 150); b.outline(70); return b; }
function tuxBelly() { const b = new Buf(); b.ell(16, 19, 6, 9, 245); for (let y = 12; y <= 27; y++) b.set(20, y, 215, 130); return b; }
function tuxFeet() { const b = new Buf(); b.rect(10, 30, 5, 2, 240); b.rect(17, 30, 5, 2, 240); b.outline(70); return b; }
function tuxBeak() { const b = new Buf(); b.rect(14, 11, 4, 2, 248); b.row(15, 17, 13, 220); b.outline(70); return b; }

// =============================================================================
// BUILD
// =============================================================================
function save(rel, buf) { const file = path.join(OUT, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, encodePNG(buf.w, buf.h, buf.d)); return rel.replace(/\\/g, '/'); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const manifest = { grid: { w: GW, h: GH }, base: {}, catalog: {} };
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
manifest.catalog.hat = ['none', 'cap', 'wizard', 'beanie', 'tophat', 'crown', 'halo'].map(k => ({ id: k, name: k === 'cap' ? 'Vim Cap' : cap(k), file: k === 'none' ? null : save('hat/' + k + '.png', hatStyle(k)) }));
manifest.catalog.accessory = ['none', 'bowtie', 'scarf', 'fish', 'badge', 'chain'].map(k => ({ id: k, name: k === 'fish' ? "Fisherman's" : cap(k), file: k === 'none' ? null : save('acc/' + k + '.png', accStyle(k)) }));
manifest.catalog.cape = ['none', 'classic', 'long', 'round', 'royal', 'tattered'].map(k => ({ id: k, name: cap(k), file: k === 'none' ? null : save('cape/' + k + '.png', capeStyle(k)) }));

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
let count = 0; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.png')) count++; } })(OUT);
console.log('Baked ' + count + ' PNGs + manifest.json');
