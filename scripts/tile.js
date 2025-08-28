import { MODULE_ID, DEBUG_PRINT } from './main.js';
import { autoApplyPresetForTile, findPresetByImage } from './presets.js';
import { applyIsometricTransformation } from './transform.js';

export function registerTileConfig() {
  // Helper to re-render the controls bar targeting the Tiles palette (v13 style), with fallback
  const rerenderTilesControls = () => {
    try {
      if (typeof ui.controls?.render === 'function') {
  const currentControl = ui.controls?.control?.name || 'tiles';
  const currentTool = ui.controls?.tool?.name;
  ui.controls.render(false, { control: currentControl, tool: currentTool });
      } else if (typeof ui.controls?.initialize === 'function') {
        // v12 fallback
  ui.controls.initialize();
      }
    } catch { /* no-op */ }
  };
  Hooks.on("renderTileConfig", handleRenderTileConfig);

  Hooks.on("createTile", handleCreateTile);
  Hooks.on("updateTile", handleUpdateTile);
  Hooks.on("refreshTile", handleRefreshTile);
  Hooks.on("updateWall", handleUpdateWall);
  Hooks.on('getSceneControlButtons', injectTileLayerButtons);

  // Ensure the controls bar re-renders once after ready so our injected tools appear
  Hooks.once('ready', () => {
    try {
  if (typeof ui.controls?.render === 'function') ui.controls.render(false, { control: ui.controls?.control?.name || 'tiles', tool: ui.controls?.tool?.name });
      else if (typeof ui.controls?.initialize === 'function') ui.controls.initialize();
    } catch {}
  });

  // Modify live SceneControls after it renders to ensure tools are present; re-render once if changed
  let lastInjectAt = 0;
  Hooks.on('renderSceneControls', (app, html) => {
    try {
      const now = performance.now();
      if (now - lastInjectAt < 150) return; // avoid rapid loops
      // Snapshot tool names before injection when possible
      const list = Array.isArray(app?.controls) ? app.controls : (Array.isArray(app?.controls?.controls) ? app.controls.controls : null);
      const before = list ? JSON.stringify(list) : null;
      injectTileLayerButtons(app);
      const after = list ? JSON.stringify(list) : null;
      if (before !== after) {
        lastInjectAt = now;
        const ctrl = app?.control?.name || ui.controls?.control?.name || 'tiles';
        const tool = app?.tool?.name || ui.controls?.tool?.name;
        if (typeof app.render === 'function') app.render(false, { control: ctrl, tool });
      }
    } catch {}
  });

  // Rebuild controls when a tile becomes selected OR when all tiles become deselected.
  // This keeps custom buttons visible only while at least one tile is selected, while avoiding
  // flicker during rapid selection switches (deselect old -> select new in same frame).
  Hooks.on('controlTile', (tile, controlled) => {
    try {
      if (controlled) {
    // Immediate refresh when a tile is selected so buttons appear.
    rerenderTilesControls();
      } else {
        // Defer: if after a short delay no tiles remain controlled, remove buttons.
        setTimeout(() => {
          try {
            const any = Array.from(canvas.tiles?.controlled || []).length > 0;
      if (!any) rerenderTilesControls();
          } catch { }
        }, 40);
      }
    } catch { }
  });

  // Track the raw drop point for tile creation so we can correct placement
  Hooks.on('dropCanvasData', (_canvas, data) => {
    try {
      if (!data) return;
      const t = (data.type || '').toLowerCase();
      if (t === 'tile' || t === 'tiles') {
        // Compute the bottom-left corner of the hovered grid cell and use that as the desired bottom-left.
        // Rationale: user wants the tile rectangle to sit slightly below the cursor, aligned to the grid cell's bottom edge.
        const rawX = Number(data.x) || 0;
        const rawY = Number(data.y) || 0;
        const gridSize = (canvas?.grid?.size) || (canvas?.dimensions?.size) || 1;
        // Identify the cell containing the cursor
        const cellX = Math.floor(rawX / gridSize);
        const cellY = Math.floor(rawY / gridSize);
        const snappedBLX = cellX * gridSize;            // left edge of cell
        const snappedBLY = (cellY + 1) * gridSize;      // bottom edge of cell
        lastTileDesiredBottomLeft = { x: snappedBLX, y: snappedBLY, ts: performance.now() };
      }
    } catch { }
  });
}

// Last recorded intended bottom-left point for a tile (from the most recent drop)
let lastTileDesiredBottomLeft = null;

// ---- Toolbar Injection ----
function injectTileLayerButtons(controlsArg) {
  // Foundry v13 may pass a non-array structure here. Normalize to the underlying array if possible.
  let controls = null;
  if (Array.isArray(controlsArg)) {
    controls = controlsArg;
  } else if (controlsArg && Array.isArray(controlsArg.controls)) {
    controls = controlsArg.controls;
  } else if (controlsArg && Array.isArray(controlsArg?.controls?.controls)) {
    controls = controlsArg.controls.controls;
  }
  if (!controls) return; // Unknown structure; do nothing for safety

  // Try to find the Tiles control robustly across versions
  let tilesCtl = controls.find(b => b && (b.name === 'tiles' || b.name === 'tile' || (typeof b.layer === 'string' && b.layer.toLowerCase() === 'tiles') || /tile/i.test(String(b.title || ''))));
  if (!tilesCtl) {
    try { if (DEBUG_PRINT) console.warn('[isometric-perspective] Tiles control not found; creating fallback Isometric Tiles control'); } catch {}
    tilesCtl = {
      name: 'isometric-tiles',
      title: 'Isometric Tiles',
      layer: 'tiles',
      icon: 'fa-solid fa-cube',
      tools: []
    };
    controls.push(tilesCtl);
  }
  if (!Array.isArray(tilesCtl.tools)) {
    try { tilesCtl.tools = Array.isArray(tilesCtl.tools) ? tilesCtl.tools : []; } catch { return; }
  }
  try { if (DEBUG_PRINT) console.log('[isometric-perspective] Injecting tools into Tiles control. Existing tools:', tilesCtl.tools.map(t => t?.name)); } catch {}
  // Determine isometric scene state
  let isIsoScene = false;
  try { isIsoScene = !!(canvas?.scene?.getFlag(MODULE_ID, 'isometricEnabled') || game.settings.get(MODULE_ID, 'worldIsometricFlag')); } catch { }

  // Always remove deprecated house/home icon if isometric scene
  if (isIsoScene) {
    try {
      tilesCtl.tools = tilesCtl.tools.filter(t => {
        if (!t) return false;
        const icon = String(t.icon || '');
        if (/fa-house|fa-home/i.test(icon)) return false;
        return true;
      });
    } catch { }
  }

  const selTiles = Array.from(canvas.tiles?.controlled || []);

  // Determine which layers are represented in the current selection
  let hasForeground = false;
  let hasBackground = false;
  try {
    for (const t of selTiles) {
      const layer = (t.document.getFlag(MODULE_ID, 'isoLayer') === 'background') ? 'background' : 'foreground';
      if (layer === 'background') hasBackground = true; else hasForeground = true;
      if (hasForeground && hasBackground) break;
    }
  } catch { }

  const applyLayer = async (layer) => {
    const sel = Array.from(canvas.tiles?.controlled || []);
    if (!sel.length) { ui.notifications?.warn('Select at least one tile'); return; }
    const updates = sel.map(t => ({ _id: t.document.id, [`flags.${MODULE_ID}.isoLayer`]: layer }));
    await canvas.scene.updateEmbeddedDocuments('Tile', updates);
  rerenderTilesControls();
  };

  // Ensure (create or update) layer toggle tools
  const ensureOrUpdate = (name, defFactory, activeState) => {
    let tool = tilesCtl.tools.find(t => t?.name === name);
    if (!tool) {
      tool = defFactory();
      tilesCtl.tools.push(tool);
    }
    tool.active = activeState; // update active each build
  };
  ensureOrUpdate('iso-layer-background', () => ({
    name: 'iso-layer-background',
    title: 'Background Layer',
    icon: 'fa-regular fa-square',
    toggle: true,
    active: hasBackground,
    onClick: () => applyLayer('background'),
  button: true,
  visible: true
  }), hasBackground);
  ensureOrUpdate('iso-layer-foreground', () => ({
    name: 'iso-layer-foreground',
    title: 'Foreground Layer',
    icon: 'fa-solid fa-square',
    toggle: true,
    active: hasForeground,
    onClick: () => applyLayer('foreground'),
  button: true,
  visible: true
  }), hasForeground);

  // Utility buttons: add once
  if (!tilesCtl.tools.some(t => t?.name === 'tile-bring-front')) tilesCtl.tools.push({
    name: 'tile-bring-front',
    title: 'Bring Selected Tiles to Front (Sort)',
    icon: 'fa-solid fa-arrow-up-wide-short',
    onClick: () => bringSelectedTilesToFront(),
  button: true,
  visible: true
  });
  if (!tilesCtl.tools.some(t => t?.name === 'tile-send-back')) tilesCtl.tools.push({
    name: 'tile-send-back',
    title: 'Send Selected Tiles to Back (Sort)',
    icon: 'fa-solid fa-arrow-down-short-wide',
    onClick: () => sendSelectedTilesToBack(),
  button: true,
  visible: true
  });
  if (!tilesCtl.tools.some(t => t?.name === 'dynamic-tile-flip')) tilesCtl.tools.push({
    name: 'dynamic-tile-flip',
    title: 'Flip Selected Tiles',
    icon: 'fa-solid fa-arrows-left-right',
    onClick: () => flipSelectedTiles(),
  button: true,
  visible: true
  });
  // Occluding opacity adjustment buttons (appear with selection, below flip)
  async function adjustSelectedOccludingOpacity(delta) {
    try {
      const selected = Array.from(canvas.tiles?.controlled || []);
      if (!selected.length) return;
      const updates = [];
      for (const t of selected) {
        const doc = t.document;
        // Only relevant/visible for foreground tiles
        const layer = doc.getFlag(MODULE_ID, 'isoLayer');
        if (layer === 'background') continue;
        const cur = Number(doc.getFlag(MODULE_ID, 'OpacityOnOccluding'));
        const base = Number.isFinite(cur) ? cur : 0.5;
        let next = base + delta;
        if (!Number.isFinite(next)) next = base;
        next = Math.max(0, Math.min(1, next));
        updates.push({ _id: doc.id, [`flags.${MODULE_ID}.OpacityOnOccluding`]: next });
      }
      if (updates.length) await canvas.scene.updateEmbeddedDocuments('Tile', updates);
    } catch (e) { if (DEBUG_PRINT) console.warn('adjustSelectedOccludingOpacity failed', e); }
  }
  // Ensure increase button is inserted before decrease for visual order
  if (!tilesCtl.tools.some(t => t?.name === 'tile-occ-opacity-inc')) tilesCtl.tools.push({
    name: 'tile-occ-opacity-inc',
    title: 'Increase Occlusion Opacity',
    icon: 'fa-solid fa-circle-plus',
    onClick: () => adjustSelectedOccludingOpacity(+0.05),
  button: true,
  visible: true
  });
  if (!tilesCtl.tools.some(t => t?.name === 'tile-occ-opacity-dec')) tilesCtl.tools.push({
    name: 'tile-occ-opacity-dec',
    title: 'Decrease Occlusion Opacity',
    icon: 'fa-solid fa-circle-minus',
    onClick: () => adjustSelectedOccludingOpacity(-0.05),
  button: true,
  visible: true
  });

  try { if (DEBUG_PRINT) console.log('[isometric-perspective] Tools after injection:', tilesCtl.tools.map(t => t?.name)); } catch {}

  // Inject CSS once to make "active" state for our layer buttons look like a mild brightness boost
  // without the default pressed/contour styling.
  try {
    if (!document.getElementById('iso-layer-highlight-style')) {
      const style = document.createElement('style');
      style.id = 'iso-layer-highlight-style';
      style.textContent = `#controls .control-tool[data-tool="iso-layer-background"].active,\n#controls .control-tool[data-tool="iso-layer-foreground"].active {\n  box-shadow: none !important;\n  border: none !important;\n  filter: brightness(1.35);\n}\n#controls .control-tool[data-tool="iso-layer-background"].active i,\n#controls .control-tool[data-tool="iso-layer-foreground"].active i {\n  text-shadow: 0 0 4px rgba(255,255,255,0.4);\n}`;
      document.head.appendChild(style);
    }
  } catch { }
}

async function handleRenderTileConfig(app, html, data) {
  const doc = app.object ?? app.document; // v12 uses object, v13 may use document
  if (!doc) return;
  const linkedWallIds = doc.getFlag(MODULE_ID, 'linkedWallIds') || [];
  const $html = (html && typeof html.find === 'function') ? html : $(html);
  const wallIdsString = Array.isArray(linkedWallIds) ? linkedWallIds.join(', ') : linkedWallIds;

  // Carrega o template HTML para a nova aba
  const isoLayer = doc.getFlag(MODULE_ID, 'isoLayer') || 'foreground';
  const tabHtml = await renderTemplate("modules/isometric-perspective/templates/tile-config.html", {

    // Default should be unchecked/false so opening the config doesn't disable isometric tiles
    isoDisabled: doc.getFlag(MODULE_ID, 'isoTileDisabled') ?? 0,
    scale: doc.getFlag(MODULE_ID, 'scale') ?? 1,
    isFlipped: doc.getFlag(MODULE_ID, 'tokenFlipped') ?? false,
    offsetX: doc.getFlag(MODULE_ID, 'offsetX') ?? 0,
    offsetY: doc.getFlag(MODULE_ID, 'offsetY') ?? 0,
    linkedWallIds: wallIdsString,
    isForeground: isoLayer !== 'background',
    isBackground: isoLayer === 'background',
    hideOnFog: doc.getFlag(MODULE_ID, 'hideOnFog') ?? false,

    opacityOnOccluding: doc.getFlag(MODULE_ID, 'OpacityOnOccluding') ?? 0.5,
    useImagePreset: doc.getFlag(MODULE_ID, 'useImagePreset') ?? true
  });

  // Adiciona a nova aba ao menu
  const tabs = $html.find('.tabs:not(.secondary-tabs)');
  const group = tabs.attr('data-group') || tabs.data('group') || 'primary';
  tabs.append(`<a class="item" data-tab="isometric"><i class="fas fa-cube"></i> ${game.i18n.localize('isometric-perspective.tab_isometric_name')}</a>`);

  // Adiciona o conteúdo da aba após a última aba existente e garante o mesmo data-group
  const lastTab = $html.find('.tab').last();
  const $isoTab = $(tabHtml);
  $isoTab.attr('data-group', group);
  lastTab.after($isoTab);

  // Update the offset fine adjustment button
  updateAdjustOffsetButton($html);

  // Re-bind Foundry's Tabs controller so the newly added tab link/content become interactive
  try {
    const tabsApi = app._tabs?.[0] ?? app.tabs?.[0];
    if (tabsApi && typeof tabsApi.bind === 'function') tabsApi.bind($html[0]);
    const $nav = $html.find('.tabs:not(.secondary-tabs)');
    // Add a dedicated click handler as a fallback to ensure activation works
    $nav.find('a.item[data-tab="isometric"]').off('click.isometric').on('click.isometric', (ev) => {
      ev.preventDefault();
      const t = app._tabs?.[0] ?? app.tabs?.[0];
      if (t && typeof t.activate === 'function') return t.activate('isometric');
      // Fallback manual activation
      $nav.find('a.item').removeClass('active');
      $(ev.currentTarget).addClass('active');
      $html.find('.tab').removeClass('active');
      $html.find('.tab[data-tab="isometric"]').addClass('active');
    });
  } catch {}

  // Inicializa os valores dos controles
  const isoTileCheckbox = $html.find('input[name="flags.isometric-perspective.isoTileDisabled"]');
  const flipCheckbox = $html.find('input[name="flags.isometric-perspective.tokenFlipped"]');
  const linkedWallInput = $html.find('input[name="flags.isometric-perspective.linkedWallIds"]');
  const layerSelect = $html.find('select[name="flags.isometric-perspective.isoLayer"]');
  const occOpacitySlider = $html.find('input[name="flags.isometric-perspective.OpacityOnOccluding"]');
  const occOpacityGroup = $html.find('.occluding-opacity-group');
  const occHideOnFogGroup = $html.find('.hide-on-fog-group');
  const hideOnFogCheckbox = $html.find('input[name="flags.isometric-perspective.hideOnFog"]');

  // Preset checkbox (declare early so we can set default before later code references)
  const usePresetCheckbox = $html.find('input[name="flags.isometric-perspective.useImagePreset"]');

  isoTileCheckbox.prop("checked", doc.getFlag(MODULE_ID, "isoTileDisabled"));
  flipCheckbox.prop("checked", doc.getFlag(MODULE_ID, "tokenFlipped"));
  hideOnFogCheckbox.prop("checked", doc.getFlag(MODULE_ID, "hideOnFog"));
  linkedWallInput.val(wallIdsString);

  // Apply defaults for Place Tile flow (flags may be undefined before creation)
  const existingUsePreset = doc.getFlag(MODULE_ID, 'useImagePreset');
  const usePresetDefault = existingUsePreset === undefined ? true : existingUsePreset;

  // Initialize occluding opacity slider numeric label
  if (occOpacitySlider.length) {
  const existing = doc.getFlag(MODULE_ID, 'OpacityOnOccluding');
    const defaultVal = existing === undefined ? 0.5 : existing;
    occOpacitySlider.val(defaultVal);
    const occOpValSpan = occOpacitySlider.closest('.form-fields').find('.range-value');
    occOpValSpan.text(defaultVal);
  }
  if (usePresetCheckbox && usePresetCheckbox.length) usePresetCheckbox.prop('checked', usePresetDefault);

  // On Flip Tile toggle: invert Y offset and swap rectangle width/height; keep Isometric tab active
  flipCheckbox.on('change', async () => {
    try {
  const checked = flipCheckbox.prop('checked');

      // Read current document values (authoritative) and compute flip around bottom-left
  const offsetYEl = $html.find('input[name="flags.isometric-perspective.offsetY"]');
  const widthInput = $html.find('input[name="width"]');
  const heightInput = $html.find('input[name="height"]');
  const yInput = $html.find('input[name="y"]');

  const curOffY = Number(doc.getFlag(MODULE_ID, 'offsetY')) || 0;
  const w = Number(doc.width) || 0;
  const h = Number(doc.height) || 0;
  const yVal = Number(doc.y) || 0;
      const newY = yVal + (h - w);

      // Single document update so Foundry rebuilds the native manipulation rectangle immediately
      const update = {
        width: h,
        height: w,
        y: newY,
        flags: {
          [MODULE_ID]: {
            tokenFlipped: checked,
            offsetY: -curOffY
          }
        }
      };
  await doc.update(update);

      // Reflect the updated values in the current form manually
      offsetYEl.val((-curOffY).toFixed(0));
      offsetYEl.trigger('change');
      if (widthInput.length) widthInput.val(h);
      if (heightInput.length) heightInput.val(w);
  if (yInput.length) yInput.val(Number.isFinite(newY) ? String(newY) : String(doc.y));

      // Ensure the tile remains controlled so its frame is visible in the updated orientation
      requestAnimationFrame(() => {
        try {
          const pl = doc.object;
          if (pl?.control) pl.control({ releaseOthers: false, pan: false });
        } catch { }
      });

      // Ensure the Isometric tab remains active without a visible switch
  const tabs = app._tabs?.[0] ?? app.tabs?.[0];
  if (tabs && typeof tabs.activate === 'function') tabs.activate('isometric');
    } catch { }
  });

  // Show/hide occlusion alpha group based on occluding checkbox (respect default)
  const syncOccGroup = () => {
    const layer = layerSelect.val();
    // Hide occlusion alpha when background (no occlusion effect); show only for foreground
    occOpacityGroup.css('display', layer === 'foreground' ? 'flex' : 'none');
    occHideOnFogGroup.css('display', layer === 'foreground' ? 'flex' : 'none');
  };
  syncOccGroup();
  layerSelect.on('change', () => syncOccGroup());

  // Set initial state for simplified preset checkbox (already defaulted above)
  if (usePresetCheckbox && usePresetCheckbox.length && usePresetCheckbox.prop('checked') === false && usePresetDefault) {
    usePresetCheckbox.prop('checked', true);
  }

  // Live update for Isometric Scale slider label near that slider only
  const scaleSlider = $html.find('input[name="flags.isometric-perspective.scale"]');
  scaleSlider.on('input change', function () {
    const container = $(this).closest('.form-fields');
    container.find('.range-value').text(this.value);
  });

  // Live update for occluding opacity slider label
  occOpacitySlider.on('input change', function () {
    const container = $(this).closest('.form-fields');
    container.find('.range-value').text(this.value);
  });

  // Handler para o formulário de submit
  $html.find('form').on('submit', async (event) => {
    if ($html.find('input[name="flags.isometric-perspective.isoTileDisabled"]').prop("checked")) {
      await doc.setFlag(MODULE_ID, "isoTileDisabled", true);
    } else {
      await doc.unsetFlag(MODULE_ID, "isoTileDisabled");
    }

    if ($html.find('input[name="flags.isometric-perspective.tokenFlipped"]').prop("checked")) {
      await doc.setFlag(MODULE_ID, "tokenFlipped", true);
    } else {
      await doc.unsetFlag(MODULE_ID, "tokenFlipped");
    }

    // Persist isoLayer selection
    try {
      const layer = layerSelect.val() === 'background' ? 'background' : 'foreground';
  await doc.setFlag(MODULE_ID, 'isoLayer', layer);
    } catch { }

    // Persist per-token occluding opacity only if foreground
    if (occOpacitySlider.length && layerSelect.val() === 'foreground') {
      const v2 = Math.max(0, Math.min(1, parseFloat(occOpacitySlider.val())));
  await doc.setFlag(MODULE_ID, 'OpacityOnOccluding', v2);
    } else {
  try { await doc.unsetFlag(MODULE_ID, 'OpacityOnOccluding'); } catch { }
    }

  if ($html.find('input[name="flags.isometric-perspective.hideOnFog"]').prop("checked")) {
      await doc.setFlag(MODULE_ID, "hideOnFog", true);
    } else {
      await doc.unsetFlag(MODULE_ID, "hideOnFog");
    }

    // Persist simplified auto preset usage opt-in
  if ($html.find('input[name="flags.isometric-perspective.useImagePreset"]').prop('checked')) {
      await doc.setFlag(MODULE_ID, 'useImagePreset', true);
    } else {
      await doc.setFlag(MODULE_ID, 'useImagePreset', false);
    }

    // dynamictile.js linked wall logic
    const wallIdsValue = linkedWallInput.val();
    if (wallIdsValue) {
      const wallIdsArray = wallIdsValue.split(',').map(id => id.trim()).filter(id => id);
  await doc.setFlag(MODULE_ID, 'linkedWallIds', wallIdsArray);

      // Ensure we also have anchors for any manually-entered IDs
  try { await ensureAnchorsForWalls(doc, wallIdsArray); }
      catch (e) { if (DEBUG_PRINT) console.warn('ensureAnchorsForWalls failed', e); }
    } else {
  await doc.setFlag(MODULE_ID, 'linkedWallIds', []);
    }

    // After all persistence, refresh controls so layer button highlight reflects any layer change.
  try { if (canvas?.tiles?.controlled?.length) rerenderTilesControls?.(); } catch { }
  });

  // dynamictile.js event listeners for the buttons
  $html.find('button.select-wall').click(() => {
  Object.values(ui.windows).filter(w => String(w?.constructor?.name).includes('TileConfig')).forEach(j => j.minimize());
    canvas.walls.activate();

    Hooks.once('controlWall', async (wall) => {
      const selectedWallId = wall.id.toString();
      const currentWallIds = doc.getFlag(MODULE_ID, 'linkedWallIds') || [];
      if (!currentWallIds.includes(selectedWallId)) {
        const newWallIds = [...currentWallIds, selectedWallId];
        await doc.setFlag(MODULE_ID, 'linkedWallIds', newWallIds);
  $html.find('input[name="flags.isometric-perspective.linkedWallIds"]').val(newWallIds.join(', '));

        // Also store relative anchors so the wall follows the tile on move/resize
        try {
          const anchors = doc.getFlag(MODULE_ID, 'linkedWallAnchors') || {};
          const ep = getWallEndpoints(wall);
          const rel = computeWallAnchors(doc, ep);
          anchors[selectedWallId] = rel;
          await doc.setFlag(MODULE_ID, 'linkedWallAnchors', anchors);
        } catch (e) { if (DEBUG_PRINT) console.warn('Failed to set linkedWallAnchors', e); }
      }
      Object.values(ui.windows).filter(w => String(w?.constructor?.name).includes('TileConfig')).forEach(j => j.maximize());
      canvas.tiles.activate();
      requestAnimationFrame(() => {
        const tabs = app._tabs?.[0] ?? app.tabs?.[0];
        if (tabs && typeof tabs.activate === 'function') tabs.activate("isometric");
      });
    });
  });

  $html.find('button.clear-wall').click(async () => {
    await doc.setFlag(MODULE_ID, 'linkedWallIds', []);
    await doc.setFlag(MODULE_ID, 'linkedWallAnchors', {});
    $html.find('input[name="flags.isometric-perspective.linkedWallIds"]').val('');
    requestAnimationFrame(() => {
      const tabs = app._tabs?.[0] ?? app.tabs?.[0];
      if (tabs && typeof tabs.activate === 'function') tabs.activate("isometric");
    });
  });
}

// Hooks.on("createTile")
function handleCreateTile(tileDocument) {
  const tile = canvas.tiles.get(tileDocument.id);
  if (!tile) return;

  const scene = tile.scene;
  const isSceneIsometric = scene.getFlag(MODULE_ID, "isometricEnabled");

  requestAnimationFrame(() => applyIsometricTransformation(tile, isSceneIsometric));
  setTimeout(() => { autoApplyPresetForTile(tileDocument); }, 50);
  // Immediately apply default flags if no preset already exists for this image
  (async () => {
    try {
      const preset = findPresetByImage(tileDocument);
      if (preset) return; // existing preset will be auto-applied shortly
      const occluding = tileDocument.getFlag(MODULE_ID, 'OccludingTile');
      const alpha = tileDocument.getFlag(MODULE_ID, 'OcclusionAlpha');
      const usePreset = tileDocument.getFlag(MODULE_ID, 'useImagePreset');
      const needs = {};
      if (occluding === undefined) needs.OccludingTile = true;
      // Foundry (or previous versions) may yield an initial stored alpha of 1; treat that as baseline and replace with our module default 0.8
      if (alpha === undefined || alpha === 1) needs.OcclusionAlpha = 0.8;
      if (usePreset === undefined) needs.useImagePreset = true;
      if (Object.keys(needs).length) {
        await tileDocument.update({ flags: { [MODULE_ID]: needs } });
        if (DEBUG_PRINT) console.log('Applied immediate default tile flags', tileDocument.id, needs);
      }
    } catch (e) { if (DEBUG_PRINT) console.warn('Immediate default tile flag assignment failed', e); }
  })();

  // Schedule post-processing alignment passes so final bottom-left sits at drop point
  if (lastTileDesiredBottomLeft && isSceneIsometric) {
    const record = lastTileDesiredBottomLeft;
    if (!record.ts || (performance.now() - record.ts) < 2500) {
      const passes = [90, 180, 360]; // ms after create to attempt alignment (after preset & transforms)
      for (const delay of passes) {
        setTimeout(() => {
          try {
            // Tile might have been deleted or moved manually; only adjust if still near original.
            const doc = tileDocument;
            if (!doc?.parent) return;
            const desiredBLX = record.x;
            const desiredBLY = record.y;
            // Compute current bottom-left
            const curX = doc.x;
            const curY = doc.y;
            const curBLX = curX;
            const curBLY = curY + doc.height;
            const dx = desiredBLX - curBLX;
            const dy = desiredBLY - curBLY;
            // Skip if already very close
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
            // Apply correction: x shifts by dx; top-left y shifts by dy
            doc.update({ x: curX + dx, y: curY + dy }, { animate: false, [MODULE_ID]: { dropAlign: true } });
          } catch (e) { if (DEBUG_PRINT) console.warn('Deferred tile alignment failed', e); }
        }, delay);
      }
    }
    // Clear after scheduling so subsequent tiles can capture new point
    lastTileDesiredBottomLeft = null;
  }
}

// Hooks.on("updateTile")
function handleUpdateTile(tileDocument, updateData, options, userId) {
  const tile = canvas.tiles.get(tileDocument.id);
  if (!tile) return;

  console.log(userId, updateData, options);
  console.log("oldW:", tileDocument.width, "oldH:", tileDocument.height)

  const scene = tile.scene;
  const isSceneIsometric = scene.getFlag(MODULE_ID, "isometricEnabled");
  
  // Always reapply transform on any tile update to keep consistent isometric presentation
  requestAnimationFrame(() => applyIsometricTransformation(tile, isSceneIsometric));

  // Ensure anchors and update linked walls to follow on any tile update (drag, config, flip, reshape)
  (async () => {
    try {
      const ids = tileDocument.getFlag(MODULE_ID, 'linkedWallIds') || [];
      await ensureAnchorsForWalls(tileDocument, ids);
      const flippedToggled = !!(updateData?.flags && updateData.flags[MODULE_ID] && ("tokenFlipped" in updateData.flags[MODULE_ID]));
      if (flippedToggled) {
        await flipLinkedWallAnchorsHorizontally(tileDocument, ids);
        await updateLinkedWallsPositions(tileDocument);
      } else {
        updateLinkedWallsPositions(tileDocument);
      }

      // If layer changed, refresh controls so highlight updates even without reselecting
      if (updateData?.flags && updateData.flags[MODULE_ID] && ("isoLayer" in updateData.flags[MODULE_ID])) {
  try { if (canvas?.tiles?.controlled?.length) rerenderTilesControls(); } catch { }
      }
    } catch (e) { if (DEBUG_PRINT) console.warn('updateLinkedWallsPositions error', e); }
  })();
}

// Hooks.on("refreshTile")
function handleRefreshTile(tile) {
  const scene = tile.scene;
  const isSceneIsometric = scene.getFlag(MODULE_ID, "isometricEnabled");
  
  // If tile's size changes, update art/image offset accordingly
  if(isSceneIsometric) {

    // Determine dominant axis for resizing for lastest and current dimensions
    let latestMainAxis = Math.max(tile.document.lastWidth, tile.document.lastHeight);
    let currentMainAxis = Math.max(tile.document.width, tile.document.height);

    let proportion = currentMainAxis / latestMainAxis;

    if (proportion > 1.001 || proportion < 0.999) {
      let offX = tile.document.getFlag(MODULE_ID, 'offsetX');
      let offY = tile.document.getFlag(MODULE_ID, 'offsetY');

      // Round it to have no decimals
      offX *= proportion;
      offY *= proportion;

      tile.document.setFlag(MODULE_ID, 'offsetX', Math.round(offX));
      tile.document.setFlag(MODULE_ID, 'offsetY', Math.round(offY));
    }

    // Store last known dimensions of current tile
    tile.document.lastWidth = tile.document.width;
    tile.document.lastHeight = tile.document.height;
  }

  applyIsometricTransformation(tile, isSceneIsometric);
}


  function updateAdjustOffsetButton($html) {
  const offsetPointContainer = $html.find('.offset-point')[0];

  // Finds the fine adjustment button on the original HTML
  if (!offsetPointContainer) return;
  const adjustButton = offsetPointContainer.querySelector('button.fine-adjust');
  if (!adjustButton) return;

  // Configures the fine adjustment button
  adjustButton.style.width = '30px';
  adjustButton.style.cursor = 'pointer';
  adjustButton.style.padding = '1px 5px';
  adjustButton.style.border = '1px solid #888';
  adjustButton.style.borderRadius = '3px';
  adjustButton.title = game.i18n.localize('isometric-perspective.tile_artOffset_mouseover'); //Hold and drag to fine-tune X and Y

  // Adds the fine adjustment logic
  let isAdjusting = false;
  let startX = 0;
  let startY = 0;
  let originalValueX = 0;
  let originalValueY = 0;

  let offsetXInput = $html.find('input[name="flags.isometric-perspective.offsetX"]')[0];
  let offsetYInput = $html.find('input[name="flags.isometric-perspective.offsetY"]')[0];
  if (!offsetXInput || !offsetYInput) return;

  // Function to apply adjustment
  const applyAdjustment = (e) => {
    if (!isAdjusting) return;

    // Calculates the difference on x and y axes
    const deltaY = e.clientX - startX;
    const deltaX = startY - e.clientY;

    // Fine tuning: every 10px of motion = 0.1 value 
    const adjustmentX = deltaX * 0.1;
    const adjustmentY = deltaY * 0.1;

    // Calculates new values
    let newValueX = Math.round(originalValueX + adjustmentX);
    let newValueY = Math.round(originalValueY + adjustmentY);

    // Rounding for 2 decimal places
    newValueX = Math.round(newValueX * 100) / 100;
    newValueY = Math.round(newValueY * 100) / 100;

    // Updates anchor inputs
    offsetXInput.value = newValueX.toFixed(0);
    offsetYInput.value = newValueY.toFixed(0);
    offsetXInput.dispatchEvent(new Event('change', { bubbles: true }));
    offsetYInput.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Listeners for Adjustment
  adjustButton.addEventListener('mousedown', (e) => {
    isAdjusting = true;
    startX = e.clientX;
    startY = e.clientY;

    // Obtains the original values ​​of offset inputs
    originalValueX = parseFloat(offsetXInput.value);
    originalValueY = parseFloat(offsetYInput.value);

    // Add global listeners
    document.addEventListener('mousemove', applyAdjustment);
    document.addEventListener('mouseup', () => {
      isAdjusting = false;
      document.removeEventListener('mousemove', applyAdjustment);
    });

    e.preventDefault();
  });
}

// ---- Linked Walls follow Tile movement/scale ----
function getWallEndpoints(wallPlaceable) {
  const c = wallPlaceable?.document?.c || [0, 0, 0, 0];
  return { ax: Number(c[0]) || 0, ay: Number(c[1]) || 0, bx: Number(c[2]) || 0, by: Number(c[3]) || 0 };
}

function computeWallAnchors(tileDocument, endpoints) {
  // Use bottom-left basis to match isometric bottom anchoring
  const tx = Number(tileDocument.x) || 0;
  const ty = Number(tileDocument.y) || 0;
  const tw = Math.max(1, Number(tileDocument.width) || 1);
  const th = Math.max(1, Number(tileDocument.height) || 1);
  const bottomY = ty + th;
  const toRel = (x, y) => ({ dx: (x - tx) / tw, dy: (bottomY - y) / th });
  return { a: toRel(endpoints.ax, endpoints.ay), b: toRel(endpoints.bx, endpoints.by) };
}

async function updateLinkedWallsPositions(tileDocument) {
  const wallIds = tileDocument.getFlag(MODULE_ID, 'linkedWallIds') || [];
  if (!wallIds.length) return;
  const anchors = tileDocument.getFlag(MODULE_ID, 'linkedWallAnchors') || {};

  const tx = Number(tileDocument.x) || 0;
  const ty = Number(tileDocument.y) || 0;
  const tw = Number(tileDocument.width) || 0;
  const th = Number(tileDocument.height) || 0;
  const bottomY = ty + th;

  const updates = [];
  for (const id of wallIds) {
    const wall = canvas.walls.get(id);
    if (!wall?.document) continue;
    const rel = anchors[id];
    if (!rel) continue;
    const ax = tx + (rel.a.dx * tw);
    const ay = bottomY - (rel.a.dy * th);
    const bx = tx + (rel.b.dx * tw);
    const by = bottomY - (rel.b.dy * th);
    updates.push({ _id: id, c: [ax, ay, bx, by] });
  }

  if (updates.length) {
    try { await canvas.scene.updateEmbeddedDocuments('Wall', updates, { animate: false, [MODULE_ID]: { fromTileFollow: true } }); }
    catch (e) { if (DEBUG_PRINT) console.warn('Walls update failed', e); }
  }
}

async function ensureAnchorsForWalls(tileDocument, wallIdsArray) {
  if (!Array.isArray(wallIdsArray) || !wallIdsArray.length) return;
  const anchors = tileDocument.getFlag(MODULE_ID, 'linkedWallAnchors') || {};
  let mutated = false;
  const basis = tileDocument.getFlag(MODULE_ID, 'linkedWallAnchorsBasis');
  // Migrate/normalize anchors to bottom-left basis if missing or not set
  if (basis !== 'bottom') {
    for (const id of wallIdsArray) {
      const wall = canvas.walls.get(id);
      if (!wall?.document) continue;
      const ep = getWallEndpoints(wall);
      anchors[id] = computeWallAnchors(tileDocument, ep);
      mutated = true;
    }
    if (mutated) await tileDocument.setFlag(MODULE_ID, 'linkedWallAnchorsBasis', 'bottom');
  }
  for (const id of wallIdsArray) {
    if (anchors[id]) continue;
    const wall = canvas.walls.get(id);
    if (!wall?.document) continue;
    const ep = getWallEndpoints(wall);
    anchors[id] = computeWallAnchors(tileDocument, ep);
    mutated = true;
  }
  if (mutated) await tileDocument.setFlag(MODULE_ID, 'linkedWallAnchors', anchors);
}

// Exported utility: normalize linked wall IDs input into an array of strings
export function ensureWallIdsArray(linkedWallIds) {
  if (!linkedWallIds) return [];
  if (Array.isArray(linkedWallIds)) return linkedWallIds;
  if (typeof linkedWallIds === 'string') {
    if (!linkedWallIds.trim()) return [];
    return linkedWallIds.split(',').map(id => id.trim()).filter(id => id);
  }
  if (typeof linkedWallIds === 'object') {
    try {
      return JSON.stringify(linkedWallIds)
        .replace(/[{}\[\]"]/g, '')
        .split(',')
        .map(id => id.trim())
        .filter(id => id);
    } catch (e) { return []; }
  }
  return [];
}

// ---- Sorting & Flip Helpers (migrated from dynamic tile system) ----
async function bringSelectedTilesToFront() {
  try {
    const selected = Array.from(canvas.tiles?.controlled || []);
    if (!selected.length) return;
    const allSorts = canvas.tiles.placeables.map(t => typeof t.document?.sort === 'number' ? t.document.sort : 0);
    const maxSort = allSorts.length ? Math.max(...allSorts) : 0;
    const ordered = selected.sort((a, b) => (a.document.sort || 0) - (b.document.sort || 0));
    let next = maxSort + 1;
    const updates = ordered.map(t => ({ _id: t.document.id, sort: next++ }));
    console.log(updates);
    await canvas.scene.updateEmbeddedDocuments('Tile', updates);
  } catch (e) { if (DEBUG_PRINT) console.warn('bringSelectedTilesToFront failed', e); }
}

async function sendSelectedTilesToBack() {
  try {
    const selected = Array.from(canvas.tiles?.controlled || []);
    if (!selected.length) return;
    const allSorts = canvas.tiles.placeables.map(t => typeof t.document?.sort === 'number' ? t.document.sort : 0);
    const minSort = allSorts.length ? Math.min(...allSorts) : 0;
    const ordered = selected.sort((a, b) => (a.document.sort || 0) - (b.document.sort || 0));
    let start = minSort - ordered.length;
    const updates = ordered.map(t => ({ _id: t.document.id, sort: start++ }));
    await canvas.scene.updateEmbeddedDocuments('Tile', updates);
  } catch (e) { if (DEBUG_PRINT) console.warn('sendSelectedTilesToBack failed', e); }
}

async function flipSelectedTiles() {
  try {
    const selected = Array.from(canvas.tiles?.controlled || []);
    if (!selected.length) return;
    const updates = [];
    for (const t of selected) {
      const doc = t.document;
      const w = Number(doc.width) || 0;
      const h = Number(doc.height) || 0;
      const yVal = Number(doc.y) || 0;
      const curOffY = Number(doc.getFlag(MODULE_ID, 'offsetY')) || 0;
      const flipped = !!doc.getFlag(MODULE_ID, 'tokenFlipped');
      const newY = yVal + (h - w);
      updates.push({
        _id: doc.id,
        width: h,
        height: w,
        y: newY,
        [`flags.${MODULE_ID}.tokenFlipped`]: !flipped,
        [`flags.${MODULE_ID}.offsetY`]: -curOffY
      });
    }
    if (updates.length) await canvas.scene.updateEmbeddedDocuments('Tile', updates);
  } catch (e) { if (DEBUG_PRINT) console.warn('flipSelectedTiles failed', e); }
}

// Flip anchors diagonally across the line dx=dy (swap) around the tile's bottom-left origin
async function flipLinkedWallAnchorsHorizontally(tileDocument, wallIds) {
  if (!Array.isArray(wallIds) || !wallIds.length) return;
  const anchors = tileDocument.getFlag(MODULE_ID, 'linkedWallAnchors') || {};
  let mutated = false;
  for (const id of wallIds) {
    const rel = anchors[id];
    if (!rel) continue;
    // Diagonal reflection: swap local normalized coordinates
    const a = { dx: rel.a.dy, dy: rel.a.dx };
    const b = { dx: rel.b.dy, dy: rel.b.dx };
    anchors[id] = { a, b };
    mutated = true;
  }
  if (mutated) {
    await tileDocument.setFlag(MODULE_ID, 'linkedWallAnchors', anchors);
    await tileDocument.setFlag(MODULE_ID, 'linkedWallAnchorsBasis', 'bottom');
  }
}

// When a wall is edited manually, refresh anchors for tiles that link it
async function handleUpdateWall(wallDocument, changes, options, userId) {
  try {
    const fromTileFollow = (options && ((options[MODULE_ID] && options[MODULE_ID].fromTileFollow) || options[MODULE_ID + '_fromTileFollow'])) ? true : false;
    if (fromTileFollow) return; // ignore self-induced updates
    if (!changes?.c) return; // only care about endpoint edits
    const wallId = wallDocument.id;
    const tiles = canvas.tiles.placeables || [];
    const endpoints = { ax: Number(changes.c[0] ?? wallDocument.c[0]), ay: Number(changes.c[1] ?? wallDocument.c[1]), bx: Number(changes.c[2] ?? wallDocument.c[2]), by: Number(changes.c[3] ?? wallDocument.c[3]) };
    const updates = [];
    for (const t of tiles) {
      const ids = t.document.getFlag(MODULE_ID, 'linkedWallIds') || [];
      if (!ids.includes(wallId)) continue;
      const anchors = t.document.getFlag(MODULE_ID, 'linkedWallAnchors') || {};
      anchors[wallId] = computeWallAnchors(t.document, endpoints);
      // Persist anchors and basis
      await t.document.setFlag(MODULE_ID, 'linkedWallAnchors', anchors);
      await t.document.setFlag(MODULE_ID, 'linkedWallAnchorsBasis', 'bottom');
    }
  } catch (e) { if (DEBUG_PRINT) console.warn('handleUpdateWall failed', e); }
}
