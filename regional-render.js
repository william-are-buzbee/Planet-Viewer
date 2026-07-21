// ══════════════════════════════════════════════════════════════════
// ── regional-render.js — Regional + Tile rendering ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import { W, H, clamp, lerpColor, bilinearSampleHR } from './core-math.js';
import { SHALLOW_WATER_TERRAIN_THRESHOLD, intToTerrainType, intToCoverType,
  TT_NONE, TT_DEEP_WATER, TT_WATER, TT_MUD, TT_GRASS,
  TT_DIRT, TT_SAND, TT_ROCK, TT_BEACH,
  CT_NONE } from './terrain-derive.js';
import { computeTilePalette, tilePhysical, regionalPhysical } from './palette-compute.js';
import { REGIONAL_SIZE, CELLS_PER_PLANETARY, getPlanetMaxLandElev } from './regional-gen.js';
import { mineralChannel, overlayFunctions } from './planet-render.js';
import { CHUNK_W, CHUNK_H, CHUNK_TOTAL } from './tile-gen.js';

const regionalCanvas = document.getElementById('regionalCanvas');
const regionalCtx = regionalCanvas.getContext('2d');
const tileCanvas = document.getElementById('tileCanvas');
const tileCtx = tileCanvas.getContext('2d');

export { regionalCanvas };

const regionalOverlayFunctions = {
  'surface': function(cell) {
    // Regional-only water features (drainage channels, ponds)
    if (cell.isLand && cell.hasWater && (cell.waterDepth || 0) >= SHALLOW_WATER_TERRAIN_THRESHOLD) {
      const m = cell.minerals || {};
      return computeTilePalette({
        terrainType: 'water', waterDepth: cell.waterDepth || 0,
        iron: m.iron || 0, copper: m.copper || 0, manganese: m.manganese || 0,
        groundCover: cell.groundCover || 0,
        floraType: cell.floraType || 'barren',
      }).bg;
    }

    // Ocean cells: sample hi-res colors (ocean color doesn't need regional detail)
    if (!cell.isLand) {
      if (state.hiResData) {
        const hx = (cell.worldX / CELLS_PER_PLANETARY) * state.hiResMultiplier;
        const hy = (cell.worldY / CELLS_PER_PLANETARY) * state.hiResMultiplier;
        const r = bilinearSampleHR(state.hiResData.colorR, hx, hy, state.HR_W, state.HR_H);
        const g = bilinearSampleHR(state.hiResData.colorG, hx, hy, state.HR_W, state.HR_H);
        const b = bilinearSampleHR(state.hiResData.colorB, hx, hy, state.HR_W, state.HR_H);
        return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
      }
      if (cell.isDeepWater) return computeTilePalette({ terrainType: 'deep_water' }).bg;
      return computeTilePalette({ terrainType: 'water', waterDepth: 0.15 }).bg;
    }

    // Land cells: compute color from the regional cell's own physical state.
    // This gives full 512×512 resolution because each regional cell has its
    // own refined physical properties (saturation, minerals, flora, terrain).
    if (cell.isFreezing) return { r: 210, g: 215, b: 220 };
    return computeTilePalette(regionalPhysical(cell)).bg;
  },
  'topographic': function(cell) {
    if (!cell.isLand) return cell.isDeepWater ? { r: 10, g: 22, b: 40 } : { r: 26, g: 48, b: 80 };
    const maxLand = getPlanetMaxLandElev();
    const t = clamp(cell.baseElevation / maxLand, 0, 1);
    return lerpColor({ r: 60, g: 75, b: 55 }, { r: 200, g: 185, b: 160 }, t);
  },
  'drainage': function(cell) {
    if (!cell.isLand) return { r: 15, g: 25, b: 40 };
    const so = cell.streamOrder;
    if (so >= 3) return { r: 40, g: 120, b: 200 };
    if (so === 2) return { r: 60, g: 140, b: 190 };
    if (so === 1) return { r: 90, g: 150, b: 170 };
    const d = clamp(cell.drainageDensity, 0, 1);
    return lerpColor({ r: 40, g: 40, b: 40 }, { r: 80, g: 110, b: 120 }, d);
  },
  'saturation': function(cell) {
    if (!cell.isLand) return { r: 20, g: 40, b: 70 };
    const s = clamp(cell.saturation, 0, 1);
    return { r: Math.floor(60 - s * 40), g: Math.floor(50 + s * 60), b: Math.floor(50 + s * 150) };
  },
  'terrainType': function(cell) {
    const tt = cell.terrainType;
    if (tt === 'deep_water') return { r: 18, g: 27, b: 47 };
    if (tt === 'water') return { r: 40, g: 70, b: 110 };
    if (tt === 'mud') return { r: 90, g: 70, b: 45 };
    if (tt === 'grass') return { r: 80, g: 120, b: 55 };
    if (tt === 'dirt') return { r: 110, g: 85, b: 55 };
    if (tt === 'sand') return { r: 190, g: 175, b: 130 };
    if (tt === 'rock') return { r: 120, g: 115, b: 108 };
    if (tt === 'beach') return { r: 210, g: 195, b: 155 };
    return { r: 60, g: 60, b: 60 };
  },
  'zone': function(cell) {
    const z = cell.zone;
    if (z === 'summit') return { r: 220, g: 210, b: 200 };
    if (z === 'upper_slope') return { r: 170, g: 150, b: 130 };
    if (z === 'mid_slope') return { r: 130, g: 130, b: 90 };
    if (z === 'lowland') return { r: 90, g: 130, b: 70 };
    if (z === 'coastal') return { r: 180, g: 165, b: 120 };
    if (z === 'tidal') return { r: 90, g: 120, b: 140 };
    return { r: 40, g: 60, b: 90 };
  },
  'iron': cell => mineralChannel(cell, 'iron'),
  'copper': cell => mineralChannel(cell, 'copper'),
  'manganese': cell => mineralChannel(cell, 'manganese'),
  'composite': cell => ({
    r: Math.floor(cell.minerals.iron * (cell.isLand ? 255 : 80)),
    g: Math.floor(cell.minerals.copper * (cell.isLand ? 255 : 80)),
    b: Math.floor(cell.minerals.manganese * (cell.isLand ? 255 : 80)),
  }),
  'moisture': cell => overlayFunctions['moisture'](cell),
  'precipitation': cell => overlayFunctions['precipitation'](cell),
  'groundwater': cell => overlayFunctions['groundwater'](cell),
  'waterAvail': cell => overlayFunctions['waterAvail'](cell),
  'floraType': function(cell) {
    if (cell.floraType === 'photosynthetic') return { r: 128, g: 32, b: 32 };
    if (cell.floraType === 'chemotrophic')   return { r: 80, g: 32, b: 96 };
    if (cell.floraType === 'mixotrophic')    return { r: 112, g: 48, b: 64 };
    if (cell.floraType === 'barren')         return { r: 64, g: 64, b: 64 };
    if (cell.floraType === 'frozen')         return { r: 192, g: 192, b: 200 };
    return { r: 16, g: 32, b: 48 };
  },
  'floraDensity': function(cell) {
    if (!cell.isLand) return { r: 10, g: 20, b: 35 };
    if (cell.floraType === 'barren' || cell.floraType === 'frozen' || cell.floraType === 'none') return { r: 32, g: 32, b: 32 };
    const d = clamp(cell.floraDensity, 0, 1);
    const base = regionalOverlayFunctions['floraType'](cell);
    return {
      r: Math.floor(base.r * (0.3 + d * 0.7)),
      g: Math.floor(base.g * (0.3 + d * 0.7)),
      b: Math.floor(base.b * (0.3 + d * 0.7)),
    };
  },
};

function renderRegionalMap(overlay) {
  if (!state.regionalCells) return;
  const colorFn = regionalOverlayFunctions[overlay] || regionalOverlayFunctions['surface'];
  const img = regionalCtx.createImageData(REGIONAL_SIZE, REGIONAL_SIZE);
  const data = img.data;
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const col = colorFn(state.regionalCells[rx][ry]);
      const off = (ry * REGIONAL_SIZE + rx) * 4;
      data[off] = col.r;
      data[off + 1] = col.g;
      data[off + 2] = col.b;
      data[off + 3] = 255;
    }
  }
  regionalCtx.putImageData(img, 0, 0);
  drawTilePositionMarker();
}

function drawTilePositionMarker() {
  if (!state.currentTileData || !state.regionalCells) return;
  const rx = state.currentTileData.rx;
  const ry = state.currentTileData.ry;
  regionalCtx.save();
  const size = 5;
  // Dark outline for contrast on any terrain
  regionalCtx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  regionalCtx.lineWidth = 3;
  regionalCtx.strokeRect(rx - size / 2 - 1, ry - size / 2 - 1, size + 2, size + 2);
  // White inner box
  regionalCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  regionalCtx.lineWidth = 1;
  regionalCtx.strokeRect(rx - size / 2, ry - size / 2, size, size);
  regionalCtx.restore();
}

const tileOverlays = {
  // Surface: per-tile palette bg — the dominant ground color from physical state
  'surface': function(t, i) {
    return computeTilePalette(tilePhysical(t, i)).bg;
  },
  // Palette FG: the bright highlight/detail color (the '#' pixels of a sprite).
  // Compare against Surface to validate that bg/fg are distinct and correct.
  'paletteFg': function(t, i) {
    return computeTilePalette(tilePhysical(t, i)).fg;
  },
  'drainage': function(t, i) {
    if (t.elevation[i] <= 0) return { r: 15, g: 25, b: 40 };
    const so = t.streamOrder[i];
    if (so >= 3) return { r: 40, g: 120, b: 200 };
    if (so === 2) return { r: 60, g: 140, b: 190 };
    if (so === 1) return { r: 90, g: 150, b: 170 };
    return { r: 45, g: 45, b: 45 };
  },
  'saturation': function(t, i) {
    if (t.elevation[i] <= 0) return { r: 20, g: 40, b: 70 };
    const s = clamp(t.saturation[i], 0, 1);
    return { r: Math.floor(60 - s * 40), g: Math.floor(50 + s * 60), b: Math.floor(50 + s * 150) };
  },
  'terrain': function(t, i) {
    switch (t.terrainType[i]) {
      case TT_DEEP_WATER: return { r: 18, g: 27, b: 47 };
      case TT_WATER: return { r: 40, g: 70, b: 110 };
      case TT_MUD:   return { r: 90, g: 70, b: 45 };
      case TT_GRASS: return { r: 80, g: 120, b: 55 };
      case TT_DIRT:  return { r: 110, g: 85, b: 55 };
      case TT_SAND:  return { r: 190, g: 175, b: 130 };
      case TT_ROCK:  return { r: 120, g: 115, b: 108 };
      case TT_BEACH: return { r: 210, g: 195, b: 155 };
      default: return { r: 55, g: 55, b: 55 };
    }
  },
  'substrate': function(t, i) {
    if (t.elevation[i] <= 0) return { r: 25, g: 35, b: 50 };
    const g = clamp(t.grainSize[i], 0, 1);
    // fine (dark brown) → coarse (light grey)
    return lerpColor({ r: 70, g: 55, b: 40 }, { r: 180, g: 178, b: 172 }, g);
  },
  'canopy': function(t, i) {
    if (t.elevation[i] <= 0) return { r: 15, g: 25, b: 40 };
    const c = clamp(t.canopy[i], 0, 1);
    return { r: Math.floor(40 - c * 20), g: Math.floor(45 + c * 90), b: Math.floor(35 - c * 15) };
  },
  'variant': function(t, i) {
    if (t.elevation[i] <= 0) return { r: 15, g: 25, b: 40 };
    const gv = t.groundVariant[i];
    const tt = t.terrainType[i];
    const hues = {
        3: [90, 70, 45],    // MUD: brown
        4: [60, 120, 50],   // GRASS: green
        5: [110, 85, 55],   // DIRT: tan
        6: [180, 170, 130], // SAND: light
        7: [120, 115, 110], // ROCK: grey
        2: [40, 70, 130],   // WATER: blue
        1: [20, 40, 90],    // DEEP_WATER: dark blue
        8: [190, 175, 140], // BEACH: light
    };
    const base = hues[tt] || [80, 80, 80];
    const shift = 1.0 - gv * 0.2;
    let r = Math.floor(base[0] * shift);
    let g = Math.floor(base[1] * shift);
    let b = Math.floor(base[2] * shift);
    const cv = t.coverVariant[i];
    if (cv > 0 || (t.coverType[i] > 0)) {
        r = Math.floor(r * 0.6);
        g = Math.floor(g * 0.7);
        b = Math.min(255, b + 60);
    }
    return { r, g, b };
  },
  'flora': function(t, i) {
    if (t.elevation[i] <= 0) return { r: 16, g: 32, b: 48 };
    const ft = t.floraType[i];
    let base;
    if (ft === 1) base = { r: 128, g: 32, b: 32 };
    else if (ft === 2) base = { r: 80, g: 32, b: 96 };
    else if (ft === 3) base = { r: 112, g: 48, b: 64 };
    else base = { r: 64, g: 64, b: 64 };
    const d = clamp(t.floraDensity[i], 0, 1);
    return { r: Math.floor(base.r * (0.3 + d * 0.7)), g: Math.floor(base.g * (0.3 + d * 0.7)), b: Math.floor(base.b * (0.3 + d * 0.7)) };
  },
};

function renderTileDetail(overlay) {
  if (!state.currentTileData) return;
  const fn = tileOverlays[overlay] || tileOverlays['surface'];
  const t = state.currentTileData.tiles;
  const img = tileCtx.createImageData(CHUNK_W, CHUNK_H);
  const data = img.data;
  for (let i = 0; i < CHUNK_TOTAL; i++) {
    const col = fn(t, i);
    const off = i * 4;
    data[off] = col.r; data[off + 1] = col.g; data[off + 2] = col.b; data[off + 3] = 255;
  }
  tileCtx.putImageData(img, 0, 0);
}

export {
  renderRegionalMap, renderTileDetail, drawTilePositionMarker,
  regionalOverlayFunctions, tileOverlays
};
