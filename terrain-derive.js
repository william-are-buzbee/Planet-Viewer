// ══════════════════════════════════════════════════════════════════
// ── terrain-derive.js — THE terrain derivation function + enums ──
// ══════════════════════════════════════════════════════════════════

// ── Terrain / cover enums (compact typed-array storage) ──
export const SHALLOW_WATER_TERRAIN_THRESHOLD = 0.05; // 5cm — below this, water is a film on ground, not a body of water

export const TT_NONE = 0, TT_DEEP_WATER = 1, TT_WATER = 2, TT_MUD = 3, TT_GRASS = 4,
      TT_DIRT = 5, TT_SAND = 6, TT_ROCK = 7, TT_BEACH = 8;
export const CT_NONE = 0, CT_FOREST = 1, CT_MUSHFOREST = 2, CT_SPARSE_FOREST = 3, CT_SPARSE_MUSHFOREST = 4;

const _ttNames = ['none', 'deep_water', 'water', 'mud', 'grass', 'dirt', 'sand', 'rock', 'beach'];
const _ctNames = ['none', 'forest', 'mushforest', 'sparse_forest', 'sparse_mushforest'];

export function terrainTypeToInt(name) {
  const i = _ttNames.indexOf(name);
  return i < 0 ? 0 : i;
}
export function intToTerrainType(i) { return _ttNames[i] || 'none'; }
export function coverTypeToInt(name) {
  const i = _ctNames.indexOf(name);
  return i < 0 ? 0 : i;
}
export function intToCoverType(i) { return _ctNames[i] || 'none'; }

// ══════════════════════════════════════════════════════════════════
// ── THE terrain derivation function — the ONLY one in the codebase ──
//    Called from every view (planetary low-res, planetary high-res,
//    regional, tile). Takes plain physical properties, returns terrain
//    type + cover type as strings. If the physical state is the same,
//    the output is the same, regardless of which view is rendering it.
//    No other function assigns terrain types anywhere in the codebase.
// ══════════════════════════════════════════════════════════════════
export function deriveTerrainAndCover(elev, isLand, grainSize, saturation, groundCover, canopyDensity, chemoCrust, floraType, waterTableDepth, isCoastal) {
    // Return values
    let terrainType = 'dirt';
    let coverType = 'none';

    // ── Water ──
    if (!isLand || elev <= -0.1) {
        return { terrainType: 'deep_water', coverType: 'none' };
    }
    if (!isLand || elev <= 0) {
        return { terrainType: 'water', coverType: 'none' };
    }

    // ── Submerged land (ponded) ──
    if (waterTableDepth < -0.02) {
        return { terrainType: 'water', coverType: 'none' };
    }

    // ── Ground type: substrate × saturation × flora presence ──
    const fine = grainSize < 0.35;
    const sandy = grainSize >= 0.35 && grainSize < 0.6;
    const coarse = grainSize >= 0.6;
    const saturated = saturation > 0.75;
    const hasFlora = groundCover > 0.15;

    // Saturated fine substrate = MUD
    if (fine && saturated) {
        terrainType = 'mud';
    }
    // Saturated sand at coast = BEACH
    else if (sandy && saturated && isCoastal) {
        terrainType = 'beach';
    }
    // Saturated sand inland = MUD
    else if (sandy && saturated) {
        terrainType = 'mud';
    }
    // Coarse substrate without significant flora = ROCK
    else if (coarse && !hasFlora) {
        terrainType = 'rock';
    }
    // FLORA PRESENCE DETERMINES GRASS — not saturation
    // If the flora system says mat is growing here, the ground is GRASS
    else if (groundCover > 0.25) {
        terrainType = 'grass';
    }
    // Coarse with some flora = still ROCK (mat in crevices doesn't change the ground character)
    else if (coarse) {
        terrainType = 'rock';
    }
    // Dry sand without flora = SAND
    else if (sandy && saturation < 0.3 && groundCover < 0.1) {
        terrainType = 'sand';
    }
    // Sparse but visible mat = GRASS
    else if (groundCover > 0.08) {
        terrainType = 'grass';
    }
    // Genuinely bare ground — rare on this planet
    else {
        terrainType = 'dirt';
    }

    // ── Cover type ──
    if (canopyDensity > 0.45) {
        if (floraType === 'chemotrophic' || floraType === 2) coverType = 'mushforest';
        else coverType = 'forest';
    } else if (canopyDensity > 0.15) {
        if (floraType === 'chemotrophic' || floraType === 2) coverType = 'sparse_mushforest';
        else coverType = 'sparse_forest';
    } else {
        coverType = 'none';
    }

    return { terrainType, coverType };
}
