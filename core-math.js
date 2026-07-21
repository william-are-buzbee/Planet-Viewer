// ══════════════════════════════════════════════════════════════════
// ── core-math.js — Noise, RNG, coordinate utilities, color helpers ──
// ══════════════════════════════════════════════════════════════════

// ── Constants ──
export const W = 512, H = 256;
export const TOTAL = W * H;

// ── PRNG: mulberry32 ──
export function mulberry32(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Noise ──
export function hashInt(x, y, seed) {
  let h = (seed & 0xffffffff) + (x * 374761393) + (y * 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function noise2D(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hashInt(ix, iy, seed);
  const n10 = hashInt(ix + 1, iy, seed);
  const n01 = hashInt(ix, iy + 1, seed);
  const n11 = hashInt(ix + 1, iy + 1, seed);
  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return (nx0 + (nx1 - nx0) * sy) * 2 - 1; // map to -1..1
}

export function fractalNoise(x, y, seed, octaves, baseScale) {
  let value = 0, amplitude = 1, frequency = baseScale, totalAmp = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise2D(x * frequency, y * frequency, seed + i * 1000);
    totalAmp += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / totalAmp;
}

// ── 3D noise for wrapping x-axis ──
export function hashInt3D(x, y, z, seed) {
  let h = (seed & 0xffffffff) + (x * 374761393) + (y * 668265263) + (z * 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function noise3D(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const n000 = hashInt3D(ix,   iy,   iz,   seed);
  const n100 = hashInt3D(ix+1, iy,   iz,   seed);
  const n010 = hashInt3D(ix,   iy+1, iz,   seed);
  const n110 = hashInt3D(ix+1, iy+1, iz,   seed);
  const n001 = hashInt3D(ix,   iy,   iz+1, seed);
  const n101 = hashInt3D(ix+1, iy,   iz+1, seed);
  const n011 = hashInt3D(ix,   iy+1, iz+1, seed);
  const n111 = hashInt3D(ix+1, iy+1, iz+1, seed);
  const nx00 = n000 + (n100 - n000) * ux;
  const nx10 = n010 + (n110 - n010) * ux;
  const nx01 = n001 + (n101 - n001) * ux;
  const nx11 = n011 + (n111 - n011) * ux;
  const nxy0 = nx00 + (nx10 - nx00) * uy;
  const nxy1 = nx01 + (nx11 - nx01) * uy;
  return (nxy0 + (nxy1 - nxy0) * uz) * 2 - 1; // map to -1..1
}

export function fractalNoise3D(x, y, z, seed, octaves, scale) {
  let value = 0, amplitude = 1, frequency = scale, totalAmp = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise3D(x * frequency, y * frequency, z * frequency, seed + i * 1000);
    totalAmp += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / totalAmp;
}

// Map x to a circle in 3D so x=0 and x=W land on the same point,
// producing seamless wrapping on the x-axis.
export function wrappedNoise(x, y, seed, octaves, scale) {
  const theta = (x / W) * Math.PI * 2;
  const circleScale = W / (Math.PI * 2); // preserve feature size
  const nx = Math.cos(theta) * circleScale;
  const nz = Math.sin(theta) * circleScale;
  return fractalNoise3D(nx, y, nz, seed, octaves, scale);
}

// ── Precomputed sphere positions for all cells ──
export const spherePos = new Array(W);
for (let cx = 0; cx < W; cx++) {
  spherePos[cx] = new Array(H);
  for (let cy = 0; cy < H; cy++) {
    const lon = (cx / W) * Math.PI * 2 - Math.PI;
    const lat = (cy / H) * Math.PI - Math.PI / 2;
    spherePos[cx][cy] = {
      x: Math.cos(lat) * Math.cos(lon),
      y: Math.sin(lat),
      z: Math.cos(lat) * Math.sin(lon)
    };
  }
}

// Conversion factor: cell distance (at equator) to 3D unit-sphere distance
export const CELL_TO_3D = 2 * Math.PI / W; // ≈ 0.01227

export function dist3D(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

// Sample noise in 3D using sphere position — eliminates ALL grid artifacts
export function sphereNoise(pos, seed, octaves, scale) {
  const s = scale * 100;
  // Offset by irrational numbers to break grid alignment with sphere axes
  return fractalNoise3D(
    pos.x * s + 0.3183,   // ≈ 1/π
    pos.y * s + 0.7071,   // ≈ 1/√2
    pos.z * s + 0.4142,   // ≈ √2 - 1
    seed, octaves, 1.0
  );
}

// ── Utilities ──
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function wrappedDistSq(x1, y1, x2, y2) {
  let dx = Math.abs(x1 - x2);
  if (dx > W / 2) dx = W - dx;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

export function wrappedDist(x1, y1, x2, y2) {
  return Math.sqrt(wrappedDistSq(x1, y1, x2, y2));
}

export function wrapX(x) { return ((x % W) + W) % W; }

// ── Spherical distance (fixes pole pinching) ──
export function toSphere(cellX, cellY) {
  const lon = (cellX / W) * Math.PI * 2 - Math.PI;  // -π to π
  const lat = (cellY / H) * Math.PI - Math.PI / 2;   // -π/2 to π/2 (south to north)
  return {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.sin(lat),
    z: Math.cos(lat) * Math.sin(lon)
  };
}

export function sphericalDist(x1, y1, x2, y2) {
  const a = toSphere(x1, y1);
  const b = toSphere(x2, y2);
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

// Convert a plate drift (2D angle + speed) to a 3D tangent vector on the sphere
export function driftTo3D(centerX, centerY, angleDeg, speed) {
  const lon = (centerX / W) * Math.PI * 2 - Math.PI;
  const lat = (centerY / H) * Math.PI - Math.PI / 2;
  // Local east unit vector
  const ex = -Math.sin(lon), ey = 0, ez = Math.cos(lon);
  // Local north unit vector
  const nx = -Math.cos(lon) * Math.sin(lat), ny = Math.cos(lat), nz = -Math.sin(lon) * Math.sin(lat);
  const a = angleDeg * Math.PI / 180;
  return {
    x: speed * (Math.cos(a) * ex + Math.sin(a) * nx),
    y: speed * (Math.cos(a) * ey + Math.sin(a) * ny),
    z: speed * (Math.cos(a) * ez + Math.sin(a) * nz),
  };
}

export function idx(x, y) { return y * W + wrapX(x); }

export function maxKey(obj) {
  let best = null, bestVal = -Infinity;
  for (const k in obj) {
    if (obj[k] > bestVal) { bestVal = obj[k]; best = k; }
  }
  return best;
}

export function toRad(deg) { return deg * Math.PI / 180; }

export function getLatitudeBand(y) {
  if (y < 25 || y >= 230) return 'polar';
  if (y < 64 || y >= 192) return 'temperate';
  return 'tropical';
}

// ── HSL to RGB helper ──
export function hslToRgb(h, s, l) {
  h /= 360;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: Math.floor(f(0) * 255), g: Math.floor(f(8) * 255), b: Math.floor(f(4) * 255) };
}

// ── Color interpolation ──
export function lerpColor(c1, c2, t) {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
  };
}

// ── Bilinear sample of a high-res typed array (for continuous fields) ──
export function bilinearSampleHR(array, fx, fy, hrW, hrH) {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const dx = fx - x0;
  const dy = fy - y0;

  const cx0 = ((x0 % hrW) + hrW) % hrW;
  const cx1 = ((x0 + 1) % hrW + hrW) % hrW;
  const cy0 = Math.max(0, Math.min(hrH - 1, y0));
  const cy1 = Math.max(0, Math.min(hrH - 1, y0 + 1));

  const v00 = array[cy0 * hrW + cx0];
  const v10 = array[cy0 * hrW + cx1];
  const v01 = array[cy1 * hrW + cx0];
  const v11 = array[cy1 * hrW + cx1];

  const vx0 = v00 + (v10 - v00) * dx;
  const vx1 = v01 + (v11 - v01) * dx;
  return vx0 + (vx1 - vx0) * dy;
}

// ── Nearest-neighbor sample of a high-res typed array (for enum/int fields) ──
export function nearestSampleHR(array, fx, fy, hrW, hrH) {
  const nx = ((Math.round(fx) % hrW) + hrW) % hrW;
  const ny = Math.max(0, Math.min(hrH - 1, Math.round(fy)));
  return array[ny * hrW + nx];
}
