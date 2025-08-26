import { MODULE_ID, DEBUG_PRINT, FOUNDRY_VERSION } from './main.js';
import { ensureWallIdsArray } from './tile.js';
import { addDebugOverlays } from './overlay.js';

const TILE_STRIDE = 10000; // large spacing between tile depth bands

let foreground; // combined foreground tiles + token clones (interwoven ordering)
let lastControlledToken = null;

let fogFilter = new PIXI.filters.ColorMatrixFilter();
fogFilter.matrix = [
    1, 0, 0, 0, -0.1,
    0, 1, 0, 0, -0.1,
    0, 0, 1, 0, -0.1,
    0, 0, 0, 1, 0
];

// --- Helper functions ---
function clamp01(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(1, v));
}

function getSeenBy(tile) {
    return new Set(tile.document.getFlag(MODULE_ID, 'seenBy') || []);
}

async function markSeenBy(tile, viewers) {
    const tileDoc = tile.document;
    let seenBy = getSeenBy(tile);
    viewers.forEach(v => seenBy.add(v.id));
    await tileDoc.setFlag(MODULE_ID, 'seenBy', Array.from(seenBy));
}

// --- Hooks ---
export function registerOcclusionConfig() {
    if (!enableForegroundTileOcclusion()) return;
    registerLifecycleHooks();
    registerTileHooks();
    registerTokenHooks();
    registerMiscHooks();
    registerFogOfWarHooks();
}

function enableForegroundTileOcclusion() {
    try {
        //const enable = game.settings.get(MODULE_ID, 'enableOcclusionDynamicTile');
        //const enable = game.settings.get(MODULE_ID, 'enableOcclusionDynamicTile');
        const worldIso = game.settings.get(MODULE_ID, 'worldIsometricFlag');
        //return !!(enable && worldIso);
        return !!(worldIso);
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
    Hooks.on('createWall', () => updateAlwaysVisibleElements());
    Hooks.on('deleteWall', () => updateAlwaysVisibleElements());
}

function registerFogOfWarHooks() {
    Hooks.once('ready', () => {
        const fog = canvas?.fog;
        if (fog && fog._handleReset instanceof Function) {
            const original = fog._handleReset.bind(fog);
            fog._handleReset = async function (...args) {
                Hooks.callAll('resetFogOfWar', fog, ...args);
                return original(...args);
            };
        }
    });

    Hooks.on('resetFogOfWar', (fogManager, ...args) => {
        for (const tile of canvas.tiles.placeables) {
            //tile.seenBy = new Set();
            tile.document.setFlag(MODULE_ID, 'seenBy', []);
        }
    });
}

// ---- Hook handlers ----
function setupContainers() {
    if (foreground) {
        try { if (foreground.parent) foreground.parent.removeChild(foreground); foreground.destroy({ children: true }); } catch { }
    }
    foreground = new PIXI.Container();
    foreground.name = 'Isometric Foreground';
    foreground.sortableChildren = true;
    foreground.eventMode = 'passive';
    // Place above native tiles but (ideally) below tokens original layer; since we hide originals, exact order is less critical
    canvas.stage.addChild(foreground);
}

function teardownContainers() {
    if (foreground) {
        try { if (foreground.parent) foreground.parent.removeChild(foreground); foreground.destroy({ children: true }); } catch { }
    }
    foreground = null;
}

function migrateLegacyIsoLayerFlags() {
    try {
        const updates = [];
        for (const tile of canvas.tiles.placeables) {
            const tileDoc = tile.document;
            const hasIso = tileDoc.getFlag(MODULE_ID, 'isoLayer');
            if (hasIso) continue;
            const legacy = tileDoc.getFlag(MODULE_ID, 'OccludingTile');
            const layer = legacy ? 'foreground' : 'background';
            updates.push({ _id: tileDoc.id, [`flags.${MODULE_ID}.isoLayer`]: layer });
        }
        if (updates.length) canvas.scene.updateEmbeddedDocuments('Tile', updates);

        // Migrate legacy OcclusionAlpha -> OpacityOnOccluding if new flag absent
        const opMigrations = [];
        for (const tile of canvas.tiles.placeables) {
            const tileDoc = tile.document;
            const hasNew = tileDoc.getFlag(MODULE_ID, 'OpacityOnOccluding');
            if (hasNew !== undefined) continue;
            const old = tileDoc.getFlag(MODULE_ID, 'OcclusionAlpha');
            if (old !== undefined && old !== null && old !== 1) {
                opMigrations.push({ _id: tileDoc.id, [`flags.${MODULE_ID}.OpacityOnOccluding`]: clamp01(old) });
            }
        }
        if (opMigrations.length) canvas.scene.updateEmbeddedDocuments('Tile', opMigrations);
    } catch (e) { if (DEBUG_PRINT) console.warn('Iso layer migration failed', e); }
}

function initializeNewTileFlags(tile) {
    try { if (!tile.getFlag(MODULE_ID, 'isoLayer')) tile.setFlag(MODULE_ID, 'isoLayer', 'foreground'); } catch { }
    try { tile.setFlag(MODULE_ID, 'linkedWallIds', []); } catch { }
    try { tile.setFlag(MODULE_ID, 'OcclusionAlpha', 1); } catch { }
    try { tile.setFlag(MODULE_ID, 'seenBy', []); } catch { }
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
    } catch { }
    updateAlwaysVisibleElements();
}

function handleControlToken(token, controlled) {
    if (controlled) lastControlledToken = token; else {
        // If no tokens remain controlled, clear lastControlledToken so we fall back to all tokens view
        const stillControlled = canvas.tokens.controlled.length; // includes this one before removal? event fires after change
        if (!stillControlled) lastControlledToken = null;
    }
    updateAlwaysVisibleElements();
    // After rebuild, reapply per-token opacity (already done inside updateLayerOpacity, but ensure immediate)
    updateLayerOpacity(foreground);
}

function handleUpdateToken(tokenDocument) {
    if (lastControlledToken && tokenDocument.id === lastControlledToken.id) {
        lastControlledToken = canvas.tokens.get(tokenDocument.id);
    }
    updateAlwaysVisibleElements();
    updateLayerOpacity(foreground);
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
    // Determine viewpoint tokens: if any controlled -> those; else if lastControlledToken still set (legacy) -> that; else all visible tokens
    let viewTokens = [];
    const controlled = canvas.tokens.controlled.filter(t => !!t.visible);
    if (controlled.length) viewTokens = controlled;
    else if (lastControlledToken && lastControlledToken.visible) viewTokens = [lastControlledToken];
    else viewTokens = canvas.tokens.placeables.filter(t => t.visible);
    const tokenPositions = viewTokens.map(token => ({ x: token.document.x, y: token.document.y }));
    layer.children.forEach(sprite => {
        let alpha = typeof sprite.baseAlpha === 'number' ? sprite.baseAlpha : sprite.alpha ?? 1;
        const group = sprite.opacityGroup === 'tokens' ? 'tokens' : 'tiles';
        // Apply per-token occluding opacity if any viewpoint token exists (union rule)
        if (group === 'tiles' && tokenPositions.length && sprite.originalTile) {
            try {
                const tileDoc = sprite.originalTile.document;
                const tileX = tileDoc.x;
                const tileBottomY = tileDoc.y + tileDoc.height - 0.0001;
                let occludesAny = false;
                for (const pos of tokenPositions) {
                    if (tileX <= pos.x && tileBottomY >= pos.y) { occludesAny = true; break; }
                }
                if (occludesAny) {
                    const perFlag = tileDoc.getFlag(MODULE_ID, 'OpacityOnOccluding');
                    if (perFlag !== undefined) alpha = alpha * clamp01(perFlag);
                }
            } catch { }
        }
        sprite.alpha = alpha;
    });
}

function cloneTileSprite(tilePlaceable) {
    const mesh = tilePlaceable?.mesh;
    if (!mesh) return null;
    const sprite = new PIXI.Sprite(mesh.texture);
    sprite.position.set(mesh.position.x, mesh.position.y);
    sprite.anchor.set(mesh.anchor.x, mesh.anchor.y);
    sprite.angle = mesh.angle;
    try { sprite.rotation = mesh.rotation; if (mesh.skew) sprite.skew.set(mesh.skew.x, mesh.skew.y); } catch { }
    try { sprite.scale.set(mesh.scale.x, mesh.scale.y); } catch { sprite.scale.set(1, 1); }
    const tileDocAlpha = typeof tilePlaceable?.document?.alpha === 'number' ? tilePlaceable.document.alpha : 1;
    sprite.baseAlpha = tileDocAlpha; // store document alpha only
    sprite.alpha = tileDocAlpha; // initial alpha; may be reduced per view token later
    sprite.opacityGroup = 'tiles';
    sprite.eventMode = 'passive';
    sprite.originalTile = tilePlaceable;

    // Set of token IDs that have seen this tile
    // If the original tile was never seen before use a new set
    if (!sprite.originalTile.seenBy) {
        sprite.originalTile.seenBy = new Set();
    }

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
        try { sprite.rotation = mesh.rotation; if (mesh.skew) sprite.skew.set(mesh.skew.x, mesh.skew.y); } catch { }
        try { sprite.scale.set(mesh.scale.x, mesh.scale.y); } catch { sprite.scale.set(1, 1); }
        const tokenAlpha = typeof token.alpha === 'number' ? token.alpha : 1;
        sprite.baseAlpha = tokenAlpha;
        sprite.alpha = tokenAlpha;
        sprite.opacityGroup = 'tokens';
        sprite.eventMode = 'passive';
        sprite.originalToken = token;
        // Mirror Foundry visibility (covers hidden, vision-based, permission-based). If token.visible is false, hide clone.
        try { sprite.visible = !!token.visible; } catch { sprite.visible = true; }
        try { token.mesh.alpha = 0; } catch { }
        return sprite;
    } catch (e) {
        if (DEBUG_PRINT) console.warn('cloneTokenSprite failed', e);
        return null;
    }
}

function collectTileEntries() {
    const backgroundTileDocs = [];
    const foregroundTileEntries = [];
    for (const tile of canvas.tiles.placeables) {
        if (!tile?.mesh) continue;
        let layer = tile.document.getFlag(MODULE_ID, 'isoLayer');
        if (layer !== 'background' && layer !== 'foreground') layer = 'foreground';
        const sort = Number(tile.document.sort) || 0;
        // Door-open hide: if any linked wall is a door (door>0) whose state is open (ds===1), hide tile art
        let hideForOpenDoor = false;
        try {
            const linkedIds = ensureWallIdsArray(tile.document.getFlag(MODULE_ID, 'linkedWallIds'));
            if (linkedIds.length) {
                for (const wid of linkedIds) {
                    const wall = canvas.walls.get(wid);
                    const wdoc = wall?.document;
                    if (!wdoc) continue;
                    const isDoor = Number(wdoc.door) > 0; // 1=door,2=secret
                    const isOpen = Number(wdoc.ds) === 1; // 1=open
                    if (isDoor && isOpen) { hideForOpenDoor = true; break; }
                }
            }
        } catch { }
        if (layer === 'background') {
            try {
                const baseAlpha = (typeof tile.document.alpha === 'number') ? tile.document.alpha : 1;
                tile.mesh.alpha = hideForOpenDoor ? 0 : baseAlpha;
            } catch { }
            if (!hideForOpenDoor) backgroundTileDocs.push(tile); // if hidden we omit from debug ordering of background
        } else {
            if (hideForOpenDoor) {
                try { tile.mesh.alpha = 0; } catch { }
                continue; // skip cloning entirely while hidden
            }
            const clone = cloneTileSprite(tile);
            if (!clone) continue;
            try { tile.mesh.alpha = 0; } catch { }
            foregroundTileEntries.push({ sort, sprite: clone, tile });
        }
    }
    return { backgroundTileDocs, foregroundTileEntries };
}

function assignTileDepths(foregroundTileEntries) {
    const bySort = new Map();
    for (const tile of foregroundTileEntries) {
        if (!bySort.has(tile.sort)) bySort.set(tile.sort, []);
        bySort.get(tile.sort).push(tile);
    }
    for (const [sortValue, arr] of bySort.entries()) {
        arr.sort((a, b) => {
            const ay = a.tile.document.y + a.tile.document.height;
            const by = b.tile.document.y + b.tile.document.height;
            if (ay !== by) return ay - by;
            const ax = a.tile.document.x;
            const bx = b.tile.document.x;
            return ax - bx;
        });
        const base = sortValue * TILE_STRIDE;
        const margin = 100;
        const usableSpan = TILE_STRIDE - margin * 2;
        const step = Math.max(1, Math.floor(usableSpan / (arr.length + 1)));
        let offset = margin;
        for (const entry of arr) {
            entry.depth = base + offset;
            offset += step;
        }
    }
}

function computeTokenEntries(foregroundTileEntries) {
    const tokenEntries = [];
    const tokenDepthMap = new Map();
    for (const token of canvas.tokens.placeables) {
        if (!token) continue;
        const tokenIsVisible = !!token.visible;
        const tokenX = token.document.x;
        const tokenY = token.document.y;
        let minOccludingDepth = Infinity;
        let maxNonOccludingDepth = -Infinity;
        for (const tile of foregroundTileEntries) {
            const tileDoc = tile.tile.document;
            const tileX = tileDoc.x;
            const tileY = tileDoc.y + tileDoc.height - 0.0001;
            const occludes = (tileX <= tokenX) && (tileY >= tokenY);
            if (occludes) {
                if (tile.depth < minOccludingDepth) minOccludingDepth = tile.depth;
            } else {
                if (tile.depth > maxNonOccludingDepth) maxNonOccludingDepth = tile.depth;
            }
        }
        let depth;
        if (minOccludingDepth === Infinity) depth = (maxNonOccludingDepth === -Infinity) ? 0 : (maxNonOccludingDepth + 1);
        else if (maxNonOccludingDepth < minOccludingDepth) depth = (maxNonOccludingDepth + minOccludingDepth) / 2;
        else depth = minOccludingDepth - 1;
        const clone = cloneTokenSprite(token);
        if (clone) {
            if (!tokenIsVisible) clone.visible = false;
            tokenEntries.push({ depth, sprite: clone, token, visible: tokenIsVisible, baseDepth: depth });
        }
        if (tokenIsVisible) tokenDepthMap.set(token.id, depth);
    }
    return { tokenEntries, tokenDepthMap };
}

function refineTokenOrdering(tokenEntries, tokenDepthMap) {
    if (tokenEntries.length <= 1) return;
    tokenEntries.sort((a, b) => {
        if (a === b) return 0;
        const ax = a.token.document.x; const ay = a.token.document.y;
        const bx = b.token.document.x; const by = b.token.document.y;
        const aOccludesB = (ax <= bx) && (ay >= by);
        const bOccludesA = (bx <= ax) && (by >= ay);
        if (aOccludesB && !bOccludesA) return 1;
        if (bOccludesA && !aOccludesB) return -1;
        if (a.baseDepth !== b.baseDepth) return a.baseDepth - b.baseDepth;
        if (ay !== by) return ay - by;
        return ax - bx;
    });
    const EPS = 0.0001;
    for (let i = 0; i < tokenEntries.length; i++) {
        tokenEntries[i].depth = tokenEntries[i].baseDepth + (i * EPS);
        const id = tokenEntries[i].token.id;
        if (tokenDepthMap.has(id)) tokenDepthMap.set(id, tokenEntries[i].depth);
    }
}

function renderForeground(foregroundTileEntries, tokenEntries) {
    const foregroundElements = [...foregroundTileEntries, ...tokenEntries];
    foregroundElements.sort((a, b) => a.depth - b.depth);
    for (const element of foregroundElements) {
        element.sprite.zIndex = element.depth;
        foreground.addChild(element.sprite);
    }
}

function buildDebugPlan(foregroundTileEntries, backgroundTileDocs, tokenDepthMap) {
    if (!DEBUG_PRINT) return;
    try {
        const plan = { debugTiles: [], debugTokens: [] };
        // Match updateLayerOpacity viewpoint logic for debug occlusion flag
        let viewTokens = [];
        const controlled = canvas.tokens.controlled.filter(t => !!t.visible);
        if (controlled.length) viewTokens = controlled;
        else if (lastControlledToken && lastControlledToken.visible) viewTokens = [lastControlledToken];
        else viewTokens = canvas.tokens.placeables.filter(t => t.visible);
        const tokenPositions = viewTokens.map(token => ({ x: token.document.x, y: token.document.y }));
        for (const tileEntry of foregroundTileEntries) {
            const tile = tileEntry.tile; if (!tile?.mesh) continue;
            const { gx, gy } = getTileBottomCornerGridXY(tile);
            const applied = Math.round(tileEntry.depth);
            let occ = false;
            if (tokenPositions.length) {
                const tdoc = tile.document;
                const tileX = tdoc.x;
                const tileBottomY = tdoc.y + tdoc.height - 0.0001;
                for (const pos of tokenPositions) { if (tileX <= pos.x && tileBottomY >= pos.y) { occ = true; break; } }
            }
            plan.debugTiles.push({ gx, gy, sort: applied, px: tile.document.x, py: tile.document.y + tile.document.height, occ });
        }
        for (const tile of backgroundTileDocs) {
            if (!tile?.mesh) continue;
            const { gx, gy } = getTileBottomCornerGridXY(tile);
            const applied = Number(tile.document.sort) || 0;
            plan.debugTiles.push({ gx, gy, sort: applied, px: tile.document.x, py: tile.document.y + tile.document.height });
        }
        for (const token of canvas.tokens.placeables) {
            if (!token || !token.visible) continue;
            const { gx, gy } = getTokenGridXY(token);
            const tokenDoc = token.document;
            const gridSize = canvas.grid?.size || 1;
            const w = (Number(tokenDoc.width) || 1) * gridSize;
            const h = (Number(tokenDoc.height) || 1) * gridSize;
            const px = Number(tokenDoc.x) + w * 0.5;
            const py = Number(tokenDoc.y) + h;
            const depth = tokenDepthMap.get(token.id);
            if (depth !== undefined) plan.debugTokens.push({ gx, gy, sort: Math.round(depth), px, py });
        }
        addDebugOverlays(plan);
    } catch (e) { if (DEBUG_PRINT) console.warn('addDebugOverlays failed', e); }
}

function updateAlwaysVisibleElements() {
    if (!canvas.ready || !foreground) return;
    foreground.removeChildren();
    const { backgroundTileDocs, foregroundTileEntries } = collectTileEntries();
    assignTileDepths(foregroundTileEntries);
    const { tokenEntries, tokenDepthMap } = computeTokenEntries(foregroundTileEntries);
    refineTokenOrdering(tokenEntries, tokenDepthMap);
    renderForeground(foregroundTileEntries, tokenEntries);
    applyVisibilityCulling(foregroundTileEntries, tokenEntries);
    updateLayerOpacity(foreground);
    buildDebugPlan(foregroundTileEntries, backgroundTileDocs, tokenDepthMap);
}

// Corner-based visibility culling: hide cloned foreground tiles and token clones if none of their corners
// are in LOS of any player-observed token (or controlled tokens). Applies only if setting enabled.
function applyVisibilityCulling(foregroundTileEntries, tokenEntries) {
    try {
        // Gather viewer tokens (controlled or owned & visible)
        let viewers = canvas.tokens.controlled.filter(t => t.visible);

        if (!viewers.length) viewers = canvas.tokens.placeables.filter(t => t.visible && t.actor?.hasPlayerOwner);
        if (!viewers.length) return; // nothing to compare

        const viewerIds = new Set(viewers.map(v => v.id));
        const gridSize = canvas.grid?.size || 1;

        const testVisibility = (x, y) => {
            try {
                if (!canvas?.visibility?.testVisibility) return true; // fallback: do not hide
                for (const v of viewers) {
                    if (canvas.visibility?.testVisibility({ x, y }, { object: v })) return true;
                }
            } catch { return true; }
            return false;
        };
        const testPerimeter = (x, y, w, h) => {

            // Grab the grid size
            const gridSize = canvas.grid?.size || 1;

            const pts = []
            for (let i = 0; i <= w; i += gridSize) pts.push([x + i, y]);
            for (let i = 0; i <= w; i += gridSize) pts.push([x + i, y + h]);
            for (let j = 0; j <= h; j += gridSize) pts.push([x, y + j]);
            for (let j = 0; j <= h; j += gridSize) pts.push([x + w, y + j]);

            for (const [px, py] of pts) if (testVisibility(px + 0.001, py + 0.001)) return true;
            return false;
        };
        const testLine = (x1, y1, x2, y2) => {

            // Grab the grid size
            const gridSize = canvas.grid?.size || 1;
            const length = Math.hypot(x2 - x1, y2 - y1);
            const steps = Math.ceil(length / gridSize);
            const dx = (x2 - x1) / steps;
            const dy = (y2 - y1) / steps;

            const pts = []
            for (let i = 0; i <= steps; i++) {
                const x = x1 + dx * i;
                const y = y1 + dy * i;
                pts.push([x, y]);
            }

            for (const [px, py] of pts) if (testVisibility(px + 0.001, py + 0.001)) return true;
            return false;
        };

        // Cull tiles (foreground clones only)
        for (const entry of foregroundTileEntries) {

            // Test tile's visibility based on its perimeter
            const tile = entry.tile;
            const tileDoc = tile.document;
            let currentlyVisible = testPerimeter(tileDoc.x, tileDoc.y, tileDoc.width, tileDoc.height);

            // Test tile's visibility based on its walls vertices
            if (!currentlyVisible) {
                const walls = getLinkedWalls(tile);
                for (const wall of walls) {
                    const x1 = wall.document.c[0];
                    const y1 = wall.document.c[1];
                    const x2 = wall.document.c[2];
                    const y2 = wall.document.c[3];

                    const wallVisible = testLine(x1, y1, x2, y2);
                    if (wallVisible) {
                        currentlyVisible = true;
                        break;
                    }
                }
            }

            const seenBy = getSeenBy(tile);
            const hideOnFog = tile.document.getFlag(MODULE_ID, 'hideOnFog') ?? false;
            const intersection = seenBy.filter(id => viewerIds.has(id));
            const fogExploration = canvas.fog?.fogExploration === true;
            
            // Visible now, render normally without filters
            if (currentlyVisible) {
                markSeenBy(tile, viewers);
                viewers.forEach(v => tile.seenBy.add(v.id));
                entry.sprite.visible = true;
                entry.sprite.filters = [];
            }
            // On fog and fog active, render with fog filter
            else if (!currentlyVisible && !hideOnFog && fogExploration && intersection.size) 
            {
                entry.sprite.visible = true;
                entry.sprite.filters = [fogFilter];
            }
            // Not currently visible and not on fog (or not renderable on fog), hide the tile
            else 
            {
                entry.sprite.visible = false;
            }
        }

        // Cull token clones unless they are viewer tokens themselves (always visible)
        for (const entry of tokenEntries) {
            const token = entry.token; const tokenDoc = token.document;
            if (viewerIds.has(token.id)) {
                entry.sprite.visible = true;
                continue;
            }
            const w = (tokenDoc.width || 1) * gridSize; const h = (tokenDoc.height || 1) * gridSize;
            const visible = testPerimeter(tokenDoc.x, tokenDoc.y, w, h);
            entry.sprite.visible = visible;
        }
    } catch (e) { if (DEBUG_PRINT) console.warn('applyCornerVisibilityCulling failed', e); }
}

function getLinkedWalls(tile) {
    if (!tile || !tile.document) return [];
    const linkedWallIds = ensureWallIdsArray(tile.document.getFlag(MODULE_ID, 'linkedWallIds'));
    return linkedWallIds.map(id => canvas.walls.get(id)).filter(Boolean);
}

// Grid helpers and rule: a token (gx, gy) is occluded by a tile whose bottom-corner grid is (tx, ty)
// iff gx > tx AND gy > ty. We use gx+gy as a depth index for token z ordering.
function getTokenGridXY(token) {
    const gridSize = canvas.grid?.size || 1;
    // Use token.center as reference for grid position
    const gx = Math.floor(token.center.x / gridSize);
    const gy = Math.floor(token.center.y / gridSize);
    return { gx, gy };
}

function getTileBottomCornerGridXY(tile) {
    const gridSize = canvas.grid?.size || 1;
    // Bottom-left in top-down corresponds to bottom corner in isometric tile art
    // Use the tile bottom-left in scene coordinates: (x, y + height)
    const x = tile.document.x;
    // Subtract a tiny epsilon so a tile whose bottom edge lies exactly on a grid line
    // is classified into the cell above, matching token centers standing on it.
    const yBottomEdge = tile.document.y + tile.document.height - 0.0001;
    const gx = Math.floor(x / gridSize);
    const gy = Math.floor(yBottomEdge / gridSize);
    return { gx, gy };
}