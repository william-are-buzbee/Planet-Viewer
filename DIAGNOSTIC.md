# Planet Viewer — Diagnostic & Analysis

Date: 2026-09-26. Scope: read-only audit of all 17 source files (~9,400 lines), plus a headless
Chromium run to measure the claims below. No behaviour was changed. Numbers come from
`tools/probe.mjs` (see Appendix C) unless stated otherwise.

---

## 1. What this repo is

A single-page, dependency-free browser app (`index.html` + ES modules, no build step) that
procedurally generates an Earth-sized alien planet and lets you drill down through three
nested views:

1. **Planetary** — 512×256 cell grid (~78 km per cell at the equator). Plate tectonics,
   elevation, minerals, wind, ocean currents, sea-surface temperature, precipitation,
   groundwater, drainage, flora type. Rendered flat, as a globe, or as a Mollweide projection,
   with 19 overlays.
2. **High-res surface** — the planetary grid upsampled ×1/2/4/8 (default ×4 = 2048×1024) into
   typed arrays, with added coastline noise, substrate, water table, drainage, flora, terrain
   type and a precomputed colour per cell. This is what the planetary canvases actually draw.
3. **Regional** — click a planetary cell → a 512×512 window (one planetary cell, 78 km across,
   ~152 m per cell) read from the high-res grid, decorated with drainage-aligned noise, refined
   substrate/flora/water, and re-classified.
4. **Tile** — click a regional cell → a 512×512 chunk covering that one regional cell
   (~0.3 m per tile), with micro-topography, D8 drainage, ponds, Poisson-disk trees, per-tile
   palette and sprite-variant selection.

Run it with any static server (`python3 -m http.server`) and open `index.html`. There are no
tests, no README, no lint config; git history is 20 "Add files via upload" commits.

### 1.1 Module map and data flow

```
main.js            state object (single shared mutable store) + runGeneration()
 ├─ planet-gen.js         orchestrates steps 1–5b on state.cells (131k JS objects)
 │   ├─ planet-geology.js     plates → geo seeds → elevation → bathymetry → minerals
 │   ├─ planet-atmosphere.js  wind → currents → SST → moisture/precip → groundwater → drainage → temp
 │   └─ terrain-derive.js     THE terrain/cover classifier (shared by all layers)
 ├─ hires-gen.js          steps HR1–HR8 on state.hiResData (typed arrays, struct-of-arrays)
 ├─ planet-render.js      flat / globe / Mollweide renderers, streamlines, selection marker
 ├─ regional-gen.js       regional pipeline (two copies: HiRes path + dead LowRes path)
 │   ├─ regional-drainage.js  D8 flow accumulation + stream order (window-local)
 │   ├─ regional-substrate.js grain / saturation / water-table refinement
 │   └─ regional-flora.js     flora refinement, confidence, WTD-derived water
 ├─ regional-render.js    regional + tile canvases and overlay tables
 ├─ tile-gen.js           tile chunk pipeline T1–T7, chunk cache
 ├─ palette-compute.js    three-layer colour pipeline (physical state → bg/fg/mid)
 ├─ core-math.js          PRNG, noise, sphere maths, bilinear samplers
 ├─ regional-constants.js REGIONAL_SIZE / PLANETARY_CELL_KM / CELLS_PER_PLANETARY
 └─ ui.js                 all event wiring, tuning panel, region cache, snapshot panel
```

Data flows strictly downward: planet → hi-res → regional → tile. Each layer bilinearly samples
the layer above and adds noise. Only `deriveTerrainAndCover` and `computeTilePalette` are
genuinely shared; every other rule (flora fitness, water thresholds, freezing, deep/shallow) is
re-implemented per layer.

### 1.2 The three grids and their scales

| Layer | Grid | Covers | Cell size | Storage |
|---|---|---|---|---|
| Planetary | 512×256 | whole planet (≈40,000 km circumference) | ≈78 km | 131k JS objects, ~45 props each |
| Hi-res | 512m×256m (m = 1,2,4,8) | whole planet | 78 / 39 / 19.5 / 9.75 km | typed arrays, ~101 B/cell (≈212 MB at ×4, ≈850 MB at ×8) |
| Regional | 512×512 | **one** planetary cell (78 km) | ≈152 m | 262k JS objects, 59 props each ≈ **221 MB per region** |
| Tile | 512×512 | one regional cell (152 m) | ≈**0.30 m** | typed arrays, ~15 MB per chunk |

Two things stand out immediately:

- The regional placeholder text in `index.html` says "~1 km per cell". It is 152 m. The
  design drifted (probably from a 512-km "US state" region to a 78-km one) and the docs did not.
- A tile is 30 cm. Roguelike tiles are conventionally 1–2 m. The 512×512 chunk is a 150 m
  square, not a play area.

### 1.3 Coordinate conventions (where the layers disagree)

- Planetary sample points are at integer coordinates `(x, y)`; hi-res cell `hx` samples
  planetary `hx / m`. So planetary sample `x` sits at the **top-left corner** of the drawn
  planetary cell, not its centre.
- `core-math.js` and the atmosphere treat `y = 0` as latitude −90° (south). The globe renderer
  and its "N" HUD treat texture row 0 as north. The flat map draws row 0 at the top.
- Regional world coordinates are `planetaryX * 512 + rx` (global, seamless across regions).
  Tile world coordinates are `rx * 512 + tx` (region-relative, **not** global), so tile noise
  repeats identically in every region.
- Elevation has no defined unit (see Finding B1).

---

## 2. Measured baseline (headless Chromium, seed 5 unless noted)

| Measurement | Value |
|---|---|
| Planet generation, res ×1 | 8.4–11.8 s, of which atmosphere (step 4) = **6.1–6.8 s** |
| Hi-res generation ×1 / ×2 | 0.4 s / 1.1 s |
| Land fraction, seeds 5 / 42 / 7 | **6.9% / 10.7% / 3.3%** |
| One regional generation | 2.2 s, **+221 MB heap** |
| Heap after one click on the planet (region + 4 auto-precomputed neighbours) | ≈1.0 GB |
| Heap after one arrow-key pan | **1.74 GB** |
| One tile chunk | 0.5–0.7 s |
| Hi-res land cells whose land flag disagrees with the planetary cell (res ×2) | 1,772 of 16,586 = **10.7%** |
| Ocean-sentinel bleed at the default ×4: hi-res land cells whose bilinear footprint gives non-zero weight to an ocean cell | **10,141 cells (7.4% of land)**; their mean groundwater is **0.678** with plain bilinear vs **0.534** once ocean corners are masked (water availability 0.665 → 0.518) |
| Regional elevation span in one 78 km window vs the planetary span in the same window | **0.134 vs 0.031** (regional noise adds 4× the real relief) |
| Tile elevation span inside one 152 m regional cell (mid-slope grass, regional slope ≈0.001 across 3 cells) | **0.035** (35× the regional-scale variation over the same distance) |
| Same tile chunk: water tiles / stream-order-3 tiles / trees | 27,751 (10.6%) / 12,838 / 0 — in a regional cell with no water |
| Drain direction at fixed planetary points, res ×1 vs ×2 | mean 15° apart; 5.4% differ by >45°, 2% by >90° |
| Console/page errors during all of the above | none |

---

## 3. Findings, ranked by cost → reward

Tiers: **A** = cheap and clearly worth it (hours). **B** = contained structural work (a day or
two each), high payoff. **C** = design decisions to make before more feature work. **D** = minor
hygiene. Within a tier, higher = do first.

### Tier A — small fixes with visible payoff

**A1. Stale tile chunks survive a region change.** `state.tileChunkCache` is keyed only by
`rx,ry`. `handleRegionalPan` clears it only when a tile view is currently open
(`ui.js:~600`). Close the tile view, pan, open the same `(rx,ry)` → you get the previous
region's chunk. Verified: cache size 1 before and after the pan.
*Fix:* clear the cache in `startRegionGeneration`'s completion path (or key the cache by
`regionKey + rx,ry`). One line. Also invalidate the `regionCache` when tuning params change
(currently only on Generate).

**A2. Ocean sentinel values bleed into coastal land.** Ocean cells are assigned
`groundwater = 1.0` and `waterAvailability = 1.0` (`planet-atmosphere.js:~471,~532`).
`stepHR2_atmosphereRow` then bilinearly interpolates those fields onto hi-res land with no land
mask, and `regional-gen.js` does the same from the planetary grid. Measured at the default ×4:
7.4% of hi-res land cells take non-zero weight from an ocean corner, and on those cells plain
bilinear gives mean groundwater 0.678 where the land-masked value is 0.534 (water availability
0.665 vs 0.518). That +0.15 of invented wetness sits exactly on the coast band and feeds the
uniform coastal mud/marsh and the "OCEAN-FLIP" diagnostics still in the code. (An earlier draft
of this report quoted 0.59 vs 0.19 measured at ×1; that figure was wrong — at ×1 every hi-res
cell has a single corner with weight 1, so it was measuring real coastal groundwater, not bleed.)
*Fix:* land-masked bilinear for land-only fields (zero the weight of ocean corners, renormalise;
fall back to nearest land corner when all four are ocean). `regional-gen.js:~880` already does
exactly this for flora type (R3-FIX1) — reuse the pattern in `stepHR2` for precipitation,
groundwater, waterAvail, and in the regional planetary sampling block. ~30 lines.

**A3. Regional view is centred on the corner of the clicked cell, not the cell.** Click handler
floors to an integer cell; the regional window is centred on planetary coordinate `(x, y)`;
that coordinate is the top-left corner of the drawn cell (§1.3). The view is therefore offset by
half a cell (≈39 km on each axis, ≈55 km diagonal, i.e. most of the 78 km window) from where the
user clicked, and the selection marker is drawn at the corner too. Verified: regional centre
cell had planetary coords exactly `(120, 69)` after clicking inside cell `(120,69)`.
*Fix:* stop flooring in the three click handlers and pass fractional planetary coordinates
(`showRegionalView(fx, fy)`); the pipeline, cache key and pan code already handle fractional
centres. Update the region label to show the rounded cell. ~5 lines. Optionally also shift
`stepHR1/HR2` sampling by `+0.5/m − 0.5` so hi-res pixels are centre-sampled.

**A4. Region cache + synchronous neighbour precompute blow the heap and freeze the UI.** Each
region is 262k plain objects with 59 properties (≈221 MB). `ui.js` caches up to 8 and, after
every click or pan, synchronously generates all 4 neighbours on `setTimeout(0)` (4 × 2.2 s of
main-thread blocking, each printing the full regional diagnostic). Measured 1.74 GB heap after
one pan; add the ×8 hi-res grid (850 MB) and the tab is at Chrome's limit.
*Fix now:* `MAX_CACHE_SIZE = 2`, remove `precomputeNeighbors` (or gate it behind a checkbox)
until B3 makes regions cheap. ~10 lines. Cuts steady-state heap by >1 GB and removes ~9 s of
jank per click.

**A5. Atmosphere step is 6–7 s of an 8–12 s planet generation at only 131k cells.** The
obvious suspect (8-element offset arrays allocated per cell per pass, ≈14 M per generation) was
hoisted to module scope and made **no measurable difference**: V8 was already eliding them. A CPU
profile of one generation puts 42% of self time inside `step4_computeAtmosphere`, 7% in `wrapX`,
and the hottest lines are plain property reads and writes on the cell objects
(`state.cells[ni].isLand`, `c.windU = u`, `nc.windU * tdx`). The cost is object-per-cell access
across ~100 full-grid passes, not allocation. The hoist is kept (cleaner, zero risk) but the real
fix is **B7** below: the planetary grid as typed arrays, like `hiResData` already is. A cheaper
interim lever is the iteration counts (`currentIterations` 25, `sstAdvectionIterations` 18,
`moistureIterations` 35), which scale step 4 linearly.

**A6. Eight tuning sliders do nothing.** `subPeakMin`, `subPeakMax`, `subPeakSpread`,
`coastWidth`, `shapeNoiseAmp`, `drainageDepth`, `drainagePathsMin`, `drainagePathsMax` are in
`state.params` and the panel but referenced nowhere else.
*Fix:* delete them from `main.js` and `ui.js paramConfig`. 16 lines removed.

**A7. Search-and-replace damage.** `planet-render.js:96` registers the plates overlay under the
key `'state.plates'` (so the low-res fallback renders "surface" for it) and the file header reads
`state.planet-render.js`. Harmless today only because the fallback path is dead (B2).

### Tier B — structural, contained, high payoff

**B1. There is no elevation unit, and each layer has silently picked a different one.** The
planet produces dimensionless elevation (land max ≈0.75, ocean floor ≈−0.30…−0.43). Downstream
code reads that number four different ways:

| Where | Constant | Implied unit |
|---|---|---|
| planet-geology / hires coast noise | shelf −0.08, coast band 0.03, coast noise ±0.028 | 1.0 ≈ 5–10 km |
| regional-gen detail noise | `coastAmplitude` 0.10 (+`mountainDetail` 0.05) at ~10 km wavelength | adds ±1 km-ish relief inside 78 km (measured span 0.134 vs 0.031 real) |
| regional-substrate / regional-flora WTD | pushes of 0.02–0.55; flood thresholds −0.03…−0.25 "metres" | 1.0 ≈ 1 m |
| terrain-derive | `SHALLOW_WATER_TERRAIN_THRESHOLD = 0.05 // 5 cm` | 1.0 = 1 m |
| tile-gen | `ridgeAmp` 0.008–0.05 inside 152 m; `isDeep = depth > 0.25 // 25 cm`; snapshot prints `depth*100 cm` | 1.0 = 1 m |

The same number is a 10 km mountain in one file and a 1 m puddle in another: a factor of
~10,000. This is the root of "low res interpreted into high res looks bad": each layer down
*multiplies* relief instead of subdividing it (planet window 0.031 → regional 0.134 → tile
0.035 inside one regional cell), and tile-scale hydrology (12,838 stream-order-3 tiles, 10%
standing water in a dry grass cell) is computed on invented topography.
*Fix path:* (1) declare `ELEVATION_UNIT_M` once (recommend storing metres directly; Float32 is
fine); convert the planet output once at the end of step 2b. (2) Re-express every downstream
amplitude and threshold in metres with a comment saying what it physically is (regional detail
±50–150 m at 10 km wavelength; tile micro-relief ±0.5–2 m; WTD/water depth in metres). (3) Make
each layer's added relief a *fraction of the parent's local relief* (e.g. regional detail
amplitude ∝ local hi-res slope × cell size) so a flat lowland stays flat at every zoom. Medium
cost (~15 constants across 6 files, then re-tune by eye), and it is the prerequisite for any
believable cross-layer terrain.

**B2. ~900 lines of dead fallback code.** `generateHighResSurface` always allocates, so
`state.hiResData` is non-null except on allocation failure. Everything guarded by
`!state.hiResData` / `!state.planet` therefore never runs:
`generateRegionalDetailLowRes` (`regional-gen.js:126–518`, a near-verbatim copy of the HiRes
path including its "Bug 3 fix"), `computeRegionalSubstrate` (`regional-substrate.js:127–223`),
the non-hi-res branch of `refineRegionalFloraFromHiRes` + `computeRegionalFloraCell`
(`regional-flora.js:201–320`), `overlayFunctions`, `setPixel2x`, `getColorFn`,
`hiResColorAt`, `renderFlatFromHighRes` and the fallback branches of `render`/`renderMollweide`
(`planet-render.js`), plus the `_est*` fields in `step5b`. The LowRes path also indexes
`state.planet.streamOrder` with planetary-grid indices (wrong width) — it would be a bug if it
ever ran.
*Fix:* delete it all; on allocation failure show "reduce resolution" and stop. Every future
change to the regional pipeline currently has to be made twice; this halves that file.

**B3. Regional cells should be typed arrays (struct-of-arrays), like `hiResData`.** 221 MB and
2.2 s per region is object overhead, not maths. The same ~40 fields in Float32/Uint8 arrays are
≈35 MB, generate faster, cache trivially, and can be transferred to a Web Worker later.
Touches `regional-gen`, `-substrate`, `-flora`, `-drainage`, `-render`, `tile-gen
sampleRegionalContext`, and the snapshot panel. Do it after B2 (half the code to convert).
Cost: a day. Reward: enables 8-region caching *and* removes the UI freezes A4 only papers over.

**B4. Regional drainage is window-local, so rivers cannot cross regions.** `computeRegionalDrainage`
starts flow accumulation from zero at the window border; the drain *direction* was made
globally deterministic (good), but the *accumulation* was not, so the same cell has a different
stream order depending on which window it is viewed in, and panning re-draws the river network.
The hi-res pass computes global `flowAccum` in `stepHR5` and then discards it, keeping only
`streamOrder`.
*Fix path:* keep `flowAccum` in `hiResData`; in the regional pass seed each cell's initial flow
with the bilinear hi-res upstream flow (or inject it along the window's inflow border). Medium
cost. This is a hard requirement for the stated goal of traversing region to region.

**B5. Tile chunk scale and coordinates.** 30 cm tiles, region-relative noise coordinates, and a
`seed` that is just the global seed mean every region's tiles look the same and none of them
are the size of a game tile. Two options: keep "one chunk = one regional cell" and use
`CHUNK_W = 128` (1.19 m tiles, 16× faster tile gen), or keep 512 tiles and make a chunk span
~5 regional cells. Either way tile world coords must become
`(regionWorldX + rx) * CHUNK_W + tx`. Decide together with B1. Small code change, but a design
decision.

**B6. Untestable module graph.** Every module imports `state` from `main.js` (a cycle through
the entry point), and the render modules call `document.getElementById` at import time. Nothing
can be imported in Node, so the only way to check anything is a browser run — which is why the
code is full of `console.log` diagnostics ("Session 24", "S24", "R1-FIX3") instead of assertions.
*Fix:* move `state` to `state.js` with no imports; lazy-init canvases on first render. Mechanical,
low cost. Then `tools/probe.mjs` (Appendix C) can become a real regression harness, and the pure
simulation modules can get Node tests.

**B7. Planetary grid as typed arrays.** `state.cells` is 131k objects with ~45 properties plus a
nested `minerals` object, and the profile (A5) shows step 4's 6–7 s is dominated by property
access on them across ~100 grid passes. The same struct-of-arrays layout as `hiResData` would
cut planet generation by a large factor, halve its memory, and make the simulation transferable
to a Web Worker. It touches every consumer of `state.cells` (geology, atmosphere, flora,
hires-gen, regional planetary sampling, renderers, snapshot panel), so it is a day of mechanical
work; do it together with B3 so both grids end up with one accessor convention.

### Tier C — design points to settle before more features

**C1. Land fraction.** Default `continentalBase = −0.08` puts continental crust *below* sea
level on average; land is whatever noise, mountains and hotspots push up. Result: 3–11% land
across three seeds (Earth: 29%). If that is the intent (an ocean world), fine, but the tuning
panel's "Earth-like" preset (−0.05) will not produce Earth-like land either. Worth a deliberate
choice; it changes what the regional/tile layers spend most of their time rendering.

**C2. One flora fitness function, one water metric.** Photo/chemo/mixo fitness is written out in
four places (`planet-gen.js step5`, `hires-gen.js HR6`, `regional-flora.js ×2`) with three
different water inputs (`waterAvailability`; `min(1, precip·3 + gw·1.5)`; `max(saturation,
waterAvailability)`). The regional layer stopped re-deriving flora type because of the resulting
disagreements (R2-FIX1) and instead inherits it from hi-res — a reasonable patch, but the
"confidence" machinery on top of it (`pelaConf`, `kolmConf`, `fitnessConfidence`) now measures
agreement with a formula that is not the one that chose the type. Export one
`floraFitness(water, mineralTotal, volcanism)` and one documented water metric.

**C3. Threshold constants are duplicated with drift.** Deep/shallow water is `−0.08` in the
planet and regional layers but `−0.1` in hi-res and `terrain-derive`; the tile layer uses a
depth of `0.25`. Freezing is `temperature < 0.5` in four files. `isCoastal` is `0 < elev < 0.03`
in four files. Put them in one constants module (fold `regional-constants.js` into it).

**C4. Hemisphere convention.** Simulation says row 0 is the south pole; the globe HUD labels it
north. Only Coriolis-dependent things are affected (ocean gyre rotation sense, Ekman upwelling
coasts appear on the mirrored hemisphere relative to the "N" marker). Pick one convention and
fix either `core-math.toSphere`/atmosphere `lat` or the globe mapping. Low cost, low urgency.

**C5. Drain direction depends on the resolution dropdown.** `stepHR1b` uses a fixed 3-hi-res-cell
radius, i.e. 0.375–3 planetary cells depending on the multiplier (the comment claims it matches
the low-res 1.5-cell radius; it only does at ×2). Measured: 15° mean difference between ×1 and
×2, 5% of samples >45°. Express the radius in planetary cells (`Math.round(1.5 * m)`).

### Tier D — hygiene

- ~68 `console.log` calls; per-generation diagnostics (`printWeatherDiagnostic`,
  `printPrecipDiagnostic`, `printRegionalDiagnostic`, `printTileDiagnostic`, WTD/OCEAN-FLIP/
  HIGH-BARREN counters, "Session 28" timings) run unconditionally, including four times per
  click via the neighbour precompute. Gate behind a `DEBUG` flag or delete.
- Dead exports/helpers: `seededRNG`, `computeRegionalBaseCell`, `wrappedNoise`, `fractalNoise`,
  `sphericalDist`, `toSphere`, `wrappedDist`, `toRad`, `bilinearInterpolate` in `hires-gen.js`
  (only used by a diagnostic), `acrossDrain` (unused local, `regional-gen.js:730`),
  `overlayColorAt`, the entire `selectSpriteVariant` cover switch (every branch returns 0).
- `computeTileDrainage` uses `tilePrecip[0]` as the "average" precipitation for its thresholds.
- `positionHash` multiplies without `Math.imul`, so the hash loses low bits on overflow.
- `getLatitudeBand` and the temperature formula hard-code 128/25/64/192/230 instead of using `H`.
- Canvas click mapping uses `getBoundingClientRect()` which includes the 1 px CSS border
  (sub-pixel error, cosmetic).
- Selecting a region in flat view and then switching to Globe bakes the flat-view marker box
  into the globe texture until the next `render()` (`setView` does not re-render the flat canvas
  first).
- `step2b_coastalBathymetry` forces any ocean cell adjacent to land to ≤ −0.015 and the next ring
  to ≈ −0.13, so continental shelves are exactly one planetary cell wide regardless of seed.

---

## 4. Recommended order of work

1. **Day 1 — Tier A in one PR.** A1, A2, A3, A4, A5, A6, A7. All are local, none change the
   architecture, and together they fix the two things a user notices first (region not where
   you clicked; coasts all mud) and stop the tab from eating 1.7 GB. **Applied — see §5.**
2. **Day 2 — B2 then B6.** Delete the dead paths, extract `state.js`, lazy-init canvases. Pure
   subtraction plus a mechanical move; makes everything after it cheaper and testable.
3. **Decide B1 + B5 + C1 together** (units, tile size, land fraction). These are design calls
   only you can make; write the answers into a `constants.js` header comment and then re-tune
   the regional and tile amplitudes against real metres. Expect a visible improvement in the
   regional and tile views for the first time.
4. **B3 — regional struct-of-arrays.** Now that the regional code is half the size and unit-
   consistent, convert it. This unlocks caching, a Web Worker, and region-to-region traversal.
5. **B4 — global flow accumulation into the regional layer.** The last piece needed before
   "move across the tile map to traverse the regional" is meaningful.
6. Tier C2–C5 and Tier D opportunistically as those files are touched.

What I would *not* do: add features, presets, or overlays before steps 1–3. Every one of the
"R1-FIX"/"R2-FIX"/"S24" patches in the code is a symptom-level fix for a unit or resolution
mismatch; more of those will keep the treadmill going.

---

## 5. Tier A — applied (same branch, second commit)

| Item | Change | Before → after (`tools/probe.mjs`) |
|---|---|---|
| A1 | `tileChunkCache` cleared wherever `state.regionalCells` is replaced | chunk cache after a pan with the tile view closed: 1 → **0** |
| A2 | land-masked bilinear for precipitation / groundwater / waterAvail in `stepHR2`; for waterAvailability / drainage in the regional planetary sample | mean groundwater on the 10,141 affected coastal cells: 0.678 → **0.534** |
| A3 | click handlers pass fractional planetary coords; `mollweidePixelToCell` / `globePixelToCell` return fractional; labels and snapshot use the containing cell | regional centre vs click: 0.5 cell off → **exact** (centre at 122.40, 69.78 for a click at 122.40, 69.78) |
| A4 | `MAX_CACHE_SIZE` 8 → 2; neighbour precompute removed | heap after one pan: 1,742 MB → **561 MB**; no 4×2.2 s freeze after each click |
| A5 | offset arrays hoisted; erosion loop allocation-free | step 4: 6.1–6.8 s → **unchanged** (see A5 text; real fix is B7) |
| A6 | 8 dead params and their sliders removed | — |
| A7 | `'state.plates'` → `'plates'`; header comment fixed | — |

Unchanged by design (Tier B/C work): 221 MB per region, regional relief 0.134 vs 0.031, tile
relief 0.035 inside one regional cell, 15° drain-direction drift between ×1 and ×2, 10.7%
land-mask disagreement. No console or page errors in any run.

---

## Appendix A — Dead code inventory (candidates for deletion in B2)

| File | Range / symbol | Why dead |
|---|---|---|
| regional-gen.js | `generateRegionalDetailLowRes` 126–518 | only reached when hi-res allocation fails |
| regional-gen.js | `computeRegionalBaseCell`, `seededRNG` | unreferenced |
| regional-substrate.js | `computeRegionalSubstrate` 127–223 | LowRes path only |
| regional-flora.js | `computeRegionalFloraCell` 201–320 and the `else` branch at 33–47 | LowRes path only |
| planet-render.js | `overlayFunctions` (53–168), `setPixel2x`, `getColorFn`, `overlayColorAt`, `hiResColorAt`, `renderFlatFromHighRes`, fallback halves of `render` and `renderMollweide` | `state.planet` is always set |
| planet-gen.js | `_est*` fields in `step5b` | consumed only by the dead `overlayFunctions.surface` |
| main.js / ui.js | 8 unused params + slider configs | never read |
| core-math.js | `wrappedNoise`, `fractalNoise`, `sphericalDist`, `toSphere`, `wrappedDist`, `toRad` | unreferenced |
| tile-gen.js | cover switch in `selectSpriteVariant` | all branches identical |

## Appendix B — Duplicated rules (candidates for a shared module)

| Rule | Copies | Files |
|---|---|---|
| Flora fitness (photo/chemo/mixo) | 4 | planet-gen, hires-gen, regional-flora ×2 |
| Ground cover / canopy / chemo-crust formulas | 3 | hires-gen HR6, regional-flora (refine), regional-flora (compute) |
| WTD drainage adjustment table + tidal push | 2 | regional-substrate ×2 |
| Regional Pass 1b/1c (drain dir, convergence, channel noise, cell build) | 2 | regional-gen (HiRes, LowRes) |
| Deep/shallow thresholds | 5 (two values) | planet-geology, hires-gen, regional-gen ×2, terrain-derive |
| Freezing (`temperature < 0.5`) | 4 | planet-atmosphere, regional-gen ×2, tile-gen |
| Terrain overlay colour tables | 3 | planet-render ×2, regional-render ×2 |
| Bilinear interpolation helpers | 4 | core-math ×2, hires-gen, regional-gen (+ inlined copies) |

## Appendix C — How the numbers were measured

`tools/probe.mjs` drives the real page in headless Chromium (Playwright): generates at ×1 for
three seeds, calls `generateRegionalDetail` / `generateTileDetail` directly, reads `state` via
`import('/main.js')`, and compares fields across resolutions. Run:

```
python3 -m http.server 8765 &          # in the repo root
node tools/probe.mjs
```

It needs `playwright` installed globally (or locally) and a Chromium it can find. It prints one
line per measurement and `ERRORS: none` if the page raised nothing. Treat it as the seed of a
regression harness once B6 makes the simulation importable without a DOM.
