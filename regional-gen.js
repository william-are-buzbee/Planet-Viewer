// ══════════════════════════════════════════════════════════════════
// ── regional-gen.js — Regional detail generation ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import {
  W, H, TOTAL, noise2D, clamp,
  bilinearSampleHR, nearestSampleHR, maxKey
} from './core-math.js';
import { deriveTerrainAndCover, SHALLOW_WATER_TERRAIN_THRESHOLD } from './terrain-derive.js';
import { REGIONAL_SIZE, CELLS_PER_PLANETARY, PLANETARY_CELL_KM, REGIONAL_CELL_KM, HR_FLORA_NAMES } from './regional-constants.js';
import { computeRegionalDrainage } from './regional-drainage.js';
import { refineRegionalSubstrateFromHiRes, computeRegionalSubstrate } from './regional-substrate.js';
import { refineRegionalFloraFromHiRes, computeRegionalFloraCell, deriveWTDWater } from './regional-flora.js';

// Re-export constants for backward compatibility with external consumers
export { REGIONAL_SIZE, CELLS_PER_PLANETARY, PLANETARY_CELL_KM, REGIONAL_CELL_KM };

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
  const _t0 = performance.now();
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

  const _t1 = performance.now();
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

  const _t2 = performance.now();
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
        volcanism: bilinearInterpolate(px, py, c => c.volcanism || 0), // R1-FIX3: needed for unified chemoFitness
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

  const _t3 = performance.now();
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

  const _t4 = performance.now();
  // Pass 3: drainage (flow accumulation over regional grid)
  computeRegionalDrainage(elevGrid);

  // ── Pass 3b: inherit planetary stream order as floor (LowRes path) ──
  if (state.planet && state.planet.streamOrder) {
    const MIN_DENSITY = [0, 0.30, 0.55, 0.80, 0.92];

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
        const minDensity = MIN_DENSITY[Math.min(cell.streamOrder, 4)];
        if (cell.drainageDensity < minDensity) {
          cell.drainageDensity = minDensity;
        }
      }
    }
  }

  const _t5 = performance.now();
  // Pass 4: substrate, saturation
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const cell = state.regionalCells[rx][ry];
      computeRegionalSubstrate(cell, regionSeed);
    }
  }

  const _t6 = performance.now();
  // Pass 5a: flora (sets canopy, groundCover — "dry" values before flood modulation)
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      computeRegionalFloraCell(state.regionalCells[rx][ry]);
    }
  }

  const _t7 = performance.now();
  // Pass 5b: derive water state from WTD (replaces computeStandingWater)
  deriveWTDWater(state.regionalCells, REGIONAL_SIZE, REGIONAL_SIZE);

  const _t8 = performance.now();
  // Pass 5c: terrain type derivation
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      deriveRegionalTerrainType(state.regionalCells[rx][ry]);
    }
  }

  const _t9 = performance.now();
  console.log(`Regional gen LowRes breakdown (ms):`,
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
  const _t0 = performance.now();
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

  const _t1 = performance.now();
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

      // R2-FIX1: probabilistic flora type sampling
      // Instead of nearest-neighbor (which produces 128×128 blocks of uniform
      // flora type), sample the four surrounding hi-res cells and pick the type
      // with the highest bilinear weight, perturbed by noise for organic boundaries.
      let hrFloraType;
      {
        const x0 = Math.floor(hx), x1 = x0 + 1;
        const y0 = Math.floor(hy), y1 = y0 + 1;
        const fx = hx - x0;
        const fy = hy - y0;

        // Sample flora type at each corner
        const t00 = nearestSampleHR(state.hiResData.floraType, x0, y0, state.HR_W, state.HR_H);
        const t10 = nearestSampleHR(state.hiResData.floraType, x1, y0, state.HR_W, state.HR_H);
        const t01 = nearestSampleHR(state.hiResData.floraType, x0, y1, state.HR_W, state.HR_H);
        const t11 = nearestSampleHR(state.hiResData.floraType, x1, y1, state.HR_W, state.HR_H);

        // R3-FIX1: ocean filter on flora sampling
        // Sample elevation at each corner to identify ocean cells.
        // Ocean corners (elevation <= 0) have their bilinear weight zeroed out
        // so barren flora doesn't leak from ocean onto land cells.
        const HR_W = state.HR_W, HR_H = state.HR_H;
        const cx0 = ((x0 % HR_W) + HR_W) % HR_W;
        const cx1 = ((x1 % HR_W) + HR_W) % HR_W;
        const cy0 = Math.max(0, Math.min(HR_H - 1, y0));
        const cy1 = Math.max(0, Math.min(HR_H - 1, y1));
        const e00 = state.hiResData.elevation[cy0 * HR_W + cx0];
        const e10 = state.hiResData.elevation[cy0 * HR_W + cx1];
        const e01 = state.hiResData.elevation[cy1 * HR_W + cx0];
        const e11 = state.hiResData.elevation[cy1 * HR_W + cx1];

        const isOcean00 = e00 <= 0;
        const isOcean10 = e10 <= 0;
        const isOcean01 = e01 <= 0;
        const isOcean11 = e11 <= 0;

        if (isOcean00 && isOcean10 && isOcean01 && isOcean11) {
          // All four corners are ocean — cell is fully ocean
          hrFloraType = 'barren';
        } else {
          // Compute bilinear weights, zeroing ocean corners
          let w00 = isOcean00 ? 0 : (1 - fx) * (1 - fy);
          let w10 = isOcean10 ? 0 : fx * (1 - fy);
          let w01 = isOcean01 ? 0 : (1 - fx) * fy;
          let w11 = isOcean11 ? 0 : fx * fy;

          // Renormalize weights so they sum to 1.0
          const wSum = w00 + w10 + w01 + w11;
          if (wSum > 0) {
            w00 /= wSum; w10 /= wSum; w01 /= wSum; w11 /= wSum;
          }
          // End R3-FIX1

          // Fast path: all four land corners agree — no noise needed
          // (only check non-ocean corners for agreement)
          const landTypes = [];
          if (!isOcean00) landTypes.push(t00);
          if (!isOcean10) landTypes.push(t10);
          if (!isOcean01) landTypes.push(t01);
          if (!isOcean11) landTypes.push(t11);
          const allAgree = landTypes.length > 0 && landTypes.every(t => t === landTypes[0]);

          if (allAgree) {
            hrFloraType = HR_FLORA_NAMES[landTypes[0]] || 'barren';
          } else {
            // Boundary path: accumulate weights per type (ocean corners already zeroed)
            const typeWeights = new Map();
            const corners = [
              { type: t00, w: w00 },
              { type: t10, w: w10 },
              { type: t01, w: w01 },
              { type: t11, w: w11 },
            ];
            for (const c of corners) {
              if (c.w > 0) {
                typeWeights.set(c.type, (typeWeights.get(c.type) || 0) + c.w);
              }
            }

            // Add noise perturbation for organic boundaries
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
            hrFloraType = HR_FLORA_NAMES[bestType] || 'barren';
          }
        }
      }

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

  const _t3 = performance.now();
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

  const _t4 = performance.now();
  // Pass 3: drainage (higher-resolution flow accumulation than the high-res grid)
  computeRegionalDrainage(elevGrid);

  // R2-FIX2: removed hi-res stream order inheritance (former Pass 3b).
  // The regional D8 flow accumulation (computeRegionalDrainage) already
  // computes stream order from the bilinear-interpolated + noise-enhanced
  // elevation grid, which encodes the same drainage patterns the hi-res
  // global computation detected. Inheriting the hi-res stream order via
  // nearestSampleHR produced 128×128 blocks of uniform stream order,
  // causing discontinuous WTD/saturation/color steps at grid boundaries.

  const _t5 = performance.now();
  // Pass 4: refine substrate / saturation / water table from the high-res base.
  //         Ridge cells keep high-res values; channels get wetter and finer.
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      refineRegionalSubstrateFromHiRes(state.regionalCells[rx][ry]);
    }
  }

  const _t6 = performance.now();
  // Pass 5a: refine flora from the (possibly drainage-modified) state.
  //          Sets canopy, groundCover — these are the "dry" values before
  //          flood modulation. Must run before deriveWTDWater.
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      refineRegionalFloraFromHiRes(state.regionalCells[rx][ry]);
    }
  }

  const _t7 = performance.now();
  // Pass 5b: derive water state from WTD (replaces computeStandingWater).
  //          Reads WTD (set in Pass 4) and canopy (set in Pass 5a).
  //          Modulates canopy downward for flooded zones.
  deriveWTDWater(state.regionalCells, REGIONAL_SIZE, REGIONAL_SIZE);

  const _t8 = performance.now();
  // Pass 5c: derive terrain type through the canonical function.
  //          Reads the flood-modulated canopy to determine coverType.
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      deriveRegionalTerrainType(state.regionalCells[rx][ry]);
    }
  }

  const _t9 = performance.now();
  console.log(`Regional gen HiRes breakdown (ms):`,
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

  printRegionalDiagnostic();
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

  // S24: Fitness-confidence diagnostic (remove after verification)
  const floraCounts = {};
  let confLt05 = 0, confLt01 = 0;
  const confByType = {};
  for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
    for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
      const c = state.regionalCells[rx][ry];
      if (!c.isLand) continue;
      const ft = c.floraType || 'barren';
      floraCounts[ft] = (floraCounts[ft] || 0) + 1;
      const fc = c.fitnessConfidence;
      if (fc !== undefined) {
        if (fc < 0.5) confLt05++;
        if (fc < 0.1) confLt01++;
        if (!confByType[ft]) confByType[ft] = { min: fc, max: fc, sum: fc, n: 1 };
        else {
          const s = confByType[ft];
          s.min = Math.min(s.min, fc);
          s.max = Math.max(s.max, fc);
          s.sum += fc;
          s.n++;
        }
      }
    }
  }
  console.log('Flora types: ' + Object.entries(floraCounts).map(([k,v]) => `${k}=${v}`).join('  '));
  console.log(`Confidence < 0.5: ${confLt05} | < 0.1: ${confLt01}`);
  for (const [ft, s] of Object.entries(confByType)) {
    console.log(`  ${ft}: min=${s.min.toFixed(3)} max=${s.max.toFixed(3)} mean=${(s.sum/s.n).toFixed(3)} (n=${s.n})`);
  }

  console.log('=== END REGIONAL DIAGNOSTIC ===');
}

export { generateRegionalDetail, classifyZone, printRegionalDiagnostic, deriveRegionalTerrainType };
