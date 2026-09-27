# CLAUDE.md — Planet-Viewer

Read this first. If the repo has an audit or design doc (a Fable audit was written 26 Sep 2026), read it before changing the code it covers.

## What this is

A procedural planet generator in the browser: plate tectonics and elevation, then atmosphere, currents and hydrology, then a
512×512 regional window (≈78 km per planetary cell, typed arrays in `regional-grid.js`) with drainage, substrate and flora, then tiles. Plain ES modules, no
framework, no dependencies, no build step. `index.html` loads `main.js` as a module; `state.js` holds the shared `state`
that every other file imports (no imports of its own, no DOM), `dom.js` is the only DOM touch the simulation modules make.
Units: the planetary and hi-res grids are in *planet units* (1.0 = 10 km, tuned, leave alone); the regional and tile grids are
in **metres**, converted once in regional-gen.js Pass 1a — `units.js` is the one place that says so. A tile chunk is 128×128
tiles of ≈1.19 m covering one regional cell. The world is an archipelago on purpose (3–11 % land); **seed 5 is the anchor**.

| file | owns |
|---|---|
| core-math.js | noise, RNG (`mulberry32`), coordinates, colour helpers; the planetary grid `W`×`H` (512×256) |
| state.js | the shared `state` object (and `state.seed`, the seed of the planet on screen) |
| dom.js | `byId` / `setStatus`, no-ops without a document |
| main.js | entry point, orchestration, binds the renderers' canvases |
| planet-gen.js | the planetary pipeline (steps 1–5b) |
| planet-geology.js | plates, geo seeds, elevation, minerals |
| planet-atmosphere.js | wind, currents, SST, precipitation, hydrology |
| planet-render.js | planetary rendering: flat, globe, Mollweide |
| terrain-derive.js | the terrain derivation function and the terrain/cover enums |
| palette-compute.js | the three-layer colour pipeline |
| units.js | elevation units: `ELEV_UNIT_M`, `puToM`, the shelf / coastal / deep-water thresholds in metres |
| regional-constants.js | the regional window's shared constants, tiles per regional cell, tile size |
| regional-grid.js | the regional window as typed arrays (struct-of-arrays, row-major), enum tables, `cell(rx, ry)` |
| regional-gen.js | regional detail generation |
| regional-drainage.js | `routeFlow`: padded priority-flood + D8 used by the regional window and tile chunks; stream order against the planet max |
| regional-substrate.js | grain size, saturation, water table depth |
| regional-flora.js | flora type, ground cover, canopy |
| regional-render.js | regional and tile rendering |
| hires-gen.js | high-resolution surface generation |
| tile-gen.js | tile/chunk generation (phase B) |
| ui.js | events, keys, view switching, tuning, snapshot |

## Run and look

Modules don't load from `file://`, so serve the folder: `npx serve .` or `python3 -m http.server`, then open `index.html`.
`node tools/smoke.mjs` runs planet → hi-res ×2 → region → tile under Node with invariant checks (≈25 s, no browser);
`tools/probe.mjs` drives the real page in headless Chromium and prints the measurements `DIAGNOSTIC.md` cites. Beyond
that the check is looking at it: from a cloud session the page can be opened in the pre-installed Chromium (Playwright)
and screenshotted; the person's own check is the pull request's preview link (below).

## Delivering a change

1. One change or one pass per pull request. Work on a `claude/…` branch, push it (`git push -u origin claude/…`), open a pull
   request into `main`. Never push to `main` (it is protected; the person's merge is the release), never force-push or rebase.
2. One branch per change, not per session (the person, 26 Sep 2026). Each new task starts a fresh `claude/…` branch from the
   current `origin/main` — this rule is standing permission to leave the session's assigned branch for it. Once a pull request
   is open, its branch takes only fixes to that pull request; follow-up work goes on a new branch and a new pull request, so
   the person can merge an open one while the session keeps working.
3. Identity for commits is `WB <willbuzbee@gmail.com>` (`git config user.name WB`, `user.email willbuzbee@gmail.com` in the
   repo's local config; never any other name — the person, 26 Sep 2026). GitHub shows these commits "Unverified"; accepted.
4. Pages (`.github/workflows/pages.yml`, `.github/publish.sh`, 26 Sep 2026) publishes the `gh-pages` branch: `main` is live at
   `https://william-are-buzbee.github.io/Planet-Viewer/`; a pull request is a preview at `…/preview/<number>/` (linked in a
   comment on it, removed when it closes); each merge is kept at `…/v/<date>-<commit>/`, never overwritten.
5. Say in the pull request what changed, why, what was looked at, and what the person should check on the preview.

## The person

- Concise replies, dry wit, no praise, no constant agreement. Disagree when reasonable. Be plain about what can and cannot be
  checked from a session.
- Likes questions and is open to ideas. When a design choice is theirs, ask, don't guess.
