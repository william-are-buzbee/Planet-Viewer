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
state.hiResMultiplier = 2;   // ×2 so hi-res footprints mix land and ocean corners (A2 has nothing to test at ×1)

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
// A2: for every hi-res land cell, the stored groundwater must equal the LAND-MASKED
// bilinear of the planetary grid (ocean corners zero-weighted, renormalised).
// Cells whose footprint has no weighted land corner at all (noise-flipped land
// inside a planetary-ocean cell) fall back to plain bilinear and inherit the ocean
// sentinels — that residue is counted here and tracked as A8 in DIAGNOSTIC.md.
let maskMismatch = 0, mixedCells = 0, noLandWeight = 0;
{
  const m = state.hiResMultiplier, hr = state.hiResData;
  for (let hy = 0; hy < state.HR_H; hy++) for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;
    if (!hr.isLand[hi]) continue;
    const lx = hx / m, ly = hy / m, x0 = Math.floor(lx), y0 = Math.floor(ly), fx = lx - x0, fy = ly - y0;
    const corners = [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]];
    let landW = 0, oceanW = 0, acc = 0;
    for (const [cx, cy, w] of corners) {
      if (w <= 0) continue;
      const c = state.cells[Math.max(0, Math.min(H - 1, cy)) * W + ((cx % W) + W) % W];
      if (c.isLand) { landW += w; acc += w * c.groundwater; } else oceanW += w;
    }
    if (landW === 0) { noLandWeight++; continue; }
    if (oceanW > 0) {
      mixedCells++;
      if (Math.abs(hr.groundwater[hi] - acc / landW) > 1e-4) maskMismatch++;
    }
  }
}
check(mixedCells > 0, `hi-res land cells with mixed land/ocean footprints exist to test (${mixedCells})`);
check(maskMismatch === 0, `A2: stored groundwater equals the land-masked bilinear on every mixed cell (${maskMismatch} mismatches; ${noLandWeight} cells with no weighted land corner keep the sentinel — A8)`);

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
check(rc && rc.S === REGIONAL_SIZE && rc.elevation.length === REGIONAL_SIZE * REGIONAL_SIZE, 'regional grid populated (struct-of-arrays)');
check(!hasNaN(rc.elevation) && !hasNaN(rc.saturation) && !hasNaN(rc.waterTableDepth), 'no NaN in regional elevation / saturation / WTD');
let rLand = 0, rMaxElev = -Infinity;
for (let i = 0; i < rc.N; i++) { if (rc.isLand[i]) rLand++; if (rc.elevation[i] > rMaxElev) rMaxElev = rc.elevation[i]; }
check(rMaxElev > 1 && rMaxElev < 12000, `regional elevation is in metres (max ${rMaxElev.toFixed(0)} m in this window)`);
check(rLand > 0, 'regional window contains land');
const centre = rc.cell(REGIONAL_SIZE / 2, REGIONAL_SIZE / 2);
check(Math.abs(centre.worldX / REGIONAL_SIZE - (px + 0.5)) < 1e-3, 'regional window is centred on the requested point (A3)');
check(typeof centre.zone === 'string' && typeof centre.terrainType === 'string', 'cell(rx, ry) materialises named fields');
{
  // Memory: 512² cells of typed arrays should be a few tens of MB, not hundreds
  let bytes = 0;
  for (const k of Object.keys(rc)) if (ArrayBuffer.isView(rc[k])) bytes += rc[k].byteLength;
  check(bytes < 60 * 1024 * 1024, `regional grid is ${(bytes / 1048576).toFixed(1)} MB of typed arrays (B3)`);
}

// Determinism: the same window twice must be bit-identical
const before = Float32Array.from({ length: 64 }, (_, i) => rc.elevation[rc.idx(i * 8, i * 8)]);
console.log = () => {};
generateRegionalDetail(px + 0.5, py + 0.5);
console.log = realLog;
const after = Float32Array.from({ length: 64 }, (_, i) => state.regionalCells.elevation[state.regionalCells.idx(i * 8, i * 8)]);
check(before.every((v, i) => v === after[i]), 'regional generation is deterministic for a fixed seed');

// B4: rivers continue across adjacent windows. Centre a window on the planetary
// cell holding the planet's biggest hi-res river, find the window edge the river
// leaves through, generate the neighbouring window on that side, and require
// that every stream-order≥3 cell on the shared edge meets one within ±3 cells.
{
  const hr = state.hiResData, m = state.hiResMultiplier;
  let best = -1, bestF = 0;
  for (let i = 0; i < hr.flowAccum.length; i++) if (hr.isLand[i] && hr.flowAccum[i] > bestF) { bestF = hr.flowAccum[i]; best = i; }
  const rpx = ((best % state.HR_W) + 0.5) / m, rpy = (Math.floor(best / state.HR_W) + 0.5) / m;
  console.log = () => {};
  generateRegionalDetail(rpx, rpy);
  console.log = realLog;
  const A = state.regionalCells, S = REGIONAL_SIZE;
  const edges = {
    east:  { cells: [], nb: [rpx + 1, rpy], pick: k => A.idx(S - 1, k), other: (B, k) => B.idx(0, k) },
    west:  { cells: [], nb: [rpx - 1, rpy], pick: k => A.idx(0, k),     other: (B, k) => B.idx(S - 1, k) },
    south: { cells: [], nb: [rpx, rpy + 1], pick: k => A.idx(k, S - 1), other: (B, k) => B.idx(k, 0) },
    north: { cells: [], nb: [rpx, rpy - 1], pick: k => A.idx(k, 0),     other: (B, k) => B.idx(k, S - 1) },
  };
  let riverCells = 0, maxFlow = 0;
  for (let i = 0; i < A.N; i++) { if (A.isLand[i] && A.streamOrder[i] >= 3) riverCells++; if (A.flowAccum[i] > maxFlow) maxFlow = A.flowAccum[i]; }
  check(riverCells > 0, `B4: the window on the planet's biggest land river cell shows a river (${riverCells} cells of stream order ≥ 3)`);
  check(A.inflowTotalKm2 === 0 || maxFlow >= 0.5 * A.inflowTotalKm2, `B4: injected border inflow reaches an outlet (${A.inflowTotalKm2.toFixed(0)} km² injected, ${maxFlow.toFixed(0)} km² at the biggest cell, ${A.outflowKm2.toFixed(0)} km² left through the border)`);
  for (const e of Object.values(edges)) for (let k = 0; k < S; k++) { const i = e.pick(k); if (A.isLand[i] && A.streamOrder[i] >= 3) e.cells.push(k); }
  const [name, e] = Object.entries(edges).sort((a, b) => b[1].cells.length - a[1].cells.length)[0];
  if (e.cells.length >= 3) {
    console.log = () => {};
    generateRegionalDetail(e.nb[0], e.nb[1]);
    console.log = realLog;
    const B = state.regionalCells;
    // Measure at the neighbour's EXITS: every cell where B's river actually leaves
    // through the shared edge (flowDir 255, stream order ≥ 3) must meet a river
    // cell on A's edge within ±10 cells (≈1.5 km of a 78 km edge). The crossing
    // gap itself is 5 cells wide and identical on both sides by construction; the
    // slack is for the corridor each window's water runs along its border wall
    // before turning in or out, which can start a few cells either side of the gap.
    const bExits = [];
    for (let k = 0; k < S; k++) { const i = e.other(B, k); if (B.isLand[i] && B.streamOrder[i] >= 3 && B.flowDir[i] === 255) bExits.push(k); }
    const aSet = new Set(e.cells);
    let matched = 0;
    for (const k of bExits) { let hit = false; for (let d = -10; d <= 10 && !hit; d++) if (aSet.has(k + d)) hit = true; if (hit) matched++; }
    check(bExits.length > 0 && matched === bExits.length, `B4: river crossing the ${name} edge continues in the next window (${matched}/${bExits.length} of the neighbour's exit cells meet this window's river; exits at rows ${bExits.join(',')})`);
  } else {
    check(true, `B4: river does not reach any window edge here (best edge has ${e.cells.length} cells) — continuity not testable on this seed`);
  }
  console.log = () => {};
  generateRegionalDetail(px + 0.5, py + 0.5);   // back to the first window for the tile checks
  console.log = realLog;
}

// Tile chunk on a land regional cell near the middle
let rx = -1, ry = -1;
for (let r = 0; r < 200 && rx < 0; r++) for (let a = 0; a < 8; a++) {
  const x = 256 + Math.round(r * Math.cos(a)), y = 256 + Math.round(r * Math.sin(a));
  const c = state.regionalCells.cell(x, y);
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
check(Math.sqrt(CHUNK_TOTAL) === 128, 'tile chunk is 128×128 (one regional cell, ≈1.19 m tiles)');
{
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < CHUNK_TOTAL; i++) { const e = t.elevation[i]; if (e < mn) mn = e; if (e > mx) mx = e; }
  check(mx - mn < 15, `tile micro-relief inside one regional cell is metres-scale (${(mx - mn).toFixed(2)} m)`);
}
check(state.tileChunkCache.has(`${rx},${ry}`), 'tile chunk cached');
{
  // B4: a chunk whose regional cell receives no significant inflow must not invent a river
  const g = state.regionalCells, ci = g.idx(rx, ry);
  let so3 = 0; for (let i = 0; i < CHUNK_TOTAL; i++) if (t.streamOrder[i] >= 3) so3++;
  if (g.streamOrder[ci] < 3) check(so3 === 0, `B4: regional cell has stream order ${g.streamOrder[ci]}, its chunk has ${so3} river tiles (expect 0)`);
  else check(so3 > 0, `B4: regional cell has stream order ${g.streamOrder[ci]}, its chunk carries the river (${so3} river tiles)`);
}

say(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
