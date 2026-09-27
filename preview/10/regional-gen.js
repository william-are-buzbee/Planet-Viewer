// ══════════════════════════════════════════════════════════════════
// ── regional-gen.js — Regional detail generation ──
// ══════════════════════════════════════════════════════════════════

import { state } from './state.js';
import {
  W, H, TOTAL, noise2D, clamp,
  bilinearSampleHR
} from './core-math.js';
import { deriveTerrainAndCover, SHALLOW_WATER_TERRAIN_THRESHOLD, terrainTypeToInt, coverTypeToInt,
         TT_DEEP_WATER, TT_WATER, TT_ROCK, CT_NONE, intToTerrainType } from './terrain-derive.js';
import { REGIONAL_SIZE, CELLS_PER_PLANETARY, PLANETARY_CELL_KM, REGIONAL_CELL_KM } from './regional-constants.js';
import { RegionalGrid, ZONE_TIDAL, ZONE_COASTAL, ZONE_LOWLAND, ZONE_MID_SLOPE, ZONE_UPPER_SLOPE, ZONE_SUMMIT,
         ZONE_NAMES, FLORA_NAMES } from './regional-grid.js';
import { computeRegionalDrainage } from './regional-drainage.js';
import { ELEV_UNIT_M, SHELF_DEPTH_M, COASTAL_ELEV_M } from './units.js';
import { refineRegionalSubstrateFromHiRes } from './regional-substrate.js';
import { refineRegionalFloraFromHiRes, deriveWTDWater } from './regional-flora.js';

// Re-export constants for backward compatibility with external consumers
export { REGIONAL_SIZE, CELLS_PER_PLANETARY, PLANETARY_CELL_KM, REGIONAL_CELL_KM };

// ── Sample a planetary cell with wrapping / clamping ──
export function getPlanetaryCell(x, y) {
  const wx = ((Math.round(x) % W) + W) % W;
  const wy = clamp(Math.round(y), 0, H - 1);
  return state.cells.cell(wy * W + wx);   // named-field view (label, tools)
}

// ── Bilinear interpolation of a planetary field over fractional coords ──
// NOTE: A separate bilinearInterpolate exists in hires-gen.js (for hi-res grid)
// This version operates on the planetary grid via getPlanetaryCell
export function bilinearInterpolate(x, y, accessor) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const v00 = accessor(getPlanetaryCell(x0, y0));
  const v10 = accessor(getPlanetaryCell(x0 + 1, y0));
  const v01 = accessor(getPlanetaryCell(x0, y0 + 1));
  const v11 = accessor(getPlanetaryCell(x0 + 1, y0 + 1));
  const vx0 = v00 + (v10 - v00) * fx;
  const vx1 = v01 + (v11 - v01) * fx;
  return vx0 + (vx1 - vx0) * fy;
}

// ── Planet-wide max land elevation (cached per generation) ──
let _planetMaxLandElev = null;
export function getPlanetMaxLandElev() {
  const P = state.cells;
  if (_planetMaxLandElev !== null) return _planetMaxLandElev;
  let m = 0.01;
  for (let i = 0; i < TOTAL; i++) {
    if (P.isLand[i] && P.elevation[i] > m) m = P.elevation[i];
  }
  _planetMaxLandElev = m;
  return m;
}
// Same, in metres — the regional and tile layers work in metres (units.js).
export function getPlanetMaxLandElevM() { return getPlanetMaxLandElev() * ELEV_UNIT_M; }

// ── Hi-res flow in km²·precip: one hi-res cell's area, and the planet's
//    biggest river (cached per generation). Stream order at every layer is
//    normalised against this so orders agree between windows and zooms.
export function hiResCellAreaKm2() {
  const km = PLANETARY_CELL_KM / state.hiResMultiplier;
  return km * km;
}
let _planetMaxFlowKm2 = null;
export function getPlanetMaxFlowKm2() {
  if (_planetMaxFlowKm2 !== null) return _planetMaxFlowKm2;
  const fa = state.hiResData.flowAccum;
  let m = 0;
  for (let i = 0; i < fa.length; i++) if (fa[i] > m) m = fa[i];
  _planetMaxFlowKm2 = Math.max(1, m * hiResCellAreaKm2());
  return _planetMaxFlowKm2;
}

// ── Zone classification from elevation (metres) + slope ──
const TIDAL_DEPTH_M = 5;   // water shallower than this is the tidal zone

function classifyZone(elevation, slopeMag, maxLandElev) {
  if (elevation <= 0) {
    return elevation > -TIDAL_DEPTH_M ? ZONE_TIDAL : ZONE_COASTAL;
  }
  const en = elevation / maxLandElev;
  if (en < 0.06) return ZONE_LOWLAND;
  if (en < 0.35) return ZONE_MID_SLOPE;
  if (en < 0.65) return ZONE_UPPER_SLOPE;
  return ZONE_SUMMIT;
}

// ── Regional detail generation ──
//    The regional window reads its BASE physical state from the high-res grid
//    (so the regional view matches the planetary map), then refines it with
//    regional-scale coastline noise and higher-resolution drainage. Ridge cells
//    (streamOrder 0) inherit the high-res values unchanged, so they render
//    identically to the planetary map; channel cells are pushed wetter / finer,
//    adding detail the high-res grid can't resolve.
//    Requires state.hiResData (generation refuses to proceed without it).
function generateRegionalDetail(centerX, centerY) {
  const P = state.cells;
  const _t0 = performance.now();
  _planetMaxLandElev = null; // recompute per generation
  _planetMaxFlowKm2 = null;
  const maxLand = getPlanetMaxLandElevM();   // metres

  const seed = state.seed | 0;
  const regionSeed = (seed ^ 0x51ED270B) | 0;

  // World-space origin (top-left) in regional-cell units
  const originWorldX = centerX * CELLS_PER_PLANETARY - REGIONAL_SIZE / 2;
  const originWorldY = centerY * CELLS_PER_PLANETARY - REGIONAL_SIZE / 2;

  // Pass 1a: read BASE elevation from hi-res grid (no noise yet).
  // Use a padded grid (MARGIN cells on each side) so the local slope and
  // convergence perturbation stabilize before reaching the interior 512×512
  // region. This ensures continuity when the user pans the regional map.
  const S = REGIONAL_SIZE;
  const NN = S * S;
  const MARGIN = 4;
  const S_PAD = S + 2 * MARGIN;  // 520
  const NN_PAD = S_PAD * S_PAD;
  const baseElevGrid = new Float32Array(NN);
  // The regional grid is struct-of-arrays (regional-grid.js); its elevation
  // array doubles as the working elevation grid for the passes below.
  const g = new RegionalGrid(S, originWorldX, originWorldY);
  state.regionalCells = g;
  const elevGrid = g.elevation;

  // Temporary arrays for high-res field samples (needed in Pass 1c)
  const _hx = new Float32Array(NN);
  const _hy = new Float32Array(NN);
  const _wx = new Float32Array(NN);
  const _wy = new Float32Array(NN);

  // Padded base elevation grid for drainage direction + convergence perturbation
  const baseElevPad = new Float32Array(NN_PAD);

  for (let ry = -MARGIN; ry < S + MARGIN; ry++) {
    for (let rx = -MARGIN; rx < S + MARGIN; rx++) {
      const worldX = originWorldX + rx;
      const worldY = originWorldY + ry;
      const px = worldX / CELLS_PER_PLANETARY;
      const py = worldY / CELLS_PER_PLANETARY;
      const hx = px * state.hiResMultiplier;
      const hy = py * state.hiResMultiplier;
      const padIdx = (ry + MARGIN) * S_PAD + (rx + MARGIN);
      // Planet units → METRES here; everything below this line is metres (units.js).
      baseElevPad[padIdx] = bilinearSampleHR(state.hiResData.elevation, hx, hy, state.HR_W, state.HR_H) * ELEV_UNIT_M;
      // Store interior coordinate arrays
      if (rx >= 0 && rx < S && ry >= 0 && ry < S) {
        const idx = ry * S + rx;
        baseElevGrid[idx] = baseElevPad[padIdx];
        _hx[idx] = hx;
        _hy[idx] = hy;
        _wx[idx] = worldX;
        _wy[idx] = worldY;
      }
    }
  }

  const _t1 = performance.now();
  // Pass 1b: drainage direction from hi-res elevation gradient (globally deterministic).
  // Instead of BFS (which is window-dependent), sample the GLOBAL hi-res elevation
  // grid at a wide window around each cell to determine downhill direction. The hi-res
  // grid was computed once during planet generation and is globally consistent — this
  // gives the same direction regardless of which regional view the cell appears in.
  const drainDirXPad = new Float32Array(NN_PAD);
  const drainDirYPad = new Float32Array(NN_PAD);

  const slopeMagPad = new Float32Array(NN_PAD);

  for (let ry = 0; ry < S_PAD; ry++) {
    for (let rx = 0; rx < S_PAD; rx++) {
      const idx = ry * S_PAD + rx;
      if (baseElevPad[idx] <= 0) {
        drainDirXPad[idx] = 0;
        drainDirYPad[idx] = 1;
        continue;
      }

      // Look up precomputed wide-window drain direction from hi-res grid
      const worldX = originWorldX + (rx - MARGIN);
      const worldY = originWorldY + (ry - MARGIN);
      const hx = (worldX / CELLS_PER_PLANETARY) * state.hiResMultiplier;
      const hy = (worldY / CELLS_PER_PLANETARY) * state.hiResMultiplier;

      drainDirXPad[idx] = bilinearSampleHR(state.hiResData.drainDirX, hx, hy, state.HR_W, state.HR_H);
      drainDirYPad[idx] = bilinearSampleHR(state.hiResData.drainDirY, hx, hy, state.HR_W, state.HR_H);

      // 3×3 Sobel slope on the padded base elevation grid
      let localGx = 0, localGy = 0;
      if (rx > 0 && rx < S_PAD - 1 && ry > 0 && ry < S_PAD - 1) {
        const rm = (ry - 1) * S_PAD, r0 = ry * S_PAD, rp = (ry + 1) * S_PAD;
        const xm = rx - 1, xp = rx + 1;
        localGx = (baseElevPad[rm + xp] + 2 * baseElevPad[r0 + xp] + baseElevPad[rp + xp])
                - (baseElevPad[rm + xm] + 2 * baseElevPad[r0 + xm] + baseElevPad[rp + xm]);
        localGy = (baseElevPad[rp + xm] + 2 * baseElevPad[rp + rx] + baseElevPad[rp + xp])
                - (baseElevPad[rm + xm] + 2 * baseElevPad[rm + rx] + baseElevPad[rm + xp]);
      }
      // Scale Sobel magnitude to approximate 7×7 weighted-gradient magnitudes.
      // Raw magnitude is kept for normalizing the direction vector.
      const localSlopeRaw = Math.sqrt(localGx * localGx + localGy * localGy);
      const localSlopeMag = localSlopeRaw * 0.4;
      slopeMagPad[idx] = localSlopeMag;

      // Blend: steep terrain uses local slope, flat terrain uses wide gradient
      const FLAT_THRESH  = 0.0015 * ELEV_UNIT_M;   // 15 m per cell (Sobel-scaled), was 0.0015 planet units
      const STEEP_THRESH = 0.005 * ELEV_UNIT_M;    // 50 m per cell
      const t = clamp((localSlopeMag - FLAT_THRESH) / (STEEP_THRESH - FLAT_THRESH), 0, 1);

      if (t > 0.01 && localSlopeRaw > 0.0001) {
        const nlx = localGx / localSlopeRaw;
        const nly = localGy / localSlopeRaw;

        let bx = drainDirXPad[idx] * (1 - t) + nlx * t;
        let by = drainDirYPad[idx] * (1 - t) + nly * t;
        const bLen = Math.sqrt(bx * bx + by * by) || 1;
        drainDirXPad[idx] = bx / bLen;
        drainDirYPad[idx] = by / bLen;
      }
    }
  }

  // ── Convergence perturbation (Bug 3 fix) ──
  // Rotate drainage direction vectors by a low-frequency noise angle on the padded grid.
  // This creates broad zones (~140-cell wavelength) where channels angle
  // toward each other (convergence) and zones where they angle apart (divergence).
  // The result is dendritic drainage instead of parallel ditches.
  const convergeSeed1 = regionSeed + 5555;
  const convergeFreq = 0.007;
  const convergeMaxAngle = 0.35;

  for (let ry = 0; ry < S_PAD; ry++) {
    for (let rx = 0; rx < S_PAD; rx++) {
      const idx = ry * S_PAD + rx;
      if (baseElevPad[idx] <= 0) continue;

      const worldX = originWorldX + (rx - MARGIN);
      const worldY = originWorldY + (ry - MARGIN);

      // Only perturb on flat terrain — steep slopes have reliable slope direction
      const flatness = clamp(1.0 - slopeMagPad[idx] / (0.005 * ELEV_UNIT_M), 0, 1);
      if (flatness < 0.05) continue;

      // Low-frequency angular offset
      const angle = noise2D(worldX * convergeFreq, worldY * convergeFreq, convergeSeed1)
                  * convergeMaxAngle * flatness;

      // Rotate the drainage direction by this angle
      const dx = drainDirXPad[idx];
      const dy = drainDirYPad[idx];
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      drainDirXPad[idx] = dx * cos - dy * sin;
      drainDirYPad[idx] = dx * sin + dy * cos;
    }
  }

  // Extract interior 512×512 drainage direction from the padded grid
  const drainDirX = new Float32Array(NN);
  const drainDirY = new Float32Array(NN);
  for (let ry = 0; ry < S; ry++) {
    for (let rx = 0; rx < S; rx++) {
      const srcIdx = (ry + MARGIN) * S_PAD + (rx + MARGIN);
      const dstIdx = ry * S + rx;
      drainDirX[dstIdx] = drainDirXPad[srcIdx];
      drainDirY[dstIdx] = drainDirYPad[srcIdx];
    }
  }

  const _t2 = performance.now();
  // Pass 1c: add isotropic + anisotropic noise, sample hi-res fields, build cells.
  for (let ry = 0; ry < S; ry++) {
    for (let rx = 0; rx < S; rx++) {
      const idx = ry * S + rx;
      const worldX = _wx[idx];
      const worldY = _wy[idx];
      const hx = _hx[idx];
      const hy = _hy[idx];
      const px = worldX / CELLS_PER_PLANETARY;
      const py = worldY / CELLS_PER_PLANETARY;
      const baseElev = baseElevGrid[idx];

      // ── Isotropic detail noise (same as before) ──
      let detail = 0, amp = 1, freq = 0.015, totalAmp = 0;
      for (let o = 0; o < 5; o++) {
        detail += amp * noise2D(worldX * freq, worldY * freq, regionSeed + o * 1013);
        totalAmp += amp;
        amp *= 0.5;
        freq *= 2;
      }
      detail /= totalAmp;

      const elevNorm = clamp(baseElev / maxLand, -1, 1);
      let detailAmp;
      if (baseElev <= 0) {
        detailAmp = state.params.regionalDetailAmpM * 0.4;          // seabed: gentler
      } else {
        detailAmp = state.params.regionalDetailAmpM + state.params.regionalMountainAmpM * elevNorm;   // metres
      }

      // ── Anisotropic channel noise (aligned with drainage direction) ──
      // Creates organized ridge-channel topography for coherent drainage networks.
      let channelOffset = 0;
      if (baseElev > 0) {
        const fdx = drainDirX[idx];
        const fdy = drainDirY[idx];

        // Project world coords into drain-aligned frame
        const alongDrain  =  worldX * fdx + worldY * fdy;
        const acrossDrain = -worldX * fdy + worldX * fdx;
        // More accurate cross-projection:
        const acrossDrainCorr = worldX * (-fdy) + worldY * fdx;

        // Anisotropic noise: low freq along drain (continuous channels),
        // high freq across drain (periodic ridge-channel spacing)
        const alongFreq  = 0.004;
        const acrossFreq = 0.07;

        let channelNoise = 0, cAmp = 1, cTotalAmp = 0;
        for (let o = 0; o < 3; o++) {
          const f = (o === 0) ? 1.0 : (o === 1) ? 2.0 : 4.0;
          channelNoise += cAmp * noise2D(
            alongDrain * alongFreq * f,
            acrossDrainCorr * acrossFreq * f,
            regionSeed + 7000 + o * 337
          );
          cTotalAmp += cAmp;
          cAmp *= 0.45;
        }
        channelNoise /= cTotalAmp;

        // Zone-dependent amplitude: strongest on flats, weakest on steep slopes
        const slopeMagLocal = Math.sqrt(
          (rx > 0 && rx < S - 1 ? (baseElevGrid[idx + 1] - baseElevGrid[idx - 1]) / 2 : 0) ** 2 +
          (ry > 0 && ry < S - 1 ? (baseElevGrid[idx + S] - baseElevGrid[idx - S]) / 2 : 0) ** 2
        );
        const zoneLocal = classifyZone(baseElev, slopeMagLocal, maxLand);
        let channelAmp;
        switch (zoneLocal) {
          // metres of ridge-to-channel relief (were 0.018 … 0.001 planet units = 180 … 10 m)
          case ZONE_LOWLAND:     channelAmp = 10; break;
          case ZONE_COASTAL:     channelAmp = 6;  break;
          case ZONE_TIDAL:       channelAmp = 3;  break;
          case ZONE_MID_SLOPE:   channelAmp = 8;  break;
          case ZONE_UPPER_SLOPE: channelAmp = 4;  break;
          case ZONE_SUMMIT:      channelAmp = 2;  break;
          default:               channelAmp = 6;  break;
        }

        channelOffset = channelNoise * channelAmp;

        // Reduce isotropic noise on flat terrain so anisotropic channels dominate
        if (zoneLocal === ZONE_LOWLAND)          detailAmp *= 0.4;
        else if (zoneLocal === ZONE_COASTAL)     detailAmp *= 0.5;
        else if (zoneLocal === ZONE_TIDAL)       detailAmp *= 0.5;
        else if (zoneLocal === ZONE_MID_SLOPE)   detailAmp *= 0.7;
        // upper_slope and summit keep full amplitude
      }

      const elev = baseElev + detail * detailAmp + channelOffset;
      elevGrid[idx] = elev;

      // ── Batched bilinear sampling: compute corners and weights ONCE ──
      const HR_W = state.HR_W, HR_H = state.HR_H;
      const bx0 = Math.floor(hx);
      const by0 = Math.floor(hy);
      const bfx = hx - bx0;
      const bfy = hy - by0;
      const bcx0 = ((bx0 % HR_W) + HR_W) % HR_W;
      const bcx1 = ((bx0 + 1) % HR_W + HR_W) % HR_W;
      const bcy0 = Math.max(0, Math.min(HR_H - 1, by0));
      const bcy1 = Math.max(0, Math.min(HR_H - 1, by0 + 1));
      const bi00 = bcy0 * HR_W + bcx0;
      const bi10 = bcy0 * HR_W + bcx1;
      const bi01 = bcy1 * HR_W + bcx0;
      const bi11 = bcy1 * HR_W + bcx1;
      const bw00 = (1 - bfx) * (1 - bfy);
      const bw10 = bfx * (1 - bfy);
      const bw01 = (1 - bfx) * bfy;
      const bw11 = bfx * bfy;

      // Inline bilinear reads for all continuous fields
      const hrd = state.hiResData;
      const hrGrain     = hrd.grainSize[bi00]*bw00 + hrd.grainSize[bi10]*bw10 + hrd.grainSize[bi01]*bw01 + hrd.grainSize[bi11]*bw11;
      const hrSat       = hrd.saturation[bi00]*bw00 + hrd.saturation[bi10]*bw10 + hrd.saturation[bi01]*bw01 + hrd.saturation[bi11]*bw11;
      const hrGCover    = hrd.groundCover[bi00]*bw00 + hrd.groundCover[bi10]*bw10 + hrd.groundCover[bi01]*bw01 + hrd.groundCover[bi11]*bw11;
      const hrChemo     = hrd.chemoCrust[bi00]*bw00 + hrd.chemoCrust[bi10]*bw10 + hrd.chemoCrust[bi01]*bw01 + hrd.chemoCrust[bi11]*bw11;
      const hrWTD       = hrd.waterTableDepth[bi00]*bw00 + hrd.waterTableDepth[bi10]*bw10 + hrd.waterTableDepth[bi01]*bw01 + hrd.waterTableDepth[bi11]*bw11;
      const hrPrecip    = hrd.precipitation[bi00]*bw00 + hrd.precipitation[bi10]*bw10 + hrd.precipitation[bi01]*bw01 + hrd.precipitation[bi11]*bw11;
      const hrGW        = hrd.groundwater[bi00]*bw00 + hrd.groundwater[bi10]*bw10 + hrd.groundwater[bi01]*bw01 + hrd.groundwater[bi11]*bw11;
      const hrVolc      = hrd.volcanism[bi00]*bw00 + hrd.volcanism[bi10]*bw10 + hrd.volcanism[bi01]*bw01 + hrd.volcanism[bi11]*bw11;
      const hrIron      = hrd.iron[bi00]*bw00 + hrd.iron[bi10]*bw10 + hrd.iron[bi01]*bw01 + hrd.iron[bi11]*bw11;
      const hrCopper    = hrd.copper[bi00]*bw00 + hrd.copper[bi10]*bw10 + hrd.copper[bi01]*bw01 + hrd.copper[bi11]*bw11;
      const hrManganese = hrd.manganese[bi00]*bw00 + hrd.manganese[bi10]*bw10 + hrd.manganese[bi01]*bw01 + hrd.manganese[bi11]*bw11;

      // R2-FIX1: probabilistic flora type sampling
      // Reuses corner indices computed above for bilinear batching.
      let hrFloraType;
      {
        // Sample flora type at each corner (direct indexed access)
        const t00 = hrd.floraType[bi00];
        const t10 = hrd.floraType[bi10];
        const t01 = hrd.floraType[bi01];
        const t11 = hrd.floraType[bi11];

        // R3-FIX1: ocean filter — reuse corner elevation from same indices
        const e00 = hrd.elevation[bi00];
        const e10 = hrd.elevation[bi10];
        const e01 = hrd.elevation[bi01];
        const e11 = hrd.elevation[bi11];

        const isOcean00 = e00 <= 0;
        const isOcean10 = e10 <= 0;
        const isOcean01 = e01 <= 0;
        const isOcean11 = e11 <= 0;

        if (isOcean00 && isOcean10 && isOcean01 && isOcean11) {
          hrFloraType = 0;   // all-ocean footprint: barren
        } else {
          // Compute bilinear weights, zeroing ocean corners
          let fw00 = isOcean00 ? 0 : bw00;
          let fw10 = isOcean10 ? 0 : bw10;
          let fw01 = isOcean01 ? 0 : bw01;
          let fw11 = isOcean11 ? 0 : bw11;

          // Renormalize
          const fwSum = fw00 + fw10 + fw01 + fw11;
          if (fwSum > 0) {
            fw00 /= fwSum; fw10 /= fwSum; fw01 /= fwSum; fw11 /= fwSum;
          }

          // Fast path: all land corners agree
          const landTypes = [];
          if (!isOcean00) landTypes.push(t00);
          if (!isOcean10) landTypes.push(t10);
          if (!isOcean01) landTypes.push(t01);
          if (!isOcean11) landTypes.push(t11);
          const allAgree = landTypes.length > 0 && landTypes.every(t => t === landTypes[0]);

          if (allAgree) {
            hrFloraType = landTypes[0];
          } else {
            // Boundary path: accumulate weights per type
            const typeWeights = new Map();
            if (fw00 > 0) typeWeights.set(t00, (typeWeights.get(t00) || 0) + fw00);
            if (fw10 > 0) typeWeights.set(t10, (typeWeights.get(t10) || 0) + fw10);
            if (fw01 > 0) typeWeights.set(t01, (typeWeights.get(t01) || 0) + fw01);
            if (fw11 > 0) typeWeights.set(t11, (typeWeights.get(t11) || 0) + fw11);

            let bestType = landTypes[0] || t00, bestWeight = -Infinity;
            for (const [type, weight] of typeWeights) {
              const perturbation = noise2D(
                worldX * 0.06 + type * 137.3,
                worldY * 0.06 + type * 251.7,
                0xBEEF
              ) * 0.18;
              const adjusted = weight + perturbation;
              if (adjusted > bestWeight) {
                bestWeight = adjusted;
                bestType = type;
              }
            }
            hrFloraType = bestType;
          }
        }
      }

      // ── Batched planetary grid sampling: compute corners once ──
      // Two planetary fields are still sampled here: waterAvailability
      // (land-masked) and temperature.
      const px0 = Math.floor(px), py0 = Math.floor(py);
      const pfx = px - px0, pfy = py - py0;
      const pwx0 = ((Math.round(px0) % W) + W) % W;
      const pwx1 = ((Math.round(px0 + 1) % W) + W) % W;
      const pwy0 = clamp(Math.round(py0), 0, H - 1);
      const pwy1 = clamp(Math.round(py0 + 1), 0, H - 1);
      const pc00 = pwy0 * W + pwx0;
      const pc10 = pwy0 * W + pwx1;
      const pc01 = pwy1 * W + pwx0;
      const pc11 = pwy1 * W + pwx1;
      const pw00 = (1 - pfx) * (1 - pfy);
      const pw10 = pfx * (1 - pfy);
      const pw01 = (1 - pfx) * pfy;
      const pw11 = pfx * pfy;

      // Land-only planetary fields (waterAvailability = 1.0 and drainage = 0 on
      // ocean cells are sentinels, not physics): for regional LAND cells, zero the
      // weight of ocean corners and renormalise so coasts are not smeared wet.
      let lw00 = pw00, lw10 = pw10, lw01 = pw01, lw11 = pw11;
      if (elev > 0) {
        lw00 = P.isLand[pc00] ? pw00 : 0;
        lw10 = P.isLand[pc10] ? pw10 : 0;
        lw01 = P.isLand[pc01] ? pw01 : 0;
        lw11 = P.isLand[pc11] ? pw11 : 0;
        const ls = lw00 + lw10 + lw01 + lw11;
        if (ls > 0) { lw00 /= ls; lw10 /= ls; lw01 /= ls; lw11 /= ls; }
        else        { lw00 = pw00; lw10 = pw10; lw01 = pw01; lw11 = pw11; }
      }

      const tempC = P.temperature[pc00]*pw00 + P.temperature[pc10]*pw10 + P.temperature[pc01]*pw01 + P.temperature[pc11]*pw11;

      // Write the cell into the struct-of-arrays grid (elevGrid IS g.elevation)
      g.isLand[idx]         = elev > 0 ? 1 : 0;
      g.isShallowWater[idx] = (elev > -SHELF_DEPTH_M && elev <= 0) ? 1 : 0;   // reclassified from the refined elevation
      g.isDeepWater[idx]    = elev <= -SHELF_DEPTH_M ? 1 : 0;
      g.isFreezing[idx]     = tempC < 0.5 ? 1 : 0;
      g.temperature[idx]    = tempC;
      g.precipitation[idx]  = hrPrecip;
      g.groundwater[idx]    = hrGW;
      g.waterAvailability[idx] = P.waterAvailability[pc00]*lw00 + P.waterAvailability[pc10]*lw10 + P.waterAvailability[pc01]*lw01 + P.waterAvailability[pc11]*lw11;
      g.volcanism[idx]      = hrVolc;
      g.iron[idx]           = hrIron;
      g.copper[idx]         = hrCopper;
      g.manganese[idx]      = hrManganese;
      g.mineralTotal[idx]   = hrIron + hrCopper + hrManganese;
      g.grainSize[idx]      = hrGrain;
      // high-res base values retained for the refinement passes
      g.hrGrainSize[idx]       = hrGrain;
      g.hrSaturation[idx]      = hrSat;
      g.hrGroundCover[idx]     = hrGCover;
      g.hrChemoCrust[idx]      = hrChemo;
      g.hrWaterTableDepth[idx] = hrWTD;
      g.hrFloraType[idx]       = hrFloraType;
    }
  }

  const _t3 = performance.now();
  // Pass 2: slopes + zone classification (on the refined elevation grid)
  for (let ry = 0; ry < S; ry++) {
    for (let rx = 0; rx < S; rx++) {
      const i = ry * S + rx;
      const xm = Math.max(0, rx - 1), xp = Math.min(S - 1, rx + 1);
      const ym = Math.max(0, ry - 1), yp = Math.min(S - 1, ry + 1);
      const gx = (elevGrid[ry * S + xp] - elevGrid[ry * S + xm]) / 2;
      const gy = (elevGrid[yp * S + rx] - elevGrid[ym * S + rx]) / 2;
      const slopeMag = Math.sqrt(gx * gx + gy * gy);
      g.slopeMag[i] = slopeMag;
      g.slopeDir[i] = Math.atan2(gy, gx);
      g.zone[i] = classifyZone(elevGrid[i], slopeMag, maxLand);
    }
  }

  const _t4 = performance.now();
  // Pass 3: drainage. Water entering the window from upstream is injected along
  // the border from the hi-res flow field: for each land border cell, the hi-res
  // drain direction's inward component times the hi-res flow there, spread over
  // the regional cells that share that hi-res edge. The regional D8 then gathers
  // it into the window's own channels, so a river arriving at one edge continues
  // through the window and out the other side instead of starting from zero.
  // ── Border crossings, chosen so adjacent windows agree by construction ──
  // The hi-res flow field is sampled along each edge. For every hi-res cell the
  // edge passes through (the field cannot resolve anything finer) there is at
  // most ONE inflow crossing and ONE exit gap, both at the argmax of
  // f·|dot| over that span (f = hi-res flow at the edge, dot = inward component
  // of the hi-res drain direction). Inflow AMOUNTS are sampled half a hi-res
  // cell OUTSIDE the window, so a window never counts its own accumulation as
  // inflow. The neighbouring window samples the same field at the same edge
  // positions and so picks the same crossing from the other side: a river that
  // leaves one window enters the next at the same place. Everything else on the
  // border is a wall; border cells that are sea may always drain.
  const inflow = new Float32Array(NN);
  const padSink = { W: new Uint8Array(S), E: new Uint8Array(S), N: new Uint8Array(S), S: new Uint8Array(S) };
  {
    const hrd = state.hiResData;
    const areaHR = hiResCellAreaKm2();
    const edgeLen = CELLS_PER_PLANETARY / state.hiResMultiplier;   // regional cells per hi-res edge
    const GAP = 2;                                                  // crossing half-width in cells
    const edge = (cellIdx, nxIn, nyIn, sinkArr) => {
      // spans keyed by the hi-res cell along the edge
      const spans = new Map();
      for (let k = 0; k < S; k++) {
        const idx = cellIdx(k);
        if (!g.isLand[idx]) { sinkArr[k] = 1; }
        const hx = _hx[idx], hy = _hy[idx];
        const dxDrain = bilinearSampleHR(hrd.drainDirX, hx, hy, state.HR_W, state.HR_H);
        const dyDrain = bilinearSampleHR(hrd.drainDirY, hx, hy, state.HR_W, state.HR_H);
        const dot = dxDrain * nxIn + dyDrain * nyIn;
        if (Math.abs(dot) <= 0.05) continue;
        const fEdge = bilinearSampleHR(hrd.flowAccum, hx, hy, state.HR_W, state.HR_H);
        const w = fEdge * Math.abs(dot);
        const key = nxIn !== 0 ? Math.floor(hy) : Math.floor(hx);
        let sp = spans.get(key);
        if (!sp) { sp = { inTotal: 0, inBest: -1, inW: -1, outBest: -1, outW: -1 }; spans.set(key, sp); }
        if (dot > 0) {
          // amount from the cell just outside the window
          const fOut = bilinearSampleHR(hrd.flowAccum, hx - nxIn * 0.5, hy - nyIn * 0.5, state.HR_W, state.HR_H) * areaHR;
          sp.inTotal += fOut * dot / edgeLen;
          if (w > sp.inW) { sp.inW = w; sp.inBest = k; }
        } else if (w > sp.outW) { sp.outW = w; sp.outBest = k; }
      }
      for (const sp of spans.values()) {
        if (sp.inTotal > 0 && sp.inBest >= 0) {
          let n = 0;
          for (let j = Math.max(0, sp.inBest - GAP); j <= Math.min(S - 1, sp.inBest + GAP); j++) if (g.isLand[cellIdx(j)]) n++;
          if (n > 0) for (let j = Math.max(0, sp.inBest - GAP); j <= Math.min(S - 1, sp.inBest + GAP); j++) {
            if (g.isLand[cellIdx(j)]) inflow[cellIdx(j)] += sp.inTotal / n;
          }
        }
        if (sp.outBest >= 0) {
          for (let j = Math.max(0, sp.outBest - GAP); j <= Math.min(S - 1, sp.outBest + GAP); j++) sinkArr[j] = 1;
        }
      }
    };
    edge(k => k * S,             1, 0, padSink.W);   // west edge: inward = +x
    edge(k => k * S + (S - 1),  -1, 0, padSink.E);   // east edge
    edge(k => k,                 0, 1, padSink.N);   // north edge: inward = +y
    edge(k => (S - 1) * S + k,   0, -1, padSink.S);  // south edge
  }
  let inflowTotal = 0;
  for (let i = 0; i < NN; i++) inflowTotal += inflow[i];
  g.inflowTotalKm2 = inflowTotal;   // diagnostics / smoke test
  computeRegionalDrainage(g, inflow, padSink, REGIONAL_CELL_KM * REGIONAL_CELL_KM, getPlanetMaxFlowKm2());

  const _t5 = performance.now();
  // Pass 4: refine substrate / saturation / water table from the high-res base.
  //         Ridge cells keep high-res values; channels get wetter and finer.
  for (let i = 0; i < NN; i++) refineRegionalSubstrateFromHiRes(g, i);

  const _t6 = performance.now();
  // Pass 5a: refine flora from the (possibly drainage-modified) state.
  //          Sets canopy, groundCover — these are the "dry" values before
  //          flood modulation. Must run before deriveWTDWater.
  for (let i = 0; i < NN; i++) refineRegionalFloraFromHiRes(g, i);

  const _t7 = performance.now();
  // Pass 5b: derive water state from WTD (replaces computeStandingWater).
  //          Reads WTD (set in Pass 4) and canopy (set in Pass 5a).
  //          Modulates canopy downward for flooded zones.
  deriveWTDWater(g);

  const _t8 = performance.now();
  // Pass 5c: derive terrain type through the canonical function.
  //          Reads the flood-modulated canopy to determine coverType.
  for (let i = 0; i < NN; i++) deriveRegionalTerrainType(g, i);

  const _t9 = performance.now();
  console.log(`Regional gen breakdown (ms):`,
    `elev=${(_t1-_t0).toFixed(1)}`,
    `drainDir=${(_t2-_t1).toFixed(1)}`,
    `cellBuild=${(_t3-_t2).toFixed(1)}`,
    `slopes=${(_t4-_t3).toFixed(1)}`,
    `drainage=${(_t5-_t4).toFixed(1)}`,
    `substrate=${(_t6-_t5).toFixed(1)}`,
    `flora=${(_t7-_t6).toFixed(1)}`,
    `wtdWater=${(_t8-_t7).toFixed(1)}`,
    `terrain=${(_t9-_t8).toFixed(1)}`,
    `total=${(_t9-_t0).toFixed(1)}`);

  printRegionalDiagnostic(g);
}

// ── Regional terrain derivation — thin wrapper over deriveTerrainAndCover ──
function deriveRegionalTerrainType(g, i) {
  // Water / ice handled here (canonical fn is elevation-based; regional keeps
  // its own deep/shallow/standing-water and freezing distinctions).
  if (!g.isLand[i]) {
    g.terrainType[i] = g.isDeepWater[i] ? TT_DEEP_WATER : TT_WATER;
    g.coverType[i] = CT_NONE;
    return;
  }
  if (g.hasWater[i] && g.waterDepth[i] >= SHALLOW_WATER_TERRAIN_THRESHOLD) {
    g.terrainType[i] = TT_WATER;
    g.coverType[i] = CT_NONE;
    return;
  }
  // Shallower standing water falls through to normal terrain derivation: the
  // cell still has hasWater set, it just doesn't RENDER as water terrain.
  if (g.isFreezing[i]) {
    g.terrainType[i] = TT_ROCK;
    g.coverType[i] = CT_NONE;
    return;
  }

  const elev = g.elevation[i];
  const isCoastal = elev > 0 && elev < COASTAL_ELEV_M;
  const result = deriveTerrainAndCover(
    elev,
    true,
    g.grainSize[i],
    g.saturation[i],
    g.groundCover[i],
    g.canopy[i],
    g.chemoCrust[i],
    g.floraType[i],
    g.waterTableDepth[i],
    isCoastal
  );
  g.terrainType[i] = terrainTypeToInt(result.terrainType);
  g.coverType[i] = coverTypeToInt(result.coverType);
}

function printRegionalDiagnostic(g) {
  if (!g) return;
  const terrainCounts = new Uint32Array(16), zoneCounts = new Uint32Array(8), floraCounts = new Uint32Array(8);
  let land = 0;
  for (let i = 0; i < g.N; i++) {
    terrainCounts[g.terrainType[i]]++;
    zoneCounts[g.zone[i]]++;
    if (g.isLand[i]) { land++; floraCounts[g.floraType[i]]++; }
  }
  const pct = n => (n / g.N * 100).toFixed(1) + '%';
  console.log('=== REGIONAL DIAGNOSTIC ===');
  console.log('Land:', land, 'Water:', g.N - land);
  console.log('Terrain types: ' + Array.from(terrainCounts).map((n, t) => n ? `${intToTerrainType(t)}=${pct(n)}` : '').filter(Boolean).join('  '));
  console.log('Zones: ' + Array.from(zoneCounts).map((n, z) => n ? `${ZONE_NAMES[z]}=${pct(n)}` : '').filter(Boolean).join('  '));
  console.log('Flora types (land): ' + Array.from(floraCounts).map((n, f) => n ? `${FLORA_NAMES[f]}=${n}` : '').filter(Boolean).join('  '));
  console.log('=== END REGIONAL DIAGNOSTIC ===');
}

export { generateRegionalDetail };
