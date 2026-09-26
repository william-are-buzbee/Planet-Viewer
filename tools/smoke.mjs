// tools/smoke.mjs — runs the whole generation stack under Node, no browser.
//
//   node tools/smoke.mjs            (≈25 s: planet + hi-res ×1 + region + tile)
//
// Proves the simulation modules load without a DOM and checks a handful of
// invariants. Exit code 1 on any failure. Extend the checks as bugs are fixed.

import { state } from '../state.js';
import { W, H, TOTAL } from '../core-math.js';
import { generatePlanet } from '../planet-gen.js';
import { generateHighResSurface } from '../hires-gen.js';
import { generateRegionalDetail, REGIONAL_SIZE } from '../regional-gen.js';
import { generateTileDetail, CHUNK_TOTAL } from '../tile-gen.js';

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); }
function hasNaN(arr) { for (let i = 0; i < arr.length; i++) if (arr[i] !== arr[i]) return true; return false; }

// Quiet the per-generation console diagnostics; keep our own lines.
const realLog = console.log;
console.log = () => {};
const say = (...a) => realLog(...a);

const seed = Number(process.argv[2] ?? 5);
state.seed = seed;
state.hiResMultiplier = 1;

let t0 = performance.now();
await generatePlanet(seed);
say(`planet   seed=${seed}  ${(performance.now() - t0).toFixed(0)} ms`);
console.log = realLog;

check(state.cells && state.cells.length === TOTAL, `planet grid has ${TOTAL} cells`);
let land = 0, nanElev = 0, nanPrecip = 0, minE = Infinity, maxE = -Infinity;
for (const c of state.cells) {
  if (c.isLand) land++;
  if (c.elevation !== c.elevation) nanElev++;
  if (c.precipitation !== c.precipitation) nanPrecip++;
  if (c.elevation < minE) minE = c.elevation;
  if (c.elevation > maxE) maxE = c.elevation;
}
const landFrac = land / TOTAL;
check(nanElev === 0 && nanPrecip === 0, 'no NaN in planetary elevation / precipitation');
check(landFrac > 0.01 && landFrac < 0.6, `land fraction plausible (${(landFrac * 100).toFixed(1)}%)`);
check(maxE > 0.2 && minE < -0.2, `elevation range plausible (${minE.toFixed(2)} … ${maxE.toFixed(2)})`);
check(state.plates.length >= 4, `${state.plates.length} plates`);

console.log = () => {};
t0 = performance.now();
await generateHighResSurface(seed);
state.planet = state.hiResData;
console.log = realLog;
say(`hi-res   ×${state.hiResMultiplier}  ${(performance.now() - t0).toFixed(0)} ms`);
check(state.hiResData && state.HR_TOTAL === W * H * state.hiResMultiplier ** 2, 'hi-res grid allocated');
check(!hasNaN(state.hiResData.elevation) && !hasNaN(state.hiResData.groundwater), 'no NaN in hi-res elevation / groundwater');
let coloured = 0;
for (let i = 0; i < state.HR_TOTAL; i += 97) if (state.hiResData.colorR[i] || state.hiResData.colorG[i] || state.hiResData.colorB[i]) coloured++;
check(coloured > 0, 'hi-res colours computed');
// A2: a hi-res land cell whose planetary footprint gives NON-ZERO bilinear weight
// to at least one land cell must never carry the ocean sentinel (groundwater 1.0).
// Cells with no weighted land corner (noise-flipped land inside a planetary-ocean
// cell; at ×1 that is every such pixel, since only its own cell has weight) still
// fall back to plain bilinear and do carry it — tracked as A8 in DIAGNOSTIC.md.
let sentinelWithLandWeight = 0, sentinelNoLandWeight = 0;
{
  const m = state.hiResMultiplier, hr = state.hiResData;
  for (let hy = 0; hy < state.HR_H; hy++) for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;
    if (!hr.isLand[hi] || hr.groundwater[hi] < 0.999) continue;
    const lx = hx / m, ly = hy / m, x0 = Math.floor(lx), y0 = Math.floor(ly), fx = lx - x0, fy = ly - y0;
    const corners = [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]];
    let landWeight = 0;
    for (const [cx, cy, w] of corners) if (w > 0 && state.cells[Math.max(0, Math.min(H - 1, cy)) * W + ((cx % W) + W) % W].isLand) landWeight += w;
    if (landWeight > 0) sentinelWithLandWeight++; else sentinelNoLandWeight++;
  }
}
check(sentinelWithLandWeight === 0, `no hi-res land cell with weighted land in its footprint carries the ocean sentinel (${sentinelWithLandWeight}; ${sentinelNoLandWeight} cells with no weighted land corner still do — A8)`);

// A land cell with some elevation for the regional / tile checks
let px = -1, py = -1;
for (let y = 40; y < H - 40 && px < 0; y++) for (let x = 0; x < W; x++) {
  const c = state.cells[y * W + x];
  if (c.isLand && c.elevation > 0.08) { px = x; py = y; break; }
}
check(px >= 0, `found a land cell for the regional test (${px}, ${py})`);

console.log = () => {};
t0 = performance.now();
generateRegionalDetail(px + 0.5, py + 0.5);
console.log = realLog;
say(`regional ${REGIONAL_SIZE}²  ${(performance.now() - t0).toFixed(0)} ms`);
const rc = state.regionalCells;
check(rc && rc.length === REGIONAL_SIZE && rc[0].length === REGIONAL_SIZE, 'regional grid populated');
let rLand = 0, rNaN = 0, rWater = 0;
for (let rx = 0; rx < REGIONAL_SIZE; rx += 3) for (let ry = 0; ry < REGIONAL_SIZE; ry += 3) {
  const c = rc[rx][ry];
  if (c.isLand) rLand++;
  if (c.elevation !== c.elevation || c.saturation !== c.saturation) rNaN++;
  if (c.hasWater) rWater++;
}
check(rNaN === 0, 'no NaN in regional elevation / saturation');
check(rLand > 0, 'regional window contains land');
const centre = rc[REGIONAL_SIZE / 2][REGIONAL_SIZE / 2];
check(Math.abs(centre.worldX / REGIONAL_SIZE - (px + 0.5)) < 1e-3, 'regional window is centred on the requested point (A3)');

// Determinism: the same window twice must be bit-identical
const before = Float32Array.from({ length: 64 }, (_, i) => rc[i * 8][i * 8].elevation);
console.log = () => {};
generateRegionalDetail(px + 0.5, py + 0.5);
console.log = realLog;
const after = Float32Array.from({ length: 64 }, (_, i) => state.regionalCells[i * 8][i * 8].elevation);
check(before.every((v, i) => v === after[i]), 'regional generation is deterministic for a fixed seed');

// Tile chunk on a land regional cell near the middle
let rx = -1, ry = -1;
for (let r = 0; r < 200 && rx < 0; r++) for (let a = 0; a < 8; a++) {
  const x = 256 + Math.round(r * Math.cos(a)), y = 256 + Math.round(r * Math.sin(a));
  const c = state.regionalCells[x] && state.regionalCells[x][y];
  if (c && c.isLand) { rx = x; ry = y; break; }
}
check(rx >= 0, `found a land regional cell for the tile test (${rx}, ${ry})`);
console.log = () => {};
t0 = performance.now();
generateTileDetail(rx, ry);
console.log = realLog;
say(`tile     ${Math.sqrt(CHUNK_TOTAL)}²  ${(performance.now() - t0).toFixed(0)} ms`);
const t = state.currentTileData && state.currentTileData.tiles;
check(!!t && t.elevation.length === CHUNK_TOTAL, 'tile chunk populated');
check(t && !hasNaN(t.elevation) && !hasNaN(t.saturation), 'no NaN in tile elevation / saturation');
check(state.tileChunkCache.has(`${rx},${ry}`), 'tile chunk cached');

say(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
