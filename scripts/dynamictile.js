import { MODULE_ID, DEBUG_PRINT, FOUNDRY_VERSION } from './main.js';
import { ensureWallIdsArray } from './tile.js';
import { addDebugOverlays } from './overlay.js';

// Module state (refactored two-layer system)
let backgroundContainer;   // cloned background tiles (rendered below foreground container)
let foregroundContainer;   // combined foreground tiles + token clones (interwoven ordering)
let tilesOpacity = 1.0;   // applies to tile sprites (group === 'tiles')
let tokensOpacity = 1.0;  // applies to token sprites (group === 'tokens')
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
    foregroundContainer.name = 'IsoForeground';
    foregroundContainer.sortableChildren = true; // we will assign zIndex
    foregroundContainer.eventMode = 'passive';

    try {
        const idx = canvas.stage.getChildIndex(canvas.tokens);
        canvas.stage.addChildAt(backgroundContainer, idx);
    } catch { canvas.stage.addChild(backgroundContainer); }
    canvas.stage.addChild(foregroundContainer); // combined tiles + tokens
}

function teardownContainers() {
    for (const c of [backgroundContainer, foregroundContainer]) {
        try { if (c?.parent) c.parent.removeChild(c); c?.destroy({ children: true }); } catch {}
    }
    backgroundContainer = foregroundContainer = null;
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

function updateLayerOpacity(layer) {
    if (!layer) return;
    layer.children.forEach(sprite => {
        const base = typeof sprite.baseAlpha === 'number' ? sprite.baseAlpha : sprite.alpha ?? 1;
        const group = sprite.opacityGroup === 'tokens' ? 'tokens' : 'tiles';
        const mul = group === 'tiles' ? tilesOpacity : tokensOpacity;
        sprite.alpha = base * mul;
    });
}

export function updateTilesOpacity(value) {
    tilesOpacity = Math.max(0, Math.min(1, value));
    updateLayerOpacity(backgroundContainer);
    updateLayerOpacity(foregroundContainer);
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
    tokensOpacity = 1.0;
    updateLayerOpacity(backgroundContainer);
    updateLayerOpacity(foregroundContainer);
}

export function updateTokensOpacity(value) {
    tokensOpacity = Math.max(0, Math.min(1, value));
    updateLayerOpacity(foregroundContainer);
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
    try {
        const mesh = token?.mesh;
        if (!mesh || !mesh.texture) {
            if (DEBUG_PRINT) console.warn('cloneTokenSprite: token mesh/texture missing', token?.id);
            return null;
        }
        const sprite = new PIXI.Sprite(mesh.texture);
        // replicate transforms
        sprite.position.set(mesh.position.x, mesh.position.y);
        sprite.anchor.set(mesh.anchor?.x ?? 0.5, mesh.anchor?.y ?? 0.5);
        sprite.angle = mesh.angle ?? token.angle ?? 0;
        try { sprite.rotation = mesh.rotation; if (mesh.skew) sprite.skew.set(mesh.skew.x, mesh.skew.y); } catch {}
        try { sprite.scale.set(mesh.scale.x, mesh.scale.y); } catch { sprite.scale.set(1, 1); }
        const tokenAlpha = typeof token.alpha === 'number' ? token.alpha : 1;
        sprite.baseAlpha = tokenAlpha;
        sprite.alpha = tokenAlpha * tokensOpacity;
        sprite.opacityGroup = 'tokens';
        sprite.eventMode = 'passive';
        sprite.originalToken = token;
        try { token.mesh.alpha = 0; } catch {}
        return sprite;
    } catch (e) {
        if (DEBUG_PRINT) console.warn('cloneTokenSprite failed', e);
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

    // Collect tile clones
    const backgroundEntries = [];
    const foregroundTileEntries = [];
    const TILE_STRIDE = 10000; // large spacing between tile depth bands
    for (const tile of canvas.tiles.placeables) {
        if (!tile?.mesh) continue;
        let layer = tile.document.getFlag(MODULE_ID, 'isoLayer');
        if (layer !== 'background' && layer !== 'foreground') layer = 'foreground';
        const clone = cloneTileSprite(tile);
        if (!clone) continue;
        try { tile.mesh.alpha = 0; } catch {}
        const sort = Number(tile.document.sort) || 0;
        if (layer === 'background') backgroundEntries.push({ sort, sprite: clone });
        else foregroundTileEntries.push({ sort, sprite: clone, tile });
    }
    backgroundEntries.sort((a,b)=> a.sort - b.sort);
    for (const e of backgroundEntries) backgroundContainer.addChild(e.sprite);

    // Map tile entries to unique depths inside each sort band so tiles of same sort don't share depth
    // Group by sort value first
    const bySort = new Map();
    for (const e of foregroundTileEntries) {
        if (!bySort.has(e.sort)) bySort.set(e.sort, []);
        bySort.get(e.sort).push(e);
    }
    for (const [sortValue, arr] of bySort.entries()) {
        // Order tiles in this sort band by their bottom Y (then X) so natural vertical stacking is preserved
        arr.sort((a,b)=> {
            const ay = a.tile.document.y + a.tile.document.height;
            const by = b.tile.document.y + b.tile.document.height;
            if (ay !== by) return ay - by; // higher on screen (smaller y) first (behind)
            const ax = a.tile.document.x;
            const bx = b.tile.document.x;
            return ax - bx;
        });
        const base = sortValue * TILE_STRIDE; // reserve a large band per sort value
        // Leave margins at start/end of band for token mid-placement (100 .. TILE_STRIDE-100)
        const margin = 100;
        const usableSpan = TILE_STRIDE - margin * 2; // plenty large
        const step = Math.max(1, Math.floor(usableSpan / (arr.length + 1)));
        let offset = margin;
        for (const entry of arr) {
            entry.depth = base + offset;
            offset += step;
        }
    }

    // Token depth placement according to occlusion rule:
    // A tile occludes a token iff tile.x <= token.x && tile.y >= token.y.
    // Desired: token behind all occluding tiles and in front of all non-occluding tiles.
    // If impossible due to tile sort ordering overlaps, prioritize being behind occluding tiles.
    const tokenEntries = [];
    const tokenDepthMap = new Map();
    for (const token of canvas.tokens.placeables) {
        if (!token) continue;
        const tx = token.document.x; // token top-left
        const ty = token.document.y;
        let minOccludingDepth = Infinity;
        let maxNonOccludingDepth = -Infinity;
        for (const te of foregroundTileEntries) {
            const tileDoc = te.tile.document;
            const tileX = tileDoc.x;
            const tileY = tileDoc.y;
            const occludes = (tileX <= tx) && (tileY >= ty);
            if (occludes) {
                if (te.depth < minOccludingDepth) minOccludingDepth = te.depth;
            } else {
                if (te.depth > maxNonOccludingDepth) maxNonOccludingDepth = te.depth;
            }
        }
        let depth;
        if (minOccludingDepth === Infinity) {
            depth = (maxNonOccludingDepth === -Infinity) ? 0 : (maxNonOccludingDepth + 1);
        } else if (maxNonOccludingDepth < minOccludingDepth) {
            depth = (maxNonOccludingDepth + minOccludingDepth) / 2;
        } else {
            depth = minOccludingDepth - 1;
        }
        // Attempt clone but don't skip debug if it fails
    const clone = cloneTokenSprite(token);
    if (clone) tokenEntries.push({ depth, sprite: clone, token });
    tokenDepthMap.set(token.id, depth);
    }

    const combined = [...foregroundTileEntries, ...tokenEntries];
    combined.sort((a,b)=> a.depth - b.depth);
    for (const e of combined) {
        e.sprite.zIndex = e.depth;
        foregroundContainer.addChild(e.sprite);
    }

    updateLayerOpacity(backgroundContainer);
    updateLayerOpacity(foregroundContainer);

    if (DEBUG_PRINT) {
        try {
            const plan = { debugTiles: [], debugTokens: [] };
            // Foreground tiles: use computed depth actually applied to zIndex, not raw document.sort
            for (const fe of foregroundTileEntries) {
                const tile = fe.tile; if (!tile?.mesh) continue;
                const { gx, gy } = getTileBottomCornerGridXY(tile);
                const applied = Math.round(fe.depth); // final zIndex used
                plan.debugTiles.push({ gx, gy, sort: applied, px: tile.document.x, py: tile.document.y + tile.document.height });
            }
            // Background tiles: they don't get a depth; use their document.sort (their relative ordering inside background container)
            for (const be of backgroundEntries) {
                const tile = be.sprite?.originalTile; if (!tile?.mesh) continue;
                const { gx, gy } = getTileBottomCornerGridXY(tile);
                const applied = Number(tile.document.sort) || 0;
                plan.debugTiles.push({ gx, gy, sort: applied, px: tile.document.x, py: tile.document.y + tile.document.height });
            }
            // Tokens: iterate all placeables so we still show debug even if clone failed
            for (const token of canvas.tokens.placeables) {
                if (!token) continue;
                const { gx, gy } = getTokenGridXY(token);
                const doc = token.document;
                const w = (Number(doc.width) || 1) * (canvas.grid?.size || 1);
                const h = (Number(doc.height) || 1) * (canvas.grid?.size || 1);
                const px = Number(doc.x) + w * 0.5;
                const py = Number(doc.y) + h;
                const depth = tokenDepthMap.get(token.id);
                if (depth !== undefined) plan.debugTokens.push({ gx, gy, sort: Math.round(depth), px, py });
            }
            addDebugOverlays(plan);
        } catch (e) { if (DEBUG_PRINT) console.warn('addDebugOverlays failed', e); }
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