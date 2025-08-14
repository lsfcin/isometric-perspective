# Isometric Perspective — Enhanced Fork

This fork builds on the excellent Isometric Perspective module and adds focused improvements for occlusion, isometric fidelity, overlays, flipping, and wall integration.

Core credits: All foundational work belongs to the original author and project:
- Original repo: https://github.com/arlosmolten/isometric-perspective
- Please support and reference the original project for the base module, vision, and design.

This fork: https://github.com/lsfcin/isometric-perspective

## What’s new in this fork

- Token occlusion that doesn’t alter tile appearance
  - “Occluding Tokens” flag keeps tiles visually unchanged; occlusion is rendered via clones on the tokens layer.
  - New “Occlusion Opacity” slider (Isometric tab) controls how dim the tile appears only while occluding tokens.
  - Slider is visible only when “Occluding Tokens” is enabled.

- Door‑linked visibility
  - If a tile is linked to a wall configured as a door and the door is open, the tile is fully hidden (original + clones).

- Overlays and interaction polish
  - Selection/hover overlays reliably render above tiles and clones.
  - Orange manipulation rectangle restored and hover‑only.

- Geometric fidelity and anchoring
  - Prevent isometric art distortion on resize: scale based on the longest side to preserve aspect.
  - Bottom‑left anchoring for tile art and transforms; offsets applied in that basis.

- Flip quality of life
  - One‑click flip swaps width/height and keeps the bottom edge fixed (y compensation).
  - Inverts offsetY to maintain bottom‑anchored alignment.
  - Keeps the Isometric tab active and updates the native manipulation rectangle on the first click.
  - Double‑flip cancels cleanly with no drift.

- Linked walls follow tiles (move, resize, flip)
  - You can link walls to a tile (IDs in the Isometric tab). Linked walls:
    - Move and scale as the tile moves/resizes.
    - Flip correctly with the tile using stable, anchor‑space math (bottom‑left basis).
    - Persist manual wall edits: editing a wall updates stored anchors so later tile moves keep your changes.
  - Anchors are auto‑created for any linked walls and healed if missing or from older bases.
  - Flip behavior for walls mirrors along the isometric diagonal by swapping normalized local anchors (dx ↔ dy); two flips restore the original.

- Dynamic controls for occlusion opacity and flip
  - “Increase/Decrease Dynamic Tile Opacity” buttons now adjust the selected tiles’ Occlusion Opacity (same value as the Isometric tab slider), not a global layer alpha.
  - New “Flip Selected Tiles” button in the Tiles controls: batch‑flips selected tiles with the same semantics as the Isometric tab (swap width/height, fix bottom edge, toggle tokenFlipped, invert offsetY). Existing wall‑follow logic applies.

- Occlusion parity and ordering
  - Non‑occluding tiles render normally (no dimming, appear as in base canvas).
  - Occluder clones draw on the tokens layer for correct stacking with tokens; non‑occluding clones draw on the tiles layer.
  - Simple grid‑based z‑ordering to keep visuals consistent in isometric scenes.

### Tile Image Presets (New)

An opt‑in lightweight system that automatically remembers isometric adjustments (offsets, scale, flip, occlusion flags, linked walls & anchors) per image filename and reapplies them to future tiles using the same image.

How it works:
- In the Tile Isometric tab there is a single checkbox: "Store and Use Preset".
- When checked (default), any meaningful update to the tile (other than pure movement) overwrites a hidden preset keyed by the image file name.
- Creating a new tile with the same image automatically applies the stored preset (size, flags, and wall clones if the new tile has no walls yet).
- Linked walls are cloned with preserved relative anchors if Include Walls conditions are met (auto‑apply only when destination tile has none).
- Deleting a tile removes any uniquely linked cloned walls (walls still referenced by other tiles are kept).

Opting out:
- Uncheck "Store and Use Preset" on a specific tile to prevent saving future changes and to ignore auto‑application for that tile.

Diagnostics & power‑users:
- A console helper is exposed (window.ISO_TILE_PRESETS) with get / save / apply / del for manual experimentation.
- Presets are stored in a hidden world setting and survive restarts.

This replaces earlier, fuller preset UI controls with a minimal workflow focused on zero‑click reuse.

## Compatibility

- Tested on Foundry VTT v12. Some compatibility paths for v11 are kept where feasible.
- PIXI rendering is used for clone layers. Overlays are managed to remain above tiles.

## Installation

- Install this fork like a standard Foundry module, or clone into your Foundry data modules folder:
  - `${UserData}/Data/modules/isometric-perspective`
- Enable the module in your world.
- Settings to consider:
  - World isometric flag
  - Enable dynamic occlusion for tiles

## Usage tips

- Per‑tile settings live in the Tile configuration under the “Isometric” tab:
  - Enable “Occluding Tokens” to make a tile participate in occlusion.
  - Adjust “Occlusion Opacity” for how strongly the tile dims while it occludes tokens.
  - Use offsets and scale to align isometric art; resizing preserves aspect.
  - Use the Flip checkbox for single‑tile adjustment.
  - Link wall IDs to make walls follow the tile. Manual edits to walls are preserved.
- Scene toolbar (Tiles controls):
  - Increase/Decrease Dynamic Tile Opacity: Adjusts the per‑tile Occlusion Opacity for selected tiles.
  - Flip Selected Tiles: Batch‑flip any selected tiles (and their linked walls).

## Acknowledgements

- Massive thanks to the original author and contributors of Isometric Perspective. This fork exists to iterate on specific workflows while honoring the original architecture and design.
- For core concepts, groundwork, and ongoing inspiration, please visit and support the original project:
  - https://github.com/arlosmolten/isometric-perspective

## License

- This fork follows the licensing terms of the original project. See the original repository for license details and attribution requirements.
