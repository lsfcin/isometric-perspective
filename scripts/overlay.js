// Use MODULE_ID string literal to avoid circular import with main.js for wall highlighting
const MODULE_ID = 'isometric-perspective';
let hoverLayer = null;

function bringOverlayToTop() {
  try {
    if (hoverLayer?.parent === canvas.stage) {
      canvas.stage.removeChild(hoverLayer);
      canvas.stage.addChild(hoverLayer);
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
    } catch {}
  });

  // Keep overlay above other layers during common refreshes
  Hooks.on('canvasReady', bringOverlayToTop);
  Hooks.on('canvasPan', bringOverlayToTop);
  Hooks.on('canvasTokensRefresh', bringOverlayToTop);
  Hooks.on('sightRefresh', bringOverlayToTop);
  Hooks.on('updateScene', bringOverlayToTop);
  Hooks.on('preUpdateScene', bringOverlayToTop);

  // Token hover circle overlay
  Hooks.on('hoverToken', (token, hovered) => {
    try {
      if (hovered) drawHoverOutline(token);
      else clearHoverOutline(token);
    } catch {}
    bringOverlayToTop();
  });
  Hooks.on('refreshToken', (token) => {
    try { if (token) updateHoverOutlinePosition(token); } catch {}
    bringOverlayToTop();
  });
  Hooks.on('updateToken', (tokenDocument) => {
    try {
      const tok = canvas.tokens.get(tokenDocument.id);
      if (tok) updateHoverOutlinePosition(tok);
      bringOverlayToTop();
    } catch {}
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

function drawHoverOutline(token) {
  try {
    if (!hoverLayer || !token) return;
    const name = `HoverOutline-${token.id}`;
    const existing = hoverLayer.getChildByName(name);
    if (existing) hoverLayer.removeChild(existing);

    const grid = canvas.grid?.size || 100;
    const wUnits = Math.max(1, Number(token.document?.width) || 1);
    const hUnits = Math.max(1, Number(token.document?.height) || 1);
    const radius = (grid * (wUnits + hUnits) / 2) * 0.45;

    const g = new PIXI.Graphics();
    g.name = name;
    g.eventMode = 'passive';
    g.zIndex = 10_000_000;
    const col = getTokenOwnerColorNumber(token);
    g.lineStyle(4, 0x000000, 0.4);
    g.drawCircle(0, 0, radius);
    g.lineStyle(2, col, 1.0);
    g.drawCircle(0, 0, radius);
    g.position.set(token.center.x, token.center.y);

    hoverLayer.addChild(g);
  bringOverlayToTop();
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
  const COLOR_NORMAL = 0xcccccc;

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
