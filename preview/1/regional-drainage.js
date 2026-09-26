// ══════════════════════════════════════════════════════════════════
// ── regional-drainage.js — D8 flow accumulation and stream order
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import { REGIONAL_SIZE } from './regional-constants.js';

// ── Regional drainage: D8 flow accumulation + stream order ──
function computeRegionalDrainage(elevGrid) {
  const N = REGIONAL_SIZE * REGIONAL_SIZE;
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  order.sort((a, b) => elevGrid[b] - elevGrid[a]);

  const flow = new Float32Array(N);
  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      flow[ry * REGIONAL_SIZE + rx] = state.regionalCells[rx][ry].precipitation + 0.05;
    }
  }

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  for (let oi = 0; oi < N; oi++) {
    const i = order[oi];
    const rx = i % REGIONAL_SIZE;
    const ry = (i / REGIONAL_SIZE) | 0;
    const e = elevGrid[i];

    let lowest = -1, lowestElev = e;
    for (let d = 0; d < 8; d++) {
      const nx = rx + dx8[d], ny = ry + dy8[d];
      if (nx < 0 || nx >= REGIONAL_SIZE || ny < 0 || ny >= REGIONAL_SIZE) continue;
      const ni = ny * REGIONAL_SIZE + nx;
      if (elevGrid[ni] < lowestElev) {
        lowestElev = elevGrid[ni];
        lowest = ni;
      }
    }
    if (lowest >= 0) {
      flow[lowest] += flow[i];
    }
  }

  // Assign stream order from accumulated flow
  let maxFlow = 1;
  for (let i = 0; i < N; i++) if (flow[i] > maxFlow) maxFlow = flow[i];

  for (let ry = 0; ry < REGIONAL_SIZE; ry++) {
    for (let rx = 0; rx < REGIONAL_SIZE; rx++) {
      const i = ry * REGIONAL_SIZE + rx;
      const cell = state.regionalCells[rx][ry];
      const f = flow[i];
      cell.flowAccum = f;
      const fn = Math.log(1 + f) / Math.log(1 + maxFlow);
      cell.drainageDensity = fn;
      if (fn > 0.88) cell.streamOrder = 4;
      else if (fn > 0.75) cell.streamOrder = 3;
      else if (fn > 0.5) cell.streamOrder = 2;
      else if (fn > 0.28) cell.streamOrder = 1;
      else cell.streamOrder = 0;
    }
  }
}

export { computeRegionalDrainage };
