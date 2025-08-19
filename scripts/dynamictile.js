import { MODULE_ID, DEBUG_PRINT, FOUNDRY_VERSION } from './main.js';
import { ensureWallIdsArray } from './tile.js';
import { addDebugOverlays } from './overlay.js';

// Module state (refactored two-layer system)
let backgroundContainer;   // cloned background tiles (rendered below tokens)
let foregroundContainer;   // cloned foreground tiles (rendered above tokens)
let tilesLayer;            // alias kept for opacity helpers (points to foregroundContainer)
let tokensLayer;           // legacy dummy (kept so helpers referencing it do not break)
let tilesOpacity = 1.0;
let tokensOpacity = 1.0; // retained for backward compatibility with existing opacity UI (no functional change now)
let lastControlledToken = null;

function clamp01(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(1, v));
}

export function registerDynamicTileConfig() {
    if (!shouldEnableDynamicTiles()) return;
    registerLifecycleHooks();
    registerTileHooks();
    registerTokenHooks();
    registerMiscHooks();
}

function shouldEnableDynamicTiles() {
    try {
        const enable = game.settings.get(MODULE_ID, 'enableOcclusionDynamicTile');
        const worldIso = game.settings.get(MODULE_ID, 'worldIsometricFlag');
        return !!(enable && worldIso);
    } catch { return false; }
}

function registerLifecycleHooks() {
    Hooks.on('canvasInit', setupContainers);
    Hooks.on('changeScene', teardownContainers);
    Hooks.on('canvasReady', () => updateAlwaysVisibleElements());
    Hooks.once('canvasReady', migrateLegacyIsoLayerFlags);
}

function registerTileHooks() {
    Hooks.on('createTile', initializeNewTileFlags);
    Hooks.on('updateTile', handleTileUpdate);
    Hooks.on('refreshTile', () => updateAlwaysVisibleElements());
    Hooks.on('deleteTile', () => updateAlwaysVisibleElements());
}

function registerTokenHooks() {
    Hooks.on('createToken', () => setTimeout(() => updateAlwaysVisibleElements(), 100));
    Hooks.on('controlToken', handleControlToken);
    Hooks.on('updateToken', handleUpdateToken);
    Hooks.on('deleteToken', handleDeleteToken);
    Hooks.on('refreshToken', () => updateAlwaysVisibleElements());
    Hooks.on('canvasTokensRefresh', () => updateAlwaysVisibleElements());
    Hooks.on('updateUser', (user, changes) => { if (user.id === game.user.id && 'character' in changes) updateAlwaysVisibleElements(); });
}

function registerMiscHooks() {
    Hooks.on('sightRefresh', () => { if (canvas.ready) updateAlwaysVisibleElements(); });
    Hooks.on('updateWall', handleUpdateWallDoorState);
}

// ---- Hook handlers ----
function setupContainers() {
    for (const c of [backgroundContainer, foregroundContainer]) {
        try { if (c?.parent) c.parent.removeChild(c); c?.destroy({ children: true }); } catch {}
    }
    backgroundContainer = new PIXI.Container();
    backgroundContainer.name = 'IsoBackgroundTiles';
    backgroundContainer.sortableChildren = true;
    backgroundContainer.eventMode = 'passive';

    foregroundContainer = new PIXI.Container();
    foregroundContainer.name = 'IsoForegroundTiles';
    foregroundContainer.sortableChildren = true;
    foregroundContainer.eventMode = 'passive';

    tilesLayer = foregroundContainer;
    tokensLayer = new PIXI.Container();
    tokensLayer.name = 'IsoLegacyTokensLayer';
    tokensLayer.visible = false;

    try {
        const idx = canvas.stage.getChildIndex(canvas.tokens);
        canvas.stage.addChildAt(backgroundContainer, idx);
    } catch { canvas.stage.addChild(backgroundContainer); }
    canvas.stage.addChild(foregroundContainer);
    canvas.stage.addChild(tokensLayer);
}

function teardownContainers() {
    for (const c of [backgroundContainer, foregroundContainer, tokensLayer]) {
        try { if (c?.parent) c.parent.removeChild(c); c?.destroy({ children: true }); } catch {}
    }
    backgroundContainer = foregroundContainer = tilesLayer = tokensLayer = null;
}

function migrateLegacyIsoLayerFlags() {
    try {
        const updates = [];
        for (const t of canvas.tiles.placeables) {
            const doc = t.document;
            const hasIso = doc.getFlag(MODULE_ID, 'isoLayer');
            if (hasIso) continue;
            const legacy = doc.getFlag(MODULE_ID, 'OccludingTile');
            const layer = legacy ? 'foreground' : 'background';
            updates.push({ _id: doc.id, [`flags.${MODULE_ID}.isoLayer`]: layer });
        }
        if (updates.length) canvas.scene.updateEmbeddedDocuments('Tile', updates);
    } catch (e) { if (DEBUG_PRINT) console.warn('Iso layer migration failed', e); }
}

function initializeNewTileFlags(tile) {
    try { if (!tile.getFlag(MODULE_ID, 'isoLayer')) tile.setFlag(MODULE_ID, 'isoLayer', 'foreground'); } catch {}
    try { tile.setFlag(MODULE_ID, 'linkedWallIds', []); } catch {}
    try { tile.setFlag(MODULE_ID, 'OcclusionAlpha', 1); } catch {}
}

async function handleTileUpdate(tileDocument, change) {
    try {
        if ('flags' in change && MODULE_ID in change.flags) {
            const currentFlags = change.flags[MODULE_ID] ?? {};
            if ('linkedWallIds' in currentFlags) {
                const validArray = ensureWallIdsArray(currentFlags.linkedWallIds);
                await tileDocument.setFlag(MODULE_ID, 'linkedWallIds', validArray);
            }
            if ('OcclusionAlpha' in currentFlags) {
                const v = clamp01(currentFlags.OcclusionAlpha);
                await tileDocument.setFlag(MODULE_ID, 'OcclusionAlpha', v);
            }
            if ('isoLayer' in currentFlags) {
                const v = currentFlags.isoLayer === 'background' ? 'background' : 'foreground';
                await tileDocument.setFlag(MODULE_ID, 'isoLayer', v);
            }
        }
    } catch {}
    updateAlwaysVisibleElements();
}

function handleControlToken(token, controlled) {
    if (controlled) lastControlledToken = token;
    updateAlwaysVisibleElements();
}

function handleUpdateToken(tokenDocument) {
    if (lastControlledToken && tokenDocument.id === lastControlledToken.id) {
        lastControlledToken = canvas.tokens.get(tokenDocument.id);
    }
    updateAlwaysVisibleElements();
}

function handleDeleteToken(token) {
    if (lastControlledToken && token.id === lastControlledToken.id) lastControlledToken = null;
    updateAlwaysVisibleElements();
}

function handleUpdateWallDoorState(wallDocument, change) {
    if (!('ds' in change)) return; // door state change only
    const linkedTiles = canvas.tiles.placeables.filter(tile => {
        const walls = getLinkedWalls(tile);
        return walls.some(w => w && w.id === wallDocument.id);
    });
    if (linkedTiles.length) updateAlwaysVisibleElements();
}

function updateLayerOpacity(layer, opacity) {
    if (!layer) return;
    layer.children.forEach(sprite => {
        const base = typeof sprite.baseAlpha === 'number' ? sprite.baseAlpha : sprite.alpha ?? 1;
        // Choose multiplier by sprite group to keep tile clones following tile opacity even on tokens layer
        const group = sprite.opacityGroup || (layer === tokensLayer ? 'tokens' : 'tiles');
        const mul = group === 'tiles' ? tilesOpacity : tokensOpacity;
        sprite.alpha = base * mul;
    });
}

export function updateTilesOpacity(value) {
    tilesOpacity = Math.max(0, Math.min(1, value));
    if (tilesLayer) updateLayerOpacity(tilesLayer, tilesOpacity);
}
// Instead of adjusting a global tiles opacity, adjust the OcclusionAlpha per selected tile
async function adjustSelectedTilesOcclusionAlpha(delta = 0.1) {
    try {
        const selected = Array.from(canvas.tiles?.controlled || []);
        if (!selected.length) return;
        const updates = [];
        for (const t of selected) {
            const doc = t.document;
            const cur = Number(doc.getFlag(MODULE_ID, 'OcclusionAlpha'));
            const base = Number.isFinite(cur) ? cur : 1;
            const next = clamp01(base + delta);
            updates.push({ _id: doc.id, [`flags.${MODULE_ID}.OcclusionAlpha`]: next });
        }
        if (updates.length) await canvas.scene.updateEmbeddedDocuments('Tile', updates);
    } catch (e) { if (DEBUG_PRINT) console.warn('adjustSelectedTilesOcclusionAlpha failed', e); }
}
export function increaseTilesOpacity() { adjustSelectedTilesOcclusionAlpha(+0.1); }
export function decreaseTilesOpacity() { adjustSelectedTilesOcclusionAlpha(-0.1); }

export function resetOpacity() {
    tilesOpacity = 1.0;
    updateTilesOpacity(tilesOpacity);
    if (tokensLayer) updateLayerOpacity(tokensLayer, tokensOpacity);
}

export function updateTokensOpacity(value) {
    tokensOpacity = Math.max(0, Math.min(1, value));
    if (tokensLayer) updateLayerOpacity(tokensLayer, tokensOpacity);
}
export function increaseTokensOpacity() { updateTokensOpacity(tokensOpacity + 0.1); }
export function decreaseTokensOpacity() { updateTokensOpacity(tokensOpacity - 0.1); }

function cloneTileSprite(tilePlaceable) {
    const mesh = tilePlaceable?.mesh;
    if (!mesh) return null;
    const sprite = new PIXI.Sprite(mesh.texture);
    sprite.position.set(mesh.position.x, mesh.position.y);
    sprite.anchor.set(mesh.anchor.x, mesh.anchor.y);
    sprite.angle = mesh.angle;
    try { sprite.rotation = mesh.rotation; if (mesh.skew) sprite.skew.set(mesh.skew.x, mesh.skew.y); } catch {}
    try { sprite.scale.set(mesh.scale.x, mesh.scale.y); } catch { sprite.scale.set(1, 1); }
    const tileDocAlpha = typeof tilePlaceable?.document?.alpha === 'number' ? tilePlaceable.document.alpha : 1;
    sprite.baseAlpha = tileDocAlpha;
    sprite.alpha = tileDocAlpha * tilesOpacity;
    sprite.opacityGroup = 'tiles';
    sprite.eventMode = 'passive';
    sprite.originalTile = tilePlaceable;
    return sprite;
}

function cloneTokenSprite(token) {
    if (!token || !token.texture) {
        if (DEBUG_PRINT) console.warn('Dynamic Tile cloneTokenSprite() common error.');
        return null;
    }
    try {
        const sprite = new PIXI.Sprite(token.texture);
        sprite.position.set(token.position.x, token.position.y);
        sprite.anchor.set(token.anchor.x, token.anchor.y);
        sprite.angle = token.angle;
        sprite.scale.set(token.scale.x, token.scale.y);
    const tokenAlpha = typeof token.alpha === 'number' ? token.alpha : 1;
    sprite.baseAlpha = tokenAlpha;
    sprite.alpha = tokenAlpha * tokensOpacity;
    sprite.opacityGroup = 'tokens';
        sprite.eventMode = 'passive';
        sprite.originalToken = token;
        return sprite;
    } catch (error) {
        console.error('Error cloning token sprite:', error);
        return null;
    }
}

function getInitialToken() {
    const controlled = canvas.tokens.controlled[0];
    if (controlled) return controlled;
    if (lastControlledToken) return lastControlledToken;
    const actor = game.user.character;
    if (actor) {
        const tokenA = canvas.tokens.placeables.find(t => t.actor?.id === actor.id);
        if (tokenA) return tokenA;
    }
    const availableToken = canvas.tokens.placeables.find(t => t.observer);
    if (availableToken) return availableToken;
    return null;
}

function updateAlwaysVisibleElements() {
    if (!canvas.ready || !backgroundContainer || !foregroundContainer) return;
    backgroundContainer.removeChildren();
    foregroundContainer.removeChildren();

    const bg = [];
    const fg = [];
    for (const tile of canvas.tiles.placeables) {
        if (!tile?.mesh) continue;
        let layer = tile.document.getFlag(MODULE_ID, 'isoLayer');
        if (layer !== 'background' && layer !== 'foreground') layer = 'foreground';
        const clone = cloneTileSprite(tile);
        if (!clone) continue;
        // Always hide original mesh so only clones render (avoids mixed ordering issues)
        try { tile.mesh.alpha = 0; } catch {}
        const sort = Number(tile.document.sort) || 0;
        if (layer === 'background') bg.push({ sort, sprite: clone }); else fg.push({ sort, sprite: clone });
    }
    bg.sort((a,b)=> a.sort - b.sort);
    fg.sort((a,b)=> a.sort - b.sort);
    for (const e of bg) backgroundContainer.addChild(e.sprite);
    for (const e of fg) foregroundContainer.addChild(e.sprite);

    updateLayerOpacity(backgroundContainer, tilesOpacity);
    updateLayerOpacity(foregroundContainer, tilesOpacity);

    // Debug overlay revival: build a lightweight plan object compatible with addDebugOverlays()
    if (DEBUG_PRINT) {
        try {
            const plan = { debugTiles: [], debugTokens: [] };
            for (const tile of canvas.tiles.placeables) {
                if (!tile?.mesh) continue;
                const { gx, gy } = getTileBottomCornerGridXY(tile);
                plan.debugTiles.push({ gx, gy, px: tile.document.x, py: tile.document.y + tile.document.height });
            }
            for (const token of canvas.tokens.placeables) {
                if (!token?.center) continue;
                const { gx, gy } = getTokenGridXY(token);
                plan.debugTokens.push({ gx, gy, px: token.center.x, py: token.center.y });
            }
            if (tokensLayer) {
                tokensLayer.visible = true; // ensure visible for debug text
                tokensLayer.removeChildren(); // clear previous debug labels
            }
            addDebugOverlays(plan);
        } catch (e) { if (DEBUG_PRINT) console.warn('addDebugOverlays failed', e); }
    } else if (tokensLayer) {
        // Hide legacy/debug layer when not debugging
        tokensLayer.visible = false;
        tokensLayer.removeChildren();
    }
}

// addDebugOverlays & ensureWallIdsArray moved to overlay.js and tile.js respectively

function getLinkedWalls(tile) {
    if (!tile || !tile.document) return [];
    const linkedWallIds = ensureWallIdsArray(tile.document.getFlag(MODULE_ID, 'linkedWallIds'));
    return linkedWallIds.map(id => canvas.walls.get(id)).filter(Boolean);
}

// Grid helpers and rule: a token (gx, gy) is occluded by a tile whose bottom-corner grid is (tx, ty)
// iff gx > tx AND gy > ty. We use gx+gy as a depth index for token z ordering.
function getTokenGridXY(token) {
    const gs = canvas.grid?.size || 1;
    // Use token.center as reference for grid position
    const gx = Math.floor(token.center.x / gs);
    const gy = Math.floor(token.center.y / gs);
    return { gx, gy };
}

function getTileBottomCornerGridXY(tile) {
    const gs = canvas.grid?.size || 1;
    // Bottom-left in top-down corresponds to bottom corner in isometric tile art
    // Use the tile bottom-left in scene coordinates: (x, y + height)
    const x = tile.document.x;
    // Subtract a tiny epsilon so a tile whose bottom edge lies exactly on a grid line
    // is classified into the cell above, matching token centers standing on it.
    const yBottomEdge = tile.document.y + tile.document.height - 0.0001;
    const gx = Math.floor(x / gs);
    const gy = Math.floor(yBottomEdge / gs);
    return { gx, gy };
}