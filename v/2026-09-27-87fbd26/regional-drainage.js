// ══════════════════════════════════════════════════════════════════
// ── regional-drainage.js — D8 flow accumulation and stream order
// ══════════════════════════════════════════════════════════════════
//
// Flow is measured in ONE unit at every layer: upstream area in km² weighted
// by precipitation (0..1), with a runoff floor of 0.05 so dry ground still
// drains. Hi-res, regional and tile flows are therefore directly comparable,
// and stream order is normalised against the planet's biggest river
// (getPlanetMaxFlowKm2) instead of each window's own maximum, so the same
// river gets the same order in every window and at every zoom.

import { D8X, D8Y } from './regional-grid.js';

export const RUNOFF_FLOOR = 0.05;

// ── Flow routing on a padded, depression-filled surface ──
//    The S×S grid is wrapped in a one-cell pad. Pad cells on the sides where
//    water may LEAVE are sinks (very low); pad cells on the sides where water
//    ENTERS (and everywhere a divide is assumed) are walls (very high, never
//    traversed). Priority-flood (+epsilon, Barnes et al. 2014) then raises every
//    interior pit until each cell has a strictly lower neighbour on a path to a
//    sink or a sea cell, so injected inflow on a border cell, or rain anywhere,
//    always reaches an outlet instead of dying in a pit. The real elevation is
//    untouched: rendering, tiles and pond detection keep the pits.
//
//    padSink: { W, E, N, S } Uint8Array(S), 1 = that pad cell is a sink.
//    Returns { flow, flowDir, outflowKm2 }: flow[i] accumulated (km²·precip),
//    flowDir[i] = D8 index of the receiving neighbour or 255 (left the grid or
//    no lower neighbour), outflowKm2 = total that left through the pad.
export function routeFlow(elev, S, flowInit, padSink, seaLevel = 0, eps = 1e-3) {
  const P = S + 2, NP = P * P;
  const HI = 1e6, LO = -1e6;
  const E = new Float32Array(NP);
  const done = new Uint8Array(NP);
  const isPad = new Uint8Array(NP);
  // interior
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) E[(y + 1) * P + (x + 1)] = elev[y * S + x];
  // pad ring: sinks are seeds, walls are excluded from the flood
  const setPad = (px, py, sink) => {
    const j = py * P + px;
    isPad[j] = 1;
    E[j] = sink ? LO : HI;
    done[j] = 1;
    return sink;
  };
  const heap = new Int32Array(NP);
  let size = 0;
  const push = i => {
    let k = size++;
    heap[k] = i;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (E[heap[p]] <= E[heap[k]]) break;
      const t = heap[p]; heap[p] = heap[k]; heap[k] = t; k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap[--size];
    if (size > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < size && E[heap[l]] < E[heap[m]]) m = l;
        if (r < size && E[heap[r]] < E[heap[m]]) m = r;
        if (m === k) break;
        const t = heap[m]; heap[m] = heap[k]; heap[k] = t; k = m;
      }
    }
    return top;
  };
  for (let k = 0; k < S; k++) {
    if (setPad(0,     k + 1, padSink.W[k])) push((k + 1) * P);
    if (setPad(P - 1, k + 1, padSink.E[k])) push((k + 1) * P + P - 1);
    if (setPad(k + 1, 0,     padSink.N[k])) push(k + 1);
    if (setPad(k + 1, P - 1, padSink.S[k])) push((P - 1) * P + k + 1);
  }
  // corners: sink if either adjacent side's end cell is a sink
  if (setPad(0, 0, padSink.W[0] || padSink.N[0])) push(0);
  if (setPad(P - 1, 0, padSink.E[0] || padSink.N[S - 1])) push(P - 1);
  if (setPad(0, P - 1, padSink.W[S - 1] || padSink.S[0])) push((P - 1) * P);
  if (setPad(P - 1, P - 1, padSink.E[S - 1] || padSink.S[S - 1])) push(NP - 1);
  // sea cells are outlets too
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const j = (y + 1) * P + (x + 1);
    if (elev[y * S + x] <= seaLevel) { done[j] = 1; push(j); }
  }
  // priority flood
  while (size > 0) {
    const c = pop();
    const cx = c % P, cy = (c / P) | 0;
    const floor = E[c] + eps;
    for (let d = 0; d < 8; d++) {
      const nx = cx + D8X[d], ny = cy + D8Y[d];
      if (nx < 0 || nx >= P || ny < 0 || ny >= P) continue;
      const n = ny * P + nx;
      if (done[n]) continue;
      done[n] = 1;
      if (E[n] < floor) E[n] = floor;
      push(n);
    }
  }
  // D8 accumulation over interior cells, highest (filled) first
  const N = S * S;
  const order = new Int32Array(N);
  for (let i = 0; i < N; i++) order[i] = i;
  const filledOf = i => E[(((i / S) | 0) + 1) * P + (i % S) + 1];
  order.sort((a, b) => filledOf(b) - filledOf(a));
  const flow = new Float32Array(N);
  flow.set(flowInit);
  const flowDir = new Uint8Array(N);
  let outflow = 0;
  for (let oi = 0; oi < N; oi++) {
    const i = order[oi];
    const x = i % S, y = (i / S) | 0;
    const j = (y + 1) * P + (x + 1);
    let lowest = -1, lowestE = E[j], lowestDir = 255;
    for (let d = 0; d < 8; d++) {
      const n = (y + 1 + D8Y[d]) * P + (x + 1 + D8X[d]);
      if (E[n] < lowestE) { lowestE = E[n]; lowest = n; lowestDir = d; }
    }
    if (lowest < 0) { flowDir[i] = 255; continue; }
    if (isPad[lowest]) { flowDir[i] = 255; outflow += flow[i]; continue; }
    flowDir[i] = lowestDir;
    flow[(((lowest / P) | 0) - 1) * S + (lowest % P) - 1] += flow[i];
  }
  return { flow, flowDir, outflowKm2: outflow };
}

// Stream order 0–4 from flow (km²·precip), on a log scale against the planet max.
export function streamOrderFromFlow(f, maxFlowKm2) {
  const fn = Math.log(1 + f) / Math.log(1 + maxFlowKm2);
  return fn > 0.88 ? 4 : fn > 0.75 ? 3 : fn > 0.5 ? 2 : fn > 0.28 ? 1 : 0;
}

// ── Regional drainage: D8 flow accumulation + stream order ──
//    inflow[i] (km²·precip) is water entering the window from upstream, put on
//    the border cells by regional-gen from the hi-res flow field; padSink marks
//    the border cells through which water may leave. Writes g.flowAccum,
//    g.flowDir, g.drainageDensity and g.streamOrder.
function computeRegionalDrainage(g, inflow, padSink, cellAreaKm2, maxFlowKm2) {
  const S = g.S, N = g.N;
  const init = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    init[i] = Math.max(g.precipitation[i], RUNOFF_FLOOR) * cellAreaKm2 + (inflow ? inflow[i] : 0);
  }
  const { flow, flowDir, outflowKm2 } = routeFlow(g.elevation, S, init, padSink);
  g.flowAccum.set(flow);
  g.flowDir.set(flowDir);
  g.outflowKm2 = outflowKm2;
  const invLogMax = 1 / Math.log(1 + maxFlowKm2);
  for (let i = 0; i < N; i++) {
    g.drainageDensity[i] = Math.log(1 + flow[i]) * invLogMax;
    g.streamOrder[i] = streamOrderFromFlow(flow[i], maxFlowKm2);
  }
}

export { computeRegionalDrainage };
