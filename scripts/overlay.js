// Use MODULE_ID string literal to avoid circular import with main.js for wall highlighting
const MODULE_ID = 'isometric-perspective';
let hoverLayer = null;
let debugLayer = null; // separate layer for debug coordinate text
let _escKeyHandler = null;
// Alt-key global highlights removed

// (Alt-key global token highlight feature removed)

function bringOverlayToTop() {
  try {
    // Maintain relative order: background stuff < debugLayer < hoverLayer (hover always on top)
    if (debugLayer?.parent === canvas.stage) {
      canvas.stage.removeChild(debugLayer);
      canvas.stage.addChild(debugLayer);
    }
    if (hoverLayer?.parent === canvas.stage) {
      canvas.stage.removeChild(hoverLayer);
      canvas.stage.addChild(hoverLayer); // hover above debug
    }
  } catch {}
}

export function registerOverlayHooks() {
  // Create/teardown hover layer with canvas lifecycle
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
  // Debug layer just below hover overlays so selection rectangles remain on top
  if (debugLayer) { try { canvas.stage.removeChild(debugLayer); debugLayer.destroy({ children: true }); } catch {} }
  debugLayer = new PIXI.Container();
  debugLayer.name = 'IsoDebugOverlay';
  debugLayer.eventMode = 'passive';
  canvas.stage.addChild(debugLayer);
  // Keep overlay as the top-most layer
  bringOverlayToTop();
    } catch {}
  });
  Hooks.on('changeScene', () => {
    try {
      if (hoverLayer) {
        canvas.stage.removeChild(hoverLayer);
        hoverLayer.destroy({ children: true });
        hoverLayer = null;
      }
      if (debugLayer) {
        canvas.stage.removeChild(debugLayer);
        debugLayer.destroy({ children: true });
        debugLayer = null;
      }
  if (_escKeyHandler) { try { window.removeEventListener('keydown', _escKeyHandler, true); } catch {} _escKeyHandler = null; }
    } catch {}
  });

  // Keep overlay above other layers during common refreshes
  Hooks.on('canvasReady', bringOverlayToTop);
  Hooks.on('canvasPan', bringOverlayToTop);
  Hooks.on('canvasTokensRefresh', bringOverlayToTop);
  Hooks.on('sightRefresh', bringOverlayToTop);
  Hooks.on('updateScene', bringOverlayToTop);
  Hooks.on('preUpdateScene', bringOverlayToTop);

  // Removed ESC auto-clear: highlight persists until actual unhover event.

  // Re-raise debug layer too
  Hooks.on('isometricOverlayBringToTop', () => {
    try { if (debugLayer && debugLayer.parent === canvas.stage) { canvas.stage.removeChild(debugLayer); canvas.stage.addChild(debugLayer); } } catch {}
  });

  // Token hover grid highlight (replaces previous purple circle)
  Hooks.on('hoverToken', (token, hovered) => {
    try {
      if (hovered) drawTokenGridHighlight(token); else clearTokenGridHighlight(token);
      bringOverlayToTop();
    } catch {}
  });

  // ESC fallback: simulate unhover (clear any token hover highlights) when user presses Escape.
  if (!_escKeyHandler) {
    _escKeyHandler = (ev) => {
      if (ev.key === 'Escape') {
        try { clearAllTokenGridHighlights(); } catch {}
      }
    };
    try { window.addEventListener('keydown', _escKeyHandler, true); } catch {}
  }

  // (Alt-key listeners & window blur cleanup removed)
  Hooks.on('refreshToken', (token) => { try { if (token?.hover) updateTokenGridHighlight(token); } catch {} bringOverlayToTop(); });
  Hooks.on('updateToken', (tokenDocument) => {
    try { const token = canvas.tokens.get(tokenDocument.id); if (token?.hover) updateTokenGridHighlight(token); } catch {}
    bringOverlayToTop();
  });

  // Token selection changes: update hover highlight color
  Hooks.on('controlToken', (token, controlled) => {
    try {
      if (token?.hover) updateTokenGridHighlight(token);
    } catch {}
    bringOverlayToTop();
  });

  // Allow other modules of this package to request re-raising the overlay
  Hooks.on('isometricOverlayBringToTop', () => {
    bringOverlayToTop();
  });

  // Tile hover rectangle overlay (only while hovered and not controlled)
  Hooks.on('hoverTile', (tile, hovered) => {
    try {
      if (!tile) return;
      if (hovered && !tile.controlled) drawTileHoverOverlay(tile);
      else clearTileHoverOverlay(tile);
      bringOverlayToTop();
    } catch {}
  });

  // Tile selection rectangle overlay
  Hooks.on('controlTile', (tile, controlled) => {
    try {
      // When controlled, prefer selection overlay and clear hover overlay
      if (controlled) {
        clearTileHoverOverlay(tile);
        drawTileSelectionOverlay(tile);
      } else {
        clearTileSelectionOverlay(tile);
      }
      // keep the hover layer on top
  bringOverlayToTop();
    } catch {}
  });
  Hooks.on('refreshTile', (tile) => {
    try {
      if (tile?.controlled) {
        clearTileSelectionOverlay(tile);
        drawTileSelectionOverlay(tile);
        bringOverlayToTop();
      } else if (tile?.hover && !tile?.controlled) {
        // keep hover overlay in sync when tile geometry changes
        clearTileHoverOverlay(tile);
        drawTileHoverOverlay(tile);
        bringOverlayToTop();
      }
    } catch {}
  });
  Hooks.on('updateTile', (tileDocument) => {
    try {
      const tile = canvas.tiles.get(tileDocument.id);
      if (tile?.controlled) {
        clearTileSelectionOverlay(tile);
        drawTileSelectionOverlay(tile);
        bringOverlayToTop();
      } else if (tile?.hover && !tile?.controlled) {
        clearTileHoverOverlay(tile);
        drawTileHoverOverlay(tile);
        bringOverlayToTop();
      }
    } catch {}
  });
  Hooks.on('deleteTile', (tile) => {
    try { clearTileSelectionOverlay(tile); clearTileHoverOverlay(tile); } catch {}
    bringOverlayToTop();
  });
}

function colorStringToNumber(str, fallback = 0x9b59b6) {
  try {
    if (typeof str === 'string' && str.startsWith('#') && (str.length === 7 || str.length === 4)) {
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
  if (game.user?.color) return colorStringToNumber(game.user.color, fallback);
  return fallback;
}

// drawHoverOutline / clearHoverOutline / updateHoverOutlinePosition removed
// ---- Token Grid Highlight ----
function drawTokenGridHighlight(token) {
  if (!hoverLayer || !token) return;
  const name = `TokenGridHover-${token.id}`;
  const existing = hoverLayer.getChildByName(name);
  if (existing) hoverLayer.removeChild(existing);
  const g = new PIXI.Graphics();
  g.name = name;
  g.eventMode = 'passive';
  g.zIndex = 9_999_997;
  try {
    const grid = canvas.grid?.size || canvas.dimensions.size || 100;
    // token.document.width/height in grid units; fallback to 1
    const wUnits = Math.max(1, Number(token.document?.width) || 1);
    const hUnits = Math.max(1, Number(token.document?.height) || 1);
    const pxW = wUnits * grid;
    const pxH = hUnits * grid;
    const x = Number(token.document?.x ?? token.x ?? token.position?.x) || 0;
    const y = Number(token.document?.y ?? token.y ?? token.position?.y) || 0;
  const outline = token.controlled ? 0xffa500 : 0x33bbff; // orange if selected, blue otherwise
  // Outer dark stroke for contrast then colored stroke (no fill)
  g.lineStyle(4, 0x000000, 0.35);
  g.drawRect(x, y, pxW, pxH);
  g.lineStyle(2, outline, 0.95);
  g.drawRect(x, y, pxW, pxH);
  } catch (e) { console.warn('drawTokenGridHighlight failed', e); }
  hoverLayer.addChild(g);
}

function clearTokenGridHighlight(token) {
  if (!hoverLayer || !token) return;
  const name = `TokenGridHover-${token.id}`;
  const existing = hoverLayer.getChildByName(name);
  if (existing) hoverLayer.removeChild(existing);
}

function updateTokenGridHighlight(token) {
  drawTokenGridHighlight(token);
}

function clearAllTokenGridHighlights() {
  try {
    if (!hoverLayer) return;
    // Remove all children whose name starts with TokenGridHover-
    const toRemove = hoverLayer.children.filter(c => typeof c?.name === 'string' && c.name.startsWith('TokenGridHover-'));
    for (const c of toRemove) hoverLayer.removeChild(c);
  } catch {}
}

function drawTileSelectionOverlay(tile) {
  try {
    if (!hoverLayer || !tile) return;
    const name = `TileSelection-${tile.id}`;
    const existing = hoverLayer.getChildByName(name);
    if (existing) hoverLayer.removeChild(existing);

    const g = new PIXI.Graphics();
    g.name = name;
    g.eventMode = 'passive';
    g.zIndex = 9_999_999;

    const x = Number(tile.document.x) || tile.x || 0;
    const y = Number(tile.document.y) || tile.y || 0;
    const w = tile.document.width;
    const h = tile.document.height;

  const stroke = 0xffa500;
    g.lineStyle(2, stroke, 0.95);
    g.drawRect(x, y, w, h);

    const r = 6; const cx = x + w; const cy = y + h;
    g.beginFill(stroke, 0.95);
    g.drawCircle(cx, cy, r);
    g.endFill();

    hoverLayer.addChild(g);
  bringOverlayToTop();
  // Also (re)draw linked walls so they persist through selection redraws
  drawLinkedWallsOverlay(tile);
  } catch (e) {
    console.error('Tile selection overlay draw error:', e);
  }
}

function clearTileSelectionOverlay(tile) {
  if (!hoverLayer || !tile) return;
  const name = `TileSelection-${tile.id}`;
  const existing = hoverLayer.getChildByName(name);
  if (existing) hoverLayer.removeChild(existing);
  const wg = hoverLayer.getChildByName(`TileWalls-${tile.id}`);
  if (wg) hoverLayer.removeChild(wg);
}

// Hover overlay: orange rectangle while pointer is over the tile
function drawTileHoverOverlay(tile) {
  try {
    if (!hoverLayer || !tile) return;
    const name = `TileHover-${tile.id}`;
    const existing = hoverLayer.getChildByName(name);
    if (existing) hoverLayer.removeChild(existing);

    const g = new PIXI.Graphics();
    g.name = name;
    g.eventMode = 'passive';
    g.zIndex = 9_999_998;

    const x = Number(tile.document.x) || tile.x || 0;
    const y = Number(tile.document.y) || tile.y || 0;
    const w = tile.document.width;
    const h = tile.document.height;

    const stroke = 0xffa500;
    g.lineStyle(2, stroke, 0.9);
    g.drawRect(x, y, w, h);

    hoverLayer.addChild(g);
    bringOverlayToTop();
  } catch (e) {
    console.error('Tile hover overlay draw error:', e);
  }
}

function clearTileHoverOverlay(tile) {
  if (!hoverLayer || !tile) return;
  const name = `TileHover-${tile.id}`;
  const existing = hoverLayer.getChildByName(name);
  if (existing) hoverLayer.removeChild(existing);
}

// ------------ Linked Walls Overlay (visual only) ------------
function drawLinkedWallsOverlay(tile) {
  try {
    if (!hoverLayer || !tile?.document) return;
    const idsRaw = tile.document.getFlag(MODULE_ID, 'linkedWallIds');
    if (!idsRaw) return;
    const ids = Array.isArray(idsRaw) ? idsRaw : String(idsRaw).split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return;
    // Remove old overlay
    const old = hoverLayer.getChildByName(`TileWalls-${tile.id}`);
    if (old) hoverLayer.removeChild(old);
    const group = new PIXI.Container();
    group.name = `TileWalls-${tile.id}`;
    group.eventMode = 'passive';
  // Foundry default style approximations: normal(white), door(purple), secret(orange), invisible(cyan)
  const COLOR_NORMAL = 0xffc864;

    for (const wid of ids) {
      const wall = canvas.walls.get(wid);
      if (!wall) continue;
      // Version-agnostic endpoint extraction
      let ax, ay, bx, by;
      if (wall.A && wall.B) { // v11 style
        ax = wall.A.x; ay = wall.A.y; bx = wall.B.x; by = wall.B.y;
      } else if (wall.edge?.a && wall.edge?.b) { // v10 style
        ax = wall.edge.a.x; ay = wall.edge.a.y; bx = wall.edge.b.x; by = wall.edge.b.y;
      } else continue;
  const g = new PIXI.Graphics();
      g.eventMode = 'passive';
 
  let color = COLOR_NORMAL;

  
  g.lineStyle(5, 0x000000, 0.35);
  g.moveTo(ax, ay); g.lineTo(bx, by);
  g.lineStyle(3, color, 0.95);
  g.moveTo(ax, ay); g.lineTo(bx, by);
  g.beginFill(color, 0.95); g.drawCircle(ax, ay, 4); g.drawCircle(bx, by, 4); g.endFill();
      group.addChild(g);
    }
    if (group.children.length) {
      hoverLayer.addChild(group);
      bringOverlayToTop();
    }
  } catch (e) { console.warn('drawLinkedWallsOverlay failed', e); }
}

function clearLinkedWallsOverlay(tile) {
  if (!hoverLayer || !tile) return;
  const ex = hoverLayer.getChildByName(`TileWalls-${tile.id}`);
  if (ex) hoverLayer.removeChild(ex);
}

// ---- Debug coordinate overlay (moved from dynamictile.js) ----
export function addDebugOverlays(plan) {
  try {
    if (!debugLayer) {
      // Late creation fallback if canvasInit order differed
      debugLayer = new PIXI.Container();
      debugLayer.name = 'IsoDebugOverlay';
      debugLayer.eventMode = 'passive';
      canvas.stage.addChild(debugLayer);
    }
    debugLayer.visible = true;
    debugLayer.removeChildren();
    const tileStyle = new PIXI.TextStyle({ fontSize: 12, fill: '#00ffff', stroke: '#000000', strokeThickness: 3 });
    const tokenStyle = new PIXI.TextStyle({ fontSize: 12, fill: '#ffff00', stroke: '#000000', strokeThickness: 3 });
    for (const t of (plan?.debugTiles || [])) {
      const txt = new PIXI.Text(`(${t.gx},${t.gy}) z:${t.sort}`, tileStyle);
      txt.anchor.set(0.5, 1);
      txt.position.set(t.px, t.py - 4);
      txt.zIndex = (t.gx ?? 0) + (t.gy ?? 0);
      txt.eventMode = 'passive';
      debugLayer.addChild(txt);
    }
    for (const k of (plan?.debugTokens || [])) {
      const txt = new PIXI.Text(`(${k.gx},${k.gy}) z:${k.sort}`, tokenStyle);
      txt.anchor.set(0.5, 1);
      txt.position.set(k.px, k.py - 16);
      txt.zIndex = (k.gx ?? 0) + (k.gy ?? 0);
      txt.eventMode = 'passive';
      debugLayer.addChild(txt);
    }
    bringOverlayToTop();
  } catch (e) { console.warn('addDebugOverlays failed', e); }
}

// Redraw when walls change
Hooks.on('updateWall', (wallDoc) => {
  try {
    const selected = canvas.tiles?.controlled || [];
    for (const t of selected) {
      const ids = t.document.getFlag(MODULE_ID, 'linkedWallIds') || [];
      if (ids.includes(wallDoc.id)) drawLinkedWallsOverlay(t);
    }
  } catch {}
});
Hooks.on('deleteWall', (wallDoc) => {
  try {
    const selected = canvas.tiles?.controlled || [];
    for (const t of selected) {
      const ids = t.document.getFlag(MODULE_ID, 'linkedWallIds') || [];
      if (ids.includes(wallDoc.id)) drawLinkedWallsOverlay(t);
    }
  } catch {}
});

// Extend existing tile control behavior (hook also in register but safe to duplicate listener)
Hooks.on('controlTile', (tile, controlled) => {
  try { if (controlled) drawLinkedWallsOverlay(tile); else clearLinkedWallsOverlay(tile); }
  catch {}
});
