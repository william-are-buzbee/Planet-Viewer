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
  // Base WTD from saturation/elevation — always non-negative.
  cell.waterTableDepth = (1 - cell.saturation) * (0.3 + cell.baseElevation * 2);

  // ── Drainage-responsive WTD adjustment (matches HiRes drainParams) ──
  // Without this, WTD is always ≥ 0 and deriveWTDWater can never produce
  // standing water. Channels (SO ≥ 3) in lowlands/coastal zones get pushed
  // negative, creating the same WTD-derived water features as the HiRes path.
  if (cell.isLand) {
    const drainParams = {
      summit:      { ridge: 0.55, so1: 0.30, so2: 0.10, channel: 0.00 },
      upper_slope: { ridge: 0.40, so1: 0.18, so2: 0.05, channel: 0.00 },
      mid_slope:   { ridge: 0.28, so1: 0.10, so2: 0.02, channel: -0.01 },
      lowland:     { ridge: 0.18, so1: 0.06, so2: 0.00, channel: -0.02 },
      coastal:     { ridge: 0.06, so1: 0.02, so2: 0.00, channel: -0.02 },
      tidal:       { ridge: 0.00, so1: 0.00, so2: 0.00, channel: -0.03 },
    };
    const dp = drainParams[cell.zone] || drainParams.lowland;
    const so = cell.streamOrder;
    let wtdAdjust;
    if (so === 0) wtdAdjust = dp.ridge;
    else if (so === 1) wtdAdjust = dp.so1;
    else if (so === 2) wtdAdjust = dp.so2;
    else wtdAdjust = dp.channel;
    cell.waterTableDepth += wtdAdjust;

    // ── Wetness-dependent additional push (tiered by stream order, matches HiRes path) ──
    if (so >= 2) {
      const waterSupply = Math.min(1,
        cell.precipitation * 0.4 + (cell.groundwater || 0) * 0.35 + cell.saturation * 0.25);
      let wtdPush;
      if (so >= 4) {
        wtdPush = waterSupply * 0.22;
      } else if (so >= 3) {
        wtdPush = waterSupply * 0.14;
      } else {
        wtdPush = waterSupply * 0.05;
      }
      const isTidal = (cell.zone === 'tidal' || cell.zone === 'coastal');
      if (isTidal) {
        wtdPush += waterSupply * 0.08;
      }
      cell.waterTableDepth -= wtdPush;
    } else {
      const isTidal = (cell.zone === 'tidal' || cell.zone === 'coastal');
      if (isTidal) {
        const waterSupply = Math.min(1,
          cell.precipitation * 0.4 + (cell.groundwater || 0) * 0.35 + cell.saturation * 0.25);
        cell.waterTableDepth -= waterSupply * 0.08;
      }
    }
  }
}

export { refineRegionalSubstrateFromHiRes, computeRegionalSubstrate };
