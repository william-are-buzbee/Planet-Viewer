// ══════════════════════════════════════════════════════════════════
// ── regional-gen.js — Regional detail generation ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import {
  W, H, TOTAL, mulberry32, hashInt, noise2D, noise3D, fractalNoise,
  fractalNoise3D, clamp, wrapX, spherePos,
  bilinearSampleHR, nearestSampleHR, getLatitudeBand
} from './core-math.js';
import { deriveTerrainAndCover, SHALLOW_WATER_TERRAIN_THRESHOLD } from './terrain-derive.js';
import { computeTilePalette } from './palette-compute.js';

export const REGIONAL_SIZE = 512;          // regional grid is 512×512 cells
export const PLANETARY_CELL_KM = 78.0;     // each planetary cell ≈ 78 km across
export const REGIONAL_CELL_KM = PLANETARY_CELL_KM / REGIONAL_SIZE; // ≈ 0.15 km/cell
export const CELLS_PER_PLANETARY = REGIONAL_SIZE; // regional cells spanning one planetary cell edge

const HR_FLORA_NAMES = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic'];

// ── Sample a planetary cell with wrapping / clamping ──
export function getPlanetaryCell(x, y) {
  const wx = ((Math.round(x) % W) + W) % W;
  const wy = clamp(Math.round(y), 0, H - 1);
  return state.cells[wy * W + wx];
}

// ── Deterministic per-region RNG ──
export function seededRNG(a, b, c) {
  let s = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Bilinear interpolation of a planetary field over fractional coords ──
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
  if (_planetMaxLandElev !== null) return _planetMaxLandElev;
  let m = 0.01;
  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].isLand && state.cells[i].elevation > m) m = state.cells[i].elevation;
  }
  _planetMaxLandElev = m;
  return m;
}

// ── Regional base elevation for one regional cell ──
// worldX, worldY are in regional-cell units across the whole planet
function computeRegionalBaseCell(worldX, worldY, seed) {
  // Fractional planetary coordinate
  const px = worldX / CELLS_PER_PLANETARY;
  const py = worldY / CELLS_PER_PLANETARY;

  // Smooth base elevation from planetary field
  const baseElev = bilinearInterpolate(px, py, c => c.elevation);

  // Multi-octave detail noise in world space (seamless across regions)
  let detail = 0, amp = 1, freq = 0.015, totalAmp = 0;
  for (let o = 0; o < 5; o++) {
    detail += amp * noise2D(worldX * freq, worldY * freq, seed + o * 1013);
    totalAmp += amp;
    amp *= 0.5;
    freq *= 2;
  }
  detail /= totalAmp;

  const maxLand = getPlanetMaxLandElev();
  const elevNorm = clamp(baseElev / maxLand, -1, 1);

  // Detail amplitude scales with terrain type
  let detailAmp;
  if (baseElev <= 0) {
    detailAmp = state.params.coastAmplitude * 0.4;
  } else {
    detailAmp = state.params.coastAmplitude + state.params.mountainDetail * elevNorm;
  }

  return baseElev + detail * detailAmp;
}

// ── Zone classification from elevation + slope ──

function classifyZone(elevation, slopeMag, maxLandElev) {
  if (elevation <= 0) {
    return elevation > -0.02 ? 'tidal' : 'coastal';
  }
  const en = elevation / maxLandElev;
  if (en < 0.06) return 'lowland';
  if (en < 0.35) return 'mid_slope';
  if (en < 0.65) return 'upper_slope';
  return 'summit';
}

// ── Regional detail generation ──
// Dispatcher: when a high-res planetary grid exists, the regional view reads
// its BASE physical state from it (so the regional view matches the planetary
// map) and only adds finer drainage/coastline detail on top. When there is no
// high-res grid (resolution multiplier = 1), fall back to computing the
// regional state independently from the low-res planetary grid.
function generateRegionalDetail(centerX, centerY) {
  if (state.hiResData) {
    generateRegionalDetailHiRes(centerX, centerY);
  } else {
    generateRegionalDetailLowRes(centerX, centerY);
  }
}

// ── Regional detail generation (LOW-RES fallback path — original behavior) ──
function generateRegionalDetailLowRes(centerX, centerY) {
  _planetMaxLandElev = null; // recompute per generation
  const maxLand = getPlanetMaxLandElev();

  const seed = parseInt(document.getElementById('seedInput').value, 10) || 0;
  // Detail noise must be a pure function of world coordinates (NOT the region
  // center), otherwise adjacent panned views sample different noise fields and
  // their seams don't line up. Seed from the global planetary seed only.
  const regionSeed = (seed ^ 0x51ED270B) | 0;

  // World-space origin (top-left) in regional-cell units
  const originWorldX = centerX * CELLS_PER_PLANETARY - REGIONAL_SIZE / 2;
  const originWorldY = centerY * CELLS_PER_PLANETARY - REGIONAL_SIZE / 2;

  // Allocate state.regionalCells[rx][ry]
  state.regionalCells = new Array(REGIONAL_SIZE);
  for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
    state.regionalCells[rx] = new Array(REGIONAL_SIZE);
  }

  // Pass 1a: base elevation (no noise yet) + planetary field sampling
  // Use a padded grid (MARGIN cells on each side) so the local slope and
  // convergence perturbation stabilize before reaching the interior 512×512 region.
  const S_LR = REGIONAL_SIZE;
  const NN_LR = S_LR * S_LR;
  const MARGIN_LR = 64;
  const S_PAD_LR = S_LR + 2 * MARGIN_LR;  // 640
  const NN_PAD_LR = S_PAD_LR * S_PAD_LR;
  const baseElevGridLR = new Float32Array(NN_LR);
  const elevGrid = new Float32Array(NN_LR);

  // Padded base elevation grid for drainage direction + convergence perturbation
  const baseElevPadLR = new Float32Array(NN_PAD_LR);

  for (let ry = -MARGIN_LR; ry < S_LR + MARGIN_LR; ry++) {
    for (let rx = -MARGIN_LR; rx < S_LR + MARGIN_LR; rx++) {
      const worldX = originWorldX + rx;
      const worldY = originWorldY + ry;
      const px = worldX / CELLS_PER_PLANETARY;
      const py = worldY / CELLS_PER_PLANETARY;
      const padIdx = (ry + MARGIN_LR) * S_PAD_LR + (rx + MARGIN_LR);
      baseElevPadLR[padIdx] = bilinearInterpolate(px, py, c => c.elevation);
      if (rx >= 0 && rx < S_LR && ry >= 0 && ry < S_LR) {
        baseElevGridLR[ry * S_LR + rx] = baseElevPadLR[padIdx];
      }
    }
  }

  // Pass 1b: drainage direction from planetary elevation gradient (globally deterministic).
  // Instead of BFS (which is window-dependent), sample the GLOBAL planetary elevation
  // via bilinearInterpolate at a wide window around each cell to determine downhill
  // direction. This gives the same direction regardless of which regional view the
  // cell appears in.
  const drainDirXPadLR = new Float32Array(NN_PAD_LR);
  const drainDirYPadLR = new Float32Array(NN_PAD_LR);

  const GRAD_RADIUS_PLANETARY_LR = 1.5;  // radius in planetary cells (~117 km, same physical scale as HiRes)
  const GRAD_STEPS_LR = 8;
  const gradDxLR = [0, 1, 1, 1, 0, -1, -1, -1];
  const gradDyLR = [-1, -1, 0, 1, 1, 1, 0, -1];

  const slopeMagPadLR = new Float32Array(NN_PAD_LR);

  for (let ry = 0; ry < S_PAD_LR; ry++) {
    for (let rx = 0; rx < S_PAD_LR; rx++) {
      const idx = ry * S_PAD_LR + rx;
      if (baseElevPadLR[idx] <= 0) {
        drainDirXPadLR[idx] = 0; drainDirYPadLR[idx] = 1; continue;
      }

      // Compute planetary coordinates for this padded cell
      const worldX = originWorldX + (rx - MARGIN_LR);
      const worldY = originWorldY + (ry - MARGIN_LR);
      const px = worldX / CELLS_PER_PLANETARY;
      const py = worldY / CELLS_PER_PLANETARY;
      const centerElev = baseElevPadLR[idx];

      // Wide-window gradient from global planetary elevation
      let gx = 0, gy = 0;
      for (let d = 0; d < GRAD_STEPS_LR; d++) {
        const samplePx = px + gradDxLR[d] * GRAD_RADIUS_PLANETARY_LR;
        const samplePy = py + gradDyLR[d] * GRAD_RADIUS_PLANETARY_LR;
        const sampleElev = bilinearInterpolate(samplePx, samplePy, c => c.elevation);
        const diff = centerElev - sampleElev;  // positive = downhill in that direction
        gx += gradDxLR[d] * diff;
        gy += gradDyLR[d] * diff;
      }
      const gLen = Math.sqrt(gx * gx + gy * gy) || 1;
      drainDirXPadLR[idx] = gx / gLen;
      drainDirYPadLR[idx] = gy / gLen;

      // Local 7×7 slope on the padded base elevation grid
      let localGx = 0, localGy = 0, localWt = 0;
      for (let ddy = -3; ddy <= 3; ddy++) {
        for (let ddx = -3; ddx <= 3; ddx++) {
          if (ddx === 0 && ddy === 0) continue;
          const nrx = rx + ddx, nry = ry + ddy;
          if (nrx < 0 || nrx >= S_PAD_LR || nry < 0 || nry >= S_PAD_LR) continue;
          const w = 1.0 / Math.sqrt(ddx * ddx + ddy * ddy);
          const diff = baseElevPadLR[idx] - baseElevPadLR[nry * S_PAD_LR + nrx];
          localGx += ddx * diff * w;
          localGy += ddy * diff * w;
          localWt += w;
        }
      }
      if (localWt > 0) { localGx /= localWt; localGy /= localWt; }
      const localSlopeMag = Math.sqrt(localGx * localGx + localGy * localGy);
      slopeMagPadLR[idx] = localSlopeMag;

      // Blend: steep terrain uses local slope, flat terrain uses wide gradient
      const FLAT_THRESH  = 0.0015;
      const STEEP_THRESH = 0.005;
      const t = clamp((localSlopeMag - FLAT_THRESH) / (STEEP_THRESH - FLAT_THRESH), 0, 1);

      if (t > 0.01 && localSlopeMag > 0.0001) {
        const nlx = localGx / localSlopeMag;
        const nly = localGy / localSlopeMag;

        let bx = drainDirXPadLR[idx] * (1 - t) + nlx * t;
        let by = drainDirYPadLR[idx] * (1 - t) + nly * t;
        const bLen = Math.sqrt(bx * bx + by * by) || 1;
        drainDirXPadLR[idx] = bx / bLen;
        drainDirYPadLR[idx] = by / bLen;
      }
    }
  }

  // ── Convergence perturbation (Bug 3 fix) ──
  const convergeSeed1LR = regionSeed + 5555;
  const convergeFreqLR = 0.007;
  const convergeMaxAngleLR = 0.35;

  for (let ry = 0; ry < S_PAD_LR; ry++) {
    for (let rx = 0; rx < S_PAD_LR; rx++) {
      const idx = ry * S_PAD_LR + rx;
      if (baseElevPadLR[idx] <= 0) continue;

      const worldX = originWorldX + (rx - MARGIN_LR);
      const worldY = originWorldY + (ry - MARGIN_LR);

      const flatness = clamp(1.0 - slopeMagPadLR[idx] / 0.005, 0, 1);
      if (flatness < 0.05) continue;

      const angle = noise2D(worldX * convergeFreqLR, worldY * convergeFreqLR, convergeSeed1LR)
                  * convergeMaxAngleLR * flatness;

      const dx = drainDirXPadLR[idx];
      const dy = drainDirYPadLR[idx];
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      drainDirXPadLR[idx] = dx * cos - dy * sin;
      drainDirYPadLR[idx] = dx * sin + dy * cos;
    }
  }

  // Extract interior 512×512 drainage direction from the padded grid
  const drainDirXLR = new Float32Array(NN_LR);
  const drainDirYLR = new Float32Array(NN_LR);
  for (let ry = 0; ry < S_LR; ry++) {
    for (let rx = 0; rx < S_LR; rx++) {
      const srcIdx = (ry + MARGIN_LR) * S_PAD_LR + (rx + MARGIN_LR);
      const dstIdx = ry * S_LR + rx;
      drainDirXLR[dstIdx] = drainDirXPadLR[srcIdx];
      drainDirYLR[dstIdx] = drainDirYPadLR[srcIdx];
    }
  }

  // Pass 1c: apply isotropic + anisotropic noise, build cell objects
  for (let ry = 0; ry < S_LR; ry++) {
    for (let rx = 0; rx < S_LR; rx++) {
      const idx = ry * S_LR + rx;
      const worldX = originWorldX + rx;
      const worldY = originWorldY + ry;
      const px = worldX / CELLS_PER_PLANETARY;
      const py = worldY / CELLS_PER_PLANETARY;
      const baseElev = baseElevGridLR[idx];

      // Isotropic detail noise (same as computeRegionalBaseCell)
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
        detailAmp = state.params.coastAmplitude * 0.4;
      } else {
        detailAmp = state.params.coastAmplitude + state.params.mountainDetail * elevNorm;
      }

      // Anisotropic channel noise
      let channelOffset = 0;
      if (baseElev > 0) {
        const fdx = drainDirXLR[idx];
        const fdy = drainDirYLR[idx];
        const alongDrain  =  worldX * fdx + worldY * fdy;
        const acrossDrainCorr = worldX * (-fdy) + worldY * fdx;
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

        const slopeMagLocal = Math.sqrt(
          (rx > 0 && rx < S_LR - 1 ? (baseElevGridLR[idx + 1] - baseElevGridLR[idx - 1]) / 2 : 0) ** 2 +
          (ry > 0 && ry < S_LR - 1 ? (baseElevGridLR[idx + S_LR] - baseElevGridLR[idx - S_LR]) / 2 : 0) ** 2
        );
        const zoneLocal = classifyZone(baseElev, slopeMagLocal, maxLand);
        let channelAmp;
        switch (zoneLocal) {
          case 'lowland':     channelAmp = 0.018; break;
          case 'coastal':     channelAmp = 0.010; break;
          case 'tidal':       channelAmp = 0.006; break;
          case 'mid_slope':   channelAmp = 0.006; break;
          case 'upper_slope': channelAmp = 0.003; break;
          case 'summit':      channelAmp = 0.001; break;
          default:            channelAmp = 0.008; break;
        }
        channelOffset = channelNoise * channelAmp;
        // Reduce isotropic noise on flat terrain so anisotropic channels dominate
        if (zoneLocal === 'lowland')          detailAmp *= 0.4;
        else if (zoneLocal === 'coastal')     detailAmp *= 0.5;
        else if (zoneLocal === 'tidal')       detailAmp *= 0.5;
        else if (zoneLocal === 'mid_slope')   detailAmp *= 0.7;
        // upper_slope and summit keep full amplitude
      }

      const elev = baseElev + detail * detailAmp + channelOffset;
      elevGrid[idx] = elev;

      const cell = {
        rx, ry,
        worldX, worldY,
        baseElevation: elev,
        elevation: elev,
        isLand: elev > 0,
        // planetary-sampled fields
        precipitation: bilinearInterpolate(px, py, c => c.precipitation),
        groundwater: bilinearInterpolate(px, py, c => c.groundwater),
        waterAvailability: bilinearInterpolate(px, py, c => c.waterAvailability),
        atmosphericMoisture: bilinearInterpolate(px, py, c => c.atmosphericMoisture),
        temperature: bilinearInterpolate(px, py, c => c.temperature),
        drainage: bilinearInterpolate(px, py, c => c.drainage),
        windSpeed: bilinearInterpolate(px, py, c => c.windSpeed),
        sst: bilinearInterpolate(px, py, c => c.sst),
        minerals: {
          iron: bilinearInterpolate(px, py, c => c.minerals.iron),
          copper: bilinearInterpolate(px, py, c => c.minerals.copper),
          manganese: bilinearInterpolate(px, py, c => c.minerals.manganese),
        },
        grainSize: 0.3,
        baseGrainSize: 0.3,
        windU: bilinearInterpolate(px, py, c => c.windU),
        windV: bilinearInterpolate(px, py, c => c.windV),
        currentSpeed: 0,
        currentU: 0,
        currentV: 0,
      };
      cell.mineralTotal = cell.minerals.iron + cell.minerals.copper + cell.minerals.manganese;
      cell.dominant = maxKey(cell.minerals);
      cell.isShallowWater = elev > -0.08 && elev <= 0;
      cell.isDeepWater = elev <= -0.08;
      cell.isFreezing = cell.temperature < 0.5;
      state.regionalCells[rx][ry] = cell;
    }
  }

  // Pass 2: slopes + zone classification
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const cell = state.regionalCells[rx][ry];
      const xm = Math.max(0, rx - 1), xp = Math.min(REGIONAL_SIZE - 1, rx + 1);
      const ym = Math.max(0, ry - 1), yp = Math.min(REGIONAL_SIZE - 1, ry + 1);
      const gx = (elevGrid[ry * REGIONAL_SIZE + xp] - elevGrid[ry * REGIONAL_SIZE + xm]) / 2;
      const gy = (elevGrid[yp * REGIONAL_SIZE + rx] - elevGrid[ym * REGIONAL_SIZE + rx]) / 2;
      cell.slopeMag = Math.sqrt(gx * gx + gy * gy);
      cell.slopeDir = Math.atan2(gy, gx);
      cell.zone = classifyZone(cell.baseElevation, cell.slopeMag, maxLand);
    }
  }

  // Pass 3: drainage (flow accumulation over regional grid)
  computeRegionalDrainage(elevGrid);

  // ── Pass 3b: inherit planetary stream order as floor (LowRes path) ──
  if (state.planet && state.planet.streamOrder) {
    const MIN_DENSITY = [0, 0.30, 0.55, 0.80];

    for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
      for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
        const cell = state.regionalCells[rx][ry];
        if (!cell.isLand) continue;

        const px = cell.worldX / CELLS_PER_PLANETARY;
        const py = cell.worldY / CELLS_PER_PLANETARY;
        // Nearest-neighbor from the planetary grid
        const gi = (Math.round(py) % H) * W + ((Math.round(px) % W) + W) % W;
        const hrSO = state.planet.streamOrder[gi] || 0;

        if (hrSO > cell.streamOrder) {
          cell.streamOrder = hrSO;
        }
        const minDensity = MIN_DENSITY[Math.min(cell.streamOrder, 3)];
        if (cell.drainageDensity < minDensity) {
          cell.drainageDensity = minDensity;
        }
      }
    }
  }

  // Pass 4: substrate, saturation, standing water
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const cell = state.regionalCells[rx][ry];
      computeRegionalSubstrate(cell, regionSeed);
    }
  }
  computeStandingWater(elevGrid);

  // Pass 5: flora + terrain type
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const cell = state.regionalCells[rx][ry];
      computeRegionalFloraCell(cell);
      deriveRegionalTerrainType(cell);
    }
  }

  printRegionalDiagnostic();
}

// ── Bilinear sample of a high-res typed array at fractional (fx, fy) ──
//    fx wraps in longitude (0..HR_W), fy clamps in latitude (0..HR_H-1).
// ── Regional detail generation (HIGH-RES path) ──
//    Reads the BASE physical state from the already-computed high-res grid,
//    then refines it with regional-scale coastline noise and higher-resolution
//    drainage. Ridge cells (streamOrder 0) inherit the high-res values
//    unchanged, so they render identically to the planetary map; channel cells
//    are pushed wetter / finer, adding detail the high-res grid can't resolve.
function generateRegionalDetailHiRes(centerX, centerY) {
  _planetMaxLandElev = null; // recompute per generation
  const maxLand = getPlanetMaxLandElev();

  const seed = parseInt(document.getElementById('seedInput').value, 10) || 0;
  const regionSeed = (seed ^ 0x51ED270B) | 0;

  // World-space origin (top-left) in regional-cell units
  const originWorldX = centerX * CELLS_PER_PLANETARY - REGIONAL_SIZE / 2;
  const originWorldY = centerY * CELLS_PER_PLANETARY - REGIONAL_SIZE / 2;

  state.regionalCells = new Array(REGIONAL_SIZE);
  for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
    state.regionalCells[rx] = new Array(REGIONAL_SIZE);
  }

  // Pass 1a: read BASE elevation from hi-res grid (no noise yet).
  // Use a padded grid (MARGIN cells on each side) so the local slope and
  // convergence perturbation stabilize before reaching the interior 512×512
  // region. This ensures continuity when the user pans the regional map.
  const S = REGIONAL_SIZE;
  const NN = S * S;
  const MARGIN = 64;
  const S_PAD = S + 2 * MARGIN;  // 640
  const NN_PAD = S_PAD * S_PAD;
  const baseElevGrid = new Float32Array(NN);
  const elevGrid = new Float32Array(NN);

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
      baseElevPad[padIdx] = bilinearSampleHR(state.hiResData.elevation, hx, hy, state.HR_W, state.HR_H);
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

  // Pass 1b: drainage direction from hi-res elevation gradient (globally deterministic).
  // Instead of BFS (which is window-dependent), sample the GLOBAL hi-res elevation
  // grid at a wide window around each cell to determine downhill direction. The hi-res
  // grid was computed once during planet generation and is globally consistent — this
  // gives the same direction regardless of which regional view the cell appears in.
  const drainDirXPad = new Float32Array(NN_PAD);
  const drainDirYPad = new Float32Array(NN_PAD);

  const GRAD_RADIUS_HR = 3.0;  // radius in hi-res cells (~3 × 39 km = ~117 km at 4×)
  const GRAD_STEPS = 8;        // sample directions (N, NE, E, SE, S, SW, W, NW)
  const gradDx = [0, 1, 1, 1, 0, -1, -1, -1];
  const gradDy = [-1, -1, 0, 1, 1, 1, 0, -1];

  const slopeMagPad = new Float32Array(NN_PAD);

  for (let ry = 0; ry < S_PAD; ry++) {
    for (let rx = 0; rx < S_PAD; rx++) {
      const idx = ry * S_PAD + rx;
      if (baseElevPad[idx] <= 0) {
        drainDirXPad[idx] = 0;
        drainDirYPad[idx] = 1;
        continue;
      }

      // Compute hi-res coordinates for this padded cell
      const worldX = originWorldX + (rx - MARGIN);
      const worldY = originWorldY + (ry - MARGIN);
      const hx = (worldX / CELLS_PER_PLANETARY) * state.hiResMultiplier;
      const hy = (worldY / CELLS_PER_PLANETARY) * state.hiResMultiplier;
      const centerElev = baseElevPad[idx];

      // Wide-window gradient from global hi-res elevation
      let gx = 0, gy = 0;
      for (let d = 0; d < GRAD_STEPS; d++) {
        const sampleHx = hx + gradDx[d] * GRAD_RADIUS_HR;
        const sampleHy = hy + gradDy[d] * GRAD_RADIUS_HR;
        const sampleElev = bilinearSampleHR(state.hiResData.elevation, sampleHx, sampleHy, state.HR_W, state.HR_H);
        const diff = centerElev - sampleElev;  // positive = downhill in that direction
        gx += gradDx[d] * diff;
        gy += gradDy[d] * diff;
      }
      const gLen = Math.sqrt(gx * gx + gy * gy) || 1;
      drainDirXPad[idx] = gx / gLen;
      drainDirYPad[idx] = gy / gLen;

      // Local 7×7 slope on the padded base elevation grid
      let localGx = 0, localGy = 0, localWt = 0;
      for (let ddy = -3; ddy <= 3; ddy++) {
        for (let ddx = -3; ddx <= 3; ddx++) {
          if (ddx === 0 && ddy === 0) continue;
          const nrx = rx + ddx, nry = ry + ddy;
          if (nrx < 0 || nrx >= S_PAD || nry < 0 || nry >= S_PAD) continue;
          const w = 1.0 / Math.sqrt(ddx * ddx + ddy * ddy);
          const diff = baseElevPad[idx] - baseElevPad[nry * S_PAD + nrx];
          localGx += ddx * diff * w;
          localGy += ddy * diff * w;
          localWt += w;
        }
      }
      if (localWt > 0) { localGx /= localWt; localGy /= localWt; }
      const localSlopeMag = Math.sqrt(localGx * localGx + localGy * localGy);
      slopeMagPad[idx] = localSlopeMag;

      // Blend: steep terrain uses local slope, flat terrain uses wide gradient
      const FLAT_THRESH  = 0.0015;
      const STEEP_THRESH = 0.005;
      const t = clamp((localSlopeMag - FLAT_THRESH) / (STEEP_THRESH - FLAT_THRESH), 0, 1);

      if (t > 0.01 && localSlopeMag > 0.0001) {
        const nlx = localGx / localSlopeMag;
        const nly = localGy / localSlopeMag;

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
      const flatness = clamp(1.0 - slopeMagPad[idx] / 0.005, 0, 1);
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
        detailAmp = state.params.coastAmplitude * 0.4;
      } else {
        detailAmp = state.params.coastAmplitude + state.params.mountainDetail * elevNorm;
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
          case 'lowland':     channelAmp = 0.018; break;
          case 'coastal':     channelAmp = 0.010; break;
          case 'tidal':       channelAmp = 0.006; break;
          case 'mid_slope':   channelAmp = 0.006; break;
          case 'upper_slope': channelAmp = 0.003; break;
          case 'summit':      channelAmp = 0.001; break;
          default:            channelAmp = 0.008; break;
        }

        channelOffset = channelNoise * channelAmp;

        // Reduce isotropic noise on flat terrain so anisotropic channels dominate
        if (zoneLocal === 'lowland')          detailAmp *= 0.4;
        else if (zoneLocal === 'coastal')     detailAmp *= 0.5;
        else if (zoneLocal === 'tidal')       detailAmp *= 0.5;
        else if (zoneLocal === 'mid_slope')   detailAmp *= 0.7;
        // upper_slope and summit keep full amplitude
      }

      const elev = baseElev + detail * detailAmp + channelOffset;
      elevGrid[idx] = elev;

      // ── Interpolated high-res physical base fields ──
      const hrGrain    = bilinearSampleHR(state.hiResData.grainSize, hx, hy, state.HR_W, state.HR_H);
      const hrSat      = bilinearSampleHR(state.hiResData.saturation, hx, hy, state.HR_W, state.HR_H);
      const hrGCover   = bilinearSampleHR(state.hiResData.groundCover, hx, hy, state.HR_W, state.HR_H);
      const hrCanopy   = bilinearSampleHR(state.hiResData.canopyDensity, hx, hy, state.HR_W, state.HR_H);
      const hrChemo    = bilinearSampleHR(state.hiResData.chemoCrust, hx, hy, state.HR_W, state.HR_H);
      const hrOrganic  = bilinearSampleHR(state.hiResData.organicContent, hx, hy, state.HR_W, state.HR_H);
      const hrWTD      = bilinearSampleHR(state.hiResData.waterTableDepth, hx, hy, state.HR_W, state.HR_H);
      const hrPrecip   = bilinearSampleHR(state.hiResData.precipitation, hx, hy, state.HR_W, state.HR_H);
      const hrGW       = bilinearSampleHR(state.hiResData.groundwater, hx, hy, state.HR_W, state.HR_H);
      const hrVolc     = bilinearSampleHR(state.hiResData.volcanism, hx, hy, state.HR_W, state.HR_H);
      const hrIron     = bilinearSampleHR(state.hiResData.iron, hx, hy, state.HR_W, state.HR_H);
      const hrCopper   = bilinearSampleHR(state.hiResData.copper, hx, hy, state.HR_W, state.HR_H);
      const hrManganese= bilinearSampleHR(state.hiResData.manganese, hx, hy, state.HR_W, state.HR_H);

      // Flora type: nearest-neighbor (discrete field, don't interpolate).
      const ftInt = nearestSampleHR(state.hiResData.floraType, hx, hy, state.HR_W, state.HR_H);
      const hrFloraType = HR_FLORA_NAMES[ftInt] || 'barren';

      // Fields the high-res grid doesn't carry stay sampled from the low-res
      // grid so the non-high-res overlays (moisture, temperature, currents,
      // wind, etc.) keep working exactly as before.
      const cell = {
        rx, ry,
        worldX, worldY,
        baseElevation: elev,
        elevation: elev,
        isLand: elev > 0,
        // planetary-sampled atmospheric fields (not present at high-res)
        precipitation: hrPrecip,
        groundwater: hrGW,
        waterAvailability: bilinearInterpolate(px, py, c => c.waterAvailability),
        atmosphericMoisture: bilinearInterpolate(px, py, c => c.atmosphericMoisture),
        temperature: bilinearInterpolate(px, py, c => c.temperature),
        drainage: bilinearInterpolate(px, py, c => c.drainage),
        windSpeed: bilinearInterpolate(px, py, c => c.windSpeed),
        sst: bilinearInterpolate(px, py, c => c.sst),
        volcanism: hrVolc,
        minerals: {
          iron: hrIron,
          copper: hrCopper,
          manganese: hrManganese,
        },
        grainSize: hrGrain,
        baseGrainSize: hrGrain,
        windU: bilinearInterpolate(px, py, c => c.windU),
        windV: bilinearInterpolate(px, py, c => c.windV),
        currentSpeed: 0,
        currentU: 0,
        currentV: 0,
        // high-res base values retained for the refinement passes
        _hrGrainSize: hrGrain,
        _hrSaturation: hrSat,
        _hrGroundCover: hrGCover,
        _hrCanopy: hrCanopy,
        _hrChemoCrust: hrChemo,
        _hrOrganic: hrOrganic,
        _hrWaterTableDepth: hrWTD,
        _hrFloraType: hrFloraType,
      };
      cell.mineralTotal = cell.minerals.iron + cell.minerals.copper + cell.minerals.manganese;
      cell.dominant = maxKey(cell.minerals);
      // Reclassify land/water from the refined elevation (adds coastline detail)
      cell.isShallowWater = elev > -0.08 && elev <= 0;
      cell.isDeepWater = elev <= -0.08;
      cell.isFreezing = cell.temperature < 0.5;
      state.regionalCells[rx][ry] = cell;
    }
  }

  // Pass 2: slopes + zone classification (on the refined elevation grid)
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const cell = state.regionalCells[rx][ry];
      const xm = Math.max(0, rx - 1), xp = Math.min(REGIONAL_SIZE - 1, rx + 1);
      const ym = Math.max(0, ry - 1), yp = Math.min(REGIONAL_SIZE - 1, ry + 1);
      const gx = (elevGrid[ry * REGIONAL_SIZE + xp] - elevGrid[ry * REGIONAL_SIZE + xm]) / 2;
      const gy = (elevGrid[yp * REGIONAL_SIZE + rx] - elevGrid[ym * REGIONAL_SIZE + rx]) / 2;
      cell.slopeMag = Math.sqrt(gx * gx + gy * gy);
      cell.slopeDir = Math.atan2(gy, gx);
      cell.zone = classifyZone(cell.baseElevation, cell.slopeMag, maxLand);
    }
  }

  // Pass 3: drainage (higher-resolution flow accumulation than the high-res grid)
  computeRegionalDrainage(elevGrid);

  // ── Pass 3b: inherit hi-res stream order as floor ──
  // The hi-res grid computed flow accumulation globally (stepHR5_drainage).
  // The regional flow accumulation is window-bounded and misses upstream
  // contributions from outside the view. Use the hi-res stream order as a
  // minimum — the regional computation can only increase it, not decrease it.
  if (state.hiResData && state.hiResData.streamOrder) {
    // Minimum drainageDensity values corresponding to each stream order
    // threshold, so downstream consumers (saturation, grain) see consistent
    // values for globally-established channels.
    const MIN_DENSITY = [0, 0.30, 0.55, 0.80];
    //                  so=0  so=1   so=2   so=3

    for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
      for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
        const cell = state.regionalCells[rx][ry];
        if (!cell.isLand) continue;

        const hx = (cell.worldX / CELLS_PER_PLANETARY) * state.hiResMultiplier;
        const hy = (cell.worldY / CELLS_PER_PLANETARY) * state.hiResMultiplier;
        const hrSO = nearestSampleHR(state.hiResData.streamOrder, hx, hy, state.HR_W, state.HR_H);

        if (hrSO > cell.streamOrder) {
          cell.streamOrder = hrSO;
        }
        const minDensity = MIN_DENSITY[Math.min(cell.streamOrder, 3)];
        if (cell.drainageDensity < minDensity) {
          cell.drainageDensity = minDensity;
        }
      }
    }
  }

  // Pass 4: refine substrate / saturation / water table from the high-res base.
  //         Ridge cells keep high-res values; channels get wetter and finer.
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      refineRegionalSubstrateFromHiRes(state.regionalCells[rx][ry]);
    }
  }
  computeStandingWater(elevGrid);

  // Pass 5: refine flora from the (possibly drainage-modified) state, then
  //         derive terrain type through the canonical function.
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const cell = state.regionalCells[rx][ry];
      refineRegionalFloraFromHiRes(cell);
      deriveRegionalTerrainType(cell);
    }
  }

  printRegionalDiagnostic();
}

// ── Refine substrate/saturation/water table from the high-res base ──
//    The high-res values are the starting point; drainage structure (resolved
//    only at regional resolution) pushes channels wetter and finer. Ridge
//    cells (streamOrder 0) are left exactly at their high-res base.
function refineRegionalSubstrateFromHiRes(cell) {
  // Start from the interpolated high-res base
  cell.grainSize = cell._hrGrainSize;
  cell.saturation = cell._hrSaturation;
  cell.waterTableDepth = cell._hrWaterTableDepth;

  if (!cell.isLand) {
    cell.saturation = 1.0;
    cell.baseGrainSize = cell.grainSize;
    return;
  }

  // ── Break bilinear interpolation contours ──
  // The hi-res grid provides only ~4 data points across the regional view.
  // Without noise, threshold crossings (canopy 0.45, cover type transitions)
  // produce grid-aligned straight-line boundaries. Small world-coordinate
  // noise makes these boundaries follow organic contours.
  const precipNoiseSeed = 0xA1B2;
  const gwNoiseSeed = 0xC3D4;
  const noiseFreq = 0.015;   // ~65-cell wavelength (~10 km)
  const precipNoiseAmp = 0.06;
  const gwNoiseAmp = 0.04;

  cell.precipitation += noise2D(cell.worldX * noiseFreq, cell.worldY * noiseFreq, precipNoiseSeed) * precipNoiseAmp;
  cell.precipitation = clamp(cell.precipitation, 0, 1);

  cell.groundwater += noise2D(cell.worldX * noiseFreq, cell.worldY * noiseFreq, gwNoiseSeed) * gwNoiseAmp;
  cell.groundwater = clamp(cell.groundwater, 0, 1);

  const so = cell.streamOrder;

  // ── Drainage-responsive water table modulation ──
  // The hi-res base WTD is 0.00 for most lowland continental cells.
  // Drainage creates differentiation: ridges shed water (WTD pushed positive),
  // channels collect water (WTD pushed negative/zero).
  const drainParams = {
    summit:      { ridge: 0.55, so1: 0.30, so2: 0.10, channel: 0.00 },
    upper_slope: { ridge: 0.40, so1: 0.18, so2: 0.05, channel: 0.00 },
    mid_slope:   { ridge: 0.28, so1: 0.10, so2: 0.02, channel: -0.01 },
    lowland:     { ridge: 0.18, so1: 0.06, so2: 0.00, channel: -0.02 },
    coastal:     { ridge: 0.06, so1: 0.02, so2: 0.00, channel: -0.02 },
    tidal:       { ridge: 0.00, so1: 0.00, so2: 0.00, channel: -0.03 },
  };

  const dp = drainParams[cell.zone] || drainParams.lowland;
  let wtdAdjust;
  if (so === 0) {
    wtdAdjust = dp.ridge;
  } else if (so === 1) {
    wtdAdjust = dp.so1;
  } else if (so === 2) {
    wtdAdjust = dp.so2;
  } else {
    wtdAdjust = dp.channel;  // negative = water table above surface
  }

  cell.waterTableDepth = cell._hrWaterTableDepth + wtdAdjust;

  // Recompute saturation from the drainage-modulated WTD
  // (same capillary fringe model as stepHR4_waterTableRow)
  const capillary = (1.0 - cell.grainSize) * 0.15;
  const effDepth = cell.waterTableDepth - capillary;
  cell.saturation = effDepth <= 0
    ? Math.min(1, Math.max(0.7, 1.0 - effDepth * 0.5))
    : Math.min(0.7, Math.exp(-effDepth * 8.0));

  cell.saturation = clamp(cell.saturation, 0, 1);

  // Channels deposit finer sediment than the ridges around them.
  if (so >= 2) {
    cell.grainSize = Math.min(cell.grainSize, 0.2);
  } else if (so >= 1) {
    cell.grainSize = Math.min(cell.grainSize, cell.grainSize * 0.8 + 0.05);
  }
  cell.grainSize = clamp(cell.grainSize, 0.05, 1.0);
  cell.baseGrainSize = cell.grainSize;
}

// ── Refine flora from the (possibly drainage-modified) state ──
//    Ground cover, canopy, chemo crust and organic content are recomputed with
//    the SAME formulas the high-res grid used (stepHR6), so a ridge cell whose
//    saturation/grain were left at the high-res base reproduces the high-res
//    flora exactly. Channel cells differ because their inputs changed. Flora
//    *type* (photo/chemo/mixo/barren) is inherited from the high-res grid.
function refineRegionalFloraFromHiRes(cell) {
  if (!cell.isLand) {
    cell.floraType = 'none'; cell.floraDensity = 0;
    cell.canopy = 0; cell.groundCover = 0;
    cell.chemoCrust = 0; cell.organicContent = 0;
    return;
  }
  if (cell.isFreezing) {
    cell.floraType = 'frozen'; cell.floraDensity = 0;
    cell.canopy = 0; cell.groundCover = 0;
    cell.chemoCrust = 0; cell.organicContent = 0;
    return;
  }

  // ── Re-derive flora type from continuous properties ──
  // Instead of inheriting cell._hrFloraType (a categorical value from the hi-res
  // grid that's identical across 128×128 regional cells), re-run the flora type
  // fitness competition using this cell's own mineral and water values.
  //
  // Domain warp: displace the mineral sampling coordinates with noise so the
  // classification boundary follows an organic contour instead of the bilinear
  // interpolation grid lines.

  if (state.hiResData) {
    const hx = (cell.worldX / CELLS_PER_PLANETARY) * state.hiResMultiplier;
    const hy = (cell.worldY / CELLS_PER_PLANETARY) * state.hiResMultiplier;

    // Domain warp (matches stepHR6_floraRow warp seeds and parameters)
    const warpScale = 0.08;
    const warpAmp = 1.8;
    const warpSeed1 = 0x7A3C;
    const warpSeed2 = 0x9E1F;
    const wx = hx + noise2D(hx * warpScale, hy * warpScale, warpSeed1) * warpAmp;
    const wy = hy + noise2D(hx * warpScale, hy * warpScale, warpSeed2) * warpAmp;

    // Sample minerals and water from warped coordinates
    const ironW = bilinearSampleHR(state.hiResData.iron, wx, wy, state.HR_W, state.HR_H);
    const copperW = bilinearSampleHR(state.hiResData.copper, wx, wy, state.HR_W, state.HR_H);
    const mnW = bilinearSampleHR(state.hiResData.manganese, wx, wy, state.HR_W, state.HR_H);
    const mineralTotalW = ironW + copperW + mnW;
    const precipW = bilinearSampleHR(state.hiResData.precipitation, wx, wy, state.HR_W, state.HR_H);
    const gwW = bilinearSampleHR(state.hiResData.groundwater, wx, wy, state.HR_W, state.HR_H);
    const volcW = bilinearSampleHR(state.hiResData.volcanism, wx, wy, state.HR_W, state.HR_H);

    // Flora type fitness competition (mirrors stepHR6_floraRow logic)
    const regWaterW = Math.min(1, precipW * 3.0 + gwW * 1.5);
    const photoFit = regWaterW * 0.8;
    const chemoFit = mineralTotalW * Math.max(regWaterW, volcW * 1.5) * 1.2;
    const mixoFit = (0.6 + 0.5 * mineralTotalW) * regWaterW;

    if (chemoFit > photoFit && chemoFit > mixoFit && chemoFit > 0.02) {
      cell.floraType = 'chemotrophic';
    } else if (mixoFit > photoFit && mixoFit > chemoFit && mixoFit > 0.02) {
      cell.floraType = 'mixotrophic';
    } else if (photoFit > 0.02) {
      cell.floraType = 'photosynthetic';
    } else {
      cell.floraType = 'barren';
    }
  } else {
    // LowRes fallback: use the cell's stored (interpolated) minerals directly
    const mineralTotal = cell.mineralTotal;
    const precip = cell.precipitation;
    const gw = cell.groundwater;
    const volc = cell.volcanism || 0;
    const regWater = Math.min(1, precip * 3.0 + gw * 1.5);
    const photoFit = regWater * 0.8;
    const chemoFit = mineralTotal * Math.max(regWater, volc * 1.5) * 1.2;
    const mixoFit = (0.6 + 0.5 * mineralTotal) * regWater;

    if (chemoFit > photoFit && chemoFit > mixoFit && chemoFit > 0.02) {
      cell.floraType = 'chemotrophic';
    } else if (mixoFit > photoFit && mixoFit > chemoFit && mixoFit > 0.02) {
      cell.floraType = 'mixotrophic';
    } else if (photoFit > 0.02) {
      cell.floraType = 'photosynthetic';
    } else {
      cell.floraType = 'barren';
    }
  }

  // ── From here, flora type is already set per cell above ──

  if (cell.hasWater) {
    // Water prevents rooted canopy but NOT ground-level biology.
    // Flora type was already re-derived above — water doesn't
    // change what KIND of organisms live here, just their structure.
    // Ground cover: shallow water supports floating mat; deep water
    // submerges it. Canopy: always zero (can't root in standing water).
    cell.canopy = 0;

    const wd = cell.waterDepth || 0;
    if (wd > 0.3) {
        // Deep water: fully submerged, no surface flora
        cell.groundCover = 0;
        cell.chemoCrust = 0;
    } else if (wd > 0.1) {
        // Moderate water: sparse floating mat
        cell.groundCover = cell._hrGroundCover * 0.3;
        cell.chemoCrust = cell._hrChemoCrust * 0.2;
    } else {
        // Shallow water or wet surface: substantial floating mat
        cell.groundCover = cell._hrGroundCover * 0.6;
        cell.chemoCrust = cell._hrChemoCrust * 0.5;
    }

    // Organic content: waterlogged decomposition is slow → organic accumulates
    const prod = cell.groundCover * 0.5;
    cell.organicContent = prod * 0.7;  // wet = slow decomposition

    cell.floraDensity = clamp(Math.max(cell.groundCover, cell.chemoCrust), 0, 1);
    return;
  }

  const sat = cell.saturation;
  const grain = cell.grainSize;
  const precip = cell.precipitation;
  const gw = cell.groundwater;
  const volc = cell.volcanism || 0;
  const mineralTotal = cell.mineralTotal;
  const hasWaterLocal = cell.waterTableDepth < -0.01;

  // Ground cover (mirrors stepHR6) — scaled by water availability
  let gc;
  if (hasWaterLocal) gc = 0.3;
  else if (grain > 0.8) gc = 0.08;
  else {
    const waterFactor = clamp(precip * 3.0 + gw * 2.0, 0, 1);
    gc = (0.5 + (1.0 - grain) * 0.4) * waterFactor;
  }
  cell.groundCover = gc;

  // Canopy (mirrors stepHR6)
  let cd = 0;
  if (!hasWaterLocal && grain <= 0.7) {
    const waterFactor = Math.min(1, precip * 3.0 + gw * 1.5);
    let satFactor;
    if (sat > 0.95) satFactor = 0.15;
    else if (sat > 0.85) satFactor = 0.35;
    else if (sat > 0.5) satFactor = 0.80;
    else if (sat > 0.3) satFactor = 1.0;
    else satFactor = 0.45;
    const subFactor = grain < 0.5 ? 1.0 : Math.max(0, 1.0 - (grain - 0.5) * 3.0);
    cd = waterFactor * satFactor * subFactor;
    if (waterFactor > 0.05 && subFactor > 0.1) cd = Math.max(cd, 0.12);
  }
  cell.canopy = cd;

  // Chemo crust (mirrors stepHR6) — uses unwarped cell.mineralTotal
  let cc = 0;
  if (mineralTotal > 0.4) {
    const cf = mineralTotal * Math.max(sat, volc * 1.5);
    const pf = gc * 0.8;
    if (cf > pf) {
      cc = Math.min(1, (cf - pf) * 2.0);
      cell.groundCover *= (1 - cc * 0.6);
    }
  }
  cell.chemoCrust = cc;

  // Density for the flora overlay, from the refined cover values.
  cell.floraDensity = clamp(Math.max(cell.canopy, cell.groundCover), 0, 1);

  // Organic content (mirrors stepHR6)
  const prod = (cell.groundCover + cd) * 0.5;
  cell.organicContent = prod * (sat > 0.7 ? 0.7 : 0.3);
}

// ── Regional drainage: D8 flow accumulation + stream order ──
function computeRegionalDrainage(elevGrid) {
  const N = REGIONAL_SIZE * REGIONAL_SIZE;
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  order.sort((a, b) => elevGrid[b] - elevGrid[a]);

  const flow = new Float32Array(N);
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      flow[ry * REGIONAL_SIZE + rx] = state.regionalCells[rx][ry].precipitation + 0.05;
    }
  }

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  for (let oi = 0; oi < N; oi++) {
    const i = order[oi];
    const rx = i % REGIONAL_SIZE;
    const ry = (i / REGIONAL_SIZE) | 0;
    const e = elevGrid[i];

    let lowest = -1, lowestElev = e;
    for (let d = 0; d < 8; d++) {
      const nx = rx + dx8[d], ny = ry + dy8[d];
      if (nx < 0 || nx >= REGIONAL_SIZE || ny < 0 || ny >= REGIONAL_SIZE) continue;
      const ni = ny * REGIONAL_SIZE + nx;
      if (elevGrid[ni] < lowestElev) {
        lowestElev = elevGrid[ni];
        lowest = ni;
      }
    }
    if (lowest >= 0) {
      flow[lowest] += flow[i];
    }
  }

  // Assign stream order from accumulated flow
  let maxFlow = 1;
  for (let i = 0; i < N; i++) if (flow[i] > maxFlow) maxFlow = flow[i];

  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const i = ry * REGIONAL_SIZE + rx;
      const cell = state.regionalCells[rx][ry];
      const f = flow[i];
      cell.flowAccum = f;
      const fn = Math.log(1 + f) / Math.log(1 + maxFlow);
      cell.drainageDensity = fn;
      if (fn > 0.75) cell.streamOrder = 3;
      else if (fn > 0.5) cell.streamOrder = 2;
      else if (fn > 0.28) cell.streamOrder = 1;
      else cell.streamOrder = 0;
    }
  }
}

// ── Substrate & saturation for a regional cell ──
function computeRegionalSubstrate(cell, seed) {
  const grainNoise = noise2D(cell.worldX * 0.05, cell.worldY * 0.05, seed + 4400);
  let grain;
  const zone = cell.zone;
  if (zone === 'summit' || zone === 'upper_slope') {
    grain = 0.75 + grainNoise * 0.2;   // coarse / rocky
  } else if (zone === 'mid_slope') {
    grain = 0.5 + grainNoise * 0.2;
  } else if (zone === 'lowland') {
    grain = 0.3 + grainNoise * 0.15;
  } else if (zone === 'coastal' || zone === 'tidal') {
    grain = 0.2 + grainNoise * 0.15;   // fine / silt
  } else {
    grain = 0.4 + grainNoise * 0.2;
  }
  if (cell.streamOrder >= 2) grain = Math.min(grain, 0.35); // river deposits fines
  cell.grainSize = clamp(grain, 0.05, 1.0);
  cell.baseGrainSize = cell.grainSize;

  // ── Break bilinear interpolation contours (same as HiRes path) ──
  if (cell.isLand) {
    const precipNoiseSeed = 0xA1B2;
    const gwNoiseSeed = 0xC3D4;
    const noiseFreq = 0.015;
    const precipNoiseAmp = 0.06;
    const gwNoiseAmp = 0.04;

    cell.precipitation += noise2D(cell.worldX * noiseFreq, cell.worldY * noiseFreq, precipNoiseSeed) * precipNoiseAmp;
    cell.precipitation = clamp(cell.precipitation, 0, 1);

    cell.groundwater += noise2D(cell.worldX * noiseFreq, cell.worldY * noiseFreq, gwNoiseSeed) * gwNoiseAmp;
    cell.groundwater = clamp(cell.groundwater, 0, 1);
  }

  // Saturation: combination of precipitation, groundwater, drainage, low slope
  const slopeFactor = clamp(1 - cell.slopeMag * 6, 0, 1);
  const drainageFactor = clamp(cell.drainageDensity * 1.5, 0, 1);
  let sat = cell.precipitation * 0.35 + cell.groundwater * 0.35 + drainageFactor * 0.3;
  sat *= (0.5 + slopeFactor * 0.5);
  if (!cell.isLand) sat = 1.0;
  cell.saturation = clamp(sat, 0, 1);

  // Water table depth proxy (0 = at surface)
  cell.waterTableDepth = clamp((1 - cell.saturation) * (0.3 + cell.baseElevation * 2), 0, 1);
}

// ── Standing water: fill local basins along major streams ──
function computeStandingWater(elevGrid) {
  const S = REGIONAL_SIZE;
  const N = S * S;
  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  // Minimum feature sizes — tightened for the wet planet (precip 1.00 everywhere).
  // Previous values were tuned for a nearly-dry planet and flooded too many cells.
  const REG_MIN_BASIN_AREA  = 20;    // was 12 — lake must span ≥20 cells
  const REG_MIN_BASIN_DEPTH = 0.04;  // was 0.02 — depression must be ≥4 cm deep
  const REG_MIN_WATER_FEAT  = 15;    // was 8  — connected water component ≥15 cells
  const REG_POUR_TOLERANCE  = 0.005; // was 0.008 — shallower fill level
  const REG_SHORE_DIST      = 2;     // unchanged

  // Reset all cells
  for (let ry = 0; ry < S; ry++) {
    for (let rx = 0; rx < S; rx++) {
      const cell = state.regionalCells[rx][ry];
      cell.hasWater = false;
      cell.waterDepth = 0;
    }
  }

  // Flat arrays for BFS processing (indexed ry * S + rx)
  const hasWater   = new Uint8Array(N);
  const wDepth     = new Float32Array(N);

  // ── Ocean tiles ──
  for (let ry = 0; ry < S; ry++) {
    for (let rx = 0; rx < S; rx++) {
      const cell = state.regionalCells[rx][ry];
      if (!cell.isLand) {
        hasWater[ry * S + rx] = 1;
        wDepth[ry * S + rx] = -cell.baseElevation;
      }
    }
  }

  // ── Channel water: stream order >= 3 at regional scale (each cell ~1km) ──
  // At regional scale, only major rivers (SO 3+) are visible.
  // SO 2 channels are ~10-50m wide — a small fraction of a 1 km cell.
  for (let ry = 0; ry < S; ry++) {
    for (let rx = 0; rx < S; rx++) {
      const cell = state.regionalCells[rx][ry];
      if (cell.isLand && cell.streamOrder >= 3 && cell.saturation > 0.85) {
        hasWater[ry * S + rx] = 1;
        wDepth[ry * S + rx] = 0.02 + cell.drainageDensity * 0.05;
      }
    }
  }

  // ── Basin detection and filling ──
  const visited = new Uint8Array(N);
  for (let ry = 0; ry < S; ry++) {
    for (let rx = 0; rx < S; rx++) {
      const i = ry * S + rx;
      if (elevGrid[i] <= 0 || hasWater[i] || visited[i]) continue;

      // Check local minimum
      const e = elevGrid[i];
      let isMin = true;
      for (let d = 0; d < 8; d++) {
        const nx = rx + dx8[d], ny = ry + dy8[d];
        if (nx < 0 || nx >= S || ny < 0 || ny >= S) continue;
        if (elevGrid[ny * S + nx] <= e) { isMin = false; break; }
      }
      if (!isMin) continue;

      // BFS flood-fill basin
      const fillLevel = e + REG_POUR_TOLERANCE;
      const queue = [i];
      const basin = [i];
      visited[i] = 1;
      let maxDepth = 0;
      let head = 0;
      while (head < queue.length) {
        const ci = queue[head++];
        const cx = ci % S, cy = (ci / S) | 0;
        const depth = fillLevel - elevGrid[ci];
        if (depth > maxDepth) maxDepth = depth;
        for (let d = 0; d < 8; d++) {
          const nx = cx + dx8[d], ny = cy + dy8[d];
          if (nx < 0 || nx >= S || ny < 0 || ny >= S) continue;
          const ni = ny * S + nx;
          if (visited[ni] || elevGrid[ni] <= 0 || hasWater[ni]) continue;
          if (elevGrid[ni] < fillLevel) {
            visited[ni] = 1;
            queue.push(ni);
            basin.push(ni);
          }
        }
      }

      // Filter
      if (basin.length < REG_MIN_BASIN_AREA) continue;
      if (maxDepth < REG_MIN_BASIN_DEPTH) continue;
      // Check center cell has reasonable saturation
      const centerCell = state.regionalCells[rx][ry];
      if (centerCell.saturation < 0.4) continue;

      for (let b = 0; b < basin.length; b++) {
        const bi = basin[b];
        hasWater[bi] = 1;
        wDepth[bi] = Math.max(0.005, fillLevel - elevGrid[bi]);
      }
    }
  }

  // ── Connected component filtering ──
  const ccLabel = new Int32Array(N);
  ccLabel.fill(-1);
  let nextCC = 0;
  const ccSizes = [];

  for (let i = 0; i < N; i++) {
    if (!hasWater[i] || ccLabel[i] >= 0) continue;
    const label = nextCC++;
    const ccQueue = [i];
    ccLabel[i] = label;
    let size = 0;
    let hasOcean = false;
    let ch = 0;
    while (ch < ccQueue.length) {
      const ci = ccQueue[ch++];
      size++;
      if (elevGrid[ci] <= 0) hasOcean = true;
      const cx = ci % S, cy = (ci / S) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx8[d], ny = cy + dy8[d];
        if (nx < 0 || nx >= S || ny < 0 || ny >= S) continue;
        const ni = ny * S + nx;
        if (hasWater[ni] && ccLabel[ni] < 0) {
          ccLabel[ni] = label;
          ccQueue.push(ni);
        }
      }
    }
    ccSizes[label] = { size, hasOcean };
  }

  // Demote small land-only components
  for (let i = 0; i < N; i++) {
    if (!hasWater[i]) continue;
    const lab = ccLabel[i];
    if (lab >= 0 && !ccSizes[lab].hasOcean && ccSizes[lab].size < REG_MIN_WATER_FEAT) {
      hasWater[i] = 0;
      wDepth[i] = 0;
    }
  }

  // ── Shoreline saturation boost ──
  const dist = new Uint8Array(N);
  dist.fill(255);
  const shoreQueue = [];
  for (let i = 0; i < N; i++) {
    if (hasWater[i] && elevGrid[i] > 0) {
      dist[i] = 0;
      shoreQueue.push(i);
    }
  }
  let sHead = 0;
  while (sHead < shoreQueue.length) {
    const ci = shoreQueue[sHead++];
    const cd = dist[ci];
    if (cd >= REG_SHORE_DIST) continue;
    const cx = ci % S, cy = (ci / S) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx < 0 || nx >= S || ny < 0 || ny >= S) continue;
      const ni = ny * S + nx;
      const nd = cd + 1;
      if (nd < dist[ni] && !hasWater[ni] && elevGrid[ni] > 0) {
        dist[ni] = nd;
        shoreQueue.push(ni);
      }
    }
  }

  // ── Write back to state.regionalCells ──
  for (let ry = 0; ry < S; ry++) {
    for (let rx = 0; rx < S; rx++) {
      const i = ry * S + rx;
      const cell = state.regionalCells[rx][ry];
      cell.hasWater = !!hasWater[i];
      cell.waterDepth = wDepth[i];

      // Shoreline saturation boost for nearby land cells
      if (!hasWater[i] && dist[i] < 255 && dist[i] > 0) {
        const boost = Math.max(0, 0.12 - dist[i] * 0.05);
        cell.saturation = clamp((cell.saturation || 0) + boost, 0, 1);
      }
    }
  }
}

// ── Regional flora ──
function computeRegionalFloraCell(cell) {
  if (!cell.isLand) { cell.floraType = 'none'; cell.floraDensity = 0; return; }
  if (cell.isFreezing) { cell.floraType = 'frozen'; cell.floraDensity = 0; return; }
  if (cell.hasWater) {
    // Same graduated response as refineRegionalFloraFromHiRes:
    // water prevents rooted canopy, but floating mat persists in shallows.
    cell.canopy = 0;
    const wd = cell.waterDepth || 0;
    if (wd > 0.3) {
        cell.groundCover = 0;
        cell.chemoCrust = 0;
        cell.floraDensity = 0;
    } else if (wd > 0.1) {
        cell.groundCover = 0.2;
        cell.chemoCrust = 0;
        cell.floraDensity = 0.2;
    } else {
        cell.groundCover = 0.4;
        cell.chemoCrust = 0;
        cell.floraDensity = 0.4;
    }
    // Flora type: compute from fitness as normal (don't skip to 'none')
    const water = Math.max(cell.saturation, cell.waterAvailability);
    const photoFitness = water * 0.85 * (0.5 + 0.5 * (1 - cell.baseElevation));
    const chemoFitness = cell.mineralTotal * Math.max(water, cell.groundwater * 1.4) * 1.2;
    if (chemoFitness > photoFitness && chemoFitness > 0.05) {
        cell.floraType = 'chemotrophic';
    } else if (photoFitness > 0.05) {
        cell.floraType = 'photosynthetic';
    } else {
        cell.floraType = 'barren';
    }
    return;
  }

  const water = Math.max(cell.saturation, cell.waterAvailability);
  const photoFitness = water * 0.85 * (0.5 + 0.5 * (1 - cell.baseElevation));
  const chemoFitness = cell.mineralTotal * Math.max(water, cell.groundwater * 1.4) * 1.2;
  const mixoFitness  = (0.6 + 0.5 * cell.mineralTotal) * water;
  const maxFit = Math.max(photoFitness, chemoFitness, mixoFitness);

  if (maxFit < 0.05) { cell.floraType = 'barren'; cell.floraDensity = 0; return; }
  if (photoFitness >= chemoFitness && photoFitness >= mixoFitness) {
    cell.floraType = 'photosynthetic';
  } else if (chemoFitness >= mixoFitness) {
    cell.floraType = 'chemotrophic';
  } else {
    cell.floraType = 'mixotrophic';
  }
  cell.floraDensity = clamp(maxFit, 0, 1);

  // Ground cover vs canopy split
  cell.canopy = clamp(cell.floraDensity * (cell.floraType === 'photosynthetic' ? 1.0 : 0.6), 0, 1);
  cell.groundCover = clamp(cell.floraDensity * 0.8 + cell.saturation * 0.2, 0, 1);
}

// ── Regional terrain derivation — thin wrapper over deriveTerrainAndCover ──
function deriveRegionalTerrainType(cell) {
  // Water / ice handled here (canonical fn is elevation-based; regional keeps
  // its own deep/shallow/standing-water and freezing distinctions).
  if (!cell.isLand) {
    cell.terrainType = cell.isDeepWater ? 'deep_water' : 'water';
    cell.coverType = 'none';
    return;
  }
  if (cell.hasWater && (cell.waterDepth || 0) >= SHALLOW_WATER_TERRAIN_THRESHOLD) {
    cell.terrainType = 'water';
    cell.coverType = 'none';
    return;
  }
  // Shallow water (< threshold) falls through to normal terrain derivation.
  // The cell still has hasWater=true — it just doesn't RENDER as water terrain.
  if (cell.isFreezing) {
    cell.terrainType = 'rock';
    cell.coverType = 'none';
    return;
  }

  const isCoastal = cell.elevation > 0 && cell.elevation < 0.03;
  const result = deriveTerrainAndCover(
    cell.elevation,
    cell.isLand,
    cell.grainSize,
    cell.saturation,
    cell.groundCover,
    cell.canopy,
    cell.chemoCrust || 0,
    cell.floraType,
    cell.waterTableDepth,
    isCoastal
  );
  cell.terrainType = result.terrainType;
  cell.coverType = result.coverType;
}

function printRegionalDiagnostic() {
  if (!state.regionalCells) return;
  const counts = {};
  const zoneCounts = {};
  let land = 0, water = 0;
  for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
    for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
      const c = state.regionalCells[rx][ry];
      counts[c.terrainType] = (counts[c.terrainType] || 0) + 1;
      zoneCounts[c.zone] = (zoneCounts[c.zone] || 0) + 1;
      if (c.isLand) land++; else water++;
    }
  }
  const total = REGIONAL_SIZE * REGIONAL_SIZE;
  const fmt = (obj) => Object.keys(obj)
    .map(k => `${k}=${(obj[k] / total * 100).toFixed(1)}%`)
    .join('  ');
  console.log('=== REGIONAL DIAGNOSTIC ===');
  console.log('Land:', land, 'Water:', water);
  console.log('Terrain types: ' + fmt(counts));
  console.log('Zones: ' + fmt(zoneCounts));
  console.log('=== END REGIONAL DIAGNOSTIC ===');
}

export { generateRegionalDetail, classifyZone, printRegionalDiagnostic, deriveRegionalTerrainType };
