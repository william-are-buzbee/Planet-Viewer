// ══════════════════════════════════════════════════════════════════
// ── planet-gen.js — Planetary generation pipeline (steps 1-5b) ──
// ══════════════════════════════════════════════════════════════════

import { state } from './state.js';
import { W, H, TOTAL, mulberry32, clamp } from './core-math.js';
import { setStatus } from './dom.js';
import { puToM } from './units.js';
import { deriveTerrainAndCover, terrainTypeToInt, coverTypeToInt, intToTerrainType, TT_DEEP_WATER, TT_WATER, TT_ROCK, CT_NONE } from './terrain-derive.js';
import { PlanetGrid } from './planet-grid.js';
import { FT_BARREN, FT_PHOTO, FT_CHEMO, FT_MIXO, FT_NONE, FT_FROZEN, FLORA_NAMES } from './regional-grid.js';
import { step1_generatePlates, step1b_generateGeoSeeds, step2_computeElevation, step2b_coastalBathymetry, step3_computeMinerals } from './planet-geology.js';
import { step4_computeAtmosphere } from './planet-atmosphere.js';

// ── Generation pipeline ──
async function generatePlanet(seed) {
  const rng = mulberry32(seed);
  // The planetary grid is struct-of-arrays (planet-grid.js); every step below
  // reads and writes its typed arrays by cell index.
  state.cells = new PlanetGrid();

  // ── Session 28: planet generation timing ──
  console.log('=== PLANET GENERATION ===');
  const p0 = performance.now();
  // Step 1: Plates
  setStatus('Generating plates…');
  await new Promise(r => setTimeout(r, 0));
  step1_generatePlates(seed, rng);
  const p1 = performance.now();
  // Step 1b: Generate geological seed points (mountains, arcs, rifts)
  setStatus('Placing geological features…');
  await new Promise(r => setTimeout(r, 0));
  step1b_generateGeoSeeds(seed, rng);
  const p1b = performance.now();
  // Step 2: Elevation
  setStatus('Computing elevation…');
  await new Promise(r => setTimeout(r, 0));
  step2_computeElevation(seed, rng);
  const p2 = performance.now();
  // Step 2b: Coastal bathymetry steepening
  step2b_coastalBathymetry();
  const p2b = performance.now();
  // Step 3: Minerals
  setStatus('Computing minerals…');
  await new Promise(r => setTimeout(r, 0));
  step3_computeMinerals(seed, rng);
  const p3 = performance.now();
  // Step 4: Atmosphere (async — yields internally between sub-phases)
  setStatus('Computing atmosphere…');
  await new Promise(r => setTimeout(r, 0));
  await step4_computeAtmosphere(seed, rng);
  const p4 = performance.now();
  // Steps 5, 5b are fast (<120ms combined), no yield needed
  step5_computeFlora();
  const p5 = performance.now();
  // Step 5b: Terrain + cover type (via the canonical deriveTerrainAndCover)
  step5b_deriveTerrainType();
  const p5b = performance.now();

  console.log(`Planet gen (ms): ` +
    `step1=${(p1-p0).toFixed(1)} step1b=${(p1b-p1).toFixed(1)} ` +
    `step2=${(p2-p1b).toFixed(1)} step2b=${(p2b-p2).toFixed(1)} step3=${(p3-p2b).toFixed(1)} ` +
    `step4=${(p4-p3).toFixed(1)} step5=${(p5-p4).toFixed(1)} ` +
    `step5b=${(p5b-p5).toFixed(1)} ` +
    `TOTAL=${(p5b-p0).toFixed(1)}`);

  // Diagnostic
  printWeatherDiagnostic();
  printPrecipDiagnostic();
}

// ── Step 5: Flora ──
function step5_computeFlora() {
  const P = state.cells;
  for (let i = 0; i < TOTAL; i++) {
    if (!P.isLand[i]) {
      P.floraType[i] = FT_NONE;
      P.floraDensity[i] = 0;
      continue;
    }
    if (P.isFreezing[i]) {
      P.floraType[i] = FT_FROZEN;
      P.floraDensity[i] = 0;
      continue;
    }

    const light = 1.0;
    const water = P.waterAvailability[i];
    const mineralTotal = P.mineralTotal[i];
    const photoFitness = light * water * 0.8;
    const chemoFitness = mineralTotal * Math.max(water, P.volcanism[i] * 1.5) * 1.2; // R1-FIX3: unified chemo secondary factor (volcanism, not groundwater)
    const mixoFitness  = (0.6 + 0.5 * mineralTotal) * water;
    const maxFitness = Math.max(photoFitness, chemoFitness, mixoFitness);

    if (maxFitness < 0.02) {
      P.floraType[i] = FT_BARREN;
      P.floraDensity[i] = 0;
    } else if (photoFitness >= chemoFitness && photoFitness >= mixoFitness) {
      P.floraType[i] = FT_PHOTO;
      P.floraDensity[i] = clamp(maxFitness, 0, 1);
    } else if (chemoFitness >= photoFitness && chemoFitness >= mixoFitness) {
      P.floraType[i] = FT_CHEMO;
      P.floraDensity[i] = clamp(maxFitness, 0, 1);
    } else {
      P.floraType[i] = FT_MIXO;
      P.floraDensity[i] = clamp(maxFitness, 0, 1);
    }
  }
}

// ── Step 5b: Terrain + cover for the low-res planetary grid ──
// Routes through THE canonical deriveTerrainAndCover so the planetary map
// classifies terrain identically to the regional / high-res / tile views.
// The low-res grid doesn't compute the detailed substrate/flora fields those
// grids have, so they're ESTIMATED here from the planetary sim's own fields.
// (Only terrainType / coverType are consumed — by the snapshot panel.)
function step5b_deriveTerrainType() {
  const P = state.cells;
  for (let i = 0; i < TOTAL; i++) {
    if (!P.isLand[i]) {
      P.terrainType[i] = P.isDeepWater[i] ? TT_DEEP_WATER : TT_WATER;
      P.coverType[i] = CT_NONE;
      continue;
    }
    if (P.isFreezing[i]) {
      P.terrainType[i] = TT_ROCK;
      P.coverType[i] = CT_NONE;
      continue;
    }

    // Estimate the physical fields the low-res grid lacks so the canonical
    // function sees inputs comparable to the high-res grid's.
    const elevation = P.elevation[i];
    const floraDensity = P.floraDensity[i];
    const grainSize     = clamp(0.25 + elevation * 0.6, 0.05, 0.95);
    const saturation    = clamp(P.waterAvailability[i] || 0, 0, 1);
    const groundCover   = floraDensity > 0 ? floraDensity * 0.6 : 0; // R1-FIX5: removed 0.3 floor, reduced multiplier to match hi-res pipeline
    const canopyDensity = floraDensity > 0.2 ? floraDensity * 0.7 : 0;
    const chemoCrust    = P.floraType[i] === FT_CHEMO ? clamp(floraDensity * 0.5, 0, 1) : 0;
    const waterTableDepth = clamp((1 - saturation) * (0.3 + elevation * 2), 0, 1);
    const isCoastal     = elevation > 0 && elevation < 0.03;

    const result = deriveTerrainAndCover(
      puToM(elevation),   // the classifier takes metres
      true,
      grainSize,
      saturation,
      groundCover,
      canopyDensity,
      chemoCrust,
      P.floraType[i],
      waterTableDepth,
      isCoastal
    );

    P.terrainType[i] = terrainTypeToInt(result.terrainType);
    P.coverType[i]   = coverTypeToInt(result.coverType);
  }
}

// ── Weather Diagnostic ──
function printWeatherDiagnostic() {
  const P = state.cells;
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

  // mean of arr[i] over cells i in [i0, i1) that satisfy pred(i)
  const meanOver = (i0, i1, arr, pred) => {
    let s = 0, n = 0;
    for (let i = i0; i < i1; i++) if (pred(i)) { s += arr[i]; n++; }
    return n ? s / n : 0;
  };
  const any = () => true, land = i => P.isLand[i] === 1, ocean = i => P.isLand[i] === 0;

  for (const band of bands) {
    const i0 = band.yMin * W, i1 = band.yMax * W;
    let nLand = 0; for (let i = i0; i < i1; i++) if (P.isLand[i]) nLand++;
    console.log(
      `${band.name.padEnd(25)} | wind: u=${meanOver(i0, i1, P.windU, any).toFixed(3)} v=${meanOver(i0, i1, P.windV, any).toFixed(3)} spd=${meanOver(i0, i1, P.windSpeed, any).toFixed(3)}` +
      ` | sst=${meanOver(i0, i1, P.sst, ocean).toFixed(3)} | oceanMoist=${meanOver(i0, i1, P.atmosphericMoisture, ocean).toFixed(4)} landMoist=${meanOver(i0, i1, P.atmosphericMoisture, land).toFixed(4)}` +
      ` | precip=${meanOver(i0, i1, P.precipitation, land).toFixed(4)} gw=${meanOver(i0, i1, P.groundwater, land).toFixed(3)} drain=${meanOver(i0, i1, P.drainage, land).toFixed(4)} wa=${meanOver(i0, i1, P.waterAvailability, land).toFixed(3)}` +
      ` | land=${nLand} ocean=${i1 - i0 - nLand}`
    );
  }

  const stat = (arr, pred) => {
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = 0; i < TOTAL; i++) { if (!pred(i)) continue; const v = arr[i]; if (v < min) min = v; if (v > max) max = v; sum += v; n++; }
    return n ? { min, max, mean: sum / n } : { min: 0, max: 0, mean: 0 };
  };

  console.log('\n=== GLOBAL STATS (land cells) ===');
  for (const [name, arr] of [['precipitation', P.precipitation], ['groundwater', P.groundwater], ['drainage', P.drainage],
                             ['waterAvailability', P.waterAvailability], ['atmosphericMoisture', P.atmosphericMoisture], ['windSpeed', P.windSpeed]]) {
    const s = stat(arr, land);
    console.log(`  ${name.padEnd(22)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)} mean=${s.mean.toFixed(4)}`);
  }

  console.log('\n=== GLOBAL STATS (ocean cells) ===');
  for (const [name, arr] of [['sst', P.sst], ['atmosphericMoisture', P.atmosphericMoisture], ['windSpeed', P.windSpeed], ['currentSpeed', P.currentSpeed]]) {
    const s = stat(arr, ocean);
    console.log(`  ${name.padEnd(22)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)} mean=${s.mean.toFixed(4)}`);
  }

  const nanCount = { precip: 0, gw: 0, wa: 0, windU: 0, sst: 0 };
  for (let i = 0; i < TOTAL; i++) {
    if (P.precipitation[i] !== P.precipitation[i]) nanCount.precip++;
    if (P.groundwater[i] !== P.groundwater[i]) nanCount.gw++;
    if (P.waterAvailability[i] !== P.waterAvailability[i]) nanCount.wa++;
    if (P.windU[i] !== P.windU[i]) nanCount.windU++;
    if (P.sst[i] !== P.sst[i]) nanCount.sst++;
  }
  if (Object.values(nanCount).some(v => v > 0)) {
    console.log('\n⚠ NaN DETECTED:');
    for (const [k, v] of Object.entries(nanCount)) if (v > 0) console.log(`  ${k}: ${v} cells`);
  } else {
    console.log('\n✓ No NaN in critical fields');
  }

  console.log('=== END DIAGNOSTIC ===');
}

// ── Precipitation-focused diagnostic ──
function printPrecipDiagnostic() {
  const P = state.cells;
  console.log('\n=== PRECIPITATION DIAGNOSTIC ===');

  const land = [];
  let nOcean = 0, zeroOceanMoist = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (P.isLand[i]) land.push(i);
    else { nOcean++; if (P.atmosphericMoisture[i] < 0.001) zeroOceanMoist++; }
  }

  let zeroPrecip = 0, lowPrecip = 0, modPrecip = 0, highPrecip = 0;
  const floraCounts = new Uint32Array(8);
  for (const i of land) {
    const p = P.precipitation[i];
    if (p < 0.001) zeroPrecip++;
    else if (p < 0.05) lowPrecip++;
    else if (p < 0.2) modPrecip++;
    else highPrecip++;
    floraCounts[P.floraType[i]]++;
  }
  const pct = (n) => (n / Math.max(1, land.length) * 100).toFixed(1);
  console.log('Land precipitation distribution:');
  console.log(`  Zero (<0.001):       ${zeroPrecip} (${pct(zeroPrecip)}%)`);
  console.log(`  Low (0.001-0.05):    ${lowPrecip} (${pct(lowPrecip)}%)`);
  console.log(`  Moderate (0.05-0.2): ${modPrecip} (${pct(modPrecip)}%)`);
  console.log(`  High (>0.2):         ${highPrecip} (${pct(highPrecip)}%)`);
  console.log(`\nOcean cells with zero moisture: ${zeroOceanMoist} / ${nOcean} (${(zeroOceanMoist / Math.max(1, nOcean) * 100).toFixed(1)}%)`);

  console.log('\nFlora distribution:');
  for (const ft of [FT_BARREN, FT_PHOTO, FT_CHEMO, FT_MIXO, FT_FROZEN]) {
    if (floraCounts[ft] || ft !== FT_FROZEN) console.log(`  ${FLORA_NAMES[ft].padEnd(16)} ${floraCounts[ft]} (${pct(floraCounts[ft])}%)`);
  }

  console.log('\n--- Sample land cells ---');
  if (land.length) {
    const step = Math.max(1, Math.floor(land.length / 5));
    for (let s = 0; s < 5; s++) {
      const i = land[Math.min(land.length - 1, s * step)];
      const x = i % W, y = Math.floor(i / W);
      const lat = ((y / H) * 180 - 90).toFixed(1);
      console.log(`  Cell (${x},${y}) lat=${lat}: elev=${P.elevation[i].toFixed(3)} precip=${P.precipitation[i].toFixed(4)} atmoMoist=${P.atmosphericMoisture[i].toFixed(4)} windSpd=${P.windSpeed[i].toFixed(3)} gw=${P.groundwater[i].toFixed(3)} wa=${P.waterAvailability[i].toFixed(3)} flora=${FLORA_NAMES[P.floraType[i]]} density=${P.floraDensity[i].toFixed(3)} terrain=${intToTerrainType(P.terrainType[i])}`);
    }
  }

  console.log('=== END PRECIPITATION DIAGNOSTIC ===');
}

export { generatePlanet };
