import { MODULE_ID, DEBUG_PRINT, WORLD_ISO_FLAG } from './main.js';

// Define all projection types
export let PROJECTION_TYPES = {
  'True Isometric': {
    rotation:  -30,
    skewX:      30,
    skewY:       0,
    HudAngle:   30,
    reverseRotation: 45,
    reverseSkewX:     0,
    reverseSkewY:     0,
    ratio:       Math.sqrt(3)
  },
  'Dimetric (2:1)': {
    rotation:    -45,
    skewX:    18.435,
    skewY:    18.435,
    HudAngle:  26.57,
    reverseRotation: 45,
    reverseSkewX:     0,
    reverseSkewY:     0,
    ratio:            2
  },
  'Overhead (√2:1)': {
    rotation:     -45,
    skewX:   9.735607,
    skewY:   9.735607,
    HudAngle:   35.26,
    reverseRotation: 45,
    reverseSkewX:     0,
    reverseSkewY:     0,
    ratio:  1.414213389
  },
  'Projection (3:2)': {
    rotation:    -45,
    skewX:   11.3101,
    skewY:   11.3101,
    HudAngle:  33.69,
    reverseRotation: 45,
    reverseSkewX:     0,
    reverseSkewY:     0,
    ratio:          1.5
  },
  'Game: Diablo 1': {
    rotation: -30,
    skewX:     34,
    skewY:      4,
    HudAngle:  26,
    reverseRotation: 45,
    reverseSkewX:     0,
    reverseSkewY:     0,
    ratio:       2.0503038415792987
  },
  'Game: Planescape Torment': {
    rotation: -35,
    skewX:     20,
    skewY:      0,
    HudAngle:  35,
    reverseRotation: 45,
    reverseSkewX:     0,
    reverseSkewY:     0,
    ratio:       1.428148006742114
  },
  'Custom Projection': {
    rotation: 0,
    skewX: 0,
    skewY: 0,
    HudAngle: 0,
    reverseRotation: 0,
    reverseSkewX: 0,
    reverseSkewY: 0,
    ratio: 1
  }
};

// Default projection type
export let DEFAULT_PROJECTION = 'True Isometric';

// Custom projection settings
export let CUSTOM_PROJECTION = { ...PROJECTION_TYPES['Custom Projection'] };

// Current isometric constants
export let ISOMETRIC_CONST = { ...PROJECTION_TYPES[DEFAULT_PROJECTION] };

// Update the CUSTOM_PROJECTION values
export function updateCustomProjection(newProjection) {
  CUSTOM_PROJECTION = { ...newProjection };
}

// Function to convert degrees to radians for all angle properties
function convertToRadians(projectionData) {
  const angleProps = ['rotation', 'skewX', 'skewY', 'HudAngle', 'reverseRotation', 'reverseSkewX', 'reverseSkewY'];
  const result = { ...projectionData };
  
  angleProps.forEach(prop => {
    result[prop] = result[prop] * Math.PI / 180;
  });
  
  return result;
}

export function updateIsometricConstants(projectionType) {
  let projection;
  
  if (projectionType === 'Custom Projection') {
    projection = CUSTOM_PROJECTION;
  } else {
    projection = PROJECTION_TYPES[projectionType] || PROJECTION_TYPES[DEFAULT_PROJECTION];
  }
  
  ISOMETRIC_CONST = convertToRadians(projection);
}

export function parseCustomProjection(customInput) {
  const values = customInput.split(',').map(val => parseFloat(val.trim()));
  
  if (values.length !== 8) {
    throw new Error('Invalid custom projection input. Must be 8 comma-separated numbers.');
  }
  
  return {
    rotation: values[0],
    skewX: values[1],
    skewY: values[2],
    HudAngle: values[3],
    reverseRotation: values[4],
    reverseSkewX: values[5],
    reverseSkewY: values[6],
    ratio: values[7]  // You might want to let the user specify this or keep it constant
  };
}