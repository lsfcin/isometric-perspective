import { MODULE_ID, DEBUG_PRINT, WORLD_ISO_FLAG } from './main.js';

// Helper to convert isometric coordinates to cartesian
export function isoToCartesian(isoX, isoY) {
  const angle = Math.PI / 4; // 45 degrees in radians
  return {
    x: (isoX * Math.cos(angle) - isoY * Math.sin(angle)),
    y: (isoX * Math.sin(angle) + isoY * Math.cos(angle))
  };
}

// Helper to convert cartesian coordinates to isometric
export function cartesianToIso(isoX, isoY) {
  const angle = Math.PI / 4; // 45 degrees in radians
  return {
    x: (isoX * Math.cos(-angle) - isoY * Math.sin(-angle)),
    y: (isoX * Math.sin(-angle) + isoY * Math.cos(-angle))
  };
}

// Helper to compute the vertical distance between diamond vertices (short diagonal)
export function calculateIsometricVerticalDistance(width, height) {
  // For 45° isometric projection, vertical distance between vertices is the diamond's height
  return Math.sqrt(2) * Math.min(width, height);
}