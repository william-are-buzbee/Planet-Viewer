// ══════════════════════════════════════════════════════════════════
// ── regional-grid.js — the regional window as struct-of-arrays ──
//    One typed array per field, row-major (i = ry * S + rx), the same layout
//    hiResData and the tile chunk already use. ~150 bytes per cell instead of
//    ~850 for the old object-per-cell grid (221 MB → ~40 MB per region).
//    Hot paths index the arrays directly; low-frequency readers (snapshot
//    panel, tile titles, tools) call cell(rx, ry) for a named-field object.
// ══════════════════════════════════════════════════════════════════

import { intToTerrainType, intToCoverType } from './terrain-derive.js';

// Zone enum (was a string per cell)
export const ZONE_TIDAL = 0, ZONE_COASTAL = 1, ZONE_LOWLAND = 2,
             ZONE_MID_SLOPE = 3, ZONE_UPPER_SLOPE = 4, ZONE_SUMMIT = 5;
export const ZONE_NAMES = ['tidal', 'coastal', 'lowland', 'mid_slope', 'upper_slope', 'summit'];

// Flora type enum: 0–3 match the hi-res grid; 4 and 5 are regional-only states.
export const FT_BARREN = 0, FT_PHOTO = 1, FT_CHEMO = 2, FT_MIXO = 3, FT_NONE = 4, FT_FROZEN = 5;
export const FLORA_NAMES = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic', 'none', 'frozen'];

// D8 neighbour order shared by the regional and tile drainage passes
export const D8X = [-1, 0, 1, -1, 1, -1, 0, 1];
export const D8Y = [-1, -1, -1, 0, 0, 1, 1, 1];

export class RegionalGrid {
  constructor(size, originWorldX, originWorldY) {
    const N = size * size;
    this.S = size;
    this.N = N;
    this.inflowTotalKm2 = 0;   // water injected at the border by regional-gen (km²·precip)
    // World-space (regional-cell units) coordinate of cell (0, 0)
    this.originWorldX = originWorldX;
    this.originWorldY = originWorldY;

    const f32 = () => new Float32Array(N);
    const u8  = () => new Uint8Array(N);

    // Elevation (metres) and land/water flags
    this.elevation      = f32();
    this.isLand         = u8();
    this.isShallowWater = u8();
    this.isDeepWater    = u8();
    this.isFreezing     = u8();

    // Sampled from the hi-res / planetary grids
    this.precipitation     = f32();
    this.groundwater       = f32();
    this.waterAvailability = f32();
    this.temperature       = f32();
    this.volcanism         = f32();
    this.iron              = f32();
    this.copper            = f32();
    this.manganese         = f32();
    this.mineralTotal      = f32();

    // Hi-res base values the refinement passes start from
    this.hrGrainSize       = f32();
    this.hrSaturation      = f32();
    this.hrGroundCover     = f32();
    this.hrChemoCrust      = f32();
    this.hrWaterTableDepth = f32();
    this.hrFloraType       = u8();

    // Pass 2: slope + zone
    this.slopeMag = f32();
    this.slopeDir = f32();
    this.zone     = u8();

    // Pass 3: drainage (flowAccum in km²·precip; flowDir = D8 index of the receiving neighbour, 255 = none)
    this.flowAccum       = f32();
    this.flowDir         = u8();
    this.drainageDensity = f32();
    this.streamOrder     = u8();

    // Pass 4: substrate
    this.grainSize       = f32();
    this.saturation      = f32();
    this.waterTableDepth = f32();

    // Pass 5a: flora
    this.floraType      = u8();
    this.floraDensity   = f32();
    this.canopy         = f32();
    this.groundCover    = f32();
    this.chemoCrust     = f32();
    this.organicContent = f32();
    this.pelaConf       = f32();
    this.kolmConf       = f32();

    // Pass 5b: water state
    this.waterDepth = f32();
    this.hasWater   = u8();
    this.wetness    = f32();
    this.pelaRaft   = f32();
    this.kolmRelict = f32();
    this.baseCanopy = f32();

    // Pass 5c: terrain
    this.terrainType = u8();
    this.coverType   = u8();
  }

  idx(rx, ry) { return ry * this.S + rx; }
  inBounds(rx, ry) { return rx >= 0 && rx < this.S && ry >= 0 && ry < this.S; }
  wx(i) { return this.originWorldX + (i % this.S); }
  wy(i) { return this.originWorldY + ((i / this.S) | 0); }

  // Named-field view of one cell, for readers that run a few times per click.
  cell(rx, ry) {
    if (!this.inBounds(rx, ry)) return null;
    const i = this.idx(rx, ry);
    return {
      rx, ry,
      worldX: this.wx(i), worldY: this.wy(i),
      elevation: this.elevation[i], baseElevation: this.elevation[i],
      isLand: !!this.isLand[i], isShallowWater: !!this.isShallowWater[i],
      isDeepWater: !!this.isDeepWater[i], isFreezing: !!this.isFreezing[i],
      precipitation: this.precipitation[i], groundwater: this.groundwater[i],
      waterAvailability: this.waterAvailability[i], temperature: this.temperature[i],
      volcanism: this.volcanism[i],
      minerals: { iron: this.iron[i], copper: this.copper[i], manganese: this.manganese[i] },
      mineralTotal: this.mineralTotal[i],
      slopeMag: this.slopeMag[i], slopeDir: this.slopeDir[i], zone: ZONE_NAMES[this.zone[i]],
      flowAccum: this.flowAccum[i], flowDir: this.flowDir[i], drainageDensity: this.drainageDensity[i], streamOrder: this.streamOrder[i],
      grainSize: this.grainSize[i], saturation: this.saturation[i], waterTableDepth: this.waterTableDepth[i],
      floraType: FLORA_NAMES[this.floraType[i]], floraDensity: this.floraDensity[i],
      canopy: this.canopy[i], groundCover: this.groundCover[i], chemoCrust: this.chemoCrust[i],
      organicContent: this.organicContent[i], pelaConf: this.pelaConf[i], kolmConf: this.kolmConf[i],
      waterDepth: this.waterDepth[i], hasWater: !!this.hasWater[i], wetness: this.wetness[i],
      pelaRaft: this.pelaRaft[i], kolmRelict: this.kolmRelict[i], baseCanopy: this.baseCanopy[i],
      terrainType: intToTerrainType(this.terrainType[i]), coverType: intToCoverType(this.coverType[i]),
    };
  }
}
