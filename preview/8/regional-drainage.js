// ══════════════════════════════════════════════════════════════════
// ── regional-drainage.js — D8 flow accumulation and stream order
// ══════════════════════════════════════════════════════════════════

// ── Regional drainage: D8 flow accumulation + stream order ──
//    Reads g.elevation and g.precipitation; writes g.flowAccum,
//    g.drainageDensity and g.streamOrder. Window-local: flow starts at zero at
//    the window border (see DIAGNOSTIC.md B4).
function computeRegionalDrainage(g) {
  const S = g.S, N = g.N;
  const elev = g.elevation;

  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  order.sort((a, b) => elev[b] - elev[a]);

  const flow = g.flowAccum;
  for (let i = 0; i < N; i++) flow[i] = g.precipitation[i] + 0.05;

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  for (let oi = 0; oi < N; oi++) {
    const i = order[oi];
    const rx = i % S;
    const ry = (i / S) | 0;
    const e = elev[i];

    let lowest = -1, lowestElev = e;
    for (let d = 0; d < 8; d++) {
      const nx = rx + dx8[d], ny = ry + dy8[d];
      if (nx < 0 || nx >= S || ny < 0 || ny >= S) continue;
      const ni = ny * S + nx;
      if (elev[ni] < lowestElev) {
        lowestElev = elev[ni];
        lowest = ni;
      }
    }
    if (lowest >= 0) flow[lowest] += flow[i];
  }

  // Assign stream order from accumulated flow
  let maxFlow = 1;
  for (let i = 0; i < N; i++) if (flow[i] > maxFlow) maxFlow = flow[i];
  const invLogMax = 1 / Math.log(1 + maxFlow);

  for (let i = 0; i < N; i++) {
    const fn = Math.log(1 + flow[i]) * invLogMax;
    g.drainageDensity[i] = fn;
    g.streamOrder[i] = fn > 0.88 ? 4 : fn > 0.75 ? 3 : fn > 0.5 ? 2 : fn > 0.28 ? 1 : 0;
  }
}

export { computeRegionalDrainage };
