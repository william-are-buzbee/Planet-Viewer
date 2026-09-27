// ══════════════════════════════════════════════════════════════════
// ── regional-substrate.js — Grain size, saturation, water table depth
// ══════════════════════════════════════════════════════════════════

import { noise2D, clamp } from './core-math.js';
import { ZONE_TIDAL, ZONE_COASTAL, ZONE_LOWLAND, ZONE_MID_SLOPE, ZONE_UPPER_SLOPE, ZONE_SUMMIT } from './regional-grid.js';

// Drainage-responsive water table adjustment (metres), indexed by zone enum.
// Ridges shed water (WTD pushed positive), channels collect it (pushed to or
// below the surface). Columns: streamOrder 0 (ridge), 1, 2, ≥3 (channel).
const DRAIN_WTD = [];
DRAIN_WTD[ZONE_SUMMIT]      = [0.55, 0.30, 0.10,  0.00];
DRAIN_WTD[ZONE_UPPER_SLOPE] = [0.40, 0.18, 0.05,  0.00];
DRAIN_WTD[ZONE_MID_SLOPE]   = [0.28, 0.10, 0.02, -0.01];
DRAIN_WTD[ZONE_LOWLAND]     = [0.18, 0.06, 0.00, -0.02];
DRAIN_WTD[ZONE_COASTAL]     = [0.06, 0.02, 0.00, -0.02];
DRAIN_WTD[ZONE_TIDAL]       = [0.00, 0.00, 0.00, -0.03];

// Break bilinear-interpolation contours: the hi-res grid provides only ~4
// samples across the regional view, so threshold crossings would otherwise be
// grid-aligned straight lines. Small world-coordinate noise makes them organic.
const PRECIP_NOISE_SEED = 0xA1B2, GW_NOISE_SEED = 0xC3D4;
const NOISE_FREQ = 0.015;      // ~65-cell wavelength (~10 km)
const PRECIP_NOISE_AMP = 0.06, GW_NOISE_AMP = 0.04;

// ── Refine substrate / saturation / water table from the high-res base ──
//    The high-res values are the starting point; drainage structure (resolved
//    only at regional resolution) pushes channels wetter and finer. Ridge cells
//    (streamOrder 0) keep their high-res base exactly.
function refineRegionalSubstrateFromHiRes(g, i) {
  let grain = g.hrGrainSize[i];
  let wtd = g.hrWaterTableDepth[i];

  if (!g.isLand[i]) {
    g.grainSize[i] = grain;
    g.saturation[i] = 1.0;
    g.waterTableDepth[i] = wtd;
    return;
  }

  const wx = g.wx(i), wy = g.wy(i);
  const precip = clamp(g.precipitation[i] + noise2D(wx * NOISE_FREQ, wy * NOISE_FREQ, PRECIP_NOISE_SEED) * PRECIP_NOISE_AMP, 0, 1);
  const gw     = clamp(g.groundwater[i]   + noise2D(wx * NOISE_FREQ, wy * NOISE_FREQ, GW_NOISE_SEED) * GW_NOISE_AMP, 0, 1);
  g.precipitation[i] = precip;
  g.groundwater[i] = gw;

  const so = g.streamOrder[i];
  const zone = g.zone[i];
  const dp = DRAIN_WTD[zone] || DRAIN_WTD[ZONE_LOWLAND];
  wtd += dp[so >= 3 ? 3 : so];

  // Wetness-dependent extra push for channels, tiered by stream order; tidal
  // and coastal cells get a coastal push whatever their order.
  const isTidal = zone === ZONE_TIDAL || zone === ZONE_COASTAL;
  if (so >= 2 || isTidal) {
    const waterSupply = Math.min(1, precip * 0.4 + gw * 0.35 + g.hrSaturation[i] * 0.25);
    let push = 0;
    if (so >= 4)      push = waterSupply * 0.22;   // rivers: full flooded-forest transition
    else if (so >= 3) push = waterSupply * 0.14;   // streams: visible wet zone
    else if (so >= 2) push = waterSupply * 0.05;   // rills: damp ground
    if (isTidal)      push += waterSupply * 0.08;  // water table near sea level at the coast
    wtd -= push;
  }
  g.waterTableDepth[i] = wtd;

  // Saturation from the drainage-modulated WTD (same capillary-fringe model as
  // stepHR4_waterTableRow)
  const capillary = (1.0 - grain) * 0.15;
  const effDepth = wtd - capillary;
  const sat = effDepth <= 0
    ? Math.min(1, Math.max(0.7, 1.0 - effDepth * 0.5))
    : Math.min(0.7, Math.exp(-effDepth * 8.0));
  g.saturation[i] = clamp(sat, 0, 1);

  // Channels deposit finer sediment than the ridges around them.
  if (so >= 2)      grain = Math.min(grain, 0.2);
  else if (so >= 1) grain = Math.min(grain, grain * 0.8 + 0.05);
  g.grainSize[i] = clamp(grain, 0.05, 1.0);
}

export { refineRegionalSubstrateFromHiRes };
