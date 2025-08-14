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
  // Gather full wall metadata (clone most properties excluding runtime-only). Keep original 'c' for reference; we'll overwrite.
  let wallMeta = {};
  try {
    const ids = Array.isArray(collected.linkedWallIds) ? collected.linkedWallIds : [];
    for (const wid of ids) {
      const wall = canvas?.walls?.get(wid);
      if (!wall?.document) continue;
      const raw = wall.document.toObject();
      // Strip volatile fields
      delete raw._id;
      delete raw.sort; // sorting will be handled by Foundry
      // Keep flags & door-related fields intact
      wallMeta[wid] = raw;
    }
  } catch {}
  return {
    width: tileDocument.width,
    height: tileDocument.height,
    flags: collected,
    wallMeta
  };
}

export function saveTilePreset(name, tileDocument, { overwrite = false } = {}) {
  if (!name || !tileDocument) return;
  const all = loadAllPresets();
  let finalName = name.trim();
  if (!finalName) finalName = 'Preset';
  // Ensure uniqueness unless overwrite
  if (all[finalName] && !overwrite) {
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

export async function applyTilePreset(tileDocument, presetName, { includeSize = true, includeWalls = false } = {}) {
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
      // We'll rebuild walls separately if cloning; skip direct ID/anchor injection in that case
      if (k === 'linkedWallIds' || k === 'linkedWallAnchors') continue;
      update[`flags.${MODULE_ID}.${k}`] = v;
    }
  }
  await canvas.scene.updateEmbeddedDocuments('Tile', [update]);

  // Clone walls only if requested, tile currently has none, and preset had anchor data
  if (includeWalls) {
    try {
      const existing = tileDocument.getFlag(MODULE_ID, 'linkedWallIds') || [];
      if (Array.isArray(existing) && existing.length) return; // respect existing walls
      const anchors = data.flags?.linkedWallAnchors || {};
      const oldIds = data.flags?.linkedWallIds || [];
      if (!anchors || !oldIds.length) return;
      const wallMeta = data.wallMeta || {};
      const tx = Number(tileDocument.x) || 0;
      const ty = Number(tileDocument.y) || 0;
      const tw = Number(tileDocument.width) || 1;
      const th = Number(tileDocument.height) || 1;
      const bottomY = ty + th;
      const seen = new Set();
      const createData = [];
      const idToRel = {};
      for (const oldId of oldIds) {
        if (seen.has(oldId)) continue; // avoid duplicates
        seen.add(oldId);
        const rel = anchors[oldId];
        if (!rel || !rel.a || !rel.b) continue;
        const ax = tx + (rel.a.dx * tw);
        const ay = bottomY - (rel.a.dy * th);
        const bx = tx + (rel.b.dx * tw);
        const by = bottomY - (rel.b.dy * th);
        let meta = wallMeta[oldId] || {};
        // Backward compatibility: minimal meta
        const minimal = Object.keys(meta).every(k => ['door','ds','c'].includes(k));
        if (minimal) meta = { door: meta.door ?? 0, ds: meta.ds ?? 0 };
        // Start with meta clone
        const wallData = foundry.utils.duplicate(meta);
        // Overwrite coordinates
        wallData.c = [ax, ay, bx, by];
        // Sanitize reserved fields
        delete wallData._id; delete wallData.id; delete wallData.sort;
        // Some schemas use 'sight' others 'sense'; keep whichever exists
        if (wallData.sense && !wallData.sight) wallData.sight = wallData.sense;
        createData.push(wallData);
        idToRel[oldId] = rel;
      }
      if (!createData.length) return;
      const created = await canvas.scene.createEmbeddedDocuments('Wall', createData);
      const newIds = created.map(w => w.id);
      const newAnchors = {};
      for (let i = 0; i < newIds.length; i++) {
        const rel = idToRel[oldIds[i]] || Object.values(anchors)[i];
        if (rel) newAnchors[newIds[i]] = rel;
      }
      await tileDocument.setFlag(MODULE_ID, 'linkedWallIds', newIds);
      await tileDocument.setFlag(MODULE_ID, 'linkedWallAnchors', newAnchors);
      await tileDocument.setFlag(MODULE_ID, 'linkedWallAnchorsBasis', 'bottom');
    } catch (e) { if (DEBUG_PRINT) console.warn('Wall cloning failed in applyTilePreset', e); }
  }
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
