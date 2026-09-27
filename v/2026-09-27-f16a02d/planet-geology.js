// ══════════════════════════════════════════════════════════════════
// ── planet-geology.js — Plate tectonics, geo seeds, elevation, minerals
// ══════════════════════════════════════════════════════════════════

import { state } from './state.js';
import { PLATE_CONTINENTAL, PLATE_OCEANIC, BT_NONE, BT_COLLISION, BT_SUBDUCTION, BT_RIFT, BT_SPREADING, BT_TRANSFORM } from './planet-grid.js';
import {
  W, H, TOTAL,
  spherePos, CELL_TO_3D, dist3D, clamp, wrapX,
  sphereNoise, driftTo3D, wrappedDistSq
} from './core-math.js';

// ── 8-neighbour offsets for erosion transport (same order as the old inline list) ──
const EDX8 = [-1, 1, 0, 0, -1, 1, -1, 1];
const EDY8 = [ 0, 0, -1, 1, -1, -1, 1, 1];

// ── Spatial index for geological seeds ──
const GRID_SIZE = 20;
const GRID_W = Math.ceil(W / GRID_SIZE);
const GRID_H = Math.ceil(H / GRID_SIZE);

function buildSeedGrid(seeds) {
  const grid = new Array(GRID_W * GRID_H);
  for (let i = 0; i < grid.length; i++) grid[i] = [];
  for (const s of seeds) {
    const gx = Math.floor(s.x / GRID_SIZE) % GRID_W;
    const gy = clamp(Math.floor(s.y / GRID_SIZE), 0, GRID_H - 1);
    grid[gy * GRID_W + gx].push(s);
  }
  return grid;
}

function queryNearbySeeds(grid, x, y, maxRadius3D) {
  const results = [];
  const pos = spherePos[x][y];
  // Convert 3D radius to cell units, accounting for pole compression
  const lat = Math.abs(((y + 0.5) / H) - 0.5) * Math.PI;
  const cosLat = Math.max(0.05, Math.cos(lat));
  const equatCells = maxRadius3D / CELL_TO_3D;
  const safeCells = equatCells / cosLat;
  const cellRadius = Math.min(Math.ceil(safeCells / GRID_SIZE) + 1, Math.ceil(GRID_W / 2));
  const gx0 = Math.floor(x / GRID_SIZE);
  const gy0 = Math.floor(y / GRID_SIZE);
  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    const gy = gy0 + dy;
    if (gy < 0 || gy >= GRID_H) continue;
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const gx = ((gx0 + dx) % GRID_W + GRID_W) % GRID_W;
      const bucket = grid[gy * GRID_W + gx];
      for (const s of bucket) {
        const d = dist3D(pos, spherePos[s.x][s.y]);
        if (d < maxRadius3D) {
          results.push({ seed: s, dist: d });
        }
      }
    }
  }
  return results;
}

function shuffleArray(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── Step 1: Plates ──
function step1_generatePlates(seed, rng) {
  const P = state.cells;
  const N = state.params.plateCountBase + (seed % state.params.plateCountRange);

  // 1a. Place centers
  const centers = [];
  let attempts = 0;
  while (centers.length < N && attempts < 50000) {
    const cx = Math.floor(rng() * W);
    const cy = Math.floor(rng() * H);
    let ok = true;
    for (const c of centers) {
      if (dist3D(spherePos[cx][cy], spherePos[c.x][c.y]) < state.params.minPlateSpacing) { ok = false; break; }
    }
    if (ok) centers.push({ x: cx, y: cy });
    attempts++;
  }

  // 1c. Assign plate properties
  state.plates = centers.map((c, i) => {
    const type = rng() < state.params.continentalRatio ? 'continental' : 'oceanic';
    return {
      id: i,
      center: c,
      type: type,
      drift: {
        angle: rng() * 360,
        speed: 0.5 + rng() * 2.5,
      },
      baseRock: {
        iron: type === 'continental' ? 0.3 + rng() * 0.3 : 0.15 + rng() * 0.2,
        copper: 0.05 + rng() * 0.15,
        manganese: type === 'oceanic' ? 0.2 + rng() * 0.3 : 0.05 + rng() * 0.15,
      },
    };
  });

  // 1b. Voronoi assignment (track nearest and second-nearest)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let nearest = { id: -1, dist: Infinity };
      let secondNearest = { id: -1, dist: Infinity };
      const pos = spherePos[x][y];
      for (let p = 0; p < state.plates.length; p++) {
        const d = dist3D(pos, spherePos[state.plates[p].center.x][state.plates[p].center.y]);
        if (d < nearest.dist) {
          secondNearest = { id: nearest.id, dist: nearest.dist };
          nearest = { id: p, dist: d };
        } else if (d < secondNearest.dist) {
          secondNearest = { id: p, dist: d };
        }
      }
      const c = y * W + x;
      P.plateId[c] = nearest.id;
      P.plateType[c] = state.plates[nearest.id].type === 'continental' ? PLATE_CONTINENTAL : PLATE_OCEANIC;
      P.nearestDist[c] = nearest.dist;
      P.secondPlateId[c] = secondNearest.id;
      P.secondDist[c] = secondNearest.dist;
    }
  }

  // 1d. Classify boundaries
  const dx4 = [1, -1, 0, 0];
  const dy4 = [0, 0, -1, 1];

  // First pass: identify boundary cells and their types
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = y * W + x;
      const plateA = state.plates[P.plateId[c]];
      let bestConvergence = 0;
      let bestType = BT_NONE;
      let isBoundary = false;

      for (let d = 0; d < 4; d++) {
        const nx = wrapX(x + dx4[d]);
        const ny = y + dy4[d];
        if (ny < 0 || ny >= H) continue;
        const neighbor = ny * W + nx;
        if (P.plateId[neighbor] === P.plateId[c]) continue;

        isBoundary = true;
        const plateB = state.plates[P.plateId[neighbor]];

        // Boundary normal — use 3D vectors on the sphere
        const pA3 = spherePos[plateA.center.x][plateA.center.y];
        const pB3 = spherePos[plateB.center.x][plateB.center.y];
        const bnx3 = pB3.x - pA3.x, bny3 = pB3.y - pA3.y, bnz3 = pB3.z - pA3.z;
        const bnLen = Math.sqrt(bnx3*bnx3 + bny3*bny3 + bnz3*bnz3) || 1;

        // Project drift vectors (as 3D tangent vectors) onto boundary normal
        const driftA3 = driftTo3D(plateA.center.x, plateA.center.y, plateA.drift.angle, plateA.drift.speed);
        const driftB3 = driftTo3D(plateB.center.x, plateB.center.y, plateB.drift.angle, plateB.drift.speed);
        const driftA_proj = (driftA3.x * bnx3 + driftA3.y * bny3 + driftA3.z * bnz3) / bnLen;
        const driftB_proj = (driftB3.x * bnx3 + driftB3.y * bny3 + driftB3.z * bnz3) / bnLen;
        const convergence = driftA_proj - driftB_proj;

        if (Math.abs(convergence) > Math.abs(bestConvergence)) {
          bestConvergence = convergence;

          if (convergence > 0.8) {
            if (plateA.type === 'continental' && plateB.type === 'continental') {
              bestType = BT_COLLISION;
            } else {
              bestType = BT_SUBDUCTION;
            }
          } else if (convergence < -0.8) {
            if (plateA.type === 'continental' && plateB.type === 'continental') {
              bestType = BT_RIFT;
            } else {
              bestType = BT_SPREADING;
            }
          } else {
            bestType = BT_TRANSFORM;
          }
        }
      }

      if (isBoundary) {
        P.boundaryType[c] = bestType;
        P.boundaryStrength[c] = clamp(Math.abs(bestConvergence) / 3.0, 0, 1);
        P.boundaryDistance[c] = 0;
      }
    }
  }

  // BFS from boundary cells to compute boundaryDistance for non-boundary cells
  const queue = [];
  const visited = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    if (P.boundaryDistance[i] === 0) {
      queue.push(i);
      visited[i] = 1;
    }
  }

  let head = 0;
  while (head < queue.length) {
    const ci = queue[head++];
    const cx = ci % W;
    const cy = (ci / W) | 0;
    const cell = ci;

    for (let d = 0; d < 4; d++) {
      const nx = wrapX(cx + dx4[d]);
      const ny = cy + dy4[d];
      if (ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (visited[ni]) continue;

      const newDist = P.boundaryDistance[cell] + 1;
      if (newDist > 15) continue; // only propagate up to distance 15

      visited[ni] = 1;
      const neighbor = ni;
      P.boundaryDistance[neighbor] = newDist;
      P.boundaryType[neighbor] = P.boundaryType[cell];
      P.boundaryStrength[neighbor] = P.boundaryStrength[cell];
      queue.push(ni);
    }
  }

  // 1e. Hotspots
  const numHotspots = state.params.hotspotCountBase + (seed % state.params.hotspotCountRange);
  state.hotspots = [];
  for (let i = 0; i < numHotspots; i++) {
    state.hotspots.push({
      x: Math.floor(rng() * W),
      y: Math.floor(rng() * H),
      intensity: state.params.hotspotIntensityMin + rng() * (state.params.hotspotIntensityMax - state.params.hotspotIntensityMin),
    });
  }
}

// ── Step 1b: Generate geological seed points ──
function step1b_generateGeoSeeds(seed, rng) {
  // Collect boundary cells by interaction type
  const collisionCells = [];
  const subductionCells = [];
  const riftCells = [];

  const P = state.cells;
  for (let i = 0; i < TOTAL; i++) {
    if (P.boundaryDistance[i] !== 0) continue;
    const bt = P.boundaryType[i];
    if (bt !== BT_COLLISION && bt !== BT_SUBDUCTION && bt !== BT_RIFT) continue;
    // a small record per boundary cell (a few thousand) — the seed placement
    // below works on these, not on the grid
    const bc = { x: i % W, y: (i / W) | 0, plateId: P.plateId[i], secondPlateId: P.secondPlateId[i], boundaryStrength: P.boundaryStrength[i] };
    if (bt === BT_COLLISION) collisionCells.push(bc);
    else if (bt === BT_SUBDUCTION) subductionCells.push(bc);
    else riftCells.push(bc);
  }

  const mountainSeeds = [];
  const arcSeeds = [];
  const riftSeeds = [];

  // Place mountain seeds along collision boundaries
  shuffleArray(collisionCells, rng);
  const MTN_MIN_SPACING = 0.15; // 3D sphere units (~12 cells at equator)
  for (const c of collisionCells) {
    let tooClose = false;
    for (const s of mountainSeeds) {
      if (dist3D(spherePos[c.x][c.y], spherePos[s.x][s.y]) < MTN_MIN_SPACING) {
        tooClose = true; break;
      }
    }
    if (!tooClose) {
      const offsetX = (rng() - 0.5) * 6;
      const offsetY = (rng() - 0.5) * 6;
      const sx = wrapX(Math.round(c.x + offsetX));
      const sy = clamp(Math.round(c.y + offsetY), 0, H - 1);

      // Compute local boundary direction from nearby collision cells
      let boundaryDir = null;
      const searchRad = 12;
      const nearbyCells = [];
      for (const bc of collisionCells) {
        const dd = wrappedDistSq(sx, sy, bc.x, bc.y);
        if (dd > 0 && dd < searchRad * searchRad) nearbyCells.push(bc);
      }
      if (nearbyCells.length >= 2) {
        let bestPair = null, bestDist = 0;
        for (let i = 0; i < nearbyCells.length; i++) {
          for (let j = i + 1; j < nearbyCells.length; j++) {
            const d = dist3D(spherePos[nearbyCells[i].x][nearbyCells[i].y],
                             spherePos[nearbyCells[j].x][nearbyCells[j].y]);
            if (d > bestDist) {
              bestDist = d;
              bestPair = [nearbyCells[i], nearbyCells[j]];
            }
          }
        }
        const p1 = spherePos[bestPair[0].x][bestPair[0].y];
        const p2 = spherePos[bestPair[1].x][bestPair[1].y];
        const bdx = p2.x - p1.x, bdy = p2.y - p1.y, bdz = p2.z - p1.z;
        const blen = Math.sqrt(bdx*bdx + bdy*bdy + bdz*bdz) || 1;
        boundaryDir = { x: bdx/blen, y: bdy/blen, z: bdz/blen };
      }

      mountainSeeds.push({
        x: sx,
        y: sy,
        height: state.params.collisionHeight * (0.35 + rng() * 0.65),
        radius: (7 + rng() * 7) * CELL_TO_3D,   // 3D radius
        convergence: c.boundaryStrength,
        boundaryDir: boundaryDir,
      });
    }
  }

  // Place volcanic arc chains along subduction boundaries
  shuffleArray(subductionCells, rng);
  const ARC_MIN_SPACING = 0.17; // 3D sphere units (~14 cells at equator)
  const arcChainParents = []; // track parent positions for spacing check
  for (const c of subductionCells) {
    let tooClose = false;
    for (const s of arcChainParents) {
      if (dist3D(spherePos[c.x][c.y], spherePos[s.x][s.y]) < ARC_MIN_SPACING) {
        tooClose = true; break;
      }
    }
    if (tooClose) continue;

    // Register this parent position for spacing
    arcChainParents.push({ x: c.x, y: c.y });

    // Determine boundary type: oceanic-oceanic vs continental-oceanic
    const plateA = state.plates[c.plateId];
    const plateB = state.plates[c.secondPlateId];
    const isOceanicArc = plateA.type === 'oceanic' && plateB.type === 'oceanic';

    // Oceanic arcs: longer chains, tighter spacing
    // Continental arcs: shorter chains, wider spacing
    const minPeaks = isOceanicArc
      ? Math.max(state.params.arcChainMinPeaks, Math.ceil(state.params.arcChainMinPeaks * 1.25))
      : Math.max(2, state.params.arcChainMinPeaks - 1);
    const maxPeaks = isOceanicArc
      ? state.params.arcChainMaxPeaks
      : Math.max(minPeaks, state.params.arcChainMaxPeaks - 2);
    const chainSpacing = isOceanicArc
      ? Math.max(2, state.params.arcChainSpacing - 1)
      : state.params.arcChainSpacing + 1;

    const numPeaks = minPeaks + Math.floor(rng() * (maxPeaks - minPeaks + 1));

    // Determine local boundary direction from nearby subduction cells
    const searchRadius = 15;
    const nearbyBoundary = [];
    for (const sc of subductionCells) {
      const dd = wrappedDistSq(c.x, c.y, sc.x, sc.y);
      if (dd > 0 && dd < searchRadius * searchRadius) {
        nearbyBoundary.push(sc);
      }
    }

    // Fit a direction vector to the nearby boundary cells
    let dirX = 0, dirY = 0;
    if (nearbyBoundary.length >= 2) {
      // Use principal component: accumulate offsets from center
      for (const nc of nearbyBoundary) {
        let dx = nc.x - c.x;
        if (dx > W / 2) dx -= W;
        if (dx < -W / 2) dx += W;
        const dy = nc.y - c.y;
        dirX += dx;
        dirY += dy;
      }
      // Use the dominant direction (first principal component approximation)
      // Try covariance approach for better fit
      let cxx = 0, cxy = 0, cyy = 0;
      for (const nc of nearbyBoundary) {
        let dx = nc.x - c.x;
        if (dx > W / 2) dx -= W;
        if (dx < -W / 2) dx += W;
        const dy = nc.y - c.y;
        cxx += dx * dx;
        cxy += dx * dy;
        cyy += dy * dy;
      }
      // Eigenvector of largest eigenvalue of [[cxx,cxy],[cxy,cyy]]
      const trace = cxx + cyy;
      const det = cxx * cyy - cxy * cxy;
      const eigenval = trace / 2 + Math.sqrt(Math.max(0, trace * trace / 4 - det));
      dirX = cxy;
      dirY = eigenval - cxx;
      if (Math.abs(dirX) < 0.001 && Math.abs(dirY) < 0.001) {
        dirX = 1; dirY = 0;
      }
    } else {
      // Fallback: random direction
      const angle = rng() * Math.PI * 2;
      dirX = Math.cos(angle);
      dirY = Math.sin(angle);
    }

    // Normalize direction
    const dirLen = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    dirX /= dirLen;
    dirY /= dirLen;

    // Compute 3D boundary direction for arc chain from nearby subduction cells
    let arcBoundaryDir = null;
    if (nearbyBoundary.length >= 2) {
      let bestPairA = null, bestDistA = 0;
      for (let i = 0; i < nearbyBoundary.length; i++) {
        for (let j = i + 1; j < nearbyBoundary.length; j++) {
          const d = dist3D(spherePos[nearbyBoundary[i].x][nearbyBoundary[i].y],
                           spherePos[nearbyBoundary[j].x][nearbyBoundary[j].y]);
          if (d > bestDistA) {
            bestDistA = d;
            bestPairA = [nearbyBoundary[i], nearbyBoundary[j]];
          }
        }
      }
      const p1a = spherePos[bestPairA[0].x][bestPairA[0].y];
      const p2a = spherePos[bestPairA[1].x][bestPairA[1].y];
      const bdxa = p2a.x - p1a.x, bdya = p2a.y - p1a.y, bdza = p2a.z - p1a.z;
      const blena = Math.sqrt(bdxa*bdxa + bdya*bdya + bdza*bdza) || 1;
      arcBoundaryDir = { x: bdxa/blena, y: bdya/blena, z: bdza/blena };
    }

    // Perpendicular direction for jitter
    const perpX = -dirY;
    const perpY = dirX;

    // Parent height for this chain
    const parentHeight = state.params.arcHeight * (0.5 + rng() * 0.5);

    // Generate sub-peaks centered on this position along the boundary direction
    const halfChain = (numPeaks - 1) / 2;
    for (let p = 0; p < numPeaks; p++) {
      const alongOffset = (p - halfChain) * chainSpacing;
      const jitter = (rng() - 0.5) * 2 * state.params.arcChainJitter;

      const peakX = wrapX(Math.round(c.x + dirX * alongOffset + perpX * jitter));
      const peakY = clamp(Math.round(c.y + dirY * alongOffset + perpY * jitter), 0, H - 1);

      const peakHeight = parentHeight * (0.5 + rng() * 0.5);
      const peakRadius = (state.params.arcSubPeakRadiusMin + rng() * (state.params.arcSubPeakRadiusMax - state.params.arcSubPeakRadiusMin)) * CELL_TO_3D;

      arcSeeds.push({
        x: peakX,
        y: peakY,
        height: peakHeight,
        radius: peakRadius,
        convergence: c.boundaryStrength,
        boundaryDir: arcBoundaryDir,
      });
    }
  }

  // Place rift seeds along rift boundaries
  shuffleArray(riftCells, rng);
  const RIFT_MIN_SPACING = 0.20; // 3D sphere units (~16 cells at equator)
  for (const c of riftCells) {
    let tooClose = false;
    for (const s of riftSeeds) {
      if (dist3D(spherePos[c.x][c.y], spherePos[s.x][s.y]) < RIFT_MIN_SPACING) {
        tooClose = true; break;
      }
    }
    if (!tooClose) {
      const offsetX = (rng() - 0.5) * 4;
      const offsetY = (rng() - 0.5) * 4;
      riftSeeds.push({
        x: wrapX(Math.round(c.x + offsetX)),
        y: clamp(Math.round(c.y + offsetY), 0, H - 1),
        depth: 0.04 + rng() * 0.06,
        radius: (6 + rng() * 5) * CELL_TO_3D,  // 3D radius
      });
    }
  }

  // Build spatial grids for fast lookup
  state.geoSeeds = {
    mountains: mountainSeeds,
    arcs: arcSeeds,
    rifts: riftSeeds,
    mountainGrid: buildSeedGrid(mountainSeeds),
    arcGrid: buildSeedGrid(arcSeeds),
    riftGrid: buildSeedGrid(riftSeeds),
  };
}

// ── Step 2: Elevation ──
// Compute effective distance with elliptical + angular noise falloff
function computeEffectiveDist(pos, seedObj) {
    const seedPos = spherePos[seedObj.x][seedObj.y];
    const dx = pos.x - seedPos.x;
    const dy = pos.y - seedPos.y;
    const dz = pos.z - seedPos.z;
    const rawDist = Math.sqrt(dx*dx + dy*dy + dz*dz);

    if (rawDist < 0.0001 || !seedObj.boundaryDir) {
        // No boundary direction (hotspot) or at the peak center — use raw distance
        return rawDist;
    }

    const bd = seedObj.boundaryDir;

    // Decompose displacement into parallel (along boundary) and perpendicular components
    const parallel = dx * bd.x + dy * bd.y + dz * bd.z;
    const perpSq = rawDist * rawDist - parallel * parallel;
    const perp = Math.sqrt(Math.max(0, perpSq));

    // Elliptical distance: shrink the parallel component by aspect ratio
    // This makes the peak wider along the boundary direction
    const aspect = state.params.peakAspectRatio;
    const ellipticalDist = Math.sqrt((parallel / aspect) * (parallel / aspect) + perp * perp);

    // Angular noise: modulate the effective radius based on angle around the peak
    // This creates irregular coastlines where the peak intersects sea level
    const angle = Math.atan2(parallel, perp);
    const noiseInput = angle * state.params.peakAngularFreq + seedObj.x * 7.31 + seedObj.y * 13.17;
    const angularMod = 1.0 + Math.sin(noiseInput) * state.params.peakAngularNoise
                           + Math.sin(noiseInput * 1.7 + 3.0) * state.params.peakAngularNoise * 0.5;

    // Return modulated elliptical distance
    // Dividing distance by angularMod means where angularMod > 1, the peak extends further out
    // and where angularMod < 1, it pulls inward — creating bays and headlands
    return ellipticalDist / angularMod;
}

function step2_computeElevation(seed, rng) {
  const P = state.cells;
  // Expand search radii by aspect ratio so elongated seeds are found
  const MAX_MTN_RADIUS = 0.25 * state.params.peakAspectRatio;   // 3D units, expanded for elongation
  const MAX_ARC_RADIUS = 0.18 * state.params.peakAspectRatio;   // 3D units, expanded for elongation
  const MAX_RIFT_RADIUS = 0.18;  // 3D units (~15 cells at equator) — rifts unchanged
  const HOTSPOT_RADIUS = 0.18;   // 3D units (~15 cells at equator) — hotspots unchanged

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = y * W + x;
      const pos = spherePos[x][y];

      const noise1 = sphereNoise(pos, seed + 500, 2, 0.015);

      // Base elevation — blended near plate boundaries for smooth continental shelves
      const plate1 = state.plates[P.plateId[c]];
      const plate2 = state.plates[P.secondPlateId[c]];
      const noiseAmp = state.params.continentalNoise;
      const baseElev1 = (plate1.type === 'continental' ? state.params.continentalBase : state.params.oceanicBase) + noise1 * noiseAmp;
      const baseElev2 = (plate2.type === 'continental' ? state.params.continentalBase : state.params.oceanicBase) + noise1 * noiseAmp;

      const edgeRatio = (P.secondDist[c] - P.nearestDist[c]) / (P.secondDist[c] + P.nearestDist[c]);
      const blendSteepness = 120 / state.params.blendWidth;
      const blend = 1 / (1 + Math.exp(-edgeRatio * blendSteepness));

      let elevation = baseElev2 + (baseElev1 - baseElev2) * blend;

      P.blend[c] = blend;
      const proximity = 1 - blend;  // 0.5 at boundary, ~0 deep inside

      if (proximity > 0.01) {
        const pA3 = spherePos[plate1.center.x][plate1.center.y];
        const pB3 = spherePos[plate2.center.x][plate2.center.y];
        const bnx3 = pB3.x - pA3.x, bny3 = pB3.y - pA3.y, bnz3 = pB3.z - pA3.z;
        const bnLen = Math.sqrt(bnx3*bnx3 + bny3*bny3 + bnz3*bnz3) || 1;
        const dA3 = driftTo3D(plate1.center.x, plate1.center.y, plate1.drift.angle, plate1.drift.speed);
        const dB3 = driftTo3D(plate2.center.x, plate2.center.y, plate2.drift.angle, plate2.drift.speed);
        const driftA = (dA3.x * bnx3 + dA3.y * bny3 + dA3.z * bnz3) / bnLen;
        const driftB = (dB3.x * bnx3 + dB3.y * bny3 + dB3.z * bnz3) / bnLen;
        P.convergence[c] = (driftA - driftB) / 3;
      } else {
        P.convergence[c] = 0;
      }

      // Mountain seeds (collision zones) — elliptical + angular noise falloff
      const nearbyMtns = queryNearbySeeds(state.geoSeeds.mountainGrid, x, y, MAX_MTN_RADIUS);
      for (const { seed: mtn } of nearbyMtns) {
        const r = mtn.radius;
        const dist = computeEffectiveDist(pos, mtn);
        if (dist < r) {
          const falloff = Math.exp(-(dist * dist) / (r * r * 0.4));
          const localNoise = sphereNoise(pos, seed + 999, 2, state.params.mountainNoiseScale);
          const noiseMod = clamp(0.5 + localNoise * 0.6, 0.1, 1.0);
          elevation += mtn.height * mtn.convergence * falloff * noiseMod;
        }
      }

      // Volcanic arc seeds (subduction zones) — elliptical + angular noise falloff
      const nearbyArcs = queryNearbySeeds(state.geoSeeds.arcGrid, x, y, MAX_ARC_RADIUS);
      for (const { seed: arc } of nearbyArcs) {
        const r = arc.radius;
        const dist = computeEffectiveDist(pos, arc);
        if (dist < r) {
          const falloff = Math.exp(-(dist * dist) / (r * r * 0.4));
          const localNoise = sphereNoise(pos, seed + 777, 2, state.params.arcNoiseScale);
          const noiseMod = clamp(0.4 + localNoise * 0.7, 0.05, 1.0);
          elevation += arc.height * arc.convergence * falloff * noiseMod;
        }
      }

      // Rift seeds (continental rift zones) — depressions, unchanged radial falloff
      const nearbyRifts = queryNearbySeeds(state.geoSeeds.riftGrid, x, y, MAX_RIFT_RADIUS);
      for (const { seed: rift, dist } of nearbyRifts) {
        const r = rift.radius;
        if (dist < r) {
          const falloff = Math.exp(-(dist * dist) / (r * r * 0.4));
          const localNoise = sphereNoise(pos, seed + 888, 2, 0.05);
          const noiseMod = clamp(0.3 + localNoise * 0.5, 0.1, 1.0);
          elevation -= rift.depth * falloff * noiseMod;
        }
      }

      // Hotspot modifier — unchanged radial falloff (hotspots are roughly radial)
      for (const hs of state.hotspots) {
        const hsDist = dist3D(pos, spherePos[hs.x][hs.y]);
        if (hsDist < HOTSPOT_RADIUS) {
          elevation += hs.intensity * 0.35 * Math.max(0, 1 - hsDist / HOTSPOT_RADIUS);
        }
      }

      // Fractal noise — no suppression needed with off-axis noise sampling
      elevation += sphereNoise(pos, seed, state.params.fractalOctaves, state.params.fractalScale) * state.params.fractalAmp;

      P.elevation[c] = elevation;
      P.isLand[c] = elevation > 0.0;
      P.isShallowWater[c] = elevation > -0.08 && elevation <= 0.0;
      P.isDeepWater[c] = elevation <= -0.08;
    }
  }
}

// ── Step 3: Minerals ──
function step3_computeMinerals(seed, rng) {
  const P = state.cells;
  const MAX_MTN_RADIUS = 0.25;   // 3D units
  const MAX_ARC_RADIUS = 0.18;   // 3D units
  const HOTSPOT_VOLC_RADIUS = 0.15;  // 3D units (~12 cells at equator)
  const HOTSPOT_CENTER_RADIUS = 0.037; // 3D units (~3 cells at equator)

  // 3a. Base chemistry — blend between nearest and second-nearest plate
  for (let i = 0; i < TOTAL; i++) {
    const c = i;
    const plate1 = state.plates[P.plateId[c]];
    const plate2 = state.plates[P.secondPlateId[c]];
    const b = P.blend[c]; // 0.5 at boundary, ~1.0 deep inside plate1

    P.iron[c] = (plate1.baseRock.iron * b + plate2.baseRock.iron * (1 - b)) * 0.3;
    P.copper[c] = (plate1.baseRock.copper * b + plate2.baseRock.copper * (1 - b)) * 0.3;
    P.manganese[c] = (plate1.baseRock.manganese * b + plate2.baseRock.manganese * (1 - b)) * 0.3;
  }

  // 3b. Volcanic concentration — use seed points, not proximity trace
  for (let i = 0; i < TOTAL; i++) {
    const c = i;
    let volcanism = 0;

    const nearbyMtns = queryNearbySeeds(state.geoSeeds.mountainGrid, (c % W), ((c / W) | 0), MAX_MTN_RADIUS);
    for (const { seed: mtn, dist } of nearbyMtns) {
      const r = mtn.radius;
      if (dist < r) {
        const falloff = Math.exp(-(dist * dist) / (r * r * 0.5));
        volcanism += mtn.convergence * mtn.height * falloff;
      }
    }

    const nearbyArcs = queryNearbySeeds(state.geoSeeds.arcGrid, (c % W), ((c / W) | 0), MAX_ARC_RADIUS);
    for (const { seed: arc, dist } of nearbyArcs) {
      const r = arc.radius;
      if (dist < r) {
        const falloff = Math.exp(-(dist * dist) / (r * r * 0.5));
        volcanism += arc.convergence * arc.height * falloff;
      }
    }

    for (const hs of state.hotspots) {
      const hsDist = dist3D(spherePos[(c % W)][((c / W) | 0)], spherePos[hs.x][hs.y]);
      if (hsDist < HOTSPOT_VOLC_RADIUS) volcanism += hs.intensity * Math.max(0, 1 - hsDist / HOTSPOT_VOLC_RADIUS);
    }

    volcanism = clamp(volcanism, 0, 1.0);
    P.volcanism[c] = volcanism;

    P.iron[c] += volcanism * 0.55;
    P.copper[c] += volcanism * 0.35;
    P.manganese[c] += volcanism * 0.3;

    for (const hs of state.hotspots) {
      const hsDist = dist3D(spherePos[(c % W)][((c / W) | 0)], spherePos[hs.x][hs.y]);
      if (hsDist < HOTSPOT_CENTER_RADIUS) {
        const centerBoost = (1 - hsDist / HOTSPOT_CENTER_RADIUS) * 0.4;
        P.iron[c]      = Math.max(P.iron[c], centerBoost * hs.intensity);
        P.manganese[c] = Math.max(P.manganese[c], centerBoost * hs.intensity * 0.8);
        P.copper[c]    = Math.max(P.copper[c], centerBoost * hs.intensity * 0.5);
      }
    }
  }

  // 3c. Erosion transport — 8-directional, multi-target distribution
  for (let pass = 0; pass < state.params.erosionPasses; pass++) {
    const snapIron = new Float32Array(TOTAL);
    const snapCopper = new Float32Array(TOTAL);
    const snapManganese = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      snapIron[i] = P.iron[i];
      snapCopper[i] = P.copper[i];
      snapManganese[i] = P.manganese[i];
    }

    // Scratch buffers for the (at most 8) lower neighbours of a cell — reused
    // across cells so the loop allocates nothing.
    const lowerIdx = new Int32Array(8);
    const lowerDiff = new Float32Array(8);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = ci;
        const elev = P.elevation[c];

        let totalDiff = 0, lowerCount = 0;
        for (let d = 0; d < 8; d++) {
          const ny = y + EDY8[d];
          if (ny < 0 || ny >= H) continue;
          const ni = ny * W + wrapX(x + EDX8[d]);
          const nElev = P.elevation[ni];
          if (nElev < elev) {
            const diff = elev - nElev;
            lowerIdx[lowerCount] = ni;
            lowerDiff[lowerCount] = diff;
            lowerCount++;
            totalDiff += diff;
          }
        }

        if (totalDiff > 0) {
          const transferRate = state.params.erosionRate;
          for (let k = 0; k < lowerCount; k++) {
            const fraction = (lowerDiff[k] / totalDiff) * transferRate;
            const tgt = lowerIdx[k];
            P.iron[tgt]      += snapIron[ci] * fraction;
            P.copper[tgt]    += snapCopper[ci] * fraction;
            P.manganese[tgt] += snapManganese[ci] * fraction;
          }
          P.iron[c]      -= snapIron[ci] * transferRate;
          P.copper[c]    -= snapCopper[ci] * transferRate;
          P.manganese[c] -= snapManganese[ci] * transferRate;
        }
      }
    }
  }

  // 3d. Marine sedimentation
  for (let i = 0; i < TOTAL; i++) {
    if (P.isDeepWater[i]) P.manganese[i] += 0.08;
  }

  // 3e. Clamp and totals
  for (let i = 0; i < TOTAL; i++) {
    const c = i;
    P.iron[c] = clamp(P.iron[c], 0, 1);
    P.copper[c] = clamp(P.copper[c], 0, 1);
    P.manganese[c] = clamp(P.manganese[c], 0, 1);
    P.mineralTotal[c] = P.iron[c] + P.copper[c] + P.manganese[c];
  }
}

// ── Step 2b: Coastal Bathymetry Steepening ──
function step2b_coastalBathymetry() {
  const P = state.cells;
  const coastDist = new Int16Array(TOTAL).fill(-1);
  const coastalHeight = new Float32Array(TOTAL);
  const oceanicBase = state.params.oceanicBase;

  // Phase 1: BFS distance-from-shore
  const queue = [];
  let head = 0;

  // Seed BFS from land cells — mark adjacent ocean cells as coastDist=0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (P.elevation[i] <= 0) continue; // not land

      // Check all 8 neighbors
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          const nx = wrapX(x + dx);
          const ni = ny * W + nx;
          if (P.elevation[ni] > 0) continue; // also land
          if (coastDist[ni] >= 0) {
            // Already queued — take max coastalHeight
            coastalHeight[ni] = Math.max(coastalHeight[ni], P.elevation[i]);
            continue;
          }
          coastDist[ni] = 0;
          coastalHeight[ni] = P.elevation[i];
          queue.push(ni);
        }
      }
    }
  }

  // For coastDist=0 cells, we now have the max elevation of adjacent land.
  // Propagate outward through ocean.
  while (head < queue.length) {
    const ci = queue[head++];
    const cx = ci % W;
    const cy = (ci / W) | 0;
    const nextDist = coastDist[ci] + 1;
    const ch = coastalHeight[ci];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ny = cy + dy;
        if (ny < 0 || ny >= H) continue;
        const nx = wrapX(cx + dx);
        const ni = ny * W + nx;
        if (coastDist[ni] >= 0) continue; // already visited
        if (P.elevation[ni] > 0) continue; // land
        coastDist[ni] = nextDist;
        coastalHeight[ni] = ch;
        queue.push(ni);
      }
    }
  }

  // Phase 2: Apply depth floor
  let modified = 0;
  let shallowToDeep = 0;
  let minDist = Infinity, maxDist = -Infinity, sumDist = 0, distCount = 0;

  for (let i = 0; i < TOTAL; i++) {
    const c = i;
    if (P.elevation[c] > 0) continue; // land
    if (coastDist[i] < 0) continue; // unreached by BFS

    // Stats
    const d = coastDist[i];
    if (d < minDist) minDist = d;
    if (d > maxDist) maxDist = d;
    sumDist += d;
    distCount++;

    const slopeMod = clamp(coastalHeight[i] * 6.0, 0.3, 1.5);
    let depthFloor = (-0.05 - d * 0.08) * slopeMod;
    depthFloor = Math.max(depthFloor, oceanicBase); // don't go below ocean floor

    if (P.elevation[c] > depthFloor) {
      const wasShallow = P.isShallowWater[c];
      P.elevation[c] = depthFloor;
      P.isLand[c] = false;
      P.isShallowWater[c] = P.elevation[c] > -0.08 && P.elevation[c] <= 0.0;
      P.isDeepWater[c] = P.elevation[c] <= -0.08;
      modified++;
      if (wasShallow && P.isDeepWater[c]) shallowToDeep++;
    }
  }

  console.log(`[step2b] Coastal bathymetry: ${modified} ocean cells deepened, ` +
    `${shallowToDeep} shallow→deep transitions, ` +
    `coastDist min=${minDist} max=${maxDist} mean=${distCount ? (sumDist / distCount).toFixed(1) : 'N/A'}`);
}

export { step1_generatePlates, step1b_generateGeoSeeds, step2_computeElevation, step2b_coastalBathymetry, step3_computeMinerals };
