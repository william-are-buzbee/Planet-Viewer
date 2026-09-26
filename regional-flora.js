// ══════════════════════════════════════════════════════════════════
// ── regional-flora.js — Flora type, ground cover, canopy, WTD water
// ══════════════════════════════════════════════════════════════════

import { clamp, smoothstep } from './core-math.js';
import { FT_BARREN, FT_PHOTO, FT_CHEMO, FT_MIXO, FT_NONE, FT_FROZEN } from './regional-grid.js';

function clearFlora(g, i, type) {
  g.floraType[i] = type;
  g.floraDensity[i] = 0;
  g.canopy[i] = 0;
  g.groundCover[i] = 0;
  g.chemoCrust[i] = 0;
  g.organicContent[i] = 0;
  g.pelaConf[i] = 0;
  g.kolmConf[i] = 0;
}

// ── Refine flora from the (possibly drainage-modified) state ──
//    Ground cover, canopy, chemo crust and organic content are recomputed with
//    the SAME formulas the high-res grid used (stepHR6), so a ridge cell whose
//    saturation/grain were left at the high-res base reproduces the high-res
//    flora exactly. Channel cells differ because their inputs changed. Flora
//    TYPE is inherited from the hi-res grid (sampled in regional Pass 1c with
//    ocean corners masked): re-deriving it here disagreed with the hi-res
//    pipeline in transition zones because the two sampled minerals differently.
function refineRegionalFloraFromHiRes(g, i) {
  if (!g.isLand[i])     { clearFlora(g, i, FT_NONE);   return; }
  if (g.isFreezing[i])  { clearFlora(g, i, FT_FROZEN); return; }

  const ft = g.hrFloraType[i];
  g.floraType[i] = ft;

  // ── Fitness confidence: how well the local (regional) physics supports the
  //    inherited type. Same fitness formulas as the planetary / hi-res steps.
  //    pela (ground cover) is hardier than kolm (canopy), so they taper at
  //    different rates near type boundaries.
  let pelaConf = 0, kolmConf = 0;
  if (ft === FT_PHOTO || ft === FT_CHEMO || ft === FT_MIXO) {
    const waterMetric = Math.max(g.saturation[i], g.waterAvailability[i]);
    const mineralTotal = g.mineralTotal[i];
    const volc = g.volcanism[i];
    const photoFit = waterMetric * 0.8;
    const chemoFit = mineralTotal * Math.max(waterMetric, volc * 1.5) * 1.2;
    const mixoFit  = (0.6 + 0.5 * mineralTotal) * waterMetric;
    const barrenThreshold = 0.02;

    let assigned, altA, altB;
    if (ft === FT_PHOTO)      { assigned = photoFit; altA = chemoFit; altB = mixoFit; }
    else if (ft === FT_CHEMO) { assigned = chemoFit; altA = photoFit; altB = mixoFit; }
    else                      { assigned = mixoFit;  altA = photoFit; altB = chemoFit; }

    const marginOverBarren = assigned - barrenThreshold;
    const marginOverAlternative = assigned - Math.max(altA, altB, barrenThreshold);
    const effectiveMargin = Math.min(marginOverBarren, marginOverAlternative);
    pelaConf = smoothstep(0.0, 0.10, effectiveMargin);
    kolmConf = smoothstep(0.03, 0.18, effectiveMargin);
  }
  g.pelaConf[i] = pelaConf;
  g.kolmConf[i] = kolmConf;

  // Barren cells have no living cover
  if (ft === FT_BARREN) { clearFlora(g, i, FT_BARREN); return; }

  if (g.hasWater[i]) {
    // Water prevents rooted canopy but NOT ground-level biology: shallow water
    // supports a floating mat, deep water submerges it.
    g.canopy[i] = 0;
    const wd = g.waterDepth[i];
    let gc, cc;
    if (wd > 0.3)      { gc = 0; cc = 0; }
    else if (wd > 0.1) { gc = g.hrGroundCover[i] * 0.3; cc = g.hrChemoCrust[i] * 0.2; }
    else               { gc = g.hrGroundCover[i] * 0.6; cc = g.hrChemoCrust[i] * 0.5; }
    gc *= pelaConf;
    cc *= pelaConf;
    g.groundCover[i] = gc;
    g.chemoCrust[i] = cc;
    g.organicContent[i] = gc * 0.5 * 0.7;   // waterlogged: slow decomposition, organic accumulates
    g.floraDensity[i] = clamp(Math.max(gc, cc), 0, 1);
    return;
  }

  const sat = g.saturation[i];
  const grain = g.grainSize[i];
  const precip = g.precipitation[i];
  const gw = g.groundwater[i];
  const volc = g.volcanism[i];
  const mineralTotal = g.mineralTotal[i];
  const hasWaterLocal = g.waterTableDepth[i] < -0.01;
  const waterFactor = Math.min(1, precip * 2.0 + gw * 1.0);

  // Ground cover (mirrors stepHR6) — scaled by water availability
  let gc;
  if (hasWaterLocal) gc = 0.3;
  else if (grain > 0.8) gc = 0.08;
  else gc = (0.5 + (1.0 - grain) * 0.4) * waterFactor;

  // Canopy (mirrors stepHR6)
  let cd = 0;
  if (!hasWaterLocal && grain <= 0.7) {
    const wetPenalty = smoothstep(0.4, 1.0, sat);
    const dryPenalty = 1.0 - smoothstep(0.05, 0.35, sat);
    const satFactor = Math.max(0.25, 1.0 - 0.65 * wetPenalty - 0.55 * dryPenalty);
    const subFactor = grain < 0.5 ? 1.0 : Math.max(0, 1.0 - (grain - 0.5) * 3.0);
    cd = waterFactor * satFactor * subFactor;
    if (waterFactor > 0.05 && subFactor > 0.1) cd = Math.max(cd, 0.12);
  }

  // Chemo crust (mirrors stepHR6)
  let cc = 0;
  if (mineralTotal > 0.4) {
    const cf = mineralTotal * Math.max(sat, volc * 1.5);
    const pf = gc * 0.8;
    if (cf > pf) {
      cc = Math.min(1, (cf - pf) * 2.0);
      gc *= (1 - cc * 0.6);
    }
  }

  gc *= pelaConf;
  cd *= kolmConf;

  g.groundCover[i] = gc;
  g.canopy[i] = cd;
  g.chemoCrust[i] = cc;
  g.floraDensity[i] = clamp(Math.max(cd, gc), 0, 1);
  g.organicContent[i] = (gc + cd) * 0.5 * (sat > 0.7 ? 0.7 : 0.3);
}

// ── Derive water state from water table depth (metres) ──
//    Channels have negative WTD (water table above the surface), ridges
//    positive. Must run AFTER substrate (WTD) and flora (canopy, groundCover)
//    and BEFORE terrain derivation, which reads the flood-modulated canopy.
function deriveWTDWater(g) {
  const N = g.N;
  for (let i = 0; i < N; i++) {
    if (!g.isLand[i]) {
      g.waterDepth[i] = Math.max(0, -g.elevation[i]);
      g.hasWater[i] = 1;
      g.pelaRaft[i] = 0;
      g.kolmRelict[i] = 0;
      g.wetness[i] = 1.0;
      g.baseCanopy[i] = g.canopy[i];
      continue;
    }

    const wtd = g.waterTableDepth[i];
    const depth = Math.max(0, -wtd);
    g.waterDepth[i] = depth;

    // 0.02 m minimum filters noise-floor artefacts; SHALLOW_WATER_TERRAIN_THRESHOLD
    // (0.05 m) in deriveTerrainAndCover decides whether it RENDERS as water.
    g.hasWater[i] = depth > 0.02 ? 1 : 0;

    // Continuous wetness for the palette: 0 at WTD ≥ 0.04 (dry), 1 at WTD ≤ −0.03
    g.wetness[i] = 1.0 - smoothstep(-0.03, 0.04, wtd);

    // Base canopy before flood modulation (for kolm relicts)
    const baseCanopy = g.canopy[i];
    g.baseCanopy[i] = baseCanopy;

    // Flood-kill: living canopy declines from WTD −0.03, gone by −0.12
    if (wtd < -0.03) g.canopy[i] = baseCanopy * smoothstep(-0.12, -0.03, wtd);

    // Pela raft: floating photosynthetic mat, photo/mixo only. Peak at depth
    // 0.02–0.06, declining 0.06–0.18, gone by 0.18.
    const ft = g.floraType[i];
    if (depth > 0 && (ft === FT_PHOTO || ft === FT_MIXO)) {
      const onset   = smoothstep(0.0, 0.02, depth);
      const decline = 1.0 - smoothstep(0.06, 0.18, depth);
      g.pelaRaft[i] = onset * decline * 0.75 * Math.min(1.0, g.groundCover[i] * 1.5) * g.pelaConf[i];
    } else {
      g.pelaRaft[i] = 0;
    }

    // Kolm relicts: dead steles appear from WTD −0.03, full by −0.08, erode
    // −0.15 … −0.25.
    if (wtd < -0.03) {
      const appear = 1.0 - smoothstep(-0.08, -0.03, wtd);
      const erode  = smoothstep(-0.25, -0.15, wtd);
      g.kolmRelict[i] = baseCanopy * 0.8 * appear * erode;
    } else {
      g.kolmRelict[i] = 0;
    }
  }
}

export { refineRegionalFloraFromHiRes, deriveWTDWater };
