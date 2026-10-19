/**
 * Manifest V3 Service Worker Entry Point
 */
importScripts(
  '../config.js',
  'state.js',
  'badge.js',
  'layers/segment-sub.js',
  'orchestrator.js',
  'remote-config.js',
  'main.js'
);