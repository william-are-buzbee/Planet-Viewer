// ══════════════════════════════════════════════════════════════════
// ── planet-atmosphere.js — Wind, currents, SST, precipitation, hydrology
// ══════════════════════════════════════════════════════════════════

import { state } from './state.js';
import { W, H, TOTAL, clamp, wrapX, smoothstep } from './core-math.js';
import { setStatus } from './dom.js';

// Neighbour offset tables — module-level so the inner loops don't allocate
// ~14M throw-away arrays per generation (they were declared per cell per pass).
const dx4 = [1, -1, 0, 0];
const dy4 = [0, 0, -1, 1];
const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

// ── Step 4: Hydrological System ──
async function step4_computeAtmosphere(seed, rng) {
  const P = state.cells;

  // ── Step 4a: Wind Vector Field ──
  setStatus('Generating wind field…');

  for (let y = 0; y < H; y++) {
    const lat = (y / H) * 180 - 90;
    const absLat = Math.abs(lat);

    let u = 0, vMag = 0, spd = 0;

    const itcz = state.params.itczWidth;
    const tradeEnd = state.params.tradeEndLat;
    const subEnd = state.params.subtropicalEndLat;
    const westEnd = state.params.westerlyEndLat;
    const tradeSpd = state.params.tradeWindSpeed;
    const westSpd = state.params.westerlyWindSpeed;

    if (absLat < itcz) {
      u = 0; vMag = 0.3; spd = 0.3;
    } else if (absLat < itcz + 5) {
      const t = smoothstep(itcz, itcz + 5, absLat);
      u = -tradeSpd * t;
      vMag = 0.3 + (tradeSpd * 0.3 - 0.3) * t;
      spd = 0.3 + (tradeSpd - 0.3) * t;
    } else if (absLat < tradeEnd) {
      u = -tradeSpd; vMag = tradeSpd * 0.3; spd = tradeSpd;
    } else if (absLat < tradeEnd + 5) {
      const t = smoothstep(tradeEnd, tradeEnd + 5, absLat);
      u = -tradeSpd * (1 - t);
      vMag = tradeSpd * 0.3 * (1 - t) + 0.15 * t;
      spd = tradeSpd + (0.5 - tradeSpd) * t;
    } else if (absLat < subEnd) {
      u = 0; vMag = 0.15; spd = 0.5;
    } else if (absLat < subEnd + 5) {
      const t = smoothstep(subEnd, subEnd + 5, absLat);
      u = westSpd * t;
      vMag = 0.15 + (westSpd * 0.15 - 0.15) * t;
      spd = 0.5 + (westSpd - 0.5) * t;
    } else if (absLat < westEnd) {
      u = westSpd; vMag = westSpd * 0.15; spd = westSpd;
    } else if (absLat < westEnd + 5) {
      const t = smoothstep(westEnd, westEnd + 5, absLat);
      u = westSpd * (1 - t) + (-0.4) * t;
      vMag = westSpd * 0.15 * (1 - t) + 0.12 * t;
      spd = westSpd + (0.4 - westSpd) * t;
    } else {
      u = -0.4; vMag = 0.12; spd = 0.4;
    }

    for (let x = 0; x < W; x++) {
      const c = y * W + x;
      P.windU[c] = u;

      let v = 0;
      if (absLat < itcz) {
        v = lat > 0 ? -vMag : vMag;
      } else if (absLat < tradeEnd + 5) {
        v = lat > 0 ? -vMag : vMag;
      } else if (absLat < subEnd) {
        v = lat > 0 ? vMag : -vMag;
      } else if (absLat < westEnd + 5) {
        v = lat > 0 ? vMag : -vMag;
      } else {
        v = lat > 0 ? -vMag : vMag;
      }

      P.windV[c] = v;
      P.windSpeed[c] = spd;
    }
  }

  // Topographic deflection (iterative passes)
  for (let pass = 0; pass < state.params.windDeflectionPasses; pass++) {
    const snapU = new Float32Array(TOTAL);
    const snapV = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      snapU[i] = P.windU[i];
      snapV[i] = P.windV[i];
    }

    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = ci;
        if (!P.isLand[c]) continue;

        const xp = wrapX(x + 1), xm = wrapX(x - 1);
        const gradX = (P.elevation[y * W + xp] - P.elevation[y * W + xm]) / 2;
        const gradY = (P.elevation[(y + 1) * W + x] - P.elevation[(y - 1) * W + x]) / 2;
        const gradMag = Math.sqrt(gradX * gradX + gradY * gradY);
        if (gradMag < 0.001) continue;

        const wU = snapU[ci], wV = snapV[ci];
        const dotWG = wU * gradX + wV * gradY;
        const uphill = dotWG / gradMag;
        if (uphill <= 0) continue;

        const block = clamp(uphill * gradMag * state.params.windBlockingStrength, 0, 0.85);
        const dotGG = gradX * gradX + gradY * gradY;
        const projFactor = dotWG / dotGG;
        const windAlongGradU = projFactor * gradX;
        const windAlongGradV = projFactor * gradY;

        P.windU[c] -= windAlongGradU * block;
        P.windV[c] -= windAlongGradV * block;

        P.windU[c] += (-gradY) * block * state.params.windDeflectionFactor;
        P.windV[c] += gradX * block * state.params.windDeflectionFactor;
      }
    }

    for (let i = 0; i < TOTAL; i++) {
      P.windSpeed[i] = Math.sqrt(P.windU[i] * P.windU[i] + P.windV[i] * P.windV[i]);
    }
  }

  // ── Step 4b: Ocean Currents ──
  setStatus('Computing ocean currents…');
  await new Promise(r => setTimeout(r, 0));

  const numCurrentIter = Math.round(state.params.currentIterations);
  for (let iter = 0; iter < numCurrentIter; iter++) {
    const snapCU = new Float32Array(TOTAL);
    const snapCV = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      snapCU[i] = P.currentU[i];
      snapCV[i] = P.currentV[i];
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = ci;
        if (P.isLand[c]) continue;

        P.currentU[c] += P.windU[c] * state.params.currentStressCoeff;
        P.currentV[c] += P.windV[c] * state.params.currentStressCoeff;

        const lat = (y / H) * 180 - 90;
        const latRad = lat * Math.PI / 180;
        const f = Math.sin(latRad);
        const angle = f * state.params.currentCoriolisStrength;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const newU = P.currentU[c] * cosA - P.currentV[c] * sinA;
        const newV = P.currentU[c] * sinA + P.currentV[c] * cosA;
        P.currentU[c] = newU;
        P.currentV[c] = newV;
        for (let d = 0; d < 4; d++) {
          const nx = wrapX(x + dx4[d]);
          const ny = y + dy4[d];
          if (ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (P.isLand[ni]) {
            const ldx = dx4[d], ldy = dy4[d];
            const towardLand = P.currentU[c] * ldx + P.currentV[c] * ldy;
            if (towardLand > 0) {
              P.currentU[c] -= towardLand * ldx;
              P.currentV[c] -= towardLand * ldy;
              P.currentU[c] += (-ldy) * towardLand * 0.5;
              P.currentV[c] += ldx * towardLand * 0.5;
            }
          }
        }
        let totalInflowU = 0, totalInflowV = 0;
        for (let d = 0; d < 8; d++) {
          const nx = wrapX(x + dx8[d]);
          const ny = y + dy8[d];
          if (ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (P.isLand[ni]) continue;
          const tdx = -dx8[d], tdy = -dy8[d];
          const tLen = Math.sqrt(tdx * tdx + tdy * tdy);
          const dot = (snapCU[ni] * tdx + snapCV[ni] * tdy) / tLen;
          if (dot > 0) {
            const weight = dot / (Math.abs(dot) + 0.5);
            totalInflowU += snapCU[ni] * weight;
            totalInflowV += snapCV[ni] * weight;
          }
        }
        const inflowMag = Math.sqrt(totalInflowU * totalInflowU + totalInflowV * totalInflowV);
        if (inflowMag > state.params.currentAdvectionRate) {
          const scale = state.params.currentAdvectionRate / inflowMag;
          totalInflowU *= scale;
          totalInflowV *= scale;
        }
        P.currentU[c] += totalInflowU;
        P.currentV[c] += totalInflowV;

        P.currentU[c] *= (1.0 - state.params.currentFriction);
        P.currentV[c] *= (1.0 - state.params.currentFriction);

        const speed = Math.sqrt(P.currentU[c] * P.currentU[c] + P.currentV[c] * P.currentV[c]);
        if (speed > state.params.maxCurrentSpeed) {
          P.currentU[c] *= state.params.maxCurrentSpeed / speed;
          P.currentV[c] *= state.params.maxCurrentSpeed / speed;
        }
      }
    }
  }

  for (let i = 0; i < TOTAL; i++) {
    const c = i;
    P.currentSpeed[c] = Math.sqrt(P.currentU[c] * P.currentU[c] + P.currentV[c] * P.currentV[c]);
  }

  for (let y = 0; y < H; y++) {
    const lat = (y / H) * 180 - 90;
    const absLat = Math.abs(lat);
    const baseSst = 1.0 - (absLat / 90) * 0.6;
    for (let x = 0; x < W; x++) {
      const c = y * W + x;
      if (!P.isLand[c]) {
        P.sst[c] = baseSst;
      }
    }
  }

  const numSstIter = Math.round(state.params.sstAdvectionIterations);
  for (let iter = 0; iter < numSstIter; iter++) {
    const snapSST = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) snapSST[i] = P.sst[i];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = ci;
        if (P.isLand[c]) continue;

        const srcX = x - Math.round(clamp(P.currentU[c] * 2, -2, 2));
        const srcY = y - Math.round(clamp(P.currentV[c] * 2, -2, 2));
        const wsx = wrapX(srcX);
        const wsy = clamp(srcY, 0, H - 1);
        const si = wsy * W + wsx;
        if (!P.isLand[si]) {
          P.sst[c] += (snapSST[si] - P.sst[c]) * state.params.sstMixRate;
        }
      }
    }
  }

  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const ci = y * W + x;
      const c = ci;
      if (P.isLand[c]) continue;

      const lat = (y / H) * 180 - 90;
      let isCoastal = false;
      for (let d = 0; d < 4; d++) {
        const nx = wrapX(x + dx4[d]);
        const ny = y + dy4[d];
        if (ny >= 0 && ny < H && P.isLand[ny * W + nx]) {
          isCoastal = true;
          const ekmanU = lat > 0 ? P.windV[c] : -P.windV[c];
          const ekmanV = lat > 0 ? -P.windU[c] : P.windU[c];
          const awayDot = ekmanU * dx4[d] + ekmanV * dy4[d];
          if (awayDot < -0.1) {
            P.sst[c] -= state.params.upwellingCooling * Math.min(1, Math.abs(awayDot));
            P.sst[c] = Math.max(0.15, P.sst[c]);
          }
        }
      }
    }
  }

  for (let i = 0; i < TOTAL; i++) {
    if (!P.isLand[i]) {
      P.sst[i] = Math.max(P.sst[i], state.params.sstFloor);
    }
  }

  // ── Step 4c: Moisture Advection & Precipitation ──
  setStatus('Running precipitation model…');
  await new Promise(r => setTimeout(r, 0));

  const moisture = new Float32Array(TOTAL);
  const precipAccum = new Float32Array(TOTAL);

  let maxWindSpeed = 0.01;
  for (let i = 0; i < TOTAL; i++) {
    if (P.windSpeed[i] > maxWindSpeed) maxWindSpeed = P.windSpeed[i];
  }

  const numMoistIter = Math.round(state.params.moistureIterations);
  for (let iter = 0; iter < numMoistIter; iter++) {
    const snap = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) snap[i] = moisture[i];

    for (let i = 0; i < TOTAL; i++) {
      const c = i;
      if (!P.isLand[c]) {
        const thermalEvap = P.sst[c] * P.sst[c] * state.params.thermalEvapFactor * state.params.atmosphericPressure;
        const windEvap = (P.windSpeed[c] / maxWindSpeed) * P.sst[c] * state.params.windEvapFactor * state.params.atmosphericPressure;
        let evapRate = thermalEvap + windEvap;
        if (evapRate <= 0) {
          evapRate = 0.05;
        }
        moisture[i] += evapRate;
      }
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        let incoming = 0;

        for (let d = 0; d < 8; d++) {
          const nx = wrapX(x + dx8[d]);
          const ny = y + dy8[d];
          if (ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          const nc = ni;
          const tdx = -dx8[d], tdy = -dy8[d];
          const tLen = Math.sqrt(tdx * tdx + tdy * tdy);
          const dot = (P.windU[nc] * tdx + P.windV[nc] * tdy) / tLen;
          if (dot > 0) {
            const transfer = snap[ni] * dot * P.windSpeed[nc] * 0.12;
            incoming += transfer;
          }
        }

        moisture[ci] += incoming;
      }
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = ci;
        let totalOut = 0;
        for (let d = 0; d < 8; d++) {
          const nx = wrapX(x + dx8[d]);
          const ny = y + dy8[d];
          if (ny < 0 || ny >= H) continue;
          const tdx = dx8[d], tdy = dy8[d];
          const tLen = Math.sqrt(tdx * tdx + tdy * tdy);
          const dot = (P.windU[c] * tdx + P.windV[c] * tdy) / tLen;
          if (dot > 0) {
            totalOut += dot * P.windSpeed[c] * 0.12;
          }
        }
        const outRate = Math.min(totalOut, 0.9);
        moisture[ci] -= snap[ci] * outRate;
        if (moisture[ci] < 0) moisture[ci] = 0;
      }
    }

    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = ci;
        if (moisture[ci] <= 0) continue;

        let oroPrecip = 0;
        let convPrecip = 0;

        // Orographic and convective precipitation — LAND ONLY
        if (P.isLand[c]) {
          const xp = wrapX(x + 1), xm = wrapX(x - 1);
          const gradX = (P.elevation[y * W + xp] - P.elevation[y * W + xm]) / 2;
          const gradY = (P.elevation[(y + 1) * W + x] - P.elevation[(y - 1) * W + x]) / 2;

          const uplift = P.windU[c] * gradX + P.windV[c] * gradY;
          if (uplift > 0) {
            const effectiveOroFactor = state.params.oroFactor / state.params.atmosphericPressure;
            oroPrecip = moisture[ci] * uplift * effectiveOroFactor;
          }

          const divU = (P.windU[y * W + xp] - P.windU[y * W + xm]) / 2;
          const divV = (P.windV[(y + 1) * W + x] - P.windV[(y - 1) * W + x]) / 2;
          const div = divU + divV;
          if (div < 0) {
            const effectiveConvFactor = state.params.convFactor / state.params.atmosphericPressure;
            convPrecip = moisture[ci] * (-div) * effectiveConvFactor;
          }
        }

        // Background precipitation — EVERYWHERE (land and ocean)
        // On a humid planet, it rains everywhere. This is the primary
        // moisture drain that keeps the atmosphere in equilibrium.
        const bgPrecip = moisture[ci] * state.params.bgPrecipRate;

        const totalPrecip = Math.min(oroPrecip + convPrecip + bgPrecip, moisture[ci] * 0.8);
        moisture[ci] -= totalPrecip;

        // Only accumulate precipitation stats on land (we care about land rainfall for flora)
        if (P.isLand[c]) {
          precipAccum[ci] += totalPrecip;
        }
      }
    }

    const diffSnap = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) diffSnap[i] = moisture[i];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const xp = wrapX(x + 1), xm = wrapX(x - 1);
        const avg = (diffSnap[y * W + xp] + diffSnap[y * W + xm] +
                     diffSnap[(y - 1) * W + x] + diffSnap[(y + 1) * W + x]) / 4;
        moisture[ci] += (avg - moisture[ci]) * state.params.moistureDiffusion * state.params.atmosphericPressure;
      }
    }

    for (let i = 0; i < TOTAL; i++) {
      if (P.isLand[i] && precipAccum[i] > 0) {
        moisture[i] += precipAccum[i] * 0.02 * state.params.atmosphericPressure;
      }
    }
  }

  for (let i = 0; i < TOTAL; i++) {
    if (P.isLand[i]) {
      const elevProxy = 1.0 - Math.min(P.elevation[i] * 5, 1);
      const minMoisture = elevProxy * 0.15 * state.params.atmosphericPressure;
      if (moisture[i] < minMoisture) moisture[i] = minMoisture;
    }
  }

  // Collect all nonzero land precipitation values
  const landPrecipValues = [];
  for (let i = 0; i < TOTAL; i++) {
    if (P.isLand[i] && precipAccum[i] > 0) {
      landPrecipValues.push(precipAccum[i]);
    }
  }

  let precipScale;
  if (landPrecipValues.length > 0) {
    // Sort and use 95th percentile as the reference maximum
    // This prevents a single extreme windward cell from crushing everything
    landPrecipValues.sort((a, b) => a - b);
    const p95Index = Math.floor(landPrecipValues.length * 0.95);
    precipScale = landPrecipValues[p95Index] || 0.001;
  } else {
    precipScale = 0.001;
  }

  for (let i = 0; i < TOTAL; i++) {
    P.precipitation[i] = P.isLand[i]
      ? clamp(precipAccum[i] / precipScale, 0, 1)
      : 0;
    P.atmosphericMoisture[i] = clamp(
      moisture[i] / (precipScale * 0.5 + 0.001), 0, 1
    );
  }

  // ── Step 4d: Groundwater ──
  setStatus('Computing groundwater…');
  await new Promise(r => setTimeout(r, 0));

  for (let i = 0; i < TOTAL; i++) {
    const c = i;
    if (!P.isLand[c]) {
      P.groundwater[c] = 1.0;
      continue;
    }

    const coastalBase = P.elevation[c] < state.params.coastalThreshold
        ? (1.0 - P.elevation[c] / state.params.coastalThreshold) * state.params.coastalGroundwater
        : 0;

    const recharge = P.precipitation[c] * state.params.groundwaterRecharge;
    const geothermal = P.volcanism[c] * state.params.groundwaterGeothermal;
    const depthPenalty = Math.max(0, P.elevation[c] - 0.05) * state.params.groundwaterDepthFactor;

    P.groundwater[c] = clamp(coastalBase + recharge + geothermal - depthPenalty, 0, 1);
  }

  // ── Step 4e: Drainage Accumulation ──
  setStatus('Computing drainage…');
  await new Promise(r => setTimeout(r, 0));

  const landIndices = [];
  for (let i = 0; i < TOTAL; i++) {
    if (P.isLand[i]) landIndices.push(i);
  }
  landIndices.sort((a, b) => P.elevation[b] - P.elevation[a]);

  const flowAccum = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    flowAccum[i] = P.isLand[i] ? P.precipitation[i] : 0;
  }
  for (const ci of landIndices) {
    const cx = ci % W;
    const cy = (ci / W) | 0;
    const elev = P.elevation[ci];

    let lowestIdx = -1, lowestElev = elev;
    for (let d = 0; d < 8; d++) {
      const nx = wrapX(cx + dx8[d]);
      const ny = cy + dy8[d];
      if (ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (P.elevation[ni] < lowestElev) {
        lowestElev = P.elevation[ni];
        lowestIdx = ni;
      }
    }
    if (lowestIdx >= 0) {
      flowAccum[lowestIdx] += flowAccum[ci];
    }
  }

  for (let i = 0; i < TOTAL; i++) {
    P.drainage[i] = P.isLand[i] ?
      clamp(Math.log(1 + flowAccum[i]) * state.params.hydDrainageScale, 0, state.params.hydDrainageCap) : 0;
  }

  // ── Step 4f: Water Availability ──
  for (let i = 0; i < TOTAL; i++) {
    const c = i;
    if (P.isLand[c]) {
      P.waterAvailability[c] = clamp(
          P.precipitation[c] * 0.7 + P.groundwater[c] * 0.3 + P.drainage[c],
          0, 1
      );
      const elevPenalty = Math.max(0, P.elevation[c] - 0.05) * 3.0;
      const minWater = Math.max(0, 0.15 - elevPenalty) * state.params.atmosphericPressure;
      P.waterAvailability[c] = Math.max(P.waterAvailability[c], minWater);
    } else {
      P.waterAvailability[c] = 1.0;
    }
  }

  // Temperature
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ci = y * W + x;
      const c = ci;
      const latFrac = Math.abs(y - 128) / 128;
      const baseTemp = 1.0 - latFrac * 0.4;
      const elevCooling = Math.max(0, P.elevation[c]) * 0.3;
      P.temperature[c] = clamp(baseTemp - elevCooling, 0.4, 1.0);
      P.isFreezing[c] = P.temperature[c] < 0.5;
    }
  }
}

export { step4_computeAtmosphere };
