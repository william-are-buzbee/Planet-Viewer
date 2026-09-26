// ══════════════════════════════════════════════════════════════════
// ── regional-flora.js — Flora type, ground cover, canopy, WTD water
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import { clamp, smoothstep } from './core-math.js';

// ── Refine flora from the (possibly drainage-modified) state ──
//    Ground cover, canopy, chemo crust and organic content are recomputed with
//    the SAME formulas the high-res grid used (stepHR6), so a ridge cell whose
//    saturation/grain were left at the high-res base reproduces the high-res
//    flora exactly. Channel cells differ because their inputs changed. Flora
//    *type* (photo/chemo/mixo/barren) is inherited from the high-res grid.
function refineRegionalFloraFromHiRes(cell) {
  if (!cell.isLand) {
    cell.floraType = 'none'; cell.floraDensity = 0;
    cell.canopy = 0; cell.groundCover = 0;
    cell.chemoCrust = 0; cell.organicContent = 0;
    return;
  }
  if (cell.isFreezing) {
    cell.floraType = 'frozen'; cell.floraDensity = 0;
    cell.canopy = 0; cell.groundCover = 0;
    cell.chemoCrust = 0; cell.organicContent = 0;
    return;
  }

  // FIX 1: flora type inheritance — inherit from hi-res grid instead of
  // re-deriving. Re-derivation disagrees with the hi-res pipeline due to
  // mineral sampling differences (regional domain-warps the coordinates,
  // hi-res does not), causing photo/chemo disagreements in transition zones.

  if (state.hiResData) {
    // R2-FIX1: flora type already determined during Pass 1c via weighted
    // probabilistic sampling from the four surrounding hi-res cells.
    // No re-sampling or boundary jitter needed here.
    cell.floraType = cell._hrFloraType;
  } else {
    // LowRes fallback: no hi-res grid available, use fitness competition.
    // This path is less critical since low-res mode doesn't show the
    // globe/regional disagreement.
    computeRegionalFloraCell(cell);
    // computeRegionalFloraCell sets canopy/groundCover/etc. too — return
    // early to avoid overwriting those downstream values.
    return;
  }

  // ── From here, flora type is already set per cell above ──

  // ── S24: Fitness-confidence computation ──
  // Compute how well the local (regional) physics supports the assigned flora type.
  // Uses the same fitness formulas as computeRegionalFloraCell (LowRes path).
  {
    const waterMetric = Math.max(cell.saturation, cell.waterAvailability || 0);
    const _mineralTotal = cell.mineralTotal;
    const _volc = cell.volcanism || 0;

    const _photoFit = waterMetric * 0.8;
    const _chemoFit = _mineralTotal * Math.max(waterMetric, _volc * 1.5) * 1.2;
    const _mixoFit  = (0.6 + 0.5 * _mineralTotal) * waterMetric;

    let floraTypeNum;
    if (cell.floraType === 'photosynthetic') floraTypeNum = 1;
    else if (cell.floraType === 'chemotrophic') floraTypeNum = 2;
    else if (cell.floraType === 'mixotrophic') floraTypeNum = 3;
    else floraTypeNum = 0;

    let assignedFitness;
    if (floraTypeNum === 1) assignedFitness = _photoFit;
    else if (floraTypeNum === 2) assignedFitness = _chemoFit;
    else if (floraTypeNum === 3) assignedFitness = _mixoFit;
    else assignedFitness = 0;

    const _barrenThreshold = 0.02;

    if (floraTypeNum === 0) {
      cell.fitnessConfidence = 1.0;
      cell.pelaConf = 0;
      cell.kolmConf = 0;
    } else {
      const marginOverBarren = assignedFitness - _barrenThreshold;
      const allFit = [_photoFit, _chemoFit, _mixoFit];
      const alternatives = allFit.filter((_, i) => i !== (floraTypeNum - 1));
      const bestAlternative = Math.max(...alternatives, _barrenThreshold);
      const marginOverAlternative = assignedFitness - bestAlternative;
      const effectiveMargin = Math.min(marginOverBarren, marginOverAlternative);

      const marginFull = 0.12;
      const t = Math.max(0, Math.min(1, effectiveMargin / marginFull));
      cell.fitnessConfidence = t * t * (3 - 2 * t);

      cell.pelaConf = smoothstep(0.0, 0.10, effectiveMargin);
      cell.kolmConf = smoothstep(0.03, 0.18, effectiveMargin);
    }
  }

  // R3-FIX2: barren gates canopy
  // Barren cells have no living cover — skip all canopy/groundCover computation
  if (cell.floraType === 'barren') {
    cell.groundCover = 0;
    cell.canopy = 0;
    cell.chemoCrust = 0;
    cell.organicContent = 0;
    cell.floraDensity = 0;
    return;
  }

  if (cell.hasWater) {
    // Water prevents rooted canopy but NOT ground-level biology.
    // Flora type was already re-derived above — water doesn't
    // change what KIND of organisms live here, just their structure.
    // Ground cover: shallow water supports floating mat; deep water
    // submerges it. Canopy: always zero (can't root in standing water).
    cell.canopy = 0;

    const wd = cell.waterDepth || 0;
    if (wd > 0.3) {
        // Deep water: fully submerged, no surface flora
        cell.groundCover = 0;
        cell.chemoCrust = 0;
    } else if (wd > 0.1) {
        // Moderate water: sparse floating mat
        cell.groundCover = cell._hrGroundCover * 0.3;
        cell.chemoCrust = cell._hrChemoCrust * 0.2;
    } else {
        // Shallow water or wet surface: substantial floating mat
        cell.groundCover = cell._hrGroundCover * 0.6;
        cell.chemoCrust = cell._hrChemoCrust * 0.5;
    }

    // S24: Apply fitness-confidence modulation to water path
    cell.groundCover *= cell.pelaConf;
    cell.chemoCrust *= cell.pelaConf;

    // Organic content: waterlogged decomposition is slow → organic accumulates
    const prod = cell.groundCover * 0.5;
    cell.organicContent = prod * 0.7;  // wet = slow decomposition

    cell.floraDensity = clamp(Math.max(cell.groundCover, cell.chemoCrust), 0, 1);
    return;
  }

  const sat = cell.saturation;
  const grain = cell.grainSize;
  const precip = cell.precipitation;
  const gw = cell.groundwater;
  const volc = cell.volcanism || 0;
  const mineralTotal = cell.mineralTotal;
  const hasWaterLocal = cell.waterTableDepth < -0.01;

  // Ground cover (mirrors stepHR6) — scaled by water availability
  let gc;
  if (hasWaterLocal) gc = 0.3;
  else if (grain > 0.8) gc = 0.08;
  else {
    const waterFactor = Math.min(1, precip * 2.0 + gw * 1.0); // R1-FIX2: unified waterFactor
    gc = (0.5 + (1.0 - grain) * 0.4) * waterFactor;
  }
  cell.groundCover = gc;

  // Canopy (mirrors stepHR6)
  let cd = 0;
  if (!hasWaterLocal && grain <= 0.7) {
    const waterFactor = Math.min(1, precip * 2.0 + gw * 1.0); // R1-FIX2: unified waterFactor
    // R1-FIX1: smooth saturation factor
    const wetPenalty = smoothstep(0.4, 1.0, sat);
    const dryPenalty = 1.0 - smoothstep(0.05, 0.35, sat);
    const satFactor = Math.max(0.25, 1.0 - 0.65 * wetPenalty - 0.55 * dryPenalty);
    const subFactor = grain < 0.5 ? 1.0 : Math.max(0, 1.0 - (grain - 0.5) * 3.0);
    cd = waterFactor * satFactor * subFactor;
    if (waterFactor > 0.05 && subFactor > 0.1) cd = Math.max(cd, 0.12);
  }
  cell.canopy = cd;

  // Chemo crust (mirrors stepHR6) — uses unwarped cell.mineralTotal
  let cc = 0;
  if (mineralTotal > 0.4) {
    const cf = mineralTotal * Math.max(sat, volc * 1.5);
    const pf = gc * 0.8;
    if (cf > pf) {
      cc = Math.min(1, (cf - pf) * 2.0);
      cell.groundCover *= (1 - cc * 0.6);
    }
  }
  cell.chemoCrust = cc;

  // S24: Apply fitness-confidence modulation — pela (ground cover) is hardier
  // than kolm (canopy), so they taper at different rates near boundaries.
  cell.groundCover *= cell.pelaConf;
  cell.canopy *= cell.kolmConf;

  // Density for the flora overlay, from the refined cover values.
  cell.floraDensity = clamp(Math.max(cell.canopy, cell.groundCover), 0, 1);

  // Organic content (mirrors stepHR6)
  const prod = (cell.groundCover + cell.canopy) * 0.5;
  cell.organicContent = prod * (sat > 0.7 ? 0.7 : 0.3);
}

// ── Regional flora ──
function computeRegionalFloraCell(cell) {
  if (!cell.isLand) { cell.floraType = 'none'; cell.floraDensity = 0; return; }
  if (cell.isFreezing) { cell.floraType = 'frozen'; cell.floraDensity = 0; return; }
  if (cell.hasWater) {
    // Same graduated response as refineRegionalFloraFromHiRes:
    // water prevents rooted canopy, but floating mat persists in shallows.
    cell.canopy = 0;
    const wd = cell.waterDepth || 0;
    if (wd > 0.3) {
        cell.groundCover = 0;
        cell.chemoCrust = 0;
        cell.floraDensity = 0;
    } else if (wd > 0.1) {
        cell.groundCover = 0.2;
        cell.chemoCrust = 0;
        cell.floraDensity = 0.2;
    } else {
        cell.groundCover = 0.4;
        cell.chemoCrust = 0;
        cell.floraDensity = 0.4;
    }
    // Flora type: compute from fitness as normal (don't skip to 'none')
    const water = Math.max(cell.saturation, cell.waterAvailability);
    const photoFitness = water * 0.8; // R1-FIX4A: removed elevation penalty, coefficient 0.8 matches planetary/hi-res
    const chemoFitness = cell.mineralTotal * Math.max(water, (cell.volcanism || 0) * 1.5) * 1.2; // R1-FIX3: volcanism, not groundwater
    const mixoFitness  = (0.6 + 0.5 * cell.mineralTotal) * water;
    if (chemoFitness > photoFitness && chemoFitness > 0.02) { // R1-FIX4B: barren threshold 0.02
        cell.floraType = 'chemotrophic';
    } else if (photoFitness > 0.02) { // R1-FIX4B: barren threshold 0.02
        cell.floraType = 'photosynthetic';
    } else {
        cell.floraType = 'barren';
    }
    // S24: Compute and apply fitness-confidence for water path
    {
      let ftNum;
      if (cell.floraType === 'photosynthetic') ftNum = 1;
      else if (cell.floraType === 'chemotrophic') ftNum = 2;
      else if (cell.floraType === 'mixotrophic') ftNum = 3;
      else ftNum = 0;
      if (ftNum === 0) {
        cell.fitnessConfidence = 1.0; cell.pelaConf = 0; cell.kolmConf = 0;
      } else {
        const aFit = ftNum === 1 ? photoFitness : ftNum === 2 ? chemoFitness : mixoFitness;
        const alts = [photoFitness, chemoFitness, mixoFitness].filter((_, i) => i !== (ftNum - 1));
        const bestAlt = Math.max(...alts, 0.02);
        const em = Math.min(aFit - 0.02, aFit - bestAlt);
        const tConf = Math.max(0, Math.min(1, em / 0.12));
        cell.fitnessConfidence = tConf * tConf * (3 - 2 * tConf);
        cell.pelaConf = smoothstep(0.0, 0.10, em);
        cell.kolmConf = smoothstep(0.03, 0.18, em);
      }
      cell.groundCover *= cell.pelaConf;
    }
    return;
  }

  const water = Math.max(cell.saturation, cell.waterAvailability);
  const photoFitness = water * 0.8; // R1-FIX4A: removed elevation penalty, coefficient 0.8 matches planetary/hi-res
  const chemoFitness = cell.mineralTotal * Math.max(water, (cell.volcanism || 0) * 1.5) * 1.2; // R1-FIX3: volcanism, not groundwater
  const mixoFitness  = (0.6 + 0.5 * cell.mineralTotal) * water;
  const maxFit = Math.max(photoFitness, chemoFitness, mixoFitness);

  if (maxFit < 0.02) { // R1-FIX4B: barren threshold 0.02
    cell.floraType = 'barren'; cell.floraDensity = 0;
    cell.fitnessConfidence = 1.0; cell.pelaConf = 0; cell.kolmConf = 0;
    return;
  }
  if (photoFitness >= chemoFitness && photoFitness >= mixoFitness) {
    cell.floraType = 'photosynthetic';
  } else if (chemoFitness >= mixoFitness) {
    cell.floraType = 'chemotrophic';
  } else {
    cell.floraType = 'mixotrophic';
  }
  cell.floraDensity = clamp(maxFit, 0, 1);

  // S24: Fitness-confidence computation (fitness values already available)
  {
    let ftNum;
    if (cell.floraType === 'photosynthetic') ftNum = 1;
    else if (cell.floraType === 'chemotrophic') ftNum = 2;
    else ftNum = 3;
    const aFit = ftNum === 1 ? photoFitness : ftNum === 2 ? chemoFitness : mixoFitness;
    const alts = [photoFitness, chemoFitness, mixoFitness].filter((_, i) => i !== (ftNum - 1));
    const bestAlt = Math.max(...alts, 0.02);
    const em = Math.min(aFit - 0.02, aFit - bestAlt);
    const tConf = Math.max(0, Math.min(1, em / 0.12));
    cell.fitnessConfidence = tConf * tConf * (3 - 2 * tConf);
    cell.pelaConf = smoothstep(0.0, 0.10, em);
    cell.kolmConf = smoothstep(0.03, 0.18, em);
  }

  // Ground cover vs canopy split
  cell.canopy = clamp(cell.floraDensity * (cell.floraType === 'photosynthetic' ? 1.0 : 0.6), 0, 1);
  cell.groundCover = clamp(cell.floraDensity * 0.8 + cell.saturation * 0.2, 0, 1);

  // S24: Apply fitness-confidence modulation
  cell.groundCover *= cell.pelaConf;
  cell.canopy *= cell.kolmConf;

  // R3-FIX2: barren gates canopy
  // Barren cells have no living cover (safety net — the early return above
  // should catch most cases, but this guards against edge cases)
  if (cell.floraType === 'barren') {
    cell.groundCover = 0;
    cell.canopy = 0;
    cell.chemoCrust = 0;
    cell.organicContent = 0;
  }
}

// ── Derive water state from water table depth ──
// Replaces computeStandingWater. Instead of detecting topographic basins and
// filling them (which produced concentric ring artifacts), this reads
// waterTableDepth directly — channels have negative WTD (water table above
// surface), ridges have positive WTD (water table below surface).
//
// Must be called AFTER both substrate refinement (sets WTD) and flora
// refinement (sets canopy, groundCover) but BEFORE terrain type derivation
// (reads the flood-modulated canopy to determine coverType).
function deriveWTDWater(cells, gridW, gridH) {
  for (let ry = 0; ry < gridH; ry++) {
    for (let rx = 0; rx < gridW; rx++) {
      const cell = cells[rx][ry];

      // ── Ocean cells: keep existing water handling, set consistent fields ──
      if (!cell.isLand) {
        cell.waterDepth = Math.max(0, -cell.baseElevation);
        cell.hasWater = true;
        cell.pelaRaft = 0;
        cell.kolmRelict = 0;
        cell.wetness = 1.0;
        cell.baseCanopy = cell.canopy || 0;
        continue;
      }

      // ── Land cells: derive water state from WTD ──
      const wtd = cell.waterTableDepth;

      // 1. Derive water depth directly from WTD
      cell.waterDepth = Math.max(0, -wtd);

      // 2. Standing water flag for terrain derivation
      //    0.02m minimum filters noise-floor artifacts.
      //    The existing SHALLOW_WATER_TERRAIN_THRESHOLD (0.05m) in
      //    deriveTerrainAndCover handles terrain type classification —
      //    cells with depth 0.02–0.05m keep their ground terrain type.
      cell.hasWater = cell.waterDepth > 0.02;

      // 3. Continuous wetness parameter (blending factor for palette)
      //    0 at WTD ≥ 0.04 (dry), 1 at WTD ≤ -0.03 (flooded)
      //    Tightened transition band so more cells show partial wetness.
      cell.wetness = 1.0 - smoothstep(-0.03, 0.04, wtd);

      // 4. Save base canopy BEFORE flood modulation
      //    Needed for kolm relict calculation
      cell.baseCanopy = cell.canopy || 0;

      // 5. Flood-kill modulation on living canopy
      //    Living canopy starts declining at WTD -0.03, reaches zero by -0.12.
      //    Compressed from original (-0.05 to -0.20) to match achievable WTD range.
      if (wtd < -0.03) {
        cell.canopy = (cell.canopy || 0) * smoothstep(-0.12, -0.03, wtd);
      }

      // 6. Pela raft coverage (floating photosynthetic mat on water surface)
      //    Only for photosynthetic or mixotrophic flora types.
      //    Peak at depth 0.02–0.06 (WTD -0.02 to -0.06), declining from
      //    0.06–0.18 (deeper channels), gone by depth 0.18 (WTD -0.18).
      //    Compressed from original (onset 0.04, decline 0.10–0.30).
      const ft = cell.floraType;
      const isPelaCapable = (ft === 'photosynthetic' || ft === 1 ||
                             ft === 'mixotrophic'    || ft === 3);
      if (cell.waterDepth > 0 && isPelaCapable) {
        const depth = cell.waterDepth;
        const onset   = smoothstep(0.0, 0.02, depth);
        const decline = 1.0 - smoothstep(0.06, 0.18, depth);
        cell.pelaRaft = onset * decline * 0.75 * Math.min(1.0, (cell.groundCover || 0) * 1.5);
        // S24: Marginal pela produces less floating material
        cell.pelaRaft *= cell.pelaConf || 1.0;
      } else {
        cell.pelaRaft = 0;
      }

      // 7. Kolm relict density (dead mineral-ceramic steles still standing)
      //    Relicts start appearing at WTD -0.03 (as living canopy declines),
      //    full density by WTD -0.08, begin eroding at -0.15, gone by -0.25.
      //    Compressed from original (-0.05/-0.15 appear, -0.30/-0.50 erode).
      if (wtd < -0.03) {
        const appear = 1.0 - smoothstep(-0.08, -0.03, wtd);
        const erode  = smoothstep(-0.25, -0.15, wtd);
        cell.kolmRelict = cell.baseCanopy * 0.8 * appear * erode;
      } else {
        cell.kolmRelict = 0;
      }
    }
  }

  // ── Diagnostic: WTD tuning verification (remove after confirming) ──
  let negWTD = 0, nzWetness = 0, nzPelaRaft = 0, nzKolmRelict = 0, minWTD = Infinity;
  for (let ry = 0; ry < gridH; ry++) {
    for (let rx = 0; rx < gridW; rx++) {
      const c = cells[rx][ry];
      if (!c.isLand) continue;
      if (c.waterTableDepth < 0) negWTD++;
      if (c.wetness > 0) nzWetness++;
      if (c.pelaRaft > 0) nzPelaRaft++;
      if (c.kolmRelict > 0) nzKolmRelict++;
      if (c.waterTableDepth < minWTD) minWTD = c.waterTableDepth;
    }
  }
  console.log(`[WTD Diagnostic] Negative WTD cells: ${negWTD} | Non-zero wetness: ${nzWetness} | Non-zero pelaRaft: ${nzPelaRaft} | Non-zero kolmRelict: ${nzKolmRelict} | Min WTD: ${minWTD.toFixed(4)}`);
}

export { refineRegionalFloraFromHiRes, computeRegionalFloraCell, deriveWTDWater };
