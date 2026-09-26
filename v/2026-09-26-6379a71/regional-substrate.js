// ══════════════════════════════════════════════════════════════════
// ── regional-substrate.js — Grain size, saturation, water table depth
// ══════════════════════════════════════════════════════════════════

import { noise2D, clamp } from './core-math.js';

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

  // ── Wetness-dependent additional push for channels (tiered by stream order) ──
  // The hi-res base WTD is ~0.05–0.07 even in wet lowlands, so the
  // structural drainParams adjustment alone (-0.02 to -0.03) doesn't
  // push WTD below zero. In areas with high water supply, channels
  // should have water table at or above the surface. Scale additional
  // push by local water supply so dry channels stay dry.
  if (so >= 2) {
    const waterSupply = Math.min(1,
      cell.precipitation * 0.4 + (cell.groundwater || 0) * 0.35 + cell._hrSaturation * 0.25);
    let wtdPush;
    if (so >= 4) {
      // Major drainage — rivers. Full flooded forest transition.
      wtdPush = waterSupply * 0.22;
    } else if (so >= 3) {
      // Minor channels — streams. Visible wet zone, some shallow water.
      wtdPush = waterSupply * 0.14;
    } else {
      // SO 2 rills — damp ground, barely perceptible water.
      wtdPush = waterSupply * 0.05;
    }
    // Tidal zones: coastal proximity pushes WTD toward zero/negative.
    // Water table is near sea level at the coast. Stacks with stream order push.
    const isTidal = (cell.zone === 'tidal' || cell.zone === 'coastal');
    if (isTidal) {
      wtdPush += waterSupply * 0.08;
    }
    cell.waterTableDepth -= wtdPush;
  } else {
    // SO 0-1: still apply tidal push even without channel flow
    const isTidal = (cell.zone === 'tidal' || cell.zone === 'coastal');
    if (isTidal) {
      const waterSupply = Math.min(1,
        cell.precipitation * 0.4 + (cell.groundwater || 0) * 0.35 + cell._hrSaturation * 0.25);
      cell.waterTableDepth -= waterSupply * 0.08;
    }
  }

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

export { refineRegionalSubstrateFromHiRes };
