import { MODULE_ID, DEBUG_PRINT, FOUNDRY_VERSION } from './main.js';
import { ISOMETRIC_CONST } from './consts.js';

// Module state
let alwaysVisibleContainer;
let tilesLayer;
let tokensLayer;
let tilesOpacity = 1.0;
let tokensOpacity = 1.0;
let lastControlledToken = null;
let hoverLayer = null;
const draggingTileIds = new Set();
let _isoDragPreviewHider = null;
let _isoOverlayTicker = null;
const _isoDragState = new Map(); // tileId -> {lastX,lastY,lastMoveTs,active,saved:{x,y}}

function clamp01(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(1, v));
}

export function registerDynamicTileConfig() {
    const enableOcclusionDynamicTile = game.settings.get(MODULE_ID, 'enableOcclusionDynamicTile');
    const worldIsometricFlag = game.settings.get(MODULE_ID, 'worldIsometricFlag');

    // Always-on: ensure a hover layer exists for selection overlays, independent of dynamic feature toggle
    try {
        Hooks.on('canvasInit', () => {
            try {
                if (hoverLayer) {
                    canvas.stage.removeChild(hoverLayer);
                    hoverLayer.destroy({ children: true });
                }
                hoverLayer = new PIXI.Container();
                hoverLayer.name = 'HoverHighlightLayer';
                hoverLayer.eventMode = 'passive';
                canvas.stage.addChild(hoverLayer);
                canvas.stage.sortChildren();
            } catch {}
        });
        Hooks.on('changeScene', () => {
            try {
                if (hoverLayer) {
                    canvas.stage.removeChild(hoverLayer);
                    hoverLayer.destroy({ children: true });
                    hoverLayer = null;
                }
                if (_isoOverlayTicker && canvas?.app?.ticker) {
                    canvas.app.ticker.remove(_isoOverlayTicker);
                    _isoOverlayTicker = null;
                }
            } catch {}
        });
    } catch {}

    // Always-on: install tile drag wrappers to drive yellow overlay + offset displacement
    try {
        const T = globalThis.Tile;
        if (T && T.prototype && !T.prototype.__isoDragWrapInstalled) {
            const wrap = (name, when = 'after') => {
                const orig = T.prototype[name];
                if (typeof orig !== 'function' || orig.__isoPatched2) return;
                T.prototype[name] = function(...args) {
                    const layer = this.layer || canvas?.tiles;
                    const isoDisabled = !!this?.document?.getFlag(MODULE_ID, 'isoTileDisabled');
                    const isIso = !isoDisabled && worldIsometricFlag;
                    const start = () => {
                        try {
                            if (!isIso) return;
                            draggingTileIds.add(this.id);
                            // Inflate offsets (temp)
                            const mod = MODULE_ID;
                            const fx = this.document.getFlag(mod, 'offsetX') ?? 0;
                            const fy = this.document.getFlag(mod, 'offsetY') ?? 0;
                            this._isoSavedOffsets = { x: fx, y: fy };
                            const cast = 1_000_000;
                            foundry.utils.setProperty(this.document, `flags.${mod}.offsetX`, fx + cast);
                            foundry.utils.setProperty(this.document, `flags.${mod}.offsetY`, fy + cast);
                            // Draw yellow overlay
                            try { drawTileSelectionOverlay(this); } catch {}
                            // Hide any immediate preview
                            try { if (layer?.preview) { layer.preview.alpha = 0; layer.preview.visible = false; layer.preview.renderable = false; layer.preview.removeChildren?.(); } } catch {}
                        } catch {}
                    };
                    const move = () => { try { if (isIso) drawTileSelectionOverlay(this); } catch {} };
                    const end = () => {
                        try {
                            if (!isIso) return;
                            draggingTileIds.delete(this.id);
                            const mod = MODULE_ID;
                            const saved = this._isoSavedOffsets || { x: undefined, y: undefined };
                            if (saved.x === undefined) foundry.utils.unsetProperty(this.document, `flags.${mod}.offsetX`);
                            else foundry.utils.setProperty(this.document, `flags.${mod}.offsetX`, saved.x);
                            if (saved.y === undefined) foundry.utils.unsetProperty(this.document, `flags.${mod}.offsetY`);
                            else foundry.utils.setProperty(this.document, `flags.${mod}.offsetY`, saved.y);
                            delete this._isoSavedOffsets;
                            try { drawTileSelectionOverlay(this); } catch {}
                        } catch {}
                    };
                    if (name === '_onDragLeftStart') {
                        if (when === 'before') start();
                        const r = orig.apply(this, args);
                        if (when === 'after') start();
                        return r;
                    }
                    if (name === '_onDragLeftMove') { const r = orig.apply(this, args); move(); return r; }
                    if (name === '_onDragLeftDrop' || name === '_onDragLeftCancel') { const r = orig.apply(this, args); end(); return r; }
                    return orig.apply(this, args);
                };
                T.prototype[name].__isoPatched2 = true;
            };
            wrap('_onDragLeftStart', 'before');
            wrap('_onDragLeftMove');
            wrap('_onDragLeftDrop');
            wrap('_onDragLeftCancel');
            T.prototype.__isoDragWrapInstalled = true;
        }
    } catch {}

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
        // Create top-most hover layer for outlines that must ignore occlusion
        if (hoverLayer) {
            canvas.stage.removeChild(hoverLayer);
            hoverLayer.destroy({ children: true });
        }
        hoverLayer = new PIXI.Container();
        hoverLayer.name = 'HoverHighlightLayer';
        hoverLayer.eventMode = 'passive';
        canvas.stage.addChild(hoverLayer);
        canvas.stage.sortChildren();
    });

    Hooks.on('changeScene', () => {
        if (!alwaysVisibleContainer) return;
        canvas.stage.removeChild(alwaysVisibleContainer);
        alwaysVisibleContainer.destroy({ children: true });
        alwaysVisibleContainer = null;
        tilesLayer = null;
        tokensLayer = null;
        if (hoverLayer) {
            canvas.stage.removeChild(hoverLayer);
            hoverLayer.destroy({ children: true });
            hoverLayer = null;
        }
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
    Hooks.on('updateTile', () => updateAlwaysVisibleElements());

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
        const tok = canvas.tokens.get(tokenDocument.id);
        if (tok) updateHoverOutlinePosition(tok);
    });
    Hooks.on('deleteToken', (token) => {
        if (lastControlledToken && token.id === lastControlledToken.id) lastControlledToken = null;
        updateAlwaysVisibleElements();
        clearHoverOutline(token);
    });
    Hooks.on('refreshToken', (token) => {
        updateAlwaysVisibleElements();
        if (token) updateHoverOutlinePosition(token);
    });
    Hooks.on('hoverToken', (token, hovered) => {
        if (hovered) drawHoverOutline(token);
        else clearHoverOutline(token);
    });

    // Drag hooks to suppress distorted preview while moving isometric tiles
    Hooks.on('dragLeftStart', (layer, object, data) => {
        try {
            if (!(object instanceof Tile)) return;
            const isoDisabled = !!object.document?.getFlag(MODULE_ID, 'isoTileDisabled');
            if (isoDisabled) return;
            draggingTileIds.add(object.id);

            // Temporarily cast away the projected preview by inflating art offsets (do not persist)
            try {
                const mod = MODULE_ID;
                const fx = object.document.getFlag(mod, 'offsetX') ?? 0;
                const fy = object.document.getFlag(mod, 'offsetY') ?? 0;
                object._isoSavedOffsets = { x: fx, y: fy };
                const cast = 1_000_000; // large displacement in pixels (pre-iso)
                foundry.utils.setProperty(object.document, `flags.${mod}.offsetX`, fx + cast);
                foundry.utils.setProperty(object.document, `flags.${mod}.offsetY`, fy + cast);
            } catch {}
            if (object?.mesh) {
                object.mesh.alpha = 0;
                object.mesh.visible = false;
                object.mesh.renderable = false;
            }
            object.visible = false;
            // Hide the layer's preview object if any (Foundry V12)
            try {
                if (layer?.preview) {
                    layer.preview.alpha = 0;
                    layer.preview.visible = false;
                    layer.preview.renderable = false;
                    if (Array.isArray(layer.preview.children)) {
                        for (const ch of layer.preview.children) {
                            if (!ch) continue;
                            ch.alpha = 0;
                            ch.visible = false;
                            ch.renderable = false;
                        }
                        // Proactively drop any preview children to avoid ghost rectangles
                        try { layer.preview.removeChildren?.(); } catch {}
                    }
                }
            } catch {}
            // Also try to hide any preview attached to the object itself
            try {
                const candidates = [object.preview, object._preview, object._dragPreview, object.dragPreview];
                for (const p of candidates) {
                    if (!p) continue;
                    p.alpha = 0;
                    p.visible = false;
                    p.renderable = false;
                }
            } catch {}

            // Start a per-frame enforcer to keep any recreated previews off-screen
            try {
                if (!_isoDragPreviewHider && canvas?.app?.ticker) {
                    _isoDragPreviewHider = (dt) => {
                        try {
                            const off = 1e7;
                            const list = [layer?.preview, canvas?.tiles?.preview, object?.preview, object?._preview, object?._dragPreview, object?.dragPreview];
                            for (const target of list) {
                                if (!target) continue;
                                target.alpha = 0;
                                target.visible = false;
                                target.renderable = false;
                                if (target.position) {
                                    target.position.set(off, off);
                                }
                                if (Array.isArray(target.children)) {
                                    for (const ch of target.children) {
                                        if (!ch) continue;
                                        ch.alpha = 0;
                                        ch.visible = false;
                                        ch.renderable = false;
                                        if (ch.position) ch.position.set(off, off);
                                    }
                                    try { target.removeChildren?.(); } catch {}
                                }
                            }
                        } catch {}
                    };
                    canvas.app.ticker.add(_isoDragPreviewHider);
                }
            } catch {}
            updateAlwaysVisibleElements();
            // Redraw selection overlay as yellow while dragging
            try { drawTileSelectionOverlay(object); } catch {}
        } catch {}
    });
    Hooks.on('dragLeftMove', (layer, object) => {
        try {
            if (layer?.preview) {
                layer.preview.alpha = 0;
                layer.preview.visible = false;
                layer.preview.renderable = false;
                if (Array.isArray(layer.preview.children)) {
                    for (const ch of layer.preview.children) {
                        if (!ch) continue;
                        ch.alpha = 0;
                        ch.visible = false;
                        ch.renderable = false;
                    }
                    try { layer.preview.removeChildren?.(); } catch {}
                }
            }
            try {
                const candidates = [object?.preview, object?._preview, object?._dragPreview, object?.dragPreview];
                for (const p of candidates) {
                    if (!p) continue;
                    p.alpha = 0;
                    p.visible = false;
                    p.renderable = false;
                }
            } catch {}
            updateAlwaysVisibleElements();
            // Keep the overlay updated while dragging
            try { if (object instanceof Tile) drawTileSelectionOverlay(object); } catch {}
        } catch {}
    });
    Hooks.on('dragLeftDrop', (layer, object, data) => {
        try {
            if (!(object instanceof Tile)) return;
            draggingTileIds.delete(object.id);

            // Restore art offsets
            try {
                const mod = MODULE_ID;
                const saved = object._isoSavedOffsets || { x: undefined, y: undefined };
                if (saved.x === undefined) foundry.utils.unsetProperty(object.document, `flags.${mod}.offsetX`);
                else foundry.utils.setProperty(object.document, `flags.${mod}.offsetX`, saved.x);
                if (saved.y === undefined) foundry.utils.unsetProperty(object.document, `flags.${mod}.offsetY`);
                else foundry.utils.setProperty(object.document, `flags.${mod}.offsetY`, saved.y);
                delete object._isoSavedOffsets;
            } catch {}
            if (object?.mesh) {
                object.mesh.visible = true;
                object.mesh.renderable = true;
                const baseAlpha = typeof object.document?.alpha === 'number' ? object.document.alpha : 1;
                object.mesh.alpha = baseAlpha;
            }
            object.visible = true;
            // Preview is usually destroyed; if present, restore
            try {
                if (layer?.preview) {
                    layer.preview.visible = true;
                    layer.preview.renderable = true;
                }
            } catch {}
            // Stop enforcer
            try {
                if (_isoDragPreviewHider && canvas?.app?.ticker) {
                    canvas.app.ticker.remove(_isoDragPreviewHider);
                    _isoDragPreviewHider = null;
                }
            } catch {}
            updateAlwaysVisibleElements();
            // Redraw overlay back to non-drag color
            try { drawTileSelectionOverlay(object); } catch {}
        } catch {}
    });
    Hooks.on('dragLeftCancel', (layer, object) => {
        try {
            if (!(object instanceof Tile)) return;
            draggingTileIds.delete(object.id);

            // Restore art offsets
            try {
                const mod = MODULE_ID;
                const saved = object._isoSavedOffsets || { x: undefined, y: undefined };
                if (saved.x === undefined) foundry.utils.unsetProperty(object.document, `flags.${mod}.offsetX`);
                else foundry.utils.setProperty(object.document, `flags.${mod}.offsetX`, saved.x);
                if (saved.y === undefined) foundry.utils.unsetProperty(object.document, `flags.${mod}.offsetY`);
                else foundry.utils.setProperty(object.document, `flags.${mod}.offsetY`, saved.y);
                delete object._isoSavedOffsets;
            } catch {}
            if (object?.mesh) {
                object.mesh.visible = true;
                object.mesh.renderable = true;
                const baseAlpha = typeof object.document?.alpha === 'number' ? object.document.alpha : 1;
                object.mesh.alpha = baseAlpha;
            }
            object.visible = true;
            try {
                if (layer?.preview) {
                    layer.preview.visible = true;
                    layer.preview.renderable = true;
                }
            } catch {}
            try {
                if (_isoDragPreviewHider && canvas?.app?.ticker) {
                    canvas.app.ticker.remove(_isoDragPreviewHider);
                    _isoDragPreviewHider = null;
                }
            } catch {}
            updateAlwaysVisibleElements();
            // Redraw overlay back to non-drag color
            try { drawTileSelectionOverlay(object); } catch {}
        } catch {}
    });

        // Try to suppress creation of the default drag preview for Tiles in V12 to avoid distorted ghost images.
        const patchTileLayerPreviewSuppression = () => {
            try {
                const tl = canvas?.tiles;
                if (!tl) return;
                const methodNames = ['createDragPreview', '_createDragPreview', 'createPreview', '_createPreview'];
                for (const m of methodNames) {
                    const orig = tl[m];
                    if (typeof orig === 'function' && !orig.__isoPatched) {
                        tl[m] = function(...args) {
                            try {
                                const obj = args[0];
                                if (obj instanceof Tile) {
                                    const isoDisabled = !!obj?.document?.getFlag(MODULE_ID, 'isoTileDisabled');
                                    if (!isoDisabled) {
                                        // Skip creating a default preview for isometric tiles; we'll render our own clean clone.
                                        return undefined;
                                    }
                                }
                            } catch {}
                            return orig.apply(this, args);
                        };
                        tl[m].__isoPatched = true;
                    }
                }

                // Also patch prototypes if available to catch other code paths
                const candidates = [globalThis.PlaceablesLayer, globalThis.TilesLayer, tl.constructor, Object.getPrototypeOf(tl)?.constructor];
                for (const C of candidates) {
                    if (!C || !C.prototype) continue;
                    for (const m of methodNames) {
                        const orig = C.prototype[m];
                        if (typeof orig === 'function' && !orig.__isoPatched) {
                            C.prototype[m] = function(...args) {
                                try {
                                    const obj = args[0];
                                    if (obj instanceof Tile) {
                                        const isoDisabled = !!obj?.document?.getFlag(MODULE_ID, 'isoTileDisabled');
                                        if (!isoDisabled) return undefined;
                                    }
                                } catch {}
                                return orig.apply(this, args);
                            };
                            C.prototype[m].__isoPatched = true;
                        }
                    }
                }
            } catch {}
        };

        Hooks.on('canvasReady', patchTileLayerPreviewSuppression);
        if (canvas?.ready) patchTileLayerPreviewSuppression();

        // Patch Tile-level drag preview methods to no-op for isometric tiles
        const patchTileDragMethods = () => {
            try {
                const T = globalThis.Tile;
                if (!T || !T.prototype) return;
                const methodNames = ['_refreshDragPreview', 'refreshDragPreview', '_drawDragPreview', 'drawDragPreview'];
                for (const m of methodNames) {
                    const orig = T.prototype[m];
                    if (typeof orig === 'function' && !orig.__isoPatched) {
                        T.prototype[m] = function(...args) {
                            try {
                                const isoDisabled = !!this?.document?.getFlag(MODULE_ID, 'isoTileDisabled');
                                if (!isoDisabled) {
                                    // Skip drawing/updating any default drag preview for isometric tiles
                                    return undefined;
                                }
                            } catch {}
                            return orig.apply(this, args);
                        };
                        T.prototype[m].__isoPatched = true;
                    }
                }
            } catch {}
        };
        Hooks.on('canvasReady', patchTileDragMethods);
        if (canvas?.ready) patchTileDragMethods();

        // Ensure we capture drag lifecycle for tiles even if generic hooks fire differently in V12
        const patchTileDragHandlers = () => {
            try {
                const T = globalThis.Tile;
                if (!T || !T.prototype) return;
                const wrap = (name, when = 'after') => {
                    const orig = T.prototype[name];
                    if (typeof orig !== 'function' || orig.__isoPatched) return;
                    T.prototype[name] = function(...args) {
                        const layer = this.layer || canvas?.tiles;
                        const isoDisabled = !!this?.document?.getFlag(MODULE_ID, 'isoTileDisabled');
                        const isIso = !isoDisabled;
                        const runStart = () => {
                            try {
                                if (!isIso) return;
                                draggingTileIds.add(this.id);
                                // Offset inflate (temporary)
                                const mod = MODULE_ID;
                                const fx = this.document.getFlag(mod, 'offsetX') ?? 0;
                                const fy = this.document.getFlag(mod, 'offsetY') ?? 0;
                                this._isoSavedOffsets = { x: fx, y: fy };
                                const cast = 1_000_000;
                                foundry.utils.setProperty(this.document, `flags.${mod}.offsetX`, fx + cast);
                                foundry.utils.setProperty(this.document, `flags.${mod}.offsetY`, fy + cast);
                                // Hide layer preview immediately
                                try {
                                    if (layer?.preview) {
                                        layer.preview.alpha = 0; layer.preview.visible = false; layer.preview.renderable = false;
                                        layer.preview.removeChildren?.();
                                    }
                                } catch {}
                                // Start per-frame hider if not running
                                if (!_isoDragPreviewHider && canvas?.app?.ticker) {
                                    _isoDragPreviewHider = (dt) => {
                                        try {
                                            const off = 1e7;
                                            const list = [layer?.preview, canvas?.tiles?.preview, this?.preview, this?._preview, this?._dragPreview, this?.dragPreview];
                                            for (const target of list) {
                                                if (!target) continue;
                                                target.alpha = 0; target.visible = false; target.renderable = false;
                                                if (target.position) target.position.set(off, off);
                                                if (Array.isArray(target.children)) {
                                                    for (const ch of target.children) {
                                                        if (!ch) continue;
                                                        ch.alpha = 0; ch.visible = false; ch.renderable = false;
                                                        if (ch.position) ch.position.set(off, off);
                                                    }
                                                    target.removeChildren?.();
                                                }
                                            }
                                        } catch {}
                                    };
                                    canvas.app.ticker.add(_isoDragPreviewHider);
                                }
                                // Draw yellow overlay
                                try { drawTileSelectionOverlay(this); } catch {}
                            } catch {}
                        };
                        const runMove = () => {
                            try { if (isIso) drawTileSelectionOverlay(this); } catch {}
                        };
                        const runEnd = () => {
                            try {
                                if (!isIso) return;
                                draggingTileIds.delete(this.id);
                                const mod = MODULE_ID;
                                const saved = this._isoSavedOffsets || { x: undefined, y: undefined };
                                if (saved.x === undefined) foundry.utils.unsetProperty(this.document, `flags.${mod}.offsetX`);
                                else foundry.utils.setProperty(this.document, `flags.${mod}.offsetX`, saved.x);
                                if (saved.y === undefined) foundry.utils.unsetProperty(this.document, `flags.${mod}.offsetY`);
                                else foundry.utils.setProperty(this.document, `flags.${mod}.offsetY`, saved.y);
                                delete this._isoSavedOffsets;
                                if (_isoDragPreviewHider && canvas?.app?.ticker) {
                                    canvas.app.ticker.remove(_isoDragPreviewHider);
                                    _isoDragPreviewHider = null;
                                }
                                try { drawTileSelectionOverlay(this); } catch {}
                            } catch {}
                        };

                        // choose action based on method
                        if (name === '_onDragLeftStart') {
                            if (when === 'before') runStart();
                            const r = orig.apply(this, args);
                            if (when === 'after') runStart();
                            try { updateAlwaysVisibleElements(); } catch {}
                            return r;
                        }
                        if (name === '_onDragLeftMove') {
                            const r = orig.apply(this, args);
                            runMove();
                            try { updateAlwaysVisibleElements(); } catch {}
                            return r;
                        }
                        if (name === '_onDragLeftDrop' || name === '_onDragLeftCancel') {
                            const r = orig.apply(this, args);
                            runEnd();
                            try { updateAlwaysVisibleElements(); } catch {}
                            return r;
                        }
                        // Fallback just in case
                        return orig.apply(this, args);
                    };
                    T.prototype[name].__isoPatched = true;
                };

                // Run our start logic BEFORE the core start to intercept preview creation early
                wrap('_onDragLeftStart', 'before');
                wrap('_onDragLeftMove');
                wrap('_onDragLeftDrop');
                wrap('_onDragLeftCancel');
            } catch {}
        };
        Hooks.on('canvasReady', patchTileDragHandlers);
        if (canvas?.ready) patchTileDragHandlers();

        // Generic PlaceableObject wrappers: catch drag for all placeables and filter to tiles
        const patchPlaceableDragHandlers = () => {
            try {
                const P = globalThis.PlaceableObject;
                if (!P || !P.prototype || P.prototype.__isoPOWrapped) return;
                const wrap = (name) => {
                    const orig = P.prototype[name];
                    if (typeof orig !== 'function' || orig.__isoPatched3) return;
                    P.prototype[name] = function(...args) {
                        const result = orig.apply(this, args);
                        try {
                            if (!(this instanceof Tile)) return result;
                            const isoDisabled = !!this?.document?.getFlag(MODULE_ID, 'isoTileDisabled');
                            if (name === '_onDragLeftStart') {
                                if (!isoDisabled) draggingTileIds.add(this.id);
                                drawTileSelectionOverlay(this);
                            } else if (name === '_onDragLeftMove') {
                                if (!isoDisabled) drawTileSelectionOverlay(this);
                            } else if (name === '_onDragLeftDrop' || name === '_onDragLeftCancel') {
                                if (!isoDisabled) draggingTileIds.delete(this.id);
                                drawTileSelectionOverlay(this);
                            }
                        } catch {}
                        return result;
                    };
                    P.prototype[name].__isoPatched3 = true;
                };
                ['_onDragLeftStart','_onDragLeftMove','_onDragLeftDrop','_onDragLeftCancel'].forEach(n => wrap(n));
                P.prototype.__isoPOWrapped = true;
            } catch {}
        };
        Hooks.on('canvasReady', patchPlaceableDragHandlers);
        if (canvas?.ready) patchPlaceableDragHandlers();

        // Per-frame overlay refresher: ensures color flips to yellow during drag on V12
        try {
            if (!_isoOverlayTicker && canvas?.app?.ticker) {
                _isoOverlayTicker = () => {
                    try {
                        if (!hoverLayer) return;
                        const tiles = canvas?.tiles?.controlled || [];
                        const now = performance.now();
                        for (const tile of tiles) {
                            const st = _isoDragState.get(tile.id) || {};
                            const x = Number(tile.document?.x) || 0;
                            const y = Number(tile.document?.y) || 0;
                            const moved = (st.lastX !== undefined && (st.lastX !== x || st.lastY !== y));
                            if (moved) st.lastMoveTs = now;
                            st.lastX = x; st.lastY = y;

                            // Consider dragging if moved in the last 150ms or any other signal says so
                            const recentMove = st.lastMoveTs && (now - st.lastMoveTs < 150);
                            const otherSignals = tile?._dragging || tile?._dragDropInProgress || !!tile?.interactionState?.dragging || !!tile?.interactionData || !!tile?.mouseDown;
                            const isDragging = !!(recentMove || otherSignals || draggingTileIds.has(tile.id));

                            if (isDragging) draggingTileIds.add(tile.id); else draggingTileIds.delete(tile.id);

                            // Apply/remove temporary huge art offset to cast away core preview
                            try {
                                const isoDisabled = !!tile?.document?.getFlag(MODULE_ID, 'isoTileDisabled');
                                const isIso = !isoDisabled && game.settings.get(MODULE_ID, 'worldIsometricFlag');
                                if (isIso && isDragging && !st.active) {
                                    const mod = MODULE_ID;
                                    const fx = tile.document.getFlag(mod, 'offsetX') ?? 0;
                                    const fy = tile.document.getFlag(mod, 'offsetY') ?? 0;
                                    st.saved = { x: fx, y: fy };
                                    const cast = 1_000_000;
                                    foundry.utils.setProperty(tile.document, `flags.${mod}.offsetX`, fx + cast);
                                    foundry.utils.setProperty(tile.document, `flags.${mod}.offsetY`, fy + cast);
                                    st.active = true;
                                } else if (st.active && !isDragging) {
                                    const mod = MODULE_ID;
                                    const sv = st.saved || { x: undefined, y: undefined };
                                    if (sv.x === undefined) foundry.utils.unsetProperty(tile.document, `flags.${mod}.offsetX`); else foundry.utils.setProperty(tile.document, `flags.${mod}.offsetX`, sv.x);
                                    if (sv.y === undefined) foundry.utils.unsetProperty(tile.document, `flags.${mod}.offsetY`); else foundry.utils.setProperty(tile.document, `flags.${mod}.offsetY`, sv.y);
                                    st.active = false; st.saved = undefined; st.lastMoveTs = undefined;
                                }
                            } catch {}

                            _isoDragState.set(tile.id, st);
                            drawTileSelectionOverlay(tile);
                        }
                    } catch {}
                };
                canvas.app.ticker.add(_isoOverlayTicker);
            }
        } catch {}

    // Tile selection hooks: draw selection rectangle + handle above the tile when selected
    Hooks.on('controlTile', (tile, controlled) => {
        try {
            if (controlled) drawTileSelectionOverlay(tile);
            else clearTileSelectionOverlay(tile);
            // keep the hover layer on top
            if (hoverLayer?.parent === canvas.stage) {
                canvas.stage.removeChild(hoverLayer);
                canvas.stage.addChild(hoverLayer);
            }
        } catch {}
    });
    Hooks.on('refreshTile', (tile) => {
        try {
            if (tile?.controlled) {
                // redraw to update position if tile moved/resized
                clearTileSelectionOverlay(tile);
                drawTileSelectionOverlay(tile);
            }
        } catch {}
    });
    Hooks.on('updateTile', (tileDocument) => {
        try {
            const tile = canvas.tiles.get(tileDocument.id);
            if (tile?.controlled) {
                clearTileSelectionOverlay(tile);
                drawTileSelectionOverlay(tile);
            }
        } catch {}
    });
    Hooks.on('deleteTile', (tile) => {
        try { clearTileSelectionOverlay(tile); } catch {}
    });

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
    sprite.angle = mesh.angle;
    // Preserve original image aspect and scale for isometric tiles (use only isoScale; ignore rectangle distortion)
    try {
        const isoDisabled = !!tilePlaceable?.document?.getFlag(MODULE_ID, 'isoTileDisabled');
        if (!isoDisabled) {
            const sx = Number(mesh.scale.x) || 0;
            const docW = Number(tilePlaceable?.document?.width) || 0;
            const texW = Number(mesh?.texture?.width) || 0;
            const signX = Math.sign(sx) || 1;
            const signY = Math.sign(Number(mesh.scale.y) || 1) || 1;
            // From transform.js: mesh.scale.x = (docW / texW) * isoScale
            const isoScale = (sx !== 0 && docW > 0 && texW > 0) ? Math.abs(sx) * (texW / docW) : Math.abs(sx) || 1;
            sprite.scale.set(isoScale * signX, isoScale * ISOMETRIC_CONST.ratio * signY);
        } else {
            sprite.scale.set(mesh.scale.x, mesh.scale.y);
        }
    } catch {
        sprite.scale.set(mesh.scale.x, mesh.scale.y);
    }
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
            // Keep overlay above any other stage children (e.g., height lines/shadows added later)
            try {
                if (alwaysVisibleContainer?.parent === canvas.stage) {
                    canvas.stage.removeChild(alwaysVisibleContainer);
                    canvas.stage.addChild(alwaysVisibleContainer);
                }
            } catch (e) {
                // no-op
            }

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

    // Quick fix: for isometric-enabled tiles, when selected (drag/manipulation), hide the distorted base mesh
    // and render a clean clone instead. Restore when not selected.
    try {
        const hideSet = new Set(plan.hideOriginalTileIds || []);
        for (const tile of canvas.tiles.placeables) {
            if (!tile?.mesh) continue;
            const isoDisabled = !!tile.document?.getFlag(MODULE_ID, 'isoTileDisabled');
            if (isoDisabled) continue; // only for isometric-enabled tiles
            if (tile.controlled) {
                // Hide original base (distorted) image
                tile.mesh.alpha = 0;
                // If this tile isn't already handled by occlusion plan, add a non-occluder clone to tiles layer
                if (!hideSet.has(tile.id)) {
                    const clone = cloneTileSprite(tile, getLinkedWalls(tile), false);
                    if (clone) tilesLayer.addChild(clone);
                }
            } else {
                // Restore base alpha for non-occluding tiles not hidden by plan
                if (!hideSet.has(tile.id)) {
                    const baseAlpha = typeof tile.document?.alpha === 'number' ? tile.document.alpha : 1;
                    tile.mesh.alpha = baseAlpha;
                }
            }
        }
    } catch {}

    // Hide/show original occluding tiles: if a tile occludes (or is in plan hide list), hide its original mesh
    try {
        const hideSet = new Set(plan.hideOriginalTileIds || []);
        for (const tile of canvas.tiles.placeables) {
            if (!tile?.mesh) continue;
            const isOccluding = !!tile.document?.getFlag(MODULE_ID, 'OccludingTile');
            if (!isOccluding) continue;
            if (hideSet.has(tile.id)) {
                tile.mesh.alpha = 0; // fully hidden on base canvas
            } else {
                // restore to document alpha
                const baseAlpha = typeof tile.document?.alpha === 'number' ? tile.document.alpha : 1;
                tile.mesh.alpha = baseAlpha;
            }
        }
    } catch (e) { /* noop */ }

    // Debug overlays (coordinates), added last so they render on top
    addDebugOverlays(plan);

        updateLayerOpacity(tilesLayer, tilesOpacity);
        updateLayerOpacity(tokensLayer, tokensOpacity);
    // Ensure tiles use insertion order only (no zIndex sorting)
    tilesLayer.sortableChildren = false;
    tokensLayer.sortableChildren = true;
    // Keep hover layer as the top-most
    try {
        if (hoverLayer?.parent === canvas.stage) {
            canvas.stage.removeChild(hoverLayer);
            canvas.stage.addChild(hoverLayer);
        }
    } catch (e) {}
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
    // Hide the original occluding tile mesh; we'll render it via clones for consistent opacity control
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

    // Create base tile clones; for tiles that occlude the controlled token, skip the base clone
    // and rely on an occluder clone at the controlled token's depth to represent the full tile with OcclusionAlpha.
    let controlledDepth = null;
    let cGX = null, cGY = null;
    if (controlledToken?.mesh) {
        const g = getTokenGridXY(controlledToken);
        cGX = g.gx; cGY = g.gy; controlledDepth = cGX + cGY;
        // After occluder hide/show, force-hide distorted base when manipulating isometric tiles and draw a clean clone
        try {
            const hideSet = new Set(plan.hideOriginalTileIds || []);
            for (const tile of canvas.tiles.placeables) {
                if (!tile?.mesh) continue;
                const isoDisabled = !!tile.document?.getFlag(MODULE_ID, 'isoTileDisabled');
                if (isoDisabled) continue; // only for isometric-enabled tiles
                const isDragging = draggingTileIds.has(tile.id);
                if (tile.controlled || isDragging) {
                    // Hide base (distorted) image regardless of occlusion restore
                    tile.mesh.alpha = 0;
                    tile.mesh.visible = false;
                    tile.mesh.renderable = false;
                    // If plan already replaced/hides it, skip adding extra clone to avoid duplicates
                    if (hideSet.has(tile.id)) continue;
                    const clone = cloneTileSprite(tile, getLinkedWalls(tile), false);
                    if (clone) tilesLayer.addChild(clone);
                } else {
                    // Restore visibility/rendering for non-controlled tiles unless hidden by plan
                    if (!hideSet.has(tile.id)) {
                        tile.mesh.visible = true;
                        tile.mesh.renderable = true;
                        const baseAlpha = typeof tile.document?.alpha === 'number' ? tile.document.alpha : 1;
                        tile.mesh.alpha = baseAlpha;
                    }
                }
            }
        } catch {}
    }
    for (const te of tileEntries) {
        const occludesControlled = controlledToken ? (cGX >= te.gx && cGY <= te.gy) : false;
        if (!occludesControlled) {
            const clonedSprite = cloneTileSprite(te.tile, te.walls, false);
            if (clonedSprite) plan.tiles.push({ sprite: clonedSprite });
        } else {
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

// Color helpers
function colorStringToNumber(str, fallback = 0x9b59b6) { // purple fallback
    try {
        if (typeof str === 'string' && str.startsWith('#') && (str.length === 7 || str.length === 4)) {
            // Expand #rgb to #rrggbb
            if (str.length === 4) {
                const r = str[1], g = str[2], b = str[3];
                str = `#${r}${r}${g}${g}${b}${b}`;
            }
            return Number.parseInt(str.slice(1), 16);
        }
    } catch {}
    return fallback;
}

function getTokenOwnerColorNumber(token, fallback = 0x9b59b6) {
    try {
        const owners = game.users?.players?.filter(u => token?.actor?.testUserPermission?.(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) || [];
        const chosen = owners.find(u => u.active) || owners[0];
        if (chosen?.color) return colorStringToNumber(chosen.color, fallback);
    } catch {}
    // Fallback to current user color if available
    if (game.user?.color) return colorStringToNumber(game.user.color, fallback);
    return fallback;
}

// ---------------- Hover outline (ignores occlusion) ----------------
function drawHoverOutline(token) {
    try {
        if (!hoverLayer || !token) return;
        const name = `HoverOutline-${token.id}`;
        // Remove existing outline for this token
        const existing = hoverLayer.getChildByName(name);
        if (existing) hoverLayer.removeChild(existing);

        const grid = canvas.grid?.size || 100;
        const wUnits = Math.max(1, Number(token.document?.width) || 1);
        const hUnits = Math.max(1, Number(token.document?.height) || 1);
        const radius = (grid * (wUnits + hUnits) / 2) * 0.45; // slightly inside the footprint

        const g = new PIXI.Graphics();
        g.name = name;
        g.eventMode = 'passive';
        g.zIndex = 10_000_000; // top inside hover layer
    // Soft glow border using token owner's color (fallback to purple)
    const col = getTokenOwnerColorNumber(token);
        g.lineStyle(4, 0x000000, 0.4);
        g.drawCircle(0, 0, radius);
        g.lineStyle(2, col, 1.0);
        g.drawCircle(0, 0, radius);
        g.position.set(token.center.x, token.center.y);

        hoverLayer.addChild(g);
        // Ensure on top
        canvas.stage.removeChild(hoverLayer);
        canvas.stage.addChild(hoverLayer);
    } catch (e) {
        console.error('Hover outline error:', e);
    }
}

function clearHoverOutline(token) {
    if (!hoverLayer || !token) return;
    const name = `HoverOutline-${token.id}`;
    const existing = hoverLayer.getChildByName(name);
    if (existing) hoverLayer.removeChild(existing);
}

function updateHoverOutlinePosition(token) {
    if (!hoverLayer || !token) return;
    const name = `HoverOutline-${token.id}`;
    const existing = hoverLayer.getChildByName(name);
    if (existing) existing.position.set(token.center.x, token.center.y);
}

// --------------- Tile grid triangle overlay (on selection) ---------------
function drawTileSelectionOverlay(tile) {
    try {
        if (!hoverLayer || !tile) return;
        const name = `TileSelection-${tile.id}`;
        const existing = hoverLayer.getChildByName(name);
        if (existing) hoverLayer.removeChild(existing);

        const g = new PIXI.Graphics();
        g.name = name;
        g.eventMode = 'passive';
        g.zIndex = 9_999_999; // just under hover outlines

    // During drag, the document is updated incrementally; read current values
    const x = Number(tile.document.x) || tile.x || 0;
    const y = Number(tile.document.y) || tile.y || 0;
        const w = tile.document.width;
        const h = tile.document.height;

    // Rectangle lines: yellow while dragging, orange otherwise
    const dragging = draggingTileIds?.has?.(tile.id);
    const stroke = dragging ? 0xffff00 : 0xffa500;
    g.lineStyle(2, stroke, 0.95);
        g.drawRect(x, y, w, h);

        // Small manipulation circle in the bottom-right corner
        const r = 6;
        const cx = x + w;
        const cy = y + h;
    g.beginFill(stroke, 0.95);
        g.drawCircle(cx, cy, r);
        g.endFill();

        hoverLayer.addChild(g);
        if (hoverLayer?.parent === canvas.stage) {
            canvas.stage.removeChild(hoverLayer);
            canvas.stage.addChild(hoverLayer);
        }
    } catch (e) {
        console.error('Tile selection overlay draw error:', e);
    }
}

function clearTileSelectionOverlay(tile) {
    if (!hoverLayer || !tile) return;
    const name = `TileSelection-${tile.id}`;
    const existing = hoverLayer.getChildByName(name);
    if (existing) hoverLayer.removeChild(existing);
}