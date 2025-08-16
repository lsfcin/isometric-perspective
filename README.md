# Isometric Perspective — Enhanced Fork

An actively maintained fork of the original Isometric Perspective module for Foundry VTT. This version focuses on: reliable occlusion, stable isometric transforms, wall + tile cohesion, flip ergonomics, and low‑friction per‑image presets.

Core credits: all foundational work belongs to the original author.
* Original project: https://github.com/arlosmolten/isometric-perspective
* This fork: https://github.com/lsfcin/isometric-perspective

## Highlights

### Occlusion & Visibility
* Tile occlusion without permanently dimming art: occluder clones are drawn on the token layer only while hiding tokens.
* Per‑tile Occlusion Opacity slider (visible only when “Occluding Tokens” is enabled).
* Door‑linked visibility: opening a linked door wall can fully hide a tile.

### Interaction & Rendering Polish
* Selection / hover overlays always above source and clone layers.
* Native manipulation rectangle restored and cleaned up.
* Resize logic preserves isometric aspect (longest side scale rule) — no art squashing.

### Geometry & Anchoring
* Bottom‑left anchor for transforms and offsets.
* One‑click horizontal flip swaps width/height while locking the bottom edge; offsetY inverted automatically; double flip restores original precisely.

### Linked Walls
* Walls can be attached to a tile so they move, resize, and flip with it.
* Relative anchor points stored (normalized in bottom‑left basis) and rebuilt if missing.
* Manual wall edits persist: moving endpoints updates stored anchors so subsequent tile adjustments keep intent.

### Batch Controls
* Toolbar buttons for Increase / Decrease Occlusion Opacity on selected tiles.
* Bring Selected Tiles to Front / Send Selected Tiles to Back — batch reorders by adjusting underlying Tile `sort` values while preserving relative order inside the selection.
* Batch Flip respects the same anchor logic and updates linked walls.

### Image Presets (Per Filename)
* Opt‑in (checkbox “Store and Use Preset”).
* Saves key isometric flags + offsets + flip + occlusion settings + wall linkage per image filename.
* Automatically re‑applies to new tiles with the same image (only clones walls if the destination tile has none yet).
* Tile deletion removes cloned walls that no other tile references.
* Minimal UI – no manual preset list clutter.

## Compatibility
* Target: Foundry VTT v12 (some v11 resilience retained).
* Uses PIXI layers for clones; integrates with standard walls and token elevation features.

## Installation
1. Install like any module or clone into your data folder: `${UserData}/Data/modules/isometric-perspective`
2. Enable the module in World Settings.
3. Optional world settings: enable global isometric flag; enable dynamic tile occlusion.

## Usage
Open a Tile’s configuration => “Isometric” tab:
* Toggle “Occluding Tokens”.
* Adjust Occlusion Opacity (only shown when occluding).
* Offsets & Scale for alignment (resize preserves aspect automatically).
* Flip checkbox for per‑tile orientation.
* Enter wall IDs (or use Attach UI if present) to link walls; they then follow transforms.
* “Store and Use Preset” keeps / reuses adjustments for identical image filenames.

Toolbar (Tiles layer) provides:
* Bring to Front / Send to Back (ordering)
* Increase / Decrease Occlusion Opacity
* Flip Selected Tiles

Console helper (for debugging): `window.ISO_TILE_PRESETS` with `get / save(name) / apply(name) / del(name)`.

## Roadmap

### Completed
* Dynamic token visibility no longer requires tiles to own walls.
* Context‑aware opacity handling (normal, behind token, door open scenario).
* Movement / flight path line drawn in the player’s color.
* Resize of the tile’s rectangle does not distort isometric artwork.
* Attached (linked) walls follow tile move, resize, and flip using anchored relative coordinates.
* Bring to Front / Send to Back ordering buttons (batch update Tile.sort).

### Planned / In Progress
* Define default settings for newly created tiles (auto‑preset opt‑in, initial scale, occlusion defaults).
* Fine‑tune drop placement (tile currently appears slightly above intended bottom‑left cursor point).
* Correct a minor grid alignment offset (sub‑pixel deviation on one axis).
* Open config popups docked to the right side instead of screen center.
* Allow non‑dynamic tiles to override dynamic tiles in render ordering when needed.
* Add per‑tile "max height" for occlusion logic (virtual vertical extent cap).
* Provide optional center‑anchor flip mode.
* Display & edit linked wall endpoints inline when a tile is selected (direct manipulation handles).
* Additional granular tile reordering (single-step up/down) UI.
* Dynamic lighting interaction for tiles (light blocking / emission integration).
* Hide direct elevation display or remap elevation to an internal height offset like tokens.
* Automatic shadow distance derived from tile height.
* Drop shadow option (square / round) for tiles and tokens.
* Token image rotation (preserving isometric projection rules).
* Animated tokens (spritesheet / frame cycling support).
* Multiple token image variants selectable by players.
* Explicit “Save Tile Adjustments to Image” button (UI wrapper around auto preset system).
* Explicit “Save Token Adjustments to Image” button.
* Auto‑draw ground shadow for tokens (no baked shadow needed in artwork).
* Perspective skew (shear) controls in Isometric tab.
* Isometric dice roll visual effect.

### Future Ideas / Experimental
* Dedicated corner dice rolling / animation area.

If an item matters to your workflow, open an issue describing the scenario. PRs welcome.

## Acknowledgements
Massive thanks to the original author and contributors of the Isometric Perspective project for the core foundations.

## License
Follows the original project’s license terms. See the upstream repository for details and attribution requirements.
