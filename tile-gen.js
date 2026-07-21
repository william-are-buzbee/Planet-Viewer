// ══════════════════════════════════════════════════════════════════
// ── tile-gen.js — Tile/Chunk Generation (Phase B) ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import { W, H, mulberry32, hashInt, noise2D, clamp } from './core-math.js';
import {
  deriveTerrainAndCover, SHALLOW_WATER_TERRAIN_THRESHOLD,
  terrainTypeToInt, coverTypeToInt, intToTerrainType, intToCoverType,
  TT_NONE, TT_DEEP_WATER, TT_WATER, TT_MUD, TT_GRASS,
  TT_DIRT, TT_SAND, TT_ROCK, TT_BEACH,
  CT_NONE, CT_FOREST, CT_MUSHFOREST, CT_SPARSE_FOREST, CT_SPARSE_MUSHFOREST
} from './terrain-derive.js';
import { computeTilePalette, tilePhysical } from './palette-compute.js';
import { REGIONAL_SIZE } from './regional-gen.js';

const CHUNK_W = 512, CHUNK_H = 512;
const CHUNK_TOTAL = CHUNK_W * CHUNK_H;

// ── Sprite Variant Selection (physical state → texture index) ──

function positionHash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    h = h ^ (h >> 16);
    return (h & 0x7FFFFFFF) / 0x7FFFFFFF;
}

function selectSpriteVariant(terrainType, coverType, physical, wx, wy) {
    const ph = positionHash(wx, wy);
    let ground = 0;
    let cover = 0;

    switch (terrainType) {
        case 'grass':
            if (physical.groundCover > 0.75) {
                ground = 1;
            } else if (physical.groundCover < 0.35) {
                ground = ph < 0.6 ? 2 : 3;
            } else {
                ground = ph < 0.5 ? 0 : 1;
            }
            break;
        case 'mud':
            ground = 0;
            break;
        case 'water':
            if (physical.waterDepth < 0.05) {
                ground = 2;
            } else if (physical.streamOrder >= 3) {
                ground = ph < 0.5 ? 1 : 3;
            } else if (physical.waterDepth > 0.2) {
                ground = ph < 0.5 ? 2 : 4;
            } else {
                ground = ph < 0.5 ? 0 : 1;
            }
            break;
        case 'deep_water':
            ground = Math.floor(ph * 3);
            break;
        case 'rock':
            ground = Math.floor(ph * 3);
            break;
        case 'dirt':
            ground = 0;
            break;
        case 'sand':
            ground = 0;
            break;
        case 'beach':
            ground = 0;
            break;
        default:
            ground = 0;
    }

    switch (coverType) {
        case 'forest':
            cover = 0;
            break;
        case 'sparse_forest':
            cover = 0;
            break;
        case 'mushforest':
            cover = 0;
            break;
        case 'sparse_mushforest':
            cover = 0;
            break;
        default:
            cover = 0;
    }

    return { ground, cover };
}

// Per-zone tile topography parameters
const tileZoneParams = {
  summit:      { channelSpacing: 25,  channelDepth: 0.006, anisotropy: 0.30, ridgeAmp: 0.050 },
  upper_slope: { channelSpacing: 35,  channelDepth: 0.009, anisotropy: 0.50, ridgeAmp: 0.040 },
  mid_slope:   { channelSpacing: 55,  channelDepth: 0.011, anisotropy: 0.65, ridgeAmp: 0.030 },
  lowland:     { channelSpacing: 90,  channelDepth: 0.008, anisotropy: 0.75, ridgeAmp: 0.018 },
  coastal:     { channelSpacing: 120, channelDepth: 0.005, anisotropy: 0.60, ridgeAmp: 0.012 },
  tidal:       { channelSpacing: 150, channelDepth: 0.003, anisotropy: 0.50, ridgeAmp: 0.008 },
};

state.currentTileData = null;
state.tileChunkCache = new Map();


// ── T1: Sample regional context (3×3 bilinear interpolation) ──
function sampleRegionalContext(rx, ry) {
  const centre = state.regionalCells[rx][ry];

  // Clamped accessor over the 3×3 regional neighborhood
  function regGet(gx, gy, fn) {
    const cx = clamp(rx + gx, 0, REGIONAL_SIZE - 1);
    const cy = clamp(ry + gy, 0, REGIONAL_SIZE - 1);
    return fn(state.regionalCells[cx][cy]);
  }

  // Precompute a 3×3 grid (indexed [gx+1][gy+1]) for one property
  function grid(fn) {
    const g = [[0,0,0],[0,0,0],[0,0,0]];
    for (let gx = -1; gx <= 1; gx++)
      for (let gy = -1; gy <= 1; gy++)
        g[gx + 1][gy + 1] = regGet(gx, gy, fn);
    return g;
  }

  const gElev   = grid(c => (c.baseElevation !== undefined ? c.baseElevation : c.elevation));
  const gPrecip = grid(c => c.precipitation);
  const gGW     = grid(c => c.groundwater);
  const gWA     = grid(c => c.waterAvailability);
  const gTemp   = grid(c => c.temperature);
  const gGrain  = grid(c => (c.grainSize !== undefined ? c.grainSize : (c.baseGrainSize || 0.3)));
  const gFe     = grid(c => c.minerals.iron);
  const gCu     = grid(c => c.minerals.copper);
  const gMn     = grid(c => c.minerals.manganese);
  // Inherit the region's physical / flora state so the tile matches its parent.
  const gSat    = grid(c => c.saturation || 0);
  const gWTD    = grid(c => (c.waterTableDepth !== undefined ? c.waterTableDepth : 0));
  const gGC     = grid(c => c.groundCover || 0);
  const gCanopy = grid(c => c.canopy || 0);
  const gChemo  = grid(c => c.chemoCrust || 0);
  const gOrg    = grid(c => c.organicContent || 0);
  const gDens   = grid(c => c.floraDensity || 0);

  const elevation        = new Float32Array(CHUNK_TOTAL);
  const precipitation    = new Float32Array(CHUNK_TOTAL);
  const groundwater      = new Float32Array(CHUNK_TOTAL);
  const waterAvailability= new Float32Array(CHUNK_TOTAL);
  const temperature      = new Float32Array(CHUNK_TOTAL);
  const grainSizeRegional= new Float32Array(CHUNK_TOTAL);
  const iron             = new Float32Array(CHUNK_TOTAL);
  const copper           = new Float32Array(CHUNK_TOTAL);
  const manganese        = new Float32Array(CHUNK_TOTAL);
  const satRegional      = new Float32Array(CHUNK_TOTAL);
  const wtdRegional      = new Float32Array(CHUNK_TOTAL);
  const gcRegional       = new Float32Array(CHUNK_TOTAL);
  const canopyRegional   = new Float32Array(CHUNK_TOTAL);
  const chemoRegional    = new Float32Array(CHUNK_TOTAL);
  const organicRegional  = new Float32Array(CHUNK_TOTAL);
  const densRegional     = new Float32Array(CHUNK_TOTAL);

  // Inline bilinear: at tile center → clicked cell; toward edges → blend to neighbors
  function bil(g, fx, fy) {
    // fx,fy in 0..1 across the tile; map to signed offset from centre
    const rxf = fx - 0.5;      // [-0.5, 0.5]
    const ryf = fy - 0.5;
    let gx0, tX, gy0, tY;
    if (rxf < 0) { gx0 = 0; tX = rxf + 1; } else { gx0 = 1; tX = rxf; }   // grid idx 0/1 or 1/2
    if (ryf < 0) { gy0 = 0; tY = ryf + 1; } else { gy0 = 1; tY = ryf; }
    const v00 = g[gx0][gy0],     v10 = g[gx0 + 1][gy0];
    const v01 = g[gx0][gy0 + 1], v11 = g[gx0 + 1][gy0 + 1];
    const vx0 = v00 + (v10 - v00) * tX;
    const vx1 = v01 + (v11 - v01) * tX;
    return vx0 + (vx1 - vx0) * tY;
  }

  for (let ty = 0; ty < CHUNK_H; ty++) {
    const fy = (ty + 0.5) / CHUNK_H;
    for (let tx = 0; tx < CHUNK_W; tx++) {
      const fx = (tx + 0.5) / CHUNK_W;
      const ti = ty * CHUNK_W + tx;
      elevation[ti]         = bil(gElev, fx, fy);
      precipitation[ti]     = bil(gPrecip, fx, fy);
      groundwater[ti]       = bil(gGW, fx, fy);
      waterAvailability[ti] = bil(gWA, fx, fy);
      temperature[ti]       = bil(gTemp, fx, fy);
      grainSizeRegional[ti] = bil(gGrain, fx, fy);
      iron[ti]              = bil(gFe, fx, fy);
      copper[ti]            = bil(gCu, fx, fy);
      manganese[ti]         = bil(gMn, fx, fy);
      satRegional[ti]       = bil(gSat, fx, fy);
      wtdRegional[ti]       = bil(gWTD, fx, fy);
      gcRegional[ti]        = bil(gGC, fx, fy);
      canopyRegional[ti]    = bil(gCanopy, fx, fy);
      chemoRegional[ti]     = bil(gChemo, fx, fy);
      organicRegional[ti]   = bil(gOrg, fx, fy);
      densRegional[ti]      = bil(gDens, fx, fy);
    }
  }

  const _ftInt = { barren: 0, photosynthetic: 1, chemotrophic: 2, mixotrophic: 3, none: 0, frozen: 0 };
  return {
    rx, ry,
    zone: centre.zone,
    slopeDirection: centre.slopeDir,
    slopeMagnitude: centre.slopeMag,
    worldX: rx * CHUNK_W,
    worldY: ry * CHUNK_H,
    seed: 0,
    elevation, precipitation, groundwater, waterAvailability, temperature,
    grainSizeRegional, iron, copper, manganese,
    // Inherited region physical / flora state (tile baseline)
    satRegional, wtdRegional, gcRegional, canopyRegional, chemoRegional, organicRegional, densRegional,
    floraTypeInt: _ftInt[centre.floraType] || 0,
  };
}

// ── T2: Tile topography (anisotropic ridge + channel noise in WORLD coords) ──
function generateTileTopography(context) {
  const out = new Float32Array(CHUNK_TOTAL);
  const zp = tileZoneParams[context.zone] || tileZoneParams['mid_slope'];
  const seed = context.seed;
  const dir = context.slopeDirection || 0;
  const cosD = Math.cos(dir), sinD = Math.sin(dir);
  const aniso = zp.anisotropy;
  const spacing = zp.channelSpacing;
  const chDepth = zp.channelDepth;
  const ridgeAmp = zp.ridgeAmp;

  for (let ty = 0; ty < CHUNK_H; ty++) {
    for (let tx = 0; tx < CHUNK_W; tx++) {
      const ti = ty * CHUNK_W + tx;
      const base = context.elevation[ti];

      // World coordinates (contiguous across regional-cell edges → seamless)
      const wx = context.worldX + tx;
      const wy = context.worldY + ty;

      // Rotate into slope-aligned frame: ax along-slope, ay across-slope
      const ax = wx * cosD + wy * sinD;
      const ay = -wx * sinD + wy * cosD;

      // Ridged fractal detail
      let ridge = 0, amp = 1, freq = 0.02, tot = 0;
      for (let o = 0; o < 4; o++) {
        const nv = noise2D(ax * freq * (1 + aniso), ay * freq, seed + o * 137);
        ridge += amp * (1 - Math.abs(nv));
        tot += amp; amp *= 0.5; freq *= 2;
      }
      ridge = ridge / tot - 0.5;

      // Downslope channels (run along-slope; vary across-slope)
      const perturb = noise2D(ax * 0.03, ay * 0.03, seed + 900) * spacing * 0.4;
      const chv = Math.abs(Math.sin(((ay + perturb) / spacing) * Math.PI));
      const channel = (1 - chv);
      const channelCarve = channel * channel * chDepth;

      let elev = base + ridge * ridgeAmp - channelCarve;

      // Land preservation: interior land shouldn't dip to ocean from detail alone
      if (base > 0.01 && elev < 0.0005) elev = 0.0005;

      out[ti] = elev;
    }
  }
  return out;
}

// ── T3: Tile drainage (D8 flow accumulation + stream order) ──
function computeTileDrainage(tileElevation, tilePrecip, Wt, Ht) {
  const N = Wt * Ht;
  const streamOrder = new Uint8Array(N);
  const flow = new Float32Array(N);

  // Collect land indices
  let landCount = 0;
  for (let i = 0; i < N; i++) {
    if (tileElevation[i] > 0) {
      flow[i] = (tilePrecip[i] || 0) + 0.02;
      landCount++;
    } else {
      flow[i] = 0;
    }
  }

  const landIdx = new Int32Array(landCount);
  let k = 0;
  for (let i = 0; i < N; i++) {
    if (tileElevation[i] > 0) landIdx[k++] = i;
  }
  // Process high → low
  const sorted = Array.prototype.slice.call(landIdx);
  sorted.sort((a, b) => tileElevation[b] - tileElevation[a]);

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  for (let s = 0; s < sorted.length; s++) {
    const i = sorted[s];
    const tx = i % Wt, ty = (i / Wt) | 0;
    const e = tileElevation[i];
    let lowest = -1, lowestElev = e;
    for (let d = 0; d < 8; d++) {
      const nx = tx + dx8[d], ny = ty + dy8[d];
      if (nx < 0 || nx >= Wt || ny < 0 || ny >= Ht) continue;
      const ni = ny * Wt + nx;
      if (tileElevation[ni] < lowestElev) { lowestElev = tileElevation[ni]; lowest = ni; }
    }
    if (lowest >= 0) flow[lowest] += flow[i];
  }

  const avgP = tilePrecip[0] || 0.01;
  const t1 = 1.5 / (1 + avgP * 8);
  const t2 = t1 * 6;
  const t3 = t1 * 25;

  for (let i = 0; i < N; i++) {
    if (tileElevation[i] <= 0) { streamOrder[i] = 0; continue; }
    const f = flow[i];
    streamOrder[i] = f > t3 ? 3 : f > t2 ? 2 : f > t1 ? 1 : 0;
  }

  return { streamOrder, flowAccum: flow };
}

// ── Water coherence constants ──
const MIN_BASIN_AREA      = 8;    // tiles — minimum pond size
const MAX_BASIN_AREA      = Math.floor(CHUNK_TOTAL * 0.02);  // tiles — max 2% of chunk per basin
const MIN_BASIN_DEPTH     = 0.0015;// elevation units — minimum depression depth for ponding
const MIN_WATER_FEATURE   = 8;    // tiles — connected component size threshold
const SHORELINE_DISTANCE  = 4;    // tiles — how far the wet-bank transition extends
const CHANNEL_WATER_ORDER = 3;    // minimum stream order for visible channel water

// ── T3.5: Water body detection (coherent spatial features, not per-tile noise) ──
// Runs ONCE over the entire chunk and returns typed arrays for hasWater, waterDepth,
// and saturationBoost.  Replaces per-tile standing-water logic with basin-filling
// and connected-component filtering to produce physically coherent water features.
function computeTileWaterBodies(tileElevation, streamOrder, context, zone) {
  const W = CHUNK_W, H = CHUNK_H, N = CHUNK_TOTAL;
  const hasWater   = new Uint8Array(N);
  const waterDepth = new Float32Array(N);
  const satBoost   = new Float32Array(N);

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  // ── Ocean tiles ──
  for (let i = 0; i < N; i++) {
    if (tileElevation[i] <= 0) {
      hasWater[i] = 1;
      waterDepth[i] = -tileElevation[i];
    }
  }

  // ── Channel water: stream order >= CHANNEL_WATER_ORDER only ──
  for (let i = 0; i < N; i++) {
    if (tileElevation[i] > 0 && streamOrder[i] >= CHANNEL_WATER_ORDER) {
      hasWater[i] = 1;
      waterDepth[i] = 0.02 + (streamOrder[i] - CHANNEL_WATER_ORDER) * 0.01;
    }
  }

  // ── Basin detection and filling ──
  // Find local minima (seeds) among land tiles not already water
  const visited = new Uint8Array(N);
  const basinId = new Int32Array(N);
  basinId.fill(-1);
  let nextBasin = 0;

  // Pour-depth tolerance varies by zone (flatter terrain → shallower basins hold water).
  // Must be a SMALL FRACTION of the zone's tile-level relief (ridgeAmp + channelDepth)
  // so that basins only fill genuine depressions, not entire valleys.
  // Target: ~15-25% of total relief for each zone.
  let pourTolerance;
  switch (zone) {
    case 'lowland':     pourTolerance = 0.004;  break;  // relief ~0.026
    case 'coastal':     pourTolerance = 0.003;  break;  // relief ~0.017
    case 'tidal':       pourTolerance = 0.002;  break;  // relief ~0.011
    case 'mid_slope':   pourTolerance = 0.007;  break;  // relief ~0.041
    case 'upper_slope': pourTolerance = 0.010;  break;  // relief ~0.049
    case 'summit':      pourTolerance = 0.012;  break;  // relief ~0.056
    default:            pourTolerance = 0.005;  break;
  }

  // Regional saturation at the chunk center (used to filter dry-zone basins)
  const centerSat = (context.satRegional && context.satRegional[((H >> 1) * W + (W >> 1))]) || 0;

  for (let i = 0; i < N; i++) {
    if (tileElevation[i] <= 0 || hasWater[i] || visited[i]) continue;

    // Check if this tile is a local minimum (lower than all 8 neighbors)
    const tx = i % W, ty = (i / W) | 0;
    const e = tileElevation[i];
    let isMin = true;
    for (let d = 0; d < 8; d++) {
      const nx = tx + dx8[d], ny = ty + dy8[d];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (tileElevation[ny * W + nx] <= e) { isMin = false; break; }
    }
    if (!isMin) continue;

    // BFS flood-fill from this minimum to find the basin
    // A tile joins the basin if its elevation is below (min_elevation + pourTolerance)
    const fillLevel = e + pourTolerance;
    const queue = [i];
    const basin = [i];
    visited[i] = 1;
    let maxDepth = 0;

    let head = 0;
    let overflowed = false;
    while (head < queue.length) {
      if (basin.length >= MAX_BASIN_AREA) { overflowed = true; break; }
      const ci = queue[head++];
      const cx = ci % W, cy = (ci / W) | 0;
      const ce = tileElevation[ci];
      const depth = fillLevel - ce;
      if (depth > maxDepth) maxDepth = depth;

      for (let d = 0; d < 8; d++) {
        const nx = cx + dx8[d], ny = cy + dy8[d];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (visited[ni] || tileElevation[ni] <= 0 || hasWater[ni]) continue;
        if (tileElevation[ni] < fillLevel) {
          visited[ni] = 1;
          queue.push(ni);
          basin.push(ni);
        }
      }
    }

    // Filter by physical criteria
    if (overflowed) continue;  // basin exceeded max area — not a realistic pond
    if (basin.length < MIN_BASIN_AREA) continue;
    if (maxDepth < MIN_BASIN_DEPTH) continue;
    // Dry-zone check: basins on arid upper slopes with deep water tables stay empty
    if (centerSat < 0.4 && (zone === 'upper_slope' || zone === 'summit')) continue;

    // Mark basin tiles as water
    const bid = nextBasin++;
    for (let b = 0; b < basin.length; b++) {
      const bi = basin[b];
      hasWater[bi] = 1;
      waterDepth[bi] = Math.max(0.005, fillLevel - tileElevation[bi]);
      basinId[bi] = bid;
    }
  }

  // ── Connected component filtering ──
  // Label ALL hasWater tiles (ocean + channels + basins) into connected components.
  // Discard land components smaller than MIN_WATER_FEATURE.
  const ccLabel = new Int32Array(N);
  ccLabel.fill(-1);
  let nextCC = 0;
  const ccSizes = [];

  for (let i = 0; i < N; i++) {
    if (!hasWater[i] || ccLabel[i] >= 0) continue;
    const label = nextCC++;
    const ccQueue = [i];
    ccLabel[i] = label;
    let size = 0;
    let hasOcean = false;
    let ch = 0;
    while (ch < ccQueue.length) {
      const ci = ccQueue[ch++];
      size++;
      if (tileElevation[ci] <= 0) hasOcean = true;
      const cx = ci % W, cy = (ci / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx8[d], ny = cy + dy8[d];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (hasWater[ni] && ccLabel[ni] < 0) {
          ccLabel[ni] = label;
          ccQueue.push(ni);
        }
      }
    }
    ccSizes[label] = { size, hasOcean };
  }

  // Demote small land-only components
  for (let i = 0; i < N; i++) {
    if (!hasWater[i]) continue;
    const lab = ccLabel[i];
    if (lab >= 0 && !ccSizes[lab].hasOcean && ccSizes[lab].size < MIN_WATER_FEATURE) {
      hasWater[i] = 0;
      waterDepth[i] = 0;
      satBoost[i] = 0.15; // demoted tiles are still very wet mud
    }
  }

  // ── Shoreline saturation boost ──
  // BFS outward from all remaining water tiles, up to SHORELINE_DISTANCE tiles.
  const dist = new Uint8Array(N);
  dist.fill(255);
  const shoreQueue = [];
  for (let i = 0; i < N; i++) {
    if (hasWater[i] && tileElevation[i] > 0) { // land-water tiles seed the shore
      dist[i] = 0;
      shoreQueue.push(i);
    }
  }
  let sHead = 0;
  while (sHead < shoreQueue.length) {
    const ci = shoreQueue[sHead++];
    const cd = dist[ci];
    if (cd >= SHORELINE_DISTANCE) continue;
    const cx = ci % W, cy = (ci / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      const nd = cd + 1;
      if (nd < dist[ni] && !hasWater[ni] && tileElevation[ni] > 0) {
        dist[ni] = nd;
        shoreQueue.push(ni);
        // Falloff: adjacent = 0.20, 2 tiles = 0.15, 3 tiles = 0.10, 4 tiles = 0.05
        const boost = Math.max(0, 0.25 - nd * 0.05);
        satBoost[ni] = Math.max(satBoost[ni], boost);
      }
    }
  }

  return { hasWater, waterDepth, satBoost };
}

// ── T4: Physical state (substrate, water table, saturation) ──
// NOTE: Standing water is no longer computed here — it is determined by
// computeTileWaterBodies at the chunk level (step T3.5). This function
// receives tileHasWater, tileWaterDepth, and saturationBoost as inputs.
function computeTilePhysicalState(ti, tileElevation, streamOrderVal, context, zone, tileHasWater, tileWaterDepth, tileSatBoost) {
  const seed = context.seed;
  const tx = ti % CHUNK_W, ty = (ti / CHUNK_W) | 0;
  const wx = context.worldX + tx, wy = context.worldY + ty;
  const elev = tileElevation[ti];
  const gw = context.groundwater[ti];

  // Grain size: regional base + local noise, modulated by zone / stream
  const grainNoise = noise2D(wx * 0.1, wy * 0.1, seed + 800);
  let grain = context.grainSizeRegional[ti] + grainNoise * 0.12;
  if (zone === 'summit' || zone === 'upper_slope') grain += 0.10;
  if (streamOrderVal >= 2) grain = Math.min(grain, 0.30); // river deposits fines
  grain = clamp(grain, 0.05, 1.0);

  // Saturation & water table are INHERITED from the parent region — the tile is
  // a zoom of the region, so it must never recompute these from precipitation
  // (which is ~0 in arid regions and would dry every tile out, then need a floor
  // to "compensate"). Instead we start from the regional value and let local
  // drainage only ADD wetness. A negative water table = standing/marsh water,
  // which the tile now preserves so wet cells stay wet (region==tile).
  const regSat = (context.satRegional && context.satRegional[ti]) || 0;
  const regWTD = (context.wtdRegional && context.wtdRegional[ti] !== undefined)
    ? context.wtdRegional[ti]
    : clamp((1 - gw) * (0.3 + elev * 3), 0, 1);   // fallback if not inherited
  let sat = regSat;
  let waterTableDepth = regWTD;
  if (streamOrderVal >= 3)      { sat = Math.max(sat, 0.95); waterTableDepth = Math.min(waterTableDepth, -0.02); }
  else if (streamOrderVal >= 2) { sat = Math.max(sat, 0.85); waterTableDepth = Math.min(waterTableDepth, 0.0); }
  else if (streamOrderVal >= 1) { sat = Math.min(1, sat + 0.10); waterTableDepth = Math.min(waterTableDepth, 0.01); }
  sat = clamp(sat, 0, 1);

  // Apply shoreline saturation boost from water body proximity (T3.5)
  sat = clamp(sat + (tileSatBoost || 0), 0, 1);

  return { grainSize: grain, waterTableDepth, saturation: sat, hasWater: !!tileHasWater, waterDepth: tileWaterDepth || 0 };
}

// ── T5: Tile flora ──
// Inherits the parent region's flora type and density so the tile matches the
// regional/planetary view, then applies local micro-variation (streams and
// saturation nudge cover up; ridges/dryness nudge it down).
function computeTileFlora(ti, physical, context) {
  const temp = context.temperature[ti];
  if (physical.hasWater) {
    // Standing water: no rooted canopy, but floating mat persists in shallows.
    // Flora type inherited from regional parent (not reset to 'none').
    const ftNames = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic'];
    const floraType = ftNames[context.floraTypeInt] || 'barren';
    const wd = physical.waterDepth || 0;

    let groundCover, chemoCrust;
    const regGC = (context.gcRegional && context.gcRegional[ti]) || 0;
    const regChemo = (context.chemoRegional && context.chemoRegional[ti]) || 0;

    if (wd > 0.3) {
        groundCover = 0;
        chemoCrust = 0;
    } else if (wd > 0.1) {
        groundCover = regGC * 0.3;
        chemoCrust = regChemo * 0.2;
    } else {
        groundCover = regGC * 0.6;
        chemoCrust = regChemo * 0.5;
    }

    return {
        floraType,
        floraDensity: Math.max(groundCover, chemoCrust),
        groundCover,
        canopy: 0,
        chemoCrust
    };
  }
  if (temp < 0.5) {
    return { floraType: 'frozen', floraDensity: 0, groundCover: 0, canopy: 0, chemoCrust: 0 };
  }

  const ftNames = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic'];
  let floraType = ftNames[context.floraTypeInt] || 'barren';

  const regGC     = (context.gcRegional     && context.gcRegional[ti])     || 0;
  const regCanopy = (context.canopyRegional && context.canopyRegional[ti]) || 0;
  const regChemo  = (context.chemoRegional  && context.chemoRegional[ti])  || 0;
  const regDens   = (context.densRegional   && context.densRegional[ti])   || Math.max(regGC, regCanopy);

  // Local nudge from wetness relative to a neutral mid-saturation.
  const localBoost = clamp((physical.saturation - 0.4) * 0.3, -0.15, 0.20);

  // Canopy comes directly from the discrete tree placement — no local boost.
  // The regional value was the density TARGET; the tree placement is the RESULT.
  // Ground cover (mat) still grows between trees, on trunks, everywhere there's
  // stable substrate — trees don't suppress mat.
  let groundCover = clamp(regGC + localBoost, 0, 1);
  let canopy      = regCanopy;  // already 0.7 (tree), 0.25 (fringe), or 0.0 (gap)
  let chemoCrust  = regChemo;
  let density     = clamp(regDens + localBoost, 0, 1);

  if (floraType === 'barren') {
    // Barren regions still get sparse local ground cover where it's wet.
    groundCover = clamp(Math.max(groundCover, physical.saturation * 0.2), 0, 1);
    canopy = 0; chemoCrust = 0; density = clamp(groundCover, 0, 1);
  }

  return { floraType, floraDensity: density, groundCover, canopy, chemoCrust };
}

// ── T6: Terrain type derivation ──
function deriveTileTerrainType(physical, flora, zone, elev) {
  // Water / ice guards; everything else routes through deriveTerrainAndCover.
  if (physical.hasWater && physical.waterDepth >= SHALLOW_WATER_TERRAIN_THRESHOLD) return { terrainType: 'water', coverType: 'none' };
  if (flora.floraType === 'frozen') return { terrainType: 'rock', coverType: 'none' };

  const isCoastal = elev > 0 && elev < 0.03;
  return deriveTerrainAndCover(
    elev,
    elev > 0,
    physical.grainSize,
    physical.saturation,
    flora.groundCover,
    flora.canopy,            // tile flora stores canopy as `canopy`
    flora.chemoCrust,
    flora.floraType,
    physical.waterTableDepth,
    isCoastal
  );
}

// ── T4: Discrete tree placement (Poisson disk) ──
// Tuning constants
const TREE_MIN_DIST_PHOTO = 5;    // min tiles between photosynthetic fern-trees
const TREE_MIN_DIST_CHEMO = 3;    // min tiles between chemotrophic colony mounds
const TREE_MIN_DIST_MIXO = 4;     // min tiles between mixotrophic growth
const TREE_CANOPY_VALUE = 0.7;    // canopy density assigned to tree tiles
const TREE_FRINGE_VALUE = 0.25;   // canopy density for tiles adjacent to trees
const TREE_MAX_PER_CHUNK = 12000; // safety cap
const TREE_MAX_GRAIN = 0.7;       // no trees on substrate coarser than this
const TREE_MAX_SAT = 0.95;        // no trees in fully waterlogged ground

function placeTreeCover(context, tileElevation, waterBodies, seed) {
    const canopyOut = new Float32Array(CHUNK_TOTAL);

    // ── Density target from regional inheritance ──
    let totalCanopy = 0;
    for (let i = 0; i < CHUNK_TOTAL; i++) {
        totalCanopy += (context.canopyRegional[i] || 0);
    }
    const avgCanopy = totalCanopy / CHUNK_TOTAL;

    // No trees needed if canopy target is negligible
    if (avgCanopy < 0.02) return canopyOut;

    // ── Placement parameters ──
    const floraTypeInt = context.floraTypeInt || 0;
    let minDist;
    if (floraTypeInt === 2) {
        minDist = TREE_MIN_DIST_CHEMO;
    } else if (floraTypeInt === 3) {
        minDist = TREE_MIN_DIST_MIXO;
    } else {
        minDist = TREE_MIN_DIST_PHOTO;
    }

    // How many trees to reach the target canopy fraction?
    const numTrees = Math.round(avgCanopy * CHUNK_TOTAL);
    const maxPossible = Math.floor(CHUNK_TOTAL / (minDist * minDist * 0.8));
    const targetTrees = Math.min(numTrees, maxPossible, TREE_MAX_PER_CHUNK);

    // ── Poisson disk placement (rejection sampling with grid acceleration) ──
    const cellSize = minDist;
    const gridW = Math.ceil(CHUNK_W / cellSize);
    const gridH = Math.ceil(CHUNK_H / cellSize);
    const grid = new Int32Array(gridW * gridH).fill(-1);
    const treeX = [];
    const treeY = [];

    // Deterministic RNG from world coordinates
    const treeRng = mulberry32(seed ^ hashInt(context.worldX || 0, context.worldY || 0, 0x54524545));

    const maxAttempts = targetTrees * 25;
    let attempts = 0;

    while (treeX.length < targetTrees && attempts < maxAttempts) {
        attempts++;
        const tx = Math.floor(treeRng() * CHUNK_W);
        const ty = Math.floor(treeRng() * CHUNK_H);
        const ti = ty * CHUNK_W + tx;

        // ── Physical placement constraints ──
        if (waterBodies.hasWater[ti]) continue;
        if (tileElevation[ti] <= 0) continue;
        if ((context.grainSizeRegional[ti] || 0.3) > TREE_MAX_GRAIN) continue;
        if ((context.satRegional[ti] || 0) > TREE_MAX_SAT) continue;

        // ── Spacing check (grid-accelerated) ──
        const gx = Math.floor(tx / cellSize);
        const gy = Math.floor(ty / cellSize);
        let tooClose = false;

        for (let dy = -2; dy <= 2 && !tooClose; dy++) {
            for (let dx = -2; dx <= 2 && !tooClose; dx++) {
                const ngx = gx + dx, ngy = gy + dy;
                if (ngx < 0 || ngx >= gridW || ngy < 0 || ngy >= gridH) continue;
                const ni = ngy * gridW + ngx;
                if (grid[ni] >= 0) {
                    const ox = treeX[grid[ni]], oy = treeY[grid[ni]];
                    if ((tx - ox) * (tx - ox) + (ty - oy) * (ty - oy) < minDist * minDist) {
                        tooClose = true;
                    }
                }
            }
        }
        if (tooClose) continue;

        // ── Place tree ──
        const treeIdx = treeX.length;
        treeX.push(tx);
        treeY.push(ty);
        grid[gy * gridW + gx] = treeIdx;

        canopyOut[ti] = TREE_CANOPY_VALUE;
    }

    // ── Fringe pass: tiles adjacent to trees get sparse canopy ──
    const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
    const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

    for (let t = 0; t < treeX.length; t++) {
        const cx = treeX[t], cy = treeY[t];
        for (let d = 0; d < 8; d++) {
            const nx = cx + dx8[d], ny = cy + dy8[d];
            if (nx < 0 || nx >= CHUNK_W || ny < 0 || ny >= CHUNK_H) continue;
            const ni = ny * CHUNK_W + nx;
            if (canopyOut[ni] < 0.1) {
                canopyOut[ni] = TREE_FRINGE_VALUE;
            }
        }
    }

    return canopyOut;
}

// ── T7: Tie it together ──
function generateTileDetail(rx, ry) {
  if (!state.regionalCells || !state.regionalCells[rx] || !state.regionalCells[rx][ry]) return;

  const seed = parseInt(document.getElementById('seedInput').value, 10) || 0;

  // T1: context
  const context = sampleRegionalContext(rx, ry);
  context.worldX = rx * CHUNK_W;
  context.worldY = ry * CHUNK_H;
  context.seed = seed;

  // T2: topography
  const tileElevation = generateTileTopography(context);

  // T3: drainage
  const drainage = computeTileDrainage(tileElevation, context.precipitation, CHUNK_W, CHUNK_H);
  const streamOrder = drainage.streamOrder;

  // T3.5: Water body detection (coherent spatial features, not per-tile noise)
  const waterBodies = computeTileWaterBodies(tileElevation, streamOrder, context, context.zone);

  // T4: Discrete tree placement — replaces uniform canopy with positioned trees
  const treeCanopy = placeTreeCover(context, tileElevation, waterBodies, seed);
  // Overwrite regional canopy with discrete placement results (Option B)
  for (let i = 0; i < CHUNK_TOTAL; i++) {
    context.canopyRegional[i] = treeCanopy[i];
  }

  // Typed-array store
  const tiles = {
    elevation:      tileElevation,
    terrainType:    new Uint8Array(CHUNK_TOTAL),
    coverType:      new Uint8Array(CHUNK_TOTAL),
    streamOrder:    streamOrder,
    grainSize:      new Float32Array(CHUNK_TOTAL),
    saturation:     new Float32Array(CHUNK_TOTAL),
    waterTableDepth:new Float32Array(CHUNK_TOTAL),
    hasWater:       new Uint8Array(CHUNK_TOTAL),
    waterDepth:     new Float32Array(CHUNK_TOTAL),
    floraType:      new Uint8Array(CHUNK_TOTAL),
    floraDensity:   new Float32Array(CHUNK_TOTAL),
    groundCover:    new Float32Array(CHUNK_TOTAL),
    canopy:         new Float32Array(CHUNK_TOTAL),
    chemoCrust:     new Float32Array(CHUNK_TOTAL),
    groundVariant:  new Uint8Array(CHUNK_TOTAL),
    coverVariant:   new Uint8Array(CHUNK_TOTAL),
    iron:           context.iron,
    copper:         context.copper,
    manganese:      context.manganese,
    organicContent: context.organicRegional,
    precipitation:  context.precipitation,
    groundwater:    context.groundwater,
    temperature:    context.temperature,
  };

  const zone = context.zone;
  const floraTypeInt = { barren: 0, photosynthetic: 1, chemotrophic: 2, mixotrophic: 3, none: 0, frozen: 0 };

  for (let ti = 0; ti < CHUNK_TOTAL; ti++) {
    const elev = tileElevation[ti];

    if (elev <= 0) {
      // Ocean tile — classify shallow vs deep based on actual water depth
      const waterDepth = -elev;
      const isDeep = waterDepth > 0.25;  // bottom not visible past 25cm

      tiles.terrainType[ti] = isDeep ? TT_DEEP_WATER : TT_WATER;
      tiles.coverType[ti] = CT_NONE;
      tiles.hasWater[ti] = 1;
      tiles.saturation[ti] = 1;
      tiles.waterDepth[ti] = waterDepth;
      tiles.grainSize[ti] = context.grainSizeRegional ? (context.grainSizeRegional[ti] || 0.2) : 0.2;
      tiles.floraType[ti] = 0;
      tiles.groundCover[ti] = 0;
      tiles.canopy[ti] = 0;
      tiles.floraDensity[ti] = 0;

      const terrainName = isDeep ? 'deep_water' : 'water';
      const oceanVariants = selectSpriteVariant(terrainName, 'none',
        { saturation: 1, groundCover: 0, grainSize: tiles.grainSize[ti],
          waterDepth: waterDepth, canopyDensity: 0, streamOrder: 0, organicContent: 0 },
        context.worldX + (ti % CHUNK_W), context.worldY + Math.floor(ti / CHUNK_W));
      tiles.groundVariant[ti] = oceanVariants.ground;
      tiles.coverVariant[ti] = oceanVariants.cover;
      continue;
    }

    const physical = computeTilePhysicalState(ti, tileElevation, streamOrder[ti], context, zone, waterBodies.hasWater[ti], waterBodies.waterDepth[ti], waterBodies.satBoost[ti]);
    const flora = computeTileFlora(ti, physical, context);
    const derived = deriveTileTerrainType(physical, flora, zone, elev);

    tiles.grainSize[ti]       = physical.grainSize;
    tiles.saturation[ti]      = physical.saturation;
    tiles.waterTableDepth[ti] = physical.waterTableDepth;
    tiles.hasWater[ti]        = physical.hasWater ? 1 : 0;
    tiles.waterDepth[ti]      = physical.waterDepth;
    tiles.floraDensity[ti]    = flora.floraDensity;
    tiles.groundCover[ti]     = flora.groundCover;
    tiles.canopy[ti]          = flora.canopy;
    tiles.chemoCrust[ti]      = flora.chemoCrust;
    tiles.floraType[ti]       = floraTypeInt[flora.floraType] || 0;

    // The derived terrain type already handles the water depth threshold.
    // No per-tile override needed — deriveTileTerrainType returns 'water' only
    // when waterDepth >= SHALLOW_WATER_TERRAIN_THRESHOLD.
    let ttInt = terrainTypeToInt(derived.terrainType);
    tiles.terrainType[ti] = ttInt;
    tiles.coverType[ti]   = coverTypeToInt(derived.coverType);

    // Variant selection from physical state
    const variantTerrainName = (physical.hasWater && physical.waterDepth >= SHALLOW_WATER_TERRAIN_THRESHOLD) ? 'water' : derived.terrainType;
    const variantPhysical = {
        saturation: physical.saturation,
        groundCover: flora.groundCover,
        grainSize: physical.grainSize,
        waterDepth: physical.waterDepth,
        canopyDensity: flora.canopy,
        streamOrder: streamOrder[ti],
        organicContent: context.organicRegional ? (context.organicRegional[ti] || 0) : 0,
    };
    const variants = selectSpriteVariant(
        variantTerrainName,
        derived.coverType,
        variantPhysical,
        context.worldX + (ti % CHUNK_W),
        context.worldY + Math.floor(ti / CHUNK_W)
    );
    tiles.groundVariant[ti] = variants.ground;
    tiles.coverVariant[ti] = variants.cover;
  }

  state.currentTileData = { tiles, rx, ry, zone, context };
  state.tileChunkCache.set(`${rx},${ry}`, state.currentTileData);

  renderTileDetail(document.getElementById('tileOverlaySelect').value);
  printTileDiagnostic(tiles);
}

function printTileDiagnostic(tiles) {
  const terrainCounts = {};
  const coverCounts = {};
  const variantCounts = {};  // keyed by "terrainName:variantIndex"
  let land = 0, water = 0, forested = 0;
  for (let i = 0; i < CHUNK_TOTAL; i++) {
    const tName = intToTerrainType(tiles.terrainType[i]);
    terrainCounts[tName] = (terrainCounts[tName] || 0) + 1;
    const cName = intToCoverType(tiles.coverType[i]);
    coverCounts[cName] = (coverCounts[cName] || 0) + 1;
    if (tiles.elevation[i] > 0) land++; else water++;
    if (tiles.coverType[i] !== CT_NONE) forested++;
    const vKey = `${tName}:v${tiles.groundVariant[i]}`;
    variantCounts[vKey] = (variantCounts[vKey] || 0) + 1;
  }
  console.log('=== TILE DIAGNOSTIC ===');
  console.log('Land:', land, 'Water:', water, 'Forested:', forested,
    `(${(forested / CHUNK_TOTAL * 100).toFixed(1)}%)`);
  const tSummary = Object.keys(terrainCounts)
    .map(k => `${k}=${(terrainCounts[k] / CHUNK_TOTAL * 100).toFixed(1)}%`)
    .join('  ');
  console.log('Terrain types: ' + tSummary);
  const cSummary = Object.keys(coverCounts)
    .map(k => `${k}=${(coverCounts[k] / CHUNK_TOTAL * 100).toFixed(1)}%`)
    .join('  ');
  console.log('Cover types: ' + cSummary);
  const vSummary = Object.keys(variantCounts).sort()
    .map(k => `${k}=${variantCounts[k]}`)
    .join('  ');
  console.log('Ground variants: ' + vSummary);
  console.log('=== END TILE DIAGNOSTIC ===');
}

function openTileView(rx, ry) {
  if (!state.regionalCells || !state.regionalCells[rx] || !state.regionalCells[rx][ry]) return;
  const rc = state.regionalCells[rx][ry];
  const container = document.getElementById('tileDetailContainer');
  container.style.display = 'block';
  document.getElementById('tileDetailTitle').textContent =
    `TILES: (${rx}, ${ry}) — ${rc.zone} ${rc.terrainType || ''}`;
  document.getElementById("statusText").textContent = 'Generating tile chunk…';
  setTimeout(() => {
    const cacheKey = `${rx},${ry}`;
    const cached = state.tileChunkCache.get(cacheKey);
    if (cached) {
      state.currentTileData = cached;
      renderTileDetail(document.getElementById('tileOverlaySelect').value);
      document.getElementById("statusText").textContent = 'Tile loaded from cache';
    } else {
      const t0 = performance.now();
      generateTileDetail(rx, ry);
      const t1 = performance.now();
      document.getElementById("statusText").textContent = `Tile chunk generated in ${(t1 - t0).toFixed(0)} ms`;
    }
    // Draw the position marker on the regional map
    renderRegionalMap(document.getElementById("regionalOverlaySelect").value);
  }, 10);
}

function hideTileView() {
  const container = document.getElementById('tileDetailContainer');
  if (container) container.style.display = 'none';
  state.currentTileData = null;
  if (document.getElementById("tileTooltip")) document.getElementById("tileTooltip").style.display = 'none';
  // Redraw regional map to remove the position marker
  if (state.regionalCells) renderRegionalMap(document.getElementById("regionalOverlaySelect").value);
}

export {
  generateTileDetail, openTileView, hideTileView,
  CHUNK_W, CHUNK_H, CHUNK_TOTAL,
  selectSpriteVariant, positionHash, printTileDiagnostic
};
