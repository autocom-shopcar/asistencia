// Genera los íconos PNG de la app sin dependencias: node crear-iconos.js
const fs = require('fs'), zlib = require('zlib'), path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(tipo, datos) {
  const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
  const td = Buffer.concat([Buffer.from(tipo), datos]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const filas = [];
  for (let y = 0; y < size; y++) {
    const fila = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) fila.set(pixel(x / size, y / size), 1 + x * 4);
    filas.push(fila);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(filas))), chunk('IEND', Buffer.alloc(0))]);
}

// Ícono de Asistencia: silueta de rostro dentro de un marco de enfoque y una palomita verde.
const FONDO = [11, 18, 32, 255], MARCO = [59, 130, 246, 255], CARA = [230, 236, 247, 255], VERDE = [34, 197, 94, 255];
function dibujo(m, redondo) {
  return (x, y) => {
    if (redondo) {
      const r = 0.2, cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];
    }
    const u = 0.5 + (x - 0.5) / m, v = 0.5 + (y - 0.5) / m;
    // Palomita en círculo verde (abajo a la derecha)
    const dc = Math.hypot(u - 0.74, v - 0.74);
    if (dc < 0.15) {
      const enLinea = (ax, ay, bx, by) => {
        const t = Math.max(0, Math.min(1, ((u - ax) * (bx - ax) + (v - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
        return Math.hypot(u - (ax + t * (bx - ax)), v - (ay + t * (by - ay))) < 0.022;
      };
      return enLinea(0.67, 0.74, 0.72, 0.8) || enLinea(0.72, 0.8, 0.82, 0.68) ? CARA : VERDE;
    }
    if (dc < 0.17) return FONDO;
    // Esquinas del marco de enfoque
    const enEsquina = (cx, cy, sx, sy) => {
      const du = (u - cx) * sx, dv = (v - cy) * sy;
      return (du >= 0 && du < 0.16 && dv >= 0 && dv < 0.04) || (dv >= 0 && dv < 0.16 && du >= 0 && du < 0.04);
    };
    if (enEsquina(0.14, 0.14, 1, 1) || enEsquina(0.86, 0.14, -1, 1) || enEsquina(0.14, 0.86, 1, -1)) return MARCO;
    // Cabeza y hombros
    if (((u - 0.5) / 0.15) ** 2 + ((v - 0.4) / 0.18) ** 2 < 1) return CARA;
    if (v > 0.62 && v < 0.8 && ((u - 0.5) / 0.27) ** 2 + ((v - 0.8) / 0.18) ** 2 < 1) return CARA;
    return FONDO;
  };
}
const dir = path.join(__dirname, 'icons');
fs.writeFileSync(path.join(dir, 'icon-192.png'), png(192, dibujo(1, true)));
fs.writeFileSync(path.join(dir, 'icon-512.png'), png(512, dibujo(1, true)));
fs.writeFileSync(path.join(dir, 'icon-maskable-512.png'), png(512, dibujo(0.72, false)));
console.log('Íconos creados en', dir);
