import { registerSceneConfig } from './scene.js';
import { registerTokenConfig } from './token.js';
import { registerTileConfig } from './tile.js';
import { registerHUDConfig } from './hud.js';
import { registerSortingConfig } from './autosorting.js';
import { registerDynamicTileConfig, increaseTilesOpacity, decreaseTilesOpacity } from './dynamictile.js';
import { applyIsometricPerspective, applyBackgroundTransformation } from './transform.js';
import { ISOMETRIC_CONST } from './consts.js';
import { isoToCartesian, cartesianToIso } from './utils.js';
import { registerOverlayHooks } from './overlay.js';

import { registerOcclusionConfig } from './occlusion.js';
import { registerTilePresetStorage } from './presets.js';

// ---------- CONSTANTS ----------
const MODULE_ID = "isometric-perspective";
let DEBUG_PRINT = true;
let WORLD_ISO_FLAG;
let FOUNDRY_VERSION;

export { MODULE_ID };
export { DEBUG_PRINT };
export { WORLD_ISO_FLAG };
export { FOUNDRY_VERSION };


// Hook to register module configuration in Foundry VTT
Hooks.once("init", function() {
  
  // ------------- Registra as configurações do módulo ------------- 
  // Checkbox configuration to enable or disable isometric mode globally
  game.settings.register(MODULE_ID, "worldIsometricFlag", {
  name: game.i18n.localize('isometric-perspective.settings_main_name'),
  hint: game.i18n.localize('isometric-perspective.settings_main_hint'),
  scope: "world",
  config: true,
  type: Boolean,
    default: true, 
  requiresReload: true
  });

  game.settings.register(MODULE_ID, 'enableHeightAdjustment', {
  name: game.i18n.localize('isometric-perspective.settings_height_name'),
  hint: game.i18n.localize('isometric-perspective.settings_height_hint'),
    scope: 'client',
    config: true,
    default: false,
    type: Boolean,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, 'enableTokenVisuals', {
  name: game.i18n.localize('isometric-perspective.settings_visuals_name'),
  hint: game.i18n.localize('isometric-perspective.settings_visuals_hint'),
    scope: 'client',
    config: true,
    default: false,
    type: Boolean,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, 'enableOcclusionDynamicTile', {
  name: game.i18n.localize('isometric-perspective.settings_dynamic_tile_name'),
  hint: game.i18n.localize('isometric-perspective.settings_dynamic_tile_hint'),
    scope: 'world',
    config: true,
    default: false,
    type: Boolean,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, 'enableCornerVisibilityCulling', {
  name: 'Isometric: Visibility Culling',
  hint: 'Hide tiles and non-viewer tokens if none of their grid corners are within LOS/vision of any of the user\'s visible tokens.',
    scope: 'client',
    config: true,
    default: false,
    type: Boolean,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, 'enableAutoSorting', {
  name: game.i18n.localize('isometric-perspective.settings_token_sort_name'),
  hint: game.i18n.localize('isometric-perspective.settings_token_sort_hint'),
    scope: 'world',
    config: true,
    default: false,
    type: Boolean,
    requiresReload: true
  });
  
  game.settings.register(MODULE_ID, 'enableOcclusionTokenSilhouette', {
  name: game.i18n.localize('isometric-perspective.settings_token_silhouette_name'),
  hint: game.i18n.localize('isometric-perspective.settings_token_silhouette_hint'),
    scope: 'client',
    config: true,
    type: String,
    choices: {
      "off": "Off",
      "gpu": "GPU Mode",
      "cpu1": "CPU Mode (Chunk Size 1)",
      "cpu2": "CPU Mode (Chunk Size 2)",
      "cpu3": "CPU Mode (Chunk Size 3)", 
      "cpu4": "CPU Mode (Chunk Size 4)",
      "cpu6": "CPU Mode (Chunk Size 6)",
      "cpu8": "CPU Mode (Chunk Size 8)",
      "cpu10": "CPU Mode (Chunk Size 10)"
    },
    default: "off",
    requiresReload: true
  });

  game.settings.register(MODULE_ID, "showWelcome", {
  name: game.i18n.localize('isometric-perspective.settings_welcome_name'),
  hint: game.i18n.localize('isometric-perspective.settings_welcome_hint'),
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, 'debug', {
  name: game.i18n.localize('isometric-perspective.settings_debug_name'),
  hint: game.i18n.localize('isometric-perspective.settings_debug_hint'),
    scope: 'client',
    config: true,
    default: false,
    type: Boolean,
    requiresReload: true
  });

  // Module keybindings
  game.keybindings.register(MODULE_ID, 'increaseTilesOpacity', {
  name: game.i18n.localize('isometric-perspective.keybindings_increase_tile_opacity'),
  hint: game.i18n.localize('isometric-perspective.keybindings_increase_tile_opacity_hint'),
    editable: [
        { key: 'NumpadAdd', modifiers: ['Control'] }
    ],
    onDown: () => {
        increaseTilesOpacity();
    },
    restricted: false,
    reservedModifiers: [],
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });

  game.keybindings.register(MODULE_ID, 'decreaseTilesOpacity', {
  name: game.i18n.localize('isometric-perspective.keybindings_decrease_tile_opacity'),
  hint: game.i18n.localize('isometric-perspective.keybindings_decrease_tile_opacity_hint'),
    editable: [
        { key: 'NumpadSubtract', modifiers: ['Control'] }
    ],
    onDown: () => {
        decreaseTilesOpacity();
    },
    restricted: false,
    reservedModifiers: [],
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });

  // Core module hooks
  registerSceneConfig();
  registerTokenConfig();
  registerTileConfig();
  registerHUDConfig();
  registerOverlayHooks();
  
  // Additional module features
  registerDynamicTileConfig();
  registerSortingConfig();
  registerOcclusionConfig();
  registerTilePresetStorage(); // Step 1: hidden storage for tile presets

  // Define global debug flags
  if (game.settings.get(MODULE_ID, "debug"))
    DEBUG_PRINT = true;
  else DEBUG_PRINT = false;

  if (game.settings.get(MODULE_ID, "worldIsometricFlag"))
    WORLD_ISO_FLAG = true;
  else WORLD_ISO_FLAG = false;

  FOUNDRY_VERSION = parseInt(game.version.split(".")[0]);
});

// Welcome screen setup
export class WelcomeScreen extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      template: "modules/isometric-perspective/templates/welcome.html",
      width: 600,
      height: 620,
      classes: ["welcome-screen"],
      resizable: false,
      title: "Isometric Perspective Module"
    });
  }
}

// Show the welcome screen if enabled
Hooks.once('ready', async function() {
  if (game.settings.get(MODULE_ID, "showWelcome")) {
    const welcome = new WelcomeScreen();
    welcome.render(true);
  }
});

// End of main module bootstrap