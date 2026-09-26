// ══════════════════════════════════════════════════════════════════
// ── main.js — Entry point: shared state, orchestration ──
// ══════════════════════════════════════════════════════════════════

// ── Shared state object ──
export const state = {
  // Planetary grid
  cells: null,
  plates: null,
  hotspots: null,
  geoSeeds: null,

  // Hi-res surface
  hiResData: null,
  planet: null,
  hiResMultiplier: 4,
  HR_W: 0,
  HR_H: 0,
  HR_TOTAL: 0,

  // Regional
  regionalCells: null,
  selectedRegion: null,
  activeControl: 'planetary',

  // Tile
  currentTileData: null,
  tileChunkCache: new Map(),

  // View
  currentView: 'flat',

  // Tunable parameters
  params: {
    plateCountBase: 14,
    plateCountRange: 6,
    continentalRatio: 0.30,
    minPlateSpacing: 0.28,
    continentalBase: -0.08,
    continentalNoise: 0.18,
    oceanicBase: -0.30,
    fractalAmp: 0.15,
    fractalOctaves: 4,
    fractalScale: 0.02,
    collisionHeight: 0.65,
    mountainNoiseScale: 0.05,
    arcHeight: 0.55,
    arcNoiseScale: 0.06,
    peakAspectRatio: 2.5,
    peakAngularNoise: 0.25,
    peakAngularFreq: 5,
    arcChainMinPeaks: 4,
    arcChainMaxPeaks: 8,
    arcChainSpacing: 4,
    arcChainJitter: 1.5,
    arcSubPeakRadiusMin: 3,
    arcSubPeakRadiusMax: 6,
    hotspotCountBase: 3,
    hotspotCountRange: 5,
    hotspotIntensityMin: 0.5,
    hotspotIntensityMax: 1.0,
    subPeakMin: 2,
    subPeakMax: 5,
    subPeakSpread: 80,
    erosionPasses: 4,
    erosionRate: 0.18,
    blendWidth: 6,
    coastAmplitude: 0.10,
    coastWidth: 0.07,
    mountainDetail: 0.05,
    shapeNoiseAmp: 0.05,
    drainageDepth: 0.012,
    drainagePathsMin: 6,
    drainagePathsMax: 12,
    windBlockingStrength: 8.0,
    windDeflectionFactor: 0.5,
    windDeflectionPasses: 3,
    tradeWindSpeed: 1.2,
    westerlyWindSpeed: 0.9,
    itczWidth: 8,
    tradeEndLat: 28,
    subtropicalEndLat: 35,
    westerlyEndLat: 55,
    currentStressCoeff: 0.03,
    currentCoriolisStrength: 0.15,
    currentAdvectionRate: 0.02,
    currentFriction: 0.12,
    currentIterations: 25,
    maxCurrentSpeed: 3.0,
    sstAdvectionIterations: 18,
    sstMixRate: 0.1,
    upwellingCooling: 0.15,
    moistureIterations: 35,
    thermalEvapFactor: 0.18,
    windEvapFactor: 0.10,
    oroFactor: 0.4,
    convFactor: 0.3,
    bgPrecipRate: 0.045,
    moistureDiffusion: 0.08,
    coastalGroundwater: 0.35,
    groundwaterDepthFactor: 2.0,
    groundwaterRecharge: 0.5,
    groundwaterGeothermal: 0.8,
    coastalThreshold: 0.08,
    hydDrainageScale: 0.15,
    hydDrainageCap: 0.4,
    atmosphericPressure: 1.2,
    sstFloor: 0.50,
  },

  // Globe state
  rotX: 0.15,
  rotY: 0,
  autoSpin: true,
  isDragging: false,
  resumeDelay: false,
  lastMX: 0,
  lastMY: 0,
};

// ── Imports ──
import { generatePlanet } from './planet-gen.js';
import { generateHighResSurface, yieldFrame, updateProgress, hideProgress } from './hires-gen.js';
import { render, renderGlobe, renderMollweide } from './planet-render.js';
import { initUI, clearRegionCache } from './ui.js';

// ── Generation orchestration ──
let _generating = false;

async function runGeneration() {
  if (_generating) return;
  _generating = true;

  const genBtn = document.getElementById('genBtn');
  const seedInput = document.getElementById('seedInput');
  const overlaySelect = document.getElementById('overlaySelect');
  const statusText = document.getElementById('statusText');

  genBtn.disabled = true;
  const seed = parseInt(seedInput.value, 10) || 0;
  statusText.textContent = 'Generating…';

  // Clear stale cached regions — planet is changing
  clearRegionCache();

  // Close any open regional view (planet is changing)
  if (state.selectedRegion) {
    // Inline close — avoid circular import
    state.selectedRegion = null;
    state.regionalCells = null;
    state.currentTileData = null;
    state.tileChunkCache.clear();
    state.activeControl = 'planetary';
    const placeholder = document.getElementById('regionalPlaceholder');
    const active = document.getElementById('regionalActive');
    const tileContainer = document.getElementById('tileDetailContainer');
    if (placeholder) placeholder.style.display = 'flex';
    if (active) active.style.display = 'none';
    if (tileContainer) tileContainer.style.display = 'none';
  }

  const resSel = document.getElementById('resolutionSelect');
  state.hiResMultiplier = resSel ? (parseInt(resSel.value, 10) || 1) : 4;

  try {
    await yieldFrame();
    updateProgress('Simulating atmosphere…', 0);
    await yieldFrame();

    const tStart = performance.now();

    const t0 = performance.now();
    await generatePlanet(seed);
    const t1 = performance.now();

    await generateHighResSurface(seed);
    state.planet = state.hiResData;
    const t2 = performance.now();

    updateProgress('Rendering…', 99);
    await yieldFrame();
    render(overlaySelect.value);
    if (state.currentView === 'globe') renderGlobe();
    if (state.currentView === 'mollweide') renderMollweide();
    const t3 = performance.now();

    const tEnd = performance.now();

    // ── Session 28: Grid sizes ──
    console.log('=== GRID SIZES ===');
    console.log(`Planet: W=${state.HR_W / state.hiResMultiplier} H=${state.HR_H / state.hiResMultiplier} TOTAL=${(state.HR_W / state.hiResMultiplier) * (state.HR_H / state.hiResMultiplier)}`);
    console.log(`HiRes multiplier: ${state.hiResMultiplier}`);
    console.log(`HiRes: HR_W=${state.HR_W} HR_H=${state.HR_H} HR_TOTAL=${state.HR_TOTAL}`);

    // ── Session 28: Top-level timing ──
    console.log(`=== TOTAL GENERATION: ${(tEnd - tStart).toFixed(0)}ms ===`);
    console.log(`  Planet gen: ${(t1 - t0).toFixed(0)}ms`);
    console.log(`  HiRes gen: ${(t2 - t1).toFixed(0)}ms`);
    console.log(`  Render: ${(t3 - t2).toFixed(0)}ms`);

    // ── Session 28: Memory snapshot ──
    if (performance.memory) {
      console.log('=== MEMORY ===');
      console.log(`Heap used: ${(performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1)}MB`);
      console.log(`Heap total: ${(performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(1)}MB`);
    }
    // Typed array memory estimate
    if (state.hiResData) {
      const f32Count = 19; // elevation, precipitation, groundwater, waterAvail, volcanism, iron, copper, manganese, windU, windV, windSpeed, temperature, sst, grainSize, waterTableDepth, saturation, groundCover, canopyDensity, organicContent + chemoCrust + drainDirX + drainDirY = ~22
      const u8Count = 9;   // isLand, isShallowWater, isDeepWater, isFreezing, floraType, terrainType, coverType, streamOrder, colorR, colorG, colorB = ~11
      const u16Count = 1;  // plateId
      const hrBytes = state.HR_TOTAL * (22 * 4 + 11 * 1 + 1 * 2);
      console.log(`HiRes typed arrays: ~${(hrBytes / 1024 / 1024).toFixed(1)}MB (${state.HR_TOTAL} cells × ~101 bytes)`);
    }

    hideProgress();
    const hrNote = state.hiResData ? `, ${state.HR_W}×${state.HR_H} surface in ${(t2 - t1).toFixed(0)} ms` : '';
    statusText.textContent =
      `Generated in ${(t1 - t0).toFixed(0)} ms${hrNote}, rendered in ${(t3 - t2).toFixed(0)} ms`;
  } catch (err) {
    console.error(err);
    hideProgress();
    const statusText = document.getElementById('statusText');
    statusText.textContent = 'Generation error — see console.';
  } finally {
    genBtn.disabled = false;
    _generating = false;
  }
}

// ── Initialize ──
initUI(runGeneration);
