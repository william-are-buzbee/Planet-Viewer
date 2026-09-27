// ══════════════════════════════════════════════════════════════════
// ── regional-render.js — Regional + Tile rendering ──
// ══════════════════════════════════════════════════════════════════

import { state } from './state.js';
import { W, H, clamp, lerpColor, bilinearSampleHR } from './core-math.js';
import { SHALLOW_WATER_TERRAIN_THRESHOLD, intToTerrainType, intToCoverType,
  TT_NONE, TT_DEEP_WATER, TT_WATER, TT_MUD, TT_GRASS,
  TT_DIRT, TT_SAND, TT_ROCK, TT_BEACH,
  CT_NONE } from './terrain-derive.js';
import { computeTilePalette, tilePhysical, regionalPhysical } from './palette-compute.js';
import { FLORA_NAMES, FT_BARREN, FT_NONE, FT_FROZEN } from './regional-grid.js';
import { REGIONAL_SIZE, CELLS_PER_PLANETARY, getPlanetMaxLandElevM } from './regional-gen.js';
import { CHUNK_W, CHUNK_H, CHUNK_TOTAL } from './tile-gen.js';

// ── Colour helpers over the regional grid (struct-of-arrays, index i) ──
const MINERAL_ARRAY = { iron: g => g.iron, copper: g => g.copper, manganese: g => g.manganese };
function mineralChannel(g, i, channel) {
  const value = MINERAL_ARRAY[channel](g)[i];
  if (!g.isLand[i] && !g.isShallowWater[i]) {
    const v = Math.floor(value * 40);
    if (channel === 'iron') return { r: v, g: 0, b: 0 };
    if (channel === 'copper') return { r: 0, g: v, b: 0 };
    return { r: 0, g: 0, b: v };
  }
  const v = Math.floor(value * 255);
  if (channel === 'iron') return { r: v, g: Math.floor(v / 4), b: Math.floor(v / 8) };
  if (channel === 'copper') return { r: Math.floor(v / 8), g: v, b: Math.floor(v / 3) };
  return { r: Math.floor(v / 3), g: Math.floor(v / 8), b: v };
}
function precipColor(g, i) {
  if (!g.isLand[i]) return { r: 25, g: 35, b: 55 };
  const p = g.precipitation[i];
  return { r: 10, g: Math.floor(20 + p * 80), b: Math.floor(40 + p * 200) };
}
function groundwaterColor(g, i) {
  if (!g.isLand[i]) return { r: 15, g: 20, b: 30 };
  const gw = g.groundwater[i];
  return { r: 10, g: Math.floor(30 + gw * 150), b: Math.floor(40 + gw * 120) };
}
function waterAvailColor(g, i) {
  if (!g.isLand[i]) return { r: 15, g: 20, b: 30 };
  const wa = g.waterAvailability[i];
  return { r: 10, g: Math.floor(30 + wa * 170), b: Math.floor(20 + wa * 100) };
}

// Canvases are bound by initRegionalRender(), not at import (see planet-render.js).
let regionalCanvas, regionalCtx, tileCanvas, tileCtx;

export function initRegionalRender() {
  regionalCanvas = document.getElementById('regionalCanvas');
  regionalCtx = regionalCanvas.getContext('2d');
  tileCanvas = document.getElementById('tileCanvas');
  tileCtx = tileCanvas.getContext('2d');
}

export { regionalCanvas };

const FLORA_COLORS = [
  { r: 64, g: 64, b: 64 },     // barren
  { r: 128, g: 32, b: 32 },    // photosynthetic
  { r: 80, g: 32, b: 96 },     // chemotrophic
  { r: 112, g: 48, b: 64 },    // mixotrophic
  { r: 16, g: 32, b: 48 },     // none (ocean)
  { r: 192, g: 192, b: 200 },  // frozen
];
const ZONE_COLORS = [
  { r: 90, g: 120, b: 140 },   // tidal
  { r: 180, g: 165, b: 120 },  // coastal
  { r: 90, g: 130, b: 70 },    // lowland
  { r: 130, g: 130, b: 90 },   // mid_slope
  { r: 170, g: 150, b: 130 },  // upper_slope
  { r: 220, g: 210, b: 200 },  // summit
];
const TERRAIN_COLORS = [];
TERRAIN_COLORS[TT_DEEP_WATER] = { r: 18, g: 27, b: 47 };
TERRAIN_COLORS[TT_WATER] = { r: 40, g: 70, b: 110 };
TERRAIN_COLORS[TT_MUD]   = { r: 90, g: 70, b: 45 };
TERRAIN_COLORS[TT_GRASS] = { r: 80, g: 120, b: 55 };
TERRAIN_COLORS[TT_DIRT]  = { r: 110, g: 85, b: 55 };
TERRAIN_COLORS[TT_SAND]  = { r: 190, g: 175, b: 130 };
TERRAIN_COLORS[TT_ROCK]  = { r: 120, g: 115, b: 108 };
TERRAIN_COLORS[TT_BEACH] = { r: 210, g: 195, b: 155 };

// Every overlay is (g, i) → {r, g, b} over the struct-of-arrays regional grid.
const regionalOverlayFunctions = {
  'surface': function(g, i) {
    // Regional-only water features (drainage channels, ponds)
    if (g.isLand[i] && g.hasWater[i] && g.waterDepth[i] >= SHALLOW_WATER_TERRAIN_THRESHOLD) {
      return computeTilePalette({
        terrainType: 'water', waterDepth: g.waterDepth[i],
        iron: g.iron[i], copper: g.copper[i], manganese: g.manganese[i],
        groundCover: g.groundCover[i],
        floraType: FLORA_NAMES[g.floraType[i]] || 'barren',
      }).bg;
    }

    // Ocean cells: sample hi-res colors (ocean color doesn't need regional detail)
    if (!g.isLand[i]) {
      const hx = (g.wx(i) / CELLS_PER_PLANETARY) * state.hiResMultiplier;
      const hy = (g.wy(i) / CELLS_PER_PLANETARY) * state.hiResMultiplier;
      const r = bilinearSampleHR(state.hiResData.colorR, hx, hy, state.HR_W, state.HR_H);
      const gg = bilinearSampleHR(state.hiResData.colorG, hx, hy, state.HR_W, state.HR_H);
      const b = bilinearSampleHR(state.hiResData.colorB, hx, hy, state.HR_W, state.HR_H);
      return { r: Math.round(r), g: Math.round(gg), b: Math.round(b) };
    }

    // Land cells: colour from the regional cell's own refined physical state.
    if (g.isFreezing[i]) return { r: 210, g: 215, b: 220 };
    return computeTilePalette(regionalPhysical(g, i)).bg;
  },
  'topographic': function(g, i) {
    if (!g.isLand[i]) return g.isDeepWater[i] ? { r: 10, g: 22, b: 40 } : { r: 26, g: 48, b: 80 };
    const maxLand = getPlanetMaxLandElevM();
    const t = clamp(g.elevation[i] / maxLand, 0, 1);
    return lerpColor({ r: 60, g: 75, b: 55 }, { r: 200, g: 185, b: 160 }, t);
  },
  'drainage': function(g, i) {
    if (!g.isLand[i]) return { r: 15, g: 25, b: 40 };
    const so = g.streamOrder[i];
    if (so >= 3) return { r: 40, g: 120, b: 200 };
    if (so === 2) return { r: 60, g: 140, b: 190 };
    if (so === 1) return { r: 90, g: 150, b: 170 };
    const d = clamp(g.drainageDensity[i], 0, 1);
    return lerpColor({ r: 40, g: 40, b: 40 }, { r: 80, g: 110, b: 120 }, d);
  },
  'saturation': function(g, i) {
    if (!g.isLand[i]) return { r: 20, g: 40, b: 70 };
    const s = clamp(g.saturation[i], 0, 1);
    return { r: Math.floor(60 - s * 40), g: Math.floor(50 + s * 60), b: Math.floor(50 + s * 150) };
  },
  'terrainType': (g, i) => TERRAIN_COLORS[g.terrainType[i]] || { r: 60, g: 60, b: 60 },
  'zone':        (g, i) => ZONE_COLORS[g.zone[i]] || { r: 40, g: 60, b: 90 },
  'iron':      (g, i) => mineralChannel(g, i, 'iron'),
  'copper':    (g, i) => mineralChannel(g, i, 'copper'),
  'manganese': (g, i) => mineralChannel(g, i, 'manganese'),
  'composite': (g, i) => {
    const s = g.isLand[i] ? 255 : 80;
    return { r: Math.floor(g.iron[i] * s), g: Math.floor(g.copper[i] * s), b: Math.floor(g.manganese[i] * s) };
  },
  'moisture': precipColor,
  'precipitation': precipColor,
  'groundwater': groundwaterColor,
  'waterAvail': waterAvailColor,
  'floraType': (g, i) => FLORA_COLORS[g.floraType[i]] || FLORA_COLORS[4],
  'floraDensity': function(g, i) {
    if (!g.isLand[i]) return { r: 10, g: 20, b: 35 };
    const ft = g.floraType[i];
    if (ft === FT_BARREN || ft === FT_FROZEN || ft === FT_NONE) return { r: 32, g: 32, b: 32 };
    const d = clamp(g.floraDensity[i], 0, 1);
    const base = FLORA_COLORS[ft];
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
  const g = state.regionalCells;
  const img = regionalCtx.createImageData(g.S, g.S);
  const data = img.data;
  for (let i = 0; i < g.N; i++) {   // row-major: image pixel order == grid index order
    const col = colorFn(g, i);
    const off = i * 4;
    data[off] = col.r;
    data[off + 1] = col.g;
    data[off + 2] = col.b;
    data[off + 3] = 255;
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
  // The canvas backing store matches the chunk; CSS scales it up (pixelated).
  if (tileCanvas.width !== CHUNK_W || tileCanvas.height !== CHUNK_H) {
    tileCanvas.width = CHUNK_W;
    tileCanvas.height = CHUNK_H;
  }
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
