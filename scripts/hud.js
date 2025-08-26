import { MODULE_ID, DEBUG_PRINT, WORLD_ISO_FLAG } from './main.js';
import { ISOMETRIC_CONST, PROJECTION_TYPES, DEFAULT_PROJECTION } from './consts.js';

export function registerHUDConfig() {
  Hooks.on("renderTokenHUD", handleRenderTokenHUD);
  Hooks.on("renderTileHUD", handleRenderTileHUD);
}

function handleRenderTokenHUD(hud, html, data) {
  const scene = game.scenes.current;
  const isSceneIsometric = scene.getFlag(MODULE_ID, "isometricEnabled");
  const isometricWorldEnabled = game.settings.get(MODULE_ID, "worldIsometricFlag");

  if (isometricWorldEnabled && isSceneIsometric) {
    requestAnimationFrame(() => adjustHUDPosition(hud, html));
  }
}

function handleRenderTileHUD(hud, html, data) {
  const scene = game.scenes.current;
  const isSceneIsometric = scene.getFlag(MODULE_ID, "isometricEnabled");
  const isometricWorldEnabled = game.settings.get(MODULE_ID, "worldIsometricFlag");

  if (isometricWorldEnabled && isSceneIsometric) {
    requestAnimationFrame(() => adjustHUDPosition(hud, html));
  }
}

// Function to calculate the isometric position (HUD projection)
export function calculateIsometricPosition(x, y) {

  // Get rotation values
  const rotation = ISOMETRIC_CONST.HudAngle; //ISOMETRIC_CONST.rotation;  // in rad

  // Apply rotation to the distorted coordinates
  const isoX = (x + y) * Math.cos(rotation);
  const isoY = (-1) * (x - y) * Math.sin(rotation);

  return { x: isoX, y: isoY };
}

export function adjustHUDPosition(hud, html) {
  let object = hud.object;
  let { x, y } = object.position;

  if (object instanceof Token) {
    const topCenter = calculateIsometricPosition(x, y);

    html.css({
      left: `${topCenter.x}px`,
      top: `${topCenter.y}px`,
      transform: 'translate(33%, -50%)'
    });
  }

  else if (object instanceof Tile) {
    const topCenter = calculateIsometricPosition(x, y);

    // Adjusts the HUD's position
    html.css({
      left: `${topCenter.x}px`,
      top: `${topCenter.y}px`,
    });
  }
}
