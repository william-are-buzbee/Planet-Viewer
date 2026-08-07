// ══════════════════════════════════════════════════════════════════
// ── planet-gen.js — Planetary generation pipeline (steps 1-5b) ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import { W, H, TOTAL, mulberry32, clamp } from './core-math.js';
import { deriveTerrainAndCover } from './terrain-derive.js';
import { step1_generatePlates, step1b_generateGeoSeeds, step2_computeElevation, step3_computeMinerals } from './planet-geology.js';
import { step4_computeAtmosphere } from './planet-atmosphere.js';

// ── Generation pipeline ──
function generatePlanet(seed) {
  const rng = mulberry32(seed);
  state.cells = new Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    state.cells[i] = {
      x: i % W,
      y: (i / W) | 0,
      plateId: 0,
      plateType: 'oceanic',
      nearestDist: 0,
      secondPlateId: 0,
      secondDist: Infinity,
      boundaryType: null,
      boundaryStrength: 0,
      boundaryDistance: 999,
      elevation: 0,
      isLand: false,
      isShallowWater: false,
      isDeepWater: true,
      minerals: { iron: 0, copper: 0, manganese: 0 },
      mineralTotal: 0,
      isDepleted: true,
      dominant: 'iron',
      volcanism: 0,
      proximity: 0,
      blend: 0.5,
      convergence: 0,
      moisture: 0,
      baseMoisture: 0,
      temperature: 0.7,
      isFreezing: false,
      wind: { direction: 0, speed: 1 },
      windU: 0,
      windV: 0,
      windSpeed: 0,
      currentU: 0,
      currentV: 0,
      currentSpeed: 0,
      sst: 0.7,
      precipitation: 0,
      atmosphericMoisture: 0,
      groundwater: 0,
      drainage: 0,
      waterAvailability: 0,
      floraType: 'none',
      floraDensity: 0,
    };
  }

  // Step 1: Plates
  step1_generatePlates(seed, rng);
  // Step 1b: Generate geological seed points (mountains, arcs, rifts)
  step1b_generateGeoSeeds(seed, rng);
  // Step 2: Elevation
  step2_computeElevation(seed, rng);
  // Step 3: Minerals
  step3_computeMinerals(seed, rng);
  // Step 4: Atmosphere
  step4_computeAtmosphere(seed, rng);
  // Step 5: Flora
  step5_computeFlora();
  // Step 5b: Terrain + cover type (via the canonical deriveTerrainAndCover)
  step5b_deriveTerrainType();
  // Diagnostic
  printWeatherDiagnostic();
  printPrecipDiagnostic();
}

// ── Step 5: Flora ──
function step5_computeFlora() {
  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    if (!c.isLand) {
      c.floraType = 'none';
      c.floraDensity = 0;
      continue;
    }
    if (c.isFreezing) {
      c.floraType = 'frozen';
      c.floraDensity = 0;
      continue;
    }

    const light = 1.0;
    const water = c.waterAvailability;
    const photoFitness = light * water * 0.8;
    const chemoFitness = c.mineralTotal * Math.max(water, c.volcanism * 1.5) * 1.2; // R1-FIX3: unified chemo secondary factor (volcanism, not groundwater)
    const mixoFitness  = (0.6 + 0.5 * c.mineralTotal) * water;
    const maxFitness = Math.max(photoFitness, chemoFitness, mixoFitness);

    if (maxFitness < 0.02) {
      c.floraType = 'barren';
      c.floraDensity = 0;
    } else if (photoFitness >= chemoFitness && photoFitness >= mixoFitness) {
      c.floraType = 'photosynthetic';
      c.floraDensity = clamp(maxFitness, 0, 1);
    } else if (chemoFitness >= photoFitness && chemoFitness >= mixoFitness) {
      c.floraType = 'chemotrophic';
      c.floraDensity = clamp(maxFitness, 0, 1);
    } else {
      c.floraType = 'mixotrophic';
      c.floraDensity = clamp(maxFitness, 0, 1);
    }
  }
}

// ── Step 5b: Terrain + cover for the low-res planetary grid ──
// Routes through THE canonical deriveTerrainAndCover so the planetary map
// classifies terrain identically to the regional / high-res / tile views.
// The low-res grid doesn't compute the detailed substrate/flora fields those
// grids have, so they're ESTIMATED here from the planetary sim's own fields.
// The same estimates are stashed on the cell so the surface overlay's
// computeTilePalette call sees the exact inputs the derivation used.
function step5b_deriveTerrainType() {
  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];

    if (!c.isLand) {
      c.terrainType = c.isDeepWater ? 'deep_water' : 'water';
      c.coverType = 'none';
      continue;
    }
    if (c.isFreezing) {
      c.terrainType = 'rock';
      c.coverType = 'none';
      continue;
    }

    // Estimate the physical fields the low-res grid lacks so the canonical
    // function sees inputs comparable to the high-res grid's.
    const grainSize     = clamp(0.25 + c.elevation * 0.6, 0.05, 0.95);
    const saturation    = clamp(c.waterAvailability || 0, 0, 1);
    const groundCover   = c.floraDensity > 0 ? c.floraDensity * 0.6 : 0; // R1-FIX5: removed 0.3 floor, reduced multiplier to match hi-res pipeline
    const canopyDensity = c.floraDensity > 0.2 ? c.floraDensity * 0.7 : 0;
    const chemoCrust    = c.floraType === 'chemotrophic' ? clamp(c.floraDensity * 0.5, 0, 1) : 0;
    const waterTableDepth = clamp((1 - saturation) * (0.3 + c.elevation * 2), 0, 1);
    const isCoastal     = c.elevation > 0 && c.elevation < 0.03;

    const result = deriveTerrainAndCover(
      c.elevation,
      c.isLand,
      grainSize,
      saturation,
      groundCover,
      canopyDensity,
      chemoCrust,
      c.floraType,
      waterTableDepth,
      isCoastal
    );

    c.terrainType = result.terrainType;
    c.coverType   = result.coverType;
    c._estGrainSize   = grainSize;
    c._estSaturation  = saturation;
    c._estGroundCover = groundCover;
    c._estCanopy      = canopyDensity;
    c._estChemoCrust  = chemoCrust;
  }
}

// ── Weather Diagnostic ──
function printWeatherDiagnostic() {
  const bands = [
    { name: 'Polar N (70-90)',       yMin: 0,   yMax: Math.floor(H * 0.11) },
    { name: 'Subpolar N (55-70)',    yMin: Math.floor(H * 0.11), yMax: Math.floor(H * 0.19) },
    { name: 'Westerly N (35-55)',    yMin: Math.floor(H * 0.19), yMax: Math.floor(H * 0.31) },
    { name: 'Subtropical N (28-35)', yMin: Math.floor(H * 0.31), yMax: Math.floor(H * 0.36) },
    { name: 'Trade N (8-28)',        yMin: Math.floor(H * 0.36), yMax: Math.floor(H * 0.46) },
    { name: 'ITCZ (0-8)',           yMin: Math.floor(H * 0.46), yMax: Math.floor(H * 0.54) },
    { name: 'Trade S (8-28)',        yMin: Math.floor(H * 0.54), yMax: Math.floor(H * 0.64) },
    { name: 'Subtropical S (28-35)', yMin: Math.floor(H * 0.64), yMax: Math.floor(H * 0.69) },
    { name: 'Westerly S (35-55)',    yMin: Math.floor(H * 0.69), yMax: Math.floor(H * 0.81) },
    { name: 'Subpolar S (55-70)',    yMin: Math.floor(H * 0.81), yMax: Math.floor(H * 0.89) },
    { name: 'Polar S (70-90)',       yMin: Math.floor(H * 0.89), yMax: H },
  ];

  console.log('=== WEATHER DIAGNOSTIC ===');

  for (const band of bands) {
    const bandCells = [];
    for (let y = band.yMin; y < band.yMax; y++) {
      for (let x = 0; x < W; x++) {
        bandCells.push(state.cells[y * W + x]);
      }
    }

    const ocean = bandCells.filter(c => !c.isLand);
    const land = bandCells.filter(c => c.isLand);

    const avg = (arr, fn) => arr.length ? arr.reduce((s, c) => s + fn(c), 0) / arr.length : 0;

    const windSpd = avg(bandCells, c => c.windSpeed || 0);
    const windU = avg(bandCells, c => c.windU || 0);
    const windV = avg(bandCells, c => c.windV || 0);
    const sst = avg(ocean, c => c.sst || 0);
    const oceanMoist = avg(ocean, c => c.atmosphericMoisture || 0);
    const landMoist = avg(land, c => c.atmosphericMoisture || 0);
    const precip = avg(land, c => c.precipitation || 0);
    const gw = avg(land, c => c.groundwater || 0);
    const drain = avg(land, c => c.drainage || 0);
    const wa = avg(land, c => c.waterAvailability || 0);

    console.log(
      `${band.name.padEnd(25)} | wind: u=${windU.toFixed(3)} v=${windV.toFixed(3)} spd=${windSpd.toFixed(3)} | sst=${sst.toFixed(3)} | oceanMoist=${oceanMoist.toFixed(4)} landMoist=${landMoist.toFixed(4)} | precip=${precip.toFixed(4)} gw=${gw.toFixed(3)} drain=${drain.toFixed(4)} wa=${wa.toFixed(3)} | land=${land.length} ocean=${ocean.length}`
    );
  }

  const landCells = state.cells.filter(c => c.isLand);
  const oceanCells = state.cells.filter(c => !c.isLand);

  const stat = (arr, fn) => {
    if (!arr.length) return { min: 0, max: 0, mean: 0 };
    let min = Infinity, max = -Infinity, sum = 0;
    for (const c of arr) {
      const v = fn(c);
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, mean: sum / arr.length };
  };

  console.log('\n=== GLOBAL STATS (land cells) ===');
  const fields = [
    ['precipitation', c => c.precipitation || 0],
    ['groundwater', c => c.groundwater || 0],
    ['drainage', c => c.drainage || 0],
    ['waterAvailability', c => c.waterAvailability || 0],
    ['atmosphericMoisture', c => c.atmosphericMoisture || 0],
    ['windSpeed', c => c.windSpeed || 0],
  ];

  for (const [name, fn] of fields) {
    const s = stat(landCells, fn);
    console.log(`  ${name.padEnd(22)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)} mean=${s.mean.toFixed(4)}`);
  }

  console.log('\n=== GLOBAL STATS (ocean cells) ===');
  const oceanFields = [
    ['sst', c => c.sst || 0],
    ['atmosphericMoisture', c => c.atmosphericMoisture || 0],
    ['windSpeed', c => c.windSpeed || 0],
    ['currentSpeed', c => c.currentSpeed || 0],
  ];

  for (const [name, fn] of oceanFields) {
    const s = stat(oceanCells, fn);
    console.log(`  ${name.padEnd(22)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)} mean=${s.mean.toFixed(4)}`);
  }

  let nanCount = { precip: 0, gw: 0, wa: 0, windU: 0, sst: 0 };
  for (const c of state.cells) {
    if (isNaN(c.precipitation) || c.precipitation === undefined) nanCount.precip++;
    if (isNaN(c.groundwater) || c.groundwater === undefined) nanCount.gw++;
    if (isNaN(c.waterAvailability) || c.waterAvailability === undefined) nanCount.wa++;
    if (isNaN(c.windU) || c.windU === undefined) nanCount.windU++;
    if (isNaN(c.sst) || c.sst === undefined) nanCount.sst++;
  }
  const hasNaN = Object.values(nanCount).some(v => v > 0);
  if (hasNaN) {
    console.log('\n⚠ NaN/UNDEFINED DETECTED:');
    for (const [k, v] of Object.entries(nanCount)) {
      if (v > 0) console.log(`  ${k}: ${v} cells`);
    }
  } else {
    console.log('\n✓ No NaN/undefined in critical fields');
  }

  console.log('=== END DIAGNOSTIC ===');
}

// ── Precipitation-focused diagnostic ──
function printPrecipDiagnostic() {
  console.log('\n=== PRECIPITATION DIAGNOSTIC ===');

  const land = [];
  const ocean = [];
  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].isLand) land.push(i);
    else ocean.push(i);
  }

  let zeroPrecip = 0, lowPrecip = 0, modPrecip = 0, highPrecip = 0;
  for (const i of land) {
    const p = state.cells[i].precipitation || 0;
    if (p < 0.001) zeroPrecip++;
    else if (p < 0.05) lowPrecip++;
    else if (p < 0.2) modPrecip++;
    else highPrecip++;
  }
  const pct = (n) => (n / Math.max(1, land.length) * 100).toFixed(1);
  console.log('Land precipitation distribution:');
  console.log(`  Zero (<0.001):       ${zeroPrecip} (${pct(zeroPrecip)}%)`);
  console.log(`  Low (0.001-0.05):    ${lowPrecip} (${pct(lowPrecip)}%)`);
  console.log(`  Moderate (0.05-0.2): ${modPrecip} (${pct(modPrecip)}%)`);
  console.log(`  High (>0.2):         ${highPrecip} (${pct(highPrecip)}%)`);

  let zeroOceanMoist = 0;
  for (const i of ocean) {
    const m = state.cells[i].atmosphericMoisture || 0;
    if (m < 0.001) zeroOceanMoist++;
  }
  console.log(`\nOcean cells with zero moisture: ${zeroOceanMoist} / ${ocean.length} (${(zeroOceanMoist / Math.max(1, ocean.length) * 100).toFixed(1)}%)`);

  let barren = 0, photo = 0, chemo = 0, mixo = 0, other = 0;
  for (const i of land) {
    const ft = state.cells[i].floraType;
    if (ft === 'photosynthetic') photo++;
    else if (ft === 'chemotrophic') chemo++;
    else if (ft === 'mixotrophic') mixo++;
    else if (ft === 'barren') barren++;
    else other++;
  }
  console.log('\nFlora distribution:');
  console.log(`  Barren:          ${barren} (${pct(barren)}%)`);
  console.log(`  Photosynthetic:  ${photo} (${pct(photo)}%)`);
  console.log(`  Chemotrophic:    ${chemo} (${pct(chemo)}%)`);
  console.log(`  Mixotrophic:     ${mixo} (${pct(mixo)}%)`);
  if (other) console.log(`  Other (frozen):  ${other} (${pct(other)}%)`);

  console.log('\n--- Sample land cells ---');
  if (land.length) {
    const step = Math.max(1, Math.floor(land.length / 5));
    for (let s = 0; s < 5; s++) {
      const i = land[Math.min(land.length - 1, s * step)];
      const c = state.cells[i];
      const x = i % W;
      const y = Math.floor(i / W);
      const lat = ((y / H) * 180 - 90).toFixed(1);
      console.log(`  Cell (${x},${y}) lat=${lat}: elev=${(c.elevation || 0).toFixed(3)} precip=${(c.precipitation || 0).toFixed(4)} atmoMoist=${(c.atmosphericMoisture || 0).toFixed(4)} windSpd=${(c.windSpeed || 0).toFixed(3)} gw=${(c.groundwater || 0).toFixed(3)} wa=${(c.waterAvailability || 0).toFixed(3)} flora=${c.floraType} density=${(c.floraDensity || 0).toFixed(3)}`);
    }
  }

  console.log('=== END PRECIPITATION DIAGNOSTIC ===');
}

export { generatePlanet };
