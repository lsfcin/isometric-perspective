import { MODULE_ID, DEBUG_PRINT } from './main.js';

// Per-image Tile Config Registry
// Stores and applies non-positional configuration for tiles by image path, including linked walls
// with relative anchor coordinates (bottom-left basis). Tile position (x,y) is never stored.

// In-memory cache to avoid repeated settings fetch
let _registryCache = null;
let _registryCacheLoaded = false;
const MIGRATION_FLAG_KEY = '__basenameMigrated';

export function registerTileRegistryHooks() {
  Hooks.on('preCreateTile', onPreCreateTileApplyRegistry); // apply stored config as early as possible (drag from browser)
  Hooks.on('createTile', onCreateTileApplyRegistry);
  Hooks.on('updateTile', onUpdateTilePersistRegistry);
  Hooks.on('updateWall', onUpdateWallRefreshAnchorsInRegistry);
  Hooks.on('deleteTile', onDeleteTileRemoveLinkedWalls);
  Hooks.on('getSceneControlButtons', injectViewerSceneTool);
  // Expose API after ready
  Hooks.once('ready', () => {
  migrateRegistryKeysIfNeeded();
    const mod = game.modules.get(MODULE_ID);
    if (!mod) return;
    mod.api = mod.api || {};
    Object.assign(mod.api, {
      dumpTileRegistry: () => getRegistry(),
      openTileRegistryViewer: () => openTileConfigRegistryViewer(),
      exportTileRegistryJSON: () => exportTileRegistryJSON()
    });
  });
}

function isRegistryEnabled() {
  return !!game.settings.get(MODULE_ID, 'enableTileConfigRegistry');
}

function getRegistry() {
  if (_registryCacheLoaded && _registryCache) return _registryCache;
  _registryCache = game.settings.get(MODULE_ID, 'tileConfigRegistry') || {};
  _registryCacheLoaded = true;
  return _registryCache;
}

async function setRegistry(data) {
  _registryCache = data || {};
  _registryCacheLoaded = true;
  await game.settings.set(MODULE_ID, 'tileConfigRegistry', _registryCache);
}

function imageKeyFor(doc) {
  const src = doc.texture?.src || (doc.getFlag && doc.getFlag('core', 'tileTexture')) || doc._source?.texture?.src || '';
  const full = String(src || '').trim();
  if (!full) return '';
  // Use only basename (after last / or \)
  const parts = full.split(/[/\\]/);
  return parts[parts.length - 1];
}

function migrateRegistryKeysIfNeeded() {
  try {
    const reg = getRegistry();
    if (!reg || reg[MIGRATION_FLAG_KEY]) return; // already migrated or empty
    let changed = false;
    const newReg = { ...reg };
    for (const key of Object.keys(reg)) {
      if (key === MIGRATION_FLAG_KEY) continue;
      if (key.includes('/') || key.includes('\\')) { // old style path key
        const base = key.split(/[/\\]/).pop();
        if (!base) continue;
        if (!newReg[base]) { // move if no collision
          newReg[base] = reg[key];
          changed = true;
        } else {
          // Collision: keep existing, skip duplicate
          if (DEBUG_PRINT) console.warn(`${MODULE_ID} registry migration collision for ${base}; keeping existing entry.`);
        }
        delete newReg[key];
      }
    }
    if (changed) {
      newReg[MIGRATION_FLAG_KEY] = true;
      setRegistry(newReg); // async but fire & forget inside ready
      if (DEBUG_PRINT) console.log(`${MODULE_ID} registry keys migrated to basename form.`);
    } else {
      // Even if no change, set flag to avoid re-check each load
      if (!newReg[MIGRATION_FLAG_KEY]) {
        newReg[MIGRATION_FLAG_KEY] = true;
        setRegistry(newReg);
      }
    }
  } catch (e) { if (DEBUG_PRINT) console.warn('migrateRegistryKeysIfNeeded failed', e); }
}

// Normalize and extract only non-positional flags and linked-wall info
function extractConfigFromTileDocument(tileDocument) {
  const key = imageKeyFor(tileDocument) || null;
  if (!key) return null;
  const flags = tileDocument.flags?.[MODULE_ID] || {};
  const cfg = {
  width: Number(tileDocument.width) || 0,
  height: Number(tileDocument.height) || 0,
    isoTileDisabled: !!flags.isoTileDisabled,
    scale: typeof flags.scale === 'number' ? flags.scale : 1,
    tokenFlipped: !!flags.tokenFlipped,
    offsetX: typeof flags.offsetX === 'number' ? flags.offsetX : 0,
    offsetY: typeof flags.offsetY === 'number' ? flags.offsetY : 0,
    OccludingTile: !!flags.OccludingTile,
    OcclusionAlpha: typeof flags.OcclusionAlpha === 'number' ? flags.OcclusionAlpha : 1,
    linkedWallIds: Array.isArray(flags.linkedWallIds) ? [...flags.linkedWallIds] : [],
    linkedWallAnchors: flags.linkedWallAnchors ? foundry.utils.duplicate(flags.linkedWallAnchors) : {},
    linkedWallAnchorsBasis: flags.linkedWallAnchorsBasis || 'bottom',
    // Walls metadata snapshot: relative anchors plus a subset of important wall properties
    walls: []
  };
  try {
    const ids = cfg.linkedWallIds || [];
    const anchors = cfg.linkedWallAnchors || {};
    for (const id of ids) {
      const wall = canvas.walls.get(id);
      if (!wall?.document) continue;
      const a = anchors[id]?.a; const b = anchors[id]?.b;
      // If anchors missing, derive from absolute endpoints c[] to keep registry consistent
      let anchorsRel = anchors[id];
      if (!anchorsRel) {
        const c = wall.document.c || [0, 0, 0, 0];
        anchorsRel = computeRelativeAnchors(tileDocument, { ax: c[0], ay: c[1], bx: c[2], by: c[3] });
      }
      const props = pickWallProps(wall.document);
      cfg.walls.push({ anchors: anchorsRel, props });
    }
  } catch (e) { if (DEBUG_PRINT) console.warn('extractConfigFromTileDocument walls snapshot failed', e); }
  return { key, cfg };
}

function computeRelativeAnchors(tileDocument, endpoints) {
  const tx = Number(tileDocument.x) || 0;
  const ty = Number(tileDocument.y) || 0;
  const tw = Math.max(1, Number(tileDocument.width) || 1);
  const th = Math.max(1, Number(tileDocument.height) || 1);
  const bottomY = ty + th;
  const toRel = (x, y) => ({ dx: (x - tx) / tw, dy: (bottomY - y) / th });
  return { a: toRel(endpoints.ax, endpoints.ay), b: toRel(endpoints.bx, endpoints.by) };
}

function pickWallProps(wDoc) {
  // Minimal set of stable properties to reproduce common wall behaviors
  const props = {};
  const keys = ['door', 'dir', 'move', 'sight', 'sound', 'light'];
  for (const k of keys) {
    if (k in wDoc) props[k] = wDoc[k];
  }
  // For door state, store as closed in template; runtime door state isn't useful to copy
  if ('ds' in wDoc) props.ds = 0;
  // Copy any module flags from the wall if needed
  if (wDoc.flags) props.flags = foundry.utils.duplicate(wDoc.flags);
  return props;
}

function isPositionalChange(updateData) {
  // Treat x, y (position only) as positional; width/height affect shape so they are treated as config changes
  if (!updateData) return false;
  return ('x' in updateData) || ('y' in updateData);
}

// Only treat update as position-only if x and/or y are the ONLY changed root keys (pure move)
function onlyPositionChange(updateData) {
  if (!updateData) return false;
  const keys = Object.keys(updateData);
  if (!keys.length) return false;
  const nonPos = keys.filter(k => k !== 'x' && k !== 'y');
  return nonPos.length === 0; // only x/y present
}

// Pre-create hook: inject stored flags & (later) defer wall recreation until after create so we can compute anchors reliably.
function onPreCreateTileApplyRegistry(tileDocument, data /*, options, userId */) {
  try {
    if (!isRegistryEnabled()) return;
    const key = imageKeyFor({ texture: { src: data?.texture?.src || data?.img || data?.texture } });
    if (!key) return;
    const reg = getRegistry();
    const stored = reg[key];
    if (!stored) return;
    // Inject flags directly so the first create already has them
    data.flags = data.flags || {};
    data.flags[MODULE_ID] = data.flags[MODULE_ID] || {};
    const f = data.flags[MODULE_ID];
    f.isoTileDisabled = !!stored.isoTileDisabled;
    f.scale = typeof stored.scale === 'number' ? stored.scale : 1;
    f.tokenFlipped = !!stored.tokenFlipped;
    f.offsetX = typeof stored.offsetX === 'number' ? stored.offsetX : 0;
    f.offsetY = typeof stored.offsetY === 'number' ? stored.offsetY : 0;
    f.OccludingTile = !!stored.OccludingTile;
    f.OcclusionAlpha = typeof stored.OcclusionAlpha === 'number' ? stored.OcclusionAlpha : 1;
  // Apply stored width/height before creation so transformation & wall anchors use correct rectangle
  // Always override width/height so Foundry's auto aspect sizing doesn't fight us
  if (stored.width) data.width = stored.width;
  if (stored.height) data.height = stored.height;
    // Walls are created in onCreate (cannot create embedded walls pre-create of tile)
  } catch (e) { if (DEBUG_PRINT) console.warn('onPreCreateTileApplyRegistry failed', e); }
}

async function onCreateTileApplyRegistry(tileDocument) {
  try {
    if (!isRegistryEnabled()) return;
    const key = imageKeyFor(tileDocument);
    if (!key) return;
    const reg = getRegistry();
    const stored = reg[key];
    if (!stored) return;

    // First apply stored per-tile flags (non-positional)
    const baseUpdate = { _id: tileDocument.id };
    baseUpdate[`flags.${MODULE_ID}.isoTileDisabled`] = !!stored.isoTileDisabled;
    baseUpdate[`flags.${MODULE_ID}.scale`] = typeof stored.scale === 'number' ? stored.scale : 1;
    baseUpdate[`flags.${MODULE_ID}.tokenFlipped`] = !!stored.tokenFlipped;
    baseUpdate[`flags.${MODULE_ID}.offsetX`] = typeof stored.offsetX === 'number' ? stored.offsetX : 0;
    baseUpdate[`flags.${MODULE_ID}.offsetY`] = typeof stored.offsetY === 'number' ? stored.offsetY : 0;
    baseUpdate[`flags.${MODULE_ID}.OccludingTile`] = !!stored.OccludingTile;
    baseUpdate[`flags.${MODULE_ID}.OcclusionAlpha`] = typeof stored.OcclusionAlpha === 'number' ? stored.OcclusionAlpha : 1;
    // Also correct width/height post-create if Foundry auto-sized them differently
    if (stored.width && stored.height && (tileDocument.width !== stored.width || tileDocument.height !== stored.height)) {
      baseUpdate.width = stored.width;
      baseUpdate.height = stored.height;
    }
    await canvas.scene.updateEmbeddedDocuments('Tile', [baseUpdate]);

    // Then, if walls metadata exists, create new walls from relative anchors for this tile
    const wallsMeta = Array.isArray(stored.walls) ? stored.walls : [];
    const tx = Number(tileDocument.x) || 0;
    const ty = Number(tileDocument.y) || 0;
    const tw = Math.max(1, Number(tileDocument.width) || 1);
    const th = Math.max(1, Number(tileDocument.height) || 1);
    const bottomY = ty + th;
    const newWallsData = [];
    for (const w of wallsMeta) {
      if (!w?.anchors) continue;
      const rel = w.anchors;
      const ax = tx + (rel.a.dx * tw);
      const ay = bottomY - (rel.a.dy * th);
      const bx = tx + (rel.b.dx * tw);
      const by = bottomY - (rel.b.dy * th);
      const wd = { c: [ax, ay, bx, by] };
      const props = w.props || {};
      for (const k of Object.keys(props)) wd[k] = props[k];
      // Ensure door state defaults to closed if present
      if ('door' in wd && !('ds' in wd)) wd.ds = 0;
      newWallsData.push(wd);
    }
    let newWallIds = [];
    if (newWallsData.length) {
      const created = await canvas.scene.createEmbeddedDocuments('Wall', newWallsData);
      newWallIds = created.map(w => w.id);
      const newAnchors = {};
      for (let i = 0; i < newWallIds.length; i++) {
        const rel = wallsMeta[i]?.anchors;
        if (rel) newAnchors[newWallIds[i]] = foundry.utils.duplicate(rel);
      }
      const linkUpdate = { _id: tileDocument.id };
      linkUpdate[`flags.${MODULE_ID}.linkedWallIds`] = newWallIds;
      linkUpdate[`flags.${MODULE_ID}.linkedWallAnchors`] = newAnchors;
      linkUpdate[`flags.${MODULE_ID}.linkedWallAnchorsBasis`] = 'bottom';
      await canvas.scene.updateEmbeddedDocuments('Tile', [linkUpdate]);
    }
  } catch (e) { if (DEBUG_PRINT) console.warn('onCreateTileApplyRegistry failed', e); }
}

async function onUpdateTilePersistRegistry(tileDocument, updateData) {
  try {
    if (!isRegistryEnabled()) return;
  if (onlyPositionChange(updateData)) return; // skip pure position-only updates
    const pair = extractConfigFromTileDocument(tileDocument);
    if (!pair) return;
    const reg = getRegistry();
    reg[pair.key] = pair.cfg;
    await setRegistry(reg);
  } catch (e) { if (DEBUG_PRINT) console.warn('onUpdateTilePersistRegistry failed', e); }
}

// If the user manually edits a linked wall, we want those anchors reflected into the stored registry
async function onUpdateWallRefreshAnchorsInRegistry(wallDocument, changes, options, userId) {
  try {
    if (!isRegistryEnabled()) return;
    if (!changes?.c) return; // only endpoint edits
    // Find tiles that link this wall and persist their latest anchors into the registry entry keyed by image
    const tiles = canvas.tiles.placeables || [];
    for (const t of tiles) {
      const flags = t.document.flags?.[MODULE_ID] || {};
      const ids = Array.isArray(flags.linkedWallIds) ? flags.linkedWallIds : [];
      if (!ids.includes(wallDocument.id)) continue;
      const pair = extractConfigFromTileDocument(t.document);
      if (!pair) continue;
      const reg = getRegistry();
      reg[pair.key] = pair.cfg; // cfg already includes linkedWallAnchors
      await setRegistry(reg);
    }
  } catch (e) { if (DEBUG_PRINT) console.warn('onUpdateWallRefreshAnchorsInRegistry failed', e); }
}

// ---- Viewer & Tools ----

class TileConfigRegistryViewer extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      title: 'Tile Presets',
      template: null,
      width: 760,
      height: 500,
      resizable: true,
      classes: ['isometric-registry-viewer'],
    });
  }

  getData() {
    const reg = getRegistry();
    // Transform into array for display
    const rows = Object.entries(reg).map(([image, cfg]) => ({ image, cfg }));
    rows.sort((a,b)=> a.image.localeCompare(b.image));
    return { rows };
  }

  activateListeners(html) {
    super.activateListeners(html);
  }

  async _renderInner(data) {
    // Build improved responsive HTML (no external template to keep patch minimal)
    const wrap = document.createElement('div');
    wrap.className = 'tile-registry-wrapper';
    wrap.innerHTML = `
      <style>
        .isometric-registry-viewer .window-content { padding:0; overflow:hidden; }
        .tile-registry-wrapper { display:flex; flex-direction:column; height:100%; font-size:12px; }
  .tile-registry-toolbar { display:flex; gap:6px; padding:6px 8px; align-items:center; border-bottom:1px solid var(--color-border-light-primary,#555); }
        .tile-registry-toolbar input[type=text] { flex:1; padding:4px 6px; font-size:12px; }
        .tile-registry-table-container { flex:1; overflow:auto; }
        .tile-registry-table { width:100%; border-collapse:collapse; }
        .tile-registry-table th { position:sticky; top:0; background:var(--color-bg-alt,#222); z-index:1; }
        .tile-registry-table th, .tile-registry-table td { border:1px solid var(--color-border-light-tertiary,#444); padding:4px 6px; vertical-align:middle; }
  .tile-registry-summary { display:flex; flex-wrap:wrap; gap:4px; }
  .tile-registry-chip { background:#333; color:#ddd; padding:2px 4px; border-radius:3px; font-size:10px; line-height:1.2; font-family:monospace; }
        .tile-registry-actions button { margin-right:4px; }
        .tile-registry-empty { padding:12px; text-align:center; opacity:0.6; }
        .tile-registry-badge { display:inline-block; background:#444; color:#ddd; padding:0 4px; border-radius:3px; margin-right:4px; font-size:10px; }
        .tile-registry-pretty-json { white-space:pre; font-family:monospace; font-size:11px; line-height:1.3; margin:0; }
  .tile-registry-image-path { word-break:break-all; }
  .tile-registry-image-path wbr { display:block; }
      </style>
      <div class='tile-registry-toolbar'>
        <input type='text' class='filter' placeholder='Filter... (supports multi-word)'>
        <span class='entries-count'>${data.rows.length}</span>
      </div>
      <div class='tile-registry-table-container'>
        <table class='tile-registry-table'>
          <thead>
            <tr>
              <th style='width:38%;'>Image</th>
              <th style='width:52%;'>Summary</th>
              <th style='width:10%;'>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${data.rows.length ? data.rows.filter(r => r.image !== MIGRATION_FLAG_KEY).map(r => {
              const c = r.cfg || {};
              const walls = Array.isArray(c.walls) ? c.walls.length : (Array.isArray(c.linkedWallIds)? c.linkedWallIds.length:0);
              const chips = [
                { k: 'dims', v: `${c.width||0}x${c.height||0}` },
                { k: 'scale', v: c.scale },
                { k: 'flip', v: c.tokenFlipped?1:0 },
                { k: 'offset', v: `${c.offsetX},${c.offsetY}` },
                { k: 'occ', v: c.OccludingTile?1:0 },
                { k: 'alpha', v: c.OcclusionAlpha },
                { k: 'walls', v: walls }
              ];
              const imageWrapped = r.image.replace(/\//g, '/<wbr>');
              return `<tr data-image='${r.image}'>
                <td title='${r.image}' class='tile-registry-image-path'>${imageWrapped}</td>
                <td><div class='tile-registry-summary'>${chips.map(ch => `<span class='tile-registry-chip'>${ch.k}:${ch.v}</span>`).join('')}</div></td>
                <td class='tile-registry-actions'>
                  <button type='button' class='view-json' data-image='${r.image}' title='View JSON'><i class='fas fa-eye'></i></button>
                </td>
              </tr>`;
            }).join('') : `<tr><td colspan='3' class='tile-registry-empty'>No entries stored yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;

    // Add interaction logic after DOM built
    setTimeout(() => {
      const filterInput = wrap.querySelector('input.filter');
      if (filterInput) {
        filterInput.addEventListener('input', () => {
          const raw = filterInput.value.trim();
          const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
          const rows = wrap.querySelectorAll('tbody tr[data-image]');
          let visible = 0;
          const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const highlight = (text) => {
            if (!tokens.length) return text;
            const pattern = tokens.map(esc).sort((a,b)=> b.length-a.length).join('|');
            const re = new RegExp(`(${pattern})`, 'gi');
            return text.replace(re, '<mark>$1</mark>');
          };
          rows.forEach(tr => {
            const img = tr.getAttribute('data-image') || '';
            const low = img.toLowerCase();
            const match = !tokens.length || tokens.every(t => low.includes(t));
            tr.style.display = match ? '' : 'none';
            if (match) {
              visible++;
              const td = tr.querySelector('.tile-registry-image-path');
              if (td) td.innerHTML = highlight(img.replace(/\//g,'/<wbr>'));
            }
          });
          const ec = wrap.querySelector('.entries-count');
          if (ec) ec.textContent = visible;
        });
      }
      // Button click OR double-click row to open JSON
      wrap.querySelectorAll('button.view-json').forEach(btn => {
        btn.addEventListener('click', ev => {
          const image = btn.getAttribute('data-image');
          if (image) openSingleEntryViewer(image);
        });
      });
      wrap.querySelectorAll('tr[data-image]').forEach(tr => {
        tr.addEventListener('dblclick', () => {
          const image = tr.getAttribute('data-image');
          if (image) openSingleEntryViewer(image);
        });
      });
    }, 0);

    return wrap;
  }
}

function openTileConfigRegistryViewer() {
  if (!isRegistryEnabled()) {
    ui.notifications?.warn('Tile Config Registry is disabled in settings.');
    return;
  }
  const app = new TileConfigRegistryViewer();
  app.render(true);
  // Defer positioning to after first paint so it appears in the correct spot immediately
  setTimeout(() => {
    try {
      const vw = window?.innerWidth || 1600;
      const width = app.element?.outerWidth() || app.options.width || 760;
      const left = Math.max(0, vw - width - 20); // 20px right margin
      app.setPosition({ left, top: 20 });
    } catch (e) { if (DEBUG_PRINT) console.warn('Tile Presets reposition failed', e); }
  }, 30);
}

function exportTileRegistryJSON() {
  try {
    const reg = getRegistry();
    const clone = { ...reg };
    delete clone[MIGRATION_FLAG_KEY];
    const blob = JSON.stringify(clone, null, 2);
    if (!Object.keys(clone).length) return ui.notifications?.warn('No entries to export.');
    // Foundry core helper
    if (typeof saveDataToFile === 'function') {
      saveDataToFile(blob, 'text/json', 'tile-config-registry.json');
    } else {
      // Fallback: copy to clipboard
      navigator.clipboard.writeText(blob);
      ui.notifications?.info('Export JSON copied to clipboard');
    }
  } catch (e) { if (DEBUG_PRINT) console.warn('exportTileRegistryJSON failed', e); }
}

function invalidateRegistryCache() { _registryCacheLoaded = false; _registryCache = null; }

function openSingleEntryViewer(imageKey) {
  const reg = getRegistry();
  const cfg = reg[imageKey];
  if (!cfg) { ui.notifications?.warn('Entry not found'); return; }
  const json = JSON.stringify({ image: imageKey, ...cfg }, null, 2);
  const app = new class extends Application {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        title: `Tile Config: ${imageKey}`,
        width: 620,
        height: 480,
        resizable: true,
        classes: ['isometric-registry-entry-viewer']
      });
    }
    async _renderInner() {
      const el = document.createElement('div');
      el.style.cssText = 'height:100%;display:flex;flex-direction:column;';
      el.innerHTML = `
        <style>
          .isometric-registry-entry-viewer .window-content { padding:0; }
          .reg-entry-toolbar { display:flex; gap:6px; padding:6px; border-bottom:1px solid var(--color-border-light-primary,#555); }
          .reg-entry-toolbar button { flex:0 0 auto; }
          .reg-entry-body { flex:1; overflow:auto; padding:6px; }
          .reg-entry-body pre { margin:0; font-family:monospace; font-size:12px; line-height:1.35; }
        </style>
        <div class='reg-entry-toolbar'>
          <button type='button' class='copy'><i class='fas fa-copy'></i> Copy</button>
          <button type='button' class='close-btn'><i class='fas fa-times'></i> Close</button>
          <span style='flex:1; text-align:right; font-size:11px; opacity:0.7;'>${imageKey}</span>
        </div>
        <div class='reg-entry-body'>
          <pre>${json.replace(/</g,'&lt;')}</pre>
        </div>
      `;
      setTimeout(()=>{
        el.querySelector('.copy')?.addEventListener('click', () => { navigator.clipboard.writeText(json); ui.notifications?.info('Copied JSON'); });
        el.querySelector('.close-btn')?.addEventListener('click', () => this.close());
      },0);
      return el;
    }
  }();
  app.render(true);
}

function injectViewerSceneTool(controls) {
  if (!game.user.isGM) return;
  const tilesCtl = controls.find(b => b.name === 'tiles');
  if (!tilesCtl) return;
  tilesCtl.tools.push({
  name: 'tile-presets-view',
  title: 'Tile Presets',
    icon: 'fas fa-database',
    button: true,
    onClick: () => openTileConfigRegistryViewer(),
    visible: true
  });
}

// Export internal helpers for potential advanced debugging (not part of public API docs)
export const __tileRegistryInternal = { getRegistry, setRegistry, invalidateRegistryCache };

// --- Linked wall cleanup when a tile is deleted ---
async function onDeleteTileRemoveLinkedWalls(tileDocument) {
  try {
    if (!tileDocument) return;
    const flags = tileDocument.flags?.[MODULE_ID] || {};
    const ids = Array.isArray(flags.linkedWallIds) ? flags.linkedWallIds : [];
    if (!ids.length) return;
    // Filter to existing walls (avoid duplicate deletions across multiple tiles)
    const present = ids.filter(id => canvas.walls?.get(id));
    if (!present.length) return;
    await canvas.scene.deleteEmbeddedDocuments('Wall', present);
  } catch (e) { if (DEBUG_PRINT) console.warn('onDeleteTileRemoveLinkedWalls failed', e); }
}
