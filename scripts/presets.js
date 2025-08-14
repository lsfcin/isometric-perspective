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

function deriveImageKey(tileDocument) {
  try {
    const src = tileDocument?.texture?.src || tileDocument?.document?.texture?.src || tileDocument?.img || tileDocument?.texture || tileDocument?.data?.img;
    if (!src) return null;
    const clean = src.split('?')[0].split('#')[0];
    const parts = clean.split('/');
    const file = parts.pop() || clean;
    return file.toLowerCase();
  } catch { return null; }
}

function attachImageKey(presetEntry, tileDocument) {
  if (!presetEntry) return presetEntry;
  const key = deriveImageKey(tileDocument);
  if (key) presetEntry.imageKey = key;
  return presetEntry;
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
  // If tile has linked walls but no stored anchors, compute anchors now (bottom-left basis)
  try {
    const hadLinked = Array.isArray(collected.linkedWallIds) && collected.linkedWallIds.length;
    if (hadLinked && !collected.linkedWallAnchors) {
      const tx = Number(tileDocument.x) || 0;
      const ty = Number(tileDocument.y) || 0;
      const tw = Math.max(1, Number(tileDocument.width) || 1);
      const th = Math.max(1, Number(tileDocument.height) || 1);
      const bottomY = ty + th;
      const anchors = {};
      for (const wid of collected.linkedWallIds) {
        const wall = canvas?.walls?.get(wid);
        if (!wall?.document) continue;
        const c = wall.document.c || wall.document.data?.c || [0,0,0,0];
        const ax = Number(c[0])||0, ay=Number(c[1])||0, bx=Number(c[2])||0, by=Number(c[3])||0;
        const toRel = (x,y)=> ({ dx: (x - tx)/tw, dy: (bottomY - y)/th });
        anchors[wid] = { a: toRel(ax,ay), b: toRel(bx,by) };
      }
      if (Object.keys(anchors).length) collected.linkedWallAnchors = anchors;
    } else if (!hadLinked) {
      // No walls: ensure anchors removed.
      delete collected.linkedWallAnchors;
    }
  } catch (e) { if (DEBUG_PRINT) console.warn('Failed computing anchors during preset extraction', e); }
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
  // Sanitize: if no linked walls, remove anchors & wallMeta
  try {
    const f = data?.flags || {};
    if (!Array.isArray(f.linkedWallIds) || !f.linkedWallIds.length) {
      if (f.linkedWallAnchors) delete f.linkedWallAnchors;
      if (data.wallMeta) data.wallMeta = {};
    }
  } catch {}
  const now = Date.now();
  const entry = { name: finalName, created: now, updated: now, data };
  attachImageKey(entry, tileDocument);
  all[finalName] = entry;
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

  // Clone walls only if requested and tile currently has none (or only stale references), and preset had anchor data
  if (includeWalls) {
    try {
      let existing = tileDocument.getFlag(MODULE_ID, 'linkedWallIds') || [];
      existing = existing.filter(id => !!canvas.walls.get(id)); // drop stale IDs for detection
      const anchors = data.flags?.linkedWallAnchors || {};
      let oldIds = data.flags?.linkedWallIds || [];
      if ((!anchors || !Object.keys(anchors).length) && DEBUG_PRINT) console.warn('Preset apply: no anchors found, skipping wall cloning');
  if (!anchors || !Object.keys(anchors).length) return; // cannot safely clone without anchors
      // Fallback: if linkedWallIds empty but we have anchor keys, derive from anchor keys
      if (!oldIds.length) oldIds = Object.keys(anchors);
      if (Array.isArray(existing) && existing.length) { if (DEBUG_PRINT) console.log('Preset apply: tile already has walls, skipping clone'); return; }
      // Additional safety: detect if matching walls already exist spatially in scene (from previous accidental clone)
      const tw = Number(tileDocument.width) || 1;
      const th = Number(tileDocument.height) || 1;
      const tx = Number(tileDocument.x) || 0;
      const ty = Number(tileDocument.y) || 0;
      const bottomY = ty + th;
      const planned = [];
      for (const oid of oldIds) {
        const rel = anchors[oid];
        if (!rel) continue;
        const ax = tx + (rel.a.dx * tw);
        const ay = bottomY - (rel.a.dy * th);
        const bx = tx + (rel.b.dx * tw);
        const by = bottomY - (rel.b.dy * th);
        // Normalize ordering & rounding for comparison tolerance (1px)
        const key = (ax < bx || (ax === bx && ay <= by)) ? `${Math.round(ax)}:${Math.round(ay)}-${Math.round(bx)}:${Math.round(by)}` : `${Math.round(bx)}:${Math.round(by)}-${Math.round(ax)}:${Math.round(ay)}`;
        planned.push(key);
      }
      const existingNear = new Set();
      if (planned.length) {
        for (const w of canvas.walls.placeables) {
          const c = w.document?.c || [0,0,0,0];
          const ax = c[0], ay = c[1], bx = c[2], by = c[3];
          const key = (ax < bx || (ax === bx && ay <= by)) ? `${Math.round(ax)}:${Math.round(ay)}-${Math.round(bx)}:${Math.round(by)}` : `${Math.round(bx)}:${Math.round(by)}-${Math.round(ax)}:${Math.round(ay)}`;
          if (planned.includes(key)) existingNear.add(key);
        }
      }
      if (existingNear.size === planned.length && planned.length) {
        if (DEBUG_PRINT) console.log('Preset apply: matching walls already exist in scene; skipping clone');
        return;
      }
      const wallMeta = data.wallMeta || {};
      const seen = new Set();
      const createData = [];
      const idToRel = {};
      const usedOldIds = [];
      for (const oldId of oldIds) {
        if (seen.has(oldId)) continue; // avoid duplicates
        seen.add(oldId);
        const rel = anchors[oldId];
        if (!rel || !rel.a || !rel.b) continue;
  if (DEBUG_PRINT) console.log('Preset apply: cloning wall', oldId, rel);
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
        usedOldIds.push(oldId);
      }
      if (!createData.length) return;
      const created = await canvas.scene.createEmbeddedDocuments('Wall', createData);
      const newIds = created.map(w => w.id);
      const newAnchors = {};
      for (let i = 0; i < newIds.length; i++) {
        const oldId = usedOldIds[i];
        const rel = idToRel[oldId];
        if (rel) newAnchors[newIds[i]] = rel;
      }
      await tileDocument.setFlag(MODULE_ID, 'linkedWallIds', newIds);
      await tileDocument.setFlag(MODULE_ID, 'linkedWallAnchors', newAnchors);
      await tileDocument.setFlag(MODULE_ID, 'linkedWallAnchorsBasis', 'bottom');
      if (DEBUG_PRINT) console.log('Cloned walls for preset', presetName, { created: newIds, anchors: newAnchors });
    } catch (e) { if (DEBUG_PRINT) console.warn('Wall cloning failed in applyTilePreset', e); }
  }
}

export function findPresetByImage(tileDocument) {
  const key = deriveImageKey(tileDocument);
  if (!key) return null;
  const all = loadAllPresets();
  for (const p of Object.values(all)) {
    if (p?.imageKey === key) return p;
  }
  return null;
}

export async function autoApplyPresetForTile(tileDocument) {
  try {
  // Respect per-tile opt-out
  const use = tileDocument.getFlag(MODULE_ID, 'useImagePreset');
  if (use === false) return false;
    const preset = findPresetByImage(tileDocument);
    if (!preset) return false;
    // Apply including walls by default for auto mode
    await applyTilePreset(tileDocument, preset.name, { includeSize: true, includeWalls: true });
    if (DEBUG_PRINT) console.log('Auto-applied image preset', preset.name, 'to tile', tileDocument.id);
    return true;
  } catch (e) { if (DEBUG_PRINT) console.warn('autoApplyPresetForTile failed', e); }
  return false;
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

// --- Auto Update Logic (Step 14) ---
// Strategy:
// 1. Each tile image filename acts as canonical preset key (imageKey).
// 2. On any tile update (except pure positional movement) we regenerate and overwrite that preset silently.
// 3. On tile creation we auto-apply (already handled) ensuring walls & size propagate to future clones.
// 4. We ignore updates that only change x or y.

function upsertImagePresetForTile(tileDocument) {
  try {
  const use = tileDocument.getFlag(MODULE_ID, 'useImagePreset');
  if (use === false) return;
    const key = deriveImageKey(tileDocument);
    if (!key) return;
    // Reuse existing preset with same imageKey or create new deterministic name based on filename
    const all = getTilePresets();
    let existingName = null;
    for (const [n,p] of Object.entries(all)) { if (p.imageKey === key) { existingName = n; break; } }
    const baseName = key.replace(/\.[a-z0-9]+$/i,'');
    const name = existingName || baseName;
    saveTilePreset(name, tileDocument, { overwrite: true });
    if (DEBUG_PRINT) console.log('Auto-updated image preset', name, 'from tile change');
  } catch (e) { if (DEBUG_PRINT) console.warn('Failed auto-updating preset from tile change', e); }
}

Hooks.on('updateTile', (doc, changes, options, userId) => {
  try {
    if (!doc?.id) return;
    // Ignore pure movement (only x/y or z) to reduce churn
    const keys = Object.keys(changes);
    const meaningful = keys.filter(k => !['x','y','z','rotation'].includes(k));
    if (!meaningful.length && !(changes.flags && Object.keys(changes.flags).length)) return;
    // Defer slightly to ensure walls or dependent flags updated
    setTimeout(()=> upsertImagePresetForTile(doc), 50);
  } catch {}
});

// Hook tile config submit if needed (redundant with updateTile, but ensures manual form commits propagate)
Hooks.on('closeTileConfig', (app, html) => {
  try { const doc = app?.object; if (doc) setTimeout(()=> upsertImagePresetForTile(doc), 50); } catch {}
});

// When a wall is deleted, purge it from any tile flags and update related presets
Hooks.on('deleteWall', async (wallDocument) => {
  try {
    const wallId = wallDocument?.id; if (!wallId) return;
    const tiles = canvas.tiles?.placeables || [];
    for (const t of tiles) {
      const doc = t.document;
      const ids = doc.getFlag(MODULE_ID, 'linkedWallIds') || [];
      if (!ids.includes(wallId)) continue;
      const newIds = ids.filter(id => id !== wallId);
      await doc.setFlag(MODULE_ID, 'linkedWallIds', newIds);
      const anchors = doc.getFlag(MODULE_ID, 'linkedWallAnchors') || {};
      if (anchors[wallId]) { delete anchors[wallId]; await doc.setFlag(MODULE_ID, 'linkedWallAnchors', anchors); }
      // Update preset to drop reference
      setTimeout(()=> upsertImagePresetForTile(doc), 25);
    }
  } catch (e) { if (DEBUG_PRINT) console.warn('Failed purging wall from presets on deletion', e); }
});

// Delete linked walls when a tile is deleted (only walls not referenced by other tiles)
Hooks.on('deleteTile', async (tileDocument) => {
  try {
    const ids = tileDocument?.getFlag(MODULE_ID, 'linkedWallIds') || [];
    if (!Array.isArray(ids) || !ids.length) return;
    const otherTiles = canvas.tiles.placeables.map(t => t.document).filter(td => td.id !== tileDocument.id);
    const referenced = new Set();
    for (const ot of otherTiles) {
      const oids = ot.getFlag(MODULE_ID, 'linkedWallIds') || [];
      if (Array.isArray(oids)) for (const id of oids) referenced.add(id);
    }
    const toDelete = ids.filter(id => !referenced.has(id));
    if (!toDelete.length) return;
    await canvas.scene.deleteEmbeddedDocuments('Wall', toDelete);
    if (DEBUG_PRINT) console.log('Deleted linked walls with tile removal', toDelete);
  } catch (e) { if (DEBUG_PRINT) console.warn('Failed deleting linked walls on tile deletion', e); }
});
