// ══════════════════════════════════════════════════════════════════
// ── ui.js — Event handlers, keyboard, view switching, tuning, snapshot ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import { W, H, TOTAL, clamp, getLatitudeBand } from './core-math.js';
import { intToTerrainType, intToCoverType } from './terrain-derive.js';
import { computeTilePalette, tilePhysical } from './palette-compute.js';
import {
  render, renderGlobe, renderMollweide,
  drawSelectionMarker, overlayFunctions,
  mollweidePixelToCell, globePixelToCell,
  canvas, globeCanvas, mollweideCanvas, ctx
} from './planet-render.js';
import {
  renderRegionalMap, renderTileDetail, drawTilePositionMarker,
  regionalCanvas
} from './regional-render.js';
import {
  generateRegionalDetail, getPlanetaryCell,
  REGIONAL_SIZE, CELLS_PER_PLANETARY
} from './regional-gen.js';
import {
  generateTileDetail, openTileView, hideTileView,
  CHUNK_W, CHUNK_H
} from './tile-gen.js';

// ── Store defaults for reset ──
const defaultParams = { ...state.params };

const paramConfig = {};

// ── DOM elements ──
const seedInput = document.getElementById('seedInput');
const genBtn = document.getElementById('genBtn');
const overlaySelect = document.getElementById('overlaySelect');
const statusText = document.getElementById('statusText');
const regionLabel = document.getElementById('regionLabel');
const regionalOverlaySelect = document.getElementById('regionalOverlaySelect');
const cellTooltip = document.getElementById('cellTooltip');
const tileTooltip = document.getElementById('tileTooltip');
const spinSlider = document.getElementById('spinSpeedSlider');
const pauseBtn = document.getElementById('pauseSpinBtn');
const speedControl = document.getElementById('speedControl');
const viewFlatBtn = document.getElementById('viewFlat');
const viewGlobeBtn = document.getElementById('viewGlobe');
const viewMollweideBtn = document.getElementById('viewMollweide');

const HOME_ROT_X = 0.15;
const HOME_ROT_Y = 0;

let tooltipVisible = false;
let lastRegionalCoord = null;
let lastTileCoord = null;

// ── Tooltip ──
function showTooltip(cell, mouseX, mouseY) {
  tooltipVisible = true;
  cellTooltip.style.display = 'block';

  let tx = mouseX + 15;
  let ty = mouseY - 10;
  cellTooltip.innerHTML = `
    <div class="tip-row"><b>Elev:</b> ${cell.elevation.toFixed(3)} — ${
        cell.isLand ? 'land' : cell.isShallowWater ? 'shallow water' : 'deep water'
    }</div>
    <div class="tip-row"><b>Zone:</b> ${cell.zone || '—'}  <b>Terrain:</b> ${
        cell.terrainType || '—'}${cell.coverType && cell.coverType !== 'none' ? ' / ' + cell.coverType : ''}</div>
    <div class="tip-row"><b>Temp:</b> ${cell.temperature.toFixed(2)}  <b>Wind:</b> ${
        (cell.windSpeed || 0).toFixed(2)} (${Math.round(Math.atan2(cell.windV || 0, cell.windU || 0) * 180 / Math.PI)}°)</div>
    <div class="tip-row"><b>Minerals:</b> Fe ${cell.minerals.iron.toFixed(2)}  Cu ${
        cell.minerals.copper.toFixed(2)}  Mn ${cell.minerals.manganese.toFixed(2)}</div>
    ${cell.isLand ? `
    <div class="tip-row"><b>Substrate:</b> grain ${(cell.grainSize || 0).toFixed(2)}  sat ${
        (cell.saturation || 0).toFixed(2)}${cell.hasWater ? '  depth ' + ((cell.waterDepth || 0) * 100).toFixed(0) + ' cm' : ''}</div>
    <div class="tip-row"><b>Water:</b> precip ${cell.precipitation.toFixed(2)}  gw ${
        (cell.groundwater || 0).toFixed(2)}  avail ${(cell.waterAvailability || 0).toFixed(2)}  drain ${
        (cell.drainage || 0).toFixed(2)}</div>
    ${cell.floraDensity > 0 ? `
    <div class="tip-row"><b>Flora:</b> ${cell.floraType} (${(cell.floraDensity || 0).toFixed(2)})  gc ${
        ((cell.groundCover || 0) * 100).toFixed(0)}%${(cell.canopy || 0) > 0 ? '  canopy ' + ((cell.canopy || 0) * 100).toFixed(0) + '%' : ''}${
        (cell.chemoCrust || 0) > 0 ? '  crust ' + (cell.chemoCrust || 0).toFixed(2) : ''}</div>
    ` : `<div class="tip-row"><b>Flora:</b> barren</div>`}
    <div class="tip-row"><b>Stream:</b> ${['ridge','tributary','secondary','major'][cell.streamOrder || 0]}</div>
    ` : `
    <div class="tip-row"><b>SST:</b> ${(cell.sst || 0).toFixed(2)}  <b>Current:</b> ${
        (cell.currentSpeed || 0).toFixed(2)} (${Math.round(Math.atan2(cell.currentV || 0, cell.currentU || 0) * 180 / Math.PI)}°)</div>
    `}
  `;

  const rect = cellTooltip.getBoundingClientRect();
  if (tx + rect.width > window.innerWidth - 8) tx = mouseX - rect.width - 10;
  if (ty + rect.height > window.innerHeight - 8) ty = mouseY - rect.height - 10;
  if (tx < 4) tx = 4;
  if (ty < 4) ty = 4;

  cellTooltip.style.left = tx + 'px';
  cellTooltip.style.top = ty + 'px';
}

function hideTooltip() {
  tooltipVisible = false;
  cellTooltip.style.display = 'none';
}

function showCellInfo(x, y, mouseEvent) {
  if (!state.cells) return;
  const c = state.cells[y * W + x];
  if (mouseEvent) {
    showTooltip(c, mouseEvent.clientX, mouseEvent.clientY);
  }
}

function showRegionalCellTooltip(rx, ry, mouseEvent) {
  if (!state.regionalCells || !state.regionalCells[rx] || !state.regionalCells[rx][ry]) return;
  const c = state.regionalCells[rx][ry];
  if (mouseEvent) {
    showTooltip(c, mouseEvent.clientX, mouseEvent.clientY);
  }
}

// ── Globe interaction state ──
function getSpinSpeed() {
  return (spinSlider.value / 100) * 0.012;
}

let currentSpinSpeed = getSpinSpeed();

// ── Active control indicator ──
function setActiveControl(which) {
  state.activeControl = which;
  const regHeader = document.getElementById('regionalHeader');
  const regWrap = document.getElementById('regionalCanvasWrap');
  if (which === 'regional') {
    regHeader.classList.add('active-panel');
    regWrap.classList.add('active-panel');
  } else {
    regHeader.classList.remove('active-panel');
    regWrap.classList.remove('active-panel');
  }
}

// ── Show / hide regional view ──
function showRegionalView(planetX, planetY) {
  const seed = parseInt(seedInput.value, 10) || 0;
  state.selectedRegion = { cx: planetX, cy: planetY };
  state.activeControl = 'regional';
  hideTileView();
  state.tileChunkCache.clear();

  document.getElementById('regionalPlaceholder').style.display = 'none';
  document.getElementById('regionalActive').style.display = 'block';

  const band = getLatitudeBand(Math.round(planetY));
  const plateCell = getPlanetaryCell(planetX, planetY);
  regionLabel.textContent = `REGION: (${Math.round(planetX)}, ${Math.round(planetY)}) — ${band}, ${plateCell.plateType}`;

  const t0 = performance.now();
  generateRegionalDetail(planetX, planetY);
  const t1 = performance.now();

  renderRegionalMap(regionalOverlaySelect.value);
  statusText.textContent = `Regional generated in ${(t1 - t0).toFixed(0)} ms`;

  setActiveControl('regional');
  render(overlaySelect.value);
  if (state.currentView === 'globe') renderGlobe();
  if (state.currentView === 'mollweide') renderMollweide();
}

function closeRegionalView() {
  state.selectedRegion = null;
  state.regionalCells = null;
  hideTileView();
  state.tileChunkCache.clear();
  state.activeControl = 'planetary';
  document.getElementById('regionalPlaceholder').style.display = 'flex';
  document.getElementById('regionalActive').style.display = 'none';
  setActiveControl('planetary');
  render(overlaySelect.value);
  if (state.currentView === 'globe') renderGlobe();
  if (state.currentView === 'mollweide') renderMollweide();
}

// ── View toggle ──
function setView(view) {
  state.currentView = view;
  viewFlatBtn.classList.remove('active');
  viewGlobeBtn.classList.remove('active');
  viewMollweideBtn.classList.remove('active');
  canvas.classList.add('hidden-canvas');
  globeCanvas.classList.add('hidden-canvas');
  mollweideCanvas.classList.add('hidden-canvas');
  speedControl.style.display = 'none';
  keysHeld.clear();
  hideTooltip();

  if (view === 'flat') {
    canvas.classList.remove('hidden-canvas');
    viewFlatBtn.classList.add('active');
  } else if (view === 'globe') {
    globeCanvas.classList.remove('hidden-canvas');
    viewGlobeBtn.classList.add('active');
    speedControl.style.display = '';
    renderGlobe();
  } else if (view === 'mollweide') {
    mollweideCanvas.classList.remove('hidden-canvas');
    viewMollweideBtn.classList.add('active');
    renderMollweide();
  }
}

// ── Home orientation ──
function returnHome() {
  const startX = state.rotX, startY = state.rotY;
  const targetX = HOME_ROT_X;
  let deltaY = HOME_ROT_Y - state.rotY;
  while (deltaY > Math.PI) deltaY -= Math.PI * 2;
  while (deltaY < -Math.PI) deltaY += Math.PI * 2;
  const targetY = state.rotY + deltaY;

  let frame = 0;
  const totalFrames = 30;

  function animateHome() {
    frame++;
    const t = frame / totalFrames;
    const ease = t * t * (3 - 2 * t);

    state.rotX = startX + (targetX - startX) * ease;
    state.rotY = startY + (targetY - startY) * ease;
    renderGlobe();

    if (frame < totalFrames) {
      requestAnimationFrame(animateHome);
    } else {
      state.rotX = HOME_ROT_X;
      state.rotY = HOME_ROT_Y;
      state.autoSpin = true;
      pauseBtn.textContent = '⏸';
    }
  }

  animateHome();
}

// ── Key state tracking ──
const keysHeld = new Set();

function processHeldKeys() {
  if (keysHeld.size === 0) return false;

  const speed = keysHeld.has('Shift') ? 0.04 : 0.01;
  let moved = false;

  if (keysHeld.has('ArrowLeft')) { state.rotY -= speed; moved = true; }
  if (keysHeld.has('ArrowRight')) { state.rotY += speed; moved = true; }
  if (keysHeld.has('ArrowUp')) { state.rotX = Math.max(-Math.PI / 2, state.rotX - speed); moved = true; }
  if (keysHeld.has('ArrowDown')) { state.rotX = Math.min(Math.PI / 2, state.rotX + speed); moved = true; }

  return moved;
}

// ── Spin animation loop ──
let lastFrameTime = 0;

function spinLoop(timestamp) {
  if (state.currentView === 'globe' && state.cells) {
    let needsRender = false;

    if (processHeldKeys()) needsRender = true;

    if (state.autoSpin && !state.isDragging && !state.resumeDelay && keysHeld.size === 0) {
      state.rotY += currentSpinSpeed;
      needsRender = true;
    }

    if (needsRender && timestamp - lastFrameTime > 33) {
      renderGlobe();
      lastFrameTime = timestamp;
    }
  }

  requestAnimationFrame(spinLoop);
}

// ══════════════════════════════════════════════════════════════════
// ── Tuning Panel ──
// ══════════════════════════════════════════════════════════════════

const tuningPresets = {
  'Default': {},
  'Earth-like': { continentalRatio: 0.35, continentalBase: -0.05, fractalAmp: 0.14, collisionHeight: 0.6, atmosphericPressure: 1.0 },
  'Waterworld': { continentalRatio: 0.12, oceanicBase: -0.40, continentalBase: -0.18 },
  'Pangaea': { plateCountBase: 6, continentalRatio: 0.55, minPlateSpacing: 0.6, continentalBase: -0.03 },
  'Archipelago': { plateCountBase: 16, plateCountRange: 6, continentalRatio: 0.18, minPlateSpacing: 0.22, continentalBase: -0.15, continentalNoise: 0.18, oceanicBase: -0.35 },
  'Mountainous': { collisionHeight: 0.9, arcHeight: 0.7, erosionPasses: 2, mountainDetail: 0.09 },
  'Arid': { atmosphericPressure: 0.85, moistureIterations: 50, bgPrecipRate: 0.01, coastalGroundwater: 0.2 },
  'Humid': { atmosphericPressure: 1.4, moistureIterations: 90, oroFactor: 0.6, convFactor: 0.45 },
};

let activePreset = 'Default';
let toastTimer = null;

function showToast(msg) {
  const toast = document.getElementById('tuneToast');
  toast.textContent = msg;
  toast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 1800);
}

function buildTuningPanel() {
  const panel = document.getElementById('tuningPanel');
  panel.innerHTML = '';

  const presetRow = document.createElement('div');
  presetRow.className = 'tune-presets';
  for (const name of Object.keys(tuningPresets)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    if (name === activePreset) btn.classList.add('preset-active');
    btn.addEventListener('click', () => applyPreset(name));
    presetRow.appendChild(btn);
  }
  panel.appendChild(presetRow);

  const groups = {};
  for (const key in paramConfig) {
    const cfg = paramConfig[key];
    if (!groups[cfg.group]) groups[cfg.group] = [];
    groups[cfg.group].push(key);
  }

  for (const groupName in groups) {
    const label = document.createElement('div');
    label.className = 'tune-group-label';
    label.textContent = groupName;
    panel.appendChild(label);

    for (const key of groups[groupName]) {
      const cfg = paramConfig[key];
      const row = document.createElement('div');
      row.className = 'tune-row';

      const lbl = document.createElement('label');
      lbl.textContent = cfg.label;
      lbl.setAttribute('for', 'tune_' + key);
      row.appendChild(lbl);

      const input = document.createElement('input');
      input.type = 'range';
      input.id = 'tune_' + key;
      input.min = cfg.min;
      input.max = cfg.max;
      input.step = cfg.step;
      input.value = state.params[key];

      const valSpan = document.createElement('span');
      valSpan.className = 'tune-value';
      valSpan.textContent = state.params[key];

      input.addEventListener('input', () => {
        state.params[key] = parseFloat(input.value);
        valSpan.textContent = input.value;
      });

      row.appendChild(input);
      row.appendChild(valSpan);
      panel.appendChild(row);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'tune-actions';

  const regenBtn = document.createElement('button');
  regenBtn.textContent = '↻ Regenerate';
  regenBtn.addEventListener('click', () => {
    // Dispatch to runGeneration in main.js
    document.getElementById('genBtn').click();
  });
  actions.appendChild(regenBtn);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = '⌫ Reset defaults';
  resetBtn.addEventListener('click', () => {
    for (const key in defaultParams) state.params[key] = defaultParams[key];
    activePreset = 'Default';
    buildTuningPanel();
    showToast('Reset to defaults');
  });
  actions.appendChild(resetBtn);

  panel.appendChild(actions);
}

function applyPreset(name) {
  for (const key in defaultParams) state.params[key] = defaultParams[key];
  const preset = tuningPresets[name];
  for (const key in preset) state.params[key] = preset[key];
  activePreset = name;
  buildTuningPanel();
  showToast('Applied preset: ' + name);
}

// ══════════════════════════════════════════════════════════════════
// ── Snapshot Info Panel ──
// ══════════════════════════════════════════════════════════════════
function captureSnapshot() {
  if (!state.cells) return;

  const snapshotPanel = document.getElementById('snapshotPanel');
  const streamNames = ['ridge', 'tributary', 'secondary', 'major'];
  const floraNames = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic'];

  function toHex(c) {
    return '#' + ((1 << 24) + (c.r << 16) + (c.g << 8) + c.b).toString(16).slice(1);
  }

  let html = '';

  let px, py;
  if (state.selectedRegion) {
    px = Math.round(state.selectedRegion.cx);
    py = Math.round(state.selectedRegion.cy);
  } else {
    px = Math.floor(W / 2);
    py = Math.floor(H / 2);
  }
  px = ((px % W) + W) % W;
  py = Math.max(0, Math.min(H - 1, py));
  const pc = state.cells[py * W + px];
  const pBand = getLatitudeBand(py);
  const pPlateType = pc.plateType || '—';
  const windDir = Math.round(Math.atan2(pc.windV || 0, pc.windU || 0) * 180 / Math.PI);
  const dominant = (pc.floraType && pc.floraType !== 'barren') ? pc.floraType : 'barren';

  html += `<div class="snap-section">`;
  html += `<div class="snap-header">PLANET (${px}, ${py}) — ${pBand} ${pPlateType}</div>`;
  html += `<div class="snap-row"><b>Elev</b> <span class="val">${pc.elevation.toFixed(3)}</span> | <b>Temp</b> <span class="val">${pc.temperature.toFixed(2)}</span> | <b>Wind</b> <span class="val">${(pc.windSpeed || 0).toFixed(2)}</span> (${windDir}°)</div>`;
  html += `<div class="snap-row"><b>Fe</b> <span class="val">${pc.minerals.iron.toFixed(2)}</span> <b>Cu</b> <span class="val">${pc.minerals.copper.toFixed(2)}</span> <b>Mn</b> <span class="val">${pc.minerals.manganese.toFixed(2)}</span> | ${dominant}</div>`;
  if (pc.isLand) {
    html += `<div class="snap-row"><b>Precip</b> <span class="val">${pc.precipitation.toFixed(2)}</span> <b>GW</b> <span class="val">${(pc.groundwater || 0).toFixed(2)}</span> <b>Drain</b> <span class="val">${(pc.drainage || 0).toFixed(2)}</span> <b>Avail</b> <span class="val">${(pc.waterAvailability || 0).toFixed(2)}</span></div>`;
    html += `<div class="snap-row"><b>Flora:</b> ${pc.floraType || 'barren'} (${(pc.floraDensity || 0).toFixed(2)}) | <b>Terrain:</b> ${pc.terrainType || '—'}</div>`;
  } else {
    html += `<div class="snap-row"><b>SST</b> <span class="val">${(pc.sst || 0).toFixed(2)}</span> | <b>Current</b> <span class="val">${(pc.currentSpeed || 0).toFixed(2)}</span> (${Math.round(Math.atan2(pc.currentV || 0, pc.currentU || 0) * 180 / Math.PI)}°)</div>`;
  }
  html += `</div>`;

  if (state.regionalCells && lastRegionalCoord) {
    const { rx, ry } = lastRegionalCoord;
    if (state.regionalCells[rx] && state.regionalCells[rx][ry]) {
      const rc = state.regionalCells[rx][ry];
      const rZone = rc.zone || '—';
      const rPlate = rc.plateType || pPlateType;
      const rMinerals = rc.minerals || {};
      html += `<div class="snap-section">`;
      html += `<div class="snap-header">REGION (${rx}, ${ry}) — ${rZone} ${rPlate}</div>`;
      html += `<div class="snap-row"><b>Elev</b> <span class="val">${rc.baseElevation !== undefined ? rc.baseElevation.toFixed(3) : (rc.elevation || 0).toFixed(3)}</span> | <b>Terrain:</b> ${rc.terrainType || '—'} | <b>Cover:</b> ${rc.coverType || 'none'}</div>`;
      html += `<div class="snap-row"><b>Grain</b> <span class="val">${(rc.grainSize || 0).toFixed(2)}</span> <b>Sat</b> <span class="val">${(rc.saturation || 0).toFixed(2)}</span> | <b>WTD</b> <span class="val">${(rc.waterTableDepth || 0).toFixed(2)}</span></div>`;
      html += `<div class="snap-row"><b>GC</b> <span class="val">${((rc.groundCover || 0) * 100).toFixed(0)}%</span> <b>Canopy</b> <span class="val">${((rc.canopy || 0) * 100).toFixed(0)}%</span> | <b>Flora:</b> ${rc.floraType || 'barren'}</div>`;
      html += `<div class="snap-row"><b>Minerals:</b> Fe <span class="val">${(rMinerals.iron || 0).toFixed(2)}</span> Cu <span class="val">${(rMinerals.copper || 0).toFixed(2)}</span> Mn <span class="val">${(rMinerals.manganese || 0).toFixed(2)}</span></div>`;
      html += `</div>`;
    }
  }

  if (state.currentTileData && lastTileCoord) {
    const { tx, ty } = lastTileCoord;
    if (tx >= 0 && tx < CHUNK_W && ty >= 0 && ty < CHUNK_H) {
      const ti = ty * CHUNK_W + tx;
      const t = state.currentTileData.tiles;
      const terrain = intToTerrainType(t.terrainType[ti]);
      const cover = intToCoverType(t.coverType[ti]);
      const isLand = t.elevation[ti] > 0;
      const palette = computeTilePalette(tilePhysical(t, ti));
      const bgHex = toHex(palette.bg), fgHex = toHex(palette.fg), midHex = toHex(palette.mid);
      const sw = (hex) => `<span style="display:inline-block;width:9px;height:9px;border:1px solid #555;vertical-align:middle;background:${hex};margin:0 1px;"></span>`;
      const floraType = floraNames[t.floraType[ti]] || 'barren';
      const depthCm = t.waterDepth[ti] * 100;
      const spriteName = terrain + (cover !== 'none' ? '+' + cover : '');
      const spriteVariant = 'v' + t.groundVariant[ti] + (cover !== 'none' ? '/c' + t.coverVariant[ti] : '');

      html += `<div class="snap-section">`;
      html += `<div class="snap-header">TILE (${tx}, ${ty}) — Elev ${t.elevation[ti].toFixed(3)}${!isLand ? ' (ocean)' : ''}</div>`;
      html += `<div class="snap-row"><b>Terrain:</b> ${terrain} | <b>Stream:</b> ${streamNames[t.streamOrder[ti]]} | <b>Sprite:</b> ${spriteName} ${spriteVariant}</div>`;
      html += `<div class="snap-row"><b>Grain</b> <span class="val">${t.grainSize[ti].toFixed(2)}</span> <b>Sat</b> <span class="val">${t.saturation[ti].toFixed(2)}</span> | <b>Water</b> <span class="val">${depthCm < 10 ? depthCm.toFixed(1) : (t.waterDepth[ti]).toFixed(2)} ${depthCm < 10 ? 'cm' : 'm'}</span></div>`;
      html += `<div class="snap-row"><b>Flora:</b> ${floraType} (${t.floraDensity[ti].toFixed(2)}) <b>GC</b> <span class="val">${(t.groundCover[ti] * 100).toFixed(0)}%</span></div>`;
      html += `<div class="snap-row"><b>Palette:</b> bg ${sw(bgHex)}${bgHex}  fg ${sw(fgHex)}${fgHex}  mid ${sw(midHex)}${midHex}</div>`;
      html += `</div>`;
    }
  }

  const now = new Date();
  const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  html += `<div class="snap-timestamp">Captured ${ts}</div>`;

  snapshotPanel.innerHTML = html;
}

// ══════════════════════════════════════════════════════════════════
// ── initUI — Wire up all event listeners ──
// ══════════════════════════════════════════════════════════════════
export function initUI(runGeneration) {

  // ── Populate paramConfig ──
  Object.assign(paramConfig, {
    plateCountBase:     { label: 'Plate count base',     min: 4,     max: 20,    step: 1,     group: 'Plates' },
    plateCountRange:    { label: 'Plate count range',    min: 1,     max: 10,    step: 1,     group: 'Plates' },
    continentalRatio:   { label: 'Continental %',        min: 0.10,  max: 0.70,  step: 0.05,  group: 'Plates' },
    minPlateSpacing:    { label: 'Min plate spacing',    min: 0.15,  max: 0.60,  step: 0.01,  group: 'Plates' },
    continentalBase:    { label: 'Continental base',     min: -0.25, max: 0.05,  step: 0.01,  group: 'Elevation' },
    continentalNoise:   { label: 'Continental noise',    min: 0.05,  max: 0.25,  step: 0.01,  group: 'Elevation' },
    oceanicBase:        { label: 'Ocean floor',           min: -0.50, max: -0.10, step: 0.01,  group: 'Elevation' },
    fractalAmp:         { label: 'Fractal amplitude',    min: 0.05,  max: 0.30,  step: 0.01,  group: 'Elevation' },
    fractalOctaves:     { label: 'Fractal octaves',      min: 2,     max: 6,     step: 1,     group: 'Elevation' },
    fractalScale:       { label: 'Fractal scale',        min: 0.005, max: 0.05,  step: 0.005, group: 'Elevation' },
    collisionHeight:    { label: 'Collision height',     min: 0.20,  max: 1.00,  step: 0.05,  group: 'Mountains' },
    mountainNoiseScale: { label: 'Mountain noise',       min: 0.01,  max: 0.10,  step: 0.01,  group: 'Mountains' },
    arcHeight:          { label: 'Arc height',           min: 0.10,  max: 0.80,  step: 0.05,  group: 'Mountains' },
    arcNoiseScale:      { label: 'Arc noise',            min: 0.01,  max: 0.10,  step: 0.01,  group: 'Mountains' },
    peakAspectRatio:    { label: 'Peak elongation',      min: 1.0,   max: 5.0,   step: 0.1,   group: 'Mountains' },
    peakAngularNoise:   { label: 'Coast irregularity',   min: 0.0,   max: 0.5,   step: 0.01,  group: 'Mountains' },
    peakAngularFreq:    { label: 'Coast complexity',     min: 2,     max: 10,    step: 1,     group: 'Mountains' },
    arcChainMinPeaks:   { label: 'Chain min peaks',      min: 2,     max: 12,    step: 1,     group: 'Arc Chains' },
    arcChainMaxPeaks:   { label: 'Chain max peaks',      min: 2,     max: 12,    step: 1,     group: 'Arc Chains' },
    arcChainSpacing:    { label: 'Chain spacing (cells)', min: 2,    max: 8,     step: 1,     group: 'Arc Chains' },
    arcChainJitter:     { label: 'Chain jitter (cells)',  min: 0,    max: 4,     step: 0.5,   group: 'Arc Chains' },
    arcSubPeakRadiusMin: { label: 'Sub-peak radius min', min: 2,    max: 10,    step: 1,     group: 'Arc Chains' },
    arcSubPeakRadiusMax: { label: 'Sub-peak radius max', min: 2,    max: 10,    step: 1,     group: 'Arc Chains' },
    hotspotCountBase:   { label: 'Hotspot count',        min: 0,     max: 10,    step: 1,     group: 'Hotspots' },
    hotspotCountRange:  { label: 'Hotspot range',        min: 1,     max: 10,    step: 1,     group: 'Hotspots' },
    hotspotIntensityMin:{ label: 'Intensity min',        min: 0.1,   max: 0.9,   step: 0.1,   group: 'Hotspots' },
    hotspotIntensityMax:{ label: 'Intensity max',        min: 0.2,   max: 1.0,   step: 0.1,   group: 'Hotspots' },
    subPeakMin:         { label: 'Sub-peaks min',        min: 1,     max: 6,     step: 1,     group: 'Hotspots' },
    subPeakMax:         { label: 'Sub-peaks max',        min: 1,     max: 8,     step: 1,     group: 'Hotspots' },
    subPeakSpread:      { label: 'Sub-peak spread (km)', min: 20,    max: 200,   step: 10,    group: 'Hotspots' },
    erosionPasses:      { label: 'Erosion passes',       min: 0,     max: 8,     step: 1,     group: 'Erosion' },
    erosionRate:        { label: 'Erosion rate',          min: 0.04,  max: 0.40,  step: 0.02,  group: 'Erosion' },
    blendWidth:         { label: 'Blend width',           min: 2,     max: 15,    step: 1,     group: 'Blend' },
    coastAmplitude:     { label: 'Coast amplitude',      min: 0.02,  max: 0.20,  step: 0.01,  group: 'Regional' },
    coastWidth:         { label: 'Coast width',           min: 0.03,  max: 0.15,  step: 0.01,  group: 'Regional' },
    mountainDetail:     { label: 'Mountain detail',       min: 0.01,  max: 0.12,  step: 0.01,  group: 'Regional' },
    shapeNoiseAmp:      { label: 'Shape noise',           min: 0.00,  max: 0.15,  step: 0.01,  group: 'Regional' },
    drainageDepth:      { label: 'Drainage depth',        min: 0.000, max: 0.030, step: 0.002, group: 'Regional' },
    drainagePathsMin:   { label: 'Drain paths min',      min: 2,     max: 12,    step: 1,     group: 'Regional' },
    drainagePathsMax:   { label: 'Drain paths max',      min: 4,     max: 20,    step: 1,     group: 'Regional' },
    windBlockingStrength: { label: 'Blocking strength',  min: 1.0,   max: 20.0,  step: 0.5,   group: 'Wind' },
    windDeflectionFactor: { label: 'Deflection factor',  min: 0.1,   max: 1.0,   step: 0.05,  group: 'Wind' },
    windDeflectionPasses: { label: 'Deflection passes',  min: 1,     max: 6,     step: 1,     group: 'Wind' },
    tradeWindSpeed:       { label: 'Trade wind speed',   min: 0.5,   max: 2.0,   step: 0.1,   group: 'Wind' },
    westerlyWindSpeed:    { label: 'Westerly speed',     min: 0.3,   max: 2.0,   step: 0.1,   group: 'Wind' },
    itczWidth:            { label: 'ITCZ width (°)',     min: 3,     max: 15,    step: 1,     group: 'Wind' },
    tradeEndLat:          { label: 'Trade end lat (°)',  min: 20,    max: 35,    step: 1,     group: 'Wind' },
    subtropicalEndLat:    { label: 'Subtropical end (°)',min: 30,    max: 42,    step: 1,     group: 'Wind' },
    westerlyEndLat:       { label: 'Westerly end (°)',   min: 45,    max: 65,    step: 1,     group: 'Wind' },
    currentStressCoeff:     { label: 'Stress coeff',     min: 0.01,  max: 0.08,  step: 0.005, group: 'Ocean Currents' },
    currentCoriolisStrength: { label: 'Coriolis',        min: 0.05,  max: 0.30,  step: 0.01,  group: 'Ocean Currents' },
    currentAdvectionRate:   { label: 'Advection rate',   min: 0.005, max: 0.06,  step: 0.005, group: 'Ocean Currents' },
    currentFriction:        { label: 'Friction',         min: 0.02,  max: 0.25,  step: 0.01,  group: 'Ocean Currents' },
    currentIterations:      { label: 'Iterations',       min: 20,    max: 80,    step: 5,     group: 'Ocean Currents' },
    maxCurrentSpeed:        { label: 'Max speed',        min: 1.0,   max: 8.0,   step: 0.5,   group: 'Ocean Currents' },
    sstAdvectionIterations: { label: 'SST iterations',   min: 10,    max: 60,    step: 5,     group: 'Ocean Currents' },
    sstMixRate:             { label: 'SST mix rate',     min: 0.03,  max: 0.20,  step: 0.01,  group: 'Ocean Currents' },
    upwellingCooling:       { label: 'Upwelling cool',   min: 0.05,  max: 0.30,  step: 0.01,  group: 'Ocean Currents' },
    moistureIterations:  { label: 'Iterations',          min: 30,    max: 100,   step: 5,     group: 'Precipitation' },
    thermalEvapFactor:   { label: 'Thermal evap',         min: 0.02,  max: 0.20,  step: 0.01,  group: 'Precipitation' },
    windEvapFactor:      { label: 'Wind evap',            min: 0.02,  max: 0.15,  step: 0.01,  group: 'Precipitation' },
    oroFactor:           { label: 'Orographic factor',   min: 0.1,   max: 0.8,   step: 0.05,  group: 'Precipitation' },
    convFactor:          { label: 'Convergence factor',  min: 0.1,   max: 0.6,   step: 0.05,  group: 'Precipitation' },
    bgPrecipRate:        { label: 'Background precip',   min: 0.002, max: 0.06,  step: 0.002, group: 'Precipitation' },
    moistureDiffusion:   { label: 'Diffusion',           min: 0.01,  max: 0.12,  step: 0.005, group: 'Precipitation' },
    coastalGroundwater:     { label: 'Coastal GW',       min: 0.1,   max: 0.7,   step: 0.05,  group: 'Groundwater' },
    groundwaterDepthFactor: { label: 'Depth penalty',    min: 0.5,   max: 4.0,   step: 0.1,   group: 'Groundwater' },
    groundwaterRecharge:    { label: 'Recharge',         min: 0.1,   max: 0.8,   step: 0.05,  group: 'Groundwater' },
    groundwaterGeothermal:  { label: 'Geothermal',       min: 0.2,   max: 1.5,   step: 0.1,   group: 'Groundwater' },
    coastalThreshold:       { label: 'Coastal threshold',min: 0.02,  max: 0.15,  step: 0.01,  group: 'Groundwater' },
    hydDrainageScale:    { label: 'Drainage scale',      min: 0.05,  max: 0.40,  step: 0.01,  group: 'Hydro Drainage' },
    hydDrainageCap:      { label: 'Drainage cap',        min: 0.1,   max: 0.8,   step: 0.05,  group: 'Hydro Drainage' },
    atmosphericPressure: { label: 'Atm. pressure (atm)', min: 0.8,   max: 1.5,   step: 0.05,  group: 'Planetary Atmosphere' },
    sstFloor:            { label: 'SST floor',            min: 0.3,   max: 0.7,   step: 0.05,  group: 'Planetary Atmosphere' },
  });

  buildTuningPanel();

  // ── View buttons ──
  viewFlatBtn.addEventListener('click', () => setView('flat'));
  viewGlobeBtn.addEventListener('click', () => setView('globe'));
  viewMollweideBtn.addEventListener('click', () => setView('mollweide'));

  // ── Home ──
  document.getElementById('homeBtn').addEventListener('click', returnHome);

  // ── Spin speed ──
  spinSlider.addEventListener('input', () => { currentSpinSpeed = getSpinSpeed(); });
  pauseBtn.addEventListener('click', () => {
    state.autoSpin = !state.autoSpin;
    pauseBtn.textContent = state.autoSpin ? '⏸' : '▶';
  });

  // ── Overlay select ──
  overlaySelect.addEventListener('change', () => {
    render(overlaySelect.value);
    if (state.currentView === 'globe') renderGlobe();
    if (state.currentView === 'mollweide') renderMollweide();
  });

  // ── Generate button ──
  genBtn.addEventListener('click', runGeneration);
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runGeneration();
  });

  // ── Regional close ──
  document.getElementById('closeRegionalBtn').addEventListener('click', closeRegionalView);
  regionalOverlaySelect.addEventListener('change', () => {
    renderRegionalMap(regionalOverlaySelect.value);
  });

  // ── Tuning toggle ──
  document.getElementById('tuningToggle').addEventListener('click', () => {
    const panel = document.getElementById('tuningPanel');
    const toggle = document.getElementById('tuningToggle');
    if (panel.style.display === 'none' || !panel.style.display) {
      panel.style.display = 'block';
      toggle.textContent = '⚙ Tuning ▲';
    } else {
      panel.style.display = 'none';
      toggle.textContent = '⚙ Tuning ▼';
    }
  });

  // ── Canvas click handlers ──
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);
    if (x >= 0 && x < W && y >= 0 && y < H) {
      showCellInfo(x, y, e);
      showRegionalView(x, y);
    }
  });

  mollweideCanvas.addEventListener('click', (e) => {
    const rect = mollweideCanvas.getBoundingClientRect();
    const scaleX = mollweideCanvas.width / rect.width;
    const scaleY = mollweideCanvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const cell = mollweidePixelToCell(px, py);
    if (cell) {
      showCellInfo(cell.x, cell.y, e);
      showRegionalView(cell.x, cell.y);
    }
  });

  // ── Globe interactions ──
  let dragMoved = false;

  globeCanvas.addEventListener('mousedown', (e) => {
    state.isDragging = true;
    dragMoved = false;
    state.lastMX = e.clientX;
    state.lastMY = e.clientY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.isDragging) return;
    const dx = e.clientX - state.lastMX;
    const dy = e.clientY - state.lastMY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
    state.rotY += dx * 0.01;
    state.rotX += dy * 0.01;
    state.rotX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, state.rotX));
    state.lastMX = e.clientX;
    state.lastMY = e.clientY;
    renderGlobe();
  });

  window.addEventListener('mouseup', () => {
    state.isDragging = false;
    if (state.autoSpin) {
      state.resumeDelay = true;
      setTimeout(() => { state.resumeDelay = false; }, 500);
    }
  });

  globeCanvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    state.isDragging = true;
    dragMoved = false;
    state.lastMX = e.touches[0].clientX;
    state.lastMY = e.touches[0].clientY;
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (!state.isDragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - state.lastMX;
    const dy = e.touches[0].clientY - state.lastMY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
    state.rotY += dx * 0.01;
    state.rotX += dy * 0.01;
    state.rotX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, state.rotX));
    state.lastMX = e.touches[0].clientX;
    state.lastMY = e.touches[0].clientY;
    renderGlobe();
  }, { passive: false });

  window.addEventListener('touchend', () => {
    state.isDragging = false;
    if (state.autoSpin) {
      state.resumeDelay = true;
      setTimeout(() => { state.resumeDelay = false; }, 500);
    }
  });

  globeCanvas.addEventListener('click', (e) => {
    if (dragMoved) return;
    const rect = globeCanvas.getBoundingClientRect();
    const scaleX = globeCanvas.width / rect.width;
    const scaleY = globeCanvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const cell = globePixelToCell(px, py);
    if (cell) {
      showCellInfo(cell.x, cell.y, e);
      showRegionalView(cell.x, cell.y);
    }
  });

  // ── Tooltip dismiss ──
  document.addEventListener('mousedown', (e) => {
    if (!tooltipVisible) return;
    if (e.target === canvas || e.target === globeCanvas || e.target === mollweideCanvas || e.target === regionalCanvas) return;
    hideTooltip();
  });

  // ── Regional canvas click ──
  regionalCanvas.addEventListener('click', (e) => {
    if (!state.regionalCells) return;
    const rect = regionalCanvas.getBoundingClientRect();
    const scaleX = regionalCanvas.width / rect.width;
    const scaleY = regionalCanvas.height / rect.height;
    const rx = Math.floor((e.clientX - rect.left) * scaleX);
    const ry = Math.floor((e.clientY - rect.top) * scaleY);
    if (rx >= 0 && rx < REGIONAL_SIZE && ry >= 0 && ry < REGIONAL_SIZE) {
      lastRegionalCoord = { rx, ry };
      showRegionalCellTooltip(rx, ry, e);
      openTileView(rx, ry);
    }
  });

  // ── Keyboard ──
  document.addEventListener('keydown', e => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      if (e.shiftKey && state.currentTileData && state.regionalCells) {
        e.preventDefault();
        let trx = state.currentTileData.rx, tryy = state.currentTileData.ry;
        if (e.key === 'ArrowRight') trx += 1;
        if (e.key === 'ArrowLeft')  trx -= 1;
        if (e.key === 'ArrowDown')  tryy += 1;
        if (e.key === 'ArrowUp')    tryy -= 1;
        trx  = Math.max(0, Math.min(REGIONAL_SIZE - 1, trx));
        tryy = Math.max(0, Math.min(REGIONAL_SIZE - 1, tryy));
        if (trx !== state.currentTileData.rx || tryy !== state.currentTileData.ry) {
          const cacheKey = `${trx},${tryy}`;
          const cached = state.tileChunkCache.get(cacheKey);
          if (cached) {
            state.currentTileData = cached;
            renderTileDetail(document.getElementById('tileOverlaySelect').value);
            const rc = state.regionalCells[trx][tryy];
            document.getElementById('tileDetailTitle').textContent =
              `TILES: (${trx}, ${tryy}) — ${rc.zone} ${rc.terrainType || ''}`;
            statusText.textContent = 'Tile loaded from cache';
          } else {
            const tt0 = performance.now();
            generateTileDetail(trx, tryy);
            const tt1 = performance.now();
            const rc = state.regionalCells[trx][tryy];
            document.getElementById('tileDetailTitle').textContent =
              `TILES: (${trx}, ${tryy}) — ${rc.zone} ${rc.terrainType || ''}`;
            statusText.textContent = `Tile panned in ${(tt1 - tt0).toFixed(0)} ms`;
          }
          renderRegionalMap(regionalOverlaySelect.value);
        }
        return;
      }

      if (state.activeControl === 'regional' && state.selectedRegion) {
        e.preventDefault();
        hideTileView();
        state.tileChunkCache.clear();
        const panStep = REGIONAL_SIZE / CELLS_PER_PLANETARY;
        if (e.key === 'ArrowRight') state.selectedRegion.cx += panStep;
        if (e.key === 'ArrowLeft')  state.selectedRegion.cx -= panStep;
        if (e.key === 'ArrowDown')  state.selectedRegion.cy += panStep;
        if (e.key === 'ArrowUp')    state.selectedRegion.cy -= panStep;
        state.selectedRegion.cx = ((state.selectedRegion.cx % W) + W) % W;
        state.selectedRegion.cy = Math.max(0, Math.min(H - 1, state.selectedRegion.cy));

        const band = getLatitudeBand(Math.round(state.selectedRegion.cy));
        const plateCell = getPlanetaryCell(Math.round(state.selectedRegion.cx), Math.round(state.selectedRegion.cy));
        regionLabel.textContent = `REGION: (${Math.round(state.selectedRegion.cx)}, ${Math.round(state.selectedRegion.cy)}) — ${band}, ${plateCell.plateType}`;

        const t0 = performance.now();
        generateRegionalDetail(state.selectedRegion.cx, state.selectedRegion.cy);
        const t1 = performance.now();
        renderRegionalMap(regionalOverlaySelect.value);
        statusText.textContent = `Regional panned in ${(t1 - t0).toFixed(0)} ms`;

        render(overlaySelect.value);
        if (state.currentView === 'globe') renderGlobe();
        if (state.currentView === 'mollweide') renderMollweide();
        return;
      }

      if (state.currentView === 'globe') {
        e.preventDefault();
        keysHeld.add(e.key);
        state.autoSpin = false;
        pauseBtn.textContent = '▶';
      }
    }

    if (e.key === 'Shift') keysHeld.add('Shift');
    if (e.key === 'Escape' && state.selectedRegion) closeRegionalView();
  });

  document.addEventListener('keyup', e => {
    keysHeld.delete(e.key);
    if (e.key === 'Shift') keysHeld.delete('Shift');
  });

  window.addEventListener('blur', () => keysHeld.clear());

  // ── Tile UI wiring ──
  document.getElementById('tileCloseBtn').addEventListener('click', hideTileView);

  document.getElementById('tileOverlaySelect').addEventListener('change', (e) => {
    if (state.currentTileData) renderTileDetail(e.target.value);
  });

  const tileCanvasEl = document.getElementById('tileCanvas');
  const streamNames = ['ridge', 'tributary', 'secondary', 'major'];
  const floraNames = ['barren', 'photosynthetic', 'chemotrophic', 'mixotrophic'];

  tileCanvasEl.addEventListener('mousemove', (e) => {
    if (!state.currentTileData) { tileTooltip.style.display = 'none'; return; }
    const rect = tileCanvasEl.getBoundingClientRect();
    const scaleX = tileCanvasEl.width / rect.width;
    const scaleY = tileCanvasEl.height / rect.height;
    const tx = Math.floor((e.clientX - rect.left) * scaleX);
    const ty = Math.floor((e.clientY - rect.top) * scaleY);
    if (tx < 0 || tx >= CHUNK_W || ty < 0 || ty >= CHUNK_H) { tileTooltip.style.display = 'none'; return; }

    const i = ty * CHUNK_W + tx;
    lastTileCoord = { tx, ty };
    const t = state.currentTileData.tiles;
    const terrain = intToTerrainType(t.terrainType[i]);
    const cover = intToCoverType(t.coverType[i]);

    const palette = computeTilePalette(tilePhysical(t, i));
    const toHex = (c) => '#' + ((1 << 24) + (c.r << 16) + (c.g << 8) + c.b).toString(16).slice(1);
    const bgHex = toHex(palette.bg), fgHex = toHex(palette.fg), midHex = toHex(palette.mid);
    const sw = (hex) => `<span style="display:inline-block;width:9px;height:9px;border:1px solid #000;vertical-align:middle;background:${hex}"></span>`;

    const floraType = floraNames[t.floraType[i]] || 'barren';
    const hasFlora = t.floraType[i] > 0;
    const depthCm = (t.waterDepth[i] * 100);

    tileTooltip.style.display = 'block';
    tileTooltip.innerHTML = `
      <div class="tip-row"><b>Tile:</b> (${tx}, ${ty})  <b>Elev:</b> ${t.elevation[i].toFixed(3)}${
          t.elevation[i] <= 0 ? ' (ocean)' : ''}</div>
      <div class="tip-row"><b>Terrain:</b> ${terrain}${
          cover !== 'none' ? ' / ' + cover : ''}  <b>Stream:</b> ${streamNames[t.streamOrder[i]]}</div>
      <div class="tip-row"><b>Substrate:</b> grain ${t.grainSize[i].toFixed(2)}  sat ${t.saturation[i].toFixed(2)}${
          t.waterDepth[i] > 0 ? '  water ' + (depthCm < 10 ? depthCm.toFixed(1) + ' cm' : (t.waterDepth[i]).toFixed(2) + ' m') : ''}</div>
      ${hasFlora ? `
      <div class="tip-row"><b>Flora:</b> ${floraType} (${t.floraDensity[i].toFixed(2)})  gc ${
          (t.groundCover[i] * 100).toFixed(0)}%${t.canopy[i] > 0.01 ? '  canopy ' + (t.canopy[i] * 100).toFixed(0) + '%' : ''}${
          t.chemoCrust && (t.chemoCrust[i] || 0) > 0.01 ? '  crust ' + t.chemoCrust[i].toFixed(2) : ''}</div>
      ` : `<div class="tip-row"><b>Flora:</b> barren</div>`}
      <div class="tip-row"><b>Sprite:</b> ${terrain}${cover !== 'none' ? '+' + cover : ''} v${t.groundVariant[i]}${
          cover !== 'none' ? '/c' + t.coverVariant[i] : ''}</div>
      <div class="tip-row"><b>Palette:</b> ${sw(bgHex)}${bgHex} ${sw(fgHex)}${fgHex} ${sw(midHex)}${midHex}</div>
    `;

    let px = e.clientX + 15, py = e.clientY - 10;
    const trect = tileTooltip.getBoundingClientRect();
    if (px + trect.width > window.innerWidth - 8) px = e.clientX - trect.width - 10;
    if (py + trect.height > window.innerHeight - 8) py = e.clientY - trect.height - 10;
    if (px < 4) px = 4;
    if (py < 4) py = 4;
    tileTooltip.style.left = px + 'px';
    tileTooltip.style.top = py + 'px';
  });

  tileCanvasEl.addEventListener('mouseleave', () => {
    tileTooltip.style.display = 'none';
  });

  // ── Snapshot button + I key ──
  const infoSnapBtn = document.getElementById('infoSnapBtn');
  infoSnapBtn.addEventListener('click', captureSnapshot);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'i' && e.key !== 'I') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    captureSnapshot();
  });

  // ── Start spin loop ──
  requestAnimationFrame(spinLoop);
}
