import { MODULE_ID, DEBUG_PRINT, WORLD_ISO_FLAG } from './main.js';

export function registerSortingConfig() {
  const isometricWorldEnabled = game.settings.get(MODULE_ID, "worldIsometricFlag");
  const enableAutoSorting = game.settings.get(MODULE_ID, "enableAutoSorting");
  if (!isometricWorldEnabled || !enableAutoSorting) return;
  if (game.version.startsWith("11")) return; //There isn't a sort method on v11. Needs another way to sort.

  Hooks.on('createToken', async (tokenDocument, options, userId) => {
    // If the movement is from the current user
    if (userId === game.userId) {
      const token = canvas.tokens.get(tokenDocument.id);
      if (token) updateTokenSort(token);
    }
  });

  Hooks.on('updateToken', async (tokenDocument, change, options, userId) => {
    // Check if there has been a change in position
    if ((change.x !== undefined || change.y !== undefined) && userId === game.userId) {
      const token = canvas.tokens.get(tokenDocument.id);
      if (token) await updateTokenSort(token);
    }
  });

  Hooks.on("canvasReady", (canvas) => {
    const scene = game.scenes.active;
    if (!scene) return;

    const tokens = scene.tokens;
    const updates = tokens.map(tokenDocument => {
      const token = canvas.tokens.get(tokenDocument.id);
      if (!token) return null;

      const newSort = calculateTokenSortValue(token);
    
      return {
        _id: tokenDocument.id,
        sort: newSort
      };
    }).filter(update => update !== null);

    if (updates.length > 0) {
      scene.updateEmbeddedDocuments('Token', updates);
    }
  });

}

function calculateTokenSortValue(token) {
  const dimensions = canvas.scene.dimensions;

  const { width, height } = dimensions;

  // invert the x because the co-ordinate system doesn't match our intuition for "closer to the screen"
  const tokenX = width - token.x;
  const tokenY = token.y;

  const sortValue = Math.round(((tokenX + tokenY) / (width + height)) * 10000);

  return sortValue;
}

async function updateTokenSort(token) {
  const scene = game.scenes.active;
  if (!scene) return;

  // Wait for the movement animation to complete
  const anim = CanvasAnimation.getAnimation(token.animationName);
  if(anim?.promise) await anim.promise;
  
  // Calculates the new sort value for the token
  const newSort = calculateTokenSortValue(token);
  
  // Creates a refresh object for the token
  const update = {
    _id: token.document.id,
    sort: newSort
  };
  
  // Updates token in scene
  await scene.updateEmbeddedDocuments('Token', [update]);
}