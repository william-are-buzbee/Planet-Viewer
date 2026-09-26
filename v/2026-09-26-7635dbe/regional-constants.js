// ══════════════════════════════════════════════════════════════════
// ── regional-constants.js — Shared regional generation constants
// ══════════════════════════════════════════════════════════════════

export const REGIONAL_SIZE = 512;          // regional grid is 512×512 cells
export const PLANETARY_CELL_KM = 78.0;     // each planetary cell ≈ 78 km across
export const REGIONAL_CELL_KM = PLANETARY_CELL_KM / REGIONAL_SIZE; // ≈ 0.15 km/cell
export const CELLS_PER_PLANETARY = REGIONAL_SIZE; // regional cells spanning one planetary cell edge
export const REGIONAL_CELL_M = PLANETARY_CELL_KM * 1000 / REGIONAL_SIZE; // ≈ 152 m per regional cell

export const TILES_PER_REGIONAL_CELL = 128;  // one tile chunk covers exactly one regional cell
export const TILE_M = REGIONAL_CELL_M / TILES_PER_REGIONAL_CELL; // ≈ 1.19 m per tile

export const HR_FLORA_NAMES = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic'];
