// ══════════════════════════════════════════════════════════════════
// ── palette-compute.js — Three-Layer Color Pipeline ──
// ══════════════════════════════════════════════════════════════════

import { clamp } from './core-math.js';
import { intToTerrainType, intToCoverType } from './terrain-derive.js';

const MAT = {
  photoLiving:    { r: 165, g: 28, b: 28 },
  photoBright:    { r: 200, g: 42, b: 38 },
  deadFresh:      { r: 130, g: 80, b: 45 },
  deadPeat:       { r: 50, g: 30, b: 20 },
  waterSurface:   { r: 65, g: 95, b: 135 },
  skyReflection:  { r: 175, g: 145, b: 80 },

  substrate: {
    iron:     { r: 150, g: 85, b: 50 },
    copper:   { r: 85, g: 130, b: 78 },
    manganese:{ r: 105, g: 82, b: 115 },
    depleted: { r: 155, g: 145, b: 130 },
  },
  bedrock: {
    iron:     { r: 120, g: 75, b: 55 },
    copper:   { r: 70, g: 100, b: 68 },
    manganese:{ r: 88, g: 72, b: 95 },
    depleted: { r: 130, g: 125, b: 115 },
  },
  sand: {
    iron:     { r: 185, g: 145, b: 95 },
    copper:   { r: 150, g: 165, b: 120 },
    manganese:{ r: 160, g: 145, b: 155 },
    depleted: { r: 195, g: 185, b: 165 },
  },
  chemo: {
    iron:     { r: 140, g: 90, b: 55 },
    copper:   { r: 55, g: 120, b: 105 },
    manganese:{ r: 110, g: 70, b: 130 },
    depleted: { r: 130, g: 125, b: 110 },
  },
};

// Mineral color interpolation — blend mineral endpoints by relative concentration
function mineralColor(iron, copper, manganese, colorTable) {
  const total = iron + copper + manganese;

  if (total < 0.05) {
    // Depleted — no significant mineral content
    return colorTable.depleted;
  }

  // Weighted blend by relative concentration
  const fi = iron / total;
  const fc = copper / total;
  const fm = manganese / total;

  let r = fi * colorTable.iron.r + fc * colorTable.copper.r + fm * colorTable.manganese.r;
  let g = fi * colorTable.iron.g + fc * colorTable.copper.g + fm * colorTable.manganese.g;
  let b = fi * colorTable.iron.b + fc * colorTable.copper.b + fm * colorTable.manganese.b;

  // Fade toward depleted at low total mineral concentration
  const mineralIntensity = Math.min(total * 2, 1);  // full intensity at total >= 0.5
  r = r * mineralIntensity + colorTable.depleted.r * (1 - mineralIntensity);
  g = g * mineralIntensity + colorTable.depleted.g * (1 - mineralIntensity);
  b = b * mineralIntensity + colorTable.depleted.b * (1 - mineralIntensity);

  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

// Combined Layer 2+3 transform: white light → screen (LOCKED multipliers)
function toScreen(r, g, b) {
  return {
    r: Math.round(Math.min(255, Math.max(0, r * 0.790))),
    g: Math.round(Math.min(255, Math.max(0, g * 0.806))),
    b: Math.round(Math.min(255, Math.max(0, b * 0.728)))
  };
}

// Blend two colors by weight
function blend(c1, c2, w1, w2) {
  const t = w1 + w2;
  if (t < 0.001) return c1;
  const f1 = w1 / t, f2 = w2 / t;
  return {
    r: Math.round(c1.r * f1 + c2.r * f2),
    g: Math.round(c1.g * f1 + c2.g * f2),
    b: Math.round(c1.b * f1 + c2.b * f2)
  };
}

// Darken a color by a factor (0 = black, 1 = unchanged)
function darken(c, factor) {
  return {
    r: Math.round(c.r * factor),
    g: Math.round(c.g * factor),
    b: Math.round(c.b * factor)
  };
}

/**
 * Compute per-tile palette from physical state.
 * @param {object} p - Physical state of the tile
 * @returns {{ bg: {r,g,b}, fg: {r,g,b}, mid: {r,g,b} }}
 */
function computeTilePalette(p) {
  const iron = p.iron || 0;
  const copper = p.copper || 0;
  const mn = p.manganese || 0;
  const sat = p.saturation || 0;
  const org = p.organicContent || 0;
  const gc = p.groundCover || 0;
  const cd = p.canopyDensity || 0;
  const cc = p.chemoCrust || 0;
  const grain = p.grainSize || 0.3;
  const depth = p.waterDepth || 0;
  const tt = p.terrainType;
  const ct = p.coverType;
  const ft = p.floraType || 'barren';
  const wetness = p.wetness || 0;
  const pelaRaft = p.pelaRaft || 0;
  const kolmRelict = p.kolmRelict || 0;

  // Select the living ground cover color based on flora type
  // Photosynthetic: crimson mat
  // Chemotrophic: mineral-tinted crust (the "ground cover" IS the crust)
  // Mixotrophic: blend of both (dual-energy organism)
  // Barren: no living color (won't be used since groundCover would be ~0)
  let livingCoverColor;
  let livingCoverBright;  // brighter version for fg highlights

  const isChemo = ft === 'chemotrophic' || ft === 2;
  const isMixo  = ft === 'mixotrophic'  || ft === 3;
  const isPhoto = ft === 'photosynthetic' || ft === 1;

  if (isChemo) {
    livingCoverColor = mineralColor(iron, copper, mn, MAT.chemo);
    livingCoverBright = {
      r: Math.min(255, livingCoverColor.r + 35),
      g: Math.min(255, livingCoverColor.g + 25),
      b: Math.min(255, livingCoverColor.b + 30)
    };
  } else if (isMixo) {
    const chemoColor = mineralColor(iron, copper, mn, MAT.chemo);
    livingCoverColor = blend(MAT.photoLiving, chemoColor, 0.6, 0.4);
    livingCoverBright = blend(MAT.photoBright, {
      r: Math.min(255, chemoColor.r + 30),
      g: Math.min(255, chemoColor.g + 20),
      b: Math.min(255, chemoColor.b + 25)
    }, 0.6, 0.4);
  } else if (ft === 'barren' || ft === 0) {
    // Barren: ground cover is dead organic + sparse mineral surface biology
    // Not crimson — use dead organic color tinted by local minerals
    const substrate = mineralColor(iron, copper, mn, MAT.substrate);
    livingCoverColor = blend(MAT.deadFresh, substrate, 0.6, 0.4);
    livingCoverBright = {
      r: Math.min(255, livingCoverColor.r + 20),
      g: Math.min(255, livingCoverColor.g + 15),
      b: Math.min(255, livingCoverColor.b + 10)
    };
  } else {
    // Photosynthetic — crimson mat
    livingCoverColor = MAT.photoLiving;
    livingCoverBright = MAT.photoBright;
  }

  let bgL1, fgL1, midL1;  // Layer 1 colors (white light)

  // ── BACKGROUND (Layer 1) ──
  if (tt === 'water' || tt === 2) {
    // What's visible at the bottom: living mat (if present) over mineral substrate.
    // The mat doesn't vanish when submerged — it's still there under the water.
    const substrate = mineralColor(iron, copper, mn, MAT.substrate);
    let bottomColor;
    if (gc > 0.05) {
      // Living cover visible through the water, darkened by wet film
      const wetMat = darken(livingCoverColor, 0.82);
      bottomColor = blend(wetMat, substrate, gc, 1 - gc);
    } else {
      bottomColor = substrate;
    }
    const bottomVisibility = Math.max(0, 1 - depth * 4);  // fades by 0.25m
    bgL1 = blend(MAT.waterSurface, bottomColor, 1 - bottomVisibility, bottomVisibility);

  } else if (tt === 'deep_water' || tt === 1) {
    bgL1 = { r: 40, g: 58, b: 95 };  // deep blue, no bottom visible

  } else if (tt === 'mud' || tt === 3) {
    const substrate = mineralColor(iron, copper, mn, MAT.substrate);
    const organicColor = blend(MAT.deadFresh, MAT.deadPeat, 1 - org, org);
    let mudBase = blend(substrate, organicColor, 1 - org * 0.6, org * 0.6);
    mudBase = darken(mudBase, 1 - sat * 0.25);

    // Living flora covers the mud surface — same pattern as GRASS
    // High groundCover: mostly living cover color with dark mud in gaps
    // Low groundCover: mostly dark wet mud with sparse flora patches
    if (gc > 0.05) {
      bgL1 = blend(livingCoverColor, mudBase, gc * 0.7, 1 - gc * 0.7);
    } else {
      bgL1 = mudBase;
    }

    // Chemo overlay only if flora isn't already chemotrophic
    if (cc > 0.1 && !isChemo) {
      const chemoColor = mineralColor(iron, copper, mn, MAT.chemo);
      bgL1 = blend(bgL1, chemoColor, 1 - cc * 0.3, cc * 0.3);
    }

  } else if (tt === 'grass' || tt === 4) {
    const substrate = mineralColor(iron, copper, mn, MAT.substrate);
    const organicSub = blend(substrate, MAT.deadFresh, 1 - org * 0.3, org * 0.3);
    bgL1 = blend(livingCoverColor, organicSub, gc, 1 - gc);
    // Only apply additional chemo tinting if flora is NOT already chemotrophic
    // (avoids double-tinting on chemo tiles where livingCoverColor is already chemo)
    if (cc > 0.1 && !isChemo) {
      const chemoColor = mineralColor(iron, copper, mn, MAT.chemo);
      bgL1 = blend(bgL1, chemoColor, 1 - cc * 0.3, cc * 0.3);
    }
    if (sat > 0.5) {
      bgL1 = darken(bgL1, 1 - (sat - 0.5) * 0.15);
    }

  } else if (tt === 'dirt' || tt === 5) {
    const substrate = mineralColor(iron, copper, mn, MAT.substrate);
    const organicTint = blend(substrate, MAT.deadFresh, 1 - org * 0.4, org * 0.4);
    bgL1 = organicTint;
    // Ground cover: if mat is present on dirt, it should be visible
    if (gc > 0.05) {
      bgL1 = blend(bgL1, livingCoverColor, 1 - gc * 0.7, gc * 0.7);
    }
    if (sat > 0.3) {
      bgL1 = darken(bgL1, 1 - (sat - 0.3) * 0.2);
    }

  } else if (tt === 'sand' || tt === 6) {
    bgL1 = mineralColor(iron, copper, mn, MAT.sand);
    if (gc > 0.05) {
      bgL1 = blend(bgL1, livingCoverColor, 1 - gc * 0.25, gc * 0.25);
    }

  } else if (tt === 'rock' || tt === 7) {
    if (grain > 0.85) {
      bgL1 = mineralColor(iron, copper, mn, MAT.bedrock);
    } else {
      const rock = mineralColor(iron, copper, mn, MAT.bedrock);
      const sub = mineralColor(iron, copper, mn, MAT.substrate);
      const rockiness = (grain - 0.6) / 0.4;  // 0 at grain=0.6, 1 at grain=1.0
      bgL1 = blend(rock, sub, rockiness, 1 - rockiness);
    }
    if (gc > 0.03) {
      bgL1 = blend(bgL1, livingCoverColor, 1 - gc * 0.2, gc * 0.2);
    }
    // Only apply additional chemo tinting if flora is NOT already chemotrophic
    // (avoids double-tinting on chemo tiles where livingCoverColor is already chemo)
    if (cc > 0.1 && !isChemo) {
      const chemoColor = mineralColor(iron, copper, mn, MAT.chemo);
      bgL1 = blend(bgL1, chemoColor, 1 - cc * 0.3, cc * 0.3);
    }

  } else if (tt === 'beach' || tt === 8) {
    bgL1 = mineralColor(iron, copper, mn, MAT.sand);
    if (sat > 0.5) {
      bgL1 = darken(bgL1, 1 - (sat - 0.5) * 0.2);
    }

  } else {
    bgL1 = { r: 100, g: 90, b: 75 };  // Fallback
  }

  // ── FOREGROUND (Layer 1) ──
  if (tt === 'water' || tt === 2) {
    // Shallow water: mat highlights show through alongside sky reflection
    const bottomVis = Math.max(0, 1 - depth * 4);
    if (bottomVis > 0.1 && gc > 0.1) {
      const wetBright = darken(livingCoverBright, 0.85);
      fgL1 = blend(wetBright, MAT.skyReflection, bottomVis * 0.4, 1 - bottomVis * 0.4);
    } else {
      fgL1 = MAT.skyReflection;
    }
  } else if (tt === 'deep_water' || tt === 1) {
    fgL1 = MAT.skyReflection;

  } else if (tt === 'mud' || tt === 3) {
    // Mud fg: puddle reflections + flora highlights
    if (gc > 0.2) {
      // Flora present: highlights are a mix of living cover bright + water reflection
      fgL1 = blend(livingCoverBright, MAT.skyReflection, gc * 0.5, 1 - gc * 0.5);
    } else {
      // Bare mud: puddle reflections only
      fgL1 = blend(MAT.skyReflection, MAT.substrate.depleted, sat, 1 - sat);
    }

  } else if (tt === 'grass' || tt === 4) {
    if (cc > 0.3) {
      fgL1 = mineralColor(iron, copper, mn, MAT.chemo);
      fgL1 = { r: Math.min(255, fgL1.r + 30), g: Math.min(255, fgL1.g + 20), b: Math.min(255, fgL1.b + 20) };
    } else {
      fgL1 = livingCoverBright;
    }

  } else if (tt === 'dirt' || tt === 5) {
    if (gc > 0.1) {
      fgL1 = livingCoverColor;
    } else {
      const sub = mineralColor(iron, copper, mn, MAT.substrate);
      fgL1 = { r: Math.min(255, sub.r + 35), g: Math.min(255, sub.g + 25), b: Math.min(255, sub.b + 20) };
    }

  } else if (tt === 'rock' || tt === 7) {
    const rockBase = mineralColor(iron, copper, mn, MAT.bedrock);
    fgL1 = { r: Math.min(255, rockBase.r + 40), g: Math.min(255, rockBase.g + 30), b: Math.min(255, rockBase.b + 25) };

  } else if (tt === 'sand' || tt === 6 || tt === 'beach' || tt === 8) {
    const sandBase = mineralColor(iron, copper, mn, MAT.sand);
    fgL1 = { r: Math.min(255, sandBase.r + 25), g: Math.min(255, sandBase.g + 20), b: Math.min(255, sandBase.b + 15) };

  } else {
    fgL1 = { r: Math.min(255, bgL1.r + 30), g: Math.min(255, bgL1.g + 25), b: Math.min(255, bgL1.b + 20) };
  }

  // ── Continuous wetness modifier ──
  // Replaces the old binary wet film. Wetness grades smoothly from 0 (dry,
  // WTD ≥ 0.05) to 1 (flooded, WTD ≤ -0.05). Applies to ground terrain
  // types only — water/deep_water have their own palette.
  if (wetness > 0 && tt !== 'water' && tt !== 2 && tt !== 'deep_water' && tt !== 1) {
    const w = wetness;
    // Darken bg with slight blue shift (same visual character as old wet film,
    // but continuous instead of binary)
    bgL1 = {
      r: Math.round(bgL1.r * (1 - 0.18 * w)),
      g: Math.round(bgL1.g * (1 - 0.18 * w)),
      b: Math.round(Math.min(255, bgL1.b * (1 - 0.18 * w) + 6 * w))
    };
    // Reduce fg intensity (water fills micro-gaps, reducing surface detail)
    fgL1 = {
      r: Math.round(fgL1.r + (bgL1.r - fgL1.r) * 0.3 * w),
      g: Math.round(fgL1.g + (bgL1.g - fgL1.g) * 0.3 * w),
      b: Math.round(fgL1.b + (bgL1.b - fgL1.b) * 0.3 * w)
    };
  }

  // ── CONTINUOUS CANOPY SHADE ──
  // Decoupled from coverType — reads canopyDensity directly.
  // No threshold, no cliff. Forest edge becomes a gradient.
  // coverType still exists for sprite selection and gameplay systems.
  if (cd > 0.01) {
    const shade = cd * 0.75;
    bgL1 = darken(bgL1, 1 - shade);

    // Living cover color overlay under canopy, gated on canopyDensity > 0.05
    if (cd > 0.05) {
      if (isChemo) {
        // Chemotrophic canopy: mineral-tinted overlay
        const chemoColor = mineralColor(iron, copper, mn, MAT.chemo);
        bgL1 = blend(bgL1, darken(chemoColor, 0.5), 1 - cd * 0.3, cd * 0.3);
        // fg: chemo highlight, blended by canopy density
        const chemoHighlight = {
          r: Math.min(255, chemoColor.r + 35),
          g: Math.min(255, chemoColor.g + 25),
          b: Math.min(255, chemoColor.b + 30)
        };
        fgL1 = blend(fgL1, chemoHighlight, 1 - cd, cd);
      } else {
        // Photosynthetic / mixotrophic canopy: crimson overlay
        bgL1 = blend(bgL1, darken(livingCoverColor, 0.4), 1 - cd * 0.3, cd * 0.3);
        // fg: canopy bright highlights, blended by canopy density
        fgL1 = blend(fgL1, livingCoverBright, 1 - cd, cd);
      }
    }
  }

  // ── PELA RAFT BLENDING (on WATER terrain) ──
  // Floating photosynthetic mat on water surface. Blends crimson pela coverage
  // onto water, replacing the hard snap from land (crimson) to water (amber/blue)
  // with a continuous gradient.
  if ((tt === 'water' || tt === 2) && pelaRaft > 0) {
    const r = pelaRaft;  // 0 to ~0.75

    // Blend water bg toward livingCoverColor based on pela raft coverage
    bgL1 = {
      r: Math.round(bgL1.r + (livingCoverColor.r - bgL1.r) * r * 0.7),
      g: Math.round(bgL1.g + (livingCoverColor.g - bgL1.g) * r * 0.7),
      b: Math.round(bgL1.b + (livingCoverColor.b - bgL1.b) * r * 0.7)
    };

    // At high pela coverage, fg shifts toward livingCoverColor too
    if (r > 0.4) {
      const fgBlend = (r - 0.4) / 0.6;  // 0 at r=0.4, ~0.58 at r=0.75
      fgL1 = {
        r: Math.round(fgL1.r + (livingCoverColor.r - fgL1.r) * fgBlend * 0.4),
        g: Math.round(fgL1.g + (livingCoverColor.g - fgL1.g) * fgBlend * 0.4),
        b: Math.round(fgL1.b + (livingCoverColor.b - fgL1.b) * fgBlend * 0.4)
      };
    }
  }

  // ── KOLM RELICT CONTRIBUTION (on WATER / DEEP_WATER terrain) ──
  // Dead mineral-ceramic steles standing in water. No shade (no fronds),
  // just visual structure as mid-tone accents.
  if ((tt === 'water' || tt === 2 || tt === 'deep_water' || tt === 1) && kolmRelict > 0) {
    // Structural wood color from local mineral chemistry
    // Iron → rust, copper → verdigris, manganese → near-black
    const totalMin = iron + copper + mn;
    let relictColor;
    if (totalMin < 0.05) {
      // Depleted minerals — neutral wood
      relictColor = { r: 100, g: 80, b: 65 };
    } else {
      const fi = iron / totalMin, fc = copper / totalMin, fm = mn / totalMin;
      // Wood L1 base colors weighted by mineral concentration
      relictColor = {
        r: Math.round(fi * 138 + fc * 74 + fm * 58),
        g: Math.round(fi * 74 + fc * 136 + fm * 40),
        b: Math.round(fi * 48 + fc * 104 + fm * 48)
      };
    }

    // Relicts are sparse vertical elements, not area cover — subtle contribution
    const k = kolmRelict * 0.3;
    // Pre-compute mid from current bg/fg, then blend relict color into it
    const preMid = blend(bgL1, fgL1, 0.65, 0.35);
    midL1 = {
      r: Math.round(preMid.r + (relictColor.r - preMid.r) * k),
      g: Math.round(preMid.g + (relictColor.g - preMid.g) * k),
      b: Math.round(preMid.b + (relictColor.b - preMid.b) * k)
    };
  }

  // ── MID-TONE (Layer 1) ──
  // If kolm relict already computed a custom mid, keep it; otherwise standard blend.
  if (!midL1) midL1 = blend(bgL1, fgL1, 0.65, 0.35);

  // ── APPLY LAYERS 2+3 (star + adaptation) ──
  const bg = toScreen(bgL1.r, bgL1.g, bgL1.b);
  const fg = toScreen(fgL1.r, fgL1.g, fgL1.b);
  const mid = toScreen(midL1.r, midL1.g, midL1.b);

  return { bg, fg, mid };
}

// ── Physical-state adapters (viewer data → computeTilePalette input) ──
// Tile chunk: typed-array store indexed by tile `i`
function tilePhysical(t, i) {
  return {
    terrainType:    intToTerrainType(t.terrainType[i]),
    coverType:      intToCoverType(t.coverType[i]),
    iron:           t.iron[i] || 0,
    copper:         t.copper[i] || 0,
    manganese:      t.manganese[i] || 0,
    grainSize:      t.grainSize[i] || 0.3,
    saturation:     t.saturation[i] || 0,
    organicContent: (t.organicContent && t.organicContent[i]) || 0,
    groundCover:    t.groundCover[i] || 0,
    canopyDensity:  t.canopy[i] || 0,
    chemoCrust:     t.chemoCrust[i] || 0,
    waterDepth:     t.waterDepth[i] || 0,
    floraType:      ['barren','photosynthetic','chemotrophic','mixotrophic'][t.floraType[i]] || 'barren',
    wetness:        (t.wetness && t.wetness[i]) || 0,
    pelaRaft:       (t.pelaRaft && t.pelaRaft[i]) || 0,
    kolmRelict:     (t.kolmRelict && t.kolmRelict[i]) || 0,
  };
}

// Regional cell: object with named string/scalar properties
function regionalPhysical(cell) {
  const m = cell.minerals || {};
  return {
    terrainType:    cell.terrainType,
    coverType:      cell.coverType,
    iron:           m.iron || 0,
    copper:         m.copper || 0,
    manganese:      m.manganese || 0,
    grainSize:      cell.grainSize || 0.3,
    saturation:     cell.saturation || 0,
    organicContent: cell.organicContent || 0,
    groundCover:    cell.groundCover || 0,
    canopyDensity:  cell.canopy || 0,
    chemoCrust:     cell.chemoCrust || 0,
    waterDepth:     cell.waterDepth || 0,
    floraType:      cell.floraType || 'barren',
    wetness:        cell.wetness || 0,        // 0 (dry) to 1 (flooded)
    pelaRaft:       cell.pelaRaft || 0,       // 0 to ~0.75 (pela raft coverage on water)
    kolmRelict:     cell.kolmRelict || 0,     // 0 to ~0.6 (dead stele density)
  };
}

// ── Exports ──
export { MAT, mineralColor, toScreen, blend, darken, computeTilePalette, tilePhysical, regionalPhysical };
