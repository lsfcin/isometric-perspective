// Tile Presets foundational API (Step 1)
// This first incremental step introduces only: persistent storage + helper
// functions to extract/store/apply presets programmatically (no UI yet).
// You can experiment via the browser console while we build further steps.

import { MODULE_ID, DEBUG_PRINT } from './main.js';

// Register the hidden world setting that will hold all presets
export function registerTilePresetStorage() {
  // Idempotent: if already registered, skip
  if (game.settings.settings.has(`${MODULE_ID}.tilePresets`)) return;
  game.settings.register(MODULE_ID, 'tilePresets', {
    name: 'Tile Presets Storage',
    hint: 'Internal storage for saved tile presets (managed by the module).',
    scope: 'world',
    config: false, // Hidden until UI is added
    type: Object,
    default: {}
  });
}

// ---- Data Shape ----
// Stored as: { [presetName]: { name, created, updated, data: { flags: {...}, width, height } } }

function loadAllPresets() {
  try { return foundry.utils.duplicate(game.settings.get(MODULE_ID, 'tilePresets')) || {}; }
  catch { return {}; }
}

function saveAllPresets(obj) {
  try { return game.settings.set(MODULE_ID, 'tilePresets', obj); }
  catch (e) { if (DEBUG_PRINT) console.warn('Failed to save tile presets', e); }
}

export function getTilePresets() {
  return loadAllPresets();
}

export function extractTilePreset(tileDocument) {
  if (!tileDocument) return null;
  const flags = tileDocument.getFlag(MODULE_ID, '') || {}; // bulk fetch not supported; collect individually
  // Explicitly collect known flags we care about now (others can be added later)
  const wanted = [
    'isoTileDisabled','scale','tokenFlipped','offsetX','offsetY',
    'OccludingTile','OcclusionAlpha','linkedWallIds','linkedWallAnchors'
  ];
  const collected = {};
  for (const k of wanted) {
    try { const v = tileDocument.getFlag(MODULE_ID, k); if (v !== undefined) collected[k] = foundry.utils.duplicate(v); } catch {}
  }
  return {
    width: tileDocument.width,
    height: tileDocument.height,
    flags: collected
  };
}

export function saveTilePreset(name, tileDocument) {
  if (!name || !tileDocument) return;
  const all = loadAllPresets();
  let finalName = name.trim();
  if (!finalName) finalName = 'Preset';
  // Ensure uniqueness
  if (all[finalName]) {
    let i = 2;
    while (all[`${finalName} (${i})`]) i++;
    finalName = `${finalName} (${i})`;
  }
  const data = extractTilePreset(tileDocument);
  const now = Date.now();
  all[finalName] = { name: finalName, created: now, updated: now, data };
  saveAllPresets(all);
  if (DEBUG_PRINT) console.log(`Saved tile preset '${finalName}'`, all[finalName]);
  return finalName;
}

export async function applyTilePreset(tileDocument, presetName, { includeSize = true, includeWalls = true } = {}) {
  if (!tileDocument || !presetName) return;
  const all = loadAllPresets();
  const preset = all[presetName];
  if (!preset) { if (DEBUG_PRINT) console.warn('Preset not found', presetName); return; }
  const { data } = preset;
  if (!data) return;
  const update = { _id: tileDocument.id };
  if (includeSize) {
    if (Number.isFinite(data.width)) update.width = data.width;
    if (Number.isFinite(data.height)) update.height = data.height;
  }
  if (data.flags && Object.keys(data.flags).length) {
    for (const [k, v] of Object.entries(data.flags)) {
      if (!includeWalls && (k === 'linkedWallIds' || k === 'linkedWallAnchors')) continue;
      update[`flags.${MODULE_ID}.${k}`] = v;
    }
  }
  await canvas.scene.updateEmbeddedDocuments('Tile', [update]);
}

export function deleteTilePreset(presetName) {
  const all = loadAllPresets();
  if (!all[presetName]) return false;
  delete all[presetName];
  saveAllPresets(all);
  return true;
}

// Convenience: expose to window for quick console tests until UI exists
Hooks.once('ready', () => {
  window.ISO_TILE_PRESETS = {
    get: getTilePresets,
    save: (name) => {
      const tile = canvas.tiles?.controlled?.[0]?.document; if (!tile) { ui.notifications.warn('Select a tile first'); return; }
      return saveTilePreset(name, tile);
    },
    apply: (name) => {
      const tile = canvas.tiles?.controlled?.[0]?.document; if (!tile) { ui.notifications.warn('Select a tile first'); return; }
      return applyTilePreset(tile, name);
    },
    del: deleteTilePreset
  };
  if (DEBUG_PRINT) console.log('Isometric Tile Presets API ready: window.ISO_TILE_PRESETS');
});
