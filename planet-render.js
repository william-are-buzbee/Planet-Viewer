// ══════════════════════════════════════════════════════════════════
// ── state.planet-render.js — Planetary rendering (flat, globe, Mollweide) ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import { W, H, TOTAL, clamp, hslToRgb, lerpColor } from './core-math.js';
import { computeTilePalette } from './palette-compute.js';
import { intToTerrainType, intToCoverType } from './terrain-derive.js';

// ── Private canvas contexts ──
const canvas = document.getElementById('planetCanvas');
const ctx = canvas.getContext('2d');
let imageData = ctx.createImageData(1024, 512);

const globeCanvas = document.getElementById('globeCanvas');
const HOME_ROT_X = 0.15;
const HOME_ROT_Y = 0;
const globeCtx = globeCanvas.getContext('2d');

const mollweideCanvas = document.getElementById('mollweideCanvas');
const mollweideCtx = mollweideCanvas.getContext('2d');

export { canvas, globeCanvas, mollweideCanvas, ctx };

// ── Mineral channel helper ──
export function mineralChannel(cell, channel) {
  if (!cell.isLand && !cell.isShallowWater) {
    const v = Math.floor(cell.minerals[channel] * 40);
    if (channel === 'iron') return { r: v, g: 0, b: 0 };
    if (channel === 'copper') return { r: 0, g: v, b: 0 };
    return { r: 0, g: 0, b: v };
  }
  const v = Math.floor(cell.minerals[channel] * 255);
  if (channel === 'iron') return { r: v, g: Math.floor(v / 4), b: Math.floor(v / 8) };
  if (channel === 'copper') return { r: Math.floor(v / 8), g: v, b: Math.floor(v / 3) };
  return { r: Math.floor(v / 3), g: Math.floor(v / 8), b: v };
}

function setPixel2x(x, y, r, g, b) {
  const sx = x * 2, sy = y * 2;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const off = ((sy + dy) * 1024 + (sx + dx)) * 4;
      imageData.data[off] = r;
      imageData.data[off + 1] = g;
      imageData.data[off + 2] = b;
      imageData.data[off + 3] = 255;
    }
  }
}

// ── Overlay color functions (low-res) ──
export const overlayFunctions = {
  'surface': function(cell) {
    if (cell.isDeepWater) return computeTilePalette({ terrainType: 'deep_water' }).bg;
    if (cell.isShallowWater) {
      const m = cell.minerals || {};
      return computeTilePalette({
        terrainType: 'water', waterDepth: 0.15,
        iron: m.iron || 0, copper: m.copper || 0, manganese: m.manganese || 0,
      }).bg;
    }
    if (cell.isFreezing) return { r: 210, g: 215, b: 220 };
    const m = cell.minerals || {};
    return computeTilePalette({
      terrainType:    cell.terrainType,
      coverType:      cell.coverType,
      iron:           m.iron || 0,
      copper:         m.copper || 0,
      manganese:      m.manganese || 0,
      grainSize:      cell._estGrainSize != null ? cell._estGrainSize : 0.3,
      saturation:     cell._estSaturation || 0,
      organicContent: 0,
      groundCover:    cell._estGroundCover || 0,
      canopyDensity:  cell._estCanopy || 0,
      chemoCrust:     cell._estChemoCrust || 0,
      waterDepth:     0,
      floraType:      cell.floraType || 'barren',
    }).bg;
  },
  'topographic': function(cell) {
    if (cell.isDeepWater)    return { r: 10, g: 22, b: 40 };
    if (cell.isShallowWater) return { r: 26, g: 48, b: 80 };
    if (cell.isFreezing && cell.isLand) {
      const t = clamp((cell.elevation) / 0.6, 0, 1);
      return lerpColor({ r: 190, g: 195, b: 200 }, { r: 220, g: 225, b: 230 }, t);
    }
    const e = cell.elevation;
    if (e < 0.05)  return { r: 60, g: 75, b: 55 };
    if (e < 0.15)  return { r: 90, g: 100, b: 65 };
    if (e < 0.30)  return { r: 130, g: 115, b: 70 };
    if (e < 0.45)  return { r: 160, g: 130, b: 90 };
    if (e < 0.60)  return { r: 180, g: 160, b: 130 };
    return { r: 200, g: 185, b: 160 };
  },
  'state.plates': function(cell) {
    if (cell.boundaryDistance === 0 && cell.boundaryType !== null) return { r: 240, g: 240, b: 240 };
    const hue = (cell.plateId / state.plates.length) * 360;
    const sat = cell.plateType === 'continental' ? 0.4 : 0.25;
    const lum = cell.plateType === 'continental' ? 0.45 : 0.30;
    return hslToRgb(hue, sat, lum);
  },
  'iron':      cell => mineralChannel(cell, 'iron'),
  'copper':    cell => mineralChannel(cell, 'copper'),
  'manganese': cell => mineralChannel(cell, 'manganese'),
  'composite': cell => ({
    r: Math.floor(cell.minerals.iron * ((!cell.isLand && !cell.isShallowWater) ? 80 : 255)),
    g: Math.floor(cell.minerals.copper * ((!cell.isLand && !cell.isShallowWater) ? 80 : 255)),
    b: Math.floor(cell.minerals.manganese * ((!cell.isLand && !cell.isShallowWater) ? 80 : 255)),
  }),
  'moisture': function(cell) {
    if (!cell.isLand) return { r: 25, g: 35, b: 55 };
    const p = cell.precipitation;
    return { r: 10, g: Math.floor(20 + p * 80), b: Math.floor(40 + p * 200) };
  },
  'precipitation': function(cell) {
    if (!cell.isLand) return { r: 25, g: 35, b: 55 };
    const p = cell.precipitation;
    return { r: 10, g: Math.floor(20 + p * 80), b: Math.floor(40 + p * 200) };
  },
  'groundwater': function(cell) {
    if (!cell.isLand) return { r: 15, g: 20, b: 30 };
    const gw = cell.groundwater;
    return { r: 10, g: Math.floor(30 + gw * 150), b: Math.floor(40 + gw * 120) };
  },
  'waterAvail': function(cell) {
    if (!cell.isLand) return { r: 15, g: 20, b: 30 };
    const wa = cell.waterAvailability;
    return { r: 10, g: Math.floor(30 + wa * 170), b: Math.floor(20 + wa * 100) };
  },
  'wind': function(cell) {
    if (cell.isLand) {
      const e = clamp(cell.elevation, 0, 0.6);
      return { r: Math.floor(35 + e * 40), g: Math.floor(30 + e * 35), b: Math.floor(25 + e * 25) };
    }
    return { r: 20, g: 25, b: 38 };
  },
  'currents': function(cell) {
    if (cell.isLand) return { r: 18, g: 18, b: 18 };
    const sst = cell.sst;
    if (sst < 0.5) {
      const t = sst / 0.5;
      return { r: Math.floor(15 + t * 20), g: Math.floor(25 + t * 30), b: Math.floor(60 + t * 30) };
    } else {
      const t = (sst - 0.5) / 0.5;
      return { r: Math.floor(35 + t * 35), g: Math.floor(55 - t * 20), b: Math.floor(90 - t * 50) };
    }
  },
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
    if (cell.floraType === 'barren' || cell.floraType === 'frozen') return { r: 32, g: 32, b: 32 };
    const d = clamp(cell.floraDensity, 0, 1);
    const base = overlayFunctions['floraType'](cell);
    return {
      r: Math.floor(base.r * (0.3 + d * 0.7)),
      g: Math.floor(base.g * (0.3 + d * 0.7)),
      b: Math.floor(base.b * (0.3 + d * 0.7)),
    };
  },
};

function getColorFn(overlay) {
  return overlayFunctions[overlay] || overlayFunctions['surface'];
}

const overlays = {

  surface(gi) {
    return { r: state.planet.colorR[gi], g: state.planet.colorG[gi], b: state.planet.colorB[gi] };
  },

  topographic(gi) {
    if (state.planet.isDeepWater[gi])    return { r: 10, g: 22, b: 40 };
    if (state.planet.isShallowWater[gi]) return { r: 26, g: 48, b: 80 };
    const e = state.planet.elevation[gi];
    if (state.planet.isFreezing[gi] && state.planet.isLand[gi]) {
      const t = clamp(e / 0.6, 0, 1);
      return lerpColor({ r: 190, g: 195, b: 200 }, { r: 220, g: 225, b: 230 }, t);
    }
    if (e < 0.05)  return { r: 60, g: 75, b: 55 };
    if (e < 0.15)  return { r: 90, g: 100, b: 65 };
    if (e < 0.30)  return { r: 130, g: 115, b: 70 };
    if (e < 0.45)  return { r: 160, g: 130, b: 90 };
    if (e < 0.60)  return { r: 180, g: 160, b: 130 };
    return { r: 200, g: 185, b: 160 };
  },

  plates(gi) {
    const n = (state.plates && state.plates.length) ? state.plates.length : 1;
    const hue = (state.planet.plateId[gi] / n) * 360;
    // No plateType at surface res; approximate continental/oceanic by land mask.
    const land = state.planet.isLand[gi];
    return hslToRgb(hue, land ? 0.4 : 0.25, land ? 0.45 : 0.30);
  },

  iron(gi)      { return overlayMineral(gi, state.planet.iron[gi], 'iron'); },
  copper(gi)    { return overlayMineral(gi, state.planet.copper[gi], 'copper'); },
  manganese(gi) { return overlayMineral(gi, state.planet.manganese[gi], 'manganese'); },
  composite(gi) {
    const deep = !state.planet.isLand[gi] && !state.planet.isShallowWater[gi];
    const s = deep ? 80 : 255;
    return {
      r: Math.floor(state.planet.iron[gi]      * s),
      g: Math.floor(state.planet.copper[gi]    * s),
      b: Math.floor(state.planet.manganese[gi] * s),
    };
  },

  moisture(gi)      { return overlayPrecip(gi); },
  precipitation(gi) { return overlayPrecip(gi); },

  groundwater(gi) {
    if (!state.planet.isLand[gi]) return { r: 15, g: 20, b: 30 };
    const gw = state.planet.groundwater[gi];
    return { r: 10, g: Math.floor(30 + gw * 150), b: Math.floor(40 + gw * 120) };
  },

  waterAvail(gi) {
    if (!state.planet.isLand[gi]) return { r: 15, g: 20, b: 30 };
    const wa = state.planet.waterAvail[gi];
    return { r: 10, g: Math.floor(30 + wa * 170), b: Math.floor(20 + wa * 100) };
  },

  wind(gi) {
    if (state.planet.isLand[gi]) {
      const e = clamp(state.planet.elevation[gi], 0, 0.6);
      return { r: Math.floor(35 + e * 40), g: Math.floor(30 + e * 35), b: Math.floor(25 + e * 25) };
    }
    return { r: 20, g: 25, b: 38 };
  },

  currents(gi) {
    if (state.planet.isLand[gi]) return { r: 18, g: 18, b: 18 };
    const sst = state.planet.sst[gi];
    if (sst < 0.5) {
      const t = sst / 0.5;
      return { r: Math.floor(15 + t * 20), g: Math.floor(25 + t * 30), b: Math.floor(60 + t * 30) };
    }
    const t = (sst - 0.5) / 0.5;
    return { r: Math.floor(35 + t * 35), g: Math.floor(55 - t * 20), b: Math.floor(90 - t * 50) };
  },

  floraType(gi)    { return overlayFlora(gi); },
  floraDensity(gi) { return overlayFlora(gi); },

  terrainType(gi) {
    const colors = [[40,40,40],[10,18,45],[28,45,85],[85,65,38],[75,100,45],[110,82,50],[155,140,100],[92,88,78],[165,145,100]];
    const c = colors[state.planet.terrainType[gi]] || colors[0];
    const ct = state.planet.coverType[gi];
    const dim = (ct >= 1 && ct <= 2) ? 0.55 : ct >= 3 ? 0.75 : 1.0;
    return { r: (c[0]*dim)|0, g: (c[1]*dim)|0, b: (c[2]*dim)|0 };
  },

  substrate(gi) {
    if (!state.planet.isLand[gi]) return { r: 15, g: 18, b: 25 };
    const gs = state.planet.grainSize[gi];
    if (gs < 0.2) return { r: 55, g: 65, b: 85 };
    if (gs < 0.45) { const f=(gs-0.2)/0.25; return { r:(55+f*75)|0, g:(65+f*45)|0, b:(85-f*45)|0 }; }
    if (gs < 0.65) { const f=(gs-0.45)/0.2; return { r:(130+f*45)|0, g:(110+f*25)|0, b:(40+f*8)|0 }; }
    const f=(gs-0.65)/0.35; return { r:(175-f*70)|0, g:(135-f*50)|0, b:(48+f*35)|0 };
  },

  saturation(gi) {
    if (!state.planet.isLand[gi]) return { r: 10, g: 18, b: 45 };
    const s = state.planet.saturation[gi];
    return { r: (110 - s*90)|0, g: (75 + s*35)|0, b: (25 + s*110)|0 };
  },

  drainage(gi) {
    if (!state.planet.isLand[gi]) return { r: 12, g: 20, b: 40 };
    const so = state.planet.streamOrder[gi];
    if (so >= 3) return { r: 70, g: 150, b: 220 };
    if (so === 2) return { r: 55, g: 115, b: 180 };
    if (so === 1) return { r: 45, g: 85, b: 130 };
    return { r: 40, g: 46, b: 42 };
  },
};

// Shared overlay helpers (read state.planet)
function overlayMineral(gi, v, channel) {
  const deep = !state.planet.isLand[gi] && !state.planet.isShallowWater[gi];
  if (deep) {
    const d = Math.floor(v * 40);
    if (channel === 'iron')   return { r: d, g: 0, b: 0 };
    if (channel === 'copper') return { r: 0, g: d, b: 0 };
    return { r: 0, g: 0, b: d };
  }
  const f = Math.floor(v * 255);
  if (channel === 'iron')   return { r: f, g: Math.floor(f/4), b: Math.floor(f/8) };
  if (channel === 'copper') return { r: Math.floor(f/8), g: f, b: Math.floor(f/3) };
  return { r: Math.floor(f/3), g: Math.floor(f/8), b: f };
}
function overlayPrecip(gi) {
  if (!state.planet.isLand[gi]) return { r: 25, g: 35, b: 55 };
  const p = state.planet.precipitation[gi];
  return { r: 10, g: Math.floor(20 + p * 80), b: Math.floor(40 + p * 200) };
}
function overlayFlora(gi) {
  const ft = state.planet.floraType[gi];
  const cd = state.planet.canopyDensity[gi];
  const gc = state.planet.groundCover[gi];
  let r, g, b;
  if (!state.planet.isLand[gi]) { r = 10; g = 15; b = 30; }
  else if (state.planet.isFreezing[gi]) { r = 192; g = 192; b = 200; }
  else if (ft === 0) { r = 45; g = 40; b = 30; }
  else if (ft === 1) { r = (40 + gc * 55)|0; g = (12 + gc * 6)|0;  b = (12 + gc * 8)|0; }
  else if (ft === 2) { r = (25 + gc * 18)|0; g = (18 + gc * 12)|0; b = (35 + gc * 45)|0; }
  else if (ft === 3) { r = (35 + gc * 30)|0; g = (12 + gc * 8)|0;  b = (25 + gc * 22)|0; }
  else { r = 40; g = 40; b = 40; }
  if (cd > 0.15 && state.planet.isLand[gi] && !state.planet.isFreezing[gi]) { r = (r*0.6)|0; g = (g*0.6)|0; b = (b*0.6)|0; }
  return { r, g, b };
}

// Compatibility wrapper: legacy callers expect [r,g,b]
function overlayColorAt(gi, overlayName) {
  const fn = overlays[overlayName] || overlays.surface;
  const c = fn(gi);
  return { r: c.r, g: c.g, b: c.b };
}

function hiResColorAt(hi, overlay) {
  if (overlay === 'surface') {
    return [state.hiResData.colorR[hi], state.hiResData.colorG[hi], state.hiResData.colorB[hi]];
  }
  if (overlay === 'terrainType') {
    const colors = [[40,40,40],[10,18,45],[28,45,85],[85,65,38],[75,100,45],[110,82,50],[155,140,100],[92,88,78],[165,145,100]];
    const c = colors[state.hiResData.terrainType[hi]] || colors[0];
    const ct = state.hiResData.coverType[hi];
    const dim = (ct >= 1 && ct <= 2) ? 0.55 : ct >= 3 ? 0.75 : 1.0;
    return [(c[0]*dim)|0, (c[1]*dim)|0, (c[2]*dim)|0];
  }
  if (overlay === 'floraDensity' || overlay === 'floraType') {
    const ft = state.hiResData.floraType[hi];
    const cd = state.hiResData.canopyDensity[hi];
    const gc = state.hiResData.groundCover[hi];
    let r, g, b;
    if (!state.hiResData.isLand[hi]) { r = 10; g = 15; b = 30; }
    else if (state.hiResData.isFreezing[hi]) { r = 192; g = 192; b = 200; }
    else if (ft === 0) { r = 45; g = 40; b = 30; }
    else if (ft === 1) { r = (40 + gc * 55)|0; g = (12 + gc * 6)|0;  b = (12 + gc * 8)|0; }
    else if (ft === 2) { r = (25 + gc * 18)|0; g = (18 + gc * 12)|0; b = (35 + gc * 45)|0; }
    else if (ft === 3) { r = (35 + gc * 30)|0; g = (12 + gc * 8)|0;  b = (25 + gc * 22)|0; }
    else { r = 40; g = 40; b = 40; }
    if (cd > 0.15 && state.hiResData.isLand[hi] && !state.hiResData.isFreezing[hi]) { r = (r*0.6)|0; g = (g*0.6)|0; b = (b*0.6)|0; }
    return [r, g, b];
  }
  if (overlay === 'saturation') {
    if (!state.hiResData.isLand[hi]) return [10, 18, 45];
    const s = state.hiResData.saturation[hi];
    return [(110 - s*90)|0, (75 + s*35)|0, (25 + s*110)|0];
  }
  if (overlay === 'substrate') {
    if (!state.hiResData.isLand[hi]) return [15, 18, 25];
    const gs = state.hiResData.grainSize[hi];
    if (gs < 0.2) return [55, 65, 85];
    if (gs < 0.45) { const f=(gs-0.2)/0.25; return [(55+f*75)|0,(65+f*45)|0,(85-f*45)|0]; }
    if (gs < 0.65) { const f=(gs-0.45)/0.2; return [(130+f*45)|0,(110+f*25)|0,(40+f*8)|0]; }
    const f=(gs-0.65)/0.35; return [(175-f*70)|0,(135-f*50)|0,(48+f*35)|0];
  }
  if (overlay === 'drainage') {
    if (!state.hiResData.isLand[hi]) return [12, 20, 40];
    const so = state.hiResData.streamOrder[hi];
    if (so >= 3) return [70, 150, 220];
    if (so === 2) return [55, 115, 180];
    if (so === 1) return [45, 85, 130];
    return [40, 46, 42];
  }
  // Fallback: surface
  return [state.hiResData.colorR[hi], state.hiResData.colorG[hi], state.hiResData.colorB[hi]];
}

// Render the flat 1024×512 canvas by downsampling the high-res grid.
function renderFlatFromHighRes(overlay) {
  imageData = ctx.createImageData(1024, 512);
  const d = imageData.data;
  const CW = 1024, CH = 512;
  for (let cy = 0; cy < CH; cy++) {
    const hy = ((cy * HR_H / CH) | 0);
    const rowBase = hy * HR_W;
    for (let cx = 0; cx < CW; cx++) {
      const hx = ((cx * HR_W / CW) | 0);
      const rgb = hiResColorAt(rowBase + hx, overlay);
      const off = (cy * CW + cx) * 4;
      d[off] = rgb[0]; d[off + 1] = rgb[1]; d[off + 2] = rgb[2]; d[off + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

// ── Flat map renderer ──
function render(overlay) {
  if (state.planet) {
    const CW = 1024, CH = 512;
    imageData = ctx.createImageData(CW, CH);
    const d = imageData.data;
    const fn = overlays[overlay] || overlays.surface;
    for (let cy = 0; cy < CH; cy++) {
      const gy = (cy * state.HR_H / CH) | 0;
      const rowBase = gy * state.HR_W;
      for (let cx = 0; cx < CW; cx++) {
        const gx = (cx * state.HR_W / CW) | 0;
        const col = fn(rowBase + gx);
        const off = (cy * CW + cx) * 4;
        d[off] = col.r; d[off + 1] = col.g; d[off + 2] = col.b; d[off + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);

    if (overlay === 'wind')     drawStreamlines(ctx, 'wind', 1024, 512);
    else if (overlay === 'currents') drawStreamlines(ctx, 'currents', 1024, 512);

    drawSelectionMarker();
    return;
  }

  // Fallback (surface allocation failed / OOM): legacy low-res cells path.
  if (!state.cells) return;
  imageData = ctx.createImageData(1024, 512);
  const colorFn = getColorFn(overlay);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = state.cells[y * W + x];
      const col = colorFn(c);
      setPixel2x(x, y, col.r, col.g, col.b);
    }
  }
  ctx.putImageData(imageData, 0, 0);
  if (overlay === 'wind')          drawStreamlines(ctx, 'wind', 1024, 512);
  else if (overlay === 'currents') drawStreamlines(ctx, 'currents', 1024, 512);
  drawSelectionMarker();
}

function drawStreamlines(targetCtx, mode, canvasW, canvasH) {
  if (!cells) return;
  const scaleX = canvasW / W;
  const scaleY = canvasH / H;

  const numSeeds = mode === 'wind' ? 400 : 250;
  const steps = mode === 'wind' ? 20 : 25;
  const stepSize = 0.7;

  let meanSST = 0.5;
  if (mode === 'currents') {
    let sum = 0, count = 0;
    for (let i = 0; i < TOTAL; i++) {
      if (!state.cells[i].isLand) { sum += state.cells[i].sst; count++; }
    }
    if (count > 0) meanSST = sum / count;
  }

  const sqrtN = Math.ceil(Math.sqrt(numSeeds));
  for (let sy = 0; sy < sqrtN; sy++) {
    for (let sx = 0; sx < sqrtN; sx++) {
      let px = (sx + 0.5) / sqrtN * W;
      let py = (sy + 0.5) / sqrtN * H;

      const startIdx = Math.floor(clamp(py, 0, H-1)) * W + Math.floor(clamp(px, 0, W-1)) % W;
      if (mode === 'currents' && state.cells[startIdx].isLand) continue;

      const points = [{ x: px, y: py }];
      let validSteps = 0;

      for (let s = 0; s < steps; s++) {
        const ix = ((Math.floor(px) % W) + W) % W;
        const iy = clamp(Math.floor(py), 0, H - 1);
        const ci = iy * W + ix;
        const c = state.cells[ci];

        let u, v;
        if (mode === 'wind') {
          u = c.windU; v = c.windV;
        } else {
          if (c.isLand) break;
          u = c.currentU; v = c.currentV;
        }

        const mag = Math.sqrt(u * u + v * v);
        if (mag < 0.01) break;

        px += (u / mag) * stepSize;
        py += (v / mag) * stepSize;
        px = ((px % W) + W) % W;
        if (py < 0 || py >= H) break;

        points.push({ x: px, y: py });
        validSteps++;
      }

      if (validSteps < 3) continue;

      targetCtx.beginPath();
      targetCtx.moveTo(points[0].x * scaleX, points[0].y * scaleY);

      for (let i = 1; i < points.length; i++) {
        const dx = points[i].x - points[i-1].x;
        if (Math.abs(dx) > W / 2) {
          targetCtx.moveTo(points[i].x * scaleX, points[i].y * scaleY);
          continue;
        }
        targetCtx.lineTo(points[i].x * scaleX, points[i].y * scaleY);
      }

      if (mode === 'wind') {
        const ci = Math.floor(clamp(points[0].y, 0, H-1)) * W + ((Math.floor(points[0].x) % W) + W) % W;
        const spd = state.cells[ci].windSpeed;
        const alpha = clamp(0.15 + spd * 0.5, 0.15, 0.85);
        if (spd < 0.3) {
          targetCtx.strokeStyle = `rgba(120, 140, 160, ${alpha})`;
        } else if (spd < 0.8) {
          targetCtx.strokeStyle = `rgba(160, 190, 220, ${alpha})`;
        } else {
          targetCtx.strokeStyle = `rgba(220, 235, 255, ${alpha})`;
        }
      } else {
        const ci = Math.floor(clamp(points[0].y, 0, H-1)) * W + ((Math.floor(points[0].x) % W) + W) % W;
        const sst = state.cells[ci].sst;
        const diff = sst - meanSST;
        const alpha = clamp(0.3 + state.cells[ci].currentSpeed * 3, 0.2, 0.85);
        if (diff > 0.05) {
          const t = clamp(diff * 5, 0, 1);
          targetCtx.strokeStyle = `rgba(${200 + Math.floor(t*55)}, ${140 - Math.floor(t*60)}, ${60 - Math.floor(t*40)}, ${alpha})`;
        } else if (diff < -0.05) {
          const t = clamp(-diff * 5, 0, 1);
          targetCtx.strokeStyle = `rgba(${60 - Math.floor(t*30)}, ${100 + Math.floor(t*40)}, ${180 + Math.floor(t*60)}, ${alpha})`;
        } else {
          targetCtx.strokeStyle = `rgba(150, 150, 150, ${alpha})`;
        }
      }

      targetCtx.lineWidth = 1.2;
      targetCtx.stroke();

      if (points.length >= 2) {
        const last = points[points.length - 1];
        const prev = points[points.length - 2];
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;
        if (Math.abs(dx) < W / 2) {
          const angle = Math.atan2(dy, dx);
          const ax = last.x * scaleX;
          const ay = last.y * scaleY;
          const arrowLen = 3;
          targetCtx.beginPath();
          targetCtx.moveTo(ax, ay);
          targetCtx.lineTo(ax - arrowLen * Math.cos(angle - 0.4), ay - arrowLen * Math.sin(angle - 0.4));
          targetCtx.moveTo(ax, ay);
          targetCtx.lineTo(ax - arrowLen * Math.cos(angle + 0.4), ay - arrowLen * Math.sin(angle + 0.4));
          targetCtx.stroke();
        }
      }
    }
  }
}

// ── Mollweide projection ──
function mollweideProject(cellX, cellY, canvasW, canvasH) {
  const lon = (cellX / W) * 2 * Math.PI - Math.PI;
  const lat = (cellY / H) * Math.PI - Math.PI / 2;

  let theta = lat;
  for (let i = 0; i < 8; i++) {
    const denom = 2 + 2 * Math.cos(2 * theta);
    if (Math.abs(denom) < 1e-10) break;
    theta -= (2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin(lat)) / denom;
  }

  const mx = (2 * Math.SQRT2 / Math.PI) * lon * Math.cos(theta);
  const my = Math.SQRT2 * Math.sin(theta);

  const scale = 0.92;
  const px = (mx / (2 * Math.SQRT2) * scale + 0.5) * canvasW;
  const py = (0.5 - my / (2 * Math.SQRT2) * scale) * canvasH;

  return { x: px, y: py };
}

function mollweidePixelToCell(px, py) {
  const mw = mollweideCanvas.width, mh = mollweideCanvas.height;
  const scale = 0.92;

  const mx = ((px / mw - 0.5) / scale) * (2 * Math.SQRT2);
  const my = ((0.5 - py / mh) / scale) * (2 * Math.SQRT2);

  const ex = mx / (2 * Math.SQRT2);
  const ey = my / Math.SQRT2;
  if (ex * ex + ey * ey > 1.0) return null;

  const sinTheta = clamp(my / Math.SQRT2, -1, 1);
  const theta = Math.asin(sinTheta);
  const cosTheta = Math.cos(theta);

  if (Math.abs(cosTheta) < 1e-10) {
    const lat = sinTheta > 0 ? Math.PI / 2 : -Math.PI / 2;
    const cellX = Math.floor(W / 2);
    const cellY = Math.floor(Math.max(0, Math.min(H - 1, (lat + Math.PI / 2) / Math.PI * H)));
    return { x: cellX, y: cellY };
  }

  const lon = (mx * Math.PI) / (2 * Math.SQRT2 * cosTheta);
  if (lon < -Math.PI || lon > Math.PI) return null;

  const sinLat = clamp((2 * theta + Math.sin(2 * theta)) / Math.PI, -1, 1);
  const lat = Math.asin(sinLat);

  const cellX = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * W) % W;
  const cellY = Math.floor(Math.max(0, Math.min(H - 1, ((lat + Math.PI / 2) / Math.PI) * H)));

  return { x: cellX, y: cellY };
}

function renderMollweide() {
  if (!state.cells) return;
  const mw = mollweideCanvas.width, mh = mollweideCanvas.height;
  const mImageData = mollweideCtx.createImageData(mw, mh);
  const data = mImageData.data;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = 5; data[i + 1] = 8; data[i + 2] = 16; data[i + 3] = 255;
  }

  if (state.planet) {
    const flat = ctx.getImageData(0, 0, 1024, 512).data;
    const scale = 0.92;
    for (let py = 0; py < mh; py++) {
      for (let px = 0; px < mw; px++) {
        const mx = ((px / mw - 0.5) / scale) * (2 * Math.SQRT2);
        const my = ((0.5 - py / mh) / scale) * (2 * Math.SQRT2);
        const ex = mx / (2 * Math.SQRT2), ey = my / Math.SQRT2;
        if (ex * ex + ey * ey > 1.0) continue;
        const sinTheta = clamp(my / Math.SQRT2, -1, 1);
        const theta = Math.asin(sinTheta);
        const cosTheta = Math.cos(theta);
        if (Math.abs(cosTheta) < 1e-10) continue;
        const lon = (mx * Math.PI) / (2 * Math.SQRT2 * cosTheta);
        if (lon < -Math.PI || lon > Math.PI) continue;
        const sinLat = clamp((2 * theta + Math.sin(2 * theta)) / Math.PI, -1, 1);
        const lat = Math.asin(sinLat);
        const tx = Math.min(1023, Math.max(0, ((lon + Math.PI) / (2 * Math.PI)) * 1024 | 0));
        const ty = Math.min(511, Math.max(0, ((lat + Math.PI / 2) / Math.PI) * 512 | 0));
        const src = (ty * 1024 + tx) * 4;
        const off = (py * mw + px) * 4;
        data[off] = flat[src]; data[off + 1] = flat[src + 1]; data[off + 2] = flat[src + 2]; data[off + 3] = 255;
      }
    }
    mollweideCtx.putImageData(mImageData, 0, 0);
    drawSelectionMarker();
    return;
  }

  const overlaySelect = document.getElementById('overlaySelect');
  const colorFn = getColorFn(overlaySelect.value);

  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const pos = mollweideProject(cx, cy, mw, mh);
      const cell = state.cells[cy * W + cx];
      const col = colorFn(cell);

      const px0 = Math.round(pos.x);
      const py0 = Math.round(pos.y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = px0 + dx;
          const py = py0 + dy;
          if (px >= 0 && px < mw && py >= 0 && py < mh) {
            const off = (py * mw + px) * 4;
            data[off] = col.r;
            data[off + 1] = col.g;
            data[off + 2] = col.b;
            data[off + 3] = 255;
          }
        }
      }
    }
  }

  mollweideCtx.putImageData(mImageData, 0, 0);
  drawSelectionMarker();
}


function renderGlobe() {
  if (!state.cells) return;

  const flatCtx = ctx;
  const flatData = flatCtx.getImageData(0, 0, 1024, 512).data;

  const gw = globeCanvas.width, gh = globeCanvas.height;
  const globeImageData = globeCtx.createImageData(gw, gh);
  const data = globeImageData.data;

  const cx = gw / 2, cy = gh / 2;
  const radius = Math.min(cx, cy) * 0.9;

  const cosY = Math.cos(state.rotY), sinY = Math.sin(state.rotY);
  const cosX = Math.cos(state.rotX), sinX = Math.sin(state.rotX);

  for (let py = 0; py < gh; py++) {
    for (let px = 0; px < gw; px++) {
      const pixIdx = (py * gw + px) * 4;

      const sx = (px - cx) / radius;
      const sy = (py - cy) / radius;
      const r2 = sx * sx + sy * sy;

      if (r2 > 1.0) {
        data[pixIdx]     = 5;
        data[pixIdx + 1] = 8;
        data[pixIdx + 2] = 15;
        data[pixIdx + 3] = 255;
        continue;
      }

      const sz = Math.sqrt(1 - r2);

      let x3d = sx * cosY + sz * sinY;
      let z3d = -sx * sinY + sz * cosY;

      let y3d = sy * cosX - z3d * sinX;
      let z3d2 = sy * sinX + z3d * cosX;

      const lat = Math.asin(Math.max(-1, Math.min(1, -y3d)));
      const lon = Math.atan2(x3d, z3d2);

      const texX = ((lon / Math.PI + 1) / 2 * 1024) % 1024;
      const texY = ((-lat / (Math.PI / 2) + 1) / 2 * 512);

      const ti = Math.floor(Math.max(0, Math.min(1023, texX)));
      const tj = Math.floor(Math.max(0, Math.min(511, texY)));
      const texIdx = (tj * 1024 + ti) * 4;

      const ci = Math.floor(ti / 2);
      const cj = Math.floor(tj / 2);
      const elev = state.cells[cj * W + ci].elevation;

      const ciR = (ci + 1) % W;
      const cjU = Math.max(0, cj - 1);
      const elevRight = state.cells[cj * W + ciR].elevation;
      const elevUp    = state.cells[cjU * W + ci].elevation;
      const reliefScale = 8.0;
      const dEdx = (elevRight - elev) * reliefScale;
      const dEdy = (elevUp - elev) * reliefScale;
      const reliefShade = 1.0 + dEdx * 0.5 + dEdy * (-0.5);

      const shade = Math.max(0.08, Math.min(1.2, (0.3 + 0.7 * sz) * reliefShade));

      data[pixIdx]     = Math.floor(flatData[texIdx] * shade);
      data[pixIdx + 1] = Math.floor(flatData[texIdx + 1] * shade);
      data[pixIdx + 2] = Math.floor(flatData[texIdx + 2] * shade);
      data[pixIdx + 3] = 255;
    }
  }

  globeCtx.putImageData(globeImageData, 0, 0);
  drawOrientationHUD(globeCtx, gw);
  drawSelectionMarker();
}

function drawOrientationHUD(ctx, canvasW) {
  const size = 60;
  const cx = canvasW - size / 2 - 12;
  const cy = size / 2 + 12;
  const radius = 22;

  ctx.beginPath();
  ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(150, 160, 180, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const northX = cx;
  const northY = cy - Math.cos(state.rotX) * radius * 0.8;

  ctx.beginPath();
  ctx.arc(northX, northY, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#8ab4f8';
  ctx.fill();

  ctx.fillStyle = '#8ab4f8';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', northX, northY - 6);

  const southX = cx;
  const southY = cy + Math.cos(state.rotX) * radius * 0.8;

  ctx.beginPath();
  ctx.arc(southX, southY, 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(180, 130, 100, 0.6)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.fill();

  if (Math.abs(state.rotX - HOME_ROT_X) > 0.05) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.4, -Math.PI/2, -Math.PI/2 + state.rotX * 2, state.rotX < 0);
    ctx.strokeStyle = 'rgba(150, 180, 220, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
function globePixelToCell(px, py) {
  const gw = globeCanvas.width, gh = globeCanvas.height;
  const cx = gw / 2, cy = gh / 2;
  const radius = Math.min(cx, cy) * 0.9;

  const sx = (px - cx) / radius;
  const sy = (py - cy) / radius;
  const r2 = sx * sx + sy * sy;
  if (r2 > 1.0) return null;

  const sz = Math.sqrt(1 - r2);

  const cosY = Math.cos(state.rotY), sinY = Math.sin(state.rotY);
  const cosX = Math.cos(state.rotX), sinX = Math.sin(state.rotX);

  let x3d = sx * cosY + sz * sinY;
  let z3d = -sx * sinY + sz * cosY;
  let y3d = sy * cosX - z3d * sinX;
  let z3d2 = sy * sinX + z3d * cosX;

  const lat = Math.asin(Math.max(-1, Math.min(1, -y3d)));
  const lon = Math.atan2(x3d, z3d2);

  const cellX = Math.floor(((lon / Math.PI + 1) / 2 * W) % W);
  const cellY = Math.floor(Math.max(0, Math.min(H - 1, (-lat / (Math.PI / 2) + 1) / 2 * H)));

  return { x: cellX, y: cellY };
}
function drawMarkerBox(c, mx, my, half) {
  c.save();
  // dark contrast outline so the white box reads on any terrain
  c.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  c.lineWidth = 3;
  c.strokeRect(mx - half, my - half, half * 2, half * 2);
  // white box
  c.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  c.lineWidth = 1.5;
  c.strokeRect(mx - half, my - half, half * 2, half * 2);
  // center dot
  c.beginPath();
  c.arc(mx, my, 1.8, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255, 255, 255, 0.95)';
  c.fill();
  c.restore();
}

// Forward-project a planetary cell (fractional cx,cy) onto the globe's screen
// pixels. Returns null when the point is on the far (hidden) hemisphere.
function globeCellToPixel(cellX, cellY) {
  const gw = globeCanvas.width, gh = globeCanvas.height;
  const scx = gw / 2, scy = gh / 2;
  const radius = Math.min(scx, scy) * 0.9;

  const lon = ((cellX / W) * 2 - 1) * Math.PI;
  const lat = (1 - (2 * cellY) / H) * (Math.PI / 2);

  // world-space unit vector (matches globePixelToCell's convention)
  const x3d = Math.cos(lat) * Math.sin(lon);
  const y3d = -Math.sin(lat);
  const z3d2 = Math.cos(lat) * Math.cos(lon);

  const cosX = Math.cos(state.rotX), sinX = Math.sin(state.rotX);
  const cosY = Math.cos(state.rotY), sinY = Math.sin(state.rotY);

  // invert the view rotation to recover screen-space coords
  const sy = cosX * y3d + sinX * z3d2;
  const z3d = -sinX * y3d + cosX * z3d2;
  const sx = cosY * x3d - sinY * z3d;
  const sz = sinY * x3d + cosY * z3d;

  if (sz <= 0) return null; // facing away from the viewer

  return { x: scx + sx * radius, y: scy + sy * radius };
}

function drawSelectionMarker() {
  if (!state.selectedRegion) return;

  if (state.currentView === 'flat') {
    const scaleX = 1024 / W, scaleY = 512 / H;
    drawMarkerBox(ctx, state.selectedRegion.cx * scaleX, state.selectedRegion.cy * scaleY, 9);
  } else if (state.currentView === 'mollweide') {
    const p = mollweideProject(state.selectedRegion.cx, state.selectedRegion.cy, mollweideCanvas.width, mollweideCanvas.height);
    drawMarkerBox(mollweideCtx, p.x, p.y, 8);
  } else if (state.currentView === 'globe') {
    const p = globeCellToPixel(state.selectedRegion.cx, state.selectedRegion.cy);
    if (p) drawMarkerBox(globeCtx, p.x, p.y, 8);
  }
}

export {
  render, renderGlobe, renderMollweide,
  drawSelectionMarker, drawStreamlines,
  overlays, overlayFunctions,
  mollweideProject, mollweidePixelToCell, globePixelToCell, globeCellToPixel,
  getColorFn
};
