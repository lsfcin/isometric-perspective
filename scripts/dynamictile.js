import { MODULE_ID, DEBUG_PRINT, FOUNDRY_VERSION } from './main.js';
import { ISOMETRIC_CONST } from './consts.js';

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
        tilesCtl.tools.push(
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
export function increaseTilesOpacity() { updateTilesOpacity(tilesOpacity + 0.5); }
export function decreaseTilesOpacity() { updateTilesOpacity(tilesOpacity - 0.5); }

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
    // Do not reorder alwaysVisibleContainer to the top; overlay.js keeps the overlay layer on top.

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

    // Do not modify original tile mesh alpha; keep base tiles rendering as-is in isometric view

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
            continue;
        }
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

    // Do not create base tile clones. We will keep the original tile mesh visible unless a tile
    // actually needs to occlude a token, in which case we add occluder clones and hide the original once.
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
            plan.hideOriginalTileIds.push(te.tile.id);
        }
    }

    // Occluder clones on tokens layer (for proper stacking), only for tiles that actually occlude each token
    const hideSet = new Set(plan.hideOriginalTileIds || []);
    for (const tk of visibleTokens) {
        const { gx, gy } = getTokenGridXY(tk);
        const depth = gx + gy;
        const occludingTiles = tileEntries.filter(te => gx >= te.gx && gy <= te.gy);
        for (const te of occludingTiles) {
            // If we already replaced the base tile for the controlled token with an occluder clone,
            // don’t add a duplicate for that same token here.
        if (controlledToken && tk.id === controlledToken.id && hideSet.has(te.tile.id)) continue;
            const occ = cloneTileSprite(te.tile, te.walls, true);
            if (occ) plan.occluders.push({ sprite: occ, z: depth + 0.5 });
        // Mark this tile to hide its original since an occluder clone exists
        hideSet.add(te.tile.id);
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

function calculateAngle(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.atan2(Math.abs(dy), Math.abs(dx)) * (180 / Math.PI);
}

function getWallDirection(x1, y1, x2, y2) {
    if (x2 > x1) return y2 < y1 ? 'forward' : 'backward';
    return y2 > y1 ? 'forward' : 'backward';
}

function isTokenInFrontOfWall(token, wall) {
    if (FOUNDRY_VERSION === 11) {
        if (!wall?.A || !wall?.B || !token?.center) return false;
    } else {
        if (!wall?.edge?.a || !wall?.edge?.b || !token?.center) return false;
    }

    const { x: x1, y: y1 } = FOUNDRY_VERSION === 11 ? wall.A : wall.edge.a;
    const { x: x2, y: y2 } = FOUNDRY_VERSION === 11 ? wall.B : wall.edge.b;
    const { x: tokenX, y: tokenY } = token.center;

    if (Math.abs(y1 - y2) < 0.001) return tokenY > y1; // horizontal
    if (Math.abs(x1 - x2) < 0.001) return tokenX < x1; // vertical

    const angle = calculateAngle(x1, y1, x2, y2);
    const wallDirection = getWallDirection(x1, y1, x2, y2);
    const slope = (y2 - y1) / (x2 - x1);
    const wallYAtTokenX = slope * (tokenX - x1) + y1;
    const difference = tokenY - wallYAtTokenX;

    if (wallDirection === 'forward') { // '/'
        return angle < 45 ? difference > 0 : difference < 0;
    } else { // '\\'
        return difference > 0;
    }
}

function canTokenSeeWall(token, wall) {
    if (!wall || !token) return false;
    if (!isTokenInFrontOfWall(token, wall)) return false;

    const wallPoints = FOUNDRY_VERSION === 11 ? [wall.A, wall.center, wall.B] : [wall.edge.a, wall.center, wall.edge.b];
    const tokenPosition = token.center;
    for (const point of wallPoints) {
        const visibilityTest = FOUNDRY_VERSION === 11
            ? canvas.effects.visibility.testVisibility(point, { tolerance: 2 })
            : canvas.visibility?.testVisibility(point, { tolerance: 2 });
        if (!visibilityTest) continue;
        const ray = new Ray(tokenPosition, point);
        const collision = CONFIG.Canvas.polygonBackends.sight.testCollision(ray.B, ray.A, { mode: 'any', type: 'sight' });
        if (!collision) return true;
    }
    return false;
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
    const y = tile.document.y + tile.document.height;
    const gx = Math.floor(x / gs);
    const gy = Math.floor(y / gs);
    return { gx, gy };
}

// Geometry helpers for robust occluder selection
function safeGetBounds(displayObject) {
    try {
        if (!displayObject) return null;
        const b = displayObject.getBounds?.();
        if (!b || !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.width) || !isFinite(b.height)) return null;
        if (b.width <= 0 || b.height <= 0) return null;
        return new PIXI.Rectangle(b.x, b.y, b.width, b.height);
    } catch {
        return null;
    }
}

function rectsIntersect(a, b) {
    if (!a || !b) return false;
    return !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y);
}

function rectCenter(r) {
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function nearestByDistance(tiles, point) {
    if (!tiles?.length || !point) return null;
    let best = null;
    let bestD2 = Infinity;
    for (const te of tiles) {
        const rb = safeGetBounds(te.tile?.mesh);
        const c = rb ? rectCenter(rb) : { x: te.tile?.document?.x ?? 0, y: te.tile?.document?.y ?? 0 };
        const dx = c.x - point.x;
        const dy = c.y - point.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = te; }
    }
    return best;
}

// Grid-only selection: choose occluder minimizing (gx - tx) + (ty - gy), with depth tie-breaker
function selectNearestGridOccluder(tiles, gx, gy) {
    if (!tiles?.length) return null;
    let best = null;
    let bestScore = Infinity;
    for (const te of tiles) {
        const dx = gx - te.gx; // positive
        const dy = te.gy - gy; // positive
        const score = dx + dy; // Manhattan in grid space toward the tile corner
        if (score < bestScore) { bestScore = score; best = te; }
        else if (score === bestScore) {
            if (!best || te.depth > best.depth) best = te; // tie-break by deeper tile corner
        }
    }
    return best;
}