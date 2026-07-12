'use strict';

/**
 * Generates build/icon.png (512x512) with zero dependencies — a dark rounded
 * tile with a concentric "radar sweep" ring motif in CultWatch amber. Run:
 *   node scripts/gen-icon.js
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 512;
const buf = Buffer.alloc(S * S * 4);

// palette
const BG1 = [18, 14, 20];
const BG2 = [10, 13, 22];
const AMBER = [255, 122, 26];
const RED = [255, 59, 87];

function set(x, y, r, g, b, a) {
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}
function mix(c1, c2, t) {
  return [Math.round(c1[0] + (c2[0] - c1[0]) * t), Math.round(c1[1] + (c2[1] - c1[1]) * t), Math.round(c1[2] + (c2[2] - c1[2]) * t)];
}

const cx = S / 2, cy = S / 2;
const radius = 96; // rounded-corner radius
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // rounded-rect alpha
    const dx = Math.max(radius - x, x - (S - radius), 0);
    const dy = Math.max(radius - y, y - (S - radius), 0);
    const corner = Math.sqrt(dx * dx + dy * dy);
    let a = 255;
    if (corner > radius) { set(x, y, 0, 0, 0, 0); continue; }
    if (corner > radius - 2) a = Math.round(255 * (radius - corner) / 2);

    // radial background gradient
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    const t = Math.min(1, d / (S * 0.7));
    let [r, g, b] = mix(BG1, BG2, t);

    // concentric rings
    for (const [rr, col, w] of [[70, AMBER, 6], [120, AMBER, 5], [175, RED, 4]]) {
      const dist = Math.abs(d - rr);
      if (dist < w) {
        const glow = 1 - dist / w;
        [r, g, b] = mix([r, g, b], col, glow * 0.9);
      }
    }
    // center dot
    if (d < 26) { const glow = 1 - d / 26; [r, g, b] = mix([r, g, b], AMBER, glow); }

    // sweep line (radar arm) from center up-right
    const ang = Math.atan2(y - cy, x - cx);
    const target = -Math.PI / 4;
    let da = Math.abs(ang - target);
    if (da > Math.PI) da = 2 * Math.PI - da;
    if (da < 0.12 && d < 185 && d > 24) {
      const glow = (1 - da / 0.12) * (1 - d / 185);
      [r, g, b] = mix([r, g, b], AMBER, glow * 0.85);
    }

    set(x, y, r, g, b, a);
  }
}

fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), encodePng(buf, S, S));
console.log('wrote build/icon.png');

// --- minimal PNG encoder (truecolor + alpha) ---
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(w, h)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ];
  return Buffer.concat(chunks);
}
function ihdr(w, h) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4);
  b[8] = 8; b[9] = 6; b[10] = 0; b[11] = 0; b[12] = 0; // 8-bit, RGBA
  return b;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
var CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
