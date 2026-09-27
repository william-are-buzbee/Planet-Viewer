// ══════════════════════════════════════════════════════════════════
// ── planet-grid.js — the planetary grid as struct-of-arrays ──
//    One typed array per field over W×H cells, index i = y * W + x. The
//    continuous fields are Float64Array on purpose: the planetary pipeline was
//    tuned with double precision and seed 5 is the anchor, so the layout change
//    must not move a single bit. Enums replace the old strings. Low-frequency
//    readers (snapshot panel, tools) use cell(i) for a named-field object.
// ══════════════════════════════════════════════════════════════════

import { W, H, TOTAL } from './core-math.js';
import { intToTerrainType, intToCoverType } from './terrain-derive.js';
import { FLORA_NAMES } from './regional-grid.js';

export const PLATE_OCEANIC = 0, PLATE_CONTINENTAL = 1;
export const PLATE_TYPE_NAMES = ['oceanic', 'continental'];

export const BT_NONE = 0, BT_COLLISION = 1, BT_SUBDUCTION = 2, BT_RIFT = 3, BT_SPREADING = 4, BT_TRANSFORM = 5;
export const BOUNDARY_NAMES = [null, 'collision', 'subduction', 'rift', 'spreading', 'transform'];

export class PlanetGrid {
  constructor() {
    const f64 = () => new Float64Array(TOTAL);
    const u8  = () => new Uint8Array(TOTAL);
    this.W = W; this.H = H; this.N = TOTAL;

    // Plates (step 1)
    this.plateId          = new Uint16Array(TOTAL);
    this.plateType        = u8();
    this.nearestDist      = f64();
    this.secondPlateId    = new Uint16Array(TOTAL);
    this.secondDist       = f64().fill(Infinity);
    this.boundaryType     = u8();
    this.boundaryStrength = f64();
    this.boundaryDistance = new Int16Array(TOTAL).fill(999);

    // Elevation (step 2)
    this.elevation      = f64();
    this.isLand         = u8();
    this.isShallowWater = u8();
    this.isDeepWater    = u8().fill(1);
    this.blend          = f64().fill(0.5);
    this.convergence    = f64();

    // Minerals (step 3)
    this.iron         = f64();
    this.copper       = f64();
    this.manganese    = f64();
    this.mineralTotal = f64();
    this.volcanism    = f64();

    // Atmosphere / hydrology (step 4)
    this.temperature         = f64().fill(0.7);
    this.isFreezing          = u8();
    this.windU               = f64();
    this.windV               = f64();
    this.windSpeed           = f64();
    this.currentU            = f64();
    this.currentV            = f64();
    this.currentSpeed        = f64();
    this.sst                 = f64().fill(0.7);
    this.precipitation       = f64();
    this.atmosphericMoisture = f64();
    this.groundwater         = f64();
    this.drainage            = f64();
    this.waterAvailability   = f64();

    // Flora / terrain (steps 5, 5b) — enums from regional-grid.js / terrain-derive.js
    this.floraType    = u8().fill(4);   // FT_NONE
    this.floraDensity = f64();
    this.terrainType  = u8();
    this.coverType    = u8();
  }

  get length() { return this.N; }
  *all() { for (let i = 0; i < this.N; i++) yield this.cell(i); }
  x(i) { return i % W; }
  y(i) { return (i / W) | 0; }

  // Named-field view of one cell (a few calls per click, not per pixel)
  cell(i) {
    return {
      x: i % W, y: (i / W) | 0,
      plateId: this.plateId[i], plateType: PLATE_TYPE_NAMES[this.plateType[i]],
      nearestDist: this.nearestDist[i], secondPlateId: this.secondPlateId[i], secondDist: this.secondDist[i],
      boundaryType: BOUNDARY_NAMES[this.boundaryType[i]], boundaryStrength: this.boundaryStrength[i],
      boundaryDistance: this.boundaryDistance[i],
      elevation: this.elevation[i], isLand: !!this.isLand[i], isShallowWater: !!this.isShallowWater[i],
      isDeepWater: !!this.isDeepWater[i], blend: this.blend[i], convergence: this.convergence[i],
      minerals: { iron: this.iron[i], copper: this.copper[i], manganese: this.manganese[i] },
      mineralTotal: this.mineralTotal[i], volcanism: this.volcanism[i],
      temperature: this.temperature[i], isFreezing: !!this.isFreezing[i],
      windU: this.windU[i], windV: this.windV[i], windSpeed: this.windSpeed[i],
      currentU: this.currentU[i], currentV: this.currentV[i], currentSpeed: this.currentSpeed[i],
      sst: this.sst[i], precipitation: this.precipitation[i], atmosphericMoisture: this.atmosphericMoisture[i],
      groundwater: this.groundwater[i], drainage: this.drainage[i], waterAvailability: this.waterAvailability[i],
      floraType: FLORA_NAMES[this.floraType[i]], floraDensity: this.floraDensity[i],
      terrainType: intToTerrainType(this.terrainType[i]), coverType: intToCoverType(this.coverType[i]),
    };
  }
}
