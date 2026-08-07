// ══════════════════════════════════════════════════════════════════
// ── planet-atmosphere.js — Wind, currents, SST, precipitation, hydrology
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import { W, H, TOTAL, clamp, wrapX, smoothstep } from './core-math.js';

// ── Step 4: Hydrological System ──
function step4_computeAtmosphere(seed, rng) {
  const statusEl = document.getElementById('statusText');

  // ── Step 4a: Wind Vector Field ──
  statusEl.textContent = 'Generating wind field…';

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
      const c = state.cells[y * W + x];
      c.windU = u;

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

      c.windV = v;
      c.windSpeed = spd;
    }
  }

  // Topographic deflection (iterative passes)
  for (let pass = 0; pass < state.params.windDeflectionPasses; pass++) {
    const snapU = new Float32Array(TOTAL);
    const snapV = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      snapU[i] = state.cells[i].windU;
      snapV[i] = state.cells[i].windV;
    }

    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = state.cells[ci];
        if (!c.isLand) continue;

        const xp = wrapX(x + 1), xm = wrapX(x - 1);
        const gradX = (state.cells[y * W + xp].elevation - state.cells[y * W + xm].elevation) / 2;
        const gradY = (state.cells[(y + 1) * W + x].elevation - state.cells[(y - 1) * W + x].elevation) / 2;
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

        c.windU -= windAlongGradU * block;
        c.windV -= windAlongGradV * block;

        c.windU += (-gradY) * block * state.params.windDeflectionFactor;
        c.windV += gradX * block * state.params.windDeflectionFactor;
      }
    }

    for (let i = 0; i < TOTAL; i++) {
      state.cells[i].windSpeed = Math.sqrt(state.cells[i].windU * state.cells[i].windU + state.cells[i].windV * state.cells[i].windV);
    }
  }

  // ── Step 4b: Ocean Currents ──
  statusEl.textContent = 'Computing ocean currents…';

  const numCurrentIter = Math.round(state.params.currentIterations);
  for (let iter = 0; iter < numCurrentIter; iter++) {
    const snapCU = new Float32Array(TOTAL);
    const snapCV = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      snapCU[i] = state.cells[i].currentU;
      snapCV[i] = state.cells[i].currentV;
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = state.cells[ci];
        if (c.isLand) continue;

        c.currentU += c.windU * state.params.currentStressCoeff;
        c.currentV += c.windV * state.params.currentStressCoeff;

        const lat = (y / H) * 180 - 90;
        const latRad = lat * Math.PI / 180;
        const f = Math.sin(latRad);
        const angle = f * state.params.currentCoriolisStrength;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const newU = c.currentU * cosA - c.currentV * sinA;
        const newV = c.currentU * sinA + c.currentV * cosA;
        c.currentU = newU;
        c.currentV = newV;

        const dx4 = [1, -1, 0, 0];
        const dy4 = [0, 0, -1, 1];
        for (let d = 0; d < 4; d++) {
          const nx = wrapX(x + dx4[d]);
          const ny = y + dy4[d];
          if (ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (state.cells[ni].isLand) {
            const ldx = dx4[d], ldy = dy4[d];
            const towardLand = c.currentU * ldx + c.currentV * ldy;
            if (towardLand > 0) {
              c.currentU -= towardLand * ldx;
              c.currentV -= towardLand * ldy;
              c.currentU += (-ldy) * towardLand * 0.5;
              c.currentV += ldx * towardLand * 0.5;
            }
          }
        }

        const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
        const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
        let totalInflowU = 0, totalInflowV = 0;
        for (let d = 0; d < 8; d++) {
          const nx = wrapX(x + dx8[d]);
          const ny = y + dy8[d];
          if (ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (state.cells[ni].isLand) continue;
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
        c.currentU += totalInflowU;
        c.currentV += totalInflowV;

        c.currentU *= (1.0 - state.params.currentFriction);
        c.currentV *= (1.0 - state.params.currentFriction);

        const speed = Math.sqrt(c.currentU * c.currentU + c.currentV * c.currentV);
        if (speed > state.params.maxCurrentSpeed) {
          c.currentU *= state.params.maxCurrentSpeed / speed;
          c.currentV *= state.params.maxCurrentSpeed / speed;
        }
      }
    }
  }

  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    c.currentSpeed = Math.sqrt(c.currentU * c.currentU + c.currentV * c.currentV);
  }

  for (let y = 0; y < H; y++) {
    const lat = (y / H) * 180 - 90;
    const absLat = Math.abs(lat);
    const baseSst = 1.0 - (absLat / 90) * 0.6;
    for (let x = 0; x < W; x++) {
      const c = state.cells[y * W + x];
      if (!c.isLand) {
        c.sst = baseSst;
      }
    }
  }

  const numSstIter = Math.round(state.params.sstAdvectionIterations);
  for (let iter = 0; iter < numSstIter; iter++) {
    const snapSST = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) snapSST[i] = state.cells[i].sst;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = state.cells[ci];
        if (c.isLand) continue;

        const srcX = x - Math.round(clamp(c.currentU * 2, -2, 2));
        const srcY = y - Math.round(clamp(c.currentV * 2, -2, 2));
        const wsx = wrapX(srcX);
        const wsy = clamp(srcY, 0, H - 1);
        const si = wsy * W + wsx;
        if (!state.cells[si].isLand) {
          c.sst += (snapSST[si] - c.sst) * state.params.sstMixRate;
        }
      }
    }
  }

  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const ci = y * W + x;
      const c = state.cells[ci];
      if (c.isLand) continue;

      const lat = (y / H) * 180 - 90;
      const dx4 = [1, -1, 0, 0];
      const dy4 = [0, 0, -1, 1];
      let isCoastal = false;
      for (let d = 0; d < 4; d++) {
        const nx = wrapX(x + dx4[d]);
        const ny = y + dy4[d];
        if (ny >= 0 && ny < H && state.cells[ny * W + nx].isLand) {
          isCoastal = true;
          const ekmanU = lat > 0 ? c.windV : -c.windV;
          const ekmanV = lat > 0 ? -c.windU : c.windU;
          const awayDot = ekmanU * dx4[d] + ekmanV * dy4[d];
          if (awayDot < -0.1) {
            c.sst -= state.params.upwellingCooling * Math.min(1, Math.abs(awayDot));
            c.sst = Math.max(0.15, c.sst);
          }
        }
      }
    }
  }

  for (let i = 0; i < TOTAL; i++) {
    if (!state.cells[i].isLand) {
      state.cells[i].sst = Math.max(state.cells[i].sst, state.params.sstFloor);
    }
  }

  // ── Step 4c: Moisture Advection & Precipitation ──
  statusEl.textContent = 'Running precipitation model…';

  const moisture = new Float32Array(TOTAL);
  const precipAccum = new Float32Array(TOTAL);

  let maxWindSpeed = 0.01;
  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].windSpeed > maxWindSpeed) maxWindSpeed = state.cells[i].windSpeed;
  }

  const numMoistIter = Math.round(state.params.moistureIterations);
  for (let iter = 0; iter < numMoistIter; iter++) {
    const snap = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) snap[i] = moisture[i];

    for (let i = 0; i < TOTAL; i++) {
      const c = state.cells[i];
      if (!c.isLand) {
        const thermalEvap = c.sst * c.sst * state.params.thermalEvapFactor * state.params.atmosphericPressure;
        const windEvap = (c.windSpeed / maxWindSpeed) * c.sst * state.params.windEvapFactor * state.params.atmosphericPressure;
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
        const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
        const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
        let incoming = 0;

        for (let d = 0; d < 8; d++) {
          const nx = wrapX(x + dx8[d]);
          const ny = y + dy8[d];
          if (ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          const nc = state.cells[ni];
          const tdx = -dx8[d], tdy = -dy8[d];
          const tLen = Math.sqrt(tdx * tdx + tdy * tdy);
          const dot = (nc.windU * tdx + nc.windV * tdy) / tLen;
          if (dot > 0) {
            const transfer = snap[ni] * dot * nc.windSpeed * 0.12;
            incoming += transfer;
          }
        }

        moisture[ci] += incoming;
      }
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = state.cells[ci];
        const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
        const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
        let totalOut = 0;
        for (let d = 0; d < 8; d++) {
          const nx = wrapX(x + dx8[d]);
          const ny = y + dy8[d];
          if (ny < 0 || ny >= H) continue;
          const tdx = dx8[d], tdy = dy8[d];
          const tLen = Math.sqrt(tdx * tdx + tdy * tdy);
          const dot = (c.windU * tdx + c.windV * tdy) / tLen;
          if (dot > 0) {
            totalOut += dot * c.windSpeed * 0.12;
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
        const c = state.cells[ci];
        if (moisture[ci] <= 0) continue;

        let oroPrecip = 0;
        let convPrecip = 0;

        // Orographic and convective precipitation — LAND ONLY
        if (c.isLand) {
          const xp = wrapX(x + 1), xm = wrapX(x - 1);
          const gradX = (state.cells[y * W + xp].elevation - state.cells[y * W + xm].elevation) / 2;
          const gradY = (state.cells[(y + 1) * W + x].elevation - state.cells[(y - 1) * W + x].elevation) / 2;

          const uplift = c.windU * gradX + c.windV * gradY;
          if (uplift > 0) {
            const effectiveOroFactor = state.params.oroFactor / state.params.atmosphericPressure;
            oroPrecip = moisture[ci] * uplift * effectiveOroFactor;
          }

          const divU = (state.cells[y * W + xp].windU - state.cells[y * W + xm].windU) / 2;
          const divV = (state.cells[(y + 1) * W + x].windV - state.cells[(y - 1) * W + x].windV) / 2;
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
        if (c.isLand) {
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
      if (state.cells[i].isLand && precipAccum[i] > 0) {
        moisture[i] += precipAccum[i] * 0.02 * state.params.atmosphericPressure;
      }
    }
  }

  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].isLand) {
      const elevProxy = 1.0 - Math.min(state.cells[i].elevation * 5, 1);
      const minMoisture = elevProxy * 0.15 * state.params.atmosphericPressure;
      if (moisture[i] < minMoisture) moisture[i] = minMoisture;
    }
  }

  // Collect all nonzero land precipitation values
  const landPrecipValues = [];
  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].isLand && precipAccum[i] > 0) {
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
    state.cells[i].precipitation = state.cells[i].isLand
      ? clamp(precipAccum[i] / precipScale, 0, 1)
      : 0;
    state.cells[i].atmosphericMoisture = clamp(
      moisture[i] / (precipScale * 0.5 + 0.001), 0, 1
    );
    state.cells[i].moisture = state.cells[i].precipitation;
    state.cells[i].baseMoisture = state.cells[i].precipitation;
  }

  // ── Step 4d: Groundwater ──
  statusEl.textContent = 'Computing groundwater…';

  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    if (!c.isLand) {
      c.groundwater = 1.0;
      continue;
    }

    const coastalBase = c.elevation < state.params.coastalThreshold
        ? (1.0 - c.elevation / state.params.coastalThreshold) * state.params.coastalGroundwater
        : 0;

    const recharge = c.precipitation * state.params.groundwaterRecharge;
    const geothermal = c.volcanism * state.params.groundwaterGeothermal;
    const depthPenalty = Math.max(0, c.elevation - 0.05) * state.params.groundwaterDepthFactor;

    c.groundwater = clamp(coastalBase + recharge + geothermal - depthPenalty, 0, 1);
  }

  // ── Step 4e: Drainage Accumulation ──
  statusEl.textContent = 'Computing drainage…';

  const landIndices = [];
  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].isLand) landIndices.push(i);
  }
  landIndices.sort((a, b) => state.cells[b].elevation - state.cells[a].elevation);

  const flowAccum = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    flowAccum[i] = state.cells[i].isLand ? state.cells[i].precipitation : 0;
  }

  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
  for (const ci of landIndices) {
    const cx = ci % W;
    const cy = (ci / W) | 0;
    const elev = state.cells[ci].elevation;

    let lowestIdx = -1, lowestElev = elev;
    for (let d = 0; d < 8; d++) {
      const nx = wrapX(cx + dx8[d]);
      const ny = cy + dy8[d];
      if (ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (state.cells[ni].elevation < lowestElev) {
        lowestElev = state.cells[ni].elevation;
        lowestIdx = ni;
      }
    }
    if (lowestIdx >= 0) {
      flowAccum[lowestIdx] += flowAccum[ci];
    }
  }

  for (let i = 0; i < TOTAL; i++) {
    state.cells[i].drainage = state.cells[i].isLand ?
      clamp(Math.log(1 + flowAccum[i]) * state.params.hydDrainageScale, 0, state.params.hydDrainageCap) : 0;
  }

  // ── Step 4f: Water Availability ──
  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    if (c.isLand) {
      c.waterAvailability = clamp(
          c.precipitation * 0.7 + c.groundwater * 0.3 + c.drainage,
          0, 1
      );
      const elevPenalty = Math.max(0, c.elevation - 0.05) * 3.0;
      const minWater = Math.max(0, 0.15 - elevPenalty) * state.params.atmosphericPressure;
      c.waterAvailability = Math.max(c.waterAvailability, minWater);
    } else {
      c.waterAvailability = 1.0;
    }
    c.moisture = c.waterAvailability;
  }

  // Temperature
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ci = y * W + x;
      const c = state.cells[ci];
      const latFrac = Math.abs(y - 128) / 128;
      const baseTemp = 1.0 - latFrac * 0.4;
      const elevCooling = Math.max(0, c.elevation) * 0.3;
      c.temperature = clamp(baseTemp - elevCooling, 0.4, 1.0);
      c.isFreezing = c.temperature < 0.5;
    }
  }
}

export { step4_computeAtmosphere };
