// ══════════════════════════════════════════════════════════════════
// ── state.js — the single shared mutable store ──
//    No imports, no DOM. Every module reads and writes this object; main.js
//    orchestrates, ui.js wires events. Importable from Node for tests.
// ══════════════════════════════════════════════════════════════════

export const state = {
  // Seed of the CURRENTLY GENERATED planet (set by runGeneration). Regional and
  // tile generation read this, not the seed input box, so they can never drift
  // from the planet on screen.
  seed: 0,

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
    erosionPasses: 4,
    erosionRate: 0.18,
    blendWidth: 6,
    coastAmplitude: 0.10,
    mountainDetail: 0.05,
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
