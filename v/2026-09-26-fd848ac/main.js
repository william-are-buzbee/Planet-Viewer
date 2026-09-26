// ══════════════════════════════════════════════════════════════════
// ── main.js — Entry point: orchestration (shared state lives in state.js) ──
// ══════════════════════════════════════════════════════════════════

import { state } from './state.js';
export { state };

// ── Imports ──
import { generatePlanet } from './planet-gen.js';
import { generateHighResSurface, yieldFrame, updateProgress, hideProgress } from './hires-gen.js';
import { render, renderGlobe, renderMollweide } from './planet-render.js';
import { initUI, clearRegionCache } from './ui.js';
import { initPlanetRender } from './planet-render.js';
import { initRegionalRender } from './regional-render.js';

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
  state.seed = seed;
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
    if (!state.hiResData) {
      // Allocation failed (Ultra on a small machine). There is no low-res
      // rendering path any more: stop here and ask for a smaller grid.
      hideProgress();
      statusText.textContent = 'High-res grid too large for available memory — choose a lower resolution and Generate again.';
      return;
    }

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
initPlanetRender();
initRegionalRender();
initUI(runGeneration);
