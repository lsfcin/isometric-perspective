import { MODULE_ID, DEBUG_PRINT, FOUNDRY_VERSION } from './main.js';

// Module state
let alwaysVisibleContainer;
let tilesLayer;
let tokensLayer;
let tilesOpacity = 1.0;
let tokensOpacity = 1.0;
let lastControlledToken = null;

export function registerDynamicTileConfig() {
    const enableOcclusionDynamicTile = game.settings.get(MODULE_ID, 'enableOcclusionDynamicTile');
    const worldIsometricFlag = game.settings.get(MODULE_ID, 'worldIsometricFlag');
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
        canvas.stage.sortChildren();
    });

    Hooks.on('changeScene', () => {
        if (!alwaysVisibleContainer) return;
        canvas.stage.removeChild(alwaysVisibleContainer);
        alwaysVisibleContainer.destroy({ children: true });
        alwaysVisibleContainer = null;
        tilesLayer = null;
        tokensLayer = null;
    });

    // Refresh triggers
    Hooks.on('canvasReady', () => updateAlwaysVisibleElements());
    Hooks.on('canvasTokensRefresh', () => updateAlwaysVisibleElements());
    Hooks.on('updateUser', (user, changes) => {
        if (user.id === game.user.id && 'character' in changes) updateAlwaysVisibleElements();
    });

    // Tile hooks
    Hooks.on('createTile', (tile) => {
        tile.setFlag(MODULE_ID, 'linkedWallIds', []);
    });
    Hooks.on('updateTile', async (tileDocument, change) => {
        if ('flags' in change && MODULE_ID in change.flags) {
            const currentFlags = change.flags[MODULE_ID] ?? {};
            if ('linkedWallIds' in currentFlags) {
                const validArray = ensureWallIdsArray(currentFlags.linkedWallIds);
                await tileDocument.setFlag(MODULE_ID, 'linkedWallIds', validArray);
            }
        }
        updateAlwaysVisibleElements();
    });
    Hooks.on('refreshTile', () => updateAlwaysVisibleElements());
    Hooks.on('deleteTile', () => updateAlwaysVisibleElements());

    // Token hooks
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
    Hooks.on('refreshToken', () => updateAlwaysVisibleElements());

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
    layer.children.forEach(sprite => { sprite.alpha = opacity; });
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
}

export function updateTokensOpacity(value) {
    tokensOpacity = Math.max(0, Math.min(1, value));
    if (tokensLayer) updateLayerOpacity(tokensLayer, tokensOpacity);
}
export function increaseTokensOpacity() { updateTokensOpacity(tokensOpacity + 0.1); }
export function decreaseTokensOpacity() { updateTokensOpacity(tokensOpacity - 0.1); }

function cloneTileSprite(tile, walls) {
    const sprite = new PIXI.Sprite(tile.texture);
    sprite.position.set(tile.position.x, tile.position.y);
    sprite.anchor.set(tile.anchor.x, tile.anchor.y);
    sprite.angle = tile.angle;
    sprite.scale.set(tile.scale.x, tile.scale.y);
    const hasClosedDoor = walls.some(wall => wall && (wall.document.door === 1 || wall.document.door === 2) && wall.document.ds === 1);
    if (hasClosedDoor) return null;
    sprite.alpha = tile.alpha * tilesOpacity;
    sprite.eventMode = 'passive';
    sprite.originalTile = tile;
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
        sprite.alpha = token.alpha * tokensOpacity;
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

    // Debug overlays (coordinates), added last so they render on top
    addDebugOverlays(plan);

    updateLayerOpacity(tilesLayer, tilesOpacity);
    // Ensure tiles use insertion order only (no zIndex sorting)
    tilesLayer.sortableChildren = false;
    tokensLayer.sortableChildren = true;
}

function computeVisibilityDrawPlan(controlledToken) {
    const plan = { tiles: [], tokens: [], occluders: [], debugTiles: [], debugTokens: [] };

    const tilesWithLinkedWalls = canvas.tiles.placeables.filter(tile => {
        const walls = getLinkedWalls(tile);
        return walls.length > 0;
    });

    // Manual ordering only: respect TileDocument.sort; ignore elevation or any dynamic sort
    const tilesSorted = [...tilesWithLinkedWalls].sort((a, b) => {
        const sa = typeof a.document?.sort === 'number' ? a.document.sort : 0;
        const sb = typeof b.document?.sort === 'number' ? b.document.sort : 0;
        if (sa !== sb) return sa - sb;
        const ida = String(a.document?.id || '');
        const idb = String(b.document?.id || '');
        return ida.localeCompare(idb);
    });

    // Prepare tiles and their grid bottom-corner for later token occlusion checks
    const tileEntries = [];
    for (const tile of tilesSorted) {
        const walls = getLinkedWalls(tile);
        const clonedSprite = cloneTileSprite(tile.mesh, walls);
        if (clonedSprite) plan.tiles.push({ sprite: clonedSprite });

        const { gx: tgx, gy: tgy } = getTileBottomCornerGridXY(tile);
        // Collect debug info for tile bottom-corner grid coords
        plan.debugTiles.push({ gx: tgx, gy: tgy, px: tile.document.x, py: tile.document.y + tile.document.height });
        tileEntries.push({ tile, walls, gx: tgx, gy: tgy, depth: tgx + tgy });
    }

            const controlledSprite = cloneTokenSprite(controlledToken.mesh);
            if (controlledSprite) {
                const { gx, gy } = getTokenGridXY(controlledToken);
                const depth = gx + gy;
                plan.tokens.push({ sprite: controlledSprite, z: depth });
                // Debug info for controlled token
                plan.debugTokens.push({ gx, gy, px: controlledToken.center.x, py: controlledToken.center.y });

                // Grid-only occlusion: for every tile where (gx >= tx && gy <= ty), draw that tile above this token
                const occludingTiles = tileEntries.filter(te => gx >= te.gx && gy <= te.gy);
                for (const te of occludingTiles) {
                    const occ = cloneTileSprite(te.tile.mesh, te.walls);
                    if (occ) plan.occluders.push({ sprite: occ, z: depth + 0.5 });
                }
            }

    for (const token of canvas.tokens.placeables) {
        if (!token?.mesh) continue;
        if (token.id === controlledToken.id) continue;
        if (!canTokenSeeToken(controlledToken, token)) continue;

            const tokenSprite = cloneTokenSprite(token.mesh);
            if (!tokenSprite) continue;

                const { gx, gy } = getTokenGridXY(token);
                const depth = gx + gy;
                plan.tokens.push({ sprite: tokenSprite, z: depth });
                // Debug info for visible token
                plan.debugTokens.push({ gx, gy, px: token.center.x, py: token.center.y });

                // Grid-only occlusion for all qualifying tiles
                const occludingTiles = tileEntries.filter(te => gx >= te.gx && gy <= te.gy);
                for (const te of occludingTiles) {
                    const occ = cloneTileSprite(te.tile.mesh, te.walls);
                    if (occ) plan.occluders.push({ sprite: occ, z: depth + 0.5 });
                }
    }

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
            txt.zIndex = 100000;
            txt.eventMode = 'passive';
            tokensLayer.addChild(txt);
        }

        for (const k of plan.debugTokens || []) {
            const txt = new PIXI.Text(`K(${k.gx},${k.gy})`, tokenStyle);
            txt.anchor.set(0.5, 1);
            txt.position.set(k.px, k.py - 16);
            txt.zIndex = 100000;
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