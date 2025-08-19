import { MODULE_ID, DEBUG_PRINT, FOUNDRY_VERSION } from './main.js';

// Module state
let alwaysVisibleContainer;
let tilesLayer;
let tokensLayer;
let tilesOpacity = 1.0;
let tokensOpacity = 1.0;
let lastControlledToken = null;

function clamp01(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(1, v));
}

export function registerDynamicTileConfig() {
    const enableOcclusionDynamicTile = game.settings.get(MODULE_ID, 'enableOcclusionDynamicTile');
    const worldIsometricFlag = game.settings.get(MODULE_ID, 'worldIsometricFlag');

    // From here on, only run the full dynamic tiles system if enabled
    if (!worldIsometricFlag || !enableOcclusionDynamicTile) return;

    // Canvas lifecycle
    Hooks.on('canvasInit', () => {
        if (alwaysVisibleContainer) {
            canvas.stage.removeChild(alwaysVisibleContainer);
            alwaysVisibleContainer.destroy({ children: true });
        }

        alwaysVisibleContainer = new PIXI.Container();
        alwaysVisibleContainer.name = 'AlwaysVisibleContainer';
        alwaysVisibleContainer.eventMode = 'passive';

        tilesLayer = new PIXI.Container();
        tilesLayer.name = 'AlwaysVisibleTiles';

        tokensLayer = new PIXI.Container();
        tokensLayer.name = 'AlwaysVisibleTokens';

        alwaysVisibleContainer.addChild(tilesLayer);
        alwaysVisibleContainer.addChild(tokensLayer);

        canvas.stage.addChild(alwaysVisibleContainer);
    // Ensure correct layering order for the always visible container
    canvas.stage.sortChildren();
    });

    Hooks.on('changeScene', () => {
        if (!alwaysVisibleContainer) return;
        canvas.stage.removeChild(alwaysVisibleContainer);
        alwaysVisibleContainer.destroy({ children: true });
        alwaysVisibleContainer = null;
        tilesLayer = null;
        tokensLayer = null;
    // Hover layer is now managed by overlay.js
    });

    // Refresh triggers
    Hooks.on('canvasReady', () => updateAlwaysVisibleElements());
    Hooks.on('canvasTokensRefresh', () => updateAlwaysVisibleElements());
    Hooks.on('updateUser', (user, changes) => {
        if (user.id === game.user.id && 'character' in changes) updateAlwaysVisibleElements();
    });

    // Tile hooks (flags maintenance + re-render)
    Hooks.on('createTile', (tile) => {
        tile.setFlag(MODULE_ID, 'linkedWallIds', []);
        // Default occlusion overlay alpha to 1 (no extra dimming)
        try { tile.setFlag(MODULE_ID, 'OcclusionAlpha', 1); } catch {}
    });
    Hooks.on('updateTile', async (tileDocument, change) => {
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
        }
        updateAlwaysVisibleElements();
    });
    Hooks.on('refreshTile', () => updateAlwaysVisibleElements());
    Hooks.on('deleteTile', () => updateAlwaysVisibleElements());
    // Note: updateTile above already triggers refresh; avoid duplicate registration

    // Token hooks (re-render on token changes)
    Hooks.on('createToken', () => setTimeout(() => updateAlwaysVisibleElements(), 100));
    Hooks.on('controlToken', (token, controlled) => {
        if (controlled) lastControlledToken = token;
        updateAlwaysVisibleElements();
    });
    Hooks.on('updateToken', (tokenDocument) => {
        if (lastControlledToken && tokenDocument.id === lastControlledToken.id) {
            lastControlledToken = canvas.tokens.get(tokenDocument.id);
        }
        updateAlwaysVisibleElements();
    });
    Hooks.on('deleteToken', (token) => {
        if (lastControlledToken && token.id === lastControlledToken.id) lastControlledToken = null;
        updateAlwaysVisibleElements();
    });
    Hooks.on('refreshToken', (token) => {
        updateAlwaysVisibleElements();
    });
    // No drag/preview interception logic here; this module focuses on occlusion only.

    // Tile selection/hover overlays have been moved to overlay.js

    // Other hooks
    Hooks.on('sightRefresh', () => {
        if (canvas.ready && alwaysVisibleContainer) updateAlwaysVisibleElements();
    });
    Hooks.on('updateWall', (wallDocument, change) => {
        if (!('ds' in change)) return; // door state change only
        const linkedTiles = canvas.tiles.placeables.filter(tile => {
            const walls = getLinkedWalls(tile);
            return walls.some(w => w && w.id === wallDocument.id);
        });
        if (linkedTiles.length) updateAlwaysVisibleElements();
    });

    // UI buttons on Tiles controls
    Hooks.on('getSceneControlButtons', (controls) => {
        const tilesCtl = controls.find(b => b.name === 'tiles');
        if (!tilesCtl) return;
        // Insert our tools in a specific order so new ordering buttons appear just below
        // existing snapping / opacity increase controls ("dynamic-tile-increase" first).
        tilesCtl.tools.push(
            {
                name: 'tile-bring-front',
                title: 'Bring Selected Tiles to Front',
                icon: 'fa-solid fa-arrow-up-wide-short',
                active: true,
                onClick: () => bringSelectedTilesToFront(),
                button: true
            },
            {
                name: 'tile-send-back',
                title: 'Send Selected Tiles to Back',
                icon: 'fa-solid fa-arrow-down-short-wide',
                active: true,
                onClick: () => sendSelectedTilesToBack(),
                button: true
            },
            {
                name: 'dynamic-tile-increase',
                title: 'Increase Dynamic Tile Opacity',
                icon: 'fa-solid fa-layer-group',
                active: true,
                onClick: () => increaseTilesOpacity(),
                button: true
            },
            {
                name: 'dynamic-tile-decrease',
                title: 'Decrease Dynamic Tile Opacity',
                icon: 'fa-duotone fa-solid fa-layer-group',
                active: true,
                onClick: () => decreaseTilesOpacity(),
                button: true
            },
            {
                name: 'dynamic-tile-flip',
                title: 'Flip Selected Tiles',
                icon: 'fa-solid fa-arrows-left-right',
                active: true,
                onClick: () => flipSelectedTiles(),
                button: true
            }
        );
    });
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

// Bring selected tiles to front/back by manipulating their TileDocument.sort values.
async function bringSelectedTilesToFront() {
    try {
        const selected = Array.from(canvas.tiles?.controlled || []);
        if (!selected.length) return;
        const allSorts = canvas.tiles.placeables.map(t => typeof t.document?.sort === 'number' ? t.document.sort : 0);
        const maxSort = allSorts.length ? Math.max(...allSorts) : 0;
        // Preserve current relative order by sorting by existing sort ascending
        const ordered = selected.sort((a, b) => (a.document.sort || 0) - (b.document.sort || 0));
        let next = maxSort + 1;
        const updates = ordered.map(t => ({ _id: t.document.id, sort: next++ }));
        await canvas.scene.updateEmbeddedDocuments('Tile', updates);
    } catch (e) { if (DEBUG_PRINT) console.warn('bringSelectedTilesToFront failed', e); }
}

async function sendSelectedTilesToBack() {
    try {
        const selected = Array.from(canvas.tiles?.controlled || []);
        if (!selected.length) return;
        const allSorts = canvas.tiles.placeables.map(t => typeof t.document?.sort === 'number' ? t.document.sort : 0);
        const minSort = allSorts.length ? Math.min(...allSorts) : 0;
        // Sort ascending so top-most stays top-most among the moved group (while all move below others)
        const ordered = selected.sort((a, b) => (a.document.sort || 0) - (b.document.sort || 0));
        // Assign new sorts strictly below current minimum, preserving relative order
        let start = minSort - ordered.length;
        const updates = ordered.map(t => ({ _id: t.document.id, sort: start++ }));
        await canvas.scene.updateEmbeddedDocuments('Tile', updates);
    } catch (e) { if (DEBUG_PRINT) console.warn('sendSelectedTilesToBack failed', e); }
}

// Flip selected tiles around their bottom-left by swapping width/height, keeping bottom edge fixed,
// toggling the tokenFlipped flag, and inverting offsetY to match the Tile Config behavior.
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

function cloneTileSprite(tilePlaceable, walls, asOccluder = false) {
    const mesh = tilePlaceable?.mesh;
    if (!mesh) return null;
    const sprite = new PIXI.Sprite(mesh.texture);
    sprite.position.set(mesh.position.x, mesh.position.y);
    sprite.anchor.set(mesh.anchor.x, mesh.anchor.y);
    // Match original mesh transforms so appearance never changes when toggling occlusion
    sprite.angle = mesh.angle;
    try {
        sprite.rotation = mesh.rotation;
        if (mesh.skew) sprite.skew.set(mesh.skew.x, mesh.skew.y);
    } catch {}
    // Match the original mesh scale exactly for identical appearance
    try { sprite.scale.set(mesh.scale.x, mesh.scale.y); } catch { sprite.scale.set(1, 1); }
    // Base alpha uses the document alpha; when asOccluder, multiply by OcclusionAlpha
    const tileDocAlpha = typeof tilePlaceable?.document?.alpha === 'number' ? tilePlaceable.document.alpha : 1;
    const occAlpha = asOccluder ? clamp01(tilePlaceable?.document?.getFlag(MODULE_ID, 'OcclusionAlpha') ?? 1) : 1;
    const base = tileDocAlpha * occAlpha;
    sprite.baseAlpha = base;
    sprite.alpha = base * tilesOpacity;
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
    if (!canvas.ready || !alwaysVisibleContainer) return;
    tilesLayer.removeChildren();
    tokensLayer.removeChildren();

    const controlled = getInitialToken();
    if (!controlled) return;

    const plan = computeVisibilityDrawPlan(controlled);
    // Keep the always-visible container near the top so clones are not buried under the grid
    try {
        if (alwaysVisibleContainer?.parent === canvas.stage) {
            canvas.stage.removeChild(alwaysVisibleContainer);
            canvas.stage.addChild(alwaysVisibleContainer);
            // Signal overlay to raise itself above tiles
            Hooks.callAll('isometricOverlayBringToTop');
        }
    } catch {}

    for (const t of plan.tiles) {
        if (!t?.sprite) continue;
        tilesLayer.addChild(t.sprite);
    }
    for (const tk of plan.tokens) {
        if (!tk?.sprite) continue;
        if (typeof tk.z === 'number') tk.sprite.zIndex = tk.z;
        tokensLayer.addChild(tk.sprite);
    }
    for (const oc of plan.occluders) {
        if (!oc?.sprite) continue;
        if (typeof oc.z === 'number') oc.sprite.zIndex = oc.z;
        tokensLayer.addChild(oc.sprite);
    }

    // No drag/selection-specific mesh manipulation; occlusion plan controls hiding.

    // Hide/show original occluding tiles: originals are hidden when represented by clones
    try {
        const hideSet = new Set(plan.hideOriginalTileIds || []);
        for (const tile of canvas.tiles.placeables) {
            if (!tile?.mesh) continue;
            const isOccluding = !!tile.document?.getFlag(MODULE_ID, 'OccludingTile');
            if (!isOccluding) continue;
            if (hideSet.has(tile.id)) {
                tile.mesh.alpha = 0; // fully hidden on base canvas
            } else {
                const baseAlpha = typeof tile.document?.alpha === 'number' ? tile.document.alpha : 1;
                tile.mesh.alpha = baseAlpha;
            }
        }
    } catch {}

    // Debug overlays (coordinates), added last so they render on top
    addDebugOverlays(plan);

        updateLayerOpacity(tilesLayer, tilesOpacity);
        updateLayerOpacity(tokensLayer, tokensOpacity);
    // Ensure tiles use insertion order only (no zIndex sorting)
    tilesLayer.sortableChildren = false;
    tokensLayer.sortableChildren = true;
    // Overlay layer (if any) is managed separately by overlay.js
}

function computeVisibilityDrawPlan(controlledToken) {
    const plan = { tiles: [], tokens: [], occluders: [], debugTiles: [], debugTokens: [], hideOriginalTileIds: [] };

        // Tiles that participate in grid occlusion are those with the 'Occluding Tokens' flag
        const occlusionTilesByFlag = canvas.tiles.placeables.filter(tile => {
            return !!tile?.document?.getFlag(MODULE_ID, 'OccludingTile');
        });

    // Manual ordering only: respect TileDocument.sort; ignore elevation or any dynamic sort
        const tilesSorted = [...occlusionTilesByFlag].sort((a, b) => {
        const sa = typeof a.document?.sort === 'number' ? a.document.sort : 0;
        const sb = typeof b.document?.sort === 'number' ? b.document.sort : 0;
        if (sa !== sb) return sa - sb;
        const ida = String(a.document?.id || '');
        const idb = String(b.document?.id || '');
        return ida.localeCompare(idb);
    });

    // Prepare tiles and collect grid corners
    const tileEntries = [];
    for (const tile of tilesSorted) {
        const walls = getLinkedWalls(tile);
        // If any linked door is open, hide this tile entirely (original + clones)
        const anyDoorOpen = Array.isArray(walls) && walls.some(w => (w?.document?.door === 1 || w?.document?.door === 2) && w?.document?.ds === 1);
        if (anyDoorOpen) {
            plan.hideOriginalTileIds.push(tile.id);
            // Do not add any clones; tile becomes fully invisible
            continue;
        }
        // Hide the original occluding tile mesh; we will represent via clones
        plan.hideOriginalTileIds.push(tile.id);
        const { gx: tgx, gy: tgy } = getTileBottomCornerGridXY(tile);
        // Collect debug info for tile bottom-corner grid coords
        plan.debugTiles.push({ gx: tgx, gy: tgy, px: tile.document.x, py: tile.document.y + tile.document.height });
        tileEntries.push({ tile, walls, gx: tgx, gy: tgy, depth: tgx + tgy });
    }

    // Gather visible tokens (controlled + others visible from it)
    const visibleTokens = [];
    if (controlledToken?.mesh) {
        visibleTokens.push(controlledToken);
        const controlledSprite = cloneTokenSprite(controlledToken.mesh);
        if (controlledSprite) {
            const { gx, gy } = getTokenGridXY(controlledToken);
            const depth = gx + gy;
            plan.tokens.push({ sprite: controlledSprite, z: depth });
            plan.debugTokens.push({ gx, gy, px: controlledToken.center.x, py: controlledToken.center.y });
        }
    }
    for (const token of canvas.tokens.placeables) {
        if (!token?.mesh) continue;
        if (controlledToken && token.id === controlledToken.id) continue;
        if (!controlledToken || canTokenSeeToken(controlledToken, token)) {
            visibleTokens.push(token);
            const tokenSprite = cloneTokenSprite(token.mesh);
            if (!tokenSprite) continue;
            const { gx, gy } = getTokenGridXY(token);
            const depth = gx + gy;
            plan.tokens.push({ sprite: tokenSprite, z: depth });
            plan.debugTokens.push({ gx, gy, px: token.center.x, py: token.center.y });
        }
    }

    let controlledDepth = null;
    let cGX = null, cGY = null;
    if (controlledToken?.mesh) {
        const g = getTokenGridXY(controlledToken);
        cGX = g.gx; cGY = g.gy; controlledDepth = cGX + cGY;
    }
    for (const te of tileEntries) {
        const occludesControlled = controlledToken ? (cGX >= te.gx && cGY <= te.gy) : false;
        if (occludesControlled) {
            // Represent the whole tile using an occluder clone at controlled token depth
            const occ = cloneTileSprite(te.tile, te.walls, true);
            if (occ && controlledDepth !== null) plan.occluders.push({ sprite: occ, z: controlledDepth + 0.5 });
        } else {
            // For non-occluding tiles, place a base clone on the tiles layer
            const clonedSprite = cloneTileSprite(te.tile, te.walls, false);
            if (clonedSprite) plan.tiles.push({ sprite: clonedSprite });
        }
    }

    // Occluder clones on tokens layer (for proper stacking), only for tiles that actually occlude each token
    const hideSet = new Set(plan.hideOriginalTileIds || []);
    for (const tk of visibleTokens) {
        const { gx, gy } = getTokenGridXY(tk);
        const depth = gx + gy;
        const occludingTiles = tileEntries.filter(te => gx >= te.gx && gy <= te.gy);
        for (const te of occludingTiles) {
            // If we already added an occluder at controlled depth, skip duplication for the controlled token
            if (controlledToken && tk.id === controlledToken.id && hideSet.has(te.tile.id)) continue;
            const occ = cloneTileSprite(te.tile, te.walls, true);
            if (occ) plan.occluders.push({ sprite: occ, z: depth + 0.5 });
        }
    }

    // Reflect the final hide set into the plan
    plan.hideOriginalTileIds = Array.from(hideSet);
    return plan;
}

function addDebugOverlays(plan) {
    if (!DEBUG_PRINT) return;
    if (!tokensLayer) return;
    try {
        const tileStyle = new PIXI.TextStyle({ fontSize: 12, fill: '#00ffff', stroke: '#000000', strokeThickness: 3 });
        const tokenStyle = new PIXI.TextStyle({ fontSize: 12, fill: '#ffff00', stroke: '#000000', strokeThickness: 3 });

            for (const t of plan.debugTiles || []) {
                const txt = new PIXI.Text(`T(${t.gx},${t.gy})`, tileStyle);
                txt.anchor.set(0.5, 1);
                txt.position.set(t.px, t.py - 4);
                txt.zIndex = (t.gx ?? 0) + (t.gy ?? 0);
                txt.eventMode = 'passive';
                tokensLayer.addChild(txt);
            }

        for (const k of plan.debugTokens || []) {
            const txt = new PIXI.Text(`K(${k.gx},${k.gy})`, tokenStyle);
            txt.anchor.set(0.5, 1);
            txt.position.set(k.px, k.py - 16);
            txt.zIndex = (k.gx ?? 0) + (k.gy ?? 0);
            txt.eventMode = 'passive';
            tokensLayer.addChild(txt);
        }
    } catch (err) {
        console.error('Dynamic Tile Debug overlay error:', err);
    }
}

function ensureWallIdsArray(linkedWallIds) {
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
        } catch (e) {
            return [];
        }
    }
    return [];
}

function getLinkedWalls(tile) {
    if (!tile || !tile.document) return [];
    const linkedWallIds = ensureWallIdsArray(tile.document.getFlag(MODULE_ID, 'linkedWallIds'));
    return linkedWallIds.map(id => canvas.walls.get(id)).filter(Boolean);
}

function canTokenSeeToken(sourceToken, targetToken) {
    if (!sourceToken || !targetToken) return false;
    return canvas.visibility?.testVisibility(targetToken.center, { tolerance: 2 });
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