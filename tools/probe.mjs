// tools/probe.mjs — headless measurement harness for DIAGNOSTIC.md.
//
// Drives the real page in headless Chromium and prints one line per measurement.
// Usage (from the repo root):
//   python3 -m http.server 8765 &
//   node tools/probe.mjs
// Requires `playwright` (installed locally or globally) and a Chromium it can launch.

import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href);
}
const { chromium } = await loadPlaywright();

const URL = process.env.PROBE_URL || 'http://127.0.0.1:8765/index.html';
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
const consoleLines = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('crash', () => errors.push('PAGE CRASHED'));
page.on('console', m => { consoleLines.push(m.text()); if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto(URL);
await page.waitForTimeout(300);

async function waitStatus(prefix, timeout = 120000) {
  await page.waitForFunction(p => document.getElementById('statusText').textContent.startsWith(p), prefix, { timeout });
  return page.$eval('#statusText', el => el.textContent);
}
async function generate(res, seed) {
  await page.selectOption('#resolutionSelect', String(res));
  await page.fill('#seedInput', String(seed));
  await page.click('#genBtn');
  return waitStatus('Generated in');
}
const heapMB = () => page.evaluate(() => { if (window.gc) window.gc(); return performance.memory.usedJSHeapSize / 1048576; });
const landFrac = () => page.evaluate(async () => { const { state } = await import('/main.js'); let n = 0; for (const c of state.cells) if (c.isLand) n++; return n / state.cells.length; });

// ── 1. Planet generation time and land fraction across seeds (res ×1) ──
for (const seed of [5, 42, 7]) {
  const s = await generate(1, seed);
  const lf = await landFrac();
  const timing = consoleLines.filter(l => l.includes('Planet gen (ms)')).pop();
  log(`SEED ${seed}: ${s} | land fraction ${(lf * 100).toFixed(1)}% | ${timing}`);
}

// ── 2. Elevation scale reference ──
log('ELEV SCALE:', JSON.stringify(await page.evaluate(async () => {
  const { state } = await import('/main.js');
  let maxL = -1, minO = 1, sumL = 0, nL = 0;
  for (const c of state.cells) { if (c.isLand) { nL++; sumL += c.elevation; if (c.elevation > maxL) maxL = c.elevation; } else if (c.elevation < minO) minO = c.elevation; }
  return { maxLandElev: maxL, meanLandElev: sumL / nL, minOceanElev: minO };
})));

// ── 3. Ocean sentinel bleed (measured at the default ×4, where bilinear weights are fractional;
//       at ×1 every hi-res cell has a single corner with weight 1, so there is nothing to bleed) ──
log('GEN res=4 seed 5:', await generate(4, 5));
log('OCEAN-SENTINEL BLEED (×4): stored (land-masked) vs plain bilinear recomputed from the planetary grid, over hi-res land cells with a non-zero-weight ocean corner:',
  JSON.stringify(await page.evaluate(async () => {
  const { state } = await import('/main.js');
  const W = 512, H = 256, m = state.hiResMultiplier, HRW = state.HR_W, HRH = state.HR_H, hr = state.hiResData;
  let n = 0, gwStored = 0, gwPlain = 0, waStored = 0, waPlain = 0, nLand = 0;
  for (let hy = 0; hy < HRH; hy++) {
    const ly = hy / m, y0 = Math.floor(ly), fy = ly - y0;
    const r0 = Math.max(0, Math.min(H - 1, y0)) * W, r1 = Math.max(0, Math.min(H - 1, y0 + 1)) * W;
    for (let hx = 0; hx < HRW; hx++) {
      const hi = hy * HRW + hx;
      if (!hr.isLand[hi]) continue;
      nLand++;
      const lx = hx / m, x0 = Math.floor(lx), fx = lx - x0;
      const cs = [state.cells[r0 + x0 % W], state.cells[r0 + (x0 + 1) % W], state.cells[r1 + x0 % W], state.cells[r1 + (x0 + 1) % W]];
      const ws = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      let oceanW = 0, gw = 0, wa = 0;
      for (let k = 0; k < 4; k++) { if (!cs[k].isLand) oceanW += ws[k]; gw += cs[k].groundwater * ws[k]; wa += cs[k].waterAvailability * ws[k]; }
      if (oceanW <= 0) continue;
      n++; gwStored += hr.groundwater[hi]; gwPlain += gw; waStored += hr.waterAvail[hi]; waPlain += wa;
    }
  }
  return { hiresLand: nLand, affectedLandCells: n, fracOfLand: +(n / nLand).toFixed(3),
           meanGW_plainBilinear: +(gwPlain / n).toFixed(3), meanGW_stored: +(gwStored / n).toFixed(3),
           meanWA_plainBilinear: +(waPlain / n).toFixed(3), meanWA_stored: +(waStored / n).toFixed(3) };
})));
log('GEN res=1 seed 7 (for the remaining measurements):', await generate(1, 7));

// ── 4. Single-region cost (direct call, no UI, no neighbour precompute) ──
const h0 = await heapMB();
const rg = await page.evaluate(async () => {
  const { state } = await import('/main.js');
  const { generateRegionalDetail } = await import('/regional-gen.js');
  let px = -1, py = -1;
  for (let y = 60; y < 200 && px < 0; y++) for (let x = 0; x < 512; x++) { const c = state.cells[y * 512 + x]; if (c.isLand && c.elevation > 0.08) { px = x; py = y; break; } }
  const t0 = performance.now(); generateRegionalDetail(px, py);
  return { px, py, ms: Math.round(performance.now() - t0) };
});
const h1 = await heapMB();
await page.evaluate(async () => { const { state } = await import('/main.js'); state.regionalCells = null; });
const h2 = await heapMB();
log('SINGLE REGION:', JSON.stringify(rg), `heap ${h0.toFixed(0)} → ${h1.toFixed(0)} → ${h2.toFixed(0)} MB (region ≈ ${(h1 - h2).toFixed(0)} MB)`);

// ── 5. Regional relief vs the planetary relief in the same window; tile relief inside one regional cell ──
log('RELIEF PER LAYER:', JSON.stringify(await page.evaluate(async () => {
  const { state } = await import('/main.js');
  const { generateRegionalDetail, bilinearInterpolate } = await import('/regional-gen.js');
  const { generateTileDetail } = await import('/tile-gen.js');
  let px = -1, py = -1;
  for (let y = 60; y < 200 && px < 0; y++) for (let x = 0; x < 512; x++) { const c = state.cells[y * 512 + x]; if (c.isLand && c.elevation > 0.08) { px = x; py = y; break; } }
  state.selectedRegion = { cx: px, cy: py };
  generateRegionalDetail(px, py);
  let mn = 1e9, mx = -1e9, bMn = 1e9, bMx = -1e9;
  for (let rx = 0; rx < 512; rx += 4) for (let ry = 0; ry < 512; ry += 4) {
    const c = state.regionalCells[rx][ry];
    mn = Math.min(mn, c.elevation); mx = Math.max(mx, c.elevation);
    const b = bilinearInterpolate(c.worldX / 512, c.worldY / 512, q => q.elevation);
    bMn = Math.min(bMn, b); bMx = Math.max(bMx, b);
  }
  let rx = -1, ry = -1;
  for (let r = 0; r < 200 && rx < 0; r++) for (let a = 0; a < 8; a++) {
    const x = 256 + Math.round(r * Math.cos(a)), y = 256 + Math.round(r * Math.sin(a));
    const c = state.regionalCells[x] && state.regionalCells[x][y];
    if (c && c.isLand && (c.zone === 'lowland' || c.zone === 'mid_slope')) { rx = x; ry = y; break; }
  }
  const t0 = performance.now(); generateTileDetail(rx, ry); const tileMs = Math.round(performance.now() - t0);
  const t = state.currentTileData.tiles, rc = state.regionalCells[rx][ry];
  let tMn = 1e9, tMx = -1e9, water = 0, so3 = 0, trees = 0;
  for (let i = 0; i < t.elevation.length; i++) { tMn = Math.min(tMn, t.elevation[i]); tMx = Math.max(tMx, t.elevation[i]); if (t.hasWater[i]) water++; if (t.streamOrder[i] >= 3) so3++; if (t.canopy[i] >= 0.7) trees++; }
  return {
    planetaryWindowSpanM: +((bMx - bMn) * 10000).toFixed(1), regionalWindowSpanM: +(mx - mn).toFixed(1),
    tile: { rx, ry, zone: rc.zone, terrain: rc.terrainType, regionalElev: +rc.baseElevation.toFixed(4), regionalHasWater: !!rc.hasWater,
            spanInsideOneRegionalCellM: +(tMx - tMn).toFixed(2), tilesPerSide: Math.sqrt(t.elevation.length), waterTiles: water, streamOrder3Tiles: so3, treeTiles: trees, ms: tileMs },
  };
})));

// ── 6. Click offset: click the drawn centre of a planetary cell, see where the region is centred ──
const rect = await page.evaluate(() => { const r = document.getElementById('planetCanvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
await page.mouse.click(rect.left + (rg.px + 0.5) / 512 * rect.width, rect.top + (rg.py + 0.5) / 256 * rect.height);
await waitStatus('Regional');
log('CLICK OFFSET:', JSON.stringify(await page.evaluate(async () => {
  const { state } = await import('/main.js');
  const c = state.regionalCells[256][256];
  return { selectedRegion: state.selectedRegion, regionalCentreAtPlanetary: { px: c.worldX / 512, py: c.worldY / 512 }, note: 'drawn cell centre is (sel.cx+0.5, sel.cy+0.5)' };
})));

// ── 7. Stale tile cache after a pan with the tile view closed ──
await page.waitForTimeout(500);
await page.evaluate(async () => { const { openTileView } = await import('/tile-gen.js'); openTileView(256, 256); });
await page.waitForTimeout(1500);
const before = await page.evaluate(async () => { const { state } = await import('/main.js'); return state.tileChunkCache.size; });
await page.click('#tileCloseBtn');
await page.keyboard.press('ArrowRight');
let pan; try { pan = await waitStatus('Regional', 90000); } catch { pan = 'TIMEOUT'; }
const after = await page.evaluate(async () => { const { state } = await import('/main.js'); return { tileCache: state.tileChunkCache.size, sel: state.selectedRegion }; });
log('PAN + STALE TILE CACHE:', pan, `| tileChunkCache before ${before}, after ${after.tileCache} (should be 0) | heap ${(await heapMB()).toFixed(0)} MB`);

// ── 8. Drain direction dependence on the resolution multiplier ──
async function sampleDrainDirs() {
  return page.evaluate(async () => {
    const { state } = await import('/main.js');
    const { bilinearSampleHR } = await import('/core-math.js');
    const m = state.hiResMultiplier, hr = state.hiResData, out = [];
    for (let py = 20; py < 236; py += 4) for (let px = 0; px < 512; px += 4) {
      const c = state.cells[py * 512 + px];
      if (!c.isLand || c.elevation < 0.02) continue;
      out.push([px, py, bilinearSampleHR(hr.drainDirX, (px + 0.5) * m, (py + 0.5) * m, state.HR_W, state.HR_H), bilinearSampleHR(hr.drainDirY, (px + 0.5) * m, (py + 0.5) * m, state.HR_W, state.HR_H)]);
    }
    return out;
  });
}
const dd1 = await sampleDrainDirs();
log('GEN res=2:', await generate(2, 7));
const dd2 = new Map((await sampleDrainDirs()).map(d => [d[0] + ',' + d[1], d]));
let n = 0, sum = 0, o45 = 0, o90 = 0;
for (const d of dd1) { const e = dd2.get(d[0] + ',' + d[1]); if (!e) continue; let da = Math.abs(Math.atan2(d[3], d[2]) - Math.atan2(e[3], e[2])); if (da > Math.PI) da = 2 * Math.PI - da; n++; sum += da; if (da > Math.PI / 4) o45++; if (da > Math.PI / 2) o90++; }
log('DRAIN DIR res1 vs res2:', JSON.stringify({ samples: n, meanDeg: +(sum / n * 180 / Math.PI).toFixed(1), fracOver45: +(o45 / n).toFixed(3), fracOver90: +(o90 / n).toFixed(3) }));

// ── 9. Land-mask disagreement between planetary and hi-res grids ──
log('LAND MASK DISAGREEMENT:', JSON.stringify(await page.evaluate(async () => {
  const { state } = await import('/main.js');
  const m = state.hiResMultiplier, hr = state.hiResData, HRW = state.HR_W, HRH = state.HR_H;
  let disagree = 0, land = 0;
  for (let hy = 0; hy < HRH; hy++) for (let hx = 0; hx < HRW; hx++) {
    const c = state.cells[Math.floor(hy / m) * 512 + Math.floor(hx / m)], hi = hy * HRW + hx;
    if (hr.isLand[hi]) land++; if (!!hr.isLand[hi] !== c.isLand) disagree++;
  }
  return { hiresLand: land, disagreeCells: disagree, fracOfLand: +(disagree / land).toFixed(3) };
})));

log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
