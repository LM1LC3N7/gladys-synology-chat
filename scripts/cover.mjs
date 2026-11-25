// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a blue-grey gradient, two
// chat bubbles (one with lines of text, one with a dotted reply) and a link
// to a small house. Plain Node (zlib), no dependency, no Synology logo.
// Run: npm run cover
// -----------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
/** Antialiased coverage of a signed distance (negative inside). */
const inside = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance to the segment (ax, ay)-(bx, by). */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

const DARK = [14, 22, 38];
const LIGHT = [30, 70, 120];
const BUBBLE = [235, 242, 250];
const BUBBLE2 = [64, 150, 230];
const TEXT = [120, 140, 165];
const WHITE = [250, 252, 255];
const LINK = [170, 215, 255];

function pixel(x, y) {
  let color = mix(DARK, LIGHT, (x / WIDTH) * 0.6 + (y / HEIGHT) * 0.4);
  // First bubble (left), with its tail and three lines of text.
  const b1 = Math.min(
    roundRect(x, y, 300, 190, 190, 80, 28),
    segment(x, y, 150, 255, 130, 300) - 14,
  );
  color = mix(color, [0, 0, 0], inside(b1 - 10) * 0.25);
  color = mix(color, BUBBLE, inside(b1));
  for (const [i, w] of [
    [0, 140],
    [1, 120],
    [2, 80],
  ]) {
    color = mix(color, TEXT, inside(roundRect(x, y, 160 + w, 150 + i * 40, w, 9, 9)));
  }
  // Second bubble (right), a reply with three dots.
  const b2 = Math.min(
    roundRect(x, y, 520, 350, 170, 64, 28),
    segment(x, y, 660, 400, 690, 440) - 14,
  );
  color = mix(color, [0, 0, 0], inside(b2 - 10) * 0.25);
  color = mix(color, BUBBLE2, inside(b2));
  for (let i = 0; i < 3; i += 1) {
    color = mix(color, WHITE, inside(Math.hypot(x - (470 + i * 50), y - 350) - 14));
  }
  // A dotted link to a small house, top right.
  const link = segment(x, y, 520, 150, 640, 110);
  const along = Math.hypot(x - 520, y - 150) % 22;
  color = mix(color, LINK, inside(link - 3) * (along < 12 ? 0.9 : 0));
  const roof = segment(x, y, 640, 110, 680, 75) - 5;
  const roof2 = segment(x, y, 680, 75, 720, 110) - 5;
  color = mix(color, LINK, Math.max(inside(roof), inside(roof2)));
  color = mix(color, LINK, inside(roundRect(x, y, 680, 135, 32, 26, 4)));
  color = mix(color, LIGHT, inside(roundRect(x, y, 680, 145, 10, 16, 2)));
  return color;
}
const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
