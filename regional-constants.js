// ══════════════════════════════════════════════════════════════════
// ── regional-constants.js — Shared regional generation constants
// ══════════════════════════════════════════════════════════════════

export const REGIONAL_SIZE = 512;          // regional grid is 512×512 cells
export const PLANETARY_CELL_KM = 78.0;     // each planetary cell ≈ 78 km across
export const REGIONAL_CELL_KM = PLANETARY_CELL_KM / REGIONAL_SIZE; // ≈ 0.15 km/cell
export const CELLS_PER_PLANETARY = REGIONAL_SIZE; // regional cells spanning one planetary cell edge

export const HR_FLORA_NAMES = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic'];
