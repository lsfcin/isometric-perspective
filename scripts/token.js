import { MODULE_ID, DEBUG_PRINT, WORLD_ISO_FLAG } from './main.js';
import { applyIsometricTransformation, updateTokenVisuals } from './transform.js';
import { cartesianToIso, isoToCartesian } from './utils.js';
import { ISOMETRIC_CONST } from './consts.js';

export function registerTokenConfig() {
  Hooks.on("renderTokenConfig", handleRenderTokenConfig);

  Hooks.on("createToken", handleCreateToken);
  Hooks.on("updateToken", handleUpdateToken);
  Hooks.on("refreshToken", handleRefreshToken);
  Hooks.on("deleteToken", handleDeleteToken);
}

async function handleRenderTokenConfig(app, html, data) {
  
  // Load the HTML template
  const tabHtml = await renderTemplate("modules/isometric-perspective/templates/token-config.html", {
    isoDisabled: app.object.getFlag(MODULE_ID, 'isoTokenDisabled') ?? 1,
    offsetX: app.object.getFlag(MODULE_ID, 'offsetX') ?? 0,
    offsetY: app.object.getFlag(MODULE_ID, 'offsetY') ?? 0,
    isoAnchorY: app.object.getFlag(MODULE_ID, 'isoAnchorY') ?? 0,
    isoAnchorX: app.object.getFlag(MODULE_ID, 'isoAnchorX') ?? 0,
    isoAnchorToggleCheckbox: app.object.getFlag(MODULE_ID, 'isoAnchorToggle') ?? 0,
    scale: app.object.getFlag(MODULE_ID, 'scale') ?? 1
  });
  
  // Add a new tab to the menu
  const tabs = html.find('.tabs:not(.secondary-tabs)');
  tabs.append(`<a class="item" data-tab="isometric"><i class="fas fa-cube"></i> ${game.i18n.localize('isometric-perspective.tab_isometric_name')}</a>`);
  
  // Adds the tab contents after the last existing tab
  const lastTab = html.find('.tab').last();
  lastTab.after(tabHtml);

  // Update the offset fine adjustment button
  updateAdjustOffsetButton(html);
  updateAdjustAnchorButton(html);

  // Initializes control values
  const isoTokenCheckbox = html.find('input[name="flags.isometric-perspective.isoTokenDisabled"]');
  isoTokenCheckbox.prop("checked", app.object.getFlag(MODULE_ID, "isoTokenDisabled"));
  const isoScaleDisabled = html.find('input[name="flags.isometric-perspective.isoScaleDisabled"]');
  isoScaleDisabled.prop("checked", app.object.getFlag(MODULE_ID, "isoScaleDisabled"));

  // Add listener to update the shown value from Slider
  html.find('.scale-slider').on('input', function() {
    html.find('.range-value').text(this.value);
  });

  // Handler for the submit form
  html.find('form').on('submit', async (event) => {
    // If the value of checkbox is true, updates the flags with the new values
    if (isoTokenCheckbox.prop("checked")) {
      await app.object.setFlag(MODULE_ID, "isoTokenDisabled", true);
    } else {
      await app.object.unsetFlag(MODULE_ID, "isoTokenDisabled");
    }

    if (isoScaleDisabled.prop("checked")) {
      await app.object.setFlag(MODULE_ID, "isoScaleDisabled", true);
    } else {
      await app.object.unsetFlag(MODULE_ID, "isoScaleDisabled");
    }
  });

  // Fix tab init
  if (!app._tabs || app._tabs.length === 0) {
    app._tabs = [new Tabs({
      navSelector: ".tabs",
      contentSelector: ".sheet-body",
      initial: "appearance",
      callback: () => {}
    })];
    app._tabs[0].bind(html[0]);
  }
  
  // Initializes control values
  const isoAnchorToggleCheckbox = html.find('input[name="isoAnchorToggle"]');
  isoAnchorToggleCheckbox.prop("unchecked", app.object.getFlag(MODULE_ID, "isoAnchorToggle") ?? false);

  // Function to draw alignment lines
  function drawAlignmentLines(isoAnchor) {
    // Removes existing lines
    cleanup();
    
    // Create container for the lines
    const graphics = new PIXI.Graphics();
    graphics.name = 'tokenAlignmentLine';
    graphics.lineStyle(1, 0xFF0000, 0.75); // Largura, Cor, Opacidade

    // Calculate diagonal length
    const canvasWidth = canvas.dimensions.width;
    const canvasHeight = canvas.dimensions.height;
    const diagonalLength = Math.sqrt(Math.pow(canvasWidth, 2) + Math.pow(canvasHeight, 2));

    // Draw lines
    graphics.moveTo(isoAnchor.x - diagonalLength / 2, isoAnchor.y - diagonalLength / 2);
    graphics.lineTo(isoAnchor.x + diagonalLength / 2, isoAnchor.y + diagonalLength / 2);
    
    graphics.moveTo(isoAnchor.x - diagonalLength / 2, isoAnchor.y + diagonalLength / 2);
    graphics.lineTo(isoAnchor.x + diagonalLength / 2, isoAnchor.y - diagonalLength / 2);

    // Add on canvas
    canvas.stage.addChild(graphics);
    return graphics;
  };

  // Function to calculate the alignment point
  function updateIsoAnchor(isoAnchorX, isoAnchorY, offsetX, offsetY) {
    let tokenMesh = app.token.object.mesh;
    if (!tokenMesh) return { x: 0, y: 0 };
    
    // Defines the values ​​and transforms strings into numbers
    let textureValues = cartesianToIso(
      tokenMesh.height,
      tokenMesh.width
    );
    let isoAnchors = cartesianToIso(
      parseFloat(isoAnchorX) * tokenMesh.height,
      parseFloat(isoAnchorY) * tokenMesh.width
    );
    let isoOffsets = cartesianToIso(
      parseFloat(offsetX), 
      parseFloat(offsetY)
    );

    return {
      x: (tokenMesh.x - textureValues.x/2) + isoOffsets.x + isoAnchors.x,
      y: (tokenMesh.y - textureValues.y/2) + isoOffsets.y + isoAnchors.y
    };
  };

  // Function to remove the lines
  function cleanup() {
    const existingLines = canvas.stage.children.filter(child => child.name === 'tokenAlignmentLine');
    existingLines.forEach(line => line.destroy());
  };

  // Initialize the lines with the current values
  let isoAnchorX = app.object.getFlag(MODULE_ID, 'isoAnchorX') ?? 0;
  let isoAnchorY = app.object.getFlag(MODULE_ID, 'isoAnchorY') ?? 0;
  let offsetX = app.object.getFlag(MODULE_ID, 'offsetX') ?? 0;
  let offsetY = app.object.getFlag(MODULE_ID, 'offsetY') ?? 0;
  
  // Add the button to reset the token settings
  const toggleButton = document.createElement("button");
  toggleButton.classList.add("toggle-alignment-lines");
  toggleButton.textContent = game.i18n.localize('isometric-perspective.token_resetAlignmentButton_name'); //Reset Token Alignment Configuration
  toggleButton.title = game.i18n.localize('isometric-perspective.token_resetAlignmentButton_mouseover'); //Click to toggle the alignment lines
  html.find(".anchor-point").append(toggleButton);

  // Variables to control state
  let graphics;
  let showAlignmentLines = true;
  
  // Add the click event to the button
  toggleButton.addEventListener("click", async (event) => {
    event.preventDefault(); // Evita que o clique feche a janela

    // Reset all alignment settings
    html.find('input[name="texture.anchorX"]').val(0.5);
    html.find('input[name="texture.anchorY"]').val(0.5);
    html.find('input[name="flags.isometric-perspective.isoAnchorX"]').val(0.5);
    html.find('input[name="flags.isometric-perspective.isoAnchorY"]').val(0.5);
    html.find('input[name="flags.isometric-perspective.offsetX"]').val(0);
    html.find('input[name="flags.isometric-perspective.offsetY"]').val(0);
    html.find('input[name="flags.isometric-perspective.scale"]').val(1);

    graphics = drawAlignmentLines(updateIsoAnchor(isoAnchorX, isoAnchorY, offsetX, offsetY));
  });

  // Add a listener to the "Save?" Checkbox, If it is marked, draw the lines
  isoAnchorToggleCheckbox.on('change', async () => {
    const isChecked = isoAnchorToggleCheckbox.prop("checked");
    if (isChecked) graphics = drawAlignmentLines(updateIsoAnchor(isoAnchorX, isoAnchorY, offsetX, offsetY));
    
    // Invert the state of the selector
    showAlignmentLines = !showAlignmentLines;
  });
  
  // Update the lines when changing the inputs
  html.find('input[name="flags.isometric-perspective.isoAnchorX"], input[name="flags.isometric-perspective.isoAnchorY"], input[name="flags.isometric-perspective.offsetX"], input[name="flags.isometric-perspective.offsetY"]').on('change', () => {
    // Take updated values ​​directly from inputs
    let currentIsoAnchorX = html.find('input[name="flags.isometric-perspective.isoAnchorX"]').val();
    let currentIsoAnchorY = html.find('input[name="flags.isometric-perspective.isoAnchorY"]').val();
    let currentOffsetX = html.find('input[name="flags.isometric-perspective.offsetX"]').val();
    let currentOffsetY = html.find('input[name="flags.isometric-perspective.offsetY"]').val();
    
    // Recalculate the position and creates the lines again
    const newAnchor = updateIsoAnchor(currentIsoAnchorX, currentIsoAnchorY, currentOffsetX, currentOffsetY);
    graphics = drawAlignmentLines(newAnchor); // Adicionar novas
  });
  
  // Removes all lines when clicking on update token
  html.find('button[type="submit"]').on('click', () => {
    if (!isoAnchorToggleCheckbox.prop("checked")) {
      cleanup();
    } else {
      // Take updated values ​​directly from inputs
      let currentIsoAnchorX = html.find('input[name="flags.isometric-perspective.isoAnchorX"]').val();
      let currentIsoAnchorY = html.find('input[name="flags.isometric-perspective.isoAnchorY"]').val();
      
      // Update the anchor basic values ​​in the token configuration
      html.find('input[name="texture.anchorX"]').val(currentIsoAnchorY);
      html.find('input[name="texture.anchorY"]').val(1-currentIsoAnchorX);
    }
  });

  // Changes the Close method to delete the lines, IF avoids changing the method more than once
  if (!app._isCloseModified) {
    const originalClose = app.close;
    app.close = async function (options) {
      cleanup();
      await originalClose.apply(this, [options]);
    };

    // Mark that the close method has already been
    app._isCloseModified = true;
  }
}

// Hooks.on("createToken")
function handleCreateToken(tokenDocument) {
  const token = canvas.tokens.get(tokenDocument.id);
  if (!token) return;
  
  const isSceneIsometric = token.scene.getFlag(MODULE_ID, "isometricEnabled");
  applyIsometricTransformation(token, isSceneIsometric);
}

// Hooks.on("updateToken")
function handleUpdateToken(tokenDocument, updateData, options, userId) {
  const token = canvas.tokens.get(tokenDocument.id);
  if (!token) return;
  
  const isSceneIsometric = token.scene.getFlag(MODULE_ID, "isometricEnabled");
  applyIsometricTransformation(token, isSceneIsometric);

  if (DEBUG_PRINT) console.log("Hooks.on token.js updateToken");
}

// Hooks.on("refreshToken")
function handleRefreshToken(token) {
  const isSceneIsometric = token.scene.getFlag(MODULE_ID, "isometricEnabled");
  applyIsometricTransformation(token, isSceneIsometric);
  
  if (DEBUG_PRINT) console.log("Hooks.on token.js refreshToken");
}

// Hooks.on("deleteToken")
function handleDeleteToken(token) {
  updateTokenVisuals(token);
}

// Generic function to create adjustable buttons with drag functionality
function createAdjustableButton(options) {
  // Destructure configuration options with default values
  const {
    container,                // Parent container element
    buttonSelector,           // CSS selector for the button
    inputs,                   // Array of input elements to update
    adjustmentScale = 0.2,    // How much the value changes per pixel moved
    valueConstraints = null,  // Optional min/max constraints for values
    roundingPrecision = 0     // Number of decimal places to round to
  } = options;

  // Find and configure the adjustment button
  const adjustButton = container.querySelector(buttonSelector);
  
  // Apply consistent button styling
  Object.assign(adjustButton.style, {
    width: '30px',
    cursor: 'pointer',
    padding: '1px 5px',
    border: '1px solid #888',
    borderRadius: '3px'
  });
  adjustButton.title = game.i18n.localize('isometric-perspective.token_artOffset_mouseover'); //Hold and drag to fine-tune X and Y

  // State variables for tracking drag operations
  let isAdjusting = false;
  let startX = 0;
  let startY = 0;
  let originalValues = [0, 0];

  // Function to handle mouse movement and value adjustments
  const applyAdjustment = (e) => {
    if (!isAdjusting) return;

    // Calculate mouse movement deltas
    const deltaY = e.clientX - startX;
    const deltaX = startY - e.clientY;
    
    // Calculate value adjustments based on mouse movement
    const adjustments = [
      deltaX * adjustmentScale,
      deltaY * adjustmentScale
    ];

    // Update each input with new values
    inputs.forEach((input, index) => {
      let newValue = originalValues[index] + adjustments[index];
      
      // Apply min/max constraints if provided
      if (valueConstraints) {
        newValue = Math.max(valueConstraints.min, Math.min(valueConstraints.max, newValue));
      }
      
      // Round to specified precision
      newValue = Math.round(newValue * Math.pow(10, roundingPrecision)) / Math.pow(10, roundingPrecision);
      
      // Update input value and trigger change event
      input.value = newValue.toFixed(roundingPrecision);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  // Set up mouse event listeners for drag functionality
  adjustButton.addEventListener('mousedown', (e) => {
    isAdjusting = true;
    startX = e.clientX;
    startY = e.clientY;
    // Store initial input values
    originalValues = inputs.map(input => parseFloat(input.value));
    
    // Add global mouse event listeners
    document.addEventListener('mousemove', applyAdjustment);
    document.addEventListener('mouseup', () => {
      isAdjusting = false;
      document.removeEventListener('mousemove', applyAdjustment);
    });
    
    e.preventDefault();
  });
}

// Handler for offset adjustment button
function updateAdjustOffsetButton(html) {
  const container = html.find('.offset-point')[0];
  createAdjustableButton({
    container,
    buttonSelector: 'button.fine-adjust',
    inputs: [
      html.find('input[name="flags.isometric-perspective.offsetX"]')[0],
      html.find('input[name="flags.isometric-perspective.offsetY"]')[0]
    ],
    adjustmentScale: 0.2,    // Larger scale for offset adjustments
    roundingPrecision: 0     // Whole numbers for offset values
  });
}

// Handler for anchor adjustment button
function updateAdjustAnchorButton(html) {
  const container = html.find('.anchor-point')[0];
  createAdjustableButton({
    container,
    buttonSelector: 'button.fine-adjust-anchor',
    inputs: [
      html.find('input[name="flags.isometric-perspective.isoAnchorX"]')[0],
      html.find('input[name="flags.isometric-perspective.isoAnchorY"]')[0]
    ],
    adjustmentScale: 0.005,  // Smaller scale for precise anchor adjustments
    valueConstraints: { min: 0, max: 1 },  // Anchor values must be between 0 and 1
    roundingPrecision: 2     // Two decimal places for anchor values
  });
}