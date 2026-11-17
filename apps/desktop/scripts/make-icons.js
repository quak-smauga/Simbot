// Ikony z logo „koło z oczami” (apps/chat/public/ui/logo.js) — bez zależności: rasteryzacja z supersamplingiem + PNG przez zlib.
//   assets/tray-{idle,blink,working,waiting}Template(.png|@2x.png)   pasek menu (template = czarny + alfa, macOS sam koloruje)
//   assets/icon.png                                                   dock (512 px)
// Uruchom: pnpm --filter @qwe/desktop icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const OUT = resolve(import.meta.dirname, '..', 'assets');
mkdirSync(OUT, { recursive: true });

function png(w, h, rgba) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** shape(x, y) w układzie 0..100 → 0 (puste) | 1 (pełne). Supersampling 5×5 na piksel. */
function raster(size, shape, color = [0, 0, 0], bg = null) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 5;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let cov = 0, bgCov = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const x = ((px + (sx + 0.5) / S) / size) * 100, y = ((py + (sy + 0.5) / S) / size) * 100;
      if (shape(x, y)) cov++;
      if (bg && bg.shape(x, y)) bgCov++;
    }
    const a = cov / (S * S), b = bg ? bgCov / (S * S) : 0;
    const i = (py * size + px) * 4;
    if (bg) { // logo na tle (dock): mieszanie koloru logo z kolorem tła
      const outA = b;
      for (let k = 0; k < 3; k++) buf[i + k] = Math.round(color[k] * a + bg.color[k] * (1 - a));
      buf[i + 3] = Math.round(255 * outA);
    } else { buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = Math.round(255 * a); }
  }
  return buf;
}

const d = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);
const ring = (x, y, R = 38, W = 15) => Math.abs(d(x, y, 50, 50) - R) <= W / 2;
const eyes = (x, y, dx = 0, dy = 0, r = 7) => d(x, y, 39 + dx, 50 + dy) <= r || d(x, y, 61 + dx, 50 + dy) <= r;
const lids = (x, y) => Math.abs(y - 51) <= 2.2 && ((x >= 32 && x <= 46) || (x >= 54 && x <= 68));

const tray = {
  idle: (x, y) => ring(x, y) || eyes(x, y),
  blink: (x, y) => ring(x, y) || lids(x, y),
  // pracuje: oczy patrzą w bok, w kole szczelina (jak przy kręceniu się)
  working: (x, y) => (ring(x, y) && !(x > 50 && y < 50 && Math.abs(Math.atan2(50 - y, x - 50) - Math.PI / 4) < 0.42)) || eyes(x, y, 5, -2),
  // czeka na Ciebie: plakietka w prawym górnym rogu, wycięta z koła
  waiting: (x, y) => (d(x, y, 84, 16) <= 15) || ((ring(x, y) || eyes(x, y)) && d(x, y, 84, 16) > 22),
};
for (const [name, shape] of Object.entries(tray)) {
  writeFileSync(resolve(OUT, `tray-${name}Template.png`), png(18, 18, raster(18, shape)));
  writeFileSync(resolve(OUT, `tray-${name}Template@2x.png`), png(36, 36, raster(36, shape)));
}

// dock: ciemny zaokrąglony kwadrat (macOS ~ 824/1024 pola, promień ~ 22%), jasne logo
const inset = 9, rad = 18;
const square = (x, y) => { const lo = inset, hi = 100 - inset; const cx = Math.min(Math.max(x, lo + rad), hi - rad), cy = Math.min(Math.max(y, lo + rad), hi - rad); return d(x, y, cx, cy) <= rad && x >= lo && x <= hi && y >= lo && y <= hi; };
const logo = (x, y) => { const s = 1.85, X = 50 + (x - 50) * s, Y = 50 + (y - 50) * s; return ring(X, Y, 40, 17) || eyes(X, Y, 1, 0, 5.6); };
writeFileSync(resolve(OUT, 'icon.png'), png(512, 512, raster(512, logo, [241, 241, 236], { shape: square, color: [25, 26, 25] })));
console.log(`ikony → ${OUT}`);
