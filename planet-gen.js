// ══════════════════════════════════════════════════════════════════
// ── planet-gen.js — Planetary generation pipeline (steps 1-5b) ──
// ══════════════════════════════════════════════════════════════════

import { state } from './main.js';
import {
  W, H, TOTAL, mulberry32, hashInt, noise2D, fractalNoise,
  hashInt3D, noise3D, fractalNoise3D, wrappedNoise,
  spherePos, CELL_TO_3D, dist3D, sphereNoise,
  clamp, wrappedDistSq, wrappedDist, wrapX, toSphere,
  sphericalDist, driftTo3D, idx, maxKey, toRad, getLatitudeBand,
  hslToRgb
} from './core-math.js';
import { deriveTerrainAndCover } from './terrain-derive.js';

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

// ── Generation pipeline ──
function generatePlanet(seed) {
  const rng = mulberry32(seed);
  state.cells = new Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    state.cells[i] = {
      x: i % W,
      y: (i / W) | 0,
      plateId: 0,
      plateType: 'oceanic',
      nearestDist: 0,
      secondPlateId: 0,
      secondDist: Infinity,
      boundaryType: null,
      boundaryStrength: 0,
      boundaryDistance: 999,
      elevation: 0,
      isLand: false,
      isShallowWater: false,
      isDeepWater: true,
      minerals: { iron: 0, copper: 0, manganese: 0 },
      mineralTotal: 0,
      isDepleted: true,
      dominant: 'iron',
      volcanism: 0,
      proximity: 0,
      blend: 0.5,
      convergence: 0,
      moisture: 0,
      baseMoisture: 0,
      temperature: 0.7,
      isFreezing: false,
      wind: { direction: 0, speed: 1 },
      windU: 0,
      windV: 0,
      windSpeed: 0,
      currentU: 0,
      currentV: 0,
      currentSpeed: 0,
      sst: 0.7,
      precipitation: 0,
      atmosphericMoisture: 0,
      groundwater: 0,
      drainage: 0,
      waterAvailability: 0,
      floraType: 'none',
      floraDensity: 0,
    };
  }

  // Step 1: Plates
  step1_generatePlates(seed, rng);
  // Step 1b: Generate geological seed points (mountains, arcs, rifts)
  step1b_generateGeoSeeds(seed, rng);
  // Step 2: Elevation
  step2_computeElevation(seed, rng);
  // Step 3: Minerals
  step3_computeMinerals(seed, rng);
  // Step 4: Atmosphere
  step4_computeAtmosphere(seed, rng);
  // Step 5: Flora
  step5_computeFlora();
  // Step 5b: Terrain + cover type (via the canonical deriveTerrainAndCover)
  step5b_deriveTerrainType();
  // Diagnostic
  printWeatherDiagnostic();
  printPrecipDiagnostic();
}

// ── Step 1: Plates ──
function step1_generatePlates(seed, rng) {
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
      const c = state.cells[y * W + x];
      c.plateId = nearest.id;
      c.plateType = state.plates[nearest.id].type;
      c.nearestDist = nearest.dist;
      c.secondPlateId = secondNearest.id;
      c.secondDist = secondNearest.dist;
    }
  }

  // 1d. Classify boundaries
  const dx4 = [1, -1, 0, 0];
  const dy4 = [0, 0, -1, 1];

  // First pass: identify boundary cells and their types
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = state.cells[y * W + x];
      const plateA = state.plates[c.plateId];
      let bestConvergence = 0;
      let bestType = null;
      let isBoundary = false;

      for (let d = 0; d < 4; d++) {
        const nx = wrapX(x + dx4[d]);
        const ny = y + dy4[d];
        if (ny < 0 || ny >= H) continue;
        const neighbor = state.cells[ny * W + nx];
        if (neighbor.plateId === c.plateId) continue;

        isBoundary = true;
        const plateB = state.plates[neighbor.plateId];

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
              bestType = 'collision';
            } else {
              bestType = 'subduction';
            }
          } else if (convergence < -0.8) {
            if (plateA.type === 'continental' && plateB.type === 'continental') {
              bestType = 'rift';
            } else {
              bestType = 'spreading';
            }
          } else {
            bestType = 'transform';
          }
        }
      }

      if (isBoundary) {
        c.boundaryType = bestType;
        c.boundaryStrength = clamp(Math.abs(bestConvergence) / 3.0, 0, 1);
        c.boundaryDistance = 0;
      }
    }
  }

  // BFS from boundary cells to compute boundaryDistance for non-boundary cells
  const queue = [];
  const visited = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].boundaryDistance === 0) {
      queue.push(i);
      visited[i] = 1;
    }
  }

  let head = 0;
  while (head < queue.length) {
    const ci = queue[head++];
    const cx = ci % W;
    const cy = (ci / W) | 0;
    const cell = state.cells[ci];

    for (let d = 0; d < 4; d++) {
      const nx = wrapX(cx + dx4[d]);
      const ny = cy + dy4[d];
      if (ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (visited[ni]) continue;

      const newDist = cell.boundaryDistance + 1;
      if (newDist > 15) continue; // only propagate up to distance 15

      visited[ni] = 1;
      const neighbor = state.cells[ni];
      neighbor.boundaryDistance = newDist;
      neighbor.boundaryType = cell.boundaryType;
      neighbor.boundaryStrength = cell.boundaryStrength;
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

  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    if (c.boundaryDistance !== 0) continue;
    if (c.boundaryType === 'collision') collisionCells.push(c);
    else if (c.boundaryType === 'subduction') subductionCells.push(c);
    else if (c.boundaryType === 'rift') riftCells.push(c);
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

function shuffleArray(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
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
  // Expand search radii by aspect ratio so elongated seeds are found
  const MAX_MTN_RADIUS = 0.25 * state.params.peakAspectRatio;   // 3D units, expanded for elongation
  const MAX_ARC_RADIUS = 0.18 * state.params.peakAspectRatio;   // 3D units, expanded for elongation
  const MAX_RIFT_RADIUS = 0.18;  // 3D units (~15 cells at equator) — rifts unchanged
  const HOTSPOT_RADIUS = 0.18;   // 3D units (~15 cells at equator) — hotspots unchanged

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = state.cells[y * W + x];
      const pos = spherePos[x][y];

      const noise1 = sphereNoise(pos, seed + 500, 2, 0.015);

      // Base elevation — blended near plate boundaries for smooth continental shelves
      const plate1 = state.plates[c.plateId];
      const plate2 = state.plates[c.secondPlateId];
      const noiseAmp = state.params.continentalNoise;
      const baseElev1 = (plate1.type === 'continental' ? state.params.continentalBase : state.params.oceanicBase) + noise1 * noiseAmp;
      const baseElev2 = (plate2.type === 'continental' ? state.params.continentalBase : state.params.oceanicBase) + noise1 * noiseAmp;

      const edgeRatio = (c.secondDist - c.nearestDist) / (c.secondDist + c.nearestDist);
      const blendSteepness = 120 / state.params.blendWidth;
      const blend = 1 / (1 + Math.exp(-edgeRatio * blendSteepness));

      let elevation = baseElev2 + (baseElev1 - baseElev2) * blend;

      c.blend = blend;
      const proximity = 1 - blend;  // 0.5 at boundary, ~0 deep inside
      c.proximity = proximity;

      if (proximity > 0.01) {
        const pA3 = spherePos[plate1.center.x][plate1.center.y];
        const pB3 = spherePos[plate2.center.x][plate2.center.y];
        const bnx3 = pB3.x - pA3.x, bny3 = pB3.y - pA3.y, bnz3 = pB3.z - pA3.z;
        const bnLen = Math.sqrt(bnx3*bnx3 + bny3*bny3 + bnz3*bnz3) || 1;
        const dA3 = driftTo3D(plate1.center.x, plate1.center.y, plate1.drift.angle, plate1.drift.speed);
        const dB3 = driftTo3D(plate2.center.x, plate2.center.y, plate2.drift.angle, plate2.drift.speed);
        const driftA = (dA3.x * bnx3 + dA3.y * bny3 + dA3.z * bnz3) / bnLen;
        const driftB = (dB3.x * bnx3 + dB3.y * bny3 + dB3.z * bnz3) / bnLen;
        c.convergence = (driftA - driftB) / 3;
      } else {
        c.convergence = 0;
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

      c.elevation = elevation;
      c.isLand = elevation > 0.0;
      c.isShallowWater = elevation > -0.08 && elevation <= 0.0;
      c.isDeepWater = elevation <= -0.08;
    }
  }
}

// ── Step 3: Minerals ──
function step3_computeMinerals(seed, rng) {
  const MAX_MTN_RADIUS = 0.25;   // 3D units
  const MAX_ARC_RADIUS = 0.18;   // 3D units
  const HOTSPOT_VOLC_RADIUS = 0.15;  // 3D units (~12 cells at equator)
  const HOTSPOT_CENTER_RADIUS = 0.037; // 3D units (~3 cells at equator)

  // 3a. Base chemistry — blend between nearest and second-nearest plate
  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    const plate1 = state.plates[c.plateId];
    const plate2 = state.plates[c.secondPlateId];
    const b = c.blend; // 0.5 at boundary, ~1.0 deep inside plate1

    c.minerals.iron = (plate1.baseRock.iron * b + plate2.baseRock.iron * (1 - b)) * 0.3;
    c.minerals.copper = (plate1.baseRock.copper * b + plate2.baseRock.copper * (1 - b)) * 0.3;
    c.minerals.manganese = (plate1.baseRock.manganese * b + plate2.baseRock.manganese * (1 - b)) * 0.3;
  }

  // 3b. Volcanic concentration — use seed points, not proximity trace
  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    let volcanism = 0;

    const nearbyMtns = queryNearbySeeds(state.geoSeeds.mountainGrid, c.x, c.y, MAX_MTN_RADIUS);
    for (const { seed: mtn, dist } of nearbyMtns) {
      const r = mtn.radius;
      if (dist < r) {
        const falloff = Math.exp(-(dist * dist) / (r * r * 0.5));
        volcanism += mtn.convergence * mtn.height * falloff;
      }
    }

    const nearbyArcs = queryNearbySeeds(state.geoSeeds.arcGrid, c.x, c.y, MAX_ARC_RADIUS);
    for (const { seed: arc, dist } of nearbyArcs) {
      const r = arc.radius;
      if (dist < r) {
        const falloff = Math.exp(-(dist * dist) / (r * r * 0.5));
        volcanism += arc.convergence * arc.height * falloff;
      }
    }

    for (const hs of state.hotspots) {
      const hsDist = dist3D(spherePos[c.x][c.y], spherePos[hs.x][hs.y]);
      if (hsDist < HOTSPOT_VOLC_RADIUS) volcanism += hs.intensity * Math.max(0, 1 - hsDist / HOTSPOT_VOLC_RADIUS);
    }

    volcanism = clamp(volcanism, 0, 1.0);
    c.volcanism = volcanism;

    c.minerals.iron += volcanism * 0.55;
    c.minerals.copper += volcanism * 0.35;
    c.minerals.manganese += volcanism * 0.3;

    for (const hs of state.hotspots) {
      const hsDist = dist3D(spherePos[c.x][c.y], spherePos[hs.x][hs.y]);
      if (hsDist < HOTSPOT_CENTER_RADIUS) {
        const centerBoost = (1 - hsDist / HOTSPOT_CENTER_RADIUS) * 0.4;
        c.minerals.iron      = Math.max(c.minerals.iron, centerBoost * hs.intensity);
        c.minerals.manganese = Math.max(c.minerals.manganese, centerBoost * hs.intensity * 0.8);
        c.minerals.copper    = Math.max(c.minerals.copper, centerBoost * hs.intensity * 0.5);
      }
    }
  }

  // 3c. Erosion transport — 8-directional, multi-target distribution
  for (let pass = 0; pass < state.params.erosionPasses; pass++) {
    const snapIron = new Float32Array(TOTAL);
    const snapCopper = new Float32Array(TOTAL);
    const snapManganese = new Float32Array(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      snapIron[i] = state.cells[i].minerals.iron;
      snapCopper[i] = state.cells[i].minerals.copper;
      snapManganese[i] = state.cells[i].minerals.manganese;
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = y * W + x;
        const c = state.cells[ci];
        const elev = c.elevation;

        const neighbors = [
          { nx: wrapX(x - 1), ny: y },
          { nx: wrapX(x + 1), ny: y },
          { nx: x,            ny: y - 1 },
          { nx: x,            ny: y + 1 },
          { nx: wrapX(x - 1), ny: y - 1 },
          { nx: wrapX(x + 1), ny: y - 1 },
          { nx: wrapX(x - 1), ny: y + 1 },
          { nx: wrapX(x + 1), ny: y + 1 },
        ];

        let totalDiff = 0;
        const lowerNeighbors = [];
        for (const n of neighbors) {
          if (n.ny < 0 || n.ny >= H) continue;
          const ni = n.ny * W + n.nx;
          const nElev = state.cells[ni].elevation;
          if (nElev < elev) {
            const diff = elev - nElev;
            lowerNeighbors.push({ idx: ni, diff });
            totalDiff += diff;
          }
        }

        if (totalDiff > 0) {
          const transferRate = state.params.erosionRate;
          for (const n of lowerNeighbors) {
            const fraction = (n.diff / totalDiff) * transferRate;
            state.cells[n.idx].minerals.iron      += snapIron[ci] * fraction;
            state.cells[n.idx].minerals.copper    += snapCopper[ci] * fraction;
            state.cells[n.idx].minerals.manganese += snapManganese[ci] * fraction;
          }
          c.minerals.iron      -= snapIron[ci] * transferRate;
          c.minerals.copper    -= snapCopper[ci] * transferRate;
          c.minerals.manganese -= snapManganese[ci] * transferRate;
        }
      }
    }
  }

  // 3d. Marine sedimentation
  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].isDeepWater) state.cells[i].minerals.manganese += 0.08;
  }

  // 3e. Clamp and totals
  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    c.minerals.iron = clamp(c.minerals.iron, 0, 1);
    c.minerals.copper = clamp(c.minerals.copper, 0, 1);
    c.minerals.manganese = clamp(c.minerals.manganese, 0, 1);
    c.mineralTotal = c.minerals.iron + c.minerals.copper + c.minerals.manganese;
    c.isDepleted = c.mineralTotal < 0.15;
    c.dominant = maxKey(c.minerals);
  }
}

// ── Step 4: Hydrological System ──
function step4_computeAtmosphere(seed, rng) {
  const statusEl = document.getElementById('statusText');

  // ── Step 4a: Wind Vector Field ──
  statusEl.textContent = 'Generating wind field…';

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

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

// ── Step 5: Flora ──
function step5_computeFlora() {
  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];
    if (!c.isLand) {
      c.floraType = 'none';
      c.floraDensity = 0;
      continue;
    }
    if (c.isFreezing) {
      c.floraType = 'frozen';
      c.floraDensity = 0;
      continue;
    }

    const light = 1.0;
    const water = c.waterAvailability;
    const photoFitness = light * water * 0.8;
    const chemoFitness = c.mineralTotal * Math.max(water, c.volcanism * 1.5) * 1.2; // R1-FIX3: unified chemo secondary factor (volcanism, not groundwater)
    const mixoFitness  = (0.6 + 0.5 * c.mineralTotal) * water;
    const maxFitness = Math.max(photoFitness, chemoFitness, mixoFitness);

    if (maxFitness < 0.02) {
      c.floraType = 'barren';
      c.floraDensity = 0;
    } else if (photoFitness >= chemoFitness && photoFitness >= mixoFitness) {
      c.floraType = 'photosynthetic';
      c.floraDensity = clamp(maxFitness, 0, 1);
    } else if (chemoFitness >= photoFitness && chemoFitness >= mixoFitness) {
      c.floraType = 'chemotrophic';
      c.floraDensity = clamp(maxFitness, 0, 1);
    } else {
      c.floraType = 'mixotrophic';
      c.floraDensity = clamp(maxFitness, 0, 1);
    }
  }
}

// ── Step 5b: Terrain + cover for the low-res planetary grid ──
// Routes through THE canonical deriveTerrainAndCover so the planetary map
// classifies terrain identically to the regional / high-res / tile views.
// The low-res grid doesn't compute the detailed substrate/flora fields those
// grids have, so they're ESTIMATED here from the planetary sim's own fields.
// The same estimates are stashed on the cell so the surface overlay's
// computeTilePalette call sees the exact inputs the derivation used.
function step5b_deriveTerrainType() {
  for (let i = 0; i < TOTAL; i++) {
    const c = state.cells[i];

    if (!c.isLand) {
      c.terrainType = c.isDeepWater ? 'deep_water' : 'water';
      c.coverType = 'none';
      continue;
    }
    if (c.isFreezing) {
      c.terrainType = 'rock';
      c.coverType = 'none';
      continue;
    }

    // Estimate the physical fields the low-res grid lacks so the canonical
    // function sees inputs comparable to the high-res grid's.
    const grainSize     = clamp(0.25 + c.elevation * 0.6, 0.05, 0.95);
    const saturation    = clamp(c.waterAvailability || 0, 0, 1);
    const groundCover   = c.floraDensity > 0 ? c.floraDensity * 0.6 : 0; // R1-FIX5: removed 0.3 floor, reduced multiplier to match hi-res pipeline
    const canopyDensity = c.floraDensity > 0.2 ? c.floraDensity * 0.7 : 0;
    const chemoCrust    = c.floraType === 'chemotrophic' ? clamp(c.floraDensity * 0.5, 0, 1) : 0;
    const waterTableDepth = clamp((1 - saturation) * (0.3 + c.elevation * 2), 0, 1);
    const isCoastal     = c.elevation > 0 && c.elevation < 0.03;

    const result = deriveTerrainAndCover(
      c.elevation,
      c.isLand,
      grainSize,
      saturation,
      groundCover,
      canopyDensity,
      chemoCrust,
      c.floraType,
      waterTableDepth,
      isCoastal
    );

    c.terrainType = result.terrainType;
    c.coverType   = result.coverType;
    c._estGrainSize   = grainSize;
    c._estSaturation  = saturation;
    c._estGroundCover = groundCover;
    c._estCanopy      = canopyDensity;
    c._estChemoCrust  = chemoCrust;
  }
}

// ── Weather Diagnostic ──
function printWeatherDiagnostic() {
  const bands = [
    { name: 'Polar N (70-90)',       yMin: 0,   yMax: Math.floor(H * 0.11) },
    { name: 'Subpolar N (55-70)',    yMin: Math.floor(H * 0.11), yMax: Math.floor(H * 0.19) },
    { name: 'Westerly N (35-55)',    yMin: Math.floor(H * 0.19), yMax: Math.floor(H * 0.31) },
    { name: 'Subtropical N (28-35)', yMin: Math.floor(H * 0.31), yMax: Math.floor(H * 0.36) },
    { name: 'Trade N (8-28)',        yMin: Math.floor(H * 0.36), yMax: Math.floor(H * 0.46) },
    { name: 'ITCZ (0-8)',           yMin: Math.floor(H * 0.46), yMax: Math.floor(H * 0.54) },
    { name: 'Trade S (8-28)',        yMin: Math.floor(H * 0.54), yMax: Math.floor(H * 0.64) },
    { name: 'Subtropical S (28-35)', yMin: Math.floor(H * 0.64), yMax: Math.floor(H * 0.69) },
    { name: 'Westerly S (35-55)',    yMin: Math.floor(H * 0.69), yMax: Math.floor(H * 0.81) },
    { name: 'Subpolar S (55-70)',    yMin: Math.floor(H * 0.81), yMax: Math.floor(H * 0.89) },
    { name: 'Polar S (70-90)',       yMin: Math.floor(H * 0.89), yMax: H },
  ];

  console.log('=== WEATHER DIAGNOSTIC ===');

  for (const band of bands) {
    const bandCells = [];
    for (let y = band.yMin; y < band.yMax; y++) {
      for (let x = 0; x < W; x++) {
        bandCells.push(state.cells[y * W + x]);
      }
    }

    const ocean = bandCells.filter(c => !c.isLand);
    const land = bandCells.filter(c => c.isLand);

    const avg = (arr, fn) => arr.length ? arr.reduce((s, c) => s + fn(c), 0) / arr.length : 0;

    const windSpd = avg(bandCells, c => c.windSpeed || 0);
    const windU = avg(bandCells, c => c.windU || 0);
    const windV = avg(bandCells, c => c.windV || 0);
    const sst = avg(ocean, c => c.sst || 0);
    const oceanMoist = avg(ocean, c => c.atmosphericMoisture || 0);
    const landMoist = avg(land, c => c.atmosphericMoisture || 0);
    const precip = avg(land, c => c.precipitation || 0);
    const gw = avg(land, c => c.groundwater || 0);
    const drain = avg(land, c => c.drainage || 0);
    const wa = avg(land, c => c.waterAvailability || 0);

    console.log(
      `${band.name.padEnd(25)} | wind: u=${windU.toFixed(3)} v=${windV.toFixed(3)} spd=${windSpd.toFixed(3)} | sst=${sst.toFixed(3)} | oceanMoist=${oceanMoist.toFixed(4)} landMoist=${landMoist.toFixed(4)} | precip=${precip.toFixed(4)} gw=${gw.toFixed(3)} drain=${drain.toFixed(4)} wa=${wa.toFixed(3)} | land=${land.length} ocean=${ocean.length}`
    );
  }

  const landCells = state.cells.filter(c => c.isLand);
  const oceanCells = state.cells.filter(c => !c.isLand);

  const stat = (arr, fn) => {
    if (!arr.length) return { min: 0, max: 0, mean: 0 };
    let min = Infinity, max = -Infinity, sum = 0;
    for (const c of arr) {
      const v = fn(c);
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, mean: sum / arr.length };
  };

  console.log('\n=== GLOBAL STATS (land cells) ===');
  const fields = [
    ['precipitation', c => c.precipitation || 0],
    ['groundwater', c => c.groundwater || 0],
    ['drainage', c => c.drainage || 0],
    ['waterAvailability', c => c.waterAvailability || 0],
    ['atmosphericMoisture', c => c.atmosphericMoisture || 0],
    ['windSpeed', c => c.windSpeed || 0],
  ];

  for (const [name, fn] of fields) {
    const s = stat(landCells, fn);
    console.log(`  ${name.padEnd(22)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)} mean=${s.mean.toFixed(4)}`);
  }

  console.log('\n=== GLOBAL STATS (ocean cells) ===');
  const oceanFields = [
    ['sst', c => c.sst || 0],
    ['atmosphericMoisture', c => c.atmosphericMoisture || 0],
    ['windSpeed', c => c.windSpeed || 0],
    ['currentSpeed', c => c.currentSpeed || 0],
  ];

  for (const [name, fn] of oceanFields) {
    const s = stat(oceanCells, fn);
    console.log(`  ${name.padEnd(22)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)} mean=${s.mean.toFixed(4)}`);
  }

  let nanCount = { precip: 0, gw: 0, wa: 0, windU: 0, sst: 0 };
  for (const c of state.cells) {
    if (isNaN(c.precipitation) || c.precipitation === undefined) nanCount.precip++;
    if (isNaN(c.groundwater) || c.groundwater === undefined) nanCount.gw++;
    if (isNaN(c.waterAvailability) || c.waterAvailability === undefined) nanCount.wa++;
    if (isNaN(c.windU) || c.windU === undefined) nanCount.windU++;
    if (isNaN(c.sst) || c.sst === undefined) nanCount.sst++;
  }
  const hasNaN = Object.values(nanCount).some(v => v > 0);
  if (hasNaN) {
    console.log('\n⚠ NaN/UNDEFINED DETECTED:');
    for (const [k, v] of Object.entries(nanCount)) {
      if (v > 0) console.log(`  ${k}: ${v} cells`);
    }
  } else {
    console.log('\n✓ No NaN/undefined in critical fields');
  }

  console.log('=== END DIAGNOSTIC ===');
}

// ── Precipitation-focused diagnostic ──
function printPrecipDiagnostic() {
  console.log('\n=== PRECIPITATION DIAGNOSTIC ===');

  const land = [];
  const ocean = [];
  for (let i = 0; i < TOTAL; i++) {
    if (state.cells[i].isLand) land.push(i);
    else ocean.push(i);
  }

  let zeroPrecip = 0, lowPrecip = 0, modPrecip = 0, highPrecip = 0;
  for (const i of land) {
    const p = state.cells[i].precipitation || 0;
    if (p < 0.001) zeroPrecip++;
    else if (p < 0.05) lowPrecip++;
    else if (p < 0.2) modPrecip++;
    else highPrecip++;
  }
  const pct = (n) => (n / Math.max(1, land.length) * 100).toFixed(1);
  console.log('Land precipitation distribution:');
  console.log(`  Zero (<0.001):       ${zeroPrecip} (${pct(zeroPrecip)}%)`);
  console.log(`  Low (0.001-0.05):    ${lowPrecip} (${pct(lowPrecip)}%)`);
  console.log(`  Moderate (0.05-0.2): ${modPrecip} (${pct(modPrecip)}%)`);
  console.log(`  High (>0.2):         ${highPrecip} (${pct(highPrecip)}%)`);

  let zeroOceanMoist = 0;
  for (const i of ocean) {
    const m = state.cells[i].atmosphericMoisture || 0;
    if (m < 0.001) zeroOceanMoist++;
  }
  console.log(`\nOcean cells with zero moisture: ${zeroOceanMoist} / ${ocean.length} (${(zeroOceanMoist / Math.max(1, ocean.length) * 100).toFixed(1)}%)`);

  let barren = 0, photo = 0, chemo = 0, mixo = 0, other = 0;
  for (const i of land) {
    const ft = state.cells[i].floraType;
    if (ft === 'photosynthetic') photo++;
    else if (ft === 'chemotrophic') chemo++;
    else if (ft === 'mixotrophic') mixo++;
    else if (ft === 'barren') barren++;
    else other++;
  }
  console.log('\nFlora distribution:');
  console.log(`  Barren:          ${barren} (${pct(barren)}%)`);
  console.log(`  Photosynthetic:  ${photo} (${pct(photo)}%)`);
  console.log(`  Chemotrophic:    ${chemo} (${pct(chemo)}%)`);
  console.log(`  Mixotrophic:     ${mixo} (${pct(mixo)}%)`);
  if (other) console.log(`  Other (frozen):  ${other} (${pct(other)}%)`);

  console.log('\n--- Sample land cells ---');
  if (land.length) {
    const step = Math.max(1, Math.floor(land.length / 5));
    for (let s = 0; s < 5; s++) {
      const i = land[Math.min(land.length - 1, s * step)];
      const c = state.cells[i];
      const x = i % W;
      const y = Math.floor(i / W);
      const lat = ((y / H) * 180 - 90).toFixed(1);
      console.log(`  Cell (${x},${y}) lat=${lat}: elev=${(c.elevation || 0).toFixed(3)} precip=${(c.precipitation || 0).toFixed(4)} atmoMoist=${(c.atmosphericMoisture || 0).toFixed(4)} windSpd=${(c.windSpeed || 0).toFixed(3)} gw=${(c.groundwater || 0).toFixed(3)} wa=${(c.waterAvailability || 0).toFixed(3)} flora=${c.floraType} density=${(c.floraDensity || 0).toFixed(3)}`);
    }
  }

  console.log('=== END PRECIPITATION DIAGNOSTIC ===');
}

export { generatePlanet };
