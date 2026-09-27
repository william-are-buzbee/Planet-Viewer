// ══════════════════════════════════════════════════════════════════
// ── units.js — the ONE place that says what the numbers mean ──
// ══════════════════════════════════════════════════════════════════
//
// Elevation
//   • Planetary grid and hi-res grid: PLANET UNITS (dimensionless, as tuned).
//     1.0 planet unit = ELEV_UNIT_M metres, so the tallest land (~0.75) is
//     ~7.5 km and the ocean floor (−0.30 … −0.43) is 3–4.3 km deep. Those two
//     layers are left alone: their coefficients were tuned against these numbers
//     and seed 5 is the anchor world.
//   • Regional grid and tile grid: METRES. The regional layer converts once, when
//     it samples the hi-res elevation (regional-gen.js Pass 1a). Everything below
//     that is metres, and every amplitude and threshold in those files is written
//     in metres.
//
// Water table depth and water depth
//   • Metres everywhere. The hi-res waterTableDepth is a dimensionless proxy that
//     the regional layer reads as metres (1.0 = 1 m) — an explicit declaration of
//     what the code already assumed, not a conversion.
//
// Horizontal
//   • Planetary cell ≈ 78 km, regional cell ≈ 152 m, tile ≈ 1.19 m
//     (regional-constants.js).

export const ELEV_UNIT_M = 10000;
export function puToM(pu) { return pu * ELEV_UNIT_M; }

// The planet's shallow/deep split (−0.08 planet units) in metres, for the
// regional layer's isShallowWater / isDeepWater flags.
export const SHELF_DEPTH_M = 0.08 * ELEV_UNIT_M;   // 800 m
// "Coastal" land band used by beach classification (0.03 planet units in the
// planetary and hi-res layers).
export const COASTAL_ELEV_M = 0.03 * ELEV_UNIT_M;  // 300 m
// Deep water in deriveTerrainAndCover (−0.1 planet units).
export const DEEP_WATER_M = 0.1 * ELEV_UNIT_M;     // 1000 m
