// ══════════════════════════════════════════════════════════════════
// ── hires-gen.js — High-Resolution Surface Generation ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import {
  W, H, noise2D, noise3D,
  clamp, smoothstep, bilinearSampleHR
} from './core-math.js';
import { deriveTerrainAndCover, terrainTypeToInt, coverTypeToInt, intToTerrainType, intToCoverType } from './terrain-derive.js';
import { computeTilePalette } from './palette-compute.js';

// NOTE: regional-gen.js has a separate bilinearInterpolate for the planetary grid.
// This version operates on hi-res typed arrays with direct index access.
function bilinearInterpolate(x, y, accessor) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  function getCell(cx, cy) {
    const wx = ((Math.round(cx) % W) + W) % W;
    const wy = clamp(Math.round(cy), 0, H - 1);
    return state.cells[wy * W + wx];
  }
  const v00 = accessor(getCell(x0, y0));
  const v10 = accessor(getCell(x0 + 1, y0));
  const v01 = accessor(getCell(x0, y0 + 1));
  const v11 = accessor(getCell(x0 + 1, y0 + 1));
  const vx0 = v00 + (v10 - v00) * fx;
  const vx1 = v01 + (v11 - v01) * fx;
  return vx0 + (vx1 - vx0) * fy;
}

function yieldFrame() { return new Promise(r => setTimeout(r, 0)); }

// ── Progress bar helpers ──
function updateProgress(message, percent) {
  const c = document.getElementById('progressContainer');
  const b = document.getElementById('progressBar');
  const t = document.getElementById('progressText');
  if (c) c.style.display = 'inline-block';
  if (b) b.style.width = clamp(percent, 0, 100) + '%';
  if (t) t.textContent = message || '';
}
function hideProgress() {
  const c = document.getElementById('progressContainer');
  const t = document.getElementById('progressText');
  if (c) c.style.display = 'none';
  if (t) t.textContent = '';
}

// Run `fn(hy)` for every high-res row, yielding periodically so the
// progress bar animates. Spreads `label` progress across [pctStart,pctEnd].
async function forEachHRRow(fn, label, pctStart, pctEnd) {
  const rowsPerChunk = 128;  // was ~42 (HR_H/24); reduces yield overhead from ~800ms to ~250ms
  for (let hy = 0; hy < state.HR_H; hy += rowsPerChunk) {
    const end = Math.min(state.HR_H, hy + rowsPerChunk);
    for (let y = hy; y < end; y++) fn(y);
    updateProgress(label, pctStart + (end / state.HR_H) * (pctEnd - pctStart));
    await yieldFrame();
  }
}

// ── Sphere coords for a high-res cell (wrap-safe noise input) ──
function hrSphere(hx, hy) {
  const lat = (hy / state.HR_H) * Math.PI;
  const lon = (hx / state.HR_W) * Math.PI * 2;
  const sinLat = Math.sin(lat);
  return { x: sinLat * Math.cos(lon), y: Math.cos(lat), z: sinLat * Math.sin(lon) };
}

function stepHR1_elevationRow(hy, seed) {
  const ly = hy / state.hiResMultiplier;
  // Precompute y-axis corners (constant for the whole row)
  const y0 = Math.floor(ly);
  const fy = ly - y0;
  const wy0 = clamp(Math.floor(ly), 0, H - 1);
  const wy1 = clamp(y0 + 1, 0, H - 1);
  const row0 = wy0 * W;
  const row1 = wy1 * W;
  const omy = 1 - fy;

  for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;
    const lx = hx / state.hiResMultiplier;

    // Inline bilinear elevation sampling (was bilinearInterpolate call)
    const x0 = Math.floor(lx);
    const fx = lx - x0;
    const wx0 = ((x0 % W) + W) % W;
    const wx1 = ((x0 + 1) % W + W) % W;
    const baseElev = state.cells[row0+wx0].elevation*(1-fx)*omy + state.cells[row0+wx1].elevation*fx*omy
                   + state.cells[row1+wx0].elevation*(1-fx)*fy   + state.cells[row1+wx1].elevation*fx*fy;
    const s = hrSphere(hx, hy);

    // Multi-octave coastline noise (only near sea level)
    let coastNoise = 0, amp = 0.015, freq = 8;
    for (let oct = 0; oct < 4; oct++) {
      coastNoise += noise3D(s.x * freq, s.y * freq, s.z * freq, seed + oct * 131) * amp;
      amp *= 0.5; freq *= 2;
    }
    const coastProximity = Math.exp(-Math.abs(baseElev) * 30);

    // Broader inland terrain variation
    let terrainNoise = 0; amp = 0.008; freq = 4;
    for (let oct = 0; oct < 3; oct++) {
      terrainNoise += noise3D(s.x * freq, s.y * freq, s.z * freq, seed + 777 + oct * 313) * amp;
      amp *= 0.45; freq *= 2.2;
    }

    const elev = baseElev + coastNoise * coastProximity + terrainNoise;
    state.hiResData.elevation[hi] = elev;
    state.hiResData.isLand[hi]         = elev > 0 ? 1 : 0;
    state.hiResData.isShallowWater[hi] = (elev <= 0 && elev > -0.1) ? 1 : 0;
    state.hiResData.isDeepWater[hi]    = elev <= -0.1 ? 1 : 0;
  }
}

// ── Step HR1b: precompute drain direction from wide-window gradient ──
// Replicates the regional Pass 1b wide-window gradient algorithm at hi-res.
// Regional gen looks this up via bilinearSampleHR instead of computing 8
// bilinear elevation samples per cell, saving ~75% of Pass 1b sampling cost.
function stepHR1b_drainDirRow(hy) {
  const GRAD_RADIUS = 3;  // integer cell radius (matches GRAD_RADIUS_HR=3.0 in regional)
  const gradDx = [0, 1, 1, 1, 0, -1, -1, -1];
  const gradDy = [-1, -1, 0, 1, 1, 1, 0, -1];
  const elev = state.hiResData.elevation;
  const HR_W = state.HR_W, HR_H = state.HR_H;

  for (let hx = 0; hx < HR_W; hx++) {
    const hi = hy * HR_W + hx;

    if (elev[hi] <= 0) {
      // Ocean: drain southward (matches regional convention)
      state.hiResData.drainDirX[hi] = 0;
      state.hiResData.drainDirY[hi] = 1;
      continue;
    }

    const centerElev = elev[hi];
    let gx = 0, gy = 0;

    for (let d = 0; d < 8; d++) {
      const sx = hx + gradDx[d] * GRAD_RADIUS;
      const sy = hy + gradDy[d] * GRAD_RADIUS;
      // Wrap x, clamp y (same convention as bilinearSampleHR)
      const wx = ((sx % HR_W) + HR_W) % HR_W;
      const wy = Math.max(0, Math.min(HR_H - 1, sy));
      const sampleElev = elev[wy * HR_W + wx];
      const diff = centerElev - sampleElev;
      gx += gradDx[d] * diff;
      gy += gradDy[d] * diff;
    }

    const gLen = Math.sqrt(gx * gx + gy * gy) || 1;
    state.hiResData.drainDirX[hi] = gx / gLen;
    state.hiResData.drainDirY[hi] = gy / gLen;
  }
}

// ── Step HR2: interpolate atmospheric / mineral fields ──
// Optimization 5: compute planetary grid corners and weights ONCE per cell,
// then inline all field reads. Eliminates 11 redundant floor/mod/clamp
// computations per cell × 2.1M cells.
function stepHR2_atmosphereRow(hy) {
  const ly = hy / state.hiResMultiplier;
  const y0 = Math.floor(ly);
  const fy = ly - y0;
  const wy0 = clamp(y0, 0, H - 1);
  const wy1 = clamp(y0 + 1, 0, H - 1);
  const row0 = wy0 * W;
  const row1 = wy1 * W;
  const omy = 1 - fy;

  for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;
    const lx = hx / state.hiResMultiplier;

    // Compute 4 corner cells and bilinear weights ONCE
    const x0 = Math.floor(lx);
    const fx = lx - x0;
    const wx0 = ((x0 % W) + W) % W;
    const wx1 = ((x0 + 1) % W + W) % W;

    const c00 = state.cells[row0 + wx0];
    const c10 = state.cells[row0 + wx1];
    const c01 = state.cells[row1 + wx0];
    const c11 = state.cells[row1 + wx1];

    const w00 = (1 - fx) * omy;
    const w10 = fx * omy;
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    // Land-only fields: ocean cells carry sentinel values (groundwater 1.0,
    // waterAvailability 1.0, precipitation 0) that must not bleed onto land.
    // For hi-res LAND cells, zero the weight of ocean corners and renormalise.
    // Fall back to plain bilinear when no corner is land (a noise-flipped land
    // pixel sitting inside a planetary-ocean cell).
    let l00 = w00, l10 = w10, l01 = w01, l11 = w11;
    if (state.hiResData.isLand[hi]) {
      l00 = c00.isLand ? w00 : 0;
      l10 = c10.isLand ? w10 : 0;
      l01 = c01.isLand ? w01 : 0;
      l11 = c11.isLand ? w11 : 0;
      const ls = l00 + l10 + l01 + l11;
      if (ls > 0) { l00 /= ls; l10 /= ls; l01 /= ls; l11 /= ls; }
      else        { l00 = w00; l10 = w10; l01 = w01; l11 = w11; }
    }

    // Inline bilinear interpolation for all 12 continuous fields
    state.hiResData.precipitation[hi] = c00.precipitation*l00 + c10.precipitation*l10 + c01.precipitation*l01 + c11.precipitation*l11;
    state.hiResData.groundwater[hi]   = c00.groundwater*l00 + c10.groundwater*l10 + c01.groundwater*l01 + c11.groundwater*l11;
    state.hiResData.waterAvail[hi]    = (c00.waterAvailability||0)*l00 + (c10.waterAvailability||0)*l10 + (c01.waterAvailability||0)*l01 + (c11.waterAvailability||0)*l11;
    state.hiResData.volcanism[hi]     = (c00.volcanism||0)*w00 + (c10.volcanism||0)*w10 + (c01.volcanism||0)*w01 + (c11.volcanism||0)*w11;
    state.hiResData.iron[hi]          = c00.minerals.iron*w00 + c10.minerals.iron*w10 + c01.minerals.iron*w01 + c11.minerals.iron*w11;
    state.hiResData.copper[hi]        = c00.minerals.copper*w00 + c10.minerals.copper*w10 + c01.minerals.copper*w01 + c11.minerals.copper*w11;
    state.hiResData.manganese[hi]     = c00.minerals.manganese*w00 + c10.minerals.manganese*w10 + c01.minerals.manganese*w01 + c11.minerals.manganese*w11;
    state.hiResData.windU[hi]         = (c00.windU||0)*w00 + (c10.windU||0)*w10 + (c01.windU||0)*w01 + (c11.windU||0)*w11;
    state.hiResData.windV[hi]         = (c00.windV||0)*w00 + (c10.windV||0)*w10 + (c01.windV||0)*w01 + (c11.windV||0)*w11;
    state.hiResData.windSpeed[hi]     = (c00.windSpeed||0)*w00 + (c10.windSpeed||0)*w10 + (c01.windSpeed||0)*w01 + (c11.windSpeed||0)*w11;
    state.hiResData.temperature[hi]   = (c00.temperature||0)*w00 + (c10.temperature||0)*w10 + (c01.temperature||0)*w01 + (c11.temperature||0)*w11;
    state.hiResData.sst[hi]           = (c00.sst||0)*w00 + (c10.sst||0)*w10 + (c01.sst||0)*w01 + (c11.sst||0)*w11;

    // Freezing + plate id carried from nearest low-res cell (discrete fields)
    state.hiResData.isFreezing[hi] = c00.isFreezing ? 1 : 0;
    state.hiResData.plateId[hi]    = c00.plateId || 0;
  }
}

// ── Step HR3: substrate (grain size) ──
function stepHR3_substrateRow(hy, seed) {
  for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;

    if (!state.hiResData.isLand[hi]) {
      state.hiResData.grainSize[hi] = state.hiResData.isDeepWater[hi] ? 0.05 : 0.3;
      continue;
    }

    const eL = state.hiResData.elevation[hy * state.HR_W + ((hx - 1 + state.HR_W) % state.HR_W)];
    const eR = state.hiResData.elevation[hy * state.HR_W + ((hx + 1) % state.HR_W)];
    const eU = hy > 0        ? state.hiResData.elevation[(hy - 1) * state.HR_W + hx] : state.hiResData.elevation[hi];
    const eD = hy < state.HR_H - 1 ? state.hiResData.elevation[(hy + 1) * state.HR_W + hx] : state.hiResData.elevation[hi];
    const gradX = (eR - eL) * 0.5, gradY = (eD - eU) * 0.5;
    const slope = Math.sqrt(gradX * gradX + gradY * gradY);

    const elev = state.hiResData.elevation[hi];
    const volc = state.hiResData.volcanism[hi];

    const slopeGrain = Math.min(slope * 3.0, 1);
    const elevGrain  = Math.min(Math.max(0, elev) * 1.5, 0.8);
    const volcGrain  = volc * 0.6;
    let grain = slopeGrain * 0.35 + elevGrain * 0.25 + volcGrain * 0.15 + 0.075;

    // Coastal fining
    if (elev < 0.03) {
      let hasOcean = false;
      const dx4 = [-1, 1, 0, 0], dy4 = [0, 0, -1, 1];
      for (let d = 0; d < 4; d++) {
        const nx = (hx + dx4[d] + state.HR_W) % state.HR_W;
        const ny = hy + dy4[d];
        if (ny >= 0 && ny < state.HR_H && !state.hiResData.isLand[ny * state.HR_W + nx]) { hasOcean = true; break; }
      }
      grain = hasOcean ? (grain * 0.4 + 0.5 * 0.6) : (grain * 0.4 + 0.3 * 0.6);
    }

    const s = hrSphere(hx, hy);
    grain += noise3D(s.x * 10, s.y * 10, s.z * 10, seed + 41) * 0.08;
    state.hiResData.grainSize[hi] = clamp(grain, 0, 1);
  }
}

// ── Step HR4: water table & saturation ──
function stepHR4_waterTableRow(hy) {
  for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;

    if (!state.hiResData.isLand[hi]) {
      state.hiResData.waterTableDepth[hi] = state.hiResData.elevation[hi];
      state.hiResData.saturation[hi] = 1.0;
      continue;
    }

    const elev = state.hiResData.elevation[hi];
    const precip = state.hiResData.precipitation[hi];
    const volc = state.hiResData.volcanism[hi];
    const grain = state.hiResData.grainSize[hi];

    let depth = Math.max(0, elev) * 3.0;
    depth -= precip * 1.2;
    depth -= volc * 1.0;
    if (elev < 0.05) depth -= (1.0 - elev / 0.05) * 0.8;

    if (depth < 0) {
      let isBasin = true;
      const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
      const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
      for (let d = 0; d < 8; d++) {
        const nx = (hx + dx8[d] + state.HR_W) % state.HR_W;
        const ny = hy + dy8[d];
        if (ny < 0 || ny >= state.HR_H) continue;
        if (state.hiResData.elevation[ny * state.HR_W + nx] < elev) { isBasin = false; break; }
      }
      if (!isBasin) depth = 0;
    }

    state.hiResData.waterTableDepth[hi] = depth;

    const capillary = (1.0 - grain) * 0.15;
    const effDepth = depth - capillary;
    state.hiResData.saturation[hi] = effDepth <= 0
      ? Math.min(1, Math.max(0.7, 1.0 - effDepth * 0.5))
      : Math.min(0.7, Math.exp(-effDepth * 8.0));
  }
}

// ── Step HR5: drainage (flow accumulation + stream order) ──
async function stepHR5_drainage() {
  const flowAccum = new Float32Array(state.HR_TOTAL);
  const streamOrder = state.hiResData.streamOrder;

  updateProgress('Preparing drainage…', 52);
  await yieldFrame();

  const landIndices = [];
  for (let hi = 0; hi < state.HR_TOTAL; hi++) {
    if (state.hiResData.isLand[hi]) {
      flowAccum[hi] = state.hiResData.precipitation[hi] || 0.005;
      landIndices.push(hi);
    }
  }

  updateProgress('Sorting elevation…', 56);
  await yieldFrame();
  landIndices.sort((a, b) => state.hiResData.elevation[b] - state.hiResData.elevation[a]);

  updateProgress('Accumulating flow…', 60);
  await yieldFrame();

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
  const n = landIndices.length;
  const yieldInterval = Math.max(1, Math.floor(n / 8));

  for (let k = 0; k < n; k++) {
    const hi = landIndices[k];
    const hx = hi % state.HR_W, hy = (hi / state.HR_W) | 0;

    let lowestElev = state.hiResData.elevation[hi];
    let lowestIdx = -1;
    for (let d = 0; d < 8; d++) {
      const nx = (hx + dx8[d] + state.HR_W) % state.HR_W;
      const ny = hy + dy8[d];
      if (ny < 0 || ny >= state.HR_H) continue;
      const ni = ny * state.HR_W + nx;
      if (state.hiResData.elevation[ni] < lowestElev) { lowestElev = state.hiResData.elevation[ni]; lowestIdx = ni; }
    }
    if (lowestIdx >= 0) flowAccum[lowestIdx] += flowAccum[hi];

    if (k > 0 && k % yieldInterval === 0) {
      updateProgress('Accumulating flow…', 60 + (k / n) * 12);
      await yieldFrame();
    }
  }

  // Stream order thresholds
  const avgP = 0.05;
  const t1 = 2.0 / (1 + avgP * 5);
  const t2 = t1 * 5, t3 = t1 * 20;
  for (let k = 0; k < n; k++) {
    const hi = landIndices[k];
    const f = flowAccum[hi];
    streamOrder[hi] = f > t3 ? 3 : f > t2 ? 2 : f > t1 ? 1 : 0;
  }
}

// ── Step HR6: flora ──
function stepHR6_floraRow(hy) {
  // Domain warp parameters: displace sampling coordinates with noise to break
  // grid-aligned classification boundaries. Only affects the flora TYPE decision
  // and chemo crust threshold, not the continuous values (saturation, grain size,
  // etc.) that feed into terrain.
  const warpScale = 0.08;   // Noise frequency — one undulation per ~12 hi-res cells
  const warpAmp = 1.8;      // Displacement in hi-res cells
  const warpSeed1 = 0x7A3C;
  const warpSeed2 = 0x9E1F;

  for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;

    if (!state.hiResData.isLand[hi] || state.hiResData.isFreezing[hi]) {
      if (!state.hiResData.isFreezing[hi]) {
        // Check if planetary grid considers this land (Session 24c isLand fix)
        const lx = hx / state.hiResMultiplier;
        const ly = hy / state.hiResMultiplier;
        const baseElev = bilinearInterpolate(lx, ly, c => c.elevation);

        // DIAGNOSTIC 1 — log near-coast cells flipped to ocean by noise
        if (baseElev > 0 && baseElev < 0.03) {
          if (!stepHR6_floraRow._oceanFlipCount) stepHR6_floraRow._oceanFlipCount = 0;
          stepHR6_floraRow._oceanFlipCount++;
          if (stepHR6_floraRow._oceanFlipCount <= 20) {
            console.log(`OCEAN-FLIP: hx=${hx} hy=${hy}`,
              `hrElev=${state.hiResData.elevation[hi].toFixed(4)}`,
              `baseElev=${baseElev.toFixed(4)}`);
          }
        }

        if (baseElev > 0.001) {
          // Planetary grid says land — fall through to flora computation.
          // Hi-res elevation is negative (noise-flipped), but earlier steps
          // populated precip/gw/sat/grain with values that produce reasonable
          // coastal flora. No override needed since stepHR4 clamped via
          // max(0, elev) and the negative depth yields high saturation.
        } else {
          // Genuinely ocean — zero and skip
          state.hiResData.groundCover[hi] = 0;
          state.hiResData.canopyDensity[hi] = 0;
          state.hiResData.chemoCrust[hi] = 0;
          state.hiResData.organicContent[hi] = 0;
          state.hiResData.floraType[hi] = 0;
          continue;
        }
      } else {
        // Freezing — zero and skip
        state.hiResData.groundCover[hi] = 0;
        state.hiResData.canopyDensity[hi] = 0;
        state.hiResData.chemoCrust[hi] = 0;
        state.hiResData.organicContent[hi] = 0;
        state.hiResData.floraType[hi] = 0;
        continue;
      }
    }

    const sat = state.hiResData.saturation[hi];
    const grain = state.hiResData.grainSize[hi];
    const precip = state.hiResData.precipitation[hi];
    const gw = state.hiResData.groundwater[hi];
    const volc = state.hiResData.volcanism[hi];
    const iron = state.hiResData.iron[hi];
    const copper = state.hiResData.copper[hi];
    const mn = state.hiResData.manganese[hi];
    const mineralTotal = iron + copper + mn;
    const depth = state.hiResData.waterTableDepth[hi];
    const hasWater = depth < -0.01;

    // Domain-warped coordinates for flora TYPE classification and chemo crust only.
    // This displaces the threshold boundary with noise so it follows an organic
    // contour instead of the planetary grid.
    const wx = hx + noise2D(hx * warpScale, hy * warpScale, warpSeed1) * warpAmp;
    const wy = hy + noise2D(hx * warpScale, hy * warpScale, warpSeed2) * warpAmp;
    const ironW = bilinearSampleHR(state.hiResData.iron, wx, wy, state.HR_W, state.HR_H);
    const copperW = bilinearSampleHR(state.hiResData.copper, wx, wy, state.HR_W, state.HR_H);
    const mnW = bilinearSampleHR(state.hiResData.manganese, wx, wy, state.HR_W, state.HR_H);
    const mineralTotalW = ironW + copperW + mnW;
    const precipW = bilinearSampleHR(state.hiResData.precipitation, wx, wy, state.HR_W, state.HR_H);
    const gwW = bilinearSampleHR(state.hiResData.groundwater, wx, wy, state.HR_W, state.HR_H);
    const volcW = bilinearSampleHR(state.hiResData.volcanism, wx, wy, state.HR_W, state.HR_H);

    // Ground cover — scaled by water availability so barren/dry zones get low coverage
    let gc;
    if (hasWater) gc = 0.3;
    else if (grain > 0.8) gc = 0.08;
    else {
      const waterFactor = Math.min(1, precip * 2.0 + gw * 1.0); // R1-FIX2: unified waterFactor
      gc = (0.5 + (1.0 - grain) * 0.4) * waterFactor;
    }
    state.hiResData.groundCover[hi] = gc;

    // Canopy
    let cd = 0;
    if (!hasWater && grain <= 0.7) {
      const waterFactor = Math.min(1, precip * 2.0 + gw * 1.0); // R1-FIX2: unified waterFactor
      // R1-FIX1: smooth saturation factor
      const wetPenalty = smoothstep(0.4, 1.0, sat);
      const dryPenalty = 1.0 - smoothstep(0.05, 0.35, sat);
      const satFactor = Math.max(0.25, 1.0 - 0.65 * wetPenalty - 0.55 * dryPenalty);
      const subFactor = grain < 0.5 ? 1.0 : Math.max(0, 1.0 - (grain - 0.5) * 3.0);
      cd = waterFactor * satFactor * subFactor;
      if (waterFactor > 0.05 && subFactor > 0.1) cd = Math.max(cd, 0.12);
    }
    state.hiResData.canopyDensity[hi] = cd;

    // Chemo crust — uses warped mineralTotal so crust boundary matches flora type boundary
    let cc = 0;
    if (mineralTotalW > 0.4) {
      const cf = mineralTotalW * Math.max(sat, volc * 1.5);
      const pf = gc * 0.8;
      if (cf > pf) {
        cc = Math.min(1, (cf - pf) * 2.0);
        state.hiResData.groundCover[hi] *= (1 - cc * 0.6);
      }
    }
    state.hiResData.chemoCrust[hi] = cc;

    // Flora type — uses warped mineral/water values for organic boundaries
    const regWaterW = Math.min(1, precipW * 3.0 + gwW * 1.5);
    const photoFit = regWaterW * 0.8;
    const chemoFit = mineralTotalW * Math.max(regWaterW, volcW * 1.5) * 1.2;
    const mixoFit = (0.6 + 0.5 * mineralTotalW) * regWaterW;
    if (chemoFit > photoFit && chemoFit > mixoFit && chemoFit > 0.02) state.hiResData.floraType[hi] = 2;
    else if (mixoFit > photoFit && mixoFit > chemoFit && mixoFit > 0.02) state.hiResData.floraType[hi] = 3;
    else if (photoFit > 0.02) state.hiResData.floraType[hi] = 1;
    else state.hiResData.floraType[hi] = 0;

    // DIAGNOSTIC 2 — log barren cells with high water at higher elevation (warp-related?)
    if (state.hiResData.floraType[hi] === 0 && state.hiResData.elevation[hi] > 0.03) {
      const rawWater = Math.min(1, precip * 2.0 + gw * 1.0);
      if (rawWater > 0.3) {
        if (!stepHR6_floraRow._highBarrenCount) stepHR6_floraRow._highBarrenCount = 0;
        stepHR6_floraRow._highBarrenCount++;
      }
    }

    // Organic content
    const prod = (state.hiResData.groundCover[hi] + cd) * 0.5;
    state.hiResData.organicContent[hi] = prod * (sat > 0.7 ? 0.7 : 0.3);
  }

  // DIAGNOSTIC — summary on last row
  if (hy === state.HR_H - 1) {
    if (stepHR6_floraRow._oceanFlipCount) {
      console.log(`OCEAN-FLIP total: ${stepHR6_floraRow._oceanFlipCount} cells`);
      stepHR6_floraRow._oceanFlipCount = 0;
    }
    if (stepHR6_floraRow._highBarrenCount) {
      console.log(`HIGH-BARREN total: ${stepHR6_floraRow._highBarrenCount} cells`);
      stepHR6_floraRow._highBarrenCount = 0;
    }
  }
}

// ── Step HR7: terrain type + cover type ──
function stepHR7_terrainRow(hy) {
  for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;

    // Water / ice guards preserve the high-res deep/shallow distinction the
    // canonical fn collapses; everything else routes through deriveTerrainAndCover.
    if (state.hiResData.isDeepWater[hi])    { state.hiResData.terrainType[hi] = 1; state.hiResData.coverType[hi] = 0; continue; }
    if (state.hiResData.isShallowWater[hi]) { state.hiResData.terrainType[hi] = 2; state.hiResData.coverType[hi] = 0; continue; }
    if (!state.hiResData.isLand[hi])        { state.hiResData.terrainType[hi] = 2; state.hiResData.coverType[hi] = 0; continue; }
    if (state.hiResData.isFreezing[hi])     { state.hiResData.terrainType[hi] = 7; state.hiResData.coverType[hi] = 0; continue; }

    const elev = state.hiResData.elevation[hi];
    const isCoastal = elev > 0 && elev < 0.03;

    const result = deriveTerrainAndCover(
      elev,
      state.hiResData.isLand[hi],
      state.hiResData.grainSize[hi],
      state.hiResData.saturation[hi],
      state.hiResData.groundCover[hi],
      state.hiResData.canopyDensity[hi],
      state.hiResData.chemoCrust[hi],
      state.hiResData.floraType[hi],            // int enum — canonical handles both
      state.hiResData.waterTableDepth[hi],
      isCoastal
    );

    state.hiResData.terrainType[hi] = terrainTypeToInt(result.terrainType);
    state.hiResData.coverType[hi]   = coverTypeToInt(result.coverType);
  }
}

const HR_FLORA_NAMES = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic'];

// ── Step HR8: pre-compute surface colors ──
function stepHR8_colorRow(hy) {
  for (let hx = 0; hx < state.HR_W; hx++) {
    const hi = hy * state.HR_W + hx;

    // Frozen land renders as ice regardless of palette
    if (state.hiResData.isLand[hi] && state.hiResData.isFreezing[hi]) {
      state.hiResData.colorR[hi] = 210; state.hiResData.colorG[hi] = 215; state.hiResData.colorB[hi] = 220;
      continue;
    }

    const wtd = state.hiResData.waterTableDepth[hi];
    const palette = computeTilePalette({
      terrainType:    intToTerrainType(state.hiResData.terrainType[hi]),
      coverType:      intToCoverType(state.hiResData.coverType[hi]),
      iron:           state.hiResData.iron[hi],
      copper:         state.hiResData.copper[hi],
      manganese:      state.hiResData.manganese[hi],
      grainSize:      state.hiResData.grainSize[hi],
      saturation:     state.hiResData.saturation[hi],
      organicContent: state.hiResData.organicContent[hi],
      groundCover:    state.hiResData.groundCover[hi],
      canopyDensity:  state.hiResData.canopyDensity[hi],
      chemoCrust:     state.hiResData.chemoCrust[hi],
      waterDepth:     wtd < 0 ? -wtd : 0,
      floraType:      HR_FLORA_NAMES[state.hiResData.floraType[hi]],
    });
    state.hiResData.colorR[hi] = palette.bg.r;
    state.hiResData.colorG[hi] = palette.bg.g;
    state.hiResData.colorB[hi] = palette.bg.b;
  }
}

// ── Phase 2 entry point ──
async function generateHighResSurface(seed) {
  state.HR_W = W * state.hiResMultiplier;
  state.HR_H = H * state.hiResMultiplier;
  state.HR_TOTAL = state.HR_W * state.HR_H;

  const HR_TOTAL = state.HR_TOTAL;
  const statusText = document.getElementById('statusText');

  // Allocate high-res typed arrays (guarded — Ultra can be large).
  try {
    state.hiResData = {
      elevation:       new Float32Array(state.HR_TOTAL),
      isLand:          new Uint8Array(state.HR_TOTAL),
      isShallowWater:  new Uint8Array(state.HR_TOTAL),
      isDeepWater:     new Uint8Array(state.HR_TOTAL),
      isFreezing:      new Uint8Array(state.HR_TOTAL),

      // Interpolated from low-res
      precipitation:   new Float32Array(state.HR_TOTAL),
      groundwater:     new Float32Array(state.HR_TOTAL),
      waterAvail:      new Float32Array(state.HR_TOTAL),
      volcanism:       new Float32Array(state.HR_TOTAL),
      iron:            new Float32Array(state.HR_TOTAL),
      copper:          new Float32Array(state.HR_TOTAL),
      manganese:       new Float32Array(state.HR_TOTAL),
      // Atmospheric fields carried up for overlays (base-resolution phenomena,
      // interpolated so flat / Mollweide read one unified source)
      windU:           new Float32Array(state.HR_TOTAL),
      windV:           new Float32Array(state.HR_TOTAL),
      windSpeed:       new Float32Array(state.HR_TOTAL),
      temperature:     new Float32Array(state.HR_TOTAL),
      sst:             new Float32Array(state.HR_TOTAL),
      plateId:         new Uint16Array(state.HR_TOTAL),

      // Computed at high-res
      grainSize:       new Float32Array(state.HR_TOTAL),
      waterTableDepth: new Float32Array(state.HR_TOTAL),
      saturation:      new Float32Array(state.HR_TOTAL),
      groundCover:     new Float32Array(state.HR_TOTAL),
      canopyDensity:   new Float32Array(state.HR_TOTAL),
      chemoCrust:      new Float32Array(state.HR_TOTAL),
      organicContent:  new Float32Array(state.HR_TOTAL),
      floraType:       new Uint8Array(state.HR_TOTAL),
      terrainType:     new Uint8Array(state.HR_TOTAL),
      coverType:       new Uint8Array(state.HR_TOTAL),
      streamOrder:     new Uint8Array(state.HR_TOTAL),

      // Precomputed drain direction (wide-window gradient, for regional gen)
      drainDirX:       new Float32Array(state.HR_TOTAL),
      drainDirY:       new Float32Array(state.HR_TOTAL),

      // For rendering
      colorR:          new Uint8Array(state.HR_TOTAL),
      colorG:          new Uint8Array(state.HR_TOTAL),
      colorB:          new Uint8Array(state.HR_TOTAL),
    };
  } catch (err) {
    console.error('High-res allocation failed:', err);
    state.hiResData = null;
    if (statusText) statusText.textContent = 'High-res grid too large for available memory — using low-res.';
    return;
  }

  // ── Session 28: hi-res generation timing ──
  console.log('=== HI-RES GENERATION ===');
  const rowsPerChunk = 128;
  const numYields = Math.ceil(state.HR_H / rowsPerChunk);
  console.log(`forEachHRRow: ${rowsPerChunk} rows/chunk, ${numYields} yields per step, est yield overhead: ${numYields * 4}ms/step`);

  const h0 = performance.now();
  await forEachHRRow(hy => stepHR1_elevationRow(hy, seed), 'Interpolating elevation…', 0, 12);
  const h1 = performance.now();
  await forEachHRRow(hy => stepHR1b_drainDirRow(hy),       'Computing drain dirs…', 12, 16);
  const h1b = performance.now();
  await forEachHRRow(hy => stepHR2_atmosphereRow(hy),      'Interpolating atmosphere…', 16, 28);
  const h2 = performance.now();
  await forEachHRRow(hy => stepHR3_substrateRow(hy, seed), 'Computing substrate…', 28, 42);
  const h3 = performance.now();
  await forEachHRRow(hy => stepHR4_waterTableRow(hy),      'Computing water table…', 42, 52);
  const h4 = performance.now();
  await stepHR5_drainage();                                 // 52 → 72
  const h5 = performance.now();
  await forEachHRRow(hy => stepHR6_floraRow(hy),           'Computing flora…', 72, 82);
  const h6 = performance.now();
  await forEachHRRow(hy => stepHR7_terrainRow(hy),         'Deriving terrain…', 82, 88);
  const h7 = performance.now();
  await forEachHRRow(hy => stepHR8_colorRow(hy),           'Computing colors…', 88, 99);
  const h8 = performance.now();

  console.log(`HiRes gen (ms): ` +
    `HR1=${(h1-h0).toFixed(1)} HR1b=${(h1b-h1).toFixed(1)} ` +
    `HR2=${(h2-h1b).toFixed(1)} HR3=${(h3-h2).toFixed(1)} ` +
    `HR4=${(h4-h3).toFixed(1)} HR5=${(h5-h4).toFixed(1)} ` +
    `HR6=${(h6-h5).toFixed(1)} HR7=${(h7-h6).toFixed(1)} ` +
    `HR8=${(h8-h7).toFixed(1)} ` +
    `TOTAL=${(h8-h0).toFixed(1)}`);
}

export { generateHighResSurface, yieldFrame, updateProgress, hideProgress };
